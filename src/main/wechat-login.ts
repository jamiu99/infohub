// 扫码登录。见 docs/wechat-login.md。
//
// 场景（用户确认）：多个号是【不同微信号的独立账号】，各自独立扫码登录。
//   因此每个账号用【独立会话分区】(persist:wx-<id>)，cookie/token 完全隔离、
//   互不覆盖、互不失效——这也彻底规避了"切换账号后旧 token 失效"的问题。
//
// 交互模型（用户要的简单方式）：
//   点登录 → 开一个窗口(独立分区) → 用户扫码登录某个号 → 关窗时抓当前 token+cookie 存下。
//   想加更多号，就再点一次登录，另开一个独立分区窗口。不做任何"内部切换账号"逻辑。
import { BrowserWindow, session } from 'electron'
import type { WxAccount } from '../shared/wechat'
import {
  buildWechatQrLoginScript,
  isWechatLoginUrl,
  type WechatQrPageState
} from './wechat-login-page'

const HOME = 'https://mp.weixin.qq.com/'
const TOKEN_RE = /[?&]token=(\d+)/

export interface LoginResult {
  token: string
  cookies: Record<string, string>
  nickname?: string
}

async function readCookies(ses: Electron.Session): Promise<Record<string, string>> {
  const list = await ses.cookies.get({ url: 'https://mp.weixin.qq.com' })
  const cookies: Record<string, string> = {}
  for (const c of list) cookies[c.name] = c.value
  return cookies
}

async function readNickname(wc: Electron.WebContents): Promise<string | undefined> {
  try {
    const n = (await wc.executeJavaScript(
      'document.querySelector(".weui-desktop-account__nickname")?.textContent?.trim() || ' +
        'window.wx?.commonData?.data?.nick_name || ""'
    )) as string
    return n || undefined
  } catch {
    return undefined
  }
}

/** 往登录页顶部注入中文引导横幅（Chromium 渲染，避开原生标题栏 WSLg 无中文字体的乱码） */
async function injectBanner(
  wc: Electron.WebContents,
  state: 'loading' | 'ready' | 'logged-in' | WechatQrPageState
): Promise<void> {
  const tips: Record<typeof state, string> = {
    loading: '正在切换到微信官方二维码。请勿输入账号、密码或验证码。',
    ready: '请用手机微信扫描下方二维码。确认登录后关闭本窗口，即可仅在本机保存登录态。',
    'logged-in': '已检测到登录。确认是要采集的号后，直接关闭本窗口即可保存该账号。',
    failed: '二维码加载失败，请检查网络后重新打开；不要改用账号、密码或验证码登录。',
    timeout: '未能自动显示二维码。请点击登录框右上角二维码图标，再选择“扫码登录”。'
  }
  const tip = tips[state]
  const js = `(() => {
    const ID='__infohub_banner__';
    let el=document.getElementById(ID);
    if(!el){el=document.createElement('div');el.id=ID;
      el.style.cssText='position:fixed;top:0;left:0;right:0;z-index:2147483647;'
        +'background:#2f6feb;color:#fff;padding:8px 14px;font-size:13px;line-height:1.5;'
        +'font-family:"Noto Sans CJK SC","Noto Sans SC",sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.2);';
      document.body.appendChild(el);document.body.style.paddingTop='40px';}
    el.textContent='infohub · '+${JSON.stringify(tip)};
  })()`
  try {
    await wc.executeJavaScript(js)
  } catch {
    /* CSP/时机问题忽略 */
  }
}

async function showWechatQrLogin(wc: Electron.WebContents): Promise<void> {
  await injectBanner(wc, 'loading')
  try {
    const result = (await wc.executeJavaScript(buildWechatQrLoginScript())) as {
      state: WechatQrPageState
    }
    await injectBanner(wc, result.state)
  } catch {
    await injectBanner(wc, 'timeout')
  }
}

/**
 * 打开一个独立分区的登录窗口。用户扫码登录一个公众号后，关窗时抓取其 token+cookie。
 * @param partition 该账号独立分区 persist:wx-<id>
 * @returns 登录结果；若用户未登录就关窗（无 token）则 resolve(null)
 */
export function openWechatLogin(partition: string): Promise<LoginResult | null> {
  return new Promise((resolve) => {
    const ses = session.fromPartition(partition)
    // 传统二维码不需要摄像头、定位、本地网络或设备权限，默认全部拒绝。
    ses.setPermissionCheckHandler(() => false)
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

    const win = new BrowserWindow({
      width: 1040,
      height: 760,
      title: 'infohub · 微信公众平台扫码登录',
      backgroundColor: '#ffffff',
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    win.setMenuBarVisibility(false)

    // 登录窗口只能在微信公众平台内部导航；页面弹窗一律拒绝。
    win.webContents.on('will-navigate', (event, url) => {
      if (!isWechatLoginUrl(url)) event.preventDefault()
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    // 记录当前观察到的登录态（关窗时以此为准抓取）
    let lastToken: string | null = null

    const onNavigate = async (url: string): Promise<void> => {
      const m = url.match(TOKEN_RE)
      if (m) {
        lastToken = m[1]
        await injectBanner(win.webContents, 'logged-in')
      }
    }

    win.webContents.on('did-finish-load', () => {
      if (lastToken) void injectBanner(win.webContents, 'logged-in')
      else void showWechatQrLogin(win.webContents)
    })
    win.webContents.on('did-navigate', (_e, url) => void onNavigate(url))
    win.webContents.on('did-navigate-in-page', (_e, url) => void onNavigate(url))

    win.on('close', async (e) => {
      // 关窗时若已登录，抓取当前 token+cookie。用 preventDefault 等异步抓完再真正关。
      if (lastToken && !(win as unknown as { _captured?: boolean })._captured) {
        e.preventDefault()
        ;(win as unknown as { _captured?: boolean })._captured = true
        try {
          const [cookies, nickname] = await Promise.all([
            readCookies(ses),
            readNickname(win.webContents)
          ])
          resolve({ token: lastToken, cookies, nickname })
        } catch {
          resolve({ token: lastToken, cookies: {}, nickname: undefined })
        } finally {
          if (!win.isDestroyed()) win.destroy()
        }
      }
    })
    win.on('closed', () => resolve(null)) // 未登录就关 → 无账号

    win.loadURL(HOME).catch(() => resolve(null))
  })
}

export function makeAccount(accountId: string, partition: string, r: LoginResult, now: number): WxAccount {
  return {
    id: accountId,
    nickname: r.nickname,
    token: r.token,
    cookies: r.cookies,
    partition,
    status: 'active',
    requestsThisHour: 0,
    windowStart: now,
    totalRequests: 0
  }
}

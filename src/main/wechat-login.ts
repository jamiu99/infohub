// 扫码登录 + 多账号捕获。见 docs/wechat-login.md。
//
// 关键认知（经用户确认 + 调研）：用户的多个公众号都挂在【同一个微信号】名下。
//   - 直接登某个号要输密码；先扫码登主微信号、再用后台"切换账号"切到旗下各号则【免密】。
//   - 每切一个号，URL 里的 token 会变（cookie 基本不变，同一微信会话）。
//   - 采集只需任一有效 token 即可搜/拉任何目标号 → 多 token = 轮换池分摊请求量。
//
// 因此登录窗口【只扫一次码】，之后监听 token 变化：用户每切一个号就自动捕获
//   {nickname, token, cookies} 进池。全程共享同一 persist 分区，免密。
import { BrowserWindow, session } from 'electron'
import type { WxAccount } from '../shared/wechat'

const HOME = 'https://mp.weixin.qq.com/'
const TOKEN_RE = /[?&]token=(\d+)/

/** 所有账号共享的登录分区：一次扫码，持久化整个微信会话 */
export const SHARED_PARTITION = 'persist:wx-main'

export interface CapturedIdentity {
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

/**
 * 打开登录/切换窗口。用户扫码登录后，可在窗口内点"切换账号"切到旗下各号；
 * 每捕获到一个新 token 就回调 onCapture。窗口关闭时 resolve（返回捕获总数）。
 * @param onCapture 每当 URL 出现新的 token 身份时触发
 */
export function openWechatSwitcher(
  onCapture: (id: CapturedIdentity) => void
): Promise<{ count: number }> {
  return new Promise((resolve) => {
    const ses = session.fromPartition(SHARED_PARTITION)
    const win = new BrowserWindow({
      width: 1040,
      height: 760,
      title: '登录微信公众号后台 · 扫码后可切换账号采集',
      webPreferences: { partition: SHARED_PARTITION, contextIsolation: true, nodeIntegration: false }
    })

    const seenTokens = new Set<string>()
    let count = 0

    const onNavigate = async (url: string): Promise<void> => {
      const m = url.match(TOKEN_RE)
      if (!m) return
      const token = m[1]
      if (seenTokens.has(token)) return // 同一号重复导航，跳过
      seenTokens.add(token)
      // 稍等页面渲染出昵称
      const wc = win.webContents
      const [cookies, nickname] = await Promise.all([readCookies(ses), readNickname(wc)])
      count++
      onCapture({ token, cookies, nickname })
    }

    win.webContents.on('did-navigate', (_e, url) => void onNavigate(url))
    win.webContents.on('did-navigate-in-page', (_e, url) => void onNavigate(url))
    win.on('closed', () => resolve({ count }))

    win.loadURL(HOME).catch(() => resolve({ count }))
  })
}

/**
 * 由捕获身份构造/更新账号。身份键优先用 nickname（公众号名），缺失时退回 token 前缀。
 * 同一号再次捕获（token 更新）时应复用同一 id —— 交给调用方按 identityKey 去重。
 */
export function identityKey(id: CapturedIdentity): string {
  return id.nickname ? `wx:${id.nickname}` : `wx:tok-${id.token.slice(0, 8)}`
}

export function makeAccount(accountId: string, id: CapturedIdentity, now: number): WxAccount {
  return {
    id: accountId,
    nickname: id.nickname,
    token: id.token,
    cookies: id.cookies,
    partition: SHARED_PARTITION,
    status: 'active',
    requestsThisHour: 0,
    windowStart: now
  }
}

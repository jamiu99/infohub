// 扫码登录：BrowserWindow 加载官方后台，用户扫码后从 session 抓 cookie + URL 抓 token。
// 见 docs/wechat-login.md。这是本项目核心亮点，只"读"官方页面的登录态，不模拟登录接口。
import { BrowserWindow, session } from 'electron'
import type { WxAccount } from '../shared/wechat'

const HOME = 'https://mp.weixin.qq.com/'
const TOKEN_RE = /[?&]token=(\d+)/

export interface LoginResult {
  token: string
  cookies: Record<string, string>
  fingerprint?: string
  nickname?: string
}

/**
 * 打开扫码登录窗口。用户扫码成功后，后台跳转 URL 带 token，即视为登录完成。
 * @param partition persist:wx-<id>，持久化该账号 cookie，多账号隔离
 */
export function openWechatLogin(partition: string): Promise<LoginResult> {
  return new Promise((resolve, reject) => {
    const ses = session.fromPartition(partition)
    const win = new BrowserWindow({
      width: 1000,
      height: 720,
      title: '扫码登录微信公众号后台',
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false }
    })

    let settled = false
    const finish = async (url: string): Promise<void> => {
      const m = url.match(TOKEN_RE)
      if (!m || settled) return
      settled = true
      const token = m[1]
      try {
        const list = await ses.cookies.get({ url: 'https://mp.weixin.qq.com' })
        const cookies: Record<string, string> = {}
        for (const c of list) cookies[c.name] = c.value
        // 尝试读昵称（失败无妨）
        let nickname: string | undefined
        try {
          const wc = win.webContents
          nickname = (await wc.executeJavaScript(
            'document.querySelector(".weui-desktop-account__nickname")?.textContent?.trim() || ' +
              'window.wx?.commonData?.data?.nick_name || ""'
          )) as string
          nickname = nickname || undefined
        } catch {
          /* ignore */
        }
        resolve({ token, cookies, nickname })
      } catch (e) {
        reject(e as Error)
      } finally {
        if (!win.isDestroyed()) win.close()
      }
    }

    win.webContents.on('did-navigate', (_e, url) => void finish(url))
    win.webContents.on('did-navigate-in-page', (_e, url) => void finish(url))
    win.on('closed', () => {
      if (!settled) reject(new Error('用户取消登录'))
    })

    win.loadURL(HOME).catch(reject)
  })
}

/** 构造一个新账号对象（登录成功后调用） */
export function makeAccount(id: string, partition: string, r: LoginResult, now: number): WxAccount {
  return {
    id,
    nickname: r.nickname,
    token: r.token,
    cookies: r.cookies,
    fingerprint: r.fingerprint,
    partition,
    status: 'active',
    requestsThisHour: 0,
    windowStart: now
  }
}

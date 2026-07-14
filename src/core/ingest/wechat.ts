// 微信公众号采集核心。复用 refs/get_wechat_list 的两个接口逻辑（那仓代码烂，只取核心）。
// 鉴权三要素 cookie + token + fingerprint 由账号池提供。见 docs/ingest.md、docs/wechat-login.md。
import type { RawItem } from '../../shared/contract'
import type { WxAccount, WxSearchResult, WxCallResult } from '../../shared/wechat'
import { WX_FREQ_CONTROL_CODE } from '../../shared/wechat'

const BASE = 'https://mp.weixin.qq.com'
export const WECHAT_BACKEND_TIMEOUT_MS = 15_000

function buildHeaders(account: WxAccount): Record<string, string> {
  const cookie = Object.entries(account.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
  return {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    referer: `${BASE}/cgi-bin/home?t=home/index&token=${account.token}&lang=zh_CN`,
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'x-requested-with': 'XMLHttpRequest',
    cookie
  }
}

interface WxBaseResp {
  base_resp?: { ret: number; err_msg: string }
}

/** 判定接口返回码：0=ok，200013=限流，其余（含未登录）按错误/失效处理 */
function classify(ret: number, msg: string): { kind: 'ok' | 'freq_control' | 'expired' | 'error' } {
  if (ret === 0) return { kind: 'ok' }
  if (ret === WX_FREQ_CONTROL_CODE) return { kind: 'freq_control' }
  // ret -1 / 未登录相关通常表示 session 失效
  if (ret === -1 || /session|login|token/i.test(msg)) return { kind: 'expired' }
  return { kind: 'error' }
}

async function wxGet<T extends WxBaseResp>(
  path: string,
  params: Record<string, string>,
  account: WxAccount
): Promise<WxCallResult<T>> {
  const url = `${BASE}${path}?${new URLSearchParams(params).toString()}`
  try {
    const res = await fetch(url, {
      headers: buildHeaders(account),
      redirect: 'manual',
      signal: AbortSignal.timeout(WECHAT_BACKEND_TIMEOUT_MS)
    })
    // 302 到登录页 = session 失效
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, reason: 'expired', message: `redirected (${res.status})` }
    }
    const data = (await res.json()) as T
    const ret = data.base_resp?.ret ?? -999
    const msg = data.base_resp?.err_msg ?? 'no base_resp'
    const c = classify(ret, msg)
    if (c.kind === 'ok') return { ok: true, data }
    return { ok: false, reason: c.kind, message: `${ret}: ${msg}` }
  } catch (e) {
    return { ok: false, reason: 'error', message: (e as Error).message }
  }
}

/** 接口 1：按名称搜公众号 → fakeid */
export async function searchBiz(
  account: WxAccount,
  query: string,
  count = 5
): Promise<WxCallResult<WxSearchResult[]>> {
  interface Resp extends WxBaseResp {
    list?: Array<{
      fakeid: string
      nickname: string
      alias?: string
      signature?: string
      round_head_img?: string
    }>
  }
  const r = await wxGet<Resp>(
    '/cgi-bin/searchbiz',
    {
      action: 'search_biz',
      query,
      begin: '0',
      count: String(count),
      fingerprint: account.fingerprint ?? '',
      token: account.token,
      lang: 'zh_CN',
      f: 'json',
      ajax: '1'
    },
    account
  )
  if (!r.ok) return r
  const list = (r.data.list ?? []).map((i) => ({
    fakeid: i.fakeid,
    nickname: i.nickname,
    alias: i.alias ?? '',
    signature: i.signature ?? '',
    roundHeadImg: i.round_head_img
  }))
  return { ok: true, data: list }
}

/** 接口 2：拉某号一页文章 */
export async function listArticlesPage(
  account: WxAccount,
  fakeid: string,
  begin: number,
  count = 10
): Promise<WxCallResult<{ total: number; items: Record<string, unknown>[] }>> {
  interface Resp extends WxBaseResp {
    app_msg_cnt?: number
    app_msg_list?: Record<string, unknown>[]
  }
  const r = await wxGet<Resp>(
    '/cgi-bin/appmsg',
    {
      action: 'list_ex',
      fakeid,
      query: '',
      begin: String(begin),
      count: String(count),
      type: '9',
      need_author_name: '1',
      fingerprint: account.fingerprint ?? '',
      token: account.token,
      lang: 'zh_CN',
      f: 'json',
      ajax: '1'
    },
    account
  )
  if (!r.ok) return r
  return { ok: true, data: { total: r.data.app_msg_cnt ?? 0, items: r.data.app_msg_list ?? [] } }
}

function nonEmpty(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim()
}

/**
 * 微信 link 会更换 chksm/scene 等参数，不能直接作为长期去重键。优先使用后台返回的 aid；
 * 缺失时使用 appmsgid+itemidx，再从公开 URL 提取 __biz+mid+idx。
 */
export function wechatExternalId(item: Record<string, unknown>): string {
  const aid = nonEmpty(item.aid)
  if (aid) return `aid:${aid}`

  const appmsgid = nonEmpty(item.appmsgid ?? item.mid)
  const rawItemIndex = nonEmpty(item.itemidx ?? item.idx)
  if (appmsgid) return `mid:${appmsgid}:idx:${rawItemIndex || '1'}`

  const link = nonEmpty(item.link).replace(/&amp;/gi, '&')
  if (!link) return ''
  try {
    const url = new URL(link, BASE)
    const biz = url.searchParams.get('__biz')?.trim() ?? ''
    const mid = (url.searchParams.get('mid') ?? url.searchParams.get('appmsgid') ?? '').trim()
    const index = (url.searchParams.get('idx') ?? '1').trim() || '1'
    if (mid) return `biz:${biz}:mid:${mid}:idx:${index}`
    // 非标准/旧链接仍做最小规范化，至少去掉 fragment。
    url.hash = ''
    return url.href
  } catch {
    return link
  }
}

/** 把一条 app_msg 转成 RawItem（externalId 使用稳定微信消息键） */
export function toRawItem(sourceId: string, item: Record<string, unknown>): RawItem {
  return {
    sourceId,
    sourceType: 'wechat',
    fetchedAt: Date.now(),
    externalId: wechatExternalId(item),
    raw: item
  }
}

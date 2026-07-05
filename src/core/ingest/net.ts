// 带超时 + 重试的 fetch。网络信源（RSS/正文页）服务器常不稳，需容错。
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface FetchOpts {
  headers?: Record<string, string>
  timeoutMs?: number // 单次超时，默认 15s
  retries?: number // 失败重试次数，默认 2
  fetchImpl?: typeof fetch
}

/**
 * 抓取文本，带超时与重试。全部失败返回 null（不抛）。
 * 超时用 AbortController；重试间隔递增（1s、2s…）。
 */
export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string | null> {
  const { headers, timeoutMs = 15_000, retries = 2, fetchImpl = fetch } = opts
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, { headers, signal: ctrl.signal })
      clearTimeout(timer)
      if (res.ok) return await res.text()
      // 4xx 不重试（请求本身有问题）；5xx/其他重试
      if (res.status >= 400 && res.status < 500) return null
    } catch {
      clearTimeout(timer)
      // 超时/网络错 → 落到重试
    }
    if (attempt < retries) await sleep(1000 * (attempt + 1))
  }
  return null
}

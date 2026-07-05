// 正文抓取：拉公众号文章页（公开，无需登录）→ 提取 #js_content → 转 markdown。
// 见 docs/process.md 阶段2。极简转换，只覆盖公众号常见标签，不引三方依赖。

/** 从完整 HTML 中截取正文容器 #js_content 的内部 HTML */
export function extractContentHtml(html: string): string | null {
  // 微信正文固定在 <div id="js_content" ...>...</div>
  const m = html.match(/<div[^>]*id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*(?:<script|<div id="js_temp)/i)
  if (m) return m[1]
  // 兜底：宽松匹配到下一个明显边界
  const m2 = html.match(/<div[^>]*id=["']js_content["'][^>]*>([\s\S]*)/i)
  return m2 ? m2[1] : null
}

const decode = (s: string): string =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))

/** 极简 HTML → markdown。覆盖 p/br/h1-6/img/a/strong/em/blockquote/li。 */
export function htmlToMarkdown(html: string): string {
  let s = html
  // 图片：data-src（懒加载）或 src
  s = s.replace(/<img[^>]*?(?:data-src|src)=["']([^"']+)["'][^>]*>/gi, (_m, url) => `\n![](${url})\n`)
  // 链接
  s = s.replace(/<a[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => `[${strip(txt)}](${href})`)
  // 标题
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lv, txt) => `\n${'#'.repeat(Number(lv))} ${strip(txt)}\n`)
  // 加粗/强调
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, txt) => `**${strip(txt)}**`)
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, txt) => `*${strip(txt)}*`)
  // 引用
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, txt) => `\n> ${strip(txt)}\n`)
  // 列表项
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, txt) => `\n- ${strip(txt)}`)
  // 段落/换行 → 换行
  s = s.replace(/<\/(p|div|section|br)[^>]*>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  // 去掉剩余标签
  s = s.replace(/<[^>]+>/g, '')
  s = decode(s)
  // 压缩多余空行/空格
  s = s
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return s
}

/** 去掉一段 HTML 里的标签，取纯文本（用于链接/标题内文） */
function strip(html: string): string {
  return decode(html.replace(/<[^>]+>/g, '')).trim()
}

/** 抓取并转换正文。失败返回 null（不阻塞入库）。 */
export async function fetchArticleBody(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  try {
    const res = await fetchImpl(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
      }
    })
    if (!res.ok) return null
    const html = await res.text()
    const content = extractContentHtml(html)
    if (!content) return null
    const md = htmlToMarkdown(content)
    return md || null
  } catch {
    return null
  }
}

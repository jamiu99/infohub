// 极简 markdown → HTML（仅用于详情页展示正文）。覆盖标题/加粗/斜体/链接/图片/引用/列表/段落。
// 正文来自我们自己的 content.ts 转换结果，格式可控，无需完整 markdown 解析器。
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function inline(s: string): string {
  let t = escapeHtml(s)
  // 图片 ![](url)
  t = t.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (_m, url) => `<img src="${url}" loading="lazy" />`)
  // 链接 [text](url)
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt, url) => `<a href="${url}" target="_blank">${txt}</a>`)
  // 加粗 **x**
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // 斜体 *x*
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  return t
}

export function renderMarkdown(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let inList = false
  const closeList = (): void => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      closeList()
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      closeList()
      const lv = h[1].length
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      closeList()
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`)
      continue
    }
    // 纯图片行
    if (/^!\[[^\]]*\]\([^)]+\)$/.test(line)) {
      closeList()
      out.push(inline(line))
      continue
    }
    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  return out.join('\n')
}

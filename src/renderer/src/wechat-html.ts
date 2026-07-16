// 微信正文原始排版文档。内容来自公开 mp.weixin.qq.com 页面，保留微信 HTML 与内联样式；
// iframe 只负责隔离微信 CSS，避免污染 infohub 三栏界面。

function findTagEnd(source: string, start: number): number {
  let quote = ''
  for (let index = start; index < source.length; index++) {
    const character = source[index]
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '>') return index
  }
  return -1
}

function setTagAttribute(tag: string, name: string, value: string): string {
  const attribute = new RegExp(
    `\\s+${name}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`,
    'i'
  )
  if (attribute.test(tag)) return tag.replace(attribute, ` ${name}="${value}"`)
  const insertAt = tag.endsWith('/>') ? tag.length - 2 : tag.length - 1
  return `${tag.slice(0, insertAt)} ${name}="${value}"${tag.slice(insertAt)}`
}

/**
 * 展示时再次统一链接行为，覆盖旧资料库或团队同步正文里遗留的 target=_self。
 * 原始快照与磁盘 sidecar 都不改，只调整本次 iframe 文档。
 */
export function normalizeWechatExternalLinks(contentHtml: string): string {
  const anchorStart = /<a(?=[\s>])/gi
  let normalized = ''
  let cursor = 0
  while (true) {
    const match = anchorStart.exec(contentHtml)
    if (!match) break
    const end = findTagEnd(contentHtml, match.index + match[0].length)
    if (end < 0) break
    let tag = contentHtml.slice(match.index, end + 1)
    tag = setTagAttribute(tag, 'target', '_blank')
    tag = setTagAttribute(tag, 'rel', 'noopener noreferrer')
    normalized += contentHtml.slice(cursor, match.index) + tag
    cursor = end + 1
    anchorStart.lastIndex = cursor
  }
  return normalized + contentHtml.slice(cursor)
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function buildWechatSrcdoc(contentHtml: string, sourceUrl: string): string {
  if (!contentHtml.trim()) return ''
  let baseUrl = 'https://mp.weixin.qq.com/'
  try {
    const candidate = new URL(sourceUrl)
    if (candidate.protocol === 'https:' && candidate.hostname === 'mp.weixin.qq.com') {
      baseUrl = candidate.href
    }
  } catch {
    // 损坏或旧数据统一回退到官方公众号域名。
  }
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <base href="${escapeAttribute(baseUrl)}" target="_blank">
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: #fff; }
    body {
      padding: 24px clamp(16px, 4vw, 40px) 56px;
      color: #222;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC",
        "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
      overflow-wrap: anywhere;
    }
    #js_content {
      max-width: 720px;
      margin: 0 auto;
      min-height: 1px;
      visibility: visible !important;
      opacity: 1 !important;
    }
    img, video, canvas { max-width: 100% !important; height: auto !important; }
    svg { max-width: 100%; }
    iframe { max-width: 100%; }
    table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
    pre { max-width: 100%; overflow-x: auto; white-space: pre-wrap; }
    a { word-break: break-word; }
  </style>
</head>
<body>${normalizeWechatExternalLinks(contentHtml)}</body>
</html>`
}

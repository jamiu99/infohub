// 微信正文原始排版文档。内容来自公开 mp.weixin.qq.com 页面，保留微信 HTML 与内联样式；
// iframe 只负责隔离微信 CSS，避免污染 infohub 三栏界面。

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
<body>${contentHtml}</body>
</html>`
}

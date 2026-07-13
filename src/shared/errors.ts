/**
 * 把底层网络、Electron 和 Node 异常转换成适合直接展示给用户的中文说明。
 * 原始异常仍由 main 进程写入日志；界面不直接暴露晦涩的英文运行时文本。
 */
export function userFacingError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const message = raw
    .trim()
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')

  if (!message) return fallback

  if (
    (error instanceof Error && error.name === 'AbortError') ||
    /aborted due to timeout|timed?\s*out|timeout|etimedout|aborterror|operation was aborted/i.test(message)
  ) {
    return '请求超时：目标服务在规定时间内没有响应。请检查网络连接和服务地址后重试。'
  }

  if (/econnrefused|connection refused/i.test(message)) {
    return '无法连接目标服务：服务可能尚未启动，或地址、端口配置不正确。'
  }

  if (/enotfound|name not resolved|dns/i.test(message)) {
    return '无法解析服务器地址。请检查地址是否正确，以及当前网络的 DNS 是否可用。'
  }

  if (/certificate|cert_|ssl|tls/i.test(message)) {
    return 'HTTPS 安全连接失败。请检查服务器证书、域名和系统时间是否正确。'
  }

  if (/failed to fetch|fetch failed|network\s*error|network request failed|offline|econnreset/i.test(message)) {
    return '网络请求失败。请检查网络连接和目标服务状态后重试。'
  }

  // 已经是业务层中文说明时保留原文，避免丢失服务端返回的具体修复建议。
  if (/[\u3400-\u9fff]/.test(message)) return message

  if (/\b401\b|unauthori[sz]ed/i.test(message)) {
    return '身份验证失败。请确认加入凭证或设备凭证仍然有效。'
  }

  if (/\b403\b|forbidden/i.test(message)) {
    return '服务器拒绝了当前操作。请确认设备已加入团队并具有访问权限。'
  }

  if (/\b404\b|not found/i.test(message)) {
    return '目标服务接口不存在。请确认服务器地址和服务端版本是否正确。'
  }

  if (/\b429\b|too many requests/i.test(message)) {
    return '请求过于频繁，服务器暂时限制访问。请稍后再试。'
  }

  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable/i.test(message)) {
    return '服务器暂时异常。请稍后重试，并检查服务端运行状态。'
  }

  return `${fallback}。请重试；如果问题持续，请检查网络和服务状态。`
}

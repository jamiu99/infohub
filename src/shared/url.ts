/** 把外部地址规范化为绝对 http(s) URL；其他 scheme 与相对路径一律拒绝。 */
export function normalizeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export function isHttpUrl(value: string): boolean {
  return normalizeHttpUrl(value) !== null
}

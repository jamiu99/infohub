// 账号池加密持久化。cookie/token 敏感，用 Electron safeStorage（OS keychain）加密落盘。
import { safeStorage } from 'electron'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import type { WxAccount } from '../shared/wechat'

export function saveAccounts(path: string, accounts: WxAccount[]): void {
  const json = JSON.stringify(accounts)
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(path, safeStorage.encryptString(json))
  } else {
    // 兜底：无 keychain 时明文（开发环境），生产应告警
    writeFileSync(path, json, 'utf8')
  }
}

export function loadAccounts(path: string): WxAccount[] {
  if (!existsSync(path)) return []
  try {
    const buf = readFileSync(path)
    let json: string
    if (safeStorage.isEncryptionAvailable()) {
      json = safeStorage.decryptString(buf)
    } else {
      json = buf.toString('utf8')
    }
    return JSON.parse(json) as WxAccount[]
  } catch {
    return []
  }
}

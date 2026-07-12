import { safeStorage } from 'electron'
import { dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { TeamDeviceCredentials } from '../shared/team'

export function saveTeamCredentials(path: string, credentials: TeamDeviceCredentials): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法安全保存团队设备凭据')
  }
  mkdirSync(dirname(path), { recursive: true })
  const json = JSON.stringify(credentials)
  const content = safeStorage.encryptString(json)
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, content, { mode: 0o600 })
    renameSync(tmp, path)
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true })
  }
}

export function loadTeamCredentials(path: string): TeamDeviceCredentials | null {
  if (!existsSync(path) || !safeStorage.isEncryptionAvailable()) return null
  try {
    const content = readFileSync(path)
    const json = safeStorage.decryptString(content)
    return JSON.parse(json) as TeamDeviceCredentials
  } catch {
    return null
  }
}

export function clearTeamCredentials(path: string): void {
  rmSync(path, { force: true })
}

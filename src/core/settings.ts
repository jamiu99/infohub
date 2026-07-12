// 非敏感运行设置。与 data/secrets 下的账号凭据分开，便于人工查看和备份。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WechatCollectionSettings } from '../shared/wechat'
import {
  WECHAT_HOURLY_LIMIT,
  validateWechatHourlyLimit
} from './collect/rate-limit'
import { DEFAULT_TEAM_SERVER_URL, validateTeamServerUrl } from '../shared/team'

export interface InfohubSettings {
  wechat: {
    hourlyRequestLimit: number
  }
  team: {
    serverUrl: string
    enabled: boolean
  }
}

export function defaultSettings(): InfohubSettings {
  return {
    wechat: { hourlyRequestLimit: WECHAT_HOURLY_LIMIT.default },
    team: { serverUrl: DEFAULT_TEAM_SERVER_URL, enabled: false }
  }
}

/** 配置文件损坏或字段越界时回退保守默认值，避免意外放开真实账号请求量。 */
export function loadSettings(path: string): InfohubSettings {
  if (!existsSync(path)) return defaultSettings()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      wechat?: { hourlyRequestLimit?: unknown }
      team?: { serverUrl?: unknown; enabled?: unknown }
    }
    const hourlyRequestLimit = validateWechatHourlyLimit(parsed.wechat?.hourlyRequestLimit)
    let serverUrl = DEFAULT_TEAM_SERVER_URL
    try {
      serverUrl = validateTeamServerUrl(parsed.team?.serverUrl ?? DEFAULT_TEAM_SERVER_URL)
    } catch {
      // 损坏的团队 URL 不应阻止本地应用启动。
    }
    return {
      wechat: { hourlyRequestLimit },
      team: { serverUrl, enabled: parsed.team?.enabled === true }
    }
  } catch {
    return defaultSettings()
  }
}

/** 先写临时文件再替换，写入失败时保留原配置。 */
export function saveSettings(path: string, settings: InfohubSettings): void {
  const hourlyRequestLimit = validateWechatHourlyLimit(settings.wechat.hourlyRequestLimit)
  const normalized: InfohubSettings = {
    wechat: { hourlyRequestLimit },
    team: {
      serverUrl: validateTeamServerUrl(settings.team.serverUrl),
      enabled: settings.team.enabled === true
    }
  }
  const tmp = `${path}.${process.pid}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true })
  }
}

export function toWechatCollectionSettings(settings: InfohubSettings): WechatCollectionSettings {
  return {
    hourlyRequestLimit: settings.wechat.hourlyRequestLimit,
    minHourlyRequestLimit: WECHAT_HOURLY_LIMIT.min,
    maxHourlyRequestLimit: WECHAT_HOURLY_LIMIT.max,
    recommendedMaxHourlyRequestLimit: WECHAT_HOURLY_LIMIT.recommendedMax
  }
}

// 非敏感运行设置。与私有 state/secrets 下的账号凭据分开保存。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WechatCollectionSettings } from '../shared/wechat'
import {
  WECHAT_HOURLY_LIMIT,
  validateWechatHourlyLimit
} from './collect/rate-limit'
import {
  DEFAULT_TEAM_SERVER_URL,
  TEAM_SYNC_INTERVAL,
  validateTeamServerUrl,
  validateTeamSyncIntervalMinutes
} from '../shared/team'
import {
  AUTO_COLLECT_INTERVAL,
  validateAutoCollectIntervalMinutes,
  type CollectionSettingsView
} from '../shared/collection'

export interface InfohubSettings {
  wechat: {
    hourlyRequestLimit: number
  }
  team: {
    serverUrl: string
    enabled: boolean
    autoSyncEnabled: boolean
    intervalMinutes: number
  }
  collection: {
    autoCollectEnabled: boolean
    intervalMinutes: number
  }
}

export function defaultSettings(): InfohubSettings {
  return {
    wechat: { hourlyRequestLimit: WECHAT_HOURLY_LIMIT.default },
    team: {
      serverUrl: DEFAULT_TEAM_SERVER_URL,
      enabled: false,
      autoSyncEnabled: true,
      intervalMinutes: TEAM_SYNC_INTERVAL.defaultMinutes
    },
    collection: {
      autoCollectEnabled: false,
      intervalMinutes: AUTO_COLLECT_INTERVAL.defaultMinutes
    }
  }
}

/** 配置文件损坏或字段越界时回退保守默认值，避免意外放开真实账号请求量。 */
export function loadSettings(path: string): InfohubSettings {
  if (!existsSync(path)) return defaultSettings()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      wechat?: { hourlyRequestLimit?: unknown }
      team?: {
        serverUrl?: unknown
        enabled?: unknown
        autoSyncEnabled?: unknown
        intervalMinutes?: unknown
      }
      collection?: { autoCollectEnabled?: unknown; intervalMinutes?: unknown }
    }
    const defaults = defaultSettings()
    let hourlyRequestLimit = defaults.wechat.hourlyRequestLimit
    try {
      hourlyRequestLimit = validateWechatHourlyLimit(parsed.wechat?.hourlyRequestLimit)
    } catch {
      // 单个损坏字段只回退自身，不能清空仍有效的团队或自动采集设置。
    }
    let serverUrl = DEFAULT_TEAM_SERVER_URL
    try {
      serverUrl = validateTeamServerUrl(parsed.team?.serverUrl ?? DEFAULT_TEAM_SERVER_URL)
    } catch {
      // 损坏的团队 URL 不应阻止本地应用启动。
    }
    const autoSyncEnabled = typeof parsed.team?.autoSyncEnabled === 'boolean'
      ? parsed.team.autoSyncEnabled
      : defaults.team.autoSyncEnabled
    let teamIntervalMinutes = defaults.team.intervalMinutes
    try {
      teamIntervalMinutes = validateTeamSyncIntervalMinutes(parsed.team?.intervalMinutes)
    } catch {
      // 旧配置缺少字段、或单个周期损坏时，保持原有的 5 分钟自动同步行为。
    }
    let intervalMinutes = defaults.collection.intervalMinutes
    try {
      intervalMinutes = validateAutoCollectIntervalMinutes(parsed.collection?.intervalMinutes)
    } catch {
      // 自动采集周期损坏时回退保守默认值，且保持默认关闭语义。
    }
    return {
      wechat: { hourlyRequestLimit },
      team: {
        serverUrl,
        enabled: parsed.team?.enabled === true,
        autoSyncEnabled,
        intervalMinutes: teamIntervalMinutes
      },
      collection: {
        autoCollectEnabled: parsed.collection?.autoCollectEnabled === true,
        intervalMinutes
      }
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
      enabled: settings.team.enabled === true,
      autoSyncEnabled: settings.team.autoSyncEnabled === true,
      intervalMinutes: validateTeamSyncIntervalMinutes(settings.team.intervalMinutes)
    },
    collection: {
      autoCollectEnabled: settings.collection.autoCollectEnabled === true,
      intervalMinutes: validateAutoCollectIntervalMinutes(settings.collection.intervalMinutes)
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

export function toCollectionSettingsView(settings: InfohubSettings): CollectionSettingsView {
  return {
    autoCollectEnabled: settings.collection.autoCollectEnabled,
    intervalMinutes: settings.collection.intervalMinutes,
    minIntervalMinutes: AUTO_COLLECT_INTERVAL.minMinutes,
    maxIntervalMinutes: AUTO_COLLECT_INTERVAL.maxMinutes,
    recommendedIntervalMinutes: AUTO_COLLECT_INTERVAL.defaultMinutes
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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  toCollectionSettingsView,
  toWechatCollectionSettings
} from '../src/core/settings.ts'
import { validateWechatHourlyLimit } from '../src/core/collect/rate-limit.ts'
import { validateAutoCollectIntervalMinutes } from '../src/shared/collection.ts'

test('设置文件不存在时使用保守默认上限 20', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-settings-'))
  try {
    const settings = loadSettings(join(dir, 'settings.json'))
    assert.equal(settings.wechat.hourlyRequestLimit, 20)
    assert.equal(settings.team.serverUrl, 'https://home.agent-wiki.cn:18038')
    assert.equal(settings.team.enabled, false)
    assert.equal(settings.collection.autoCollectEnabled, false)
    assert.equal(settings.collection.intervalMinutes, 240)
    assert.equal(toWechatCollectionSettings(settings).recommendedMaxHourlyRequestLimit, 50)
    assert.equal(toCollectionSettingsView(settings).minIntervalMinutes, 60)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('自定义小时上限写入 settings.json 并可重新加载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-settings-'))
  const path = join(dir, 'settings.json')
  try {
    const settings = defaultSettings()
    settings.wechat.hourlyRequestLimit = 73
    saveSettings(path, settings)
    assert.equal(loadSettings(path).wechat.hourlyRequestLimit, 73)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      wechat: { hourlyRequestLimit: 73 },
      team: { serverUrl: 'https://home.agent-wiki.cn:18038', enabled: false },
      collection: { autoCollectEnabled: false, intervalMinutes: 240 }
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('损坏或越界的设置回退 20，IPC 输入校验拒绝非整数与过大值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-settings-'))
  const path = join(dir, 'settings.json')
  try {
    writeFileSync(path, '{broken', 'utf8')
    assert.equal(loadSettings(path).wechat.hourlyRequestLimit, 20)
    writeFileSync(path, JSON.stringify({ wechat: { hourlyRequestLimit: 0 } }), 'utf8')
    assert.equal(loadSettings(path).wechat.hourlyRequestLimit, 20)
    assert.throws(
      () => saveSettings(path, {
        wechat: { hourlyRequestLimit: 20 },
        team: { serverUrl: 'http://x', enabled: true },
        collection: { autoCollectEnabled: false, intervalMinutes: 240 }
      }),
      /HTTPS/
    )
    assert.throws(() => validateWechatHourlyLimit(20.5), /1–1000/)
    assert.throws(() => validateWechatHourlyLimit(1001), /1–1000/)
    assert.throws(() => validateAutoCollectIntervalMinutes(59), /60–10080/)
    assert.throws(() => validateAutoCollectIntervalMinutes(10081), /60–10080/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('自动采集设置可持久化，损坏字段只回退自身', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-settings-'))
  const path = join(dir, 'settings.json')
  try {
    const settings = defaultSettings()
    settings.wechat.hourlyRequestLimit = 33
    settings.team.enabled = true
    settings.collection = { autoCollectEnabled: true, intervalMinutes: 720 }
    saveSettings(path, settings)
    assert.deepEqual(loadSettings(path).collection, {
      autoCollectEnabled: true,
      intervalMinutes: 720
    })

    writeFileSync(path, JSON.stringify({
      wechat: { hourlyRequestLimit: 33 },
      team: { serverUrl: 'https://home.agent-wiki.cn:18038', enabled: true },
      collection: { autoCollectEnabled: true, intervalMinutes: 12 }
    }), 'utf8')
    const loaded = loadSettings(path)
    assert.equal(loaded.wechat.hourlyRequestLimit, 33)
    assert.equal(loaded.team.enabled, true)
    assert.equal(loaded.collection.autoCollectEnabled, true)
    assert.equal(loaded.collection.intervalMinutes, 240)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  toWechatCollectionSettings
} from '../src/core/settings.ts'
import { validateWechatHourlyLimit } from '../src/core/collect/rate-limit.ts'

test('设置文件不存在时使用保守默认上限 20', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-settings-'))
  try {
    const settings = loadSettings(join(dir, 'settings.json'))
    assert.equal(settings.wechat.hourlyRequestLimit, 20)
    assert.equal(settings.team.serverUrl, 'https://home.agent-wiki.cn:18038')
    assert.equal(settings.team.enabled, false)
    assert.equal(toWechatCollectionSettings(settings).recommendedMaxHourlyRequestLimit, 50)
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
      team: { serverUrl: 'https://home.agent-wiki.cn:18038', enabled: false }
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
      () => saveSettings(path, { wechat: { hourlyRequestLimit: 20 }, team: { serverUrl: 'http://x', enabled: true } }),
      /HTTPS/
    )
    assert.throws(() => validateWechatHourlyLimit(20.5), /1–1000/)
    assert.throws(() => validateWechatHourlyLimit(1001), /1–1000/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

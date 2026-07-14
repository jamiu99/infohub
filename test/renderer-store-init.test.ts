import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InfohubApi } from '../src/shared/ipc'

test('renderer 初始化单个 IPC 失败时仍先安装事件订阅并保留其他域状态', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const api = {
    account: {
      list: async () => [],
      login: async () => [],
      relogin: async () => [],
      remove: async () => undefined,
      getCollectionSettings: async () => ({
        hourlyRequestLimit: 20,
        minHourlyRequestLimit: 1,
        maxHourlyRequestLimit: 1000,
        recommendedMaxHourlyRequestLimit: 50
      }),
      setHourlyRequestLimit: async () => ({
        hourlyRequestLimit: 20,
        minHourlyRequestLimit: 1,
        maxHourlyRequestLimit: 1000,
        recommendedMaxHourlyRequestLimit: 50
      })
    },
    collection: {
      getSettings: async () => ({
        autoCollectEnabled: false,
        intervalMinutes: 240,
        minIntervalMinutes: 60,
        maxIntervalMinutes: 10080,
        recommendedIntervalMinutes: 240
      }),
      updateSettings: async () => ({
        autoCollectEnabled: false,
        intervalMinutes: 240,
        minIntervalMinutes: 60,
        maxIntervalMinutes: 10080,
        recommendedIntervalMinutes: 240
      }),
      status: async () => ({ state: 'disabled', enabled: false, intervalMinutes: 240 })
    },
    dataLibrary: {
      status: async () => ({
        root: '/data',
        defaultRoot: '/data',
        outputsPath: '/data/outputs',
        customized: false,
        migration: null
      }),
      open: async () => undefined,
      chooseAndMigrate: async () => ({ state: 'cancelled' as const })
    },
    source: {
      list: async () => { throw new Error('corrupted sources payload') },
      search: async () => [],
      add: async () => { throw new Error('unused') },
      remove: async () => undefined,
      refresh: async () => undefined
    },
    article: {
      list: async () => [],
      get: async () => null,
      markRead: async () => undefined,
      archive: async () => undefined,
      unreadCounts: async () => ({}),
      reprocess: async () => ({
        mode: 'offline' as const,
        scope: 'all' as const,
        total: 0,
        updated: 0,
        unchanged: 0,
        failed: 0,
        skipped: 0,
        items: []
      })
    },
    team: {
      status: async () => ({
        state: 'disabled' as const,
        enabled: false,
        serverUrl: 'https://example.test',
        pendingUploads: 0,
        quarantinedUploads: 0
      }),
      join: async () => { throw new Error('unused') },
      leave: async () => ({
        state: 'disabled' as const,
        enabled: false,
        serverUrl: 'https://example.test',
        pendingUploads: 0,
        quarantinedUploads: 0
      }),
      syncNow: async () => ({
        state: 'disabled' as const,
        enabled: false,
        serverUrl: 'https://example.test',
        pendingUploads: 0,
        quarantinedUploads: 0
      })
    },
    update: {
      check: async () => undefined,
      install: async () => undefined
    },
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      listeners.set(channel, callback)
      return () => listeners.delete(channel)
    }
  } as unknown as InfohubApi

  Object.defineProperty(globalThis, 'window', {
    value: { api },
    configurable: true
  })

  const { store } = await import('../src/renderer/src/stores/app')
  await store.init()

  assert.deepEqual(
    [...listeners.keys()].sort(),
    [
      'accounts-changed',
      'articles-changed',
      'collection-status',
      'ingest-progress',
      'team-status',
      'update-status'
    ]
  )
  assert.match(store.state.sourcesError, /信源列表加载失败/)
  assert.equal(store.state.collectionSettings?.intervalMinutes, 240)
  assert.equal(store.state.collectionStatus?.state, 'disabled')
  assert.equal(store.state.dataLibrary?.outputsPath, '/data/outputs')
})

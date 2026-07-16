import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makePaths } from '../src/core/paths'
import { TeamSyncStorage } from '../src/core/team/sync-storage'
import { TeamSyncClient } from '../src/core/team/sync-client'
import { applyRemoteArticle } from '../src/core/team/apply-remote'
import { Store } from '../src/core/store'
import { Collector } from '../src/core/collect/collector'
import { AdapterRegistry } from '../src/core/ingest/adapter'
import '../src/core/process/wechat'
import { toRawItem } from '../src/core/ingest/wechat'
import {
  DEFAULT_TEAM_SERVER_URL,
  rssSourceId,
  TEAM_PUSH_BODY_BUDGET_BYTES,
  toTeamArticlePayload,
  validateTeamServerUrl,
  type TeamArticleRecord,
  type TeamArticleUpload,
  type TeamDeviceCredentials
} from '../src/shared/team'
import type { Article, RawItem, Source } from '../src/shared/contract'
import type { SourceAdapter } from '../src/core/ingest/adapter'

const source: Source = {
  id: 'wx-fake-1',
  type: 'wechat',
  name: '测试公众号',
  enabled: true,
  config: { fakeid: 'fake-1', cookie: 'never-upload', token: 'never-upload' }
}

function article(externalId = 'https://mp.weixin.qq.com/s/test'): Article {
  return {
    id: 'local-article',
    externalId,
    title: '本地文章',
    body: '本地完整正文',
    publishedAt: 100,
    sourceUrl: externalId,
    source: { id: source.id, type: source.type, name: source.name },
    ext: { digest: '摘要', token: 'ext-secret', raw: { cookie: 'secret' } },
    read: false,
    archived: false,
    createdAt: 100,
    updatedAt: 100
  }
}

function record(externalId = 'https://mp.weixin.qq.com/s/test'): TeamArticleRecord {
  return {
    remoteId: 'remote-1',
    source: { id: 'server-source-1', type: 'wechat', name: source.name, config: { fakeid: 'fake-1' } },
    article: {
      externalId,
      title: '团队文章',
      body: '团队正文',
      publishedAt: 100,
      sourceUrl: externalId,
      ext: { digest: '团队摘要' },
      createdAt: 100,
      updatedAt: 200
    },
    contributors: [
      { deviceId: 'other-device', memberName: '伙伴', deviceName: '伙伴电脑', collectedAt: 200 }
    ]
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

test('团队自动同步使用单次 timeout；关闭后仍可入队和手动同步', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-schedule-'))
  const paths = makePaths(dir)
  const credentials: TeamDeviceCredentials = {
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    instanceId: 'instance-schedule',
    teamName: '调度测试',
    device: { id: 'device-schedule', memberName: '我', deviceName: '电脑' },
    deviceToken: 'device-token'
  }
  let now = 1_000
  let nextTimerId = 0
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const requests: string[] = []
  const client = new TeamSyncClient({
    paths,
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    enabled: true,
    autoSyncEnabled: true,
    intervalMinutes: 5,
    credentials,
    now: () => now,
    setTimeoutImpl: (callback, delay) => {
      const id = ++nextTimerId
      timers.set(id, { callback, delay })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeoutImpl: (timer) => timers.delete(timer as unknown as number),
    fetchImpl: async (input, init) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('/api/v2/status')) {
        return jsonResponse({
          instanceId: credentials.instanceId,
          teamName: credentials.teamName,
          device: credentials.device
        })
      }
      if (url.endsWith('/api/v2/sync/push')) {
        const items = (JSON.parse(String(init?.body)) as { items: TeamArticleUpload[] }).items
        return jsonResponse({ accepted: items.length, cursor: 1 })
      }
      return jsonResponse({ cursor: 0, hasMore: false, changes: [] })
    },
    onCredentials: () => undefined,
    onRemoteArticle: () => undefined
  })

  try {
    client.start()
    await client.syncNow()
    assert.deepEqual(requests.map((url) => new URL(url).pathname), [
      '/api/v2/status',
      '/api/v2/sync/pull'
    ])
    assert.equal(timers.size, 1)
    assert.equal([...timers.values()][0].delay, 5 * 60_000)
    assert.equal(client.status().nextSyncAt, now + 5 * 60_000)

    client.configureSchedule({ autoSyncEnabled: false, intervalMinutes: 15 })
    assert.equal(client.status().autoSyncEnabled, false)
    assert.equal(client.status().intervalMinutes, 15)
    assert.equal(client.status().nextSyncAt, undefined)
    assert.equal(timers.size, 0)

    // 关闭只停定时网络；本地结果仍可靠入队，手动同步仍会完成 push/pull。
    assert.equal(client.enqueue(source, { ...article('schedule-manual'), id: 'schedule-manual' }), true)
    const beforeManual = requests.length
    const manual = await client.syncNow()
    assert.equal(requests.length, beforeManual + 3)
    assert.equal(manual.pendingUploads, 0)
    assert.equal(timers.size, 0)

    // 从关闭切到开启会立即同步，并在完成后才安排一个完整周期。
    now = 2_000
    const beforeEnable = requests.length
    client.configureSchedule({ autoSyncEnabled: true, intervalMinutes: 15 })
    await client.syncNow()
    assert.equal(requests.length, beforeEnable + 2)
    assert.equal(timers.size, 1)
    assert.equal([...timers.values()][0].delay, 15 * 60_000)
    assert.equal(client.status().nextSyncAt, now + 15 * 60_000)

    // 已开启时修改频率只重置单个倒计时，不额外发起网络请求或遗留旧 timer。
    const beforeReconfigure = requests.length
    client.configureSchedule({ autoSyncEnabled: true, intervalMinutes: 30 })
    assert.equal(requests.length, beforeReconfigure)
    assert.equal(timers.size, 1)
    assert.equal([...timers.values()][0].delay, 30 * 60_000)
    assert.equal(client.status().nextSyncAt, now + 30 * 60_000)
    assert.throws(
      () => client.configureSchedule({ autoSyncEnabled: false, intervalMinutes: 0 }),
      /1–1440/
    )
    assert.equal(client.status().autoSyncEnabled, true)
    assert.equal(client.status().intervalMinutes, 30)
    assert.equal(timers.size, 1)

    // timer 到点执行一轮；同步期间不会再预排另一个 timer，完成后才续排。
    const [timerId, scheduled] = [...timers.entries()][0]
    timers.delete(timerId)
    now = 3_000
    scheduled.callback()
    assert.equal(client.status().nextSyncAt, undefined)
    await client.syncNow()
    assert.equal(timers.size, 1)
    assert.equal(client.status().nextSyncAt, now + 30 * 60_000)

    client.stop()
    assert.equal(timers.size, 0)
    assert.equal(client.status().nextSyncAt, undefined)

    // 持久化为关闭状态后重新启动，不应偷偷执行启动同步。
    client.configureSchedule({ autoSyncEnabled: false, intervalMinutes: 60 })
    const beforeDisabledStart = requests.length
    client.start()
    await Promise.resolve()
    assert.equal(requests.length, beforeDisabledStart)
    assert.equal(timers.size, 0)
  } finally {
    client.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('团队服务器只允许无凭据、无查询参数的 HTTPS 地址', () => {
  assert.equal(validateTeamServerUrl(`${DEFAULT_TEAM_SERVER_URL}/`), DEFAULT_TEAM_SERVER_URL)
  assert.throws(() => validateTeamServerUrl('http://localhost:18038'), /只允许使用 HTTPS/)
  assert.throws(() => validateTeamServerUrl('https://example.com/?token=x'), /不能包含/)
})

test('outbox 隔离损坏事件，不阻塞后续正常事件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-storage-'))
  const paths = makePaths(dir)
  try {
    const storage = new TeamSyncStorage(paths)
    writeFileSync(join(paths.teamOutbox, '000-broken.json'), '{broken', 'utf8')
    writeFileSync(join(paths.teamOutbox, '001-missing-event-id.json'), '{"source":{}}', 'utf8')
    const item: TeamArticleUpload = {
      eventId: 'zzz-good',
      collectedAt: 1,
      source: { type: 'rss', name: 'RSS', config: { feedUrl: 'https://example.com/feed' } },
      article: {
        externalId: 'e1', title: 't', body: 'b', publishedAt: 1, sourceUrl: 'https://example.com/1'
      }
    }
    storage.enqueue({
      ...item,
      eventId: 'aaa-too-large',
      article: { ...item.article, body: 'x'.repeat(2 * 1024 * 1024 + 1) }
    })
    storage.enqueue(item)
    assert.deepEqual(storage.readBatch(), [item])
    const quarantined = readdirSync(paths.teamQuarantine)
    assert.equal(quarantined.length, 3)
    assert.equal(quarantined.some((name) => /000-broken\.json$/.test(name)), true)
    assert.equal(storage.quarantineCount(), 3)
    storage.saveCursor(7)
    assert.equal(storage.cursor(), 7)
    const second = { ...item, eventId: 'zzz-next', article: { ...item.article, body: 'x'.repeat(500) } }
    storage.enqueue(second)
    assert.equal(storage.readBatch(600).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('outbox 按实际 push JSON 的 UTF-8 字节数分批，并保证至少返回队首一项', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-byte-batch-'))
  const paths = makePaths(dir)
  const makeItem = (eventId: string, contentHtml: string): TeamArticleUpload => ({
    eventId,
    collectedAt: 1,
    source: { type: 'wechat', name: '转义测试', config: { fakeid: 'fake-byte-test' } },
    article: {
      externalId: `https://mp.weixin.qq.com/s/${eventId}`,
      title: '转义测试',
      body: '正文',
      contentHtml,
      publishedAt: 1,
      sourceUrl: `https://mp.weixin.qq.com/s/${eventId}`
    }
  })
  const first = makeItem('a-first', '<div>"\\"\\"\\"</div>')
  const second = makeItem('b-second', '<div>"\\"\\"\\"</div>')
  try {
    const storage = new TeamSyncStorage(paths)
    storage.enqueue(first)
    storage.enqueue(second)
    const firstBytes = Buffer.byteLength(JSON.stringify({ items: [first] }), 'utf8')
    const pairBytes = Buffer.byteLength(JSON.stringify({ items: [first, second] }), 'utf8')
    assert.ok(pairBytes > firstBytes)

    const batch = storage.readBatch(pairBytes - 1)
    assert.deepEqual(batch.map((item) => item.eventId), ['a-first'])
    assert.equal(Buffer.byteLength(JSON.stringify({ items: batch }), 'utf8'), firstBytes)

    // 自定义预算小于单项时仍返回队首；生产预算下这类事件会先被 validation 隔离。
    assert.deepEqual(storage.readBatch(firstBytes - 1).map((item) => item.eventId), ['a-first'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('单篇原文虽未超过 4 MiB，但 JSON 转义后超过 12 MiB 时会本地隔离', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-json-inflation-'))
  const paths = makePaths(dir)
  const credentials: TeamDeviceCredentials = {
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    instanceId: 'instance-json-inflation',
    teamName: '转义测试',
    device: { id: 'device-json-inflation', memberName: '我', deviceName: '电脑' },
    deviceToken: 'device-token'
  }
  const client = new TeamSyncClient({
    paths,
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    enabled: true,
    credentials,
    onCredentials: () => undefined,
    onRemoteArticle: () => undefined
  })
  try {
    const body = '"'.repeat(2 * 1024 * 1024)
    const contentHtml = '"'.repeat(4 * 1024 * 1024)
    assert.equal(Buffer.byteLength(body, 'utf8'), 2 * 1024 * 1024)
    assert.equal(Buffer.byteLength(contentHtml, 'utf8'), 4 * 1024 * 1024)
    assert.equal(
      client.enqueue(source, { ...article('json-inflation'), body, contentHtml }),
      false
    )
    assert.equal(client.status().pendingUploads, 0)
    assert.equal(client.status().quarantinedUploads, 1)
    const quarantine = readFileSync(
      join(paths.teamQuarantine, readdirSync(paths.teamQuarantine)[0]),
      'utf8'
    )
    assert.match(quarantine, /JSON 后超过 12 MiB/)

    const controlCharacter = {
      ...article('control-character'),
      contentHtml: '<div>正文\u0000</div>'
    }
    assert.equal(client.enqueue(source, controlCharacter), false)
    assert.equal(client.status().quarantinedUploads, 2)
  } finally {
    client.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('API v2 硬切换：旧服务 status 404 时暂停，不会 push 或隔离 outbox', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-v2-cutover-'))
  const paths = makePaths(dir)
  const credentials: TeamDeviceCredentials = {
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    instanceId: 'instance-v2',
    teamName: 'v2 测试',
    device: { id: 'device-v2', memberName: '我', deviceName: '电脑' },
    deviceToken: 'device-token'
  }
  const requests: string[] = []
  const client = new TeamSyncClient({
    paths,
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    enabled: true,
    credentials,
    fetchImpl: async (input) => {
      requests.push(String(input))
      return jsonResponse({ error: { code: 'not_found', message: '旧服务没有此路径' } }, 404)
    },
    onCredentials: () => undefined,
    onRemoteArticle: () => undefined
  })
  try {
    assert.equal(client.enqueue(source, article('v2-cutover')), true)
    const result = await client.syncNow()
    assert.equal(result.state, 'error')
    assert.match(result.error ?? '', /API v2/)
    assert.equal(result.pendingUploads, 1)
    assert.equal(result.quarantinedUploads, 0)
    assert.deepEqual(requests, [`${DEFAULT_TEAM_SERVER_URL}/api/v2/status`])
  } finally {
    client.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('服务端永久拒绝只隔离坏事件，合法事件继续上传；私有 RSS URL 不进入 outbox', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-poison-'))
  const paths = makePaths(dir)
  const credentials: TeamDeviceCredentials = {
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    instanceId: 'instance-1',
    teamName: '团队',
    device: { id: 'device-1', memberName: '我', deviceName: '电脑' },
    deviceToken: 'device-token'
  }
  const uploaded: string[] = []
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/api/v2/status')) {
      return jsonResponse({
        instanceId: credentials.instanceId,
        teamName: credentials.teamName,
        device: credentials.device
      })
    }
    if (url.endsWith('/api/v2/sync/push')) {
      const items = (JSON.parse(String(init?.body)) as { items: TeamArticleUpload[] }).items
      if (items.some((item) => item.article.externalId === 'server-reject')) {
        return jsonResponse({ error: { code: 'bad_request', message: '测试拒绝' } }, 400)
      }
      uploaded.push(...items.map((item) => item.article.externalId))
      return jsonResponse({ accepted: items.length, cursor: 1 })
    }
    return jsonResponse({ cursor: 0, hasMore: false, changes: [] })
  }
  const client = new TeamSyncClient({
    paths,
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    enabled: true,
    credentials,
    fetchImpl: fakeFetch,
    onCredentials: () => undefined,
    onRemoteArticle: () => undefined
  })
  try {
    assert.equal(client.enqueue(source, { ...article('server-reject'), id: 'rejected' }), true)
    assert.equal(client.enqueue(source, { ...article('accepted'), id: 'accepted' }), true)
    const synced = await client.syncNow()
    assert.equal(synced.state, 'ready')
    assert.equal(synced.pendingUploads, 0)
    assert.equal(synced.quarantinedUploads, 1)
    assert.deepEqual(uploaded, ['accepted'])

    const privateRss: Source = {
      id: 'rss-private',
      type: 'rss',
      name: '私有 RSS',
      enabled: true,
      config: { feedUrl: 'https://example.com/feed?access_token=do-not-upload' }
    }
    assert.equal(
      client.enqueue(privateRss, {
        ...article('private-entry'),
        id: 'private-entry',
        source: { id: privateRss.id, type: privateRss.type, name: privateRss.name }
      }),
      false
    )
    assert.equal(client.status().quarantinedUploads, 2)
    const quarantineText = readdirSync(paths.teamQuarantine)
      .map((name) => readFileSync(join(paths.teamQuarantine, name), 'utf8'))
      .join('\n')
    assert.doesNotMatch(quarantineText, /do-not-upload/)
  } finally {
    client.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('加入后设备 token 由服务端返回；断网保留 allowlist outbox，恢复后 push/pull', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-client-'))
  const paths = makePaths(dir)
  let mode: 'join' | 'offline' | 'online' = 'join'
  let persisted: TeamDeviceCredentials | null = null
  let pulledMine: boolean | undefined
  let pushJson = ''
  let authorization = ''
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (mode === 'join') {
      assert.match(url, /\/api\/v2\/join$/)
      assert.deepEqual(JSON.parse(String(init?.body)), {
        teamToken: 'shared-once', memberName: '我', deviceName: '测试电脑'
      })
      return jsonResponse({
        instanceId: 'instance-1', teamName: '我的团队',
        device: { id: 'device-1', memberName: '我', deviceName: '测试电脑' },
        deviceToken: 'server-device-token'
      })
    }
    if (mode === 'offline') return jsonResponse({ error: { code: 'OFFLINE', message: '暂时离线' } }, 503)
    authorization = new Headers(init?.headers).get('authorization') ?? ''
    if (url.endsWith('/api/v2/status')) {
      return jsonResponse({
        instanceId: 'instance-1', teamName: '我的团队',
        device: { id: 'device-1', memberName: '我', deviceName: '测试电脑' }
      })
    }
    if (url.includes('/sync/push')) {
      pushJson = String(init?.body)
      return jsonResponse({ accepted: 1, cursor: 1 })
    }
    return jsonResponse({
      cursor: 7,
      hasMore: false,
      changes: [{ seq: 7, type: 'article.upsert', article: record('remote-external') }]
    })
  }
  const client = new TeamSyncClient({
    paths,
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    enabled: false,
    fetchImpl: fakeFetch,
    onCredentials: (value) => { persisted = value },
    onRemoteArticle: (_record, mine) => { pulledMine = mine }
  })
  try {
    await client.join({
      serverUrl: DEFAULT_TEAM_SERVER_URL,
      teamToken: 'shared-once',
      memberName: '我',
      deviceName: '测试电脑'
    })
    assert.equal(persisted?.deviceToken, 'server-device-token')
    assert.equal(Object.hasOwn(persisted ?? {}, 'teamToken'), false)

    assert.equal(client.seedExisting([source], [{ ...article(), contentHtml: '<div>微信原始排版</div>' }]), 1)
    mode = 'offline'
    const failed = await client.syncNow()
    assert.equal(failed.state, 'error')
    assert.match(failed.error ?? '', /暂时离线/)
    assert.equal(failed.pendingUploads, 1)
    const queued = readFileSync(join(paths.teamOutbox, readdirSync(paths.teamOutbox)[0]), 'utf8')
    const queuedObject = JSON.parse(queued) as {
      source: { config: object }
      article: { ext: object; contentHtml?: string }
    }
    assert.deepEqual(queuedObject.source.config, { fakeid: 'fake-1' })
    assert.deepEqual(queuedObject.article.ext, { digest: '摘要' })
    assert.equal(queuedObject.article.contentHtml, '<div>微信原始排版</div>')
    assert.doesNotMatch(queued, /never-upload|ext-secret/)

    mode = 'online'
    const synced = await client.syncNow()
    assert.equal(synced.state, 'ready')
    assert.equal(synced.pendingUploads, 0)
    assert.equal(authorization, 'Bearer server-device-token')
    assert.equal(JSON.parse(pushJson).items.length, 1)
    assert.equal(pulledMine, false)
    assert.equal(new TeamSyncStorage(paths).cursor(), 7)

    const left = client.leave()
    assert.equal(left.state, 'disabled')
    assert.equal(persisted, null)
  } finally {
    client.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('多篇接近 4 MiB 的正文 HTML 会按 12 MiB JSON 预算拆成多个 push，pull 每页 50 条', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-html-batches-'))
  const paths = makePaths(dir)
  const credentials: TeamDeviceCredentials = {
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    instanceId: 'instance-html-batches',
    teamName: '大正文测试',
    device: { id: 'device-html-batches', memberName: '我', deviceName: '电脑' },
    deviceToken: 'device-token'
  }
  const pushBodies: string[] = []
  let pullUrl = ''
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/api/v2/status')) {
      return jsonResponse({
        instanceId: credentials.instanceId,
        teamName: credentials.teamName,
        device: credentials.device
      })
    }
    if (url.endsWith('/api/v2/sync/push')) {
      pushBodies.push(String(init?.body))
      const items = (JSON.parse(String(init?.body)) as { items: TeamArticleUpload[] }).items
      return jsonResponse({ accepted: items.length, cursor: pushBodies.length })
    }
    pullUrl = url
    return jsonResponse({ cursor: 0, hasMore: false, changes: [] })
  }
  const client = new TeamSyncClient({
    paths,
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    enabled: true,
    credentials,
    fetchImpl: fakeFetch,
    onCredentials: () => undefined,
    onRemoteArticle: () => undefined
  })
  try {
    const wrapperBytes = Buffer.byteLength('<div></div>', 'utf8')
    const contentHtml = `<div>${'x'.repeat(4 * 1024 * 1024 - wrapperBytes)}</div>`
    assert.equal(Buffer.byteLength(contentHtml, 'utf8'), 4 * 1024 * 1024)
    for (let index = 0; index < 3; index++) {
      assert.equal(
        client.enqueue(source, {
          ...article(`https://mp.weixin.qq.com/s/large-${index}`),
          id: `large-${index}`,
          contentHtml
        }),
        true
      )
    }

    const result = await client.syncNow()
    assert.equal(result.state, 'ready')
    assert.equal(result.pendingUploads, 0)
    assert.equal(pushBodies.length, 2)
    assert.deepEqual(
      pushBodies.map((body) => (JSON.parse(body) as { items: unknown[] }).items.length),
      [2, 1]
    )
    assert.equal(
      pushBodies.every((body) => Buffer.byteLength(body, 'utf8') <= TEAM_PUSH_BODY_BUDGET_BYTES),
      true
    )
    assert.match(pullUrl, /\/api\/v2\/sync\/pull\?cursor=0&limit=50$/)
  } finally {
    client.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('团队同步直接发送可用的正文 HTML，不依赖协议能力协商', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-content-payload-'))
  const paths = makePaths(dir)
  const credentials: TeamDeviceCredentials = {
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    instanceId: 'instance-content',
    teamName: '正文测试',
    device: { id: 'device-content', memberName: '我', deviceName: '电脑' },
    deviceToken: 'device-token'
  }
  const client = new TeamSyncClient({
    paths,
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    enabled: true,
    credentials,
    onCredentials: () => undefined,
    onRemoteArticle: () => undefined
  })
  const detail = { ...article('content-entry'), contentHtml: '<div id="js_content">原始排版</div>' }
  try {
    assert.equal(client.enqueue(source, detail), true)
    const payload = JSON.parse(
      readFileSync(join(paths.teamOutbox, readdirSync(paths.teamOutbox)[0]), 'utf8')
    ) as TeamArticleUpload
    assert.equal(payload.article.contentHtml, detail.contentHtml)
  } finally {
    client.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('微信 partial/failed 正文不会被标成完整内容进入团队队列', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-partial-content-'))
  const paths = makePaths(dir)
  const credentials: TeamDeviceCredentials = {
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    instanceId: 'instance-partial-content',
    teamName: '正文状态测试',
    device: { id: 'device-partial-content', memberName: '我', deviceName: '电脑' },
    deviceToken: 'device-token'
  }
  const client = new TeamSyncClient({
    paths,
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    enabled: true,
    credentials,
    onCredentials: () => undefined,
    onRemoteArticle: () => undefined
  })
  const partial = {
    ...article('aid:partial'),
    content: {
      status: 'partial' as const,
      parserVersion: 2,
      lastAttemptAt: 100,
      error: { code: 'PARTIAL', message: '只解析到部分正文' }
    },
    contentHtml: '<div id="js_content">不完整正文</div>'
  }
  try {
    assert.equal(toTeamArticlePayload(partial).contentHtml, undefined)
    assert.equal(client.enqueue(source, partial), false)
    assert.equal(client.status().pendingUploads, 0)
  } finally {
    client.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('阅读与归档不会推进内容版本，团队 payload 和确定性事件保持不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-local-state-version-'))
  const paths = makePaths(dir)
  const store = new Store(paths)
  const credentials: TeamDeviceCredentials = {
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    instanceId: 'instance-local-state',
    teamName: '本地状态测试',
    device: { id: 'device-local-state', memberName: '我', deviceName: '电脑' },
    deviceToken: 'device-token'
  }
  const client = new TeamSyncClient({
    paths,
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    enabled: true,
    credentials,
    onCredentials: () => undefined,
    onRemoteArticle: () => undefined
  })
  try {
    const saved = store.saveArticle({ ...article('local-state-stable'), updatedAt: 123 })
    const before = store.getArticleDetail(saved.id)!
    const payloadBefore = toTeamArticlePayload(before)
    assert.equal(client.enqueue(source, before), true)
    const firstEvent = JSON.parse(
      readFileSync(join(paths.teamOutbox, readdirSync(paths.teamOutbox)[0]), 'utf8')
    ) as TeamArticleUpload

    store.setRead(saved.id, true)
    store.setArchived(saved.id, true)
    const after = store.getArticleDetail(saved.id)!
    assert.equal(after.read, true)
    assert.equal(after.archived, true)
    assert.equal(after.updatedAt, 123)
    assert.deepEqual(toTeamArticlePayload(after), payloadBefore)
    assert.equal(client.enqueue(source, after), false)
    assert.equal(readdirSync(paths.teamOutbox).length, 1)
    const sameEvent = JSON.parse(
      readFileSync(join(paths.teamOutbox, readdirSync(paths.teamOutbox)[0]), 'utf8')
    ) as TeamArticleUpload
    assert.equal(sameEvent.eventId, firstEvent.eventId)
  } finally {
    client.stop()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('确定性事件在重启恢复时复用 outbox，2xx ack 后再次扫描不会重复上传', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-resume-'))
  const paths = makePaths(dir)
  const credentials: TeamDeviceCredentials = {
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    instanceId: 'instance-resume',
    teamName: '恢复测试',
    device: { id: 'device-resume', memberName: '我', deviceName: '电脑' },
    deviceToken: 'device-token'
  }
  let pushes = 0
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/api/v2/status')) {
      return jsonResponse({
        instanceId: credentials.instanceId,
        teamName: credentials.teamName,
        device: credentials.device
      })
    }
    if (url.includes('/sync/push')) {
      pushes++
      return jsonResponse({ accepted: 1, cursor: 1 })
    }
    return jsonResponse({ cursor: 1, hasMore: false, changes: [] })
  }
  const makeClient = () => new TeamSyncClient({
    paths,
    serverUrl: DEFAULT_TEAM_SERVER_URL,
    enabled: true,
    credentials,
    fetchImpl: fakeFetch,
    onCredentials() {},
    onRemoteArticle() {}
  })
  try {
    const first = makeClient()
    assert.equal(first.seedExisting([source], [article()]), 1)
    assert.equal(first.status().pendingUploads, 1)

    // 模拟进程在排队后退出：新实例扫描相同内容，不创建第二个事件。
    const restarted = makeClient()
    assert.equal(restarted.seedExisting([source], [article()]), 0)
    assert.equal(restarted.status().pendingUploads, 1)
    assert.equal((await restarted.syncNow()).pendingUploads, 0)
    assert.equal(pushes, 1)
    assert.equal(readdirSync(paths.teamAcked).length, 1)

    // 模拟 2xx 已确认后的下一次启动：ack 标记阻止全量历史重复上传。
    const afterAck = makeClient()
    assert.equal(afterAck.seedExisting([source], [article()]), 0)
    assert.equal(afterAck.status().pendingUploads, 0)
    await afterAck.syncNow()
    assert.equal(pushes, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mine/team scope 可由文章文件重建，pull 不覆盖本地阅读状态和较完整正文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-store-'))
  const store = new Store(makePaths(dir))
  try {
    const local = store.saveArticle(article('local-external'))
    store.setRead(local.id, true)
    const merged = applyRemoteArticle(store, {
      ...record('local-external'),
      remoteId: 'same-local'
    }, false)
    assert.equal(merged.read, true)
    assert.equal(merged.body, '本地完整正文')
    assert.equal(merged.team?.contributedByMe, true)

    const remote = applyRemoteArticle(store, record('team-only'), false)
    assert.equal(remote.team?.contributedByMe, false)
    assert.equal(store.listArticles({ scope: 'mine' }).length, 1)
    assert.equal(store.listArticles({ scope: 'team' }).length, 2)
    const refreshedRemote = applyRemoteArticle(
      store,
      {
        ...record('team-only'),
        article: { ...record('team-only').article, body: '团队更新后的完整正文', updatedAt: 300 }
      },
      false
    )
    assert.equal(refreshedRemote.body, '团队更新后的完整正文')
    store.rebuildIndex()
    assert.equal(store.listArticles({ scope: 'mine' }).length, 1)
    assert.equal(store.listArticles({ scope: 'team' }).length, 2)
    store.setArchived(local.id, true)
    assert.equal(store.listContributedArticlesForSync().map((item) => item.id).includes(local.id), true)
    store.rebuildIndex()
    assert.equal(store.listArticles({ scope: 'mine', filter: 'archived' })[0]?.id, local.id)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('团队正文 HTML 使用 sidecar 合并：本机贡献优先，缺失 HTML 的更新不会清空已有排版', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-content-html-'))
  const store = new Store(makePaths(dir))
  try {
    const local = store.saveArticle(
      {
        ...article('local-html'),
        content: {
          status: 'complete',
          parserVersion: 1,
          lastAttemptAt: 100,
          lastSuccessAt: 100
        }
      },
      { contentHtml: '<div id="js_content">本机排版</div>' }
    )
    applyRemoteArticle(store, {
      ...record('local-html'),
      remoteId: 'remote-local-html',
      article: {
        ...record('local-html').article,
        contentHtml: '<div id="js_content">团队排版</div>'
      }
    }, false)
    assert.equal(store.getArticleDetail(local.id)?.contentHtml, '<div id="js_content">本机排版</div>')

    const remoteRecord: TeamArticleRecord = {
      ...record('team-html'),
      remoteId: 'remote-team-html',
      article: {
        ...record('team-html').article,
        contentHtml: '<div id="js_content">团队初版排版</div>'
      }
    }
    const remote = applyRemoteArticle(store, remoteRecord, false)
    assert.equal(
      store.getArticleDetail(remote.id)?.contentHtml,
      '<div id="js_content">团队初版排版</div>'
    )

    // 某次抓取只有 Markdown 时，不能把已有 HTML sidecar 清空。
    applyRemoteArticle(store, {
      ...remoteRecord,
      article: { ...remoteRecord.article, contentHtml: undefined, body: '正文更新', updatedAt: 300 }
    }, false)
    assert.equal(
      store.getArticleDetail(remote.id)?.contentHtml,
      '<div id="js_content">团队初版排版</div>'
    )

    applyRemoteArticle(store, {
      ...remoteRecord,
      article: {
        ...remoteRecord.article,
        contentHtml: '<div id="js_content">团队新版排版</div>',
        updatedAt: 400
      }
    }, false)
    assert.equal(
      store.getArticleDetail(remote.id)?.contentHtml,
      '<div id="js_content">团队新版排版</div>'
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('团队 RSS 使用规范化 URL 匹配现有本地来源，避免重复 Source ID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-rss-source-'))
  const store = new Store(makePaths(dir))
  const localRss: Source = {
    id: 'rss-original-hash',
    type: 'rss',
    name: '本地 RSS',
    enabled: true,
    config: { feedUrl: 'https://example.com?b=2&a=1' }
  }
  try {
    const remote = applyRemoteArticle(
      store,
      {
        ...record('rss-guid'),
        remoteId: 'remote-rss',
        source: {
          id: 'server-rss',
          type: 'rss',
          name: '团队 RSS',
          config: { feedUrl: 'https://example.com/?a=1&b=2' }
        }
      },
      false,
      [localRss]
    )
    assert.equal(remote.source.id, localRss.id)
    assert.equal(
      rssSourceId('https://example.com?b=2&a=1#fragment'),
      rssSourceId('https://example.com/?a=1&b=2')
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('取消订阅删除纯本地文章但保留团队副本，pull/重建/重新订阅均不重复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-unfollow-'))
  const store = new Store(makePaths(dir))
  const retainedExternalId = 'aid:2_1'
  try {
    const pureLocal = store.saveArticle(article('pure-local'))
    const retained = applyRemoteArticle(store, record(retainedExternalId), false)
    store.setRead(retained.id, true)
    store.setArchived(retained.id, true)

    store.purgeSource(source.id)
    assert.equal(store.getArticle(pureLocal.id), null)
    let kept = store.getArticle(retained.id)
    assert.equal(kept?.team?.contributedByMe, false)
    assert.equal(kept?.team?.detachedFromLocalSource, true)
    assert.equal(kept?.read, true)
    assert.equal(kept?.archived, true)
    assert.equal(store.isSeen(source.id, retainedExternalId), true)

    // 服务端再次推送当前设备 contribution，也不能撤销本地“已取消订阅”状态或复制文件。
    const pulledAgain = applyRemoteArticle(store, {
      ...record(retainedExternalId),
      contributors: [
        { deviceId: 'current-device', memberName: '我', deviceName: '电脑', collectedAt: 300 }
      ]
    }, true)
    assert.equal(pulledAgain.id, retained.id)
    assert.equal(pulledAgain.team?.contributedByMe, false)
    assert.equal(store.listArticles({ scope: 'team', filter: 'archived' }).length, 1)

    store.rebuildIndex()
    kept = store.findArticleByExternalId(source.id, retainedExternalId)
    assert.equal(kept?.id, retained.id)
    assert.equal(kept?.team?.detachedFromLocalSource, true)

    // 重新订阅并真实采到同一条目：命中 retained 文件、恢复 mine，不新增 Article。
    store.saveSources([source])
    const raw = toRawItem(source.id, {
      aid: '2_1', appmsgid: 2, title: '重新订阅采到',
      link: 'https://mp.weixin.qq.com/s?__biz=test&mid=2&idx=1', create_time: 2
    })
    const registry = new AdapterRegistry()
    registry.register({ type: 'wechat', async fetch() { return { items: [raw], status: 'ok' } } })
    const collector = new Collector(registry, store)
    assert.equal((await collector.collectSource(source)).newArticles, 1)
    kept = store.findArticleByExternalId(source.id, retainedExternalId)
    assert.equal(kept?.id, retained.id)
    assert.equal(kept?.team?.contributedByMe, true)
    assert.equal(kept?.team?.detachedFromLocalSource, false)
    assert.equal(store.listArticles({ scope: 'team', filter: 'archived' }).length, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('团队文章先 pull、随后本机真实采到时翻转贡献并入队，不丢正文和阅读状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-team-flip-'))
  const store = new Store(makePaths(dir))
  const externalId = 'aid:1_1'
  const sourceUrl = 'https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1'
  const remoteRecord = record(externalId)
  remoteRecord.article.sourceUrl = sourceUrl
  remoteRecord.article.contentHtml = '<div id="js_content">团队正文</div>'
  const pulled = applyRemoteArticle(store, remoteRecord, false)
  store.setRead(pulled.id, true)
  const raw: RawItem = toRawItem(source.id, {
    aid: '1_1', appmsgid: 1, title: '本机再次采到', digest: 'x', link: sourceUrl,
    author_name: '作者', create_time: 1
  })
  const adapter: SourceAdapter = {
    type: 'wechat',
    contentParserVersion: 1,
    async fetch() { return { items: [raw], status: 'ok' } },
    async enrichContent() {
      return {
        body: '团队正文',
        contentHtml: '<div id="js_content">团队正文</div>',
        pageHtml: '<html><div id="js_content">团队正文</div></html>',
        status: 'complete',
        parserVersion: 1
      }
    }
  }
  const registry = new AdapterRegistry()
  registry.register(adapter)
  let queued: Article | null = null
  const collector = new Collector(registry, store, (_source, value) => { queued = value })
  try {
    const result = await collector.collectSource(source)
    assert.equal(result.newArticles, 1)
    assert.equal(queued?.team?.contributedByMe, true)
    assert.equal(queued?.read, true)
    assert.equal(queued?.body, '团队正文')
    assert.ok(store.getArticle(pulled.id)?.content?.pageHtmlPath)
    assert.equal(store.listArticles({ scope: 'mine' }).length, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

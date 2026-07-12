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
    assert.deepEqual(storage.readBatch(1), [item])
    const quarantined = readdirSync(paths.teamQuarantine)
    assert.equal(quarantined.length, 3)
    assert.equal(quarantined.some((name) => /000-broken\.json$/.test(name)), true)
    assert.equal(storage.quarantineCount(), 3)
    storage.saveCursor(7)
    assert.equal(storage.cursor(), 7)
    const second = { ...item, eventId: 'zzz-next', article: { ...item.article, body: 'x'.repeat(500) } }
    storage.enqueue(second)
    assert.equal(storage.readBatch(100, 600).length, 1)
  } finally {
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
    if (url.endsWith('/api/v1/status')) {
      return jsonResponse({
        instanceId: credentials.instanceId,
        teamName: credentials.teamName,
        device: credentials.device
      })
    }
    if (url.endsWith('/api/v1/sync/push')) {
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
      assert.match(url, /\/api\/v1\/join$/)
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
    if (url.endsWith('/api/v1/status')) {
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

    assert.equal(client.seedExisting([source], [article()]), 1)
    mode = 'offline'
    const failed = await client.syncNow()
    assert.equal(failed.state, 'error')
    assert.match(failed.error ?? '', /暂时离线/)
    assert.equal(failed.pendingUploads, 1)
    const queued = readFileSync(join(paths.teamOutbox, readdirSync(paths.teamOutbox)[0]), 'utf8')
    const queuedObject = JSON.parse(queued) as { source: { config: object }; article: { ext: object } }
    assert.deepEqual(queuedObject.source.config, { fakeid: 'fake-1' })
    assert.deepEqual(queuedObject.article.ext, { digest: '摘要' })
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
    if (url.endsWith('/api/v1/status')) {
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
  try {
    const pureLocal = store.saveArticle(article('pure-local'))
    const retained = applyRemoteArticle(store, record('team-retained'), false)
    store.setRead(retained.id, true)
    store.setArchived(retained.id, true)

    store.purgeSource(source.id)
    assert.equal(store.getArticle(pureLocal.id), null)
    let kept = store.getArticle(retained.id)
    assert.equal(kept?.team?.contributedByMe, false)
    assert.equal(kept?.team?.detachedFromLocalSource, true)
    assert.equal(kept?.read, true)
    assert.equal(kept?.archived, true)
    assert.equal(store.isSeen(source.id, 'team-retained'), true)

    // 服务端再次推送当前设备 contribution，也不能撤销本地“已取消订阅”状态或复制文件。
    const pulledAgain = applyRemoteArticle(store, {
      ...record('team-retained'),
      contributors: [
        { deviceId: 'current-device', memberName: '我', deviceName: '电脑', collectedAt: 300 }
      ]
    }, true)
    assert.equal(pulledAgain.id, retained.id)
    assert.equal(pulledAgain.team?.contributedByMe, false)
    assert.equal(store.listArticles({ scope: 'team', filter: 'archived' }).length, 1)

    store.rebuildIndex()
    kept = store.findArticleByExternalId(source.id, 'team-retained')
    assert.equal(kept?.id, retained.id)
    assert.equal(kept?.team?.detachedFromLocalSource, true)

    // 重新订阅并真实采到同一条目：命中 retained 文件、恢复 mine，不新增 Article。
    const raw = toRawItem(source.id, {
      aid: '2_1', appmsgid: 2, title: '重新订阅采到', link: 'team-retained', create_time: 2
    })
    const registry = new AdapterRegistry()
    registry.register({ type: 'wechat', async fetch() { return { items: [raw], status: 'ok' } } })
    const collector = new Collector(registry, store)
    assert.equal((await collector.collectSource(source)).newArticles, 1)
    kept = store.findArticleByExternalId(source.id, 'team-retained')
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
  const externalId = 'https://mp.weixin.qq.com/s/local-later'
  const pulled = applyRemoteArticle(store, record(externalId), false)
  store.setRead(pulled.id, true)
  const raw: RawItem = toRawItem(source.id, {
    aid: '1_1', appmsgid: 1, title: '本机再次采到', digest: 'x', link: externalId,
    author_name: '作者', create_time: 1
  })
  const adapter: SourceAdapter = {
    type: 'wechat',
    async fetch() { return { items: [raw], status: 'ok' } }
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
    assert.equal(store.listArticles({ scope: 'mine' }).length, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

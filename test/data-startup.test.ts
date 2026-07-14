import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  activateDataLocation,
  DataLocationError,
  dataLocationContext,
  resolveDataLocation
} from '../src/main/data-location'
import {
  DataStartupError,
  dataStartupFiles,
  importLegacyPrivateState,
  prepareDataStartup,
  queuePendingDataMigration,
  readLastDataMigrationResult,
  readPendingDataMigration
} from '../src/main/data-startup'
import { createLibraryManifest } from '../src/main/data-manifest'

test('首次 v0.4 启动只复制缺失的旧私有状态，既不覆盖目标也不删除源', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'infohub-startup-legacy-'))
  const context = dataLocationContext(userData)
  try {
    mkdirSync(join(context.defaultRoot, 'secrets'), { recursive: true })
    mkdirSync(join(context.defaultRoot, 'team', 'outbox'), { recursive: true })
    writeFileSync(join(context.defaultRoot, 'settings.json'), '{"from":"legacy"}', 'utf8')
    writeFileSync(join(context.defaultRoot, 'secrets', 'wx.enc'), 'legacy-secret', 'utf8')
    writeFileSync(join(context.defaultRoot, 'team', 'outbox', '1.json'), 'legacy-event', 'utf8')

    mkdirSync(context.privatePaths.stateRoot, { recursive: true })
    writeFileSync(context.privatePaths.settings, '{"from":"current"}', 'utf8')

    const startup = await prepareDataStartup(userData, { now: () => 100 })
    assert.deepEqual(startup.legacyPrivateState.copied, ['secrets', 'team'])
    assert.deepEqual(startup.legacyPrivateState.skippedExisting, ['settings.json'])
    assert.equal(readFileSync(context.privatePaths.settings, 'utf8'), '{"from":"current"}')
    assert.equal(readFileSync(join(context.privatePaths.secrets, 'wx.enc'), 'utf8'), 'legacy-secret')
    assert.equal(readFileSync(join(context.privatePaths.team, 'outbox', '1.json'), 'utf8'), 'legacy-event')

    assert.equal(readFileSync(join(context.defaultRoot, 'settings.json'), 'utf8'), '{"from":"legacy"}')
    assert.equal(readFileSync(join(context.defaultRoot, 'secrets', 'wx.enc'), 'utf8'), 'legacy-secret')
    assert.equal(readFileSync(join(context.defaultRoot, 'team', 'outbox', '1.json'), 'utf8'), 'legacy-event')
    assert.equal(startup.paths.root, context.defaultRoot)
    assert.equal(startup.paths.settings, context.privatePaths.settings)
    assert.equal(existsSync(context.privatePaths.legacyPrivateImportMarker), true)

    writeFileSync(join(context.defaultRoot, 'secrets', 'new.enc'), 'must-not-merge', 'utf8')
    rmSync(context.privatePaths.settings, { force: true })
    rmSync(context.privatePaths.secrets, { recursive: true, force: true })
    rmSync(context.privatePaths.team, { recursive: true, force: true })
    const second = importLegacyPrivateState(userData)
    assert.deepEqual(second.copied, [])
    assert.deepEqual(second.skippedExisting, [])
    assert.equal(second.alreadyCompleted, true)
    assert.equal(existsSync(join(context.privatePaths.secrets, 'new.enc')), false)
    assert.equal(existsSync(context.privatePaths.settings), false)
    assert.equal(existsSync(context.privatePaths.team), false)

    writeFileSync(context.privatePaths.legacyPrivateImportMarker, '{broken', 'utf8')
    assert.throws(
      () => importLegacyPrivateState(userData),
      (error: unknown) =>
        error instanceof DataStartupError && /拒绝重新导入凭据/.test(error.message)
    )
    assert.equal(existsSync(context.privatePaths.secrets), false)
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

test('旧私有状态中的符号链接会被拒绝，不会复制链接目标', (t) => {
  const userData = mkdtempSync(join(tmpdir(), 'infohub-startup-legacy-link-'))
  const context = dataLocationContext(userData)
  try {
    mkdirSync(join(context.defaultRoot, 'secrets'), { recursive: true })
    writeFileSync(join(context.defaultRoot, 'outside.txt'), 'outside', 'utf8')
    try {
      symlinkSync('../outside.txt', join(context.defaultRoot, 'secrets', 'link.enc'))
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('当前平台不允许测试进程创建 symlink')
        return
      }
      throw error
    }
    assert.throws(
      () => importLegacyPrivateState(userData),
      (error: unknown) => error instanceof DataStartupError && /符号链接/.test(error.message)
    )
    assert.equal(existsSync(context.privatePaths.secrets), false)
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

test('待迁移请求必须使用绝对路径，并以 schema 和时间持久化到 state/migrations', () => {
  const userData = mkdtempSync(join(tmpdir(), 'infohub-startup-pending-'))
  try {
    assert.throws(
      () => queuePendingDataMigration(userData, 'relative/data'),
      (error: unknown) => error instanceof DataStartupError && /绝对路径/.test(error.message)
    )
    const target = join(userData, '..', 'custom library')
    const queued = queuePendingDataMigration(userData, target, () => 1234)
    assert.deepEqual(queued, {
      schemaVersion: 1,
      targetRoot: resolve(target),
      requestedAt: 1234
    })
    assert.deepEqual(readPendingDataMigration(userData), queued)
    assert.equal(dataStartupFiles(userData).pendingRequest, join(userData, 'state', 'migrations', 'pending.json'))
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

test('下次启动在 Store 打开前迁移并切换 activeRoot，源资料库始终保留', async () => {
  const home = mkdtempSync(join(tmpdir(), 'infohub-startup-success-'))
  const userData = join(home, 'user-data')
  const target = join(home, 'moved-library')
  try {
    mkdirSync(join(userData, 'data', 'articles'), { recursive: true })
    writeFileSync(join(userData, 'data', 'articles', 'a.md'), 'original article', 'utf8')
    await prepareDataStartup(userData, { now: () => 10 })
    mkdirSync(target)
    queuePendingDataMigration(userData, target, () => 20)

    let currentTime = 30
    const startup = await prepareDataStartup(userData, {
      now: () => currentTime++,
      migrationId: () => 'startup-success'
    })
    const source = join(userData, 'data')
    assert.equal(startup.location.activeRoot, target)
    assert.equal(startup.location.bootstrap?.lastGoodRoot, source)
    assert.equal(startup.paths.root, target)
    assert.equal(startup.paths.settings, join(userData, 'state', 'settings.json'))
    assert.equal(readFileSync(join(target, 'articles', 'a.md'), 'utf8'), 'original article')
    assert.equal(readFileSync(join(source, 'articles', 'a.md'), 'utf8'), 'original article')
    assert.equal(existsSync(dataStartupFiles(userData).pendingRequest), false)
    assert.equal(existsSync(dataStartupFiles(userData).journal), true)
    assert.equal(startup.migration?.status, 'success')
    assert.match(startup.migration?.message ?? '', /原目录仍保留/)
    assert.deepEqual(readLastDataMigrationResult(userData), startup.migration)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('迁移失败会清除 pending、写入中文结果并继续使用原资料库', async () => {
  const home = mkdtempSync(join(tmpdir(), 'infohub-startup-failure-'))
  const userData = join(home, 'user-data')
  const target = join(home, 'non-empty-target')
  try {
    mkdirSync(join(userData, 'data'), { recursive: true })
    writeFileSync(join(userData, 'data', 'sources.json'), '[]', 'utf8')
    await prepareDataStartup(userData)
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'do not overwrite', 'utf8')
    queuePendingDataMigration(userData, target, () => 44)

    const startup = await prepareDataStartup(userData, { now: () => 55 })
    assert.equal(startup.location.activeRoot, join(userData, 'data'))
    assert.equal(startup.migration?.status, 'failed')
    assert.match(startup.migration?.message ?? '', /迁移失败，仍使用原目录/)
    assert.match(startup.migration?.message ?? '', /目标必须为空目录/)
    assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'do not overwrite')
    assert.equal(readFileSync(join(userData, 'data', 'sources.json'), 'utf8'), '[]')
    assert.equal(existsSync(dataStartupFiles(userData).pendingRequest), false)
    assert.equal(readLastDataMigrationResult(userData)?.status, 'failed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('损坏的 pending 只产生失败结果；缺失的自定义 activeRoot 仍阻断启动', async () => {
  const home = mkdtempSync(join(tmpdir(), 'infohub-startup-errors-'))
  const userData = join(home, 'user-data')
  const custom = join(home, 'custom')
  try {
    mkdirSync(join(userData, 'data'), { recursive: true })
    const initialized = await prepareDataStartup(userData)
    const files = dataStartupFiles(userData)
    mkdirSync(join(userData, 'state', 'migrations'), { recursive: true })
    writeFileSync(files.pendingRequest, '{broken', 'utf8')

    const damaged = await prepareDataStartup(userData, { now: () => 99 })
    assert.equal(damaged.migration?.status, 'failed')
    assert.match(damaged.migration?.message ?? '', /请求已损坏/)
    assert.equal(existsSync(files.pendingRequest), false)

    mkdirSync(custom)
    createLibraryManifest(custom, {
      libraryId: initialized.location.bootstrap!.libraryId,
      now: () => 1
    })
    activateDataLocation(userData, custom)
    rmSync(custom, { recursive: true, force: true })
    queuePendingDataMigration(userData, join(home, 'another-target'))
    await assert.rejects(
      prepareDataStartup(userData),
      (error: unknown) => error instanceof DataLocationError && error.code === 'DATA_ROOT_MISSING'
    )
    assert.equal(existsSync(files.pendingRequest), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('bootstrap 切换后若启动收尾异常则阻断启动，不回旧目录形成双写', async () => {
  const home = mkdtempSync(join(tmpdir(), 'infohub-startup-post-activate-'))
  const userData = join(home, 'user-data')
  const target = join(home, 'target-library')
  try {
    mkdirSync(join(userData, 'data', 'articles'), { recursive: true })
    writeFileSync(join(userData, 'data', 'articles', 'stable.md'), 'stable', 'utf8')
    await prepareDataStartup(userData)
    mkdirSync(target)
    queuePendingDataMigration(userData, target, () => 20)

    await assert.rejects(
      prepareDataStartup(userData, {
        migrationId: () => 'post-activate-fault',
        afterActivate: () => {
          throw new Error('模拟指针提交后故障')
        }
      }),
      (error: unknown) =>
        error instanceof DataStartupError &&
        /指针已切换/.test(error.message) &&
        /拒绝回退/.test(error.message)
    )

    assert.equal(resolveDataLocation(userData).activeRoot, target)
    assert.equal(readFileSync(join(target, 'articles', 'stable.md'), 'utf8'), 'stable')
    assert.equal(readFileSync(join(userData, 'data', 'articles', 'stable.md'), 'utf8'), 'stable')
    assert.equal(existsSync(dataStartupFiles(userData).pendingRequest), true)

    const recovered = await prepareDataStartup(userData, { now: () => 30 })
    assert.equal(recovered.location.activeRoot, target)
    assert.equal(recovered.migration?.status, 'success')
    assert.match(recovered.migration?.message ?? '', /上次启动完成切换/)
    assert.equal(existsSync(dataStartupFiles(userData).pendingRequest), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

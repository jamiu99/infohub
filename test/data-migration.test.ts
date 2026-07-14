import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  DataMigrationError,
  migrateDataDirectory,
  readDataMigrationJournal
} from '../src/main/data-migration'

interface Fixture {
  home: string
  source: string
  target: string
  journal: string
}

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'infohub-data-migration-'))
  const source = join(home, 'source data')
  const target = join(home, '目标 资料库')
  const journal = join(home, 'private-state', 'migrations', 'current.json')
  mkdirSync(join(source, 'articles', 'wechat'), { recursive: true })
  mkdirSync(join(source, 'raw', 'wechat'), { recursive: true })
  mkdirSync(join(source, 'outputs', 'empty-result'), { recursive: true })
  mkdirSync(join(source, 'secrets'), { recursive: true })
  mkdirSync(join(source, 'team', 'outbox'), { recursive: true })
  mkdirSync(target)
  writeFileSync(join(source, 'articles', 'wechat', 'a.md'), 'article-a', 'utf8')
  writeFileSync(join(source, 'raw', 'wechat', 'a.json'), '{"raw":true}', 'utf8')
  writeFileSync(join(source, 'sources.json'), '[]', 'utf8')
  writeFileSync(join(source, 'index.sqlite'), 'derived-index', 'utf8')
  writeFileSync(join(source, 'index.sqlite-wal'), 'derived-wal', 'utf8')
  writeFileSync(join(source, 'articles', 'unfinished.123.tmp'), 'temporary', 'utf8')
  writeFileSync(join(source, 'settings.json'), '{"private":true}', 'utf8')
  writeFileSync(join(source, 'secrets', 'token.enc'), 'private', 'utf8')
  writeFileSync(join(source, 'team', 'outbox', 'event.json'), '{"private":true}', 'utf8')
  return { home, source, target, journal }
}

function stagingEntries(target: string): string[] {
  const parent = dirname(target)
  const prefix = `.${basename(target)}.infohub-staging-`
  return readdirSync(parent).filter((name) => name.startsWith(prefix))
}

test('迁移在目标盘 staging 校验后提交，跳过索引/临时文件并保留源', async () => {
  const current = fixture()
  try {
    const phases: string[] = []
    const result = await migrateDataDirectory({
      sourceRoot: current.source,
      targetRoot: current.target,
      journalPath: current.journal,
      id: 'success',
      now: (() => {
        let value = 100
        return () => ++value
      })(),
      hooks: {
        onPhase: (journal) => {
          phases.push(journal.phase)
        }
      }
    })

    assert.deepEqual(phases, ['planned', 'copying', 'verifying', 'committing', 'complete'])
    assert.equal(readFileSync(join(current.target, 'articles', 'wechat', 'a.md'), 'utf8'), 'article-a')
    assert.equal(readFileSync(join(current.target, 'raw', 'wechat', 'a.json'), 'utf8'), '{"raw":true}')
    assert.equal(existsSync(join(current.target, 'index.sqlite')), false)
    assert.equal(existsSync(join(current.target, 'index.sqlite-wal')), false)
    assert.equal(existsSync(join(current.target, 'articles', 'unfinished.123.tmp')), false)
    assert.equal(existsSync(join(current.target, 'secrets')), false)
    assert.equal(existsSync(join(current.target, 'settings.json')), false)
    assert.equal(existsSync(join(current.target, 'team')), false)
    assert.deepEqual(readdirSync(join(current.target, 'outputs', 'empty-result')), [])
    assert.equal(existsSync(join(current.source, 'index.sqlite')), true)
    assert.equal(existsSync(join(current.source, 'secrets', 'token.enc')), true)
    assert.equal(stagingEntries(current.target).length, 0)
    assert.equal(result.files.length, 3)
    assert.ok(result.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)))
    assert.equal(result.bytes, result.files.reduce((sum, file) => sum + file.size, 0))

    const journal = await readDataMigrationJournal(current.journal)
    assert.equal(journal?.phase, 'complete')
    assert.equal(journal?.committed, true)
    assert.equal(journal?.files.length, 3)
  } finally {
    rmSync(current.home, { recursive: true, force: true })
  }
})

test('目标不存在时也使用其父目录 staging 提交，源目录不被移动', async () => {
  const current = fixture()
  try {
    rmSync(current.target, { recursive: true, force: true })
    await migrateDataDirectory({
      sourceRoot: current.source,
      targetRoot: current.target,
      journalPath: current.journal,
      id: 'missing-target'
    })
    assert.equal(existsSync(join(current.target, 'sources.json')), true)
    assert.equal(existsSync(join(current.source, 'sources.json')), true)
    assert.equal(stagingEntries(current.target).length, 0)
  } finally {
    rmSync(current.home, { recursive: true, force: true })
  }
})

test('非空目标与嵌套目标会在复制前被拒绝', async () => {
  const current = fixture()
  try {
    writeFileSync(join(current.target, 'existing.txt'), 'do not overwrite', 'utf8')
    await assert.rejects(
      migrateDataDirectory({
        sourceRoot: current.source,
        targetRoot: current.target,
        journalPath: current.journal
      }),
      (error: unknown) => error instanceof DataMigrationError && error.code === 'TARGET_NOT_EMPTY'
    )
    assert.equal(readFileSync(join(current.target, 'existing.txt'), 'utf8'), 'do not overwrite')
    assert.equal(existsSync(current.journal), false)

    rmSync(current.target, { recursive: true, force: true })
    const nested = join(current.source, 'nested-target')
    mkdirSync(nested)
    await assert.rejects(
      migrateDataDirectory({
        sourceRoot: current.source,
        targetRoot: nested,
        journalPath: current.journal
      }),
      (error: unknown) => error instanceof DataMigrationError && error.code === 'NESTED_PATH'
    )
  } finally {
    rmSync(current.home, { recursive: true, force: true })
  }
})

test('迁移记录不能写进源或目标资料库', async () => {
  const current = fixture()
  try {
    await assert.rejects(
      migrateDataDirectory({
        sourceRoot: current.source,
        targetRoot: current.target,
        journalPath: join(current.source, 'migration.json')
      }),
      (error: unknown) =>
        error instanceof DataMigrationError && error.code === 'JOURNAL_INSIDE_DATA'
    )
  } finally {
    rmSync(current.home, { recursive: true, force: true })
  }
})

test('迁移记录路径会消除祖先别名后再判断是否位于资料库内', async (t) => {
  const current = fixture()
  const homeAlias = `${current.home}-alias`
  try {
    try {
      symlinkSync(current.home, homeAlias, 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('当前平台不允许测试进程创建目录链接')
        return
      }
      throw error
    }
    await assert.rejects(
      migrateDataDirectory({
        sourceRoot: current.source,
        targetRoot: current.target,
        journalPath: join(
          homeAlias,
          basename(current.source),
          'missing',
          'deep',
          'migration.json'
        )
      }),
      (error: unknown) =>
        error instanceof DataMigrationError && error.code === 'JOURNAL_INSIDE_DATA'
    )
    assert.equal(existsSync(join(current.source, 'missing')), false)
  } finally {
    rmSync(homeAlias, { recursive: true, force: true })
    rmSync(current.home, { recursive: true, force: true })
  }
})

test('源目录含 symlink 时拒绝并清理 staging，源与空目标保持不变', async (t) => {
  const current = fixture()
  try {
    try {
      symlinkSync('a.md', join(current.source, 'articles', 'wechat', 'link.md'))
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('当前平台不允许测试进程创建 symlink')
        return
      }
      throw error
    }
    await assert.rejects(
      migrateDataDirectory({
        sourceRoot: current.source,
        targetRoot: current.target,
        journalPath: current.journal,
        id: 'symlink'
      }),
      (error: unknown) =>
        error instanceof DataMigrationError && error.code === 'SYMLINK_NOT_ALLOWED'
    )
    assert.deepEqual(readdirSync(current.target), [])
    assert.equal(existsSync(join(current.source, 'articles', 'wechat', 'a.md')), true)
    assert.equal(stagingEntries(current.target).length, 0)
    assert.equal((await readDataMigrationJournal(current.journal))?.phase, 'failed')
  } finally {
    rmSync(current.home, { recursive: true, force: true })
  }
})

test('复制后源文件变化会导致哈希校验失败，目标不提交且 journal 可诊断', async () => {
  const current = fixture()
  let changed = false
  try {
    await assert.rejects(
      migrateDataDirectory({
        sourceRoot: current.source,
        targetRoot: current.target,
        journalPath: current.journal,
        id: 'source-changed',
        hooks: {
          afterFileCopied: (file) => {
            if (!changed && file.path.endsWith('a.md')) {
              changed = true
              writeFileSync(join(current.source, ...file.path.split('/')), 'article-a-changed', 'utf8')
            }
          }
        }
      }),
      (error: unknown) => error instanceof DataMigrationError && error.code === 'VERIFY_FAILED'
    )
    assert.equal(changed, true)
    assert.deepEqual(readdirSync(current.target), [])
    assert.equal(stagingEntries(current.target).length, 0)
    const journal = await readDataMigrationJournal(current.journal)
    assert.equal(journal?.phase, 'failed')
    assert.equal(journal?.committed, false)
    assert.match(journal?.error ?? '', /发生变化/)
  } finally {
    rmSync(current.home, { recursive: true, force: true })
  }
})

test('复制阶段异常会留下 failed journal，但不会留下半成品目录', async () => {
  const current = fixture()
  try {
    await assert.rejects(
      migrateDataDirectory({
        sourceRoot: current.source,
        targetRoot: current.target,
        journalPath: current.journal,
        id: 'copy-error',
        hooks: {
          afterFileCopied: () => {
            throw new Error('模拟磁盘写入失败')
          }
        }
      }),
      (error: unknown) => error instanceof DataMigrationError && error.code === 'COPY_FAILED'
    )
    assert.deepEqual(readdirSync(current.target), [])
    assert.equal(stagingEntries(current.target).length, 0)
    assert.equal((await readDataMigrationJournal(current.journal))?.phase, 'failed')
  } finally {
    rmSync(current.home, { recursive: true, force: true })
  }
})

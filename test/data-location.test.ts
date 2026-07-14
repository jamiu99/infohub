import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import {
  activateDataLocation,
  dataLocationContext,
  DataLocationError,
  initializeDefaultDataLocation,
  resolveDataLocation,
  writeDataLocationBootstrap
} from '../src/main/data-location'
import {
  makeLibraryPaths,
  makePaths,
  makePrivateStatePaths
} from '../src/core/paths'
import { createLibraryManifest } from '../src/main/data-manifest'

const LIBRARY_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LIBRARY_ID = '22222222-2222-4222-8222-222222222222'

test('公开资料库与固定私有状态使用独立路径，旧 makePaths 暂时保持一体布局', () => {
  const library = makeLibraryPaths('/tmp/infohub-library')
  const privateState = makePrivateStatePaths('/tmp/infohub-state')
  const legacy = makePaths('/tmp/infohub-legacy')

  assert.equal(library.articles, join('/tmp/infohub-library', 'articles'))
  assert.equal(library.outputs, join('/tmp/infohub-library', 'outputs'))
  assert.equal(library.manifest, join('/tmp/infohub-library', 'infohub-library.json'))
  assert.equal(privateState.bootstrap, join('/tmp/infohub-state', 'data-location.json'))
  assert.equal(
    privateState.dataLocationMarker,
    join('/tmp/infohub-state', 'data-location.initialized.json')
  )
  assert.equal(
    privateState.legacyPrivateImportMarker,
    join('/tmp/infohub-state', 'legacy-private-import.json')
  )
  assert.equal(privateState.dataMigrationRequest, join('/tmp/infohub-state', 'migrations', 'pending.json'))
  assert.equal(privateState.dataMigrationResult, join('/tmp/infohub-state', 'migrations', 'last-result.json'))
  assert.equal(privateState.wxAccounts, join('/tmp/infohub-state', 'secrets', 'wx-accounts.enc'))
  assert.equal(legacy.settings, join('/tmp/infohub-legacy', 'settings.json'))
  assert.equal(legacy.articles, join('/tmp/infohub-legacy', 'articles'))
})

test('首次运行只返回默认路径，不静默创建；显式初始化后写 bootstrap', () => {
  const userData = mkdtempSync(join(tmpdir(), 'infohub-location-first-run-'))
  try {
    const context = dataLocationContext(userData)
    const first = resolveDataLocation(userData)
    assert.equal(first.needsInitialization, true)
    assert.equal(first.activeRoot, context.defaultRoot)
    assert.equal(existsSync(first.activeRoot), false)
    assert.equal(existsSync(context.privatePaths.bootstrap), false)

    const initialized = initializeDefaultDataLocation(userData, () => 1234, () => LIBRARY_ID)
    assert.equal(initialized.needsInitialization, false)
    assert.equal(initialized.customized, false)
    assert.equal(initialized.bootstrap?.updatedAt, 1234)
    assert.equal(existsSync(initialized.activeRoot), true)
    assert.deepEqual(JSON.parse(readFileSync(context.privatePaths.bootstrap, 'utf8')), {
      schemaVersion: 1,
      libraryId: LIBRARY_ID,
      activeRoot: context.defaultRoot,
      updatedAt: 1234
    })
    assert.equal(
      JSON.parse(readFileSync(join(initialized.activeRoot, 'infohub-library.json'), 'utf8')).libraryId,
      LIBRARY_ID
    )
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

test('激活自定义资料库后可解析，原默认目录记录为 lastGoodRoot', () => {
  const userData = mkdtempSync(join(tmpdir(), 'infohub-location-custom-'))
  const custom = mkdtempSync(join(tmpdir(), 'infohub-library-custom-'))
  try {
    const defaultRoot = dataLocationContext(userData).defaultRoot
    const initialized = initializeDefaultDataLocation(userData, () => 1234, () => LIBRARY_ID)
    createLibraryManifest(custom, {
      libraryId: initialized.bootstrap!.libraryId,
      now: () => 1234
    })
    activateDataLocation(userData, custom, { lastGoodRoot: defaultRoot, now: () => 5678 })

    const resolved = resolveDataLocation(userData)
    assert.equal(resolved.activeRoot, custom)
    assert.equal(resolved.customized, true)
    assert.equal(resolved.bootstrap?.lastGoodRoot, defaultRoot)
    assert.equal(resolved.bootstrap?.updatedAt, 5678)
  } finally {
    rmSync(userData, { recursive: true, force: true })
    rmSync(custom, { recursive: true, force: true })
  }
})

test('已配置的自定义盘缺失时显式报错，不回退到存在的默认空目录', () => {
  const userData = mkdtempSync(join(tmpdir(), 'infohub-location-missing-'))
  const custom = mkdtempSync(join(tmpdir(), 'infohub-library-missing-'))
  try {
    const context = dataLocationContext(userData)
    const initialized = initializeDefaultDataLocation(userData, () => 1234, () => LIBRARY_ID)
    createLibraryManifest(custom, {
      libraryId: initialized.bootstrap!.libraryId,
      now: () => 1234
    })
    activateDataLocation(userData, custom, { lastGoodRoot: context.defaultRoot })
    rmSync(custom, { recursive: true, force: true })

    assert.throws(
      () => resolveDataLocation(userData),
      (error: unknown) =>
        error instanceof DataLocationError &&
        error.code === 'DATA_ROOT_MISSING' &&
        error.root === custom
    )
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

test('损坏 bootstrap 显式失败且不会被默认配置覆盖', () => {
  const userData = mkdtempSync(join(tmpdir(), 'infohub-location-corrupt-'))
  try {
    const context = dataLocationContext(userData)
    mkdirSync(context.privatePaths.stateRoot, { recursive: true })
    writeFileSync(context.privatePaths.bootstrap, '{broken', 'utf8')

    assert.throws(
      () => resolveDataLocation(userData),
      (error: unknown) => error instanceof DataLocationError && error.code === 'INVALID_BOOTSTRAP'
    )
    assert.equal(readFileSync(context.privatePaths.bootstrap, 'utf8'), '{broken')
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

test('已初始化后 bootstrap 缺失会 fail-closed，不把默认目录当成新库', () => {
  const userData = mkdtempSync(join(tmpdir(), 'infohub-location-bootstrap-missing-'))
  try {
    const initialized = initializeDefaultDataLocation(userData, () => 10, () => LIBRARY_ID)
    writeFileSync(join(initialized.activeRoot, 'sources.json'), '[{"id":"keep"}]', 'utf8')
    rmSync(initialized.privatePaths.bootstrap, { force: true })

    assert.throws(
      () => resolveDataLocation(userData),
      (error: unknown) =>
        error instanceof DataLocationError && error.code === 'BOOTSTRAP_MISSING'
    )
    assert.equal(readFileSync(join(initialized.activeRoot, 'sources.json'), 'utf8'), '[{"id":"keep"}]')
    assert.equal(existsSync(initialized.privatePaths.bootstrap), false)
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

test('bootstrap 的 libraryId 必须与根目录 manifest 一致，错盘不会被 Store 初始化', () => {
  const userData = mkdtempSync(join(tmpdir(), 'infohub-location-identity-'))
  const wrongRoot = mkdtempSync(join(tmpdir(), 'infohub-location-wrong-volume-'))
  try {
    const initialized = initializeDefaultDataLocation(userData, () => 10, () => LIBRARY_ID)
    createLibraryManifest(wrongRoot, { libraryId: OTHER_LIBRARY_ID, now: () => 10 })
    writeDataLocationBootstrap(initialized.privatePaths.bootstrap, {
      schemaVersion: 1,
      libraryId: LIBRARY_ID,
      activeRoot: wrongRoot,
      lastGoodRoot: initialized.activeRoot,
      updatedAt: 20
    })

    assert.throws(
      () => resolveDataLocation(userData),
      (error: unknown) =>
        error instanceof DataLocationError && error.code === 'DATA_ROOT_IDENTITY_MISMATCH'
    )
    assert.equal(existsSync(join(wrongRoot, 'articles')), false)
    assert.equal(existsSync(join(wrongRoot, 'index.sqlite')), false)
  } finally {
    rmSync(userData, { recursive: true, force: true })
    rmSync(wrongRoot, { recursive: true, force: true })
  }
})

test('同一绝对路径下若 manifest 消失也会阻断启动', () => {
  const userData = mkdtempSync(join(tmpdir(), 'infohub-location-manifest-missing-'))
  try {
    const initialized = initializeDefaultDataLocation(userData, () => 10, () => LIBRARY_ID)
    rmSync(join(initialized.activeRoot, 'infohub-library.json'), { force: true })
    assert.throws(
      () => resolveDataLocation(userData),
      (error: unknown) =>
        error instanceof DataLocationError && error.code === 'DATA_ROOT_MANIFEST_MISSING'
    )
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

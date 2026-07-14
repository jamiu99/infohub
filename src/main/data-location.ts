// 数据资料库定位的纯核心。
//
// bootstrap 固定放在 Electron userData/state 下，因此即使资料库被移动，App 仍能先找到它。
// 本模块不导入 Electron，便于在 Service 启动前使用并通过 node:test 覆盖。
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  DATA_LOCATION_BOOTSTRAP_FILE,
  DATA_LOCATION_MARKER_FILE,
  defaultLibraryRoot,
  defaultPrivateStateRoot,
  LIBRARY_MANIFEST_FILE,
  makePrivateStatePaths,
  type PrivateStatePaths
} from '../core/paths'
import {
  assertLibraryManifest,
  createLibraryManifest,
  isLibraryId,
  LibraryManifestError
} from './data-manifest'

export const DATA_LOCATION_SCHEMA_VERSION = 1 as const
export const DATA_LOCATION_MARKER_SCHEMA_VERSION = 1 as const

export interface DataLocationBootstrap {
  schemaVersion: typeof DATA_LOCATION_SCHEMA_VERSION
  /** 与资料库根目录 manifest 一致，防止同路径换盘/换目录后误开。 */
  libraryId: string
  activeRoot: string
  /** 最近一次已知可用的根，仅用于迁移失败恢复，不会被静默启用。 */
  lastGoodRoot?: string
  updatedAt: number
}

export interface DataLocationMarker {
  schemaVersion: typeof DATA_LOCATION_MARKER_SCHEMA_VERSION
  libraryId: string
  initializedAt: number
}

export interface DataLocationContext {
  userDataRoot: string
  defaultRoot: string
  privatePaths: PrivateStatePaths
}

export interface ResolvedDataLocation extends DataLocationContext {
  activeRoot: string
  customized: boolean
  /** true 表示首次运行尚未写 bootstrap；调用方可创建默认资料库后再显式激活。 */
  needsInitialization: boolean
  bootstrap: DataLocationBootstrap | null
}

export type DataLocationErrorCode =
  | 'INVALID_BOOTSTRAP'
  | 'BOOTSTRAP_MISSING'
  | 'DATA_ROOT_MISSING'
  | 'DATA_ROOT_NOT_DIRECTORY'
  | 'DATA_ROOT_SYMLINK'
  | 'DATA_ROOT_UNAVAILABLE'
  | 'DATA_ROOT_MANIFEST_MISSING'
  | 'DATA_ROOT_MANIFEST_INVALID'
  | 'DATA_ROOT_IDENTITY_MISMATCH'

export class DataLocationError extends Error {
  constructor(
    readonly code: DataLocationErrorCode,
    message: string,
    readonly root?: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'DataLocationError'
  }
}

function normalizeRoot(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || !isAbsolute(value)) {
    throw new DataLocationError('INVALID_BOOTSTRAP', `${field} 必须是非空绝对路径`)
  }
  return resolve(value)
}

export function dataLocationContext(userDataRoot: string): DataLocationContext {
  const normalizedUserData = resolve(userDataRoot)
  return {
    userDataRoot: normalizedUserData,
    defaultRoot: resolve(defaultLibraryRoot(normalizedUserData)),
    privatePaths: makePrivateStatePaths(defaultPrivateStateRoot(normalizedUserData))
  }
}

export function parseDataLocationBootstrap(value: unknown): DataLocationBootstrap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DataLocationError('INVALID_BOOTSTRAP', '数据目录配置不是有效对象')
  }
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== DATA_LOCATION_SCHEMA_VERSION) {
    throw new DataLocationError(
      'INVALID_BOOTSTRAP',
      `不支持的数据目录配置版本：${String(input.schemaVersion)}`
    )
  }
  if (typeof input.updatedAt !== 'number' || !Number.isFinite(input.updatedAt) || input.updatedAt < 0) {
    throw new DataLocationError('INVALID_BOOTSTRAP', '数据目录配置的更新时间无效')
  }
  if (!isLibraryId(input.libraryId)) {
    throw new DataLocationError('INVALID_BOOTSTRAP', '数据目录配置的 libraryId 无效')
  }
  return {
    schemaVersion: DATA_LOCATION_SCHEMA_VERSION,
    libraryId: input.libraryId,
    activeRoot: normalizeRoot(input.activeRoot, 'activeRoot')!,
    ...(input.lastGoodRoot === undefined
      ? {}
      : { lastGoodRoot: normalizeRoot(input.lastGoodRoot, 'lastGoodRoot') }),
    updatedAt: input.updatedAt
  }
}

function parseDataLocationMarker(value: unknown): DataLocationMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DataLocationError('INVALID_BOOTSTRAP', '数据目录初始化标记不是有效对象')
  }
  const input = value as Record<string, unknown>
  if (
    input.schemaVersion !== DATA_LOCATION_MARKER_SCHEMA_VERSION ||
    !isLibraryId(input.libraryId) ||
    typeof input.initializedAt !== 'number' ||
    !Number.isFinite(input.initializedAt) ||
    input.initializedAt < 0
  ) {
    throw new DataLocationError('INVALID_BOOTSTRAP', '数据目录初始化标记已损坏')
  }
  return {
    schemaVersion: DATA_LOCATION_MARKER_SCHEMA_VERSION,
    libraryId: input.libraryId,
    initializedAt: input.initializedAt
  }
}

function readDataLocationMarker(path: string): DataLocationMarker | null {
  if (!existsSync(path)) return null
  try {
    return parseDataLocationMarker(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (error instanceof DataLocationError) throw error
    throw new DataLocationError('INVALID_BOOTSTRAP', '数据目录初始化标记已损坏', undefined, {
      cause: error
    })
  }
}

export function readDataLocationBootstrap(path: string): DataLocationBootstrap | null {
  if (!existsSync(path)) return null
  try {
    return parseDataLocationBootstrap(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (error instanceof DataLocationError) throw error
    throw new DataLocationError('INVALID_BOOTSTRAP', '数据目录配置损坏，未自动切换到空目录', undefined, {
      cause: error
    })
  }
}

/** 使用同目录临时文件 + rename 原子替换，失败时保留旧 bootstrap。 */
export function writeDataLocationBootstrap(path: string, value: DataLocationBootstrap): void {
  const normalized = parseDataLocationBootstrap(value)
  const tmp = `${path}.${process.pid}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true })
  }
}

function writeDataLocationMarker(path: string, value: DataLocationMarker): void {
  const normalized = parseDataLocationMarker(value)
  const tmp = `${path}.${process.pid}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true })
  }
}

/** 在 bootstrap 提交前准备持久标记；bootstrap 始终是最后一个可抛错写入。 */
function ensureDataLocationMarker(
  context: DataLocationContext,
  libraryId: string,
  now: () => number
): DataLocationMarker {
  const existing = readDataLocationMarker(context.privatePaths.dataLocationMarker)
  if (existing) {
    if (existing.libraryId !== libraryId) {
      throw new DataLocationError(
        'DATA_ROOT_IDENTITY_MISMATCH',
        '数据目录初始化标记与 bootstrap 身份不一致，拒绝切换',
        context.privatePaths.dataLocationMarker
      )
    }
    return existing
  }
  const marker: DataLocationMarker = {
    schemaVersion: DATA_LOCATION_MARKER_SCHEMA_VERSION,
    libraryId,
    initializedAt: now()
  }
  writeDataLocationMarker(context.privatePaths.dataLocationMarker, marker)
  return marker
}

function hasPriorInitializationEvidence(context: DataLocationContext): boolean {
  if (existsSync(context.privatePaths.dataLocationMarker)) return true
  if (existsSync(join(context.defaultRoot, LIBRARY_MANIFEST_FILE))) return true
  if (!existsSync(context.privatePaths.stateRoot)) return false
  const knownV04Entries = new Set([
    DATA_LOCATION_BOOTSTRAP_FILE,
    DATA_LOCATION_MARKER_FILE,
    'legacy-private-import.json',
    'migrations'
  ])
  return readdirSync(context.privatePaths.stateRoot).some((entry) => knownV04Entries.has(entry))
}

/**
 * 验证一个已配置的根仍然存在且可读写。
 *
 * 这里故意不 mkdir：移动盘未挂载时创建同名空目录会让用户误以为数据丢失。
 */
export function assertAvailableDataRoot(root: string, expectedLibraryId: string): string {
  const normalized = resolve(root)
  let stat
  try {
    stat = lstatSync(normalized)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new DataLocationError(
        'DATA_ROOT_MISSING',
        `数据资料库不可用：${normalized}。请重新连接原磁盘或恢复该目录后再启动 infohub。`,
        normalized,
        { cause: error }
      )
    }
    throw new DataLocationError(
      'DATA_ROOT_UNAVAILABLE',
      `无法访问数据资料库：${normalized}`,
      normalized,
      { cause: error }
    )
  }
  if (stat.isSymbolicLink()) {
    throw new DataLocationError(
      'DATA_ROOT_SYMLINK',
      `数据资料库不能是符号链接或目录联接：${normalized}`,
      normalized
    )
  }
  if (!stat.isDirectory()) {
    throw new DataLocationError(
      'DATA_ROOT_NOT_DIRECTORY',
      `数据资料库路径不是目录：${normalized}`,
      normalized
    )
  }
  try {
    accessSync(normalized, constants.R_OK | constants.W_OK)
  } catch (error) {
    throw new DataLocationError(
      'DATA_ROOT_UNAVAILABLE',
      `数据资料库不可读写：${normalized}`,
      normalized,
      { cause: error }
    )
  }
  try {
    assertLibraryManifest(normalized, expectedLibraryId)
  } catch (error) {
    if (!(error instanceof LibraryManifestError)) throw error
    const code: DataLocationErrorCode =
      error.code === 'MANIFEST_MISSING'
        ? 'DATA_ROOT_MANIFEST_MISSING'
        : error.code === 'LIBRARY_ID_MISMATCH'
          ? 'DATA_ROOT_IDENTITY_MISMATCH'
          : 'DATA_ROOT_MANIFEST_INVALID'
    throw new DataLocationError(code, error.message, normalized, { cause: error })
  }
  return normalized
}

/**
 * 解析当前资料库。
 *
 * 只有“bootstrap、v0.4 标记和资料库 manifest 都不存在”才是首次运行。
 * 已初始化后 bootstrap 缺失必须 fail-closed，否则自定义盘用户会静默回到旧默认目录。
 */
export function resolveDataLocation(userDataRoot: string): ResolvedDataLocation {
  const context = dataLocationContext(userDataRoot)
  const bootstrap = readDataLocationBootstrap(context.privatePaths.bootstrap)
  if (!bootstrap) {
    if (hasPriorInitializationEvidence(context)) {
      throw new DataLocationError(
        'BOOTSTRAP_MISSING',
        `数据目录配置缺失：${context.privatePaths.bootstrap}。已拒绝自动切回默认目录，请恢复该文件。`,
        context.privatePaths.bootstrap
      )
    }
    return {
      ...context,
      activeRoot: context.defaultRoot,
      customized: false,
      needsInitialization: true,
      bootstrap: null
    }
  }
  const marker = readDataLocationMarker(context.privatePaths.dataLocationMarker)
  if (marker && marker.libraryId !== bootstrap.libraryId) {
    throw new DataLocationError(
      'DATA_ROOT_IDENTITY_MISMATCH',
      '数据目录 bootstrap 与初始化标记的 libraryId 不一致，拒绝打开',
      bootstrap.activeRoot
    )
  }
  const activeRoot = assertAvailableDataRoot(bootstrap.activeRoot, bootstrap.libraryId)
  return {
    ...context,
    activeRoot,
    customized: activeRoot !== context.defaultRoot,
    needsInitialization: false,
    bootstrap
  }
}

/** 创建默认资料库并显式写入 bootstrap；仅应在确认首次运行时调用。 */
export function initializeDefaultDataLocation(
  userDataRoot: string,
  now: () => number = Date.now,
  makeLibraryId?: () => string
): ResolvedDataLocation {
  const current = resolveDataLocation(userDataRoot)
  if (!current.needsInitialization) {
    ensureDataLocationMarker(current, current.bootstrap!.libraryId, now)
    return current
  }
  mkdirSync(current.defaultRoot, { recursive: true })
  const manifest = createLibraryManifest(current.defaultRoot, {
    ...(makeLibraryId ? { libraryId: makeLibraryId() } : {}),
    now
  })
  // marker 先写、bootstrap 后写。只要 bootstrap 提交成功，下次启动就一定有
  // 可验证的 libraryId；中途断电则由 marker/manifest 触发 fail-closed。
  ensureDataLocationMarker(current, manifest.libraryId, now)
  const bootstrap: DataLocationBootstrap = {
    schemaVersion: DATA_LOCATION_SCHEMA_VERSION,
    libraryId: manifest.libraryId,
    activeRoot: current.defaultRoot,
    updatedAt: now()
  }
  writeDataLocationBootstrap(current.privatePaths.bootstrap, bootstrap)
  return {
    ...current,
    activeRoot: current.defaultRoot,
    customized: false,
    needsInitialization: false,
    bootstrap
  }
}

/** 在迁移提交后切换指针；目标必须已存在且可读写。 */
export function activateDataLocation(
  userDataRoot: string,
  activeRoot: string,
  options: { lastGoodRoot?: string; now?: () => number } = {}
): DataLocationBootstrap {
  const context = dataLocationContext(userDataRoot)
  const current = readDataLocationBootstrap(context.privatePaths.bootstrap)
  if (!current) {
    throw new DataLocationError(
      'BOOTSTRAP_MISSING',
      '激活新资料库前必须先有已验证的当前 bootstrap',
      context.privatePaths.bootstrap
    )
  }
  const normalizedActiveRoot = assertAvailableDataRoot(activeRoot, current.libraryId)
  const normalizedLastGoodRoot = options.lastGoodRoot
    ? normalizeRoot(options.lastGoodRoot, 'lastGoodRoot')
    : undefined
  const bootstrap: DataLocationBootstrap = {
    schemaVersion: DATA_LOCATION_SCHEMA_VERSION,
    libraryId: current.libraryId,
    activeRoot: normalizedActiveRoot,
    ...(normalizedLastGoodRoot
      ? { lastGoodRoot: normalizedLastGoodRoot }
      : {}),
    updatedAt: (options.now ?? Date.now)()
  }
  // 所有可失败的身份/标记验证都在前面完成；bootstrap 是唯一提交点。
  ensureDataLocationMarker(context, current.libraryId, options.now ?? Date.now)
  writeDataLocationBootstrap(context.privatePaths.bootstrap, bootstrap)
  return bootstrap
}

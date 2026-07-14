// Electron Service 创建之前的数据启动编排。
//
// 本模块不导入 Electron：主进程只需传入 app.getPath('userData')，即可先完成
// 旧私有状态导入、资料库定位和“下次启动迁移”，再把 paths 注入 Store/Service。
import { randomUUID } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  combinePaths,
  makeLibraryPaths,
  type LibraryPaths,
  type Paths,
  type PrivateStatePaths
} from '../core/paths'
import {
  activateDataLocation,
  dataLocationContext,
  initializeDefaultDataLocation,
  type ResolvedDataLocation
} from './data-location'
import { migrateDataDirectory } from './data-migration'

export const PENDING_DATA_MIGRATION_SCHEMA_VERSION = 1 as const
export const DATA_MIGRATION_STARTUP_RESULT_SCHEMA_VERSION = 1 as const
export const LEGACY_PRIVATE_IMPORT_SCHEMA_VERSION = 1 as const

const LEGACY_PRIVATE_ENTRIES = ['settings.json', 'secrets', 'team'] as const
type LegacyPrivateEntry = (typeof LEGACY_PRIVATE_ENTRIES)[number]

export interface PendingDataMigrationRequest {
  schemaVersion: typeof PENDING_DATA_MIGRATION_SCHEMA_VERSION
  targetRoot: string
  requestedAt: number
}

export interface DataMigrationStartupResult {
  schemaVersion: typeof DATA_MIGRATION_STARTUP_RESULT_SCHEMA_VERSION
  status: 'success' | 'failed'
  sourceRoot: string
  targetRoot?: string
  requestedAt?: number
  completedAt: number
  message: string
  journalPath: string
}

export interface DataStartupFiles {
  pendingRequest: string
  lastResult: string
  journal: string
}

export interface LegacyPrivateStateImportResult {
  copied: LegacyPrivateEntry[]
  skippedExisting: LegacyPrivateEntry[]
  missing: LegacyPrivateEntry[]
  /** true 表示本机已完成过一次性检查，本次未再读取旧凭据。 */
  alreadyCompleted: boolean
}

interface LegacyPrivateImportMarker {
  schemaVersion: typeof LEGACY_PRIVATE_IMPORT_SCHEMA_VERSION
  completedAt: number
}

export interface DataStartupResult {
  location: ResolvedDataLocation
  libraryPaths: LibraryPaths
  privatePaths: PrivateStatePaths
  /** 供旧 Service 在双路径改造期间直接注入的完整路径对象。 */
  paths: Paths
  startupFiles: DataStartupFiles
  legacyPrivateState: LegacyPrivateStateImportResult
  migration: DataMigrationStartupResult | null
}

export interface PrepareDataStartupOptions {
  now?: () => number
  migrationId?: () => string
  makeLibraryId?: () => string
  /** 只用于验证切换提交语义的故障注入。 */
  afterActivate?: () => void
}

export class DataStartupError extends Error {
  constructor(
    message: string,
    readonly path?: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'DataStartupError'
  }
}

function assertTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DataStartupError(`${field} 必须是有效时间戳`)
  }
  return value
}

function normalizeAbsoluteRoot(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || !isAbsolute(value)) {
    throw new DataStartupError(`${field} 必须是非空绝对路径`)
  }
  return resolve(value)
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

export function dataStartupFiles(userDataRoot: string): DataStartupFiles {
  const privatePaths = dataLocationContext(userDataRoot).privatePaths
  return {
    pendingRequest: privatePaths.dataMigrationRequest,
    lastResult: privatePaths.dataMigrationResult,
    journal: join(privatePaths.migrations, 'current-journal.json')
  }
}

export function parsePendingDataMigrationRequest(value: unknown): PendingDataMigrationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DataStartupError('待执行的数据迁移请求不是有效对象')
  }
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== PENDING_DATA_MIGRATION_SCHEMA_VERSION) {
    throw new DataStartupError(`不支持的数据迁移请求版本：${String(input.schemaVersion)}`)
  }
  return {
    schemaVersion: PENDING_DATA_MIGRATION_SCHEMA_VERSION,
    targetRoot: normalizeAbsoluteRoot(input.targetRoot, 'targetRoot'),
    requestedAt: assertTimestamp(input.requestedAt, 'requestedAt')
  }
}

export function readPendingDataMigration(userDataRoot: string): PendingDataMigrationRequest | null {
  const path = dataStartupFiles(userDataRoot).pendingRequest
  if (!existsSync(path)) return null
  try {
    return parsePendingDataMigrationRequest(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (error instanceof DataStartupError) throw error
    throw new DataStartupError('待执行的数据迁移请求已损坏', path, { cause: error })
  }
}

/**
 * 记录一次“下次启动迁移”。这里只落盘，不移动任何正在使用的数据。
 * 再次选择目录会原子替换尚未执行的请求。
 */
export function queuePendingDataMigration(
  userDataRoot: string,
  targetRoot: string,
  now: () => number = Date.now
): PendingDataMigrationRequest {
  const request = parsePendingDataMigrationRequest({
    schemaVersion: PENDING_DATA_MIGRATION_SCHEMA_VERSION,
    targetRoot,
    requestedAt: now()
  })
  writeJsonAtomic(dataStartupFiles(userDataRoot).pendingRequest, request)
  return request
}

export function clearPendingDataMigration(userDataRoot: string): void {
  rmSync(dataStartupFiles(userDataRoot).pendingRequest, { force: true })
}

function parseDataMigrationStartupResult(value: unknown): DataMigrationStartupResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DataStartupError('数据迁移结果不是有效对象')
  }
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== DATA_MIGRATION_STARTUP_RESULT_SCHEMA_VERSION) {
    throw new DataStartupError(`不支持的数据迁移结果版本：${String(input.schemaVersion)}`)
  }
  if (input.status !== 'success' && input.status !== 'failed') {
    throw new DataStartupError('数据迁移结果状态无效')
  }
  if (typeof input.message !== 'string' || input.message.length === 0) {
    throw new DataStartupError('数据迁移结果缺少说明')
  }
  if (typeof input.journalPath !== 'string' || !isAbsolute(input.journalPath)) {
    throw new DataStartupError('数据迁移结果中的 journalPath 无效')
  }
  return {
    schemaVersion: DATA_MIGRATION_STARTUP_RESULT_SCHEMA_VERSION,
    status: input.status,
    sourceRoot: normalizeAbsoluteRoot(input.sourceRoot, 'sourceRoot'),
    ...(input.targetRoot === undefined
      ? {}
      : { targetRoot: normalizeAbsoluteRoot(input.targetRoot, 'targetRoot') }),
    ...(input.requestedAt === undefined
      ? {}
      : { requestedAt: assertTimestamp(input.requestedAt, 'requestedAt') }),
    completedAt: assertTimestamp(input.completedAt, 'completedAt'),
    message: input.message,
    journalPath: resolve(input.journalPath)
  }
}

export function readLastDataMigrationResult(userDataRoot: string): DataMigrationStartupResult | null {
  const path = dataStartupFiles(userDataRoot).lastResult
  if (!existsSync(path)) return null
  try {
    return parseDataMigrationStartupResult(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (error instanceof DataStartupError) throw error
    throw new DataStartupError('数据迁移结果已损坏', path, { cause: error })
  }
}

function copyLegacyDirectory(source: string, destination: string): void {
  const sourceStat = lstatSync(source)
  if (sourceStat.isSymbolicLink()) {
    throw new DataStartupError(`旧私有状态包含不允许的符号链接或目录联接：${source}`, source)
  }
  if (!sourceStat.isDirectory()) {
    throw new DataStartupError(`旧私有状态不是目录：${source}`, source)
  }
  mkdirSync(destination)
  const entries = readdirSync(source, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    const stat = lstatSync(from)
    if (stat.isSymbolicLink()) {
      throw new DataStartupError(`旧私有状态包含不允许的符号链接或目录联接：${from}`, from)
    }
    if (stat.isDirectory()) {
      copyLegacyDirectory(from, to)
    } else if (stat.isFile()) {
      copyFileSync(from, to, constants.COPYFILE_EXCL)
    } else {
      throw new DataStartupError(`旧私有状态包含不支持的文件类型：${from}`, from)
    }
  }
}

function copyLegacyEntry(source: string, destination: string, expected: 'file' | 'directory'): boolean {
  const sourceStat = lstatSync(source)
  if (sourceStat.isSymbolicLink()) {
    throw new DataStartupError(`旧私有状态包含不允许的符号链接或目录联接：${source}`, source)
  }
  if (expected === 'file' && !sourceStat.isFile()) {
    throw new DataStartupError(`旧私有状态应为文件：${source}`, source)
  }
  if (expected === 'directory' && !sourceStat.isDirectory()) {
    throw new DataStartupError(`旧私有状态应为目录：${source}`, source)
  }
  const staging = join(dirname(destination), `.${basename(destination)}.legacy-${randomUUID()}`)
  try {
    if (sourceStat.isFile()) {
      copyFileSync(source, staging, constants.COPYFILE_EXCL)
    } else if (sourceStat.isDirectory()) {
      copyLegacyDirectory(source, staging)
    } else {
      throw new DataStartupError(`旧私有状态包含不支持的文件类型：${source}`, source)
    }
    // App 以 single-instance 运行；提交前仍再次检查，绝不主动覆盖已存在的目标。
    if (lstatOrNull(destination)) return false
    renameSync(staging, destination)
    return true
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function readLegacyPrivateImportMarker(path: string): LegacyPrivateImportMarker | null {
  if (!existsSync(path)) return null
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new DataStartupError('旧私有状态导入标记已损坏，已拒绝重新导入凭据', path, {
      cause: error
    })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DataStartupError('旧私有状态导入标记无效，已拒绝重新导入凭据', path)
  }
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== LEGACY_PRIVATE_IMPORT_SCHEMA_VERSION) {
    throw new DataStartupError('旧私有状态导入标记版本不受支持', path)
  }
  return {
    schemaVersion: LEGACY_PRIVATE_IMPORT_SCHEMA_VERSION,
    completedAt: assertTimestamp(input.completedAt, 'legacyImport.completedAt')
  }
}

/**
 * 从 v0.3.x 的 userData/data 中复制私有状态到固定 state 目录。
 * 源数据始终保留；目标一旦存在就完全跳过，不做合并或覆盖。
 */
export function importLegacyPrivateState(
  userDataRoot: string,
  now: () => number = Date.now
): LegacyPrivateStateImportResult {
  const context = dataLocationContext(userDataRoot)
  if (readLegacyPrivateImportMarker(context.privatePaths.legacyPrivateImportMarker)) {
    return {
      copied: [],
      skippedExisting: [],
      missing: [],
      alreadyCompleted: true
    }
  }
  const result: LegacyPrivateStateImportResult = {
    copied: [],
    skippedExisting: [],
    missing: [],
    alreadyCompleted: false
  }
  mkdirSync(context.privatePaths.stateRoot, { recursive: true })
  for (const entry of LEGACY_PRIVATE_ENTRIES) {
    const source = join(context.defaultRoot, entry)
    const destination = join(context.privatePaths.stateRoot, entry)
    if (lstatOrNull(destination)) {
      result.skippedExisting.push(entry)
      continue
    }
    if (!lstatOrNull(source)) {
      result.missing.push(entry)
      continue
    }
    const copied = copyLegacyEntry(
      source,
      destination,
      entry === 'settings.json' ? 'file' : 'directory'
    )
    // 若提交前目标由另一个进程创建，copyLegacyEntry 会保留对方版本并跳过。
    if (copied) result.copied.push(entry)
    else result.skippedExisting.push(entry)
  }
  // 只在所有顶层项都检查/复制完成后写 marker。若中途失败，下次
  // 启动会重试未完成项；marker 存在后即使目标被删除也不会复活旧 Cookie/token。
  writeJsonAtomic(context.privatePaths.legacyPrivateImportMarker, {
    schemaVersion: LEGACY_PRIVATE_IMPORT_SCHEMA_VERSION,
    completedAt: now()
  } satisfies LegacyPrivateImportMarker)
  return result
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameAbsolutePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight
}

function assembleResult(
  location: ResolvedDataLocation,
  legacyPrivateState: LegacyPrivateStateImportResult,
  migration: DataMigrationStartupResult | null
): DataStartupResult {
  const libraryPaths = makeLibraryPaths(location.activeRoot)
  return {
    location,
    libraryPaths,
    privatePaths: location.privatePaths,
    paths: combinePaths(libraryPaths, location.privatePaths),
    startupFiles: dataStartupFiles(location.userDataRoot),
    legacyPrivateState,
    migration
  }
}

/**
 * Service/Store 创建前调用的唯一启动入口。
 *
 * 已配置的 activeRoot 不可用时 initializeDefaultDataLocation 会原样抛错，绝不静默
 * 回退。只有 pending 迁移自身失败会转为中文结果，并继续使用原 activeRoot 启动。
 */
export async function prepareDataStartup(
  userDataRoot: string,
  options: PrepareDataStartupOptions = {}
): Promise<DataStartupResult> {
  const now = options.now ?? Date.now
  // 这一步在读取 pending 前完成，确保缺失的自定义 activeRoot 仍是阻断性错误。
  let location = initializeDefaultDataLocation(userDataRoot, now, options.makeLibraryId)
  const legacyPrivateState = importLegacyPrivateState(userDataRoot, now)
  const files = dataStartupFiles(userDataRoot)

  let pending: PendingDataMigrationRequest | null = null
  let pendingReadError: unknown
  try {
    pending = readPendingDataMigration(userDataRoot)
  } catch (error) {
    pendingReadError = error
  }
  if (!pending && pendingReadError === undefined) {
    return assembleResult(location, legacyPrivateState, null)
  }

  const sourceRoot = location.activeRoot
  let migration: DataMigrationStartupResult
  let activationCommitted = false
  try {
    if (pendingReadError) throw pendingReadError
    const request = pending!
    if (sameAbsolutePath(sourceRoot, request.targetRoot)) {
      // 上次进程可能在 bootstrap 切换后、pending 清理前退出。此时身份
      // 已在 resolveDataLocation 中验证，直接完成收尾，绝不对同一目录再复制。
      const originalRoot = location.bootstrap?.lastGoodRoot ?? sourceRoot
      migration = {
        schemaVersion: DATA_MIGRATION_STARTUP_RESULT_SCHEMA_VERSION,
        status: 'success',
        sourceRoot: originalRoot,
        targetRoot: sourceRoot,
        requestedAt: request.requestedAt,
        completedAt: now(),
        message: `数据资料库已在上次启动完成切换。原目录仍保留在：${originalRoot}`,
        journalPath: files.journal
      }
    } else {
      const migrated = await migrateDataDirectory({
        sourceRoot,
        targetRoot: request.targetRoot,
        journalPath: files.journal,
        id: options.migrationId?.(),
        now
      })
      const activated = activateDataLocation(userDataRoot, migrated.targetRoot, {
        lastGoodRoot: sourceRoot,
        now
      })
      activationCommitted = true
      location = {
        ...location,
        activeRoot: activated.activeRoot,
        customized: activated.activeRoot !== location.defaultRoot,
        needsInitialization: false,
        bootstrap: activated
      }
      options.afterActivate?.()
      migration = {
        schemaVersion: DATA_MIGRATION_STARTUP_RESULT_SCHEMA_VERSION,
        status: 'success',
        sourceRoot,
        targetRoot: location.activeRoot,
        requestedAt: request.requestedAt,
        completedAt: now(),
        message: `数据资料库迁移完成。原目录仍保留在：${sourceRoot}`,
        journalPath: files.journal
      }
    }
  } catch (error) {
    if (activationCommitted) {
      // bootstrap 是不可逆的提交点。切换后任何异常都必须阻断本次
      // 启动；继续用 sourceRoot 运行会让两份资料库同时被写入。
      throw new DataStartupError(
        `数据资料库指针已切换到：${location.activeRoot}，但启动收尾失败。本次已拒绝回退到旧目录，请重新启动 infohub。`,
        location.activeRoot,
        { cause: error }
      )
    }
    migration = {
      schemaVersion: DATA_MIGRATION_STARTUP_RESULT_SCHEMA_VERSION,
      status: 'failed',
      sourceRoot,
      ...(pending ? { targetRoot: pending.targetRoot, requestedAt: pending.requestedAt } : {}),
      completedAt: now(),
      message: `数据资料库迁移失败，仍使用原目录：${sourceRoot}。原因：${describeError(error)}`,
      journalPath: files.journal
    }
  }

  // 无论成功、请求损坏还是目标不合规，都只尝试一次，避免每次启动重复失败。
  try {
    clearPendingDataMigration(userDataRoot)
  } catch {
    // 与结果写入同理：私有状态盘故障会在下次启动再次提示，但不切到空资料库。
  }
  try {
    writeJsonAtomic(files.lastResult, migration)
  } catch {
    // 结果落盘失败不应把一次可恢复的迁移错误升级为“应用无法启动”。
  }
  return assembleResult(location, legacyPrivateState, migration)
}

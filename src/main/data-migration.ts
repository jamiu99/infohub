// 资料库迁移的纯文件核心。
//
// 设计约束：源目录始终保留；目标只能为空；跨盘只 copy，不 rename 源；
// 所有文件在目标盘 staging 中逐项校验后，才用同目录 rename 提交。
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'

export const DATA_MIGRATION_JOURNAL_VERSION = 1 as const

/** v0.3.x 一体目录中不能进入公开资料库的本机状态。 */
export const LEGACY_PRIVATE_STATE_ENTRIES = ['settings.json', 'secrets', 'team'] as const

export type DataMigrationPhase =
  | 'planned'
  | 'copying'
  | 'verifying'
  | 'committing'
  | 'complete'
  | 'failed'

export interface DataMigrationFile {
  path: string
  size: number
  sha256: string
}

export interface DataMigrationJournal {
  schemaVersion: typeof DATA_MIGRATION_JOURNAL_VERSION
  id: string
  sourceRoot: string
  targetRoot: string
  stagingRoot: string
  phase: DataMigrationPhase
  startedAt: number
  updatedAt: number
  completedAt?: number
  committed: boolean
  files: DataMigrationFile[]
  bytes: number
  error?: string
}

export interface DataMigrationResult {
  sourceRoot: string
  targetRoot: string
  journalPath: string
  files: DataMigrationFile[]
  bytes: number
}

export interface DataMigrationOptions {
  sourceRoot: string
  targetRoot: string
  /** 必须放在固定私有状态根，不能位于源、目标或 staging 内。 */
  journalPath: string
  /** 额外排除项；参数统一使用 `/` 分隔的相对路径。 */
  exclude?: (relativePath: string) => boolean
  id?: string
  now?: () => number
  hooks?: {
    /** journal 已落盘后调用；可用于进度桥接与故障注入测试。 */
    onPhase?: (journal: Readonly<DataMigrationJournal>) => void | Promise<void>
    afterFileCopied?: (file: Readonly<DataMigrationFile>) => void | Promise<void>
  }
}

export type DataMigrationErrorCode =
  | 'INVALID_PATH'
  | 'SOURCE_UNAVAILABLE'
  | 'TARGET_UNAVAILABLE'
  | 'TARGET_NOT_EMPTY'
  | 'NESTED_PATH'
  | 'SYMLINK_NOT_ALLOWED'
  | 'UNSUPPORTED_ENTRY'
  | 'JOURNAL_INSIDE_DATA'
  | 'STAGING_EXISTS'
  | 'COPY_FAILED'
  | 'VERIFY_FAILED'
  | 'COMMIT_FAILED'
  | 'INVALID_JOURNAL'

export class DataMigrationError extends Error {
  constructor(
    readonly code: DataMigrationErrorCode,
    message: string,
    readonly path?: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'DataMigrationError'
  }
}

function portablePath(path: string): string {
  return path.split(sep).join('/')
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function canonicalTarget(path: string): Promise<string> {
  const current = await lstatOrNull(path)
  if (current) return realpath(path)
  const parent = dirname(path)
  const parentStat = await lstatOrNull(parent)
  if (!parentStat?.isDirectory()) {
    throw new DataMigrationError(
      'TARGET_UNAVAILABLE',
      `目标目录的父目录不存在：${parent}`,
      parent
    )
  }
  return resolve(await realpath(parent), basename(path))
}

/**
 * 解析可能尚不存在的文件路径，同时消除任意祖先目录中的链接、目录联接和
 * Windows 8.3 短路径别名。journal 的父目录通常要到首次写入时才创建，
 * 因此不能只 realpath 它的直接父目录。
 */
async function canonicalPotentialPath(path: string): Promise<string> {
  let existingAncestor = resolve(path)
  const missingSegments: string[] = []
  while (!(await lstatOrNull(existingAncestor))) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) return existingAncestor
    missingSegments.unshift(basename(existingAncestor))
    existingAncestor = parent
  }
  return resolve(await realpath(existingAncestor), ...missingSegments)
}

async function assertSourceRoot(path: string): Promise<string> {
  const current = await lstatOrNull(path)
  if (!current) {
    throw new DataMigrationError('SOURCE_UNAVAILABLE', `源资料库不存在：${path}`, path)
  }
  if (current.isSymbolicLink()) {
    throw new DataMigrationError(
      'SYMLINK_NOT_ALLOWED',
      `源资料库不能是符号链接或目录联接：${path}`,
      path
    )
  }
  if (!current.isDirectory()) {
    throw new DataMigrationError('SOURCE_UNAVAILABLE', `源资料库不是目录：${path}`, path)
  }
  try {
    await access(path, constants.R_OK)
  } catch (error) {
    throw new DataMigrationError('SOURCE_UNAVAILABLE', `源资料库不可读：${path}`, path, {
      cause: error
    })
  }
  return realpath(path)
}

async function assertEmptyTarget(path: string): Promise<{ existed: boolean; canonical: string }> {
  if (resolve(path) === parse(resolve(path)).root) {
    throw new DataMigrationError('INVALID_PATH', '不能把文件系统根目录作为迁移目标', path)
  }
  const current = await lstatOrNull(path)
  if (current?.isSymbolicLink()) {
    throw new DataMigrationError(
      'SYMLINK_NOT_ALLOWED',
      `迁移目标不能是符号链接或目录联接：${path}`,
      path
    )
  }
  if (current && !current.isDirectory()) {
    throw new DataMigrationError('TARGET_UNAVAILABLE', `迁移目标不是目录：${path}`, path)
  }
  if (current) {
    const entries = await readdir(path)
    if (entries.length > 0) {
      throw new DataMigrationError('TARGET_NOT_EMPTY', `迁移目标必须为空目录：${path}`, path)
    }
    try {
      await access(path, constants.R_OK | constants.W_OK)
    } catch (error) {
      throw new DataMigrationError('TARGET_UNAVAILABLE', `迁移目标不可读写：${path}`, path, {
        cause: error
      })
    }
  } else {
    const parent = dirname(path)
    try {
      await access(parent, constants.R_OK | constants.W_OK)
    } catch (error) {
      throw new DataMigrationError('TARGET_UNAVAILABLE', `迁移目标的父目录不可读写：${parent}`, parent, {
        cause: error
      })
    }
  }
  return { existed: Boolean(current), canonical: await canonicalTarget(path) }
}

function shouldSkip(relativePath: string, options: DataMigrationOptions): boolean {
  const normalized = portablePath(relativePath)
  const name = basename(relativePath)
  // SQLite 是派生索引；临时文件可能处在未完成写入状态，均由目标启动时重建/忽略。
  if (normalized === 'index.sqlite' || normalized.startsWith('index.sqlite-')) return true
  if (name.endsWith('.tmp') || name.includes('.tmp.')) return true
  const topLevel = normalized.split('/')[0]
  if ((LEGACY_PRIVATE_STATE_ENTRIES as readonly string[]).includes(topLevel)) return true
  return options.exclude?.(normalized) === true
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', rejectHash)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function writeJournalAtomic(path: string, journal: DataMigrationJournal): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(tmp, `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

function validateJournal(value: unknown): DataMigrationJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DataMigrationError('INVALID_JOURNAL', '迁移记录不是有效对象')
  }
  const input = value as Partial<DataMigrationJournal>
  if (
    input.schemaVersion !== DATA_MIGRATION_JOURNAL_VERSION ||
    typeof input.id !== 'string' ||
    typeof input.sourceRoot !== 'string' ||
    typeof input.targetRoot !== 'string' ||
    typeof input.stagingRoot !== 'string' ||
    !['planned', 'copying', 'verifying', 'committing', 'complete', 'failed'].includes(
      String(input.phase)
    ) ||
    typeof input.startedAt !== 'number' ||
    typeof input.updatedAt !== 'number' ||
    typeof input.committed !== 'boolean' ||
    !Array.isArray(input.files) ||
    typeof input.bytes !== 'number'
  ) {
    throw new DataMigrationError('INVALID_JOURNAL', '迁移记录字段不完整或版本不受支持')
  }
  return input as DataMigrationJournal
}

export async function readDataMigrationJournal(path: string): Promise<DataMigrationJournal | null> {
  try {
    return validateJournal(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof DataMigrationError) throw error
    throw new DataMigrationError('INVALID_JOURNAL', `迁移记录损坏：${path}`, path, { cause: error })
  }
}

interface RelativeTree {
  directories: string[]
  files: string[]
}

async function collectRelativeTree(
  root: string,
  options: DataMigrationOptions,
  rejectSymlinks: boolean
): Promise<RelativeTree> {
  const directories: string[] = []
  const files: string[] = []
  const walk = async (directory: string, relativeDirectory = ''): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const rel = relativeDirectory ? `${relativeDirectory}${sep}${entry.name}` : entry.name
      const full = resolve(directory, entry.name)
      const current = await lstat(full)
      if (current.isSymbolicLink()) {
        if (rejectSymlinks) {
          throw new DataMigrationError(
            'SYMLINK_NOT_ALLOWED',
            `资料库内不允许符号链接或目录联接：${full}`,
            full
          )
        }
        continue
      }
      if (shouldSkip(rel, options)) continue
      if (current.isDirectory()) {
        directories.push(rel)
        await walk(full, rel)
      } else if (current.isFile()) {
        files.push(rel)
      } else {
        throw new DataMigrationError(
          'UNSUPPORTED_ENTRY',
          `资料库包含不支持的文件类型：${full}`,
          full
        )
      }
    }
  }
  await walk(root)
  return { directories, files }
}

function sameFileList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * 把一个公开资料库迁移到空目标目录。
 *
 * 返回成功只表示目标目录已完整提交；调用方应随后用 data-location.activateDataLocation
 * 原子切换 bootstrap，并在启动 Store 成功后再把迁移视为对用户可见的完成。
 */
export async function migrateDataDirectory(options: DataMigrationOptions): Promise<DataMigrationResult> {
  const now = options.now ?? Date.now
  const id = options.id ?? randomUUID()
  if (!id || /[\\/]/.test(id)) {
    throw new DataMigrationError('INVALID_PATH', '迁移事务 ID 无效')
  }
  const requestedSource = resolve(options.sourceRoot)
  const requestedTarget = resolve(options.targetRoot)
  const requestedJournal = resolve(options.journalPath)
  if (requestedSource === parse(requestedSource).root) {
    throw new DataMigrationError('INVALID_PATH', '不能迁移整个文件系统根目录', requestedSource)
  }

  const sourceRoot = await assertSourceRoot(requestedSource)
  const target = await assertEmptyTarget(requestedTarget)
  const targetRoot = target.canonical
  const journalPath = await canonicalPotentialPath(requestedJournal)
  if (
    sourceRoot === targetRoot ||
    isInside(sourceRoot, targetRoot) ||
    isInside(targetRoot, sourceRoot)
  ) {
    throw new DataMigrationError(
      'NESTED_PATH',
      '源资料库与迁移目标不能相同，也不能互相嵌套',
      requestedTarget
    )
  }
  if (
    journalPath === sourceRoot ||
    journalPath === targetRoot ||
    isInside(sourceRoot, journalPath) ||
    isInside(targetRoot, journalPath)
  ) {
    throw new DataMigrationError(
      'JOURNAL_INSIDE_DATA',
      '迁移记录必须放在资料库之外的固定私有状态目录',
      journalPath
    )
  }

  const stagingRoot = resolve(dirname(targetRoot), `.${basename(targetRoot)}.infohub-staging-${id}`)
  if (journalPath === stagingRoot || isInside(stagingRoot, journalPath)) {
    throw new DataMigrationError(
      'JOURNAL_INSIDE_DATA',
      '迁移记录不能放在迁移暂存目录中',
      journalPath
    )
  }
  if (await lstatOrNull(stagingRoot)) {
    throw new DataMigrationError('STAGING_EXISTS', `迁移暂存目录已存在：${stagingRoot}`, stagingRoot)
  }

  let journal: DataMigrationJournal = {
    schemaVersion: DATA_MIGRATION_JOURNAL_VERSION,
    id,
    sourceRoot,
    targetRoot,
    stagingRoot,
    phase: 'planned',
    startedAt: now(),
    updatedAt: now(),
    committed: false,
    files: [],
    bytes: 0
  }
  const persistPhase = async (phase: DataMigrationPhase): Promise<void> => {
    journal = { ...journal, phase, updatedAt: now() }
    await writeJournalAtomic(journalPath, journal)
    await options.hooks?.onPhase?.(journal)
  }

  try {
    await persistPhase('planned')
    await mkdir(stagingRoot)
    await persistPhase('copying')

    const sourceTree = await collectRelativeTree(sourceRoot, options, true)
    for (const rel of sourceTree.directories) {
      await mkdir(resolve(stagingRoot, rel), { recursive: true })
    }
    for (const rel of sourceTree.files) {
      const source = resolve(sourceRoot, rel)
      const destination = resolve(stagingRoot, rel)
      await mkdir(dirname(destination), { recursive: true })
      const sourceBefore = await stat(source)
      const sourceHash = await sha256File(source)
      await copyFile(source, destination)
      const destinationStat = await stat(destination)
      const destinationHash = await sha256File(destination)
      if (sourceBefore.size !== destinationStat.size || sourceHash !== destinationHash) {
        throw new DataMigrationError('VERIFY_FAILED', `文件复制校验失败：${portablePath(rel)}`, source)
      }
      const file: DataMigrationFile = {
        path: portablePath(rel),
        size: destinationStat.size,
        sha256: destinationHash
      }
      journal.files.push(file)
      journal.bytes += file.size
      await options.hooks?.afterFileCopied?.(file)
    }

    await persistPhase('verifying')
    const currentSourceTree = await collectRelativeTree(sourceRoot, options, true)
    const stageTree = await collectRelativeTree(stagingRoot, { ...options, exclude: undefined }, true)
    const normalizedSourceDirectories = currentSourceTree.directories.map(portablePath)
    const normalizedStageDirectories = stageTree.directories.map(portablePath)
    const normalizedSourceFiles = currentSourceTree.files.map(portablePath)
    const normalizedStageFiles = stageTree.files.map(portablePath)
    if (
      !sameFileList(normalizedSourceDirectories, normalizedStageDirectories) ||
      !sameFileList(normalizedSourceFiles, normalizedStageFiles)
    ) {
      throw new DataMigrationError('VERIFY_FAILED', '迁移期间源目录发生变化，未提交目标目录')
    }
    for (const file of journal.files) {
      const source = resolve(sourceRoot, ...file.path.split('/'))
      const staged = resolve(stagingRoot, ...file.path.split('/'))
      const [sourceStat, stagedStat, sourceHash, stagedHash] = await Promise.all([
        stat(source),
        stat(staged),
        sha256File(source),
        sha256File(staged)
      ])
      if (
        sourceStat.size !== file.size ||
        stagedStat.size !== file.size ||
        sourceHash !== file.sha256 ||
        stagedHash !== file.sha256
      ) {
        throw new DataMigrationError(
          'VERIFY_FAILED',
          `迁移期间文件发生变化：${file.path}`,
          source
        )
      }
    }

    // 防止在长时间复制期间另一个进程往目标写入内容。
    await assertEmptyTarget(requestedTarget)
    await persistPhase('committing')
    if (target.existed) await rmdir(requestedTarget)
    await rename(stagingRoot, requestedTarget)
    journal.committed = true
    journal.completedAt = now()
    await persistPhase('complete')
    return {
      sourceRoot,
      targetRoot: requestedTarget,
      journalPath,
      files: journal.files.map((file) => ({ ...file })),
      bytes: journal.bytes
    }
  } catch (error) {
    if (!journal.committed) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    journal = { ...journal, phase: 'failed', updatedAt: now(), error: message }
    await writeJournalAtomic(journalPath, journal).catch(() => undefined)
    if (error instanceof DataMigrationError) throw error
    const code: DataMigrationErrorCode = journal.committed ? 'COMMIT_FAILED' : 'COPY_FAILED'
    throw new DataMigrationError(
      code,
      journal.committed
        ? `目标资料库已提交，但迁移记录更新失败：${message}`
        : `资料库迁移失败，源目录未改变：${message}`,
      journal.committed ? requestedTarget : stagingRoot,
      { cause: error }
    )
  }
}

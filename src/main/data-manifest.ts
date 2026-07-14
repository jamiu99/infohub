// 资料库身份文件。
//
// 绝对路径不能唯一识别一个资料库：Windows 盘符可能被重新分配，
// 目录联接也可能改指。bootstrap 和根目录中的 libraryId 必须一致，
// Store 才能打开该目录。
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { LIBRARY_MANIFEST_FILE } from '../core/paths'

export const LIBRARY_MANIFEST_SCHEMA_VERSION = 1 as const
export const LIBRARY_MANIFEST_KIND = 'infohub-library' as const

export interface LibraryManifest {
  schemaVersion: typeof LIBRARY_MANIFEST_SCHEMA_VERSION
  kind: typeof LIBRARY_MANIFEST_KIND
  libraryId: string
  createdAt: number
  managed: ['articles', 'raw', 'sources.json', 'index.sqlite']
  externalOutputs: 'outputs'
  guide: 'INFOHUB_DATA.md'
}

export type LibraryManifestErrorCode =
  | 'MANIFEST_MISSING'
  | 'MANIFEST_INVALID'
  | 'LIBRARY_ID_MISMATCH'

export class LibraryManifestError extends Error {
  constructor(
    readonly code: LibraryManifestErrorCode,
    message: string,
    readonly path: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'LibraryManifestError'
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MANAGED_ENTRIES = ['articles', 'raw', 'sources.json', 'index.sqlite'] as const

export function isLibraryId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function parseLibraryManifest(
  value: unknown,
  path = LIBRARY_MANIFEST_FILE
): LibraryManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LibraryManifestError('MANIFEST_INVALID', '资料库身份文件不是有效对象', path)
  }
  const input = value as Record<string, unknown>
  const managed = input.managed
  if (
    input.schemaVersion !== LIBRARY_MANIFEST_SCHEMA_VERSION ||
    input.kind !== LIBRARY_MANIFEST_KIND ||
    !isLibraryId(input.libraryId) ||
    !validTimestamp(input.createdAt) ||
    !Array.isArray(managed) ||
    managed.length !== MANAGED_ENTRIES.length ||
    !managed.every((entry, index) => entry === MANAGED_ENTRIES[index]) ||
    input.externalOutputs !== 'outputs' ||
    input.guide !== 'INFOHUB_DATA.md'
  ) {
    throw new LibraryManifestError(
      'MANIFEST_INVALID',
      '资料库身份文件字段不完整或版本不受支持',
      path
    )
  }
  return {
    schemaVersion: LIBRARY_MANIFEST_SCHEMA_VERSION,
    kind: LIBRARY_MANIFEST_KIND,
    libraryId: input.libraryId,
    createdAt: input.createdAt,
    managed: [...MANAGED_ENTRIES],
    externalOutputs: 'outputs',
    guide: 'INFOHUB_DATA.md'
  }
}

export function libraryManifestPath(root: string): string {
  return join(resolve(root), LIBRARY_MANIFEST_FILE)
}

export function readLibraryManifest(root: string): LibraryManifest | null {
  const path = libraryManifestPath(root)
  if (!existsSync(path)) return null
  try {
    return parseLibraryManifest(JSON.parse(readFileSync(path, 'utf8')), path)
  } catch (error) {
    if (error instanceof LibraryManifestError) throw error
    throw new LibraryManifestError('MANIFEST_INVALID', `资料库身份文件已损坏：${path}`, path, {
      cause: error
    })
  }
}

function writeManifestAtomic(path: string, manifest: LibraryManifest): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
    // 资料库身份一旦存在就不允许覆盖。这里的二次检查用于防止
    // 外部程序在初始化期间创建另一个身份。App 本身另有单实例锁。
    if (existsSync(path)) {
      const existing = readLibraryManifest(dirname(path))
      if (existing?.libraryId !== manifest.libraryId) {
        throw new LibraryManifestError(
          'LIBRARY_ID_MISMATCH',
          '资料库已由另一个身份初始化，未覆盖既有文件',
          path
        )
      }
      return
    }
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

export function createLibraryManifest(
  root: string,
  options: { libraryId?: string; now?: () => number } = {}
): LibraryManifest {
  const path = libraryManifestPath(root)
  const existing = readLibraryManifest(root)
  if (existing) {
    if (options.libraryId && existing.libraryId !== options.libraryId) {
      throw new LibraryManifestError(
        'LIBRARY_ID_MISMATCH',
        `资料库身份不匹配：${path}`,
        path
      )
    }
    return existing
  }
  const libraryId = options.libraryId ?? randomUUID()
  if (!isLibraryId(libraryId)) {
    throw new LibraryManifestError('MANIFEST_INVALID', '资料库 libraryId 必须是 UUID', path)
  }
  const manifest: LibraryManifest = {
    schemaVersion: LIBRARY_MANIFEST_SCHEMA_VERSION,
    kind: LIBRARY_MANIFEST_KIND,
    libraryId,
    createdAt: (options.now ?? Date.now)(),
    managed: [...MANAGED_ENTRIES],
    externalOutputs: 'outputs',
    guide: 'INFOHUB_DATA.md'
  }
  const normalized = parseLibraryManifest(manifest, path)
  mkdirSync(resolve(root), { recursive: true })
  writeManifestAtomic(path, normalized)
  return normalized
}

export function assertLibraryManifest(root: string, expectedLibraryId?: string): LibraryManifest {
  const path = libraryManifestPath(root)
  const manifest = readLibraryManifest(root)
  if (!manifest) {
    throw new LibraryManifestError('MANIFEST_MISSING', `数据资料库缺少身份文件：${path}`, path)
  }
  if (expectedLibraryId && manifest.libraryId !== expectedLibraryId) {
    throw new LibraryManifestError(
      'LIBRARY_ID_MISMATCH',
      `数据资料库身份不匹配，拒绝打开：${resolve(root)}`,
      path
    )
  }
  return manifest
}

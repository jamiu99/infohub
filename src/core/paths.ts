// 运行时路径契约。
//
// LibraryPaths 是用户可选择、迁移并交给外部只读消费者的数据资料库；
// PrivateStatePaths 固定留在 Electron userData 下，不能暴露给资料库消费者。
// 旧 Paths/makePaths 暂时保留，便于 Service/Store 分阶段迁移而不打断现有版本。
import { join } from 'node:path'

export const LIBRARY_MANIFEST_FILE = 'infohub-library.json'
export const DATA_LOCATION_BOOTSTRAP_FILE = 'data-location.json'
export const DATA_LOCATION_MARKER_FILE = 'data-location.initialized.json'
export const LEGACY_PRIVATE_IMPORT_MARKER_FILE = 'legacy-private-import.json'

/** 用户可迁移的公开资料库。 */
export interface LibraryPaths {
  root: string
  manifest: string
  articles: string
  raw: string
  outputs: string
  index: string
  sources: string
  guide: string
}

/** DataPaths 是 LibraryPaths 的语义别名，供后续调用方逐步采用。 */
export type DataPaths = LibraryPaths

/** 固定在 app.getPath('userData') 下的本机私有状态。 */
export interface PrivateStatePaths {
  stateRoot: string
  bootstrap: string
  dataLocationMarker: string
  legacyPrivateImportMarker: string
  migrations: string
  dataMigrationRequest: string
  dataMigrationResult: string
  settings: string
  secrets: string
  wxAccounts: string
  teamDevice: string
  team: string
  teamOutbox: string
  teamAcked: string
  teamQuarantine: string
  teamState: string
}

/**
 * 兼容旧代码的一体化路径类型。
 *
 * 新代码不应继续依赖它：资料库用 LibraryPaths，本机状态用 PrivateStatePaths。
 */
export interface Paths extends LibraryPaths, PrivateStatePaths {}

export function makeLibraryPaths(dataRoot: string): LibraryPaths {
  return {
    root: dataRoot,
    manifest: join(dataRoot, LIBRARY_MANIFEST_FILE),
    articles: join(dataRoot, 'articles'),
    raw: join(dataRoot, 'raw'),
    outputs: join(dataRoot, 'outputs'),
    index: join(dataRoot, 'index.sqlite'),
    sources: join(dataRoot, 'sources.json'),
    guide: join(dataRoot, 'INFOHUB_DATA.md')
  }
}

/** “数据目录”旧称对应公开资料库；保留直观别名供调用方迁移。 */
export const makeDataPaths = makeLibraryPaths

export function makePrivateStatePaths(stateRoot: string): PrivateStatePaths {
  return {
    stateRoot,
    bootstrap: join(stateRoot, DATA_LOCATION_BOOTSTRAP_FILE),
    dataLocationMarker: join(stateRoot, DATA_LOCATION_MARKER_FILE),
    legacyPrivateImportMarker: join(stateRoot, LEGACY_PRIVATE_IMPORT_MARKER_FILE),
    migrations: join(stateRoot, 'migrations'),
    dataMigrationRequest: join(stateRoot, 'migrations', 'pending.json'),
    dataMigrationResult: join(stateRoot, 'migrations', 'last-result.json'),
    settings: join(stateRoot, 'settings.json'),
    secrets: join(stateRoot, 'secrets'),
    wxAccounts: join(stateRoot, 'secrets', 'wx-accounts.enc'),
    teamDevice: join(stateRoot, 'secrets', 'team-device.enc'),
    team: join(stateRoot, 'team'),
    teamOutbox: join(stateRoot, 'team', 'outbox'),
    teamAcked: join(stateRoot, 'team', 'acked'),
    teamQuarantine: join(stateRoot, 'team', 'quarantine'),
    teamState: join(stateRoot, 'team', 'sync-state.json')
  }
}

/** Electron userData 下的默认公开资料库。 */
export function defaultLibraryRoot(userDataRoot: string): string {
  return join(userDataRoot, 'data')
}

/** Electron userData 下固定的私有状态根。 */
export function defaultPrivateStateRoot(userDataRoot: string): string {
  return join(userDataRoot, 'state')
}

/** 分阶段迁移期间供旧 Store/TeamSyncClient 共用的装配对象。 */
export function combinePaths(
  libraryPaths: LibraryPaths,
  privateStatePaths: PrivateStatePaths
): Paths {
  return { ...libraryPaths, ...privateStatePaths }
}

/**
 * 旧版兼容装配：仍把私有状态放在同一个 dataRoot。
 *
 * 该函数只用于尚未切换到双路径注入的现有代码和测试。新的 Service 装配完成后可删除。
 */
export function makePaths(dataRoot: string): Paths {
  return combinePaths(makeLibraryPaths(dataRoot), makePrivateStatePaths(dataRoot))
}

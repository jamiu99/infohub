import { app, dialog, ipcMain, shell } from 'electron'
import { readdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { IPC } from '../shared/ipc'
import type { DataLibraryMoveResult, DataLibraryStatus } from '../shared/data-library'
import type { DataStartupResult } from './data-startup'
import {
  clearPendingDataMigration,
  queuePendingDataMigration,
  readLastDataMigrationResult
} from './data-startup'

export interface DataLibraryControllerOptions {
  userDataRoot: string
  startup: DataStartupResult
  beforeRestart: () => Promise<void>
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function statusView(
  startup: DataStartupResult,
  migration: DataStartupResult['migration']
): DataLibraryStatus {
  return {
    root: startup.location.activeRoot,
    defaultRoot: startup.location.defaultRoot,
    outputsPath: startup.libraryPaths.outputs,
    customized: startup.location.customized,
    migration: migration
      ? {
          status: migration.status,
          sourceRoot: migration.sourceRoot,
          ...(migration.targetRoot ? { targetRoot: migration.targetRoot } : {}),
          completedAt: migration.completedAt,
          message: migration.message
        }
      : null
  }
}

function validateSelectedTarget(sourceRoot: string, targetRoot: string): string {
  const source = resolve(sourceRoot)
  const target = resolve(targetRoot)
  if (source === target || isInside(source, target) || isInside(target, source)) {
    throw new Error('新资料库不能与当前目录相同，也不能与当前目录互相嵌套')
  }
  let entries: string[]
  try {
    entries = readdirSync(target)
  } catch (error) {
    throw new Error(`无法读取迁移目标目录：${target}`, { cause: error })
  }
  if (entries.length > 0) throw new Error('请选择一个空目录作为新资料库')
  return target
}

/** 数据目录 UI 只负责排队；实际复制发生在下一次启动、Store 打开之前。 */
export function registerDataLibraryIpc(options: DataLibraryControllerOptions): void {
  let lastMigration = options.startup.migration
  if (!lastMigration) {
    try {
      lastMigration = readLastDataMigrationResult(options.userDataRoot)
    } catch (error) {
      console.warn('读取上次资料库迁移结果失败:', error)
    }
  }
  ipcMain.handle(IPC.dataLibraryStatus, () => statusView(options.startup, lastMigration))
  ipcMain.handle(IPC.dataLibraryOpen, async () => {
    const error = await shell.openPath(options.startup.location.activeRoot)
    if (error) throw new Error(`无法打开数据资料库：${error}`)
  })
  ipcMain.handle(IPC.dataLibraryChooseAndMigrate, async (): Promise<DataLibraryMoveResult> => {
    const selected = await dialog.showOpenDialog({
      title: '选择新的 infohub 数据资料库（必须为空目录）',
      defaultPath: dirname(options.startup.location.activeRoot),
      properties: ['openDirectory', 'createDirectory']
    })
    if (selected.canceled || !selected.filePaths[0]) return { state: 'cancelled' }
    const targetRoot = validateSelectedTarget(
      options.startup.location.activeRoot,
      selected.filePaths[0]
    )
    const confirmation = await dialog.showMessageBox({
      type: 'question',
      title: '迁移数据资料库',
      message: 'infohub 将安全关闭并重启，然后复制和校验全部内容数据。',
      detail: `新目录：${targetRoot}\n\n原目录会完整保留，不会自动删除；账号凭据与团队 token 不会迁移。`,
      buttons: ['迁移并重启', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (confirmation.response !== 0) return { state: 'cancelled' }

    queuePendingDataMigration(options.userDataRoot, targetRoot)
    try {
      await options.beforeRestart()
    } catch (error) {
      clearPendingDataMigration(options.userDataRoot)
      throw error
    }
    setTimeout(() => {
      app.relaunch()
      app.quit()
    }, 350)
    return { state: 'restarting', targetRoot }
  })
}

// 自动更新：electron-updater 从 GitHub Release 检查更新。见 docs/release.md。
// 用户下载一次后，之后启动自动检查、后台下载、退出时安装。
import { autoUpdater } from 'electron-updater'
import { BrowserWindow, ipcMain } from 'electron'
import type { UpdateStatus } from '../shared/ipc'

export function initUpdater(): void {
  autoUpdater.autoDownload = true // 有更新自动后台下载
  autoUpdater.autoInstallOnAppQuit = true // 退出时静默安装

  const send = (s: UpdateStatus): void => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update-status', s)
  }

  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }))
  autoUpdater.on('update-available', (i) => send({ state: 'available', version: i.version }))
  autoUpdater.on('update-not-available', () => send({ state: 'none' }))
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => send({ state: 'ready', version: i.version }))
  autoUpdater.on('error', (e) => send({ state: 'error', message: e.message }))

  // 渲染进程可主动触发"检查更新"和"立即重启安装"
  ipcMain.handle('update:check', () => autoUpdater.checkForUpdates().catch(() => null))
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall())

  // 启动后延迟检查（避开启动高峰）。dev 环境跳过。
  if (!process.defaultApp) {
    setTimeout(() => void autoUpdater.checkForUpdates().catch(() => null), 5000)
  }
}

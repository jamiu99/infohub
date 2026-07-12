// 用户确认式更新：检查 → 询问下载 → 下载进度 → 询问重启安装。
// 原生对话框运行在 main，不依赖 renderer/preload，可作为桌面恢复通道。
import { app, BrowserWindow, dialog, ipcMain, type MessageBoxOptions } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/ipc'
import { UpdateController, type UpdateUi } from './update-controller'

function send(value: UpdateStatus): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('update-status', value)
}

function showMessage(options: MessageBoxOptions): ReturnType<typeof dialog.showMessageBox> {
  const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)
}

function createNativeUi(): UpdateUi {
  return {
    status: send,
    progress: (value) => {
      for (const window of BrowserWindow.getAllWindows()) window.setProgressBar(value ?? -1)
    },
    confirmDownload: async (version, currentVersion) => {
      const result = await showMessage({
        type: 'info',
        title: 'infohub 更新',
        message: `发现新版本 ${version}`,
        detail: `当前版本为 ${currentVersion}。是否现在下载更新？`,
        buttons: ['下载更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      return result.response === 0
    },
    confirmInstall: async (version) => {
      const result = await showMessage({
        type: 'info',
        title: 'infohub 更新',
        message: `版本 ${version} 已下载完成`,
        detail: '立即重启 infohub 完成安装，或稍后在退出时安装。',
        buttons: ['立即重启更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      return result.response === 0
    },
    showUpToDate: async (currentVersion) => {
      await showMessage({
        type: 'info',
        title: '检查更新',
        message: '当前已经是最新版本',
        detail: `infohub ${currentVersion}`,
        buttons: ['确定'],
        noLink: true
      })
    },
    showBusy: async (phase) => {
      await showMessage({
        type: 'info',
        title: 'infohub 更新',
        message: phase === 'downloading' ? '更新正在下载中' : '正在检查更新',
        buttons: ['确定'],
        noLink: true
      })
    },
    showError: async (message) => {
      await showMessage({
        type: 'error',
        title: '更新失败',
        message: '无法完成更新',
        detail: message,
        buttons: ['确定'],
        noLink: true
      })
    }
  }
}

export function initUpdater(): UpdateController {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  const controller = new UpdateController(
    {
      check: async () => {
        await autoUpdater.checkForUpdates()
      },
      download: async () => {
        await autoUpdater.downloadUpdate()
      },
      install: () => autoUpdater.quitAndInstall(false, true)
    },
    createNativeUi(),
    app.getVersion()
  )

  autoUpdater.on('update-available', (info) => void controller.available(info.version))
  autoUpdater.on('update-not-available', () => void controller.none())
  autoUpdater.on('download-progress', (progress) => controller.progress(progress.percent))
  autoUpdater.on('update-downloaded', (info) => void controller.downloaded(info.version))
  autoUpdater.on('error', (error) => void controller.failed(error))

  ipcMain.handle('update:check', () => controller.check(true))
  ipcMain.handle('update:install', () => controller.installNow())

  if (!process.defaultApp) setTimeout(() => void controller.check(false), 5000)
  return controller
}

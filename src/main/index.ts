import { app, BrowserWindow, dialog, shell, Menu, session, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { Service } from './service'
import { initUpdater } from './updater'
import { isHttpUrl } from '../shared/url'

let service: Service | null = null
const isDesktopSmokeTest = process.argv.includes('--infohub-smoke-test')
const smokeDataPath = isDesktopSmokeTest ? join(tmpdir(), `infohub-smoke-${process.pid}`) : null

if (smokeDataPath) app.setPath('userData', smokeDataPath)

// 去掉 Electron 默认的 File/Edit/View/Window 原生菜单栏（这不是浏览器，用不上）
Menu.setApplicationMenu(null)

function installApplicationMenu(checkForUpdates: () => void): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '帮助',
      submenu: [
        { id: 'check-for-updates', label: '检查更新…', click: checkForUpdates },
        { type: 'separator' },
        {
          label: '关于 infohub',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '关于 infohub',
              message: `infohub ${app.getVersion()}`,
              detail: '本地信息采集、文件归档、SQLite 索引与快速看板',
              buttons: ['确定'],
              noLink: true
            })
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// 公众号图片防盗链：给 mmbiz 图片请求伪造 mp 的 Referer，窗口里即可直接显示原图。
// 这是桌面客户端相比网页的能力——网页 JS 改不了 Referer，主进程可以。
function installImageReferer(): void {
  const filter = { urls: ['*://*.qpic.cn/*', '*://*.qlogo.cn/*', '*://mmbiz.qpic.cn/*'] }
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, cb) => {
    details.requestHeaders['Referer'] = 'https://mp.weixin.qq.com/'
    cb({ requestHeaders: details.requestHeaders })
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    show: !isDesktopSmokeTest,
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'infohub',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // 外链用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // F12 / Ctrl+Shift+I 开关 DevTools（默认菜单被移除了，这里手动绑）
  win.webContents.on('before-input-event', (_e, input) => {
    const f12 = input.key === 'F12'
    const ctrlShiftI = input.control && input.shift && input.key.toLowerCase() === 'i'
    if (input.type === 'keyDown' && (f12 || ctrlShiftI)) {
      win.webContents.toggleDevTools()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (isDesktopSmokeTest) {
    let finished = false
    const finish = (ok: boolean, detail: string): void => {
      if (finished) return
      finished = true
      console.log(`Desktop bridge smoke test: ${ok ? 'OK' : 'FAILED'} (${detail})`)
      service?.stop()
      if (smokeDataPath) rmSync(smokeDataPath, { recursive: true, force: true })
      app.exit(ok ? 0 : 1)
    }
    const timer = setTimeout(() => finish(false, 'timeout'), 15_000)
    win.webContents.once('did-finish-load', () => {
      void win.webContents
        .executeJavaScript(`(async () => {
          if (!window.api || typeof window.api.account?.list !== 'function') return false;
          if (typeof window.api.account?.getCollectionSettings !== 'function') return false;
          if (typeof window.api.account?.setHourlyRequestLimit !== 'function') return false;
          const accounts = await window.api.account.list();
          const initial = await window.api.account.getCollectionSettings();
          const updated = await window.api.account.setHourlyRequestLimit(23);
          const reread = await window.api.account.getCollectionSettings();
          return Array.isArray(accounts)
            && initial?.hourlyRequestLimit === 20
            && updated?.hourlyRequestLimit === 23
            && reread?.hourlyRequestLimit === 23;
        })()`)
        .then((ok) => {
          clearTimeout(timer)
          const menuReady = Boolean(Menu.getApplicationMenu()?.getMenuItemById('check-for-updates'))
          const passed = ok === true && menuReady
          finish(
            passed,
            passed ? 'preload + account/settings IPC + update menu' : 'bridge or update menu missing'
          )
        })
        .catch((error: Error) => {
          clearTimeout(timer)
          finish(false, error.message)
        })
    })
  }
}

app.whenReady().then(() => {
  installImageReferer()
  service = new Service()
  service.start()
  createWindow()
  const updater = initUpdater()
  installApplicationMenu(() => void updater.check(true))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    service?.stop()
    app.quit()
  }
})

app.on('before-quit', () => service?.stop())

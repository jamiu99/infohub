import { app, BrowserWindow, shell, Menu, session } from 'electron'
import { join } from 'node:path'
import { Service } from './service'
import { initUpdater } from './updater'
import { isHttpUrl } from '../shared/url'

let service: Service | null = null

// 去掉 Electron 默认的 File/Edit/View/Window 原生菜单栏（这不是浏览器，用不上）
Menu.setApplicationMenu(null)

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
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'infohub',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
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
}

app.whenReady().then(() => {
  installImageReferer()
  service = new Service()
  service.start()
  createWindow()
  initUpdater()
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

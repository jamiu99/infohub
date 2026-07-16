import {
  app,
  BrowserWindow,
  dialog,
  shell,
  Menu,
  powerMonitor,
  session,
  type MenuItemConstructorOptions
} from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { Service } from './service'
import { initUpdater } from './updater'
import { isHttpUrl } from '../shared/url'
import { prepareDataStartup } from './data-startup'
import { registerDataLibraryIpc } from './data-library-controller'
import { GracefulShutdownCoordinator } from './graceful-shutdown'
import { userFacingError } from '../shared/errors'
import { shouldOpenFrameExternally } from './external-navigation'

let service: Service | null = null
const shutdown = new GracefulShutdownCoordinator(async () => {
  await service?.prepareForRestart()
})
const isDesktopSmokeTest = process.argv.includes('--infohub-smoke-test')
const smokeDataPath = isDesktopSmokeTest ? join(tmpdir(), `infohub-smoke-${process.pid}`) : null

if (smokeDataPath) app.setPath('userData', smokeDataPath)

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

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

  // 旧正文或嵌入内容可能显式使用 target=_self。禁止子 frame 离开静态正文，
  // 统一交给系统浏览器，避免 iframe 变成没有后退/关闭按钮的网页。
  win.webContents.on('will-frame-navigate', (event) => {
    if (!shouldOpenFrameExternally(event)) return
    event.preventDefault()
    void shell.openExternal(event.url)
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
      void (async () => {
        let exitCode = ok ? 0 : 1
        try {
          await service?.stop()
        } catch (error) {
          exitCode = 1
          console.error('Desktop bridge smoke cleanup failed:', error)
        } finally {
          // Windows 上 Chromium 可能在进程退出前仍短暂持有 userData 文件锁；
          // 烟测目录清理是 best-effort，不能因此阻止 Electron 返回测试结果。
          if (smokeDataPath) {
            try {
              rmSync(smokeDataPath, { recursive: true, force: true })
            } catch (error) {
              console.warn('Desktop bridge smoke temp cleanup skipped:', error)
            }
          }
          app.exit(exitCode)
        }
      })()
    }
    const timer = setTimeout(() => finish(false, 'timeout'), 15_000)
    win.webContents.once('did-finish-load', () => {
      void win.webContents
        .executeJavaScript(`(async () => {
          if (!window.api || typeof window.api.account?.list !== 'function') return false;
          if (typeof window.api.account?.getCollectionSettings !== 'function') return false;
          if (typeof window.api.account?.setHourlyRequestLimit !== 'function') return false;
          if (typeof window.api.collection?.getSettings !== 'function') return false;
          if (typeof window.api.collection?.updateSettings !== 'function') return false;
          if (typeof window.api.collection?.status !== 'function') return false;
          if (typeof window.api.dataLibrary?.status !== 'function') return false;
          if (typeof window.api.dataLibrary?.open !== 'function') return false;
          if (typeof window.api.dataLibrary?.chooseAndMigrate !== 'function') return false;
          if (typeof window.api.article?.reprocess !== 'function') return false;
          if (typeof window.api.article?.getContentHtml !== 'function') return false;
          if (typeof window.api.team?.status !== 'function') return false;
          if (typeof window.api.team?.updateSettings !== 'function') return false;
          if (typeof window.api.team?.join !== 'function') return false;
          if (typeof window.api.team?.leave !== 'function') return false;
          if (typeof window.api.team?.syncNow !== 'function') return false;
          const accounts = await window.api.account.list();
          const team = await window.api.team.status();
          const initial = await window.api.account.getCollectionSettings();
          const updated = await window.api.account.setHourlyRequestLimit(23);
          const reread = await window.api.account.getCollectionSettings();
          const collection = await window.api.collection.getSettings();
          const collectionStatus = await window.api.collection.status();
          const dataLibrary = await window.api.dataLibrary.status();
          const frameLoaded = await new Promise((resolve) => {
            const frame = document.createElement('iframe');
            const timeout = setTimeout(() => resolve(false), 2000);
            frame.onload = () => {
              clearTimeout(timeout);
              const ok = frame.contentDocument?.getElementById('srcdoc-smoke')?.textContent === 'iframe ok'
                && frame.contentDocument?.baseURI === 'https://mp.weixin.qq.com/s/smoke';
              frame.remove();
              resolve(ok);
            };
            frame.srcdoc = '<base href="https://mp.weixin.qq.com/s/smoke"><p id="srcdoc-smoke">iframe ok</p>';
            document.body.appendChild(frame);
          });
          return Array.isArray(accounts)
            && initial?.hourlyRequestLimit === 20
            && team?.state === 'disabled'
            && team?.serverUrl === 'https://home.agent-wiki.cn:18038'
            && updated?.hourlyRequestLimit === 23
            && reread?.hourlyRequestLimit === 23
            && collection?.autoCollectEnabled === false
            && collection?.intervalMinutes === 240
            && collectionStatus?.state === 'disabled'
            && typeof dataLibrary?.root === 'string'
            && typeof dataLibrary?.outputsPath === 'string'
            && frameLoaded;
        })()`)
        .then((ok) => {
          clearTimeout(timer)
          const menuReady = Boolean(Menu.getApplicationMenu()?.getMenuItemById('check-for-updates'))
          const passed = ok === true && menuReady
          finish(
            passed,
            passed
              ? 'preload + account/collection/data IPC + srcdoc iframe + update menu'
              : 'bridge, srcdoc iframe or update menu missing'
          )
        })
        .catch((error: Error) => {
          clearTimeout(timer)
          finish(false, error.message)
        })
    })
  }
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })

  app.whenReady().then(async () => {
    try {
      const userDataRoot = app.getPath('userData')
      const startup = await prepareDataStartup(userDataRoot)
      installImageReferer()
      service = new Service({ paths: startup.paths })
      service.start()
      registerDataLibraryIpc({
        userDataRoot,
        startup,
        beforeRestart: async () => service?.prepareForRestart()
      })
      createWindow()
      const updater = initUpdater({
        beforeInstall: () => shutdown.prepareAndAllowQuit()
      })
      installApplicationMenu(() => void updater.check(true))
      powerMonitor.on('resume', () => service?.resume())
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '数据资料库初始化失败'
      dialog.showErrorBox('infohub 无法打开数据资料库', message)
      await shutdown.prepareAndAllowQuit().catch(() => undefined)
      app.quit()
    }
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (!hasSingleInstanceLock || shutdown.isQuitAllowed()) return
  event.preventDefault()
  void shutdown
    .prepareAndAllowQuit()
    .then(() => app.quit())
    .catch((error) => {
      console.error('安全退出失败:', error)
      dialog.showErrorBox(
        'infohub 无法安全退出',
        userFacingError(error, '等待采集和数据写入完成时发生未知错误')
      )
    })
})

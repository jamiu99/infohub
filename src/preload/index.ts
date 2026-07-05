import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { InfohubApi } from '../shared/ipc'

const api: InfohubApi = {
  account: {
    list: () => ipcRenderer.invoke(IPC.accountList),
    login: () => ipcRenderer.invoke(IPC.accountLogin),
    relogin: (id) => ipcRenderer.invoke(IPC.accountRelogin, id),
    remove: (id) => ipcRenderer.invoke(IPC.accountRemove, id)
  },
  source: {
    list: () => ipcRenderer.invoke(IPC.sourceList),
    search: (type, q) => ipcRenderer.invoke(IPC.sourceSearch, type, q),
    add: (type, r) => ipcRenderer.invoke(IPC.sourceAdd, type, r),
    remove: (id) => ipcRenderer.invoke(IPC.sourceRemove, id),
    refresh: (id) => ipcRenderer.invoke(IPC.sourceRefresh, id)
  },
  article: {
    list: (opts) => ipcRenderer.invoke(IPC.articleList, opts),
    get: (id) => ipcRenderer.invoke(IPC.articleGet, id),
    markRead: (id, read) => ipcRenderer.invoke(IPC.articleMarkRead, id, read),
    archive: (id) => ipcRenderer.invoke(IPC.articleArchive, id),
    unreadCounts: () => ipcRenderer.invoke(IPC.articleUnreadCounts)
  },
  on: (channel, cb) => {
    const listener = (_e: unknown, ...args: unknown[]) => (cb as (...a: unknown[]) => void)(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

import { createApp } from 'vue'
import './styles/main.css'

function showBridgeError(): void {
  const root = document.querySelector('#app')
  if (!root) return
  const panel = document.createElement('main')
  panel.style.cssText =
    'max-width:680px;margin:15vh auto;padding:28px;font-family:system-ui,sans-serif;' +
    'line-height:1.7;color:#1f2328;border:1px solid #d0d7de;border-radius:12px;background:#fff;'
  const title = document.createElement('h1')
  title.textContent = 'infohub 桌面桥接加载失败'
  title.style.cssText = 'font-size:22px;margin:0 0 12px;'
  const message = document.createElement('p')
  message.textContent = '当前版本无法连接本地服务，请更新或重新安装 infohub 后再试。错误代码：PRELOAD_BRIDGE_MISSING'
  panel.append(title, message)
  root.replaceChildren(panel)
}

async function bootstrap(): Promise<void> {
  if (!window.api?.account?.list) {
    showBridgeError()
    return
  }
  const { default: App } = await import('./App.vue')
  createApp(App).mount('#app')
}

void bootstrap()

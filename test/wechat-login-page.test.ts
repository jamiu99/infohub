import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { buildWechatQrLoginScript, isWechatLoginUrl } from '../src/main/wechat-login-page'

test('登录导航只允许微信公众平台 HTTPS 页面', () => {
  assert.equal(isWechatLoginUrl('https://mp.weixin.qq.com/'), true)
  assert.equal(isWechatLoginUrl('https://mp.weixin.qq.com/cgi-bin/home?token=1'), true)
  assert.equal(isWechatLoginUrl('http://mp.weixin.qq.com/'), false)
  assert.equal(isWechatLoginUrl('https://mp.weixin.qq.com.evil.test/'), false)
  assert.equal(isWechatLoginUrl('javascript:alert(1)'), false)
})

test('登录页辅助脚本切换账号登录和快捷登录，直到传统二维码出现', async () => {
  const clicks: string[] = []
  const accountPanel = { display: 'block' }
  const qr = {
    display: 'block',
    currentSrc: '',
    complete: true,
    naturalWidth: 256,
    getAttribute: () => qr.currentSrc
  }
  const scanSwitch = {
    click: () => {
      clicks.push('mode')
      accountPanel.display = 'none'
    }
  }
  const fallback = {
    textContent: '扫码登录',
    click: () => {
      clicks.push('fallback')
      qr.currentSrc = 'https://mp.weixin.qq.com/cgi-bin/scanloginqrcode?action=getqrcode'
    }
  }
  const document = {
    querySelector: (selector: string) => {
      if (selector === '.login__type__container__account') return accountPanel
      if (selector === '.login__type__container__select-type__scan') return scanSwitch
      if (selector === '.login__type__container__scan__qrcode') return qr
      return null
    },
    querySelectorAll: (selector: string) => {
      if (selector === '.login__type__container__scan a') return [fallback]
      return []
    }
  }
  const result = (await runInNewContext(buildWechatQrLoginScript(), {
    document,
    getComputedStyle: (element: { display?: string }) => ({
      display: element.display ?? 'block',
      visibility: 'visible',
      opacity: '1'
    }),
    setTimeout: (fn: () => void) => queueMicrotask(fn)
  })) as { state: string }

  assert.deepEqual(clicks, ['mode', 'fallback'])
  assert.equal(result.state, 'ready')
})

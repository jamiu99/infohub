import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UpdateController, type UpdatePort, type UpdateUi } from '../src/main/update-controller'
import type { UpdateStatus } from '../src/shared/ipc'

function fixture(options: { download?: boolean; install?: boolean } = {}): {
  controller: UpdateController
  calls: string[]
  statuses: UpdateStatus[]
} {
  const calls: string[] = []
  const statuses: UpdateStatus[] = []
  const port: UpdatePort = {
    check: async () => void calls.push('check'),
    download: async () => void calls.push('download'),
    install: () => void calls.push('install')
  }
  const ui: UpdateUi = {
    status: (value) => statuses.push(value),
    progress: (value) => void calls.push(`progress:${value}`),
    confirmDownload: async () => {
      calls.push('confirm-download')
      return options.download ?? false
    },
    confirmInstall: async () => {
      calls.push('confirm-install')
      return options.install ?? false
    },
    showUpToDate: async () => void calls.push('up-to-date'),
    showBusy: async (phase) => void calls.push(`busy:${phase}`),
    showError: async () => void calls.push('error')
  }
  return { controller: new UpdateController(port, ui, '1.0.0'), calls, statuses }
}

test('手动检查无新版时显示当前已是最新', async () => {
  const { controller, calls, statuses } = fixture()
  await controller.check(true)
  await controller.none()
  assert.deepEqual(calls, ['check', 'up-to-date'])
  assert.equal(statuses.at(-1)?.state, 'none')
})

test('后台发现新版后先询问，拒绝时不下载', async () => {
  const { controller, calls } = fixture({ download: false })
  await controller.check(false)
  await controller.available('1.1.0')
  assert.deepEqual(calls, ['check', 'confirm-download'])
})

test('确认更新后下载，完成后确认重启并安装', async () => {
  const { controller, calls, statuses } = fixture({ download: true, install: true })
  await controller.check(false)
  await controller.available('1.1.0')
  controller.progress(48.6)
  await controller.downloaded('1.1.0')
  assert.deepEqual(calls, [
    'check',
    'confirm-download',
    'progress:0',
    'download',
    'progress:0.49',
    'progress:null',
    'confirm-install',
    'install'
  ])
  assert.deepEqual(statuses.at(-1), { state: 'ready', version: '1.1.0' })
})

test('已下载但选择稍后时，再次检查会重新询问安装', async () => {
  const { controller, calls } = fixture({ download: true, install: false })
  await controller.available('1.1.0')
  await controller.downloaded('1.1.0')
  await controller.check(true)
  assert.equal(calls.filter((value) => value === 'confirm-install').length, 2)
  assert.equal(calls.includes('install'), false)
})

test('后台检查失败只广播错误，手动检查失败才弹窗', async () => {
  const background = fixture()
  await background.controller.check(false)
  await background.controller.failed(new Error('offline'))
  assert.equal(background.calls.includes('error'), false)

  const manual = fixture()
  await manual.controller.check(true)
  await manual.controller.failed(new Error('offline'))
  assert.equal(manual.calls.includes('error'), true)
})

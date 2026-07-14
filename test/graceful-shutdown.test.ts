import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GracefulShutdownCoordinator } from '../src/main/graceful-shutdown'

test('并发退出来源只执行一次收尾，完成前不允许 Electron 退出', async () => {
  let calls = 0
  let release!: () => void
  const shutdown = new GracefulShutdownCoordinator(async () => {
    calls++
    await new Promise<void>((resolve) => { release = resolve })
  })

  const first = shutdown.prepareAndAllowQuit()
  const second = shutdown.prepareAndAllowQuit()
  await Promise.resolve()
  assert.equal(calls, 1)
  assert.equal(shutdown.isQuitAllowed(), false)
  release()
  await Promise.all([first, second])
  assert.equal(shutdown.isQuitAllowed(), true)
})

test('收尾失败不会放行，后续退出可以重新尝试', async () => {
  let calls = 0
  const shutdown = new GracefulShutdownCoordinator(async () => {
    calls++
    if (calls === 1) throw new Error('temporary failure')
  })

  await assert.rejects(shutdown.prepareAndAllowQuit(), /temporary failure/)
  assert.equal(shutdown.isQuitAllowed(), false)
  await shutdown.prepareAndAllowQuit()
  assert.equal(calls, 2)
  assert.equal(shutdown.isQuitAllowed(), true)
})

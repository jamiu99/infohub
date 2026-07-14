import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AutoCollectScheduler } from '../src/core/collect/auto-collect-scheduler.ts'

interface TimerTask {
  at: number
  callback: () => void
  cancelled: boolean
}

class FakeTimers {
  now = 0
  private nextId = 1
  private tasks = new Map<number, TimerTask>()

  setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++
    this.tasks.set(id, { at: this.now + delayMs, callback, cancelled: false })
    return id
  }

  clearTimer = (handle: unknown): void => {
    const task = this.tasks.get(handle as number)
    if (task) task.cancelled = true
  }

  activeCount(): number {
    return [...this.tasks.values()].filter((task) => !task.cancelled).length
  }

  firstActiveId(): number | undefined {
    return [...this.tasks.entries()].find(([, task]) => !task.cancelled)?.[0]
  }

  advance(ms: number): void {
    this.now += ms
    const due = [...this.tasks.entries()]
      .filter(([, task]) => !task.cancelled && task.at <= this.now)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
    for (const [id, task] of due) {
      this.tasks.delete(id)
      task.callback()
    }
  }

  invokeEvenIfCancelled(id: number): void {
    this.tasks.get(id)?.callback()
  }
}

async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('默认关闭不创建定时器；启用后等待完整周期而不是立即运行', () => {
  const timers = new FakeTimers()
  let runs = 0
  const scheduler = new AutoCollectScheduler({
    run: () => {
      runs++
    },
    now: () => timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  })

  scheduler.configure({ enabled: false, intervalMs: 100 })
  assert.equal(timers.activeCount(), 0)
  assert.equal(scheduler.nextRunAt(), undefined)

  scheduler.configure({ enabled: true, intervalMs: 100 })
  assert.equal(runs, 0)
  assert.equal(timers.activeCount(), 1)
  assert.equal(scheduler.nextRunAt(), 100)
})

test('一轮完成后从完成时刻安排下一轮，不重叠也不追赶', async () => {
  const timers = new FakeTimers()
  const starts: number[] = []
  const scheduler = new AutoCollectScheduler({
    run: () => {
      starts.push(timers.now)
      timers.now += 25
    },
    now: () => timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  })

  scheduler.configure({ enabled: true, intervalMs: 100 })
  timers.advance(100)
  await flushAsync()

  assert.deepEqual(starts, [100])
  assert.equal(timers.activeCount(), 1)
  assert.equal(scheduler.nextRunAt(), 225)
})

test('外部批次忙时跳过本轮且不排队', async () => {
  const timers = new FakeTimers()
  const skipped: string[] = []
  let runs = 0
  const scheduler = new AutoCollectScheduler({
    run: () => {
      runs++
    },
    isBusy: () => true,
    now: () => timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onSkipped: (reason) => skipped.push(reason)
  })

  scheduler.configure({ enabled: true, intervalMs: 100 })
  timers.advance(100)
  await flushAsync()

  assert.equal(runs, 0)
  assert.deepEqual(skipped, ['busy'])
  assert.equal(scheduler.nextRunAt(), 200)
  assert.equal(timers.activeCount(), 1)
})

test('迟到的定时器视为睡眠错过，不在唤醒时补跑', async () => {
  const timers = new FakeTimers()
  const skipped: string[] = []
  let runs = 0
  const scheduler = new AutoCollectScheduler({
    run: () => {
      runs++
    },
    now: () => timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    maxLatenessMs: 10,
    onSkipped: (reason) => skipped.push(reason)
  })

  scheduler.configure({ enabled: true, intervalMs: 100 })
  timers.advance(200)
  await flushAsync()

  assert.equal(runs, 0)
  assert.deepEqual(skipped, ['late'])
  assert.equal(scheduler.nextRunAt(), 300)
})

test('resume 放弃旧计划并从当前时间重新等待完整周期', async () => {
  const timers = new FakeTimers()
  let runs = 0
  const scheduler = new AutoCollectScheduler({
    run: () => {
      runs++
    },
    now: () => timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  })

  scheduler.configure({ enabled: true, intervalMs: 100 })
  timers.now = 1_000
  scheduler.resume()
  assert.equal(runs, 0)
  assert.equal(timers.activeCount(), 1)
  assert.equal(scheduler.nextRunAt(), 1_100)

  timers.advance(100)
  await flushAsync()
  assert.equal(runs, 1)
})

test('generation 阻止已取消的旧回调覆盖新计划', async () => {
  const timers = new FakeTimers()
  let runs = 0
  const scheduler = new AutoCollectScheduler({
    run: () => {
      runs++
    },
    now: () => timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  })

  scheduler.configure({ enabled: true, intervalMs: 100 })
  const oldTimer = timers.firstActiveId()!
  scheduler.configure({ enabled: true, intervalMs: 250 })
  timers.invokeEvenIfCancelled(oldTimer)
  await flushAsync()

  assert.equal(runs, 0)
  assert.equal(timers.activeCount(), 1)
  assert.equal(scheduler.nextRunAt(), 250)
})

test('stop 后在途任务完成也不会重新挂定时器', async () => {
  const timers = new FakeTimers()
  const hold = deferred()
  const scheduler = new AutoCollectScheduler({
    run: () => hold.promise,
    now: () => timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  })

  scheduler.configure({ enabled: true, intervalMs: 100 })
  timers.advance(100)
  await flushAsync()
  assert.equal(scheduler.isRunning(), true)

  scheduler.stop()
  hold.resolve()
  await flushAsync()

  assert.equal(scheduler.isRunning(), false)
  assert.equal(scheduler.nextRunAt(), undefined)
  assert.equal(timers.activeCount(), 0)
})

test('run 抛错后报告错误并继续安排下一轮', async () => {
  const timers = new FakeTimers()
  const errors: unknown[] = []
  const scheduler = new AutoCollectScheduler({
    run: () => {
      throw new Error('probe')
    },
    now: () => timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: (error) => errors.push(error)
  })

  scheduler.configure({ enabled: true, intervalMs: 100 })
  timers.advance(100)
  await flushAsync()

  assert.equal((errors[0] as Error).message, 'probe')
  assert.equal(scheduler.nextRunAt(), 200)
  assert.equal(timers.activeCount(), 1)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userFacingError } from '../src/shared/errors'

test('把 AbortSignal 超时异常转换成清晰中文', () => {
  assert.equal(
    userFacingError(new Error('The operation was aborted due to timeout'), '团队同步失败'),
    '请求超时：目标服务在规定时间内没有响应。请检查网络连接和服务地址后重试。'
  )
})

test('去掉 Electron IPC 前缀并保留中文业务说明', () => {
  assert.equal(
    userFacingError(
      "Error invoking remote method 'team:join': Error: 团队服务器实例已变化，请退出后重新加入",
      '加入团队失败'
    ),
    '团队服务器实例已变化，请退出后重新加入'
  )
})

test('未知英文异常不直接暴露到界面', () => {
  assert.equal(
    userFacingError(new Error('unexpected low-level failure'), '文章加载失败'),
    '文章加载失败。请重试；如果问题持续，请检查网络和服务状态。'
  )
})

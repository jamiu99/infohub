// Agent CLI 纯逻辑测试：stream-json 解析 + Windows→WSL 路径映射。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStreamLine, winToWslPath } from '../src/main/agent-cli'

test('parseStreamLine 解析 result 事件', () => {
  const ev = parseStreamLine(JSON.stringify({ type: 'result', result: '答案' }))
  assert.equal(ev?.type, 'result')
  assert.equal(ev?.text, '答案')
})

test('parseStreamLine 解析 assistant 文本块', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '你好' }, { type: 'tool_use' }] }
  })
  const ev = parseStreamLine(line)
  assert.equal(ev?.type, 'assistant')
  assert.equal(ev?.text, '你好')
})

test('parseStreamLine 非 JSON 返回 null', () => {
  assert.equal(parseStreamLine('not json'), null)
})

test('winToWslPath 映射盘符路径', () => {
  assert.equal(winToWslPath('C:\\Users\\jamiu\\data'), '/mnt/c/Users/jamiu/data')
  assert.equal(winToWslPath('/home/jamiu'), '/home/jamiu') // 非 Windows 路径原样返回
})

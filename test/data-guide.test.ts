import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makePaths } from '../src/core/paths'
import { ensureDataGuide } from '../src/main/data-guide'

test('数据目录说明只暴露文件/索引接口，不绑定具体 AI 工具', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-guide-'))
  try {
    const paths = makePaths(dir)
    ensureDataGuide(paths)
    const guide = readFileSync(paths.guide, 'utf8')
    assert.match(guide, /articles/)
    assert.match(guide, /index\.sqlite/)
    assert.match(guide, /team\/.*内部同步状态/)
    assert.match(guide, /secrets\/.*不应读取/)
    assert.match(guide, /不调用模型/)
    assert.doesNotMatch(guide, /Claude|Codex|SKILL\.md/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

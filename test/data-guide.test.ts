import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makePaths } from '../src/core/paths'
import { ensureDataGuide } from '../src/main/data-guide'
import { createLibraryManifest } from '../src/main/data-manifest'

const LIBRARY_ID = '11111111-1111-4111-8111-111111111111'

test('数据目录说明只暴露文件/索引接口，不绑定具体 AI 工具', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-guide-'))
  try {
    const paths = makePaths(dir)
    createLibraryManifest(dir, { libraryId: LIBRARY_ID, now: () => 123 })
    const manifestBeforeGuide = readFileSync(paths.manifest, 'utf8')
    ensureDataGuide(paths)
    ensureDataGuide(paths)
    const guide = readFileSync(paths.guide, 'utf8')
    assert.match(guide, /articles/)
    assert.match(guide, /\.content\.html/)
    assert.match(guide, /\.page\.html/)
    assert.match(guide, /content\.contentHtmlPath/)
    assert.match(guide, /index\.sqlite/)
    assert.match(guide, /outputs\/&lt;producer&gt;/)
    assert.match(guide, /raw\/.*不得修改/)
    assert.match(guide, /只读 <code>articles\//)
    assert.match(guide, /不调用模型/)
    assert.doesNotMatch(guide, /settings\.json|team\/|secrets\//)
    assert.doesNotMatch(guide, /Claude|Codex|SKILL\.md/i)
    assert.equal(existsSync(paths.outputs), true)
    assert.equal(readFileSync(paths.manifest, 'utf8'), manifestBeforeGuide)
    assert.deepEqual(JSON.parse(readFileSync(paths.manifest, 'utf8')), {
      schemaVersion: 1,
      kind: 'infohub-library',
      libraryId: LIBRARY_ID,
      createdAt: 123,
      managed: ['articles', 'raw', 'sources.json', 'index.sqlite'],
      externalOutputs: 'outputs',
      guide: 'INFOHUB_DATA.md'
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

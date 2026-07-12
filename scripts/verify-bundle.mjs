import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const preloadPath = resolve(root, 'out/preload/index.cjs')
const staleEsmPath = resolve(root, 'out/preload/index.mjs')
const mainPath = resolve(root, 'out/main/index.js')

assert.ok(existsSync(preloadPath), 'sandbox preload bundle out/preload/index.cjs is missing')
assert.ok(!existsSync(staleEsmPath), 'stale ESM preload bundle must not be packaged')

const preload = readFileSync(preloadPath, 'utf8')
assert.match(preload, /require\(["']electron["']\)/, 'preload must use sandbox-compatible CommonJS')
assert.doesNotMatch(preload, /^\s*import\s/m, 'sandbox preload must not contain ESM imports')

const main = readFileSync(mainPath, 'utf8')
assert.match(main, /\.\.\/preload\/index\.cjs/, 'BrowserWindow must load the CommonJS preload bundle')

console.log('Desktop bundle contract OK: sandbox + CommonJS preload')

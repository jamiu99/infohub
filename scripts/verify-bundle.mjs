import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const preloadPath = resolve(root, 'out/preload/index.cjs')
const staleEsmPath = resolve(root, 'out/preload/index.mjs')
const mainPath = resolve(root, 'out/main/index.js')
const builderConfigPath = resolve(root, 'electron-builder.yml')
const logoPath = resolve(root, 'resources/branding/infohub-icon-v1.png')

assert.ok(existsSync(preloadPath), 'sandbox preload bundle out/preload/index.cjs is missing')
assert.ok(!existsSync(staleEsmPath), 'stale ESM preload bundle must not be packaged')

const preload = readFileSync(preloadPath, 'utf8')
assert.match(preload, /require\(["']electron["']\)/, 'preload must use sandbox-compatible CommonJS')
assert.doesNotMatch(preload, /^\s*import\s/m, 'sandbox preload must not contain ESM imports')

const main = readFileSync(mainPath, 'utf8')
assert.match(main, /\.\.\/preload\/index\.cjs/, 'BrowserWindow must load the CommonJS preload bundle')

assert.ok(existsSync(logoPath), 'Windows branding source PNG is missing')
const logo = readFileSync(logoPath)
assert.deepEqual(
  [...logo.subarray(0, 8)],
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'Windows branding source must be a PNG'
)
const logoWidth = logo.readUInt32BE(16)
const logoHeight = logo.readUInt32BE(20)
assert.equal(logoWidth, logoHeight, 'Windows branding source must be square')
assert.ok(logoWidth >= 512, 'Windows branding source must be at least 512x512')
assert.equal(logo[25], 6, 'Windows branding source must be RGBA with a transparent background')

const builderConfig = readFileSync(builderConfigPath, 'utf8')
assert.match(
  builderConfig,
  /^\s*buildResources:\s*resources\/branding\s*$/m,
  'electron-builder must resolve branding assets from resources/branding'
)
assert.match(
  builderConfig,
  /^\s*icon:\s*infohub-icon-v1\.png\s*$/m,
  'Windows application icon must use the checked-in infohub logo'
)

console.log(
  `Desktop bundle contract OK: sandbox + CommonJS preload + ${logoWidth}x${logoHeight} Windows logo`
)

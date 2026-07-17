/**
 * Patches @whiskeysockets/baileys 7.0.0-rc.9 for three known bugs.
 * Runs as a postinstall script — safe to re-run.
 *
 * 1. passive: true → false  (causes device_removed disconnect)
 * 2. delete lidDbMigrated    (unrecognized field, rejected by WA)
 * 3. remove await on noise.finishInit()  (race condition)
 *
 * NOTE: The WA Web version is intentionally NOT patched here anymore.
 * server.ts calls fetchLatestBaileysVersion() at runtime, so the version
 * stays current automatically and never goes stale (was causing 405).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const baileys = join(__dirname, 'node_modules', '@whiskeysockets', 'baileys', 'lib')

function patch(file, find, replace, label) {
  const path = join(baileys, file)
  if (!existsSync(path)) {
    console.log(`  skip: ${file} not found`)
    return
  }
  let src = readFileSync(path, 'utf8')
  if (!src.includes(find)) {
    if (src.includes(replace)) {
      console.log(`  ok: ${label} (already patched)`)
    } else {
      console.log(`  warn: ${label} — pattern not found, may need manual review`)
    }
    return
  }
  src = src.replace(find, replace)
  writeFileSync(path, src)
  console.log(`  patched: ${label}`)
}

console.log('patching baileys rc.9...')

// Patch 1: passive: true → passive: false
patch(
  'Utils/validate-connection.js',
  'passive: true',
  'passive: false',
  'passive flag'
)

// Patch 2: remove lidDbMigrated: false
patch(
  'Utils/validate-connection.js',
  'lidDbMigrated: false',
  '/* lidDbMigrated removed */',
  'lidDbMigrated'
)

// Patch 3: remove await on noise.finishInit()
patch(
  'Socket/socket.js',
  'await noise.finishInit()',
  'noise.finishInit()',
  'noise.finishInit race condition'
)

console.log('done.')

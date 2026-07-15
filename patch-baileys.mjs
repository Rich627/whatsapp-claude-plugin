/**
 * Patches @whiskeysockets/baileys 7.0.0-rc.9 for three known bugs.
 * Runs as a postinstall script — safe to re-run.
 *
 * 1. passive: true → false  (causes device_removed disconnect)
 * 2. delete lidDbMigrated    (unrecognized field, rejected by WA)
 * 3. remove await on noise.finishInit()  (race condition)
 * 4. update WA Web version (old version rejected with 405)
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

// Patch 4: update WA Web version (405 fix)
//
// WA rejects builds it considers too old with a 405 "Connection Failure" during
// the handshake, before any QR or pairing code can be registered — so a stale
// value here surfaces as "couldn't link device" on the phone, not as a version
// error. Matching on the build number by regex rather than by a hardcoded old
// value keeps this working whatever rc.9 ships, and makes a bump a one-line
// change to WA_VERSION below.
//
// Current value from Baileys' own source of truth:
//   https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json
const WA_VERSION = '1035194821'

function patchVersion(file, label) {
  const path = join(baileys, file)
  if (!existsSync(path)) {
    console.log(`  skip: ${file} not found`)
    return
  }
  const src = readFileSync(path, 'utf8')
  // `[2, 3000, <build>]` — the only shape the version literal takes in rc.9
  const re = /(\[\s*2\s*,\s*3000\s*,\s*)(\d{9,})(\s*\])/
  const found = src.match(re)
  if (!found) {
    console.log(`  warn: ${label} — version literal not found, may need manual review`)
    return
  }
  if (found[2] === WA_VERSION) {
    console.log(`  ok: ${label} (already ${WA_VERSION})`)
    return
  }
  writeFileSync(path, src.replace(re, `$1${WA_VERSION}$3`))
  console.log(`  patched: ${label} (${found[2]} -> ${WA_VERSION})`)
}

patchVersion('Defaults/index.js', 'WA Web version (Defaults)')
patchVersion('Utils/generics.js', 'WA Web version (generics)')

console.log('done.')

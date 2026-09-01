/**
 * Patches @whiskeysockets/baileys 7.0.0-rc.9 for three known bugs.
 * Runs as a postinstall script — safe to re-run.
 *
 * 1. passive: true → false  (causes device_removed disconnect)
 * 2. delete lidDbMigrated    (unrecognized field, rejected by WA)
 * 3. remove await on noise.finishInit()  (race condition)
 * 4. update WA Web version (old version rejected with 405)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const baileys = join(
  __dirname,
  "node_modules",
  "@whiskeysockets",
  "baileys",
  "lib",
);

// Set (non-zero exitCode) only when a patch target has genuinely vanished -
// i.e. neither the pre-patch nor the post-patch text is present, so we can't
// tell whether the fix is already in place. Re-running after a successful
// patch (or against an install that's already patched) always lands in the
// "already patched" branch below and never touches this - a fresh install
// must stay green.
let unapplied = 0;

function patch(file, find, replace, label) {
  const path = join(baileys, file);
  if (!existsSync(path)) {
    console.log(`  skip: ${file} not found`);
    return;
  }
  let src = readFileSync(path, "utf8");
  if (!src.includes(find)) {
    if (src.includes(replace)) {
      console.log(`  ok: ${label} (already patched)`);
    } else {
      console.log(
        `  ERROR: ${label} — pattern not found in ${file}; patch NOT applied (baileys version likely changed, needs manual review)`,
      );
      unapplied++;
    }
    return;
  }
  // replaceAll: some patch targets appear more than once in the file, and a
  // silent "only the first occurrence got patched" is exactly the kind of
  // invisible partial-patch this rework exists to prevent.
  src = src.replaceAll(find, replace);
  writeFileSync(path, src);
  console.log(`  patched: ${label}`);
}

console.log("patching baileys rc.9...");

// Patch 1: passive: true → passive: false
// Matched together with the following `pull: true,` line (not just
// "passive: true" alone): the same file also has an unrelated
// `passive: false` site (generateRegistrationNode) that would otherwise make
// the "already patched" check below indistinguishable from "target vanished"
// for this specific patch.
patch(
  "Utils/validate-connection.js",
  "passive: true,\n        pull: true,",
  "passive: false,\n        pull: true,",
  "passive flag",
);

// Patch 2: remove lidDbMigrated: false
patch(
  "Utils/validate-connection.js",
  "lidDbMigrated: false",
  "/* lidDbMigrated removed */",
  "lidDbMigrated",
);

// Patch 3: remove await on noise.finishInit()
patch(
  "Socket/socket.js",
  "await noise.finishInit()",
  "noise.finishInit()",
  "noise.finishInit race condition",
);

// Patch 4: update WA Web version (405 fix)
patch(
  "Defaults/index.js",
  "1027934701",
  "1034074495",
  "WA Web version (Defaults)",
);

patch(
  "Utils/generics.js",
  "1027934701",
  "1034074495",
  "WA Web version (generics)",
);

if (unapplied > 0) {
  console.error(
    [
      "",
      "=== patch-baileys: PATCH(ES) NOT APPLIED ===",
      `${unapplied} patch(es) above could not be applied - their target text was not found,`,
      "and the already-patched text wasn't found either. This most likely means",
      "@whiskeysockets/baileys was upgraded and patch-baileys.mjs needs updating for the",
      "new source. Running unpatched (e.g. without the passive:false device_removed fix)",
      "is a real outage risk - do not ignore this.",
      "==============================================",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}

console.log("done.");

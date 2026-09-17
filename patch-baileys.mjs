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

// WHITESPACE-TOLERANT TARGETS. The patch targets are source text, so an
// upstream reindent - or a line break moving - is a cosmetic change that
// carries no meaning. Matched literally, that read here as "target vanished",
// and once the exit code became load-bearing below it would have failed
// `bun install` for EVERY user over a reformat that broke nothing. Every run
// of whitespace in a target now matches any run of whitespace in the file;
// everything else is matched literally, so the targets stay as specific as
// they were. (Owner's call, 2026-09-09: tolerant matching, and the hard
// failure reserved for a target that is genuinely gone.)
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const flexible = (needle, flags) =>
  new RegExp(needle.trim().split(/\s+/).map(escapeRe).join("\\s+"), flags);

function patch(file, find, replace, label) {
  const path = join(baileys, file);
  if (!existsSync(path)) {
    // COUNTS AS UNAPPLIED, like the pattern-not-found case below. A missing
    // file is the LIKELIER form of a Baileys version bump - upstream renames
    // or moves a module - and it used to print `skip:` and exit 0, leaving
    // `bun install` green while the runtime ran completely unpatched. The
    // loud case was loud and the likely case was silent.
    console.log(
      `  ERROR: ${label} — ${file} not found; patch NOT applied (baileys layout likely changed, needs manual review)`,
    );
    unapplied++;
    return;
  }
  let src = readFileSync(path, "utf8");
  if (!flexible(find).test(src)) {
    if (flexible(replace).test(src)) {
      console.log(`  ok: ${label} (already patched)`);
    } else {
      // GENUINELY ABSENT: present in neither its pre- nor its post-patch
      // form, even allowing for reformatting. This is the case the hard exit
      // is for - we cannot tell whether the fix is in place, so the install
      // must not pass silently.
      console.log(
        `  ERROR: ${label} — target not found in ${file} in either form; patch NOT applied (baileys version likely changed, needs manual review)`,
      );
      unapplied++;
    }
    return;
  }
  // Global regex: some patch targets appear more than once in the file, and a
  // silent "only the first occurrence got patched" is exactly the kind of
  // invisible partial-patch this rework exists to prevent. The replacement is
  // a FUNCTION so that a `$` in the replacement text could never be read as a
  // substitution pattern.
  src = src.replace(flexible(find, "g"), () => replace);
  writeFileSync(path, src);
  console.log(`  patched: ${label}`);
}

console.log("patching baileys rc.9...");

// "NOT INSTALLED HERE" IS NOT "TARGET VANISHED", and the whole rework turns on
// that distinction. Without this check a hoisted or absent
// node_modules/@whiskeysockets/baileys makes all five patches take the
// missing-file branch, and the install fails with five identical "layout
// likely changed, needs manual review" lines - none of which is the actual
// condition. Exit 0: nothing is unpatched, because there is nothing here to
// patch, and a workspace that hoists its dependencies elsewhere must not fail
// its install over where this script happened to look.
if (!existsSync(baileys)) {
  console.log(`  skip: no baileys at ${baileys} (nothing to patch here)`);
  process.exit(0);
}

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

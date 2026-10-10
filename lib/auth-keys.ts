// useMultiFileAuthState stores each app-state sync key as
// `app-state-sync-key-<base64 id>.json`. Base64 is case-sensitive; NTFS and
// APFS are not, so two ids differing only in case share one file and the
// later key overwrites the earlier. Baileys then decrypts that collection
// with the wrong key (BAD_DECRYPT - its MAC check is off by default), and the
// address book never syncs: measured 2026-10-06 on Windows, 51 key ids
// received, 42 distinct ignoring case, 42 files. Hex ids are case-proof.
//
// Reads fall back to the old base64 name so keys that never collided keep
// working; a key lost to a collision only comes back with a re-link.

import type { SignalKeyStore } from "@whiskeysockets/baileys";

const TYPE = "app-state-sync-key";
// Hex of the id's own characters, not of its base64-decoded bytes: decoding
// ignores invalid characters, so two different ids could share one file.
const hexId = (id: string) => "hex-" + Buffer.from(id).toString("hex");

export function caseSafeKeys(keys: SignalKeyStore): SignalKeyStore {
  return {
    ...keys,
    get: async (type, ids): Promise<any> => {
      if (type !== TYPE) return keys.get(type, ids);
      const byHex = await keys.get(type, ids.map(hexId));
      const missing = ids.filter((id) => !byHex[hexId(id)]);
      const legacy = missing.length ? await keys.get(type, missing) : {};
      return Object.fromEntries(
        ids.map((id) => [id, byHex[hexId(id)] ?? legacy[id]]),
      );
    },
    set: async (data) => {
      if (!data[TYPE]) return keys.set(data);
      const renamed = Object.fromEntries(
        Object.entries(data[TYPE]).map(([id, v]) => [hexId(id), v]),
      );
      return keys.set({ ...data, [TYPE]: renamed });
    },
  };
}

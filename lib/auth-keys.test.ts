import { expect, test } from "bun:test";
import { caseSafeKeys } from "./auth-keys";

// A store that ignores case in its keys, like files on NTFS.
function caseInsensitiveStore() {
  const files = new Map<string, any>();
  const name = (type: string, id: string) => `${type}-${id}`.toLowerCase();
  return {
    files,
    get: async (type: string, ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, files.get(name(type, id))])),
    set: async (data: Record<string, Record<string, any>>) => {
      for (const [type, byId] of Object.entries(data))
        for (const [id, v] of Object.entries(byId))
          if (v === null) files.delete(name(type, id));
          else files.set(name(type, id), v);
    },
  };
}

test("ids differing only in case keep separate app-state keys", async () => {
  const keys = caseSafeKeys(caseInsensitiveStore());
  await keys.set({
    "app-state-sync-key": { AAAAAKpT: "one", AAAAAKPT: "two" },
  });
  expect(
    await keys.get("app-state-sync-key", ["AAAAAKpT", "AAAAAKPT"]),
  ).toEqual({ AAAAAKpT: "one", AAAAAKPT: "two" });
});

test("a key stored under the old base64 name is still read", async () => {
  const store = caseInsensitiveStore();
  await store.set({ "app-state-sync-key": { AAAAAKpT: "old" } });
  const keys = caseSafeKeys(store);
  expect(
    await keys.get("app-state-sync-key", ["AAAAAKpT", "AAAAAXXX"]),
  ).toEqual({ AAAAAKpT: "old", AAAAAXXX: undefined });
});

test("other key types pass through unchanged", async () => {
  const store = caseInsensitiveStore();
  const keys = caseSafeKeys(store);
  await keys.set({ session: { "61400000000.0": "s" } });
  expect(store.files.get("session-61400000000.0")).toBe("s");
});

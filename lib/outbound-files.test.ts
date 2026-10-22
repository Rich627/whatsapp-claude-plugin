import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  truncateSync,
} from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { readSendableFile } from "./outbound-files";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wa-outbound-")));
  const outbox = join(root, "outbox");
  mkdirSync(outbox);
  const file = join(outbox, "share.txt");
  writeFileSync(file, "share");
  const validate = (path: string) => {
    const real = realpathSync(path);
    if (!real.startsWith(outbox + sep))
      throw new Error("outside export directory");
    return real;
  };
  return { root, outbox, file, validate };
}

test("snapshots ordinary export files and refuses oversized or non-regular files", () => {
  const f = fixture();
  try {
    expect(readSendableFile(f.file, f.validate).toString()).toBe("share");
    truncateSync(f.file, 16 * 1024 * 1024 + 1);
    expect(() => readSendableFile(f.file, f.validate)).toThrow("at most 16 MB");
    expect(() =>
      readSendableFile(f.outbox, (path) => realpathSync(path)),
    ).toThrow("regular file");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "rejects ancestor replacement between validation and descriptor opening",
  () => {
    const f = fixture();
    const blocked = join(f.root, "auth-fixture");
    mkdirSync(blocked);
    writeFileSync(join(blocked, "share.txt"), "SYNTHETIC_BLOCKED_STATE");
    let calls = 0;
    try {
      const validate = (path: string) => {
        if (++calls === 1) {
          const permitted = f.validate(path);
          renameSync(f.outbox, join(f.root, "saved-outbox"));
          symlinkSync(blocked, f.outbox);
          return permitted;
        }
        // Restore the directory after open: the canonical string is allowed again,
        // but the opened descriptor still names the blocked inode.
        unlinkSync(f.outbox);
        renameSync(join(f.root, "saved-outbox"), f.outbox);
        return f.validate(path);
      };
      expect(() => readSendableFile(f.file, validate)).toThrow(
        "path changed after opening",
      );
      expect(calls).toBe(2);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

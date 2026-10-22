import {
  openSync,
  closeSync,
  fstatSync,
  readSync,
  statSync,
  constants as fsConstants,
} from "node:fs";

const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

export function readSendableFile(
  f: string,
  assertSendable: (path: string) => string,
): Buffer {
  const real = assertSendable(f);
  const before = statSync(real);
  const fd = openSync(
    real,
    fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_ATTACHMENT_BYTES)
      throw new Error("Attachment must be a regular file of at most 16 MB");
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      assertSendable(real) !== real
    )
      throw new Error("Attachment changed while opening");
    const verified = statSync(real);
    if (opened.dev !== verified.dev || opened.ino !== verified.ino)
      throw new Error("Attachment path changed after opening");
    // Capture bounded bytes from this descriptor before any network await.
    const buffer = Buffer.alloc(opened.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > opened.size) throw new Error("Attachment grew while reading");
    return buffer.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

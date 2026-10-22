import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("provider status exposes registration without exposing credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-auth-status-"));
  try {
    mkdirSync(join(dir, ".baileys_auth"));
    const file = join(dir, ".baileys_auth", "creds.json");
    for (const [raw, expected] of [
      [null, "not paired"],
      [
        JSON.stringify({ registered: true, noiseKey: "SYNTHETIC_PRIVATE_KEY" }),
        "paired",
      ],
      [
        JSON.stringify({
          registered: "true",
          noiseKey: "SYNTHETIC_PRIVATE_KEY",
        }),
        "not paired",
      ],
      ["invalid SYNTHETIC_PRIVATE_KEY", "unavailable (invalid or unreadable)"],
    ] as const) {
      if (raw !== null) writeFileSync(file, raw);
      const child = spawnSync(
        "bun",
        [join(import.meta.dir, "provider.ts"), "status"],
        {
          env: {
            ...process.env,
            WHATSAPP_STATE_DIR: dir,
            WHATSAPP_PROVIDER: "baileys",
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(child.status).toBe(0);
      expect(child.stdout).toContain(`Linked-device auth: ${expected}`);
      expect(child.stdout + child.stderr).not.toContain(
        "SYNTHETIC_PRIVATE_KEY",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

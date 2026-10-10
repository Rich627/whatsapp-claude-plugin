import { describe, expect, test } from "bun:test";
import {
  channelProvider,
  parseStateEnv,
  stateEnvironment,
  updateStateEnv,
} from "./provider";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("provider configuration", () => {
  test("existing installs and empty plugin values retain Baileys", () => {
    expect(channelProvider({})).toBe("baileys");
    expect(channelProvider({ WHATSAPP_PROVIDER: "" })).toBe("baileys");
    expect(
      channelProvider({
        WHATSAPP_PROVIDER: "${user_config.connection_provider}",
      }),
    ).toBe("baileys");
    expect(() => channelProvider({ WHATSAPP_PROVIDER: "typo" })).toThrow();
  });
  test("saved settings survive empty plugin fields while real env wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-provider-"));
    try {
      const path = join(dir, ".env");
      writeFileSync(
        path,
        '\uFEFFWHATSAPP_PROVIDER="cloud-api"\r\nWHATSAPP_CLOUD_ACCESS_TOKEN=test-token\r\n',
      );
      const env = stateEnvironment(path, {
        WHATSAPP_PROVIDER: "",
        WHATSAPP_CLOUD_ACCESS_TOKEN: "override",
      });
      expect(channelProvider(env)).toBe("cloud-api");
      expect(env.WHATSAPP_CLOUD_ACCESS_TOKEN).toBe("override");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("switching preserves unrelated settings and removes duplicate provider keys", () => {
    const raw =
      "# Keep this\nWHATSAPP_PHONE_NUMBER=123456789\nWHATSAPP_PROVIDER=baileys\nWHATSAPP_PROVIDER=baileys\nOTHER=value\n";
    const result = updateStateEnv(raw, { WHATSAPP_PROVIDER: "cloud-api" });
    expect(result).toContain("# Keep this\nWHATSAPP_PHONE_NUMBER=123456789\n");
    expect(result).toContain("OTHER=value");
    expect(result.match(/WHATSAPP_PROVIDER=/g)).toHaveLength(1);
    expect(parseStateEnv(result).WHATSAPP_PROVIDER).toBe("cloud-api");
    expect(() =>
      updateStateEnv(raw, { WHATSAPP_PROVIDER: "cloud-api\nOTHER=injected" }),
    ).toThrow();
  });
});

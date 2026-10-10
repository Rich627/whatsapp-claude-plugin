import { readFileSync } from "node:fs";

export type ChannelProvider = "baileys" | "cloud-api";

export function configuredValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && !trimmed.startsWith("${") ? trimmed : undefined;
}

export function channelProvider(
  env: Record<string, string | undefined>,
): ChannelProvider {
  const value = configuredValue(env.WHATSAPP_PROVIDER) ?? "baileys";
  if (value === "baileys" || value === "cloud-api") return value;
  throw new Error("WHATSAPP_PROVIDER must be baileys or cloud-api");
}

export function parseStateEnv(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = line.match(/^(\w+)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

export function stateEnvironment(
  path: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  let saved: Record<string, string> = {};
  try {
    saved = parseStateEnv(readFileSync(path, "utf8"));
  } catch {}
  const result = { ...saved, ...env };
  // Empty plugin userConfig fields must not mask terminal-saved configuration.
  for (const key of Object.keys(saved)) {
    if (!configuredValue(env[key])) result[key] = saved[key];
  }
  return result;
}

export function updateStateEnv(
  raw: string,
  updates: Record<string, string>,
): string {
  for (const [key, value] of Object.entries(updates)) {
    if (!/^WHATSAPP_[A-Z0-9_]+$/.test(key) || /[\r\n\0]/.test(value)) {
      throw new Error("Invalid configuration field");
    }
  }
  const remaining = new Set(Object.keys(updates));
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  const output: string[] = [];
  for (const line of lines) {
    const key = line.match(/^(\w+)=/)?.[1];
    if (!key || !Object.hasOwn(updates, key)) {
      output.push(line);
      continue;
    }
    if (remaining.delete(key)) output.push(`${key}=${updates[key]}`);
  }
  while (output.at(-1) === "") output.pop();
  for (const key of remaining) output.push(`${key}=${updates[key]}`);
  return output.join("\n") + "\n";
}

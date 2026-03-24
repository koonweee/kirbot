import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function resolveCodexProfilesConfigPath(): string {
  const candidates = [
    resolve(process.cwd(), "config", "codex-profiles.json"),
    resolve(process.cwd(), "..", "config", "codex-profiles.json"),
    resolve(process.cwd(), "..", "..", "config", "codex-profiles.json"),
    resolve(__dirname, "..", "..", "..", "config", "codex-profiles.json"),
    resolve(__dirname, "..", "..", "..", "..", "config", "codex-profiles.json")
  ];

  for (const path of candidates) {
    if (!existsSync(path)) {
      continue;
    }

    return path;
  }

  throw new Error("Could not locate config/codex-profiles.json");
}

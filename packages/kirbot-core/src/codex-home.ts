import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SEEDED_CODEX_FILES = ["auth.json"] as const;
const SEEDED_CODEX_DIRECTORIES = ["rules", "skills", "superpowers"] as const;

export function resolveKirbotCodexHomePath(databasePath: string, explicitPath?: string): string {
  if (explicitPath) {
    return explicitPath;
  }

  return resolve(dirname(databasePath), "codex-home");
}

export function resolveKirbotCodexConfigPath(homePath: string): string {
  return join(homePath, "config.toml");
}

export function prepareKirbotCodexHome(options: {
  targetHomePath: string;
  sourceHomePath?: string;
}): void {
  const sourceHomePath = options.sourceHomePath ?? join(homedir(), ".codex");
  mkdirSync(options.targetHomePath, { recursive: true });

  for (const fileName of SEEDED_CODEX_FILES) {
    copyIntoIsolatedHomeIfPresent(join(sourceHomePath, fileName), join(options.targetHomePath, fileName));
  }

  for (const directoryName of SEEDED_CODEX_DIRECTORIES) {
    copyIntoIsolatedHomeIfPresent(
      join(sourceHomePath, directoryName),
      join(options.targetHomePath, directoryName)
    );
  }
}

function copyIntoIsolatedHomeIfPresent(sourcePath: string, targetPath: string): void {
  if (!existsSync(sourcePath) || existsSync(targetPath)) {
    return;
  }

  cpSync(sourcePath, targetPath, {
    recursive: true
  });
}

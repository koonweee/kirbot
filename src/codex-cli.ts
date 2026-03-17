import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const codexRequire = createRequire(__filename);

type CodexPackageJson = {
  bin?: string | Record<string, string>;
};

export type CodexCliInvocation = {
  command: string;
  args: string[];
};

export function resolvePinnedCodexExecutablePath(): string {
  const packageJsonPath = codexRequire.resolve("@openai/codex/package.json");
  const packageDir = dirname(packageJsonPath);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as CodexPackageJson;
  const binPath =
    typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.codex;

  if (!binPath) {
    throw new Error("Could not resolve the codex binary from @openai/codex/package.json");
  }

  const executablePath = resolve(packageDir, binPath);
  if (!existsSync(executablePath)) {
    throw new Error(`Pinned Codex binary does not exist at ${executablePath}`);
  }

  return executablePath;
}

export function resolvePinnedCodexInvocation(): CodexCliInvocation {
  const executablePath = resolvePinnedCodexExecutablePath();

  if (/\.(c|m)?js$/u.test(executablePath)) {
    return {
      command: process.execPath,
      args: [executablePath]
    };
  }

  return {
    command: executablePath,
    args: []
  };
}

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

export function resolvePinnedCodexExecutablePath() {
  const packageJsonPath = require.resolve("@openai/codex/package.json");
  const packageDir = dirname(packageJsonPath);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const binPath = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.codex;

  if (!binPath) {
    throw new Error("Could not resolve the codex binary from @openai/codex/package.json");
  }

  const executablePath = resolve(packageDir, binPath);
  if (!existsSync(executablePath)) {
    throw new Error(`Pinned Codex binary does not exist at ${executablePath}`);
  }

  return executablePath;
}

export function resolvePinnedCodexInvocation() {
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

export function generateCodexTypes(outDir) {
  const codex = resolvePinnedCodexInvocation();

  rmSync(outDir, { force: true, recursive: true });
  mkdirSync(dirname(outDir), { recursive: true });

  const result = spawnSync(codex.command, [...codex.args, "app-server", "generate-ts", "--out", outDir], {
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Codex type generation failed with exit code ${result.status ?? "unknown"}`);
  }
}

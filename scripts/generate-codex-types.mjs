import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const outDir = resolve("src/generated/codex");

rmSync(outDir, { force: true, recursive: true });
mkdirSync(dirname(outDir), { recursive: true });

execFileSync("codex", ["app-server", "generate-ts", "--out", outDir], {
  stdio: "inherit"
});

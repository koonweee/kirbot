import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const sourceDir = resolve("src/mini-app/static");
const targetDir = resolve("dist/src/mini-app/static");

if (!existsSync(sourceDir)) {
  process.exit(0);
}

mkdirSync(dirname(targetDir), { recursive: true });
cpSync(sourceDir, targetDir, {
  recursive: true
});

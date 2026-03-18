import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { generateCodexTypes } from "./codex-cli.mjs";

const expectedDir = resolve("packages/codex-client/src/generated/codex");
const tempRoot = mkdtempSync(join(tmpdir(), "kirbot-codex-types-"));
const actualDir = join(tempRoot, "generated", "codex");

try {
  generateCodexTypes(actualDir);
  const differences = compareTrees(expectedDir, actualDir);

  if (differences.length > 0) {
    console.error("Committed Codex bindings drifted from the pinned @openai/codex version:");
    for (const difference of differences) {
      console.error(`- ${difference}`);
    }
    process.exit(1);
  }
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}

function compareTrees(expectedRoot, actualRoot) {
  const expectedFiles = listRelativeFiles(expectedRoot);
  const actualFiles = listRelativeFiles(actualRoot);
  const differences = [];

  for (const path of expectedFiles) {
    if (!actualFiles.has(path)) {
      differences.push(`missing from generated output: ${path}`);
      continue;
    }

    const expectedContents = readFileSync(join(expectedRoot, path), "utf8");
    const actualContents = readFileSync(join(actualRoot, path), "utf8");
    if (expectedContents !== actualContents) {
      differences.push(`content differs: ${path}`);
    }
  }

  for (const path of actualFiles) {
    if (!expectedFiles.has(path)) {
      differences.push(`unexpected generated file: ${path}`);
    }
  }

  return differences.sort();
}

function listRelativeFiles(root) {
  const files = new Set();
  walk(root, root, files);
  return files;
}

function walk(root, currentDir, output) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const entryPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walk(root, entryPath, output);
      continue;
    }

    output.add(relative(root, entryPath));
  }
}

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const vitestEntrypoint = require.resolve("vitest/vitest.mjs");
const env = { ...process.env };

// Node's watch mode sets this so child processes can report watched imports.
// Vitest's tinypool workers also use process.send(), so the inherited flag makes
// the worker emit watch-mode IPC that Vitest does not understand.
delete env.WATCH_REPORT_DEPENDENCIES;

const child = spawn(process.execPath, [vitestEntrypoint, ...process.argv.slice(2)], {
  stdio: "inherit",
  env
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

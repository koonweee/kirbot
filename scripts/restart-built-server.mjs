import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const tmpDir = resolve(repoRoot, ".tmp");
const pidFilePath = resolve(tmpDir, "kirbot.pid");
const stdoutLogPath = resolve(tmpDir, "kirbot.stdout.log");
const stderrLogPath = resolve(tmpDir, "kirbot.stderr.log");
const distEntrypointPath = resolve(repoRoot, "dist/index.js");
const shutdownTimeoutMs = 5_000;

async function main() {
  if (process.argv.includes("--help")) {
    printHelp();
    return;
  }

  mkdirSync(tmpDir, { recursive: true });

  await stopExistingServer();
  runBuild();
  startServer();
}

function printHelp() {
  console.log("Usage: npm run restart");
  console.log("");
  console.log("Stops the previously started built kirbot process, rebuilds dist/, and");
  console.log("starts a fresh detached process with stdout/stderr written into .tmp/.");
}

async function stopExistingServer() {
  if (!existsSync(pidFilePath)) {
    return;
  }

  const pid = readPidFile();
  if (pid === null) {
    rmSync(pidFilePath, { force: true });
    return;
  }

  if (!isProcessRunning(pid)) {
    rmSync(pidFilePath, { force: true });
    return;
  }

  if (!isKirbotProcess(pid)) {
    throw new Error(
      `Refusing to stop pid ${pid}: ${pidFilePath} does not appear to point at a kirbot process started from ${repoRoot}`
    );
  }

  console.log(`Stopping existing kirbot process ${pid}`);
  sendSignal(pid, "SIGTERM");
  const stoppedGracefully = await waitForExit(pid, shutdownTimeoutMs);
  if (!stoppedGracefully) {
    console.warn(`Process ${pid} did not exit after ${shutdownTimeoutMs}ms, forcing shutdown`);
    sendSignal(pid, "SIGKILL");
    await waitForExit(pid, shutdownTimeoutMs);
  }

  rmSync(pidFilePath, { force: true });
}

function readPidFile() {
  const raw = readFileSync(pidFilePath, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false;
    }

    throw error;
  }
}

function isKirbotProcess(pid) {
  const cmdlinePath = `/proc/${pid}/cmdline`;
  if (!existsSync(cmdlinePath)) {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    if (result.status !== 0) {
      return false;
    }

    const command = result.stdout.trim();
    return command.includes(distEntrypointPath) || command.includes(resolve(repoRoot, "dist", "index.js"));
  }

  const cmdline = readFileSync(cmdlinePath, "utf8");
  return cmdline.includes(distEntrypointPath) || cmdline.includes(resolve(repoRoot, "dist", "index.js"));
}

function sendSignal(pid, signal) {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
      return;
    }
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
    return;
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}

async function waitForExit(pid, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return true;
    }

    await sleep(200);
  }

  return !isProcessRunning(pid);
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function runBuild() {
  console.log("Building kirbot");

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function startServer() {
  if (!existsSync(distEntrypointPath)) {
    console.error(`Built entrypoint not found at ${distEntrypointPath}`);
    process.exit(1);
  }

  const stdoutFd = openSync(stdoutLogPath, "a");
  const stderrFd = openSync(stderrLogPath, "a");

  try {
    const child = spawn(process.execPath, ["--enable-source-maps", distEntrypointPath], {
      cwd: repoRoot,
      env: process.env,
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd]
    });

    child.unref();
    writeFileSync(pidFilePath, `${child.pid}\n`);
    console.log(`Started kirbot process ${child.pid}`);
    console.log(`stdout: ${stdoutLogPath}`);
    console.log(`stderr: ${stderrLogPath}`);
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

function isMissingProcessError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

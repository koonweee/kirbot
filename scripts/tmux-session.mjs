import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

export const repoRoot = resolve(dirname(scriptPath), "..");
export const tmuxTargets = {
  dev: {
    sessionName: "kirbot-dev",
    npmScript: "dev",
    description: "Detached kirbot dev process with automatic restarts."
  },
  start: {
    sessionName: "kirbot-prod",
    npmScript: "start",
    description: "Detached kirbot production process from the built start command."
  }
};

const validActions = new Set(["ensure", "attach", "restart"]);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

export function getTarget(targetName) {
  const target = tmuxTargets[targetName];
  if (!target) {
    throw new Error(`Unknown tmux target "${targetName}". Expected one of: ${Object.keys(tmuxTargets).join(", ")}`);
  }

  return target;
}

export function buildSessionCommand(targetName) {
  return `${npmCommand} run ${getTarget(targetName).npmScript}`;
}

export function buildNewSessionArgs(targetName) {
  const target = getTarget(targetName);
  return ["new-session", "-d", "-s", target.sessionName, "-c", repoRoot, buildSessionCommand(targetName)];
}

export function buildRemainOnExitArgs(targetName) {
  return ["set-option", "-t", getTarget(targetName).sessionName, "remain-on-exit", "on"];
}

export function buildAttachArgs(targetName, insideTmux) {
  return [insideTmux ? "switch-client" : "attach-session", "-t", getTarget(targetName).sessionName];
}

export function buildRestartArgs(targetName) {
  return [
    "respawn-pane",
    "-k",
    "-t",
    `${getTarget(targetName).sessionName}:0.0`,
    "-c",
    repoRoot,
    buildSessionCommand(targetName)
  ];
}

export function buildClearHistoryArgs(targetName) {
  return ["clear-history", "-t", `${getTarget(targetName).sessionName}:0.0`];
}

function printHelp() {
  console.log("Usage: node scripts/tmux-session.mjs <ensure|attach|restart> <dev|start>");
  console.log("");
  console.log("Targets:");
  for (const [targetName, target] of Object.entries(tmuxTargets)) {
    console.log(`- ${targetName}: ${target.description} Session: ${target.sessionName}`);
  }
}

function sessionExists(targetName) {
  const result = spawnSync("tmux", ["has-session", "-t", getTarget(targetName).sessionName], {
    cwd: repoRoot,
    stdio: "ignore"
  });

  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") {
      throw new Error("tmux is required for detached kirbot sessions but is not installed.");
    }

    throw result.error;
  }

  return result.status === 0;
}

function runTmux(args, options = {}) {
  const result = spawnSync("tmux", args, {
    cwd: repoRoot,
    stdio: options.stdio ?? "pipe",
    encoding: "utf8"
  });

  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") {
      throw new Error("tmux is required for detached kirbot sessions but is not installed.");
    }

    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(stderr || `tmux ${args[0]} failed with exit code ${result.status ?? 1}`);
  }

  return result;
}

function ensureSession(targetName) {
  const target = getTarget(targetName);
  if (sessionExists(targetName)) {
    console.log(`tmux session ${target.sessionName} already exists.`);
    return;
  }

  runTmux(buildNewSessionArgs(targetName));
  runTmux(buildRemainOnExitArgs(targetName));
  console.log(`Started detached tmux session ${target.sessionName} (${buildSessionCommand(targetName)}).`);
}

function attachSession(targetName) {
  const target = getTarget(targetName);
  if (!sessionExists(targetName)) {
    throw new Error(`tmux session ${target.sessionName} does not exist. Start it first with ensure.`);
  }

  runTmux(buildAttachArgs(targetName, Boolean(process.env.TMUX)), { stdio: "inherit" });
}

function restartSession(targetName) {
  const target = getTarget(targetName);
  if (!sessionExists(targetName)) {
    ensureSession(targetName);
    return;
  }

  runTmux(buildClearHistoryArgs(targetName));
  runTmux(buildRestartArgs(targetName));
  console.log(`Restarted tmux session ${target.sessionName} (${buildSessionCommand(targetName)}) and cleared pane history.`);
}

export function runTmuxSessionCli(argv = process.argv.slice(2)) {
  const [action, targetName] = argv;
  if (action === "--help" || action === "-h" || !action || !targetName) {
    printHelp();
    return 0;
  }

  if (!validActions.has(action)) {
    throw new Error(`Unknown action "${action}". Expected one of: ${Array.from(validActions).join(", ")}`);
  }

  getTarget(targetName);

  switch (action) {
    case "ensure":
      ensureSession(targetName);
      return 0;
    case "attach":
      attachSession(targetName);
      return 0;
    case "restart":
      restartSession(targetName);
      return 0;
    default:
      throw new Error(`Unhandled action "${action}"`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = runTmuxSessionCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

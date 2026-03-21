import { spawn } from "node:child_process";
import { resolve } from "node:path";

type RestartStepReporter = (command: string) => Promise<void>;

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const repoRoot = resolve(__dirname, "..", "..", "..");
const OUTPUT_TAIL_LIMIT = 8_000;

const RESTART_STEPS = [
  {
    command: "git",
    args: ["checkout", "master"],
    display: "git checkout master"
  },
  {
    command: "git",
    args: ["fetch", "origin"],
    display: "git fetch origin"
  },
  {
    command: "git",
    args: ["reset", "--hard", "origin/master"],
    display: "git reset --hard origin/master"
  },
  {
    command: npmCommand,
    args: ["run", "build"],
    display: "npm run build"
  },
  {
    command: npmCommand,
    args: ["run", "start:tmux:restart"],
    display: "npm run start:tmux:restart"
  }
] as const;

export async function restartKirbotProductionSession(reportStep: RestartStepReporter): Promise<void> {
  for (const step of RESTART_STEPS) {
    await reportStep(step.display);
    await runCommand(step.command, step.args, step.display);
  }
}

async function runCommand(command: string, args: readonly string[], displayCommand: string): Promise<void> {
  await new Promise<void>((resolveOutput, rejectOutput) => {
    const child = spawn(command, [...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let combinedOutput = "";

    const appendOutput = (chunk: string | Buffer): void => {
      combinedOutput = keepOutputTail(`${combinedOutput}${String(chunk)}`);
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.once("error", rejectOutput);
    child.once("close", (code, signal) => {
      if (signal) {
        rejectOutput(
          new Error(formatCommandFailure(displayCommand, `terminated by signal ${signal}`, combinedOutput))
        );
        return;
      }

      if ((code ?? 1) !== 0) {
        rejectOutput(
          new Error(formatCommandFailure(displayCommand, `exited with code ${code ?? 1}`, combinedOutput))
        );
        return;
      }

      resolveOutput();
    });
  });
}

function keepOutputTail(output: string): string {
  if (output.length <= OUTPUT_TAIL_LIMIT) {
    return output;
  }

  return output.slice(-OUTPUT_TAIL_LIMIT);
}

function formatCommandFailure(command: string, reason: string, output: string): string {
  const trimmedOutput = output.trim();
  if (trimmedOutput.length === 0) {
    return `${command} ${reason}`;
  }

  return `${command} ${reason}\n\n${trimmedOutput}`;
}

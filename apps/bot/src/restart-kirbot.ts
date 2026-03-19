import { spawn } from "node:child_process";
import { resolve } from "node:path";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const repoRoot = resolve(__dirname, "..", "..", "..");
const OUTPUT_TAIL_LIMIT = 8_000;

export async function restartKirbotProductionSession(): Promise<void> {
  await runNpmScript("build");
  await runNpmScript("start:tmux:restart");
}

async function runNpmScript(scriptName: string): Promise<void> {
  await new Promise<void>((resolveOutput, rejectOutput) => {
    const child = spawn(npmCommand, ["run", scriptName], {
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
          new Error(formatScriptFailure(scriptName, `terminated by signal ${signal}`, combinedOutput))
        );
        return;
      }

      if ((code ?? 1) !== 0) {
        rejectOutput(
          new Error(formatScriptFailure(scriptName, `exited with code ${code ?? 1}`, combinedOutput))
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

function formatScriptFailure(scriptName: string, reason: string, output: string): string {
  const trimmedOutput = output.trim();
  if (trimmedOutput.length === 0) {
    return `npm run ${scriptName} ${reason}`;
  }

  return `npm run ${scriptName} ${reason}\n\n${trimmedOutput}`;
}

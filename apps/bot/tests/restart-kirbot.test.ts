import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn()
}));

import { spawn } from "node:child_process";

import { restartKirbotProductionSession } from "../src/restart-kirbot";

const expectedRepoRoot = resolve(__dirname, "..", "..", "..");

type FakeChildProcess = ChildProcess & {
  stdout: PassThrough;
  stderr: PassThrough;
};

function createCompletedChild(options?: {
  code?: number;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}): ChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  setTimeout(() => {
    if (options?.stdout) {
      child.stdout.write(options.stdout);
    }
    if (options?.stderr) {
      child.stderr.write(options.stderr);
    }
    child.emit("close", options?.code ?? 0, options?.signal ?? null);
  }, 0);

  return child;
}

describe("restartKirbotProductionSession", () => {
  const spawnMock = vi.mocked(spawn);
  const reportStep = vi.fn<(command: string) => Promise<void>>();
  const runRestart = restartKirbotProductionSession as unknown as (
    reportStep: (command: string) => Promise<void>
  ) => Promise<void>;

  beforeEach(() => {
    spawnMock.mockReset();
    reportStep.mockReset();
    reportStep.mockResolvedValue(undefined);
  });

  it("runs the full deployment pipeline in order from the repo root", async () => {
    spawnMock
      .mockReturnValueOnce(createCompletedChild())
      .mockReturnValueOnce(createCompletedChild())
      .mockReturnValueOnce(createCompletedChild())
      .mockReturnValueOnce(createCompletedChild())
      .mockReturnValueOnce(createCompletedChild());

    await runRestart(reportStep);

    expect(reportStep.mock.calls).toEqual([
      ["git checkout master"],
      ["git fetch origin"],
      ["git reset --hard origin/master"],
      ["npm run build"],
      ["npm run start:tmux:restart"]
    ]);
    expect(spawnMock.mock.calls).toEqual([
      ["git", ["checkout", "master"], { cwd: expectedRepoRoot, stdio: ["ignore", "pipe", "pipe"] }],
      ["git", ["fetch", "origin"], { cwd: expectedRepoRoot, stdio: ["ignore", "pipe", "pipe"] }],
      ["git", ["reset", "--hard", "origin/master"], { cwd: expectedRepoRoot, stdio: ["ignore", "pipe", "pipe"] }],
      ["npm", ["run", "build"], { cwd: expectedRepoRoot, stdio: ["ignore", "pipe", "pipe"] }],
      ["npm", ["run", "start:tmux:restart"], { cwd: expectedRepoRoot, stdio: ["ignore", "pipe", "pipe"] }]
    ]);
  });

  it("stops after the first failing command and surfaces the command-specific error", async () => {
    spawnMock
      .mockReturnValueOnce(createCompletedChild())
      .mockReturnValueOnce(createCompletedChild())
      .mockReturnValueOnce(createCompletedChild({ code: 1, stderr: "fatal: could not reset" }));

    await expect(runRestart(reportStep)).rejects.toThrow(
      "git reset --hard origin/master exited with code 1\n\nfatal: could not reset"
    );

    expect(reportStep.mock.calls).toEqual([
      ["git checkout master"],
      ["git fetch origin"],
      ["git reset --hard origin/master"]
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });
});

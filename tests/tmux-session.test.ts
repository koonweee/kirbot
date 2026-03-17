import { beforeAll, describe, expect, it } from "vitest";

type TmuxSessionModule = {
  repoRoot: string;
  tmuxTargets: Record<
    string,
    {
      sessionName: string;
      npmScript: string;
      description: string;
    }
  >;
  getTarget(targetName: string): {
    sessionName: string;
    npmScript: string;
    description: string;
  };
  buildNewSessionArgs(targetName: string): string[];
  buildAttachArgs(targetName: string, insideTmux: boolean): string[];
  buildRestartArgs(targetName: string): string[];
};

let tmuxSession: TmuxSessionModule;

beforeAll(async () => {
  // @ts-expect-error The runtime script is ESM-only and intentionally has no generated declaration file.
  tmuxSession = await import("../scripts/tmux-session.mjs");
});

describe("tmux-session helper", () => {
  it("defines stable detached session names for dev and production targets", () => {
    expect(tmuxSession.tmuxTargets).toEqual({
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
    });
  });

  it("builds new-session args from the repo root and target script", () => {
    expect(tmuxSession.buildNewSessionArgs("dev")).toEqual([
      "new-session",
      "-d",
      "-s",
      "kirbot-dev",
      "-c",
      tmuxSession.repoRoot,
      "npm run dev"
    ]);
  });

  it("switches clients inside tmux and attaches outside tmux", () => {
    expect(tmuxSession.buildAttachArgs("dev", false)).toEqual(["attach-session", "-t", "kirbot-dev"]);
    expect(tmuxSession.buildAttachArgs("start", true)).toEqual(["switch-client", "-t", "kirbot-prod"]);
  });

  it("restarts the production pane in place", () => {
    expect(tmuxSession.buildRestartArgs("start")).toEqual([
      "respawn-pane",
      "-k",
      "-t",
      "kirbot-prod:0.0",
      "-c",
      tmuxSession.repoRoot,
      "npm run start"
    ]);
  });

  it("rejects unknown targets", () => {
    expect(() => tmuxSession.getTarget("prod")).toThrow('Unknown tmux target "prod"');
  });
});

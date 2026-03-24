import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareKirbotCodexHome, resolveKirbotCodexHomePath } from "../src/codex-home";

describe("codex home helpers", () => {
  const tempDirs: string[] = [];
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };

    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { force: true, recursive: true });
    }
  });

  it("derives an isolated Codex home beside the database by default", () => {
    expect(resolveKirbotCodexHomePath("/srv/kirbot/data/bridge.sqlite")).toBe("/srv/kirbot/data/codex-home");
    expect(resolveKirbotCodexHomePath("/srv/kirbot/data/bridge.sqlite", "/srv/kirbot/custom-home")).toBe(
      "/srv/kirbot/custom-home"
    );
  });

  it("keeps the legacy bootstrap-only path intact", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, targetHome);

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"abc"}');
    fs.mkdirSync(join(sourceHome, "skills"), { recursive: true });
    fs.writeFileSync(join(sourceHome, "skills", "local-skill.md"), "# local skill\n");
    fs.mkdirSync(join(sourceHome, "superpowers"), { recursive: true });
    fs.writeFileSync(join(sourceHome, "superpowers", "manifest.txt"), "skill-index\n");
    fs.mkdirSync(join(sourceHome, "rules"), { recursive: true });
    fs.writeFileSync(join(sourceHome, "rules", "local.md"), "# local rule\n");
    fs.mkdirSync(join(sourceHome, "sessions"), { recursive: true });
    fs.writeFileSync(join(sourceHome, "sessions", "thread.jsonl"), "{}\n");
    fs.writeFileSync(join(sourceHome, "state_5.sqlite"), "sqlite");

    prepareKirbotCodexHome({
      sourceHomePath: sourceHome,
      targetHomePath: targetHome
    });

    expect(fs.readFileSync(join(targetHome, "auth.json"), "utf8")).toBe('{"token":"abc"}');
    expect(fs.readFileSync(join(targetHome, "skills", "local-skill.md"), "utf8")).toBe("# local skill\n");
    expect(fs.readFileSync(join(targetHome, "superpowers", "manifest.txt"), "utf8")).toBe("skill-index\n");
    expect(fs.readFileSync(join(targetHome, "rules", "local.md"), "utf8")).toBe("# local rule\n");
    expect(() => fs.readFileSync(join(targetHome, "config.toml"), "utf8")).toThrow();
    expect(() => fs.readFileSync(join(targetHome, "sessions", "thread.jsonl"), "utf8")).toThrow();
    expect(() => fs.readFileSync(join(targetHome, "state_5.sqlite"), "utf8")).toThrow();
  });

  it("creates a missing managed home, seeds auth.json from the base home, rewrites config.toml, and rebuilds managed skills exactly", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHomeParent = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-parent-"));
    const targetHome = join(targetHomeParent, "profile-home");
    tempDirs.push(sourceHome, repoRoot, targetHomeParent);

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"abc"}');
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");
    fs.mkdirSync(join(repoRoot, "skills", "kirbot-skill-install"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "kirbot-skill-install", "SKILL.md"), "# kirbot-skill-install\n");

    const managedConfigToml = [
      'model = "gpt-5-codex"',
      'sandbox_mode = "danger-full-access"',
      'approval_policy = "never"',
      "",
      "[mcp_servers.github]",
      'type = "stdio"',
      'command = ["github-mcp", "serve"]',
      ""
    ].join("\n");

    prepareKirbotCodexHome({
      sourceHomePath: sourceHome,
      targetHomePath: targetHome,
      managed: {
        managedConfigToml,
        managedSkillIds: ["brainstorming", "kirbot-skill-install"],
        managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
      }
    });

    expect(fs.existsSync(targetHome)).toBe(true);
    expect(fs.readFileSync(join(targetHome, "auth.json"), "utf8")).toBe('{"token":"abc"}');
    expect(fs.readFileSync(join(targetHome, "config.toml"), "utf8")).toBe(managedConfigToml);
    expect(fs.readdirSync(join(targetHome, "skills")).sort()).toEqual(["brainstorming", "kirbot-skill-install"]);
    expect(fs.readFileSync(join(targetHome, "skills", "brainstorming", "SKILL.md"), "utf8")).toBe("# brainstorming\n");
    expect(fs.readFileSync(join(targetHome, "skills", "kirbot-skill-install", "SKILL.md"), "utf8")).toBe(
      "# kirbot-skill-install\n"
    );
  });

  it("rejects partial managed updates that do not own config.toml and skills together", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, targetHome);

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"base"}');

    expect(() =>
      prepareKirbotCodexHome({
        sourceHomePath: sourceHome,
        targetHomePath: targetHome,
        managed: {
          managedConfigToml: 'model = "gpt-5-codex"\n'
        } as any
      })
    ).toThrow(/managed reconciliation requires config\.toml, skill ids, and the resolved profiles config path together/);
  });

  it("uses the resolved profiles config path from loadConfig when reconciling managed skills", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHomeParent = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-parent-"));
    const targetHome = join(targetHomeParent, "profile-home");
    tempDirs.push(sourceHome, repoRoot, targetHomeParent);

    process.env = {
      ...originalEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app",
      DATABASE_PATH: join(repoRoot, "data", "bridge.sqlite")
    };

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"abc"}');
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(
      join(repoRoot, "config", "codex-profiles.json"),
      JSON.stringify({
        routes: { general: "general", thread: "coding", plan: "coding" },
        skills: { brainstorming: {} },
        mcps: {},
        profiles: {
          general: { reasoningEffort: "medium", serviceTier: "flex", skills: [], mcps: [] },
          coding: { reasoningEffort: "high", serviceTier: "fast", skills: ["brainstorming"], mcps: [] }
        }
      })
    );
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    const { loadConfig } = await import("../src/config");
    const config = loadConfig();

    prepareKirbotCodexHome({
      sourceHomePath: sourceHome,
      targetHomePath: targetHome,
      managed: {
        managedConfigToml: 'model = "gpt-5-codex"\n',
        managedSkillIds: ["brainstorming"],
        managedProfilesConfigPath: config.codex.profilesConfigPath
      }
    });

    expect(config.codex.profilesConfigPath).toBe(join(repoRoot, "config", "codex-profiles.json"));
    expect(fs.readFileSync(join(targetHome, "skills", "brainstorming", "SKILL.md"), "utf8")).toBe("# brainstorming\n");
  });

  it("falls back to copying managed skills when symlinks are unavailable", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"abc"}');
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    try {
      vi.resetModules();
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof fs>("node:fs");
        return {
          ...actual,
          symlinkSync: () => {
            throw new Error("symlink unavailable");
          }
        };
      });

      const { prepareKirbotCodexHome: mockedPrepareKirbotCodexHome } = await import("../src/codex-home");

      mockedPrepareKirbotCodexHome({
        sourceHomePath: sourceHome,
        targetHomePath: targetHome,
        managed: {
          managedConfigToml: 'model = "gpt-5-codex"\n',
          managedSkillIds: ["brainstorming"],
          managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
        }
      });
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }

    expect(fs.lstatSync(join(targetHome, "skills", "brainstorming")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(join(targetHome, "skills", "brainstorming", "SKILL.md"), "utf8")).toBe("# brainstorming\n");
  });

  it("prefers symlinks for managed skills when the filesystem allows them", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"abc"}');
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    const cpSyncCalls: string[] = [];
    const symlinkTargets: string[] = [];

    try {
      vi.resetModules();
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof fs>("node:fs");
        return {
          ...actual,
          cpSync: (...args: Parameters<typeof actual.cpSync>) => {
            const [source, target] = args;
            cpSyncCalls.push(`${String(source)} -> ${String(target)}`);
            return actual.cpSync(...args);
          },
          symlinkSync: (target: fs.PathLike, path: fs.PathLike, type?: fs.symlink.Type) => {
            symlinkTargets.push(`${String(target)} -> ${String(path)}`);
            return actual.symlinkSync(target, path, type);
          }
        };
      });

      const { prepareKirbotCodexHome: mockedPrepareKirbotCodexHome } = await import("../src/codex-home");

      mockedPrepareKirbotCodexHome({
        sourceHomePath: sourceHome,
        targetHomePath: targetHome,
        managed: {
          managedConfigToml: 'model = "gpt-5-codex"\n',
          managedSkillIds: ["brainstorming"],
          managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
        }
      });
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }

    expect(cpSyncCalls).toHaveLength(1);
    expect(cpSyncCalls[0]).toContain("auth.json");
    expect(symlinkTargets).toHaveLength(1);
    expect(symlinkTargets[0]).toContain("skills/brainstorming");
  });

  it("preserves existing auth.json and unmanaged files while removing stale managed skills", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"base"}');
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills"), { recursive: true });
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    fs.mkdirSync(join(targetHome, "rules"), { recursive: true });
    fs.writeFileSync(join(targetHome, "rules", "local.md"), "# keep me\n");
    fs.mkdirSync(join(targetHome, "superpowers"), { recursive: true });
    fs.writeFileSync(join(targetHome, "superpowers", "manifest.txt"), "skill-index\n");
    fs.writeFileSync(join(targetHome, "runtime.log"), "runtime-state\n");
    fs.writeFileSync(join(targetHome, "auth.json"), '{"token":"existing"}');
    fs.writeFileSync(join(targetHome, "config.toml"), 'model = "old-model"\n');
    fs.mkdirSync(join(targetHome, "skills", "old-skill"), { recursive: true });
    fs.writeFileSync(join(targetHome, "skills", "old-skill", "SKILL.md"), "# old-skill\n");

    const managedConfigToml = [
      'model = "gpt-5-codex"',
      'sandbox_mode = "workspace-write"',
      'approval_policy = "on-request"',
      "",
      "[mcp_servers.github]",
      'type = "stdio"',
      'command = ["github-mcp", "serve"]',
      ""
    ].join("\n");

    prepareKirbotCodexHome({
      sourceHomePath: sourceHome,
      targetHomePath: targetHome,
      managed: {
        managedConfigToml,
        managedSkillIds: ["brainstorming"],
        managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
      }
    });

    expect(fs.readFileSync(join(targetHome, "auth.json"), "utf8")).toBe('{"token":"existing"}');
    expect(fs.readFileSync(join(targetHome, "config.toml"), "utf8")).toBe(managedConfigToml);
    expect(fs.readdirSync(join(targetHome, "skills"))).toEqual(["brainstorming"]);
    expect(fs.existsSync(join(targetHome, "skills", "old-skill"))).toBe(false);
    expect(fs.readFileSync(join(targetHome, "skills", "brainstorming", "SKILL.md"), "utf8")).toBe("# brainstorming\n");
    expect(fs.readFileSync(join(targetHome, "rules", "local.md"), "utf8")).toBe("# keep me\n");
    expect(fs.readFileSync(join(targetHome, "superpowers", "manifest.txt"), "utf8")).toBe("skill-index\n");
    expect(fs.readFileSync(join(targetHome, "runtime.log"), "utf8")).toBe("runtime-state\n");
  });

  it("does not rewrite managed files when a configured repo-local skill is missing", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"base"}');
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills"), { recursive: true });

    fs.writeFileSync(join(targetHome, "config.toml"), 'model = "old-model"\n');
    fs.mkdirSync(join(targetHome, "skills", "old-skill"), { recursive: true });
    fs.writeFileSync(join(targetHome, "skills", "old-skill", "SKILL.md"), "# old-skill\n");

    expect(() =>
      prepareKirbotCodexHome({
        sourceHomePath: sourceHome,
        targetHomePath: targetHome,
        managed: {
          managedConfigToml: 'model = "gpt-5-codex"\n',
          managedSkillIds: ["missing-skill"],
          managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
        }
      })
    ).toThrow(/Managed skill "missing-skill" is missing/);

    expect(fs.readFileSync(join(targetHome, "config.toml"), "utf8")).toBe('model = "old-model"\n');
    expect(fs.readdirSync(join(targetHome, "skills"))).toEqual(["old-skill"]);
    expect(fs.readFileSync(join(targetHome, "skills", "old-skill", "SKILL.md"), "utf8")).toBe("# old-skill\n");
  });

  it("rejects managed skill ids that escape the repo-local skills directory", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"base"}');
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills"), { recursive: true });

    expect(() =>
      prepareKirbotCodexHome({
        sourceHomePath: sourceHome,
        targetHomePath: targetHome,
        managed: {
          managedConfigToml: 'model = "gpt-5-codex"\n',
          managedSkillIds: ["../escape"],
          managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
        }
      })
    ).toThrow(/Managed skill id "\.\.\/escape" must be a single path segment/);
  });

  it("rolls back both config.toml and skills when skills promotion fails after config promotion", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"base"}');
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    fs.writeFileSync(join(targetHome, "config.toml"), 'model = "old-model"\n');
    fs.mkdirSync(join(targetHome, "skills", "old-skill"), { recursive: true });
    fs.writeFileSync(join(targetHome, "skills", "old-skill", "SKILL.md"), "# old-skill\n");

    try {
      vi.resetModules();
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof fs>("node:fs");
        return {
          ...actual,
          renameSync: (source: fs.PathLike, target: fs.PathLike) => {
            if (String(source) === join(targetHome, ".kirbot-managed-skills-next") && String(target) === join(targetHome, "skills")) {
              throw new Error("skills rename failed");
            }

            return actual.renameSync(source, target);
          }
        };
      });

      const { prepareKirbotCodexHome: mockedPrepareKirbotCodexHome } = await import("../src/codex-home");

      expect(() =>
        mockedPrepareKirbotCodexHome({
          sourceHomePath: sourceHome,
          targetHomePath: targetHome,
          managed: {
            managedConfigToml: 'model = "gpt-5-codex"\n',
            managedSkillIds: ["brainstorming"],
            managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
          }
        })
      ).toThrow(/skills rename failed/);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }

    expect(fs.readFileSync(join(targetHome, "config.toml"), "utf8")).toBe('model = "old-model"\n');
    expect(fs.readdirSync(join(targetHome, "skills"))).toEqual(["old-skill"]);
    expect(fs.readFileSync(join(targetHome, "skills", "old-skill", "SKILL.md"), "utf8")).toBe("# old-skill\n");
  });

  it("restores config.toml when the second backup rename fails after config backup succeeds", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"base"}');
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    fs.writeFileSync(join(targetHome, "config.toml"), 'model = "old-model"\n');
    fs.mkdirSync(join(targetHome, "skills", "old-skill"), { recursive: true });
    fs.writeFileSync(join(targetHome, "skills", "old-skill", "SKILL.md"), "# old-skill\n");

    try {
      vi.resetModules();
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof fs>("node:fs");
        return {
          ...actual,
          renameSync: (source: fs.PathLike, target: fs.PathLike) => {
            if (String(source) === join(targetHome, "skills") && String(target) === join(targetHome, ".kirbot-managed-skills.prev")) {
              throw new Error("skills backup failed");
            }

            return actual.renameSync(source, target);
          }
        };
      });

      const { prepareKirbotCodexHome: mockedPrepareKirbotCodexHome } = await import("../src/codex-home");

      expect(() =>
        mockedPrepareKirbotCodexHome({
          sourceHomePath: sourceHome,
          targetHomePath: targetHome,
          managed: {
            managedConfigToml: 'model = "gpt-5-codex"\n',
            managedSkillIds: ["brainstorming"],
            managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
          }
        })
      ).toThrow(/skills backup failed/);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }

    expect(fs.readFileSync(join(targetHome, "config.toml"), "utf8")).toBe('model = "old-model"\n');
    expect(fs.readdirSync(join(targetHome, "skills"))).toEqual(["old-skill"]);
    expect(fs.readFileSync(join(targetHome, "skills", "old-skill", "SKILL.md"), "utf8")).toBe("# old-skill\n");
  });

  it("preserves the live managed boundary when the first backup rename fails", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"base"}');
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    fs.writeFileSync(join(targetHome, "config.toml"), 'model = "old-model"\n');
    fs.mkdirSync(join(targetHome, "skills", "old-skill"), { recursive: true });
    fs.writeFileSync(join(targetHome, "skills", "old-skill", "SKILL.md"), "# old-skill\n");

    try {
      vi.resetModules();
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof fs>("node:fs");
        return {
          ...actual,
          renameSync: (source: fs.PathLike, target: fs.PathLike) => {
            if (String(source).endsWith("config.toml") && String(target).endsWith(".kirbot-managed-config.toml.prev")) {
              throw new Error("config backup failed");
            }

            return actual.renameSync(source, target);
          }
        };
      });

      const { prepareKirbotCodexHome: mockedPrepareKirbotCodexHome } = await import("../src/codex-home");

      expect(() =>
        mockedPrepareKirbotCodexHome({
          sourceHomePath: sourceHome,
          targetHomePath: targetHome,
          managed: {
            managedConfigToml: 'model = "gpt-5-codex"\n',
            managedSkillIds: ["brainstorming"],
            managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
          }
        })
      ).toThrow(/config backup failed/);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }

    expect(fs.readFileSync(join(targetHome, "config.toml"), "utf8")).toBe('model = "old-model"\n');
    expect(fs.readdirSync(join(targetHome, "skills"))).toEqual(["old-skill"]);
    expect(fs.readFileSync(join(targetHome, "skills", "old-skill", "SKILL.md"), "utf8")).toBe("# old-skill\n");
  });

  it("preserves rollback backups on disk when restore fails", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"base"}');
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    fs.writeFileSync(join(targetHome, "config.toml"), 'model = "old-model"\n');
    fs.mkdirSync(join(targetHome, "skills", "old-skill"), { recursive: true });
    fs.writeFileSync(join(targetHome, "skills", "old-skill", "SKILL.md"), "# old-skill\n");

    try {
      vi.resetModules();
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof fs>("node:fs");
        return {
          ...actual,
          renameSync: (source: fs.PathLike, target: fs.PathLike) => {
            if (String(source) === join(targetHome, ".kirbot-managed-skills-next") && String(target) === join(targetHome, "skills")) {
              throw new Error("skills rename failed");
            }
            if (
              String(source) === join(targetHome, ".kirbot-managed-config.toml.prev") &&
              String(target) === join(targetHome, "config.toml")
            ) {
              throw new Error("config restore failed");
            }

            return actual.renameSync(source, target);
          }
        };
      });

      const { prepareKirbotCodexHome: mockedPrepareKirbotCodexHome } = await import("../src/codex-home");

      expect(() =>
        mockedPrepareKirbotCodexHome({
          sourceHomePath: sourceHome,
          targetHomePath: targetHome,
          managed: {
            managedConfigToml: 'model = "gpt-5-codex"\n',
            managedSkillIds: ["brainstorming"],
            managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
          }
        })
      ).toThrow(/config restore failed/);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }

    expect(fs.existsSync(join(targetHome, ".kirbot-managed-config.toml.prev"))).toBe(true);
    expect(fs.existsSync(join(targetHome, ".kirbot-managed-skills.prev"))).toBe(true);
  });

  it("cleans staged config.toml when skill staging fails before promotion", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"base"}');
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    try {
      vi.resetModules();
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof fs>("node:fs");
        return {
          ...actual,
          symlinkSync: () => {
            throw new Error("symlink unavailable");
          },
          cpSync: (...args: Parameters<typeof actual.cpSync>) => {
            const [, target] = args;
            if (String(target).includes(".kirbot-managed-skills-next")) {
              throw new Error("skill copy failed");
            }

            return actual.cpSync(...args);
          }
        };
      });

      const { prepareKirbotCodexHome: mockedPrepareKirbotCodexHome } = await import("../src/codex-home");

      expect(() =>
        mockedPrepareKirbotCodexHome({
          sourceHomePath: sourceHome,
          targetHomePath: targetHome,
          managed: {
            managedConfigToml: 'model = "gpt-5-codex"\n',
            managedSkillIds: ["brainstorming"],
            managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
          }
        })
      ).toThrow(/skill copy failed/);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }

    expect(fs.existsSync(join(targetHome, ".kirbot-managed-config.toml.next"))).toBe(false);
  });
});

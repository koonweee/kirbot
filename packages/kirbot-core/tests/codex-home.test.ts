import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareKirbotCodexHome, resolveKirbotCodexHomePath } from "../src/codex-home";

describe("codex home helpers", () => {
  const tempDirs: string[] = [];
  const originalEnv = { ...process.env };

  function seedSourceHomeAuth(sourceHome: string, token: string): void {
    fs.mkdirSync(join(sourceHome, ".codex"), { recursive: true });
    fs.writeFileSync(join(sourceHome, ".codex", "auth.json"), token);
  }

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

  it("requires managed reconciliation inputs", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, targetHome);

    seedSourceHomeAuth(sourceHome, '{"token":"abc"}');

    expect(() =>
      prepareKirbotCodexHome({
        sourceHomePath: sourceHome,
        targetHomePath: targetHome
      } as any)
    ).toThrow(/managed reconciliation requires config\.toml, skill ids, and the resolved profiles config path together/);
  });

  it("creates a missing managed home, seeds auth.json from sourceHome/.codex/auth.json, rewrites config.toml, and rebuilds managed skills exactly", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHomeParent = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-parent-"));
    const targetHome = join(targetHomeParent, "profile-home");
    tempDirs.push(sourceHome, repoRoot, targetHomeParent);

    seedSourceHomeAuth(sourceHome, '{"token":"abc"}');
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

  it("defaults sourceHomePath to homedir() and reads auth from ~/.codex/auth.json", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.mkdirSync(join(sourceHome, ".ssh"), { recursive: true });
    fs.writeFileSync(join(sourceHome, ".gitconfig"), "[user]\n\tname = Jeremy\n");
    seedSourceHomeAuth(sourceHome, '{"token":"default-home-token"}');

    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    try {
      vi.resetModules();
      vi.doMock("node:os", async () => {
        const actual = await vi.importActual<typeof import("node:os")>("node:os");
        return {
          ...actual,
          homedir: () => sourceHome
        };
      });

      const { prepareKirbotCodexHome: mockedPrepareKirbotCodexHome } = await import("../src/codex-home");

      mockedPrepareKirbotCodexHome({
        targetHomePath: targetHome,
        managed: {
          managedConfigToml: 'model = "gpt-5-codex"\n',
          managedSkillIds: ["brainstorming"],
          managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
        }
      });
    } finally {
      vi.doUnmock("node:os");
      vi.resetModules();
    }

    expect(fs.existsSync(join(targetHome, ".ssh"))).toBe(true);
    expect(fs.lstatSync(join(targetHome, ".ssh")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(join(targetHome, ".ssh"))).toBe(fs.realpathSync(join(sourceHome, ".ssh")));
    expect(fs.existsSync(join(targetHome, ".gitconfig"))).toBe(true);
    expect(fs.lstatSync(join(targetHome, ".gitconfig")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(join(targetHome, "auth.json"), "utf8")).toBe('{"token":"default-home-token"}');
    expect(fs.existsSync(join(targetHome, ".codex"))).toBe(false);
  });

  it("mirrors top-level home entries while excluding codex-related state and seeds auth.json from sourceHome/.codex/auth.json", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.mkdirSync(join(sourceHome, ".ssh"), { recursive: true });
    fs.writeFileSync(join(sourceHome, ".gitconfig"), "[user]\n\tname = Jeremy\n");
    fs.mkdirSync(join(sourceHome, ".codex"), { recursive: true });
    fs.writeFileSync(join(sourceHome, ".codex", "auth.json"), '{"token":"codex-token"}');
    fs.mkdirSync(join(sourceHome, ".codex", "superpowers", "skills"), { recursive: true });
    fs.mkdirSync(join(sourceHome, ".agents", "skills"), { recursive: true });
    fs.symlinkSync(
      join(sourceHome, ".codex", "superpowers", "skills"),
      join(sourceHome, ".agents", "skills", "superpowers"),
      "dir"
    );

    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    prepareKirbotCodexHome({
      sourceHomePath: sourceHome,
      targetHomePath: targetHome,
      managed: {
        managedConfigToml: 'model = "gpt-5-codex"\n',
        managedSkillIds: ["brainstorming"],
        managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
      }
    });

    const mirrorManifest = JSON.parse(fs.readFileSync(join(targetHome, ".kirbot-managed-home-mirror.json"), "utf8")) as {
      mirroredTopLevelNames?: string[];
    };

    expect(fs.existsSync(join(targetHome, ".ssh"))).toBe(true);
    expect(fs.lstatSync(join(targetHome, ".ssh")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(join(targetHome, ".ssh"))).toBe(fs.realpathSync(join(sourceHome, ".ssh")));
    expect(fs.existsSync(join(targetHome, ".gitconfig"))).toBe(true);
    expect(fs.lstatSync(join(targetHome, ".gitconfig")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(join(targetHome, ".gitconfig"))).toBe(fs.realpathSync(join(sourceHome, ".gitconfig")));
    expect(fs.existsSync(join(targetHome, ".codex"))).toBe(false);
    expect(fs.existsSync(join(targetHome, ".agents"))).toBe(false);
    expect(fs.existsSync(join(targetHome, "auth.json"))).toBe(true);
    expect(fs.lstatSync(join(targetHome, "auth.json")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(join(targetHome, "auth.json"), "utf8")).toBe('{"token":"codex-token"}');
    expect(mirrorManifest.mirroredTopLevelNames).toHaveLength(2);
    expect(mirrorManifest.mirroredTopLevelNames).toEqual(expect.arrayContaining([".ssh", ".gitconfig"]));
    expect(mirrorManifest.mirroredTopLevelNames).not.toContain(".codex");
    expect(mirrorManifest.mirroredTopLevelNames).not.toContain(".agents");
    expect(mirrorManifest.mirroredTopLevelNames).not.toContain("auth.json");
    expect(mirrorManifest.mirroredTopLevelNames).not.toContain("config.toml");
    expect(mirrorManifest.mirroredTopLevelNames).not.toContain("skills");
  });

  it("ignores unsafe manifest entries when cleaning stale mirrors", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHomeParent = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-parent-"));
    const targetHome = join(targetHomeParent, "profile-home");
    tempDirs.push(sourceHome, repoRoot, targetHomeParent);

    fs.mkdirSync(join(sourceHome, ".codex"), { recursive: true });
    fs.writeFileSync(join(sourceHome, ".codex", "auth.json"), '{"token":"codex-token"}');
    fs.mkdirSync(join(targetHomeParent, "outside"), { recursive: true });
    fs.writeFileSync(join(targetHomeParent, "outside", "keep.txt"), "keep");
    fs.mkdirSync(targetHome, { recursive: true });
    fs.writeFileSync(join(targetHome, "keep.txt"), "keep");
    fs.writeFileSync(
      join(targetHome, ".kirbot-managed-home-mirror.json"),
      JSON.stringify({ mirroredTopLevelNames: [".", "", "../outside"] })
    );

    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    prepareKirbotCodexHome({
      sourceHomePath: sourceHome,
      targetHomePath: targetHome,
      managed: {
        managedConfigToml: 'model = "gpt-5-codex"\n',
        managedSkillIds: ["brainstorming"],
        managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
      }
    });

    const mirrorManifest = JSON.parse(fs.readFileSync(join(targetHome, ".kirbot-managed-home-mirror.json"), "utf8")) as {
      mirroredTopLevelNames?: string[];
    };

    expect(fs.readFileSync(join(targetHome, "keep.txt"), "utf8")).toBe("keep");
    expect(fs.readFileSync(join(targetHomeParent, "outside", "keep.txt"), "utf8")).toBe("keep");
    expect(mirrorManifest.mirroredTopLevelNames).toEqual([]);
  });

  it("excludes the source top-level entry that contains targetHomePath from mirroring", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = join(sourceHome, "homes", "profile-home");
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.mkdirSync(join(sourceHome, "homes"), { recursive: true });
    fs.mkdirSync(join(sourceHome, ".codex"), { recursive: true });
    fs.writeFileSync(join(sourceHome, ".codex", "auth.json"), '{"token":"codex-token"}');
    fs.mkdirSync(join(sourceHome, ".ssh"), { recursive: true });
    fs.writeFileSync(join(sourceHome, ".gitconfig"), "[user]\n\tname = Jeremy\n");

    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    prepareKirbotCodexHome({
      sourceHomePath: sourceHome,
      targetHomePath: targetHome,
      managed: {
        managedConfigToml: 'model = "gpt-5-codex"\n',
        managedSkillIds: ["brainstorming"],
        managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
      }
    });

    const mirrorManifest = JSON.parse(fs.readFileSync(join(targetHome, ".kirbot-managed-home-mirror.json"), "utf8")) as {
      mirroredTopLevelNames?: string[];
    };

    expect(fs.existsSync(join(targetHome, "homes"))).toBe(false);
    expect(fs.existsSync(join(targetHome, ".gitconfig"))).toBe(true);
    expect(fs.lstatSync(join(targetHome, ".gitconfig")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(join(targetHome, ".gitconfig"))).toBe(fs.realpathSync(join(sourceHome, ".gitconfig")));
    expect(fs.readFileSync(join(targetHome, "auth.json"), "utf8")).toBe('{"token":"codex-token"}');
    expect(mirrorManifest.mirroredTopLevelNames).toEqual(expect.arrayContaining([".gitconfig", ".ssh"]));
    expect(mirrorManifest.mirroredTopLevelNames).not.toContain("homes");
  });

  it("removes stale mirrored entries on reconcile but keeps runtime-owned Codex directories", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.writeFileSync(
      join(targetHome, ".kirbot-managed-home-mirror.json"),
      JSON.stringify({ mirroredTopLevelNames: [".agents", ".obsolete"] })
    );
    fs.mkdirSync(join(sourceHome, ".config"), { recursive: true });
    fs.writeFileSync(join(sourceHome, ".config", "user.json"), "{}");

    fs.symlinkSync(join(sourceHome, ".config"), join(targetHome, ".agents"), "dir");
    fs.symlinkSync(join(sourceHome, ".config"), join(targetHome, ".obsolete"), "dir");
    fs.writeFileSync(join(targetHome, ".stray"), "keep");
    fs.mkdirSync(join(targetHome, "sessions"), { recursive: true });
    fs.writeFileSync(join(targetHome, "sessions", "keep.txt"), "keep");
    fs.mkdirSync(join(targetHome, "shell_snapshots"), { recursive: true });
    fs.writeFileSync(join(targetHome, "shell_snapshots", "keep.txt"), "keep");
    fs.mkdirSync(join(targetHome, "tmp"), { recursive: true });
    fs.writeFileSync(join(targetHome, "tmp", "keep.txt"), "keep");

    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    prepareKirbotCodexHome({
      sourceHomePath: sourceHome,
      targetHomePath: targetHome,
      managed: {
        managedConfigToml: 'model = "gpt-5-codex"\n',
        managedSkillIds: ["brainstorming"],
        managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
      }
    });

    const mirrorManifest = JSON.parse(fs.readFileSync(join(targetHome, ".kirbot-managed-home-mirror.json"), "utf8")) as {
      mirroredTopLevelNames?: string[];
    };

    expect(fs.existsSync(join(targetHome, ".agents"))).toBe(false);
    expect(fs.existsSync(join(targetHome, ".obsolete"))).toBe(false);
    expect(fs.existsSync(join(targetHome, ".stray"))).toBe(true);
    expect(fs.existsSync(join(targetHome, ".config"))).toBe(true);
    expect(fs.lstatSync(join(targetHome, ".config")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(join(targetHome, ".config"))).toBe(fs.realpathSync(join(sourceHome, ".config")));
    expect(fs.readFileSync(join(targetHome, "sessions", "keep.txt"), "utf8")).toBe("keep");
    expect(fs.readFileSync(join(targetHome, "shell_snapshots", "keep.txt"), "utf8")).toBe("keep");
    expect(fs.readFileSync(join(targetHome, "tmp", "keep.txt"), "utf8")).toBe("keep");
    expect(mirrorManifest.mirroredTopLevelNames).toEqual([".config"]);
  });

  it("prefers managed Codex files over mirrored home entries", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "kirbot-repo-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, repoRoot, targetHome);

    fs.writeFileSync(join(sourceHome, "auth.json"), '{"token":"mirror-token"}');
    fs.writeFileSync(join(sourceHome, "config.toml"), 'model = "mirror-model"\n');
    fs.mkdirSync(join(sourceHome, ".codex"), { recursive: true });
    fs.writeFileSync(join(sourceHome, ".codex", "auth.json"), '{"token":"codex-token"}');
    fs.mkdirSync(join(sourceHome, "skills", "wrong-skill"), { recursive: true });

    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    fs.mkdirSync(join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "config", "codex-profiles.json"), "{}");
    fs.mkdirSync(join(repoRoot, "skills", "brainstorming"), { recursive: true });
    fs.writeFileSync(join(repoRoot, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");

    prepareKirbotCodexHome({
      sourceHomePath: sourceHome,
      targetHomePath: targetHome,
      managed: {
        managedConfigToml: 'model = "gpt-5-codex"\n',
        managedSkillIds: ["brainstorming"],
        managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
      }
    });

    const mirrorManifest = JSON.parse(fs.readFileSync(join(targetHome, ".kirbot-managed-home-mirror.json"), "utf8")) as {
      mirroredTopLevelNames?: string[];
    };

    expect(fs.existsSync(join(targetHome, "auth.json"))).toBe(true);
    expect(fs.readFileSync(join(targetHome, "auth.json"), "utf8")).toBe('{"token":"codex-token"}');
    expect(fs.lstatSync(join(targetHome, "auth.json")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(join(targetHome, "config.toml"), "utf8")).toBe('model = "gpt-5-codex"\n');
    expect(fs.lstatSync(join(targetHome, "config.toml")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(join(targetHome, "skills", "brainstorming", "SKILL.md"), "utf8")).toBe("# brainstorming\n");
    expect(fs.existsSync(join(targetHome, "skills", "wrong-skill"))).toBe(false);
    expect(mirrorManifest.mirroredTopLevelNames).toEqual([]);
    expect(mirrorManifest.mirroredTopLevelNames).not.toContain("auth.json");
    expect(mirrorManifest.mirroredTopLevelNames).not.toContain("config.toml");
    expect(mirrorManifest.mirroredTopLevelNames).not.toContain("skills");
  });

  it("rejects partial managed updates that do not own config.toml and skills together", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, targetHome);

    seedSourceHomeAuth(sourceHome, '{"token":"base"}');

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

    seedSourceHomeAuth(sourceHome, '{"token":"abc"}');
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

    seedSourceHomeAuth(sourceHome, '{"token":"abc"}');
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

    seedSourceHomeAuth(sourceHome, '{"token":"abc"}');
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

    seedSourceHomeAuth(sourceHome, '{"token":"base"}');
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

    seedSourceHomeAuth(sourceHome, '{"token":"base"}');
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

    seedSourceHomeAuth(sourceHome, '{"token":"base"}');
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

    seedSourceHomeAuth(sourceHome, '{"token":"base"}');
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

    seedSourceHomeAuth(sourceHome, '{"token":"base"}');
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

    seedSourceHomeAuth(sourceHome, '{"token":"base"}');
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

    seedSourceHomeAuth(sourceHome, '{"token":"base"}');
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

    seedSourceHomeAuth(sourceHome, '{"token":"base"}');
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

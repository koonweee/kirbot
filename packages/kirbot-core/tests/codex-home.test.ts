import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { prepareKirbotCodexHome, resolveKirbotCodexHomePath } from "../src/codex-home";

describe("codex home helpers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { force: true, recursive: true });
    }
  });

  it("derives an isolated Codex home beside the database by default", () => {
    expect(resolveKirbotCodexHomePath("/srv/kirbot/data/bridge.sqlite")).toBe("/srv/kirbot/data/codex-home");
    expect(resolveKirbotCodexHomePath("/srv/kirbot/data/bridge.sqlite", "/srv/kirbot/custom-home")).toBe(
      "/srv/kirbot/custom-home"
    );
  });

  it("seeds auth and skill directories without copying Codex config or thread state", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-source-"));
    const targetHome = mkdtempSync(join(tmpdir(), "kirbot-codex-home-target-"));
    tempDirs.push(sourceHome, targetHome);

    writeFileSync(join(sourceHome, "auth.json"), '{"token":"abc"}');
    writeFileSync(join(sourceHome, "config.toml"), 'model = "gpt-5-codex"\n');
    mkdirSync(join(sourceHome, "skills"), { recursive: true });
    writeFileSync(join(sourceHome, "skills", "local-skill.md"), "# local skill\n");
    mkdirSync(join(sourceHome, "superpowers"), { recursive: true });
    writeFileSync(join(sourceHome, "superpowers", "manifest.txt"), "skill-index\n");
    mkdirSync(join(sourceHome, "rules"), { recursive: true });
    writeFileSync(join(sourceHome, "rules", "local.md"), "# local rule\n");
    mkdirSync(join(sourceHome, "sessions"), { recursive: true });
    writeFileSync(join(sourceHome, "sessions", "thread.jsonl"), "{}\n");
    writeFileSync(join(sourceHome, "state_5.sqlite"), "sqlite");

    prepareKirbotCodexHome({
      sourceHomePath: sourceHome,
      targetHomePath: targetHome
    });

    expect(readFileSync(join(targetHome, "auth.json"), "utf8")).toBe('{"token":"abc"}');
    expect(readFileSync(join(targetHome, "skills", "local-skill.md"), "utf8")).toBe("# local skill\n");
    expect(readFileSync(join(targetHome, "superpowers", "manifest.txt"), "utf8")).toBe("skill-index\n");
    expect(readFileSync(join(targetHome, "rules", "local.md"), "utf8")).toBe("# local rule\n");
    expect(() => readFileSync(join(targetHome, "config.toml"), "utf8")).toThrow();
    expect(() => readFileSync(join(targetHome, "sessions", "thread.jsonl"), "utf8")).toThrow();
    expect(() => readFileSync(join(targetHome, "state_5.sqlite"), "utf8")).toThrow();
  });
});

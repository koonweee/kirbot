import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SEEDED_CODEX_FILES = ["auth.json"] as const;
const SEEDED_CODEX_DIRECTORIES = ["rules", "skills", "superpowers"] as const;

export type ManagedKirbotCodexHome = {
  managedConfigToml: string;
  managedSkillIds: readonly string[];
  managedProfilesConfigPath: string;
};

export type PrepareKirbotCodexHomeOptions = {
  targetHomePath: string;
  sourceHomePath?: string;
  managed?: ManagedKirbotCodexHome;
};

export function resolveKirbotCodexHomePath(databasePath: string, explicitPath?: string): string {
  if (explicitPath) {
    return explicitPath;
  }

  return resolve(dirname(databasePath), "codex-home");
}

export function resolveKirbotCodexConfigPath(homePath: string): string {
  return join(homePath, "config.toml");
}

export function prepareKirbotCodexHome(options: PrepareKirbotCodexHomeOptions): void {
  const sourceHomePath = options.sourceHomePath ?? join(homedir(), ".codex");
  fs.mkdirSync(options.targetHomePath, { recursive: true });

  if (options.managed === undefined) {
    seedLegacyCodexHome({
      sourceHomePath,
      targetHomePath: options.targetHomePath
    });
    return;
  }

  validateManagedCodexHome(options.managed);
  const managedSkills = resolveManagedSkills(
    options.managed.managedSkillIds,
    options.managed.managedProfilesConfigPath
  );
  seedAuthJsonIfMissing(sourceHomePath, options.targetHomePath);
  // Kirbot-managed boundary: rewrite config.toml and rebuild skills/ on every startup.
  // Runtime-owned state such as auth.json, rules/, superpowers/, and session data stays untouched.
  try {
    stageManagedConfigToml(options.targetHomePath, options.managed.managedConfigToml);
    stageManagedSkills({
      targetHomePath: options.targetHomePath,
      managedSkills
    });
    promoteManagedBoundary(options.targetHomePath);
  } finally {
    fs.rmSync(resolveManagedConfigTomlTempPath(options.targetHomePath), { force: true, recursive: true });
  }
}

function seedLegacyCodexHome(options: {
  targetHomePath: string;
  sourceHomePath: string;
}): void {
  for (const fileName of SEEDED_CODEX_FILES) {
    copyIntoIsolatedHomeIfPresent(join(options.sourceHomePath, fileName), join(options.targetHomePath, fileName));
  }

  for (const directoryName of SEEDED_CODEX_DIRECTORIES) {
    copyIntoIsolatedHomeIfPresent(
      join(options.sourceHomePath, directoryName),
      join(options.targetHomePath, directoryName)
    );
  }
}

function validateManagedCodexHome(managed: ManagedKirbotCodexHome): void {
  if (
    typeof managed.managedConfigToml !== "string" ||
    !Array.isArray(managed.managedSkillIds) ||
    managed.managedSkillIds.some((skillId) => typeof skillId !== "string") ||
    typeof managed.managedProfilesConfigPath !== "string" ||
    managed.managedProfilesConfigPath.length === 0
  ) {
    throw new Error("managed reconciliation requires config.toml, skill ids, and the resolved profiles config path together");
  }
}

function seedAuthJsonIfMissing(sourceHomePath: string, targetHomePath: string): void {
  copyIntoIsolatedHomeIfPresent(join(sourceHomePath, "auth.json"), join(targetHomePath, "auth.json"));
}

function copyIntoIsolatedHomeIfPresent(sourcePath: string, targetPath: string): void {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) {
    return;
  }

  fs.cpSync(sourcePath, targetPath, {
    recursive: true
  });
}

function stageManagedSkills(options: {
  targetHomePath: string;
  managedSkills: readonly ManagedSkillSource[];
}): void {
  // Kirbot-managed boundary: rebuild skills/ exactly; rules/, superpowers/, and runtime files are not managed here.
  const stagedSkillsPath = join(options.targetHomePath, ".kirbot-managed-skills-next");
  let completed = false;

  fs.rmSync(stagedSkillsPath, { force: true, recursive: true });
  fs.mkdirSync(stagedSkillsPath, { recursive: true });

  try {
    for (const skill of options.managedSkills) {
      const targetSkillPath = join(stagedSkillsPath, skill.skillId);

      try {
        fs.symlinkSync(skill.sourceSkillPath, targetSkillPath, "dir");
      } catch {
        fs.cpSync(skill.sourceSkillPath, targetSkillPath, { recursive: true });
      }
    }
    completed = true;
  } finally {
    if (!completed) {
      fs.rmSync(stagedSkillsPath, { force: true, recursive: true });
    }
  }
}

type ManagedSkillSource = {
  skillId: string;
  sourceSkillPath: string;
};

function resolveManagedSkills(
  managedSkillIds: readonly string[],
  managedProfilesConfigPath: string
): ManagedSkillSource[] {
  if (managedSkillIds.length === 0) {
    return [];
  }

  const sourceSkillsRoot = resolveKirbotManagedSkillsPath(managedProfilesConfigPath);
  const managedSkills: ManagedSkillSource[] = [];

  for (const skillId of new Set(managedSkillIds)) {
    if (!isSafeManagedSkillId(skillId)) {
      throw new Error(`Managed skill id "${skillId}" must be a single path segment`);
    }

    const sourceSkillPath = join(sourceSkillsRoot, skillId);
    if (!fs.existsSync(sourceSkillPath)) {
      throw new Error(`Managed skill "${skillId}" is missing from ${sourceSkillPath}`);
    }

    managedSkills.push({ skillId, sourceSkillPath });
  }

  return managedSkills;
}

function resolveKirbotManagedSkillsPath(managedProfilesConfigPath: string): string {
  const skillsPath = resolve(dirname(managedProfilesConfigPath), "..", "skills");

  if (!fs.existsSync(skillsPath)) {
    throw new Error(`Could not locate sibling skills/ directory for ${managedProfilesConfigPath}`);
  }

  return skillsPath;
}

function stageManagedConfigToml(targetHomePath: string, managedConfigToml: string): void {
  fs.writeFileSync(resolveManagedConfigTomlTempPath(targetHomePath), managedConfigToml);
}

function resolveManagedConfigTomlTempPath(targetHomePath: string): string {
  return join(targetHomePath, ".kirbot-managed-config.toml.next");
}

function isSafeManagedSkillId(skillId: string): boolean {
  return skillId.length > 0 && skillId !== "." && skillId !== ".." && !skillId.includes("/") && !skillId.includes("\\");
}

function promoteManagedBoundary(targetHomePath: string): void {
  const configPath = resolveKirbotCodexConfigPath(targetHomePath);
  const stagedConfigPath = resolveManagedConfigTomlTempPath(targetHomePath);
  const stagedSkillsPath = resolveManagedSkillsTempPath(targetHomePath);
  const skillsPath = join(targetHomePath, "skills");
  const configBackupPath = join(targetHomePath, ".kirbot-managed-config.toml.prev");
  const skillsBackupPath = join(targetHomePath, ".kirbot-managed-skills.prev");
  const hadConfig = fs.existsSync(configPath);
  const hadSkills = fs.existsSync(skillsPath);
  let backedUpConfig = false;
  let backedUpSkills = false;
  let promotedConfig = false;
  let promotedSkills = false;
  let cleanupBackups = false;

  fs.rmSync(configBackupPath, { force: true, recursive: true });
  fs.rmSync(skillsBackupPath, { force: true, recursive: true });

  try {
    if (hadConfig) {
      fs.renameSync(configPath, configBackupPath);
      backedUpConfig = true;
    }
    if (hadSkills) {
      fs.renameSync(skillsPath, skillsBackupPath);
      backedUpSkills = true;
    }

    fs.renameSync(stagedConfigPath, configPath);
    promotedConfig = true;
    fs.renameSync(stagedSkillsPath, skillsPath);
    promotedSkills = true;

    cleanupBackups = true;
  } catch (error) {
    try {
      rollbackManagedBoundary({
        configPath,
        stagedConfigPath,
        configBackupPath,
        hadConfig,
        backedUpConfig,
        promotedConfig,
        skillsPath,
        stagedSkillsPath,
        skillsBackupPath,
        hadSkills,
        backedUpSkills,
        promotedSkills
      });
      cleanupBackups = true;
    } catch (rollbackError) {
      throw rollbackError;
    }
    throw error;
  } finally {
    fs.rmSync(stagedConfigPath, { force: true, recursive: true });
    fs.rmSync(stagedSkillsPath, { force: true, recursive: true });
    if (cleanupBackups) {
      fs.rmSync(configBackupPath, { force: true, recursive: true });
      fs.rmSync(skillsBackupPath, { force: true, recursive: true });
    }
  }
}

function rollbackManagedBoundary(options: {
  configPath: string;
  stagedConfigPath: string;
  configBackupPath: string;
  hadConfig: boolean;
  backedUpConfig: boolean;
  promotedConfig: boolean;
  skillsPath: string;
  stagedSkillsPath: string;
  skillsBackupPath: string;
  hadSkills: boolean;
  backedUpSkills: boolean;
  promotedSkills: boolean;
}): void {
  if (options.promotedConfig) {
    fs.rmSync(options.configPath, { force: true, recursive: true });
  }
  if (options.promotedSkills) {
    fs.rmSync(options.skillsPath, { force: true, recursive: true });
  }
  fs.rmSync(options.stagedConfigPath, { force: true, recursive: true });
  fs.rmSync(options.stagedSkillsPath, { force: true, recursive: true });

  if (options.hadConfig && options.backedUpConfig && fs.existsSync(options.configBackupPath)) {
    fs.renameSync(options.configBackupPath, options.configPath);
  }
  if (options.hadSkills && options.backedUpSkills && fs.existsSync(options.skillsBackupPath)) {
    fs.renameSync(options.skillsBackupPath, options.skillsPath);
  }
}

function resolveManagedSkillsTempPath(targetHomePath: string): string {
  return join(targetHomePath, ".kirbot-managed-skills-next");
}

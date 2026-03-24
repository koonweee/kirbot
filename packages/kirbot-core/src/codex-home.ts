import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const MIRROR_EXCLUDED_TOP_LEVEL_NAMES = new Set([
  ".agents",
  ".codex"
]);
const MANAGED_LOCAL_TOP_LEVEL_NAMES = new Set([
  "auth.json",
  "config.toml",
  "skills",
  "sessions",
  "shell_snapshots",
  "tmp",
  "rules",
  "superpowers"
]);
const KIRBOT_INTERNAL_TOP_LEVEL_NAMES = new Set([
  ".kirbot-managed-home-mirror.json",
  ".kirbot-managed-config.toml.next",
  ".kirbot-managed-config.toml.prev",
  ".kirbot-managed-skills-next",
  ".kirbot-managed-skills.prev"
]);
const MIRROR_MANIFEST_FILE = ".kirbot-managed-home-mirror.json";

export type ManagedKirbotCodexHome = {
  managedConfigToml: string;
  managedSkillIds: readonly string[];
  managedProfilesConfigPath: string;
};

export type PrepareKirbotCodexHomeOptions = {
  targetHomePath: string;
  sourceHomePath?: string;
  managed: ManagedKirbotCodexHome;
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
  const sourceHomePath = options.sourceHomePath ?? homedir();
  fs.mkdirSync(options.targetHomePath, { recursive: true });

  validateManagedCodexHome(options.managed);
  const managedSkills = resolveManagedSkills(
    options.managed.managedSkillIds,
    options.managed.managedProfilesConfigPath
  );
  // Kirbot mirrors the real home into the profile home at the top level, but codex-related
  // homes such as `.codex` and `.agents` stay out. Inside the profile home, `config.toml`
  // and `skills/` are Kirbot-managed, while
  // `sessions/`, `shell_snapshots/`, `tmp/`, `rules/`, and `superpowers/` remain runtime-owned.
  reconcileTopLevelHomeMirror(sourceHomePath, options.targetHomePath);
  seedAuthJsonIfMissing(sourceHomePath, options.targetHomePath);
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

function validateManagedCodexHome(managed: ManagedKirbotCodexHome | undefined): void {
  if (
    managed === undefined ||
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
  copyIntoIsolatedHomeIfPresent(join(sourceHomePath, ".codex", "auth.json"), join(targetHomePath, "auth.json"));
}

function copyIntoIsolatedHomeIfPresent(sourcePath: string, targetPath: string): void {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) {
    return;
  }

  fs.cpSync(sourcePath, targetPath, {
    recursive: true
  });
}

function reconcileTopLevelHomeMirror(sourceHomePath: string, targetHomePath: string): void {
  const currentMirroredTopLevelNames = resolveMirrorEligibleTopLevelNames(sourceHomePath, targetHomePath);
  const currentMirroredTopLevelNameSet = new Set(currentMirroredTopLevelNames);
  const previousManifest = readManagedHomeMirrorManifest(targetHomePath);

  for (const previousTopLevelName of previousManifest.mirroredTopLevelNames) {
    if (currentMirroredTopLevelNameSet.has(previousTopLevelName) || isProtectedTopLevelEntryName(previousTopLevelName)) {
      continue;
    }

    fs.rmSync(join(targetHomePath, previousTopLevelName), { force: true, recursive: true });
  }

  for (const topLevelName of currentMirroredTopLevelNames) {
    mirrorTopLevelHomeEntry(sourceHomePath, targetHomePath, topLevelName);
  }

  writeManagedHomeMirrorManifest(targetHomePath, currentMirroredTopLevelNames);
}

function resolveMirrorEligibleTopLevelNames(sourceHomePath: string, targetHomePath: string): string[] {
  const topLevelNameContainingTargetHomePath = resolveTopLevelSourceEntryContainingTargetHomePath(
    sourceHomePath,
    targetHomePath
  );

  return fs
    .readdirSync(sourceHomePath, { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => isMirrorEligibleTopLevelName(name) && name !== topLevelNameContainingTargetHomePath)
    .sort((left, right) => left.localeCompare(right));
}

function isMirrorEligibleTopLevelName(topLevelName: string): boolean {
  return !MIRROR_EXCLUDED_TOP_LEVEL_NAMES.has(topLevelName) && !isProtectedTopLevelEntryName(topLevelName);
}

function isProtectedTopLevelEntryName(topLevelName: string): boolean {
  return MANAGED_LOCAL_TOP_LEVEL_NAMES.has(topLevelName) || KIRBOT_INTERNAL_TOP_LEVEL_NAMES.has(topLevelName);
}

function readManagedHomeMirrorManifest(targetHomePath: string): { mirroredTopLevelNames: string[] } {
  const manifestPath = resolveManagedHomeMirrorManifestPath(targetHomePath);

  if (!fs.existsSync(manifestPath)) {
    return { mirroredTopLevelNames: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<{ mirroredTopLevelNames: unknown }>;
    const mirroredTopLevelNames = Array.isArray(parsed.mirroredTopLevelNames)
      ? parsed.mirroredTopLevelNames.filter((name): name is string => typeof name === "string")
      : [];

    return {
      mirroredTopLevelNames: mirroredTopLevelNames.filter(
        (name) => isSafeSinglePathSegment(name) && !isProtectedTopLevelEntryName(name)
      )
    };
  } catch {
    return { mirroredTopLevelNames: [] };
  }
}

function writeManagedHomeMirrorManifest(targetHomePath: string, mirroredTopLevelNames: readonly string[]): void {
  fs.writeFileSync(
    resolveManagedHomeMirrorManifestPath(targetHomePath),
    JSON.stringify(
      {
        mirroredTopLevelNames: [...new Set(mirroredTopLevelNames)].sort((left, right) => left.localeCompare(right))
      },
      null,
      2
    )
  );
}

function resolveManagedHomeMirrorManifestPath(targetHomePath: string): string {
  return join(targetHomePath, MIRROR_MANIFEST_FILE);
}

function mirrorTopLevelHomeEntry(sourceHomePath: string, targetHomePath: string, topLevelName: string): void {
  const sourcePath = join(sourceHomePath, topLevelName);
  const targetPath = join(targetHomePath, topLevelName);

  fs.rmSync(targetPath, { force: true, recursive: true });
  fs.symlinkSync(sourcePath, targetPath, resolveSymlinkType(sourcePath));
}

function resolveTopLevelSourceEntryContainingTargetHomePath(
  sourceHomePath: string,
  targetHomePath: string
): string | undefined {
  const relativeTargetHomePath = relative(sourceHomePath, targetHomePath);

  if (relativeTargetHomePath.length === 0 || relativeTargetHomePath.startsWith("..") || isAbsolute(relativeTargetHomePath)) {
    return undefined;
  }

  const [topLevelSourceEntryName] = relativeTargetHomePath.split(/[\\/]/, 1);

  return isSafeSinglePathSegment(topLevelSourceEntryName) ? topLevelSourceEntryName : undefined;
}

function resolveSymlinkType(sourcePath: string): fs.symlink.Type {
  try {
    return fs.statSync(sourcePath).isDirectory() ? "dir" : "file";
  } catch {
    return "file";
  }
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
  return isSafeSinglePathSegment(skillId);
}

function isSafeSinglePathSegment(pathSegment: string): boolean {
  return pathSegment.length > 0 && pathSegment !== "." && pathSegment !== ".." && !pathSegment.includes("/") && !pathSegment.includes("\\");
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

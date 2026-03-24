import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import type { AskForApproval } from "@kirbot/codex-client/generated/codex/v2/AskForApproval";
import type { SandboxMode } from "@kirbot/codex-client/generated/codex/v2/SandboxMode";
import type { JsonValue } from "@kirbot/codex-client/generated/codex/serde_json/JsonValue";

export type CodexProfileId = string;

export type CodexProfileConfig = {
  homePath: string;
  model: string | undefined;
  sandboxMode: SandboxMode | undefined;
  approvalPolicy: AskForApproval | undefined;
  skills: string[];
  mcps: string[];
};

export type CodexProfilesConfig = {
  routes: Record<string, CodexProfileId>;
  skills: Record<string, Record<string, JsonValue | undefined>>;
  mcps: Record<string, Record<string, JsonValue | undefined>>;
  profiles: Record<string, CodexProfileConfig>;
};

const sandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

const approvalPolicySchema = z.union([
  z.enum(["untrusted", "on-failure", "on-request", "never"]),
  z
    .object({
      granular: z
        .object({
          sandbox_approval: z.boolean(),
          rules: z.boolean(),
          skill_approval: z.boolean(),
          request_permissions: z.boolean(),
          mcp_elicitations: z.boolean()
        })
        .strict()
    })
    .strict()
]) as z.ZodType<AskForApproval>;

const codexProfileSourceSchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    sandboxMode: sandboxModeSchema.optional(),
    approvalPolicy: approvalPolicySchema.optional(),
    skills: z.array(z.string().min(1)).optional(),
    mcps: z.array(z.string().min(1)).optional()
  })
  .strict();

const codexProfilesSourceSchema = z
  .object({
    routes: z
      .object({
        general: z.string().min(1),
        thread: z.string().min(1),
        plan: z.string().min(1)
      })
      .catchall(z.string().min(1)),
    skills: z.record(z.string(), z.record(z.string(), jsonValueSchema)).default({}),
    mcps: z.record(z.string(), z.record(z.string(), jsonValueSchema)).default({}),
    profiles: z.record(z.string(), codexProfileSourceSchema)
  })
  .strict();

type CodexProfilesSourceConfig = z.infer<typeof codexProfilesSourceSchema>;

export function parseCodexProfilesConfig(
  value: string,
  options: {
    configPath: string;
    databasePath: string;
  }
): CodexProfilesConfig {
  const parsed = codexProfilesSourceSchema.parse(JSON.parse(value)) as CodexProfilesSourceConfig;
  const issues: z.ZodIssue[] = [];
  const profiles: CodexProfilesConfig["profiles"] = {};
  const skillUsage = new Set<string>();
  const mcpUsage = new Set<string>();
  const seenHomePaths = new Map<string, string>();
  const baseHomeDir = resolve(dirname(options.databasePath), "homes");
  const repoSkillsDir = resolve(dirname(options.configPath), "..", "skills");

  for (const skillId of Object.keys(parsed.skills)) {
    if (!isSafeSkillId(skillId)) {
      issues.push({
        code: "custom",
        path: ["skills", skillId],
        message: `declared skill id ${JSON.stringify(skillId)} must be a single path segment without path separators or traversal`
      });
    }
  }

  for (const [mcpId, mcpConfig] of Object.entries(parsed.mcps)) {
    validateManagedTomlValue(mcpConfig, issues, ["mcps", mcpId]);
  }

  for (const [routeName, profileId] of Object.entries(parsed.routes)) {
    if (!(profileId in parsed.profiles)) {
      issues.push({
        code: "custom",
        path: ["routes", routeName],
        message: `routing target ${JSON.stringify(profileId)} references an undeclared profile`
      });
    }
  }

  const generalProfileId = parsed.routes.general;
  for (const [routeName, profileId] of Object.entries(parsed.routes)) {
    if (routeName === "general" || profileId !== generalProfileId) {
      continue;
    }

    issues.push({
      code: "custom",
      path: ["routes", "general"],
      message: `routes.general must use a dedicated profile and cannot share ${JSON.stringify(profileId)} with routes.${routeName}`
    });
  }

  for (const [profileId, profile] of Object.entries(parsed.profiles)) {
    if (!isSafeProfileId(profileId)) {
      issues.push({
        code: "custom",
        path: ["profiles", profileId],
        message: `profile id ${JSON.stringify(profileId)} must be a single path segment without path separators or traversal`
      });
      continue;
    }

    const homePath = resolve(baseHomeDir, profileId);
    const existingProfileId = seenHomePaths.get(homePath);
    if (existingProfileId) {
      issues.push({
        code: "custom",
        path: ["profiles", profileId, "homePath"],
        message: `generated home path ${JSON.stringify(homePath)} for profile ${profileId} collides with profile ${existingProfileId}`
      });
    } else {
      seenHomePaths.set(homePath, profileId);
    }

    const profileSkills = profile.skills ?? [];
    const profileMcps = profile.mcps ?? [];

    for (const [index, skillId] of profileSkills.entries()) {
      if (!isSafeSkillId(skillId)) {
        issues.push({
          code: "custom",
          path: ["profiles", profileId, "skills", index],
          message: `profile ${profileId} references invalid skill id ${JSON.stringify(skillId)}; skill ids must be a single path segment without path separators or traversal`
        });
        continue;
      }

      if (!(skillId in parsed.skills)) {
        issues.push({
          code: "custom",
          path: ["profiles", profileId, "skills", index],
          message: `profile ${profileId} references undeclared skill ${JSON.stringify(skillId)}`
        });
        continue;
      }

      skillUsage.add(skillId);
      validateProfileSkillDirectory(profileId, skillId, repoSkillsDir, issues, ["profiles", profileId, "skills", index]);
    }

    for (const [index, mcpId] of profileMcps.entries()) {
      if (!(mcpId in parsed.mcps)) {
        issues.push({
          code: "custom",
          path: ["profiles", profileId, "mcps", index],
          message: `profile ${profileId} references undeclared MCP key ${JSON.stringify(mcpId)}`
        });
        continue;
      }

      mcpUsage.add(mcpId);
    }

    profiles[profileId] = {
      homePath,
      model: profile.model,
      sandboxMode: profile.sandboxMode,
      approvalPolicy: profile.approvalPolicy,
      skills: profileSkills,
      mcps: profileMcps
    };
  }

  if (issues.length > 0) {
    throw new z.ZodError(issues);
  }

  for (const skillId of Object.keys(parsed.skills)) {
    if (!skillUsage.has(skillId)) {
      console.warn(`Unused declared skill id ${skillId}`);
    }
  }

  warnAboutStraySkillsFolders(repoSkillsDir, parsed.skills);

  for (const mcpId of Object.keys(parsed.mcps)) {
    if (!mcpUsage.has(mcpId)) {
      console.warn(`Unused MCP registry entry ${mcpId}`);
    }
  }

  return {
    routes: parsed.routes,
    skills: parsed.skills,
    mcps: parsed.mcps,
    profiles
  };
}

export function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return `${homedir()}${value.slice(1)}`;
  }

  return value;
}

function validateProfileSkillDirectory(
  profileId: string,
  skillId: string,
  repoSkillsDir: string,
  issues: z.ZodIssue[],
  path: Array<string | number>
): void {
  const skillDir = resolve(repoSkillsDir, skillId);
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
    issues.push({
      code: "custom",
      path,
      message: `profile ${profileId} references missing skill directory ${skillDir}`
    });
    return;
  }

  const skillReadme = resolve(skillDir, "SKILL.md");
  if (!existsSync(skillReadme)) {
    issues.push({
      code: "custom",
      path,
      message: `profile ${profileId} skill directory ${skillDir} is missing SKILL.md`
    });
  }
}

function warnAboutStraySkillsFolders(
  repoSkillsDir: string,
  declaredSkills: Record<string, Record<string, JsonValue | undefined>>
): void {
  if (!existsSync(repoSkillsDir) || !statSync(repoSkillsDir).isDirectory()) {
    return;
  }

  const declaredSkillIds = new Set(Object.keys(declaredSkills));
  for (const entry of readdirSync(repoSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || declaredSkillIds.has(entry.name)) {
      continue;
    }

    console.warn(`Repo-local skills/ folder ${entry.name} has no matching declared skill id`);
  }
}

function validateManagedTomlValue(value: JsonValue, issues: z.ZodIssue[], path: Array<string | number>): void {
  if (value === null) {
    issues.push({
      code: "custom",
      path,
      message: "managed MCP config does not support null TOML values"
    });
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      validateManagedTomlValue(entry, issues, [...path, index]);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      validateManagedTomlValue(entry!, issues, [...path, key]);
    }
  }
}

function homedir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "/";
}

function isSafeSkillId(skillId: string): boolean {
  return isSafePathSegment(skillId);
}

function isSafeProfileId(profileId: string): boolean {
  return isSafePathSegment(profileId);
}

function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

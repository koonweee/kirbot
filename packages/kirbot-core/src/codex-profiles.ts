import { z } from "zod";
import { homedir } from "node:os";
import { resolve } from "node:path";

const codexProfileSchema = z.object({
  homePath: z.string().min(1)
});

const codexProfilesConfigSchema = z
  .object({
    profiles: z.record(z.string(), codexProfileSchema),
    routing: z
      .object({
        general: z.string().min(1),
        thread: z.string().min(1),
        plan: z.string().min(1)
      })
      .catchall(z.string().min(1))
  })
  .superRefine((value, ctx) => {
    for (const [entrypoint, profileId] of Object.entries(value.routing)) {
      if (!(profileId in value.profiles)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["routing", entrypoint],
          message: `routing target ${JSON.stringify(profileId)} references an undeclared profile`
        });
      }
    }

    for (const [entrypoint, profileId] of Object.entries(value.routing)) {
      if (entrypoint === "general" || profileId !== value.routing.general) {
        continue;
      }

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["routing", "general"],
        message: `routing.general must use a dedicated profile and cannot share ${JSON.stringify(profileId)} with routing.${entrypoint}`
      });
    }
  });

export type CodexProfileId = string;

export type CodexProfilesConfig = {
  profiles: Record<string, { homePath: string }>;
  routing: {
    general: string;
    thread: string;
    plan: string;
    [entrypoint: string]: string;
  };
};

export function parseCodexProfilesConfig(value: string): CodexProfilesConfig {
  const parsed = codexProfilesConfigSchema.parse(JSON.parse(value)) as CodexProfilesConfig;
  const profiles: CodexProfilesConfig["profiles"] = {};
  const seenHomePaths = new Map<string, string>();

  for (const [profileId, profile] of Object.entries(parsed.profiles)) {
    const homePath =
      profile.homePath === "~"
        ? failBareHomeRoot(profileId)
        : canonicalizeHomePath(profile.homePath);
    const existingProfileId = seenHomePaths.get(homePath);
    if (existingProfileId) {
      throw new Error(
        `Codex profiles ${existingProfileId} and ${profileId} must not share the same homePath`
      );
    }

    seenHomePaths.set(homePath, profileId);
    profiles[profileId] = { homePath };
  }

  return {
    ...parsed,
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

function canonicalizeHomePath(value: string): string {
  return resolve(expandHomePath(value));
}

function failBareHomeRoot(profileId: string): never {
  throw new Error(`Codex profile ${profileId} homePath must not be the user home root`);
}

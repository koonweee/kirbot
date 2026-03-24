import { z } from "zod";

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
  return codexProfilesConfigSchema.parse(JSON.parse(value)) as CodexProfilesConfig;
}

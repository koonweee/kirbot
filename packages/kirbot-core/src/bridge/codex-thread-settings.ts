import type { ReasoningEffort } from "@kirbot/codex-client/generated/codex/ReasoningEffort";
import type { ServiceTier } from "@kirbot/codex-client/generated/codex/ServiceTier";
import type { AskForApproval } from "@kirbot/codex-client/generated/codex/v2/AskForApproval";
import type { SandboxPolicy } from "@kirbot/codex-client/generated/codex/v2/SandboxPolicy";

export type CodexThreadSettings = {
  model: string;
  reasoningEffort: ReasoningEffort | null;
  serviceTier: ServiceTier | null;
  approvalPolicy: AskForApproval;
  sandboxPolicy: SandboxPolicy;
};

export type CodexThreadSettingsOverride = Partial<CodexThreadSettings>;

export type StoredCodexThreadSettings = {
  current: CodexThreadSettings | null;
  pending: CodexThreadSettingsOverride | null;
};

export type CodexPermissionPresetId = "read-only" | "default" | "full-access";

export type CodexPermissionPreset = {
  id: CodexPermissionPresetId;
  label: string;
  description: string;
  approvalPolicy: AskForApproval;
  sandboxPolicy: SandboxPolicy;
};

const DEFAULT_READ_ONLY_ACCESS = {
  type: "fullAccess"
} satisfies Extract<SandboxPolicy, { type: "readOnly" }>["access"];

export const CODEX_PERMISSION_PRESETS: readonly CodexPermissionPreset[] = [
  {
    id: "read-only",
    label: "Read Only",
    description:
      "Codex can read files in the current workspace. Approval is required to edit files or access the internet.",
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "readOnly",
      access: DEFAULT_READ_ONLY_ACCESS,
      networkAccess: false
    }
  },
  {
    id: "default",
    label: "Default",
    description:
      "Codex can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files.",
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [],
      readOnlyAccess: DEFAULT_READ_ONLY_ACCESS,
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  },
  {
    id: "full-access",
    label: "Full Access",
    description:
      "Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using.",
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "dangerFullAccess"
    }
  }
] as const;

export function createEmptyStoredCodexThreadSettings(): StoredCodexThreadSettings {
  return {
    current: null,
    pending: null
  };
}

export function normalizeStoredCodexThreadSettings(value: unknown): StoredCodexThreadSettings {
  if (!value || typeof value !== "object") {
    return createEmptyStoredCodexThreadSettings();
  }

  const parsed = value as Partial<StoredCodexThreadSettings>;
  return {
    current: isCodexThreadSettings(parsed.current) ? parsed.current : null,
    pending: isCodexThreadSettingsOverride(parsed.pending) ? parsed.pending : null
  };
}

export function applyCodexThreadSettingsOverride(
  current: CodexThreadSettings,
  override: CodexThreadSettingsOverride | null | undefined
): CodexThreadSettings {
  if (!override) {
    return current;
  }

  return {
    ...current,
    ...override
  };
}

export function getEffectiveCodexThreadSettings(
  stored: StoredCodexThreadSettings | null | undefined
): CodexThreadSettings | null {
  if (!stored?.current) {
    return null;
  }

  return applyCodexThreadSettingsOverride(stored.current, stored.pending);
}

export function hasPendingCodexThreadSettings(
  stored: StoredCodexThreadSettings | null | undefined
): boolean {
  return !!stored?.pending && Object.keys(stored.pending).length > 0;
}

export function withUpdatedCurrentCodexThreadSettings(
  stored: StoredCodexThreadSettings | null | undefined,
  current: CodexThreadSettings
): StoredCodexThreadSettings {
  return {
    current,
    pending: stored?.pending ?? null
  };
}

export function withUpdatedPendingCodexThreadSettings(
  stored: StoredCodexThreadSettings | null | undefined,
  pending: CodexThreadSettingsOverride | null
): StoredCodexThreadSettings {
  return {
    current: stored?.current ?? null,
    pending: pending && Object.keys(pending).length > 0 ? pending : null
  };
}

export function clearPendingCodexThreadSettings(
  stored: StoredCodexThreadSettings | null | undefined
): StoredCodexThreadSettings {
  return {
    current: stored?.current ?? null,
    pending: null
  };
}

export function getCodexPermissionPreset(
  presetId: CodexPermissionPresetId
): CodexPermissionPreset {
  const preset = CODEX_PERMISSION_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) {
    throw new Error(`Unknown Codex permission preset: ${presetId}`);
  }

  return preset;
}

export function detectCodexPermissionPreset(
  settings: Pick<CodexThreadSettings, "approvalPolicy" | "sandboxPolicy"> | null | undefined
): CodexPermissionPresetId | null {
  if (!settings) {
    return null;
  }

  for (const preset of CODEX_PERMISSION_PRESETS) {
    if (
      settings.approvalPolicy === preset.approvalPolicy &&
      sandboxPoliciesMatchPreset(settings.sandboxPolicy, preset.sandboxPolicy)
    ) {
      return preset.id;
    }
  }

  return null;
}

function sandboxPoliciesMatchPreset(left: SandboxPolicy, right: SandboxPolicy): boolean {
  if (left.type !== right.type) {
    return false;
  }

  switch (left.type) {
    case "dangerFullAccess":
      return true;
    case "readOnly":
      return right.type === "readOnly" && left.networkAccess === right.networkAccess;
    case "workspaceWrite":
      return right.type === "workspaceWrite" && left.networkAccess === right.networkAccess;
    case "externalSandbox":
      return right.type === "externalSandbox" && left.networkAccess === right.networkAccess;
  }
}

function isCodexThreadSettings(value: unknown): value is CodexThreadSettings {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<CodexThreadSettings>;
  return (
    typeof candidate.model === "string" &&
    "reasoningEffort" in candidate &&
    "serviceTier" in candidate &&
    "approvalPolicy" in candidate &&
    !!candidate.sandboxPolicy
  );
}

function isCodexThreadSettingsOverride(value: unknown): value is CodexThreadSettingsOverride {
  return !!value && typeof value === "object";
}

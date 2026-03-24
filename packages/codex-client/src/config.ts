import type { AskForApproval } from "./generated/codex/v2/AskForApproval";
import type { SandboxMode } from "./generated/codex/v2/SandboxMode";
import type { JsonValue } from "./generated/codex/serde_json/JsonValue";

export type CodexConfig = {
  defaultCwd: string;
  homePath?: string;
  model: string | undefined;
  modelProvider: string | undefined;
  sandbox: SandboxMode | undefined;
  approvalPolicy: AskForApproval | undefined;
  serviceName: string;
  developerInstructions: string | undefined;
  config: Record<string, JsonValue | undefined> | undefined;
};

export type AppConfig = {
  codex: CodexConfig;
};

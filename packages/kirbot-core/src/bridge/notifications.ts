import type { ServerNotification } from "@kirbot/codex-client/generated/codex/ServerNotification";

export function getNotificationTurnId(notification: ServerNotification): string | null {
  switch (notification.method) {
    case "turn/started":
    case "turn/completed":
      return notification.params.turn.id;
    case "item/started":
    case "turn/plan/updated":
    case "thread/tokenUsage/updated":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "model/rerouted":
    case "item/mcpToolCall/progress":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/completed":
    case "error":
      return notification.params.turnId;
    default:
      return null;
  }
}

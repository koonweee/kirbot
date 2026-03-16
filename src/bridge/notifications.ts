import type { ServerNotification } from "../generated/codex/ServerNotification";

export function getNotificationTurnId(notification: ServerNotification): string | null {
  switch (notification.method) {
    case "turn/started":
    case "turn/completed":
      return notification.params.turn.id;
    case "item/started":
    case "turn/plan/updated":
    case "item/reasoning/summaryTextDelta":
    case "item/mcpToolCall/progress":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/agentMessage/delta":
    case "item/completed":
    case "error":
      return notification.params.turnId;
    default:
      return null;
  }
}

import type { UserInput } from "../generated/codex/v2/UserInput";

export function buildUserInputSignature(input: UserInput[]): string {
  return JSON.stringify(
    input.map((item) => {
      if (item.type === "text") {
        return {
          type: "text",
          text: item.text
        };
      }

      if (item.type === "localImage") {
        return {
          type: "localImage",
          path: item.path
        };
      }

      if (item.type === "image") {
        return {
          type: "image",
          url: item.url
        };
      }

      return item;
    })
  );
}

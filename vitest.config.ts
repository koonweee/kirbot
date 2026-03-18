import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@kirbot\/core$/,
        replacement: fileURLToPath(new URL("./packages/kirbot-core/src/index.ts", import.meta.url))
      },
      {
        find: /^@kirbot\/core\/(.*)$/,
        replacement: fileURLToPath(new URL("./packages/kirbot-core/src/$1", import.meta.url))
      },
      {
        find: /^@kirbot\/codex-client$/,
        replacement: fileURLToPath(new URL("./packages/codex-client/src/index.ts", import.meta.url))
      },
      {
        find: /^@kirbot\/codex-client\/(.*)$/,
        replacement: fileURLToPath(new URL("./packages/codex-client/src/$1", import.meta.url))
      },
      {
        find: /^@kirbot\/telegram-format$/,
        replacement: fileURLToPath(new URL("./packages/telegram-format/src/index.ts", import.meta.url))
      },
      {
        find: /^@kirbot\/telegram-format\/(.*)$/,
        replacement: fileURLToPath(new URL("./packages/telegram-format/src/$1", import.meta.url))
      },
      {
        find: /^@kirbot\/telegram-harness$/,
        replacement: fileURLToPath(new URL("./packages/telegram-harness/src/index.ts", import.meta.url))
      },
      {
        find: /^@kirbot\/telegram-harness\/(.*)$/,
        replacement: fileURLToPath(new URL("./packages/telegram-harness/src/$1", import.meta.url))
      }
    ],
    conditions: ["development"]
  },
  test: {
    environment: "node",
    include: ["apps/*/tests/**/*.test.ts", "packages/*/tests/**/*.test.ts"]
  }
});

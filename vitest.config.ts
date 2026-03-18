import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@kirbot\/core$/,
        replacement: resolve(__dirname, "./packages/kirbot-core/src/index.ts")
      },
      {
        find: /^@kirbot\/core\/(.*)$/,
        replacement: resolve(__dirname, "./packages/kirbot-core/src/$1")
      },
      {
        find: /^@kirbot\/codex-client$/,
        replacement: resolve(__dirname, "./packages/codex-client/src/index.ts")
      },
      {
        find: /^@kirbot\/codex-client\/(.*)$/,
        replacement: resolve(__dirname, "./packages/codex-client/src/$1")
      },
      {
        find: /^@kirbot\/telegram-format$/,
        replacement: resolve(__dirname, "./packages/telegram-format/src/index.ts")
      },
      {
        find: /^@kirbot\/telegram-format\/(.*)$/,
        replacement: resolve(__dirname, "./packages/telegram-format/src/$1")
      },
      {
        find: /^@kirbot\/telegram-harness$/,
        replacement: resolve(__dirname, "./packages/telegram-harness/src/index.ts")
      },
      {
        find: /^@kirbot\/telegram-harness\/(.*)$/,
        replacement: resolve(__dirname, "./packages/telegram-harness/src/$1")
      }
    ],
    conditions: ["development"]
  },
  test: {
    environment: "node",
    include: ["apps/*/tests/**/*.test.ts", "packages/*/tests/**/*.test.ts"]
  }
});

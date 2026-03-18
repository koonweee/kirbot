import { resolve } from "node:path";
import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

export default defineConfig({
  resolve: {
    alias: {
      "@kirbot/core/mini-app/url": resolve(__dirname, "../../packages/kirbot-core/src/mini-app/url.ts")
    }
  },
  plugins: [sveltekit()]
});

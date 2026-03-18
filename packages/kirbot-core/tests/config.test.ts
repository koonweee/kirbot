import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

describe("core config module", () => {
  it("does not require Telegram env vars just to import the package surface", async () => {
    process.env = {};

    const core = await import("../src/index");

    expect(core.loadConfig).toBeTypeOf("function");
  });
});

import { describe, expect, it } from "vitest";

import { hasFlushBoundary, splitFlushablePrefix } from "@kirbot/core/bridge/stream-boundaries";

describe("stream boundaries", () => {
  it("flushes on sentence endings", () => {
    expect(hasFlushBoundary("Hello world.")).toBe(true);
    expect(splitFlushablePrefix("Hello world. More text")).toEqual(["Hello world.", " More text"]);
  });

  it("flushes on paragraph breaks", () => {
    expect(splitFlushablePrefix("First paragraph.\n\nSecond paragraph")).toEqual([
      "First paragraph.\n\n",
      "Second paragraph"
    ]);
  });

  it("flushes on structured line breaks", () => {
    expect(splitFlushablePrefix("- Step one\n- Step two")).toEqual(["- Step one\n", "- Step two"]);
    expect(splitFlushablePrefix("1. First\n2. Second")).toEqual(["1. First\n", "2. Second"]);
  });

  it("does not flush mid code fence", () => {
    expect(hasFlushBoundary("```ts\nconst answer = 42;\n")).toBe(false);
    expect(splitFlushablePrefix("```ts\nconst answer = 42;\n")).toEqual(["", "```ts\nconst answer = 42;\n"]);
  });
});

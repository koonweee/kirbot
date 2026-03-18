import { describe, expect, it } from "vitest";
import { compressToEncodedURIComponent } from "lz-string";

import {
  buildMiniAppArtifactUrl,
  decodeMiniAppArtifact,
  encodeMiniAppArtifact,
  getEncodedMiniAppArtifactFromHash,
  MAX_MINI_APP_ARTIFACT_URL_LENGTH,
  MiniAppArtifactType
} from "../src/mini-app/url";

describe("Mini App URL codec", () => {
  it("round-trips plan artifacts through the encoded fragment payload", () => {
    const artifact = {
      v: 1 as const,
      type: MiniAppArtifactType.Plan,
      title: "Plan",
      markdownText: "1. Draft the rollout"
    };

    const encoded = encodeMiniAppArtifact(artifact);
    expect(decodeMiniAppArtifact(encoded)).toEqual(artifact);
  });

  it("builds plan URLs with compressed hash payloads", () => {
    const url = buildMiniAppArtifactUrl("https://example.com/mini-app", {
      v: 1,
      type: MiniAppArtifactType.Plan,
      title: "Plan",
      markdownText: "1. Draft the rollout"
    });

    expect(url.startsWith("https://example.com/mini-app/plan#d=")).toBe(true);
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url).hash);
    expect(encoded).toBeTruthy();
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Plan,
      title: "Plan",
      markdownText: "1. Draft the rollout"
    });
  });

  it("rejects unsupported artifact versions", () => {
    const encoded = compressToEncodedURIComponent(
      JSON.stringify({
        v: 2,
        type: MiniAppArtifactType.Plan,
        title: "Plan",
        markdownText: "1. Draft the rollout"
      })
    );

    expect(() => decodeMiniAppArtifact(encoded)).toThrow("unsupported_artifact_version");
  });

  it("rejects oversize Mini App URLs", () => {
    const markdownText = Array.from({ length: 300 }, (_, index) =>
      `${index + 1}. ${Array.from({ length: 20 }, (__unused, wordIndex) => `token-${index}-${wordIndex}`).join(" ")}`
    ).join("\n");

    expect(() =>
      buildMiniAppArtifactUrl("https://example.com/mini-app", {
        v: 1,
        type: MiniAppArtifactType.Plan,
        title: "Plan",
        markdownText
      })
    ).toThrow("mini_app_artifact_too_large");
  });

  it("uses the documented URL budget", () => {
    expect(MAX_MINI_APP_ARTIFACT_URL_LENGTH).toBe(12_000);
  });
});

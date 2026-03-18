import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";

export const MAX_MINI_APP_ARTIFACT_URL_LENGTH = 12_000;
export const MINI_APP_ARTIFACT_FRAGMENT_KEY = "d";
export const MINI_APP_ARTIFACT_VERSION = 1;

export enum MiniAppArtifactType {
  Plan = "plan",
  Commentary = "commentary",
  Response = "response"
}

type MiniAppMarkdownArtifactBase = {
  v: typeof MINI_APP_ARTIFACT_VERSION;
  title: string;
  markdownText: string;
};

export type MiniAppPlanArtifact = MiniAppMarkdownArtifactBase & {
  type: MiniAppArtifactType.Plan;
};

export type MiniAppCommentaryArtifact = MiniAppMarkdownArtifactBase & {
  type: MiniAppArtifactType.Commentary;
};

export type MiniAppResponseArtifact = MiniAppMarkdownArtifactBase & {
  type: MiniAppArtifactType.Response;
};

export type MiniAppArtifact = MiniAppPlanArtifact | MiniAppCommentaryArtifact | MiniAppResponseArtifact;

export function encodeMiniAppArtifact(artifact: MiniAppArtifact): string {
  return compressToEncodedURIComponent(JSON.stringify(validateMiniAppArtifact(artifact)));
}

export function decodeMiniAppArtifact(encoded: string): MiniAppArtifact {
  const json = decompressFromEncodedURIComponent(encoded);
  if (!json) {
    throw new Error("invalid_compressed_artifact");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("invalid_artifact_json");
  }

  return validateMiniAppArtifact(parsed);
}

export function getEncodedMiniAppArtifactFromHash(hash: string): string | null {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(normalized);
  const encoded = params.get(MINI_APP_ARTIFACT_FRAGMENT_KEY)?.trim() ?? "";
  return encoded.length > 0 ? encoded : null;
}

export function buildMiniAppArtifactUrl(publicUrl: string, artifact: MiniAppArtifact): string {
  const normalizedBaseUrl = publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`;
  const url = new URL("plan", normalizedBaseUrl);
  url.hash = buildMiniAppArtifactHash(artifact);
  const rendered = url.toString();
  if (rendered.length > MAX_MINI_APP_ARTIFACT_URL_LENGTH) {
    throw new Error("mini_app_artifact_too_large");
  }

  return rendered;
}

export function buildMiniAppArtifactHash(artifact: MiniAppArtifact): string {
  const params = new URLSearchParams();
  params.set(MINI_APP_ARTIFACT_FRAGMENT_KEY, encodeMiniAppArtifact(artifact));
  return params.toString();
}

function validateMiniAppArtifact(value: unknown): MiniAppArtifact {
  if (!value || typeof value !== "object") {
    throw new Error("invalid_artifact_shape");
  }

  const artifact = value as Partial<MiniAppArtifact> & Record<string, unknown>;
  if (artifact.v !== MINI_APP_ARTIFACT_VERSION) {
    throw new Error("unsupported_artifact_version");
  }

  switch (artifact.type) {
    case MiniAppArtifactType.Plan:
    case MiniAppArtifactType.Commentary:
    case MiniAppArtifactType.Response:
      if (typeof artifact.title !== "string" || typeof artifact.markdownText !== "string") {
        throw new Error(`invalid_${artifact.type}_artifact`);
      }

      return {
        v: MINI_APP_ARTIFACT_VERSION,
        type: artifact.type,
        title: artifact.title,
        markdownText: artifact.markdownText
      };
    default:
      throw new Error("unsupported_artifact_type");
  }
}

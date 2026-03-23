import type { ThreadItem } from "@kirbot/codex-client/generated/codex/v2/ThreadItem";

const GENERATED_IMAGE_FETCH_TIMEOUT_MS = 15_000;
const GENERATED_IMAGE_MAX_BYTES = 12_000_000;

type ImageGenerationItem = Extract<ThreadItem, { type: "imageGeneration" }>;

export type GeneratedImagePublicationFailureStage = "invalid_url" | "download" | "validation";

export type UploadReadyGeneratedImage = {
  bytes: Uint8Array;
  fileName: string | null;
  mimeType: string;
  url: string;
};

export class GeneratedImagePublicationError extends Error {
  constructor(
    readonly stage: GeneratedImagePublicationFailureStage,
    readonly url: string,
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = "GeneratedImagePublicationError";
    if (cause !== undefined) {
      Object.assign(this, { cause });
    }
  }
}

export function isImageGenerationSuccess(item: ImageGenerationItem): boolean {
  return item.status === "completed" && item.result.trim().length > 0;
}

export async function fetchUploadReadyGeneratedImage(item: ImageGenerationItem): Promise<UploadReadyGeneratedImage> {
  const url = parseGeneratedImageUrl(item.result);
  const response = await fetchGeneratedImage(url);
  const mimeType = getImageMimeType(response, url.href);
  const contentLength = parseContentLength(response);

  if (contentLength !== null && contentLength > GENERATED_IMAGE_MAX_BYTES) {
    throw new GeneratedImagePublicationError("validation", url.href, "Generated image exceeds the size limit");
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new GeneratedImagePublicationError("download", url.href, "Failed to read generated image bytes", error);
  }

  if (bytes.byteLength > GENERATED_IMAGE_MAX_BYTES) {
    throw new GeneratedImagePublicationError("validation", url.href, "Generated image exceeds the size limit");
  }

  return {
    bytes,
    fileName: deriveGeneratedImageFileName(url),
    mimeType,
    url: url.href
  };
}

function parseGeneratedImageUrl(rawUrl: string): URL {
  const trimmedUrl = rawUrl.trim();

  let url: URL;
  try {
    url = new URL(trimmedUrl);
  } catch (error) {
    throw new GeneratedImagePublicationError("invalid_url", trimmedUrl, "Generated image URL is invalid", error);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GeneratedImagePublicationError("invalid_url", url.href, "Generated image URL must use http or https");
  }

  return url;
}

async function fetchGeneratedImage(url: URL): Promise<Response> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), GENERATED_IMAGE_FETCH_TIMEOUT_MS);

  try {
    const response = await globalThis.fetch(url.href, {
      signal: abortController.signal
    });

    if (!response.ok) {
      throw new GeneratedImagePublicationError(
        "download",
        url.href,
        `Generated image download failed with status ${response.status}`
      );
    }

    return response;
  } catch (error) {
    if (error instanceof GeneratedImagePublicationError) {
      throw error;
    }

    throw new GeneratedImagePublicationError("download", url.href, "Failed to download generated image", error);
  } finally {
    clearTimeout(timeout);
  }
}

function getImageMimeType(response: Response, url: string): string {
  const rawContentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!rawContentType.startsWith("image/")) {
    throw new GeneratedImagePublicationError("validation", url, "Generated image response was not an image");
  }

  return rawContentType;
}

function parseContentLength(response: Response): number | null {
  const rawContentLength = response.headers.get("content-length")?.trim();
  if (!rawContentLength) {
    return null;
  }

  const contentLength = Number.parseInt(rawContentLength, 10);
  return Number.isFinite(contentLength) ? contentLength : null;
}

function deriveGeneratedImageFileName(url: URL): string | null {
  const lastPathSegment = url.pathname.split("/").pop()?.trim() ?? "";
  if (!lastPathSegment) {
    return null;
  }

  try {
    return decodeURIComponent(lastPathSegment);
  } catch {
    return lastPathSegment;
  }
}

import { isIP } from "node:net";
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
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort(new DOMException("Generated image download timed out", "TimeoutError"));
  }, GENERATED_IMAGE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchGeneratedImage(url, abortController.signal);
    const mimeType = getImageMimeType(response, url.href);
    const contentLength = parseContentLength(response);

    if (contentLength !== null && contentLength > GENERATED_IMAGE_MAX_BYTES) {
      throw new GeneratedImagePublicationError("validation", url.href, "Generated image exceeds the size limit");
    }

    const bytes = await readGeneratedImageBytes(response, url.href, abortController.signal);
    return {
      bytes,
      fileName: deriveGeneratedImageFileName(url),
      mimeType,
      url: url.href
    };
  } finally {
    clearTimeout(timeout);
  }
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

  if (isBlockedGeneratedImageHost(url.hostname)) {
    throw new GeneratedImagePublicationError("invalid_url", url.href, "Generated image URL must target a public host");
  }

  return url;
}

async function fetchGeneratedImage(url: URL, signal: AbortSignal): Promise<Response> {
  try {
    const response = await globalThis.fetch(url.href, {
      signal,
      redirect: "error"
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
  }
}

async function readGeneratedImageBytes(response: Response, url: string, signal: AbortSignal): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    throw new GeneratedImagePublicationError("download", url, "Generated image response body was missing");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let abortReader: (() => void) | null = null;

  const abortPromise = new Promise<never>((_, reject) => {
    abortReader = () => {
      const reason = signal.reason ?? new DOMException("Generated image download timed out", "TimeoutError");
      void reader.cancel(reason).catch(() => undefined);
      reject(reason);
    };

    if (signal.aborted) {
      abortReader();
      return;
    }

    signal.addEventListener("abort", abortReader, { once: true });
  });

  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), abortPromise]);
      if (chunk.done) {
        break;
      }

      const value = chunk.value;
      totalBytes += value.byteLength;
      if (totalBytes > GENERATED_IMAGE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new GeneratedImagePublicationError("validation", url, "Generated image exceeds the size limit");
      }

      chunks.push(value);
    }

    return concatChunks(chunks, totalBytes);
  } catch (error) {
    if (error instanceof GeneratedImagePublicationError) {
      throw error;
    }

    throw new GeneratedImagePublicationError("download", url, "Failed to read generated image bytes", error);
  } finally {
    if (abortReader) {
      signal.removeEventListener("abort", abortReader);
    }
    reader.releaseLock();
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

function isBlockedGeneratedImageHost(hostname: string): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname) {
    return true;
  }

  if (normalizedHostname === "localhost" || normalizedHostname.endsWith(".localhost")) {
    return true;
  }

  const ipVersion = isIP(normalizedHostname);
  if (ipVersion === 4) {
    return isBlockedIpv4Address(normalizedHostname);
  }

  if (ipVersion === 6) {
    return isBlockedIpv6Address(normalizedHostname);
  }

  return false;
}

function normalizeHostname(hostname: string): string {
  const trimmedHostname = hostname.trim().replace(/\.$/, "").toLowerCase();
  if (trimmedHostname.startsWith("[") && trimmedHostname.endsWith("]")) {
    return trimmedHostname.slice(1, -1);
  }

  return trimmedHostname;
}

function isBlockedIpv4Address(address: string): boolean {
  const octets = address.split(".").map((segment) => Number.parseInt(segment, 10));
  const [firstOctet, secondOctet] = octets;
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  return (
    firstOctet === 0 ||
    firstOctet === 10 ||
    firstOctet === 127 ||
    (firstOctet === 169 && secondOctet === 254) ||
    (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
    (firstOctet === 192 && secondOctet === 168)
  );
}

function isBlockedIpv6Address(address: string): boolean {
  const normalizedAddress = address.toLowerCase();
  if (normalizedAddress === "::1") {
    return true;
  }

  if (normalizedAddress.startsWith("::ffff:")) {
    const mappedIpv4 = normalizedAddress.slice("::ffff:".length);
    return isIP(mappedIpv4) === 4 ? isBlockedIpv4Address(mappedIpv4) : false;
  }

  const firstHextet = normalizedAddress.split(":").find((segment) => segment.length > 0) ?? "";
  if (firstHextet.length < 2) {
    return false;
  }

  const firstByte = Number.parseInt(firstHextet.slice(0, 2), 16);
  if (!Number.isFinite(firstByte)) {
    return false;
  }

  return (firstByte & 0xfe) === 0xfc || (firstByte === 0xfe && isLinkLocalIpv6(normalizedAddress));
}

function isLinkLocalIpv6(address: string): boolean {
  const firstHextet = address.split(":").find((segment) => segment.length > 0) ?? "";
  if (firstHextet.length < 2) {
    return false;
  }

  const firstTwoBytes = Number.parseInt(firstHextet.padEnd(4, "0"), 16);
  if (!Number.isFinite(firstTwoBytes)) {
    return false;
  }

  return (firstTwoBytes & 0xffc0) === 0xfe80;
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

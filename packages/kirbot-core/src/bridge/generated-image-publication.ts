import * as dns from "node:dns/promises";
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
  const url = await parseGeneratedImageUrl(item.result);
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

async function parseGeneratedImageUrl(rawUrl: string): Promise<URL> {
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

  if (shouldResolveHostname(url.hostname)) {
    await validateResolvedHostname(url);
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
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const firstOctet = octets[0]!;
  const secondOctet = octets[1]!;

  return (
    firstOctet === 0 ||
    firstOctet === 10 ||
    firstOctet === 127 ||
    (firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127) ||
    (firstOctet === 169 && secondOctet === 254) ||
    (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
    (firstOctet === 192 && secondOctet === 168) ||
    (firstOctet === 198 && (secondOctet === 18 || secondOctet === 19))
  );
}

function isBlockedIpv6Address(address: string): boolean {
  const bytes = parseIpv6Address(address);
  if (!bytes) {
    return false;
  }

  if (isAllZeroes(bytes) || isIpv6Loopback(bytes)) {
    return true;
  }

  const mappedIpv4 = extractMappedIpv4(bytes);
  if (mappedIpv4) {
    return isBlockedIpv4Address(mappedIpv4);
  }

  return isUniqueLocalIpv6(bytes) || isLinkLocalIpv6(bytes);
}

async function validateResolvedHostname(url: URL): Promise<void> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = (await dns.lookup(normalizeHostname(url.hostname), {
      all: true,
      verbatim: true
    })) as Array<{ address: string; family: number }>;
  } catch (error) {
    throw new GeneratedImagePublicationError("invalid_url", url.href, "Generated image hostname could not be validated", error);
  }

  if (addresses.length === 0 || addresses.some((entry) => isBlockedGeneratedImageHost(entry.address))) {
    throw new GeneratedImagePublicationError("invalid_url", url.href, "Generated image hostname resolved to a blocked address");
  }
}

function shouldResolveHostname(hostname: string): boolean {
  return isIP(normalizeHostname(hostname)) === 0;
}

function parseIpv6Address(address: string): Uint8Array | null {
  const normalizedAddress = address.toLowerCase().split("%")[0] ?? "";
  if (!normalizedAddress) {
    return null;
  }

  const doubleColonIndex = normalizedAddress.indexOf("::");
  if (doubleColonIndex !== normalizedAddress.lastIndexOf("::")) {
    return null;
  }

  const [head = "", tail = ""] = normalizedAddress.split("::");
  const headParts = parseIpv6Segments(head);
  const tailParts = parseIpv6Segments(tail);
  if (!headParts || !tailParts) {
    return null;
  }

  const hasDoubleColon = doubleColonIndex !== -1;
  const zeroSegments = hasDoubleColon ? 8 - (headParts.length + tailParts.length) : 0;
  if ((hasDoubleColon && zeroSegments < 0) || (!hasDoubleColon && headParts.length !== 8)) {
    return null;
  }

  const parts = hasDoubleColon
    ? [...headParts, ...Array.from({ length: zeroSegments }, () => "0"), ...tailParts]
    : headParts;
  if (parts.length !== 8) {
    return null;
  }

  const bytes = new Uint8Array(16);
  for (const [index, part] of parts.entries()) {
    const value = Number.parseInt(part, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      return null;
    }

    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }

  return bytes;
}

function parseIpv6Segments(input: string): string[] | null {
  if (!input) {
    return [];
  }

  const rawSegments = input.split(":");
  const segments: string[] = [];

  for (const segment of rawSegments) {
    if (!segment) {
      return null;
    }

    if (segment.includes(".")) {
      const ipv4Bytes = parseIpv4Bytes(segment);
      if (!ipv4Bytes) {
        return null;
      }

      segments.push(((ipv4Bytes[0]! << 8) | ipv4Bytes[1]!).toString(16));
      segments.push(((ipv4Bytes[2]! << 8) | ipv4Bytes[3]!).toString(16));
      continue;
    }

    segments.push(segment);
  }

  return segments;
}

function parseIpv4Bytes(address: string): Uint8Array | null {
  const octets = address.split(".").map((segment) => Number.parseInt(segment, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return Uint8Array.from(octets);
}

function isAllZeroes(bytes: Uint8Array): boolean {
  return bytes.every((value) => value === 0);
}

function isIpv6Loopback(bytes: Uint8Array): boolean {
  return bytes.slice(0, 15).every((value) => value === 0) && bytes[15]! === 1;
}

function extractMappedIpv4(bytes: Uint8Array): string | null {
  const mappedPrefixMatches =
    bytes.slice(0, 10).every((value) => value === 0) && bytes[10]! === 0xff && bytes[11]! === 0xff;
  if (!mappedPrefixMatches) {
    return null;
  }

  return `${bytes[12]!}.${bytes[13]!}.${bytes[14]!}.${bytes[15]!}`;
}

function isUniqueLocalIpv6(bytes: Uint8Array): boolean {
  return (bytes[0]! & 0xfe) === 0xfc;
}

function isLinkLocalIpv6(bytes: Uint8Array): boolean {
  return bytes[0]! === 0xfe && (bytes[1]! & 0xc0) === 0x80;
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

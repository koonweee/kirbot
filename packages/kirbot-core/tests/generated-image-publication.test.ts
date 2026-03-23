import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", async () => {
  const actual = await vi.importActual<typeof import("node:dns/promises")>("node:dns/promises");
  return {
    ...actual,
    lookup: vi.fn(actual.lookup)
  };
});

import * as dns from "node:dns/promises";

import {
  fetchUploadReadyGeneratedImage,
  GeneratedImagePublicationError
} from "../src/bridge/generated-image-publication";
import type { ThreadItem } from "@kirbot/codex-client/generated/codex/v2/ThreadItem";

function imageGenerationItem(result: string): Extract<ThreadItem, { type: "imageGeneration" }> {
  return {
    type: "imageGeneration",
    id: "image-gen-1",
    status: "completed",
    revisedPrompt: null,
    result
  };
}

function buildDelayedStream(chunks: Uint8Array[], delaysMs: number[]): ReadableStream<Uint8Array> {
  let nextChunkIndex = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (nextChunkIndex === 0) {
        controller.enqueue(chunks[0]!);
        nextChunkIndex += 1;
        return;
      }

      const delayMs = delaysMs[nextChunkIndex - 1];
      const chunk = chunks[nextChunkIndex];
      if (delayMs === undefined || !chunk) {
        controller.close();
        return;
      }

      nextChunkIndex += 1;
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          try {
            controller.enqueue(chunk);
            if (nextChunkIndex >= chunks.length) {
              controller.close();
            }
          } catch {
            // The helper may cancel the stream once it has enough evidence.
          }
          resolve();
        }, delayMs);
      });
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.mocked(dns.lookup).mockReset();
  vi.mocked(dns.lookup).mockResolvedValue([
    {
      address: "93.184.216.34",
      family: 4
    }
  ] as Awaited<ReturnType<typeof dns.lookup>>);
});

describe("generated image publication helper", () => {
  it.each([
    "http://localhost/image.png",
    "https://localhost/image.png",
    "https://foo.localhost/image.png",
    "https://127.0.0.1/image.png",
    "https://10.0.0.5/image.png",
    "https://172.16.0.5/image.png",
    "https://192.168.1.5/image.png",
    "https://169.254.1.5/image.png",
    "https://0.0.0.0/image.png",
    "https://[::1]/image.png",
    "https://[::ffff:127.0.0.1]/image.png",
    "https://[::]/image.png",
    "https://100.64.0.1/image.png",
    "https://198.18.0.1/image.png"
  ])("rejects non-public generated image URL %s before fetch", async (url) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("fetch should not be called for non-public image URLs");
    });

    const publicationPromise = fetchUploadReadyGeneratedImage(imageGenerationItem(url));

    await expect(publicationPromise).rejects.toBeInstanceOf(GeneratedImagePublicationError);
    await expect(publicationPromise).rejects.toMatchObject({
      stage: "invalid_url",
      url: new URL(url).href
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("disables redirects when downloading generated images", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Type": "image/png"
        }
      })
    );

    await fetchUploadReadyGeneratedImage(imageGenerationItem("https://example.com/generated.png"));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error"
    });
  });

  it("rejects public-looking hostnames that resolve to blocked internal addresses before fetch", async () => {
    const lookupSpy = vi.mocked(dns.lookup).mockResolvedValue([
      {
        address: "10.0.0.25",
        family: 4
      }
    ] as Awaited<ReturnType<typeof dns.lookup>>);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("fetch should not be called for hostnames that resolve internally");
    });

    const publicationPromise = fetchUploadReadyGeneratedImage(
      imageGenerationItem("https://public-looking.example/generated.png")
    );

    await expect(publicationPromise).rejects.toMatchObject({
      stage: "invalid_url",
      url: "https://public-looking.example/generated.png"
    });
    expect(lookupSpy).toHaveBeenCalledWith("public-looking.example", {
      all: true,
      verbatim: true
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the timeout active while the response body is still streaming", async () => {
    vi.useFakeTimers();
    let resolveSecondRead: ((value: ReadableStreamReadResult<Uint8Array>) => void) | null = null;
    const read = vi
      .fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
      .mockResolvedValueOnce({
        done: false,
        value: new Uint8Array([1])
      })
      .mockImplementationOnce(
        () =>
          new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
            resolveSecondRead = resolve;
          })
      );
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      {
        ok: true,
        status: 200,
        headers: new Headers({
          "Content-Type": "image/png"
        }),
        body: {
          getReader: () => ({
            read,
            cancel,
            releaseLock
          })
        }
      } as unknown as Response
    );

    const publicationPromise = fetchUploadReadyGeneratedImage(imageGenerationItem("https://example.com/slow.png"));
    let outcome: "resolved" | "rejected" | null = null;
    publicationPromise.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      }
    );

    await vi.advanceTimersByTimeAsync(15_001);
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(outcome).toBe("rejected");
    expect(cancel).toHaveBeenCalledTimes(1);

    resolveSecondRead?.({
      done: true,
      value: undefined
    });
    await expect(publicationPromise).rejects.toMatchObject({
      stage: "download",
      url: "https://example.com/slow.png"
    });
  });

  it("rejects oversized streamed responses before the body finishes", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(buildDelayedStream([new Uint8Array(6_000_000), new Uint8Array(6_000_001)], [1_000]), {
        headers: {
          "Content-Type": "image/png"
        }
      })
    );

    const publicationPromise = fetchUploadReadyGeneratedImage(imageGenerationItem("https://example.com/oversized.png"));
    let outcome: "resolved" | "rejected" | null = null;
    publicationPromise.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      }
    );

    await vi.advanceTimersByTimeAsync(1_001);
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(outcome).toBe("rejected");

    await expect(publicationPromise).rejects.toMatchObject({
      stage: "validation",
      url: "https://example.com/oversized.png"
    });
  });
});

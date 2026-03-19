import { describe, expect, it } from "vitest";
import type { Message } from "grammy/types";

import { buildImageDocumentMessageInput, buildPhotoMessageInput } from "../src/message-input";

describe("bot image message input helpers", () => {
  it("builds photo input from the largest Telegram photo size and preserves the caption text", () => {
    const result = buildPhotoMessageInput(
      "Check this screenshot",
      [
        {
          file_id: "photo-small",
          file_unique_id: "photo-small-unique",
          width: 32,
          height: 32
        },
        {
          file_id: "photo-large",
          file_unique_id: "photo-large-unique",
          width: 128,
          height: 128
        }
      ] satisfies Message.PhotoMessage["photo"]
    );

    expect(result).toEqual({
      text: "Check this screenshot",
      input: [
        {
          type: "text",
          text: "Check this screenshot",
          text_elements: []
        },
        {
          type: "telegramImage",
          fileId: "photo-large",
          fileName: "telegram-photo.jpg",
          mimeType: "image/jpeg"
        }
      ]
    });
  });

  it("builds image-document input and preserves file metadata", () => {
    const result = buildImageDocumentMessageInput(
      "Inspect this export",
      {
        file_id: "doc-image-1",
        file_unique_id: "doc-image-1-unique",
        file_name: "export.png",
        mime_type: "image/png",
        file_size: 128
      } satisfies Message.DocumentMessage["document"]
    );

    expect(result).toEqual({
      text: "Inspect this export",
      input: [
        {
          type: "text",
          text: "Inspect this export",
          text_elements: []
        },
        {
          type: "telegramImage",
          fileId: "doc-image-1",
          fileName: "export.png",
          mimeType: "image/png"
        }
      ]
    });
  });

  it("rejects non-image documents", () => {
    const result = buildImageDocumentMessageInput(
      "Inspect this export",
      {
        file_id: "doc-text-1",
        file_unique_id: "doc-text-1-unique",
        file_name: "notes.txt",
        mime_type: "text/plain",
        file_size: 128
      } satisfies Message.DocumentMessage["document"]
    );

    expect(result).toBeNull();
  });

  it("omits the text item when an image message has no caption", () => {
    const result = buildPhotoMessageInput(
      "",
      [
        {
          file_id: "photo-only",
          file_unique_id: "photo-only-unique",
          width: 128,
          height: 128
        }
      ] satisfies Message.PhotoMessage["photo"]
    );

    expect(result).toEqual({
      text: "",
      input: [
        {
          type: "telegramImage",
          fileId: "photo-only",
          fileName: "telegram-photo.jpg",
          mimeType: "image/jpeg"
        }
      ]
    });
  });
});

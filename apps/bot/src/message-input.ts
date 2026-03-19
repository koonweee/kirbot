import type { UserTurnInput } from "@kirbot/core";
import type { Message } from "grammy/types";

type TelegramImageDescriptor = {
  fileId: string;
  fileName?: string | null;
  mimeType?: string | null;
};

export function buildPhotoMessageInput(
  caption: string | null | undefined,
  photos: Message.PhotoMessage["photo"]
): { text: string; input: UserTurnInput[] } {
  const photo = pickLargestPhoto(photos);
  const text = caption ?? "";
  return {
    text,
    input: buildImageMessageInput(text, {
      fileId: photo.file_id,
      fileName: "telegram-photo.jpg",
      mimeType: "image/jpeg"
    })
  };
}

export function buildImageDocumentMessageInput(
  caption: string | null | undefined,
  document: Message.DocumentMessage["document"]
): { text: string; input: UserTurnInput[] } | null {
  if (!isImageDocument(document)) {
    return null;
  }

  const text = caption ?? "";
  return {
    text,
    input: buildImageMessageInput(text, {
      fileId: document.file_id,
      ...(document.file_name ? { fileName: document.file_name } : {}),
      ...(document.mime_type ? { mimeType: document.mime_type } : {})
    })
  };
}

export function buildImageMessageInput(text: string, image: TelegramImageDescriptor): UserTurnInput[] {
  const input: UserTurnInput[] = [];
  if (text.trim().length > 0) {
    input.push({
      type: "text",
      text,
      text_elements: []
    });
  }
  input.push({
    type: "telegramImage",
    fileId: image.fileId,
    ...(image.fileName !== undefined ? { fileName: image.fileName } : {}),
    ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {})
  });
  return input;
}

export function pickLargestPhoto(photos: Message.PhotoMessage["photo"]): Message.PhotoMessage["photo"][number] {
  const largest = photos.at(-1);
  if (!largest) {
    throw new Error("Telegram photo message did not include any photo sizes");
  }

  return largest;
}

export function isImageDocument(document: Message.DocumentMessage["document"]): boolean {
  return typeof document.mime_type === "string" && document.mime_type.startsWith("image/");
}

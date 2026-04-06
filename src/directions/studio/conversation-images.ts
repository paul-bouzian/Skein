import type {
  ConversationImageAttachment,
  ModelOption,
} from "../../lib/types";

export const IMAGE_FILE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
] as const;

// Keep aligned with the Rust image preview guard in `system.rs`.
export const MAX_CONVERSATION_IMAGE_BYTES = 25 * 1024 * 1024;

const IMAGE_FILE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export function conversationImageKey(image: ConversationImageAttachment) {
  return image.type === "image" ? `image:${image.url}` : `local:${image.path}`;
}

export function conversationImageLabel(image: ConversationImageAttachment) {
  if (image.type === "image") {
    return "Pasted image";
  }
  const normalized = image.path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : image.path;
}

export function modelSupportsImageInput(model?: ModelOption | null) {
  return (model?.inputModalities ?? ["text"]).includes("image");
}

export function modelImageSupportMessage(model?: ModelOption | null) {
  const label = model?.displayName ?? "the selected model";
  return `Image attachments are unavailable for ${label}.`;
}

export function normalizeDialogSelection(
  selection: string | string[] | null,
): string[] {
  if (!selection) {
    return [];
  }
  return Array.isArray(selection) ? selection : [selection];
}

export function isSupportedImagePath(path: string) {
  const extension = path.trim().split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_FILE_EXTENSIONS.includes(
    extension as (typeof IMAGE_FILE_EXTENSIONS)[number],
  );
}

export function isSupportedImageFile(file: File) {
  const type = file.type.toLowerCase();
  if (
    IMAGE_FILE_MIME_TYPES.includes(
      type as (typeof IMAGE_FILE_MIME_TYPES)[number],
    )
  ) {
    return true;
  }
  return isSupportedImagePath(file.name);
}

export async function readFileAsDataUrl(file: File): Promise<string> {
  if (file.size > MAX_CONVERSATION_IMAGE_BYTES) {
    throw new Error("Image exceeds the 25 MiB preview limit.");
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string" && reader.result.length > 0) {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read image data."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image data."));
    reader.readAsDataURL(file);
  });
}

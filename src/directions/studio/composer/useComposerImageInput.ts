import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";

import type { ConversationImageAttachment } from "../../../lib/types";
import {
  IMAGE_FILE_EXTENSIONS,
  conversationImageKey,
  isSupportedImageFile,
  isSupportedImagePath,
  normalizeDialogSelection,
  readFileAsDataUrl,
} from "../conversation-images";

type Props = {
  disabled: boolean;
  imagesEnabled: boolean;
  scopeKey: string;
  setImages: Dispatch<SetStateAction<ConversationImageAttachment[]>>;
};

type DragPosition = { x: number; y: number };

const FILE_TRANSFER_TYPES = ["Files", "public.file-url", "application/x-moz-file"];

function mergeImages(
  current: ConversationImageAttachment[],
  incoming: ConversationImageAttachment[],
) {
  const deduped = new Map(
    current.map((image) => [conversationImageKey(image), image] as const),
  );
  for (const image of incoming) {
    deduped.set(conversationImageKey(image), image);
  }
  return Array.from(deduped.values());
}

function normalizeDragPosition(
  position: DragPosition,
  lastClientPosition: DragPosition | null,
) {
  const scale = window.devicePixelRatio || 1;
  if (scale === 1 || !lastClientPosition) {
    return position;
  }
  const scaled = { x: position.x / scale, y: position.y / scale };
  const directDistance = Math.hypot(
    position.x - lastClientPosition.x,
    position.y - lastClientPosition.y,
  );
  const scaledDistance = Math.hypot(
    scaled.x - lastClientPosition.x,
    scaled.y - lastClientPosition.y,
  );
  return scaledDistance < directDistance ? scaled : position;
}

function isFileTransfer(types: readonly string[] | undefined) {
  return Boolean(types?.some((type) => FILE_TRANSFER_TYPES.includes(type)));
}

function pathsToLocalImages(paths: string[]) {
  return paths
    .filter((path) => path.trim().length > 0)
    .filter(isSupportedImagePath)
    .map((path) => ({ type: "localImage", path }) as const);
}

async function readImageFilesAsDataUrls(files: File[]) {
  const results = await Promise.allSettled(
    files.map(async (file) => ({
      type: "image" as const,
      url: await readFileAsDataUrl(file),
    })),
  );
  return results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
}

export function useComposerImageInput({
  disabled,
  imagesEnabled,
  scopeKey,
  setImages,
}: Props) {
  const dropTargetRef = useRef<HTMLDivElement | null>(null);
  const lastClientPositionRef = useRef<DragPosition | null>(null);
  const disabledRef = useRef(disabled);
  const imagesEnabledRef = useRef(imagesEnabled);
  const scopeKeyRef = useRef(scopeKey);
  const scopeVersionRef = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);

  if (scopeKeyRef.current !== scopeKey) {
    scopeKeyRef.current = scopeKey;
    scopeVersionRef.current += 1;
  }

  useEffect(() => {
    disabledRef.current = disabled;
    imagesEnabledRef.current = imagesEnabled;
  }, [disabled, imagesEnabled]);

  const appendImages = useCallback(
    (images: ConversationImageAttachment[]) => {
      if (
        images.length === 0 ||
        disabledRef.current ||
        !imagesEnabledRef.current
      ) {
        return;
      }
      setImages((current) => mergeImages(current, images));
    },
    [setImages],
  );

  const removeImage = useCallback(
    (key: string) => {
      setImages((current) =>
        current.filter((image) => conversationImageKey(image) !== key),
      );
    },
    [setImages],
  );

  async function pickImages() {
    if (disabled || !imagesEnabled) {
      return;
    }
    const scopeVersion = scopeVersionRef.current;
    let selection: string | string[] | null;
    try {
      selection = await open({
        multiple: true,
        filters: [
          {
            name: "Images",
            extensions: [...IMAGE_FILE_EXTENSIONS],
          },
        ],
      });
    } catch {
      return;
    }
    if (scopeVersion !== scopeVersionRef.current) {
      return;
    }
    const paths = pathsToLocalImages(normalizeDialogSelection(selection));
    appendImages(paths);
  }

  useEffect(() => {
    if (disabled || !imagesEnabled) {
      setIsDragOver(false);
      return;
    }

    let cancelled = false;
    let unlisten: null | (() => void) = null;
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        const target = dropTargetRef.current;
        if (!target) {
          return;
        }
        if (event.payload.type === "leave") {
          setIsDragOver(false);
          return;
        }
        const position = normalizeDragPosition(
          event.payload.position,
          lastClientPositionRef.current,
        );
        const rect = target.getBoundingClientRect();
        const inside =
          position.x >= rect.left &&
          position.x <= rect.right &&
          position.y >= rect.top &&
          position.y <= rect.bottom;

        if (event.payload.type === "enter" || event.payload.type === "over") {
          setIsDragOver(inside);
          return;
        }
        if (event.payload.type === "drop") {
          setIsDragOver(false);
          if (!inside) {
            return;
          }
          appendImages(pathsToLocalImages(event.payload.paths));
        }
      })
      .then((cleanup) => {
        if (cancelled) {
          cleanup();
          return;
        }
        unlisten = cleanup;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [appendImages, disabled, imagesEnabled]);

  function handleDragOver(event: React.DragEvent<HTMLElement>) {
    if (!isFileTransfer(event.dataTransfer?.types)) {
      return;
    }
    event.preventDefault();
    lastClientPositionRef.current = { x: event.clientX, y: event.clientY };
    if (!disabled && imagesEnabled) {
      setIsDragOver(true);
    }
  }

  function handleDragEnter(event: React.DragEvent<HTMLElement>) {
    handleDragOver(event);
  }

  function handleDragLeave() {
    setIsDragOver(false);
    lastClientPositionRef.current = null;
  }

  async function handleDrop(event: React.DragEvent<HTMLElement>) {
    if (!isFileTransfer(event.dataTransfer?.types)) {
      return;
    }
    event.preventDefault();
    setIsDragOver(false);
    lastClientPositionRef.current = null;
    if (disabled || !imagesEnabled) {
      return;
    }
    const scopeVersion = scopeVersionRef.current;

    const files = Array.from(event.dataTransfer?.files ?? []);
    const pathImages = pathsToLocalImages(
      files.map((file) => (file as File & { path?: string }).path ?? ""),
    );
    const dataImages = await readImageFilesAsDataUrls(
      files
        .filter((file) => isSupportedImageFile(file))
        .filter((file) => !((file as File & { path?: string }).path ?? "")),
    );
    if (scopeVersion !== scopeVersionRef.current) {
      return;
    }
    appendImages([...pathImages, ...dataImages]);
  }

  async function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (disabled || !imagesEnabled) {
      return;
    }
    const scopeVersion = scopeVersionRef.current;
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
      .filter((file) => isSupportedImageFile(file));
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    const dataImages = await readImageFilesAsDataUrls(files);
    if (scopeVersion !== scopeVersionRef.current) {
      return;
    }
    appendImages(dataImages);
  }

  return {
    dropTargetRef,
    isDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handlePaste,
    pickImages,
    removeImage,
  };
}

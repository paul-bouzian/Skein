import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { dialog, windowShell } from "../../../lib/shell";
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
      selection = await dialog.open({
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

  function handleDragOver(event: React.DragEvent<HTMLElement>) {
    if (!isFileTransfer(event.dataTransfer?.types)) {
      return;
    }
    event.preventDefault();
    if (!disabled && imagesEnabled) {
      setIsDragOver(true);
    }
  }

  function handleDragEnter(event: React.DragEvent<HTMLElement>) {
    handleDragOver(event);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  async function handleDrop(event: React.DragEvent<HTMLElement>) {
    if (!isFileTransfer(event.dataTransfer?.types)) {
      return;
    }
    event.preventDefault();
    setIsDragOver(false);
    if (disabled || !imagesEnabled) {
      return;
    }
    const scopeVersion = scopeVersionRef.current;

    const files = Array.from(event.dataTransfer?.files ?? []);
    const resolvedFiles = files.map((file) => {
      const path = windowShell.getPathForFile(file);
      return {
        file,
        path,
        useResolvedPath: Boolean(path && isSupportedImagePath(path)),
      };
    });
    const pathImages = resolvedFiles.flatMap(({ path, useResolvedPath }) =>
      useResolvedPath && path ? [{ type: "localImage" as const, path }] : [],
    );
    const dataImages = await readImageFilesAsDataUrls(
      resolvedFiles
        .filter(
          ({ file, useResolvedPath }) =>
            isSupportedImageFile(file) && !useResolvedPath,
        )
        .map(({ file }) => file),
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

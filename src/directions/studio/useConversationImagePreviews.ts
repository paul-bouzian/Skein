import { useEffect, useMemo, useRef, useState } from "react";

import { readImageAsDataUrl } from "../../lib/bridge";
import type { ConversationImageAttachment } from "../../lib/types";
import {
  conversationImageKey,
  conversationImageLabel,
} from "./conversation-images";

export type ConversationImagePreview = {
  attachment: ConversationImageAttachment;
  key: string;
  label: string;
  loading: boolean;
  previewUrl: string | null;
};

const MAX_PREVIEW_CACHE_ENTRIES = 64;
const previewCache = new Map<string, string>();

function getCachedPreview(path: string) {
  const previewUrl = previewCache.get(path) ?? null;
  if (!previewUrl) {
    return null;
  }
  previewCache.delete(path);
  previewCache.set(path, previewUrl);
  return previewUrl;
}

function cachePreview(path: string, previewUrl: string) {
  previewCache.delete(path);
  previewCache.set(path, previewUrl);
  while (previewCache.size > MAX_PREVIEW_CACHE_ENTRIES) {
    const oldestKey = previewCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    previewCache.delete(oldestKey);
  }
}

export function useConversationImagePreviews(
  images: ConversationImageAttachment[] | null | undefined,
) {
  const loadingPathsRef = useRef(new Set<string>());
  const [localPreviews, setLocalPreviews] = useState<
    Record<string, { loading: boolean; previewUrl: string | null }>
  >({});

  useEffect(() => {
    if (!images || images.length === 0) {
      return;
    }

    let cancelled = false;
    for (const image of images) {
      if (image.type !== "localImage") {
        continue;
      }
      const path = image.path;
      if (getCachedPreview(path) || loadingPathsRef.current.has(path)) {
        continue;
      }
      loadingPathsRef.current.add(path);

      setLocalPreviews((current) => ({
        ...current,
        [path]: { loading: true, previewUrl: null },
      }));

      void readImageAsDataUrl(path)
        .then((previewUrl) => {
          cachePreview(path, previewUrl);
          loadingPathsRef.current.delete(path);
          if (cancelled) {
            return;
          }
          setLocalPreviews((current) => ({
            ...current,
            [path]: { loading: false, previewUrl },
          }));
        })
        .catch(() => {
          loadingPathsRef.current.delete(path);
          if (cancelled) {
            return;
          }
          setLocalPreviews((current) => ({
            ...current,
            [path]: { loading: false, previewUrl: null },
          }));
        });
    }

    return () => {
      cancelled = true;
    };
  }, [images]);

  return useMemo<ConversationImagePreview[]>(() => {
    return (images ?? []).map((image) => {
      if (image.type === "image") {
        return {
          attachment: image,
          key: conversationImageKey(image),
          label: conversationImageLabel(image),
          loading: false,
          previewUrl: image.url,
        };
      }

      const cached = previewCache.get(image.path) ?? null;
      const local = localPreviews[image.path];
      return {
        attachment: image,
        key: conversationImageKey(image),
        label: conversationImageLabel(image),
        loading: local?.loading ?? !cached,
        previewUrl: cached ?? local?.previewUrl ?? null,
      };
    });
  }, [images, localPreviews]);
}

import { useEffect, useMemo, useState } from "react";

import * as bridge from "../../lib/bridge";
import type { OpenTarget } from "../../lib/types";

const iconCache = new Map<string, Promise<string | null>>();

function loadOpenAppIcon(appName: string) {
  if (!iconCache.has(appName)) {
    iconCache.set(
      appName,
      bridge.getOpenAppIcon(appName).catch(() => null),
    );
  }
  return iconCache.get(appName)!;
}

export function useOpenAppIcons(targets: OpenTarget[]) {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const appNames = useMemo(
    () =>
      targets.flatMap((target) =>
        target.kind === "app" && typeof target.appName === "string"
          ? [target.appName]
          : [],
      ),
    [targets],
  );

  useEffect(() => {
    let cancelled = false;
    if (appNames.length === 0) {
      setIcons({});
      return undefined;
    }

    void Promise.all(
      appNames.map(async (appName) => [appName, await loadOpenAppIcon(appName)] as const),
    ).then((entries) => {
      if (cancelled) {
        return;
      }
      setIcons(
        Object.fromEntries(
          entries.filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
        ),
      );
    });

    return () => {
      cancelled = true;
    };
  }, [appNames]);

  return icons;
}

import { useDeferredValue, useEffect, useMemo, useState } from "react";

import * as bridge from "../../lib/bridge";

const iconCache = new Map<string, Promise<string | null>>();

export function resetOpenAppIconCacheForTests() {
  iconCache.clear();
}

function loadOpenAppIcon(appName: string) {
  if (!iconCache.has(appName)) {
    iconCache.set(
      appName,
      bridge.getOpenAppIcon(appName).catch(() => null),
    );
  }
  return iconCache.get(appName)!;
}

export function useOpenAppIcons(appNames: string[]) {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const normalizedAppNames = useMemo(
    () =>
      Array.from(
        new Set(
          appNames
            .map((appName) => appName.trim())
            .filter(Boolean),
        ),
      ),
    [appNames],
  );
  const deferredAppNames = useDeferredValue(normalizedAppNames);
  const deferredAppNamesKey = deferredAppNames.join("\0");
  const resolvedAppNames = useMemo(
    () => (deferredAppNamesKey ? deferredAppNamesKey.split("\0") : []),
    [deferredAppNamesKey],
  );

  useEffect(() => {
    let cancelled = false;
    if (resolvedAppNames.length === 0) {
      setIcons({});
      return undefined;
    }

    void Promise.all(
      resolvedAppNames.map(async (appName) => [appName, await loadOpenAppIcon(appName)] as const),
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
  }, [resolvedAppNames]);

  return icons;
}

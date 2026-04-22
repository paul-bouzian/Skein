import { readLocalStorageWithMigration } from "./app-identity";
import { getDesktopApi } from "./desktop-host";

function primeLocalStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

async function mirrorPreferenceToHost(key: string, value: string | null) {
  const desktopApi = getDesktopApi();
  if (!desktopApi?.preferences) {
    return;
  }

  await desktopApi.preferences.set(key, value);
}

export function readUiPreferenceWithMigration(
  key: string,
  legacyKeys: string | readonly string[],
) {
  const desktopValue = getDesktopApi()?.preferences?.getSnapshot()[key];
  if (typeof desktopValue === "string") {
    primeLocalStorage(key, desktopValue);
    return desktopValue;
  }

  const localValue = readLocalStorageWithMigration(key, legacyKeys);
  if (localValue != null) {
    void mirrorPreferenceToHost(key, localValue);
  }
  return localValue;
}

export function persistUiPreference(key: string, value: string | null) {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    /* ignore */
  }

  return mirrorPreferenceToHost(key, value).catch(() => undefined);
}

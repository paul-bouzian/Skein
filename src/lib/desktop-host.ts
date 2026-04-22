import type {
  HostEvent,
  HostUnlistenFn,
  SkeinDesktopApi,
} from "./desktop-types";

export type { HostUnlistenFn } from "./desktop-types";

export function getDesktopApi(): SkeinDesktopApi | null {
  return typeof window === "undefined" ? null : window.skeinDesktop ?? null;
}

export function requireDesktopApi(errorMessage?: string): SkeinDesktopApi {
  const desktopApi = getDesktopApi();
  if (desktopApi) {
    return desktopApi;
  }

  throw new Error(
    errorMessage ??
      "Desktop host is unavailable. Launch Skein with `bun run electron:dev`.",
  );
}

export function hasDesktopHost() {
  return getDesktopApi() !== null;
}

export function invokeCommand<T>(
  command: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  return requireDesktopApi().invoke<T>(command, payload);
}

export function listenEvent<T>(
  eventName: string,
  handler: (event: HostEvent<T>) => void,
): Promise<HostUnlistenFn> {
  return requireDesktopApi().listen<T>(eventName, handler);
}

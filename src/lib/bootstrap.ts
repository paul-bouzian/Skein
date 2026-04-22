import { invokeCommand as invoke } from "./desktop-host";

export type BootstrapStatus = {
  appName: string;
  appVersion: string;
  backend: string;
  platform: string;
};

export async function getBootstrapStatus(): Promise<BootstrapStatus> {
  return invoke<BootstrapStatus>("get_bootstrap_status");
}

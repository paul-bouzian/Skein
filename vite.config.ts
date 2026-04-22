import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const electronBuild = mode === "electron";

  return {
    plugins: [react()],
    base: electronBuild ? "./" : undefined,
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: "./src/test/setup.ts",
      css: true,
      exclude: [
        ...configDefaults.exclude,
        "dist-electron/**",
        "release-artifacts/**",
      ],
    },

    build: electronBuild
      ? {
          outDir: "dist-electron/renderer",
          emptyOutDir: true,
        }
      : undefined,

    // Vite options tailored for the desktop workflow.
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. the desktop shell expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        ignored: ["**/desktop-backend/**"],
      },
    },
  };
});

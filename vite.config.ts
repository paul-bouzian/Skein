import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

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

    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      watch: {
        ignored: ["**/desktop-backend/**"],
      },
    },
  };
});

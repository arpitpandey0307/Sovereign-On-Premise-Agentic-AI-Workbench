import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// The API is proxied rather than called cross-origin. In production this app
// is served by the same host as the API, so a proxy in development keeps the
// two environments the same shape -- no CORS in one and not the other, and no
// base-URL switch to get wrong.
const API_TARGET = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // fileURLToPath rather than __dirname (absent under the native config
    // loader) and rather than URL.pathname, which on Windows yields a
    // leading-slash path that does not resolve.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/health": { target: API_TARGET, changeOrigin: true },
      "/internal": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    // Split the heavier libraries into their own chunks. Someone opening
    // the marketing page should not download the whole workbench.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("framer-motion")) return "motion";
          if (id.includes("@tanstack")) return "query";
          if (id.includes("recharts") || id.includes("d3-")) return "charts";
          return undefined;
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
  },
});

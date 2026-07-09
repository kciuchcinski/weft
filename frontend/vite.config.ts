import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `process` is injected by Node when Vite loads this config; typed loosely here
// so we don't need a dev-only @types/node dependency.
const nodeEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  plugins: [react()],
  server: {
    // Honor the PORT env var (used by the preview harness) so the server binds
    // to the port it's assigned; fall back to the usual dev port otherwise.
    port: Number(nodeEnv.PORT) || 5173,
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
});

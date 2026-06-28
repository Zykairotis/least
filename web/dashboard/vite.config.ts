import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.LEAST_DASHBOARD_PORT ?? 8922),
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.LEAST_DASHBOARD_API ?? "http://127.0.0.1:8922",
        changeOrigin: true,
        ws: false,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../../dist/dashboard"),
    emptyOutDir: true,
  },
});

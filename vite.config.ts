import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: "./",
  publicDir: mode === "web" ? "public" : false,
  build: { outDir: mode === "web" ? "dist-web" : "dist" },
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg"] },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
}));

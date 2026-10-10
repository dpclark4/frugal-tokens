import process from "node:process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.FRUGAL_TOKENS_WEB_PORT ?? "5273"),
    strictPort: true,
    proxy: {
      "/api": `http://localhost:${process.env.PORT ?? "9000"}`,
    },
  },
  build: {
    outDir: "dist",
  },
});

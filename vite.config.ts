import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(Deno.env.get("FRUGAL_TOKENS_WEB_PORT") ?? "5273"),
    strictPort: true,
    proxy: {
      "/api": `http://localhost:${Deno.env.get("FRUGAL_TOKENS_API_PORT") ?? "9000"}`,
    },
  },
  build: {
    outDir: "dist",
  },
});

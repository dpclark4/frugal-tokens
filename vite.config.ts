import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:9000",
    },
  },
  build: {
    outDir: "dist",
  },
});

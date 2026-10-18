import process from "node:process";
import { execFileSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function runningCommit() {
  const override = process.env.FRUGAL_TOKENS_UPDATE_BASE_COMMIT;
  if (override) {
    if (!/^[a-f0-9]{40}$/.test(override)) {
      throw new Error(
        "FRUGAL_TOKENS_UPDATE_BASE_COMMIT must be a full commit SHA",
      );
    }
    console.warn("[update-check] Using debug base commit:", override);
    return override;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  define: {
    "import.meta.env.VITE_RUNNING_COMMIT": JSON.stringify(runningCommit()),
  },
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

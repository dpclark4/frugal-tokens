import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";

export async function runTitleProcess(
  executable: string,
  args: string[],
  timeoutMs = 60_000,
) {
  const command = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    command.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      new Promise<number>((resolve, reject) => {
        command.once("error", reject);
        command.once("close", (code) => resolve(code ?? 1));
      }),
      text(command.stdout),
      text(command.stderr),
    ]);
    if (timedOut) {
      throw new Error(
        `Codex title generation timed out after ${timeoutMs}ms; process killed`,
      );
    }
    return { code, stdout, stderr: stderr.trim() };
  } finally {
    clearTimeout(timeout);
  }
}

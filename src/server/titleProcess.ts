import { spawn } from "node:child_process";
import { constants } from "node:os";
import { text } from "node:stream/consumers";
import { childExitCode } from "../../scripts/childExitCode.ts";

export async function runTitleProcess(
  executable: string,
  args: string[],
  timeoutMs = 60_000,
) {
  const processGroup = process.platform !== "win32";
  const command = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: processGroup,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      // Settle independently of close/EOF: descendants may retain inherited pipes.
      reject(Object.assign(
        new Error(
          `Codex title generation timed out after ${timeoutMs}ms; process killed`,
        ),
        { exitCode: 128 + constants.signals.SIGKILL },
      ));
      try {
        if (processGroup && command.pid !== undefined) {
          process.kill(-command.pid, "SIGKILL");
        } else {
          command.kill("SIGKILL");
        }
      } catch (error) {
        // The process group may already have exited when the deadline fires.
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        ) {
          console.error("[generate titles] process cleanup failed", error);
        }
      }
    }, timeoutMs);
  });
  try {
    const [code, stdout, stderr] = await Promise.race([
      Promise.all([
        new Promise<number>((resolve, reject) => {
          command.once("error", reject);
          command.once(
            "close",
            (code, signal) => resolve(childExitCode(code, signal)),
          );
        }),
        text(command.stdout),
        text(command.stderr),
      ]),
      deadline,
    ]);
    return { code, stdout, stderr: stderr.trim() };
  } finally {
    clearTimeout(timeout);
    command.stdout.destroy();
    command.stderr.destroy();
    command.unref();
  }
}

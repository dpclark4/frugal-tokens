import { constants } from "node:os";

export function childExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  return code ?? (signal ? 128 + constants.signals[signal] : 1);
}

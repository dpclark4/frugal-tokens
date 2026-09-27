import { z } from "zod";

export const sessionModelSelectionLimit = 100;
export const sessionDirectorySelectionLimit = 100;

export const sessionDirectorySelectionSchema = z.array(
  z.string().min(1).max(4096).nullable(),
).max(sessionDirectorySelectionLimit);

export function sessionDirectoryGroup(path: string | null): string | null {
  return path?.match(/^(.*(?:^|\/)\.herdr\/worktrees\/[^/]+)(?:\/.*)?$/)?.[1] ??
    path;
}

export function isHerdrProjectDirectory(path: string): boolean {
  return /(?:^|\/)\.herdr\/worktrees\/[^/]+$/.test(path);
}

export const sessionModelSelectionSchema = z.array(z.string().min(1).max(512))
  .max(sessionModelSelectionLimit);

export const sessionFilterOptionsSchema = z.object({
  directories: z.array(z.object({
    path: z.string().nullable(),
    displayPath: z.string().optional(),
    sessionCount: z.number().int().nonnegative(),
  })),
  models: z.array(z.object({
    id: z.string(),
    sessionCount: z.number().int().nonnegative(),
  })),
});

export type SessionDirectoryOption = z.infer<
  typeof sessionFilterOptionsSchema
>["directories"][number];

export type SessionModelOption = z.infer<
  typeof sessionFilterOptionsSchema
>["models"][number];

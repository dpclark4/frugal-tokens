import { z } from "zod";

export const updateStatusSchema = z.object({
  status: z.enum(["available", "current", "unknown"]),
  currentCommit: z.string(),
  latestCommit: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

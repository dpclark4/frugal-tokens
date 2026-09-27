import { z } from "zod";

export const sessionModelSelectionSchema = z.array(z.string().min(1).max(512))
  .max(100);

export const sessionFilterOptionsSchema = z.object({
  models: z.array(z.object({
    id: z.string(),
    sessionCount: z.number().int().nonnegative(),
  })),
});

export type SessionModelOption = z.infer<
  typeof sessionFilterOptionsSchema
>["models"][number];

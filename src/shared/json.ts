import { z } from "zod";

export const jsonValueSchema = z.json();
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export type JsonValue = z.infer<typeof jsonValueSchema>;
export type JsonObject = z.infer<typeof jsonObjectSchema>;

export function parseJsonValue(text: string): JsonValue {
  return jsonValueSchema.parse(JSON.parse(text));
}

export function parseJsonObject(text: string): JsonObject {
  return jsonObjectSchema.parse(JSON.parse(text));
}

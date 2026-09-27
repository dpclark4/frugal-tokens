import {
  jsonObjectSchema,
  jsonStringValue,
  jsonValueSchema,
} from "../shared/json.ts";

/** Keep only complete top-level fields before a truncated object's tail. */
function completeObjectPrefix(value: string): string | undefined {
  if (!value.trimStart().startsWith("{")) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let boundary = -1;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{" || character === "[") depth++;
    else if (character === "}" || character === "]") depth--;
    else if (character === "," && depth === 1) boundary = index;
  }
  return boundary < 0 ? undefined : `${value.slice(0, boundary)}}`;
}

/** Select a readable argument, never a raw or truncated JSON object. */
export function toolTarget(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = jsonValueSchema.parse(JSON.parse(value));
    const direct = jsonStringValue(parsed);
    if (direct !== undefined) return direct.trim() ? direct : undefined;
    const object = jsonObjectSchema.safeParse(parsed);
    if (object.success) {
      for (
        const key of [
          "description",
          "prompt",
          "task",
          "command",
          "filePath",
          "file_path",
          "name",
          "path",
          "pattern",
          "query",
        ]
      ) {
        const candidate = jsonStringValue(object.data[key]);
        if (candidate?.trim()) return candidate;
      }
    }
  } catch {
    const prefix = completeObjectPrefix(value);
    if (prefix !== undefined) return toolTarget(prefix);
    if (!/^[\s]*[\[{]/.test(value)) return value;
  }
  return undefined;
}

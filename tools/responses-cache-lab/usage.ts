import {
  type CacheClassification,
  isObservedObject,
  type ObservedObject,
  type RawField,
  type UsageShape,
} from "./types.ts";

type CacheFieldClassification = {
  classification: CacheClassification;
  malformedFields: string[];
};

function hasOwn(record: ObservedObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function field(record: ObservedObject | undefined, key: string): RawField {
  if (!record || !hasOwn(record, key)) return { state: "missing" };
  const value = record[key];
  if (value === undefined) return { state: "undefined" };
  if (value === null) return { state: "null", value: null };
  return { state: "value", value };
}

function fieldKeys(value: unknown): string[] {
  return isObservedObject(value) ? Object.keys(value).sort() : [];
}

function validTokenCount(value: RawField): boolean {
  return value.state === "value" &&
    typeof value.value === "number" &&
    Number.isInteger(value.value) &&
    Number.isFinite(value.value) &&
    value.value >= 0;
}

function classifyCacheFields(
  details: unknown,
  detailsPresent: boolean,
): CacheFieldClassification {
  if (!detailsPresent) {
    return { classification: "omitted-cache-details", malformedFields: [] };
  }
  if (!isObservedObject(details)) {
    return {
      classification: "malformed/unexpected",
      malformedFields: ["input_tokens_details"],
    };
  }

  const cachedTokens = field(details, "cached_tokens");
  const cacheWriteTokens = field(details, "cache_write_tokens");
  const malformedFields: string[] = [];
  if (cachedTokens.state !== "missing" && !validTokenCount(cachedTokens)) {
    malformedFields.push("input_tokens_details.cached_tokens");
  }
  if (
    cacheWriteTokens.state !== "missing" && !validTokenCount(cacheWriteTokens)
  ) {
    malformedFields.push("input_tokens_details.cache_write_tokens");
  }

  // Keep malformed cache-write data visible even when cached_tokens is absent.
  if (malformedFields.length > 0) {
    return { classification: "malformed/unexpected", malformedFields };
  }
  if (cachedTokens.state === "missing" || cachedTokens.state === "undefined") {
    return { classification: "omitted-cached-tokens", malformedFields: [] };
  }
  if (cachedTokens.state !== "value") {
    return {
      classification: "malformed/unexpected",
      malformedFields: ["input_tokens_details.cached_tokens"],
    };
  }
  return {
    classification: cachedTokens.value === 0 ? "explicit-zero" : "nonzero",
    malformedFields: [],
  };
}

/**
 * Extracts only usage shape. It intentionally does not apply Pi's `|| 0`
 * normalization, so an absent field remains different from an explicit zero.
 */
export function extractUsageShape(response: unknown): UsageShape {
  const responseRecord = isObservedObject(response) ? response : undefined;
  const usageKeyPresent = responseRecord
    ? hasOwn(responseRecord, "usage")
    : false;
  const usageValue = responseRecord?.usage;
  const usagePresent = usageKeyPresent && usageValue !== null &&
    usageValue !== undefined;
  const usage = isObservedObject(usageValue) ? usageValue : undefined;
  const detailsPresent = Boolean(
    usage && hasOwn(usage, "input_tokens_details"),
  );
  const details = detailsPresent ? usage?.input_tokens_details : undefined;
  const cacheClassification = !usagePresent
    ? { classification: "usage-missing" as const, malformedFields: [] }
    : !usage
    ? {
      classification: "malformed/unexpected" as const,
      malformedFields: ["usage"],
    }
    : classifyCacheFields(details, detailsPresent);

  return {
    classification: cacheClassification.classification,
    usagePresent,
    usageKeys: usage ? Object.keys(usage).sort() : [],
    inputTokensDetailsPresent: detailsPresent,
    inputTokensDetailsKeys: fieldKeys(details),
    cachedTokens: field(
      isObservedObject(details) ? details : undefined,
      "cached_tokens",
    ),
    cacheWriteTokens: field(
      isObservedObject(details) ? details : undefined,
      "cache_write_tokens",
    ),
    inputTokens: field(usage, "input_tokens"),
    outputTokens: field(usage, "output_tokens"),
    totalTokens: field(usage, "total_tokens"),
    reasoningTokens: field(
      isObservedObject(usage?.output_tokens_details)
        ? usage.output_tokens_details
        : undefined,
      "reasoning_tokens",
    ),
    malformedFields: cacheClassification.malformedFields,
  };
}

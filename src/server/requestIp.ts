function extractFirstForwardedIp(
  forwardedFor: string | null | undefined,
): string | undefined {
  if (!forwardedFor) return undefined;

  return forwardedFor.split(",")[0]?.trim() || undefined;
}

function getCloudflareClientIp(headers: Headers): string | undefined {
  return headers.get("true-client-ip") ||
    headers.get("cf-connecting-ip") ||
    undefined;
}

function getGenericProxyClientIp(headers: Headers): string | undefined {
  return headers.get("x-real-ip") ||
    extractFirstForwardedIp(headers.get("x-forwarded-for"));
}

export function getRequestIp(
  headers: Headers,
  remoteAddress?: string | null,
): string | undefined {
  return getCloudflareClientIp(headers) ||
    getGenericProxyClientIp(headers) ||
    remoteAddress ||
    undefined;
}

#!/usr/bin/env bash
set -euo pipefail

BASE_URL=${MITM_WEB_URL:-http://127.0.0.1:8082}
TOKEN_FILE=${MITM_WEB_TOKEN_FILE:-$HOME/.mitmproxy/frugal-test-mitmweb.token}
URL_SUBSTRING=${MITM_KILL_URL_SUBSTRING:-/backend-api/codex/responses}

if [[ ! -r "$TOKEN_FILE" ]]; then
  printf 'Missing mitmweb token file: %s\n' "$TOKEN_FILE" >&2
  exit 1
fi

COOKIE=$(mktemp)
FLOWS=$(mktemp)
trap 'rm -f "$COOKIE" "$FLOWS"' EXIT

TOKEN=$(<"$TOKEN_FILE")
LOGIN_HTML=$(curl --silent --show-error --max-time 5 \
  -c "$COOKIE" "$BASE_URL/")
XSRF_FORM=$(printf '%s' "$LOGIN_HTML" |
  sed -n 's/.*name="_xsrf" value="\([^"]*\)".*/\1/p')
XSRF_COOKIE=$(awk '$6 == "_mitmproxy_xsrf" {print $7}' "$COOKIE" | tail -n 1)

if [[ -z "$XSRF_FORM" || -z "$XSRF_COOKIE" ]]; then
  printf 'Could not initialize mitmweb authentication.\n' >&2
  exit 1
fi

curl --silent --show-error --max-time 5 \
  -b "$COOKIE" -c "$COOKIE" -X POST "$BASE_URL/" \
  --data-urlencode "token=$TOKEN" \
  --data-urlencode "_xsrf=$XSRF_FORM" \
  -o /dev/null

curl --silent --show-error --fail --max-time 5 \
  -b "$COOKIE" "$BASE_URL/flows" -o "$FLOWS"

MATCH=$(python3 - "$FLOWS" "$URL_SUBSTRING" <<'PY'
import json
import sys

path, substring = sys.argv[1:]
flows = json.load(open(path, encoding="utf-8"))
candidates = []
for flow in flows:
    request = flow.get("request") or {}
    response = flow.get("response") or {}
    websocket = flow.get("websocket") or {}
    headers = {
        str(key).lower(): str(value).lower()
        for key, value in request.get("headers", [])
    }
    is_websocket = (
        bool(websocket)
        or flow.get("type") == "websocket"
        or headers.get("upgrade") == "websocket"
    )
    response_is_live = not response or response.get("timestamp_end") is None
    if not is_websocket and not response_is_live:
        continue
    url = f"{request.get('scheme', '')}://{request.get('host', '')}{request.get('path', '')}"
    if substring and substring not in url:
        continue
    kind = "websocket" if is_websocket else "http-stream"
    candidates.append((request.get("timestamp_start", 0), flow, url, kind))

if not candidates:
    print("", end="")
    raise SystemExit

_, flow, url, kind = max(candidates, key=lambda item: item[0])
print("\t".join([
    str(flow.get("id", "")),
    url,
    str(len(websocket.get("messages", []))),
    kind,
]))
PY
)

if [[ -z "$MATCH" ]]; then
  printf 'No matching live response flow found for: %s\n' "$URL_SUBSTRING"
  exit 2
fi

IFS=$'\t' read -r FLOW_ID FLOW_URL MESSAGE_COUNT FLOW_KIND <<< "$MATCH"
printf 'Killing %s flow:\n  %s\n  captured_messages=%s\n' "$FLOW_KIND" "$FLOW_URL" "$MESSAGE_COUNT"

STATUS=$(curl --silent --show-error --max-time 5 \
  -b "$COOKIE" -X POST "$BASE_URL/flows/$FLOW_ID/kill" \
  -H "X-XSRFToken: $XSRF_COOKIE" \
  -o /dev/null -w '%{http_code}')
printf 'mitmweb kill response: HTTP %s\n' "$STATUS"

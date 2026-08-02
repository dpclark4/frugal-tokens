#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WIRETAP="$ROOT/codex-wiretap.mjs"

if [[ ! -f "$WIRETAP" ]]; then
  printf 'Missing wiretap module: %s\n' "$WIRETAP" >&2
  exit 1
fi

if [[ -z "${PI_CODEX_WIRETAP_FILE:-}" ]]; then
  directory="${PI_CODEX_WIRETAP_DIR:-$HOME/.pi/agent/diagnostics/cache-telemetry/wiretap}"
  mkdir -p "$directory"
  chmod 700 "$directory" 2>/dev/null || true
  timestamp=$(date -u '+%Y-%m-%dT%H-%M-%SZ')
  export PI_CODEX_WIRETAP_FILE="$directory/codex-websocket-${timestamp}-${$}.jsonl"
fi

if [[ -n "${NODE_OPTIONS:-}" ]]; then
  export NODE_OPTIONS="--import=$WIRETAP $NODE_OPTIONS"
else
  export NODE_OPTIONS="--import=$WIRETAP"
fi

printf 'Pi Codex WebSocket wiretap: %s\n' "$PI_CODEX_WIRETAP_FILE" >&2
exec pi "$@"

#!/usr/bin/env bash
# Print a privacy-safe token/cost summary for a Pi JSONL session.
# Usage: pi-session-usage [session.jsonl]
set -euo pipefail

for command in jq find xargs ls head; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Error: required command not found: %s\n' "$command" >&2
    exit 1
  }
done

if (( $# > 1 )); then
  printf 'Usage: %s [session.jsonl]\n' "$0" >&2
  exit 1
fi

if (( $# == 1 )); then
  SESSION=$1
else
  SESSION=$(find "${PI_SESSION_DIR:-$HOME/.pi/agent/sessions}" \
    -type f -name '*.jsonl' -print0 2>/dev/null |
    xargs -0 ls -t 2>/dev/null | head -n 1)
fi

if [[ -z "${SESSION:-}" || ! -f "$SESSION" ]]; then
  printf 'Error: no Pi session file found.\n' >&2
  exit 1
fi

printf 'Session: %s\n\n' "$SESSION"

jq -sr '
  reduce .[] as $record (
    {turn: 0, call: 0, images: 0, previous_cache: null, rows: []};
    ($record.message // {}) as $message |
    if $record.type != "message" then .
    elif $message.role == "user" and (
      [$message.content[]? | select(.type == "text") | .text // ""] | join("") | test("\\S")
    ) then
      .turn += 1 | .call = 0 |
      ([$message.content[]? | select(.type == "image" or .type == "input_image")] | length) as $image_blocks |
      .images = (if $image_blocks > 0 then $image_blocks else
        ([$message.content[]? | select(.type == "text") | .text // "" |
          select(test("(?:^|[[:space:]\"])[^[:space:]\"]+\\.(?:png|jpe?g|gif|webp|bmp)(?:$|[[:space:]\"])"; "i"))] | length)
        end)
    elif $message.role == "assistant" and $message.usage != null and .turn > 0 then
      ($message.usage) as $usage |
      ($usage.input // 0) as $input |
      ($usage.cacheRead // 0) as $cache |
      ($usage.cacheWrite // 0) as $write |
      ($usage.output // 0) as $output |
      ($usage.reasoning // 0) as $reasoning |
      ($usage.cost.total // 0) as $cost |
       (if .previous_cache == null then "baseline"
       elif $cache == 0 then "full-miss"
       elif $cache >= .previous_cache then "hit"
        else "partial-hit"
       end) as $status |
      .call += 1 |
      .rows += [[
        .turn, .call,
        ($message.provider // "unknown"),
        ($message.model // "unknown"),
        $input, $cache, $write,
        ($input + $write), $output, $reasoning, $cost, $status, .images
      ]] |
      .previous_cache = $cache | .images = 0
    else . end
  )
  | .rows
  | map(select((.[4] + .[5] + .[6] + .[8] + .[9] + .[10]) > 0))
  | (map(.[0]) | unique) as $turns
  | .[] as $row
  | $row
  | .[0] = (($turns | index($row[0])) + 1)
  | @tsv
' "$SESSION" |
awk -F '\t' '
BEGIN {
  printf "%-5s %-16s %-20s %3s %8s %8s %8s %8s %8s %8s %11s %12s\n",
    "T.C", "PROVIDER", "MODEL", "IMG", "INPUT", "CACHE", "WRITE", "NEW", "OUT", "RSN", "REPORTED", "CACHE"
}
{
  tc = sprintf("%d.%d", $1, $2)
  provider = $3
  model = $4
  if (length(provider) > 16) provider = substr(provider, 1, 15) "~"
  if (length(model) > 20) model = substr(model, 1, 19) "~"
  printf "%-5s %-16s %-20s %3s %8d %8d %8d %8d %8d %8d %11s %12s\n",
    tc, provider, model, ($13 == 0 ? "-" : "Y"), $5, $6, $7, $8, $9, $10,
    sprintf("$%.6f", $11), $12
}'

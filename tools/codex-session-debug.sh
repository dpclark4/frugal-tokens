#!/usr/bin/env bash

set -euo pipefail

for command in find jq awk; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Error: required command not found: %s\n' "$command" >&2
    exit 1
  fi
done

if (( $# > 1 )); then
  printf 'Usage: %s [session.jsonl]\n' "$0" >&2
  exit 1
fi

if (( $# == 1 )); then
  SESSION=$1
else
  SESSION=$(
    find "$HOME/.codex/sessions" -type f -name 'rollout-*.jsonl' -print0 2>/dev/null |
      xargs -0 ls -t 2>/dev/null |
      head -n 1
  )
fi

if [[ -z "${SESSION:-}" || ! -f "$SESSION" ]]; then
  printf 'Error: no Codex session file found.\n' >&2
  exit 1
fi

MODEL=$(jq -nr '
  first(
    inputs
    | select(.type == "turn_context" and .payload.model != null)
    | .payload.model
  ) // "unknown"
' "$SESSION")

printf 'Session: %s\n' "$SESSION"
printf 'Model:   %s\n\n' "$MODEL"

jq -nr '
  foreach inputs as $e (
    {
      turn: 0,
       call: 0,
       action: "model",
       images: 0,
       prev_input: null,
      prev_cached: null,
      row: null
    };

    .row = null

    | if $e.type == "event_msg"
         and $e.payload.type == "task_started"
       then
         .turn += 1
         | .call = 0
         | .action = "model"

      elif $e.type == "response_item"
           and $e.payload.type == "message"
           and $e.payload.role == "user"
      then
        .images += ([ $e.payload.content[]? | select(.type == "input_image") ] | length)

      elif $e.type == "response_item"
           and $e.payload.type == "custom_tool_call"
      then
        .action = (
          "tool: " + $e.payload.name
          + (
              if ($e.payload.input | type) == "string"
                 and ($e.payload.input | test("tools\\.[A-Za-z0-9_]+"))
              then
                " -> "
                + (
                    $e.payload.input
                    | capture("tools\\.(?<name>[A-Za-z0-9_]+)")
                    | .name
                  )
              else ""
              end
            )
        )

      elif $e.type == "response_item"
           and $e.payload.type == "message"
           and $e.payload.role == "assistant"
           and $e.payload.phase == "final_answer"
      then
        .action = "final response"

      elif $e.type == "event_msg"
           and $e.payload.type == "token_count"
           and $e.payload.info.last_token_usage != null
      then
        .call += 1

        | ($e.payload.info.last_token_usage) as $usage
        | ($usage.input_tokens // 0) as $input
        | ($usage.cached_input_tokens // 0) as $cached

        | (
            if .prev_input == null
            then null
            else $input - .prev_input
            end
          ) as $input_delta

        | (
            if .prev_cached == null
            then null
            else $cached - .prev_cached
            end
          ) as $cache_delta

        | (
            if .prev_cached == null or $cached >= .prev_cached
            then 0
            else .prev_cached - $cached
            end
          ) as $cache_lost

        | (
            if .prev_input != null and $input < .prev_input
            then "CONTEXT_SHRANK"
            elif $cache_lost > 0
            then "CACHE_REGRESSION"
            else ""
            end
          ) as $flag

         | .row = [
             .turn,
             .call,
             (
               if .images == 0
                 then .action
                 elif .images == 1
                 then "image + " + .action
                 else (.images | tostring) + " images + " + .action
                 end
             ),
            $input,
            $cached,
            ($input - $cached),
            (
              if $input == 0
              then 0
              else 100 * $cached / $input
              end
            ),
            $input_delta,
            $cache_delta,
            $cache_lost,
            ($usage.output_tokens // 0),
            ($usage.reasoning_output_tokens // 0),
            $flag
          ]

        | .prev_input = $input
         | .prev_cached = $cached
         | .action = "model"
         | .images = 0

      else .
      end;

    if .row then .row | @tsv else empty end
  )
' "$SESSION" |
  awk -F '\t' '
  BEGIN {
    printf "%-5s %-16s %8s %8s %8s %6s %8s %8s %8s %6s %6s  %s\n",
           "T.C", "ACTION", "INPUT", "CACHE", "MISS", "HIT",
           "D_INPUT", "D_CACHE", "LOST", "OUT", "RSN", "FLAG"
  }
  {
    tc     = sprintf("%d.%d", $1, $2)
    action = $3
    din    = ($8 == "" ? "-" : sprintf("%+d", $8))
    dc     = ($9 == "" ? "-" : sprintf("%+d", $9))
    lost   = ($10 == 0 ? "-" : $10)
    flag   = ($13 == "" ? "-" : $13)

    if (length(action) > 16)
      action = substr(action, 1, 15) "~"

    printf "%-5s %-16s %8d %8d %8d %5.1f%% %8s %8s %8s %6d %6d  %s\n",
           tc, action, $4, $5, $6, $7,
           din, dc, lost, $11, $12, flag
  }'

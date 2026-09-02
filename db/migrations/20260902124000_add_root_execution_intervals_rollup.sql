-- migrate:up
ALTER TABLE conversation_rollups
  ADD COLUMN root_execution_intervals_json TEXT
  CHECK (root_execution_intervals_json IS NULL OR json_valid(root_execution_intervals_json));

UPDATE conversation_rollups AS rollup
SET root_execution_intervals_json = (
  SELECT COALESCE(json_group_array(json_object(
    'startedAt', measured.started_at,
    'executionEndAt', measured.execution_end_at
  )), '[]')
  FROM (
    SELECT root_turn.started_at,
      MAX(
        root_turn.started_at,
        MAX(COALESCE(
          root_tool.completed_at,
          root_tool.started_at,
          root_call.completed_at,
          root_call.started_at
        ))
      ) AS execution_end_at
    FROM conversation_turns root_turn
    JOIN conversation_model_calls root_call
      ON root_call.turn_id = root_turn.id
    LEFT JOIN conversation_tool_events root_tool
      ON root_tool.model_call_id = root_call.id
    WHERE root_turn.conversation_id = rollup.conversation_id
      AND COALESCE(root_call.source_call_id, '')
        NOT LIKE 'context-operation:%'
      AND COALESCE(root_call.source_call_id, '')
        NOT LIKE 'unmeasured:%'
    GROUP BY root_turn.id
    ORDER BY root_turn.ordinal
  ) AS measured
);

-- migrate:down
ALTER TABLE conversation_rollups DROP COLUMN root_execution_intervals_json;

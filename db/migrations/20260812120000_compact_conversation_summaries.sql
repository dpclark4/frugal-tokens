-- migrate:up
UPDATE conversation_rollups AS rollup
SET summary_json = CASE
  WHEN EXISTS (
    SELECT 1
    FROM conversation_model_calls call
    WHERE call.conversation_id = rollup.conversation_id
      AND call.reasoning_setting_value IS NOT NULL
      AND COALESCE(call.source_call_id, '') NOT LIKE 'context-operation:%'
  ) THEN json_set(
    json_remove(
      summary_json,
      '$.turns', '$.subagents', '$.contextEvents', '$.agent',
      '$.sourcePath', '$.internalID', '$.subagentModelCalls'
    ),
    '$.thinking',
    json_object(
      'latest', (
        SELECT call.reasoning_setting_value
        FROM conversation_model_calls call
        WHERE call.conversation_id = rollup.conversation_id
          AND call.reasoning_setting_value IS NOT NULL
          AND COALESCE(call.source_call_id, '') NOT LIKE 'context-operation:%'
        ORDER BY call.started_at DESC, call.ordinal DESC
        LIMIT 1
      ),
      'values', json((
        SELECT json_group_array(value)
        FROM (
          SELECT call.reasoning_setting_value AS value
          FROM conversation_model_calls call
          WHERE call.conversation_id = rollup.conversation_id
            AND call.reasoning_setting_value IS NOT NULL
            AND COALESCE(call.source_call_id, '') NOT LIKE 'context-operation:%'
          GROUP BY call.reasoning_setting_value
          ORDER BY MIN(call.started_at), MIN(call.ordinal)
        )
      )),
      'classifiedCalls', (
        SELECT COUNT(*)
        FROM conversation_model_calls call
        WHERE call.conversation_id = rollup.conversation_id
          AND call.reasoning_setting_value IS NOT NULL
          AND COALESCE(call.source_call_id, '') NOT LIKE 'context-operation:%'
      )
    )
  )
  ELSE json_remove(
    summary_json,
    '$.turns', '$.subagents', '$.contextEvents', '$.agent',
    '$.sourcePath', '$.internalID', '$.subagentModelCalls'
  )
END
WHERE summary_json IS NOT NULL;

-- migrate:down
-- Summary materializations are disposable and are rebuilt by the next sync.
UPDATE conversation_rollups SET summary_json = NULL;

// Keep only the event marker and numeric attribution needed to classify misses.
// Compaction summaries, file paths, and other native metadata remain redacted.
export const demoContextMetadataSql = `json_patch(
  json_object(
    'type', CASE WHEN json_extract(native_metadata_json, '$.type') = 'compaction'
      THEN 'compaction' ELSE 'redacted' END,
    'sourceOrder', CASE
      WHEN json_type(native_metadata_json, '$.sourceOrder') = 'integer'
        AND json_extract(native_metadata_json, '$.sourceOrder') > 0
      THEN json_extract(native_metadata_json, '$.sourceOrder') ELSE 1 END
  ),
  CASE WHEN json_type(native_metadata_json, '$.affectedCall.turn') = 'integer'
    AND json_type(native_metadata_json, '$.affectedCall.call') = 'integer'
  THEN json_object('affectedCall', json_object(
    'turn', json_extract(native_metadata_json, '$.affectedCall.turn'),
    'call', json_extract(native_metadata_json, '$.affectedCall.call')
  )) ELSE '{}' END
)`;

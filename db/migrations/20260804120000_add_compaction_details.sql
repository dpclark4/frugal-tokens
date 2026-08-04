-- migrate:up
CREATE TABLE compaction_details (
  context_event_id INTEGER PRIMARY KEY
    REFERENCES context_events(id) ON DELETE CASCADE,
  source_compaction_id TEXT,
  trigger_kind TEXT NOT NULL DEFAULT 'unknown' CHECK (
    trigger_kind IN ('manual', 'automatic', 'threshold', 'overflow', 'unknown')
  ),
  result_kind TEXT NOT NULL CHECK (
    result_kind IN (
      'plaintext-summary', 'encrypted-checkpoint', 'unavailable'
    )
  ),
  checkpoint_completeness TEXT NOT NULL CHECK (
    checkpoint_completeness IN (
      'complete', 'partial', 'summary-only', 'unknown'
    )
  ),
  pre_context_tokens INTEGER CHECK (
    pre_context_tokens IS NULL OR pre_context_tokens >= 0
  ),
  post_context_tokens INTEGER CHECK (
    post_context_tokens IS NULL OR post_context_tokens >= 0
  ),
  dropped_context_tokens INTEGER CHECK (
    dropped_context_tokens IS NULL OR dropped_context_tokens >= 0
  ),
  retained_item_count INTEGER CHECK (
    retained_item_count IS NULL OR retained_item_count >= 0
  ),
  dropped_item_count INTEGER CHECK (
    dropped_item_count IS NULL OR dropped_item_count >= 0
  ),
  native_metadata_json TEXT CHECK (
    native_metadata_json IS NULL OR json_valid(native_metadata_json)
  )
);

CREATE TABLE compaction_checkpoint_items (
  id INTEGER PRIMARY KEY,
  context_event_id INTEGER NOT NULL
    REFERENCES compaction_details(context_event_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  source_entry_id TEXT,
  item_kind TEXT NOT NULL CHECK (length(item_kind) > 0),
  role TEXT,
  content_availability TEXT NOT NULL CHECK (
    content_availability IN (
      'plaintext', 'encrypted', 'reference-only', 'unavailable'
    )
  ),
  content_preview TEXT,
  original_length INTEGER CHECK (
    original_length IS NULL OR original_length >= 0
  ),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  content_hash TEXT,
  native_metadata_json TEXT CHECK (
    native_metadata_json IS NULL OR json_valid(native_metadata_json)
  ),
  UNIQUE (context_event_id, ordinal)
);

-- Force existing source sessions through updated importers so durable source
-- compaction records populate the new optional detail tables.
UPDATE source_sessions SET parser_version = NULL;

-- migrate:down
DROP TABLE compaction_checkpoint_items;
DROP TABLE compaction_details;

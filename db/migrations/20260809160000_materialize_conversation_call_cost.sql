-- migrate:up
ALTER TABLE conversation_model_calls
  ADD COLUMN computed_cost REAL
  CHECK (computed_cost IS NULL OR computed_cost >= 0);

-- Existing conversation projections are rebuilt by their parser-version bumps,
-- which prices every canonical call while retaining reported cost separately.

-- migrate:down
ALTER TABLE conversation_model_calls DROP COLUMN computed_cost;

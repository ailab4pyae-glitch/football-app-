-- Unique constraint to support ON CONFLICT upserts in scrapers
CREATE UNIQUE INDEX IF NOT EXISTS matches_source_match_id_source_name_key
  ON matches (source_match_id, source_name);

-- Auth: LATERAL subquery on subscriptions needs composite index
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status
  ON subscriptions(user_id, status);

-- Stream health job: filters (is_healthy, last_checked) every 5 min
CREATE INDEX IF NOT EXISTS idx_stream_urls_healthy_checked
  ON stream_urls(is_healthy, last_checked ASC NULLS FIRST)
  WHERE is_healthy = true;

-- Stream query: filters (match_id, is_healthy, expires_at) on every stream request
CREATE INDEX IF NOT EXISTS idx_stream_urls_match_healthy
  ON stream_urls(match_id, is_healthy)
  WHERE is_healthy = true;

-- Matches: china-live detection in streams route (source_name = 'chinalive')
CREATE INDEX IF NOT EXISTS idx_matches_source_name
  ON matches(source_name);

-- Matches: main-live query filters tab_id + status on every page load
CREATE INDEX IF NOT EXISTS idx_matches_tab_status
  ON matches(tab_id, status)
  WHERE status != 'finished';

-- Team logos: lookup by key is the hot path; already has idx but ensure partial index
CREATE INDEX IF NOT EXISTS idx_team_logos_key_partial
  ON team_logos(team_key)
  WHERE logo_url IS NOT NULL;

-- New tab: Soco API — direct HLS/FLV streams pulled via API, no Playwright, no iframes
INSERT INTO tabs (id, name, slug, position, source_type, is_active, icon, color, description, config)
VALUES (
  gen_random_uuid(),
  'Soco API',
  'soco-api',
  6,
  'scraper',
  true,
  'zap',
  '#22c55e',
  'SOCO Live via direct API — HLS/FLV only, no iframes',
  '{"sync_interval_ms": 120000}'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

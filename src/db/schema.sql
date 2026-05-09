-- Football Live Streaming Aggregator Database Schema

-- Tabs table for different streaming categories
CREATE TABLE tabs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    position INTEGER NOT NULL,
    source_type VARCHAR(50) NOT NULL, -- e.g., 'api', 'scraper'
    base_domain VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sources table for different streaming sources
CREATE TABLE sources (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    driver_type VARCHAR(50) NOT NULL, -- 'api' or 'scraper'
    base_domain VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    health_score INTEGER DEFAULT 100,
    last_domain_check TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Matches table for football matches
CREATE TABLE matches (
    id SERIAL PRIMARY KEY,
    tab_id INTEGER REFERENCES tabs(id) ON DELETE CASCADE,
    title VARCHAR(500) NOT NULL,
    home_team VARCHAR(255) NOT NULL,
    away_team VARCHAR(255) NOT NULL,
    home_logo VARCHAR(500),
    away_logo VARCHAR(500),
    status VARCHAR(20) NOT NULL DEFAULT 'scheduled', -- 'live', 'scheduled', 'finished'
    scheduled_at TIMESTAMP,
    source_match_id VARCHAR(255), -- ID from the source
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Stream URLs table for match streaming links
CREATE TABLE stream_urls (
    id SERIAL PRIMARY KEY,
    match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    quality VARCHAR(10) NOT NULL, -- 'SD' or 'HD'
    source_name VARCHAR(255),
    priority INTEGER DEFAULT 1,
    is_healthy BOOLEAN DEFAULT TRUE,
    last_checked TIMESTAMP,
    fail_count INTEGER DEFAULT 0,
    expires_at TIMESTAMP
);

-- Indexes for better performance
CREATE INDEX idx_matches_tab_id ON matches(tab_id);
CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_matches_scheduled_at ON matches(scheduled_at);
CREATE INDEX idx_stream_urls_match_id ON stream_urls(match_id);
CREATE INDEX idx_stream_urls_is_healthy ON stream_urls(is_healthy);
CREATE INDEX idx_tabs_slug ON tabs(slug);
CREATE INDEX idx_sources_driver_type ON sources(driver_type);
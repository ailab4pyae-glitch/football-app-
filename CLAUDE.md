# Football Live Streaming App

## Project Overview
Sports live streaming aggregator web app targeting global users with Myanmar focus.

## Tech Stack
- **Backend:** Node.js + Fastify
- **DB:** PostgreSQL (Neon)
- **Cache:** Redis (Upstash)
- **Queue:** BullMQ
- **Scraper:** Playwright

## Tabs / Categories
1. **Main Live** - Integration with streamed.su API
2. **SOCO Live** - Scraper for socolive.tv
3. **China Live** - Scraper for yyzbw8.live
4. **Loungsan** - Aggregation of alternative sources
5. **English** - Filtered for English commentary only

## Stream URL Rules
- **Quality Options:** Each match must store both SD and HD URLs.
- **Monitoring:** Health check performed every 2 minutes.
- **Failover:** Automatic fallback to the next available server upon failure.
- **Token Management:** Pre-expire refresh triggered at 70% of the token's lifetime.

## Coding Standards & Guidelines
- **Asynchronous Patterns:** Always use `async/await` for asynchronous operations.
- **Robustness:** Implement comprehensive error handling on every DB and API call.
- **Performance:** Check Redis cache before executing any DB query.
- **Security:** Use environment variables for all secrets and sensitive configurations.

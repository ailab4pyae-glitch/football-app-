# Football Live Streaming Aggregator Backend

A Node.js + Fastify backend for aggregating live football streaming sources.

## Tech Stack

- **Backend:** Node.js + Fastify
- **Database:** PostgreSQL
- **Cache:** Redis
- **Queue:** BullMQ
- **Scraper integration:** streamed.su API

## Project Structure

```
football-app/
├── src/
│   ├── config/
│   │   ├── database.js
│   │   └── redis.js
│   ├── db/
│   │   └── schema.sql
│   ├── jobs/
│   │   └── syncMatches.js
│   ├── routes/
│   │   ├── tabs.js
│   │   ├── matches.js
 │   │   └── streams.js
│   ├── services/
│   │   └── streamedSu.js
 │   └── index.js
├── .env.example
├── .gitignore
└── package.json
```

## Environment

Copy `.env.example` to `.env` and fill in values:

```bash
cp .env.example .env
```

Example values:

```env
DATABASE_URL=postgresql://user:pass@host/dbname
REDIS_URL=redis://default:pass@host:port
PORT=3000
NODE_ENV=development
```

## Install

```bash
npm install
```

## Database Migration

```bash
env DATABASE_URL="your_database_url" npm run db:migrate
```

## Run

```bash
npm run dev
```

## API Endpoints

- `GET /health` - Server health check
- `GET /api/tabs` - Active tabs
- `GET /api/matches?tab=slug` - Matches for a tab
- `GET /api/matches/:id` - Match detail
- `GET /api/streams/:matchId` - Stream URLs for a match

## Notes

- Routes cache responses in Redis
- `syncMatches` job runs every 5 minutes via BullMQ
- Schema uses UUID primary keys and timestamp fields

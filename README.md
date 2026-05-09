# Football Live Streaming Aggregator Backend

A Node.js backend for aggregating football live streaming sources using Fastify.

## Tech Stack

- **Backend:** Node.js + Fastify
- **Database:** PostgreSQL
- **Cache:** Redis
- **Queue:** BullMQ
- **Scraper:** Playwright

## Setup Instructions

1. **Clone the repository:**
   ```bash
   git clone https://github.com/lapyae123/Football-backend.git
   cd football-app
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Environment Setup:**
   - Copy `.env.example` to `.env`
   - Fill in your actual values:
     - `DATABASE_URL`: Your PostgreSQL connection string
     - `REDIS_URL`: Your Redis connection URL
     - `PORT`: Port for the server (default: 3000)

4. **Database Setup:**
   - Ensure PostgreSQL is running
   - Create the database if needed

5. **Redis Setup:**
   - Ensure Redis is running

6. **Run the application:**
   - Development: `npm run dev`
   - Production: `npm start`

The server will start on the specified PORT (default 3000).

## Project Structure

```
src/
├── config/          # Configuration files
├── jobs/            # BullMQ job handlers
├── models/          # Database models
├── routes/          # API routes
├── scrapers/        # Playwright scrapers
└── services/        # Business logic services
```

## API Endpoints

- `GET /` - Health check
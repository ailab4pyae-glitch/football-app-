# Football App — Developer Notes (မြန်မာဘာသာ)

---

## Project Structure

```
football-app/   ← Backend (Node.js + Fastify, port 3050)
streamzone/     ← Frontend (Next.js, port 3000)
```

---

## ၁. Scraping Logic — ဘယ်လိုအလုပ်လုပ်လဲ

### SOCO Live (`src/scrapers/socolive.js`)

Playwright headless Chrome သုံးပြီး **XHR Interception** နည်းလမ်းနဲ့ data ထုတ်ယူတယ်။

**ဘာကြောင့် XHR Interception သုံးသလဲ**
- SOCO site တွေဟာ domain ပြောင်းလဲနေတယ် — CSS selector scraping ဆိုရင် HTML ပြောင်းတိုင်း ကုဒ်ပြင်ရတယ်
- XHR interception ဆိုရင် site ကို redesign လုပ်ပေမယ့် API response format မပြောင်းမချင်း scraper ဆက်အလုပ်လုပ်တယ်

**ဆင့် ၁ — Match List (XHR Interception)**

```
Playwright → SOCO mirror ဖွင့်တယ်
    ↓
Browser က fb-api.apiscoreflow.com/football ကို XHR call လုပ်တယ်
    ↓
ကျွန်တော်တို့က အဲ့ response ကို intercept လုပ်ပြီး JSON parse လုပ်တယ်
    ↓
Match list ကို clean JSON အနေနဲ့ ရတယ် (HTML parsing မလိုဘူး)
```

XHR မရရင် → CSS selector fallback (`.match-item`) ကို သုံးတယ်။

**ဆင့် ၂ — Stream URLs (Network Interception)**
Live ပွဲတွေအတွက်သာ match page ကို visit လုပ်ပြီး:
1. Context-level network listener → `.m3u8` / `.flv` CDN URL အားလုံး capture လုပ်တယ်
2. iframe တွေကို real page အဖြစ် ဖွင့်ပြီး play button click လုပ်တယ်
3. Video bytes တွေ server ကို မဖြတ်ဘူး — CDN URL သာ သိမ်းတယ် (copyright-safe)

**Copyright-Safe ဖြစ်ပုံ**
- Match data (team name, score, schedule) = factual data မို့ copyright မကျဘူး
- Stream URL = publicly accessible CDN link — user browser ကနေ တိုက်ရိုက်ဆက်သွားတယ်
- Video stream bytes — server ကို လုံးဝမဖြတ်ဘူး

---

**Auto-Discovery — Domain ပြောင်းလဲမှုကို ကိုင်တွယ်ပုံ**

SOCO team က copyright takedown ကြောင့် domain ပြောင်းနေကြတယ်။ Scraper က auto-discover လုပ်နိုင်တယ်:

```
Mirror URL အားလုံး fail
    ↓
s2sprediction.net (stable SEO domain) ကို visit လုပ်တယ်
    ↓
<link rel="alternate" href="https://new-mirror.com"> tag ကို ဖတ်တယ်
    ↓
New mirror URL ကို test လုပ်တယ်
    ↓
DB ထဲ auto-save → နောက်ကြိမ် run မှာ အဲ့ URL ကိုပဲ သုံးတယ်
```

Code: `discoverMirror()` function — `src/scrapers/socolive.js`
DB update: `sources.config.base_urls` — Admin panel restart မလိုဘဲ အလုပ်လုပ်တယ်

---

### China Live (`src/scrapers/chinalive.js`)

Browser မလိုဘူး — JSON API ကို HTTP request တိုက်ရိုက်ခေါ်တယ်။

**API ၃ ခု concurrent ဆွဲတယ်:**

```
GET https://json.yyzb456.top/all_live_rooms.json              → live ပွဲစာရင်း (roomNum, title)
GET https://json.yyzb456.top/match/matches_YYYYMMDD.json      → ပွဲဇယား + team logo (per-team badge)
GET https://json.yyzb456.top/room/{roomNum}/detail.json       → stream URLs
```

**Team Logo ရပုံ (Key Logic):**
- `matches_YYYYMMDD.json` ထဲမှာ `anchors[].anchor.roomNum` ပါတယ်
- `all_live_rooms.json` ကနေ roomNum ကိုသုံးပြီး schedule entry lookup လုပ်တယ်
- Schedule hit → `hostIcon` (home badge) + `guestIcon` (away badge) ကို logo အဖြစ်သုံးတယ်
- Logo URL: `https://sta.yyzb456.top/file/imgs/team/football/...` (proper team badges)
- Schedule miss → title parse + broadcast cover image ကို fallback အဖြစ်သုံးတယ်

**Stream URL ထုတ်ယူပုံ:**
- Known fields: `hdM3u8` (HD), `m3u8` (SD), `hdFlv` (HD), `flv` (SD)
- Fallback: stream object ထဲက field တိုင်းကို scan လုပ်ပြီး `.m3u8` / `.flv` URL ပါတာ ယူတယ်
- `hd`, `high`, `1080`, `720` keyword ပါတဲ့ field → HD အဖြစ် classify

Sports category (`liveTypeParent=1`) + live status (`liveStatus=1`) ပွဲတွေကိုသာ စစ်ထုတ်တယ်။

---

## ၂. Database — Stream URL သိမ်းပုံ

`stream_urls` table:

| Field | အဓိပ္ပါယ် |
|---|---|
| `quality` | `HD` သို့မဟုတ် `SD` |
| `priority` | HD=2, SD=1 |
| `is_healthy` | scrape ချိန်မှာ `true` |
| `expires_at` | SOCO: token expiry (auth_key) သို့မဟုတ် +2 hours; China: +50 minutes |
| `fail_count` | health check fail ရေ |

Frontend က stream query လုပ်ရင် SD ဦးစွာ၊ ပြီးမှ HD၊ latency နည်းတာ ဦးစားပေး (SD ကနေ စတင်ကြည့်တာ ပိုကောင်းတဲ့ UX)

---

## ၃. Health Check (`src/jobs/urlHealthJob.js`)

**Interval: 10 မိနစ်တစ်ကြိမ်**

- DB ထဲက `is_healthy=true` stream တွေကို HEAD request ဆက်ပို့ပြီး စစ်တယ်
- Response မလာ / error → `fail_count++`
- **`fail_count >= 10`** ဆိုမှ `is_healthy = false` → dead mark
- SOCO stream fail → `rerunSoco()` re-scrape
- China stream fail → `rerunChina()` re-scrape
- Expired URL (`expires_at < NOW()`) → `is_healthy = false`

---

## ၃(က). Finished Match Cleanup Job (`src/jobs/finishedMatchCleanupJob.js`) — သစ်

**Interval: 20 မိနစ်တစ်ကြိမ်** (default — `app_config.cleanup` ကနေ ပြောင်းလို့ရတယ်)

Health check job နဲ့ ခွဲပြီး dedicated cleanup job တစ်ခု ထည့်ထားတယ်:

| Task | Logic |
|---|---|
| Scheduled → Finished | Kickoff ပြီး 2h ကျော်ပြီ ဆိုရင် |
| Live → Finished | Kickoff ပြီး 4h ကျော်ပြီဆိုရင် (stuck match) |
| Finished matches delete | 24h ကျော်ပြီ ဆိုရင် ဖျက်တယ် |
| Finished stream_urls delete | Expired / unhealthy URL တွေ ဖျက်တယ် |
| Orphaned stream_urls delete | Match မရှိတော့တဲ့ stream URL တွေ ဖျက်တယ် |

**Config (app_config table, key=`cleanup`):**
```json
{
  "interval_ms": 1200000,
  "retention_hours": 24,
  "stuck_live_hours": 4
}
```

---

## ၄. Playback Logic — Frontend

### Network Tier Detection (`VideoPlayer.js`)

User ဝင်တဲ့အချိန် `navigator.connection` ကိုကြည့်ပြီး network tier ဆုံးဖြတ်တယ်:

```
4G + downlink > 4 Mbps  →  "fast"   → buffer 60s,  auto quality
3G / downlink < 2 Mbps  →  "slow"   → buffer 90s,  SD ကနေစ, ABR conservative
ကြားက               →  "medium"
```

### Server Order

```
allUrls = [SD 1, SD 2, ..., HD 1, HD 2, ...]
```

SD ဦးစွာ auto select လုပ်တယ်။ User bandwidth ကောင်းရင် HD ကို ကိုယ်တိုင် ရွေးနိုင်တယ်။

### Auto Switch (Silent)

Link error ဖြစ်ရင် — user ဘာမှ မနှိပ်ရဘဲ — next server ကို auto switch လုပ်တယ်:

```
Error ဖြစ်
    ↓
next server ရှိသေးလား?
    ├── ရှိတယ် → spinner ပြ၊ next server ကို silently switch
    └── မရှိ  → "Stream unavailable" error screen ပြ
```

Error ရှာပုံ (မည်သည့်အချိန်မဆို trigger ဖြစ်နိုင်):
- Stream load 40 seconds ထဲ မရောက်
- HLS / FLV fatal error
- Video `currentTime` 40 seconds ကြာ မပြောင်း (stall)

### Manual Server Select

`ServerSelector` component က SD/HD button grid ပြတယ်။ User ရွေးရင် `localStorage` မှာ သိမ်းထားတဲ့အတွက် page refresh / browser ပြန်ဖွင့်ပါ — **ရွေးထားတဲ့ server ကပဲ ပြန်ဖွင့်တယ်**။

### Exhausted State

Server အားလုံး fail ဆိုမှ error screen ပြ + ServerSelector ဖြင့် user ကိုယ်တိုင် ထပ်ရွေးနိုင်တယ်။ Streams ၆၀ seconds တစ်ကြိမ် refresh ဖြစ်ရင် exhausted state ကို reset လုပ်တယ် (scraper က URL သစ်ရလာနိုင်လို့)။

### Live Catchup

Live stream မှာ lag > 8 seconds ဆိုရင် `currentTime` ကို live edge ကို auto jump တယ် (4 seconds တစ်ကြိမ် check)။

---

## ၅. Tabs / Categories

| Tab | Slug | Source | Scrape Method |
|---|---|---|---|
| Main Live | `main-live` | streamed.su API | API call |
| SOCO Live | `soco-live` | socolive.tv mirrors | Playwright + HTTP extraction + Auto-Discovery |
| **Soco API** | `soco-api` | socolive.tv API | **HTTP-only, no Playwright, no iframes** |
| China Live | `china-live` | yyzbw8.live / yyzb456.top | HTTP JSON API |
| Loungsan | `loungsan` | aggregated | multiple sources |
| English | `english` | filtered | commentary filter |

### Soco API Tab (သစ်) — `src/scrapers/socoliveApi.js`

`soco-live` tab နဲ့ source တူတူ (SOCO API) ကိုသုံးပြီး **Playwright လုံးဝမသုံးဘဲ** HTTP request သက်သက်နဲ့ data ထုတ်ယူတယ်:

```
SOCO API (/match/detail_live) → live match list ရတယ်
    ↓
Match page ကို HTTP GET → var list_stream = [...] ကိုဖတ်တယ်
    ↓
Direct m3u8 / flv URL တွေသာ DB မှာ သိမ်းတယ်
iframe / embed URL → filter ထုတ်ချတယ်
```

**`soco-live` နဲ့ ကွာခြားချက်:**
- Playwright browser မဖွင့်ဘဲ HTTP request ချဲ့ပဲ fetch လုပ်တယ်
- iframe URL တွေ DB ထဲ မဝင်ဘဲ m3u8/flv URL တွေသာ ဝင်တယ်
- Server resource ပိုသက်သာ၊ ပိုမြန်တယ်
- Stream မရရင် empty (Playwright fallback မရှိ)

---

## ၆. Scraper On/Off Switch — Admin Panel

### ဘာကြောင့်လိုသလဲ
Live site မတည်ငြိမ်တဲ့အချိန်မှာ admin panel ကနေ scraper ကို ချက်ချင်း ပိတ်/ဖွင့်နိုင်ဖို့ အတွက်ထည့်ထားတယ်။

### Admin API Endpoints

| Method | URL | လုပ်ဆောင်ချက် |
|---|---|---|
| `GET` | `/api/admin/scrapers` | Scraper တစ်ခုချင်းရဲ့ status ကြည့်မယ် (is_active, tab_active, last_run_at) |
| `POST` | `/api/admin/scrapers/chinalive/toggle` | China Live scraper On/Off ပြောင်းမယ် |
| `POST` | `/api/admin/scrapers/socolive/toggle` | SOCO Live scraper On/Off ပြောင်းမယ် |

> JWT token လိုတယ် (`Authorization: Bearer <token>`)

### Toggle ဘယ်လိုသိမ်းသလဲ
`sources` table ထဲမှာ `is_active` column ကို flip လုပ်တယ်။ Scraper job တွေက tick တိုင်း DB ကို စစ်တာမို့ **restart မလိုဘဲ ချက်ချင်းအကျိုးသက်ရောက်တယ်** (interval ၁ ကြိမ်ကုန်မှပဲ)။

---

## ၇. Tab-Active Gating — Scraper Logic

### ဘယ်လိုအလုပ်လုပ်သလဲ

Scraper job တစ်ခုချင်း tick တိုင်း DB ထဲ check ၂ ခု လုပ်တယ်:

```
sources.is_active = true   ← Admin panel On/Off switch
    AND
tabs.is_active = true      ← Tab ကို admin က enable/disable လုပ်ထားလား
    ↓
နှစ်ခုလုံး true မှ scrape run မယ်
တစ်ခုခု false ဆိုရင် skip (timer ဆက် schedule လုပ်တယ်)
```

### ဘာကြောင့် Redis မသုံးဘဲ DB ကိုသုံးသလဲ
ဦးစွာ Redis activity tracking (page visit တိုင်း TTL set) ကို သုံးဖို့ ကြိုးစားခဲ့တယ်။ ဒါပေမဲ့ `tabs` table မှာ `is_active` column ရှိပြီးသားမို့ — Admin panel ကနေ tab ကို inactive လုပ်ရင် scraper ကလည်း အလိုအလျောက် ရပ်တယ်။ ပိုရိုးရှင်းပြီး ပိုတိကျတယ်။

### Admin ကနေ ထိန်းချုပ်ပုံ
| Action | Effect |
|---|---|
| Admin panel → Sources → SOCO toggle off | `sources.is_active = false` → scraper ရပ် |
| Admin panel → Tabs → SOCO Live toggle off | `tabs.is_active = false` → scraper ရပ် |
| နှစ်ခုလုံး on | Normal scraping |

---

## ၈. IP Ban Protection — Server IP ပိတ်ခံရမှု ကာကွယ်ပုံ

### ဘာဖြစ်နိုင်သလဲ
Scraper server ကို deploy လုပ်ပြီးနောက် SOCO / China Live site တွေက server IP ကို block လုပ်နိုင်တယ်။ ထိုအချိန်မှာ:
- `[socolive] All source URLs failed or returned no matches`
- `[chinalive] Failed to fetch rooms: Request timeout`

### ဘယ်လိုကာကွယ်ထားသလဲ

**User-Agent Rotation**
Request တိုင်းမှာ real browser UA ၅ မျိုးထဲကတစ်ခုကို random ရွေးသုံးတယ် — bot detection ကို ရှောင်တယ်။

```js
// chinalive.js နဲ့ socolive.js နှစ်ခုလုံးမှာ ထည့်ထားတယ်
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
```

**Request Jitter (China Live)**
Room တစ်ခုချင်း fetch မတိုင်ခင် 300–900ms random delay ထည့်တယ် — rate limit trigger ကို ရှောင်တယ်။

**Proxy Support**
Ban ဖြစ်ရင် residential proxy ထည့်လို့ရတယ်:
```env
SCRAPER_PROXY=http://user:pass@proxy-host:port
```
Playwright မှာ `--proxy-server` arg အနေနဲ့ pass လုပ်တယ်။ Code ပြင်စရာမလိုဘူး — env var တစ်ခုပဲ ပြောင်းရတယ်။

### Ban ဖြစ်ကြောင်း ဘယ်လိုသိသလဲ
Admin panel → **Sources** page → **"▶ Run Check"** ခလုတ် နှိပ်တယ်:

| Status | အဓိပ္ပါယ် | ဘာလုပ်မလဲ |
|---|---|---|
| ✅ `ok` | အဆင်ပြေတယ် | ဘာမှမလုပ်နဲ့ |
| 🚫 `banned` | IP block ခံရတယ် | Server region ပြောင်း / Proxy ထည့် |
| ⏱️ `timeout` | Request ၁၀s ထဲ မပြန် | IP block ဖြစ်နိုင် — region ပြောင်းကြည့် |
| ⚠️ `warning` | API endpoint မ respond ဘူး | Mirror ပြောင်းကြည့် |
| ❌ `error` | Connection fail | Site down / network ပြဿနာ |

API: `GET /api/admin/scrapers/ban-check` (JWT required)

**SOCO ban check logic (ပြင်ဆင်ချက်) —** ယခင်က homepage HTML ထဲမှာ `match-item` ရှာတာ SPA site ဆိုရင် အမြဲ `warning` ပြနေတယ်။ ယခု စစ်ထုတ်ပုံသစ်:
1. Homepage fetch → Cloudflare challenge / 403 → `banned`
2. HTML ထဲက `"api": "https://..."` variable ကို extract လုပ်တယ်
3. API endpoint (`/match/detail_live`) ကို တိုက်ရိုက် test လုပ်တယ်
4. JSON `"results"` response ရရင် → `ok`; API fail → `warning`

### Ban ဖြစ်ရင် ဘာလုပ်မလဲ (Priority Order)
1. **Railway မှာ region ပြောင်း** — Singapore → Frankfurt → US → ချက်ချင်း IP သစ်ရတယ် (free)
2. **SOCO mirror ပြောင်း** — Admin panel → Sources → base_urls ထဲ URL သစ်ထည့် (restart မလို)
3. **Residential proxy ထည့်** — [webshare.io](https://webshare.io) ကနေ ~$3/mo, `.env` ထဲ `SCRAPER_PROXY=` ထည့်

---

## ၉. Match Search

`GET /api/matches?search=<team_name>` — အသစ်ထည့်ထားတဲ့ feature

- Team name ဖြင့် match ရှာနိုင်တယ် (`home_team` OR `away_team` ILIKE)
- Tab filter နဲ့ ပေါင်းသုံးလို့ရတယ်: `?search=manchester&tab=soco-live`
- Search result ကို Redis cache မသုံးဘဲ ကိုယ်တိုင် DB query ဆွဲတယ် (user input ဆိုတော့ cache ထည့်မထားဘဲ ချန်ထားတယ်)
- Result limit: 50 ပွဲ

```
GET /api/matches?search=arsenal          → Arsenal ပါတဲ့ ပွဲတွေ
GET /api/matches?search=man&tab=soco-api → soco-api tab ထဲ man* ပါတဲ့ ပွဲတွေ
```

---

## ၁၀. Caching

- Stream list: Redis `EX 30` seconds
- Match list: Redis cache → DB query fallback
- Cache invalidate: sync job run တိုင်း `streams:{matchId}` key delete
- Search query: cache မသုံးဘဲ DB တိုက်ရိုက် (TTL ဘာမှ မသတ်)

---

## ၁၁. Environment Variables

```env
# Database & Cache
DATABASE_URL              # PostgreSQL — Neon (dev + prod နှစ်ခုလုံး Neon ကို သုံးတယ်)
REDIS_URL                 # Redis — Upstash (paid plan လိုတယ် — free tier 500k req/month limit)
REDIS_TLS=true

# Scraper
SOCO_BASE_URL             # default: https://www.socolive.tv
SOCO_BASE_URL_2           # fallback: https://s2sprediction.net
SCRAPER_PROXY=            # optional: http://user:pass@host:port (ban ဖြစ်ရင်သာ ထည့်)
SCRAPER_INTERVAL_MS       # China Live interval — default: 300000 (5 min)
SOCO_SYNC_INTERVAL_MS     # SOCO interval — default: 300000 (5 min)

# Health Check
HEALTH_CHECK_INTERVAL_MS  # default: 600000 (10 min) — admin panel ကနေလည်း ပြောင်းလို့ရတယ်
HEALTH_FAIL_THRESHOLD     # default: 10 — admin panel ကနေလည်း ပြောင်းလို့ရတယ်

# Admin
ADMIN_USERNAME            # default: admin
ADMIN_PASSWORD            # default: 12345
JWT_SECRET                # JWT signing key
PORT=3050
```

**ဘယ် DB / Redis ကို သုံးသလဲ**

| Service | Dev | Production |
|---|---|---|
| Database | Neon (cloud) | Neon (same) |
| Redis | Upstash | Upstash (same) |
| Backend | local `npm run dev` | Railway (Singapore region) |
| Frontend | local `npm run dev` | Vercel |

Vercel ကို backend deploy မလုပ်ရ — serverless မို့ background job တွေ (`setTimeout` loop) run မနိုင်ဘူး။

---

## ၁၂. Dev Commands

```bash
# Backend start
cd football-app && npm run dev

# Frontend start
cd streamzone && npm run dev
```

---

_ဤ file ကို app logic ပြောင်းတိုင်း update လုပ်ပေးပါ။_

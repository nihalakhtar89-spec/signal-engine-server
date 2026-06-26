# Signal Engine Server

Background server for Signal Engine — runs on Render.com free tier.

## What it does
- Scans 20 core coins on Binance every 2 minutes
- Sends push notifications via ntfy.sh
- Stores trades permanently in JSONBin.io
- Monitors open trades for TP/SL hits

## Setup Instructions

### Step 1 — JSONBin.io (free database)
1. Go to https://jsonbin.io
2. Sign up free
3. Click **+ Create Bin**
4. Paste this as initial content: `{"trades":[]}`
5. Click **Create**
6. Copy your **Bin ID** (in the URL) and **Master Key** (in API Keys section)

### Step 2 — GitHub Repo
1. Create new repo called `signal-engine-server`
2. Upload these files: `server.js`, `package.json`, `README.md`
3. Keep repo public

### Step 3 — Render.com
1. Go to https://render.com
2. Sign up with GitHub (free)
3. Click **New** → **Web Service**
4. Connect your `signal-engine-server` repo
5. Settings:
   - **Name:** signal-engine-server
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
6. Add **Environment Variables:**
   - `NTFY_TOPIC` = your ntfy topic (e.g. signal-nihal-8472)
   - `JSONBIN_KEY` = your JSONBin Master Key
   - `JSONBIN_BIN` = your JSONBin Bin ID
7. Click **Create Web Service**

### Step 4 — UptimeRobot (keeps server awake)
1. Go to https://uptimerobot.com (free)
2. Sign up
3. Add monitor → HTTP(s)
4. URL: `https://your-render-url.onrender.com/`
5. Interval: 5 minutes
6. This pings your server every 5 min so it never sleeps

### Step 5 — Update your app
In your Signal Engine HTML file, set:
```js
const SERVER_URL = 'https://your-render-url.onrender.com';
```

## API Endpoints
- `GET /` — Health check + status
- `GET /trades` — Get all trades
- `POST /trades` — Add new trade
- `PATCH /trades/:id` — Update/close trade
- `DELETE /trades` — Clear all trades
- `GET /scan` — Trigger manual scan

## Environment Variables
| Variable | Description |
|----------|-------------|
| NTFY_TOPIC | Your ntfy.sh topic name |
| JSONBIN_KEY | JSONBin.io Master Key |
| JSONBIN_BIN | JSONBin.io Bin ID |

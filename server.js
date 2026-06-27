// ══════════════════════════════════════════════════════════════
// SIGNAL ENGINE SERVER
// Runs on Render.com free tier
// - Scans Binance every 2 minutes
// - Sends ntfy push notifications
// - Stores trades in JSONBin.io (permanent storage)
// ══════════════════════════════════════════════════════════════

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG (set these as Environment Variables in Render) ──────
const PORT         = process.env.PORT || 3000;
const NTFY_TOPIC   = process.env.NTFY_TOPIC || 'signal-engine-default';
const JSONBIN_KEY  = process.env.JSONBIN_KEY || '';   // from jsonbin.io
const JSONBIN_BIN  = process.env.JSONBIN_BIN || '';   // bin ID from jsonbin.io

// ── BINANCE API ────────────────────────────────────────────────
const BASE_URL  = 'https://api.binance.com/api/v3/';
const FAPI_URL  = 'https://fapi.binance.com/fapi/v1/';

// ── CORE COINS (always scanned) ────────────────────────────────
const CORE_COINS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
  'AVAXUSDT','DOGEUSDT','ADAUSDT','LINKUSDT','LTCUSDT',
  'UNIUSDT','NEARUSDT','APTUSDT','INJUSDT','OPUSDT',
  'STXUSDT','MATICUSDT','DOTUSDT','ATOMUSDT','TONUSDT'
];

// ── STATE ──────────────────────────────────────────────────────
let prevSignals   = {};   // sym → last signal
let openTrades    = [];   // loaded from JSONBin
let lastScanTime  = null;
let scanCount     = 0;
let isScanning    = false;

// ── HELPERS ───────────────────────────────────────────────────
async function fetchJSON(url, timeout = 8000) {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(id);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function ntfySend(title, message, priority = 'default', tags = '') {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        'Title': title.replace(/[^ -~]/g, ''),
        'Priority': priority,
        'Tags': tags || 'chart_with_upwards_trend',
        'Content-Type': 'text/plain; charset=utf-8'
      },
      body: message
    });
    console.log(`📨 Sent: ${title}`);
  } catch (e) {
    console.error('ntfy error:', e.message);
  }
}

// ── JSONBIN STORAGE ────────────────────────────────────────────
async function loadTrades() {
  if (!JSONBIN_KEY || !JSONBIN_BIN) return [];
  try {
    const r = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_KEY }
    });
    if (!r.ok) return [];
    const d = await r.json();
    return d.record?.trades || [];
  } catch { return []; }
}

async function saveTrades(trades) {
  if (!JSONBIN_KEY || !JSONBIN_BIN) return;
  try {
    await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': JSONBIN_KEY
      },
      body: JSON.stringify({ trades, updatedAt: new Date().toISOString() })
    });
  } catch (e) {
    console.error('JSONBin save error:', e.message);
  }
}

// ── TECHNICAL INDICATORS ───────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgG = gains / period;
  const avgL = losses / period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcADX(highs, lows, closes, period = 14) {
  if (closes.length < period * 2) return null;
  const dms = [], trs = [];
  for (let i = 1; i < closes.length; i++) {
    const dmP = highs[i] - highs[i-1];
    const dmN = lows[i-1] - lows[i];
    dms.push({
      p: dmP > dmN && dmP > 0 ? dmP : 0,
      n: dmN > dmP && dmN > 0 ? dmN : 0
    });
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  const slice = dms.slice(-period);
  const trSlice = trs.slice(-period);
  const atr = trSlice.reduce((a,b)=>a+b,0)/period;
  if (atr === 0) return 0;
  const diP = (slice.reduce((a,b)=>a+b.p,0)/period/atr)*100;
  const diN = (slice.reduce((a,b)=>a+b.n,0)/period/atr)*100;
  const dx = Math.abs(diP-diN)/(diP+diN||1)*100;
  return dx;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  return ema12 - ema26;
}

// ── SIGNAL ENGINE (same logic as client) ──────────────────────
function getSignal(candles) {
  const { opens, highs, lows, closes, volumes } = candles;
  if (closes.length < 50) return null;

  const price = closes[closes.length - 1];
  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const ema200= calcEMA(closes, 200);
  const rsi   = calcRSI(closes, 14);
  const adx   = calcADX(highs, lows, closes, 14);
  const atr   = calcATR(highs, lows, closes, 14);
  const macd  = calcMACD(closes);

  if (!ema9||!ema21||!rsi||!adx||!atr) return null;

  let score = 0;

  // Trend
  if (ema9 > ema21) score++;
  if (ema21 > ema50) score++;
  if (ema50 > (ema200||ema50)) score++;
  if (price > ema9) score++;

  // Momentum
  if (rsi >= 45 && rsi <= 65) score++;
  if (rsi > 50) score++;

  // Trend strength
  if (adx >= 25) score++;
  if (adx >= 35) score++;

  // MACD
  if (macd && macd > 0) score++;

  // Volume
  const avgVol = volumes.slice(-20).reduce((a,b)=>a+b,0)/20;
  const lastVol = volumes[volumes.length-1];
  if (lastVol > avgVol * 1.2) score++;

  // Volatility (ATR expansion)
  const atrPct = atr / price;
  if (atrPct > 0.01 && atrPct < 0.05) score++;

  // Candlestick pattern
  const last = closes.length - 1;
  const body = Math.abs(closes[last] - opens[last]);
  const range = highs[last] - lows[last];
  if (body > range * 0.6 && closes[last] > opens[last]) score++;

  // SL / TP
  const sl = price - atr * 1.5;
  const tp = price + atr * 2.5;
  const rr = (tp - price) / (price - sl);

  let signal = 'NEUTRAL';
  if (adx < 20) signal = 'SKIP';
  else if (score >= 9) signal = 'STRONG BUY';
  else if (score >= 7) signal = 'BUY';
  else if (score >= 5) signal = 'NEUTRAL';
  else if (score >= 3) signal = 'SELL';
  else signal = 'STRONG SELL';

  return { signal, score, rr: +rr.toFixed(2), sl: +sl.toFixed(8), tp: +tp.toFixed(8), price, atr };
}

// ── FETCH CANDLES ──────────────────────────────────────────────
async function fetchCandles(symbol, interval = '4h', limit = 200) {
  const data = await fetchJSON(`${BASE_URL}klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!data || !Array.isArray(data)) return null;
  const now = Date.now();
  const completed = data.filter(k => Number(k[6]) < now);
  if (completed.length < 50) return null;
  return {
    opens:   completed.map(k => +k[1]),
    highs:   completed.map(k => +k[2]),
    lows:    completed.map(k => +k[3]),
    closes:  completed.map(k => +k[4]),
    volumes: completed.map(k => +k[5])
  };
}

// ── MAIN SCAN ─────────────────────────────────────────────────
async function runScan() {
  if (isScanning) return;
  isScanning = true;
  scanCount++;
  console.log(`\n🔍 Scan #${scanCount} — ${new Date().toISOString()}`);

  try {
    // Load open trades from JSONBin
    openTrades = await loadTrades();

    for (const sym of CORE_COINS) {
      try {
        const candles = await fetchCandles(sym, '4h', 200);
        if (!candles) continue;

        const result = getSignal(candles);
        if (!result) continue;

        const { signal, score, rr, sl, tp, price } = result;
        const coin = sym.replace('USDT', '');
        const prev = prevSignals[sym];

        // ── SIGNAL NOTIFICATIONS ──
        if (signal === 'STRONG BUY' && prev !== 'STRONG BUY') {
          await ntfySend(
            `STRONG BUY - ${coin}`,
            `🟢 STRONG BUY\nPrice: $${price} | Score: ${score}/12 | R:R: ${rr}x\nSL: $${sl} | TP: $${tp}`,
            'high', 'white_check_mark,chart_with_upwards_trend'
          );
        }

        const isConfirmed = (signal==='STRONG BUY'||signal==='BUY') && score>=7 && rr>=1.8;
        const wasConfirmed = prevSignals[sym+'_conf'];
        if (isConfirmed && !wasConfirmed) {
          await ntfySend(
            `CONFIRMED BUY - ${coin}`,
            `🎯 CONFIRMED BUY\nPrice: $${price} | Score: ${score}/12 | R:R: ${rr}x\nSL: $${sl} | TP: $${tp}`,
            'high', 'dart,white_check_mark'
          );
        }

        if (signal === 'STRONG SELL' && prev !== 'STRONG SELL') {
          await ntfySend(
            `STRONG SELL - ${coin}`,
            `🔴 STRONG SELL\nPrice: $${price} | Score: ${score}/12\nCheck open trades immediately!`,
            'urgent', 'warning,chart_with_downwards_trend'
          );
        }

        prevSignals[sym] = signal;
        prevSignals[sym+'_conf'] = isConfirmed;

        // ── OPEN TRADE MONITORING ──
        const trade = openTrades.find(t => t.sym === sym && t.status === 'OPEN');
        if (trade) {
          if (price >= trade.tp) {
            const pnl = ((trade.tp - trade.entry) * trade.qty - trade.fee * 2).toFixed(2);
            trade.status = 'WIN';
            trade.closePrice = trade.tp;
            trade.pnl = +pnl;
            trade.closeDate = new Date().toISOString();
            await ntfySend(
              `TP HIT - ${coin} +$${pnl}`,
              `✅ PROFIT TAKEN\nEntry: $${trade.entry} → TP: $${trade.tp}\nProfit: +$${pnl}`,
              'high', 'moneybag,white_check_mark'
            );
            await saveTrades(openTrades);
          } else if (price <= trade.sl) {
            const pnl = ((trade.sl - trade.entry) * trade.qty - trade.fee * 2).toFixed(2);
            trade.status = 'LOSS';
            trade.closePrice = trade.sl;
            trade.pnl = +pnl;
            trade.closeDate = new Date().toISOString();
            await ntfySend(
              `SL HIT - ${coin} $${pnl}`,
              `❌ STOP LOSS HIT\nEntry: $${trade.entry} → SL: $${trade.sl}\nLoss: $${pnl}`,
              'high', 'x,chart_with_downwards_trend'
            );
            await saveTrades(openTrades);
          }
        }

        // Small delay between coins to respect rate limits
        await new Promise(r => setTimeout(r, 300));

      } catch (e) {
        console.error(`Error scanning ${sym}:`, e.message);
      }
    }

    lastScanTime = new Date().toISOString();
    console.log(`✅ Scan complete. Next in 2 minutes.`);

  } catch (e) {
    console.error('Scan error:', e.message);
  } finally {
    isScanning = false;
  }
}

// ── API ROUTES ────────────────────────────────────────────────

// Health check (also used by UptimeRobot to keep server awake)
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    lastScan: lastScanTime,
    scanCount,
    openTrades: openTrades.filter(t => t.status === 'OPEN').length,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// Get all trades
app.get('/trades', async (req, res) => {
  const trades = await loadTrades();
  res.json({ trades });
});

// Add a new trade (called from your app when you tap Buy)
app.post('/trades', async (req, res) => {
  const trade = req.body;
  if (!trade.sym || !trade.entry) return res.status(400).json({ error: 'Missing fields' });

  const trades = await loadTrades();
  trade.id = Date.now();
  trade.status = 'OPEN';
  trade.date = new Date().toISOString();
  trades.push(trade);
  await saveTrades(trades);

  res.json({ success: true, trade });
});

// Close a trade
app.patch('/trades/:id', async (req, res) => {
  const trades = await loadTrades();
  const trade = trades.find(t => t.id === +req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });

  Object.assign(trade, req.body);
  trade.closeDate = new Date().toISOString();
  await saveTrades(trades);

  res.json({ success: true, trade });
});

// Delete all trades (reset journal)
app.delete('/trades', async (req, res) => {
  await saveTrades([]);
  openTrades = [];
  res.json({ success: true });
});

// Sync all trades from app (bulk save)
app.post('/trades/sync', async (req, res) => {
  const { trades, balance } = req.body;
  if (!Array.isArray(trades)) return res.status(400).json({ error: 'Invalid' });
  openTrades = trades;
  await saveTrades(trades, balance);
  res.json({ success: true, count: trades.length });
});

// Manual scan trigger
app.get('/scan', async (req, res) => {
  runScan();
  res.json({ message: 'Scan started' });
});

// ── START SERVER ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║  ⚡ Signal Engine Server             ║
║  Port: ${PORT}                          ║
║  Scanning every 2 minutes            ║
║  ntfy topic: ${NTFY_TOPIC}
╚══════════════════════════════════════╝
  `);

  // Start scanning immediately
  runScan();

  // Then every 2 minutes
  setInterval(runScan, 2 * 60 * 1000);
});

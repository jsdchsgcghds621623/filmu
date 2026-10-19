require('dotenv').config();

const express       = require('express');
const cors          = require('cors');
const compression   = require('compression');
const helmet        = require('helmet');
const rateLimit     = require('express-rate-limit');
const { Pool }      = require('pg');
const crypto        = require('crypto');

const app  = express();
const PORT = Number(process.env.PORT) || 3000;

// Add this line to trust Render's proxy
app.set('trust proxy', 1);



// ─── Tunables ─────────────────────────────────────────────
const CAPTURE_TIMEOUT      = Number(process.env.CAPTURE_TIMEOUT)   || 15_000;
const CAPTURE_CONCURRENCY  = Number(process.env.CAPTURE_CONCURRENCY) || 6;
const QUEUE_TIMEOUT        = Number(process.env.QUEUE_TIMEOUT)     || 30_000;
const MEM_CACHE_MAX        = Number(process.env.MEM_CACHE_MAX)     || 2000;
const CACHE_TTL            = Number(process.env.CACHE_TTL)         || 30 * 60_000;
const NEGATIVE_CACHE_TTL   = Number(process.env.NEGATIVE_CACHE_TTL)|| 60_000;
const DB_POOL_MAX          = Number(process.env.DB_POOL_MAX)       || 10;
const RATE_LIMIT_MAX       = Number(process.env.RATE_LIMIT_MAX)    || 120;
const LOG_LEVEL            = (process.env.LOG_LEVEL  || 'info').toLowerCase();
const LOG_JSON             = process.env.LOG_JSON === 'true';
const LOG_COLOR            = process.env.LOG_COLOR !== 'false' && process.stdout.isTTY;

// ─── Freshness / refresh tunables ─────────────────────────
// Any DB row older than REFRESH_INTERVAL_MS is considered stale.
// On-demand requests will refresh it before responding.
const REFRESH_ENABLED      = process.env.REFRESH_ENABLED !== 'false';
const REFRESH_INTERVAL_MS  = Number(process.env.REFRESH_INTERVAL_MS) || 24 * 60 * 60_000; // 24h
const REFRESH_CONCURRENCY  = Number(process.env.REFRESH_CONCURRENCY) || 2;
const REFRESH_BATCH        = Number(process.env.REFRESH_BATCH)       || 100;
const REFRESH_BOOT_DELAY   = Number(process.env.REFRESH_BOOT_DELAY)  || 60_000;
const REFRESH_RETRY_TTL    = Number(process.env.REFRESH_RETRY_TTL)   || 5 * 60_000;        // serve stale 5 min
const ADMIN_TOKEN          = process.env.ADMIN_TOKEN || '';

// ─── Bingr.one API config ─────────────────────────────────
const BINGR_BASE     = (process.env.BINGR_BASE || 'https://api.bingr.one').replace(/\/+$/, '');
const BINGR_TIMEOUT  = Number(process.env.BINGR_TIMEOUT) || 12_000;
const BINGR_API_KEY  = process.env.BINGR_API_KEY || '';
// Server ID used for movie POST requests (s40 as requested)
const BINGR_SRV      = process.env.BINGR_SRV || 's40';
// Scraper slug used for TV GET requests
const BINGR_SCRAPER  = process.env.BINGR_SCRAPER || 'aphelion-tv';

// ─── CORS allow-list ──────────────────────────────────────
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  [
    'https://moonflix.website',
    'https://www.moonflix.website',
    'https://player.moonflix.website',
    // add dev origins here if needed:
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:4000',
    'http://localhost:3001'
  ].join(',')
)
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const ALLOWED_HOSTS = new Set(
  ALLOWED_ORIGINS.map(o => {
    try { return new URL(o).hostname.toLowerCase(); }
    catch { return o.replace(/^https?:\/\//, '').split('/')[0].toLowerCase(); }
  })
);

function hostOf(value) {
  if (!value || value === 'null') return null;
  try { return new URL(value).hostname.toLowerCase(); }
  catch { return null; }
}
function isAllowedOrigin(origin) {
  const h = hostOf(origin);
  return !!h && ALLOWED_HOSTS.has(h);
}
function isAllowedReferer(referer) {
  const h = hostOf(referer);
  return !!h && ALLOWED_HOSTS.has(h);
}

// ═══════════════════════════════════════════════════════════════
//  BEAUTIFUL TERMINAL LOGGER
// ═══════════════════════════════════════════════════════════════
const C = LOG_COLOR ? {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m', gray: '\x1b[90m',
  bgRed: '\x1b[41m', bgGreen: '\x1b[42m', bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m', bgMagenta: '\x1b[45m', bgCyan: '\x1b[46m',
} : new Proxy({}, { get: () => '' });

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_MIN = LEVELS[LOG_LEVEL] || 20;

const LEVEL_META = {
  debug: { icon: '🔍', color: C.gray,    label: 'DEBUG' },
  info:  { icon: 'ℹ️ ', color: C.cyan,    label: 'INFO ' },
  ok:    { icon: '✅', color: C.green,   label: 'OK   ' },
  warn:  { icon: '⚠️ ', color: C.yellow,  label: 'WARN ' },
  error: { icon: '❌', color: C.red,     label: 'ERROR' },
};

const TAG_STYLE = {
  db:        { icon: '💾', color: C.magenta },
  fetch:     { icon: '🛰️ ', color: C.blue },
  cache:     { icon: '⚡', color: C.yellow },
  capture:   { icon: '🎯', color: C.cyan },
  server:    { icon: '🚀', color: C.green },
  http:      { icon: '🌐', color: C.white },
  proxy:     { icon: '🎬', color: C.magenta },
  queue:     { icon: '⏳', color: C.yellow },
  refresh:   { icon: '♻️ ', color: C.cyan },
  shutdown:  { icon: '🛑', color: C.red },
  ready:     { icon: '✨', color: C.green },
};

function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtVal(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function log(level, tag, msg, extra) {
  if (LOG_JSON) {
    const line = JSON.stringify({
      t: new Date().toISOString(), level,
      tag: tag || 'app', msg, ...(extra || {}),
    });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
    return;
  }
  const lvl = LEVELS[level] ?? 20;
  if (lvl < LEVEL_MIN) return;

  const meta = LEVEL_META[level] || LEVEL_META.info;
  const tstyle = TAG_STYLE[tag] || { icon: '·', color: C.gray };

  let extras = '';
  if (extra && typeof extra === 'object') {
    const parts = [];
    for (const [k, v] of Object.entries(extra)) {
      const val = fmtVal(v);
      if (val === '') continue;
      parts.push(`${C.gray}${k}${C.reset}${C.dim}=${C.reset}${C.white}${val}${C.reset}`);
    }
    if (parts.length) extras = '  ' + parts.join(' ');
  }

  const line =
    `${C.gray}${ts()}${C.reset}  ` +
    `${meta.color}${meta.icon}${C.reset}  ` +
    `${tstyle.color}${String(tag || 'app').padEnd(8)}${C.reset}` +
    `${C.white}${msg}${C.reset}` +
    extras;

  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}
function banner() {
  if (LOG_JSON) return;
  const lines = [
    '',
    `${C.cyan}  ╭─────────────────────────────────────────────────────────────╮${C.reset}`,
    `${C.cyan}  │${C.reset}  ${C.bold}🎬  filmu.in stream proxy${C.reset}                                  ${C.cyan}│${C.reset}`,
    `${C.cyan}  │${C.reset}  ${C.gray}v3.3 · bingr.one · DB-first · on-demand 24h refresh${C.reset}     ${C.cyan}│${C.reset}`,
    `${C.cyan}  ╰─────────────────────────────────────────────────────────────╯${C.reset}`,
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}
function divider(label) {
  if (LOG_JSON) return;
  const w = 62;
  const mid = ` ${label} `;
  const left = Math.floor((w - mid.length) / 2);
  const right = w - mid.length - left;
  process.stdout.write(
    `\n${C.gray}  ${'─'.repeat(left)}${C.reset}${C.bold}${mid}${C.reset}${C.gray}${'─'.repeat(right)}${C.reset}\n`
  );
}

// ═══════════════════════════════════════════════════════════════
//  EXPRESS
// ═══════════════════════════════════════════════════════════════
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, false);
    if (isAllowedOrigin(origin)) return cb(null, true);
    log('warn', 'http', 'cors origin rejected', { origin });
    return cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Origin', 'X-Requested-With'],
  exposedHeaders: ['x-cache-source', 'x-data-updated-at', 'x-data-stale', 'Retry-After'],
  maxAge: 86_400,
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  req.id = crypto.randomBytes(4).toString('hex');
  req._t0 = process.hrtime.bigint();

  const q = { ...req.query };
  delete q.type;
  const queryStr = Object.entries(q)
    .map(([k, v]) => `${C.gray}${k}${C.reset}${C.dim}=${C.reset}${C.white}${v}${C.reset}`)
    .join('  ');

  log('info', 'http', `${C.cyan}→${C.reset}  ${C.bold}${req.method}${C.reset}  ${req.path}${queryStr ? '  ' + queryStr : ''}`, { id: req.id });

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - req._t0) / 1e6;
    const statusColor =
      res.statusCode >= 500 ? C.red :
      res.statusCode >= 400 ? C.yellow :
      res.statusCode >= 300 ? C.cyan :
      C.green;
    const msColor = ms < 100 ? C.green : ms < 1000 ? C.cyan : ms < 3000 ? C.yellow : C.red;
    const tag = res.getHeader('x-cache-source') || '';

    log('info', 'http',
      `${statusColor}← ${res.statusCode}${C.reset}  ${C.bold}${req.path}${C.reset}  ` +
      `${msColor}${ms.toFixed(0)}ms${C.reset}` +
      (tag ? `  ${C.gray}via ${C.reset}${C.magenta}${tag}${C.reset}` : '')
    , { id: req.id });
  });
  next();
});

app.use('/api', rateLimit({
  windowMs: 60_000,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ═══════════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════════
function buildPoolConfig() {
  const ssl = { rejectUnauthorized: false };

  if (process.env.DATABASE_URL) {
    const cleanUrl = process.env.DATABASE_URL
      .replace(/([?&])sslmode=[^&]*&?/g, '$1')
      .replace(/[?&]$/, '');
    return {
      connectionString: cleanUrl,
      ssl,
      max: DB_POOL_MAX,
      min: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 5_000,
      query_timeout: 5_000,
      application_name: 'filmu-proxy',
    };
  }

  return {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'defaultdb',
    ssl,
    max: DB_POOL_MAX,
    min: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 5_000,
    query_timeout: 5_000,
    application_name: 'filmu-proxy',
  };
}

const pool = new Pool(buildPoolConfig());
pool.on('error', (err) => log('error', 'db', 'idle client error', { err: err.message }));
pool.on('connect', () => log('debug', 'db', 'new client connected'));

let dbReady = false;

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stream_cache (
      id          SERIAL PRIMARY KEY,
      media_type  TEXT        NOT NULL DEFAULT 'tv',
      tmdb        TEXT        NOT NULL,
      season      INTEGER     NOT NULL,
      episode     INTEGER     NOT NULL,
      payload     JSONB       NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE stream_cache
      ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'tv';
    ALTER TABLE stream_cache
      DROP CONSTRAINT IF EXISTS stream_cache_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS stream_cache_unique
      ON stream_cache (media_type, tmdb, season, episode);
    CREATE INDEX IF NOT EXISTS idx_stream_cache_lookup
      ON stream_cache (tmdb, season, episode);
    CREATE INDEX IF NOT EXISTS idx_stream_cache_updated_at
      ON stream_cache (updated_at);
  `);
  dbReady = true;
  log('ok', 'db', 'stream_cache table ready');
}

// returns { payload, updatedAt } or null
async function getFromDb(mediaType, tmdb, season, episode) {
  if (!dbReady) return null;
  try {
    const { rows } = await pool.query(
      `SELECT payload, updated_at FROM stream_cache
       WHERE media_type = $1 AND tmdb = $2 AND season = $3 AND episode = $4
       LIMIT 1`,
      [mediaType, String(tmdb), Number(season), Number(episode)]
    );
    if (!rows.length) return null;
    log('debug', 'db', 'hit', { key: `${mediaType} ${tmdb}|${season}|${episode}` });
    return { payload: rows[0].payload, updatedAt: rows[0].updated_at };
  } catch (err) {
    log('error', 'db', 'query failed', { err: err.message });
    return null;
  }
}

// ── INSERT ONLY. Never UPDATE an existing row here. ───────
async function saveToDb(mediaType, tmdb, season, episode, payload) {
  if (!dbReady) return;
  const key = `${mediaType} ${tmdb}|${season}|${episode}`;
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO stream_cache (media_type, tmdb, season, episode, payload, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
       ON CONFLICT (media_type, tmdb, season, episode) DO NOTHING`,
      [mediaType, String(tmdb), Number(season), Number(episode), JSON.stringify(payload)]
    );
    if (rowCount > 0) {
      log('ok', 'db', 'saved (new row)', { key });
    } else {
      log('debug', 'db', 'row exists — kept original payload', { key });
    }
  } catch (err) {
    log('error', 'db', 'save failed', { err: err.message, key });
  }
}

// ── UPDATE: used by on-demand refresh AND background job ──
async function updateDb(mediaType, tmdb, season, episode, payload) {
  if (!dbReady) return false;
  const key = `${mediaType} ${tmdb}|${season}|${episode}`;
  try {
    const { rowCount } = await pool.query(
      `UPDATE stream_cache
          SET payload = $5::jsonb,
              updated_at = NOW()
        WHERE media_type = $1 AND tmdb = $2 AND season = $3 AND episode = $4`,
      [mediaType, String(tmdb), Number(season), Number(episode), JSON.stringify(payload)]
    );
    if (rowCount > 0) log('ok', 'db', 'row refreshed (links replaced)', { key });
    else              log('debug', 'db', 'refresh target missing', { key });
    return rowCount > 0;
  } catch (err) {
    log('error', 'db', 'update failed', { err: err.message, key });
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
//  LRU CACHE  (stores { payload, updatedAt })
// ═══════════════════════════════════════════════════════════════
class LRUCache {
  constructor(maxSize) { this.max = maxSize; this.map = new Map(); }
  get(key) {
    const v = this.map.get(key);
    if (!v) return null;
    if (Date.now() > v.expires) { this.map.delete(key); return null; }
    this.map.delete(key);
    this.map.set(key, v);
    return v.data;
  }
  set(key, data, ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { data, expires: Date.now() + ttlMs });
    if (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
  }
  get size() { return this.map.size; }
}
const cache = new LRUCache(MEM_CACHE_MAX);

// memory cache helpers — always carry an updatedAt alongside the payload
function memSet(key, payload, updatedAt, ttlMs) {
  cache.set(key, { payload, updatedAt: updatedAt ? toDate(updatedAt) : null }, ttlMs);
}
function memGet(key) {
  return cache.get(key); // { payload, updatedAt } | null
}
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// ═══════════════════════════════════════════════════════════════
//  SEMAPHORE
// ═══════════════════════════════════════════════════════════════
class Semaphore {
  constructor(max, timeoutMs) {
    this.max = max;
    this.timeoutMs = timeoutMs;
    this.current = 0;
    this.queue = [];
  }
  _makeReleaser() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.current--;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        this.current++;
        next.resolve(this._makeReleaser());
      }
    };
  }
  acquire() {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve(this._makeReleaser());
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error('queue_timeout'));
      }, this.timeoutMs);
      this.queue.push(entry);
    });
  }
  async run(fn) {
    const release = await this.acquire();
    try { return await fn(); }
    finally { release(); }
  }
  stats() { return { current: this.current, queued: this.queue.length, max: this.max }; }
}
const captureSem = new Semaphore(CAPTURE_CONCURRENCY, QUEUE_TIMEOUT);

// ═══════════════════════════════════════════════════════════════
//  SINGLE-FLIGHT
// ═══════════════════════════════════════════════════════════════
const inflight = new Map();
function singleFlight(key, fn) {
  const existing = inflight.get(key);
  if (existing) {
    log('debug', 'cache', 'single-flight join', { key });
    return existing;
  }
  const p = (async () => fn())().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ═══════════════════════════════════════════════════════════════
//  BINGR.ONE FETCHER  — POST for movies, GET for TV
// ═══════════════════════════════════════════════════════════════
async function fetchFromBingr(mediaType, tmdb, s, e) {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BINGR_TIMEOUT);

  try {
    let url, options;

    if (mediaType === 'movie') {
      // ── MOVIE: POST /api/stream with srv + t + id ──────
      url = `${BINGR_BASE}/api/stream`;
      const body = { srv: BINGR_SRV, t: 'movie', id: String(tmdb) };
      options = {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(BINGR_API_KEY ? { 'x-api-key': BINGR_API_KEY } : {}),
        },
        body: JSON.stringify(body),
      };
      log('debug', 'fetch', 'bingr POST', { url, body });
    } else {
      // ── TV: GET /api/stream/{scraper}/{tmdb}/{season}/{episode} ──
      url = `${BINGR_BASE}/api/stream/${BINGR_SCRAPER}/${encodeURIComponent(tmdb)}/${Number(s)}/${Number(e)}`;
      options = {
        method: 'GET',
        signal: ctrl.signal,
        headers: {
          'Accept': 'application/json',
          ...(BINGR_API_KEY ? { 'x-api-key': BINGR_API_KEY } : {}),
        },
      };
      log('debug', 'fetch', 'bingr GET', { url });
    }

    const res = await fetch(url, options);
    const text = await res.text();

    if (!res.ok) {
      log('warn', 'fetch', 'non-200', { status: res.status, body: text.slice(0, 200) });
      return { available: false, reason: `http_${res.status}`, status: res.status };
    }

    let json;
    try { json = JSON.parse(text); }
    catch {
      log('warn', 'fetch', 'bad json', { len: text.length });
      return { available: false, reason: 'bad_json' };
    }

    const payload = normalizeBingr(json);
    if (!payload) {
      log('warn', 'fetch', 'no usable source', { keys: Object.keys(json) });
      return { available: false, reason: 'no_source' };
    }

    const took = Date.now() - startedAt;
    log('ok', 'fetch', 'hit', {
      scraper: payload.scraperName,
      sources: payload.sources.length,
      took: `${took}ms`,
    });

    return { available: true, data: payload, from: url };

  } catch (err) {
    log('warn', 'fetch', 'error', { err: err.message });
    return { available: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Accepts the shapes we've seen from bingr.one and normalizes to a payload
// that mirrors the "sources + subtitles" contract used downstream.
function normalizeBingr(json) {
  if (!json || typeof json !== 'object') return null;

  // Primary shape: { scraperName, sources: [...], subtitles: [...] }
  if (Array.isArray(json.sources) && json.sources.length) {
    const ok = json.sources.filter(s => s && typeof s.url === 'string' && s.url.length > 0);
    if (!ok.length) return null;
    return {
      scraperName: json.scraperName || 'unknown',
      sources: ok,
      subtitles: Array.isArray(json.subtitles) ? json.subtitles : [],
      _debug: json._debug,
      _debugRawKeys: json._debugRawKeys,
      _debugTrace: json._debugTrace,
    };
  }

  // Alternate shapes
  const url =
    json.m3u8_path ||
    (typeof json.url === 'string' ? json.url : null) ||
    (json.source && typeof json.source === 'string' ? json.source : null);

  if (url) {
    return {
      scraperName: json.scraperName || 'unknown',
      sources: [{
        url,
        quality: json.quality || 'Auto',
        language: json.language || 'Original',
        type: json.type || 'application/x-mpegurl',
        label: json.label || (json.scraperName ? `${json.scraperName} #0` : 'Source #0'),
        name: json.name || json.quality || 'Auto',
        isMP4: !!json.isMP4,
        headers: json.headers || {},
      }],
      subtitles: Array.isArray(json.subtitles) ? json.subtitles : [],
    };
  }

  return null;
}

// Build a normalized upstream payload (with available:true, etc.)
function buildUpstreamPayload(mediaType, cap) {
  return {
    available: true,
    type: mediaType,
    scraperName: cap.data.scraperName,
    sources: cap.data.sources,
    subtitles: cap.data.subtitles,
    _debug: cap.data._debug,
    _debugRawKeys: cap.data._debugRawKeys,
    _debugTrace: cap.data._debugTrace,
  };
}

// Fetch upstream, deduped via singleFlight so on-demand requests and the
// background refresh job never hammer the same content twice concurrently.
function fetchFreshUpstream(mediaType, tmdb, s, e) {
  const flightKey = `fetch|${mediaType}|${tmdb}|${s}|${e}`;
  return singleFlight(flightKey, () =>
    captureSem.run(() => fetchFromBingr(mediaType, tmdb, s, e))
  );
}

// ═══════════════════════════════════════════════════════════════
//  ON-DEMAND FRESHNESS  → resolveStream()
//  Flow: memory → DB(fresh|stale) → upstream
//  A DB row older than REFRESH_INTERVAL_MS is refreshed before responding.
// ═══════════════════════════════════════════════════════════════
async function resolveStream(mediaType, tmdb, s, e, key) {
  // 1) Memory — always fresh (TTL 30 min << 24 h)
  const mem = memGet(key);
  if (mem) {
    return {
      payload: mem.payload,
      source: 'memory',
      negative: mem.payload.available === false,
      refreshed: false,
      stale: false,
      updatedAt: mem.updatedAt,
    };
  }

  // 2) DB
  const dbHit = await getFromDb(mediaType, tmdb, s, e);
  if (dbHit) {
    const updatedAt = toDate(dbHit.updatedAt);
    const ageMs = updatedAt ? Date.now() - updatedAt.getTime() : Infinity;
    const isStale = !updatedAt || ageMs >= REFRESH_INTERVAL_MS;

    if (!isStale) {
      log('ok', 'cache', 'db hit (fresh)', {
        key, ageH: (ageMs / 3_600_000).toFixed(2),
      });
      memSet(key, dbHit.payload, updatedAt, CACHE_TTL);
      return {
        payload: dbHit.payload,
        source: 'database',
        negative: dbHit.payload.available === false,
        refreshed: false,
        stale: false,
        updatedAt,
      };
    }

    // STALE → try to refresh from upstream before responding
    log('info', 'cache', 'db hit (STALE) — refreshing', {
      key, ageH: (ageMs / 3_600_000).toFixed(2),
    });

    const cap = await fetchFreshUpstream(mediaType, tmdb, s, e);

    const usable =
      cap.available &&
      cap.data &&
      Array.isArray(cap.data.sources) &&
      cap.data.sources.length > 0;

    if (usable) {
      const freshPayload = buildUpstreamPayload(mediaType, cap);
      const ok = await updateDb(mediaType, tmdb, s, e, freshPayload);
      if (ok) {
        const now = new Date();
        memSet(key, freshPayload, now, CACHE_TTL);
        log('ok', 'refresh', 'stale row refreshed on-demand', { key });
        return {
          payload: freshPayload,
          source: 'refresh',
          negative: false,
          refreshed: true,
          stale: false,
          updatedAt: now,
        };
      }
      // updateDb failed → fall through and serve stale
    }

    // Refresh failed → serve the old payload, mark it stale, short retry TTL
    log('warn', 'refresh', 'refresh failed — serving stale data', {
      key,
      reason: cap.reason || 'db_update_failed',
    });
    memSet(key, dbHit.payload, updatedAt, REFRESH_RETRY_TTL);
    return {
      payload: dbHit.payload,
      source: 'database-stale',
      negative: dbHit.payload.available === false,
      refreshed: false,
      stale: true,
      updatedAt,
    };
  }

  // 3) Miss → fetch fresh
  log('info', 'cache', 'miss — fetching from bingr.one', { key });

  const cap = await fetchFreshUpstream(mediaType, tmdb, s, e);

  if (!cap.available) {
    const body = {
      available: false,
      error: 'Not available',
      message: 'This movie / episode is not available on this server.',
      reason: cap.reason,
      type: mediaType, tmdb, season: s, episode: e,
    };
    const now = new Date();
    memSet(key, body, now, NEGATIVE_CACHE_TTL);
    return {
      payload: body,
      source: 'fetch',
      negative: true,
      refreshed: false,
      stale: false,
      updatedAt: now,
    };
  }

  const payload = buildUpstreamPayload(mediaType, cap);
  const now = new Date();
  memSet(key, payload, now, CACHE_TTL);
  saveToDb(mediaType, tmdb, s, e, payload).catch(() => {});

  return {
    payload,
    source: 'fetch',
    negative: false,
    refreshed: true,
    stale: false,
    updatedAt: now,
  };
}

// ═══════════════════════════════════════════════════════════════
//  RESPONSE META HELPERS
// ═══════════════════════════════════════════════════════════════
function mapCached(source) {
  if (source === 'memory') return 'memory';
  if (source === 'database' || source === 'database-stale') return 'database';
  return false; // 'fetch' or 'refresh' → fresh upstream fetch
}
function buildMeta(result) {
  const updatedAt = toDate(result.updatedAt);
  const ageSeconds = updatedAt
    ? Math.max(0, Math.round((Date.now() - updatedAt.getTime()) / 1000))
    : null;
  return {
    source: result.source,
    refreshed: !!result.refreshed,
    stale: !!result.stale,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    ageSeconds,
    staleAfterHours: +(REFRESH_INTERVAL_MS / 3_600_000).toFixed(2),
  };
}
function buildResponse(result) {
  return {
    ...result.payload,
    _cached: mapCached(result.source),
    _meta: buildMeta(result),
  };
}

// ═══════════════════════════════════════════════════════════════
//  24H BACKGROUND SAFETY SWEEP  (optional, enabled by default)
//  Keeps never-requested rows fresh. On-demand requests do the
//  heavy lifting; this just catches the tail.
// ═══════════════════════════════════════════════════════════════
const refreshState = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastTotal: 0,
  lastUpdated: 0,
  lastFailed: 0,
  lastError: null,
};

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx], idx);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

async function refreshOne(row) {
  const mediaType = row.media_type;
  const tmdb      = row.tmdb;
  const season    = Number(row.season);
  const episode   = Number(row.episode);
  const key       = `${mediaType}|${tmdb}|${season}|${episode}`;

  let cap;
  try {
    cap = await fetchFreshUpstream(mediaType, tmdb, season, episode);
  } catch (err) {
    log('warn', 'refresh', 'fetch error — keeping old links', { key, err: err.message });
    return false;
  }

  if (!cap.available) {
    log('warn', 'refresh', 'upstream unavailable — keeping old links', {
      key, reason: cap.reason,
    });
    return false;
  }

  const payload = buildUpstreamPayload(mediaType, cap);
  if (!Array.isArray(payload.sources) || payload.sources.length === 0) {
    log('warn', 'refresh', 'upstream returned 0 sources — keeping old links', { key });
    return false;
  }

  const ok = await updateDb(mediaType, tmdb, season, episode, payload);
  if (ok) {
    memSet(key, payload, new Date(), CACHE_TTL);
    log('ok', 'refresh', 'links updated', {
      key,
      sources: payload.sources.length,
      scraper: payload.scraperName,
    });
  }
  return ok;
}

async function runRefreshCycle() {
  if (!dbReady) { log('warn', 'refresh', 'skipped — database not ready'); return; }
  if (refreshState.running) { log('warn', 'refresh', 'cycle already running'); return; }

  refreshState.running       = true;
  refreshState.lastStartedAt = new Date();
  refreshState.lastTotal     = 0;
  refreshState.lastUpdated   = 0;
  refreshState.lastFailed    = 0;
  refreshState.lastError     = null;

  const cutoff = new Date(Date.now() - REFRESH_INTERVAL_MS);
  const t0 = Date.now();
  let lastId = 0;

  log('info', 'refresh', 'cycle start', { olderThan: cutoff.toISOString() });

  try {
    while (true) {
      const { rows } = await pool.query(
        `SELECT id, media_type, tmdb, season, episode
           FROM stream_cache
          WHERE updated_at < $1
            AND id > $2
          ORDER BY id
          LIMIT $3`,
        [cutoff, lastId, REFRESH_BATCH]
      );
      if (!rows.length) break;

      lastId = rows[rows.length - 1].id;
      refreshState.lastTotal += rows.length;

      await mapLimit(rows, REFRESH_CONCURRENCY, async (row) => {
        const ok = await refreshOne(row);
        if (ok) refreshState.lastUpdated++;
        else    refreshState.lastFailed++;
      });
    }

    log('ok', 'refresh', 'cycle complete', {
      total:   refreshState.lastTotal,
      updated: refreshState.lastUpdated,
      kept:    refreshState.lastFailed,
      took:    `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    });
  } catch (err) {
    refreshState.lastError = err.message;
    log('error', 'refresh', 'cycle failed', { err: err.message });
  } finally {
    refreshState.running        = false;
    refreshState.lastFinishedAt = new Date();
  }
}

let refreshTimer     = null;
let refreshBootTimer = null;

function startRefreshScheduler() {
  if (!REFRESH_ENABLED) {
    log('info', 'refresh', 'background sweep disabled (REFRESH_ENABLED=false)');
    return;
  }
  refreshBootTimer = setTimeout(() => runRefreshCycle().catch(() => {}), REFRESH_BOOT_DELAY);
  refreshTimer     = setInterval(() => runRefreshCycle().catch(() => {}), REFRESH_INTERVAL_MS);
  refreshBootTimer.unref?.();
  refreshTimer.unref?.();

  log('info', 'refresh', 'background sweep armed', {
    every:       `${(REFRESH_INTERVAL_MS / 3_600_000).toFixed(1)}h`,
    bootDelay:   `${(REFRESH_BOOT_DELAY / 1000).toFixed(0)}s`,
    concurrency: REFRESH_CONCURRENCY,
    batch:       REFRESH_BATCH,
  });
}

function stopRefreshScheduler() {
  if (refreshBootTimer) clearTimeout(refreshBootTimer);
  if (refreshTimer)     clearInterval(refreshTimer);
  refreshBootTimer = refreshTimer = null;
}

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════
async function streamHandler(req, res) {
  const tmdb = req.query.tmdb || req.query.id;
  const rawType  = String(req.query.type || '').toLowerCase();
  const mediaType =
    rawType === 'movie' ? 'movie'
    : rawType === 'tv'  ? 'tv'
    : req.path.startsWith('/api/movie') ? 'movie'
    : 'tv';

  if (!tmdb) return res.status(400).json({ error: 'Missing tmdb (or id)' });

  const isMovie = mediaType === 'movie';
  const s = isMovie ? 0 : Number(req.query.s ?? 1);
  const e = isMovie ? 0 : Number(req.query.e ?? 1);

  const key = `${mediaType}|${tmdb}|${s}|${e}`;

  try {
    const result = await singleFlight(key, () =>
      resolveStream(mediaType, tmdb, s, e, key));

    const meta = buildMeta(result);
    res.setHeader('x-cache-source', result.source);
    res.setHeader('x-data-stale', meta.stale ? '1' : '0');
    if (meta.updatedAt) res.setHeader('x-data-updated-at', meta.updatedAt);

    const body = buildResponse(result);

    if (result.negative) return res.status(404).json(body);
    return res.json(body);

  } catch (err) {
    if (err.message === 'queue_timeout') {
      res.set('Retry-After', '5');
      log('warn', 'queue', 'full — rejecting', { key, ...captureSem.stats() });
      return res.status(503).json({
        available: false,
        error: 'Server busy',
        reason: 'queue_timeout',
        retryAfter: 5,
      });
    }
    log('error', 'proxy', 'stream error', { err: err.message, key });
    return res.status(502).json({
      available: false,
      error: 'Fetch failed',
      message: err.message,
    });
  }
}

app.get('/api/stream', streamHandler);
app.get('/api/movie',  streamHandler);

// Manual full refresh trigger (protected)
app.post('/api/admin/refresh', async (req, res) => {
  if (!ADMIN_TOKEN) return res.status(404).json({ error: 'Not found' });

  const token = req.get('x-admin-token') || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  if (refreshState.running) {
    return res.status(409).json({ ok: false, reason: 'already_running', state: refreshState });
  }
  runRefreshCycle().catch(() => {});
  return res.status(202).json({ ok: true, started: true });
});

app.get('/health', async (_req, res) => {
  let dbOk = false;
  try {
    if (dbReady) { await pool.query('SELECT 1'); dbOk = true; }
  } catch {}
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    bingrBase: BINGR_BASE,
    bingrSrv: BINGR_SRV,
    bingrScraper: BINGR_SCRAPER,
    memoryCache: cache.size,
    memoryCacheMax: MEM_CACHE_MAX,
    capture: captureSem.stats(),
    inflight: inflight.size,
    db: dbOk,
    mem: process.memoryUsage().rss,
    freshness: {
      refreshIntervalHours: +(REFRESH_INTERVAL_MS / 3_600_000).toFixed(2),
      onDemand: true,
      retryTtlSeconds: Math.round(REFRESH_RETRY_TTL / 1000),
    },
    backgroundSweep: {
      enabled:        REFRESH_ENABLED,
      running:        refreshState.running,
      lastStartedAt:  refreshState.lastStartedAt,
      lastFinishedAt: refreshState.lastFinishedAt,
      lastTotal:      refreshState.lastTotal,
      lastUpdated:    refreshState.lastUpdated,
      lastFailed:     refreshState.lastFailed,
      lastError:      refreshState.lastError,
    },
  });
});

// ═══════════════════════════════════════════════════════════════
//  BOOT + SHUTDOWN
// ═══════════════════════════════════════════════════════════════
let shuttingDown = false;

(async () => {
  banner();

  try { await initDb(); }
  catch (err) {
    log('error', 'db', 'init failed — running WITHOUT database', { err: err.message });
    dbReady = false;
  }

  const server = app.listen(PORT, () => {
    log('ok', 'server', `listening on ${C.bold}http://localhost:${PORT}${C.reset}`);
    log('info', 'server', 'config', {
      concurrency: CAPTURE_CONCURRENCY,
      queueTimeout: `${QUEUE_TIMEOUT / 1000}s`,
      captureTimeout: `${BINGR_TIMEOUT / 1000}s`,
      memCache: MEM_CACHE_MAX,
      dbPool: DB_POOL_MAX,
      logLevel: LOG_LEVEL,
      bingrBase: BINGR_BASE,
      bingrSrv: BINGR_SRV,
      bingrScraper: BINGR_SCRAPER,
      refreshEvery: `${(REFRESH_INTERVAL_MS / 3_600_000).toFixed(1)}h`,
      onDemandRefresh: true,
    });
    log('info', 'server', 'cors allow-list', { hosts: [...ALLOWED_HOSTS].join(', ') });

    // arm the optional background safety sweep
    startRefreshScheduler();

    log('ready', 'proxy', 'ready — waiting for requests');
    process.stdout.write('\n');
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout   = 66_000;
  server.requestTimeout   = 120_000;

  async function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    stopRefreshScheduler();

    divider(`shutting down (${sig})`);
    log('info', 'shutdown', 'closing HTTP server');
    server.close(() => log('ok', 'shutdown', 'HTTP closed'));

    const force = setTimeout(() => {
      log('warn', 'shutdown', 'forcing exit after 10s');
      process.exit(1);
    }, 10_000);
    force.unref();

    try { await pool.end(); log('ok', 'shutdown', 'db pool drained'); } catch {}

    clearTimeout(force);
    log('ok', 'shutdown', 'done');
    process.exit(0);
  }

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', e => log('error', 'proxy', 'unhandledRejection', { err: String(e) }));
  process.on('uncaughtException',  e => log('error', 'proxy', 'uncaughtException',  { err: String(e) }));
})();

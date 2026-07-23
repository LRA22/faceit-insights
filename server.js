const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

const PORT = process.env.PORT || 3847;
const PUBLIC = path.join(__dirname, 'public');
const FACEIT_API_KEY = (process.env.FACEIT_API_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
// Na cota free atual: 3.5 Flash Lite = ~500 RPD; Flash “cheio” (ex. 3.6) = ~20 RPD
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();
const FACEIT_API = 'https://open.faceit.com/data/v4';
// Cache do diagnóstico: default 6h (evita gastar cota ao reconsultar o mesmo perfil)
const INSIGHT_CACHE_TTL_MS = Number(
  process.env.INSIGHT_CACHE_TTL_MS || 6 * 60 * 60 * 1000
);
const CACHE_DIR = path.join(__dirname, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'insights.json');
const insightCache = new Map();

function fingerprint(obj) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(obj))
    .digest('hex')
    .slice(0, 16);
}

function loadDiskCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const now = Date.now();
    for (const [key, hit] of Object.entries(raw || {})) {
      if (hit && hit.expiresAt > now && hit.value) {
        insightCache.set(key, hit);
      }
    }
  } catch (_) {
    /* ignore */
  }
}

function saveDiskCache() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const out = {};
    const now = Date.now();
    for (const [key, hit] of insightCache.entries()) {
      if (hit.expiresAt > now) out[key] = hit;
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(out));
  } catch (e) {
    console.warn('Não foi possível gravar cache em disco:', e.message);
  }
}

function cacheGet(key) {
  const hit = insightCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    insightCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  insightCache.set(key, { value, expiresAt: Date.now() + INSIGHT_CACHE_TTL_MS });
  saveDiskCache();
}

loadDiskCache();

function send(res, status, body, type = 'application/json') {
  let data = body;
  if (Buffer.isBuffer(body)) {
    data = body;
  } else if (typeof body !== 'string') {
    data = JSON.stringify(body);
  }
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };
  if (type.startsWith('text/') || type.includes('json') || type.includes('javascript') || type.includes('svg')) {
    headers['Content-Type'] = `${type}; charset=utf-8`;
  } else {
    headers['Content-Type'] = type;
  }
  if (Buffer.isBuffer(data)) {
    headers['Content-Length'] = data.length;
  }
  res.writeHead(status, headers);
  res.end(data);
}

function parseNickname(input) {
  if (!input) return null;
  const raw = String(input).trim();
  const fromUrl = raw.match(/faceit\.com\/(?:[a-z-]+\/)?players\/([^/?#]+)/i);
  if (fromUrl) return decodeURIComponent(fromUrl[1]);
  return raw.replace(/^@/, '').split(/[/?#]/)[0] || null;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pick(obj, keys, fallback = null) {
  if (!obj) return fallback;
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== '') return obj[key];
  }
  return fallback;
}

async function faceitApi(pathname) {
  if (!FACEIT_API_KEY) {
    const err = new Error(
      'Configure FACEIT_API_KEY no Render (chave em https://developers.faceit.com)'
    );
    err.status = 503;
    throw err;
  }

  const res = await fetch(`${FACEIT_API}${pathname}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${FACEIT_API_KEY}`,
    },
  });
  const text = await res.text();

  if (!res.ok) {
    let message = `Faceit API ${res.status}`;
    try {
      const body = JSON.parse(text);
      message = body.message || body.errors?.[0]?.message || message;
    } catch (_) {
      /* ignore */
    }
    if (res.status === 401 || res.status === 403) {
      message = 'FACEIT_API_KEY inválida ou sem permissão';
    }
    if (res.status === 404) {
      message = 'Jogador não encontrado';
    }
    const err = new Error(message);
    err.status = res.status === 404 ? 404 : res.status >= 500 ? 502 : 400;
    throw err;
  }

  return text ? JSON.parse(text) : {};
}

function mapMatchStats(item) {
  const s = item?.stats || item || {};
  const score = String(pick(s, ['Score', 'score'], ''));
  const parts = score.split(/[/\-:]/).map((p) => num(p.trim()));
  const rounds = parts.length >= 2 ? parts[0] + parts[1] : 0;
  const deaths = num(pick(s, ['Deaths', 'deaths']));
  const result = pick(s, ['Result', 'result']);
  const premadeRaw = pick(s, ['Premade', 'premade']);
  let premade = null;
  if (premadeRaw === true || premadeRaw === 'true' || premadeRaw === 1 || premadeRaw === '1') {
    premade = true;
  } else if (
    premadeRaw === false ||
    premadeRaw === 'false' ||
    premadeRaw === 0 ||
    premadeRaw === '0'
  ) {
    premade = false;
  }

  return {
    map: pick(s, ['Map', 'map']),
    win: result === '1' || result === 1 || String(result).toLowerCase() === 'win',
    score,
    kills: num(pick(s, ['Kills', 'kills'])),
    assists: num(pick(s, ['Assists', 'assists'])),
    deaths,
    kd: num(pick(s, ['K/D Ratio', 'KD Ratio', 'kd'])),
    kr: num(pick(s, ['K/R Ratio', 'KR Ratio', 'kr'])),
    hs: num(pick(s, ['Headshots %', 'Headshots%', 'HS %', 'hs'])),
    adr: num(pick(s, ['ADR', 'Average Damage', 'Average Damage per Round', 'adr'])),
    dpr: rounds > 0 ? +(deaths / rounds).toFixed(2) : null,
    elo: null,
    eloDelta: null,
    premade,
    matchId: pick(s, ['Match Id', 'Match ID', 'matchId', 'match_id']),
  };
}

function aggMatches(list) {
  if (!list.length) return null;
  const avg = (key) =>
    list.reduce((s, x) => s + num(x[key]), 0) / list.length;
  const wins = list.filter((x) => x.win).length;
  const kds = list.map((x) => x.kd);
  const hs = list.map((x) => x.hs);
  const minKd = Math.min(...kds);
  const maxKd = Math.max(...kds);
  const withPremade = list.filter((x) => x.premade != null);
  return {
    n: list.length,
    wr: +((100 * wins) / list.length).toFixed(1),
    kd: +avg('kd').toFixed(2),
    adr: +avg('adr').toFixed(1),
    hs: +avg('hs').toFixed(1),
    kills: +avg('kills').toFixed(1),
    deaths: +avg('deaths').toFixed(1),
    dpr: +avg('dpr').toFixed(2),
    kdSwing: +(maxKd - minKd).toFixed(2),
    kdMin: +minKd.toFixed(2),
    kdMax: +maxKd.toFixed(2),
    hsMin: +Math.min(...hs).toFixed(0),
    hsMax: +Math.max(...hs).toFixed(0),
    highDeaths: list.filter((x) => x.deaths >= 16).length,
    lowHs: list.filter((x) => x.hs < 35).length,
    bodyShot: list.filter((x) => x.adr >= 75 && x.hs < 40).length,
    soloKnown: withPremade.length === list.length && list.length > 0,
    solo: list.filter((x) => x.premade === false).length,
  };
}

function buildStatsPayload(player, lifetime, recentMatches) {
  const cs2 = player.games?.cs2 || {};
  const life = lifetime?.lifetime || {};
  const mapped = recentMatches.slice(0, 20);

  const lifeKd = num(
    pick(life, ['Average K/D Ratio', 'K/D Ratio', 'Average K/D', 'KD Ratio'])
  );
  const lifeHs = num(
    pick(life, ['Average Headshots %', 'Headshots %', 'Average Headshots%', 'HS %'])
  );
  const lifeAdr = num(
    pick(life, ['ADR', 'Average Damage', 'Average Damage per Round'])
  );
  const lifeWr = num(pick(life, ['Win Rate %', 'Win Rate', 'Wins %']));

  return {
    profile: {
      nickname: player.nickname,
      avatar: player.avatar,
      country: player.country,
      elo: cs2.faceit_elo,
      level: cs2.skill_level,
      region: cs2.region,
      steam: player.steam_id_64 || player.platforms?.steam || null,
    },
    lifetime: {
      matches: num(pick(life, ['Matches', 'Total Matches', 'matches'])),
      wins: num(pick(life, ['Wins', 'Total Wins', 'wins'])),
      kd: lifeKd,
      wr: lifeWr,
      hs: lifeHs,
      adr: lifeAdr,
      recentForm: pick(life, ['Recent Results', 'Recent Form', 's0'], []) || [],
    },
    windows: {
      last5: aggMatches(mapped.slice(0, 5)),
      last10: aggMatches(mapped.slice(0, 10)),
      last20: aggMatches(mapped.slice(0, 20)),
    },
    matches: mapped.slice(0, 10),
  };
}

function normalizeInsight(item) {
  if (!item || typeof item !== 'object') return null;
  const level = String(item.level || 'info').toLowerCase();
  const allowed = level === 'warn' || level === 'ok' || level === 'info' ? level : 'info';
  const title = String(item.title || '').trim();
  const text = String(item.text || '').trim();
  if (!title || !text) return null;
  return { level: allowed, title, text };
}

function normalizeActions(actions) {
  if (!Array.isArray(actions)) return null;
  const out = [];
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const title = String(a.title || '').trim();
    let items = [];
    if (Array.isArray(a.items)) {
      items = a.items.map((x) => String(x || '').trim()).filter(Boolean);
    } else if (typeof a.items === 'string' && a.items.trim()) {
      items = [a.items.trim()];
    } else if (typeof a.text === 'string' && a.text.trim()) {
      items = [a.text.trim()];
    }
    if (!title) continue;
    if (!items.length) items = ['Foque no diagnóstico principal nas próximas partidas.'];
    out.push({ title, items: items.slice(0, 6) });
  }
  return out.length ? out : null;
}

function parseGeminiJson(rawText) {
  let text = String(rawText || '').trim();
  if (!text) throw new Error('Não foi possível gerar o diagnóstico');

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      parsed = JSON.parse(text.slice(start, end + 1));
    } else {
      throw new Error('Não foi possível gerar o diagnóstico');
    }
  }

  const headline = normalizeInsight(parsed.headline);
  if (!headline) {
    throw new Error('Não foi possível gerar o diagnóstico');
  }

  const secondary = Array.isArray(parsed.insights)
    ? parsed.insights.map(normalizeInsight).filter(Boolean).slice(0, 4)
    : [];

  const actions = normalizeActions(parsed.actions);
  if (!actions) {
    // Estrutura mínima se a LLM omitir actions
    return {
      insights: [headline, ...secondary],
      actions: [
        {
          title: 'Foco desta sessão',
          items: [headline.text],
        },
      ],
    };
  }

  return {
    insights: [headline, ...secondary],
    actions,
  };
}

function compactStatsForLlm(stats) {
  const p = stats.profile || {};
  const life = stats.lifetime || {};
  const w10 = stats.windows?.last10 || null;
  const w5 = stats.windows?.last5 || null;
  return {
    nick: p.nickname,
    elo: p.elo,
    level: p.level,
    life: {
      matches: life.matches,
      kd: life.kd,
      wr: life.wr,
      hs: life.hs,
      adr: life.adr,
    },
    last5: w5
      ? {
          n: w5.n,
          wr: w5.wr,
          kd: w5.kd,
          hs: w5.hs,
          adr: w5.adr,
          kills: w5.kills,
          deaths: w5.deaths,
          kdSwing: w5.kdSwing,
        }
      : null,
    last10: w10
      ? {
          n: w10.n,
          wr: w10.wr,
          kd: w10.kd,
          hs: w10.hs,
          adr: w10.adr,
          kills: w10.kills,
          deaths: w10.deaths,
          kdSwing: w10.kdSwing,
          kdMin: w10.kdMin,
          kdMax: w10.kdMax,
          hsMin: w10.hsMin,
          hsMax: w10.hsMax,
          bodyShot: w10.bodyShot,
          highDeaths: w10.highDeaths,
        }
      : null,
    recent: (stats.matches || []).slice(0, 5).map((m) => ({
      map: (m.map || '').replace(/^de_/, ''),
      w: m.win ? 1 : 0,
      k: m.kills,
      d: m.deaths,
      a: m.assists,
      kd: m.kd,
      hs: m.hs,
      adr: m.adr,
    })),
  };
}

const PATTERN_MATCH_THRESHOLD = Number(process.env.PATTERN_MATCH_THRESHOLD || 0.9);
const PATTERNS_FILE = path.join(CACHE_DIR, 'patterns.json');
const MAX_PATTERNS = Number(process.env.MAX_PATTERNS || 200);
let patternBank = [];

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function extractFeatures(compact) {
  const life = compact.life || {};
  const w = compact.last10 || compact.last5 || {};
  const lifeKd = num(life.kd);
  const lifeHs = num(life.hs);
  const lifeWr = num(life.wr);
  const lifeAdr = num(life.adr);
  const kd = num(w.kd);
  const hs = num(w.hs);
  const wr = num(w.wr);
  const adr = num(w.adr);
  const deaths = num(w.deaths);
  const swing = num(w.kdSwing);
  const n = Math.max(1, num(w.n, 1));
  const highDeaths = num(w.highDeaths) / n;
  const bodyShot = num(w.bodyShot) / n;

  return [
    clamp01(lifeKd / 2),
    clamp01(lifeHs / 100),
    clamp01(lifeWr / 100),
    clamp01(lifeAdr / 150),
    clamp01(kd / 2),
    clamp01(hs / 100),
    clamp01(wr / 100),
    clamp01(adr / 150),
    clamp01(deaths / 25),
    clamp01(swing / 2),
    clamp01((lifeHs - hs + 50) / 100), // HS drop centrado
    clamp01((lifeKd - kd + 1) / 2), // KD drop centrado
    wr >= 55 && kd < 0.95 ? 1 : 0,
    clamp01(highDeaths),
    clamp01(bodyShot),
    clamp01(num(compact.level, 5) / 10),
    clamp01(num(compact.elo, 1500) / 3000),
  ];
}

function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function loadPatternBank() {
  try {
    if (!fs.existsSync(PATTERNS_FILE)) {
      patternBank = [];
      return;
    }
    const raw = JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf8'));
    patternBank = Array.isArray(raw) ? raw : [];
  } catch (_) {
    patternBank = [];
  }
}

function savePatternBank() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(PATTERNS_FILE, JSON.stringify(patternBank.slice(-MAX_PATTERNS)));
  } catch (e) {
    console.warn('Não foi possível gravar padrões:', e.message);
  }
}

function findBestPattern(features) {
  let best = null;
  let bestScore = 0;
  for (const p of patternBank) {
    const score = cosineSimilarity(features, p.features);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (!best || bestScore < PATTERN_MATCH_THRESHOLD) return null;
  return { pattern: best, score: +bestScore.toFixed(4) };
}

function formatNum(v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  if (Number.isInteger(n)) return String(n);
  const t = +n.toFixed(2);
  if (Number.isInteger(t)) return String(t);
  return String(t);
}

function collectNumberPairs(oldC, newC) {
  const pairs = [];
  const push = (a, b) => {
    const oa = formatNum(a);
    const nb = formatNum(b);
    if (oa == null || nb == null || oa === nb) return;
    pairs.push([oa, nb]);
  };

  push(oldC.elo, newC.elo);
  push(oldC.level, newC.level);
  const ol = oldC.life || {};
  const nl = newC.life || {};
  push(ol.kd, nl.kd);
  push(ol.hs, nl.hs);
  push(ol.wr, nl.wr);
  push(ol.adr, nl.adr);
  push(ol.matches, nl.matches);

  for (const key of ['last5', 'last10']) {
    const o = oldC[key] || {};
    const n = newC[key] || {};
    for (const f of [
      'kd',
      'hs',
      'wr',
      'adr',
      'kills',
      'deaths',
      'kdSwing',
      'kdMin',
      'kdMax',
      'hsMin',
      'hsMax',
      'n',
      'bodyShot',
      'highDeaths',
    ]) {
      push(o[f], n[f]);
    }
  }

  // Evitar trocar "1" solto antes de "1.05": ordenar por tamanho do texto antigo
  pairs.sort((a, b) => b[0].length - a[0].length || b[0].localeCompare(a[0]));
  // Dedup por old
  const seen = new Set();
  return pairs.filter(([o]) => {
    if (seen.has(o)) return false;
    seen.add(o);
    return true;
  });
}

function applyNumberPairs(text, pairs) {
  let out = String(text || '');
  for (const [oldV, newV] of pairs) {
    // troca ocorrências do número antigo (evita pedaço de palavra)
    const re = new RegExp(
      `(^|[^0-9.,])(${oldV.replace('.', '\\.')})(?=[^0-9]|$)`,
      'g'
    );
    out = out.replace(re, `$1${newV}`);
  }
  return out;
}

function adaptDiagnosis(pattern, newCompact) {
  const pairs = collectNumberPairs(pattern.compact || {}, newCompact);
  const mapInsight = (i) => ({
    level: i.level,
    title: applyNumberPairs(i.title, pairs),
    text: applyNumberPairs(i.text, pairs),
  });
  const insights = (pattern.insights || []).map(mapInsight);
  const actions = (pattern.actions || []).map((a) => ({
    title: applyNumberPairs(a.title, pairs),
    items: (a.items || []).map((x) => applyNumberPairs(x, pairs)),
  }));
  return { insights, actions };
}

function savePatternFromAnalysis(compact, features, diagnosis) {
  const id = fingerprint({ features, t: Date.now() });
  patternBank.push({
    id,
    features,
    compact,
    insights: diagnosis.insights,
    actions: diagnosis.actions,
    createdAt: Date.now(),
    hits: 0,
  });
  if (patternBank.length > MAX_PATTERNS) {
    patternBank = patternBank.slice(-MAX_PATTERNS);
  }
  savePatternBank();
  return id;
}

loadPatternBank();

async function generateInsightsWithGemini(stats) {
  if (!GEMINI_API_KEY) {
    const err = new Error('Serviço de análise temporariamente indisponível');
    err.status = 503;
    throw err;
  }

  const compact = compactStatsForLlm(stats);
  const prompt = [
    'Você é um coach de CS2 Faceit. Analise o JSON de stats e monte um diagnóstico completo.',
    'Português do Brasil. Específico para ESTE jogador; cite números reais.',
    'headline: 1 diagnóstico principal (título forte + texto com 2–4 frases).',
    'insights: 2 a 3 pontos secundários detalhados (2–4 frases cada, com números).',
    'actions: 2 a 3 blocos de treino/metas; cada um com 3 a 5 items práticos.',
    'Explique o porquê (HS recente vs lifetime, swing de K/D, mortes, WR alto com KD baixo, etc.).',
    'NÃO copie roteiro genérico idêntico (Warm-up 20 min / DM Headshot Only / Aim Botz) para todo mundo — personalize.',
    'level: warn | info | ok.',
    'Stats:',
    JSON.stringify(compact),
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent`;

  const responseSchema = {
    type: 'OBJECT',
    properties: {
      headline: {
        type: 'OBJECT',
        properties: {
          level: { type: 'STRING' },
          title: { type: 'STRING' },
          text: { type: 'STRING' },
        },
        required: ['level', 'title', 'text'],
      },
      insights: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            level: { type: 'STRING' },
            title: { type: 'STRING' },
            text: { type: 'STRING' },
          },
          required: ['level', 'title', 'text'],
        },
      },
      actions: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING' },
            items: {
              type: 'ARRAY',
              items: { type: 'STRING' },
            },
          },
          required: ['title', 'items'],
        },
      },
    },
    required: ['headline', 'insights', 'actions'],
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.45,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
          responseSchema,
        },
      }),
    });
  } catch (e) {
    const err = new Error(e.message || 'Falha ao gerar o diagnóstico');
    err.status = 502;
    throw err;
  }

  const raw = await res.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (_) {
    const err = new Error('Falha ao gerar o diagnóstico');
    err.status = 502;
    throw err;
  }

  if (!res.ok) {
    console.error('Insight provider error:', res.status, body?.error?.message || raw.slice(0, 200));
    const err = new Error('Falha ao gerar o diagnóstico. Tente novamente.');
    err.status = 502;
    throw err;
  }

  const candidate = body?.candidates?.[0];
  const text =
    candidate?.content?.parts?.map((p) => p.text || '').join('') || '';

  try {
    return parseGeminiJson(text);
  } catch (e) {
    console.error(
      'Insight parse error:',
      e.message,
      'finish=',
      candidate?.finishReason,
      String(text).slice(0, 280)
    );
    const err = new Error(e.message || 'Falha ao gerar o diagnóstico');
    err.status = 502;
    throw err;
  }
}

async function handleAnalyze(nickname) {
  const nick = parseNickname(nickname);
  if (!nick) {
    const err = new Error('Informe um nick ou URL da Faceit');
    err.status = 400;
    throw err;
  }

  const player = await faceitApi(
    `/players?nickname=${encodeURIComponent(nick)}&game=cs2`
  );
  if (!player?.player_id) {
    const err = new Error('Jogador não encontrado');
    err.status = 404;
    throw err;
  }
  if (!player.games?.cs2) {
    const err = new Error('Este perfil não tem CS2 na Faceit');
    err.status = 404;
    throw err;
  }

  const playerId = player.player_id;
  const [lifetime, recent] = await Promise.all([
    faceitApi(`/players/${playerId}/stats/cs2`),
    faceitApi(`/players/${playerId}/games/cs2/stats?offset=0&limit=10`),
  ]);

  const recentMatches = Array.isArray(recent?.items)
    ? recent.items.map(mapMatchStats)
    : [];

  const stats = buildStatsPayload(player, lifetime, recentMatches);
  const compact = compactStatsForLlm(stats);

  // 1) Cache exato nick+stats → 0 LLM
  const fp = fingerprint(compact);
  const cacheKey = `${nick.toLowerCase()}:${fp}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return {
      ...stats,
      insights: cached.insights,
      actions: cached.actions,
      cached: true,
      source: 'cache',
    };
  }

  // 2) Match alto com padrão já aprendido → reusa textos adaptando números
  const features = extractFeatures(compact);
  const match = findBestPattern(features);
  if (match) {
    const adapted = adaptDiagnosis(match.pattern, compact);
    match.pattern.hits = (match.pattern.hits || 0) + 1;
    savePatternBank();
    const insightPayload = {
      insights: adapted.insights,
      actions: adapted.actions,
    };
    cacheSet(cacheKey, insightPayload);
    return {
      ...stats,
      ...insightPayload,
      cached: true,
      source: 'pattern',
      patternMatch: {
        id: match.pattern.id,
        score: match.score,
        threshold: PATTERN_MATCH_THRESHOLD,
      },
    };
  }

  // 3) Sem match → Gemini e grava novo padrão
  const generated = await generateInsightsWithGemini(stats);
  const insightPayload = {
    insights: generated.insights,
    actions: generated.actions,
  };
  cacheSet(cacheKey, insightPayload);
  const patternId = savePatternFromAnalysis(compact, features, insightPayload);

  return {
    ...stats,
    ...insightPayload,
    cached: false,
    source: 'llm',
    patternId,
  };
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    if (url.pathname === '/api/analyze' && req.method === 'GET') {
      const q = url.searchParams.get('q') || url.searchParams.get('nick');
      try {
        const data = await handleAnalyze(q);
        return send(res, 200, { ok: true, data });
      } catch (e) {
        return send(res, e.status || 500, {
          ok: false,
          error: e.message || 'Erro ao consultar Faceit',
        });
      }
    }

    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
    const abs = path.join(PUBLIC, filePath);
    if (!abs.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });

    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return send(res, 404, { error: 'Not found' });
    }

    const ext = path.extname(abs);
    send(res, 200, fs.readFileSync(abs), MIME[ext] || 'application/octet-stream');
  } catch (e) {
    send(res, 500, { ok: false, error: e.message || 'Erro interno' });
  }
});

server.listen(PORT, () => {
  console.log(`Faceit Insights rodando em http://localhost:${PORT}`);
  if (!FACEIT_API_KEY) {
    console.warn('AVISO: FACEIT_API_KEY não definida.');
  }
  if (!GEMINI_API_KEY) {
    console.warn('AVISO: GEMINI_API_KEY não definida — insights não vão funcionar.');
  }
});

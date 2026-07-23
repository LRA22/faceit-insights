const http = require('http');
const fs = require('fs');
const path = require('path');
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
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-flash-latest').trim();
const FACEIT_API = 'https://open.faceit.com/data/v4';

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
    const items = Array.isArray(a.items)
      ? a.items.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    if (!title || !items.length) continue;
    out.push({ title, items });
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
    throw new Error('Não foi possível gerar o plano de treino');
  }

  return {
    insights: [headline, ...secondary],
    actions,
  };
}

async function generateInsightsWithGemini(stats) {
  if (!GEMINI_API_KEY) {
    const err = new Error('Serviço de análise temporariamente indisponível');
    err.status = 503;
    throw err;
  }

  const prompt = [
    'Você é um coach de CS2 Faceit. Analise as estatísticas JSON abaixo.',
    'Responda APENAS com JSON válido (sem markdown) neste schema:',
    '{',
    '  "headline": { "level": "warn|info|ok", "title": string, "text": string },',
    '  "insights": [ { "level": "warn|info|ok", "title": string, "text": string } ],',
    '  "actions": [ { "title": string, "items": string[] } ]',
    '}',
    'Regras:',
    '- Português do Brasil, direto e específico para ESTE jogador.',
    '- headline = diagnóstico principal único (1 só).',
    '- insights = 2 a 4 pontos secundários distintos; cite números reais do JSON.',
    '- actions = 2 a 3 blocos de treino/metas personalizados ao diagnóstico.',
    '- PROIBIDO copiar roteiros genéricos tipo "Warm-up 20 min / DM Headshot Only / Aim Botz / Metas por partida" iguais para todo mundo.',
    '- Cada action deve citar o problema concreto deste perfil (ex.: HS recente X% vs lifetime Y%, swing de K/D).',
    '- Não invente partidas ou métricas que não estejam no JSON.',
    '- level: warn (problema), info (contexto), ok (ponto forte/estável).',
    '',
    'STATS:',
    JSON.stringify(stats),
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent`;

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
          temperature: 0.7,
          responseMimeType: 'application/json',
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

  const text =
    body?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ||
    '';

  try {
    return parseGeminiJson(text);
  } catch (e) {
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
    faceitApi(`/players/${playerId}/games/cs2/stats?offset=0&limit=20`),
  ]);

  const recentMatches = Array.isArray(recent?.items)
    ? recent.items.map(mapMatchStats)
    : [];

  const stats = buildStatsPayload(player, lifetime, recentMatches);
  const generated = await generateInsightsWithGemini(stats);

  return {
    ...stats,
    insights: generated.insights,
    actions: generated.actions,
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

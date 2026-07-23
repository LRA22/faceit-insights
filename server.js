const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const PORT = process.env.PORT || 3847;
const PUBLIC = path.join(__dirname, 'public');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

function curlBinary() {
  return process.platform === 'win32' ? 'curl.exe' : 'curl';

async function faceitGetViaCurl(url) {
  const { stdout } = await execFileAsync(
    curlBinary(),
    ['-sS', '-L', '-A', UA, '--max-time', '25', url],
    { maxBuffer: 5 * 1024 * 1024 }
  );
  const text = String(stdout || '');
  if (!text || text.startsWith('<')) {
    const err = new Error('Faceit bloqueou a requisição (Cloudflare)');
    err.status = 502;
    throw err;
  }
  return JSON.parse(text);
}

async function faceitGet(url) {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
        Referer: 'https://www.faceit.com/',
        Origin: 'https://www.faceit.com',
      },
    });
    const text = await res.text();
    if (res.ok && text && !text.startsWith('<')) {
      return JSON.parse(text);
    }
  } catch (_) {
    /* fallback abaixo */
  }
  return faceitGetViaCurl(url);
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function analyze(player, lifetime, recent) {
  const cs2 = player.games?.cs2 || {};
  const life = lifetime?.lifetime || {};
  const matches = Array.isArray(recent) ? recent.slice(0, 20) : [];

  const mapped = matches.map((m) => {
    const score = String(m.i18 || '');
    const parts = score.split('/');
    const rounds =
      parts.length >= 2 ? num(parts[0]) + num(parts[1]) : 0;
    const deaths = num(m.i8);
    return {
      map: m.i1,
      win: m.i10 === '1' || m.i10 === 1,
      score,
      kills: num(m.i6),
      assists: num(m.i7),
      deaths,
      kd: num(m.c2),
      kr: num(m.c3),
      hs: num(m.c4),
      adr: num(m.c10),
      dpr: rounds > 0 ? +(deaths / rounds).toFixed(2) : null,
      elo: m.elo != null ? num(m.elo) : null,
      eloDelta: m.elo_delta != null ? num(m.elo_delta) : null,
      premade: !!m.premade,
      matchId: m.matchId,
    };
  });

  const last5 = mapped.slice(0, 5);
  const last10 = mapped.slice(0, 10);
  const last20 = mapped.slice(0, 20);

  function agg(list) {
    if (!list.length) return null;
    const avg = (key) =>
      list.reduce((s, x) => s + num(x[key]), 0) / list.length;
    const wins = list.filter((x) => x.win).length;
    const kds = list.map((x) => x.kd);
    const hs = list.map((x) => x.hs);
    const minKd = Math.min(...kds);
    const maxKd = Math.max(...kds);
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
      solo: list.filter((x) => !x.premade).length,
    };
  }

  const a5 = agg(last5);
  const a10 = agg(last10);
  const a20 = agg(last20);

  const insights = [];
  const lifeKd = num(life.k5);
  const lifeHs = num(life.k8);
  const lifeAdr = num(life.k17);
  const lifeWr = num(life.k6);

  if (a10) {
    if (a10.kdSwing >= 0.45) {
      insights.push({
        level: 'warn',
        title: 'K/D inconsistente',
        text: `Nas últimas ${a10.n} partidas o K/D foi de ${a10.kdMin} a ${a10.kdMax} (swing ${a10.kdSwing}). Isso costuma ser HS%/finalização oscilando, não só mortes.`,
      });
    }
    if (a10.hs < 40) {
      insights.push({
        level: 'warn',
        title: 'HS% abaixo do ideal',
        text: `HS médio recente ${a10.hs}% (lifetime ${lifeHs || '—'}%). Meta pra estabilizar: ≥40–45% em todas as partidas.`,
      });
    }
    if (a10.hsMax - a10.hsMin >= 30) {
      insights.push({
        level: 'info',
        title: 'Mira bipolar',
        text: `HS recentes entre ${a10.hsMin}% e ${a10.hsMax}%. O aim existe nos bons jogos — falta consistência sob pressão.`,
      });
    }
    if (a10.deaths <= 15.5 && a10.kd < 1) {
      insights.push({
        level: 'info',
        title: 'Mortes ok, kills baixas',
        text: `Mortes ~${a10.deaths}/jogo (próximo da média de lobby), mas K/D ${a10.kd}. Foco: converter contato em kill (first bullet), não só “morrer menos”.`,
      });
    }
    if (a10.bodyShot >= 2) {
      insights.push({
        level: 'warn',
        title: 'Dano no corpo',
        text: `${a10.bodyShot} partida(s) com ADR alto e HS baixo — crosshair abaixo da head line ou spray longo no peito.`,
      });
    }
    if (a10.wr >= 55 && a10.kd < 0.95) {
      insights.push({
        level: 'info',
        title: 'Wins escondem o fragging',
        text: `WR ${a10.wr}% com K/D ${a10.kd}. Elo pode subir enquanto o swing não melhora — meça HS% e kills, não só vitória.`,
      });
    }
    if (a10.solo === a10.n) {
      insights.push({
        level: 'info',
        title: '100% solo queue',
        text: 'Todas as partidas recentes foram solo. Duo com call/trade acelera constância.',
      });
    }
  }

  if (lifeHs && a10 && a10.hs < lifeHs - 3) {
    insights.push({
      level: 'warn',
      title: 'Forma abaixo do seu nível',
      text: `HS recente (${a10.hs}%) está abaixo do lifetime (${lifeHs}%). Warm-up transferível antes do ranked.`,
    });
  }

  if (!insights.length) {
    insights.push({
      level: 'ok',
      title: 'Perfil estável',
      text: 'Nenhum alerta forte nas métricas recentes. Continue medindo HS%, kills e ADR por partida.',
    });
  }

  const actions = [
    {
      title: 'Warm-up 20 min',
      items: [
        '10 min DM Headshot Only (1–3 tiros por kill)',
        '5 min peek duels no Aim Botz (jiggle → first bullet)',
        '5 min prefire head height (Mirage/Inferno offline ou workshop)',
      ],
    },
    {
      title: 'Metas por partida',
      items: [
        'HS% ≥ 40% (ideal 45%+)',
        'Kills ≥ 16 se mortes ~14–15',
        'ADR ≥ 85',
        'K/D entre 0.95 e 1.25 (menos extremos)',
      ],
    },
    {
      title: 'Em ranked',
      items: [
        'Crosshair na head line antes do peek',
        'Matou 1 → reposiciona (não force o 2º no mesmo swing)',
        'HS < 35% no intervalo → trade/anchor por alguns rounds',
        'Máx. 3–4 ranked por sessão',
      ],
    },
  ];

  return {
    profile: {
      nickname: player.nickname,
      avatar: player.avatar,
      country: player.country,
      elo: cs2.faceit_elo,
      level: cs2.skill_level,
      region: cs2.region,
      steam: player.platforms?.steam?.id64 || null,
    },
    lifetime: {
      matches: num(life.m1),
      wins: num(life.m2),
      kd: lifeKd,
      wr: lifeWr,
      hs: lifeHs,
      adr: lifeAdr,
      recentForm: life.s0 || [],
    },
    windows: { last5: a5, last10: a10, last20: a20 },
    matches: mapped.slice(0, 10),
    insights,
    actions,
  };
}

async function handleAnalyze(nickname) {
  const nick = parseNickname(nickname);
  if (!nick) {
    const err = new Error('Informe um nick ou URL da Faceit');
    err.status = 400;
    throw err;
  }

  const user = await faceitGet(
    `https://api.faceit.com/users/v1/nicknames/${encodeURIComponent(nick)}`
  );
  const player = user.payload;
  if (!player?.id) {
    const err = new Error('Jogador não encontrado');
    err.status = 404;
    throw err;
  }
  if (!player.games?.cs2) {
    const err = new Error('Este perfil não tem CS2 na Faceit');
    err.status = 404;
    throw err;
  }

  const playerId = player.id;
  const [lifetime, recent] = await Promise.all([
    faceitGet(
      `https://api.faceit.com/stats/v1/stats/users/${playerId}/games/cs2`
    ),
    faceitGet(
      `https://api.faceit.com/stats/v1/stats/time/users/${playerId}/games/cs2?size=20`
    ),
  ]);

  return analyze(player, lifetime, recent);
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
});

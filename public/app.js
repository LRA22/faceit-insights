const form = document.getElementById('searchForm');
const input = document.getElementById('q');
const btn = document.getElementById('btn');
const statusEl = document.getElementById('status');
const results = document.getElementById('results');

const params = new URLSearchParams(location.search);
if (params.get('q') || params.get('nick')) {
  input.value = params.get('q') || params.get('nick');
  analyze(input.value);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  analyze(input.value.trim());
});

function setStatus(msg, isErr = false) {
  statusEl.hidden = !msg;
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('err', isErr);
}

async function analyze(q) {
  if (!q) {
    setStatus('Informe um nick ou URL da Faceit.', true);
    return;
  }

  btn.disabled = true;
  setStatus('Consultando Faceit…');
  results.hidden = true;

  const url = `/api/analyze?q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Falha na análise');

    const qs = new URLSearchParams(location.search);
    qs.set('q', q);
    history.replaceState(null, '', `${location.pathname}?${qs}`);

    render(json.data);
    setStatus('');
    results.hidden = false;
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setStatus(err.message || 'Erro ao analisar perfil', true);
  } finally {
    btn.disabled = false;
  }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render(data) {
  const p = data.profile;
  const life = data.lifetime;
  const w = data.windows?.last10 || data.windows?.last5;
  const insights = data.insights || [];
  const matches = data.matches || [];
  const actions = data.actions || [];

  const avatar = p.avatar
    ? `<img src="${esc(p.avatar)}" alt="" />`
    : `<div class="mark" style="width:64px;height:64px;border-radius:14px">?</div>`;

  results.innerHTML = `
    <div class="panel" style="margin-top:0">
      <div class="profile">
        ${avatar}
        <div>
          <h2>${esc(p.nickname)}</h2>
          <div class="meta">${esc(p.country || '').toUpperCase()} · ${esc(p.region || '—')}</div>
          <div class="badges">
            <span class="badge">Level ${esc(p.level)}</span>
            <span class="badge">${esc(p.elo)} ELO</span>
            <span class="badge">${esc(life.matches)} partidas</span>
          </div>
        </div>
      </div>

      <h3 style="margin:0 0 0.6rem;font-size:1rem;color:var(--muted)">Lifetime</h3>
      <div class="stats">
        ${stat('K/D', life.kd)}
        ${stat('WR', life.wr != null ? life.wr + '%' : '—')}
        ${stat('HS%', life.hs != null ? life.hs + '%' : '—')}
        ${stat('ADR', life.adr)}
      </div>

      ${
        w
          ? `
        <h3 style="margin:0 0 0.6rem;font-size:1rem;color:var(--muted)">Últimas ${w.n} partidas</h3>
        <div class="stats">
          ${stat('WR', w.wr + '%')}
          ${stat('K/D', w.kd)}
          ${stat('HS%', w.hs + '%')}
          ${stat('ADR', w.adr)}
          ${stat('Kills', w.kills)}
          ${stat('Mortes', w.deaths)}
          ${stat('KD swing', w.kdSwing)}
        </div>`
          : ''
      }

      <h3 style="margin:0 0 0.6rem;font-size:1rem;color:var(--muted)">Insights</h3>
      <div class="insights">
        ${insights
          .map(
            (i) => `
          <div class="insight ${esc(i.level)}">
            <span class="tag">${esc(i.level)}</span>
            <strong>${esc(i.title)}</strong>
            <p>${esc(i.text)}</p>
          </div>`
          )
          .join('')}
      </div>

      <h3 style="margin:0 0 0.6rem;font-size:1rem;color:var(--muted)">Partidas recentes</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Mapa</th><th>R</th><th>K/A/D</th><th>K/D</th><th>ADR</th><th>HS%</th><th>DPR</th>
            </tr>
          </thead>
          <tbody>
            ${matches
              .map(
                (m) => `
              <tr>
                <td>${esc((m.map || '').replace('de_', ''))}</td>
                <td class="${m.win ? 'w' : 'l'}">${m.win ? 'W' : 'L'}</td>
                <td class="mono">${m.kills}/${m.assists}/${m.deaths}</td>
                <td class="mono">${m.kd}</td>
                <td class="mono">${m.adr}</td>
                <td class="mono">${m.hs}</td>
                <td class="mono">${m.dpr ?? '—'}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>

      <div class="actions">
        ${actions
          .map(
            (a) => `
          <div class="action">
            <h4>${esc(a.title)}</h4>
            <ul>${(a.items || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          </div>`
          )
          .join('')}
      </div>
    </div>
  `;
}

function stat(label, value) {
  return `<div class="stat"><b>${esc(value ?? '—')}</b><span>${esc(label)}</span></div>`;
}

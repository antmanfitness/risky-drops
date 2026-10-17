/* Risky Drops front end. Read-only links; never buys or carts. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => /^https?:\/\//i.test(u || '') ? u : '';
  const money = (n) => n == null || !isFinite(n) ? '' : (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const etDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
  const et = (iso) => iso ? etFmt.format(new Date(iso)) + ' ET' : '';
  const LABEL = { in_stock: 'In stock', sold_out: 'Sold out', scheduled: 'Scheduled', paused: 'Paused', blocked: 'Blocked', error: 'Error', unknown: 'Unknown', starting: 'Starting', running: 'Running' };
  let state = { status: null, alerts: [], flip: null, filter: 'all', tab: 'watches' };

  const toast = (t) => { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (el.hidden = true), 2600); };
  // ---- backend: local box server (cookie) or hosted mode (Supabase RPC + access key, commands polled by the box)
  const CFG = window.RD_CONFIG || null;
  const KEY = (() => {
    if (!CFG) return null;
    const k = new URLSearchParams(location.search).get('key');
    if (k) { localStorage.setItem('rd-key', k); return k; }
    return localStorage.getItem('rd-key');
  })();
  async function rpc(fn, args) {
    const r = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST', cache: 'no-store',
      headers: { apikey: CFG.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message === 'forbidden' ? 'Access key missing or wrong' : (j.message || 'HTTP ' + r.status));
    return j;
  }
  let snap = null, snapAt = 0;
  async function snapshot() {
    if (!snap || Date.now() - snapAt > 2000) { snapAt = Date.now(); snap = rpc('rd_get', { p_key: KEY }); }
    return snap;
  }
  async function command(action, payload) {
    const c = await rpc('rd_command', { p_key: KEY, p_action: action, p_payload: payload || {} });
    toast('Sent to the box. It applies changes within about 30 seconds…');
    for (let i = 0; i < 45; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      const st = await rpc('rd_command_status', { p_key: KEY, p_id: c.id });
      if (st && st.state === 'done') { snap = null; return st.result || {}; }
      if (st && st.state === 'failed') throw new Error((st.result && st.result.error) || 'The box could not apply that');
    }
    throw new Error('The box has not picked this up yet. Is it online? It will apply it when it reconnects.');
  }
  async function api(path, body) {
    if (CFG) {
      if (!KEY) throw new Error('Access key missing. Open the full link with ?key= once.');
      if (body === undefined) {
        const d = await snapshot();
        state.syncedAt = d.synced_at;
        if (path === '/api/status') return d.status || { items: [] };
        if (path === '/api/alerts') return { alerts: d.alerts || [] };
        if (path === '/api/flip') return d.flip || {};
      }
      if (path === '/api/items') return command('add', body);
      const m = path.match(/^\/api\/items\/([^/]+)\/(pause|resume|delete)$/);
      if (m) return command(m[2], { id: decodeURIComponent(m[1]) });
      if (path === '/api/test-notify') return command('test_notify', {});
      throw new Error('not supported');
    }
    const opt = body === undefined ? { credentials: 'same-origin' } :
      { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-RD': '1' }, body: JSON.stringify(body) };
    const r = await fetch(path, opt);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  // ---------- tabs
  function show(tab) {
    state.tab = tab;
    document.querySelectorAll('.screen').forEach((s) => (s.hidden = s.id !== 'tab-' + tab));
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + '#' + tab);
    if (tab === 'alerts') { localStorage.setItem('rd-seen', new Date().toISOString()); renderBadge(); }
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  // ---------- watches
  function renderWatches() {
    const items = state.status?.items || [];
    const lastSync = state.syncedAt || state.status?.generated;
    const stale = lastSync && Date.now() - new Date(lastSync).getTime() > 3 * 60 * 1000;
    $('#updated').textContent = lastSync ? (stale ? 'Box offline? Last sync ' : 'Updated ') + et(lastSync) : '';
    $('#updated').style.color = stale ? 'var(--red)' : '';
    const sum = $('#summary'); sum.innerHTML = '';
    const active = items.filter((i) => i.status !== 'scheduled' && i.status !== 'paused' && i.status !== 'blocked' || i.builtin && i.id === 'vans');
    const alive = items.filter((i) => i.alive).length;
    const shouldRun = items.filter((i) => i.can_pause && !i.paused && !(i.status === 'blocked' && !i.builtin)).length || 1;
    const hot = items.filter((i) => i.status === 'in_stock').length;
    sum.appendChild(OrbitRing({ pct: (alive / shouldRun) * 100, size: 74, tone: hot ? 'alert' : undefined,
      center: `<b>${alive}/${shouldRun}</b><small>alive</small>`, label: `${alive} of ${shouldRun} watchers alive` }));
    const txt = document.createElement('div'); txt.className = 'grow';
    txt.innerHTML = `<p class="t">${hot ? `${hot} in stock now` : 'Nothing in stock right now'}</p>
      <p class="d">${alive} watcher${alive === 1 ? '' : 's'} running · ${items.length} items. Tap Buy to open the product or Apple pickup page; you check out yourself.</p>`;
    sum.appendChild(txt);
    $('#watch-list').innerHTML = items.map((i) => {
      const link = safeUrl(i.link);
      const procTxt = i.status === 'scheduled' ? 'Starts on schedule' : i.alive ? `Watcher alive (pid ${i.pid})` : (i.status === 'blocked' && !i.builtin ? 'Not polled' : 'Watcher not running');
      const pauseBtn = i.can_pause ? (i.paused || (!i.alive && i.builtin)
        ? `<button class="btn" data-act="resume" data-id="${esc(i.id)}">${i.paused ? 'Resume' : 'Start'}</button>`
        : `<button class="btn" data-act="pause" data-id="${esc(i.id)}">Pause</button>`) : '';
      const del = !i.builtin ? `<button class="btn ghost" data-act="delete" data-id="${esc(i.id)}" aria-label="Remove">Remove</button>` : '';
      return `<div class="card ${i.status === 'in_stock' ? 'in-stock-card' : ''}">
        <div class="row"><p class="t grow">${esc(i.name)}</p><span class="pill ${esc(i.status)}">${esc(LABEL[i.status] || i.status)}</span></div>
        <p class="d">${esc(i.sub)}</p>
        ${i.detail ? `<p class="d">${esc(i.detail)}</p>` : ''}
        ${i.extra ? `<p class="f">${esc(i.extra)}</p>` : ''}
        <div class="meta"><span class="row" style="gap:6px"><span class="dot ${i.alive ? 'on' : (i.status === 'scheduled' || i.paused || (i.status === 'blocked' && !i.builtin) ? '' : 'off')}"></span>${esc(procTxt)}</span>
          <span>Last check: ${i.last_check ? esc(et(i.last_check)) : '—'}${i.stale ? ' (stale)' : ''}</span></div>
        <div class="actions">${link ? `<a class="btn buy" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Buy ↗</a>` : ''}${pauseBtn}${del}</div>
      </div>`;
    }).join('') || '<p class="empty">No watches yet.</p>';
  }
  $('#watch-list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const { act, id } = b.dataset;
    if (act === 'delete' && !confirm('Stop and remove this watch?')) return;
    if (act === 'pause' && !confirm('Pause this watcher? It stops checking until you resume.')) return;
    b.disabled = true;
    try { await api(`/api/items/${encodeURIComponent(id)}/${act}`, {}); toast(act === 'pause' ? 'Paused' : act === 'delete' ? 'Removed' : 'Started'); setTimeout(load, 1500); }
    catch (err) { toast(err.message); b.disabled = false; }
  });
  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, msg = $('#add-msg'), btn = f.querySelector('button');
    msg.className = 'msg'; msg.textContent = 'Adding…'; btn.disabled = true;
    try {
      const r = await api('/api/items', { target: f.target.value, name: f.name.value, zips: f.zips.value, sizes: f.sizes.value });
      msg.className = 'msg ok';
      msg.textContent = r.item.blocked ? `Added as Blocked: ${r.item.site} blocks this box.` : `Watching ${r.item.part || r.item.site}. First check within a minute.`;
      f.target.value = ''; f.name.value = ''; f.sizes.value = '';
      setTimeout(load, 2000);
    } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
    btn.disabled = false;
  });

  // ---------- alerts
  function renderBadge() {
    const seen = localStorage.getItem('rd-seen') || '';
    const n = state.alerts.filter((a) => a.kind === 'restock' && !a.backfilled && a.ts > seen).length;
    $('#badge').textContent = n ? String(n) : '';
  }
  function renderAlerts() {
    const list = state.alerts.filter((a) => state.filter === 'all' || a.kind === state.filter);
    let lastDay = '';
    $('#alert-list').innerHTML = list.map((a) => {
      const day = etDay.format(new Date(a.ts));
      const head = day !== lastDay ? `<div class="day">${esc(day)}</div>` : ''; lastDay = day;
      const where = [a.store, a.street, a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter((x) => x && x !== 'online').join(', ');
      const link = safeUrl(a.link);
      return `${head}<div class="card">
        <div class="row"><p class="t grow">${esc(a.item || a.title)}</p><span class="pill ${esc(a.kind)}">${a.kind === 'test' ? 'Test' : 'Restock'}</span></div>
        ${where ? `<p class="d">${esc(where)}</p>` : ''}
        ${a.detail ? `<p class="d">${esc(a.detail)}</p>` : ''}
        <p class="f">${esc(a.time_et || et(a.ts))}${a.backfilled ? ' · from watcher log' : ''}${a.pushed === false ? ' · push failed' : ''}</p>
        ${link ? `<div class="actions"><a class="btn buy" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Buy ↗</a></div>` : ''}
      </div>`;
    }).join('') || '<p class="empty">No alerts yet.</p>';
  }
  $('#alert-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.filter = b.dataset.f; document.querySelectorAll('#alert-filter button').forEach((x) => x.classList.toggle('on', x === b)); renderAlerts();
  });

  // ---------- flip
  const TAX = 0.06625;
  const fee = () => { const v = parseFloat($('#fee').value); return isFinite(v) ? v / 100 : 0.13; };
  function renderFlip() {
    const f = state.flip; if (!f) return;
    const fe = fee();
    $('#flip-list').innerHTML = f.products.map((p) => {
      const rows = p.rows.map((r) => {
        const price = r.price ?? p.price;
        const cost = price != null ? price * (1 + TAX) : null;
        const profit = cost != null && r.resale != null ? r.resale * (1 - fe) - cost : null;
        return `<div class="frow"><span>${esc(r.label)}</span><span>${money(cost)}</span><span>${money(r.resale)}</span>
          <span class="${profit == null ? '' : profit >= 0 ? 'pos' : 'neg'}">${money(profit)}</span>${r.note ? `<small>${esc(r.note)}</small>` : ''}</div>`;
      }).join('');
      return `<div class="card"><p class="t">${esc(p.name)}</p>
        <p class="d">${esc(p.sku)}${p.price != null ? ' · retail ' + money(p.price) + ' → ' + money(p.price * (1 + TAX)) + ' with NJ tax' : ''}</p>
        <div class="ftable"><div class="frow h"><span>Size / config</span><span>Cost</span><span>Resale</span><span>Profit</span></div>${rows}</div>
        <p class="f">Source: ${esc(p.source)}${p.fee_hint ? ' · typical fees ' + esc(p.fee_hint) : ''}. ${esc(p.caveat || '')}</p></div>`;
    }).join('');
  }
  function calc() {
    const p = parseFloat($('#calc-price').value), r = parseFloat($('#calc-resale').value);
    if (!isFinite(p)) { $('#calc-out').textContent = 'Enter a price to see cost with NJ tax.'; return; }
    const cost = p * (1 + TAX);
    $('#calc-out').innerHTML = `Cost with tax <b>${money(cost)}</b>` + (isFinite(r) ? ` · after ${(fee() * 100).toFixed(1)}% fee you net ${money(r * (1 - fee()))} · profit <b class="${r * (1 - fee()) - cost >= 0 ? '' : ''}">${money(r * (1 - fee()) - cost)}</b>` : '');
  }
  $('#fee').addEventListener('input', () => { renderFlip(); calc(); });
  $('#calc-price').addEventListener('input', calc); $('#calc-resale').addEventListener('input', calc);

  // ---------- settings
  function applyTheme(t) {
    localStorage.setItem('rd-theme', t);
    const d = t === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
    document.documentElement.dataset.theme = d;
    document.querySelector('meta[name=theme-color]').content = d === 'light' ? '#f6f1e8' : '#030404';
    document.querySelectorAll('#theme-seg button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  }
  $('#theme-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) applyTheme(b.dataset.t); });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (localStorage.getItem('rd-theme') === 'auto') applyTheme('auto'); });
  applyTheme(localStorage.getItem('rd-theme') || 'dark');
  $('#test-btn').addEventListener('click', async (e) => {
    const b = e.currentTarget, m = $('#test-msg'); b.disabled = true; m.className = 'msg'; m.textContent = 'Sending…';
    try { await api('/api/test-notify', {}); m.className = 'msg ok'; m.textContent = 'Sent. Check the ntfy app on your iPhone.'; load(); }
    catch (err) { m.className = 'msg err'; m.textContent = 'Failed: ' + err.message; }
    setTimeout(() => (b.disabled = false), 5000);
  });

  // ---------- data
  async function load() {
    try {
      const [s, a] = await Promise.all([api('/api/status'), api('/api/alerts')]);
      state.status = s; state.alerts = a.alerts || [];
      if (!state.flip) state.flip = await api('/api/flip');
      if (!localStorage.getItem('rd-seen')) localStorage.setItem('rd-seen', new Date().toISOString());
      renderWatches(); renderAlerts(); renderFlip(); renderBadge(); calc();
    } catch (err) {
      if (/Access key/.test(err.message)) {
        document.querySelector('main').innerHTML = '<div class="card" style="margin-top:30px;text-align:center"><p class="t">Access key required</p><p class="d">Open the full Risky Drops link with ?key=… once. This device remembers it.</p></div>';
        document.querySelector('.tabbar').hidden = true;
      } else toast('Could not load: ' + err.message);
    }
    $('#boot').classList.add('gone');
  }
  const h = location.hash.slice(1); if (['watches', 'alerts', 'flip', 'settings'].includes(h)) show(h);
  load();
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
})();

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
    $('#cd-open').classList.toggle('on', tab === 'countdowns');
    $('#ask-open').hidden = tab === 'ask';
    if (typeof closeSheet === 'function') closeSheet();
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
        ${CFG ? dropHtml(i) : ''}
        <div class="actions">${link ? `<a class="btn buy" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Buy ↗</a>` : ''}${pauseBtn}${CFG ? `<button class="btn" data-drop="${esc(i.id)}">Drop time</button>` : ''}${del}</div>
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
        <div class="row"><p class="t grow">${esc(a.item || a.title)}</p><span class="pill ${esc(a.kind)}">${a.kind === 'test' ? 'Test' : a.kind === 'price_drop' ? 'Price drop' : 'Restock'}</span></div>
        ${where ? `<p class="d">${esc(where)}</p>` : ''}
        ${a.detail ? `<p class="d">${esc(a.detail)}</p>` : ''}
        <p class="f">${esc(a.time_et || et(a.ts))}${a.backfilled ? ' · from watcher log' : ''}${a.pushed === false ? ' · push failed' : ''}</p>
        ${CFG ? soldLine(a) : ''}
        <div class="actions">${link ? `<a class="btn buy" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Buy ↗</a>` : ''}${CFG && a.id && a.kind !== 'test' ? `<button class="btn" data-sold="${esc(a.id)}">${saleFor(a.id) ? 'Edit sale' : 'Mark as sold'}</button>` : ''}</div>
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

  // ================= v2: Listings, profit tracker, mark-as-sold, countdowns, members, price watch =================
  const ext = { listings: [], sales: [], drops: {}, members: [], countdowns: [], prices: [], loaded: false };
  const PLATFORM = { ebay: 'eBay', stockx: 'StockX', facebook: 'Facebook Marketplace', mercari: 'Mercari', other: 'Local / Other' };
  const platName = (r) => r.platform === 'other' ? (r.platform_custom || 'Local / Other') : (PLATFORM[r.platform] || r.platform);
  const num = (v) => { const s = String(v ?? '').replace(/[$,\s]/g, ''); return s === '' || !/^-?\d*\.?\d+$/.test(s) ? NaN : parseFloat(s); };
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  // same formula as the database: profit = price − price×fee% − shipping − cost
  const pnl = (price, fee, ship, cost) => { const f = r2(price * fee / 100); return { fee: f, net: r2(price - price * fee / 100 - ship), profit: r2(price - price * fee / 100 - ship - cost) }; };
  const cls = (n) => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
  const pct = (n) => (Math.round(n * 1000) / 1000).toString();
  // ET helpers (datetime-local inputs are read and written as America/New_York wall time)
  const etPartsFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const etParts = (d) => { const o = {}; etPartsFmt.formatToParts(d).forEach((p) => (o[p.type] = p.value)); return o; };
  const etLocalToIso = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || ''); if (!m) return null;
    const want = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]); let g = want;
    for (let i = 0; i < 3; i++) { const p = etParts(new Date(g)); g -= Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - want; }
    return new Date(g).toISOString();
  };
  const isoToEtLocal = (iso) => { if (!iso) return ''; const p = etParts(new Date(iso)); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
  const etKey = (d) => { const p = etParts(d); return `${p.year}-${p.month}-${p.day}`; };
  const etWhen = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const etLong = (iso) => etWhen.format(new Date(iso)) + ' ET';
  const ago = (iso) => { const s = Math.max(0, (Date.now() - new Date(iso)) / 1000); return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} hr ago` : `${Math.round(s / 86400)}d ago`; };
  const split = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return { d: Math.floor(s / 86400), h: Math.floor(s / 3600) % 24, m: Math.floor(s / 60) % 60, s: s % 60 }; };
  const pad = (n) => String(n).padStart(2, '0');
  const compact = (ms) => { const t = split(ms); return (t.d ? `${t.d}d ` : '') + `${pad(t.h)}h ${pad(t.m)}m ${pad(t.s)}s`; };
  const digits = (iso) => { const t = split(new Date(iso) - Date.now());
    return `<div class="cd-digits" data-digits="${esc(iso)}"><span><b>${t.d}</b><small>days</small></span><span><b>${pad(t.h)}</b><small>hrs</small></span><span><b>${pad(t.m)}</b><small>min</small></span><span><b>${pad(t.s)}</b><small>sec</small></span></div>`; };
  const need = () => { if (!CFG) throw new Error('Listings and countdowns need the hosted app link.'); if (!KEY) throw new Error('Access key missing. Open the full link with ?key= once.'); };
  const call = async (fn, args) => { need(); const r = await rpc(fn, { p_key: KEY, ...args }); return r; };
  async function loadExt() {
    if (!CFG || !KEY) return;
    const d = await rpc('rd_app_data', { p_key: KEY });
    Object.assign(ext, d, { loaded: true });
  }
  const refreshExt = async () => { try { await loadExt(); renderV2(); } catch (e) { toast('Could not load: ' + e.message); } };

  // ---------- members (picker stored in localStorage)
  const me = () => { const id = +localStorage.getItem('rd-member'); return ext.members.find((m) => m.id === id) || ext.members.find((m) => m.name === 'Krishna') || ext.members[0] || null; };
  const memberName = (id) => (ext.members.find((m) => m.id === id) || {}).name || 'No owner';
  function renderMembers() {
    const cur = me(), sel = $('#member-pick');
    sel.innerHTML = ext.members.map((m) => `<option value="${m.id}" ${cur && m.id === cur.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('') || '<option value="">No members yet</option>';
    $('#member-topic').innerHTML = cur ? (cur.ntfy_topic ? `Reminders go to ntfy topic <b>${esc(cur.ntfy_topic)}</b>.` : '<span class="neg">No ntfy topic yet, so reminders can’t reach you. Tap Edit me.</span>') : '';
    $('#member-edit').hidden = !cur;
  }
  $('#member-pick').addEventListener('change', (e) => { localStorage.setItem('rd-member', e.target.value); renderV2(); toast('Hi ' + (me()?.name || '')); });
  let memberEditing = null;
  const memberForm = (m) => { memberEditing = m; const f = $('#member-form'); f.hidden = false; f.name.value = m ? m.name : ''; f.topic.value = m ? (m.ntfy_topic || '') : ''; $('#member-msg').textContent = ''; f.name.focus(); };
  $('#member-add').addEventListener('click', () => memberForm(null));
  $('#member-edit').addEventListener('click', () => memberForm(me()));
  $('#member-cancel').addEventListener('click', () => ($('#member-form').hidden = true));
  $('#member-gen').addEventListener('click', () => { const f = $('#member-form'); const a = new Uint8Array(5); crypto.getRandomValues(a);
    f.topic.value = 'rd-' + (f.name.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'member') + '-' + [...a].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 8); });
  $('#member-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target, msg = $('#member-msg');
    try { const m = await call('rd_member_save', { p_id: memberEditing ? memberEditing.id : null, p_name: f.name.value, p_topic: f.topic.value });
      localStorage.setItem('rd-member', m.id); f.hidden = true; toast('Saved ' + m.name); await refreshExt();
    } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
  });

  // ---------- sheets
  let openSheet = null;
  function sheet(id) { closeSheet(); openSheet = $(id); openSheet.hidden = false; $('#sheet-back').hidden = false; document.body.style.overflow = 'hidden'; openSheet.scrollTop = 0; }
  function closeSheet() { if (openSheet) openSheet.hidden = true; openSheet = null; $('#sheet-back').hidden = true; document.body.style.overflow = ''; }
  $('#sheet-back').addEventListener('click', closeSheet);
  document.querySelectorAll('.sheet [data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  const otherToggle = (f) => { f.querySelector('[data-other]').hidden = f.platform.value !== 'other'; };
  const feeErr = (v) => !isFinite(v) ? 'Enter the selling fee % for this listing (0 is OK).' : v < 0 || v > 100 ? 'Fee % must be between 0 and 100.' : '';
  const calcHtml = (price, fee, ship, cost) => {
    if (!isFinite(price) || !isFinite(fee)) return '<p class="hint">Enter price and fee % to see fee, net payout and profit.</p>';
    const r = pnl(price, fee, isFinite(ship) ? ship : 0, isFinite(cost) ? cost : 0);
    return `<div class="mgrid"><div><small>Fee (${esc(pct(fee))}%)</small><b>−${money(r.fee)}</b></div><div><small>Net payout</small><b>${money(r.net)}</b></div>
      <div class="big"><small>Profit</small><b class="${cls(r.profit)}">${money(r.profit)}</b></div></div>`;
  };
  const priceRow = (kind, ref) => ext.prices.find((p) => p.kind === kind && p.ref === String(ref));
  function priceLine(p, buyIn) {
    const b = p && p.buy_in != null ? +p.buy_in : buyIn;
    if (b == null || !isFinite(b)) return '';
    let s = `Buy-in <b>${money(b)}</b> · `;
    if (!p || p.market_value == null) s += 'No price source yet';
    else { const v = +p.market_value, gap = v - b, g = b ? gap / b * 100 : 0;
      s += `Value <b>${money(v)}</b> from ${esc(p.market_value_source || 'source')} at ${esc(et(p.market_value_at))} · <span class="${gap < 0 ? 'neg' : 'pos'}">${gap < 0 ? '−' : '+'}${money(Math.abs(gap)).replace('−', '')} (${g.toFixed(1)}%)</span>`; }
    if (p && p.alert_on) s += ' · drop alert on' + (p.drop_alert_fired_at ? ' (fired)' : '');
    return `<p class="pw">${s}</p>`;
  }

  // ---------- listings
  let listingFilter = 'all', listingEdit = null, trackerPeriod = 'all';
  function renderListings() {
    const rows = ext.listings.filter((l) => listingFilter === 'all' || l.status === listingFilter);
    $('#listing-list').innerHTML = rows.map((l) => {
      const r = pnl(+l.price, +l.fee_pct, +l.shipping, +l.cost);
      return `<div class="card">
        <div class="row"><p class="t grow">${esc(l.item)}</p><span class="pill ${esc(l.status)}">${l.status === 'sold' ? 'Sold' : 'Active'}</span></div>
        <p class="d">${esc(platName(l))} · fee ${esc(pct(+l.fee_pct))}%${l.status === 'sold' && l.sold_at ? ' · sold ' + esc(et(l.sold_at)) : ' · listed ' + esc(et(l.created_at))}</p>
        <div class="mgrid"><div><small>${l.status === 'sold' ? 'Sale' : 'List'} price</small><b>${money(+l.price)}</b></div><div><small>Fee</small><b>−${money(r.fee)}</b></div><div><small>Shipping</small><b>${+l.shipping ? '−' + money(+l.shipping) : money(0)}</b></div>
          <div><small>Net payout</small><b>${money(r.net)}</b></div><div><small>Cost paid</small><b>${money(+l.cost)}</b></div><div class="big"><small>Profit</small><b class="${cls(r.profit)}">${money(r.profit)}</b></div></div>
        ${l.notes ? `<p class="f">${esc(l.notes)}</p>` : ''}
        ${priceLine(priceRow('listing', l.id), +l.cost)}
        <div class="actions"><button class="btn" data-ledit="${l.id}">Edit</button>${l.status === 'active' ? `<button class="btn" data-lsold="${l.id}">Mark sold</button>` : ''}<button class="btn ghost danger" data-ldel="${l.id}">Delete</button></div>
      </div>`;
    }).join('') || `<p class="empty">${ext.listings.length ? 'Nothing here.' : 'No listings yet. Tap + New listing.'}</p>`;
  }
  function renderTracker() {
    const now = new Date(), today = etKey(now), wd = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7;
    const monday = new Date(Date.parse(today + 'T12:00:00Z') - wd * 86400000).toISOString().slice(0, 10);
    const inP = (iso) => { if (!iso) return false; const k = etKey(new Date(iso)); return trackerPeriod === 'all' || (trackerPeriod === 'month' ? k.slice(0, 7) === today.slice(0, 7) : k >= monday); };
    const all = [...ext.listings.filter((l) => l.status === 'sold').map((l) => ({ ...l, when: l.sold_at || l.updated_at })), ...ext.sales.map((s) => ({ ...s, when: s.sold_at }))].filter((x) => inP(x.when));
    const t = all.reduce((a, x) => { const r = pnl(+x.price, +x.fee_pct, +x.shipping, +x.cost); a.rev += +x.price; a.fee += r.fee; a.ship += +x.shipping; a.cost += +x.cost; a.profit += r.profit; return a; }, { rev: 0, fee: 0, ship: 0, cost: 0, profit: 0 });
    $('#tracker-stats').innerHTML = `<div class="wide"><small>Total profit · ${all.length} sale${all.length === 1 ? '' : 's'}</small><b class="${cls(r2(t.profit))}">${money(r2(t.profit))}</b></div>
      <div><small>Revenue</small><b>${money(r2(t.rev))}</b></div><div><small>Fees</small><b>${money(r2(t.fee))}</b></div>
      <div><small>Cost</small><b>${money(r2(t.cost))}</b></div><div><small>Shipping</small><b>${money(r2(t.ship))}</b></div>`;
  }
  $('#tracker-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; trackerPeriod = b.dataset.p; document.querySelectorAll('#tracker-seg button').forEach((x) => x.classList.toggle('on', x === b)); renderTracker(); });
  $('#listing-filter').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; listingFilter = b.dataset.f; document.querySelectorAll('#listing-filter button').forEach((x) => x.classList.toggle('on', x === b)); renderListings(); });
  const setStatus = (s) => document.querySelectorAll('#sl-status button').forEach((b) => b.classList.toggle('on', b.dataset.s === s));
  const curStatus = () => $('#sl-status button.on').dataset.s;
  $('#sl-status').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { setStatus(b.dataset.s); } });
  function listingCalc() { const f = $('#listing-form'); $('#sl-calc').innerHTML = calcHtml(num(f.price.value), num(f.fee_pct.value), num(f.shipping.value), num(f.cost.value)); }
  function openListing(l, sold) {
    listingEdit = l || null; const f = $('#listing-form'); f.reset();
    $('#sl-title').textContent = l ? 'Edit listing' : 'New listing';
    f.item.value = l ? l.item : ''; f.platform.value = l ? l.platform : ''; f.platform_custom.value = l ? (l.platform_custom || '') : '';
    f.fee_pct.value = l ? pct(+l.fee_pct) : ''; f.cost.value = l ? (+l.cost).toFixed(2) : ''; f.price.value = l ? (+l.price).toFixed(2) : '';
    f.shipping.value = l && +l.shipping ? (+l.shipping).toFixed(2) : ''; f.notes.value = l ? (l.notes || '') : '';
    setStatus(sold ? 'sold' : l ? l.status : 'active');
    const p = l && priceRow('listing', l.id); f.drop_alert.checked = !!(p && p.alert_on);
    $('#sl-price').innerHTML = (p && p.market_value != null) ? priceLine(p, +l.cost) : 'Uses your cost paid as the buy-in. No price source yet, so nothing is checked until one is added.';
    $('#sl-delete').hidden = !l; $('#sl-msg').textContent = ''; otherToggle(f); listingCalc(); sheet('#sheet-listing');
  }
  $('#listing-new').addEventListener('click', () => openListing(null));
  $('#listing-form').addEventListener('input', listingCalc);
  $('#listing-form').platform.addEventListener('change', (e) => otherToggle(e.target.form));
  $('#listing-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target, msg = $('#sl-msg'); msg.className = 'msg err';
    const fee = num(f.fee_pct.value), cost = num(f.cost.value), price = num(f.price.value), ship = f.shipping.value.trim() === '' ? 0 : num(f.shipping.value);
    const err = !f.item.value.trim() ? 'Enter the item name.' : !f.platform.value ? 'Pick the platform you’re selling on.' : (f.platform.value === 'other' && !f.platform_custom.value.trim()) ? 'Type the platform name for Local / Other.' :
      feeErr(fee) || (!isFinite(cost) || cost < 0 ? 'Enter what you paid (0 or more).' : !isFinite(price) || price < 0 ? 'Enter the list or sale price.' : !isFinite(ship) || ship < 0 ? 'Shipping must be 0 or more.' : '');
    if (err) { msg.textContent = err; return; }
    const body = { item: f.item.value, platform: f.platform.value, platform_custom: f.platform_custom.value, fee_pct: fee, cost, price, shipping: ship, notes: f.notes.value, status: curStatus() };
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Saving…';
    try {
      const l = listingEdit ? await call('rd_listing_update', { p_id: listingEdit.id, p_listing: body }) : await call('rd_listing_add', { p_listing: body });
      const prev = priceRow('listing', l.id);
      if (f.drop_alert.checked || prev) await call('rd_price_watch_save', { p_kind: 'listing', p_ref: String(l.id), p_cfg: { buy_in: l.cost, alert_on: f.drop_alert.checked, label: l.item, site: platName(l), member_id: me()?.id ?? null } });
      closeSheet(); toast(listingEdit ? 'Listing updated' : 'Listing added'); await refreshExt();
    } catch (err2) { msg.className = 'msg err'; msg.textContent = err2.message; }
    btn.disabled = false;
  });
  $('#sl-delete').addEventListener('click', async () => {
    if (!listingEdit || !confirm('Delete this listing? This can’t be undone.')) return;
    try { await call('rd_listing_delete', { p_id: listingEdit.id }); if (priceRow('listing', listingEdit.id)) await call('rd_price_watch_delete', { p_kind: 'listing', p_ref: String(listingEdit.id) }); closeSheet(); toast('Listing deleted'); await refreshExt(); }
    catch (err) { $('#sl-msg').className = 'msg err'; $('#sl-msg').textContent = err.message; }
  });
  $('#listing-list').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const id = +(b.dataset.ledit || b.dataset.lsold || b.dataset.ldel), l = ext.listings.find((x) => x.id === id); if (!l) return;
    if (b.dataset.ledit) openListing(l);
    else if (b.dataset.lsold) openListing(l, true);
    else if (b.dataset.ldel && confirm('Delete this listing? This can’t be undone.')) {
      try { await call('rd_listing_delete', { p_id: id }); if (priceRow('listing', id)) await call('rd_price_watch_delete', { p_kind: 'listing', p_ref: String(id) }); toast('Listing deleted'); await refreshExt(); } catch (err) { toast(err.message); }
    }
  });

  // ---------- mark alert as sold
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const saleFor = (alertId) => ext.sales.find((s) => s.alert_id === alertId);
  const matchListing = (item) => { const n = norm(item); if (!n) return null; return ext.listings.find((l) => norm(l.item) === n) || ext.listings.find((l) => { const m = norm(l.item); return m.length > 3 && (n.includes(m) || m.includes(n)); }) || null; };
  const lastFee = (platform, custom) => {
    const all = [...ext.listings, ...ext.sales].filter((x) => x.platform === platform && (platform !== 'other' || !custom || norm(x.platform_custom) === norm(custom)));
    all.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))); return all[0] || null;
  };
  let saleCtx = null;
  function saleFee(force) {
    const f = $('#sale-form'), hint = $('#ss-feehint');
    if (saleCtx.feeTouched && !force) return;
    const L = saleCtx.listing, plat = f.platform.value;
    if (L && (!plat || L.platform === plat)) { f.fee_pct.value = pct(+L.fee_pct); hint.textContent = `From your listing “${L.item}” (${platName(L)}). You can change it.`; }
    else if (plat) { const x = lastFee(plat, f.platform_custom.value); if (x) { f.fee_pct.value = pct(+x.fee_pct); hint.textContent = `Last fee you entered for ${platName(x)}. Platforms set individual rates, so edit if this sale differs.`; }
      else { f.fee_pct.value = ''; hint.textContent = `No fee saved for ${PLATFORM[plat]} yet. Platforms set individual rates, so enter this sale’s fee %.`; } }
    else { f.fee_pct.value = ''; hint.textContent = 'Pick a platform. Platforms set individual rates, so enter this sale’s fee %.'; }
  }
  function saleCalc() { const f = $('#sale-form'); $('#ss-calc').innerHTML = calcHtml(num(f.price.value), num(f.fee_pct.value), num(f.shipping.value), num(f.cost.value)); }
  function openSale(a) {
    const s = saleFor(a.id), L = s ? null : matchListing(a.item || a.title), f = $('#sale-form'); f.reset();
    saleCtx = { alert: a, sale: s, listing: L, feeTouched: !!s };
    $('#ss-title').textContent = s ? 'Edit sale' : 'Mark as sold'; $('#ss-sub').textContent = `${a.store ? a.store + ' · ' : ''}${a.time_et || et(a.ts)}`;
    f.item.value = s ? s.item : (a.item || a.title || ''); f.price.value = s ? (+s.price).toFixed(2) : (L ? (+L.price).toFixed(2) : '');
    f.platform.value = s ? s.platform : (L ? L.platform : ''); f.platform_custom.value = s ? (s.platform_custom || '') : (L ? (L.platform_custom || '') : '');
    f.cost.value = s ? (+s.cost).toFixed(2) : (L ? (+L.cost).toFixed(2) : ''); f.shipping.value = s && +s.shipping ? (+s.shipping).toFixed(2) : (L && +L.shipping ? (+L.shipping).toFixed(2) : '');
    if (s) { f.fee_pct.value = pct(+s.fee_pct); $('#ss-feehint').textContent = 'Fee % you entered for this sale. Platforms set individual rates.'; } else saleFee(true);
    $('#ss-delete').hidden = !s; $('#ss-msg').textContent = ''; otherToggle(f); saleCalc(); sheet('#sheet-sale');
  }
  $('#sale-form').addEventListener('input', (e) => { if (e.target.name === 'fee_pct') saleCtx.feeTouched = true; if (e.target.name === 'platform_custom') saleFee(); saleCalc(); });
  $('#sale-form').platform.addEventListener('change', (e) => { otherToggle(e.target.form); saleFee(); saleCalc(); });
  $('#sale-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target, msg = $('#ss-msg'); msg.className = 'msg err';
    const fee = num(f.fee_pct.value), cost = num(f.cost.value), price = num(f.price.value), ship = f.shipping.value.trim() === '' ? 0 : num(f.shipping.value);
    const err = !f.item.value.trim() ? 'Enter the item.' : !isFinite(price) || price < 0 ? 'Enter the sale price.' : !f.platform.value ? 'Pick the platform.' : (f.platform.value === 'other' && !f.platform_custom.value.trim()) ? 'Type the platform name for Local / Other.' :
      feeErr(fee) || (!isFinite(cost) || cost < 0 ? 'Enter what you paid (0 or more).' : !isFinite(ship) || ship < 0 ? 'Shipping must be 0 or more.' : '');
    if (err) { msg.textContent = err; return; }
    try { await call('rd_sale_save', { p_sale: { alert_id: saleCtx.alert.id, item: f.item.value, platform: f.platform.value, platform_custom: f.platform_custom.value, fee_pct: fee, price, cost, shipping: ship } });
      closeSheet(); toast('Sale saved'); await refreshExt(); } catch (err2) { msg.textContent = err2.message; }
  });
  $('#ss-delete').addEventListener('click', async () => {
    if (!saleCtx?.sale || !confirm('Remove this sale? The alert stays.')) return;
    try { await call('rd_sale_delete', { p_id: saleCtx.sale.id }); closeSheet(); toast('Sale removed'); await refreshExt(); } catch (err) { $('#ss-msg').textContent = err.message; }
  });
  $('#alert-list').addEventListener('click', (e) => { const b = e.target.closest('button[data-sold]'); if (!b) return; const a = state.alerts.find((x) => x.id === b.dataset.sold); if (a) { try { need(); openSale(a); } catch (err) { toast(err.message); } } });
  const soldLine = (a) => { const s = a.id && saleFor(a.id); if (!s) return ''; const r = pnl(+s.price, +s.fee_pct, +s.shipping, +s.cost);
    return `<p class="sold-line">Sold ${money(+s.price)} on ${esc(platName(s))}, profit <span class="${cls(r.profit)}">${money(r.profit)}</span></p>`; };

  // ---------- watch items: next drop + check timing + buy-in
  const CHECK_S = { beats: 60, burgundy: 300, vans: 60, ps5: 190 };
  const checkEvery = (i) => CHECK_S[i.id] || (i.kind === 'apple' ? 60 : i.kind === 'page' ? 120 : null);
  function dropHtml(i) {
    const d = ext.drops[i.id], p = priceRow('watch', i.id);
    let s;
    if (d) { const past = new Date(d.next_drop_at) <= Date.now();
      s = `<p class="drop-line">Next drop: <b>${esc(etLong(d.next_drop_at))}</b> · <span class="cd-inline" data-tick="${esc(d.next_drop_at)}" data-past="Started">${past ? 'Started' : 'in ' + compact(new Date(d.next_drop_at) - Date.now())}</span>${d.note ? `<br><small>${esc(d.note)}</small>` : ''}</p>`; }
    else { const ev = checkEvery(i), run = i.alive && !i.paused && i.last_check;
      s = `<p class="drop-line">No announced drop${i.last_check ? ` · last checked <span data-ago="${esc(i.last_check)}">${ago(i.last_check)}</span>` : ''}${run && ev ? ` · <span data-next="${esc(i.last_check)}" data-every="${ev}"></span>` : ''}</p>`; }
    return s + (p && p.buy_in != null ? priceLine(p) : '');
  }
  // status.json times are minute-granular, so estimate the next check from the watcher's cycle (every ev seconds)
  function nextCheck(el) { const ev = +el.dataset.every, since = (Date.now() - new Date(el.dataset.next).getTime()) / 1000;
    el.textContent = since > ev * 6 ? `checks every ~${ev}s` : `next check in ~${Math.max(1, Math.round(since < ev ? ev - since : ev - (since % ev)))}s`; }
  let dropItem = null;
  function openDrop(i) {
    dropItem = i; const f = $('#drop-form'), d = ext.drops[i.id], p = priceRow('watch', i.id); f.reset();
    $('#sd-sub').textContent = i.name; f.at.value = d ? isoToEtLocal(d.next_drop_at) : ''; f.note.value = d ? (d.note || '') : '';
    f.buy_in.value = p && p.buy_in != null ? (+p.buy_in).toFixed(2) : ''; f.drop_alert.checked = !!(p && p.alert_on);
    $('#sd-price').textContent = p && p.market_value != null ? '' : 'No price source yet, so nothing is checked until one is added.';
    $('#sd-clear').hidden = !d; $('#sd-msg').textContent = ''; sheet('#sheet-drop');
  }
  $('#watch-list').addEventListener('click', (e) => { const b = e.target.closest('button[data-drop]'); if (!b) return; e.stopPropagation(); const i = (state.status?.items || []).find((x) => x.id === b.dataset.drop); if (i) { try { need(); openDrop(i); } catch (err) { toast(err.message); } } }, true);
  $('#drop-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target, msg = $('#sd-msg'); msg.className = 'msg err';
    const buy = f.buy_in.value.trim() === '' ? null : num(f.buy_in.value);
    if (buy !== null && (!isFinite(buy) || buy < 0)) { msg.textContent = 'Buy-in must be a dollar amount.'; return; }
    if (f.drop_alert.checked && buy === null) { msg.textContent = 'Enter what you paid to turn on the drop alert.'; return; }
    try {
      const d = ext.drops[dropItem.id], at = f.at.value ? etLocalToIso(f.at.value) : null;
      if (at || d) await call('rd_drop_set', { p_item_id: dropItem.id, p_at: at, p_note: f.note.value });
      const p = priceRow('watch', dropItem.id);
      if (buy !== null || p) await call('rd_price_watch_save', { p_kind: 'watch', p_ref: dropItem.id, p_cfg: { buy_in: buy, alert_on: f.drop_alert.checked, label: dropItem.name, site: (safeUrl(dropItem.link) && new URL(dropItem.link).hostname) || '', member_id: me()?.id ?? null } });
      closeSheet(); toast('Saved'); await refreshExt();
    } catch (err) { msg.textContent = err.message; }
  });
  $('#sd-clear').addEventListener('click', async () => { if (!confirm('Clear the drop time for this item?')) return;
    try { await call('rd_drop_set', { p_item_id: dropItem.id, p_at: null }); closeSheet(); toast('Drop time cleared'); await refreshExt(); } catch (err) { $('#sd-msg').textContent = err.message; } });

  // ---------- countdowns
  let cdView = 'trending', cdWho = 'me', cdEdit = null;
  const autoCds = () => Object.entries(ext.drops).map(([id, d]) => { const i = (state.status?.items || []).find((x) => x.id === id);
    return { kind: 'auto', id, title: i ? i.name : id, at: d.next_drop_at, notes: d.note, item: i }; });
  const myCds = () => ext.countdowns.filter((c) => cdWho === 'all' || (me() && c.member_id === me().id)).map((c) => ({ kind: 'custom', ...c }));
  const bySoon = (a, b) => { const now = Date.now(), pa = new Date(a.at) <= now, pb = new Date(b.at) <= now; return pa !== pb ? (pa ? 1 : -1) : pa ? new Date(b.at) - new Date(a.at) : new Date(a.at) - new Date(b.at); };
  const REM = { 0: 'At time', 15: '15 min', 60: '1 hr', 1440: '1 day' };
  function cdCard(c) {
    const past = new Date(c.at) <= Date.now(), soon = !past && new Date(c.at) - Date.now() < 86400000;
    const rem = c.kind === 'custom' && c.reminders?.length ? `<div class="rem">${c.reminders.map((r) => `<span class="${r.fired_at && r.result === 'sent' ? 'done' : ''}">🔔 ${REM[r.offset_min]}${r.fired_at ? (r.result === 'sent' ? ' ✓ sent' : ' · ' + esc((r.result || '').split(' ')[0])) : ''}</span>`).join('')}</div>` : '';
    return `<div class="card cd-card ${past ? 'past' : ''} ${soon ? 'soon' : ''}">
      <div class="row"><p class="t grow">${esc(c.title)}</p><span class="tag ${c.kind}">${c.kind === 'auto' ? 'Auto · watch' : 'Custom'}</span></div>
      <p class="cd-when">${esc(etLong(c.at))}${c.kind === 'custom' ? ' · ' + esc(memberName(c.member_id)) : ''}</p>
      ${past ? `<p class="sold-line">${c.kind === 'auto' ? 'Started' : 'Passed'} ${esc(ago(c.at))}</p>` : digits(c.at)}
      ${c.notes ? `<p class="f">${esc(c.notes)}</p>` : ''}${rem}
      <div class="actions">${c.kind === 'auto'
        ? `${c.item && safeUrl(c.item.link) ? `<a class="btn buy" href="${esc(c.item.link)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : ''}${c.item ? `<button class="btn" data-cdrop="${esc(c.id)}">Edit time</button>` : ''}${past ? `<button class="btn ghost danger" data-cclear="${esc(c.id)}">Clear</button>` : ''}`
        : `<button class="btn" data-cedit="${c.id}">Edit</button><button class="btn ghost danger" data-cdel="${c.id}">${past ? 'Clear' : 'Delete'}</button>`}</div>
    </div>`;
  }
  function renderCountdowns() {
    const auto = autoCds().sort(bySoon), mine = myCds().sort(bySoon);
    $('#cd-trending').innerHTML = auto.map(cdCard).join('') || '<p class="empty">No announced drops yet. When a watched item gets a real drop time (Watches → Drop time), it shows up here.</p>';
    $('#cd-list').innerHTML = mine.map(cdCard).join('') || `<p class="empty">${me() ? 'No countdowns yet. Tap + New countdown.' : 'Pick who you are in Settings first.'}</p>`;
    renderHero();
  }
  function nextUp() { const now = Date.now(); const all = [...autoCds(), ...ext.countdowns.filter((c) => me() && c.member_id === me().id).map((c) => ({ kind: 'custom', ...c }))].filter((c) => new Date(c.at) > now).sort(bySoon); return all[0] || null; }
  function renderHero() {
    const n = nextUp();
    $('#cd-hero-txt').innerHTML = n ? `<p class="k">Next up · ${n.kind === 'auto' ? 'Auto' : 'Custom'}</p><p class="h">${esc(n.title)}</p><p class="n" data-tick="${esc(n.at)}" data-past="Now">${compact(new Date(n.at) - Date.now())}</p><p class="w">${esc(etLong(n.at))}</p>`
      : '<p class="k">Countdowns</p><p class="h">Nothing scheduled</p><p class="w">Announced drops and your own reminders show here.</p>';
    const ent = $('#cd-entry');
    ent.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6M12 2v3"/></svg>
      <span class="grow"><span class="t" style="display:block">Countdowns</span><span class="d" style="display:block">${n ? `${esc(n.title)} · <span class="cd-inline" data-tick="${esc(n.at)}" data-past="Now">${compact(new Date(n.at) - Date.now())}</span>` : 'Announced drops and your reminders'}</span></span><span class="chev">›</span>`;
  }
  $('#cd-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; cdView = b.dataset.v; document.querySelectorAll('#cd-seg button').forEach((x) => x.classList.toggle('on', x === b)); $('#cd-trending').hidden = cdView !== 'trending'; $('#cd-mine').hidden = cdView !== 'mine'; });
  $('#cd-who').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; cdWho = b.dataset.w; document.querySelectorAll('#cd-who button').forEach((x) => x.classList.toggle('on', x === b)); renderCountdowns(); });
  function openCd(c) {
    cdEdit = c || null; const f = $('#cd-form'); f.reset(); const m = c ? ext.members.find((x) => x.id === c.member_id) : me();
    $('#sc-title').textContent = c ? 'Edit countdown' : 'New countdown'; f.title.value = c ? c.title : ''; f.at.value = c ? isoToEtLocal(c.at) : ''; f.notes.value = c ? (c.notes || '') : '';
    const on = c ? c.reminders.map((r) => r.offset_min) : [0];
    document.querySelectorAll('#sc-rem button').forEach((b) => b.classList.toggle('on', on.includes(+b.dataset.m)));
    $('#sc-who').innerHTML = m ? (m.ntfy_topic ? `Reminders go to ${esc(m.name)}’s ntfy topic (${esc(m.ntfy_topic)}). Times are ET.` : `<span class="neg">${esc(m.name)} has no ntfy topic yet. Add one in Settings to get reminders.</span>`) : '<span class="neg">Pick who you are in Settings first.</span>';
    $('#sc-delete').hidden = !c; $('#sc-msg').textContent = ''; sheet('#sheet-cd');
  }
  $('#sc-rem').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) b.classList.toggle('on'); });
  $('#cd-new').addEventListener('click', () => { try { need(); openCd(null); } catch (err) { toast(err.message); } });
  $('#cd-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target, msg = $('#sc-msg'); msg.className = 'msg err';
    const at = etLocalToIso(f.at.value);
    if (!f.title.value.trim()) { msg.textContent = 'Enter a title.'; return; }
    if (!at) { msg.textContent = 'Pick a date and time (ET).'; return; }
    const owner = cdEdit ? cdEdit.member_id : me()?.id;
    try { await call('rd_countdown_save', { p_id: cdEdit ? cdEdit.id : null, p_cd: { title: f.title.value, at, notes: f.notes.value, member_id: owner ?? null,
        reminders: [...document.querySelectorAll('#sc-rem button.on')].map((b) => +b.dataset.m) } });
      closeSheet(); toast('Countdown saved'); await refreshExt(); } catch (err) { msg.textContent = err.message; }
  });
  const delCd = async (id) => { try { await call('rd_countdown_delete', { p_id: id }); toast('Removed'); closeSheet(); await refreshExt(); } catch (err) { toast(err.message); } };
  $('#sc-delete').addEventListener('click', () => { if (cdEdit && confirm('Delete this countdown and its reminders?')) delCd(cdEdit.id); });
  document.querySelector('#tab-countdowns').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.cedit) openCd(ext.countdowns.find((c) => c.id === +b.dataset.cedit));
    else if (b.dataset.cdel && confirm('Remove this countdown?')) delCd(+b.dataset.cdel);
    else if (b.dataset.cdrop) { const i = (state.status?.items || []).find((x) => x.id === b.dataset.cdrop); if (i) openDrop(i); }
    else if (b.dataset.cclear && confirm('Clear this drop time?')) { try { await call('rd_drop_set', { p_item_id: b.dataset.cclear, p_at: null }); toast('Cleared'); await refreshExt(); } catch (err) { toast(err.message); } }
  });
  $('#cd-open').addEventListener('click', () => show('countdowns'));
  $('#cd-entry').addEventListener('click', () => show('countdowns'));

  // ---------- live ticking (1s)
  function tick() {
    const now = Date.now();
    document.querySelectorAll('[data-tick]').forEach((el) => { const ms = new Date(el.dataset.tick) - now; el.textContent = ms > 0 ? (el.classList.contains('n') ? '' : el.closest('.drop-line') ? 'in ' : '') + compact(ms) : el.dataset.past; });
    document.querySelectorAll('[data-digits]').forEach((el) => { const t = split(new Date(el.dataset.digits) - now); const b = el.querySelectorAll('b'); b[0].textContent = t.d; b[1].textContent = pad(t.h); b[2].textContent = pad(t.m); b[3].textContent = pad(t.s);
      if (new Date(el.dataset.digits) <= now && !el.dataset.done) { el.dataset.done = 1; renderCountdowns(); } });
    document.querySelectorAll('[data-ago]').forEach((el) => (el.textContent = ago(el.dataset.ago)));
    document.querySelectorAll('[data-next]').forEach(nextCheck);
  }
  setInterval(() => { if (document.visibilityState === 'visible') tick(); }, 1000);
  function renderV2() { if (state.tab === 'ask' && !askBusy) renderAsk(); renderMembers(); renderListings(); renderTracker(); renderCountdowns(); renderWatches(); renderAlerts(); tick(); }

  // ================= Ask Risky (questions queued in Supabase, answered by the box worker with Gemini + Google Search) =================
  let askHist = [], askOpen = null, askBusy = false, askCoords = null;
  // tiny safe markdown: escape everything first, then allow headings, bold/italic, lists, tables, code, http(s) links
  function md(src) {
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u.replace(/"/g, '%22')}" target="_blank" rel="noopener noreferrer">${t}</a>`)
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, u) => `${pre}<a href="${u.replace(/"/g, '%22')}" target="_blank" rel="noopener noreferrer">${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
    const lines = String(src || '').replace(/\r/g, '').split('\n'); let out = '', list = null, para = [];
    const flushP = () => { if (para.length) { out += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
    const flushL = () => { if (list) { out += `</${list}>`; list = null; } };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], t = l.trim(); let m;
      if (!t) { flushP(); flushL(); continue; }
      if ((m = /^#{1,6}\s+(.*)$/.exec(t))) { flushP(); flushL(); out += `<h3>${inline(m[1])}</h3>`; continue; }
      if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())) {
        flushP(); flushL(); const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        let tb = `<table><tr>${cells(t).map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`; i += 2;
        while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { tb += `<tr>${cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`; i++; }
        out += tb + '</table>'; i--; continue;
      }
      if ((m = /^[-*•]\s+(.*)$/.exec(t))) { flushP(); if (list !== 'ul') { flushL(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; continue; }
      if ((m = /^\d+[.)]\s+(.*)$/.exec(t))) { flushP(); if (list !== 'ol') { flushL(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; continue; }
      flushL(); para.push(t);
    }
    flushP(); flushL(); return out;
  }
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  function answerCard(q) {
    if (!q) return '';
    const head = `<div class="row"><p class="t grow">${esc(q.question)}</p></div><p class="f">${esc(q.member || '')}${q.location ? ' · ' + esc(q.location) : ''} · ${esc(et(q.created_at))}${q.model ? ' · ' + esc(q.model) : ''}</p>`;
    if (q.status === 'pending' || q.status === 'running') {
      const old = Date.now() - new Date(q.created_at) > 45000;
      return `<div class="card">${head}<div class="ask-loading" style="margin-top:12px"><div class="ask-orbit busy">${$('#ask-orbit').innerHTML}</div>
        <p class="d">${q.status === 'pending' ? (old ? 'Waiting for the box to pick this up. Is it online?' : 'Sending to Risky…') : 'Researching live sources…'}</p></div></div>`;
    }
    if (q.status === 'error') return `<div class="card">${head}<p class="msg err">${esc(q.error || 'Something went wrong. Try again.')}</p><div class="actions"><button class="btn" data-qretry="${q.id}">Ask again</button><button class="btn ghost danger" data-qdel="${q.id}">Delete</button></div></div>`;
    const src = (q.sources || []).filter((s) => safeUrl(s.url));
    const rendered = q.search && q.search.rendered ? `<iframe class="gsearch" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" title="Google Search suggestions" srcdoc="${esc('<base target="_blank">' + q.search.rendered)}"></iframe>` : '';
    return `<div class="card">${head}<div class="md" style="margin-top:10px">${md(q.answer)}</div>
      ${src.length ? `<div class="sources">${src.map((s, i) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"><b>${i + 1}</b><span>${esc(s.title || host(s.url))}</span></a>`).join('')}</div>` : '<p class="f">No web sources were returned for this answer.</p>'}
      ${rendered}${q.notified ? `<p class="f">Phone summary: ${esc(q.notified)}</p>` : ''}
      <div class="actions"><button class="btn ghost danger" data-qdel="${q.id}">Delete</button></div></div>`;
  }
  function renderAsk() {
    const m = me(); $('#ask-who').textContent = m ? `Asking as ${m.name}` : 'Pick who you are in Settings';
    $('#ask-answer').innerHTML = askOpen ? answerCard(askHist.find((q) => q.id === askOpen) || null) : '';
    $('#ask-history').innerHTML = askHist.filter((q) => q.id !== askOpen).map((q) => `<button class="card qrow" data-qopen="${q.id}"><p class="t">${esc(q.question)}</p>
      <p class="f">${esc(q.member || '')} · ${esc(et(q.created_at))} · ${q.status === 'done' ? `${(q.sources || []).length} sources` : q.status === 'error' ? '<span class="neg">failed</span>' : 'answering…'}</p></button>`).join('') || '<p class="empty">No questions yet.</p>';
    $('#ask-orbit').classList.toggle('busy', askBusy);
  }
  async function loadAsk() { if (!CFG || !KEY) return; askHist = await rpc('rd_questions', { p_key: KEY }); renderAsk(); }
  async function waitAnswer(id) {
    askBusy = true; renderAsk();
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, i < 5 ? 1500 : 2500));
      const q = await rpc('rd_question_get', { p_key: KEY, p_id: id }).catch(() => null);
      if (q) { const k = askHist.findIndex((x) => x.id === id); if (k >= 0) askHist[k] = q; else askHist.unshift(q); renderAsk(); if (q.status === 'done' || q.status === 'error') break; }
    }
    askBusy = false; renderAsk();
  }
  async function ask(text) {
    if (askBusy) return; const msg = text.trim(); if (!msg) { toast('Type a question first'); return; }
    let loc = '';
    if ($('#ask-loc').checked) { if (!askCoords) await getLoc(); if (askCoords) loc = askCoords; }
    try { need(); const q = await rpc('rd_ask', { p_key: KEY, p_member_id: me()?.id ?? null, p_question: msg, p_location: loc, p_notify: $('#ask-notify').checked });
      askHist.unshift(q); askOpen = q.id; $('#ask-q').value = ''; $('#ask-count').textContent = '0'; window.scrollTo(0, 0); await waitAnswer(q.id);
    } catch (err) { toast(err.message); }
  }
  function getLoc() {
    return new Promise((res) => {
      if (!navigator.geolocation) { $('#ask-loc-txt').textContent = 'not supported'; return res(); }
      $('#ask-loc-txt').textContent = 'locating…';
      navigator.geolocation.getCurrentPosition((p) => { askCoords = `near ${p.coords.latitude.toFixed(3)}, ${p.coords.longitude.toFixed(3)} (±${Math.round(p.coords.accuracy)} m)`; $('#ask-loc-txt').textContent = askCoords; res(); },
        () => { $('#ask-loc-txt').textContent = 'location blocked; using Sayreville NJ'; $('#ask-loc').checked = false; res(); }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
    });
  }
  $('#ask-loc').addEventListener('change', (e) => { if (e.target.checked && !askCoords) getLoc(); });
  $('#ask-q').addEventListener('input', (e) => ($('#ask-count').textContent = e.target.value.length));
  $('#ask-form').addEventListener('submit', (e) => { e.preventDefault(); ask($('#ask-q').value); });
  $('#ask-chips').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; const t = $('#ask-q'); t.value = b.dataset.q; t.focus(); const i = t.value.indexOf('['); if (i >= 0) t.setSelectionRange(i, t.value.indexOf(']', i) + 1); $('#ask-count').textContent = t.value.length; });
  document.querySelector('#tab-ask').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-qopen],[data-qdel],[data-qretry]'); if (!b) return;
    if (b.dataset.qopen) { askOpen = +b.dataset.qopen; renderAsk(); window.scrollTo(0, 0); }
    else if (b.dataset.qretry) { const q = askHist.find((x) => x.id === +b.dataset.qretry); if (q) { $('#ask-q').value = q.question; ask(q.question); } }
    else if (b.dataset.qdel && confirm('Delete this question and answer?')) {
      try { await rpc('rd_question_delete', { p_key: KEY, p_id: +b.dataset.qdel }); askHist = askHist.filter((x) => x.id !== +b.dataset.qdel); if (askOpen === +b.dataset.qdel) askOpen = null; renderAsk(); toast('Deleted'); } catch (err) { toast(err.message); }
    }
  });
  // dictation (Web Speech API where available; iOS Safari users can use the keyboard mic)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; let rec = null;
  if (!SR) { $('#ask-mic').hidden = true; $('#ask-mic-hint').textContent = 'Tip: use your keyboard’s dictation mic to speak your question.'; }
  $('#ask-mic').addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
    const base = $('#ask-q').value ? $('#ask-q').value.trim() + ' ' : '';
    rec.onresult = (ev) => { let t = ''; for (const r of ev.results) t += r[0].transcript; $('#ask-q').value = (base + t).slice(0, 1000); $('#ask-count').textContent = $('#ask-q').value.length; };
    rec.onerror = (ev) => toast(ev.error === 'not-allowed' ? 'Microphone blocked. Use the keyboard mic instead.' : 'Dictation stopped: ' + ev.error);
    rec.onend = () => { rec = null; $('#ask-mic').classList.remove('rec'); };
    try { rec.start(); $('#ask-mic').classList.add('rec'); } catch (e) { rec = null; }
  });
  $('#ask-open').addEventListener('click', () => { show('ask'); loadAsk().catch((e) => toast(e.message)); setTimeout(() => $('#ask-q').focus({ preventScroll: true }), 50); });

  // ---------- data
  async function load() {
    try {
      const [s, a] = await Promise.all([api('/api/status'), api('/api/alerts'), loadExt().catch((e) => { if (/Access key/.test(e.message)) throw e; toast('Could not load listings: ' + e.message); })]);
      state.status = s; state.alerts = a.alerts || [];
      if (!state.flip) state.flip = await api('/api/flip');
      if (!localStorage.getItem('rd-seen')) localStorage.setItem('rd-seen', new Date().toISOString());
      renderFlip(); renderBadge(); calc(); renderV2();
    } catch (err) {
      if (/Access key/.test(err.message)) {
        document.querySelector('main').innerHTML = '<div class="card" style="margin-top:30px;text-align:center"><p class="t">Access key required</p><p class="d">Open the full Risky Drops link with ?key=… once. This device remembers it.</p></div>';
        document.querySelector('.tabbar').hidden = true;
      } else toast('Could not load: ' + err.message);
    }
    $('#boot').classList.add('gone');
  }
  const h = location.hash.slice(1); if (['watches', 'alerts', 'listings', 'countdowns', 'flip', 'settings', 'ask'].includes(h)) { show(h); if (h === 'ask') loadAsk().catch(() => {}); }
  load();
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
})();

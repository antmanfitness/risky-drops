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
  let state = { status: null, alerts: [], flip: null, filter: 'all', tab: 'home', wsub: 'list', ssub: 'listings' };

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
  // Tabs: Home / Watches (list | alerts | countdowns) / Phones / Sales (listings | sold | comps). Settings = header gear, Ask = floating orb.
  const LEGACY = { alerts: ['watches', 'alerts'], countdowns: ['watches', 'countdowns'], listings: ['sales', 'listings'], flip: ['sales', 'comps'] };
  function show(tab, sub) {
    if (LEGACY[tab]) [tab, sub] = LEGACY[tab];
    state.tab = tab;
    document.querySelectorAll('.screen').forEach((s) => (s.hidden = s.id !== 'tab-' + tab));
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $('#gear').classList.toggle('on', tab === 'settings');
    $('#ask-open').hidden = tab === 'ask';
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + '#' + tab);
    if (sub && tab === 'watches') showSub('w', sub);
    if (sub && tab === 'sales') showSub('s', sub);
    if (tab === 'phones' || tab === 'home') loadPhones().catch(() => {});
    if (typeof closeSheet === 'function') closeSheet();
    if (tab === 'watches' && state.wsub === 'alerts') { localStorage.setItem('rd-seen', new Date().toISOString()); renderBadge(); }
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  $('#gear').addEventListener('click', () => show('settings'));
  const SUBS = { w: ['list', 'alerts', 'countdowns'], s: ['listings', 'sold', 'comps'] };
  function showSub(g, v) {
    if (!SUBS[g].includes(v)) return; state[g + 'sub'] = v;
    document.querySelectorAll(`#${g}-seg button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    SUBS[g].forEach((x) => ($(`#${g}-${x}`).hidden = x !== v));
    if (g === 'w' && v === 'alerts') { localStorage.setItem('rd-seen', new Date().toISOString()); renderBadge(); }
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + '#' + (g === 'w' ? 'watches' : 'sales') + '/' + v);
  }
  $('#w-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showSub('w', b.dataset.v); });
  $('#s-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showSub('s', b.dataset.v); });

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
    $('#badge').textContent = n ? String(n) : ''; $('#tab-badge').textContent = n ? String(n) : '';
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
        <div class="actions">${link ? `<a class="btn buy" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Buy ↗</a>` : ''}${CFG && a.id && a.kind !== 'test' ? `<button class="btn" data-sold="${esc(a.id)}">${saleFor(a.id) || listingFor(a.id) ? 'Edit sale' : 'Mark as sold'}</button>` : ''}</div>
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
  $('#fee').addEventListener('input', renderFlip);

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
  const memberName = (id) => (ext.members.find((m) => m.id === id) || {}).name || 'No collector';
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
  let listingEdit = null, trackerPeriod = 'all';
  function renderListings() {
    const rows = ext.listings.filter((l) => l.status === 'active');
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
    }).join('') || `<p class="empty">${ext.listings.length ? 'No active listings. Sold ones are under Sold.' : 'No listings yet. Tap + New listing.'}</p>`;
    renderSold();
  }
  // Sold history: sold listings + alerts marked sold, each shown once (a listing linked to an alert is one record)
  function renderSold() {
    const rows = [...ext.listings.filter((l) => l.status === 'sold').map((l) => ({ kind: 'listing', r: l, when: l.sold_at || l.updated_at })),
      ...ext.sales.map((x) => ({ kind: 'sale', r: x, when: x.sold_at }))].sort((a, b) => String(b.when).localeCompare(String(a.when)));
    $('#sold-list').innerHTML = rows.map(({ kind, r, when }) => { const m = pnl(+r.price, +r.fee_pct, +r.shipping, +r.cost);
      return `<div class="card"><div class="row"><p class="t grow">${esc(r.item)}</p><span class="pill sold">${kind === 'sale' || r.alert_id ? 'From alert' : 'Listing'}</span></div>
        <p class="d">${esc(platName(r))} · fee ${esc(pct(+r.fee_pct))}% · sold ${esc(et(when))}</p>
        <div class="mgrid"><div><small>Sale</small><b>${money(+r.price)}</b></div><div><small>Fees + ship</small><b>−${money(r2(m.fee + +r.shipping))}</b></div><div class="big"><small>Profit</small><b class="${cls(m.profit)}">${money(m.profit)}</b></div></div>
        <div class="actions"><button class="btn" data-sedit="${kind}:${kind === 'sale' ? r.alert_id || '' : r.id}">Edit</button></div></div>`; }).join('') || '<p class="empty">No sales yet. Mark a listing sold, or tap “Mark as sold” on an alert.</p>';
  }
  $('#sold-list').addEventListener('click', (e) => { const b = e.target.closest('[data-sedit]'); if (!b) return; const [k, id] = b.dataset.sedit.split(':');
    if (k === 'listing') openListing(ext.listings.find((l) => l.id === +id));
    else { const s = ext.sales.find((x) => x.alert_id === id); const a = state.alerts.find((x) => x.id === id) || { id, item: s?.item, ts: s?.sold_at }; openSale(a); } });
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
  const listingFor = (alertId) => ext.listings.find((l) => l.alert_id === alertId);
  const matchListing = (item) => { const n = norm(item); if (!n) return null; const pool = ext.listings.filter((l) => l.status === 'active' && !l.alert_id);
    return pool.find((l) => norm(l.item) === n) || pool.find((l) => { const m = norm(l.item); return m.length > 3 && (n.includes(m) || m.includes(n)); }) || null; };
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
  const saleCost = () => { const f = $('#sale-form'); return saleCtx?.listing && f.use_listing.checked ? +saleCtx.listing.cost : num(f.cost.value); };
  function saleCalc() { const f = $('#sale-form'); $('#ss-calc').innerHTML = calcHtml(num(f.price.value), num(f.fee_pct.value), num(f.shipping.value), saleCost()); }
  const linkToggle = () => { const f = $('#sale-form'), on = !!(saleCtx.listing && f.use_listing.checked); $('#ss-cost-wrap').hidden = on; saleCalc(); };
  function openSale(a) {
    const linked = listingFor(a.id); if (linked) { openListing(linked); return; }   // already one record: edit the listing itself
    const s = saleFor(a.id), L = s ? null : matchListing(a.item || a.title), f = $('#sale-form'); f.reset();
    saleCtx = { alert: a, sale: s, listing: L, feeTouched: !!s };
    $('#ss-title').textContent = s ? 'Edit sale' : 'Mark as sold'; $('#ss-sub').textContent = `${a.store ? a.store + ' · ' : ''}${a.time_et || et(a.ts)}`;
    f.item.value = s ? s.item : (a.item || a.title || ''); f.price.value = s ? (+s.price).toFixed(2) : (L ? (+L.price).toFixed(2) : '');
    f.platform.value = s ? s.platform : (L ? L.platform : ''); f.platform_custom.value = s ? (s.platform_custom || '') : (L ? (L.platform_custom || '') : '');
    f.cost.value = s ? (+s.cost).toFixed(2) : (L ? (+L.cost).toFixed(2) : ''); f.shipping.value = s && +s.shipping ? (+s.shipping).toFixed(2) : (L && +L.shipping ? (+L.shipping).toFixed(2) : '');
    if (s) { f.fee_pct.value = pct(+s.fee_pct); $('#ss-feehint').textContent = 'Fee % you entered for this sale. Platforms set individual rates.'; } else saleFee(true);
    $('#ss-link-wrap').hidden = !L; if (L) { f.use_listing.checked = true; $('#ss-link-txt').textContent = `Sell my listing “${L.item}” (cost ${money(+L.cost)} stays on that listing)`; }
    $('#ss-delete').hidden = !s; $('#ss-msg').textContent = ''; otherToggle(f); linkToggle(); sheet('#sheet-sale');
  }
  $('#sale-form').addEventListener('input', (e) => { if (e.target.name === 'fee_pct') saleCtx.feeTouched = true; if (e.target.name === 'platform_custom') saleFee(); if (e.target.name === 'use_listing') linkToggle(); saleCalc(); });
  $('#sale-form').platform.addEventListener('change', (e) => { otherToggle(e.target.form); saleFee(); saleCalc(); });
  $('#sale-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target, msg = $('#ss-msg'); msg.className = 'msg err';
    const fee = num(f.fee_pct.value), cost = saleCost(), price = num(f.price.value), ship = f.shipping.value.trim() === '' ? 0 : num(f.shipping.value);
    const err = !f.item.value.trim() ? 'Enter the item.' : !isFinite(price) || price < 0 ? 'Enter the sale price.' : !f.platform.value ? 'Pick the platform.' : (f.platform.value === 'other' && !f.platform_custom.value.trim()) ? 'Type the platform name for Local / Other.' :
      feeErr(fee) || (!isFinite(cost) || cost < 0 ? 'Enter what you paid (0 or more).' : !isFinite(ship) || ship < 0 ? 'Shipping must be 0 or more.' : '');
    if (err) { msg.textContent = err; return; }
    try {
      const L = saleCtx.listing && f.use_listing.checked ? saleCtx.listing : null;
      if (L) { await call('rd_listing_update', { p_id: L.id, p_listing: { item: L.item, platform: f.platform.value, platform_custom: f.platform_custom.value, fee_pct: fee, cost: +L.cost, price, shipping: ship, notes: L.notes, status: 'sold' } });
        await call('rd_listing_link_alert', { p_id: L.id, p_alert_id: saleCtx.alert.id }); }
      else await call('rd_sale_save', { p_sale: { alert_id: saleCtx.alert.id, item: f.item.value, platform: f.platform.value, platform_custom: f.platform_custom.value, fee_pct: fee, price, cost, shipping: ship } });
      closeSheet(); toast('Sale saved'); await refreshExt(); } catch (err2) { msg.textContent = err2.message; }
  });
  $('#ss-delete').addEventListener('click', async () => {
    if (!saleCtx?.sale || !confirm('Remove this sale? The alert stays.')) return;
    try { await call('rd_sale_delete', { p_id: saleCtx.sale.id }); closeSheet(); toast('Sale removed'); await refreshExt(); } catch (err) { $('#ss-msg').textContent = err.message; }
  });
  $('#alert-list').addEventListener('click', (e) => { const b = e.target.closest('button[data-sold]'); if (!b) return; const a = state.alerts.find((x) => x.id === b.dataset.sold); if (a) { try { need(); openSale(a); } catch (err) { toast(err.message); } } });
  const soldLine = (a) => { const s = a.id && (saleFor(a.id) || listingFor(a.id)); if (!s) return ''; const r = pnl(+s.price, +s.fee_pct, +s.shipping, +s.cost);
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
  document.querySelector('#w-countdowns').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.cedit) openCd(ext.countdowns.find((c) => c.id === +b.dataset.cedit));
    else if (b.dataset.cdel && confirm('Remove this countdown?')) delCd(+b.dataset.cdel);
    else if (b.dataset.cdrop) { const i = (state.status?.items || []).find((x) => x.id === b.dataset.cdrop); if (i) openDrop(i); }
    else if (b.dataset.cclear && confirm('Clear this drop time?')) { try { await call('rd_drop_set', { p_item_id: b.dataset.cclear, p_at: null }); toast('Cleared'); await refreshExt(); } catch (err) { toast(err.message); } }
  });

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
  function renderV2() { if (state.tab === 'ask' && !askBusy) renderAsk(); renderMembers(); renderDash(); renderListings(); renderTracker(); renderCountdowns(); renderWatches(); renderAlerts(); tick(); }

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

  // ================= Phones: box scanner, phone log, collectors & payouts, part lookup =================
  const ph = { phones: [], parts: [], dupes: [], loaded: false, filter: null, q: '' };
  async function loadPhones() { if (!CFG || !KEY) return; const d = await rpc('rd_phones', { p_key: KEY }); Object.assign(ph, d, { loaded: true }); renderPhones(); renderDash(); }
  const C = window.RDClassify;
  const maskSerial = (s) => s ? s.slice(0, 3) + '•••' + s.slice(-2) : '';
  const phoneName = (p) => [p.model, p.color, p.storage].filter(Boolean).join(' · ') || (p.part_number ? p.part_number : 'Unknown model');
  const hwMismatch = (p) => p.handwritten_serial && p.serial && p.handwritten_serial.replace(/[^A-Z0-9]/gi, '').toUpperCase() !== p.serial;
  const partOf = (pn) => ph.parts.find((x) => x.part_number === String(pn || '').toUpperCase());
  function collectors() {
    const m = new Map();
    for (const p of ph.phones) { if (p.status !== 'logged') continue; const k = p.member_id ?? 0; const c = m.get(k) || { id: p.member_id, name: p.member || 'No collector', n: 0, owed: 0 }; c.n++; c.owed = r2(c.owed + +p.price_paid); m.set(k, c); }
    return [...m.values()].sort((a, b) => b.owed - a.owed);
  }
  function renderPhones() {
    const cs = collectors(), total = r2(cs.reduce((a, c) => a + c.owed, 0));
    $('#collectors').innerHTML = cs.length ? `<div class="stats" style="margin-top:0"><div class="wide"><small>Owed back to collectors · ${cs.reduce((a, c) => a + c.n, 0)} phones</small><b>${money(total)}</b></div></div>
      <div class="coll-list">${cs.map((c) => `<button class="coll ${ph.filter === c.id ? 'on' : ''}" data-coll="${c.id ?? ''}"><span class="grow"><b>${esc(c.name)}</b><small>${c.n} phone${c.n === 1 ? '' : 's'}</small></span><b>${money(c.owed)}</b></button>`).join('')}</div>
      <p class="f">Owed = sum of price paid on each collector’s logged phones (their money back). Profit split comes later.</p>` : '<p class="d">No phones logged yet. Tap Scan box.</p>';
    $('#ph-filter-clear').hidden = ph.filter === null;
    const q = ph.q.trim().toUpperCase();
    const rows = ph.phones.filter((p) => (ph.filter === null || p.member_id === ph.filter) && (!q || [p.serial, p.imei1, p.imei2, p.model, p.color, p.storage, p.part_number, p.member, p.sku].some((x) => String(x || '').toUpperCase().includes(q))));
    $('#phone-list').innerHTML = rows.map((p) => `<button class="card qrow" data-phone="${p.id}">
      <div class="row"><p class="t grow">${esc(phoneName(p))}</p><b>${money(+p.price_paid)}</b></div>
      <p class="d">S/N ${esc(p.serial)}${p.imei1 ? ' · IMEI ' + esc(p.imei1) : ''}${p.imei2 ? ' / ' + esc(p.imei2) : ''}</p>
      <p class="f">${esc(p.member || 'No collector')} · ${esc(et(p.created_at))}${p.part_number ? ' · ' + esc(p.part_number) : ''}${p.status === 'returned' ? ' · returned' : ''}${p.has_photo ? ' · 📷' : ''}</p>
      ${hwMismatch(p) ? `<p class="flag">Handwritten serial “${esc(p.handwritten_serial)}” doesn’t match the scanned serial</p>` : ''}</button>`).join('') || `<p class="empty">${ph.phones.length ? 'No matches.' : 'Nothing logged yet.'}</p>`;
    $('#parts-count').textContent = ph.parts.length;
    $('#parts-list').innerHTML = ph.parts.map((x) => `<div class="prow"><span class="grow"><b>${esc(x.part_number)}</b> ${esc([x.model, x.color, x.storage].filter(Boolean).join(' · '))}<br><small>${esc(x.source || '')}</small></span><button class="btn ghost danger" data-pdel="${esc(x.part_number)}" aria-label="Remove ${esc(x.part_number)}">✕</button></div>`).join('');
    const uniq = (k) => [...new Set([...ph.parts.map((x) => x[k]), ...ph.phones.map((x) => x[k])].filter(Boolean))].sort();
    $('#dl-model').innerHTML = uniq('model').map((v) => `<option value="${esc(v)}">`).join('');
    $('#dl-color').innerHTML = uniq('color').map((v) => `<option value="${esc(v)}">`).join('');
    $('#dl-storage').innerHTML = [...new Set([...uniq('storage'), '128GB', '256GB', '512GB', '1TB', '2TB'])].map((v) => `<option value="${esc(v)}">`).join('');
  }
  $('#collectors').addEventListener('click', (e) => { const b = e.target.closest('[data-coll]'); if (!b) return; const id = b.dataset.coll === '' ? null : +b.dataset.coll; ph.filter = ph.filter === id ? null : id; renderPhones(); });
  $('#ph-filter-clear').addEventListener('click', () => { ph.filter = null; renderPhones(); });
  $('#ph-search').addEventListener('input', (e) => { ph.q = e.target.value; renderPhones(); });
  $('#phone-list').addEventListener('click', (e) => { const b = e.target.closest('[data-phone]'); if (b) openPhone(ph.phones.find((p) => p.id === +b.dataset.phone)); });
  $('#parts-list').addEventListener('click', async (e) => { const b = e.target.closest('[data-pdel]'); if (!b || !confirm(`Remove ${b.dataset.pdel} from the lookup?`)) return;
    try { await call('rd_part_delete', { p_part: b.dataset.pdel }); await loadPhones(); toast('Removed'); } catch (err) { toast(err.message); } });

  // ---------- scanner UI (guided: serial -> IMEI(s) -> part number, any order)
  let cap = null, stopLive = null, torchFn = null, torchOn = false;
  const STEPS = [['serial', 'Serial'], ['imei1', 'IMEI'], ['imei2', 'IMEI 2'], ['part_number', 'Part no.'], ['upc', 'UPC']];
  function renderCap(last) {
    $('#scan-check').innerHTML = STEPS.map(([k, l]) => `<span class="${cap[k] ? 'ok' : ''}">${cap[k] ? '✓' : '○'} ${l}${cap[k] ? `<small>${esc(k === 'serial' ? cap[k] : cap[k].slice(-6))}</small>` : ''}</span>`).join('');
    const next = !cap.serial ? 'Serial No. (S) barcode' : !cap.imei1 ? 'IMEI barcode' : !cap.part_number ? 'Part No. (P) barcode' : null;
    $('#scan-msg').textContent = next ? `Next: aim the line at the ${next}` : 'Got the essentials. Scan IMEI 2 if there is one, then Review & save.';
    if (last) $('#scan-last').textContent = last;
  }
  function addCode(raw, from) {
    const c = C.classify(raw); let msg;
    if (c.type === 'imei') { if (cap.imei1 === c.value || cap.imei2 === c.value) return false; if (!cap.imei1) cap.imei1 = c.value; else if (!cap.imei2) cap.imei2 = c.value; else return false; msg = `IMEI ${c.value}`; }
    else if (c.type === 'serial') { if (cap.serial === c.value) return false; msg = `${cap.serial ? 'Serial replaced: ' : 'Serial '}${c.value}`; cap.serial = c.value; }
    else if (c.type === 'part') { if (cap.part_number === c.value) return false; cap.part_number = c.value; const k = partOf(c.value); msg = `Part ${c.value}${k ? ' = ' + [k.model, k.color, k.storage].filter(Boolean).join(' ') : ' (not in lookup yet)'}`; }
    else if (c.type === 'upc') { if (cap.upc === c.value) return false; cap.upc = c.value; msg = `UPC ${c.value}`; }
    else { $('#scan-last').textContent = `Ignored ${from || 'code'} “${String(raw).slice(0, 34)}”${c.note ? ': ' + c.note : ''}`; return false; }
    navigator.vibrate?.(60); renderCap(`✓ ${msg}`); return true;
  }
  function openScanner() {
    try { need(); } catch (err) { toast(err.message); return; }
    cap = { serial: '', imei1: '', imei2: '', part_number: '', upc: '' }; renderCap(''); $('#scan-last').textContent = '';
    $('#scan-ui').hidden = false; document.body.style.overflow = 'hidden'; $('#scan-view').hidden = false; $('#scan-torch').hidden = true; torchOn = false;
    $('#scan-msg').textContent = 'Starting camera…';
    stopLive = RDScanner.startLive({ video: $('#scan-video'), onCode: (v) => addCode(v, 'barcode'),
      onTorch: (fn) => { torchFn = fn; $('#scan-torch').hidden = false; },
      onStatus: (st, m) => { if (st === 'scanning') renderCap(); else { $('#scan-view').hidden = true; $('#scan-msg').textContent = m; } } });
  }
  function closeScanner() { stopLive?.(); stopLive = null; torchFn = null; $('#scan-ui').hidden = true; document.body.style.overflow = ''; }
  $('#scan-open').addEventListener('click', openScanner);
  $('#scan-cancel').addEventListener('click', () => { if (!Object.values(cap).some(Boolean) || confirm('Discard what you scanned?')) closeScanner(); });
  $('#scan-torch').addEventListener('click', async () => { if (torchFn && await torchFn(!torchOn)) { torchOn = !torchOn; $('#scan-torch').textContent = torchOn ? 'Light off' : 'Light on'; } else $('#scan-torch').hidden = true; });
  $('#scan-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return; $('#scan-last').textContent = 'Reading barcodes in the photo…';
    try { const codes = await RDScanner.decodeImage(f); let n = 0; for (const c of codes) if (addCode(c, 'photo code')) n++;
      $('#scan-last').textContent = codes.length ? `Photo: ${codes.length} code${codes.length === 1 ? '' : 's'} found, ${n} new. ${$('#scan-last').textContent.startsWith('✓') ? '' : ''}` : 'No barcode found in that photo. Try closer and flatter, or use AI read photo.';
    } catch (err) { $('#scan-last').textContent = err.message; }
  });
  $('#scan-ai').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      $('#scan-last').textContent = 'Uploading photo for an AI read (needs the box online)…';
      const img = await RDScanner.compress(f, 1600, 0.8);
      const job = await call('rd_scan_submit', { p_member_id: me()?.id ?? null, p_image: img });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2500)); const j = await rpc('rd_scan_get', { p_key: KEY, p_id: job.id }).catch(() => null);
        if (!j) continue; if (j.status === 'pending' && i > 12) $('#scan-last').textContent = 'Waiting for the box to pick this up. Is it online?';
        if (j.status === 'running') $('#scan-last').textContent = 'Reading the label…';
        if (j.status === 'error') { $('#scan-last').textContent = j.error; return; }
        if (j.status === 'done') { const r = j.result || {}; const got = [];
          if (r.serial && C.classify(r.serial).type !== 'imei') { cap.serial = r.serial.toUpperCase(); got.push('serial'); }
          (r.imei || []).forEach((x) => { if (!cap.imei1) cap.imei1 = x; else if (!cap.imei2 && x !== cap.imei1) cap.imei2 = x; got.push('IMEI'); });
          if (r.part_number) { cap.part_number = r.part_number; got.push('part'); } if (r.upc) { cap.upc = r.upc; got.push('UPC'); }
          cap.ai = { model: r.model, color: r.color, storage: r.storage, notes: r.notes || [] };
          renderCap(got.length ? `AI read: ${got.join(', ')}. Check every value on the next screen.` : 'AI could not read the label clearly. Type it in.'); return; }
      }
      $('#scan-last').textContent = 'No answer yet. The box may be offline.';
    } catch (err) { $('#scan-last').textContent = err.message; }
  });
  $('#scan-type').addEventListener('click', () => { const keep = { ...cap }; closeScanner(); openPhone(null, keep); });
  $('#scan-done').addEventListener('click', () => { const keep = { ...cap }; closeScanner(); openPhone(null, keep); });

  // ---------- confirm / edit sheet (nothing is saved without this screen)
  let phEdit = null, phPhoto = null;
  function partHint() {
    const f = $('#phone-form'), pn = f.part_number.value.trim().toUpperCase(), k = partOf(pn);
    if (k) { $('#sp-part').textContent = `Lookup: ${[k.model, k.color, k.storage].filter(Boolean).join(' · ')}`; $('#sp-savepart').hidden = true; }
    else { $('#sp-part').textContent = pn ? 'Not in the lookup. Pick or type model / color / storage below.' : ''; $('#sp-savepart').hidden = !pn; }
    return k;
  }
  function imeiHint() {
    const f = $('#phone-form'), bad = ['imei1', 'imei2'].filter((k) => f[k].value.trim() && !C.luhn(f[k].value.replace(/\D/g, '')));
    $('#sp-imei').innerHTML = bad.length ? `<span class="neg">${bad.map((k) => k === 'imei1' ? 'IMEI' : 'IMEI 2').join(' and ')} failed the IMEI check (15 digits + Luhn).</span>` : '';
  }
  function hwHint() {
    const f = $('#phone-form'), hw = f.handwritten_serial.value.replace(/[^A-Z0-9]/gi, '').toUpperCase(), sn = f.serial.value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    $('#sp-hw').hidden = !(hw && sn && hw !== sn); $('#sp-hw').textContent = `Mismatch: handwritten “${hw}” vs scanned “${sn}”. Check the box before saving.`;
  }
  const setPhStatus = (v) => document.querySelectorAll('#sp-status button').forEach((b) => b.classList.toggle('on', b.dataset.s === v));
  $('#sp-status').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setPhStatus(b.dataset.s); });
  function openPhone(p, scanned) {
    phEdit = p || null; phPhoto = null; const f = $('#phone-form'); f.reset(); const s = scanned || {};
    f.member_id.innerHTML = ext.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    f.member_id.value = String(p ? (p.member_id ?? '') : (me()?.id ?? ''));
    $('#sp-title').textContent = p ? 'Edit phone' : 'Confirm phone'; $('#sp-sub').textContent = p ? `Logged ${et(p.created_at)} by ${p.member || 'no collector'}` : 'Check every field against the box before saving.';
    for (const k of ['serial', 'imei1', 'imei2', 'part_number', 'model', 'color', 'storage', 'sku', 'handwritten_serial', 'notes']) f[k].value = p ? (p[k] || '') : (s[k] || '');
    if (!p && s.upc) f.sku.value = 'UPC ' + s.upc;
    f.price_paid.value = p ? (+p.price_paid).toFixed(2) : '';
    const k = partHint();
    if (!p && k) { f.model.value = k.model || ''; f.color.value = k.color || ''; f.storage.value = k.storage || ''; }
    else if (!p && s.ai) { f.model.value = s.ai.model || ''; f.color.value = s.ai.color || ''; f.storage.value = s.ai.storage || ''; }
    if (!p && s.ai?.notes?.length) $('#sp-sub').textContent = 'AI read: ' + s.ai.notes.join('; ') + '. Check every value.';
    $('#sp-thumb').hidden = true; $('#sp-status-wrap').hidden = !p; setPhStatus(p ? p.status : 'logged');
    if (p?.has_photo) rpc('rd_phone_photo', { p_key: KEY, p_id: p.id }).then((d) => { if (d) { $('#sp-thumb').src = d; $('#sp-thumb').hidden = false; } }).catch(() => {});
    $('#sp-delete').hidden = !p; $('#sp-rescan').hidden = !!p; $('#sp-msg').textContent = ''; imeiHint(); hwHint(); sheet('#sheet-phone');
  }
  $('#phone-form').addEventListener('input', (e) => {
    const f = e.currentTarget, n = e.target.name;
    if (n === 'part_number') { const k = partHint(); if (k) { f.model.value = k.model || ''; f.color.value = k.color || ''; f.storage.value = k.storage || ''; } }
    if (n === 'imei1' || n === 'imei2') imeiHint();
    if (n === 'serial' || n === 'handwritten_serial') hwHint();
  });
  $('#phone-form').photo.addEventListener('change', async (e) => { const fl = e.target.files[0]; if (!fl) return; try { phPhoto = await RDScanner.compress(fl, 1280, 0.72); $('#sp-thumb').src = phPhoto; $('#sp-thumb').hidden = false; } catch (err) { toast(err.message); } });
  $('#sp-rescan').addEventListener('click', () => { const f = $('#phone-form'); const keep = { serial: f.serial.value, imei1: f.imei1.value, imei2: f.imei2.value, part_number: f.part_number.value, upc: '' };
    closeSheet(); openScanner(); Object.assign(cap, keep); renderCap('Kept what you had. Scan the rest.'); });
  $('#phone-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target, msg = $('#sp-msg'); msg.className = 'msg err';
    const serial = f.serial.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase(), i1 = f.imei1.value.replace(/\D/g, ''), i2 = f.imei2.value.replace(/\D/g, ''), price = num(f.price_paid.value);
    const err = !/^[A-Z0-9]{8,14}$/.test(serial) ? 'Enter the serial number (8–14 letters/numbers).' : (i1 && !C.luhn(i1)) ? 'IMEI fails the IMEI check. Re-scan or fix it.' : (i2 && !C.luhn(i2)) ? 'IMEI 2 fails the IMEI check.' :
      (i1 && i1 === i2) ? 'IMEI and IMEI 2 are the same.' : (!isFinite(price) || price < 0) ? 'Enter the price paid.' : '';
    if (err) { msg.textContent = err; return; }
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Saving…';
    try {
      const r = await call('rd_phone_save', { p_id: phEdit ? phEdit.id : null, p_phone: { member_id: f.member_id.value, serial, imei1: i1, imei2: i2, part_number: f.part_number.value, model: f.model.value, color: f.color.value,
        storage: f.storage.value, sku: f.sku.value, handwritten_serial: f.handwritten_serial.value, price_paid: price, notes: f.notes.value, status: phEdit ? $('#sp-status button.on').dataset.s : 'logged', photo: phPhoto } });
      if (r && r.error) { msg.className = 'msg err'; msg.textContent = r.error; btn.disabled = false; return; }
      if (f.save_part.checked && f.part_number.value.trim() && f.model.value.trim() && !partOf(f.part_number.value)) {
        await call('rd_part_save', { p_part: { part_number: f.part_number.value, model: f.model.value, color: f.color.value, storage: f.storage.value, source: 'added in app by ' + (me()?.name || 'member') } }).catch((x) => toast('Lookup not saved: ' + x.message)); }
      closeSheet(); toast(phEdit ? 'Phone updated' : 'Phone logged'); await loadPhones();
    } catch (err2) { msg.className = 'msg err'; msg.textContent = err2.message; }
    btn.disabled = false;
  });
  $('#sp-delete').addEventListener('click', async () => { if (!phEdit || !confirm(`Delete phone ${phEdit.serial}? This can’t be undone.`)) return;
    try { await call('rd_phone_delete', { p_id: phEdit.id }); closeSheet(); toast('Deleted'); await loadPhones(); } catch (err) { $('#sp-msg').textContent = err.message; } });
  setInterval(() => { if (document.visibilityState === 'visible' && (state.tab === 'phones' || state.tab === 'home') && !openSheet && $('#scan-ui').hidden) loadPhones().catch(() => {}); }, 10000);

  // ================= Dashboard (read-only overview; every card links to the tab that owns it) =================
  function renderDash() {
    if (!$('#dash-stats')) return;
    const now = new Date(), today = etKey(now), wd = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7, monday = new Date(Date.parse(today + 'T12:00:00Z') - wd * 86400000).toISOString().slice(0, 10);
    const P = ph.phones, logged = P.filter((p) => p.status === 'logged');
    const nToday = P.filter((p) => etKey(new Date(p.created_at)) === today).length, nWeek = P.filter((p) => etKey(new Date(p.created_at)) >= monday).length;
    const cs = collectors(), owed = r2(cs.reduce((a, c) => a + c.owed, 0));
    const items = state.status?.items || [], alive = items.filter((i) => i.alive).length, blocked = items.filter((i) => i.status === 'blocked').length, hot = items.filter((i) => i.status === 'in_stock').length;
    const sold = [...ext.listings.filter((l) => l.status === 'sold'), ...ext.sales]; const profit = r2(sold.reduce((a, x) => a + pnl(+x.price, +x.fee_pct, +x.shipping, +x.cost).profit, 0));
    const n = nextUp();
    $('#dash-hero').innerHTML = `<p class="k">Risky Drops · ${esc(etDay.format(now))}</p><p class="h">${hot ? `${hot} in stock now` : `${P.length} phone${P.length === 1 ? '' : 's'} logged`}</p>
      ${n ? `<p class="n" data-tick="${esc(n.at)}" data-past="Now">${compact(new Date(n.at) - Date.now())}</p><p class="w">until ${esc(n.title)} · ${esc(etLong(n.at))}</p>` : '<p class="w">No announced drop yet.</p>'}`;
    const stat = (go, label, val, sub, c = '') => `<button class="dstat" data-go="${go}"><small>${label}</small><b class="${c}">${val}</b>${sub ? `<span>${sub}</span>` : ''}</button>`;
    $('#dash-stats').innerHTML = stat('phones', 'Phones logged', P.length, `${nToday} today · ${nWeek} this week`) + stat('phones', 'Owed to collectors', money(owed), `${cs.length} collector${cs.length === 1 ? '' : 's'}`) +
      stat('watches/list', 'Watchers', `${alive}/${items.length}`, `${blocked} blocked${hot ? ` · <span class="neg">${hot} in stock</span>` : ''}`) + stat('sales/sold', 'Sales profit', money(profit), `${sold.length} sale${sold.length === 1 ? '' : 's'}`, cls(profit));
    // breakdown by model / color / storage
    const groups = new Map(); for (const p of logged) { const k = phoneName(p); groups.set(k, (groups.get(k) || 0) + 1); }
    const breakdown = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const flags = [...P.filter(hwMismatch).map((p) => ({ t: `Handwritten serial mismatch on ${maskSerial(p.serial)}`, s: `${p.member || 'No collector'} · ${et(p.created_at)}` })),
      ...ph.dupes.slice(0, 6).map((d) => ({ t: `Duplicate ${d.kind === 'imei' ? 'IMEI' : 'serial'} attempt ${d.kind === 'imei' ? '…' + d.value.slice(-5) : maskSerial(d.value)}`, s: `${memberName(d.member_id)} · ${et(d.at)}` }))];
    const restocks = state.alerts.filter((a) => a.kind === 'restock').slice(0, 3);
    const card = (go, title, body, more = 'Open') => `<div class="card dcard"><div class="row"><p class="t grow">${title}</p><button class="btn ghost" data-go="${go}">${more} ›</button></div>${body}</div>`;
    $('#dash-cards').innerHTML =
      card('phones', 'Payout owed by collector', cs.length ? `<div class="coll-list">${cs.slice(0, 5).map((c) => `<button class="coll" data-gocoll="${c.id ?? ''}"><span class="grow"><b>${esc(c.name)}</b><small>${c.n} phone${c.n === 1 ? '' : 's'}</small></span><b>${money(c.owed)}</b></button>`).join('')}</div>` : '<p class="d">No collectors have logged phones yet.</p>') +
      card('phones', 'Phones by model', breakdown.length ? `<div class="bars">${breakdown.map(([k, v]) => `<div><span>${esc(k)}</span><i style="--w:${Math.round(v / breakdown[0][1] * 100)}%"></i><b>${v}</b></div>`).join('')}</div>` : '<p class="d">Nothing logged yet.</p>') +
      card('phones', 'Recent phones', P.length ? P.slice(0, 5).map((p) => `<div class="drow"><span class="grow"><b>${esc(phoneName(p))}</b><small>${esc(maskSerial(p.serial))} · ${esc(p.member || 'No collector')} · ${esc(et(p.created_at))}</small></span><b>${money(+p.price_paid)}</b></div>`).join('') : '<p class="d">Nothing logged yet.</p>') +
      card('phones', `Flags${flags.length ? ` <span class="pill price_drop">${flags.length}</span>` : ''}`, flags.length ? flags.slice(0, 6).map((x) => `<div class="drow flagrow"><span class="grow"><b>${esc(x.t)}</b><small>${esc(x.s)}</small></span></div>`).join('') : '<p class="d">No duplicate or mismatch flags.</p>', 'Review') +
      card('watches/alerts', 'Latest restock alerts', restocks.length ? restocks.map((a) => `<div class="drow"><span class="grow"><b>${esc(a.item || a.title)}</b><small>${esc([a.store, a.city].filter(Boolean).join(', '))} · ${esc(a.time_et || et(a.ts))}</small></span></div>`).join('') : '<p class="d">No restocks yet.</p>') +
      card('watches/list', 'Watcher health', `<div class="drow"><span class="grow">${items.map((i) => `<span class="hchip"><span class="dot ${i.alive ? 'on' : i.status === 'scheduled' || i.paused ? '' : 'off'}"></span>${esc(i.name.split(' (')[0])}${i.status === 'blocked' ? ' · blocked' : i.status === 'in_stock' ? ' · IN STOCK' : ''}</span>`).join('')}</span></div>`);
  }
  $('#tab-home').addEventListener('click', (e) => {
    const c = e.target.closest('[data-gocoll]'); if (c) { ph.filter = c.dataset.gocoll === '' ? null : +c.dataset.gocoll; show('phones'); renderPhones(); return; }
    const b = e.target.closest('[data-go]'); if (!b) return; const [t, sub] = b.dataset.go.split('/'); show(t, sub);
  });

  // ---------- data
  async function load() {
    try {
      const [s, a] = await Promise.all([api('/api/status'), api('/api/alerts'), loadExt().catch((e) => { if (/Access key/.test(e.message)) throw e; toast('Could not load listings: ' + e.message); })]);
      state.status = s; state.alerts = a.alerts || [];
      if (!state.flip) state.flip = await api('/api/flip');
      if (!localStorage.getItem('rd-seen')) localStorage.setItem('rd-seen', new Date().toISOString());
      renderFlip(); renderBadge(); renderV2();
    } catch (err) {
      if (/Access key/.test(err.message)) {
        document.querySelector('main').innerHTML = '<div class="card" style="margin-top:30px;text-align:center"><p class="t">Access key required</p><p class="d">Open the full Risky Drops link with ?key=… once. This device remembers it.</p></div>';
        document.querySelector('.tabbar').hidden = true;
      } else toast('Could not load: ' + err.message);
    }
    $('#boot').classList.add('gone');
  }
  const route = () => { const [h, hs] = location.hash.slice(1).split('/');
    if (['home', 'watches', 'phones', 'sales', 'settings', 'ask', ...Object.keys(LEGACY)].includes(h)) { show(h, hs); if (h === 'ask') loadAsk().catch(() => {}); } else show('home'); };
  route(); window.addEventListener('hashchange', route);
  load();
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
})();

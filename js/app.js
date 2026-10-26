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
  // ---- Item types: ONE registry. flow 'scanner' = the iPhone box-scan flow; anything else (or an unknown id) = the generic form.
  // To add a type: append { id, label, one, hint, icon, flow: 'generic', namePh, modelPh, match }. The server accepts any lowercase id.
  const ICON = { phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>', console: '<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 11v3M5.5 12.5h3"/><circle cx="16" cy="11.5" r="1"/><circle cx="18" cy="13.5" r="1"/>',
    other: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>' };
  const ITEM_TYPES = [
    { id: 'phone', label: 'Phones', one: 'phone', hint: 'Scan the box label', icon: ICON.phone, flow: 'scanner', match: /\b(iphone|pixel|galaxy)\b/i },
    { id: 'console', label: 'Consoles', one: 'console', hint: 'PS5, Xbox, Switch…', icon: ICON.console, flow: 'generic', namePh: 'e.g. PS5 Pro', modelPh: 'e.g. CFI-7020', match: /\b(ps5|ps4|playstation|xbox|switch|steam deck|console)\b/i },
    { id: 'other', label: 'Other', one: 'item', hint: 'Anything else', icon: ICON.other, flow: 'generic', namePh: 'e.g. Beats Pill', modelPh: 'model / variant' },
  ];
  const itemType = (id) => ITEM_TYPES.find((t) => t.id === (id || 'phone')) ||
    { id, label: String(id).replace(/^./, (c) => c.toUpperCase()), one: String(id), hint: '', icon: ICON.other, flow: 'generic', namePh: 'Item name', modelPh: 'model / variant' };
  const guessType = (name) => (ITEM_TYPES.find((t) => t.match && t.match.test(name || '')) || { id: 'other' }).id;
  const typeOfSale = (x) => x.item_type || guessType(x.item);
  const pickerHtml = () => ITEM_TYPES.map((t) => `<button type="button" class="tpick" role="listitem" data-itype="${t.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${t.icon}</svg><b>${t.label}</b><small>${t.hint}</small></button>`).join('');
  const BUYNOW = new Set(['iphoneduo', 'ps5', 'ps5wm']);   // alert cards from these sources get a big 'Buy now' link (link only, never buys)
  const typeChip = (p) => `<span class="tchip">${esc(itemType(p.item_type).label.replace(/s$/, ''))}</span>`;
  let state = { status: null, alerts: [], flip: null, filter: 'all', tab: 'home', wsub: 'list', ssub: 'listings' };

  const toast = (t) => { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (el.hidden = true), 2600); };
  // ---- backend: local box server (cookie) or hosted mode (Supabase RPC + access key, commands polled by the box)
  const CFG = window.RD_CONFIG || null;
  // Sign-in modes (hosted): 'admin' = owner ?key= link or an admin session token (accepted by every app RPC),
  // 'friend' = friend session (only the rd_me / rd_f_* RPCs accept it; enforced in the database), 'login' = the one login screen.
  const QS = new URLSearchParams(location.search);
  let SESSION = null; try { SESSION = JSON.parse(localStorage.getItem('rd-session') || 'null'); } catch (e) { SESSION = null; }
  const MODE = (() => {
    if (!CFG) return 'admin';
    const k = QS.get('key');
    if (k) { localStorage.setItem('rd-key', k); localStorage.removeItem('rd-session'); SESSION = null; return 'admin'; }
    if (QS.has('login')) return 'login';
    if (SESSION && SESSION.token && SESSION.role === 'friend') return 'friend';
    if (SESSION && SESSION.token && SESSION.role === 'admin') return 'admin';
    if (localStorage.getItem('rd-key')) return 'admin';
    return 'login';
  })();
  const KEY = (() => {
    if (!CFG || MODE !== 'admin') return null;
    if (QS.get('key')) return QS.get('key');
    if (SESSION && SESSION.role === 'admin') return SESSION.token;
    return localStorage.getItem('rd-key');
  })();
  const TOKEN = MODE === 'friend' ? SESSION.token : null;
  document.documentElement.dataset.mode = MODE;
  async function rpc(fn, args) {
    const r = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST', cache: 'no-store',
      headers: { apikey: CFG.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (j.message === 'forbidden' && (TOKEN || (SESSION && SESSION.role === 'admin' && KEY === SESSION.token))) signOut('Your session ended. Log in again.');
      throw new Error(j.message === 'forbidden' ? 'Access key missing or wrong' : (j.message || 'HTTP ' + r.status));
    }
    return j;
  }
  function signOut(msg) {
    const t = SESSION && SESSION.token; localStorage.removeItem('rd-session'); localStorage.removeItem('rd-key');
    if (msg) sessionStorage.setItem('rd-login-msg', msg);
    const go = () => location.replace(location.pathname);
    if (t && CFG) fetch(`${CFG.supabaseUrl}/rest/v1/rpc/rd_logout`, { method: 'POST', headers: { apikey: CFG.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_token: t }) }).finally(go);
    else go();
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
  // Dock: Home / Duo / PS5 Pro / Watches / Pickup / More. More holds Items, Sales, Favorites, Friends, Ask and Settings (admin link only) plus the theme picker.
  // Items, Sales, Friends, Settings and Ask keep their own screens; the dock highlights More while you are on one of them.
  const MORE_SET = ['more', 'phones', 'sales', 'friends', 'settings', 'ask'];
  const LEGACY = { items: ['phones', undefined], alerts: ['watches', 'alerts'], countdowns: ['watches', 'countdowns'], listings: ['sales', 'listings'], flip: ['sales', 'comps'] };
  function show(tab, sub) {
    if (LEGACY[tab]) [tab, sub] = LEGACY[tab];
    state.tab = tab;
    document.querySelectorAll('.screen').forEach((s) => (s.hidden = s.id !== 'tab-' + tab));
    document.querySelectorAll('.tabbar button').forEach((b) => { const on = b.dataset.tab === tab || (b.dataset.tab === 'more' && MORE_SET.includes(tab)); b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $('#gear').classList.toggle('on', tab === 'settings');
    $('#ask-open').hidden = tab === 'ask' || tab === 'duo' || tab === 'ps5' || tab === 'people';   // the sticky Check now button lives where the orb floats
    if (tab === 'duo' && typeof duoOpen === 'function') duoOpen();
    if (tab === 'ps5' && typeof ps5Open === 'function') ps5Open();
    if ((tab === 'people' || tab === 'duo') && typeof ppOpen === 'function') ppOpen(tab);
    const tb = document.querySelector(`.tabbar button[data-tab="${tab}"]`); if (tb && tb.scrollIntoView) tb.scrollIntoView({ inline: 'center', block: 'nearest' });
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + '#' + (tab === 'phones' ? 'items' : tab) + (tab === 'friends' && sub ? '/' + sub : ''));
    if (sub && tab === 'watches') showSub('w', sub);
    if (sub && tab === 'sales') showSub('s', sub);
    if (tab === 'sales' && typeof renderTracker === 'function' && ext.loaded) setTimeout(renderTracker, 0);
    if (tab === 'phones' || tab === 'home') loadPhones().catch(() => {});
    if (tab === 'friends' && typeof loadFriendsView === 'function') { if (sub === undefined) frDetail = null; loadFriendsView().catch((e) => toast(e.message)); }
    if (typeof closeSheet === 'function') closeSheet();
    if (tab === 'watches' && state.wsub === 'alerts') { localStorage.setItem('rd-seen', new Date().toISOString()); renderBadge(); }
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  $('#gear').addEventListener('click', () => show('settings'));
  // More menu: every row opens its screen; Favorites lives inside Watches.
  document.querySelectorAll('.more-row').forEach((b) => b.addEventListener('click', () => { const g = b.dataset.go; if (g === 'favs') show('watches', 'favs'); else show(g); if (g === 'ask') loadAsk().catch(() => {}); }));
  const SUBS = { w: ['list', 'favs', 'alerts', 'countdowns'], s: ['listings', 'sold', 'comps'] };
  function showSub(g, v) {
    if (!SUBS[g].includes(v)) return; state[g + 'sub'] = v;
    document.querySelectorAll(`#${g}-seg button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    SUBS[g].forEach((x) => ($(`#${g}-${x}`).hidden = x !== v));
    if (g === 'w' && v === 'alerts') { localStorage.setItem('rd-seen', new Date().toISOString()); renderBadge(); }
    if (g === 'w' && v === 'favs' && typeof loadFavs === 'function') loadFavs();
    if (g === 'w' && v !== 'list' && state.wdetail) { state.wdetail = null; if (typeof renderWatches === 'function') renderWatches(); }
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + '#' + (g === 'w' ? 'watches' : 'sales') + '/' + v);
  }
  $('#w-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showSub('w', b.dataset.v); });
  $('#s-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showSub('s', b.dataset.v); });

  // ---------- watches
  // Store pills: a watcher's detail like "PS Direct 1000050928: outOfStock $899.0 · Best Buy 6601524: CHECK_STORES $899.99" becomes one compact
  // scrollable row of pills (green glowing dot = live/in stock, gray = sold out/unknown/blocked); only the selected store's detail is shown.
  const storeSel = {};
  const LIVE_RX = /\b(check[ _-]?stores|in[ _-]?stock|instock|add[ _-]?to[ _-]?cart|available|orderable|cart=true|buyable=true)\b/i, DEAD_RX = /out[ _-]?of[ _-]?stock|sold[ _-]?out|unavailable|not available|blocked|cart=false|none/i;
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
  const enc = encodeURIComponent;
  // Store registry: every pill's Buy link goes to THAT store's own page (plain https; on iPhone the store's app opens via its universal link
  // when installed, so no cross-store deep links). Unknown product id → that store's own search, never another store.
  const STORES = [
    { rx: /^drop$|drop\.vans/i, name: 'drop.vans.com', host: 'drop.vans.com' },
    { rx: /^main$|^vans/i, name: 'vans.com', host: 'vans.com', search: (q) => `https://www.vans.com/en-us/search?q=${enc(q)}` },
    { rx: /best ?buy/i, host: 'bestbuy.com', id: (r) => /^\d{6,8}$/.test(r) && `https://www.bestbuy.com/site/${r}.p?skuId=${r}`, search: (q) => `https://www.bestbuy.com/site/searchpage.jsp?st=${enc(q)}` },
    { rx: /amazon/i, host: 'amazon.com', id: (r) => /^B0[A-Z0-9]{8}$/.test(r) && `https://www.amazon.com/dp/${r}`, search: (q) => `https://www.amazon.com/s?k=${enc(q)}` },
    { rx: /ps ?direct|playstation|psn/i, host: 'direct.playstation.com', search: () => 'https://direct.playstation.com/en-us/' },
    { rx: /apple/i, host: 'apple.com', id: (r) => /^[A-Z0-9]{4,6}\d?[A-Z]{1,2}\/[A-Z]$/.test(r) && `https://www.apple.com/shop/product/${r}`, search: (q) => `https://www.apple.com/us/search/${enc(q)}` },
    { rx: /target/i, host: 'target.com', search: (q) => `https://www.target.com/s?searchTerm=${enc(q)}` },
    { rx: /walmart/i, host: 'walmart.com', search: (q) => `https://www.walmart.com/search?q=${enc(q)}` },
    { rx: /gamestop/i, host: 'gamestop.com', search: (q) => `https://www.gamestop.com/search/?q=${enc(q)}` },
  ];
  function storeLink(label, ref, i, single) {
    const s = STORES.find((x) => x.rx.test(label)), il = safeUrl(i.link);
    if (!s) return single ? il : '';
    const byId = s.id && ref && s.id(ref); if (byId) return byId;
    if (il && hostOf(il) === s.host) return il;
    const code = (String(i.sub || '').match(/\b(?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/) || [])[0];
    return s.search ? s.search(ref || code || i.name) : (single ? il : '');
  }
  function parseStores(i) {
    if (!i.detail || !i.detail.includes(':')) return [];
    const raw = i.detail.split(' · ').map((x) => x.trim());
    let lead = ''; const mm = /^(.*[.;!?])\s+([^.;!?:]{1,40}:.*)$/.exec(raw[0]); if (mm) { lead = mm[1]; raw[0] = mm[2]; }
    const segs = raw.map((x) => /^([^:]{1,40}):\s*(.*)$/.exec(x));
    if (segs.length < 1 || segs.some((m) => !m)) return [];
    if (segs.length === 1 && !STORES.some((x) => x.rx.test(segs[0][1].trim()))) return [];   // e.g. "Watcher starts Oct 22, 7:00 PM" is not a store list
    return segs.map((m) => {
      const label = m[1].trim(), rest = m[2].trim(), ref = (label.match(/\b([A-Z0-9]{6,}(?:\/[A-Z])?)\b/) || [])[1] || '';
      const reg = STORES.find((x) => x.rx.test(label));
      const name = (reg && reg.name) || label.replace(/\s+[A-Z0-9]{6,}(?:\/[A-Z])?$/, '').replace(/^./, (c) => c.toUpperCase());
      const price = (rest.match(/\$\s?[\d,]+(?:\.\d+)?/) || rest.match(/price=([\d.]+)/) || [])[0];
      const mode = rest.replace(/\$\s?[\d,]+(?:\.\d+)?/g, '').replace(/\s+/g, ' ').trim();
      const live = LIVE_RX.test(rest) && !DEAD_RX.test(rest.replace(LIVE_RX, ''));
      const dup = segs.filter((x) => x[1].replace(/\s+[A-Z0-9]{6,}$/, '') === m[1].replace(/\s+[A-Z0-9]{6,}$/, '')).length > 1;
      return { key: label, lead, name: name + (dup && ref ? ' ' + ref.slice(-4) : ''), ref, price: price ? (price.startsWith('$') ? price.replace(/\s/g, '') : '$' + price.replace('price=', '')) : '', mode, live, link: storeLink(label, ref, i, segs.length === 1) };
    });
  }
  const selStore = (i, st) => st.find((x) => x.key === storeSel[i.id]) || st.find((x) => x.live) || st[0];
  function storesHtml(i) {
    const st = parseStores(i);
    if (!st.length) return i.detail ? `<p class="d">${esc(i.detail)}</p>` : '';
    const s = selStore(i, st);
    return `${st[0].lead ? `<p class="d">${esc(st[0].lead)}</p>` : ''}<div class="spills" role="tablist" aria-label="Stores">${st.map((x) => `<button type="button" role="tab" aria-selected="${x === s}" class="spill ${x === s ? 'on' : ''}" data-store="${esc(i.id)}" data-skey="${esc(x.key)}"><i class="${x.live ? 'live' : ''}"></i>${esc(x.name)}</button>`).join('')}</div>
      <p class="sline"><b>${s.live ? 'Live' : 'Not live'}</b>${s.price ? `<span>${esc(s.price)}</span>` : ''}${s.mode ? `<span>${esc(s.mode)}</span>` : ''}<span>checked ${i.last_check ? esc(et(i.last_check)) : '—'}</span></p>`;
  }
  // Buy button: the selected store pill's own link, else the watch's product link.
  function buyFor(i) {
    const st = parseStores(i), s = st.length ? selStore(i, st) : null;
    return s && s.link ? { href: s.link, label: `Buy at ${s.name} ↗` } : (safeUrl(i.link) ? { href: safeUrl(i.link), label: 'Buy ↗' } : null);
  }
  const isBlocked = (i) => (i.health && i.health.status === 'blocked') || i.status === 'blocked';
  const hasProblem = (i) => isBlocked(i) || (i.health && i.health.status === 'error') || i.status === 'error';
  function storeNames(i) {
    const st = parseStores(i); if (st.length) return st.map((x) => x.name);
    if (i.kind === 'apple' || /^Apple /.test(i.sub || '') || hostOf(i.link).endsWith('apple.com')) return ['Apple'];
    const h = hostOf(i.link); return h ? [h] : [];
  }
  // Last time a watch was really in stock: now (if its latest check says so) or its newest restock alert.
  function lastInStock(i) {
    if (i.status === 'in_stock') return i.last_check || state.status?.generated || null;
    let best = null;
    for (const a of state.alerts) if (a.kind === 'restock' && (a.source === i.id || a.source === 'app:' + i.id) && (!best || a.ts > best)) best = a.ts;
    return best;
  }

  // ----- favorites state (hosted only; a saved list — nothing here starts checks)
  let favs = [], favsLoaded = false, wMenu = null, dashSort = localStorage.getItem('rd-dash-sort') || 'recent';
  const favFor = (i) => favs.find((f) => !f.promoted_at && (f.watch_id === i.id || (f.url && f.url === i.link)));

  function watchCard(i) {
    const buy = buyFor(i), blocked = isBlocked(i), prob = hasProblem(i), favd = favFor(i);
    const procTxt = i.status === 'scheduled' ? 'Starts on schedule' : i.alive ? `Watcher alive (pid ${i.pid})` : (i.status === 'blocked' && !i.builtin ? 'Not polled' : 'Watcher not running');
    const pauseBtn = i.can_pause ? (i.paused || (!i.alive && i.builtin)
      ? `<button class="btn" data-act="resume" data-id="${esc(i.id)}">${i.paused ? 'Resume' : 'Start'}</button>`
      : `<button class="btn" data-act="pause" data-id="${esc(i.id)}">Pause</button>`) : '';
    const h = i.health || {};
    const blockLine = prob ? `<p class="blk-line"><b>${blocked ? 'Blocked' : 'Check failing'}</b>${h.http_status ? `<span>HTTP ${esc(h.http_status)}</span>` : ''}${h.kind ? `<span>${esc(KIND_SHORT[h.kind] || h.kind.replace(/_/g, ' '))}</span>` : ''}${h.consecutive_failures ? `<span>${esc(h.consecutive_failures)}× in a row</span>` : ''}${h.blocked_at ? `<span>since ${esc(et(h.blocked_at))}</span>` : ''}</p>` : '';
    return `<div class="card wcard ${i.status === 'in_stock' ? 'in-stock-card' : ''} ${blocked ? 'blocked-card' : ''}" id="wc-${esc(i.id)}">
      <div class="row"><p class="t grow">${favd ? '<span class="fav-star" title="In favorites" aria-label="In favorites">★</span> ' : ''}${esc(i.name)}</p><span class="pill ${esc(blocked ? 'blocked' : i.status)}">${esc(blocked ? 'Blocked' : (LABEL[i.status] || i.status))}</span>
        ${CFG ? `<div class="client-menu wmenu"><button type="button" class="client-menu-trigger" aria-label="More actions for ${esc(i.name)}" aria-haspopup="menu" aria-expanded="${wMenu === i.id}" data-wmenu="${esc(i.id)}">⋯</button>
        ${wMenu === i.id ? `<div class="client-menu-pop" role="menu"><button type="button" role="menuitem" data-wfav="${esc(i.id)}">${favd ? '★ In favorites' : '☆ Add to favorites'}</button><button type="button" role="menuitem" data-wdiag="${esc(i.id)}">Diagnose</button><button type="button" role="menuitem" class="danger" data-wdel="${esc(i.id)}">Delete watch</button></div>` : ''}</div>` : ''}</div>
      <p class="d">${esc(i.sub)}</p>
      ${blockLine}
      ${storesHtml(i)}
      ${i.extra ? `<p class="f">${esc(i.extra)}</p>` : ''}
      <div class="meta"><span class="row" style="gap:6px"><span class="dot ${i.alive ? 'on' : (i.status === 'scheduled' || i.paused || (i.status === 'blocked' && !i.builtin) ? '' : 'off')}"></span>${esc(procTxt)}</span>
        <span>Last check: ${i.last_check ? esc(et(i.last_check)) : '—'}${i.stale ? ' (stale)' : ''}</span></div>
      ${CFG ? dropHtml(i) : ''}
      <div class="actions">${buy ? `<a class="btn buy" href="${esc(buy.href)}" target="_blank" rel="noopener noreferrer">${esc(buy.label)}</a>` : ''}${prob && CFG ? `<button class="btn warn" data-wretry="${esc(i.id)}">Retry</button><button class="btn" data-wdiag="${esc(i.id)}">Diagnose</button>` : ''}${pauseBtn}${CFG ? `<button class="btn" data-drop="${esc(i.id)}">Drop time</button>` : ''}${!CFG && !i.builtin ? `<button class="btn ghost" data-act="delete" data-id="${esc(i.id)}">Remove</button>` : ''}</div>
    </div>`;
  }

  // ----- multi-watch dashboard (top of the Watches tab): every active watch at a glance, real data only
  function dashState(i) { return isBlocked(i) ? 'blocked' : i.status === 'in_stock' ? 'live' : 'quiet'; }
  function renderDashW(items) {
    const act = items.filter((i) => !i.paused && i.status !== 'paused');
    if (!act.length) { $('#w-dash').innerHTML = ''; return; }
    const rows = act.map((i) => ({ i, st: dashState(i), stores: storeNames(i), lis: lastInStock(i) }));
    if (dashSort === 'store') rows.sort((a, b) => (a.stores[0] || '~').localeCompare(b.stores[0] || '~', 'en', { sensitivity: 'base' }) || a.i.name.localeCompare(b.i.name));
    else rows.sort((a, b) => (b.lis || '').localeCompare(a.lis || '') || (a.st === 'blocked') - (b.st === 'blocked') || a.i.name.localeCompare(b.i.name));
    let grp = '';
    const html = rows.map((r) => {
      const g = dashSort === 'store' ? (r.stores[0] || 'Other') : '';
      const head = g && g.toLowerCase() !== grp.toLowerCase() ? `<div class="wd-grp">${esc(g)}</div>` : ''; if (g) grp = g;
      const lbl = r.st === 'live' ? 'In stock' : r.st === 'blocked' ? 'Blocked' : 'Quiet';
      return `${head}<button type="button" class="wd-row" data-wopen="${esc(r.i.id)}" aria-label="${esc(r.i.name)}: ${lbl}. Open details">
        <span class="wd-main"><b>${esc(r.i.name)}</b><small>${esc(r.stores.join(' · ') || '—')}</small></span>
        <span class="wd-side"><span class="dpill ${r.st}">${lbl}</span><small>${r.i.last_check ? 'checked ' + esc(et(r.i.last_check)) : 'not checked yet'}</small><small>${r.lis ? (r.st === 'live' ? 'in stock now' : 'last in stock ' + esc(et(r.lis))) : 'never in stock'}</small></span>
        <svg class="wd-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>`;
    }).join('');
    $('#w-dash').innerHTML = `<div class="card wd"><div class="row wd-top"><p class="t grow">All watches <small class="muted">${act.length} active</small></p>
      <div class="seg wd-sort" role="group" aria-label="Sort watches"><button type="button" data-dsort="recent" class="${dashSort === 'recent' ? 'on' : ''}">Recently in stock</button><button type="button" data-dsort="store" class="${dashSort === 'store' ? 'on' : ''}">By store</button></div></div>
      <div class="wd-list">${html}</div></div>`;
  }
  $('#w-dash').addEventListener('click', (e) => {
    const s = e.target.closest('[data-dsort]'); if (s) { dashSort = s.dataset.dsort; localStorage.setItem('rd-dash-sort', dashSort); renderWatches(); return; }
    const r = e.target.closest('[data-wopen]'); if (r) location.hash = 'watches/w/' + encodeURIComponent(r.dataset.wopen);
  });

  function renderWatches() {
    const items = state.status?.items || [];
    const lastSync = state.syncedAt || state.status?.generated;
    const stale = lastSync && Date.now() - new Date(lastSync).getTime() > 3 * 60 * 1000;
    $('#updated').textContent = lastSync ? (stale ? 'Box offline? Last sync ' : 'Updated ') + et(lastSync) : '';
    $('#updated').style.color = stale ? 'var(--red)' : '';
    const detail = state.wdetail ? items.find((i) => i.id === state.wdetail) : null;
    $('#w-main').hidden = !!state.wdetail; $('#w-detail').hidden = !state.wdetail;
    if (state.wdetail) {
      const hist = detail ? state.alerts.filter((a) => a.source === detail.id || a.source === 'app:' + detail.id).slice(0, 30) : [];
      $('#wdetail-body').innerHTML = detail ? watchCard(detail) + `<div class="kicker">Alert history</div>` + (hist.map((a) => `<div class="card slim"><div class="row"><p class="t grow">${esc(a.store || a.item || a.title)}</p><span class="pill ${esc(a.kind)}">${a.kind === 'restock' ? 'Restock' : esc(a.kind)}</span></div>${a.detail ? `<p class="d">${esc(a.detail)}</p>` : ''}<p class="f">${esc(a.time_et || et(a.ts))}</p></div>`).join('') || '<p class="empty">No alerts for this watch yet.</p>')
        : '<p class="empty">This watch is gone (deleted or not synced yet).</p>';
      return;
    }
    const sum = $('#summary'); sum.innerHTML = '';
    const alive = items.filter((i) => i.alive).length;
    const shouldRun = items.filter((i) => i.can_pause && !i.paused && !(i.status === 'blocked' && !i.builtin)).length || 1;
    const hot = items.filter((i) => i.status === 'in_stock').length, nb = items.filter(isBlocked).length;
    sum.appendChild(OrbitRing({ pct: (alive / shouldRun) * 100, size: 74, tone: hot ? 'alert' : undefined,
      center: `<b>${alive}/${shouldRun}</b><small>alive</small>`, label: `${alive} of ${shouldRun} watchers alive` }));
    const txt = document.createElement('div'); txt.className = 'grow';
    txt.innerHTML = `<p class="t">${hot ? `${hot} in stock now` : 'Nothing in stock right now'}</p>
      <p class="d">${alive} watcher${alive === 1 ? '' : 's'} running · ${items.length} items${nb ? ` · <span class="blk-txt">${nb} blocked</span>` : ''}. Tap Buy to open that store's page; you check out yourself.</p>`;
    sum.appendChild(txt);
    renderDashW(items);
    $('#watch-list').innerHTML = items.map(watchCard).join('') || '<p class="empty">No watches yet.</p>';
  }

  // ----- confirm dialog (red for destructive)
  function confirmBox({ title, body, ok = 'OK', danger = false }) {
    return new Promise((res) => {
      const d = $('#cdlg'); $('#cdlg-t').textContent = title; $('#cdlg-b').textContent = body || '';
      const okb = $('#cdlg-ok'); okb.textContent = ok; okb.className = 'btn ' + (danger ? 'danger' : 'buy');
      d.hidden = false; $('#cdlg-back').hidden = false; okb.focus();
      const done = (v) => { d.hidden = true; $('#cdlg-back').hidden = true; okb.onclick = null; $('#cdlg-no').onclick = null; $('#cdlg-back').onclick = null; res(v); };
      okb.onclick = () => done(true); $('#cdlg-no').onclick = () => done(false); $('#cdlg-back').onclick = () => done(false);
    });
  }
  async function waitCmd(id, quiet) {
    if (!quiet) toast('Sent to the box. It applies changes within about 30 seconds…');
    for (let n = 0; n < 45; n++) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = await rpc('rd_command_status', { p_key: KEY, p_id: id });
      if (st && st.state === 'done') { snap = null; return st.result || {}; }
      if (st && st.state === 'failed') throw new Error((st.result && st.result.error) || 'The box could not apply that');
    }
    throw new Error('The box has not picked this up yet. Is it online? It will apply it when it reconnects.');
  }

  // ----- Diagnose: plain-English report from the DB health record
  const KIND_SHORT = { http_403: '403 Forbidden', http_429: '429 rate limit', http_503: '503 unavailable', perimeterx: 'PerimeterX wall', datadome: 'DataDome wall', cloudflare: 'Cloudflare wall', akamai: 'Akamai wall', captcha: 'captcha page', access_denied: 'access denied', redirect: 'unexpected redirect', empty: 'empty response', garbled: 'garbled response', timeout: 'timeout', network: 'network error', known_block: 'known bot wall', bot_wall: 'bot wall', check_error: 'check error' };
  function kindText(h) {
    const k = h.kind || '', fu = h.final_url || 'another page';
    const wall = { perimeterx: 'PerimeterX', datadome: 'DataDome', cloudflare: 'Cloudflare', akamai: 'Akamai' }[k];
    if (wall) return (h.http_status && h.http_status !== 200 ? `The store refused the request (HTTP ${h.http_status}) and ` : 'The store ') + `served a bot-protection page (${wall}) instead of the product, so the box couldn't read stock.`;
    return ({
      http_403: 'The store refused the request (HTTP 403 Forbidden). That is almost always bot protection blocking this box’s IP or browserless requests.',
      http_429: 'The store is rate-limiting the box (HTTP 429 Too Many Requests): it checked too often for their liking.',
      http_503: 'The store answered 503 Service Unavailable, which usually means a bot wall or a queue/waiting-room page.',
      captcha: 'A captcha / “are you human?” page came back instead of the product page.',
      access_denied: 'An “Access Denied” page came back instead of the product page.',
      redirect: `The product URL redirected to ${fu} instead of the product page (often a block, region or error page).`,
      empty: 'The store sent back an empty (or nearly empty) page, which is how some bot walls respond.',
      garbled: 'The response was garbled / not readable text, so there was nothing to parse.',
      timeout: 'The store didn’t answer within 30 seconds (timeout).',
      network: 'The box couldn’t reach the store (network / DNS error).',
      known_block: 'This site is on the box’s known-blocked list (its bot protection blocks box requests), so it is not polled automatically.',
      bot_wall: 'The watcher’s own log reports it is blocked by the store’s bot wall.',
      check_error: 'The watcher reported an error on its last check.',
    })[k] || (k.startsWith('http_') ? `The store answered HTTP ${k.slice(5)}.` : 'The last check failed.');
  }
  function fixText(h, i) {
    const host = hostOf(h.final_url || i.link), k = h.kind || '';
    const by = (re) => re.test(host);
    if (k === 'timeout' || k === 'network') return 'Usually temporary. Tap Retry in a few minutes; if it keeps failing, the store may be down.';
    if (k === 'http_429') return 'Back off: wait 15–30 minutes, then Retry. The watcher already spaces its checks out.';
    if (k === 'redirect' && !/block|captcha|denied|challenge/i.test(h.final_url || '')) return 'Open the link yourself; if the product moved, delete this watch and add the new product URL.';
    const store = by(/target\.com/) ? 'Target' : by(/walmart\.com/) ? 'Walmart' : by(/gamestop\.com/) ? 'GameStop' : by(/vans\.com/) ? 'Vans' : by(/amazon\./) ? 'Amazon' : by(/bestbuy\.com/) ? 'Best Buy' : by(/apple\.com/) ? 'Apple' : '';
    return `${store ? store + ' bot protection' : 'Bot protection'}; try again later or check it in ${store ? 'the ' + store : 'the store’s'} app. The box can’t solve captchas (by design), so a watch that stays blocked won’t alert.`;
  }
  async function openDiag(id) {
    const i = (state.status?.items || []).find((x) => x.id === id); if (!i) return;
    let h = null;
    if (CFG) { try { h = await rpc('rd_watch_diagnose', { p_key: KEY, p_id: id }); } catch (e) { toast(e.message); } }
    h = h ? { ...h, kind: h.last_error_kind, detail: h.last_error_detail } : (i.health || {});
    const ok = !h.status || h.status === 'ok';
    $('#dg-title').textContent = 'Diagnose · ' + i.name;
    $('#dg-body').innerHTML = ok
      ? `<p class="dg-ok">No problem on the last check.</p><p class="d">Last checked ${esc(et(h.checked_at || i.last_check) || '—')}${h.last_ok_at ? ` · last good check ${esc(et(h.last_ok_at))}` : ''}. Status: ${esc(LABEL[i.status] || i.status)}${i.detail ? ' · ' + esc(i.detail) : ''}.</p>`
      : `<p class="dg-what">${esc(kindText(h))}</p>
        <dl class="dg-dl"><dt>Status</dt><dd><span class="pill ${h.status === 'blocked' ? 'blocked' : 'error'}">${h.status === 'blocked' ? 'Blocked' : 'Error'}</span></dd>
        <dt>HTTP status</dt><dd>${h.http_status ? esc(h.http_status) : '—'}</dd>
        <dt>Final URL</dt><dd class="dg-url">${h.final_url ? esc(h.final_url) : '—'}</dd>
        <dt>Last check</dt><dd>${esc(et(h.checked_at) || '—')}</dd>
        <dt>Blocked since</dt><dd>${h.blocked_at ? esc(et(h.blocked_at)) : '—'}</dd>
        <dt>Failures in a row</dt><dd>${esc(h.consecutive_failures ?? '—')}</dd>
        <dt>Detail</dt><dd>${esc(h.detail || '—')}</dd></dl>
        ${h.snippet ? `<p class="kicker" style="margin-top:12px">What the store sent (snippet)</p><pre class="dg-snip">${esc(h.snippet)}</pre>` : ''}
        <p class="kicker" style="margin-top:12px">Suggested fix</p><p class="d">${esc(fixText(h, i))}</p>`;
    $('#dg-retry').hidden = ok || !CFG; $('#dg-retry').dataset.id = id;
    sheet('#sheet-diag');
  }
  async function doRetry(id, btn) {
    const i = (state.status?.items || []).find((x) => x.id === id); if (!i) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Retrying…'; }
    try {
      const c = await rpc('rd_watch_retry', { p_key: KEY, p_id: id });
      toast('Retry sent. The box re-runs this check now…');
      const r = await waitCmd(c.id, true);
      const h = r.health;
      toast(r.builtin ? 'Built-in watcher: status refreshed (it re-checks on its own loop).' : !h || h.status === 'ok' ? `Check OK: ${LABEL[r.status] || r.status || 'done'}. Blocked flag cleared.` : `Still ${h.status === 'blocked' ? 'blocked' : 'failing'}: ${KIND_SHORT[h.kind] || h.kind}${h.http_status ? ' (HTTP ' + h.http_status + ')' : ''}.`);
      await load();
    } catch (e) { toast(e.message); }
    if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
  }
  async function doDelete(id) {
    const i = (state.status?.items || []).find((x) => x.id === id); if (!i) return;
    const ok = await confirmBox({ title: `Delete watch for ${i.name}?`, danger: true, ok: 'Delete watch',
      body: 'Alerts stop and it’s removed from your list.' + (i.builtin ? ' This is a built-in watcher: the box stops its process and won’t restart it.' : '') + ' Past alerts stay in your history.' });
    if (!ok) return;
    try {
      if (CFG) {
        const c = await rpc('rd_watch_delete', { p_key: KEY, p_id: id });
        state.status.items = state.status.items.filter((x) => x.id !== id); if (state.wdetail === id) location.hash = 'watches/list'; renderWatches();
        toast('Deleted. The box stops its checks within about 30 seconds.');
        waitCmd(c.id, true).then((r) => { toast(r.killed === false && r.builtin ? 'Watch deleted.' : 'Watch deleted and its checks stopped.'); load(); }).catch((e) => toast(e.message));
      } else { await api(`/api/items/${encodeURIComponent(id)}/delete`, {}); toast('Deleted'); load(); }
    } catch (e) { toast(e.message); }
  }
  async function favFromWatch(id) {
    const i = (state.status?.items || []).find((x) => x.id === id); if (!i) return;
    if (favFor(i)) { toast('Already in favorites'); return; }
    const st = parseStores(i), s = st.length ? selStore(i, st) : null;
    const sku = (String(i.sub || '').match(/\b(?:[A-Z0-9]{4,6}\d?[A-Z]{1,2}\/[A-Z]|(?=[A-Z0-9]*\d)[A-Z0-9]{8,})\b/) || [])[0] || (s && s.ref) || '';
    try {
      const f = await rpc('rd_fav_save', { p_key: KEY, p_fav: { name: i.name, url: safeUrl(i.link) || null, store: storeNames(i)[0] || '', sku, source: 'watch', watch_id: i.id } });
      if (!f.existing) favs.unshift(f); toast(f.existing ? 'Already in favorites' : 'Saved to favorites (the watch is unchanged)'); renderWatches(); renderFavs();
    } catch (e) { toast(e.message); }
  }

  const onWatchClick = async (e) => {
    const t = (s) => e.target.closest(s);
    const sp = t('button[data-store]'); if (sp) { storeSel[sp.dataset.store] = sp.dataset.skey; renderWatches(); return; }
    if (t('[data-wmenu]')) { const id = t('[data-wmenu]').dataset.wmenu; wMenu = wMenu === id ? null : id; renderWatches(); return; }
    if (t('[data-wdel]')) { wMenu = null; renderWatches(); doDelete(t('[data-wdel]').dataset.wdel); return; }
    if (t('[data-wfav]')) { wMenu = null; favFromWatch(t('[data-wfav]').dataset.wfav); return; }
    if (t('[data-wdiag]')) { wMenu = null; renderWatches(); openDiag(t('[data-wdiag]').dataset.wdiag); return; }
    if (t('[data-wretry]')) { doRetry(t('[data-wretry]').dataset.wretry, t('[data-wretry]')); return; }
    const b = t('button[data-act]'); if (!b) return;
    const { act, id } = b.dataset;
    if (act === 'delete') { doDelete(id); return; }
    if (act === 'pause' && !confirm('Pause this watcher? It stops checking until you resume.')) return;
    b.disabled = true;
    try { await api(`/api/items/${encodeURIComponent(id)}/${act}`, {}); toast(act === 'pause' ? 'Paused' : 'Started'); setTimeout(load, 1500); }
    catch (err) { toast(err.message); b.disabled = false; }
  };
  if (!CFG && $('#w-seg-favs')) $('#w-seg-favs').hidden = true;
  $('#watch-list').addEventListener('click', onWatchClick);
  $('#wdetail-body').addEventListener('click', onWatchClick);
  $('#wd-back').addEventListener('click', () => { location.hash = 'watches/list'; });
  document.addEventListener('click', (e) => { if (wMenu && !e.target.closest('.wmenu')) { wMenu = null; renderWatches(); } });
  $('#dg-retry').addEventListener('click', (e) => { closeSheet(); doRetry(e.currentTarget.dataset.id); });

  // ----- Favorites: search known items (your watches, alert history, comps) or paste a link; star to save. No checks start.
  async function loadFavs() {
    if (!CFG) return;
    try { favs = await rpc('rd_favs', { p_key: KEY }) || []; favsLoaded = true; renderFavs(); if (state.tab === 'watches') renderWatches(); } catch (e) { toast('Favorites: ' + e.message); }
  }
  function searchPool() {
    const out = [], seen = new Set();
    const add = (o) => { const k = (o.url || '') + '|' + o.name.toLowerCase(); if (!o.name || seen.has(k)) return; seen.add(k); out.push(o); };
    for (const i of state.status?.items || []) add({ name: i.name, url: safeUrl(i.link), store: storeNames(i)[0] || '', sku: (String(i.sub || '').match(/\b(?:[A-Z0-9]{4,6}\d?[A-Z]{1,2}\/[A-Z]|(?=[A-Z0-9]*\d)[A-Z0-9]{8,})\b/) || [])[0] || '', from: 'Watch' });
    for (const a of state.alerts) if (a.kind !== 'test') add({ name: a.item || a.title || '', url: safeUrl(a.link), store: a.store && a.store !== 'online' ? a.store : hostOf(a.link), sku: ((a.item || '').match(/\(([A-Z0-9/]{6,})\)/) || [])[1] || '', from: 'Alert ' + (a.time_et || '') });
    for (const p of state.flip?.products || []) { const w = (state.status?.items || []).find((i) => i.id === p.id); add({ name: p.name, url: w ? safeUrl(w.link) : '', store: w ? storeNames(w)[0] : '', sku: p.sku || '', from: 'Comps' }); }
    return out;
  }
  function renderFavSearch() {
    const q = ($('#fav-q').value || '').trim(), box = $('#fav-results');
    if (!q) { box.innerHTML = ''; return; }
    const res = [];
    if (/^https?:\/\/\S+$/i.test(q)) res.push({ name: hostOf(q) + ' item', url: q, store: hostOf(q), sku: '', from: 'Pasted link' });
    else if (/^[A-Z0-9]{4,6}\d?[A-Z]{1,2}\/[A-Z]$/i.test(q)) res.push({ name: 'Apple ' + q.toUpperCase(), url: 'https://www.apple.com/shop/product/' + q.toUpperCase(), store: 'Apple', sku: q.toUpperCase(), from: 'Apple part number' });
    const words = q.toLowerCase().split(/\s+/);
    res.push(...searchPool().filter((o) => words.every((w) => (o.name + ' ' + o.store + ' ' + o.sku).toLowerCase().includes(w))).slice(0, 12));
    state.favRes = res;
    box.innerHTML = res.map((o, n) => { const have = favs.some((f) => !f.promoted_at && o.url && f.url === o.url);
      return `<div class="fav-res"><div class="grow"><b>${esc(o.name)}</b><small>${esc([o.store, o.sku, o.from].filter(Boolean).join(' · '))}</small></div>
      <button type="button" class="star-btn ${have ? 'on' : ''}" data-fstar="${n}" aria-pressed="${have}" aria-label="${have ? 'In favorites' : 'Add to favorites'}: ${esc(o.name)}">${have ? '★' : '☆'}</button></div>`; }).join('') || '<p class="empty">No matching items. Paste a product link or Apple part number to save it.</p>';
  }
  function renderFavs() {
    if (!$('#fav-list')) return;
    const list = favs.filter((f) => !f.promoted_at || f.promote_state === 'pending' || f.promote_state === 'failed');
    $('#fav-count').textContent = list.length ? String(list.length) : ''; { const mf = $('#more-fav-n'); if (mf) mf.textContent = list.length ? String(list.length) : ''; }
    $('#fav-list').innerHTML = list.map((f) => {
      const pend = f.promoted_at && f.promote_state === 'pending', watched = !pend && f.url && (state.status?.items || []).some((i) => i.link === f.url);
      const failed = !watched && f.promoted_at && f.promote_state === 'failed';
      return `<div class="card fav-card">
        <div class="row">${f.image ? `<img class="fav-img" src="${esc(f.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="fav-ico" aria-hidden="true">★</span>'}<div class="grow"><p class="t">${esc(f.name)}</p>
        <p class="d">${esc([f.store, f.sku].filter(Boolean).join(' · ') || hostOf(f.url) || 'No link')}</p></div></div>
        ${f.note ? `<p class="d fav-note">${esc(f.note)}</p>` : ''}
        <p class="f">Saved ${esc(et(f.created_at))}${f.source === 'watch' ? ' · from a watch' : ''} · not being checked${pend ? ' · <b>starting watch…</b>' : ''}${failed ? ` · <span class="blk-txt">couldn’t start: ${esc(f.promote_error || 'error')}</span>` : ''}</p>
        <div class="actions">${pend ? '' : watched ? '<span class="pill active">Already a watch</span>' : `<button class="btn buy" data-fpromote="${f.id}">${failed ? 'Try again' : 'Watch this'}</button>`}${safeUrl(f.url) ? `<a class="btn" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : ''}<button class="btn" data-fnote="${f.id}">Note</button><button class="btn ghost" data-fdel="${f.id}">Remove</button></div></div>`;
    }).join('') || '<p class="empty">No favorites yet. Search above or tap ⋯ → Add to favorites on any watch. Favorites are just a saved list: nothing gets checked until you tap Watch this.</p>';
  }
  if ($('#fav-q')) {
    $('#fav-q').addEventListener('input', renderFavSearch);
    $('#fav-results').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-fstar]'); if (!b || b.classList.contains('on')) return;
      const o = state.favRes[+b.dataset.fstar]; b.disabled = true;
      try { const f = await rpc('rd_fav_save', { p_key: KEY, p_fav: { name: o.name, url: o.url || null, store: o.store, sku: o.sku, source: 'search' } }); if (!f.existing) favs.unshift(f); toast(f.existing ? 'Already in favorites' : 'Saved to favorites'); renderFavs(); renderFavSearch(); renderWatches(); }
      catch (err) { toast(err.message); b.disabled = false; }
    });
    $('#fav-list').addEventListener('click', async (e) => {
      const t = (s) => e.target.closest(s);
      if (t('[data-fdel]')) {
        const f = favs.find((x) => x.id === +t('[data-fdel]').dataset.fdel); if (!f) return;
        if (!(await confirmBox({ title: `Remove ${f.name} from favorites?`, body: 'It’s only a bookmark, so nothing else changes.', ok: 'Remove' }))) return;
        try { await rpc('rd_fav_delete', { p_key: KEY, p_id: f.id }); favs = favs.filter((x) => x.id !== f.id); toast('Removed from favorites'); renderFavs(); renderWatches(); } catch (err) { toast(err.message); }
      } else if (t('[data-fnote]')) {
        const f = favs.find((x) => x.id === +t('[data-fnote]').dataset.fnote); if (!f) return;
        const n = prompt('Note for ' + f.name, f.note || ''); if (n === null) return;
        try { Object.assign(f, await rpc('rd_fav_note', { p_key: KEY, p_id: f.id, p_note: n })); renderFavs(); } catch (err) { toast(err.message); }
      } else if (t('[data-fpromote]')) {
        const f = favs.find((x) => x.id === +t('[data-fpromote]').dataset.fpromote); if (!f) return;
        const b = t('[data-fpromote]'); b.disabled = true;
        try {
          const r = await rpc('rd_fav_promote', { p_key: KEY, p_id: f.id }); Object.assign(f, r, { promote_state: 'pending' }); renderFavs();
          toast('Starting a watch (alerts only)…');
          const res = await waitCmd(r.command.id, true);
          f.promote_state = 'done'; renderFavs();
          toast(res.item && res.item.blocked ? `Watch added, but ${res.item.site} is a known bot-wall site (marked Blocked).` : 'Now watching it. First check within a minute.');
          await load(); loadFavs();
        } catch (err) { toast(err.message); loadFavs(); }
      }
    });
  }
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
        <p class="f">${esc(a.time_et || et(a.ts))}${a.backfilled ? ' · from watcher log' : ''}${a.muted ? ' · quiet, not pushed' : a.pushed === false ? ' · push failed' : ''}</p>
        ${CFG ? soldLine(a) : ''}
        <div class="actions">${link ? (BUYNOW.has(a.source) ? `<a class="btn buy buynow" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${a.kind === 'test' ? 'Buy now (test) ↗' : 'Buy now ↗'}</a>` : `<a class="btn buy" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Buy ↗</a>`) : ''}${CFG && a.id && a.kind !== 'test' ? `<button class="btn" data-sold="${esc(a.id)}">${saleFor(a.id) || listingFor(a.id) ? 'Edit sale' : 'Mark as sold'}</button>` : ''}</div>
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
  // Themes: six looks, saved per device. The same ids live in tokens.css and the <head> script in index.html.
  const THEMES = { navy: '#070d1a', graphite: '#0b0e0d', purple: '#0c0717', ember: '#080605', light: '#f2f5fa', classic: '#030404' };
  function applyTheme(t, save = true) {
    if (!THEMES[t]) t = 'navy';
    if (save) { try { localStorage.setItem('rd-theme2', t); } catch (e) { /* private mode: theme just won't persist */ } }
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name=theme-color]').content = THEMES[t];
    document.querySelectorAll('#theme-grid [data-theme-pick]').forEach((b) => { const on = b.dataset.themePick === t; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
  }
  $('#theme-grid').addEventListener('click', (e) => { const b = e.target.closest('[data-theme-pick]'); if (b) applyTheme(b.dataset.themePick); });
  { let cur = 'navy'; try { cur = localStorage.getItem('rd-theme2') || 'navy'; } catch (e) { /* ignore */ } applyTheme(cur, false); }
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
  // Quantity: a listing holds qty units at unit_cost each (price paid + tax share + inbound shipping share). Each sale of N units is a
  // row in l.sales; COGS = N × unit_cost. These rows (plus alert sales) feed Sold and the Sales overview.
  const leftOf = (l) => l.units_left ?? (l.status === 'sold' ? 0 : 1), qtyOf = (l) => l.qty ?? 1, unitCost = (l) => +(l.unit_cost ?? l.cost);
  const unitSales = () => ext.listings.flatMap((l) => (l.sales || []).map((u) => ({ u, l })));
  const usRow = ({ u, l }) => ({ kind: 'unit', id: u.id, listing_id: l.id, item: l.item, item_type: l.item_type, platform: u.platform, platform_custom: u.platform_custom,
    price: r2(u.units * +u.price_unit), unit_price: +u.price_unit, units: u.units, cost: r2(u.units * unitCost(l)), fee_pct: +u.fee_pct, shipping: +u.shipping, when: u.sold_at, alert_id: u.alert_id, serial: u.serial });
  const unitSaleFor = (alertId) => unitSales().find(({ u }) => u.alert_id === alertId);
  const pct = (n) => (Math.round(n * 1000) / 1000).toString();
  // ================= Fee & profit calculator (Settings). Pure client-side; defaults saved in localStorage only. =================
  // Platform fee presets. Each is verified against the platform's own help page on FEES_ASOF; edit the fields in the app if a rate changes.
  //  base: what the % fee is charged on. 'item' = sale price; 'item+ship' = price + shipping the buyer pays;
  //        'total' = price + buyer shipping + buyer's sales tax (eBay "total amount of the sale", Meta "total Transaction value").
  const FEES_ASOF = 'Oct 18, 2026';
  const FEE_PRESETS = {
    // eBay: https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees?id=4822 (read Oct 18, 2026)
    //  Most categories 13.6% of the total amount of the sale (≤ $7,500) + $0.40 per order ($0.30 if the order is $10 or less).
    //  Men's/Women's Athletic Shoes: 8% and no per-order fee when the total is $150 or more; under $150 → 13.6% + per-order fee.
    //  Total amount of the sale = item price + handling + shipping charged to the buyer + sales tax + other fees.
    ebay: { label: 'eBay', base: 'total', rule: (t, cat) => cat === 'sneakers' && t >= 150 ? { pct: 8, fixed: 0 } : { pct: 13.6, fixed: t <= 10 ? 0.30 : 0.40 },
      note: 'eBay charges its % on the whole order: price + shipping the buyer pays + the buyer’s sales tax. Per-order fee $0.40 ($0.30 on orders of $10 or less). Sneakers: 8% with no per-order fee at $150+ total.' },
    // Mercari US: https://www.mercari.com/us/help_center/article/169/ (updated 05/07/2026; read Oct 18, 2026)
    //  10% selling fee on item price + buyer-paid shipping; no payment processing fee on listings since Jan 6, 2025.
    mercari: { label: 'Mercari', base: 'item+ship', rule: () => ({ pct: 10, fixed: 0 }), note: 'Mercari: 10% of item price + shipping the buyer pays. No separate processing fee. Balance withdrawal fees are not included.' },
    // Facebook local pickup: no selling fee (Meta only charges on Marketplace checkout/shipped orders).
    fb_local: { label: 'Facebook Marketplace (local, cash)', base: 'item', rule: () => ({ pct: 0, fixed: 0 }), note: 'Local pickup paid in cash/off-platform: no Facebook fee. Set your shipping to $0.' },
    // Facebook shipped: https://transparency.meta.com/policies/other-policies/terms-of-service/ → Onsite Checkout Payments Features Terms
    //  (updated Sep 23, 2025; read Oct 18, 2026): US Marketplace selling fee 10% of total transaction value, minimum $0.80.
    fb_ship: { label: 'Facebook Marketplace (shipped)', base: 'total', rule: () => ({ pct: 10, fixed: 0, min: 0.80 }), note: 'Facebook shipped: 10% of the total transaction (price + shipping + tax), $0.80 minimum.' },
    // StockX: https://stockx.com/help/articles/What-are-StockXs-fees-for-Sellers (read Oct 18, 2026): Verified Marketplace = transaction fee by
    //  Seller Level (Level 1 9% … Level 5 7%) + 3% payment processing; US minimum seller fee $5.
    //  US seller shipping fee for standard (non-Flex) sales is $5 since Mar 1, 2026: https://stockx.com/news/en-us/updates-to-the-stockx-seller-program/
    stockx: { label: 'StockX', base: 'item', rule: () => ({ pct: 12, fixed: 5, min: 5 }), note: 'StockX Level 1: 9% transaction + 3% processing = 12% (min $5), plus the $5 seller shipping fee (in Fixed). StockX gives you the label, so set your shipping to $0. Higher levels: 11.5% / 11% / 10.5% / 10%.' },
    // GOAT: https://www.goat.com/fees (last updated Aug 1, 2026; read Oct 18, 2026): 9.5% commission (seller rating 90+) + seller fee
    //  (US prepaid shipping $5, US drop-off $0); 2.9% cash-out fee on ACH/PayPal cash-outs.
    goat: { label: 'GOAT', base: 'item', rule: () => ({ pct: 9.5, fixed: 5, cashout: 2.9 }), note: 'GOAT: 9.5% commission + $5 seller fee (prepaid shipping; $0 if you drop off) + 2.9% cash-out fee on what you withdraw. Set your shipping to $0 if you use GOAT’s label.' },
    custom: { label: 'Custom', base: 'item', rule: () => ({ pct: 0, fixed: 0 }), note: 'Enter your own fee % and fixed fee.' },
  };
  const FC_LISTING = { ebay: 'ebay', mercari: 'mercari', facebook: 'fb_ship', stockx: 'stockx' };   // listing/sale form platform → preset
  const presetFor = (plat, total = 100, cat = 'general') => { const p = FEE_PRESETS[FC_LISTING[plat] || plat]; return p ? { ...p, ...p.rule(total, cat) } : null; };
  // One unit = one order. Same core formula as pnl() (price − fee − shipping − cost); with a Custom % fee and nothing else they match exactly.
  function feeMath(i) {
    const P = i.price, B = i.buyerShip;
    const tot = P + B + (i.base === 'total' ? (P + B) * i.buyerTax / 100 : 0), base = i.base === 'item' ? P : i.base === 'item+ship' ? P + B : tot;
    const rr = i.auto ? i.rule(tot, i.cat) : null, pctv = rr ? rr.pct : i.pct, fixed = rr ? rr.fixed : i.fixed, min = rr ? (rr.min || 0) : i.min, co = rr ? (rr.cashout || 0) : i.cashout;
    const fee1 = Math.max(min, base * pctv / 100) + fixed, gross = P + B, cash = Math.max(0, gross - fee1) * co / 100;
    const fees = fee1 + cash, net = gross - fees, cost = i.cost * (1 + (i.taxOn ? i.tax : 0) / 100) + i.ship + i.supplies;
    return { fees, net, cost, profit: net - cost, pct: pctv, fixed, min, cashout: co };
  }
  function solvePrice(i, want) {   // smallest price with profit ≥ want (fees are piecewise, so bisect)
    const f = (P) => feeMath({ ...i, price: P }).profit;
    if (f(0) >= want) return 0;
    let lo = 0, hi = Math.max(100, (i.cost * 1.1 + i.ship + i.supplies + Math.max(want, 0)) * 3);
    for (let n = 0; f(hi) < want && n < 30; n++) hi *= 2;
    if (f(hi) < want) return null;
    for (let n = 0; n < 60; n++) { const m = (lo + hi) / 2; if (f(m) >= want) hi = m; else lo = m; }
    return Math.ceil(hi * 100) / 100;
  }
  const fcF = () => $('#fc-form');
  const fcSaved = () => { try { return JSON.parse(localStorage.getItem('rd-calc') || '{}'); } catch (e) { return {}; } };
  let fcOverride = false;
  function fcInit() {
    const f = fcF(); if (!f) return;
    f.platform.innerHTML = Object.entries(FEE_PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
    const s = fcSaved();
    f.platform.value = FEE_PRESETS[s.platform] ? s.platform : 'ebay'; f.ebay_cat.value = s.ebay_cat || 'general';
    f.tax.value = s.tax ?? pct(TAX * 100); f.tax_on.checked = s.tax_on ?? true; f.buyer_tax.value = s.buyer_tax ?? pct(TAX * 100);
    $('#fc-asof').innerHTML = `Rates as of ${FEES_ASOF}, from each platform’s help page. Edit if they’ve changed. Each unit counts as its own order.`;
    fcApplyPreset(); fcRender();
  }
  function fcSave() { const f = fcF(); localStorage.setItem('rd-calc', JSON.stringify({ platform: f.platform.value, ebay_cat: f.ebay_cat.value, tax: f.tax.value, tax_on: f.tax_on.checked, buyer_tax: f.buyer_tax.value })); }
  function fcApplyPreset() { fcOverride = false; const f = fcF(), p = FEE_PRESETS[f.platform.value]; $('#fc-cat-wrap').hidden = f.platform.value !== 'ebay'; $('#fc-btax-wrap').hidden = p.base !== 'total'; $('#fc-feenote').textContent = p.note; }
  function fcInputs() {
    const f = fcF(), p = FEE_PRESETS[f.platform.value], v = (el, d = 0) => { const n = num(el.value); return isFinite(n) ? n : d; };
    return { base: p.base, rule: p.rule, cat: f.ebay_cat.value, auto: !fcOverride, price: v(f.price), qty: Math.max(1, Math.round(v(f.qty, 1))), cost: v(f.cost),
      taxOn: f.tax_on.checked, tax: v(f.tax, TAX * 100), ship: v(f.ship), supplies: v(f.supplies), buyerShip: v(f.buyer_ship), buyerTax: p.base === 'total' ? v(f.buyer_tax, 0) : 0,
      pct: v(f.fee_pct), fixed: v(f.fee_fixed), min: v(f.fee_min), cashout: v(f.cashout), target: num(f.target.value) };
  }
  function fcRender() {
    const f = fcF(); if (!f) return;
    const i = fcInputs(), r = feeMath(i), q = i.qty, has = num(f.price.value) > 0 || num(f.cost.value) > 0;
    if (!fcOverride) { f.fee_pct.value = pct(r.pct); f.fee_fixed.value = r.fixed ? r.fixed.toFixed(2) : '0'; f.fee_min.value = r.min ? r.min.toFixed(2) : '0'; f.cashout.value = pct(r.cashout); }
    const be = solvePrice(i, 0), tgt = isFinite(i.target) ? solvePrice(i, i.target / q) : undefined, sale = i.price * q, cost = r.cost * q, profit = r.profit * q;
    const pctTxt = (a, b) => b > 0 ? (a / b * 100).toFixed(1) + '%' : '—';
    $('#fc-out').innerHTML = !has ? '<p class="hint">Enter a sale price and what you paid to see fees and profit.</p>' : `
      <div class="fc-hero ${profit >= 0 ? 'pos' : 'neg'}"><small>Profit${q > 1 ? ` (${q} units)` : ''}</small><b>${money(r2(profit))}</b><span>margin ${pctTxt(profit, sale)} · ROI ${pctTxt(profit, cost)}</span></div>
      <div class="mgrid fc-grid">
        <div><small>Platform fees</small><b>${r.fees > 0 ? '−' : ''}${money(r2(r.fees * q))}</b></div>
        <div><small>Net payout</small><b>${money(r2(r.net * q))}</b></div>
        <div><small>Total cost</small><b>${money(r2(cost))}</b></div>
        <div><small>Margin</small><b class="${cls(profit)}">${pctTxt(profit, sale)}</b></div>
        <div><small>ROI</small><b class="${cls(profit)}">${pctTxt(profit, cost)}</b></div>
        <div><small>Break-even price</small><b>${be == null ? '—' : money(be)}</b></div>
        ${tgt !== undefined ? `<div class="wide"><small>Price for ${money(i.target)} profit</small><b>${tgt == null ? '—' : money(tgt) + (q > 1 ? ' each' : '')}</b></div>` : ''}
      </div>
      <p class="f">Fees: ${esc(pct(r.pct))}%${r.min ? ` (min ${money(r.min)})` : ''}${r.fixed ? ` + ${money(r.fixed)}/order` : ''}${r.cashout ? ` + ${esc(pct(r.cashout))}% cash-out` : ''}${i.base === 'total' ? ` on price + buyer shipping + ${esc(pct(i.buyerTax))}% buyer tax` : i.base === 'item+ship' ? ' on price + buyer shipping' : ' on the sale price'}. Total cost = item${i.taxOn ? ` + ${esc(pct(i.tax))}% tax` : ''} + your shipping + supplies${q > 1 ? ', per unit × ' + q : ''}.</p>`;
  }
  if (fcF()) {
    fcInit();
    fcF().addEventListener('input', (e) => {
      const n = e.target.name;
      if (['fee_pct', 'fee_fixed', 'fee_min', 'cashout'].includes(n)) fcOverride = true;
      if (n === 'platform' || n === 'ebay_cat') fcApplyPreset();
      if (['platform', 'ebay_cat', 'tax', 'tax_on', 'buyer_tax'].includes(n)) fcSave();
      fcRender();
    });
    fcF().platform.addEventListener('change', () => { fcApplyPreset(); fcSave(); fcRender(); });
    $('#fc-preset').addEventListener('click', () => { fcApplyPreset(); fcRender(); });
    $('#fc-reset').addEventListener('click', () => { const f = fcF(); ['item', 'price', 'qty', 'cost', 'ship', 'supplies', 'buyer_ship', 'target'].forEach((k) => (f[k].value = '')); fcApplyPreset(); fcRender(); });
    window.rdFeeMath = { feeMath, solvePrice, FEE_PRESETS };   // exposed for the test harness only (no data)
  }
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
  const need = () => { if (!CFG) throw new Error('Listings and countdowns need the hosted app link.'); if (!KEY && !TOKEN) throw new Error('Access key missing. Open the full link with ?key= once.'); };
  // friend sessions use the scoped rd_f_* RPCs (server forces their own member and only returns their own rows)
  const FRIEND_FN = { rd_scan_submit: 'rd_f_scan_submit', rd_scan_get: 'rd_f_scan_get', rd_phone_save: 'rd_f_phone_save', rd_phone_photo: 'rd_f_phone_photo' };
  const call = async (fn, args) => {
    need();
    if (TOKEN) { const f = FRIEND_FN[fn]; if (!f) throw new Error('Not available on a friend account');
      const a = { ...args }; delete a.p_member_id; if (fn === 'rd_phone_save') delete a.p_id; return rpc(f, { p_token: TOKEN, ...a }); }
    return rpc(fn, { p_key: KEY, ...args });
  };
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
    const rows = ext.listings.filter((l) => leftOf(l) > 0);
    $('#listing-list').innerHTML = rows.map((l) => {
      const r = pnl(+l.price, +l.fee_pct, +l.shipping, unitCost(l)), q = qtyOf(l), left = leftOf(l), sold = (l.sales || []);
      const soldProfit = r2(sold.reduce((a, u) => a + +u.profit, 0));
      return `<div class="card">
        <div class="row"><p class="t grow">${esc(l.item)}</p><span class="pill ${left ? 'active' : 'sold'} qpill">${left ? `${left} of ${q} left` : 'Sold out'}</span></div>
        <p class="d">${esc(platName(l))} · fee ${esc(pct(+l.fee_pct))}% · listed ${esc(et(l.created_at))}${q > 1 ? ` · ${q} units at ${money(unitCost(l))} each` : ''}</p>
        <div class="mgrid"><div><small>List price${q > 1 ? ' / unit' : ''}</small><b>${money(+l.price)}</b></div><div><small>Fee</small><b>−${money(r.fee)}</b></div><div><small>Shipping</small><b>${+l.shipping ? '−' + money(+l.shipping) : money(0)}</b></div>
          <div><small>Net payout</small><b>${money(r.net)}</b></div><div><small>Cost${q > 1 ? ' / unit' : ' paid'}</small><b>${money(unitCost(l))}</b></div><div class="big"><small>Profit${q > 1 ? ' / unit' : ''}</small><b class="${cls(r.profit)}">${money(r.profit)}</b></div></div>
        ${sold.length ? `<p class="sold-line">Sold ${l.units_sold} so far · profit <span class="${cls(soldProfit)}">${money(soldProfit)}</span></p>` : ''}
        ${l.notes ? `<p class="f">${esc(l.notes)}</p>` : ''}
        ${priceLine(priceRow('listing', l.id), +l.cost)}
        <div class="actions"><button class="btn buy" data-lsold="${l.id}">Record sale</button><button class="btn" data-ledit="${l.id}">Edit</button><button class="btn ghost danger" data-ldel="${l.id}">Delete</button></div>
      </div>`;
    }).join('') || `<p class="empty">${ext.listings.length ? 'Nothing left in stock. Sold ones are under Sold.' : 'No listings yet. Tap + New listing.'}</p>`;
    renderSold();
  }
  // Sold history: each unit sale from a listing + alerts marked sold
  function renderSold() {
    const rows = [...unitSales().map(usRow), ...ext.sales.map((x) => ({ kind: 'sale', ...x, when: x.sold_at }))].sort((a, b) => String(b.when).localeCompare(String(a.when)));
    $('#sold-list').innerHTML = rows.map((r) => { const m = pnl(+r.price, +r.fee_pct, +r.shipping, +r.cost), L = r.kind === 'unit' ? ext.listings.find((l) => l.id === r.listing_id) : null;
      return `<div class="card"><div class="row"><p class="t grow">${esc(r.item)}</p><span class="pill sold">${r.alert_id ? 'From alert' : 'Listing'}</span></div>
        <p class="d">${r.kind === 'unit' && (r.units > 1 || qtyOf(L) > 1) ? `${r.units} × ${money(r.unit_price)} · ` : ''}${esc(platName(r))} · fee ${esc(pct(+r.fee_pct))}% · sold ${esc(et(r.when))}${L && qtyOf(L) > 1 ? ` · ${leftOf(L) ? leftOf(L) + ' of ' + qtyOf(L) + ' left' : 'sold out'}` : ''}${r.serial ? ' · SN ' + esc(r.serial) : ''}</p>
        <div class="mgrid"><div><small>Sale</small><b>${money(+r.price)}</b></div><div><small>Fees + ship</small><b>−${money(r2(m.fee + +r.shipping))}</b></div><div class="big"><small>Profit</small><b class="${cls(m.profit)}">${money(m.profit)}</b></div></div>
        <div class="actions"><button class="btn" data-sedit="${r.kind}:${r.kind === 'sale' ? r.alert_id || '' : r.id}">Edit</button></div></div>`; }).join('') || '<p class="empty">No sales yet. Tap Record sale on a listing, or “Mark as sold” on an alert.</p>';
  }
  $('#sold-list').addEventListener('click', (e) => { const b = e.target.closest('[data-sedit]'); if (!b) return; const [k, id] = b.dataset.sedit.split(':');
    if (k === 'unit') { const x = unitSales().find(({ u }) => u.id === +id); if (x) openUnitSale(x.l, x.u); }
    else { const s = ext.sales.find((x) => x.alert_id === id); const a = state.alerts.find((x) => x.id === id) || { id, item: s?.item, ts: s?.sold_at }; openSale(a); } });
  // ---------- Record a sale of N units from a listing (quantity / inventory)
  let usCtx = null;
  function usaleCalc() {
    const f = $('#usale-form'); if (!usCtx) return; const L = usCtx.l, n = Math.round(num(f.units.value)), pu = num(f.price_unit.value);
    if (!(n >= 1) || !isFinite(pu)) { $('#su-calc').innerHTML = ''; return; }
    const ship = f.shipping.value.trim() === '' ? 0 : num(f.shipping.value), rev = r2(n * pu), cogs = r2(n * unitCost(L)), r = pnl(rev, num(f.fee_pct.value) || 0, ship || 0, cogs);
    $('#su-calc').innerHTML = `<div class="mgrid"><div><small>Revenue</small><b>${money(rev)}</b></div><div><small>Fee</small><b>−${money(r.fee)}</b></div><div><small>Shipping</small><b>${ship ? '−' + money(ship) : money(0)}</b></div>
      <div><small>Cost (${n} × ${money(unitCost(L))})</small><b>−${money(cogs)}</b></div><div><small>Margin</small><b class="${cls(r.profit)}">${rev > 0 ? (r.profit / rev * 100).toFixed(1) + '%' : '—'}</b></div><div class="big"><small>Profit</small><b class="${cls(r.profit)}">${money(r.profit)}</b></div></div>`;
  }
  function openUnitSale(L, u) {
    const f = $('#usale-form'); f.reset(); usCtx = { l: L, u: u || null };
    const max = leftOf(L) + (u ? u.units : 0);
    $('#su-title').textContent = u ? 'Edit sale' : 'Record sale';
    $('#su-sub').textContent = `${L.item} · ${leftOf(L)} of ${qtyOf(L)} left · cost ${money(unitCost(L))} per unit`;
    f.units.value = u ? u.units : 1; f.units.dataset.max = max;
    f.price_unit.value = u ? (+u.price_unit).toFixed(2) : (+L.price ? (+L.price).toFixed(2) : '');
    f.platform.value = u ? u.platform : L.platform; f.platform_custom.value = u ? (u.platform_custom || '') : (L.platform_custom || '');
    f.fee_pct.value = pct(u ? +u.fee_pct : +L.fee_pct); f.shipping.value = u ? (+u.shipping ? (+u.shipping).toFixed(2) : '') : (+L.shipping ? (+L.shipping).toFixed(2) : '');
    f.shipping.dataset.auto = u ? '' : '1'; f.serial.value = u ? (u.serial || '') : ''; f.notes.value = u ? (u.notes || '') : '';
    $('#su-serials').innerHTML = (ph.phones || []).filter((p) => p.serial).slice(0, 300).map((p) => `<option value="${esc(p.serial)}">${esc([p.item_name || p.model, p.color, p.storage].filter(Boolean).join(' '))}</option>`).join('');
    $('#su-chips').hidden = max <= 1; $('#su-delete').hidden = !u; $('#su-msg').textContent = ''; $('#su-feehint').textContent = `Fee prefilled from the listing (${pct(+L.fee_pct)}%). Shipping is the total for this sale.`;
    otherToggle(f); usaleCalc(); sheet('#sheet-usale');
  }
  $('#su-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-u]'); if (!b) return; const f = $('#usale-form'); f.units.value = b.dataset.u === 'all' ? f.units.dataset.max : 1; f.units.dispatchEvent(new Event('input', { bubbles: true })); });
  $('#usale-form').addEventListener('input', (e) => { const f = e.currentTarget;
    if (e.target.name === 'shipping') f.shipping.dataset.auto = '';
    if (e.target.name === 'units' && f.shipping.dataset.auto === '1' && usCtx && +usCtx.l.shipping) { const n = Math.round(num(f.units.value)); if (n >= 1) f.shipping.value = (n * +usCtx.l.shipping).toFixed(2); }
    usaleCalc(); });
  $('#usale-form').platform.addEventListener('change', (e) => { const f = e.target.form; otherToggle(f); f.fee_pct.value = ''; presetFee(f, $('#su-feehint')); usaleCalc(); });
  $('#usale-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.currentTarget, msg = $('#su-msg'), L = usCtx.l, max = +f.units.dataset.max;
    const n = num(f.units.value), pu = num(f.price_unit.value), fee = num(f.fee_pct.value), ship = f.shipping.value.trim() === '' ? 0 : num(f.shipping.value);
    const err = !(n >= 1) || n !== Math.round(n) ? 'Units sold must be a whole number, 1 or more.' : n > max ? `Only ${max} left to sell.` : !isFinite(pu) || pu < 0 ? 'Enter the sale price per unit.' :
      feeErr(fee) || (!isFinite(ship) || ship < 0 ? 'Shipping must be 0 or more.' : (f.platform.value === 'other' && !f.platform_custom.value.trim()) ? 'Type the platform name for Local / Other.' : '');
    if (err) { msg.textContent = err; return; }
    const btn = f.querySelector('[type=submit]'); btn.disabled = true; msg.textContent = 'Saving…';
    try {
      const sale = { units: n, price_unit: pu, fee_pct: fee, shipping: ship, platform: f.platform.value, platform_custom: f.platform_custom.value, serial: f.serial.value.trim(), notes: f.notes.value };
      if (usCtx.u) { sale.alert_id = usCtx.u.alert_id; sale.sold_at = usCtx.u.sold_at; }
      const nl = await call('rd_unit_sale_save', { p_listing_id: L.id, p_sale: sale, p_id: usCtx.u ? usCtx.u.id : null });
      const i = ext.listings.findIndex((x) => x.id === L.id); if (i >= 0 && nl) ext.listings[i] = { ...ext.listings[i], ...nl };
      closeSheet(); toast(nl && nl.units_left === 0 ? `${L.item} is sold out` : `Sale saved · ${nl ? nl.units_left : ''} left`); await refreshExt();
    } catch (er) { msg.textContent = er.message || 'Couldn’t save the sale.'; } finally { btn.disabled = false; }
  });
  $('#su-delete').addEventListener('click', async () => {
    if (!usCtx?.u) return; if (!(await confirmBox({ title: 'Delete this sale?', body: 'The units go back into stock. This can’t be undone.', ok: 'Delete', danger: true }))) return;
    try { await call('rd_unit_sale_delete', { p_id: usCtx.u.id }); closeSheet(); toast('Sale deleted'); await refreshExt(); } catch (er) { $('#su-msg').textContent = er.message || 'Couldn’t delete.'; }
  });
  // ---------- Sales overview (Stripe-style): range picker drives 3 cards, dotted line chart (+ dashed estimate) and the revenue→net waterfall
  let sdMetric = 'rev', sdSel = null, sdType = null;
  const SD_LABEL = { rev: 'Revenue', profit: 'Net profit', fee: 'Fees', cost: 'Cost', ship: 'Shipping' };
  const soldRows = () => [...unitSales().map(usRow), ...ext.sales.map((x) => ({ ...x, when: x.sold_at }))].filter((x) => x.when);
  const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const dLab = (k) => dayLabel.format(new Date(k + 'T12:00:00Z'));
  const addDays = (k, n) => new Date(Date.parse(k + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  function renderTracker() {
    if (!$('#sd-cards')) return;
    const today = etKey(new Date()), from = trackerPeriod === 'all' ? '' : addDays(today, -(+trackerPeriod - 1));
    const allT = soldRows(), present = [...new Set(allT.map(typeOfSale))];
    $('#sd-types').innerHTML = present.length ? [`<button type="button" class="spill ${sdType === null ? 'on' : ''}" data-stype="">All types</button>`, ...[...ITEM_TYPES.map((t) => t.id).filter((id) => present.includes(id)), ...present.filter((id) => !ITEM_TYPES.some((t) => t.id === id))]
      .map((id) => `<button type="button" class="spill ${sdType === id ? 'on' : ''}" data-stype="${esc(id)}">${esc(itemType(id).label)}</button>`)].join('') : '';
    const all = allT.filter((x) => sdType === null || typeOfSale(x) === sdType), rows = all.filter((x) => etKey(new Date(x.when)) >= from);
    const t = rows.reduce((a, x) => { const r = pnl(+x.price, +x.fee_pct, +x.shipping, +x.cost); a.rev += +x.price; a.fee += r.fee; a.ship += +x.shipping; a.cost += +x.cost; a.profit += r.profit; return a; }, { rev: 0, fee: 0, ship: 0, cost: 0, profit: 0 });
    Object.keys(t).forEach((k) => (t[k] = r2(t[k])));
    const active = ext.listings.filter((l) => leftOf(l) > 0 && (sdType === null || typeOfSale(l) === sdType)), unsoldCost = r2(active.reduce((a, l) => a + unitCost(l) * leftOf(l), 0)), unsoldN = active.reduce((a, l) => a + leftOf(l), 0);
    const n = rows.length, rangeTxt = trackerPeriod === 'all' ? 'all time' : `last ${trackerPeriod} days`;
    $('#sd-cards').innerHTML = `<div class="sd-card"><small>Money invested</small><b>${money(t.cost)}</b><span>item cost of ${n} sale${n === 1 ? '' : 's'}${unsoldN ? ` · +${money(unsoldCost)} in ${unsoldN} unsold unit${unsoldN === 1 ? '' : 's'}` : ''}</span></div>
      <div class="sd-card"><small>Money made</small><b>${money(t.rev)}</b><span>net profit <b class="${cls(t.profit)}" style="display:inline;font-size:inherit">${money(t.profit)}</b></span></div>
      <div class="sd-card"><small>Money lost</small><b>${money(r2(t.fee + t.ship))}</b><span>fees ${money(t.fee)} · shipping ${money(t.ship)}</span></div>`;
    // daily buckets (ET) for the chart; each dot = a day with real sales
    const byDay = new Map();
    for (const x of rows) { const k = etKey(new Date(x.when)), r = pnl(+x.price, +x.fee_pct, +x.shipping, +x.cost), d = byDay.get(k) || { k, n: 0, rev: 0, fee: 0, cost: 0, ship: 0, profit: 0 };
      d.n++; d.rev += +x.price; d.fee += r.fee; d.cost += +x.cost; d.ship += +x.shipping; d.profit += r.profit; byDay.set(k, d); }
    const pts = [...byDay.values()].sort((a, b) => a.k.localeCompare(b.k)).map((d) => ({ ...d, rev: r2(d.rev), fee: r2(d.fee), cost: r2(d.cost), ship: r2(d.ship), profit: r2(d.profit) }));
    $('#sd-chart-title').textContent = `${SD_LABEL[sdMetric]} over time · ${sdType ? itemType(sdType).label.toLowerCase() + ' · ' : ''}${rangeTxt}`;
    renderChart(pts, projection(all, active, today));
    // waterfall: revenue − fees − cost − shipping = net profit
    if (!n) { $('#sd-break').innerHTML = `<p class="sd-empty">No sales in this range yet. Mark a listing or alert sold and it shows up here.</p>`; return; }
    const lo = Math.min(0, t.profit), hi = Math.max(t.rev, 0.01), sc = (v) => ((v - lo) / (hi - lo)) * 100;
    let run = t.rev; const steps = [['Revenue', 'rev', 0, t.rev, t.rev]];
    for (const [lab, v] of [['Platform fees', t.fee], ['Item cost', t.cost], ['Shipping', t.ship]]) { steps.push([lab, 'neg', run - v, run, -v]); run = r2(run - v); }
    steps.push(['Net profit', 'net' + (t.profit < 0 ? ' loss' : ''), Math.min(0, t.profit), Math.max(0, t.profit), t.profit]);
    $('#sd-break').innerHTML = `<div class="wf">${steps.map(([lab, c, a, b, v]) => `<div class="wf-row ${c}"><span>${lab}</span><div class="wf-track"><i style="left:${sc(Math.min(a, b)).toFixed(2)}%;width:${Math.max(0.8, sc(Math.max(a, b)) - sc(Math.min(a, b))).toFixed(2)}%"></i></div><b class="${c.startsWith('net') ? cls(v) : ''}">${c === 'neg' ? '−' + money(-v) : money(v)}</b></div>`).join('')}</div>`;
  }
  // Estimate: unsold active listings, priced at recent real sale prices (same item name if sold before, else its own list price), spaced at the recent sale cadence.
  function projection(all, active, today) {
    const recent = all.filter((x) => etKey(new Date(x.when)) >= addDays(today, -89)).sort((a, b) => String(a.when).localeCompare(String(b.when)));
    if (recent.length < 3 || !active.length) return null;
    const days = (Date.parse(recent[recent.length - 1].when) - Date.parse(recent[0].when)) / 86400000, gap = Math.max(1, days / (recent.length - 1));
    const avgOf = (item) => { const m = recent.filter((x) => x.item.trim().toLowerCase() === item.trim().toLowerCase()); return m.length ? m.reduce((a, x) => a + (x.unit_price ?? +x.price), 0) / m.length : null; };   // per-unit price
    const out = []; let k = today;
    active.slice(0, 8).forEach((l, i) => { const n = leftOf(l), price = r2((avgOf(l.item) ?? +l.price) * n), cost = r2(unitCost(l) * n), ship = r2(+l.shipping * n), r = pnl(price, +l.fee_pct, ship, cost); k = addDays(today, Math.round(gap * (i + 1)));
      out.push({ k, n, est: true, item: l.item, rev: price, fee: r.fee, cost, ship, profit: r.profit }); });
    return { pts: out, gap: r2(gap), count: active.length };
  }
  function renderChart(pts, proj) {
    const el = $('#sd-chart');
    if (!pts.length) { el.innerHTML = `<p class="sd-empty">No sales in this range yet. Real sales only; nothing is made up.</p>`; return; }
    const m = sdMetric, P = (proj && ['rev', 'profit'].includes(m)) ? proj.pts : [];
    const W = Math.max(300, Math.round(el.clientWidth || 340)), H = 210, L = 44, R = 12, T = 22, B = 26;
    const keys = [...pts.map((p) => p.k), ...P.map((p) => p.k)], t0 = Date.parse(keys[0] + 'T12:00:00Z'), t1 = Date.parse(keys[keys.length - 1] + 'T12:00:00Z');
    const vals = [...pts, ...P].map((p) => p[m]); let vmin = Math.min(0, ...vals), vmax = Math.max(...vals, 0);
    if (vmax === vmin) vmax = vmin + 1; const pad = (vmax - vmin) * 0.12; vmax += pad; if (vmin < 0) vmin -= pad;
    const x = (k) => t1 === t0 ? (L + (W - L - R) / 2) : L + ((Date.parse(k + 'T12:00:00Z') - t0) / (t1 - t0)) * (W - L - R);
    const y = (v) => T + (1 - (v - vmin) / (vmax - vmin)) * (H - T - B);
    const ticks = [0, 1, 2, 3].map((i) => vmin + (vmax - vmin) * i / 3);
    const xl = [...new Set([keys[0], keys[Math.floor((keys.length - 1) / 2)], keys[keys.length - 1]])];
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.k).toFixed(1)},${y(p[m]).toFixed(1)}`).join('');
    const area = pts.length > 1 ? `${line}L${x(pts[pts.length - 1].k).toFixed(1)},${y(Math.max(vmin, 0)).toFixed(1)}L${x(pts[0].k).toFixed(1)},${y(Math.max(vmin, 0)).toFixed(1)}Z` : '';
    const last = pts[pts.length - 1], pline = P.length ? `M${x(last.k).toFixed(1)},${y(last[m]).toFixed(1)}` + P.map((p) => `L${x(p.k).toFixed(1)},${y(p[m]).toFixed(1)}`).join('') : '';
    let hiI = -1, loI = -1; if (pts.length > 1) { hiI = 0; loI = 0; pts.forEach((p, i) => { if (p[m] > pts[hiI][m]) hiI = i; if (p[m] < pts[loI][m]) loI = i; }); if (pts[hiI][m] === pts[loI][m]) { hiI = -1; loI = -1; } }
    const tagX = (k) => Math.min(W - R - 4, Math.max(L + 4, x(k)));
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(SD_LABEL[m])} by day">
      <defs><linearGradient id="sdfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="rgb(var(--accent-rgb))" stop-opacity=".22"/><stop offset="1" stop-color="rgb(var(--accent-rgb))" stop-opacity="0"/></linearGradient></defs>
      <g class="grid">${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`).join('')}</g>
      <g class="axis">${ticks.map((v) => `<text x="${L - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${esc(short$(v))}</text>`).join('')}
        ${xl.map((k) => `<text x="${x(k).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(dLab(k))}</text>`).join('')}</g>
      ${area ? `<path class="area" d="${area}"/>` : ''}<path class="ln" d="${line}"/>${pline ? `<path class="proj" d="${pline}"/>` : ''}
      ${P.length ? `<text class="tag pj" x="${tagX(P[P.length - 1].k)}" y="${(y(P[P.length - 1][m]) - 10).toFixed(1)}" text-anchor="end">Estimate</text>` : ''}
      ${hiI >= 0 ? `<text class="tag" x="${tagX(pts[hiI].k)}" y="${(y(pts[hiI][m]) - 10).toFixed(1)}" text-anchor="middle">High ${esc(short$(pts[hiI][m]))}</text>` : ''}
      ${loI >= 0 ? `<text class="tag lo" x="${tagX(pts[loI].k)}" y="${(y(pts[loI][m]) + 18).toFixed(1)}" text-anchor="middle">Low ${esc(short$(pts[loI][m]))}</text>` : ''}
      ${P.map((p, i) => `<circle class="pt pj" cx="${x(p.k).toFixed(1)}" cy="${y(p[m]).toFixed(1)}" r="3.5" data-pi="p${i}"/>`).join('')}
      ${pts.map((p, i) => `<circle class="pt${i === hiI ? ' hi' : ''}${i === loI ? ' lo' : ''}" cx="${x(p.k).toFixed(1)}" cy="${y(p[m]).toFixed(1)}" r="${i === hiI || i === loI ? 5.5 : 4}" data-pi="${i}"/>`).join('')}
      ${[...pts.map((p, i) => [p, String(i)]), ...P.map((p, i) => [p, 'p' + i])].map(([p, id]) => `<circle class="hit" cx="${x(p.k).toFixed(1)}" cy="${y(p[m]).toFixed(1)}" r="14" data-pi="${id}"/>`).join('')}
    </svg><div class="sd-tip" hidden></div>
    ${P.length ? `<p class="hint">Dashed line = estimate, not real sales: ${proj.count} unsold listing${proj.count === 1 ? '' : 's'} at recent real sale prices, one about every ${proj.gap} day${proj.gap === 1 ? '' : 's'}.</p>` : (proj === null && ['rev', 'profit'].includes(m) ? '<p class="hint">Estimate appears once there are 3+ sales in the last 90 days and at least one active listing.</p>' : '')}`;
    const tip = el.querySelector('.sd-tip'), svg = el.querySelector('svg');
    const showTip = (id) => { const p = id.startsWith('p') ? P[+id.slice(1)] : pts[+id]; if (!p) return; const c = svg.querySelector(`circle.pt[data-pi="${id}"]`);
      svg.querySelectorAll('circle.pt.sel').forEach((n) => n.classList.remove('sel')); c.classList.add('sel');
      const bx = svg.getBoundingClientRect(), cb = c.getBoundingClientRect(), eb = el.getBoundingClientRect();
      tip.style.top = (cb.top - eb.top) + 'px';
      tip.innerHTML = `<small>${p.est ? 'Estimate · ' + esc(p.item) + ' · ' : ''}${esc(dLab(p.k))}${p.est ? '' : ` · ${p.n} sale${p.n === 1 ? '' : 's'}`}</small><b>${esc(SD_LABEL[m])} ${money(p[m])}</b>
        <small>Revenue ${money(p.rev)} · Fees ${money(p.fee)}</small><small>Cost ${money(p.cost)} · Ship ${money(p.ship)} · Net ${money(p.profit)}</small>`; tip.hidden = false; const half = tip.offsetWidth / 2; tip.style.left = Math.min(eb.width - half, Math.max(half, cb.left - eb.left + cb.width / 2)) + 'px'; sdSel = id; void bx; };
    svg.addEventListener('pointerover', (e) => { const c = e.target.closest('[data-pi]'); if (c) showTip(c.dataset.pi); });
    svg.addEventListener('click', (e) => { const c = e.target.closest('[data-pi]'); if (c) showTip(c.dataset.pi); else { tip.hidden = true; svg.querySelectorAll('circle.pt.sel').forEach((n) => n.classList.remove('sel')); } });
    svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') tip.hidden = true; });
  }
  const short$ = (v) => { const a = Math.abs(v), sg = v < 0 ? '−' : ''; return sg + '$' + (a >= 10000 ? (a / 1000).toFixed(0) + 'k' : a >= 1000 ? (a / 1000).toFixed(1) + 'k' : a.toFixed(0)); };
  $('#tracker-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; trackerPeriod = b.dataset.p; document.querySelectorAll('#tracker-seg button').forEach((x) => x.classList.toggle('on', x === b)); renderTracker(); });
  $('#sd-types').addEventListener('click', (e) => { const b = e.target.closest('[data-stype]'); if (!b) return; sdType = b.dataset.stype || null; renderTracker(); });
  $('#sd-metric').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; sdMetric = b.dataset.m; document.querySelectorAll('#sd-metric button').forEach((x) => x.classList.toggle('on', x === b)); renderTracker(); });
  const setStatus = (s) => document.querySelectorAll('#sl-status button').forEach((b) => b.classList.toggle('on', b.dataset.s === s));
  const curStatus = () => $('#sl-status button.on').dataset.s;
  $('#sl-status').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { setStatus(b.dataset.s); } });
  // listing form: quantity + per-unit/total cost entry (+ optional tax % and inbound shipping) → per-unit cost basis
  let costMode = 'unit';
  function listingNums() {
    const f = $('#listing-form'), q = Math.round(num(f.qty.value)) || 1, c = num(f.cost.value), tx = f.tax_pct.value.trim() === '' ? 0 : num(f.tax_pct.value), ins = f.in_ship.value.trim() === '' ? 0 : num(f.in_ship.value);
    const per = costMode === 'total' ? c / q : c, basis = per * (1 + (isFinite(tx) ? tx : 0) / 100) + (isFinite(ins) ? ins : 0) / q;
    return { q, per, tx, ins, basis };
  }
  function listingCalc() {
    const f = $('#listing-form'), n = listingNums();
    $('#sl-costsum').innerHTML = isFinite(n.per) ? `Total cost <b>${money(r2(n.basis * n.q))}</b> · <b>${money(r2(n.basis))}</b> per unit${n.tx || n.ins ? ' (incl. tax / inbound shipping)' : ''}` : '';
    $('#sl-calc').innerHTML = (n.q > 1 ? '<p class="hint">Per unit, at the list price:</p>' : '') + calcHtml(num(f.price.value), num(f.fee_pct.value), num(f.shipping.value), n.basis);
  }
  const setCostMode = (m) => { costMode = m; document.querySelectorAll('#sl-costmode button').forEach((b) => b.classList.toggle('on', b.dataset.m === m)); $('#sl-cost-lbl').textContent = m === 'total' ? 'Total paid for all units ($)' : 'Cost per unit ($)'; listingCalc(); };
  $('#sl-costmode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; const f = $('#listing-form'), n = listingNums();
    if (b.dataset.m !== costMode && isFinite(n.per)) f.cost.value = (b.dataset.m === 'total' ? n.per * n.q : n.per).toFixed(2); setCostMode(b.dataset.m); });
  const typeOpts = (sel) => { sel.innerHTML = ITEM_TYPES.map((t) => `<option value="${t.id}">${esc(t.label.replace(/s$/, ''))}</option>`).join(''); };
  typeOpts($('#listing-form').item_type); typeOpts($('#sale-form').item_type);
  $('#listing-form').item.addEventListener('input', (e) => { const f = e.target.form; if (!f.item_type.dataset.touched) f.item_type.value = guessType(e.target.value); });
  $('#sale-form').item.addEventListener('input', (e) => { const f = e.target.form; if (!f.item_type.dataset.touched) f.item_type.value = guessType(e.target.value); });
  ['#listing-form', '#sale-form'].forEach((id) => $(id).item_type.addEventListener('change', (e) => { e.target.dataset.touched = '1'; }));
  const tagType = (kind, id, t) => id ? call('rd_set_item_type', { p_kind: kind, p_id: id, p_type: t }).catch((x) => toast('Type not saved: ' + x.message)) : null;
  function openListing(l, sold) {
    if (sold && l) { openUnitSale(l); return; }
    listingEdit = l || null; const f = $('#listing-form'); f.reset(); delete f.item_type.dataset.touched;
    $('#sl-title').textContent = l ? 'Edit listing' : 'New listing';
    f.item.value = l ? l.item : ''; f.platform.value = l ? l.platform : ''; f.platform_custom.value = l ? (l.platform_custom || '') : '';
    f.fee_pct.value = l ? pct(+l.fee_pct) : ''; f.cost.value = l ? (+l.cost).toFixed(2) : ''; f.price.value = l ? (+l.price).toFixed(2) : '';
    f.shipping.value = l && +l.shipping ? (+l.shipping).toFixed(2) : ''; f.notes.value = l ? (l.notes || '') : '';
    f.qty.value = l ? qtyOf(l) : '1'; f.tax_pct.value = l && +l.tax_pct ? pct(+l.tax_pct) : ''; f.in_ship.value = l && +l.in_ship ? (+l.in_ship).toFixed(2) : ''; setCostMode('unit');
    $('#sl-qtyhint').textContent = l && l.units_sold ? `${l.units_sold} sold so far, so quantity can’t go below ${l.units_sold}.` : 'Each unit can be sold separately. Default 1.';
    f.item_type.value = l ? typeOfSale(l) : 'other';
    setStatus(sold ? 'sold' : l ? l.status : 'active');
    const p = l && priceRow('listing', l.id); f.drop_alert.checked = !!(p && p.alert_on);
    $('#sl-price').innerHTML = (p && p.market_value != null) ? priceLine(p, +l.cost) : 'Uses your cost paid as the buy-in. No price source yet, so nothing is checked until one is added.';
    $('#sl-delete').hidden = !l; $('#sl-msg').textContent = ''; otherToggle(f); if (f.platform.value) presetFee(f, $('#sl-feehint')); listingCalc(); sheet('#sheet-listing');
  }
  $('#listing-new').addEventListener('click', () => openListing(null));
  $('#listing-form').addEventListener('input', listingCalc);
  $('#listing-form').platform.addEventListener('change', (e) => { otherToggle(e.target.form); presetFee(e.target.form, $('#sl-feehint')); listingCalc(); });
  // Fee presets from the calculator: fill an empty fee % for the chosen platform (still editable)
  function presetFee(f, hintEl) {
    const p = presetFor(f.platform.value, num(f.price.value) || 100);
    if (!p) { if (hintEl) hintEl.textContent = 'Local / Other: enter the fee you’ll pay (0 for cash).'; return; }
    if (f.fee_pct.value.trim() === '' || f.fee_pct.dataset.preset === '1') { f.fee_pct.value = pct(p.pct); f.fee_pct.dataset.preset = '1'; }
    if (hintEl) hintEl.textContent = `${p.label} preset: ${pct(p.pct)}%${p.fixed ? ` + ${money(p.fixed)}/order` : ''}${p.cashout ? ` + ${pct(p.cashout)}% cash-out` : ''} (rates as of ${FEES_ASOF}; fixed fees aren’t included in this %). Edit if your rate differs.`;
  }
  $('#listing-form').fee_pct.addEventListener('input', (e) => { delete e.target.dataset.preset; });
  $('#listing-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target, msg = $('#sl-msg'); msg.className = 'msg err';
    const fee = num(f.fee_pct.value), n = listingNums(), cost = r2(n.per * 10000) / 10000, price = num(f.price.value), ship = f.shipping.value.trim() === '' ? 0 : num(f.shipping.value), qn = num(f.qty.value);
    const err = !f.item.value.trim() ? 'Enter the item name.' : !f.platform.value ? 'Pick the platform you’re selling on.' : (f.platform.value === 'other' && !f.platform_custom.value.trim()) ? 'Type the platform name for Local / Other.' :
      feeErr(fee) || (!isFinite(qn) || qn < 1 || qn !== Math.round(qn) ? 'Quantity must be a whole number, 1 or more.' : listingEdit && qn < (listingEdit.units_sold || 0) ? `Quantity can’t be below the ${listingEdit.units_sold} already sold.` :
      !isFinite(n.per) || n.per < 0 ? 'Enter what you paid (0 or more).' : !isFinite(n.tx) || n.tx < 0 || n.tx > 30 ? 'Sales tax % must be 0–30.' : !isFinite(n.ins) || n.ins < 0 ? 'Inbound shipping must be 0 or more.' :
      !isFinite(price) || price < 0 ? 'Enter the list price.' : !isFinite(ship) || ship < 0 ? 'Shipping must be 0 or more.' : '');
    if (err) { msg.textContent = err; return; }
    const body = { item: f.item.value, platform: f.platform.value, platform_custom: f.platform_custom.value, fee_pct: fee, cost, price, shipping: ship, notes: f.notes.value, qty: qn, tax_pct: n.tx, in_ship: n.ins };
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Saving…';
    try {
      const l = listingEdit ? await call('rd_listing_update', { p_id: listingEdit.id, p_listing: body }) : await call('rd_listing_add', { p_listing: body });
      await tagType('listing', l.id, f.item_type.value);
      const prev = priceRow('listing', l.id);
      if (f.drop_alert.checked || prev) await call('rd_price_watch_save', { p_kind: 'listing', p_ref: String(l.id), p_cfg: { buy_in: unitCost(l), alert_on: f.drop_alert.checked, label: l.item, site: platName(l), member_id: me()?.id ?? null } });
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
    else if (b.dataset.lsold) openUnitSale(l);
    else if (b.dataset.ldel && confirm('Delete this listing? This can’t be undone.')) {
      try { await call('rd_listing_delete', { p_id: id }); if (priceRow('listing', id)) await call('rd_price_watch_delete', { p_kind: 'listing', p_ref: String(id) }); toast('Listing deleted'); await refreshExt(); } catch (err) { toast(err.message); }
    }
  });

  // ---------- mark alert as sold
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const saleFor = (alertId) => ext.sales.find((s) => s.alert_id === alertId);
  const listingFor = (alertId) => { const x = unitSaleFor(alertId); return x ? x.l : ext.listings.find((l) => l.alert_id === alertId); };
  const matchListing = (item) => { const n = norm(item); if (!n) return null; const pool = ext.listings.filter((l) => leftOf(l) > 0);
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
      else { f.fee_pct.value = ''; presetFee(f, hint); } }
    else { f.fee_pct.value = ''; hint.textContent = 'Pick a platform. Platforms set individual rates, so enter this sale’s fee %.'; }
  }
  const saleCost = () => { const f = $('#sale-form'); return saleCtx?.listing && f.use_listing.checked ? unitCost(saleCtx.listing) : num(f.cost.value); };
  function saleCalc() { const f = $('#sale-form'); $('#ss-calc').innerHTML = calcHtml(num(f.price.value), num(f.fee_pct.value), num(f.shipping.value), saleCost()); }
  const linkToggle = () => { const f = $('#sale-form'), on = !!(saleCtx.listing && f.use_listing.checked); $('#ss-cost-wrap').hidden = on; saleCalc(); };
  function openSale(a) {
    const us = unitSaleFor(a.id); if (us) { openUnitSale(us.l, us.u); return; }   // already recorded as a unit sale of a listing
    const linked = listingFor(a.id); if (linked) { openListing(linked); return; }
    const s = saleFor(a.id), L = s ? null : matchListing(a.item || a.title), f = $('#sale-form'); f.reset(); delete f.item_type.dataset.touched;
    saleCtx = { alert: a, sale: s, listing: L, feeTouched: !!s };
    $('#ss-title').textContent = s ? 'Edit sale' : 'Mark as sold'; $('#ss-sub').textContent = `${a.store ? a.store + ' · ' : ''}${a.time_et || et(a.ts)}`;
    f.item.value = s ? s.item : (a.item || a.title || ''); f.item_type.value = s ? typeOfSale(s) : L ? typeOfSale(L) : guessType(f.item.value); f.price.value = s ? (+s.price).toFixed(2) : (L ? (+L.price).toFixed(2) : '');
    f.platform.value = s ? s.platform : (L ? L.platform : ''); f.platform_custom.value = s ? (s.platform_custom || '') : (L ? (L.platform_custom || '') : '');
    f.cost.value = s ? (+s.cost).toFixed(2) : (L ? (+L.cost).toFixed(2) : ''); f.shipping.value = s && +s.shipping ? (+s.shipping).toFixed(2) : (L && +L.shipping ? (+L.shipping).toFixed(2) : '');
    if (s) { f.fee_pct.value = pct(+s.fee_pct); $('#ss-feehint').textContent = 'Fee % you entered for this sale. Platforms set individual rates.'; } else saleFee(true);
    $('#ss-link-wrap').hidden = !L; if (L) { f.use_listing.checked = true; $('#ss-link-txt').textContent = `Sell 1 unit of my listing “${L.item}” (${leftOf(L)} of ${qtyOf(L)} left, cost ${money(unitCost(L))} each)`; }
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
      if (L) { await call('rd_unit_sale_save', { p_listing_id: L.id, p_sale: { units: 1, price_unit: price, fee_pct: fee, shipping: ship, platform: f.platform.value, platform_custom: f.platform_custom.value, alert_id: saleCtx.alert.id } });
        await tagType('listing', L.id, f.item_type.value); }
      else { const sv = await call('rd_sale_save', { p_sale: { alert_id: saleCtx.alert.id, item: f.item.value, platform: f.platform.value, platform_custom: f.platform_custom.value, fee_pct: fee, price, cost, shipping: ship } }); await tagType('sale', sv && sv.id, f.item_type.value); }
      closeSheet(); toast('Sale saved'); await refreshExt(); } catch (err2) { msg.textContent = err2.message; }
  });
  $('#ss-delete').addEventListener('click', async () => {
    if (!saleCtx?.sale || !confirm('Remove this sale? The alert stays.')) return;
    try { await call('rd_sale_delete', { p_id: saleCtx.sale.id }); closeSheet(); toast('Sale removed'); await refreshExt(); } catch (err) { $('#ss-msg').textContent = err.message; }
  });
  $('#alert-list').addEventListener('click', (e) => { const b = e.target.closest('button[data-sold]'); if (!b) return; const a = state.alerts.find((x) => x.id === b.dataset.sold); if (a) { try { need(); openSale(a); } catch (err) { toast(err.message); } } });
  const soldLine = (a) => { const us = a.id && unitSaleFor(a.id), s = us ? usRow(us) : a.id && (saleFor(a.id) || listingFor(a.id)); if (!s) return ''; const r = pnl(+s.price, +s.fee_pct, +s.shipping, +s.cost);
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
  const ph = { phones: [], parts: [], dupes: [], loaded: false, filter: null, q: '', type: null };
  async function loadPhones() { if (TOKEN) return loadFriend(); if (!CFG || !KEY) return; const d = await rpc('rd_phones', { p_key: KEY }); Object.assign(ph, d, { loaded: true }); renderPhones(); renderDash(); }
  const C = window.RDClassify;
  const maskSerial = (s) => s ? s.slice(0, 3) + '•••' + s.slice(-2) : '';
  const phoneName = (p) => (p.item_type && p.item_type !== 'phone') ? ([p.item_name, p.model].filter(Boolean).join(' · ') || 'Unnamed item') :
    ([p.model, p.color, p.storage].filter(Boolean).join(' · ') || (p.part_number ? p.part_number : 'Unknown model'));
  const openAny = (p) => p && p.item_type && p.item_type !== 'phone' ? openItem(p, p.item_type) : openPhone(p);
  function startItem(id) { const t = itemType(id); if (t.flow === 'scanner') openScanner(); else openItem(null, t.id); }
  const hwMismatch = (p) => p.handwritten_serial && p.serial && p.handwritten_serial.replace(/[^A-Z0-9]/gi, '').toUpperCase() !== p.serial;
  const partOf = (pn) => ph.parts.find((x) => x.part_number === String(pn || '').toUpperCase());
  function collectors() {
    const m = new Map();
    for (const p of ph.phones) { if (p.status !== 'logged') continue; const k = p.member_id ?? 0; const c = m.get(k) || { id: p.member_id, name: p.member || 'No collector', n: 0, owed: 0 }; c.n++; c.owed = r2(c.owed + +p.price_paid); m.set(k, c); }
    return [...m.values()].sort((a, b) => b.owed - a.owed);
  }
  function renderPhones() {
    const cs = collectors(), total = r2(cs.reduce((a, c) => a + c.owed, 0));
    $('#collectors').innerHTML = cs.length ? `<div class="stats" style="margin-top:0"><div class="wide"><small>Owed back to collectors · ${cs.reduce((a, c) => a + c.n, 0)} items</small><b>${money(total)}</b></div></div>
      <div class="coll-list">${cs.map((c) => `<button class="coll ${ph.filter === c.id ? 'on' : ''}" data-coll="${c.id ?? ''}"><span class="grow"><b>${esc(c.name)}</b><small>${c.n} item${c.n === 1 ? '' : 's'}</small></span><b>${money(c.owed)}</b></button>`).join('')}</div>
      <p class="f">Owed = sum of price paid on each collector’s logged items (their money back). Profit split comes later.</p>` : '<p class="d">Nothing logged yet. Pick a type above.</p>';
    $('#ph-filter-clear').hidden = ph.filter === null;
    const q = ph.q.trim().toUpperCase();
    const present = [...new Set(ph.phones.map((p) => p.item_type || 'phone'))], types = [...ITEM_TYPES.map((t) => t.id).filter((id) => present.includes(id)), ...present.filter((id) => !ITEM_TYPES.some((t) => t.id === id))];
    $('#ph-types').innerHTML = types.length > 1 ? [`<button type="button" class="spill ${ph.type === null ? 'on' : ''}" data-ptype="">All ${ph.phones.length}</button>`, ...types.map((id) => `<button type="button" class="spill ${ph.type === id ? 'on' : ''}" data-ptype="${esc(id)}">${esc(itemType(id).label)} ${ph.phones.filter((p) => (p.item_type || 'phone') === id).length}</button>`)].join('') : '';
    const rows = ph.phones.filter((p) => (ph.filter === null || p.member_id === ph.filter) && (ph.type === null || (p.item_type || 'phone') === ph.type) && (!q || [p.serial, p.imei1, p.imei2, p.model, p.color, p.storage, p.part_number, p.member, p.sku, p.item_name, p.order_number].some((x) => String(x || '').toUpperCase().includes(q))));
    $('#phone-list').innerHTML = rows.map((p) => `<button class="card qrow" data-phone="${p.id}">
      <div class="row"><p class="t grow">${typeChip(p)}${esc(phoneName(p))}</p><b>${money(+p.price_paid)}</b></div>
      <p class="d">${p.serial ? 'S/N ' + esc(p.serial) : 'No serial'}${p.imei1 ? ' · IMEI ' + esc(p.imei1) : ''}${p.imei2 ? ' / ' + esc(p.imei2) : ''}${p.order_number ? ' · Order ' + esc(p.order_number) : ''}</p>
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
  $('#phone-list').addEventListener('click', (e) => { const b = e.target.closest('[data-phone]'); if (b) openAny(ph.phones.find((p) => p.id === +b.dataset.phone)); });
  $('#item-pick').innerHTML = pickerHtml(); $('#fr-pick').innerHTML = pickerHtml();
  $('#item-pick').addEventListener('click', (e) => { const b = e.target.closest('[data-itype]'); if (b) startItem(b.dataset.itype); });
  $('#ph-types').addEventListener('click', (e) => { const b = e.target.closest('[data-ptype]'); if (!b) return; ph.type = b.dataset.ptype || null; renderPhones(); });
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
        await new Promise((r) => setTimeout(r, 2500)); const j = await call('rd_scan_get', { p_id: job.id }).catch(() => null);
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
    else { $('#sp-part').textContent = pn ? 'Not in the lookup. Pick or type model / color / storage below.' : ''; $('#sp-savepart').hidden = !pn || !!TOKEN; }
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
    $('#sp-coll-wrap').hidden = !!TOKEN; $('#sp-name-wrap').hidden = !TOKEN; f.entered_name.value = TOKEN ? ($('#fr-name').value.trim() || fr.account?.name || '') : '';
    f.order_number.value = p ? (p.order_number || '') : '';
    $('#sp-title').textContent = p ? 'Edit phone' : 'Confirm phone'; $('#sp-sub').textContent = p ? `Logged ${et(p.created_at)} by ${p.member || 'no collector'}` : 'Check every field against the box before saving.';
    for (const k of ['serial', 'imei1', 'imei2', 'part_number', 'model', 'color', 'storage', 'sku', 'handwritten_serial', 'notes']) f[k].value = p ? (p[k] || '') : (s[k] || '');
    if (!p && s.upc) f.sku.value = 'UPC ' + s.upc;
    f.price_paid.value = p ? (+p.price_paid).toFixed(2) : '';
    const k = partHint();
    if (!p && k) { f.model.value = k.model || ''; f.color.value = k.color || ''; f.storage.value = k.storage || ''; }
    else if (!p && s.ai) { f.model.value = s.ai.model || ''; f.color.value = s.ai.color || ''; f.storage.value = s.ai.storage || ''; }
    if (!p && s.ai?.notes?.length) $('#sp-sub').textContent = 'AI read: ' + s.ai.notes.join('; ') + '. Check every value.';
    $('#sp-thumb').hidden = true; $('#sp-status-wrap').hidden = !p; setPhStatus(p ? p.status : 'logged');
    if (p?.has_photo) call('rd_phone_photo', { p_id: p.id }).then((d) => { if (d) { $('#sp-thumb').src = d; $('#sp-thumb').hidden = false; } }).catch(() => {});
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
      const body = { item_type: 'phone', member_id: f.member_id.value, serial, imei1: i1, imei2: i2, part_number: f.part_number.value, model: f.model.value, color: f.color.value,
        storage: f.storage.value, sku: f.sku.value, handwritten_serial: f.handwritten_serial.value, price_paid: price, notes: f.notes.value, order_number: f.order_number.value,
        status: phEdit ? $('#sp-status button.on').dataset.s : 'logged', photo: phPhoto };
      if (TOKEN) { if (!f.entered_name.value.trim()) { msg.className = 'msg err'; msg.textContent = 'Enter your name.'; btn.disabled = false; return; } body.entered_name = f.entered_name.value.trim(); delete body.member_id; delete body.status; }
      const r = await call('rd_phone_save', { p_id: phEdit ? phEdit.id : null, p_phone: body });
      if (r && r.error) { msg.className = 'msg err'; msg.textContent = r.error; btn.disabled = false; return; }
      if (!TOKEN && f.save_part.checked && f.part_number.value.trim() && f.model.value.trim() && !partOf(f.part_number.value)) {
        await call('rd_part_save', { p_part: { part_number: f.part_number.value, model: f.model.value, color: f.color.value, storage: f.storage.value, source: 'added in app by ' + (me()?.name || 'member') } }).catch((x) => toast('Lookup not saved: ' + x.message)); }
      closeSheet(); toast(phEdit ? 'Phone updated' : 'Phone logged'); await loadPhones(); if (!TOKEN && state.tab === 'friends') loadFriendsView().catch(() => {});
    } catch (err2) { msg.className = 'msg err'; msg.textContent = err2.message; }
    btn.disabled = false;
  });
  $('#sp-delete').addEventListener('click', async () => { if (!phEdit || !confirm(`Delete phone ${phEdit.serial}? This can’t be undone.`)) return;
    try { await call('rd_phone_delete', { p_id: phEdit.id }); closeSheet(); toast('Deleted'); await loadPhones(); } catch (err) { $('#sp-msg').textContent = err.message; } });
  setInterval(() => { if (document.visibilityState === 'visible' && (state.tab === 'phones' || state.tab === 'home') && !openSheet && $('#scan-ui').hidden) loadPhones().catch(() => {}); }, 10000);

  // ---------- generic item sheet (consoles, other, and any future registry type without a custom flow)
  let itEdit = null, itType = 'other', itPhoto = null;
  const setItStatus = (v) => document.querySelectorAll('#si-status button').forEach((b) => b.classList.toggle('on', b.dataset.s === v));
  $('#si-status').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setItStatus(b.dataset.s); });
  function openItem(p, type) {
    try { need(); } catch (err) { toast(err.message); return; }
    itEdit = p || null; itType = (p && p.item_type) || type || 'other'; itPhoto = null; const t = itemType(itType), f = $('#item-form'); f.reset();
    f.member_id.innerHTML = ext.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    f.member_id.value = String(p ? (p.member_id ?? '') : (me()?.id ?? ''));
    $('#si-coll-wrap').hidden = !!TOKEN; $('#si-name-wrap').hidden = !TOKEN; f.entered_name.value = TOKEN ? ($('#fr-name').value.trim() || fr.account?.name || '') : '';
    $('#si-title').textContent = (p ? 'Edit ' : 'New ') + t.one; $('#si-sub').textContent = p ? `Logged ${et(p.created_at)} by ${p.member || 'no collector'}` : 'Check every field before saving.';
    f.item_name.placeholder = t.namePh || 'Item name'; f.model.placeholder = t.modelPh || 'optional';
    for (const k of ['item_name', 'model', 'serial', 'order_number', 'receipt_url', 'notes']) f[k].value = p ? (p[k] || '') : '';
    f.price_paid.value = p ? (+p.price_paid).toFixed(2) : '';
    $('#si-thumb').hidden = true; $('#si-status-wrap').hidden = !p; setItStatus(p ? p.status : 'logged');
    if (p?.has_photo) call('rd_phone_photo', { p_id: p.id }).then((d) => { if (d) { $('#si-thumb').src = d; $('#si-thumb').hidden = false; } }).catch(() => {});
    $('#si-delete').hidden = !p || !!TOKEN; $('#si-msg').textContent = ''; sheet('#sheet-item'); setTimeout(() => f.item_name.focus({ preventScroll: true }), 60);
  }
  $('#item-form').photo.addEventListener('change', async (e) => { const fl = e.target.files[0]; if (!fl) return; try { itPhoto = await RDScanner.compress(fl, 1280, 0.72); $('#si-thumb').src = itPhoto; $('#si-thumb').hidden = false; } catch (err) { toast(err.message); } });
  $('#item-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target, msg = $('#si-msg'); msg.className = 'msg err';
    const price = num(f.price_paid.value), serial = f.serial.value.replace(/[^A-Za-z0-9-]/g, '').toUpperCase(), url = f.receipt_url.value.trim();
    const err = !f.item_name.value.trim() ? 'Enter a name.' : (serial && !/^[A-Z0-9-]{3,40}$/.test(serial)) ? 'Serial: 3–40 letters/numbers.' : (!isFinite(price) || price < 0) ? 'Enter the price paid.' :
      (url && !/^https?:\/\/\S+$/i.test(url)) ? 'Receipt link must start with http:// or https://' : (TOKEN && !f.entered_name.value.trim()) ? 'Enter your name.' : '';
    if (err) { msg.textContent = err; return; }
    const body = { item_type: itType, item_name: f.item_name.value.trim(), model: f.model.value, serial, order_number: f.order_number.value, price_paid: price, receipt_url: url, notes: f.notes.value,
      photo: itPhoto, member_id: f.member_id.value, status: itEdit ? $('#si-status button.on').dataset.s : 'logged' };
    if (TOKEN) { body.entered_name = f.entered_name.value.trim(); delete body.member_id; delete body.status; }
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Saving…';
    try {
      const r = await call('rd_phone_save', { p_id: itEdit ? itEdit.id : null, p_phone: body });
      if (r && r.error) { msg.className = 'msg err'; msg.textContent = r.error; btn.disabled = false; return; }
      closeSheet(); toast(itEdit ? 'Item updated' : `${itemType(itType).one.replace(/^./, (c) => c.toUpperCase())} logged`); await loadPhones();
      if (!TOKEN && state.tab === 'friends') loadFriendsView().catch(() => {});
    } catch (err2) { msg.className = 'msg err'; msg.textContent = err2.message; }
    btn.disabled = false;
  });
  $('#si-delete').addEventListener('click', async () => { if (!itEdit || !confirm(`Delete ${phoneName(itEdit)}? This can’t be undone.`)) return;
    try { await call('rd_phone_delete', { p_id: itEdit.id }); closeSheet(); toast('Deleted'); await loadPhones(); if (state.tab === 'friends') loadFriendsView().catch(() => {}); } catch (err) { $('#si-msg').textContent = err.message; } });

  // ================= Dashboard (read-only overview; every card links to the tab that owns it) =================
  function renderDash() {
    if (!$('#dash-stats')) return;
    const now = new Date(), today = etKey(now), wd = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7, monday = new Date(Date.parse(today + 'T12:00:00Z') - wd * 86400000).toISOString().slice(0, 10);
    const P = ph.phones, logged = P.filter((p) => p.status === 'logged');
    const nToday = P.filter((p) => etKey(new Date(p.created_at)) === today).length, nWeek = P.filter((p) => etKey(new Date(p.created_at)) >= monday).length;
    const cs = collectors(), owed = r2(cs.reduce((a, c) => a + c.owed, 0));
    const items = state.status?.items || [], alive = items.filter((i) => i.alive).length, blocked = items.filter((i) => i.status === 'blocked').length, hot = items.filter((i) => i.status === 'in_stock').length;
    const sold = soldRows(); const profit = r2(sold.reduce((a, x) => a + pnl(+x.price, +x.fee_pct, +x.shipping, +x.cost).profit, 0));
    const n = nextUp();
    $('#dash-hero').innerHTML = `<p class="k">Risky Drops · ${esc(etDay.format(now))}</p><p class="h">${hot ? `${hot} in stock now` : `${P.length} item${P.length === 1 ? '' : 's'} logged`}</p>
      ${n ? `<p class="n" data-tick="${esc(n.at)}" data-past="Now">${compact(new Date(n.at) - Date.now())}</p><p class="w">until ${esc(n.title)} · ${esc(etLong(n.at))}</p>` : '<p class="w">No announced drop yet.</p>'}`;
    const stat = (go, label, val, sub, c = '') => `<button class="dstat" data-go="${go}"><small>${label}</small><b class="${c}">${val}</b>${sub ? `<span>${sub}</span>` : ''}</button>`;
    $('#dash-stats').innerHTML = stat('phones', 'Items logged', P.length, `${nToday} today · ${nWeek} this week`) + stat('phones', 'Owed to collectors', money(owed), `${cs.length} collector${cs.length === 1 ? '' : 's'}`) +
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
      card('phones', 'Items by model', breakdown.length ? `<div class="bars">${breakdown.map(([k, v]) => `<div><span>${esc(k)}</span><i style="--w:${Math.round(v / breakdown[0][1] * 100)}%"></i><b>${v}</b></div>`).join('')}</div>` : '<p class="d">Nothing logged yet.</p>') +
      card('phones', 'Recent items', P.length ? P.slice(0, 5).map((p) => `<div class="drow"><span class="grow"><b>${esc(phoneName(p))}</b><small>${esc(maskSerial(p.serial))} · ${esc(p.member || 'No collector')} · ${esc(et(p.created_at))}</small></span><b>${money(+p.price_paid)}</b></div>`).join('') : '<p class="d">Nothing logged yet.</p>') +
      card('phones', `Flags${flags.length ? ` <span class="pill price_drop">${flags.length}</span>` : ''}`, flags.length ? flags.slice(0, 6).map((x) => `<div class="drow flagrow"><span class="grow"><b>${esc(x.t)}</b><small>${esc(x.s)}</small></span></div>`).join('') : '<p class="d">No duplicate or mismatch flags.</p>', 'Review') +
      card('watches/alerts', 'Latest restock alerts', restocks.length ? restocks.map((a) => `<div class="drow"><span class="grow"><b>${esc(a.item || a.title)}</b><small>${esc([a.store, a.city].filter(Boolean).join(', '))} · ${esc(a.time_et || et(a.ts))}</small></span></div>`).join('') : '<p class="d">No restocks yet.</p>') +
      card('watches/list', 'Watcher health', `<div class="drow"><span class="grow">${items.map((i) => `<span class="hchip"><span class="dot ${i.alive ? 'on' : i.status === 'scheduled' || i.paused ? '' : 'off'}"></span>${esc(i.name.split(' (')[0])}${i.status === 'blocked' ? ' · blocked' : i.status === 'in_stock' ? ' · IN STOCK' : ''}</span>`).join('')}</span></div>`);
  }
  $('#tab-home').addEventListener('click', (e) => {
    const c = e.target.closest('[data-gocoll]'); if (c) { ph.filter = c.dataset.gocoll === '' ? null : +c.dataset.gocoll; show('phones'); renderPhones(); return; }
    const b = e.target.closest('[data-go]'); if (!b) return; const [t, sub] = b.dataset.go.split('/'); show(t, sub);
  });

  // ================= Accounts: one login screen, friend mode (own uploads + receipts only), admin Friends view =================
  const fr = { account: null, phones: [], receipts: [] };
  let frDetail = null, flFilter = 'active', flAccounts = [], fdData = null, acctEdit = null, flMenu = null;
  const fmtBytes = (n) => !n ? '' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const onlyScreen = (id) => { document.querySelectorAll('.screen').forEach((x) => (x.hidden = x.id !== id)); $('.tabbar').hidden = true; $('#ask-open').hidden = true; $('#gear').hidden = true; };
  function bootOther() {
    state.tab = MODE;
    if (MODE === 'login') {
      onlyScreen('tab-login'); $('#updated').textContent = '';
      const m = sessionStorage.getItem('rd-login-msg'); if (m) { $('#login-msg').className = 'msg'; $('#login-msg').textContent = m; sessionStorage.removeItem('rd-login-msg'); }
      $('#boot').classList.add('gone'); setTimeout(() => $('#login-form').username.focus({ preventScroll: true }), 300);
    } else if (MODE === 'friend') {
      onlyScreen('tab-friend'); { const cc = $('#calc-card'); if (cc && cc.parentElement.id !== 'tab-friend') $('#tab-friend').appendChild(cc); }   // friends have no Settings tab
      $('#updated').textContent = SESSION.name ? 'Signed in as ' + SESSION.name : '';
      $('#fr-name').value = localStorage.getItem('rd-fr-name') || SESSION.name || '';
      loadFriend().catch((e) => toast(e.message)).finally(() => $('#boot').classList.add('gone'));
      setInterval(() => { if (document.visibilityState === 'visible' && !openSheet && $('#scan-ui').hidden) loadFriend().catch(() => {}); }, 30000);
    }
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target, msg = $('#login-msg'), btn = f.querySelector('button[type=submit]');
    if (!f.username.value.trim() || !f.password.value) { msg.className = 'msg err'; msg.textContent = 'Enter your username and PIN.'; return; }
    btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Signing in…';
    try {
      const r = await rpc('rd_login', { p_username: f.username.value.trim(), p_pass: f.password.value });
      if (!r || r.error || !r.token) throw new Error((r && r.error) || 'Could not sign in');
      localStorage.setItem('rd-session', JSON.stringify({ token: r.token, role: r.role, name: r.name, username: r.username, member_id: r.member_id }));
      if (r.role === 'admin') localStorage.removeItem('rd-key');
      location.replace(location.pathname);
    } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; btn.disabled = false; }
  });
  // ---------- friend mode
  async function loadFriend() {
    const d = await rpc('rd_me', { p_token: TOKEN });
    Object.assign(fr, d); ph.parts = d.parts || []; ph.phones = d.phones || []; renderFriend();
  }
  function renderFriend() {
    const name = fr.account?.name || SESSION?.name || '';
    const logged = fr.phones.filter((p) => p.status === 'logged'), owed = r2(logged.reduce((a, p) => a + +p.price_paid, 0));
    $('#fr-hero').innerHTML = `<p class="k">Risky Drops · friend account</p><p class="h">Hi ${esc(name)}</p><p class="w">@${esc(fr.account?.username || '')} · ${fr.phones.length} item${fr.phones.length === 1 ? '' : 's'} uploaded</p>`;
    $('#fr-stats').innerHTML = `<div class="wide"><small>Payout owed to you · ${logged.length} item${logged.length === 1 ? '' : 's'}</small><b>${money(owed)}</b></div>
      <div><small>Items uploaded</small><b>${fr.phones.length}</b></div><div><small>Receipts</small><b>${fr.receipts.length}</b></div>`;
    $('#fr-phones').innerHTML = fr.phones.map((p) => `<div class="card"><div class="row"><p class="t grow">${typeChip(p)}${esc(phoneName(p))}</p><b>${money(+p.price_paid)}</b></div>
      <p class="d">${p.serial ? 'S/N ' + esc(p.serial) : 'No serial'}${p.imei1 ? ' · IMEI ' + esc(p.imei1) : ''}${p.order_number ? ' · Order ' + esc(p.order_number) : ''}</p>
      <p class="f">${esc(et(p.created_at))}${p.status === 'returned' ? ' · returned' : ' · logged'}${p.has_photo ? ' · 📷' : ''}</p></div>`).join('') || '<p class="empty">Nothing uploaded yet. Pick a type above.</p>';
    $('#fr-receipts').innerHTML = fr.receipts.length ? `<div class="card">${fr.receipts.map((x) => `<div class="rc-row"><span class="grow"><b>${esc(x.file_name || (x.mime === 'application/pdf' ? 'Receipt (PDF)' : 'Receipt photo'))}</b><small>${esc(et(x.created_at))}${x.order_number ? ' · Order ' + esc(x.order_number) : ''}${x.phone_id ? ' · ' + esc(phoneName(fr.phones.find((p) => p.id === x.phone_id) || {})) : ''} · ${fmtBytes(x.size_bytes)}</small></span><button class="btn" data-rview="${x.id}">View</button><button class="btn ghost danger" data-rdel="${x.id}" aria-label="Delete receipt">✕</button></div>`).join('')}</div>` : '<p class="empty">No receipts yet.</p>';
    const sel = $('#rc-form').phone_id, cur = sel.value;
    sel.innerHTML = '<option value="">Not linked</option>' + fr.phones.map((p) => `<option value="${p.id}">${esc(phoneName(p))}${p.serial ? ' · ' + esc(p.serial.slice(-5)) : ''}</option>`).join(''); sel.value = cur;
    const uniq = (k) => [...new Set([...ph.parts.map((x) => x[k]), ...ph.phones.map((x) => x[k])].filter(Boolean))].sort();
    $('#dl-model').innerHTML = uniq('model').map((v) => `<option value="${esc(v)}">`).join(''); $('#dl-color').innerHTML = uniq('color').map((v) => `<option value="${esc(v)}">`).join('');
    $('#dl-storage').innerHTML = [...new Set([...uniq('storage'), '128GB', '256GB', '512GB', '1TB', '2TB'])].map((v) => `<option value="${esc(v)}">`).join('');
  }
  $('#fr-name').addEventListener('change', (e) => localStorage.setItem('rd-fr-name', e.target.value.trim()));
  $('#fr-pick').addEventListener('click', (e) => { const b = e.target.closest('[data-itype]'); if (!b) return; if (!$('#fr-name').value.trim()) { toast('Enter your name first'); $('#fr-name').focus(); return; } localStorage.setItem('rd-fr-name', $('#fr-name').value.trim()); startItem(b.dataset.itype); });
  $('#fr-logout').addEventListener('click', () => { if (confirm('Log out of Risky Drops on this device?')) signOut('Logged out.'); });
  let rcFile = null;
  const readAsDataUrl = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read that file')); r.readAsDataURL(f); });
  async function pickReceipt(f) {
    if (!f) return; $('#rc-msg').textContent = '';
    try {
      if (f.type === 'application/pdf') { if (f.size > 3 * 1024 * 1024) throw new Error('PDF is over 3 MB. Take a photo instead.'); rcFile = { data: await readAsDataUrl(f), name: f.name, mime: 'application/pdf' }; }
      else if (/^image\//.test(f.type)) rcFile = { data: await RDScanner.compress(f, 2000, 0.82), name: f.name || 'receipt.jpg', mime: 'image/jpeg' };
      else throw new Error('Pick a photo or a PDF');
      $('#rc-file').textContent = `${rcFile.name} · ${fmtBytes(Math.round(rcFile.data.length * 0.75))}${rcFile.mime === 'image/jpeg' ? ' (compressed)' : ''}`;
    } catch (err) { rcFile = null; $('#rc-file').textContent = 'No file chosen.'; $('#rc-msg').className = 'msg err'; $('#rc-msg').textContent = err.message; }
  }
  $('#rc-form').photo.addEventListener('change', (e) => { pickReceipt(e.target.files[0]); e.target.value = ''; });
  $('#rc-form').file.addEventListener('change', (e) => { pickReceipt(e.target.files[0]); e.target.value = ''; });
  $('#rc-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target, msg = $('#rc-msg'), btn = f.querySelector('button[type=submit]');
    if (!rcFile) { msg.className = 'msg err'; msg.textContent = 'Take a photo or choose a file first.'; return; }
    btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Uploading…';
    try { await rpc('rd_f_receipt_add', { p_token: TOKEN, p_receipt: { data: rcFile.data, file_name: rcFile.name, order_number: f.order_number.value, phone_id: f.phone_id.value || null, note: f.note.value } });
      rcFile = null; f.reset(); $('#rc-file').textContent = 'No file chosen.'; msg.textContent = ''; toast('Receipt uploaded'); await loadFriend();
    } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
    btn.disabled = false;
  });
  function openDataUrl(d, name) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(d || ''); if (!m) { toast('File not found'); return; }
    const bin = atob(m[2]), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([u8], { type: m[1] })), w = window.open(url, '_blank', 'noopener');
    if (!w) { const a = document.createElement('a'); a.href = url; a.download = name || 'receipt'; a.click(); }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  $('#fr-receipts').addEventListener('click', async (e) => {
    const v = e.target.closest('[data-rview]'), d = e.target.closest('[data-rdel]');
    try {
      if (v) openDataUrl(await rpc('rd_f_receipt_get', { p_token: TOKEN, p_id: +v.dataset.rview }));
      if (d && confirm('Delete this receipt?')) { await rpc('rd_f_receipt_delete', { p_token: TOKEN, p_id: +d.dataset.rdel }); toast('Deleted'); await loadFriend(); }
    } catch (err) { toast(err.message); }
  });
  // ---------- admin: Friends list (client-list pattern) + friend detail
  async function loadFriendsView() {
    if (!CFG || !KEY) return;
    flAccounts = await rpc('rd_accounts', { p_key: KEY });
    if (frDetail) { fdData = await rpc('rd_friend_detail', { p_key: KEY, p_member_id: frDetail }); }
    renderFriends();
  }
  function renderFriends() {
    $('#fl-list-view').hidden = !!frDetail; $('#fl-detail-view').hidden = !frDetail;
    if (frDetail) return renderFriendDetail();
    const admin = flAccounts.find((a) => a.role === 'admin'), friends = flAccounts.filter((a) => a.role !== 'admin');
    $('#fl-admin').innerHTML = admin ? `<div class="split"><span><b>Admin login: @${esc(admin.username)}</b><br><small class="muted">${admin.has_password ? 'Password set' + (admin.last_login_at ? ' · last login ' + esc(et(admin.last_login_at)) : '') : 'No password yet. Your owner link works; set a password to log in on the main screen.'}</small></span><button class="btn" data-acct="${admin.id}" style="flex:none">${admin.has_password ? 'Change' : 'Set password'}</button></div>` : '';
    const act = friends.filter((a) => !a.disabled), dis = friends.filter((a) => a.disabled);
    $('#fl-n-active').textContent = act.length; $('#fl-n-disabled').textContent = dis.length;
    const list = flFilter === 'active' ? act : dis;
    $('#fl-list').innerHTML = list.map((a) => `<div class="client-row${a.disabled ? ' archived' : ''}">
      <button class="card card-link" type="button" data-fopen="${a.member_id}"><div class="split"><div class="card-title">${esc(a.name)}</div>${a.disabled ? '<span class="chip off">Turned off</span>' : `<span class="chip ${+a.owed > 0 ? 'on' : ''}">${money(+a.owed)} owed</span>`}</div>
        <div class="status-line">${a.phones} item${a.phones == 1 ? '' : 's'} · ${money(+a.total_paid)} total${a.last_upload_at ? ' · last upload ' + esc(et(a.last_upload_at)) : ' · nothing uploaded yet'}</div>
        <div class="muted">@${esc(a.username)}${a.last_login_at ? ' · last login ' + esc(et(a.last_login_at)) : ' · never logged in'}</div>
        <div class="chips">${Object.entries(a.types || {}).map(([k, v]) => `<span class="chip on">${esc(itemType(k).label)} ${v}</span>`).join('')}<span class="chip">${a.receipts} receipt${a.receipts == 1 ? '' : 's'}</span><span class="chip">${a.logged} logged</span>${a.phones - a.logged > 0 ? `<span class="chip">${a.phones - a.logged} returned</span>` : ''}</div></button>
      <div class="client-menu"><button type="button" class="client-menu-trigger" aria-label="More actions for ${esc(a.name)}" aria-haspopup="menu" aria-expanded="${flMenu === a.id}" data-fmenu="${a.id}">⋯</button>
        ${flMenu === a.id ? `<div class="client-menu-pop" role="menu"><button role="menuitem" data-fopen="${a.member_id}">Open friend</button><button role="menuitem" data-acct="${a.id}">Edit / reset PIN</button><button role="menuitem" data-ftoggle="${a.id}">${a.disabled ? 'Turn login back on' : 'Turn off login'}</button></div>` : ''}</div></div>`).join('')
      || `<p class="empty">${flFilter === 'active' ? 'No friend accounts yet. Tap + New friend.' : 'No turned-off logins.'}</p>`;
  }
  function renderFriendDetail() {
    const d = fdData; if (!d || !d.member) { $('#fd-body').innerHTML = '<p class="empty">Friend not found.</p>'; return; }
    const P = d.phones, logged = P.filter((p) => p.status === 'logged'), owed = r2(logged.reduce((a, p) => a + +p.price_paid, 0)), total = r2(P.reduce((a, p) => a + +p.price_paid, 0)), a = d.account;
    const rcFor = (id) => d.receipts.filter((x) => x.phone_id === id);
    const rcRow = (x) => `<div class="rc-row"><span class="grow"><b>${esc(x.file_name || (x.mime === 'application/pdf' ? 'Receipt (PDF)' : 'Receipt photo'))}</b><small>${esc(et(x.created_at))}${x.order_number ? ' · Order ' + esc(x.order_number) : ''}${x.note ? ' · ' + esc(x.note) : ''} · ${fmtBytes(x.size_bytes)}</small></span><button class="btn" data-arview="${x.id}">View</button><button class="btn ghost danger" data-ardel="${x.id}" aria-label="Delete receipt">✕</button></div>`;
    const kv = (k, v) => v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '';
    $('#fd-body').innerHTML = `<div class="cd-hero dash-hero" style="margin-top:10px"><div class="cd-hero-txt" style="padding:4px 4px"><p class="k">Friend${a && a.role === 'admin' ? ' · admin' : ''}</p><p class="h">${esc(d.member.name)}</p>
        <p class="w">${a ? '@' + esc(a.username) + (a.disabled ? ' · login turned off' : '') + (a.last_login_at ? ' · last login ' + esc(et(a.last_login_at)) : ' · never logged in') : 'No login'}</p></div></div>
      <div class="stats"><div class="wide"><small>Payout owed · ${logged.length} logged item${logged.length === 1 ? "" : "s"}</small><b>${money(owed)}</b></div>
        <div><small>Items brought</small><b>${P.length}</b></div><div><small>Total paid (all)</small><b>${money(total)}</b></div></div>
      ${a && a.role !== 'admin' ? `<div class="actions"><button class="btn" data-acct="${a.id}">Edit / reset PIN</button><button class="btn" data-ftoggle="${a.id}">${a.disabled ? 'Turn login on' : 'Turn login off'}</button></div>` : ''}
      <div class="kicker">Items (${P.length})${[...new Set(P.map((p) => p.item_type || 'phone'))].length > 1 ? ' · ' + [...new Set(P.map((p) => p.item_type || 'phone'))].map((k) => `${esc(itemType(k).label)} ${P.filter((p) => (p.item_type || 'phone') === k).length}`).join(' · ') : ''}</div>
      ${P.map((p) => `<div class="card fd-item"><div class="row"><p class="t grow">${typeChip(p)}${esc(phoneName(p))}</p><b>${money(+p.price_paid)}</b></div>
        <p class="d">${esc(etLong(p.created_at))} · ${p.status === 'logged' ? 'Logged (payout owed)' : 'Returned'}</p>
        <dl class="kv">${kv('Type', itemType(p.item_type).label.replace(/s$/, ''))}${kv('Name', p.item_name)}${kv('Serial', p.serial)}${kv('IMEI', p.imei1)}${kv('IMEI 2', p.imei2)}${kv('Part no.', p.part_number)}${kv('Model', p.model)}${kv('Color', p.color)}${kv('Storage', p.storage)}${kv('SKU', p.sku)}${kv('Order no.', p.order_number)}${kv('Handwritten', p.handwritten_serial)}${kv('Name entered', p.entered_name)}${kv('Payout', money(+p.price_paid))}${kv('Notes', p.notes)}${safeUrl(p.receipt_url) ? `<dt>Receipt link</dt><dd><a href="${esc(p.receipt_url)}" target="_blank" rel="noopener noreferrer">${esc(p.receipt_url.replace(/^https?:\/\//, '').slice(0, 48))} ↗</a></dd>` : ''}</dl>
        ${hwMismatch(p) ? `<p class="flag">Handwritten serial “${esc(p.handwritten_serial)}” doesn’t match the scanned serial</p>` : ''}
        ${rcFor(p.id).length ? `<div style="margin-top:8px">${rcFor(p.id).map(rcRow).join('')}</div>` : ''}
        <div class="actions">${p.has_photo ? `<button class="btn" data-fphoto="${p.id}">Photo</button>` : ''}<button class="btn" data-fedit="${p.id}">Edit</button></div><div data-photo-slot="${p.id}"></div></div>`).join('') || '<p class="empty">No items yet.</p>'}
      <div class="kicker">Receipts (${d.receipts.length})</div>
      ${d.receipts.length ? `<div class="card">${d.receipts.map(rcRow).join('')}</div>` : '<p class="empty">No receipts yet.</p>'}`;
  }
  $('#fl-filter').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; flFilter = b.dataset.v; document.querySelectorAll('#fl-filter button').forEach((x) => x.classList.toggle('on', x === b)); renderFriends(); });
  $('#fd-back').addEventListener('click', () => { location.hash = 'friends'; });
  $('#fl-new').addEventListener('click', () => openAcct(null));
  $('#tab-friends').addEventListener('click', async (e) => {
    const t = (sel) => e.target.closest(sel);
    if (t('[data-fmenu]')) { const id = +t('[data-fmenu]').dataset.fmenu; flMenu = flMenu === id ? null : id; renderFriends(); return; }
    if (t('[data-fopen]')) { flMenu = null; location.hash = 'friends/' + t('[data-fopen]').dataset.fopen; return; }
    if (t('[data-acct]')) { flMenu = null; renderFriends(); openAcct(flAccounts.find((a) => a.id === +t('[data-acct]').dataset.acct)); return; }
    try {
      if (t('[data-ftoggle]')) { flMenu = null; const a = flAccounts.find((x) => x.id === +t('[data-ftoggle]').dataset.ftoggle); if (!a) return;
        if (!a.disabled && !confirm(`Turn off ${a.name}'s login? They're signed out right away. Their phones stay.`)) { renderFriends(); return; }
        await call('rd_account_save', { p_id: a.id, p_name: a.name, p_username: a.username, p_pass: null, p_disabled: !a.disabled }); toast(a.disabled ? 'Login turned on' : 'Login turned off'); await loadFriendsView(); return; }
      if (t('[data-fedit]')) { const p = fdData.phones.find((x) => x.id === +t('[data-fedit]').dataset.fedit); if (p) { if (!ext.members.length) await loadExt().catch(() => {}); openAny(p); } return; }
      if (t('[data-fphoto]')) { const id = +t('[data-fphoto]').dataset.fphoto, d = await call('rd_phone_photo', { p_id: id }), slot = $(`[data-photo-slot="${id}"]`);
        if (d && slot) slot.innerHTML = `<img class="fd-thumb" alt="Box photo" src="${esc(d)}">`; return; }
      if (t('[data-arview]')) { openDataUrl(await call('rd_receipt_get', { p_id: +t('[data-arview]').dataset.arview })); return; }
      if (t('[data-ardel]')) { if (!confirm('Delete this receipt for good?')) return; await call('rd_receipt_delete', { p_id: +t('[data-ardel]').dataset.ardel }); toast('Deleted'); await loadFriendsView(); return; }
    } catch (err) { toast(err.message); }
    if (flMenu !== null && !t('.client-menu')) { flMenu = null; renderFriends(); }
  });
  function openAcct(a) {
    acctEdit = a || null; const f = $('#acct-form'); f.reset(); $('#sa-msg').textContent = '';
    const isAdmin = a && a.role === 'admin';
    $('#sa-title').textContent = !a ? 'New friend' : isAdmin ? 'Admin login' : `Edit ${a.name}`;
    $('#sa-sub').textContent = !a ? 'They log in on the main screen with this username and PIN.' : isAdmin ? 'Your own login for the main screen. The owner link keeps working too.' : 'Leave PIN empty to keep the current one. A new PIN signs them out everywhere.';
    f.name.value = a ? a.name : ''; f.username.value = a ? a.username : ''; f.disabled.checked = !!(a && a.disabled);
    $('#sa-pass-label').firstChild.textContent = isAdmin ? 'New password' : a ? 'New PIN or password (optional)' : 'PIN or password';
    f.pass.type = isAdmin ? 'password' : 'text'; f.pass.placeholder = isAdmin ? '8+ characters' : '4+ characters';
    $('#sa-gen').hidden = !!isAdmin; $('#sa-dis-wrap').hidden = !a || isAdmin; $('#sa-delete').hidden = !a || isAdmin;
    sheet('#sheet-acct'); setTimeout(() => (a ? f.pass : f.name).focus({ preventScroll: true }), 50);
  }
  $('#sa-gen').addEventListener('click', () => { const a = new Uint32Array(1); crypto.getRandomValues(a); $('#acct-form').pass.value = String(a[0] % 1000000).padStart(6, '0'); });
  $('#acct-form').name.addEventListener('input', (e) => { const f = $('#acct-form'); if (!acctEdit && !f.username.dataset.touched) f.username.value = e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32); });
  $('#acct-form').username.addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
  $('#acct-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target, msg = $('#sa-msg'); msg.className = 'msg err';
    const pass = f.pass.value, isAdmin = acctEdit && acctEdit.role === 'admin';
    if (!f.name.value.trim()) { msg.textContent = 'Enter a name.'; return; }
    if (!/^[a-z0-9._-]{2,32}$/.test(f.username.value.trim().toLowerCase())) { msg.textContent = 'Username: 2–32 letters, numbers, dot, dash or underscore.'; return; }
    if (!acctEdit && pass.length < 4) { msg.textContent = 'Set a PIN or password (4+ characters).'; return; }
    if (pass && pass.length < (isAdmin ? 8 : 4)) { msg.textContent = isAdmin ? 'Admin password: 8+ characters.' : 'PIN: 4+ characters.'; return; }
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Saving…';
    try {
      const r = await call('rd_account_save', { p_id: acctEdit ? acctEdit.id : null, p_name: f.name.value.trim(), p_username: f.username.value.trim().toLowerCase(), p_pass: pass || null, p_disabled: f.disabled.checked });
      closeSheet();
      toast(!acctEdit ? `Created @${r.username}. Send them the app link + their PIN.` : pass ? 'Saved. New PIN is active.' : 'Saved');
      await loadFriendsView(); refreshExt();
    } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
    btn.disabled = false;
  });
  $('#sa-delete').addEventListener('click', async () => {
    const a = acctEdit; if (!a) return;
    if (!confirm(`Delete ${a.name}'s login? Their phones and receipts stay under their name (you can delete those separately).`)) return;
    const wipe = confirm(`Also delete ALL of ${a.name}'s phones and receipts? This can't be undone.\n\nOK = delete everything · Cancel = keep their data`);
    try { await call('rd_account_delete', { p_id: a.id, p_delete_data: wipe }); closeSheet(); toast('Login deleted'); if (frDetail === a.member_id && wipe) location.hash = 'friends'; await loadFriendsView(); refreshExt(); loadPhones().catch(() => {}); }
    catch (err) { $('#sa-msg').className = 'msg err'; $('#sa-msg').textContent = err.message; }
  });
  // Settings → Account
  if ($('#acct-who')) $('#acct-who').textContent = MODE !== 'admin' ? '' : !CFG ? 'Local box server.' : (SESSION && SESSION.role === 'admin') ? `Signed in as @${SESSION.username} (admin).` : 'Signed in with the owner link (admin).';
  $('#acct-logout').addEventListener('click', () => { if (confirm(SESSION && SESSION.role === 'admin' ? 'Log out on this device?' : 'Log out? This device forgets the owner link; open it again or log in as krishna.')) signOut('Logged out.'); });

  // ---------- data
  async function load() {
    try {
      const [s, a] = await Promise.all([api('/api/status'), api('/api/alerts'), loadExt().catch((e) => { if (/Access key/.test(e.message)) throw e; toast('Could not load listings: ' + e.message); })]);
      state.status = s; state.alerts = a.alerts || [];
      if (!state.flip) state.flip = await api('/api/flip');
      if (!localStorage.getItem('rd-seen')) localStorage.setItem('rd-seen', new Date().toISOString());
      renderFlip(); renderBadge(); renderV2();
      if (state.tab === 'duo') duoRenderStatus(); if (state.tab === 'ps5') ps5Render();
      if (CFG && !favsLoaded) loadFavs();
    } catch (err) {
      if (/Access key/.test(err.message)) {
        document.querySelector('main').innerHTML = '<div class="card" style="margin-top:30px;text-align:center"><p class="t">Access key required</p><p class="d">Open the full Risky Drops link with ?key=… once. This device remembers it.</p></div>';
        document.querySelector('.tabbar').hidden = true;
      } else toast('Could not load: ' + err.message);
    }
    $('#boot').classList.add('gone');
  }
  // ---------- Duo Stock tab (top-level): what I want, the 12 nearest Apple stores, live stock, "Check now".
  // The page can't call Apple (CORS), so it queues commands (rd_command); sync.py on the box answers them (fast path) and this view polls
  // rd_command_status. `duo_stock` = a live lookup for a ZIP (read-only), `duo_prefs` = save what I want (models, dropped stores, interval,
  // pause) for the box-side watcher /workspace/iphoneduo/duo_watch.py, which is what actually pings. Apple failures show as "couldn't check",
  // never as stock. Nothing here adds to a cart or buys: "Buy now" is a plain link to Apple.
  const DUO_SIZES = ['256GB', '512GB', '1TB', '2TB'], DUO_COLORS = ['Night Sky', 'Star White'];
  const DUO_PRICE = { '256GB': 1999, '512GB': 2199, '1TB': 2599, '2TB': 3199 };   // Apple list prices
  const DUO_PART = { '256GB|Star White': 'MK1E4LL/A', '256GB|Night Sky': 'MK1F4LL/A', '512GB|Star White': 'MK1G4LL/A', '512GB|Night Sky': 'MK1H4LL/A',
    '1TB|Star White': 'MK1J4LL/A', '1TB|Night Sky': 'MK1L4LL/A', '2TB|Star White': 'MK1Q4LL/A', '2TB|Night Sky': 'MK1R4LL/A' };
  const DUO_INFO = {}; Object.entries(DUO_PART).forEach(([k, p]) => { const [s, c] = k.split('|'); DUO_INFO[p] = { storage: s, color: c }; });
  const DUO_SLUG = (p) => `https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-${DUO_INFO[p].storage.toLowerCase()}-${DUO_INFO[p].color.toLowerCase().replace(' ', '-')}`;
  const DUO_ALL = Object.values(DUO_PART);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const duo = { zip: localStorage.getItem('rd-duo-zip') || '08872', res: null, busy: false, req: 0, opened: false, watcher: null, pending: null, saveT: 0, saveMsg: '' };
  duo.prefs = { parts: DUO_ALL.slice(), dropped: [], cadence: 30, paused_until: 0 };
  try { Object.assign(duo.prefs, JSON.parse(localStorage.getItem('rd-duo-prefs') || '{}')); } catch (e) { /* ignore */ }
  try { const l = JSON.parse(localStorage.getItem('rd-duo-last') || 'null'); if (l && l.zip && l.stores) { duo.res = l; duo.saved = true; if (!localStorage.getItem('rd-duo-zip')) duo.zip = l.zip; } } catch (e) { /* ignore */ }
  const etTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const apple = (u) => /^https:\/\/www\.apple\.com\//.test(u || '') ? u : '';
  const dmoney = (v) => v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const dago = (ts) => { if (!ts) return ''; const s = Math.max(0, Math.round(Date.now() / 1000 - ts)); return s < 90 ? `${s} sec ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  const duoShip = (d) => { if (!/^\d{8}$/.test(d || '')) return ''; const dt = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)));
    const o = { timeZone: 'UTC', month: 'short', day: 'numeric' }; if (dt.getUTCFullYear() !== new Date().getFullYear()) o.year = '2-digit'; return new Intl.DateTimeFormat('en-US', o).format(dt).replace(/, (\d\d)$/, ' ’$1'); };
  const duoSel = () => { const s = new Set(duo.prefs.parts || []); return { parts: s, colors: DUO_COLORS.filter((c) => DUO_SIZES.some((z) => s.has(DUO_PART[z + '|' + c]))), sizes: DUO_SIZES.filter((z) => DUO_COLORS.some((c) => s.has(DUO_PART[z + '|' + c]))) }; };
  const duoPaused = () => (duo.prefs.paused_until || 0) * 1000 > Date.now();
  async function quick(action, payload, ms) {
    const c = await rpc('rd_command', { p_key: KEY, p_action: action, p_payload: payload || {} });
    const t0 = Date.now();
    for (;;) {
      await sleep(Date.now() - t0 < 6000 ? 1200 : 2500);
      const st = await rpc('rd_command_status', { p_key: KEY, p_id: c.id });
      if (st && st.state === 'done') return st.result || {};
      if (st && st.state === 'failed') throw new Error((st.result && st.result.error) || 'The box could not run that');
      if (Date.now() - t0 > (ms || 60000)) throw new Error('The box hasn’t picked this up. Is it online?');
    }
  }
  const wInfo = () => { const a = duo.watcher, b = state.status && state.status.duo_watch; return (a && b) ? ((a.last_pass_ts || 0) >= (b.last_pass_ts || 0) ? a : b) : (a || b || null); };

  function duoRenderStatus() {
    const el = $('#duo-status'); if (!el) return;
    const w = wInfo(), sel = duoSel(), n = sel.parts.size, paused = duoPaused() || (w && w.paused);
    const age = w && w.last_pass_ts ? Math.round(Date.now() / 1000 - w.last_pass_ts) : null;
    const stale = !paused && (age == null || age > Math.max(180, 3 * (duo.prefs.cadence || 30)));
    const cls = paused ? 'pause' : stale ? 'warn' : 'ok';
    const title = paused ? 'Paused' : stale ? (w ? 'Not responding' : 'Waiting for the box') : 'Watching';
    const by = w && w.by_state ? Object.keys(w.by_state).sort().join(' ') : 'NJ PA DE NY';
    const sub = `${n} model${n === 1 ? '' : 's'} · ${w ? w.stores : '45'} stores (${esc(by)}) · every ${duo.prefs.cadence || 30}s`;
    const when = w && w.last_pass_ts ? `Last check ${esc(dago(w.last_pass_ts))} · ${esc(etTime.format(new Date(w.last_pass_ts * 1000)))} ET` : 'No check recorded yet.';
    el.className = 'card dz-status ' + cls;
    el.innerHTML = `<div class="dz-st-row"><span class="dz-dot" aria-hidden="true"></span><b class="grow">${title}</b><span class="dz-ok" aria-hidden="true">${paused ? '❚❚' : stale ? '!' : '✓'}</span></div>
      <p class="d">${sub}</p><p class="f">${when}${paused ? ' · pauses auto-resume after 2 hours' : ''}${stale && w ? ' · the watcher on the box hasn’t checked recently' : ''}</p>`;
  }
  function duoRenderWant() {
    const sel = duoSel();
    $('#duo-colors').innerHTML = DUO_COLORS.map((c) => `<button type="button" class="dz-chip ${sel.colors.includes(c) ? 'on' : ''}" data-color="${c}" aria-pressed="${sel.colors.includes(c)}"><i class="sw ${c === 'Star White' ? 'w' : 'n'}"></i>${c}</button>`).join('');
    $('#duo-sizes').innerHTML = DUO_SIZES.map((z) => `<button type="button" class="dz-chip sz ${sel.sizes.includes(z) ? 'on' : ''}" data-size="${z}" aria-pressed="${sel.sizes.includes(z)}"><b>${z}</b><small>${dmoney(DUO_PRICE[z])}</small></button>`).join('');
    $('#duo-carrier').innerHTML = ['Unlocked', 'AT&T', 'T-Mobile', 'Verizon'].map((c, i) => `<button type="button" class="${i === 0 ? 'on' : 'nt'}" data-carrier="${esc(c)}" aria-pressed="${i === 0}" ${i ? 'aria-disabled="true"' : ''}>${esc(c)}${i ? '<small>not tracked</small>' : ''}</button>`).join('');
    $('#duo-cad-t').textContent = `Check every ${duo.prefs.cadence || 30}s`;
    $('#duo-cad-minus').disabled = (duo.prefs.cadence || 30) >= 300; $('#duo-cad-plus').disabled = (duo.prefs.cadence || 30) <= 30;
    const p = duoPaused(); const sw = $('#duo-pause'); sw.setAttribute('aria-checked', p ? 'true' : 'false'); sw.classList.toggle('on', p);
    const m = $('#duo-msg'); if (duo.saveMsg) { m.className = 'msg' + (/^Saved/.test(duo.saveMsg) ? '' : ' err'); m.textContent = duo.saveMsg; }
  }
  function duoHitChips(s, sel) {
    return DUO_ALL.filter((p) => s.avail && s.avail[p] === 'available' && sel.parts.has(p)).map((p) => `<a class="dz-hit" href="${esc(DUO_SLUG(p))}" target="_blank" rel="noopener noreferrer">${esc(DUO_INFO[p].storage + ' ' + DUO_INFO[p].color)} ↗</a>`).join('');
  }
  function duoRenderStores() {
    const el = $('#duo-stores'), r = duo.res, sel = duoSel(), dropped = new Set(duo.prefs.dropped || []);
    if (!r) { el.innerHTML = '<p class="dz-k">Nearest Apple stores</p><p class="d">Tap Check now to load the stores near your ZIP.</p>'; return; }
    if (r.ok === false && r.error) { el.innerHTML = `<p class="dz-k">Nearest Apple stores</p><p class="d dz-bad">${esc(r.error.message)}.</p>`; return; }
    if (r.pickup_error) { el.innerHTML = `<p class="dz-k">Nearest Apple stores</p><p class="d dz-bad">Couldn’t check pickup stock: ${esc(r.pickup_error.message)}. Stock isn’t shown because it can’t be verified right now.</p>`; return; }
    const rows = (r.stores || []).slice().sort((a, b) => (a.dist == null) - (b.dist == null) || a.dist - b.dist);
    const watching = rows.filter((s) => !dropped.has(s.id)).length;
    el.innerHTML = `<p class="dz-k"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6"/></svg>${rows.length} nearest Apple stores</p>
      ${rows.map((s) => { const off = dropped.has(s.id), link = apple(s.link), chips = off ? '' : duoHitChips(s, sel);
        return `<div class="dz-srow ${off ? 'off' : ''} ${chips ? 'hit' : ''}"><div class="grow"><a class="dz-sn" ${link ? `href="${esc(link)}" target="_blank" rel="noopener noreferrer"` : ''}>${esc(s.name)}</a><small>${esc(s.city)}, ${esc(s.state)} ${esc(s.zip)}${s.dist != null ? ` · ${s.dist.toFixed(2)} mi` : ''}${off ? ' · not alerting' : ''}</small>${chips ? `<div class="dz-hits">${chips}</div>` : ''}</div>
          <button type="button" class="dz-x" data-drop="${esc(s.id)}" aria-label="${off ? 'Alert for' : 'Stop alerting for'} Apple ${esc(s.name)}" title="${off ? 'Add back' : 'Drop this store'}">${off ? '+' : '×'}</button></div>`; }).join('')}
      <p class="hint">${watching} of ${rows.length} alert. The box watches all ${(wInfo() || {}).stores || 45} stores in NJ, PA, DE and NY; × only silences a store’s pings. Distances are from Apple.</p>`;
  }
  const dzCell = (p, v, store, sel) => {
    const on = sel.parts.has(p.part), link = apple(p.link), cls = v === 'available' ? 'av' : v === 'unavailable' ? 'un' : 'nd', txt = v === 'available' ? 'Available' : v === 'unavailable' ? 'Unavailable' : 'No data';
    const tip = `${store} · iPhone Duo ${p.storage} ${p.color}: ${txt}`;
    return `<td class="${on ? 'emph' : 'dim'}">${link ? `<a class="dz ${cls}" href="${esc(link)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(tip)}" title="${esc(tip)}">${txt}</a>` : `<span class="dz ${cls}">${txt}</span>`}</td>`;
  };
  function duoTable(r, sel) {
    const parts = r.parts, th = DUO_SIZES.map((z) => `<th colspan="2" class="${sel.sizes.includes(z) ? 'emph' : 'dim'}">${z}</th>`).join('');
    const sub = parts.map((p) => `<th class="${sel.parts.has(p.part) ? 'emph' : 'dim'} sub"><i class="sw ${p.color === 'Star White' ? 'w' : 'n'}"></i>${p.color}</th>`).join('');
    const o = r.online, zip = esc(r.zip);
    const onl = !o ? `<tr class="online err"><th class="store"><span class="sn">Online</span><span class="sl">Ships to ${zip}</span></th><td colspan="8"><span class="dz-err">Couldn't check online${r.online_error ? ': ' + esc(r.online_error.message) : ''}</span></td></tr>`
      : `<tr class="online"><th class="store"><span class="sn">Online</span><span class="sl">Ships to ${zip}</span></th>${parts.map((p) => {
        const x = (o.items || {})[p.part] || {}, link = apple(p.link), d = duoShip(x.date), txt = x.buyable === true ? 'Buyable' : x.buyable === false ? 'Not buyable' : 'No data';
        const cls = x.buyable === true ? 'av' : x.buyable === false ? 'un' : 'nd', inner = `${txt}${d ? `<small>${esc(d)}</small>` : ''}`, tip = `Online · iPhone Duo ${p.storage} ${p.color}: ${txt}${d ? ', ships ' + d : ''}`;
        return `<td class="${sel.parts.has(p.part) ? 'emph' : 'dim'}">${link ? `<a class="dz ${cls} two" href="${esc(link)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(tip)}" title="${esc(tip)}">${inner}</a>` : `<span class="dz ${cls} two">${inner}</span>`}</td>`; }).join('')}</tr>`;
    const dropped = new Set(duo.prefs.dropped || []);
    const rows = (r.pickup_error ? [] : r.stores || []).map((s) => {
      const link = apple(s.link), any = parts.some((p) => sel.parts.has(p.part) && s.avail[p.part] === 'available'), name = `<span class="sn">${esc(s.name)}</span><span class="sl">${esc(s.city)}, ${esc(s.state)} ${esc(s.zip)}${s.dist != null ? ` · ${s.dist.toFixed(1)} mi` : ''}</span>`;
      return `<tr class="${any ? 'hit' : ''}${dropped.has(s.id) ? ' nyrow' : ''}"><th class="store">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="Apple ${esc(s.name)} store page">${name}</a>` : name}</th>${parts.map((p) => dzCell(p, s.avail[p.part], 'Apple ' + s.name, sel)).join('')}</tr>`; }).join('');
    return `<div class="dz-wrap card" tabindex="0" role="region" aria-label="iPhone Duo stock table, scroll sideways"><table class="dz-tbl"><thead><tr><th class="store" rowspan="2">Store</th>${th}</tr><tr>${sub}</tr></thead><tbody>${onl}${rows}</tbody></table></div>`;
  }
  function duoRenderOut() {
    const out = $('#duo-out'), r = duo.res; if (!out) return;
    if (!r || (r.ok === false && r.error)) { out.innerHTML = ''; return; }
    const sel = duoSel(), all = r.stores || [];
    const avail = all.filter((s) => r.parts.some((p) => sel.parts.has(p.part) && s.avail[p.part] === 'available')).length;
    const when = r.checked_ts ? `${duo.saved ? 'Last checked' : 'Checked'} ${esc(etTime.format(new Date(r.checked_ts * 1000)))} ET${r.cached && !duo.saved ? ' (cached)' : ''}` : '';
    const quote = !r.pickup_error && !avail && all.some((s) => s.quote) ? ` Apple says: “${esc((all.find((s) => s.quote) || {}).quote)}”.` : '';
    const sum = r.pickup_error ? '' : `<p class="dz-sum ${avail ? 'hot' : ''}">${avail ? `<b>${avail} store${avail === 1 ? '' : 's'} with your Duo for pickup</b>` : 'None of your selected models are in stock for pickup right now.'} <span class="dz-when">${when}.${quote}</span></p>`;
    out.innerHTML = `${sum}<p class="dz-k" style="margin:10px 2px 6px">Stock by store · every color and size</p>${duoTable(r, sel)}
      <p class="hint" style="margin:8px 2px 0">Scroll sideways for all sizes. Your colors and sizes are highlighted. Tap a store for its Apple page, or a cell for that model’s Apple page. Read-only: Risky Drops never adds to cart or buys.</p>`;
  }
  // Share Duo view (Oct 26): public read-only page duo.html next to this app. The link is built from the page path only, never from ?key= or the token.
  const duoShareUrl = () => new URL('duo.html', location.origin + location.pathname.replace(/[^/]*$/, '')).href;
  (function duoShareInit() {
    const inp = $('#duo-share-url'), cp = $('#duo-share-copy'), sh = $('#duo-share-send'); if (!inp || !cp) return;
    inp.value = duoShareUrl(); inp.addEventListener('focus', () => inp.select());
    if (navigator.share) sh.hidden = false;
    cp.addEventListener('click', async () => {
      const u = duoShareUrl(); inp.value = u;
      try { await navigator.clipboard.writeText(u); toast('Duo view link copied'); }
      catch (e) { inp.focus(); inp.select(); try { document.execCommand('copy'); toast('Duo view link copied'); } catch (e2) { toast('Press and hold the link to copy it'); } }
    });
    sh.addEventListener('click', () => { navigator.share({ title: 'iPhone Duo NJ stock', url: duoShareUrl() }).catch(() => {}); });
  })();
  const duoRender = () => { duoRenderStatus(); duoRenderWant(); duoRenderStores(); duoRenderOut(); };
  async function duoRun(force) {
    const zip = ($('#duo-zip').value || '').trim(), msg = $('#duo-msg');
    if (!/^\d{5}$/.test(zip)) { msg.className = 'msg err'; msg.textContent = 'Enter a 5-digit ZIP code.'; $('#duo-zip').focus(); return; }
    if (!CFG || !KEY) { msg.className = 'msg err'; msg.textContent = 'Open the app with your access link first.'; return; }
    const my = ++duo.req; duo.zip = zip; localStorage.setItem('rd-duo-zip', zip);
    duo.busy = true; $('#duo-go').disabled = true; $('#duo-go').textContent = 'Checking…'; msg.className = 'msg'; msg.textContent = 'Asking Apple through the box…';
    try {
      const r = await quick('duo_stock', { zip, force: !!force }, 70000);
      if (my !== duo.req) return;   // a newer lookup took over
      if (r.zip === zip || r.ok === false) { duo.res = { ...r, zip: r.zip || zip }; duo.saved = false; if (r.ok) { try { localStorage.setItem('rd-duo-last', JSON.stringify(duo.res)); } catch (e) { /* quota */ } } }
      if (r.watcher) duo.watcher = r.watcher;
      if (r.prefs && !duo.pending) { duo.prefs = r.prefs; localStorage.setItem('rd-duo-prefs', JSON.stringify(duo.prefs)); }
      msg.textContent = '';
    } catch (err) {
      if (my === duo.req) { const e = err.message; if (/ZIP/.test(e)) duo.res = { ok: false, zip, error: { kind: 'bad_zip', message: e } }; msg.className = 'msg err'; msg.textContent = e === 'Failed to fetch' ? 'No connection. Showing the last saved result, if any.' : e; }
    }
    if (my === duo.req) { duo.busy = false; $('#duo-go').disabled = false; $('#duo-go').textContent = 'Check now'; duoRender(); }
  }
  // Saving what I want: instant in the UI + localStorage, then one debounced `duo_prefs` command with only the changed fields.
  function duoSave(fields) {
    if ('parts' in fields) duo.prefs.parts = fields.parts; if ('dropped' in fields) duo.prefs.dropped = fields.dropped; if ('cadence' in fields) duo.prefs.cadence = fields.cadence;
    if ('paused' in fields) duo.prefs.paused_until = fields.paused ? Math.floor(Date.now() / 1000) + 7200 : 0;
    localStorage.setItem('rd-duo-prefs', JSON.stringify(duo.prefs));
    duo.pending = Object.assign(duo.pending || {}, fields); duo.saveMsg = ''; duoRender();
    clearTimeout(duo.saveT); duo.saveT = setTimeout(async () => {
      const body = duo.pending; duo.pending = null;
      try { const r = await quick('duo_prefs', body, 60000); if (r.prefs && !duo.pending) { duo.prefs = r.prefs; localStorage.setItem('rd-duo-prefs', JSON.stringify(r.prefs)); } if (r.watcher) duo.watcher = r.watcher; duo.saveMsg = 'Saved to the box ✓'; }
      catch (e) { duo.saveMsg = 'Not saved yet: ' + (e.message === 'Failed to fetch' ? 'no connection' : e.message); }
      duoRender();
    }, 700);
  }
  function duoToggle(kind, val) {
    const sel = duoSel(); let colors = sel.colors.slice(), sizes = sel.sizes.slice();
    const flip = (a, v) => (a.includes(v) ? a.filter((x) => x !== v) : a.concat(v));
    if (kind === 'color') colors = flip(colors, val); else sizes = flip(sizes, val);
    if (!colors.length || !sizes.length) { toast('Pick at least one color and one size.'); return; }
    duoSave({ parts: DUO_ALL.filter((p) => colors.includes(DUO_INFO[p].color) && sizes.includes(DUO_INFO[p].storage)) });
  }
  function duoOpen() {
    if (!duo.opened) {
      duo.opened = true; $('#duo-zip').value = duo.zip;
      if (CFG && KEY) quick('duo_prefs', {}, 60000).then((r) => { if (r.prefs && !duo.pending) { duo.prefs = r.prefs; localStorage.setItem('rd-duo-prefs', JSON.stringify(r.prefs)); } if (r.watcher) duo.watcher = r.watcher; duoRender(); }).catch(() => {});
    }
    duoRender();
    if (CFG && KEY && !duo.busy && /^\d{5}$/.test(duo.zip) && (!duo.res || Date.now() / 1000 - (duo.res.checked_ts || 0) > 120)) duoRun(false);
  }
  if (CFG) {
    $('#duo-form').addEventListener('submit', (e) => { e.preventDefault(); duoRun(false); document.activeElement.blur(); });
    $('#duo-zip').addEventListener('change', () => { if (/^\d{5}$/.test($('#duo-zip').value.trim())) duoRun(false); });
    $('#duo-go').addEventListener('click', () => { if (!duo.busy) duoRun(true); });
    $('#duo-colors').addEventListener('click', (e) => { const b = e.target.closest('[data-color]'); if (b) duoToggle('color', b.dataset.color); });
    $('#duo-sizes').addEventListener('click', (e) => { const b = e.target.closest('[data-size]'); if (b) duoToggle('size', b.dataset.size); });
    $('#duo-carrier').addEventListener('click', (e) => { const b = e.target.closest('[data-carrier]'); if (!b || !b.classList.contains('nt')) return;
      const n = $('#duo-carrier-note'); n.hidden = false; n.textContent = `${b.dataset.carrier} models aren’t tracked: only the unlocked iPhone Duo is checked (no carrier part numbers are known).`; });
    $('#duo-cad-minus').addEventListener('click', () => duoSave({ cadence: Math.min(300, (duo.prefs.cadence || 30) + 15) }));
    $('#duo-cad-plus').addEventListener('click', () => duoSave({ cadence: Math.max(30, (duo.prefs.cadence || 30) - 15) }));
    $('#duo-pause').addEventListener('click', () => duoSave({ paused: !duoPaused() }));
    $('#duo-stores').addEventListener('click', (e) => { const b = e.target.closest('[data-drop]'); if (!b) return;
      const d = new Set(duo.prefs.dropped || []); if (d.has(b.dataset.drop)) d.delete(b.dataset.drop); else d.add(b.dataset.drop); duoSave({ dropped: [...d] }); });
    $('#duo-test').addEventListener('click', async () => {
      if (!confirm('Send a TEST ping to your phone? It is labelled TEST ONLY and links to the real Apple page.')) return;
      const m = $('#duo-msg'); m.className = 'msg'; m.textContent = 'Sending the test ping…';
      try { await quick('test_notify', { which: 'duo' }, 60000); m.textContent = 'TEST ping sent. Check your phone.'; } catch (e) { m.className = 'msg err'; m.textContent = e.message; }
    });
  } else { document.querySelectorAll('.tabbar [data-tab="duo"], .tabbar [data-tab="ps5"]').forEach((b) => (b.hidden = true)); }

  // ---------- PS5 Pro tab: Walmart item 18235967161 (New only pings; open box is shown separately). Real data from the box's wm_state.json / wm.log.
  const ps5 = { d: null, busy: false, opened: false };
  const ps5Data = () => ps5.d || (state.status && state.status.ps5pro) || null;
  function ps5Render() {
    const d = ps5Data(); if (!d) { $('#ps5-main').innerHTML = '<p class="dz-k">Walmart · PS5 Pro (New)</p><p class="d">No Walmart reading yet. The box sends it with the next status update.</p>'; return; }
    const stale = d.last_check_ts && Date.now() / 1000 - d.last_check_ts > 900;
    const NS = { in_stock_under_cap: ['in', 'In stock', 'At or under your cap: you get pinged.'], in_stock_over_cap: ['over', 'In stock, over your cap', 'Above the cap, so no ping.'], out_of_stock: ['out', 'Out of stock', 'Waiting for it to come back.'] }[d.new_status] || ['nd', 'No reading yet', ''];
    const link = /^https:\/\/www\.walmart\.com\//.test(d.url || '') ? d.url : '';
    $('#ps5-main').className = 'card ps-main ' + NS[0];
    $('#ps5-main').innerHTML = `<p class="dz-k">Walmart · PS5 Pro · New (not open box)</p>
      <p class="ps-state"><span class="dz-dot" aria-hidden="true"></span>${esc(NS[1])}</p>
      <p class="ps-price">${d.new ? dmoney(d.new.price) : '—'}<small>${d.new ? 'price shown for New' : ''}</small></p>
      <p class="d">${esc(NS[2])}${d.seller ? ` Seller: ${esc(d.seller)}.` : ''}</p>
      ${link ? `<a class="btn buy dz-big" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open Walmart page ↗</a>` : ''}`;
    const ob = d.open_box;
    $('#ps5-box').innerHTML = `<p class="dz-k">Open box · separate</p><p class="ps-state sm ${ob && ob.status === 'IN_STOCK' ? 'in' : 'out'}"><span class="dz-dot" aria-hidden="true"></span>${ob ? (ob.status === 'IN_STOCK' ? 'In stock' : 'Out of stock') : 'Not listed'}${ob ? ` · ${dmoney(ob.price)}` : ''}</p>
      <p class="hint">Open-box units are shown for reference only. They never trigger a ping.</p>`;
    $('#ps5-when').innerHTML = `<p class="dz-k">Last checked</p><p class="ps-when-t ${stale ? 'warn' : ''}">${esc(d.last_check_et || 'No check yet')}</p>
      <p class="d">${d.last_check_ts ? esc(dago(d.last_check_ts)) + ' · ' : ''}${d.interval_s ? `checks about every ${Math.round(d.interval_s / 60 * 10) / 10} min (${d.interval_s}s between checks)` : esc(d.interval_note || '')}</p>${stale ? '<p class="msg err">No Walmart check for over 15 minutes. The watcher may be down or blocked.</p>' : ''}`;
    $('#ps5-rule').innerHTML = `Pings only when <b>New</b> (not open box) goes in stock at or under <b>${dmoney(d.cap)}</b>. Your target is about $900. Each ping repeats every minute (up to 5 times) while it’s still in stock.`;
    const ci = $('#ps5-cap-in'); if (document.activeElement !== ci) ci.value = d.cap;
    const row = (x) => `<li><span class="when">${esc(x.et)}</span><span class="txt">${esc(x.text)}</span></li>`;
    const oth = Object.entries(d.other_stores || {}).map(([k, v]) => `<li><span class="when">${esc({ psd: 'PlayStation Direct', bestbuy: 'Best Buy', amazon: 'Amazon' }[k] || k)}</span><span class="txt">${esc(v.text)} <small>${esc(v.et)}</small></span></li>`).join('');
    $('#ps5-hist').innerHTML = `<p class="dz-k">Status changes</p><ul class="ps-hist">${(d.changes || []).map(row).join('') || '<li><span class="txt">Nothing yet.</span></li>'}</ul>
      <details class="dz-det"><summary>Recent checks (last ${(d.history || []).length})</summary><ul class="ps-hist">${(d.history || []).map(row).join('')}</ul></details>
      ${oth ? `<p class="dz-k" style="margin-top:12px">Other stores (last reading)</p><ul class="ps-hist">${oth}</ul>` : ''}`;
  }
  async function ps5Refresh() {
    if (!CFG || !KEY || ps5.busy) return; ps5.busy = true;
    try { ps5.d = await quick('ps5_pro', {}, 60000); } catch (e) { /* the status feed still shows the last data */ }
    ps5.busy = false; ps5Render();
  }
  function ps5Open() { ps5Render(); if (!ps5.opened || !ps5.d || Date.now() / 1000 - (ps5.d.now || 0) > 60) { ps5.opened = true; ps5Refresh(); } }
  if (CFG) {
    $('#ps5-cap-form').addEventListener('submit', async (e) => {
      e.preventDefault(); const v = parseFloat(($('#ps5-cap-in').value || '').replace(/[$,]/g, '')), m = $('#ps5-msg');
      if (!isFinite(v) || v < 100 || v > 3000) { m.className = 'msg err'; m.textContent = 'Enter a price cap from $100 to $3,000.'; return; }
      m.className = 'msg'; m.textContent = 'Saving…'; $('#ps5-cap-save').disabled = true;
      try { ps5.d = await quick('ps5_pro', { cap: v }, 60000); m.textContent = `Saved: pings at or under ${dmoney(ps5.d.cap)} ✓`; } catch (err) { m.className = 'msg err'; m.textContent = err.message; }
      $('#ps5-cap-save').disabled = false; ps5Render();
    });
    $('#ps5-test').addEventListener('click', async () => {
      if (!confirm('Send a TEST ping to your phone? It is labelled TEST and links to the real Walmart page.')) return;
      const m = $('#ps5-msg'); m.className = 'msg'; m.textContent = 'Sending the test ping…';
      try { await quick('test_notify', { which: 'ps5' }, 60000); m.textContent = 'TEST ping sent. Check your phone.'; } catch (err) { m.className = 'msg err'; m.textContent = err.message; }
    });
  }


  // ---------- Pickup people + auto-buy policy row (Oct 24 2026). People live in Supabase (rd.pickup_people, key-checked rd_person_* RPCs).
  // The policy row is READ-ONLY: it shows the sanitized mirror of the box's local policy file. Nothing in the app can switch auto-buy on.
  const pp = { list: [], loaded: false, busy: false, edit: null, policy: null, open: false };
  const abFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const abUntil = (iso) => { const d = new Date(iso); return isNaN(d) ? '?' : abFmt.format(d) + ' ET'; };
  function abRender() {
    const p = pp.policy, has = !!(p && p.models), on = has && p.enabled === true;
    const sub = !has ? 'Waiting for the box to report its policy. The default is OFF.'
      : on ? 'ON in the box file, but the checkout driver isn’t built yet, so it only alerts.'
      : 'Alerts only. Nothing is bought automatically, and it can’t be switched on from this app.';
    let det = '';
    if (has) {
      const m = p.models || {}, st = p.states || {};
      const mrow = (z) => { const r = m[z]; if (!r) return ''; return r.rule === 'always' ? `${z}: always` : r.rule === 'never' ? `${z}: never auto-buy (alert only, waits for you)` : `${z}: until ${abUntil(r.until)} (${r.open_now ? 'open' : 'closed'})`; };
      const rows = [`<b>Models</b> ${['256GB', '512GB', '1TB', '2TB'].map(mrow).filter(Boolean).map(esc).join(' · ')}`,
        `<b>Where</b> ${esc((st.auto_buy || []).join(', ') || '—')} stores only (${esc((st.ignored || []).join(', '))} ignored; ${esc((st.excluded || []).join(', '))} excluded)`,
        `<b>How</b> store pickup only, earliest slot, guest checkout`, `<b>Payment</b> Vault card, entered at buy time (never stored)`,
        `<b>Limits</b> stops when Apple shows a limit${p.limit_stop ? '. <span class="ab-warn">LIMIT HIT: waiting for you</span>' : ''}`,
        `<b>Synced</b> ${p.mirrored_at ? esc(dago(Math.round(new Date(p.mirrored_at).getTime() / 1000))) : '—'}`];
      det = `<ul class="ab-det" ${pp.open ? '' : 'hidden'}>${rows.map((r) => `<li>${r}</li>`).join('')}</ul>`;
    }
    document.querySelectorAll('[data-ab]').forEach((el) => {
      el.className = 'card ab-row ' + (on ? 'on' : 'off'); el.setAttribute('aria-expanded', String(pp.open));
      el.innerHTML = `<div class="ab-top"><svg class="ab-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>
        <span class="grow"><b>Auto-buy: ${on ? 'ON' : 'OFF'}</b><small>${esc(sub)}</small></span><span class="ab-pill">${on ? 'ON' : 'OFF'}</span><span class="ab-chev" aria-hidden="true">${pp.open ? '⌃' : '⌄'}</span></div>${det}`;
    });
  }
  function ppRender() {
    const el = $('#pp-list'); if (!el) return;
    if (!pp.loaded) { el.innerHTML = '<p class="hint">Loading…</p>'; return; }
    if (!pp.list.length) { el.innerHTML = '<p class="empty pp-empty">No pickup people yet.<br>Tap <b>+ Add person</b> at the top.</p>'; return; }
    const n = pp.list.filter((x) => x.enabled).length;
    el.innerHTML = pp.list.map((x) => `<div class="pp-row ${x.enabled ? '' : 'off'}">
      <button type="button" class="pp-main" data-edit="${x.id}" aria-label="Edit ${esc(x.name)}"><b>${esc(x.name)}${x.is_default ? ' <span class="pp-def">Default</span>' : ''}</b>
        <small>${[x.phone, x.email].filter(Boolean).map(esc).join(' · ') || 'No phone or email yet'}</small>${x.note ? `<small class="pp-nt">${esc(x.note)}</small>` : ''}</button>
      <span class="pp-act">
        <button type="button" class="dz-switch pp-sw ${x.enabled ? 'on' : ''}" role="switch" aria-checked="${x.enabled}" data-tog="${x.id}" aria-label="${esc(x.name)} on or off"><i></i></button>
        <button type="button" class="pp-ic ${x.is_default ? 'on' : ''}" data-def="${x.id}" aria-label="Make ${esc(x.name)} the default" aria-pressed="${x.is_default}" title="Default"><svg viewBox="0 0 24 24" fill="${x.is_default ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8z"/></svg></button>
        <button type="button" class="pp-ic del" data-del="${x.id}" aria-label="Delete ${esc(x.name)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button>
      </span></div>`).join('') + `<p class="hint pp-count">${n} of ${pp.list.length} on. ${n ? '' : 'Auto-buy would only alert until someone is on.'}</p>`;
  }
  async function ppLoad() {
    if (!CFG || !KEY) return; const m = $('#pp-msg');
    try { pp.list = (await rpc('rd_people', { p_key: KEY })) || []; pp.loaded = true; m.textContent = ''; } catch (e) { m.className = 'msg err'; m.textContent = 'Couldn’t load people: ' + e.message; }
    ppRender();
  }
  async function abLoad() {
    if (!CFG || !KEY) return;
    try { pp.policy = await rpc('rd_autobuy_get', { p_key: KEY }); } catch (e) { /* keep the last one */ }
    abRender();
  }
  function ppOpen(tab) { abRender(); abLoad(); if (tab === 'people') { ppRender(); ppLoad(); } }
  function ppSheet(person) {
    pp.edit = person || null; const f = $('#person-form'); f.reset(); $('#pp-form-msg').textContent = ''; $('#pp-form-msg').className = 'msg';
    $('#pp-title').textContent = person ? 'Edit pickup person' : 'Add pickup person';
    if (person) { f.name.value = person.name; f.phone.value = person.phone || ''; f.email.value = person.email || ''; f.note.value = person.note || ''; f.is_default.checked = !!person.is_default; f.enabled.checked = !!person.enabled; }
    else { f.enabled.checked = true; f.is_default.checked = !pp.list.some((x) => x.enabled); }   // the first person you add becomes the default
    sheet('#sheet-person'); setTimeout(() => { try { f.name.focus(); } catch (e) { /* ignore */ } }, 120);
  }
  if (CFG) {
    $('#pp-add').addEventListener('click', () => ppSheet(null));
    $('#person-form').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target, m = $('#pp-form-msg'), name = f.name.value.trim(), phone = f.phone.value.trim(), email = f.email.value.trim();
      const bad = !name ? 'Enter the person’s name.' : (phone && !/^[0-9 ()+.-]{7,30}$/.test(phone)) ? 'Phone: digits only, like 732 555 0100.' : (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) ? 'That email doesn’t look right.' : '';
      if (bad) { m.className = 'msg err'; m.textContent = bad; return; }
      m.className = 'msg'; m.textContent = 'Saving…'; $('#pp-save').disabled = true;
      try {
        await rpc('rd_person_save', { p_key: KEY, p_id: pp.edit ? pp.edit.id : null, p_person: { name, phone, email, note: f.note.value.trim(), enabled: f.enabled.checked || f.is_default.checked, is_default: f.is_default.checked } });
        closeSheet(); toast(pp.edit ? 'Saved' : 'Added ' + name); await ppLoad();
      } catch (err) { m.className = 'msg err'; m.textContent = err.message; }
      $('#pp-save').disabled = false;
    });
    $('#pp-list').addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b || pp.busy) return;
      const id = +(b.dataset.edit || b.dataset.tog || b.dataset.def || b.dataset.del), x = pp.list.find((y) => y.id === id); if (!x) return;
      if (b.dataset.edit) { ppSheet(x); return; }
      pp.busy = true;
      try {
        if (b.dataset.tog) await rpc('rd_person_toggle', { p_key: KEY, p_id: id, p_enabled: !x.enabled });
        else if (b.dataset.def) await rpc('rd_person_default', { p_key: KEY, p_id: id });
        else if (b.dataset.del && await confirmBox({ title: `Delete ${x.name}?`, body: 'They’ll be removed from the pickup list.', ok: 'Delete', danger: true })) { await rpc('rd_person_delete', { p_key: KEY, p_id: id }); toast('Deleted'); }
        await ppLoad();
      } catch (err) { toast(err.message); }
      pp.busy = false;
    });
    document.querySelectorAll('[data-ab]').forEach((el) => {
      const tog = () => { pp.open = !pp.open; abRender(); };
      el.addEventListener('click', tog); el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tog(); } });
    });
  } else { document.querySelectorAll('.tabbar [data-tab="people"]').forEach((b) => (b.hidden = true)); document.querySelectorAll('[data-ab]').forEach((b) => (b.hidden = true)); }

  const route = () => { const [h, hs, h3] = location.hash.slice(1).split('/');
    if (h === 'watches' && hs === 'w' && h3) { state.wdetail = decodeURIComponent(h3); show('watches', 'list'); history.replaceState(null, '', location.pathname + location.search + '#watches/w/' + h3); renderWatches(); return; }
    if (state.wdetail) { state.wdetail = null; if (state.status) renderWatches(); }
    if (h === 'watches' && hs === 'duo') { show('duo'); return; }
    if (h === 'friends') { frDetail = hs && /^\d+$/.test(hs) ? +hs : null; show('friends', hs || null); return; }
    if (['home', 'duo', 'ps5', 'people', 'more', 'watches', 'phones', 'sales', 'settings', 'ask', ...Object.keys(LEGACY)].includes(h)) { show(h, hs); if (h === 'ask') loadAsk().catch(() => {}); } else show('home'); };
  if (MODE === 'admin') {
    route(); window.addEventListener('hashchange', route);
    load();
    setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
  } else bootOther();
})();

// keep the sticky Duo title bar right under the header
(function () { const hd = document.querySelector('.app-header'); const set = () => { if (hd) document.documentElement.style.setProperty('--hdr-h', Math.round(hd.getBoundingClientRect().height) + 'px'); }; set(); addEventListener('resize', set); setTimeout(set, 600); })();

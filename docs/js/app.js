/* MPH platform shell: auth gate, hash router, rail, production phases, overlays, toasts.
   Routes (dot tokens):  #login  #signup  #invite.<token>  #setup  #home  #productions  #team  #account
                         #p.<productionId>.<module>[.<param>] */
(function () {
  const { esc, t, ui, api } = MPH;
  const cfg = window.MPH_CONFIG;
  const app = document.getElementById('app');
  const overlay = document.getElementById('overlay');
  const toasts = document.getElementById('toasts');

  /* ------------------------------------------------------------ production flow
     `live` modules work in Phase 1; the rest show a "coming soon" page linking to the demo. */
  const PHASES = [
    { id: 'pre', label: 'Pre-production', icon: 'pencil-ruler', color: '#ACD062',
      tabs: [['treatment', 'Treatment & Lookbook', 'gallery-vertical-end'], ['script', 'Script', 'file-text', 1], ['docs', 'Documents', 'folder-open'],
             ['breakdown', 'AI Breakdown', 'scan-text', 1], ['shotlist', 'Shot List', 'list-video', 1], ['storyboard', 'Storyboard', 'layout-grid'],
             ['stripboard', 'Stripboard', 'rows-3', 1], ['budget', 'Budget & Bid', 'calculator', 1], ['calendar', 'Calendar', 'calendar-days']],
      groups: [['treatment', 'script', 'docs'], ['breakdown'], ['shotlist', 'storyboard'], ['stripboard', 'budget', 'calendar']] },
    { id: 'prod', label: 'Production', icon: 'clapperboard', color: '#FAB771',
      tabs: [['crew', 'Crew & Talent', 'users', 1], ['locations', 'Locations', 'map-pin'], ['callsheets', 'Call Sheets', 'clipboard-list', 1], ['shootday', 'Shoot Day', 'radio']] },
    { id: 'post', label: 'Post-production', icon: 'film', color: '#86B8E8',
      tabs: [['dailies', 'Dailies & Media', 'hard-drive'], ['edit', 'Edit & Versions', 'scissors'], ['review', 'Review & Approvals', 'circle-check-big'],
             ['finishing', 'Finishing', 'wand-sparkles'], ['deliverables', 'Deliverables', 'package-check'], ['wrap', 'Wrap Report', 'file-bar-chart']] },
  ];
  const CLIENT_MODULES = ['overview', 'script', 'budget'];
  const phaseOf = (prod) => ({ 'Development': 'pre', 'Bidding': 'pre', 'Pre-production': 'pre', 'Shooting': 'prod', 'Post-production': 'post', 'Delivered': 'post' }[prod.status] || 'pre');
  const phaseForModule = (mod) => PHASES.find((ph) => ph.tabs.some(([id]) => id === mod));
  const isLive = (mod) => mod === 'overview' || PHASES.some((ph) => ph.tabs.some(([id, , , live]) => id === mod && live));
  MPH.PHASES = PHASES;
  MPH.phaseOf = phaseOf;

  /* ------------------------------------------------------------ overlays & toasts */
  function openOverlay(html, mode, opts = {}) {
    overlay.className = mode === 'drawer' ? 'drawer-mode' : 'modal-mode';
    overlay.innerHTML = `<div class="${mode === 'drawer' ? 'drawer' : `modal ${opts.wide ? 'wide' : ''}`}" role="dialog" aria-modal="true">${html}</div>`;
    overlay.hidden = false;
    icons();
    const first = overlay.querySelector('input:not([type=hidden]), select, textarea');
    if (first) first.focus({ preventScroll: true });
    return overlay.firstElementChild;
  }
  const closeOverlay = () => { overlay.hidden = true; overlay.innerHTML = ''; };
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-close]')) closeOverlay(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeOverlay(); });
  MPH.frame = ({ title, sub = '', body = '', foot = '' }) => `
    <header class="overlay-head"><div class="grow stack tight" style="gap:2px"><h2 class="h2">${title}</h2>${sub ? `<span class="small muted">${sub}</span>` : ''}</div>
      <button class="btn btn-ghost btn-sm btn-icon" data-close aria-label="Close">${ui.icon('x')}</button></header>
    <div class="overlay-body">${body}</div>${foot ? `<footer class="overlay-foot">${foot}</footer>` : ''}`;
  MPH.modal = (html, opts) => openOverlay(html, 'modal', opts);
  MPH.drawer = (html) => openOverlay(html, 'drawer');
  MPH.closeOverlay = closeOverlay;
  MPH.toast = (msg, icon = 'check', kind = '') => {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `${ui.icon(kind === 'error' ? 'triangle-alert' : icon)}<span>${esc(msg)}</span>`;
    toasts.appendChild(el); icons();
    setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
  };
  MPH.toastError = (err) => MPH.toast(err?.message || String(err), 'triangle-alert', 'error');
  const icons = () => { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } }); };
  MPH.icons = icons;

  /* ------------------------------------------------------------ routing */
  const parse = () => {
    const raw = decodeURIComponent(location.hash.replace(/^#/, '')) || 'home';
    const parts = raw.split('.');
    if (parts[0] === 'p') return { section: 'p', productionId: parts[1], view: parts[2] || 'overview', params: parts.slice(3) };
    return { section: parts[0], view: parts[0], params: parts.slice(1) };
  };
  const go = (hash) => { const h = hash.startsWith('#') ? hash : '#' + hash; if (location.hash === h) render(); else location.hash = h; };
  MPH.go = go;

  /* production cache for the header (refreshed on every production route) */
  let prodCache = null;
  async function loadProduction(id) {
    const { data, error } = await MPH.sb.from('productions').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  /* ------------------------------------------------------------ auth screens */
  function authScreen(mode, info = {}) {
    const signup = mode === 'signup';
    return `
      <div class="auth">
        <div class="auth-card">
          <div class="row" style="gap:10px"><span class="auth-mark">${esc(cfg.brand)}</span><span class="small muted">${esc(cfg.brandLong)}</span></div>
          <h1 class="h1">${info.title || (signup ? 'Create your account' : 'Sign in')}</h1>
          ${info.sub ? `<p class="muted small">${info.sub}</p>` : ''}
          <form id="auth-form" class="stack" novalidate>
            ${signup ? `<div class="field"><label for="au-name">Full name</label><input id="au-name" class="input" autocomplete="name" required></div>` : ''}
            <div class="field"><label for="au-email">Email</label><input id="au-email" class="input" type="email" autocomplete="email" value="${esc(info.email || '')}" required></div>
            <div class="field"><label for="au-pass">Password</label><input id="au-pass" class="input" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="8" required>
              ${signup ? '<span class="tiny faint">At least 8 characters.</span>' : ''}</div>
            <div id="au-error" hidden></div>
            <button class="btn btn-primary" type="submit" id="au-submit">${signup ? 'Create account' : 'Sign in'}</button>
          </form>
          <div class="row between small">
            ${signup ? `<span class="muted">Already have an account? <a class="accent" href="#login${info.next ? '.' + info.next : ''}">Sign in</a></span>`
                     : `<span class="muted">New here? <a class="accent" href="#signup${info.next ? '.' + info.next : ''}">Create an account</a></span><button class="btn btn-ghost btn-xs" type="button" id="au-forgot">Forgot password</button>`}
          </div>
          <a class="small muted row" href="${esc(cfg.demoUrl)}" target="_blank" rel="noopener">${ui.icon('play')}See the click-through demo</a>
        </div>
      </div>`;
  }

  function mountAuth(mode, next) {
    const form = document.getElementById('auth-form');
    const err = document.getElementById('au-error');
    const show = (m) => { err.hidden = false; err.innerHTML = ui.errorBox(m); icons(); };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('au-email').value.trim();
      const pass = document.getElementById('au-pass').value;
      if (!email || pass.length < 8) return show('Enter your email and a password of at least 8 characters.');
      const btn = document.getElementById('au-submit');
      btn.disabled = true; btn.innerHTML = `${ui.spinner()} Please wait`;
      try {
        if (mode === 'signup') {
          const name = document.getElementById('au-name').value.trim();
          const { data, error } = await api.signUp(email, pass, name);
          if (error) throw error;
          if (!data.session) { show('Check your email to confirm your account, then sign in.'); btn.disabled = false; btn.textContent = 'Create account'; return; }
        } else {
          const { error } = await api.signIn(email, pass);
          if (error) throw new Error(error.message === 'Invalid login credentials' ? 'That email and password don’t match an account.' : error.message);
        }
        await api.loadSession();
        go(next ? decodeURIComponent(next) : 'home');
      } catch (ex) {
        show(ex.message); btn.disabled = false; btn.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
      }
    });
    const forgot = document.getElementById('au-forgot');
    if (forgot) forgot.addEventListener('click', async () => {
      const email = document.getElementById('au-email').value.trim();
      if (!email) return show('Type your email first, then choose Forgot password.');
      const { error } = await api.resetPassword(email);
      show(error ? error.message : 'If that email has an account, a reset link is on its way.');
    });
  }

  /* first run: create the production house */
  function setupScreen() {
    return `
      <div class="auth"><div class="auth-card">
        <span class="eyebrow">Welcome, ${esc(MPH.session.profile.full_name || '')}</span>
        <h1 class="h1">Set up your production house</h1>
        <p class="muted small">Your house holds your productions, team and rate history. You can invite producers, heads of department and clients once it’s set up. If someone invited you, open the invite link they sent instead.</p>
        <form id="setup-form" class="stack">
          <div class="field"><label for="su-name">House name</label><input id="su-name" class="input" placeholder="e.g. Life Circles" required></div>
          <div class="field"><label for="su-name-ar">Name in Arabic (optional)</label><input id="su-name-ar" class="input ar" dir="rtl" placeholder="دوائر الحياة"></div>
          <div class="field"><label for="su-city">City</label><input id="su-city" class="input" value="Riyadh"></div>
          <div id="su-error" hidden></div>
          <button class="btn btn-primary" type="submit">${ui.icon('building-2')}Create house</button>
        </form>
        <button class="btn btn-ghost btn-sm" data-act="signout">${ui.icon('log-out')}${t('Sign out')}</button>
      </div></div>`;
  }
  function mountSetup() {
    document.getElementById('setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('su-name').value.trim();
      if (!name) return;
      try {
        const orgId = api.must(await MPH.sb.rpc('create_org', { p_name: name, p_name_ar: document.getElementById('su-name-ar').value.trim() || null, p_city: document.getElementById('su-city').value.trim() || 'Riyadh' }));
        MPH.state.orgId = orgId; MPH.saveState();
        await api.loadSession();
        MPH.toast(`${name} is ready`);
        go('home');
      } catch (ex) { const b = document.getElementById('su-error'); b.hidden = false; b.innerHTML = ui.errorBox(ex.message); icons(); }
    });
  }

  /* invite link */
  async function inviteScreen(token) {
    const info = (await MPH.sb.rpc('invite_info', { p_token: token })).data;
    if (!info) return `<div class="auth"><div class="auth-card">${ui.empty('link-2-off', 'This invite link isn’t valid', 'Ask the producer to send you a new one.')}</div></div>`;
    const what = info.role === 'client' ? `review <strong>${esc(info.production)}</strong> as the client` : `join <strong>${esc(info.org)}</strong> as ${info.role === 'hod' ? 'a head of department' : 'a ' + esc(info.role)}`;
    if (info.used) return `<div class="auth"><div class="auth-card">${ui.empty('circle-check', 'This invite has already been used', 'Sign in to continue.', `<a class="btn btn-primary" href="#login">Sign in</a>`)}</div></div>`;
    if (!MPH.session) return authScreen('signup', { title: 'You’re invited', sub: `Create an account to ${what}. Use ${esc(info.email)}.`, email: info.email, next: encodeURIComponent('invite.' + token) });
    return `<div class="auth"><div class="auth-card">
      <span class="eyebrow">Invite</span><h1 class="h1">You’re invited</h1>
      <p class="muted">Accept to ${what}.</p>
      <div id="inv-error" hidden></div>
      <button class="btn btn-primary" id="inv-accept">${ui.icon('check')}Accept invite</button>
    </div></div>`;
  }
  function mountInvite(token) {
    const btn = document.getElementById('inv-accept');
    if (!btn) return mountAuth('signup', encodeURIComponent('invite.' + token));
    btn.addEventListener('click', async () => {
      try {
        const res = api.must(await MPH.sb.rpc('accept_invite', { p_token: token }));
        if (res.org_id) { MPH.state.orgId = res.org_id; MPH.saveState(); }
        await api.loadSession();
        MPH.toast('Invite accepted');
        go(res.production_id ? `p.${res.production_id}.overview` : 'home');
      } catch (ex) { const b = document.getElementById('inv-error'); b.hidden = false; b.innerHTML = ui.errorBox(ex.message); icons(); }
    });
  }

  /* ------------------------------------------------------------ shell */
  function rail(r) {
    const s = MPH.session;
    const clientOnly = !s.orgs.length;
    const active = r.section === 'p' ? 'productions' : r.section;
    const items = [['home', 'Home', 'house'], ['productions', 'Productions', 'clapperboard']];
    if (!clientOnly) items.push(['team', 'Team', 'users-round']);
    return `
      <nav class="rail" aria-label="Main">
        <a class="rail-logo" href="#home" aria-label="${esc(cfg.brandLong)} home"><span class="mark">${esc(cfg.brand)}</span></a>
        ${items.map(([id, label, icon]) => `<a href="#${id}" class="${active === id ? 'active' : ''}">${ui.icon(icon)}<span>${t(label)}</span></a>`).join('')}
        ${clientOnly ? '' : `<a href="${esc(cfg.demoUrl)}#market" target="_blank" rel="noopener" class="market-link" title="Marketplace arrives in a later phase: opens the demo">${ui.icon('store')}<span>${t('Marketplace')}</span><span class="soon-dot">${t('Soon')}</span></a>`}
        <div class="rail-foot">
          <a href="#account" class="${active === 'account' ? 'active' : ''}">${ui.av(s.profile, 'sm')}<span>Account</span></a>
        </div>
      </nav>`;
  }

  function topbar(r, prod, access) {
    const s = MPH.session;
    const sep = `<span class="faint">/</span>`;
    const house = s.org ? `<span>${esc(s.org.name)}</span>` : `<span>${esc(cfg.brand)}</span>`;
    let crumbs = house;
    if (r.section === 'p' && prod) {
      const ph = phaseForModule(r.view);
      const tab = ph && ph.tabs.find(([id]) => id === r.view);
      crumbs += `${sep}<a href="#productions">${t('Productions')}</a>${sep}<a href="#p.${prod.id}.overview">${esc(prod.title)}</a>${sep}<span class="here">${t(tab ? tab[1] : 'Overview')}</span>`;
    } else {
      const label = { home: 'Home', productions: 'Productions', team: 'Team', account: 'Account' }[r.section] || '';
      crumbs += label ? `${sep}<span class="here">${t(label)}</span>` : '';
    }
    const houseSwitch = s.orgs.length > 1 ? `<select class="select" id="org-switch" style="width:auto;height:30px">${s.orgs.map((o) => `<option value="${o.id}" ${o.id === s.org?.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>` : '';
    const preview = prod && access.canSeeInternal
      ? `<button class="btn btn-sm ${MPH.state.previewClient ? 'btn-primary' : 'btn-outline'}" data-act="preview-client" title="See exactly what your client sees">${ui.icon(MPH.state.previewClient ? 'eye-off' : 'eye')}${MPH.state.previewClient ? t('Back to producer view') : t('Preview client view')}</button>` : '';
    return `
      <header class="topbar">
        <div class="crumbs truncate">${crumbs}</div>
        <span class="spacer"></span>
        ${houseSwitch}${preview}
        <button class="btn btn-sm btn-ghost" data-act="toggle-lang">${MPH.state.lang === 'ar' ? 'EN' : 'عربي'}</button>
      </header>`;
  }

  function prodHeader(r, prod, access) {
    const client = access.isClient || MPH.state.previewClient;
    const allowed = (id) => !client || CLIENT_MODULES.includes(id);
    const current = phaseOf(prod);
    const order = PHASES.map((p) => p.id);
    const viewing = phaseForModule(r.view);
    const visible = PHASES.map((ph) => ({ ...ph, tabs: ph.tabs.filter(([id]) => allowed(id)) })).filter((ph) => ph.tabs.length);
    const stateOf = (ph) => order.indexOf(ph.id) < order.indexOf(current) ? 'done' : ph.id === current ? 'current' : 'next';
    const tab = ([id, label, icon, live]) => `<a href="#p.${prod.id}.${id}" class="${r.view === id ? 'active' : ''} ${live ? '' : 'soon'}">${ui.icon(icon)}${t(label)}${live ? '' : `<span class="soon-tag">${t('Soon')}</span>`}</a>`;
    const stepper = `
      <div class="phases" role="tablist">
        <a href="#p.${prod.id}.overview" class="phase-ov ${r.view === 'overview' ? 'active' : ''}">${ui.icon('layout-dashboard')}<span>${t('Overview')}</span></a>
        ${visible.map((ph, i) => {
          const st = stateOf(ph);
          const first = ph.tabs.find((x) => x[3]) || ph.tabs[0];
          return `<a href="#p.${prod.id}.${first[0]}" class="phase ${st} ${viewing && viewing.id === ph.id ? 'active' : ''}" style="--pc:${ph.color}">
            <span class="phase-num">${st === 'done' ? ui.icon('check') : i + 1}</span>
            <span class="stack" style="gap:0"><span class="phase-name">${t(ph.label)}</span><span class="phase-sub">${st === 'done' ? 'Complete' : st === 'current' ? 'In progress' : 'Up next'} · ${ph.tabs.filter((x) => x[3]).length} live</span></span></a>`;
        }).join('<span class="phase-link" aria-hidden="true"></span>')}
      </div>`;
    let steps = '';
    if (viewing) {
      const ph = visible.find((x) => x.id === viewing.id);
      if (ph) {
        const groups = (ph.groups || [ph.tabs.map(([id]) => id)]).map((g) => ph.tabs.filter(([id]) => g.includes(id)).map(tab).join('')).filter(Boolean);
        steps = `<nav class="steps" style="--pc:${ph.color}">${groups.map((g) => `<div class="step-group">${g}</div>`).join('')}</nav>`;
      }
    }
    return `
      <div class="prod-head">
        <div class="ph-top">
          ${ui.prodThumb(prod)}
          <div class="stack tight grow" style="gap:1px">
            <div class="row wrap"><span class="prod-title">${esc(MPH.state.lang === 'ar' && prod.title_ar ? prod.title_ar : prod.title)}</span>${ui.statusPill(prod.status)}</div>
            <span class="small muted">${esc(prod.client_name || 'No client yet')}${prod.agency ? ' · via ' + esc(prod.agency) : ''}${prod.format ? ' · ' + esc(prod.format) : ''}${prod.code ? ` · <span class="mono">${esc(prod.code)}</span>` : ''}</span>
          </div>
          ${prod.shoot_start ? `<div class="row small muted nowrap">${ui.icon('calendar')}Shoot ${MPH.date(prod.shoot_start)}${prod.shoot_end && prod.shoot_end !== prod.shoot_start ? '–' + MPH.date(prod.shoot_end) : ''}</div>` : ''}
        </div>
        ${stepper}${steps}
      </div>
      ${client ? `<div class="client-banner">${ui.icon('eye')}${access.isClient ? 'Client view' : 'Previewing the client view'}. Internal cost, margin, rates and crew detail are never sent to client accounts.</div>` : ''}`;
  }

  function soonPage(r, prod) {
    const ph = phaseForModule(r.view);
    const tab = ph && ph.tabs.find(([id]) => id === r.view);
    const label = tab ? tab[1] : r.view;
    return `<div class="page">${ui.empty('hammer', `${label} arrives in a later phase`, 'Phase 1 covers script, AI breakdown, shot list, stripboard, budget and bid, crew and call sheets. You can see how this screen will work in the click-through demo.',
      `<a class="btn btn-outline" href="${esc(cfg.demoUrl)}#p.desert-launch.${esc(r.view)}" target="_blank" rel="noopener">${ui.icon('external-link')}Open ${esc(label)} in the demo</a>`)}</div>`;
  }

  /* ------------------------------------------------------------ render */
  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    const r = parse();
    document.documentElement.lang = MPH.state.lang;
    document.documentElement.dir = MPH.state.lang === 'ar' ? 'rtl' : 'ltr';
    document.body.dataset.zone = 'production';

    if (!api.configured) {
      app.innerHTML = `<div class="auth"><div class="auth-card">${ui.empty('plug', 'Not connected yet', 'Add the Supabase project URL and publishable key to js/config.js.')}</div></div>`;
      return icons();
    }
    if (!MPH.session) await api.loadSession();
    if (seq !== renderSeq) return;

    // signed-out routes
    if (r.section === 'invite') {
      app.innerHTML = await inviteScreen(r.params[0]); icons(); return mountInvite(r.params[0]);
    }
    if (!MPH.session) {
      const mode = r.section === 'signup' ? 'signup' : 'login';
      const next = ['login', 'signup'].includes(r.section) ? r.params.join('.') : encodeURIComponent(location.hash.replace(/^#/, ''));
      app.innerHTML = authScreen(mode, { next }); icons(); return mountAuth(mode, next);
    }
    if (['login', 'signup'].includes(r.section)) return go(r.params.length ? decodeURIComponent(r.params.join('.')) : 'home');
    if (!MPH.session.orgs.length && !MPH.session.clientProductions.length || r.section === 'setup') {
      app.innerHTML = setupScreen(); icons(); return mountSetup();
    }

    // production context
    let prod = null, access = api.accessFor(null);
    if (r.section === 'p') {
      try { prod = await loadProduction(r.productionId); } catch (ex) { prod = null; }
      if (seq !== renderSeq) return;
      if (!prod) { MPH.toast('That production doesn’t exist or you don’t have access.', 'triangle-alert', 'error'); return go('productions'); }
      prodCache = prod;
      access = api.accessFor(prod);
      if (!access.canSeeInternal) MPH.state.previewClient = false;
    }

    app.innerHTML = `
      <div class="shell">
        ${rail(r)}
        <main class="main">
          ${topbar(r, prod, access)}
          ${prod ? prodHeader(r, prod, access) : ''}
          <div class="content" id="content"><div id="view"></div></div>
        </main>
      </div>`;
    icons();
    await renderView(r, prod, access, seq);
  }
  MPH.render = render;

  async function renderView(r, prod, access, seq = renderSeq) {
    const old = document.getElementById('view');
    if (!old) return;
    const root = document.createElement('div');
    root.id = 'view';
    old.replaceWith(root);

    const clientish = access.isClient || MPH.state.previewClient;
    if (prod && clientish && !CLIENT_MODULES.includes(r.view)) {
      root.innerHTML = `<div class="page">${ui.empty('lock', 'Not shared with clients', 'This module holds internal production detail.')}</div>`; return icons();
    }
    if (prod && !isLive(r.view)) { root.innerHTML = soonPage(r, prod); return icons(); }

    const view = MPH.views[r.view];
    if (!view) { root.innerHTML = `<div class="page">${ui.empty('compass', 'Page not found', '', '<a class="btn btn-outline" href="#home">Go home</a>')}</div>`; return icons(); }

    const ctx = {
      route: r, params: r.params, production: prod, ...access,
      isClient: clientish, // client screens render for real clients and for producer preview
      realClient: access.isClient,
      go, reload: () => renderView(r, prod, access), refreshAll: render,
      toast: MPH.toast, toastError: MPH.toastError, modal: MPH.modal, drawer: MPH.drawer, closeOverlay, frame: MPH.frame,
      t, ui, esc, api, sb: MPH.sb, state: MPH.state, session: MPH.session,
    };
    try {
      let data;
      if (view.load) {
        root.innerHTML = ui.loading(); icons();
        data = await view.load(ctx);
        if (seq !== renderSeq || !root.isConnected) return;
      }
      root.innerHTML = view.render(ctx, data);
      icons();
      if (view.mount) await view.mount(root, ctx, data);
      icons();
    } catch (err) {
      console.error(err);
      root.innerHTML = `<div class="page">${ui.errorBox(err.message || String(err))}<div><button class="btn btn-outline btn-sm" data-act="retry">Try again</button></div></div>`;
      icons();
      root.querySelector('[data-act=retry]').addEventListener('click', () => renderView(r, prod, access));
    }
  }

  /* ------------------------------------------------------------ global actions */
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const a = el.dataset.act;
    if (a === 'toggle-lang') { MPH.state.lang = MPH.state.lang === 'ar' ? 'en' : 'ar'; MPH.saveState(); render(); }
    else if (a === 'preview-client') {
      MPH.state.previewClient = !MPH.state.previewClient;
      const r = parse();
      if (MPH.state.previewClient && r.section === 'p' && !CLIENT_MODULES.includes(r.view)) go(`p.${r.productionId}.overview`); else render();
      MPH.toast(MPH.state.previewClient ? 'Showing what your client sees' : 'Back to producer view', 'eye');
    } else if (a === 'signout') { await api.signOut(); MPH.session = null; go('login'); }
  });
  document.addEventListener('change', async (e) => {
    if (e.target.id === 'org-switch') { MPH.state.orgId = e.target.value; MPH.saveState(); await api.loadSession(); go('home'); }
  });

  if (MPH.sb) {
    MPH.sb.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { MPH.session = null; render(); }
      if (event === 'PASSWORD_RECOVERY') go('account');
    });
  }
  window.addEventListener('hashchange', render);
  render();
})();

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
    /* each phase is an ordered sequence of steps, grouped into activities (tabs keep the same order) */
    { id: 'pre', label: 'Pre-production', icon: 'pencil-ruler', color: '#ACD062',
      tabs: [['script', 'Script', 'file-text', 1], ['treatment', 'Treatment & Lookbook', 'gallery-vertical-end', 1],
             ['breakdown', 'AI Breakdown', 'scan-text', 1],
             ['storyboard', 'Storyboard', 'layout-grid', 1], ['shotlist', 'Shot List', 'list-video', 1],
             ['stripboard', 'Stripboard', 'rows-3', 1], ['calendar', 'Calendar', 'calendar-days', 1],
             ['budget', 'Budget & Bid', 'calculator', 1]],
      groups: [['Story', ['script', 'treatment']], ['Breakdown', ['breakdown']], ['Visualize', ['storyboard', 'shotlist']],
               ['Schedule', ['stripboard', 'calendar']], ['Budget', ['budget']]] },
    { id: 'prod', label: 'Production', icon: 'clapperboard', color: '#FAB771',
      tabs: [['crew', 'Crew & Talent', 'users', 1], ['locations', 'Locations', 'map-pin', 1], ['callsheets', 'Call Sheets', 'clipboard-list', 1], ['shootday', 'Shoot Day', 'radio', 1]],
      groups: [['Team & places', ['crew', 'locations']], ['Shoot', ['callsheets', 'shootday']]] },
    { id: 'post', label: 'Post-production', icon: 'film', color: '#7FB2A6',
      tabs: [['dailies', 'Dailies & Media', 'hard-drive'], ['edit', 'Edit & Versions', 'scissors'], ['review', 'Review & Approvals', 'circle-check-big'],
             ['finishing', 'Finishing', 'wand-sparkles'], ['deliverables', 'Deliverables', 'package-check'], ['wrap', 'Wrap Report', 'file-bar-chart']],
      groups: [['Edit', ['dailies', 'edit']], ['Approve', ['review']], ['Finish & deliver', ['finishing', 'deliverables']], ['Close', ['wrap']]] },
  ];
  const CLIENT_MODULES = ['overview', 'treatment', 'script', 'storyboard', 'calendar', 'budget', 'docs'];
  const phaseOf = (prod) => ({ 'Development': 'pre', 'Bidding': 'pre', 'Pre-production': 'pre', 'Shooting': 'prod', 'Post-production': 'post', 'Delivered': 'post' }[prod.status] || 'pre');
  const phaseForModule = (mod) => PHASES.find((ph) => ph.tabs.some(([id]) => id === mod));
  const isLive = (mod) => mod === 'overview' || mod === 'docs' || PHASES.some((ph) => ph.tabs.some(([id, , , live]) => id === mod && live));
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

  /* ------------------------------------------------------------ auth screens
     Split layout: an animated picture of the product at work (stripboard strips drifting past, the AI
     tagging a script line in English and Arabic) beside a minimal form. */
  const STRIPS = [
    ['1', 'EXT', 'Desert highway', '1/8', 'dawn'], ['2', 'INT', 'Majlis, Al Malqa', '2/8', 'intday'],
    ['3', 'EXT', 'At-Turaif, Diriyah', '2/8', 'extday'], ['', '', 'End of day 1', '', 'break'],
    ['4', 'EXT', 'Desert camp', '3/8', 'extnight'], ['5', 'EXT', 'Dune ridge', '1/8', 'dawn'],
    ['6', 'INT', 'Studio packshot', '1/8', 'intday'], ['7', 'INT', 'Car interior', '1/8', 'intnight'],
    ['', '', 'End of day 2', '', 'break'], ['8', 'EXT', 'Boulevard', '2/8', 'extnight'],
    ['9', 'EXT', 'Wadi Hanifa', '3/8', 'extday'], ['10', 'INT', 'Coffee house', '2/8', 'intday'],
  ];
  const stripHtml = (list) => list.map(([n, ie, set, pg, k]) => k === 'break'
    ? `<div class="aa-strip s-break">${esc(set)}</div>`
    : `<div class="aa-strip s-${k}"><b>${n}</b><span>${ie} · ${esc(set)}</span><i>${pg}</i></div>`).join('');
  const rotate = (arr, n) => arr.slice(n).concat(arr.slice(0, n));
  function authArt() {
    const col = (n, dur) => `<div class="aa-col" style="--dur:${dur}s"><div class="aa-track">${stripHtml(rotate(STRIPS, n))}${stripHtml(rotate(STRIPS, n))}</div></div>`;
    return `
      <aside class="aa" aria-hidden="true">
        <div class="aa-strips">${col(0, 46)}${col(4, 62)}${col(8, 54)}</div>
        <div class="aa-glow"></div>
        <div class="aa-card">
          <div class="aa-card-head"><span class="aa-live"></span>AI Breakdown<span class="aa-sc">Sc. 3</span></div>
          <p class="aa-slug">EXT. AT-TURAIF, DIRIYAH – GOLDEN HOUR</p>
          <p class="aa-line">The <mark class="aa-w w1 cat-vehicles">family SUV</mark> glides past the <mark class="aa-w w2 cat-location">mud-brick walls</mark>. <mark class="aa-w w3 cat-extras">Tourists</mark> turn to look.</p>
          <p class="aa-line aa-ar" dir="rtl" lang="ar"><mark class="aa-w w5 cat-cast">نورة</mark>: «شف يبه… <mark class="aa-w w4 cat-vfx">نجمة تطير</mark>!»</p>
          <div class="aa-chips">
            <span class="aa-chip c1 cat-vehicles">Vehicles</span><span class="aa-chip c2 cat-location">Location</span>
            <span class="aa-chip c3 cat-extras">Extras ×12</span><span class="aa-chip c5 cat-cast">Cast · Noura</span><span class="aa-chip c4 cat-vfx">VFX · shooting star</span>
          </div>
        </div>
        <div class="aa-foot">
          <p class="aa-tag">Seamless production for every story.</p>
          <p class="aa-sub">One connected workspace from first draft to final delivery. Script, schedule, budget and call sheets stay in step, so every shoot runs smoother and everyone on set knows exactly what’s next.</p>
        </div>
      </aside>`;
  }
  /* shared frame for sign-in, sign-up, onboarding and invite screens: form on the start side, picture on the end side */
  const authShell = (inner) => `
    <div class="auth2">
      <main class="auth-panel">
        <div class="auth-inner">
          <a class="auth-logo" href="#login" aria-label="${esc(cfg.brandLong)}"><span class="auth-mark">${esc(cfg.brand)}</span><span>${esc(cfg.brandLong)}</span></a>
          ${inner}
        </div>
      </main>
      ${authArt()}
    </div>`;

  /* borderless floating-label field. The label sits inside and floats up once there's a value. */
  const fx = ({ id, label, icon, type = 'text', value = '', autocomplete = '', dir = '', end = '', attrs = '' }) => `
    <label class="fx" for="${id}">
      <span class="fx-icon">${ui.icon(icon)}</span>
      <input id="${id}" class="fx-input" type="${type}" placeholder=" " value="${esc(value)}"${autocomplete ? ` autocomplete="${autocomplete}"` : ''}${dir ? ` dir="${dir}"` : ''} ${attrs}>
      <span class="fx-label">${esc(label)}</span>
      ${end}
      <span class="fx-line" aria-hidden="true"></span>
    </label>`;

  /* pointer spotlight on fields, cards and buttons: sets --mx/--my for the CSS glow */
  function wireGlow(root) {
    root.querySelectorAll('.fx, .acct-card, .auth-submit, .msel-trigger').forEach((el) => {
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', `${e.clientX - r.left}px`);
        el.style.setProperty('--my', `${e.clientY - r.top}px`);
      });
    });
  }
  const shake = (el) => { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); };
  /* open/close a collapsing row; "settled" (overflow visible) is added once the slide has finished */
  const setCollapse = (el, open) => {
    clearTimeout(el._settle);
    el.classList.remove('settled');
    if (open) { el.removeAttribute('inert'); el._settle = setTimeout(() => el.classList.add('settled'), 450); }
    else el.setAttribute('inert', '');
  };
  const settleOpen = (root) => root.querySelectorAll('.au-collapse:not([inert])').forEach((el) => el.classList.add('settled'));

  const AUTH_COPY = {
    login: { title: 'Welcome back', sub: 'Sign in to your workspace.', button: 'Sign in' },
    signup: { title: 'Create your account', sub: 'For everyone in production: producers, crew, talent, agencies and brands. Free to start.', button: 'Create account' },
  };

  function authScreen(mode, info = {}) {
    const signup = mode === 'signup';
    const copy = AUTH_COPY[mode];
    return authShell(`
      <div class="stack tight">
        <h1 class="auth-title" id="au-title">${info.title || copy.title}</h1>
        <p class="muted" id="au-sub">${info.sub || copy.sub}</p>
      </div>
      ${info.title ? '' : `<div class="auth-switch" role="tablist" data-mode="${mode}">
        <span class="auth-switch-pill" aria-hidden="true"></span>
        <button type="button" role="tab" data-mode-to="login" aria-selected="${!signup}">Sign in</button>
        <button type="button" role="tab" data-mode-to="signup" aria-selected="${signup}">Create account</button>
      </div>`}
      <form id="auth-form" class="auth-form" data-mode="${mode}" novalidate>
        <div class="au-collapse" data-only="signup" ${signup ? '' : 'inert'}><div>${fx({ id: 'au-name', label: 'Full name', icon: 'user-round', autocomplete: 'name' })}</div></div>
        ${fx({ id: 'au-email', label: 'Email', icon: 'mail', type: 'email', value: info.email || '', autocomplete: 'email' })}
        ${fx({ id: 'au-pass', label: 'Password', icon: 'lock-keyhole', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', attrs: 'minlength="8"',
               end: `<button type="button" class="fx-end" id="au-eye" aria-label="Show password">${ui.icon('eye')}</button>` })}
        <div class="row between au-meta">
          <span class="tiny faint" data-only="signup" ${signup ? '' : 'hidden'}>At least 8 characters</span>
          <button class="auth-link" type="button" id="au-forgot" data-only="login" ${signup ? 'hidden' : ''}>Forgot password?</button>
        </div>
        <div id="au-error" hidden></div>
        <button class="btn btn-primary auth-submit" type="submit" id="au-submit"><span id="au-btn-text">${copy.button}</span>${ui.icon('arrow-right')}</button>
      </form>
      <a class="auth-demo" href="${esc(cfg.demoUrl)}" target="_blank" rel="noopener">${ui.icon('play')}Just looking? Watch the click-through demo</a>`);
  }

  function mountAuth(mode, next) {
    const form = document.getElementById('auth-form');
    const err = document.getElementById('au-error');
    const show = (m, bad = true) => { err.hidden = false; err.innerHTML = ui.errorBox(m); icons(); if (bad) shake(form); };
    wireGlow(document.getElementById('app'));
    settleOpen(form);

    // switch Sign in / Create account in place: the pill slides, the name field opens, copy changes
    const sw = document.querySelector('.auth-switch');
    const setMode = (m) => {
      mode = m;
      const signup = m === 'signup';
      sw.dataset.mode = m; form.dataset.mode = m;
      sw.querySelectorAll('[data-mode-to]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.modeTo === m)));
      form.querySelectorAll('[data-only]').forEach((el) => {
        const on = el.dataset.only === m;
        if (el.classList.contains('au-collapse')) setCollapse(el, on);
        else el.hidden = !on;
      });
      document.getElementById('au-title').textContent = AUTH_COPY[m].title;
      document.getElementById('au-sub').textContent = AUTH_COPY[m].sub;
      document.getElementById('au-btn-text').textContent = AUTH_COPY[m].button;
      document.getElementById('au-pass').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
      err.hidden = true;
      history.replaceState(null, '', `#${m}${next ? '.' + next : ''}`);
      (signup ? document.getElementById('au-name') : document.getElementById('au-email')).focus({ preventScroll: true });
    };
    if (sw) sw.addEventListener('click', (e) => { const b = e.target.closest('[data-mode-to]'); if (b && b.dataset.modeTo !== mode) setMode(b.dataset.modeTo); });

    const eye = document.getElementById('au-eye');
    if (eye) eye.addEventListener('click', () => {
      const f = document.getElementById('au-pass');
      const showing = f.type === 'text';
      f.type = showing ? 'password' : 'text';
      eye.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      eye.innerHTML = ui.icon(showing ? 'eye' : 'eye-off'); icons();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('au-email').value.trim();
      const pass = document.getElementById('au-pass').value;
      if (!email || pass.length < 8) return show('Enter your email and a password of at least 8 characters.');
      const btn = document.getElementById('au-submit');
      const reset = () => { btn.disabled = false; btn.classList.remove('busy'); btn.innerHTML = `<span id="au-btn-text">${AUTH_COPY[mode].button}</span>${ui.icon('arrow-right')}`; icons(); };
      if (mode === 'signup' && !document.getElementById('au-name').value.trim()) return show('Add your full name.');
      btn.disabled = true; btn.classList.add('busy'); btn.innerHTML = `${ui.spinner()} Please wait`;
      try {
        if (mode === 'signup') {
          const name = document.getElementById('au-name').value.trim();
          const { data, error } = await api.signUp(email, pass, name);
          if (error) throw error;
          if (!data.session) { show('Check your email to confirm your account, then sign in.', false); reset(); return; }
        } else {
          const { error } = await api.signIn(email, pass);
          if (error) throw new Error(error.message === 'Invalid login credentials' ? 'That email and password don’t match an account.' : error.message);
        }
        await api.loadSession();
        go(next ? decodeURIComponent(next) : 'home');
      } catch (ex) {
        show(ex.message); reset();
      }
    });
    const forgot = document.getElementById('au-forgot');
    if (forgot) forgot.addEventListener('click', async () => {
      const email = document.getElementById('au-email').value.trim();
      if (!email) return show('Type your email first, then choose Forgot password.');
      const { error } = await api.resetPassword(email);
      show(error ? error.message : 'If that email has an account, a reset link is on its way.', !!error);
    });
  }

  /* ------------------------------------------------------------ onboarding: about you */
  const PROFESSIONS = [
    ['Production', ['Producer', 'Executive producer', 'Line producer', 'Production manager', 'Production coordinator', 'Production assistant']],
    ['Direction', ['Director', 'Assistant director', 'Script supervisor']],
    ['Camera & lighting', ['Director of photography', 'Camera operator', 'Camera assistant', 'Drone operator', 'Gaffer', 'Grip', 'Photographer', 'DIT']],
    ['Art & costume', ['Production designer', 'Art director', 'Set decorator', 'Props master', 'Wardrobe stylist', 'Hair & makeup']],
    ['Sound & music', ['Sound recordist', 'Sound designer', 'Composer']],
    ['Post-production', ['Editor', 'Colourist', 'VFX artist', 'Motion designer']],
    ['Talent', ['Actor', 'Voice artist', 'Presenter', 'Model', 'Extra / background']],
    ['Writing, casting & locations', ['Writer', 'Casting director', 'Location manager']],
    ['Other', ['Student', 'Other']],
  ];
  const SERVICES = [
    ['What your company does', ['Production house', 'Advertising agency', 'Brand / client', 'Equipment rental', 'Post-production house', 'Studio / stage', 'Casting agency', 'Location services', 'Catering & transport', 'Talent management', 'Film school', 'Other']],
  ];

  /* searchable multi-select dropdown */
  const msel = (id, label, icon) => `
    <div class="msel" id="${id}">
      <button type="button" class="msel-trigger" aria-haspopup="listbox" aria-expanded="false">
        <span class="fx-icon">${ui.icon(icon)}</span>
        <span class="msel-body"><span class="msel-label">${esc(label)}</span><span class="msel-chips"></span></span>
        <span class="msel-chev">${ui.icon('chevron-down')}</span>
        <span class="fx-line" aria-hidden="true"></span>
      </button>
      <div class="msel-pop" hidden>
        <div class="msel-search">${ui.icon('search')}<input type="text" placeholder="Search" aria-label="Search options"></div>
        <div class="msel-list" role="listbox" aria-multiselectable="true"></div>
      </div>
    </div>`;
  function wireMsel(root, id, groups, selected) {
    const box = root.querySelector('#' + id);
    const trigger = box.querySelector('.msel-trigger');
    const pop = box.querySelector('.msel-pop');
    const list = box.querySelector('.msel-list');
    const search = box.querySelector('.msel-search input');
    const paintChips = () => {
      const chips = box.querySelector('.msel-chips');
      box.classList.toggle('has-value', selected.size > 0);
      chips.innerHTML = [...selected].map((v) => `<span class="msel-chip">${esc(v)}<span class="msel-x" data-remove="${esc(v)}" role="button" aria-label="Remove ${esc(v)}">${ui.icon('x')}</span></span>`).join('');
      icons();
    };
    const paintList = () => {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = groups.map(([group, items]) => {
        const hits = items.filter((v) => !q || v.toLowerCase().includes(q));
        return hits.length ? `<div class="msel-group">${esc(group)}</div>${hits.map((v) => `
          <button type="button" class="msel-opt ${selected.has(v) ? 'on' : ''}" role="option" aria-selected="${selected.has(v)}" data-value="${esc(v)}">
            <span class="msel-box">${ui.icon('check')}</span>${esc(v)}</button>`).join('')}` : '';
      }).join('') || '<div class="msel-empty">No match. Choose “Other”.</div>';
      icons();
    };
    const open = (v) => {
      pop.hidden = !v; box.classList.toggle('open', v); trigger.setAttribute('aria-expanded', String(v));
      if (v) { search.value = ''; paintList(); setTimeout(() => search.focus(), 30); }
    };
    trigger.addEventListener('click', (e) => {
      const x = e.target.closest('[data-remove]');
      if (x) { selected.delete(x.dataset.remove); paintChips(); if (!pop.hidden) paintList(); e.stopPropagation(); return; }
      open(pop.hidden);
    });
    list.addEventListener('click', (e) => {
      const o = e.target.closest('[data-value]'); if (!o) return;
      const v = o.dataset.value;
      if (selected.has(v)) selected.delete(v); else selected.add(v);
      o.classList.toggle('on'); o.setAttribute('aria-selected', String(selected.has(v)));
      paintChips();
    });
    search.addEventListener('input', paintList);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { open(false); trigger.focus(); }
      if (e.key === 'Enter') { e.preventDefault(); const first = list.querySelector('[data-value]'); if (first) first.click(); }
    });
    document.addEventListener('click', function outside(e) {
      if (!document.body.contains(box)) return document.removeEventListener('click', outside);
      if (!box.contains(e.target)) open(false);
    });
    paintChips();
    return { reset: (g) => { groups = g; selected.clear(); paintChips(); open(false); } };
  }

  function onboardingScreen(opts = {}) {
    const p = MPH.session.profile;
    const first = (p.full_name || '').split(' ')[0];
    const type = opts.newWorkspace ? 'company' : (p.account_type || '');
    return authShell(`
      <div class="stack tight">
        <span class="eyebrow">${opts.newWorkspace ? 'New workspace' : `Welcome${first ? ', ' + esc(first) : ''}`}</span>
        <h1 class="auth-title">${opts.newWorkspace ? 'Set up another workspace' : 'Tell us about you'}</h1>
        <p class="muted">${opts.newWorkspace ? 'A separate workspace for another company, with its own productions and team.' : 'So we can shape your workspace. You can change this later.'}</p>
      </div>
      <form id="ob-form" class="auth-form" data-type="${type}" novalidate>
        <div class="acct-cards" role="radiogroup" aria-label="Account type" ${opts.newWorkspace ? 'hidden' : ''}>
          <button type="button" class="acct-card" role="radio" data-type="individual" aria-checked="${type === 'individual'}">
            <span class="acct-ico">${ui.icon('user-round')}</span><span class="acct-name">Individual</span><span class="acct-desc">Freelancer, crew, talent or student</span>
            <span class="acct-tick">${ui.icon('check')}</span></button>
          <button type="button" class="acct-card" role="radio" data-type="company" aria-checked="${type === 'company'}">
            <span class="acct-ico">${ui.icon('building-2')}</span><span class="acct-name">Company</span><span class="acct-desc">Production house, agency, brand or supplier</span>
            <span class="acct-tick">${ui.icon('check')}</span></button>
        </div>
        <div class="au-collapse" data-only="company" ${type === 'company' ? '' : 'inert'}><div>${fx({ id: 'ob-company', label: 'Company name', icon: 'building-2', autocomplete: 'organization', value: opts.newWorkspace ? '' : (p.company_name || '') })}</div></div>
        <div class="au-collapse" data-only="any" ${type ? '' : 'inert'}><div>${msel('ob-prof', type === 'company' ? 'What does your company do?' : 'What do you do?', 'briefcase-business')}</div></div>
        <div id="ob-error" hidden></div>
        <button class="btn btn-primary auth-submit" type="submit" id="ob-submit"><span>Continue</span>${ui.icon('arrow-right')}</button>
      </form>
      <button class="auth-demo" data-act="signout">${ui.icon('log-out')}${t('Sign out')}</button>`);
  }
  function mountOnboarding(opts = {}) {
    const root = document.getElementById('app');
    const form = document.getElementById('ob-form');
    const err = document.getElementById('ob-error');
    const p = MPH.session.profile;
    wireGlow(root);
    settleOpen(form);
    let type = form.dataset.type || '';
    const chosen = new Set(opts.newWorkspace ? [] : (p.professions || []));
    const ms = wireMsel(root, 'ob-prof', type === 'company' ? SERVICES : PROFESSIONS, chosen);
    const setType = (t2) => {
      if (t2 === type) return;
      const changedKind = type && type !== t2;
      type = t2; form.dataset.type = t2;
      form.querySelectorAll('.acct-card').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.type === t2)));
      form.querySelectorAll('.au-collapse').forEach((el) => {
        const on = el.dataset.only === 'any' || el.dataset.only === t2;
        if (on !== !el.hasAttribute('inert')) setCollapse(el, on);
      });
      form.querySelector('.msel-label').textContent = t2 === 'company' ? 'What does your company do?' : 'What do you do?';
      if (changedKind || !chosen.size) ms.reset(t2 === 'company' ? SERVICES : PROFESSIONS);
      err.hidden = true;
      if (t2 === 'company') setTimeout(() => document.getElementById('ob-company').focus({ preventScroll: true }), 220);
    };
    form.querySelectorAll('.acct-card').forEach((c) => c.addEventListener('click', () => setType(c.dataset.type)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fail = (m) => { err.hidden = false; err.innerHTML = ui.errorBox(m); icons(); shake(form); };
      if (!type) return fail('Choose Individual or Company.');
      const company = document.getElementById('ob-company').value.trim();
      if (type === 'company' && !company) return fail('Add your company name.');
      if (!chosen.size) return fail(type === 'company' ? 'Choose at least one thing your company does.' : 'Choose at least one profession.');
      const btn = document.getElementById('ob-submit');
      btn.disabled = true; btn.innerHTML = `${ui.spinner()} Setting up`;
      try {
        const s = MPH.session;
        if (!opts.newWorkspace) {
          api.must(await MPH.sb.from('profiles').update({
            account_type: type, professions: [...chosen], company_name: type === 'company' ? company : null, onboarded_at: new Date().toISOString(),
          }).eq('id', s.user.id));
        }
        // a workspace for new users (or on request); invited people already belong to someone else's
        if (opts.newWorkspace || (!s.orgs.length && !s.clientProductions.length)) {
          const name = type === 'company' ? company : (s.profile.full_name || s.user.email.split('@')[0]);
          const orgId = api.must(await MPH.sb.rpc('create_org', { p_name: name, p_kind: type, p_services: type === 'company' ? [...chosen] : [] }));
          MPH.state.orgId = orgId; MPH.saveState();
        }
        await api.loadSession();
        MPH.toast(opts.newWorkspace ? 'Workspace created' : 'You’re all set');
        go('home');
      } catch (ex) { btn.disabled = false; btn.innerHTML = `<span>Continue</span>${ui.icon('arrow-right')}`; fail(ex.message); }
    });
  }

  /* invite link */
  async function inviteScreen(token) {
    const info = (await MPH.sb.rpc('invite_info', { p_token: token })).data;
    if (!info) return authShell(ui.empty('link-2-off', 'This invite link isn’t valid', 'Ask the producer to send you a new one.', `<a class="btn btn-outline" href="#login">Go to sign in</a>`));
    const what = info.role === 'client' ? `review <strong>${esc(info.production)}</strong> as the client` : `join <strong>${esc(info.org)}</strong> as ${info.role === 'hod' ? 'a head of department' : 'a ' + esc(info.role)}`;
    if (info.used) return authShell(ui.empty('circle-check', 'This invite has already been used', 'Sign in to continue.', `<a class="btn btn-primary" href="#login">Sign in</a>`));
    if (!MPH.session) return authScreen('signup', { title: 'You’re invited', sub: `Create an account to ${what}. Use ${esc(info.email)}.`, email: info.email, next: encodeURIComponent('invite.' + token) });
    return authShell(`
      <div class="stack tight"><span class="eyebrow">Invite</span><h1 class="auth-title">You’re invited</h1><p class="muted">Accept to ${what}.</p></div>
      <div id="inv-error" hidden></div>
      <button class="btn btn-primary auth-submit" id="inv-accept">${ui.icon('check')}Accept invite</button>`);
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
      const here = tab ? tab[1] : r.view === 'docs' ? 'Documents' : 'Overview';
      crumbs += `${sep}<a href="#productions">${t('Productions')}</a>${sep}<a href="#p.${prod.id}.overview">${esc(prod.title)}</a>${sep}<span class="here">${t(here)}</span>`;
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
        // grouped, numbered activities, in sequence: "1 Story · Script, Treatment" …
        const groups = (ph.groups || [['', ph.tabs.map(([id]) => id)]])
          .map(([label, ids]) => [label, ph.tabs.filter(([id]) => ids.includes(id)).map(tab).join('')])
          .filter(([, html]) => html);
        steps = `<nav class="steps" style="--pc:${ph.color}">${groups.map(([label, html], i) => `
          <div class="step-group">${label ? `<span class="step-group-label"><b>${i + 1}</b>${esc(t(label))}</span>` : ''}<div class="step-group-tabs">${html}</div></div>`).join('')}</nav>`;
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
          <a class="ph-docs ${r.view === 'docs' ? 'active' : ''}" href="#p.${prod.id}.docs">${ui.icon('folder-open')}${t('Documents')}</a>
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
      app.innerHTML = authShell(ui.empty('plug', 'Not connected yet', 'Add the Supabase project URL and publishable key to js/config.js.'));
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
    // onboarding: first sign-in (about you), a user with nowhere to work yet, or "new workspace" from Account
    const s0 = MPH.session;
    if (r.section === 'setup' || !s0.profile.onboarded_at || (!s0.orgs.length && !s0.clientProductions.length)) {
      const opts = { newWorkspace: r.section === 'setup' && !!s0.profile.onboarded_at };
      app.innerHTML = onboardingScreen(opts); icons(); return mountOnboarding(opts);
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

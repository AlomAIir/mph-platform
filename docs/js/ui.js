/* MPH UI helpers: small functions that return HTML strings. Build every screen with these. */
(function () {
  const { esc } = MPH;
  const UI = (MPH.ui = {});

  /* Lucide icon placeholder; the app calls lucide.createIcons() after each render (or call MPH.icons()) */
  UI.icon = (name, cls = '') => `<i data-lucide="${name}"${cls ? ` class="${cls}"` : ''}></i>`;

  UI.initials = (name) => String(name || '?').split(/\s+/).filter((w) => !/^(al|el|bin|abu|umm)[-]?$/i.test(w))
    .map((w) => w.replace(/^Al-/i, '')[0] || '').slice(0, 2).join('').toUpperCase() || '?';

  /* avatar from a person-like object ({name|full_name|email}) or a name string. size: '', 'sm', 'lg', 'xl' */
  UI.av = (p, size = '') => {
    const name = typeof p === 'string' ? p : (p?.full_name || p?.name || p?.email || '?');
    return `<span class="av ${size}" style="--h:${MPH.hue(name)}" title="${esc(name)}">${esc(UI.initials(name))}</span>`;
  };
  UI.avStack = (list, max = 5, size = 'sm') => {
    const shown = list.slice(0, max).map((p) => UI.av(p, size)).join('');
    const more = list.length > max ? `<span class="av ${size}" style="background:var(--raised-2);color:var(--text-2)">+${list.length - max}</span>` : '';
    return `<span class="av-stack">${shown}${more}</span>`;
  };

  UI.pill = (text, kind = '', icon = '') => `<span class="pill ${kind}">${icon ? UI.icon(icon) : ''}${esc(text)}</span>`;
  UI.statusPill = (status) => {
    const kind = { 'Development': '', 'Bidding': 'warn', 'Pre-production': 'info', 'Shooting': 'accent', 'Post-production': 'market', 'Delivered': 'ok' }[status] ?? '';
    return UI.pill(status, kind);
  };

  /* breakdown categories (ids match the database check constraint) */
  UI.CATEGORIES = [
    { id: 'cast', label: 'Cast', icon: 'user-round' },
    { id: 'extras', label: 'Extras', icon: 'users' },
    { id: 'props', label: 'Props', icon: 'coffee' },
    { id: 'wardrobe', label: 'Wardrobe', icon: 'shirt' },
    { id: 'makeup', label: 'Hair & Makeup', icon: 'brush' },
    { id: 'vehicles', label: 'Vehicles', icon: 'car' },
    { id: 'location', label: 'Locations', icon: 'map-pin' },
    { id: 'sfx', label: 'Special Effects', icon: 'flame' },
    { id: 'equipment', label: 'Special Equipment', icon: 'aperture' },
    { id: 'animals', label: 'Animals', icon: 'paw-print' },
    { id: 'sound', label: 'Sound & Music', icon: 'music' },
    { id: 'vfx', label: 'VFX & Graphics', icon: 'sparkles' },
    { id: 'stunts', label: 'Stunts', icon: 'zap' },
  ];
  UI.cat = (id) => UI.CATEGORIES.find((c) => c.id === id);
  UI.catTag = (id, text) => {
    const c = UI.cat(id);
    return `<span class="tag cat-${id}">${UI.icon(c?.icon || 'tag')}${esc(text ?? c?.label ?? id)}</span>`;
  };

  /* production cover: deterministic gradient from the production id */
  UI.coverStyle = (prod) => {
    const h = MPH.hue(prod.id || prod.title);
    return `background:linear-gradient(135deg, hsl(${h} 35% 24%), hsl(${(h + 30) % 360} 45% 42%));`;
  };
  UI.prodThumb = (prod, size = 38) => prod.cover && MPH.sketch
    ? `<span class="prod-thumb" style="width:${size}px;height:${size}px;display:block;overflow:hidden;flex:none">${MPH.sketch(prod.cover, { wide: true })}</span>`
    : UI.prodThumbPlain(prod, size);
  UI.prodThumbPlain = (prod, size = 38) =>
    `<span class="prod-thumb" style="${UI.coverStyle(prod)};width:${size}px;height:${size}px;display:grid;place-items:center;color:rgba(255,255,255,.85);font:700 ${Math.round(size * 0.36)}px/1 var(--font-display)">${esc(UI.initials(prod.title))}</span>`;

  UI.stat = (value, label, extra = '') => `<div class="stat"><span class="v">${value}</span><span class="l">${esc(label)}</span>${extra}</div>`;

  UI.panel = ({ title, icon, actions = '', body = '', flush = false, cls = '' }) => `
    <section class="panel ${flush ? 'flush' : ''} ${cls}">
      ${title ? `<header class="panel-head">${icon ? UI.icon(icon) : ''}<h3 class="h3">${esc(title)}</h3>${actions}</header>` : ''}
      <div class="panel-body">${body}</div>
    </section>`;

  UI.empty = (icon, title, text = '', action = '') => `
    <div class="empty">${UI.icon(icon)}<div class="h3" style="color:var(--text)">${esc(title)}</div>${text ? `<p class="small" style="max-width:52ch">${esc(text)}</p>` : ''}${action}</div>`;

  UI.bar = (ratio, cls = '') => `<div class="bar ${cls}"><span style="width:${Math.max(0, Math.min(1, ratio || 0)) * 100}%"></span></div>`;
  UI.aiBadge = (text = 'AI') => `<span class="ai-badge">${UI.icon('sparkles')}${esc(text)}</span>`;

  UI.pageHead = ({ eyebrow = '', title, sub = '', actions = '' }) => `
    <header class="page-head">
      <div class="grow stack tight">
        ${eyebrow ? `<span class="eyebrow">${eyebrow}</span>` : ''}
        <h1 class="h1">${title}</h1>
        ${sub ? `<p class="muted">${sub}</p>` : ''}
      </div>
      ${actions ? `<div class="toolbar">${actions}</div>` : ''}
    </header>`;

  UI.lockNote = (text = 'Internal only. Clients never see this.') => `<span class="lock-note">${UI.icon('lock')}${esc(text)}</span>`;

  UI.loading = (text = 'Loading…') => `<div class="page"><div class="empty"><span class="spin"></span><span class="small">${esc(text)}</span></div></div>`;
  UI.spinner = () => '<span class="spin sm"></span>';
  UI.errorBox = (msg) => `<div class="callout danger">${UI.icon('triangle-alert')}<span class="small">${esc(msg)}</span></div>`;

  /* WhatsApp glyph */
  UI.wa = (size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" style="flex:none"><path fill="#25D366" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Z"/><path fill="#fff" d="M17.3 14.4c-.3-.1-1.7-.8-1.9-.9-.3-.1-.5-.1-.7.1l-.9 1.1c-.2.2-.3.2-.6.1a7.8 7.8 0 0 1-3.9-3.4c-.3-.5.3-.5.8-1.6.1-.2 0-.4 0-.5l-.9-2.1c-.2-.5-.5-.5-.7-.5h-.6a1.1 1.1 0 0 0-.8.4 3.3 3.3 0 0 0-1 2.5 5.8 5.8 0 0 0 1.2 3 13 13 0 0 0 5 4.4c1.8.8 2.6.9 3.5.7a3 3 0 0 0 2-1.4 2.4 2.4 0 0 0 .2-1.4c-.1-.2-.3-.3-.7-.5Z"/></svg>`;

  /* WhatsApp share link (opens WhatsApp with a prefilled message) */
  /* Saudi numbers: 05XXXXXXXX or 5XXXXXXXX become 9665XXXXXXXX; anything with a country code is kept */
  UI.waNumber = (phone) => {
    let d = String(phone || '').replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (/^05\d{8}$/.test(d)) d = '966' + d.slice(1);
    else if (/^5\d{8}$/.test(d)) d = '966' + d;
    return d;
  };
  UI.waLink = (phone, text) => `https://wa.me/${UI.waNumber(phone)}?text=${encodeURIComponent(text)}`;
})();

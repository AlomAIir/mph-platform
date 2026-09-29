/* Treatment & Lookbook (#p.<id>.treatment): Pre-production, client-visible.
   The director's treatment is a versioned document (treatments: one row per version, sections jsonb) that the client
   approves or sends back; the lookbook (lookbook_items) is a masonry of images, notes and colour swatches in free-text
   boards. Editors write the latest draft inline (autosaved); sent versions are locked so the client reviews exactly
   what was sent. Clients only ever load non-draft versions, and the lookbook only once a version has been sent.
   Also defines MPH.trShow, the full-screen slideshow the Storyboard reuses. */
(function () {
  const esc = MPH.esc;
  const DEFAULT_SECTIONS = ['Vision', 'Story', 'Look & light', 'Casting', 'Locations', 'Wardrobe & art', 'Sound & music'];
  const BOARD_IDEAS = ['Mood', 'Light', 'Wardrobe', 'Locations'];
  const STATUS = {
    draft: { label: 'Draft', kind: '', icon: 'pencil-line' },
    sent: { label: 'Sent', kind: 'warn', icon: 'send' },
    approved: { label: 'Approved', kind: 'ok', icon: 'badge-check' },
    changes_requested: { label: 'Changes requested', kind: 'danger', icon: 'message-square-warning' },
  };

  /* per-production UI state that outlives re-renders */
  const S = { ver: {}, board: {}, boards: {}, aiForm: {}, aiErr: {} };
  const aiRuns = new Map(); // production id -> promise of the inserted treatment row
  let activeSaver = null;
  window.addEventListener('beforeunload', (e) => {
    if (activeSaver && activeSaver.dirty) { activeSaver.flush(); e.preventDefault(); e.returnValue = ''; }
  });

  /* ------------------------------------------------------------ helpers */
  const pad = (n) => String(n).padStart(2, '0');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const HEX = /^#[0-9a-f]{6}$/i;
  const safeHex = (c) => (HEX.test(String(c || '').trim()) ? String(c).trim().toUpperCase() : '#7FB2A6');
  const newId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9));
  const txt = (v, max = 20000) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : ''; };
  const normSections = (list) => (Array.isArray(list) ? list : []).filter(Boolean)
    .map((s) => ({ id: s.id ? String(s.id) : newId(), title: String(s.title || ''), body: String(s.body || '') }));
  const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
  const docWords = (t) => t.sections.reduce((n, s) => n + words(s.body), 0);
  const richText = (s) => String(s || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p class="tr-p" dir="auto">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const itemOrder = (a, b) => ((a.sort || 0) - (b.sort || 0)) || String(a.created_at || '').localeCompare(String(b.created_at || ''));
  const boardName = (i) => (String(i.board || '').trim() || 'Mood');
  const boardsOf = (pid, items) => {
    const out = [];
    items.forEach((i) => { const b = boardName(i); if (!out.includes(b)) out.push(b); });
    (S.boards[pid] || []).forEach((b) => { if (!out.includes(b)) out.push(b); });
    return out;
  };
  const secIcon = (title) => {
    const t = String(title || '').toLowerCase();
    if (/vision|idea|concept|رؤي/.test(t)) return 'eye';
    if (/story|synopsis|narrative|script|قص|حكاي/.test(t)) return 'book-open';
    if (/look|light|camera|visual|photograph|إضاء|صورة/.test(t)) return 'sun';
    if (/cast|talent|perform|تمثيل|أداء|ممثل/.test(t)) return 'users';
    if (/location|place|set|موقع|أماكن/.test(t)) return 'map-pin';
    if (/wardrobe|art|costume|design|prop|أزياء|ديكور/.test(t)) return 'shirt';
    if (/sound|music|score|voice|صوت|موسيق/.test(t)) return 'music';
    if (/edit|pace|rhythm|مونتاج/.test(t)) return 'scissors';
    if (/reference|mood|palette|مرجع/.test(t)) return 'palette';
    return 'pilcrow';
  };
  const firstSentence = (s) => { const m = /^[\s\S]*?[.!?؟](\s|$)/.exec(String(s || '').trim()); return m ? m[0].trim() : ''; };
  const onView = (pid) => location.hash.startsWith(`#p.${pid}.treatment`);

  /* pitch-style cover: forest sky, apricot sun, layered dunes (flat shapes, no outlines) */
  let artSeq = 0;
  function coverArt(seed) {
    const C = MPH.art.colors;
    const n = ++artSeq;
    const h = MPH.hue(seed || 'mph');
    const sx = 430 + (h % 260);
    let s = h || 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const stars = Array.from({ length: 34 }, (_, i) => `<circle class="tr-star" style="animation-delay:${(i % 7) * 0.5}s" cx="${(rnd() * 800).toFixed(0)}" cy="${(rnd() * 150).toFixed(0)}" r="${(0.6 + rnd() * 1.3).toFixed(1)}" fill="${C.cream}"/>`).join('');
    return `<svg class="tr-cover-svg" viewBox="0 0 800 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs><linearGradient id="trsky${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0B1817"/><stop offset=".62" stop-color="#16403B"/><stop offset="1" stop-color="#2E5B55"/></linearGradient>
      <radialGradient id="trsun${n}"><stop offset="0" stop-color="${C.apricot}" stop-opacity=".75"/><stop offset="1" stop-color="${C.apricot}" stop-opacity="0"/></radialGradient></defs>
      <rect width="800" height="300" fill="url(#trsky${n})"/>${stars}
      <circle cx="${sx}" cy="190" r="170" fill="url(#trsun${n})"/>
      <circle class="tr-sun" cx="${sx}" cy="196" r="44" fill="${C.apricot}"/>
      <path d="M0 214 C130 176 250 196 370 208 C500 222 620 182 800 198 V300 H0Z" fill="${C.teal}"/>
      <path d="M0 242 C150 216 290 238 430 246 C570 254 690 228 800 238 V300 H0Z" fill="${C.forest}"/>
      <path d="M0 272 C170 254 330 272 490 274 C630 276 730 264 800 268 V300 H0Z" fill="#0B1817"/>
      <path class="tr-spark" style="transform-origin:${sx - 150}px 70px" d="M${sx - 150} 56 Q${sx - 147} 67 ${sx - 136} 70 Q${sx - 147} 73 ${sx - 150} 84 Q${sx - 153} 73 ${sx - 164} 70 Q${sx - 153} 67 ${sx - 150} 56Z" fill="${C.lime}"/>
    </svg>`;
  }

  /* ------------------------------------------------------------ slideshow (shared with the Storyboard) */
  MPH.trShow = function ({ title = '', sub = '', slides = [], start = 0 }) {
    const { ui } = MPH;
    if (!slides.length) return null;
    const prevFocus = document.activeElement;
    const el = document.createElement('div');
    el.className = 'tr-show';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', `${title} presentation`);
    el.tabIndex = -1;
    const many = slides.length > 16;
    el.innerHTML = `
      <div class="tr-show-top">
        <span class="strong truncate">${esc(title)}</span>${sub ? `<span class="small muted truncate">${esc(sub)}</span>` : ''}
        <span class="spacer"></span>
        <span class="tiny faint tr-show-hint">${ui.icon('keyboard')}Arrow keys to move · Esc to exit</span>
        ${document.fullscreenEnabled ? `<button class="btn btn-sm btn-ghost btn-icon" data-show="fs" aria-label="Full screen" title="Full screen">${ui.icon('maximize')}</button>` : ''}
        <button class="btn btn-sm btn-outline" data-show="close">${ui.icon('x')}Exit</button>
      </div>
      <div class="tr-show-stage" aria-live="polite"></div>
      <div class="tr-show-bot">
        <button class="tr-show-nav" data-show="prev" aria-label="Previous slide">${ui.icon('chevron-left')}</button>
        ${many ? '<div class="tr-show-prog"><span></span></div>' : `<div class="tr-show-dots">${slides.map((_, i) => `<button class="tr-show-dot" data-show-i="${i}" aria-label="Slide ${i + 1}"></button>`).join('')}</div>`}
        <span class="small muted num tr-show-count"></span>
        <button class="tr-show-nav" data-show="next" aria-label="Next slide">${ui.icon('chevron-right')}</button>
      </div>`;
    document.body.appendChild(el);
    document.documentElement.classList.add('tr-show-open');
    const stage = el.querySelector('.tr-show-stage');
    let i = Math.max(0, Math.min(slides.length - 1, start | 0));
    const draw = () => {
      stage.innerHTML = `<div class="tr-show-slide">${slides[i]}</div>`;
      el.querySelectorAll('.tr-show-dot').forEach((b, k) => { b.classList.toggle('on', k === i); b.setAttribute('aria-current', k === i ? 'true' : 'false'); });
      const bar = el.querySelector('.tr-show-prog span');
      if (bar) bar.style.width = `${((i + 1) / slides.length) * 100}%`;
      el.querySelector('.tr-show-count').textContent = `${i + 1} / ${slides.length}`;
      el.querySelector('[data-show="prev"]').disabled = i === 0;
      el.querySelector('[data-show="next"]').disabled = i === slides.length - 1;
      MPH.icons();
    };
    const go = (n) => { const k = Math.max(0, Math.min(slides.length - 1, n)); if (k !== i) { i = k; draw(); } };
    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('hashchange', close);
      if (document.fullscreenElement === el && document.exitFullscreen) document.exitFullscreen().catch(() => {});
      el.remove();
      document.documentElement.classList.remove('tr-show-open');
      if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus({ preventScroll: true });
    };
    function onKey(e) {
      if (!el.isConnected) return document.removeEventListener('keydown', onKey, true);
      const rtl = document.documentElement.dir === 'rtl';
      const k = e.key;
      if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (k === 'ArrowRight' || k === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(i + ((k === 'ArrowRight') !== rtl ? 1 : -1)); }
      else if (k === 'PageDown' || k === ' ') { e.preventDefault(); go(i + 1); }
      else if (k === 'PageUp') { e.preventDefault(); go(i - 1); }
      else if (k === 'Home') { e.preventDefault(); go(0); }
      else if (k === 'End') { e.preventDefault(); go(slides.length - 1); }
    }
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('hashchange', close);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-show], [data-show-i]');
      if (!b) return;
      if (b.dataset.showI != null) return go(Number(b.dataset.showI));
      const a = b.dataset.show;
      if (a === 'close') close();
      else if (a === 'prev') go(i - 1);
      else if (a === 'next') go(i + 1);
      else if (a === 'fs') { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else el.requestFullscreen().catch(() => {}); }
    });
    // swipe on touch screens
    let sx = null;
    stage.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') sx = e.clientX; });
    stage.addEventListener('pointerup', (e) => {
      if (sx == null) return;
      const dx = e.clientX - sx; sx = null;
      if (Math.abs(dx) > 50) go(i + ((dx < 0) !== (document.documentElement.dir === 'rtl') ? 1 : -1));
    });
    draw();
    el.focus({ preventScroll: true });
    return { close, go };
  };

  /* ------------------------------------------------------------ data selection */
  const latestOf = (d) => d.versions[0] || null;
  const currentOf = (ctx, d) => d.versions.find((v) => v.version === S.ver[ctx.production.id]) || latestOf(d);
  const canWrite = (ctx) => ctx.canEdit && !ctx.isClient;
  const isEditable = (ctx, d, cur) => canWrite(ctx) && cur && cur === latestOf(d) && cur.status === 'draft';
  const tabOf = (ctx) => (ctx.state.trTab === 'look' ? 'look' : 'doc');
  const firstImage = (d) => d.items.find((i) => i.kind === 'image' && d.urls[i.image_path]);

  /* ------------------------------------------------------------ pieces */
  function statusPill(ui, t) {
    const st = STATUS[t.status] || STATUS.draft;
    return ui.pill(st.label, st.kind, st.icon);
  }

  function tabsHtml(ctx, d, cur) {
    const { ui } = ctx;
    const tab = tabOf(ctx);
    return `
      <div class="tabs tr-tabs" role="tablist">
        <button role="tab" aria-selected="${tab === 'doc'}" class="${tab === 'doc' ? 'on' : ''}" data-tr-tab="doc">${ui.icon('file-text')}Treatment${cur ? `<span class="count">v${esc(cur.version)}</span>` : ''}</button>
        <button role="tab" aria-selected="${tab === 'look'}" class="${tab === 'look' ? 'on' : ''}" data-tr-tab="look">${ui.icon('gallery-vertical-end')}Lookbook<span class="count">${d.items.length}</span></button>
      </div>`;
  }

  function paperHtml(ctx, d, t, editable) {
    const { ui } = ctx;
    const p = ctx.production;
    const img = firstImage(d);
    const w = docWords(t);
    const upd = t.updated_at || t.created_at;
    const meta = [
      `v${esc(t.version)}`,
      esc((STATUS[t.status] || STATUS.draft).label),
      t.status === 'draft' ? (upd ? `updated ${esc(MPH.date(upd))}` : '') : (t.sent_at ? `sent ${esc(MPH.date(t.sent_at))}` : ''),
      plural(t.sections.length, 'section'),
      w ? `${w.toLocaleString('en-US')} words · ${Math.max(1, Math.round(w / 200))} min read` : '',
    ].filter(Boolean).join(' · ');
    const secs = t.sections.map((s, i) => editable ? `
      <section class="tr-sec is-edit" data-sec="${esc(s.id)}" id="tr-s-${esc(s.id)}" style="animation-delay:${Math.min(i, 8) * 40}ms">
        <header class="tr-sec-head">
          <span class="tr-sec-ic" aria-hidden="true">${ui.icon(secIcon(s.title))}</span>
          <input class="tr-sec-title" data-tr-f="sec-title" dir="auto" value="${esc(s.title)}" placeholder="Section title" maxlength="120" aria-label="Title of section ${i + 1}">
          <div class="tr-sec-tools">
            <button class="btn btn-ghost btn-xs btn-icon" data-tr="sec-up" ${i === 0 ? 'disabled' : ''} aria-label="Move section up" title="Move up">${ui.icon('arrow-up')}</button>
            <button class="btn btn-ghost btn-xs btn-icon" data-tr="sec-down" ${i === t.sections.length - 1 ? 'disabled' : ''} aria-label="Move section down" title="Move down">${ui.icon('arrow-down')}</button>
            <button class="btn btn-ghost btn-xs btn-icon tr-del" data-tr="sec-del" aria-label="Remove section" title="Remove section">${ui.icon('trash-2')}</button>
          </div>
        </header>
        <textarea class="tr-sec-body" data-tr-f="sec-body" dir="auto" rows="3" placeholder="Write this section. Concrete pictures work better than adjectives." aria-label="${esc(s.title || 'Section ' + (i + 1))}">${esc(s.body)}</textarea>
      </section>` : `
      <section class="tr-sec" data-sec="${esc(s.id)}" id="tr-s-${esc(s.id)}" style="animation-delay:${Math.min(i, 8) * 40}ms">
        <header class="tr-sec-head">
          <span class="tr-sec-ic" aria-hidden="true">${ui.icon(secIcon(s.title))}</span>
          <h3 class="tr-h" dir="auto">${esc(s.title || 'Untitled section')}</h3>
          <span class="tr-sec-n num">${pad(i + 1)}</span>
        </header>
        ${richText(s.body) || '<p class="tr-p faint">Nothing written here yet.</p>'}
      </section>`).join('');
    return `
      <article class="tr-paper ${editable ? 'is-edit' : ''}" aria-label="Treatment version ${esc(t.version)}">
        <div class="tr-cover">${img ? `<img src="${esc(d.urls[img.image_path])}" alt="" draggable="false">` : coverArt(p.id)}</div>
        <header class="tr-titleblock">
          <span class="eyebrow">Director’s treatment${p.client_name ? ' · ' + esc(p.client_name) : ''}${p.format ? ' · ' + esc(p.format) : ''}</span>
          ${editable
            ? `<input class="tr-title-in" data-tr-f="title" dir="auto" value="${esc(t.title || '')}" placeholder="Title of the film" maxlength="160" aria-label="Treatment title">`
            : `<h2 class="tr-title" dir="auto">${esc(t.title || p.title)}</h2>`}
          <span class="small muted" data-tr-meta>${meta}</span>
        </header>
        <div class="tr-body">
          ${secs || `<div class="tr-sec">${ui.empty('pilcrow', 'No sections yet', editable ? 'Add the first section below.' : '')}</div>`}
          ${editable ? `<button class="tr-add-sec" data-tr="sec-add">${ui.icon('plus')}Add a section</button>` : ''}
        </div>
      </article>`;
  }

  function outlineHtml(ctx, t, editable) {
    const { ui } = ctx;
    const w = docWords(t);
    const filled = t.sections.filter((s) => s.body.trim()).length;
    return `
      <aside class="tr-outline" aria-label="Sections">
        <div class="stack tight">
          <span class="eyebrow">Sections</span>
          <span class="small muted" data-tr-ol-stat>${filled} of ${t.sections.length} written${w ? ` · ${w.toLocaleString('en-US')} words` : ''}</span>
          ${ui.bar(t.sections.length ? filled / t.sections.length : 0)}
        </div>
        <nav class="tr-ol">
          ${t.sections.map((s, i) => `
            <button class="tr-ol-item" data-tr-goto="${esc(s.id)}">
              <span class="tr-ol-n num">${pad(i + 1)}</span>
              <span class="grow truncate" dir="auto" data-tr-ol-t="${esc(s.id)}">${esc(s.title || 'Untitled section')}</span>
              <span class="tr-ol-dot ${s.body.trim() ? 'on' : ''}" data-tr-ol-d="${esc(s.id)}" aria-hidden="true"></span>
            </button>`).join('')}
        </nav>
        ${editable ? `<button class="btn btn-sm btn-ghost tr-ol-add" data-tr="sec-add">${ui.icon('plus')}Add a section</button>` : ''}
      </aside>`;
  }

  /* status bar over the document (team) */
  function barHtml(ctx, d, cur) {
    const { ui } = ctx;
    const latest = latestOf(d);
    const editor = canWrite(ctx);
    const isLatest = cur === latest;
    const detail = {
      draft: 'Only your team can see drafts.',
      sent: `Sent to the client${cur.sent_at ? ' ' + esc(MPH.date(cur.sent_at, 'long')) : ''}. Waiting for their decision.`,
      approved: `Approved by the client${cur.decided_at ? ' ' + esc(MPH.date(cur.decided_at, 'long')) : ''}.`,
      changes_requested: `The client asked for changes${cur.decided_at ? ' ' + esc(MPH.date(cur.decided_at, 'long')) : ''}.`,
    }[cur.status] || '';
    const vers = d.versions.length > 1
      ? `<div class="seg tr-vers" role="group" aria-label="Version">${d.versions.slice().reverse().map((v) => `
          <button class="${v === cur ? 'on' : ''}" data-tr-ver="${v.version}" aria-pressed="${v === cur}" title="v${v.version} · ${esc((STATUS[v.status] || STATUS.draft).label)}">v${esc(v.version)}<span class="tr-vdot k-${esc(v.status)}"></span></button>`).join('')}</div>`
      : `<span class="tr-vbadge num">v${esc(cur.version)}</span>`;
    let actions = '';
    if (!isLatest) actions = `<button class="btn btn-sm btn-outline" data-tr-ver="${latest.version}">${ui.icon('arrow-right')}Open the latest, v${esc(latest.version)}</button>`;
    else if (editor) {
      if (cur.status === 'draft') actions = `<button class="btn btn-sm btn-ghost" data-tr="new-version" title="Copy v${esc(cur.version)} into a new draft">${ui.icon('copy-plus')}New version</button><button class="btn btn-sm btn-primary" data-tr="send">${ui.icon('send')}Send to client</button>`;
      else if (cur.status === 'changes_requested') actions = `<button class="btn btn-sm btn-primary" data-tr="new-version">${ui.icon('file-pen-line')}Start v${esc(cur.version + 1)} from these notes</button>`;
      else actions = `<button class="btn btn-sm btn-outline" data-tr="new-version">${ui.icon('copy-plus')}New version</button>`;
    }
    return `
      <section class="tr-bar k-${esc(cur.status)}">
        ${vers}
        <div class="tr-bar-state">${statusPill(ui, cur)}<span class="small muted">${isLatest ? detail : `You’re viewing v${esc(cur.version)}. It’s read only.`}</span></div>
        <span class="spacer"></span>
        ${isEditable(ctx, d, cur) ? '<span class="tr-save tiny" data-tr-save aria-live="polite"></span>' : ''}
        <div class="toolbar">${actions}</div>
      </section>
      ${cur.client_note ? `<div class="callout ${cur.status === 'approved' ? '' : 'market'} tr-cnote">${ui.icon('quote')}<div class="stack tight" style="gap:2px"><span class="strong small">Client’s note on v${esc(cur.version)}</span><span dir="auto">${esc(cur.client_note)}</span></div></div>` : ''}
      ${cur.note && cur.status !== 'draft' ? `<p class="tiny muted tr-sentnote">${ui.icon('send')}Your note with v${esc(cur.version)}: <span dir="auto">“${esc(cur.note)}”</span></p>` : ''}
      ${isLatest && editor && cur.status !== 'draft' ? `<p class="tiny faint tr-sentnote">${ui.icon('lock')}Sent versions are locked, so the client reviews exactly what you sent. Start a new version to make changes.</p>` : ''}`;
  }

  /* first-run: write with AI, or start blank */
  function startHtml(ctx) {
    const { ui } = ctx;
    const pid = ctx.production.id;
    if (!canWrite(ctx)) {
      return ui.panel({ body: ui.empty('gallery-vertical-end', 'No treatment yet', 'Producers and heads of department write the director’s treatment here. It appears for you as soon as they start.') });
    }
    const f = S.aiForm[pid] || { brief: '', sections: DEFAULT_SECTIONS.slice(), extra: '' };
    const running = aiRuns.has(pid);
    const err = S.aiErr[pid];
    const aiBody = running ? `
      <div class="tr-ai-run" role="status">
        <span class="spin"></span>
        <div class="stack tight" style="gap:3px"><span class="strong">Writing the treatment…</span>
          <span class="small muted">The AI is reading the script and your notes, then writing each section. This takes about a minute. You can leave this page; the draft will be waiting when it’s done.</span></div>
      </div>
      <div class="tr-ai-ghost" aria-hidden="true">${[72, 94, 88, 60, 90, 80].map((w, i) => `<span style="width:${w}%;animation-delay:${i * 120}ms"></span>`).join('')}</div>` : `
      ${err ? ui.errorBox(err) : ''}
      <div class="field"><label for="tr-brief">Director’s notes <span class="faint">(optional)</span></label>
        <textarea id="tr-brief" class="textarea" rows="3" dir="auto" placeholder="Tone, references, what must be in it. For example: warm and quiet, one family, no voice-over until the last shot.">${esc(f.brief)}</textarea></div>
      <div class="field"><span class="label">Sections to write</span>
        <div class="tr-checks">${DEFAULT_SECTIONS.map((s) => `<label class="tr-check"><input type="checkbox" value="${esc(s)}" ${f.sections.includes(s) ? 'checked' : ''}><span>${ui.icon('check')}${esc(s)}</span></label>`).join('')}</div>
        <input class="input" id="tr-extra" dir="auto" value="${esc(f.extra)}" placeholder="Other sections, separated by commas (e.g. Edit & pace, References)" aria-label="Other sections"></div>
      <div class="row wrap"><button class="btn btn-primary" data-tr="ai-write">${ui.icon('sparkles')}Write the treatment</button><span class="tiny faint">Takes 20 to 60 seconds. Everything stays editable.</span></div>`;
    return `
      <div class="tr-start">
        <section class="tr-start-card tr-start-ai ${running ? 'is-running' : ''}">
          <div class="tr-start-art">${MPH.art.step('treatment')}</div>
          <div class="stack">
            <div class="stack tight">${ui.aiBadge('Write with AI')}<h2 class="h2">Draft the treatment from your script</h2>
              <p class="small muted">The AI reads the script breakdown and the production summary, then writes each section in the script’s language: Arabic, English or both.</p></div>
            ${aiBody}
          </div>
        </section>
        <section class="tr-start-card tr-start-blank">
          <div class="tr-start-art">${MPH.art.step('script')}</div>
          <div class="stack">
            <div class="stack tight"><span class="eyebrow">Write it yourself</span><h2 class="h2">Start blank</h2>
              <p class="small muted">Seven sections ready to fill in: ${DEFAULT_SECTIONS.map(esc).join(', ')}. Rename, reorder or remove any of them.</p></div>
            <div><button class="btn btn-outline" data-tr="start-blank" ${running ? 'disabled' : ''}>${ui.icon('file-plus')}Start a blank treatment</button></div>
          </div>
        </section>
      </div>`;
  }

  /* ------------------------------------------------------------ lookbook */
  function tileHtml(ctx, d, it, editable, showBoard) {
    const { ui } = ctx;
    let media;
    if (it.kind === 'image') {
      const url = d.urls[it.image_path];
      media = url ? `<img src="${esc(url)}" alt="${esc(it.caption || 'Lookbook image')}" loading="lazy" draggable="false">`
        : `<div class="tr-img-missing">${ui.icon('image-off')}<span class="tiny">Image unavailable</span></div>`;
    } else if (it.kind === 'note') {
      media = `<div class="tr-note-tile">${ui.icon('quote')}<p dir="auto">${esc(it.body || '')}</p></div>`;
    } else {
      const hex = safeHex(it.color);
      media = `<div class="tr-swatch" style="--sw:${hex}"><span class="mono">${hex}</span></div>`;
    }
    const cap = it.caption ? `<figcaption class="tr-tile-cap" dir="auto">${esc(it.caption)}</figcaption>` : '';
    return `
      <figure class="tr-tile k-${esc(it.kind)} ${showBoard ? 'has-board' : ''}" data-item="${esc(it.id)}" ${editable ? 'draggable="true"' : ''}>
        <button class="tr-tile-media" data-tr="item-open" aria-label="${editable ? 'Edit' : 'View'} ${esc(it.caption || it.kind)}">${media}</button>
        ${cap}
        ${showBoard ? `<span class="tr-tile-board">${esc(boardName(it))}</span>` : ''}
        ${editable ? `<div class="tr-tile-tools">
          <span class="tr-tool tr-grip" title="Drag to reorder" aria-hidden="true">${ui.icon('grip-vertical')}</span>
          <button class="tr-tool" data-tr="item-edit" aria-label="Edit" title="Edit">${ui.icon('pencil')}</button>
          <button class="tr-tool tr-del" data-tr="item-del" aria-label="Delete" title="Delete">${ui.icon('trash-2')}</button></div>` : ''}
      </figure>`;
  }

  function lookbookHtml(ctx, d, sharedNow) {
    const { ui } = ctx;
    const pid = ctx.production.id;
    const editable = canWrite(ctx);
    const boards = boardsOf(pid, d.items);
    let filter = S.board[pid] || '';
    if (filter && !boards.includes(filter)) filter = S.board[pid] = '';
    const cols = [2, 3, 4].includes(ctx.state.trCols) ? ctx.state.trCols : 3;
    const list = d.items.filter((i) => !filter || boardName(i) === filter);
    const count = (b) => d.items.filter((i) => boardName(i) === b).length;
    const bar = `
      <div class="tr-look-bar">
        <div class="row wrap grow tr-boards" role="group" aria-label="Boards">
          <button class="chip ${!filter ? 'on' : ''}" data-tr-board="">All <span class="num faint">${d.items.length}</span></button>
          ${boards.map((b) => `<button class="chip ${filter === b ? 'on' : ''}" data-tr-board="${esc(b)}" dir="auto">${esc(b)} <span class="num faint">${count(b)}</span></button>`).join('')}
          ${editable ? `<button class="chip tr-chip-new" data-tr="board-new">${ui.icon('plus')}New board</button>` : ''}
        </div>
        <div class="toolbar">
          <div class="seg" role="group" aria-label="Columns">${[2, 3, 4].map((c) => `<button class="${cols === c ? 'on' : ''}" data-tr-cols="${c}" aria-pressed="${cols === c}" title="${c} columns">${ui.icon(`columns-${c}`)}${c}</button>`).join('')}</div>
          ${editable ? `<span class="sep"></span>
            <label class="btn btn-sm btn-primary tr-file">${ui.icon('image-plus')}Add images<input type="file" accept="image/*" multiple data-tr-file hidden></label>
            <button class="btn btn-sm btn-outline" data-tr="add-note">${ui.icon('sticky-note')}Note</button>
            <button class="btn btn-sm btn-outline" data-tr="add-color">${ui.icon('palette')}Colour</button>` : ''}
        </div>
      </div>`;
    const note = editable
      ? `<p class="tiny muted tr-look-note">${ui.icon(sharedNow ? 'eye' : 'lock')}${sharedNow ? 'Your client can see the lookbook.' : 'Your client sees the lookbook once you send a treatment version.'}${' '}Drop images anywhere on the board to add them${filter ? ` to ${esc(filter)}` : ''}; drag tiles to reorder.</p>` : '';
    let grid;
    if (list.length) grid = `<div class="tr-masonry" data-cols="${cols}" data-tr-grid>${list.map((it) => tileHtml(ctx, d, it, editable, !filter)).join('')}</div>`;
    else if (editable) grid = `<label class="dropzone tr-drop" data-tr-grid>${ui.icon('images')}<span class="strong">${filter ? `Nothing on ${esc(filter)} yet` : 'Start the lookbook'}</span>
        <span class="small">Drop images here or choose files. Add notes and colour swatches next to them. Try boards like ${BOARD_IDEAS.map(esc).join(', ')}.</span>
        <input type="file" accept="image/*" multiple data-tr-file hidden></label>`;
    else grid = ui.panel({ body: ui.empty('gallery-vertical-end', filter ? 'Nothing on this board yet' : 'No lookbook yet', ctx.isClient ? 'Your production team adds the images behind the treatment here.' : 'Producers and heads of department build the lookbook here.') });
    return `<div class="stack tr-look">${bar}${note}${grid}</div>`;
  }

  /* ------------------------------------------------------------ pages */
  function teamPage(ctx, d) {
    const { ui } = ctx;
    const p = ctx.production;
    const cur = currentOf(ctx, d);
    const tab = tabOf(ctx);
    const shared = d.versions.some((v) => v.status !== 'draft');
    const head = ui.pageHead({
      eyebrow: 'Story · Client-visible',
      title: ctx.t('Treatment & Lookbook'),
      sub: cur ? `${esc(cur.title || p.title)} · ${plural(d.versions.length, 'version')} · ${plural(d.items.length, 'lookbook item')}` : 'The director’s vision for the film, and the pictures behind it. Write it here, then send it to the client to approve.',
      actions: (cur || d.items.length) ? `<button class="btn btn-sm btn-outline" data-tr="present">${ui.icon('presentation')}Present</button>` : '',
    });
    let body;
    if (tab === 'look') body = lookbookHtml(ctx, d, shared);
    else if (!cur || aiRuns.has(p.id)) body = startHtml(ctx);
    else {
      const editable = isEditable(ctx, d, cur);
      body = `${barHtml(ctx, d, cur)}<div class="tr-layout">${outlineHtml(ctx, cur, editable)}${paperHtml(ctx, d, cur, editable)}</div>`;
    }
    return `<div class="page tr-page">${head}${tabsHtml(ctx, d, cur)}${body}</div>`;
  }

  function clientPage(ctx, d) {
    const { ui } = ctx;
    const p = ctx.production;
    const preview = !ctx.realClient;
    const cur = latestOf(d);
    if (!cur) {
      return `<div class="page tr-page">
        ${ui.pageHead({ eyebrow: 'Story', title: ctx.t('Treatment & Lookbook'), sub: esc(p.title) })}
        ${ui.panel({ body: ui.empty('gallery-vertical-end', 'No treatment shared yet', preview
          ? 'Your client sees the treatment and lookbook here once you send a version. Drafts never appear in this view.'
          : 'Your production team will share the director’s treatment here. You’ll be able to approve it or ask for changes.') })}
      </div>`;
    }
    let decision = '';
    if (cur.status === 'sent') {
      decision = `<div class="callout tr-decide">${ui.icon('bell-ring')}
        <div class="grow stack tight">
          <span><span class="strong">This treatment is waiting for your decision.</span> <span class="muted">Approving tells your production team to go ahead with this direction. Requesting changes sends them your note.</span></span>
          ${cur.note ? `<span class="small">Note from your production team: <span dir="auto">“${esc(cur.note)}”</span></span>` : ''}
          ${preview ? `<span class="tiny tr-preview-note">${ui.icon('eye')}Clients see these buttons. They’re disabled in preview.</span>` : ''}
        </div>
        <div class="row wrap">
          <button class="btn btn-sm btn-primary" data-tr="approve" ${preview ? 'disabled' : ''}>${ui.icon('check')}Approve treatment</button>
          <button class="btn btn-sm btn-outline" data-tr="changes" ${preview ? 'disabled' : ''}>${ui.icon('message-square')}Request changes</button>
        </div></div>`;
    } else if (cur.status === 'approved') {
      decision = `<div class="callout">${ui.icon('circle-check')}<div class="grow"><span class="strong">Approved${cur.decided_at ? ' on ' + esc(MPH.date(cur.decided_at, 'long')) : ''}.</span>${cur.client_note ? ` <span class="muted">Your note: <span dir="auto">“${esc(cur.client_note)}”</span></span>` : ''}</div></div>`;
    } else if (cur.status === 'changes_requested') {
      decision = `<div class="callout market">${ui.icon('message-square')}<div class="grow"><span class="strong">Changes requested${cur.decided_at ? ' on ' + esc(MPH.date(cur.decided_at, 'long')) : ''}.</span>${cur.client_note ? ` <span class="muted"><span dir="auto">“${esc(cur.client_note)}”</span></span>` : ''} <span class="muted">Your production team will send a revised version.</span></div></div>`;
    }
    const tab = tabOf(ctx);
    return `
      <div class="page tr-page">
        ${ui.pageHead({
          eyebrow: `Treatment · v${esc(cur.version)}${cur.sent_at ? ' · sent ' + esc(MPH.date(cur.sent_at, 'long')) : ''}`,
          title: esc(cur.title || p.title),
          sub: `The director’s treatment for ${esc(p.title)}${d.items.length ? `, with a lookbook of ${plural(d.items.length, 'reference')}` : ''}.`,
          actions: `${statusPill(ui, cur)}<button class="btn btn-sm btn-outline" data-tr="present">${ui.icon('presentation')}Present</button>`,
        })}
        ${decision}
        ${tabsHtml(ctx, d, cur)}
        ${tab === 'look' ? lookbookHtml(ctx, d, true) : `<div class="tr-layout">${outlineHtml(ctx, cur, false)}${paperHtml(ctx, d, cur, false)}</div>`}
      </div>`;
  }

  const renderPage = (ctx, d) => (ctx.isClient ? clientPage(ctx, d) : teamPage(ctx, d));

  /* ------------------------------------------------------------ present */
  function present(ctx, d, startAt) {
    const { ui } = ctx;
    const p = ctx.production;
    const t = ctx.isClient ? latestOf(d) : currentOf(ctx, d);
    const images = d.items.filter((i) => i.kind === 'image' && d.urls[i.image_path]);
    const slides = [];
    const cover = firstImage(d);
    if (t) {
      slides.push(`
        <div class="tr-slide tr-slide-cover">
          <div class="tr-slide-bg">${cover ? `<img src="${esc(d.urls[cover.image_path])}" alt="">` : coverArt(p.id)}</div><div class="tr-slide-shade"></div>
          <div class="tr-slide-cover-text">
            <span class="eyebrow">${esc(p.client_name || '')}${p.agency ? ' · ' + esc(p.agency) : ''}${p.client_name || p.agency ? ' · ' : ''}Director’s treatment</span>
            <span class="tr-slide-title" dir="auto">${esc(t.title || p.title)}</span>
            <span class="small muted">${esc(p.title)} · v${esc(t.version)}</span>
          </div>
        </div>`);
      t.sections.forEach((s, i) => {
        const img = images.length ? images[i % images.length] : null;
        const lead = firstSentence(s.body);
        const rest = lead ? s.body.trim().slice(lead.length).trim() : s.body.trim();
        slides.push(`
          <div class="tr-slide tr-slide-sec">
            <div class="tr-slide-art">${img ? `<img src="${esc(d.urls[img.image_path])}" alt="${esc(img.caption || '')}">` : `<div class="tr-slide-ic">${ui.icon(secIcon(s.title))}<span class="num">${pad(i + 1)}</span></div>`}</div>
            <div class="tr-slide-copy">
              <span class="eyebrow accent" dir="auto">${pad(i + 1)} · ${esc(s.title || 'Section')}</span>
              ${lead ? `<h2 dir="auto">${esc(lead)}</h2>` : `<h2 dir="auto">${esc(s.title || '')}</h2>`}
              ${richText(rest)}
            </div>
          </div>`);
      });
    }
    const lookStart = slides.length;
    if (d.items.length) {
      slides.push(`<div class="tr-slide tr-slide-div"><span class="eyebrow accent">Lookbook</span><span class="tr-slide-title">The pictures behind it</span><span class="small muted">${boardsOf(p.id, d.items).map(esc).join(' · ')}</span></div>`);
      d.items.filter((i) => i.kind !== 'color').forEach((it) => {
        if (it.kind === 'image') {
          const url = d.urls[it.image_path];
          slides.push(`<div class="tr-slide tr-slide-img">${url ? `<img src="${esc(url)}" alt="${esc(it.caption || '')}">` : `<div class="tr-img-missing">${ui.icon('image-off')}</div>`}
            <div class="tr-slide-cap"><span class="eyebrow" dir="auto">${esc(boardName(it))}</span>${it.caption ? `<span dir="auto">${esc(it.caption)}</span>` : ''}</div></div>`);
        } else {
          slides.push(`<div class="tr-slide tr-slide-note"><div class="tr-slide-note-in">${ui.icon('quote')}<p dir="auto">${esc(it.body || '')}</p>${it.caption ? `<span class="small muted" dir="auto">${esc(it.caption)}</span>` : ''}<span class="eyebrow" dir="auto">${esc(boardName(it))}</span></div></div>`);
        }
      });
      const colors = d.items.filter((i) => i.kind === 'color');
      if (colors.length) {
        slides.push(`<div class="tr-slide tr-slide-pal"><span class="eyebrow accent">Palette</span>
          <div class="tr-slide-sw">${colors.map((c) => `<div class="tr-slide-swc"><span style="--sw:${safeHex(c.color)}"></span><span class="small strong" dir="auto">${esc(c.caption || '')}</span><span class="tiny mono muted">${safeHex(c.color)}</span></div>`).join('')}</div></div>`);
      }
    }
    if (!slides.length) return ctx.toast('Write the treatment or add to the lookbook first', 'presentation');
    MPH.trShow({ title: p.title, sub: t ? `Treatment v${t.version}` : 'Lookbook', slides, start: startAt === 'look' ? lookStart : (startAt | 0) });
  }

  /* ------------------------------------------------------------ autosave for the draft being edited */
  function makeSaver(ctx, root) {
    let doc = null, timer = null, dirty = false, chain = Promise.resolve();
    const ind = (st) => {
      const el = root.querySelector('[data-tr-save]');
      if (!el) return;
      el.dataset.st = st;
      el.innerHTML = { dirty: 'Editing…', saving: `${MPH.ui.spinner()}Saving`, saved: `${MPH.ui.icon('check')}Saved`, error: `${MPH.ui.icon('triangle-alert')}Not saved` }[st] || '';
      MPH.icons();
    };
    const save = () => {
      clearTimeout(timer);
      if (!dirty || !doc) return chain;
      dirty = false;
      const target = doc;
      const payload = { title: txt(target.title, 300) || null, sections: target.sections.map((s) => ({ id: s.id, title: s.title, body: s.body })) };
      ind('saving');
      chain = chain.then(async () => {
        const { error } = await ctx.sb.from('treatments').update(payload).eq('id', target.id);
        if (error) { if (doc === target) dirty = true; ind('error'); ctx.toastError(new Error(`Your last change didn’t save: ${error.message}`)); }
        else { target.updated_at = new Date().toISOString(); if (!dirty) ind('saved'); }
      });
      return chain;
    };
    return {
      bind(d0) { if (doc && doc !== d0 && dirty) save(); doc = d0; },
      touch() { dirty = true; ind('dirty'); clearTimeout(timer); timer = setTimeout(save, 700); },
      flush: save,
      get dirty() { return dirty; },
    };
  }

  /* two-step confirm on destructive buttons */
  const armed = (btn, label) => {
    if (btn.dataset.armed) return true;
    btn.dataset.armed = '1';
    const html = btn.innerHTML;
    btn.classList.add('tr-armed');
    btn.textContent = label;
    setTimeout(() => { if (!btn.isConnected) return; delete btn.dataset.armed; btn.classList.remove('tr-armed'); btn.innerHTML = html; }, 3000);
    return false;
  };

  /* ------------------------------------------------------------ view */
  MPH.view('treatment', {
    async load(ctx) {
      const pid = ctx.production.id;
      const { must } = ctx.api;
      let versions, items = [];
      if (ctx.isClient) {
        // clients (and the producer's preview) never load drafts
        versions = must(await ctx.sb.from('treatments').select('id, version, title, status, sections, note, client_note, sent_at, decided_at, created_at, updated_at')
          .eq('production_id', pid).neq('status', 'draft').order('version', { ascending: false }));
        if (versions.length) items = must(await ctx.sb.from('lookbook_items').select('*').eq('production_id', pid));
      } else {
        const [t, l] = await Promise.all([
          ctx.sb.from('treatments').select('*').eq('production_id', pid).order('version', { ascending: false }),
          ctx.sb.from('lookbook_items').select('*').eq('production_id', pid),
        ]);
        versions = must(t); items = must(l);
      }
      versions.forEach((v) => { v.sections = normSections(v.sections); });
      items.sort(itemOrder);
      const urls = await ctx.api.mediaUrls(items.filter((i) => i.kind === 'image').map((i) => i.image_path));
      return { versions, items, urls };
    },

    render: renderPage,

    mount(root, ctx, d) {
      const { ui } = ctx;
      const pid = ctx.production.id;
      const saver = makeSaver(ctx, root);
      activeSaver = saver;
      const needsAutosize = !(window.CSS && CSS.supports && CSS.supports('field-sizing', 'content'));
      const autosize = (ta) => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
      const sizeAll = () => { if (needsAutosize) root.querySelectorAll('.tr-sec-body').forEach(autosize); };
      const editDoc = () => { const cur = currentOf(ctx, d); return isEditable(ctx, d, cur) ? cur : null; };
      const repaint = () => { saver.bind(editDoc()); root.innerHTML = renderPage(ctx, d); MPH.icons(); sizeAll(); };
      saver.bind(editDoc());
      sizeAll();

      /* ---------- AI run (survives navigation; this screen just listens) */
      const listenAi = () => {
        const run = aiRuns.get(pid);
        if (!run) return;
        run.then((row) => { if (root.isConnected) { S.ver[pid] = row.version; ctx.state.trTab = 'doc'; ctx.reload(); } },
          (err) => { if (root.isConnected) repaint(); void err; });
      };
      listenAi();
      const startAi = (brief, sections) => {
        if (aiRuns.has(pid)) return;
        S.aiErr[pid] = null;
        const run = (async () => {
          const out = await ctx.api.ai('treatment', { production_id: pid, brief: brief || undefined, sections });
          const secs = normSections(out && out.sections).filter((s) => s.title.trim() || s.body.trim());
          if (!secs.length) throw new Error('The AI didn’t return any sections. Add a few director’s notes and try again.');
          const version = await ctx.api.nextVersion('treatments', pid);
          return ctx.api.must(await ctx.sb.from('treatments').insert({
            production_id: pid, version, title: txt(out.title, 300) || ctx.production.title, sections: secs, status: 'draft', created_by: ctx.session.user.id,
          }).select().single());
        })();
        aiRuns.set(pid, run);
        run.then((row) => { aiRuns.delete(pid); if (!onView(pid)) ctx.toast(`Treatment v${row.version} for ${ctx.production.title} is ready`, 'sparkles'); },
          (err) => { aiRuns.delete(pid); S.aiErr[pid] = err.message || String(err); if (!onView(pid)) ctx.toastError(new Error(`The treatment draft failed: ${S.aiErr[pid]}`)); });
        repaint();
        listenAi();
      };

      const createVersion = async (btn, row, toastMsg) => {
        if (btn) { btn.disabled = true; btn.innerHTML = `${ui.spinner()}Creating…`; }
        try {
          await saver.flush();
          const version = await ctx.api.nextVersion('treatments', pid);
          const ins = ctx.api.must(await ctx.sb.from('treatments').insert({ production_id: pid, version, status: 'draft', created_by: ctx.session.user.id, ...row }).select().single());
          S.ver[pid] = ins.version;
          ctx.state.trTab = 'doc';
          ctx.toast(toastMsg(ins), 'file-plus');
          ctx.reload();
        } catch (ex) { ctx.toastError(ex); if (btn && btn.isConnected) { btn.disabled = false; repaint(); } }
      };

      /* ---------- sections */
      const secIndex = (el) => { const doc = editDoc(); const sec = el.closest('[data-sec]'); return doc && sec ? doc.sections.findIndex((s) => s.id === sec.dataset.sec) : -1; };
      const structural = (focusSel) => {
        saver.touch(); saver.flush();
        repaint();
        if (focusSel) { const f = root.querySelector(focusSel); if (f) { f.focus(); f.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }
      };

      /* ---------- send / decide */
      const openSend = (cur) => {
        const empty = cur.sections.filter((s) => !s.body.trim()).length;
        const el = ctx.modal(ctx.frame({
          title: `Send v${esc(cur.version)} to the client`,
          sub: esc(ctx.production.client_name || ctx.production.title),
          body: `
            <p>Your client will see v${esc(cur.version)} and the lookbook next time they open this production, and can approve it or ask for changes. Once sent, this version is locked; start a new version to change it.</p>
            ${empty ? `<div class="callout market">${ui.icon('triangle-alert')}<span class="small">${plural(empty, 'section')} ${empty === 1 ? 'is' : 'are'} still empty. You can send anyway, or go back and finish ${empty === 1 ? 'it' : 'them'}.</span></div>` : ''}
            <div class="field"><label for="tr-send-note">Note to the client <span class="faint">(optional)</span></label>
              <textarea id="tr-send-note" class="textarea" rows="3" dir="auto" maxlength="2000" placeholder="For example: here is the treatment we talked about on Sunday. The lookbook has the light references."></textarea></div>`,
          foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="tr-send-go">${ui.icon('send')}Send v${esc(cur.version)} to the client</button>`,
        }));
        const go = el.querySelector('#tr-send-go');
        go.addEventListener('click', async () => {
          go.disabled = true; go.innerHTML = `${ui.spinner()}Sending`;
          try {
            await saver.flush();
            const note = txt(el.querySelector('#tr-send-note').value, 2000) || null;
            const rows = ctx.api.must(await ctx.sb.from('treatments').update({ status: 'sent', sent_at: new Date().toISOString(), note })
              .eq('id', cur.id).eq('status', 'draft').select('id'));
            if (!rows.length) throw new Error('This version was already sent. Reload to see its status.');
            ctx.closeOverlay();
            ctx.toast(`v${cur.version} sent to the client`, 'send');
            ctx.reload();
          } catch (ex) { go.disabled = false; go.innerHTML = `${ui.icon('send')}Send v${esc(cur.version)} to the client`; MPH.icons(); ctx.toastError(ex); }
        });
      };

      const openDecide = (approve) => {
        if (!ctx.realClient) return; // preview: never decide on the client's behalf
        const cur = latestOf(d);
        if (!cur || cur.status !== 'sent') return;
        const label = approve ? 'Approve treatment' : 'Send request';
        const el = ctx.modal(ctx.frame({
          title: approve ? `Approve treatment v${esc(cur.version)}` : `Request changes to v${esc(cur.version)}`,
          sub: esc(ctx.production.title),
          body: approve
            ? `<p>Approving tells your production team to go ahead with this direction.</p>
               <div class="field"><label for="tr-dec-note">Note to your production team <span class="faint">(optional)</span></label><textarea id="tr-dec-note" class="textarea" rows="3" dir="auto" maxlength="2000" placeholder="For example: love the night scenes. Keep the shemagh red and white."></textarea></div>`
            : `<div class="field"><label for="tr-dec-note">What should change?</label><textarea id="tr-dec-note" class="textarea" rows="4" dir="auto" maxlength="2000" placeholder="For example: less talk about the product, and a warmer night."></textarea></div>`,
          foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn ${approve ? 'btn-primary' : 'btn-outline'}" id="tr-dec-go">${ui.icon(approve ? 'check' : 'send')}${label}</button>`,
        }));
        const go = el.querySelector('#tr-dec-go');
        go.addEventListener('click', async () => {
          const ta = el.querySelector('#tr-dec-note');
          const note = ta.value.trim();
          if (!approve && !note) { ta.focus(); return ctx.toast('Tell your production team what should change', 'message-square'); }
          go.disabled = true; go.innerHTML = `${ui.spinner()}Sending`;
          try {
            ctx.api.must(await ctx.sb.rpc('decide_treatment', { p_id: cur.id, p_decision: approve ? 'approved' : 'changes_requested', p_note: note || null }));
            ctx.closeOverlay();
            ctx.toast(approve ? 'Treatment approved. Your production team can see it now.' : 'Change request sent to your production team', approve ? 'check' : 'send');
            ctx.reload();
          } catch (ex) { go.disabled = false; go.innerHTML = `${ui.icon(approve ? 'check' : 'send')}${label}`; MPH.icons(); ctx.toastError(ex); }
        });
      };

      /* ---------- lookbook: add / edit / upload / reorder */
      const boardNow = () => S.board[pid] || boardsOf(pid, d.items)[0] || 'Mood';
      const nextSort = () => d.items.reduce((m, i) => Math.max(m, (i.sort || 0) + 1), 0);
      const dropExtraBoard = (b) => { if (S.boards[pid]) S.boards[pid] = S.boards[pid].filter((x) => x !== b || !d.items.some((i) => boardName(i) === b)); };

      const uploadFiles = async (fileList) => {
        const files = [...(fileList || [])].filter((f) => /^image\//.test(f.type));
        if (!files.length) return ctx.toast('Choose image files: JPG, PNG, WebP or GIF', 'image-off');
        const tooBig = files.filter((f) => f.size > 25 * 1024 * 1024);
        if (tooBig.length) return ctx.toastError(new Error(`${tooBig[0].name} is over 25 MB. Export a smaller version and try again.`));
        const board = boardNow();
        ctx.state.trTab = 'look';
        repaint();
        let grid = root.querySelector('.tr-masonry');
        if (!grid) {
          const holder = root.querySelector('[data-tr-grid]');
          grid = document.createElement('div');
          grid.className = 'tr-masonry'; grid.dataset.cols = String(ctx.state.trCols || 3);
          if (holder) holder.replaceWith(grid);
        }
        files.forEach((f) => grid.insertAdjacentHTML('beforeend', `<figure class="tr-tile k-uploading"><div class="tr-up"><span class="spin"></span><span class="tiny truncate">Uploading ${esc(f.name)}</span></div></figure>`));
        const res = await Promise.allSettled(files.map((f) => ctx.api.uploadMedia(pid, f, 'client', 'lookbook')));
        const paths = res.map((r) => (r.status === 'fulfilled' ? r.value : null));
        const failed = res.find((r) => r.status === 'rejected');
        let sort = nextSort();
        const rows = files.map((f, k) => paths[k] && ({ production_id: pid, board, kind: 'image', image_path: paths[k], caption: null, sort: sort++ })).filter(Boolean);
        if (rows.length) {
          try {
            const ins = ctx.api.must(await ctx.sb.from('lookbook_items').insert(rows).select());
            Object.assign(d.urls, await ctx.api.mediaUrls(ins.map((i) => i.image_path)));
            d.items.push(...ins); d.items.sort(itemOrder);
            dropExtraBoard(board);
            ctx.toast(`Added ${plural(ins.length, 'image')} to ${board}`, 'image-plus');
          } catch (ex) { ctx.api.removeMedia(rows.map((r) => r.image_path)); ctx.toastError(ex); }
        }
        if (failed) ctx.toastError(new Error(`${files.length - rows.length} image${files.length - rows.length === 1 ? '' : 's'} didn’t upload: ${failed.reason && failed.reason.message ? failed.reason.message : failed.reason}`));
        if (root.isConnected) repaint();
      };

      const itemForm = (kind, item) => {
        const boards = boardsOf(pid, d.items);
        const board = item ? boardName(item) : boardNow();
        const hex = safeHex(item ? item.color : '#C98A4B');
        const url = item && item.kind === 'image' ? d.urls[item.image_path] : null;
        const title = item ? { image: 'Edit image', note: 'Edit note', color: 'Edit colour' }[kind] : { note: 'Add a note', color: 'Add a colour' }[kind];
        const body = `
          ${kind === 'image' ? `<div class="tr-form-img">${url ? `<img src="${esc(url)}" alt="">` : `<div class="tr-img-missing">${ui.icon('image-off')}</div>`}</div>` : ''}
          ${kind === 'note' ? `<div class="field"><label for="tr-i-body">Note</label><textarea id="tr-i-body" class="textarea" rows="5" dir="auto" maxlength="2000" placeholder="A line of direction, a reference, a feeling. For example: faces stay warm, the sky stays cold.">${esc(item ? item.body || '' : '')}</textarea></div>` : ''}
          ${kind === 'color' ? `<div class="field"><label for="tr-i-hex">Colour</label>
            <div class="row tr-cpick"><input type="color" id="tr-i-color" value="${hex.toLowerCase()}" aria-label="Pick a colour"><input class="input mono" id="tr-i-hex" value="${hex}" maxlength="7" placeholder="#C98A4B" spellcheck="false"><span class="tr-cprev" style="--sw:${hex}"></span></div></div>` : ''}
          <div class="field"><label for="tr-i-cap">${kind === 'color' ? 'Name' : kind === 'note' ? 'Title' : 'Caption'} <span class="faint">(optional)</span></label>
            <input class="input" id="tr-i-cap" dir="auto" maxlength="300" value="${esc(item ? item.caption || '' : '')}" placeholder="${kind === 'color' ? 'Rimal sand' : kind === 'note' ? 'Night light' : 'What this image is for'}"></div>
          <div class="field"><label for="tr-i-board">Board</label>
            <input class="input" id="tr-i-board" dir="auto" maxlength="60" list="tr-board-list" value="${esc(board)}">
            <datalist id="tr-board-list">${[...new Set([...boards, ...BOARD_IDEAS])].map((b) => `<option value="${esc(b)}"></option>`).join('')}</datalist></div>`;
        const el = (item ? ctx.drawer : ctx.modal)(ctx.frame({
          title, sub: item ? esc(board) : `Goes on ${esc(board)}`,
          body,
          foot: `${item ? `<button class="btn btn-ghost tr-del" id="tr-i-del">${ui.icon('trash-2')}Delete</button><span class="spacer"></span>` : ''}<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="tr-i-save">${ui.icon('check')}${item ? 'Save' : 'Add to lookbook'}</button>`,
        }));
        const cp = el.querySelector('#tr-i-color'), hx = el.querySelector('#tr-i-hex'), pv = el.querySelector('.tr-cprev');
        if (cp) {
          cp.addEventListener('input', () => { hx.value = cp.value.toUpperCase(); pv.style.setProperty('--sw', hx.value); });
          hx.addEventListener('input', () => {
            let v = hx.value.trim(); if (v && v[0] !== '#') v = '#' + v;
            if (HEX.test(v)) { cp.value = v.toLowerCase(); pv.style.setProperty('--sw', v); }
          });
        }
        const del = el.querySelector('#tr-i-del');
        if (del) del.addEventListener('click', () => { if (armed(del, 'Click again to delete')) { ctx.closeOverlay(); removeItem(item.id); } });
        const save = el.querySelector('#tr-i-save');
        save.addEventListener('click', async () => {
          const row = { caption: txt(el.querySelector('#tr-i-cap').value, 300) || null, board: txt(el.querySelector('#tr-i-board').value, 60) || 'Mood' };
          if (kind === 'note') {
            row.body = txt(el.querySelector('#tr-i-body').value, 2000);
            if (!row.body) { el.querySelector('#tr-i-body').focus(); return ctx.toast('Write the note first', 'sticky-note'); }
          }
          if (kind === 'color') {
            let v = hx.value.trim(); if (v && v[0] !== '#') v = '#' + v;
            if (!HEX.test(v)) { hx.focus(); return ctx.toast('Use a six-digit hex colour, like #C98A4B', 'palette'); }
            row.color = v.toUpperCase();
          }
          save.disabled = true;
          try {
            if (item) {
              ctx.api.must(await ctx.sb.from('lookbook_items').update(row).eq('id', item.id));
              Object.assign(item, row);
            } else {
              const ins = ctx.api.must(await ctx.sb.from('lookbook_items').insert({ production_id: pid, kind, sort: nextSort(), ...row }).select().single());
              d.items.push(ins); d.items.sort(itemOrder);
              ctx.toast(kind === 'note' ? 'Note added' : 'Colour added', kind === 'note' ? 'sticky-note' : 'palette');
            }
            dropExtraBoard(row.board);
            ctx.closeOverlay();
            repaint();
          } catch (ex) { save.disabled = false; ctx.toastError(ex); }
        });
      };

      const removeItem = async (id) => {
        const idx = d.items.findIndex((i) => i.id === id);
        if (idx < 0) return;
        const [it] = d.items.splice(idx, 1);
        repaint();
        try {
          ctx.api.must(await ctx.sb.from('lookbook_items').delete().eq('id', id));
          if (it.image_path) ctx.api.removeMedia([it.image_path]).catch(() => {});
          ctx.toast('Removed from the lookbook', 'trash-2');
        } catch (ex) { d.items.splice(idx, 0, it); repaint(); ctx.toastError(ex); }
      };

      const moveItem = (id, targetId, before) => {
        const list = d.items.slice();
        const from = list.findIndex((i) => i.id === id);
        if (from < 0) return;
        const [it] = list.splice(from, 1);
        let to = list.findIndex((i) => i.id === targetId);
        if (to < 0) return;
        if (!before) to += 1;
        list.splice(to, 0, it);
        const changed = [];
        list.forEach((x, k) => { if (x.sort !== k) { x.sort = k; changed.push(x); } });
        d.items = list;
        repaint();
        if (!changed.length) return;
        Promise.all(changed.map((x) => ctx.sb.from('lookbook_items').update({ sort: x.sort }).eq('id', x.id))).then((res) => {
          const bad = res.find((r) => r.error);
          if (bad) { ctx.toastError(new Error(`The new order didn’t save: ${bad.error.message}`)); ctx.reload(); }
        });
      };

      /* ---------- clicks */
      root.addEventListener('click', async (e) => {
        const t = e.target;
        let b;
        if ((b = t.closest('[data-tr-tab]'))) { if (ctx.state.trTab !== b.dataset.trTab) { await saver.flush(); ctx.state.trTab = b.dataset.trTab; repaint(); } return; }
        if ((b = t.closest('[data-tr-ver]'))) { await saver.flush(); S.ver[pid] = Number(b.dataset.trVer); ctx.state.trTab = 'doc'; repaint(); return; }
        if ((b = t.closest('[data-tr-board]'))) { S.board[pid] = b.dataset.trBoard; repaint(); return; }
        if ((b = t.closest('[data-tr-cols]'))) { ctx.state.trCols = Number(b.dataset.trCols); repaint(); return; }
        if ((b = t.closest('[data-tr-goto]'))) {
          const sec = root.querySelector(`#tr-s-${CSS.escape(b.dataset.trGoto)}`);
          if (sec) { sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); sec.classList.remove('tr-flash'); void sec.offsetWidth; sec.classList.add('tr-flash'); }
          return;
        }
        if (!(b = t.closest('[data-tr]')) || b.disabled) return;
        const act = b.dataset.tr;
        if (act === 'present') { await saver.flush(); return present(ctx, d, tabOf(ctx) === 'look' ? 'look' : 0); }
        if (act === 'approve' || act === 'changes') return openDecide(act === 'approve');
        if (act === 'item-open') {
          const tile = b.closest('[data-item]');
          const it = tile && d.items.find((i) => i.id === tile.dataset.item);
          if (!it) return;
          if (canWrite(ctx)) return itemForm(it.kind, it);
          // readers: open the slideshow at this item
          const t0 = ctx.isClient ? latestOf(d) : currentOf(ctx, d);
          const offset = (t0 ? 1 + t0.sections.length : 0) + 1;
          const nonColor = d.items.filter((i) => i.kind !== 'color');
          const k = nonColor.indexOf(it);
          return present(ctx, d, k >= 0 ? offset + k : (it.kind === 'color' ? offset + nonColor.length : 0));
        }
        if (!canWrite(ctx)) return;
        if (act === 'ai-write') {
          const checks = [...root.querySelectorAll('.tr-checks input:checked')].map((x) => x.value);
          const extra = (root.querySelector('#tr-extra')?.value || '').split(/[,،]/).map((x) => x.trim()).filter(Boolean);
          const brief = (root.querySelector('#tr-brief')?.value || '').trim();
          const sections = [...new Set([...checks, ...extra])].slice(0, 10);
          S.aiForm[pid] = { brief, sections: checks, extra: extra.join(', ') };
          if (!sections.length) return ctx.toast('Choose at least one section to write', 'list-checks');
          return startAi(brief.slice(0, 4000), sections);
        }
        if (act === 'start-blank') return createVersion(b, { title: ctx.production.title, sections: DEFAULT_SECTIONS.map((title) => ({ id: newId(), title, body: '' })) }, (r) => `Treatment v${r.version} started`);
        if (act === 'new-version') {
          const latest = latestOf(d);
          return createVersion(b, { title: latest.title, sections: latest.sections.map((s) => ({ id: s.id, title: s.title, body: s.body })) }, (r) => `v${r.version} started from v${latest.version}`);
        }
        if (act === 'send') { const cur = editDoc(); if (cur) openSend(cur); return; }
        if (act === 'sec-add') {
          const doc = editDoc(); if (!doc) return;
          const s = { id: newId(), title: '', body: '' };
          doc.sections.push(s);
          return structural(`[data-sec="${CSS.escape(s.id)}"] .tr-sec-title`);
        }
        if (act === 'sec-up' || act === 'sec-down') {
          const doc = editDoc(); const i = secIndex(b); if (!doc || i < 0) return;
          const j = i + (act === 'sec-up' ? -1 : 1);
          if (j < 0 || j >= doc.sections.length) return;
          const [s] = doc.sections.splice(i, 1); doc.sections.splice(j, 0, s);
          return structural(`[data-sec="${CSS.escape(s.id)}"] [data-tr="${act}"]:not([disabled])`);
        }
        if (act === 'sec-del') {
          const doc = editDoc(); const i = secIndex(b); if (!doc || i < 0) return;
          const s = doc.sections[i];
          if ((s.body.trim() || s.title.trim()) && !armed(b, 'Remove?')) return;
          doc.sections.splice(i, 1);
          structural();
          return ctx.toast(`Removed ${s.title ? '“' + s.title + '”' : 'the section'}`, 'trash-2');
        }
        if (act === 'board-new') {
          const el = ctx.modal(ctx.frame({
            title: 'New board', sub: 'Group lookbook items by theme',
            body: `<div class="field"><label for="tr-nb">Board name</label><input class="input" id="tr-nb" dir="auto" maxlength="60" placeholder="${esc(BOARD_IDEAS.find((x) => !boardsOf(pid, d.items).includes(x)) || 'Night')}"></div>
              <div class="row wrap">${BOARD_IDEAS.filter((x) => !boardsOf(pid, d.items).includes(x)).map((x) => `<button class="chip" data-nb="${esc(x)}">${esc(x)}</button>`).join('')}</div>`,
            foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="tr-nb-go">${ui.icon('plus')}Create board</button>`,
          }));
          const inp = el.querySelector('#tr-nb');
          const make = (name) => {
            const n = txt(name, 60);
            if (!n) { inp.focus(); return; }
            S.boards[pid] = [...new Set([...(S.boards[pid] || []), n])];
            S.board[pid] = n;
            ctx.closeOverlay(); repaint();
          };
          el.addEventListener('click', (ev) => { const c = ev.target.closest('[data-nb]'); if (c) make(c.dataset.nb); });
          el.querySelector('#tr-nb-go').addEventListener('click', () => make(inp.value));
          inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); make(inp.value); } });
          return;
        }
        if (act === 'add-note') return itemForm('note', null);
        if (act === 'add-color') return itemForm('color', null);
        const tile = b.closest('[data-item]');
        const it = tile && d.items.find((i) => i.id === tile.dataset.item);
        if (!it) return;
        if (act === 'item-edit') return itemForm(it.kind, it);
        if (act === 'item-del') { if (armed(b, 'Delete?')) removeItem(it.id); }
      });

      /* ---------- inline editing of the draft (autosaved) */
      root.addEventListener('input', (e) => {
        const el = e.target;
        const f = el.dataset && el.dataset.trF;
        if (!f) return;
        const doc = editDoc(); if (!doc) return;
        if (f === 'title') doc.title = el.value.slice(0, 300);
        else {
          const i = secIndex(el); if (i < 0) return;
          const s = doc.sections[i];
          if (f === 'sec-title') {
            s.title = el.value.slice(0, 120);
            const ol = root.querySelector(`[data-tr-ol-t="${CSS.escape(s.id)}"]`); if (ol) ol.textContent = s.title || 'Untitled section';
            const ic = el.closest('.tr-sec').querySelector('.tr-sec-ic'); if (ic && ic.dataset.icon !== secIcon(s.title)) { ic.dataset.icon = secIcon(s.title); ic.innerHTML = ui.icon(secIcon(s.title)); MPH.icons(); }
          } else {
            s.body = el.value.slice(0, 20000);
            if (needsAutosize) autosize(el);
            const dot = root.querySelector(`[data-tr-ol-d="${CSS.escape(s.id)}"]`); if (dot) dot.classList.toggle('on', !!s.body.trim());
            const stat = root.querySelector('[data-tr-ol-stat]');
            if (stat) { const w = docWords(doc); const filled = doc.sections.filter((x) => x.body.trim()).length; stat.textContent = `${filled} of ${doc.sections.length} written${w ? ` · ${w.toLocaleString('en-US')} words` : ''}`; }
          }
        }
        saver.touch();
      });
      root.addEventListener('focusout', (e) => { if (e.target.dataset && e.target.dataset.trF) saver.flush(); });
      root.addEventListener('keydown', (e) => {
        if (e.target.matches && e.target.matches('.tr-title-in, .tr-sec-title') && e.key === 'Enter') {
          e.preventDefault();
          const sec = e.target.closest('.tr-sec');
          const next = sec ? sec.querySelector('.tr-sec-body') : root.querySelector('.tr-sec-body');
          if (next) next.focus();
        }
      });

      /* ---------- files: picker, drop on the board */
      root.addEventListener('change', (e) => { if (e.target.matches('[data-tr-file]')) { const files = [...e.target.files]; e.target.value = ''; uploadFiles(files); } });
      let drag = null;
      const clearMarks = () => root.querySelectorAll('.tr-before, .tr-after').forEach((x) => x.classList.remove('tr-before', 'tr-after'));
      const isFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
      root.addEventListener('dragstart', (e) => {
        const tile = e.target.closest && e.target.closest('.tr-tile[draggable="true"]');
        if (!tile) return;
        drag = tile.dataset.item;
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', drag); } catch (err) { /* restricted */ }
        requestAnimationFrame(() => tile.classList.add('is-dragging'));
      });
      root.addEventListener('dragover', (e) => {
        if (!canWrite(ctx)) return;
        if (isFiles(e) && !drag) {
          e.preventDefault(); // never let a dropped file navigate away from unsaved work
          const zone = e.target.closest && e.target.closest('.tr-look');
          if (!zone) { e.dataTransfer.dropEffect = 'none'; return; }
          e.dataTransfer.dropEffect = 'copy';
          root.querySelector('[data-tr-grid]')?.classList.add('over');
          return;
        }
        if (!drag) return;
        const tile = e.target.closest && e.target.closest('.tr-tile[data-item]');
        clearMarks();
        if (!tile || tile.dataset.item === drag) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        const r = tile.getBoundingClientRect();
        tile.classList.add(e.clientY < r.top + r.height / 2 ? 'tr-before' : 'tr-after');
      });
      root.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !root.contains(e.relatedTarget)) root.querySelector('[data-tr-grid]')?.classList.remove('over'); });
      root.addEventListener('drop', (e) => {
        if (!canWrite(ctx)) return;
        root.querySelector('[data-tr-grid]')?.classList.remove('over');
        if (isFiles(e) && !drag) {
          e.preventDefault();
          if (!(e.target.closest && e.target.closest('.tr-look'))) return;
          uploadFiles(e.dataTransfer.files);
          return;
        }
        if (!drag) return;
        const tile = e.target.closest && e.target.closest('.tr-tile[data-item]');
        if (!tile || tile.dataset.item === drag) return;
        e.preventDefault();
        const r = tile.getBoundingClientRect();
        const id = drag; drag = null;
        moveItem(id, tile.dataset.item, e.clientY < r.top + r.height / 2);
      });
      root.addEventListener('dragend', () => { drag = null; clearMarks(); root.querySelectorAll('.is-dragging').forEach((x) => x.classList.remove('is-dragging')); });
    },
  });
})();

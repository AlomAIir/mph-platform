/* Storyboard (#p.<id>.storyboard[.<frameId>]): Pre-production · Visualize.
   A grid of frames (storyboard_frames) in one global order (sort), optionally grouped by scene. Each frame has an
   image (media bucket, client scope), title, description, shot size, movement, a colour label, and links to a scene
   (active_scenes) and a shot (shots). "Create frames from the shot list" makes one frame per shot not yet boarded.
   Frames without an image get a pitch-style placeholder drawn from the shot size and movement.
   Clients see the frames read only, and only when productions.share_storyboard is on (RLS enforces the same). */
(function () {
  const esc = MPH.esc;
  const SIZES = ['EWS', 'WS', 'MWS', 'MS', 'MCU', 'CU', 'ECU', 'Insert', 'OTS', 'POV', 'Two-shot'];
  const SIZE_NAMES = { EWS: 'Extreme wide shot', WS: 'Wide shot', MWS: 'Medium wide shot', MS: 'Medium shot', MCU: 'Medium close-up', CU: 'Close-up', ECU: 'Extreme close-up', Insert: 'Insert', OTS: 'Over the shoulder', POV: 'Point of view', 'Two-shot': 'Two-shot' };
  const MOVES = ['Static', 'Pan', 'Tilt', 'Dolly', 'Tracking', 'Crane', 'Drone', 'Handheld', 'Gimbal', 'Car mount', 'Push in', 'Pull out'];
  const LABELS = [['lime', '#ACD062', 'Lime'], ['apricot', '#FAB771', 'Apricot'], ['teal', '#7FB2A6', 'Teal'], ['sky', '#86B8E8', 'Sky'],
    ['gold', '#F2C94C', 'Gold'], ['coral', '#F07A6A', 'Coral'], ['violet', '#B79CF0', 'Violet']];
  const ASPECTS = [['16:9', '16 / 9', 16 / 9], ['2.39:1', '2.39 / 1', 2.39], ['9:16', '9 / 16', 9 / 16], ['1:1', '1 / 1', 1]];

  const pad = (n) => String(n).padStart(2, '0');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const txt = (v, max = 2000) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
  const label = (k) => LABELS.find((l) => l[0] === k) || null;
  const byNum = (a, b) => String(a.num).localeCompare(String(b.num), undefined, { numeric: true });
  const sceneOrder = (a, b) => ((a.sort || 0) - (b.sort || 0)) || byNum(a, b);
  const byCreated = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''));
  const frameOrder = (a, b) => ((a.sort || 0) - (b.sort || 0)) || byCreated(a, b);
  const aspectOf = (ctx) => ASPECTS.find((a) => a[0] === ctx.state.sbdAspect) || ASPECTS[0];
  const colsOf = (ctx) => ([1, 2, 3, 4].includes(ctx.state.sbdCols) ? ctx.state.sbdCols : 3);
  const grouped = (ctx) => ctx.state.sbdGroup !== false;
  const canWrite = (ctx) => ctx.canEdit && !ctx.isClient;
  const sceneOf = (d, id) => d.scenes.find((s) => s.id === id) || null;
  const shotOf = (d, id) => d.shots.find((s) => s.id === id) || null;
  const baseName = (name) => String(name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim();

  /* ------------------------------------------------------------ placeholder frame: flat pitch-style drawing
     The subject's scale follows the shot size and a dashed arrow shows the camera movement. */
  let artN = 0;
  function placeholder(f) {
    const C = MPH.art.colors;
    const n = ++artN;
    const h = MPH.hue(f.id || f.title || 'frame');
    const PALS = [
      ['#0B1817', '#1E4A42', '#102A27', C.apricot],
      ['#10302C', '#4E8A7E', '#0E2422', C.lime],
      ['#1A1310', '#6A4A34', '#241A15', C.apricot],
      ['#07100F', '#16403B', '#0A1614', C.cream],
    ];
    const [top, bot, ground, acc] = PALS[h % PALS.length];
    const size = SIZES.includes(f.shot_size) ? f.shot_size : 'MS';
    const wide = ['EWS', 'WS', 'POV'].includes(size);
    const hz = wide ? 60 : 64;
    const fig = (cx, hgt, base, fill) => {
      const r = hgt * 0.11, hy = base - hgt + r, sy = hy + r + hgt * 0.03, w1 = hgt * 0.17, w2 = hgt * 0.25;
      return `<circle cx="${cx}" cy="${hy.toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}"/><path d="M${(cx - w1).toFixed(1)} ${(sy + hgt * 0.1).toFixed(1)} Q${(cx - w1).toFixed(1)} ${sy.toFixed(1)} ${cx} ${sy.toFixed(1)} Q${(cx + w1).toFixed(1)} ${sy.toFixed(1)} ${(cx + w1).toFixed(1)} ${(sy + hgt * 0.1).toFixed(1)} L${(cx + w2).toFixed(1)} ${base} L${(cx - w2).toFixed(1)} ${base} Z" fill="${fill}"/>`;
    };
    const G = { EWS: [12, 62], WS: [26, 69], MWS: [50, 80], MS: [80, 99], MCU: [120, 137], CU: [190, 207], ECU: [330, 339], POV: [20, 66] };
    const x = [80, 62, 98][h % 3];
    const cream = C.cream;
    let subject = '';
    if (size === 'Insert') subject = `<rect x="58" y="34" width="44" height="30" rx="6" fill="${cream}" opacity=".92"/><rect x="64" y="40" width="20" height="4" rx="2" fill="${acc}"/><rect x="64" y="48" width="30" height="3" rx="1.5" fill="${C.line}"/><rect x="50" y="66" width="60" height="4" rx="2" fill="#000" opacity=".25"/>`;
    else if (size === 'Two-shot') subject = fig(64, 46, 81, cream) + fig(97, 42, 81, C.creamD);
    else if (size === 'OTS') subject = fig(104, 58, 92, C.creamD) + `<g opacity=".96">${fig(30, 190, 214, '#050B0A')}</g>`;
    else { const [hg, base] = G[size]; subject = fig(x, hg, base, cream); }
    const sunX = 22 + (h % 116);
    const sun = wide || size === 'MWS' ? `<circle cx="${sunX}" cy="${hz - 12}" r="16" fill="${acc}" opacity=".18"/><circle cx="${sunX}" cy="${hz - 12}" r="6.5" fill="${acc}"/>` : `<circle cx="${sunX}" cy="22" r="26" fill="${acc}" opacity=".08"/>`;
    const arrow = (x1, y1, x2, y2) => {
      const a = Math.atan2(y2 - y1, x2 - x1), L = 4.2;
      const p1 = [x2 - L * Math.cos(a - 0.5), y2 - L * Math.sin(a - 0.5)], p2 = [x2 - L * Math.cos(a + 0.5), y2 - L * Math.sin(a + 0.5)];
      return `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${C.lime}" stroke-width="1.4" stroke-dasharray="3 2" fill="none"/><path d="M${x2} ${y2} L${p1[0].toFixed(1)} ${p1[1].toFixed(1)} L${p2[0].toFixed(1)} ${p2[1].toFixed(1)}Z" fill="${C.lime}"/>`;
    };
    const mv = f.movement || '';
    let move = '';
    if (mv === 'Pan') move = arrow(58, 11, 102, 11);
    else if (mv === 'Tilt') move = arrow(149, 58, 149, 24);
    else if (mv === 'Tracking' || mv === 'Car mount') move = arrow(36, 83, 124, 83);
    else if (mv === 'Dolly' || mv === 'Push in') move = `<rect x="34" y="20" width="92" height="52" rx="3" fill="none" stroke="${C.lime}" stroke-width="1" stroke-dasharray="3 2" opacity=".85"/>${arrow(20, 10, 33, 19)}`;
    else if (mv === 'Pull out') move = `<rect x="34" y="20" width="92" height="52" rx="3" fill="none" stroke="${C.lime}" stroke-width="1" stroke-dasharray="3 2" opacity=".85"/>${arrow(33, 19, 18, 8)}`;
    else if (mv === 'Crane' || mv === 'Drone') move = `<path d="M136 74 Q150 50 138 22" stroke="${C.lime}" stroke-width="1.4" stroke-dasharray="3 2" fill="none"/>${arrow(139.5, 26, 138, 20)}`;
    else if (mv === 'Handheld' || mv === 'Gimbal') move = `<path d="M60 11 q5 -4 10 0 t10 0 t10 0 t10 0" stroke="${C.lime}" stroke-width="1.4" fill="none" stroke-linecap="round"/>`;
    const corners = [[6, 6, 1, 1], [154, 6, -1, 1], [6, 84, 1, -1], [154, 84, -1, -1]].map(([cx, cy, sx, sy]) => `<path d="M${cx} ${cy + 7 * sy} V${cy} H${cx + 7 * sx}" stroke="${cream}" stroke-width="1" fill="none" opacity=".35"/>`).join('');
    const pov = size === 'POV' ? `<rect width="160" height="90" fill="url(#sbdv${n})"/>` : '';
    return `<svg class="sbd-art" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs><linearGradient id="sbds${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bot}"/></linearGradient>
        <radialGradient id="sbdv${n}" cx=".5" cy=".5" r=".62"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".85"/></radialGradient></defs>
      <rect width="160" height="90" fill="url(#sbds${n})"/>${sun}
      <path d="M0 ${hz} C40 ${hz - 4} 90 ${hz + 3} 160 ${hz - 2} V90 H0Z" fill="${ground}"/>
      ${subject}${pov}${move}${corners}
    </svg>`;
  }

  /* ------------------------------------------------------------ ordering */
  function groupsOf(d) {
    const ids = new Set(d.scenes.map((s) => s.id));
    const out = d.scenes.map((sc) => ({ key: sc.id, scene: sc, frames: d.frames.filter((f) => f.scene_id === sc.id) })).filter((g) => g.frames.length);
    const loose = d.frames.filter((f) => !f.scene_id || !ids.has(f.scene_id));
    if (loose.length) out.push({ key: 'none', scene: null, frames: loose });
    return out;
  }
  const displayed = (ctx, d) => (grouped(ctx) ? groupsOf(d).flatMap((g) => g.frames) : d.frames);
  const unboarded = (d) => { const done = new Set(d.frames.map((f) => f.shot_id).filter(Boolean)); return d.shots.filter((s) => !done.has(s.id)); };

  /* ------------------------------------------------------------ pieces */
  function mediaHtml(d, f) {
    const url = f.image_path ? d.urls[f.image_path] : null;
    return url ? `<img src="${esc(url)}" alt="${esc(f.title || 'Storyboard frame')}" loading="lazy" draggable="false">` : placeholder(f);
  }

  function cardHtml(ctx, d, f, n, editable) {
    const { ui } = ctx;
    const url = f.image_path ? d.urls[f.image_path] : null;
    const sc = sceneOf(d, f.scene_id);
    const sh = shotOf(d, f.shot_id);
    const lb = label(f.label);
    const title = f.title || (sh && sh.code ? `Shot ${sh.code}` : `Frame ${n}`);
    return `
      <article class="sbd-card ${lb ? 'has-label' : ''} ${url ? '' : 'no-img'}" data-frame="${esc(f.id)}" ${editable ? 'draggable="true"' : ''} style="${lb ? `--lc:${lb[1]};` : ''}animation-delay:${Math.min(n, 14) * 28}ms">
        <button class="sbd-img" data-sbd="open" aria-label="${editable ? 'Edit' : 'View'} frame ${n}: ${esc(title)}">
          ${mediaHtml(d, f)}
          <span class="sbd-num num">${pad(n)}</span>
          ${sh && sh.code ? `<span class="sbd-code mono">${esc(sh.code)}</span>` : ''}
          ${!url && editable ? `<span class="sbd-hint">${ui.icon('image-up')}Drop an image</span>` : ''}
          ${editable ? `<span class="sbd-drop">${ui.icon('image-up')}Drop to replace</span>` : ''}
        </button>
        <div class="sbd-meta">
          <div class="row sbd-title-row">${lb ? `<span class="sbd-lbl" title="${esc(lb[2])} label"></span>` : ''}<span class="sbd-title truncate" dir="auto">${esc(title)}</span></div>
          ${f.description ? `<p class="sbd-desc" dir="auto">${esc(f.description)}</p>` : editable ? '<p class="sbd-desc faint">Add what happens in this frame.</p>' : ''}
          <div class="row wrap sbd-tags">
            ${f.shot_size ? `<span class="sbd-tag" title="${esc(SIZE_NAMES[f.shot_size] || f.shot_size)}">${esc(f.shot_size)}</span>` : ''}
            ${f.movement ? `<span class="sbd-tag">${esc(f.movement)}</span>` : ''}
            ${sc ? `<span class="sbd-sc" title="${esc(sc.heading || '')}">Sc. ${esc(sc.num)}</span>` : ''}
          </div>
        </div>
        ${editable ? `<span class="sbd-grip" title="Drag to reorder" aria-hidden="true">${ui.icon('grip-vertical')}</span>` : ''}
      </article>`;
  }

  function gridHtml(ctx, d, frames, startN, key, editable) {
    const a = aspectOf(ctx);
    return `<div class="sbd-grid" data-sbd-grid data-group="${esc(key)}" style="--cols:${colsOf(ctx)};--ar:${a[1]}">${frames.map((f, i) => cardHtml(ctx, d, f, startN + i, editable)).join('')}</div>`;
  }

  function shareHtml(ctx) {
    const on = !!ctx.production.share_storyboard;
    return `<button class="sbd-share ${on ? 'on' : ''}" role="switch" aria-checked="${on}" data-sbd="share">
      <span class="toggle ${on ? 'on' : ''}" aria-hidden="true"></span>
      <span class="stack" style="gap:0"><span class="small strong">Share with client</span><span class="tiny muted">${on ? 'Your client can see these frames' : 'Only your team can see it'}</span></span></button>`;
  }

  function renderPage(ctx, d) {
    const { ui } = ctx;
    const p = ctx.production;
    const editable = canWrite(ctx);
    if (d.hidden) {
      return `<div class="page sbd-page">
        ${ui.pageHead({ eyebrow: 'Visualize', title: ctx.t('Storyboard'), sub: esc(p.title) })}
        ${ui.panel({ body: ui.empty('layout-grid', 'Storyboard not shared yet', ctx.realClient
          ? 'Your production team hasn’t shared the storyboard yet.'
          : 'Your production team hasn’t shared the storyboard yet. That’s what your client sees now. Turn on “Share with client” on the Storyboard in the producer view to show it.') })}
      </div>`;
    }
    const list = displayed(ctx, d);
    const todo = unboarded(d);
    const scenesUsed = new Set(d.frames.map((f) => f.scene_id).filter((id) => sceneOf(d, id))).size;
    const linked = d.frames.filter((f) => f.shot_id && shotOf(d, f.shot_id)).length;
    const head = ui.pageHead({
      eyebrow: `Visualize${ctx.isClient ? '' : p.share_storyboard ? ' · Shared with the client' : ' · Team only'}`,
      title: ctx.t('Storyboard'),
      sub: d.frames.length ? `${plural(d.frames.length, 'frame')}${scenesUsed ? ` across ${plural(scenesUsed, 'scene')}` : ''}${!ctx.isClient && linked ? ` · ${linked} linked to the shot list` : ''}` : esc(p.title),
      actions: `${ctx.canSeeInternal && !ctx.isClient ? shareHtml(ctx) : ''}${d.frames.length ? `<button class="btn btn-sm btn-outline" data-sbd="present">${ui.icon('presentation')}Present</button>` : ''}`,
    });

    if (!d.frames.length) {
      if (!editable) {
        return `<div class="page sbd-page">${head}${ui.panel({ body: ui.empty('layout-grid', 'No frames yet', ctx.isClient ? 'Your production team hasn’t added any frames yet.' : 'Producers and heads of department build the storyboard here.') })}</div>`;
      }
      return `<div class="page sbd-page">${head}
        <section class="sbd-start">
          <div class="sbd-start-art">${MPH.art.step('storyboard')}</div>
          <div class="stack">
            <div class="stack tight"><span class="eyebrow accent">Board the film</span><h2 class="h2">Frame by frame, from your shot list</h2>
              <p class="muted">${d.shots.length ? `Every shot becomes a frame with its size, movement and description filled in: ${plural(todo.length, 'frame')} ready to create. Then drop in your artist’s sketches or reference stills.` : 'Plan shots on the Shot List and they turn into frames here in one click. Or upload your storyboard artist’s images now; files named after a shot code (for example 3A.jpg) link to that shot.'}</p></div>
            <div class="row wrap">
              ${todo.length ? `<button class="btn btn-primary" data-sbd="from-shots">${ui.icon('list-video')}Create ${plural(todo.length, 'frame')} from the shot list</button>` : `<a class="btn btn-outline" href="#p.${p.id}.shotlist">${ui.icon('list-video')}Open the Shot List</a>`}
              <label class="btn btn-outline">${ui.icon('image-up')}Upload frames<input type="file" accept="image/*" multiple data-sbd-file hidden></label>
              <button class="btn btn-ghost" data-sbd="add">${ui.icon('plus')}Add a blank frame</button>
            </div>
          </div>
        </section>
        <label class="dropzone sbd-dropzone" data-sbd-zone>${ui.icon('images')}<span class="strong">Drop storyboard images here</span><span class="small">One frame per image, in file-name order. JPG, PNG or WebP.</span><input type="file" accept="image/*" multiple data-sbd-file hidden></label>
      </div>`;
    }

    const a = aspectOf(ctx);
    const cols = colsOf(ctx);
    const toolbar = `
      <div class="sbd-toolbar">
        ${editable ? `<div class="toolbar">
          <button class="btn btn-sm ${todo.length ? 'btn-primary' : 'btn-outline'}" data-sbd="from-shots" ${todo.length ? '' : 'disabled title="Every shot on the shot list has a frame"'}>${ui.icon('list-video')}Create frames from the shot list${todo.length ? `<span class="sbd-count num">${todo.length}</span>` : ''}</button>
          <label class="btn btn-sm btn-outline">${ui.icon('image-up')}Upload frames<input type="file" accept="image/*" multiple data-sbd-file hidden></label>
          <button class="btn btn-sm btn-ghost" data-sbd="add">${ui.icon('plus')}Blank frame</button>
        </div>` : ''}
        <span class="spacer"></span>
        <button class="sbd-switch" role="switch" aria-checked="${grouped(ctx)}" data-sbd="group"><span class="toggle ${grouped(ctx) ? 'on' : ''}" aria-hidden="true"></span>Group by scene</button>
        <div class="seg" role="group" aria-label="Aspect ratio">${ASPECTS.map(([id]) => `<button class="${a[0] === id ? 'on' : ''}" data-sbd-aspect="${id}" aria-pressed="${a[0] === id}">${id}</button>`).join('')}</div>
        <div class="seg" role="group" aria-label="Frames per row">${[1, 2, 3, 4].map((c) => `<button class="${cols === c ? 'on' : ''}" data-sbd-cols="${c}" aria-pressed="${cols === c}" title="${plural(c, 'frame')} per row">${c}</button>`).join('')}</div>
      </div>`;

    let body;
    if (grouped(ctx)) {
      let n = 1;
      body = groupsOf(d).map((g) => {
        const html = `
          <section class="sbd-group">
            <header class="sbd-group-h">
              ${g.scene ? `<span class="sbd-scn mono">Sc. ${esc(g.scene.num)}</span><span class="strong truncate" dir="auto">${esc(g.scene.heading || g.scene.location || 'Untitled scene')}</span>` : `<span class="strong">${ctx.isClient ? 'Other frames' : 'Not linked to a scene'}</span>`}
              <span class="tiny faint nowrap">${plural(g.frames.length, 'frame')}</span>
            </header>
            ${gridHtml(ctx, d, g.frames, n, g.key, editable)}
          </section>`;
        n += g.frames.length;
        return html;
      }).join('');
    } else body = gridHtml(ctx, d, list, 1, 'all', editable);

    return `
      <div class="page full sbd-page">
        ${head}${toolbar}
        <div class="stack sbd-board" data-sbd-zone>${body}</div>
        ${editable ? `<p class="tiny faint sbd-hint-line">${ui.icon('info')}Drag frames to reorder${grouped(ctx) ? ' inside a scene' : ''}. Drop an image on a frame to replace it, or anywhere on the board to add new frames.</p>` : ''}
      </div>`;
  }

  /* ------------------------------------------------------------ present */
  function present(ctx, d, startId) {
    const { ui } = ctx;
    const list = displayed(ctx, d);
    if (!list.length) return;
    const a = aspectOf(ctx);
    const slides = list.map((f, i) => {
      const sc = sceneOf(d, f.scene_id);
      const sh = shotOf(d, f.shot_id);
      const lb = label(f.label);
      return `
        <div class="sbd-slide" style="--ar:${a[1]};--arn:${a[2]}">
          <div class="sbd-slide-img">${mediaHtml(d, f)}<span class="sbd-num num">${pad(i + 1)}</span></div>
          <div class="sbd-slide-cap">
            <div class="row wrap">
              ${lb ? `<span class="sbd-lbl" style="--lc:${lb[1]}"></span>` : ''}
              <span class="strong" dir="auto">${esc(f.title || (sh && sh.code ? 'Shot ' + sh.code : 'Frame ' + (i + 1)))}</span>
              ${sc ? `<span class="small muted" dir="auto">Sc. ${esc(sc.num)}${sc.heading ? ' · ' + esc(sc.heading) : ''}</span>` : ''}
              <span class="spacer"></span>
              ${f.shot_size ? `<span class="sbd-tag">${esc(SIZE_NAMES[f.shot_size] || f.shot_size)}</span>` : ''}${f.movement ? `<span class="sbd-tag">${esc(f.movement)}</span>` : ''}
            </div>
            ${f.description ? `<p dir="auto">${esc(f.description)}</p>` : ''}
          </div>
        </div>`;
    });
    const start = Math.max(0, list.findIndex((f) => f.id === startId));
    if (MPH.trShow) MPH.trShow({ title: ctx.production.title, sub: `Storyboard · ${plural(list.length, 'frame')}`, slides, start });
    else ctx.toast('Presentation mode isn’t available right now. Reload the page and try again.', 'triangle-alert');
    void ui;
  }

  /* two-step confirm */
  const armed = (btn, text) => {
    if (btn.dataset.armed) return true;
    btn.dataset.armed = '1';
    const html = btn.innerHTML;
    btn.classList.add('sbd-armed'); btn.textContent = text;
    setTimeout(() => { if (!btn.isConnected) return; delete btn.dataset.armed; btn.classList.remove('sbd-armed'); btn.innerHTML = html; }, 3000);
    return false;
  };

  /* ------------------------------------------------------------ view */
  MPH.view('storyboard', {
    async load(ctx) {
      const pid = ctx.production.id;
      const { must } = ctx.api;
      if (ctx.isClient && !ctx.production.share_storyboard) return { hidden: true, frames: [], scenes: [], shots: [], urls: {} };
      const [f, sc, sh] = await Promise.all([
        ctx.sb.from('storyboard_frames').select('*').eq('production_id', pid),
        ctx.sb.from('active_scenes').select('id, num, heading, location, sort').eq('production_id', pid),
        // shots are team-only: never queried in the client view
        ctx.isClient ? Promise.resolve({ data: [], error: null }) : ctx.sb.from('shots').select('id, scene_id, code, size, movement, description, sort, created_at').eq('production_id', pid),
      ]);
      const frames = must(f).sort(frameOrder);
      const scenes = must(sc).sort(sceneOrder);
      const ids = new Set(scenes.map((s) => s.id));
      const rank = new Map(scenes.map((s, i) => [s.id, i]));
      const shots = must(sh).filter((s) => ids.has(s.scene_id))
        .sort((a, b) => (rank.get(a.scene_id) - rank.get(b.scene_id)) || ((a.sort || 0) - (b.sort || 0)) || byCreated(a, b));
      const urls = await ctx.api.mediaUrls(frames.map((x) => x.image_path).filter(Boolean));
      return { frames, scenes, shots, urls };
    },

    render: renderPage,

    mount(root, ctx, d) {
      const { ui } = ctx;
      const pid = ctx.production.id;
      const repaint = () => { root.innerHTML = renderPage(ctx, d); MPH.icons(); };
      const nextSort = () => d.frames.reduce((m, f) => Math.max(m, (f.sort || 0) + 1), 0);
      const findFrame = (id) => d.frames.find((f) => f.id === id);
      let drawerFor = null; // frame id whose drawer is open

      const persistOrder = () => {
        const changed = [];
        d.frames.forEach((f, i) => { if (f.sort !== i) { f.sort = i; changed.push(f); } });
        if (!changed.length) return;
        Promise.all(changed.map((f) => ctx.sb.from('storyboard_frames').update({ sort: f.sort }).eq('id', f.id))).then((res) => {
          const bad = res.find((r) => r.error);
          if (bad) { ctx.toastError(new Error(`The new order didn’t save: ${bad.error.message}`)); ctx.reload(); }
        });
      };

      const insertFrames = async (rows, msg) => {
        const ins = ctx.api.must(await ctx.sb.from('storyboard_frames').insert(rows).select());
        Object.assign(d.urls, await ctx.api.mediaUrls(ins.map((x) => x.image_path).filter(Boolean)));
        d.frames.push(...ins); d.frames.sort(frameOrder);
        repaint();
        if (msg) ctx.toast(msg(ins), 'layout-grid');
        return ins;
      };

      const fromShots = () => {
        const todo = unboarded(d);
        if (!todo.length) return ctx.toast('Every shot on the shot list already has a frame', 'list-video');
        const el = ctx.modal(ctx.frame({
          title: `Create ${plural(todo.length, 'frame')} from the shot list`,
          sub: `${plural(new Set(todo.map((s) => s.scene_id)).size, 'scene')}`,
          body: `<p>One frame for each shot that isn’t on the storyboard yet, in shot-list order. Each frame takes the shot’s code, size, movement and description. Add images afterwards, or drop them on the frames.</p>
            <div class="sbd-preview-list">${todo.slice(0, 8).map((s) => `<div class="row small"><span class="mono strong">${esc(s.code || '—')}</span><span class="sbd-tag">${esc(s.size || '—')}</span><span class="muted truncate grow" dir="auto">${esc(s.description || '')}</span></div>`).join('')}${todo.length > 8 ? `<span class="tiny faint">and ${todo.length - 8} more</span>` : ''}</div>`,
          foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="sbd-fs-go">${ui.icon('list-video')}Create ${plural(todo.length, 'frame')}</button>`,
        }));
        const go = el.querySelector('#sbd-fs-go');
        go.addEventListener('click', async () => {
          go.disabled = true; go.innerHTML = `${ui.spinner()}Creating…`;
          let sort = nextSort();
          const rows = todo.map((s) => ({
            production_id: pid, scene_id: s.scene_id, shot_id: s.id, title: s.code ? `Shot ${s.code}` : null,
            description: txt(s.description), shot_size: txt(s.size, 40), movement: txt(s.movement, 40), sort: sort++,
          }));
          try { await insertFrames(rows, (ins) => `Created ${plural(ins.length, 'frame')} from the shot list`); ctx.closeOverlay(); }
          catch (ex) { go.disabled = false; go.innerHTML = `${ui.icon('list-video')}Try again`; MPH.icons(); ctx.toastError(ex); }
        });
      };

      const addBlank = async (btn) => {
        if (btn) btn.disabled = true;
        try {
          const [f] = await insertFrames([{ production_id: pid, sort: nextSort(), shot_size: 'WS', movement: 'Static' }]);
          openFrame(f.id);
        } catch (ex) { ctx.toastError(ex); if (btn && btn.isConnected) btn.disabled = false; }
      };

      const imageFiles = (list) => {
        const files = [...(list || [])].filter((f) => /^image\//.test(f.type));
        if (!files.length) { ctx.toast('Choose image files: JPG, PNG, WebP or GIF', 'image-off'); return null; }
        const big = files.find((f) => f.size > 25 * 1024 * 1024);
        if (big) { ctx.toastError(new Error(`${big.name} is over 25 MB. Export a smaller version and try again.`)); return null; }
        return files;
      };

      const uploadNew = async (list) => {
        const files = imageFiles(list);
        if (!files) return;
        files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        ctx.toast(`Uploading ${plural(files.length, 'image')}…`, 'image-up');
        const zone = root.querySelector('[data-sbd-zone]');
        if (zone) zone.classList.add('is-busy');
        const res = await Promise.allSettled(files.map((f) => ctx.api.uploadMedia(pid, f, 'client', 'storyboard')));
        const free = unboarded(d);
        let sort = nextSort();
        const rows = [];
        res.forEach((r, k) => {
          if (r.status !== 'fulfilled') return;
          const base = baseName(files[k].name);
          const sh = free.find((s) => s.code && s.code.toLowerCase() === base.toLowerCase());
          if (sh) free.splice(free.indexOf(sh), 1);
          rows.push(sh
            ? { production_id: pid, image_path: r.value, scene_id: sh.scene_id, shot_id: sh.id, title: `Shot ${sh.code}`, description: txt(sh.description), shot_size: txt(sh.size, 40), movement: txt(sh.movement, 40), sort: sort++ }
            : { production_id: pid, image_path: r.value, title: txt(base, 120), sort: sort++ });
        });
        const failed = res.filter((r) => r.status === 'rejected');
        if (rows.length) {
          try {
            await insertFrames(rows, (ins) => {
              const matched = ins.filter((x) => x.shot_id).length;
              return `Added ${plural(ins.length, 'frame')}${matched ? `, ${matched} linked to shots by file name` : ''}`;
            });
          } catch (ex) { ctx.api.removeMedia(rows.map((r) => r.image_path)); ctx.toastError(ex); }
        }
        if (failed.length) ctx.toastError(new Error(`${plural(failed.length, 'image')} didn’t upload: ${failed[0].reason && failed[0].reason.message ? failed[0].reason.message : failed[0].reason}`));
        if (root.isConnected) { const z = root.querySelector('[data-sbd-zone]'); if (z) z.classList.remove('is-busy'); }
      };

      const replaceImage = async (id, list) => {
        const files = imageFiles(list);
        const f = findFrame(id);
        if (!files || !f) return;
        const card = root.querySelector(`[data-frame="${CSS.escape(id)}"]`);
        if (card) card.classList.add('is-busy');
        try {
          const path = await ctx.api.uploadMedia(pid, files[0], 'client', 'storyboard');
          try { ctx.api.must(await ctx.sb.from('storyboard_frames').update({ image_path: path }).eq('id', id)); }
          catch (ex) { ctx.api.removeMedia([path]); throw ex; }
          const old = f.image_path;
          f.image_path = path;
          Object.assign(d.urls, await ctx.api.mediaUrls([path]));
          if (old) ctx.api.removeMedia([old]).catch(() => {});
          repaint();
          if (drawerFor === id) paintDrawer();
          ctx.toast('Frame image updated', 'image-up');
        } catch (ex) { if (card && card.isConnected) card.classList.remove('is-busy'); ctx.toastError(ex); }
      };

      const removeImage = async (id) => {
        const f = findFrame(id);
        if (!f || !f.image_path) return;
        const old = f.image_path;
        try {
          ctx.api.must(await ctx.sb.from('storyboard_frames').update({ image_path: null }).eq('id', id));
          f.image_path = null;
          ctx.api.removeMedia([old]).catch(() => {});
          repaint(); if (drawerFor === id) paintDrawer();
        } catch (ex) { ctx.toastError(ex); }
      };

      const deleteFrame = async (id) => {
        const idx = d.frames.findIndex((f) => f.id === id);
        if (idx < 0) return;
        const [f] = d.frames.splice(idx, 1);
        repaint();
        try {
          ctx.api.must(await ctx.sb.from('storyboard_frames').delete().eq('id', id));
          if (f.image_path) ctx.api.removeMedia([f.image_path]).catch(() => {});
          ctx.toast('Frame deleted', 'trash-2');
        } catch (ex) { d.frames.splice(idx, 0, f); repaint(); ctx.toastError(ex); }
      };

      const updateFrame = async (id, patch, el) => {
        const f = findFrame(id);
        if (!f) return;
        const prev = {};
        Object.keys(patch).forEach((k) => { prev[k] = f[k]; });
        if (Object.keys(patch).every((k) => (f[k] ?? null) === (patch[k] ?? null))) return;
        Object.assign(f, patch);
        repaint();
        try {
          ctx.api.must(await ctx.sb.from('storyboard_frames').update(patch).eq('id', id));
          if (el && el.isConnected) { el.classList.remove('sbd-saved'); void el.offsetWidth; el.classList.add('sbd-saved'); }
        } catch (ex) { Object.assign(f, prev); repaint(); if (drawerFor === id) paintDrawer(); ctx.toastError(ex); }
      };

      /* ---------- frame drawer */
      let drawerEl = null;
      const drawerHtml = (f) => {
        const n = displayed(ctx, d).indexOf(f) + 1;
        const a = aspectOf(ctx);
        const sc = sceneOf(d, f.scene_id);
        const opt = (list, val, names) => {
          const all = val && !list.includes(val) ? [val, ...list] : list;
          return `<option value="">Not set</option>${all.map((v) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(names ? `${v} · ${names[v] || v}` : v)}</option>`).join('')}`;
        };
        const shotOpts = d.scenes.map((s) => {
          const shots = d.shots.filter((x) => x.scene_id === s.id);
          return shots.length ? `<optgroup label="Sc. ${esc(s.num)}">${shots.map((x) => `<option value="${esc(x.id)}" ${x.id === f.shot_id ? 'selected' : ''}>${esc(x.code || 'Shot')}${x.size ? ' · ' + esc(x.size) : ''}${x.description ? ' · ' + esc(x.description.slice(0, 40)) : ''}</option>`).join('')}</optgroup>` : '';
        }).join('');
        return ctx.frame({
          title: `Frame ${pad(n)}`,
          sub: sc ? `Sc. ${esc(sc.num)}${sc.heading ? ' · ' + esc(sc.heading) : ''}` : 'Not linked to a scene',
          body: `
            <div class="sbd-d-img" style="--ar:${a[1]}" data-sbd-dimg>${mediaHtml(d, f)}<span class="sbd-drop">${ui.icon('image-up')}Drop to replace</span></div>
            <div class="row wrap">
              <label class="btn btn-sm btn-outline">${ui.icon('image-up')}${f.image_path ? 'Replace image' : 'Add an image'}<input type="file" accept="image/*" data-sbd-dfile hidden></label>
              ${f.image_path ? `<button class="btn btn-sm btn-ghost" data-sbd-d="rm-img">${ui.icon('image-off')}Remove image</button>` : '<span class="tiny faint">Showing a sketch drawn from the shot size and movement.</span>'}
            </div>
            <div class="field"><label for="sbd-f-title">Title</label><input class="input" id="sbd-f-title" data-sbd-f="title" dir="auto" maxlength="120" value="${esc(f.title || '')}" placeholder="Shot 3A, or what the frame is"></div>
            <div class="field"><label for="sbd-f-desc">Description</label><textarea class="textarea" id="sbd-f-desc" data-sbd-f="description" rows="3" dir="auto" maxlength="2000" placeholder="What we see and hear in this frame">${esc(f.description || '')}</textarea></div>
            <div class="grid-2">
              <div class="field"><label for="sbd-f-size">Shot size</label><select class="select" id="sbd-f-size" data-sbd-f="shot_size">${opt(SIZES, f.shot_size, SIZE_NAMES)}</select></div>
              <div class="field"><label for="sbd-f-move">Movement</label><select class="select" id="sbd-f-move" data-sbd-f="movement">${opt(MOVES, f.movement)}</select></div>
            </div>
            <div class="field"><span class="label">Colour label</span>
              <div class="sbd-swatches" role="radiogroup" aria-label="Colour label">
                <button class="sbd-sw none ${!label(f.label) ? 'on' : ''}" role="radio" aria-checked="${!label(f.label)}" data-sbd-lbl="" title="No label">${ui.icon('ban')}</button>
                ${LABELS.map(([k, hex, name]) => `<button class="sbd-sw ${f.label === k ? 'on' : ''}" role="radio" aria-checked="${f.label === k}" data-sbd-lbl="${k}" style="--lc:${hex}" title="${name}" aria-label="${name}"></button>`).join('')}
              </div></div>
            <div class="grid-2">
              <div class="field"><label for="sbd-f-scene">Scene</label><select class="select" id="sbd-f-scene" data-sbd-f="scene_id"><option value="">No scene</option>${d.scenes.map((s) => `<option value="${esc(s.id)}" ${s.id === f.scene_id ? 'selected' : ''}>Sc. ${esc(s.num)}${s.heading ? ' · ' + esc(s.heading.slice(0, 48)) : ''}</option>`).join('')}</select></div>
              <div class="field"><label for="sbd-f-shot">Shot</label><select class="select" id="sbd-f-shot" data-sbd-f="shot_id"><option value="">Not linked</option>${shotOpts}</select></div>
            </div>
            ${f.shot_id && shotOf(d, f.shot_id) ? `<a class="tiny accent sbd-d-link" href="#p.${pid}.shotlist">${ui.icon('list-video')}Open shot ${esc(shotOf(d, f.shot_id).code || '')} in the Shot List</a>` : ''}`,
          foot: `<button class="btn btn-ghost sbd-del" data-sbd-d="delete">${ui.icon('trash-2')}Delete frame</button><span class="spacer"></span><button class="btn btn-primary" data-close>Done</button>`,
        });
      };
      function paintDrawer() {
        const f = findFrame(drawerFor);
        if (!drawerEl || !drawerEl.isConnected || !f) return;
        const focusId = document.activeElement && drawerEl.contains(document.activeElement) ? document.activeElement.id : null;
        drawerEl.innerHTML = drawerHtml(f);
        MPH.icons();
        if (focusId) { const x = drawerEl.querySelector('#' + CSS.escape(focusId)); if (x) x.focus({ preventScroll: true }); }
      }
      function openFrame(id) {
        const f = findFrame(id);
        if (!f) return;
        if (!canWrite(ctx)) return present(ctx, d, id);
        drawerFor = id;
        drawerEl = ctx.drawer(drawerHtml(f));
        drawerEl.addEventListener('change', async (e) => {
          const el = e.target;
          const fr = findFrame(drawerFor);
          if (!fr) return;
          if (el.matches('[data-sbd-dfile]')) { const files = [...el.files]; el.value = ''; return replaceImage(fr.id, files); }
          const k = el.dataset.sbdF;
          if (!k) return;
          const v = txt(el.value, k === 'description' ? 2000 : 120);
          if (k === 'shot_id') {
            const sh = shotOf(d, v);
            const patch = { shot_id: v };
            if (sh) {
              patch.scene_id = sh.scene_id;
              if (!fr.title) patch.title = sh.code ? `Shot ${sh.code}` : null;
              if (!fr.description && sh.description) patch.description = txt(sh.description);
              if (!fr.shot_size && sh.size) patch.shot_size = sh.size;
              if (!fr.movement && sh.movement) patch.movement = sh.movement;
            }
            await updateFrame(fr.id, patch, el);
            return paintDrawer();
          }
          if (k === 'scene_id') {
            const patch = { scene_id: v };
            const sh = shotOf(d, fr.shot_id);
            if (sh && sh.scene_id !== v) patch.shot_id = null; // the shot belongs to another scene
            await updateFrame(fr.id, patch, el);
            return paintDrawer();
          }
          updateFrame(fr.id, { [k]: v }, el);
          if (k === 'shot_size' || k === 'movement') paintDrawer();
        });
        drawerEl.addEventListener('click', (e) => {
          const fr = findFrame(drawerFor);
          if (!fr) return;
          const lb = e.target.closest('[data-sbd-lbl]');
          if (lb) { updateFrame(fr.id, { label: lb.dataset.sbdLbl || null }).then(paintDrawer); return; }
          const b = e.target.closest('[data-sbd-d]');
          if (!b) return;
          if (b.dataset.sbdD === 'rm-img') removeImage(fr.id);
          else if (b.dataset.sbdD === 'delete' && armed(b, 'Click again to delete')) { ctx.closeOverlay(); drawerFor = null; deleteFrame(fr.id); }
        });
        drawerEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input.input')) { e.preventDefault(); e.target.blur(); } });
        const isFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
        drawerEl.addEventListener('dragover', (e) => { if (!isFiles(e)) return; e.preventDefault(); const z = drawerEl.querySelector('[data-sbd-dimg]'); if (z) z.classList.add('over'); });
        drawerEl.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !drawerEl.contains(e.relatedTarget)) { const z = drawerEl.querySelector('[data-sbd-dimg]'); if (z) z.classList.remove('over'); } });
        drawerEl.addEventListener('drop', (e) => { if (!isFiles(e)) return; e.preventDefault(); const fr = findFrame(drawerFor); if (fr) replaceImage(fr.id, e.dataTransfer.files); });
      }

      /* ---------- clicks */
      root.addEventListener('click', async (e) => {
        const t = e.target;
        let b;
        if ((b = t.closest('[data-sbd-aspect]'))) { ctx.state.sbdAspect = b.dataset.sbdAspect; return repaint(); }
        if ((b = t.closest('[data-sbd-cols]'))) { ctx.state.sbdCols = Number(b.dataset.sbdCols); return repaint(); }
        if (!(b = t.closest('[data-sbd]')) || b.disabled) return;
        const act = b.dataset.sbd;
        if (act === 'group') { ctx.state.sbdGroup = !grouped(ctx); return repaint(); }
        if (act === 'present') return present(ctx, d);
        if (act === 'open') { const card = b.closest('[data-frame]'); if (card) openFrame(card.dataset.frame); return; }
        if (act === 'share') {
          if (!ctx.canSeeInternal || ctx.isClient) return;
          const on = !ctx.production.share_storyboard;
          b.disabled = true;
          try {
            const rows = ctx.api.must(await ctx.sb.from('productions').update({ share_storyboard: on }).eq('id', pid).select('id'));
            if (!rows.length) throw new Error('Only owners and producers can change what the client sees.');
            ctx.production.share_storyboard = on;
            repaint();
            ctx.toast(on ? 'Storyboard shared with the client' : 'Storyboard hidden from the client', on ? 'eye' : 'eye-off');
          } catch (ex) { b.disabled = false; ctx.toastError(ex); }
          return;
        }
        if (!canWrite(ctx)) return;
        if (act === 'from-shots') return fromShots();
        if (act === 'add') return addBlank(b);
      });
      root.addEventListener('change', (e) => { if (e.target.matches('[data-sbd-file]')) { const files = [...e.target.files]; e.target.value = ''; uploadNew(files); } });

      /* ---------- drag: reorder frames, drop images on a frame (replace) or on the board (new frames) */
      let drag = null;
      const isFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
      const clearMarks = () => root.querySelectorAll('.sbd-before, .sbd-after, .sbd-over').forEach((x) => x.classList.remove('sbd-before', 'sbd-after', 'sbd-over'));
      const beforeOf = (card, e) => {
        const r = card.getBoundingClientRect();
        if (colsOf(ctx) === 1) return e.clientY < r.top + r.height / 2;
        const left = e.clientX < r.left + r.width / 2;
        return document.documentElement.dir === 'rtl' ? !left : left;
      };
      root.addEventListener('dragstart', (e) => {
        const card = e.target.closest && e.target.closest('.sbd-card[draggable="true"]');
        if (!card) return;
        drag = { id: card.dataset.frame, group: card.closest('[data-group]')?.dataset.group };
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', drag.id); } catch (err) { /* restricted */ }
        requestAnimationFrame(() => card.classList.add('is-dragging'));
      });
      root.addEventListener('dragover', (e) => {
        if (!canWrite(ctx)) return;
        clearMarks();
        const card = e.target.closest && e.target.closest('.sbd-card[data-frame]');
        if (isFiles(e) && !drag) {
          e.preventDefault();
          if (card) { e.dataTransfer.dropEffect = 'copy'; card.classList.add('sbd-over'); return; }
          const zone = e.target.closest && e.target.closest('[data-sbd-zone], .sbd-toolbar');
          e.dataTransfer.dropEffect = zone ? 'copy' : 'none';
          if (zone) root.querySelector('[data-sbd-zone]')?.classList.add('sbd-over');
          return;
        }
        if (!drag || !card || card.dataset.frame === drag.id) return;
        if (grouped(ctx) && card.closest('[data-group]')?.dataset.group !== drag.group) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        card.classList.add(beforeOf(card, e) ? 'sbd-before' : 'sbd-after');
      });
      root.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !root.contains(e.relatedTarget)) clearMarks(); });
      root.addEventListener('drop', (e) => {
        if (!canWrite(ctx)) return;
        const card = e.target.closest && e.target.closest('.sbd-card[data-frame]');
        clearMarks();
        if (isFiles(e) && !drag) {
          e.preventDefault();
          if (card) return replaceImage(card.dataset.frame, e.dataTransfer.files);
          if (e.target.closest && e.target.closest('[data-sbd-zone], .sbd-toolbar')) uploadNew(e.dataTransfer.files);
          return;
        }
        if (!drag || !card || card.dataset.frame === drag.id) return;
        if (grouped(ctx) && card.closest('[data-group]')?.dataset.group !== drag.group) return;
        e.preventDefault();
        const before = beforeOf(card, e);
        const id = drag.id; drag = null;
        const from = d.frames.findIndex((f) => f.id === id);
        const [f] = d.frames.splice(from, 1);
        let to = d.frames.findIndex((x) => x.id === card.dataset.frame);
        if (!before) to += 1;
        d.frames.splice(to, 0, f);
        persistOrder();
        repaint();
      });
      root.addEventListener('dragend', () => { drag = null; clearMarks(); root.querySelectorAll('.is-dragging').forEach((x) => x.classList.remove('is-dragging')); });

      /* deep link: #p.<id>.storyboard.<frameId> */
      const fid = ctx.params[0];
      if (fid && findFrame(fid)) {
        const card = root.querySelector(`[data-frame="${CSS.escape(fid)}"]`);
        if (card) { card.scrollIntoView({ block: 'center' }); card.classList.add('is-hi'); }
        openFrame(fid);
      }
    },
  });
})();

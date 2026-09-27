/* Shot List (#p.<id>.shotlist)
   Shots grouped by scene, or in shooting order (by shoot day, from the stripboard). Cells save on change and patch
   the DOM in place, rows reorder inside a scene (drag the handle or use the arrows), and "Suggest shots" asks the AI
   for coverage that the user reviews before anything is written. */
(function () {
  const SIZES = ['EWS', 'WS', 'MWS', 'MS', 'MCU', 'CU', 'ECU', 'Insert', 'OTS', 'POV', 'Two-shot'];
  const SIZE_NAMES = { EWS: 'Extreme wide shot', WS: 'Wide shot', MWS: 'Medium wide shot', MS: 'Medium shot', MCU: 'Medium close-up', CU: 'Close-up', ECU: 'Extreme close-up', Insert: 'Insert', OTS: 'Over the shoulder', POV: 'Point of view', 'Two-shot': 'Two-shot' };
  const ANGLES = ['Eye level', 'High', 'Low', 'Overhead', 'Aerial', 'Dutch'];
  const MOVES = ['Static', 'Pan', 'Tilt', 'Dolly', 'Tracking', 'Crane', 'Drone', 'Handheld', 'Gimbal', 'Car mount', 'Push in', 'Pull out'];

  /* AI runs survive re-renders and navigation: scene id -> pending promise / finished result */
  const aiRuns = new Map();
  const aiReady = new Map();

  const fmtMin = (m) => { m = Math.round(Number(m) || 0); const h = Math.floor(m / 60), r = m % 60; return h ? `${h}h${r ? ' ' + r + 'm' : ''}` : `${r}m`; };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const letters = (i) => { let s = ''; let n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const letterIndex = (str) => { let n = 0; for (const c of str) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };
  const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const byNum = (a, b) => String(a.num).localeCompare(String(b.num), undefined, { numeric: true });
  const sceneOrder = (a, b) => ((a.sort || 0) - (b.sort || 0)) || byNum(a, b);
  const shotOrder = (a, b) => ((a.sort || 0) - (b.sort || 0)) || String(a.created_at || '').localeCompare(String(b.created_at || ''));
  const shotsOf = (d, sceneId) => d.shots.filter((s) => s.scene_id === sceneId).sort(shotOrder);
  const sortedDays = (d) => d.days.slice().sort((a, b) => a.day_no - b.day_no);
  const findScene = (d, id) => d.scenes.find((s) => s.id === id);
  const txt = (v, max = 500) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
  const int = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? n : null; };

  /* next shot codes for a scene: scene number + letter, continuing after the highest letter already used */
  function codeSeq(scene, list) {
    const num = String(scene.num).trim();
    const re = new RegExp('^' + reEsc(num) + '([A-Z]+)$', 'i');
    let max = list.length - 1;
    list.forEach((s) => { const m = re.exec(String(s.code || '').trim()); if (m) max = Math.max(max, letterIndex(m[1].toUpperCase())); });
    return (k) => `${num}${letters(max + 1 + k)}`;
  }

  /* ------------------------------------------------------------ pieces */
  function statsHtml(ctx, d) {
    const { ui } = ctx;
    const n = d.shots.length, done = d.shots.filter((s) => s.done).length;
    const setups = new Set(d.shots.filter((s) => s.setup != null).map((s) => s.scene_id + ':' + s.setup)).size;
    const total = d.shots.reduce((a, s) => a + (Number(s.est_minutes) || 0), 0);
    const pct = n ? Math.round((done / n) * 100) : 0;
    return `
      <div class="sl-stat">${ui.icon('list-video')}<div><span class="v num">${n}</span><span class="l">${n === 1 ? 'Shot' : 'Shots'}</span></div></div>
      <div class="sl-stat">${ui.icon('aperture')}<div><span class="v num">${setups}</span><span class="l">Camera setups</span></div></div>
      <div class="sl-stat">${ui.icon('timer')}<div><span class="v num">${fmtMin(total)}</span><span class="l">Est. shooting time${d.days.length ? ` over ${plural(d.days.length, 'shoot day')}` : ''}</span></div></div>
      <div class="sl-stat grow">${ui.icon('circle-check')}<div class="grow"><span class="v num">${pct}%</span><span class="l">${done} of ${n} done</span>${ui.bar(n ? done / n : 0)}</div></div>`;
  }

  function sceneMeta(d, sc, mode) {
    const list = shotsOf(d, sc.id);
    const setups = new Set(list.filter((s) => s.setup != null).map((s) => s.setup)).size;
    const est = list.reduce((a, s) => a + (Number(s.est_minutes) || 0), 0);
    const parts = [];
    if (mode === 'scene') {
      const day = d.days.find((x) => x.id === sc.shoot_day_id);
      parts.push(day ? `Day ${day.day_no}${day.date ? ' · ' + MPH.date(day.date, 'day') : ''}` : 'Unscheduled');
    }
    parts.push(plural(list.length, 'shot'));
    if (setups) parts.push(plural(setups, 'setup'));
    if (est) parts.push(fmtMin(est));
    return parts.join(' · ');
  }

  function dayMeta(d, day, scenes) {
    const ids = new Set(scenes.map((s) => s.id));
    const shots = d.shots.filter((s) => ids.has(s.scene_id));
    const est = shots.reduce((a, s) => a + (Number(s.est_minutes) || 0), 0);
    if (!scenes.length) return day ? 'No scenes scheduled on this day' : '';
    const parts = [];
    if (day && day.location) parts.push(day.location);
    if (day && day.crew_call) parts.push(`crew call ${MPH.time(day.crew_call)}`);
    parts.push(plural(scenes.length, 'scene'), plural(shots.length, 'shot'));
    if (est) parts.push(`${fmtMin(est)} on camera`);
    return parts.join(' · ');
  }

  /* header AI button; an empty, idle scene already shows the call to action in its empty row */
  function aiBtn(ctx, sc, shotCount) {
    const { ui } = ctx;
    if (aiRuns.has(sc.id)) return `<button class="btn btn-xs btn-outline" data-ai-scene disabled>${ui.spinner()}Suggesting…</button>`;
    if (aiReady.has(sc.id)) {
      const n = ((aiReady.get(sc.id) || {}).shots || []).length;
      return `<button class="btn btn-xs btn-primary" data-ai-scene>${ui.icon('sparkles')}Review ${plural(n, 'suggestion')}</button>`;
    }
    return shotCount ? `<button class="btn btn-xs btn-outline" data-ai-scene>${ui.icon('sparkles')}Suggest shots</button>` : '';
  }

  function cols(ctx) { return ctx.canEdit ? 12 : 10; }

  function rowHtml(ctx, s, i, count) {
    const { ui, esc } = ctx;
    const ed = ctx.canEdit;
    const code = s.code || '';
    if (!ed) {
      return `
        <tr class="sl-row ${s.done ? 'is-done' : ''}" data-shot="${s.id}" data-scene="${s.scene_id}">
          <td class="sl-check-c"><input type="checkbox" class="sl-check" ${s.done ? 'checked' : ''} disabled aria-label="Shot ${esc(code)} done"></td>
          <td class="sl-c-code"><span class="sl-code mono">${esc(code) || '<span class="faint">—</span>'}</span>${s.ai ? `<span class="sl-ai-dot" title="Suggested by AI">${ui.icon('sparkles')}</span>` : ''}</td>
          <td class="sl-c-size">${s.size ? `<span class="sl-size" title="${esc(SIZE_NAMES[s.size] || s.size)}">${esc(s.size)}</span>` : ''}</td>
          <td class="sl-c-angle small">${esc(s.angle || '')}</td>
          <td class="sl-c-move small">${esc(s.movement || '')}</td>
          <td class="sl-c-lens small num">${esc(s.lens || '')}</td>
          <td class="sl-c-desc"><span class="sl-desc" dir="auto">${esc(s.description || '')}</span></td>
          <td class="sl-c-subject small muted" dir="auto">${esc(s.subject || '')}</td>
          <td class="sl-c-setup r">${s.setup != null ? `<span class="sl-setup num">${esc(s.setup)}</span>` : ''}</td>
          <td class="sl-c-est r num small">${s.est_minutes != null ? fmtMin(s.est_minutes) : ''}</td>
        </tr>`;
    }
    const opts = (list, val) => {
      const all = val && !list.includes(val) ? [val, ...list] : list;
      return `<option value=""></option>${all.map((v) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(v)}</option>`).join('')}`;
    };
    const label = `shot ${code || i + 1}`;
    return `
      <tr class="sl-row ${s.done ? 'is-done' : ''}" data-shot="${s.id}" data-scene="${s.scene_id}">
        <td class="sl-grip-c"><span class="sl-grip" data-grip title="Drag to reorder">${ui.icon('grip-vertical')}</span></td>
        <td class="sl-check-c"><input type="checkbox" class="sl-check" data-done ${s.done ? 'checked' : ''} aria-label="Mark ${esc(label)} as done"></td>
        <td class="sl-c-code"><div class="sl-code-wrap"><input class="cell-input mono sl-code-in" data-f="code" value="${esc(code)}" maxlength="12" aria-label="Shot code">${s.ai ? `<span class="sl-ai-dot" title="Suggested by AI">${ui.icon('sparkles')}</span>` : ''}</div></td>
        <td class="sl-c-size"><select class="cell-input" data-f="size" aria-label="Shot size for ${esc(label)}" title="${esc(SIZE_NAMES[s.size] || 'Shot size')}">${opts(SIZES, s.size)}</select></td>
        <td class="sl-c-angle"><select class="cell-input" data-f="angle" aria-label="Camera angle for ${esc(label)}">${opts(ANGLES, s.angle)}</select></td>
        <td class="sl-c-move"><select class="cell-input" data-f="movement" aria-label="Camera movement for ${esc(label)}">${opts(MOVES, s.movement)}</select></td>
        <td class="sl-c-lens"><input class="cell-input" data-f="lens" value="${esc(s.lens || '')}" placeholder="35mm" maxlength="40" aria-label="Lens for ${esc(label)}"></td>
        <td class="sl-c-desc"><textarea class="cell-input sl-desc-in" data-f="description" rows="1" dir="auto" placeholder="What the shot shows" aria-label="Description of ${esc(label)}">${esc(s.description || '')}</textarea></td>
        <td class="sl-c-subject"><input class="cell-input" data-f="subject" value="${esc(s.subject || '')}" dir="auto" placeholder="Who or what" aria-label="Subject of ${esc(label)}"></td>
        <td class="sl-c-setup"><input class="cell-input num" data-f="setup" type="number" min="1" step="1" inputmode="numeric" value="${s.setup ?? ''}" aria-label="Setup number for ${esc(label)}"></td>
        <td class="sl-c-est"><input class="cell-input num" data-f="est_minutes" type="number" min="0" step="5" inputmode="numeric" value="${s.est_minutes ?? ''}" aria-label="Estimated minutes for ${esc(label)}"></td>
        <td class="sl-c-acts"><div class="sl-acts">
          <span class="sl-updown">
            <button class="btn btn-ghost btn-xs btn-icon" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(label)} up" title="Move up">${ui.icon('chevron-up')}</button>
            <button class="btn btn-ghost btn-xs btn-icon" data-move="1" ${i === count - 1 ? 'disabled' : ''} aria-label="Move ${esc(label)} down" title="Move down">${ui.icon('chevron-down')}</button>
          </span>
          <button class="btn btn-ghost btn-xs btn-icon sl-del" data-del aria-label="Delete ${esc(label)}" title="Delete shot">${ui.icon('trash-2')}</button>
        </div></td>
      </tr>`;
  }

  function groupHtml(ctx, d, sc, mode) {
    const { ui, esc } = ctx;
    const ed = ctx.canEdit, n = cols(ctx);
    const list = shotsOf(d, sc.id);
    const done = list.filter((s) => s.done).length;
    return `
      <tbody class="sl-group" data-scene="${sc.id}">
        <tr class="group sl-group-h"><td colspan="${n}"><div class="row sl-gh">
          <span class="sl-scn mono">Sc. ${esc(sc.num)}</span>
          <span class="strong sl-heading" dir="auto">${esc(sc.heading || sc.location || 'Untitled scene')}</span>
          <span class="tiny faint" data-sl-meta>${esc(sceneMeta(d, sc, mode))}</span>
          <span class="spacer"></span>
          <span class="sl-prog" data-sl-prog ${list.length ? '' : 'hidden'}><span class="tiny muted num" data-sl-count>${done}/${list.length}</span><span class="sl-mini" data-sl-bar>${ui.bar(list.length ? done / list.length : 0)}</span></span>
          ${ed && list.length > 1 ? `<button class="btn btn-xs btn-ghost" data-renumber title="Reset codes to ${esc(sc.num)}A, ${esc(sc.num)}B… in the current order">${ui.icon('list-ordered')}Renumber</button>` : ''}
          ${ed ? `<span data-ai-slot>${aiBtn(ctx, sc, list.length)}</span>` : ''}
        </div></td></tr>
        ${list.map((s, i) => rowHtml(ctx, s, i, list.length)).join('')}
        ${!list.length ? `<tr class="sl-empty-row"><td colspan="${n}"><div class="row wrap">
            <span class="small muted">No shots in this scene yet.</span>
            ${ed ? `<button class="btn btn-xs btn-outline" data-ai-scene>${ui.icon('sparkles')}Suggest shots with AI</button><button class="btn btn-xs btn-ghost" data-add-shot>${ui.icon('plus')}Add a shot</button>` : ''}
          </div></td></tr>` : ''}
        ${ed && list.length ? `<tr class="sl-add"><td colspan="${n}"><button class="btn btn-ghost btn-xs" data-add-shot>${ui.icon('plus')}Add shot to Sc. ${esc(sc.num)}</button></td></tr>` : ''}
      </tbody>`;
  }

  function dayHead(ctx, d, day, scenes) {
    const { ui, esc } = ctx;
    const n = cols(ctx);
    if (!day) {
      return `
        <tbody class="sl-day" data-day="none"><tr class="sl-day-h is-none"><td colspan="${n}"><div class="row wrap">
          ${ui.icon('archive')}<span class="strong">Unscheduled</span>
          <span class="tiny faint" data-sl-daymeta>${esc(dayMeta(d, null, scenes))}</span>
          <span class="spacer"></span><a class="btn btn-xs btn-ghost" href="#p.${ctx.production.id}.stripboard">${ui.icon('rows-3')}Schedule on the stripboard</a>
        </div></td></tr></tbody>`;
    }
    return `
      <tbody class="sl-day" data-day="${day.id}"><tr class="sl-day-h"><td colspan="${n}"><div class="row wrap">
        <span class="sl-day-tag">Day ${esc(day.day_no)}</span>
        <span class="strong">${day.date ? MPH.date(day.date, 'long') : 'Date not set'}</span>
        <span class="tiny faint" data-sl-daymeta>${esc(dayMeta(d, day, scenes))}</span>
      </div></td></tr></tbody>`;
  }

  function orderedGroups(d) {
    const scenes = d.scenes.slice().sort(sceneOrder);
    const days = sortedDays(d);
    const dayIds = new Set(days.map((x) => x.id));
    const out = days.map((day) => ({
      day,
      scenes: scenes.filter((s) => s.shoot_day_id === day.id).sort((a, b) => ((a.day_sort || 0) - (b.day_sort || 0)) || sceneOrder(a, b)),
    }));
    const un = scenes.filter((s) => !s.shoot_day_id || !dayIds.has(s.shoot_day_id));
    if (un.length) out.push({ day: null, scenes: un });
    return out;
  }

  function bodyHtml(ctx, d, mode) {
    if (mode === 'scene') return d.scenes.slice().sort(sceneOrder).map((sc) => groupHtml(ctx, d, sc, mode)).join('');
    return orderedGroups(d).map((g) => dayHead(ctx, d, g.day, g.scenes) + g.scenes.map((sc) => groupHtml(ctx, d, sc, mode)).join('')).join('');
  }

  function renderPage(ctx, d) {
    const { ui, esc } = ctx;
    const p = ctx.production;
    const mode = ctx.state.slMode === 'order' ? 'order' : 'scene';
    const ed = ctx.canEdit;

    if (!d.scenes.length) {
      return `
        <div class="page sl-page">
          ${ui.pageHead({ title: ctx.t('Shot List'), sub: esc(p.title) })}
          ${ui.panel({ body: ui.empty('list-video', 'No scenes to plan shots for yet',
            'The shot list is built scene by scene. Add the script and run the AI Breakdown first; every scene it finds appears here, ready for coverage.',
            `<a class="btn btn-primary" href="#p.${p.id}.breakdown">${ui.icon('scan-text')}Open AI Breakdown</a>`) })}
        </div>`;
    }

    const head = ui.pageHead({
      title: ctx.t('Shot List'),
      sub: `${plural(d.scenes.length, 'scene')}${ed ? ' · changes save as you go' : ''}`,
      actions: `
        <div class="seg" role="group" aria-label="Order">
          <button class="${mode === 'scene' ? 'on' : ''}" data-mode="scene" aria-pressed="${mode === 'scene'}">${ui.icon('clapperboard')}By scene</button>
          <button class="${mode === 'order' ? 'on' : ''}" data-mode="order" aria-pressed="${mode === 'order'}">${ui.icon('list-ordered')}Shooting order</button>
        </div>`,
    });

    const intro = `
      <div class="callout" data-sl-intro ${d.shots.length ? 'hidden' : ''}>${ui.icon('sparkles')}
        <div class="stack tight" style="gap:2px">
          <span class="strong small">Start the shot list</span>
          <span class="small">${ed ? 'Use <strong>Suggest shots</strong> on a scene and the AI proposes coverage from the script and breakdown. You pick what to keep; nothing is added until you do. Or add shots by hand.' : 'No shots have been planned yet. Producers and heads of department can build the shot list.'}</span>
        </div>
      </div>`;

    const noDays = mode === 'order' && !d.days.length
      ? `<div class="callout info">${ui.icon('calendar-days')}<span class="small">No shoot days yet, so every scene is unscheduled. Build the schedule on the <a class="accent" href="#p.${p.id}.stripboard">Stripboard</a> and this view follows it.</span></div>` : '';

    const th = `<tr>
      ${ed ? '<th class="sl-grip-c"><span class="sl-sr">Reorder</span></th>' : ''}
      <th class="sl-check-c"><span class="sl-sr">Done</span></th>
      <th class="sl-c-code">Shot</th><th class="sl-c-size">Size</th><th class="sl-c-angle">Angle</th><th class="sl-c-move">Movement</th>
      <th class="sl-c-lens">Lens</th><th class="sl-c-desc">Description</th><th class="sl-c-subject">Subject</th>
      <th class="sl-c-setup r">Setup</th><th class="sl-c-est r">Est. min</th>
      ${ed ? '<th class="sl-c-acts"><span class="sl-sr">Actions</span></th>' : ''}
    </tr>`;

    return `
      <div class="page full sl-page">
        ${head}
        <div class="sl-stats" data-sl-stats>${statsHtml(ctx, d)}</div>
        ${intro}${noDays}
        <div class="panel flush">
          <div class="table-wrap">
            <table class="table sl-table ${ed ? 'is-edit' : ''}">
              <thead>${th}</thead>
              ${bodyHtml(ctx, d, mode)}
            </table>
          </div>
        </div>
        ${ed ? `<p class="tiny faint sl-hint">${ui.icon('info')}Drag the handle or use the arrows to reorder shots inside a scene. Enter saves a cell, Esc undoes the edit. Codes stay put when you reorder; use Renumber to reset them.</p>` : ''}
      </div>`;
  }

  /* ------------------------------------------------------------ AI coverage */
  function openAi(ctx, d, sc, hooks) {
    const { ui, esc } = ctx;
    const el = ctx.modal(ctx.frame({
      title: `Suggest shots for Sc. ${esc(sc.num)}`,
      sub: esc(sc.heading || ''),
      body: '<div class="stack" data-ai-body></div>',
      foot: '<div class="row sl-ai-foot" data-ai-foot></div>',
    }), { wide: true });
    const body = el.querySelector('[data-ai-body]');
    const foot = el.querySelector('[data-ai-foot]');
    const paint = (b, f) => { body.innerHTML = b; foot.innerHTML = f; MPH.icons(); };

    const running = () => paint(
      `<div class="sl-ai-running"><span class="spin"></span><div class="stack tight" style="gap:2px"><span class="strong">Planning coverage for Sc. ${esc(sc.num)}…</span><span class="small muted">The AI reads the scene and its confirmed elements, then groups shots into camera setups. This usually takes 20 to 40 seconds. You can close this window; the suggestions will wait for you.</span></div></div>`,
      '<button class="btn btn-ghost" data-close>Close</button>');

    const failed = (err) => paint(ui.errorBox(err.message || String(err)),
      `<button class="btn btn-ghost" data-close>Close</button><button class="btn btn-primary" data-ai-retry>${ui.icon('rotate-ccw')}Try again</button>`);

    const preview = (out) => {
      const shots = Array.isArray(out && out.shots) ? out.shots : [];
      if (!shots.length) {
        return paint(ui.empty('sparkles', 'No shots proposed', 'The AI didn’t return any shots for this scene. Check the scene has script text in the breakdown, then try again.'),
          `<button class="btn btn-ghost" data-ai-discard>Discard</button><button class="btn btn-primary" data-ai-retry>${ui.icon('rotate-ccw')}Try again</button>`);
      }
      const existing = shotsOf(d, sc.id);
      const setupBase = existing.reduce((m, s) => Math.max(m, Number(s.setup) || 0), 0);
      const code = codeSeq(sc, existing);
      paint(`
        ${out.notes ? `<div class="callout">${ui.icon('sparkles')}<span class="small" dir="auto">${esc(out.notes)}</span></div>` : ''}
        <p class="small muted">${plural(shots.length, 'shot')} proposed. Untick any you don’t want. Codes continue from ${esc(code(0))}${setupBase ? ` and setups are numbered after the scene’s existing setup ${setupBase}` : ''}. Everything stays editable after you add it.</p>
        <div class="table-wrap sl-ai-wrap"><table class="table sl-ai-table">
          <thead><tr><th class="sl-check-c"><input type="checkbox" class="sl-check" data-ai-all checked aria-label="Select all shots"></th><th>Shot</th><th>Size</th><th>Angle</th><th>Movement</th><th>Lens</th><th>Description</th><th>Subject</th><th class="r">Setup</th><th class="r">Est.</th></tr></thead>
          <tbody>${shots.map((s, i) => `
            <tr data-ai-row="${i}">
              <td class="sl-check-c"><input type="checkbox" class="sl-check" data-ai-pick="${i}" checked aria-label="Add shot ${i + 1}"></td>
              <td class="mono strong nowrap" data-ai-code="${i}"></td>
              <td>${s.size ? `<span class="sl-size" title="${esc(SIZE_NAMES[s.size] || s.size)}">${esc(s.size)}</span>` : ''}</td>
              <td class="small nowrap">${esc(s.angle || '')}</td>
              <td class="small nowrap">${esc(s.movement || '')}</td>
              <td class="small nowrap num">${esc(s.lens || '')}</td>
              <td class="small sl-ai-desc" dir="auto">${esc(s.description || '')}</td>
              <td class="small muted" dir="auto">${esc(s.subject || '')}</td>
              <td class="r num small">${int(s.setup) != null ? setupBase + int(s.setup) : ''}</td>
              <td class="r num small nowrap">${int(s.est_minutes) != null ? fmtMin(int(s.est_minutes)) : ''}</td>
            </tr>`).join('')}</tbody>
        </table></div>`,
      `<button class="btn btn-ghost" data-ai-discard>Discard suggestions</button><span class="spacer"></span><button class="btn btn-ghost" data-close>Decide later</button><button class="btn btn-primary" data-ai-add>${ui.icon('plus')}<span data-ai-add-label></span></button>`);

      const sync = () => {
        const picks = [...body.querySelectorAll('[data-ai-pick]')];
        let k = 0;
        picks.forEach((cb) => {
          const i = cb.dataset.aiPick;
          body.querySelector(`[data-ai-code="${i}"]`).textContent = cb.checked ? code(k++) : '—';
          cb.closest('tr').classList.toggle('is-off', !cb.checked);
        });
        const all = body.querySelector('[data-ai-all]');
        all.checked = k === picks.length; all.indeterminate = k > 0 && k < picks.length;
        foot.querySelector('[data-ai-add-label]').textContent = k ? `Add ${plural(k, 'shot')}` : 'Select shots to add';
        foot.querySelector('[data-ai-add]').disabled = !k;
      };
      body.onchange = (e) => {
        if (e.target.matches('[data-ai-all]')) body.querySelectorAll('[data-ai-pick]').forEach((cb) => { cb.checked = e.target.checked; });
        sync();
      };
      sync();

      foot.querySelector('[data-ai-add]').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const picks = [...body.querySelectorAll('[data-ai-pick]:checked')].map((cb) => shots[+cb.dataset.aiPick]);
        if (!picks.length) return;
        btn.disabled = true; btn.innerHTML = `${ui.spinner()}Adding…`;
        const now = shotsOf(d, sc.id);
        const next = codeSeq(sc, now);
        const base = now.reduce((m, s) => Math.max(m, (s.sort || 0) + 1), 0);
        const setupNow = now.reduce((m, s) => Math.max(m, Number(s.setup) || 0), 0);
        const rows = picks.map((s, k) => ({
          production_id: ctx.production.id, scene_id: sc.id, code: next(k),
          size: txt(s.size, 20), angle: txt(s.angle, 40), movement: txt(s.movement, 40), lens: txt(s.lens, 40),
          description: txt(s.description, 2000), subject: txt(s.subject, 200),
          setup: int(s.setup) != null ? setupNow + int(s.setup) : null,
          est_minutes: int(s.est_minutes) ?? 15, ai: true, sort: base + k,
        }));
        try {
          const ins = ctx.api.must(await ctx.sb.from('shots').insert(rows).select());
          d.shots.push(...ins);
          aiReady.delete(sc.id);
          ctx.closeOverlay();
          hooks.refreshScene(sc.id);
          ctx.toast(`Added ${plural(ins.length, 'shot')} to Sc. ${sc.num}`, 'sparkles');
        } catch (ex) {
          btn.disabled = false; btn.innerHTML = `${ui.icon('plus')}Try again`; MPH.icons();
          ctx.toastError(ex);
        }
      });
    };

    const start = () => {
      running();
      let run = aiRuns.get(sc.id);
      if (!run) {
        run = ctx.api.ai('shots', { production_id: ctx.production.id, scene_id: sc.id });
        aiRuns.set(sc.id, run);
        hooks.aiState(sc);
        run.then((out) => { aiReady.set(sc.id, out); }, () => {}).finally(() => { aiRuns.delete(sc.id); hooks.aiState(sc); });
      }
      run.then((out) => {
        if (el.isConnected) preview(out);
        else ctx.toast(`Shot suggestions for Sc. ${sc.num} are ready to review`, 'sparkles');
      }, (err) => {
        if (el.isConnected) failed(err);
        else ctx.toastError(new Error(`Shot suggestions for Sc. ${sc.num} failed: ${err.message || err}`));
      });
    };

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-ai-retry]')) { aiReady.delete(sc.id); start(); }
      else if (e.target.closest('[data-ai-discard]')) { aiReady.delete(sc.id); hooks.aiState(sc); ctx.closeOverlay(); }
    });

    if (aiReady.has(sc.id)) preview(aiReady.get(sc.id)); else start();
  }

  /* ------------------------------------------------------------ view */
  MPH.view('shotlist', {
    async load(ctx) {
      const pid = ctx.production.id;
      const [scenes, shots, days] = await Promise.all([
        ctx.sb.from('active_scenes').select('id, num, heading, location, sort, shoot_day_id, day_sort').eq('production_id', pid),
        ctx.sb.from('shots').select('*').eq('production_id', pid),
        ctx.sb.from('shoot_days').select('id, day_no, date, location, crew_call').eq('production_id', pid),
      ]);
      const d = { scenes: ctx.api.must(scenes), shots: ctx.api.must(shots), days: ctx.api.must(days) };
      const ids = new Set(d.scenes.map((s) => s.id));
      d.shots = d.shots.filter((s) => ids.has(s.scene_id));
      return d;
    },

    render: renderPage,

    mount(root, ctx, d) {
      if (!d.scenes.length) return;
      const { ui, esc } = ctx;
      const mode = () => (ctx.state.slMode === 'order' ? 'order' : 'scene');
      let queue = Promise.resolve();
      const enqueue = (fn) => { queue = queue.then(fn, fn); return queue; };

      const autosize = (ta) => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
      const needsAutosize = !(window.CSS && CSS.supports && CSS.supports('field-sizing', 'content'));
      const sizeAll = (scope) => { if (needsAutosize) scope.querySelectorAll('.sl-desc-in').forEach(autosize); };

      /* group rows pin their contents to the visible width of the scrolling table (see --slw in the CSS) */
      let ro = null;
      const watchWidth = () => {
        const wrap = root.querySelector('.table-wrap');
        if (ro) ro.disconnect();
        if (!wrap || !window.ResizeObserver) return;
        let last = 0;
        ro = new ResizeObserver(() => {
          if (!root.isConnected) { ro.disconnect(); return; }
          const w = wrap.clientWidth;
          if (w === last) return; // height changes (rows wrapping) don't matter
          last = w;
          requestAnimationFrame(() => wrap.style.setProperty('--slw', w + 'px'));
        });
        ro.observe(wrap);
      };

      const repaint = () => { root.innerHTML = renderPage(ctx, d); MPH.icons(); sizeAll(root); watchWidth(); };

      const updateSummary = () => {
        const st = root.querySelector('[data-sl-stats]');
        if (st) st.innerHTML = statsHtml(ctx, d);
        const intro = root.querySelector('[data-sl-intro]');
        if (intro) intro.hidden = d.shots.length > 0;
        d.scenes.forEach((sc) => {
          const tb = root.querySelector(`tbody.sl-group[data-scene="${sc.id}"]`);
          if (!tb) return;
          const list = shotsOf(d, sc.id);
          const done = list.filter((s) => s.done).length;
          tb.querySelector('[data-sl-meta]').textContent = sceneMeta(d, sc, mode());
          tb.querySelector('[data-sl-prog]').hidden = !list.length;
          tb.querySelector('[data-sl-count]').textContent = `${done}/${list.length}`;
          tb.querySelector('[data-sl-bar]').innerHTML = ui.bar(list.length ? done / list.length : 0);
        });
        if (mode() === 'order') {
          orderedGroups(d).forEach((g) => {
            const m = root.querySelector(`tbody.sl-day[data-day="${g.day ? g.day.id : 'none'}"] [data-sl-daymeta]`);
            if (m) m.textContent = dayMeta(d, g.day, g.scenes);
          });
        }
        MPH.icons();
      };

      const refreshScene = (sceneId) => {
        const sc = findScene(d, sceneId);
        const tb = root.querySelector(`tbody.sl-group[data-scene="${sceneId}"]`);
        if (!sc || !tb) return repaint();
        const tmp = document.createElement('table');
        tmp.innerHTML = groupHtml(ctx, d, sc, mode());
        const fresh = tmp.querySelector('tbody');
        tb.replaceWith(fresh);
        MPH.icons();
        sizeAll(fresh);
        updateSummary();
      };

      /* the AI button of a scene, wherever the current view is (runs outlive re-renders) */
      const aiState = (sc) => {
        const slot = document.querySelector(`#view tbody.sl-group[data-scene="${sc.id}"] [data-ai-slot]`);
        if (slot) { slot.innerHTML = aiBtn(ctx, sc, shotsOf(d, sc.id).length); MPH.icons(); }
      };
      const hooks = { refreshScene, aiState };

      const flash = (el) => { el.classList.remove('sl-saved'); void el.offsetWidth; el.classList.add('sl-saved'); };

      /* two-step confirm on destructive buttons */
      const armed = (btn, label) => {
        if (btn.dataset.armed) return true;
        btn.dataset.armed = '1';
        const html = btn.innerHTML;
        const wrap = btn.closest('.sl-acts');
        btn.classList.add('is-armed'); if (wrap) wrap.classList.add('is-armed');
        btn.textContent = label;
        setTimeout(() => {
          if (!btn.isConnected) return;
          delete btn.dataset.armed; btn.classList.remove('is-armed'); if (wrap) wrap.classList.remove('is-armed');
          btn.innerHTML = html;
        }, 3000);
        return false;
      };

      const persistOrder = (list) => {
        const changed = [];
        list.forEach((s, i) => { if ((s.sort || 0) !== i || s.sort == null) { s.sort = i; changed.push(s); } });
        if (!changed.length) return;
        enqueue(async () => {
          const res = await Promise.all(changed.map((s) => ctx.sb.from('shots').update({ sort: s.sort }).eq('id', s.id)));
          const bad = res.find((r) => r.error);
          if (bad) { ctx.toastError(new Error(`The new order didn’t save: ${bad.error.message}`)); ctx.reload(); }
        });
      };

      const moveShot = (id, toIndex) => {
        const s = d.shots.find((x) => x.id === id);
        if (!s) return;
        const list = shotsOf(d, s.scene_id);
        const from = list.indexOf(s);
        if (toIndex < 0 || toIndex >= list.length || toIndex === from) return;
        list.splice(from, 1); list.splice(toIndex, 0, s);
        persistOrder(list);
        refreshScene(s.scene_id);
      };

      const addShot = async (sceneId, btn) => {
        const sc = findScene(d, sceneId);
        const list = shotsOf(d, sceneId);
        const last = list[list.length - 1];
        const row = {
          production_id: ctx.production.id, scene_id: sceneId, code: codeSeq(sc, list)(0),
          angle: 'Eye level', movement: 'Static', setup: last ? (last.setup ?? 1) : 1, est_minutes: 15,
          sort: list.reduce((m, x) => Math.max(m, (x.sort || 0) + 1), 0),
        };
        if (btn) btn.disabled = true;
        try {
          const ins = ctx.api.must(await ctx.sb.from('shots').insert(row).select().single());
          d.shots.push(ins);
          refreshScene(sceneId);
          const ta = root.querySelector(`tr[data-shot="${ins.id}"] [data-f="description"]`);
          if (ta) ta.focus();
        } catch (ex) { ctx.toastError(ex); if (btn && btn.isConnected) btn.disabled = false; }
      };

      const renumber = async (sceneId) => {
        const sc = findScene(d, sceneId);
        const list = shotsOf(d, sceneId);
        const changed = [];
        list.forEach((s, i) => { const c = `${String(sc.num).trim()}${letters(i)}`; if (s.code !== c) { s.code = c; changed.push(s); } });
        if (!changed.length) return ctx.toast('Codes are already in order', 'list-ordered');
        refreshScene(sceneId);
        enqueue(async () => {
          const res = await Promise.all(changed.map((s) => ctx.sb.from('shots').update({ code: s.code }).eq('id', s.id)));
          const bad = res.find((r) => r.error);
          if (bad) { ctx.toastError(new Error(bad.error.message)); ctx.reload(); } else ctx.toast(`Sc. ${sc.num} renumbered`, 'list-ordered');
        });
      };

      const delShot = async (id) => {
        const s = d.shots.find((x) => x.id === id);
        if (!s) return;
        const idx = d.shots.indexOf(s);
        d.shots.splice(idx, 1);
        refreshScene(s.scene_id);
        try {
          ctx.api.must(await ctx.sb.from('shots').delete().eq('id', id));
          ctx.toast(s.code ? `Shot ${s.code} deleted` : 'Shot deleted', 'trash-2');
        } catch (ex) { d.shots.splice(idx, 0, s); refreshScene(s.scene_id); ctx.toastError(ex); }
      };

      /* ---------- clicks */
      root.addEventListener('click', (e) => {
        const t = e.target;
        const m = t.closest('[data-mode]');
        if (m) { if (ctx.state.slMode !== m.dataset.mode) { ctx.state.slMode = m.dataset.mode; repaint(); } return; }
        if (!ctx.canEdit) return;
        const group = t.closest('tbody.sl-group');
        const sceneId = group && group.dataset.scene;
        let b;
        if ((b = t.closest('[data-ai-scene]'))) { if (!b.disabled) openAi(ctx, d, findScene(d, sceneId), hooks); return; }
        if ((b = t.closest('[data-add-shot]'))) return addShot(sceneId, b);
        if ((b = t.closest('[data-renumber]'))) { if (armed(b, 'Click again to renumber')) renumber(sceneId); return; }
        const tr = t.closest('tr[data-shot]');
        if (!tr) return;
        if ((b = t.closest('[data-move]'))) {
          const list = shotsOf(d, tr.dataset.scene);
          const from = list.findIndex((s) => s.id === tr.dataset.shot);
          const dir = +b.dataset.move;
          moveShot(tr.dataset.shot, from + dir);
          const again = root.querySelector(`tr[data-shot="${tr.dataset.shot}"] [data-move="${dir}"]`);
          const other = root.querySelector(`tr[data-shot="${tr.dataset.shot}"] [data-move="${-dir}"]`);
          if (again && !again.disabled) again.focus(); else if (other) other.focus();
          return;
        }
        if ((b = t.closest('[data-del]'))) { if (armed(b, 'Delete?')) delShot(tr.dataset.shot); }
      });

      /* ---------- inline edits: save on change, patch the DOM */
      root.addEventListener('change', async (e) => {
        const el = e.target;
        const tr = el.closest('tr[data-shot]');
        if (!tr || !ctx.canEdit) return;
        const s = d.shots.find((x) => x.id === tr.dataset.shot);
        if (!s) return;
        if (el.matches('[data-done]')) {
          const prev = s.done;
          s.done = el.checked; tr.classList.toggle('is-done', s.done); updateSummary();
          try { ctx.api.must(await ctx.sb.from('shots').update({ done: s.done }).eq('id', s.id)); }
          catch (ex) { s.done = prev; el.checked = prev; tr.classList.toggle('is-done', prev); updateSummary(); ctx.toastError(ex); }
          return;
        }
        const f = el.dataset.f;
        if (!f) return;
        let v;
        if (f === 'setup' || f === 'est_minutes') {
          v = el.value.trim() === '' ? null : int(el.value);
          el.value = v ?? '';
        } else v = txt(el.value, f === 'description' ? 2000 : 200);
        if ((s[f] ?? null) === v) return;
        const prev = s[f];
        s[f] = v;
        if (f === 'size') el.title = SIZE_NAMES[v] || 'Shot size';
        if (f === 'setup' || f === 'est_minutes') updateSummary();
        try {
          ctx.api.must(await ctx.sb.from('shots').update({ [f]: v }).eq('id', s.id));
          flash(el);
        } catch (ex) {
          s[f] = prev; el.value = prev ?? '';
          if (f === 'setup' || f === 'est_minutes') updateSummary();
          ctx.toastError(ex);
        }
      });

      root.addEventListener('focusin', (e) => { if (e.target.matches('.cell-input')) e.target.dataset.orig = e.target.value; });
      root.addEventListener('keydown', (e) => {
        const el = e.target;
        if (!el.matches || !el.matches('input.cell-input, textarea.cell-input')) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); el.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (el.dataset.orig != null) el.value = el.dataset.orig; if (needsAutosize && el.tagName === 'TEXTAREA') autosize(el); el.blur(); }
      });
      if (needsAutosize) root.addEventListener('input', (e) => { if (e.target.matches('.sl-desc-in')) autosize(e.target); });

      /* ---------- drag to reorder inside a scene (only from the handle, so text selection in cells still works) */
      let drag = null;
      const clearMarks = () => root.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      root.addEventListener('mousedown', (e) => {
        const g = e.target.closest('[data-grip]');
        if (g) g.closest('tr').draggable = true;
      });
      root.addEventListener('mouseup', () => { if (!drag) root.querySelectorAll('tr[draggable="true"]').forEach((x) => { x.draggable = false; }); });
      root.addEventListener('dragstart', (e) => {
        const tr = e.target.closest && e.target.closest('tr.sl-row');
        if (!tr || !tr.draggable) return;
        drag = { id: tr.dataset.shot, scene: tr.dataset.scene };
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', drag.id); } catch (err) { /* restricted */ }
        requestAnimationFrame(() => tr.classList.add('is-dragging'));
      });
      root.addEventListener('dragover', (e) => {
        if (!drag) return;
        const tr = e.target.closest && e.target.closest('tr.sl-row');
        clearMarks();
        if (!tr || tr.dataset.scene !== drag.scene || tr.dataset.shot === drag.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = tr.getBoundingClientRect();
        tr.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
      });
      root.addEventListener('drop', (e) => {
        if (!drag) return;
        const tr = e.target.closest && e.target.closest('tr.sl-row');
        if (!tr || tr.dataset.scene !== drag.scene || tr.dataset.shot === drag.id) return;
        e.preventDefault();
        const before = e.clientY < tr.getBoundingClientRect().top + tr.getBoundingClientRect().height / 2;
        const list = shotsOf(d, drag.scene).filter((s) => s.id !== drag.id);
        let to = list.findIndex((s) => s.id === tr.dataset.shot);
        if (!before) to += 1;
        const id = drag.id;
        drag = null;
        moveShot(id, to);
      });
      root.addEventListener('dragend', () => {
        drag = null; clearMarks();
        root.querySelectorAll('.is-dragging').forEach((x) => x.classList.remove('is-dragging'));
        root.querySelectorAll('tr[draggable="true"]').forEach((x) => { x.draggable = false; });
      });

      sizeAll(root);
      watchWidth();
    },
  });
})();

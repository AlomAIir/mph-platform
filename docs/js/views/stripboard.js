/* Stripboard (#p.<id>.stripboard)
   Shoot days with colour-coded scene strips (INT/EXT × day/night, dawn/dusk/golden hour apricot), "End of Day" breaks
   with totals and a call sheet link, and an Unscheduled boneyard. Scenes move by native drag and drop, or by the
   "Move to…" menu on each strip (keyboard and touch). Writes scenes.shoot_day_id + scenes.day_sort.
   "Suggest schedule" asks the AI for a plan that the user previews before it is applied. */
(function () {
  const KINDS = [['int-day', 'INT Day'], ['ext-day', 'EXT Day'], ['int-night', 'INT Night'], ['ext-night', 'EXT Night'], ['dawn', 'Dawn, dusk, golden hour']];
  const LONG_DAY = 12 * 60;

  /* AI runs survive re-renders: production id -> pending promise / finished result */
  const aiRuns = new Map();
  const aiReady = new Map();

  const fmtMin = (m) => { m = Math.round(Number(m) || 0); const h = Math.floor(m / 60), r = m % 60; return h ? `${h}h${r ? ' ' + String(r).padStart(2, '0') + 'm' : ''}` : `${r}m`; };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const pagesLabel = (n) => `${MPH.eighths(n)} ${n > 8 ? 'pages' : 'page'}`;
  const est = (s) => (s.est_minutes == null ? 60 : Number(s.est_minutes) || 0);
  const ieOf = (s) => s.int_ext || (/^\s*EXT/i.test(s.heading || '') ? 'EXT' : /^\s*INT/i.test(s.heading || '') ? 'INT' : '');
  const kindOf = (s) => (/dawn|dusk|golden|sunrise|sunset|magic/i.test(s.day_night || '') ? 'dawn'
    : `${/EXT/i.test(ieOf(s)) ? 'ext' : 'int'}-${/night/i.test(s.day_night || '') ? 'night' : 'day'}`);
  const setName = (s) => {
    let h = String(s.heading || '').trim().replace(/^(INT\.?\s*\/\s*EXT\.?|EXT\.?\s*\/\s*INT\.?|I\/E\.?|INT\.?|EXT\.?)\s+/i, '');
    const m = /^(.*\S)\s+[–—-]\s+[^–—-]+$/.exec(h);
    h = m ? m[1] : h;
    return h || s.location || `Scene ${s.num}`;
  };
  const byNum = (a, b) => String(a.num).localeCompare(String(b.num), undefined, { numeric: true });
  const sceneOrder = (a, b) => ((a.sort || 0) - (b.sort || 0)) || byNum(a, b);
  const inDayOrder = (a, b) => ((a.day_sort || 0) - (b.day_sort || 0)) || sceneOrder(a, b);
  const sortedDays = (d) => d.days.slice().sort((a, b) => a.day_no - b.day_no);
  const toMin = (t) => { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
  const spanMin = (day) => { const a = toMin(day.crew_call), b = toMin(day.wrap); if (a == null || b == null) return null; let s = b - a; if (s <= 0) s += 1440; return s; };
  const addDays = (iso, n) => {
    if (!iso) return null;
    const dt = new Date(iso + 'T00:00:00'); dt.setDate(dt.getDate() + n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  };

  /* scenes per day (sorted) + the boneyard */
  function buckets(d) {
    const days = sortedDays(d);
    const ids = new Set(days.map((x) => x.id));
    const by = new Map(days.map((x) => [x.id, []]));
    const none = [];
    d.scenes.forEach((s) => { if (s.shoot_day_id && ids.has(s.shoot_day_id)) by.get(s.shoot_day_id).push(s); else none.push(s); });
    by.forEach((list) => list.sort(inDayOrder));
    none.sort(inDayOrder);
    return { days, by, none };
  }
  const listStats = (list) => ({ pages: list.reduce((a, s) => a + (Number(s.pages_eighths) || 0), 0), est: list.reduce((a, s) => a + est(s), 0) });

  /* ------------------------------------------------------------ pieces */
  function castChips(ctx, d, s) {
    const { esc } = ctx;
    const ids = [...new Set((d.cast[s.id] || []).map((n) => d.castIds.get(n.toLowerCase())).filter(Boolean))].sort((a, b) => a - b);
    if (!ids.length) return '<span class="faint">—</span>';
    return ids.map((n) => `<span class="stb-cid" title="${esc(d.castNames[n - 1])}">${n}</span>`).join('');
  }

  function moveMenu(ctx, s, dayId, idx, count, days) {
    const { ui, esc } = ctx;
    return `
      <label class="stb-move" title="Move scene ${esc(s.num)}">${ui.icon('ellipsis-vertical')}
        <select data-move="${s.id}" aria-label="Move scene ${esc(s.num)}">
          <option value="" selected>Move to…</option>
          ${idx > 0 ? '<option value="up">Move up</option>' : ''}
          ${idx < count - 1 ? '<option value="down">Move down</option>' : ''}
          ${days.length ? `<optgroup label="Shoot days">${days.map((x) => `<option value="day:${x.id}" ${x.id === dayId ? 'disabled' : ''}>Day ${esc(x.day_no)}${x.date ? ' · ' + MPH.date(x.date, 'day') : ''}${x.id === dayId ? ' (here)' : ''}</option>`).join('')}</optgroup>` : ''}
          ${dayId ? '<option value="none">Unscheduled</option>' : ''}
        </select>
      </label>`;
  }

  function strip(ctx, d, s, dayId, idx, count, days) {
    const { ui, esc } = ctx;
    const ed = ctx.canEdit;
    return `
      <div class="stb-strip stb-k-${kindOf(s)}" ${ed ? 'draggable="true"' : ''} data-id="${s.id}" role="listitem" aria-label="Scene ${esc(s.num)}, ${esc(s.heading || '')}">
        <span class="stb-grip" aria-hidden="true">${ed ? ui.icon('grip-vertical') : ''}</span>
        <span class="stb-num">${esc(s.num)}</span>
        <span class="stb-ie">${esc(ieOf(s))}</span>
        <span class="stb-set"><span class="stb-set-name truncate" dir="auto" title="${esc(s.heading || '')}">${esc(setName(s))}</span>${s.synopsis ? `<span class="stb-syn truncate" dir="auto" title="${esc(s.synopsis)}">${esc(s.synopsis)}</span>` : ''}</span>
        <span class="stb-dn" title="${esc(s.day_night || '')}">${esc(s.day_night || '')}</span>
        <span class="stb-pg mono">${MPH.eighths(s.pages_eighths)}</span>
        <span class="stb-est num">${fmtMin(est(s))}</span>
        <span class="stb-cast">${castChips(ctx, d, s)}</span>
        <span class="stb-loc truncate" dir="auto" title="${esc(s.location || '')}">${esc(s.location || '')}</span>
        ${ed ? moveMenu(ctx, s, dayId, idx, count, days) : '<span></span>'}
      </div>`;
  }

  function dayBlock(ctx, d, day, list, days) {
    const { ui, esc } = ctx;
    const ed = ctx.canEdit;
    const st = listStats(list);
    const span = spanMin(day);
    const locs = day.location || [...new Set(list.map((s) => s.location).filter(Boolean))].join(' → ');
    const summary = [day.date ? MPH.date(day.date, 'day') : 'Date not set', locs, pagesLabel(st.pages), `est. ${fmtMin(st.est)}`].filter(Boolean).join(' · ');
    const warn = st.est > LONG_DAY
      ? `<span class="pill danger" title="Scenes on this day add up to more than 12 hours of shooting">${ui.icon('triangle-alert')}Over 12 hours</span>`
      : span && st.est > span ? `<span class="pill warn" title="Scenes add up to more than the time between crew call and wrap">${ui.icon('clock-alert')}Longer than call to wrap</span>` : '';
    return `
      <section class="stb-day" data-day="${day.id}">
        <div class="stb-zone" data-zone="${day.id}" role="list" aria-label="Day ${esc(day.day_no)} scenes">
          ${list.length ? list.map((s, i) => strip(ctx, d, s, day.id, i, list.length, days)).join('')
            : `<div class="stb-drop-empty">${ui.icon('move')}${ed ? `Drag scenes here, or use Move to… on a strip, to shoot them on Day ${esc(day.day_no)}` : `No scenes on Day ${esc(day.day_no)} yet`}</div>`}
        </div>
        <div class="stb-break">
          <div class="stb-break-l">
            <div class="stb-break-title"><strong>End of Day ${esc(day.day_no)} of ${days.length}</strong><span dir="auto">— ${esc(summary)}</span></div>
            <div class="stb-break-meta">
              ${day.crew_call ? `<span>${ui.icon('clock')}Call ${MPH.time(day.crew_call)}${day.wrap ? ` · Wrap ${MPH.time(day.wrap)}` : ''}${span ? ` <span class="faint">(${fmtMin(span)})</span>` : ''}</span>` : `<span class="faint">${ui.icon('clock')}Call time not set</span>`}
              <span>${ui.icon('clapperboard')}${plural(list.length, 'scene')}</span>
              ${day.notes ? `<span class="stb-note" dir="auto" title="${esc(day.notes)}">${ui.icon('sticky-note')}<span class="truncate">${esc(day.notes)}</span></span>` : ''}
            </div>
          </div>
          <div class="stb-break-r">
            ${warn}
            ${ed ? `<button class="btn btn-xs btn-ghost" data-edit-day="${day.id}">${ui.icon('pencil')}Edit day</button>` : ''}
            <a class="btn btn-xs stb-cs-btn" href="#p.${ctx.production.id}.callsheets.new.${day.id}">${ui.icon('clipboard-list')}Create call sheet</a>
          </div>
        </div>
      </section>`;
  }

  function boneyard(ctx, d, list, days) {
    const { ui } = ctx;
    const st = listStats(list);
    return `
      <section class="stb-boneyard">
        <header class="stb-bone-head">${ui.icon('archive')}<strong>Unscheduled</strong>
          <span class="tiny muted">Boneyard: scenes not on a shoot day. They don’t appear on any call sheet.</span>
          <span class="spacer"></span>${list.length ? `<span class="tiny num muted">${plural(list.length, 'scene')} · ${pagesLabel(st.pages)} · est. ${fmtMin(st.est)}</span>` : ''}
        </header>
        <div class="stb-zone" data-zone="none" role="list" aria-label="Unscheduled scenes">
          ${list.map((s, i) => strip(ctx, d, s, null, i, list.length, days)).join('')
            || `<div class="stb-drop-empty">${ui.icon('circle-check')}Every scene has a shoot day.${ctx.canEdit ? ' Drag a strip here to take it off the schedule.' : ''}</div>`}
        </div>
      </section>`;
  }

  function side(ctx, d, b) {
    const { ui, esc } = ctx;
    const scheduled = d.scenes.length - b.none.length;
    const all = b.days.map((day) => ({ day, list: b.by.get(day.id), ...listStats(b.by.get(day.id)) }));
    const pages = all.reduce((a, x) => a + x.pages, 0);
    const total = all.reduce((a, x) => a + x.est, 0);
    const warnings = [];
    all.forEach((x) => {
      const span = spanMin(x.day);
      if (x.est > LONG_DAY) warnings.push(`Day ${x.day.day_no} has ${fmtMin(x.est)} of scenes, over a 12-hour day. Move a scene or add a day.`);
      else if (span && x.est > span) warnings.push(`Day ${x.day.day_no} has ${fmtMin(x.est)} of scenes between a ${MPH.time(x.day.crew_call)} call and ${MPH.time(x.day.wrap)} wrap (${fmtMin(span)}).`);
      if (!x.day.date && x.list.length) warnings.push(`Day ${x.day.day_no} has no date yet. Call sheets need one.`);
    });
    if (b.none.length && b.days.length) warnings.push(`${plural(b.none.length, 'scene is', 'scenes are')} unscheduled and won’t appear on any call sheet.`);
    return `
      <aside class="stb-side">
        ${ui.panel({
          title: 'Schedule totals', icon: 'sigma', flush: true,
          body: `
            <div class="stb-tot-grid">
              ${ui.stat(String(b.days.length), b.days.length === 1 ? 'Shoot day' : 'Shoot days')}
              ${ui.stat(`${scheduled}<span class="stb-of">/${d.scenes.length}</span>`, 'Scenes scheduled')}
              ${ui.stat(MPH.eighths(pages), 'Pages scheduled')}
              ${ui.stat(fmtMin(total), 'Est. shooting')}
            </div>
            ${all.length ? `<div class="stb-tot-days">${all.map((x) => {
              const cap = spanMin(x.day) || LONG_DAY;
              const over = x.est > LONG_DAY || x.est > cap;
              return `
                <div class="stb-tot-day">
                  <div class="row" style="gap:8px"><span class="small strong">Day ${esc(x.day.day_no)}</span><span class="tiny muted">${x.day.date ? MPH.date(x.day.date, 'day') : 'No date'}</span><span class="spacer"></span><span class="tiny num">${x.list.length} sc · ${MPH.eighths(x.pages)} pg</span></div>
                  ${ui.bar(Math.min(1, x.est / cap), over ? 'stb-bar-over' : '')}
                  <span class="tiny muted num">est. ${fmtMin(x.est)}${spanMin(x.day) ? ` of a ${fmtMin(spanMin(x.day))} day` : ' of 12h'}</span>
                </div>`;
            }).join('')}</div>` : ''}
            ${warnings.length ? `<div class="stb-warns">${warnings.map((w) => `<div class="stb-warn">${ui.icon('triangle-alert')}<span>${esc(w)}</span></div>`).join('')}</div>` : ''}`,
        })}
      </aside>`;
  }

  function renderPage(ctx, d) {
    const { ui, esc } = ctx;
    const p = ctx.production;
    const ed = ctx.canEdit;
    if (!d.scenes.length) {
      return `
        <div class="page stb-page">
          ${ui.pageHead({ title: ctx.t('Stripboard'), sub: esc(p.title) })}
          ${ui.panel({ body: ui.empty('rows-3', 'No strips yet',
            'The stripboard builds itself from the AI Breakdown: one strip per scene, coloured by interior, exterior, day and night. Add the script and run the breakdown first.',
            `<a class="btn btn-primary" href="#p.${p.id}.breakdown">${ui.icon('scan-text')}Open AI Breakdown</a>`) })}
        </div>`;
    }
    const b = buckets(d);
    const running = aiRuns.has(p.id), ready = aiReady.has(p.id);
    const aiLabel = running ? `${ui.spinner()}Suggesting…` : ready ? `${ui.icon('sparkles')}Review AI schedule` : `${ui.icon('sparkles')}Suggest schedule with AI`;
    const scheduled = d.scenes.length - b.none.length;
    const range = b.days.filter((x) => x.date).map((x) => x.date).sort();

    const head = ui.pageHead({
      title: ctx.t('Stripboard'),
      sub: `${plural(b.days.length, 'shoot day')}${range.length ? ` · ${MPH.date(range[0])}${range.length > 1 && range[range.length - 1] !== range[0] ? '–' + MPH.date(range[range.length - 1]) : ''}` : ''} · ${scheduled} of ${plural(d.scenes.length, 'scene')} scheduled${ed ? ' · drag strips to reschedule' : ''}`,
      actions: ed ? `
        <button class="btn btn-outline btn-sm" data-add-day>${ui.icon('calendar-plus')}Add shoot day</button>
        <button class="btn btn-sm btn-primary" data-ai ${running ? 'disabled' : ''}>${aiLabel}</button>` : '',
    });

    const legend = `
      <div class="stb-legend panel">
        <div class="stb-leg-grp"><span class="eyebrow">Strip colours</span>
          ${KINDS.map(([k, l]) => `<span class="stb-leg-item"><span class="stb-swatch stb-k-${k}"></span>${l}</span>`).join('')}</div>
        ${d.castNames.length ? `<div class="stb-leg-grp"><span class="eyebrow">Cast</span>${d.castNames.map((n, i) => `<span class="stb-leg-cast"><span class="stb-cid">${i + 1}</span><span class="small" dir="auto">${esc(n)}</span></span>`).join('')}</div>` : ''}
      </div>`;

    const noDays = !b.days.length ? `
      <div class="callout">${ui.icon('calendar-plus')}
        <div class="stack tight grow" style="gap:4px">
          <span class="strong small">No shoot days yet</span>
          <span class="small">${ed ? 'Add your shoot days, then drag scenes onto them. Or let AI propose a schedule; it creates the days it needs when you apply it.' : 'The schedule hasn’t been built yet. Every scene is unscheduled.'}</span>
          ${ed ? `<div class="row wrap"><button class="btn btn-sm btn-primary" data-add-day>${ui.icon('calendar-plus')}Add the first shoot day</button><button class="btn btn-sm btn-outline" data-ai ${running ? 'disabled' : ''}>${aiLabel}</button></div>` : ''}
        </div>
      </div>` : '';

    return `
      <div class="page full stb-page">
        ${head}
        ${legend}
        ${noDays}
        <div class="stb-layout">
          <section class="stb-main">
            <div class="stb-board-wrap">
              <div class="stb-board">
                <div class="stb-cols" aria-hidden="true"><span></span><span>Sc.</span><span>I/E</span><span>Set and synopsis</span><span>D/N</span><span>Pgs</span><span>Est.</span><span>Cast</span><span>Location</span><span></span></div>
                ${b.days.map((day) => dayBlock(ctx, d, day, b.by.get(day.id), b.days)).join('')}
                ${boneyard(ctx, d, b.none, b.days)}
              </div>
            </div>
          </section>
          ${side(ctx, d, b)}
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------ shoot day form */
  function openDay(ctx, d, day, paint) {
    const { ui, esc } = ctx;
    const days = sortedDays(d);
    const last = days[days.length - 1];
    const nextNo = days.reduce((m, x) => Math.max(m, x.day_no), 0) + 1;
    const v = day || {
      date: last && last.date ? addDays(last.date, 1) : (ctx.production.shoot_start || ''),
      location: '', crew_call: (last && last.crew_call) || '07:00', wrap: (last && last.wrap) || '19:00', notes: '',
    };
    const locs = [...new Set(d.scenes.map((s) => s.location).filter(Boolean))];
    const form = () => `
      <form class="stack" data-day-form>
        <div class="grid-2">
          <div class="field"><label for="sd-date">Date</label><input id="sd-date" class="input" type="date" value="${esc(v.date || '')}"></div>
          <div class="field"><label for="sd-loc">Main location</label><input id="sd-loc" class="input" list="sd-locs" dir="auto" value="${esc(v.location || '')}" placeholder="e.g. Al Thumamah dunes"><datalist id="sd-locs">${locs.map((l) => `<option value="${esc(l)}"></option>`).join('')}</datalist></div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="sd-call">Crew call</label><input id="sd-call" class="input" type="time" value="${esc(MPH.time(v.crew_call))}"></div>
          <div class="field"><label for="sd-wrap">Wrap</label><input id="sd-wrap" class="input" type="time" value="${esc(MPH.time(v.wrap))}"></div>
        </div>
        <div class="field"><label for="sd-notes">Notes (optional)</label><textarea id="sd-notes" class="textarea" dir="auto" style="min-height:64px" placeholder="Company move after lunch, permit window, weather cover…">${esc(v.notes || '')}</textarea></div>
        <div data-day-error hidden></div>
      </form>`;
    const footMain = () => `
      ${day ? `<button class="btn btn-ghost stb-danger-text" data-day-del>${ui.icon('trash-2')}Delete day</button><span class="spacer"></span>` : ''}
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" data-day-save>${day ? 'Save day' : `${ui.icon('plus')}Add Day ${nextNo}`}</button>`;
    const el = ctx.modal(ctx.frame({
      title: day ? `Edit Day ${esc(day.day_no)}` : `Add Day ${nextNo}`,
      sub: day ? '' : 'Days are numbered in the order you add them.',
      body: `<div data-day-body>${form()}</div>`,
      foot: `<div class="row stb-modal-foot" data-day-foot>${footMain()}</div>`,
    }));
    const body = el.querySelector('[data-day-body]');
    const foot = el.querySelector('[data-day-foot]');
    const showErr = (m) => { const b = el.querySelector('[data-day-error]'); if (b) { b.hidden = false; b.innerHTML = ui.errorBox(m); MPH.icons(); } else ctx.toastError(new Error(m)); };

    const save = async (btn) => {
      const val = (id) => el.querySelector(id).value.trim() || null;
      const row = { date: val('#sd-date'), location: val('#sd-loc'), crew_call: val('#sd-call'), wrap: val('#sd-wrap'), notes: val('#sd-notes') };
      btn.disabled = true;
      try {
        if (day) {
          ctx.api.must(await ctx.sb.from('shoot_days').update(row).eq('id', day.id));
          Object.assign(day, row);
          ctx.toast(`Day ${day.day_no} saved`);
        } else {
          const ins = ctx.api.must(await ctx.sb.from('shoot_days').insert({ ...row, production_id: ctx.production.id, day_no: nextNo }).select().single());
          d.days.push(ins);
          ctx.toast(`Day ${ins.day_no} added`, 'calendar-plus');
        }
        ctx.closeOverlay();
        paint();
      } catch (ex) { btn.disabled = false; showErr(ex.message); }
    };

    const confirmDelete = async () => {
      const list = d.scenes.filter((s) => s.shoot_day_id === day.id);
      body.innerHTML = `<div class="sl-ai-running">${ui.spinner()}<span class="small muted">Checking what’s on this day…</span></div>`;
      foot.innerHTML = '<button class="btn btn-ghost" data-close>Cancel</button>';
      const { count } = await ctx.sb.from('call_sheets').select('id', { count: 'exact', head: true }).eq('shoot_day_id', day.id);
      if (!el.isConnected) return;
      body.innerHTML = `
        <div class="callout danger">${ui.icon('triangle-alert')}<div class="stack tight" style="gap:4px">
          <span class="strong small">Delete Day ${esc(day.day_no)}${day.date ? ' · ' + MPH.date(day.date, 'long') : ''}?</span>
          <span class="small">${list.length ? `${list.length === 1 ? 'Its scene moves' : `Its ${list.length} scenes move`} to Unscheduled; nothing is lost from the breakdown.` : 'It has no scenes.'}
          ${count ? ` <strong>${plural(count, 'call sheet')} for this day will be deleted too.</strong>` : ''} Later days are renumbered.</span>
        </div></div>`;
      foot.innerHTML = `<button class="btn btn-ghost" data-day-back>Back</button><span class="spacer"></span><button class="btn btn-danger" data-day-del-go>${ui.icon('trash-2')}Delete Day ${esc(day.day_no)}</button>`;
      MPH.icons();
    };

    const doDelete = async (btn) => {
      btn.disabled = true; btn.innerHTML = `${ui.spinner()}Deleting…`;
      try {
        ctx.api.must(await ctx.sb.from('shoot_days').delete().eq('id', day.id));
        d.days = d.days.filter((x) => x.id !== day.id);
        d.scenes.forEach((s) => { if (s.shoot_day_id === day.id) s.shoot_day_id = null; });
        const later = sortedDays(d).filter((x) => x.day_no > day.day_no);
        for (const x of later) {
          ctx.api.must(await ctx.sb.from('shoot_days').update({ day_no: x.day_no - 1 }).eq('id', x.id));
          x.day_no -= 1;
        }
        ctx.closeOverlay();
        paint();
        ctx.toast(`Day ${day.day_no} deleted`, 'trash-2');
      } catch (ex) { ctx.closeOverlay(); ctx.toastError(ex); ctx.reload(); }
    };

    el.addEventListener('click', (e) => {
      let b;
      if ((b = e.target.closest('[data-day-save]'))) save(b);
      else if (e.target.closest('[data-day-del]')) confirmDelete().catch((ex) => ctx.toastError(ex));
      else if (e.target.closest('[data-day-back]')) { body.innerHTML = form(); foot.innerHTML = footMain(); MPH.icons(); }
      else if ((b = e.target.closest('[data-day-del-go]'))) doDelete(b);
    });
    el.addEventListener('submit', (e) => { e.preventDefault(); const b = el.querySelector('[data-day-save]'); if (b) save(b); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); const b = el.querySelector('[data-day-save]'); if (b && !b.disabled) save(b); } });
  }

  /* ------------------------------------------------------------ AI schedule */
  function openAi(ctx, d, paint) {
    const { ui, esc } = ctx;
    const pid = ctx.production.id;
    const days0 = sortedDays(d);
    const el = ctx.modal(ctx.frame({
      title: 'Suggest a schedule',
      sub: `${plural(d.scenes.length, 'scene')}${days0.length ? ` · ${plural(days0.length, 'shoot day')}` : ''}`,
      body: '<div class="stack" data-ai-body></div>',
      foot: '<div class="row stb-modal-foot" data-ai-foot></div>',
    }), { wide: true });
    const body = el.querySelector('[data-ai-body]');
    const foot = el.querySelector('[data-ai-foot]');
    const set = (b, f) => { body.innerHTML = b; foot.innerHTML = f; MPH.icons(); };

    const running = () => set(
      `<div class="sl-ai-running"><span class="spin"></span><div class="stack tight" style="gap:2px"><span class="strong">Building a schedule…</span><span class="small muted">The AI groups scenes by location, cast and daylight, keeps days under 12 hours and checks turnaround. This takes about a minute. You can close this window; the proposal will wait for you. Nothing changes until you apply it.</span></div></div>`,
      '<button class="btn btn-ghost" data-close>Close</button>');
    const failed = (err) => set(ui.errorBox(err.message || String(err)),
      `<button class="btn btn-ghost" data-close>Close</button><button class="btn btn-primary" data-ai-retry>${ui.icon('rotate-ccw')}Try again</button>`);

    const plan = (out) => {
      const known = new Map(d.scenes.map((s) => [s.id, s]));
      const seen = new Set();
      const pdays = (Array.isArray(out && out.days) ? out.days : []).slice()
        .sort((a, b) => (Number(a.day_no) || 0) - (Number(b.day_no) || 0))
        .map((pd) => ({
          rationale: String(pd.rationale || ''),
          scenes: (Array.isArray(pd.scene_ids) ? pd.scene_ids : []).filter((id) => known.has(id) && !seen.has(id) && seen.add(id)).map((id) => known.get(id)),
        }))
        .filter((pd) => pd.scenes.length);
      const rest = d.scenes.filter((s) => !seen.has(s.id)).sort(sceneOrder);
      return { pdays, rest, notes: String((out && out.notes) || '') };
    };

    const chip = (s) => `<span class="stb-chip stb-k-${kindOf(s)}" title="${esc(s.heading || '')}"><b>${esc(s.num)}</b><span class="truncate" dir="auto">${esc(setName(s))}</span></span>`;

    const preview = (out) => {
      const pl = plan(out);
      const days = sortedDays(d);
      if (!pl.pdays.length) {
        return set(ui.empty('sparkles', 'No schedule proposed', 'The AI didn’t return a usable schedule. Try again, or check the scenes have locations and times of day in the breakdown.'),
          `<button class="btn btn-ghost" data-ai-discard>Discard</button><button class="btn btn-primary" data-ai-retry>${ui.icon('rotate-ccw')}Try again</button>`);
      }
      const extra = pl.pdays.length - days.length;
      const idle = days.slice(pl.pdays.length);
      set(`
        ${pl.notes ? `<div class="callout">${ui.icon('sparkles')}<span class="small" dir="auto">${esc(pl.notes)}</span></div>` : ''}
        <div class="stb-ai-days">
          ${pl.pdays.map((pd, i) => {
            const day = days[i];
            const st = listStats(pd.scenes);
            return `
              <div class="stb-ai-day">
                <div class="row wrap" style="gap:8px">
                  <span class="strong">Day ${i + 1}</span>
                  ${day ? `<span class="small muted">${day.date ? MPH.date(day.date, 'day') : 'No date'}${day.location ? ' · ' + esc(day.location) : ''}</span>` : ui.pill('New day', 'accent', 'plus')}
                  <span class="spacer"></span>
                  <span class="tiny num muted">${plural(pd.scenes.length, 'scene')} · ${pagesLabel(st.pages)} · est. ${fmtMin(st.est)}</span>
                  ${st.est > LONG_DAY ? ui.pill('Over 12 hours', 'danger', 'triangle-alert') : ''}
                </div>
                <div class="stb-chips">${pd.scenes.map(chip).join('')}</div>
                ${pd.rationale ? `<p class="small stb-ai-why" dir="auto">${esc(pd.rationale)}</p>` : ''}
              </div>`;
          }).join('')}
          ${pl.rest.length ? `
            <div class="stb-ai-day is-none">
              <div class="row" style="gap:8px"><span class="strong">Unscheduled</span><span class="tiny muted">${plural(pl.rest.length, 'scene')} the AI left out</span></div>
              <div class="stb-chips">${pl.rest.map(chip).join('')}</div>
            </div>` : ''}
        </div>
        <p class="tiny muted">Applying puts every scene where it’s shown, in this order${extra > 0 ? `, and creates ${plural(extra, 'new shoot day')} after your last day` : ''}.${idle.length ? ` ${idle.map((x) => `Day ${x.day_no}`).join(', ')} will have no scenes; ${idle.length === 1 ? 'it stays' : 'they stay'} on the board.` : ''} You can drag anything afterwards.</p>`,
      `<button class="btn btn-ghost" data-ai-discard>Discard</button><span class="spacer"></span><button class="btn btn-ghost" data-close>Decide later</button><button class="btn btn-primary" data-ai-apply>${ui.icon('check')}Apply schedule</button>`);

      foot.querySelector('[data-ai-apply]').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.innerHTML = `${ui.spinner()}Applying…`;
        try {
          let target = sortedDays(d);
          const need = pl.pdays.length - target.length;
          if (need > 0) {
            const last = target[target.length - 1];
            const maxNo = target.reduce((m, x) => Math.max(m, x.day_no), 0);
            const start = last && last.date ? last.date : ctx.production.shoot_start ? addDays(ctx.production.shoot_start, -1 + target.length) : null;
            const rows = Array.from({ length: need }, (_, k) => ({
              production_id: pid, day_no: maxNo + 1 + k,
              date: start ? addDays(start, k + 1) : null,
              crew_call: last ? last.crew_call : null, wrap: last ? last.wrap : null,
            }));
            const ins = ctx.api.must(await ctx.sb.from('shoot_days').insert(rows).select());
            d.days.push(...ins);
            target = sortedDays(d);
          }
          const changes = [];
          const put = (s, dayId, k) => {
            if (s.shoot_day_id !== dayId || s.day_sort !== k) { s.shoot_day_id = dayId; s.day_sort = k; changes.push(s); }
          };
          pl.pdays.forEach((pd, i) => pd.scenes.forEach((s, k) => put(s, target[i].id, k)));
          pl.rest.forEach((s, k) => put(s, null, k));
          const res = await Promise.all(changes.map((s) => ctx.sb.from('scenes').update({ shoot_day_id: s.shoot_day_id, day_sort: s.day_sort }).eq('id', s.id)));
          const bad = res.find((r) => r.error);
          if (bad) throw new Error(bad.error.message);
          aiReady.delete(pid);
          ctx.closeOverlay();
          paint();
          ctx.toast(`Schedule applied: ${plural(d.scenes.length - pl.rest.length, 'scene')} across ${plural(pl.pdays.length, 'day')}`, 'sparkles');
        } catch (ex) {
          ctx.closeOverlay(); ctx.toastError(ex); ctx.reload();
        }
      });
    };

    const start = () => {
      running();
      let run = aiRuns.get(pid);
      if (!run) {
        run = ctx.api.ai('schedule', { production_id: pid });
        aiRuns.set(pid, run);
        paint();
        run.then((out) => { aiReady.set(pid, out); }, () => {}).finally(() => { aiRuns.delete(pid); paintIfHere(); });
      }
      run.then((out) => {
        if (el.isConnected) preview(out);
        else ctx.toast('The AI schedule is ready to review', 'sparkles');
      }, (err) => {
        if (el.isConnected) failed(err);
        else ctx.toastError(new Error(`The AI schedule failed: ${err.message || err}`));
      });
    };
    /* after a run finishes, refresh the header button only if this board is still on screen */
    const paintIfHere = () => {
      const btns = document.querySelectorAll('#view .stb-page [data-ai]');
      if (!btns.length || location.hash.indexOf(pid) < 0) return;
      const html = aiReady.has(pid) ? `${ui.icon('sparkles')}Review AI schedule` : `${ui.icon('sparkles')}Suggest schedule with AI`;
      btns.forEach((b) => { b.disabled = false; b.innerHTML = html; });
      MPH.icons();
    };

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-ai-retry]')) { aiReady.delete(pid); start(); }
      else if (e.target.closest('[data-ai-discard]')) { aiReady.delete(pid); ctx.closeOverlay(); paintIfHere(); }
    });

    if (aiReady.has(pid)) preview(aiReady.get(pid)); else start();
  }

  /* ------------------------------------------------------------ view */
  MPH.view('stripboard', {
    async load(ctx) {
      const pid = ctx.production.id;
      const [scenes, days, cast] = await Promise.all([
        ctx.sb.from('active_scenes').select('id, num, heading, int_ext, day_night, location, synopsis, pages_eighths, est_minutes, sort, shoot_day_id, day_sort').eq('production_id', pid),
        ctx.sb.from('shoot_days').select('*').eq('production_id', pid),
        ctx.sb.from('elements').select('scene_id, name').eq('production_id', pid).eq('category', 'cast'),
      ]);
      const d = { scenes: ctx.api.must(scenes), days: ctx.api.must(days), cast: {}, castIds: new Map(), castNames: [] };
      /* cast IDs in order of first appearance, like a stripboard's cast numbers */
      const order = new Map(d.scenes.slice().sort(sceneOrder).map((s, i) => [s.id, i]));
      ctx.api.must(cast).slice().sort((a, b) => (order.get(a.scene_id) ?? 1e9) - (order.get(b.scene_id) ?? 1e9)).forEach((c) => {
        const name = String(c.name || '').trim();
        if (!name) return;
        (d.cast[c.scene_id] = d.cast[c.scene_id] || []).push(name);
        const key = name.toLowerCase();
        if (!d.castIds.has(key)) { d.castNames.push(name); d.castIds.set(key, d.castNames.length); }
      });
      return d;
    },

    render: renderPage,

    mount(root, ctx, d) {
      if (!d.scenes.length) return;
      const paint = () => { if (root.isConnected) { root.innerHTML = renderPage(ctx, d); MPH.icons(); } };
      if (!ctx.canEdit) return;

      let queue = Promise.resolve();
      const persist = (changes) => {
        if (!changes.length) return;
        queue = queue.then(async () => {
          const res = await Promise.all(changes.map((s) => ctx.sb.from('scenes').update({ shoot_day_id: s.shoot_day_id, day_sort: s.day_sort }).eq('id', s.id)));
          const bad = res.find((r) => r.error);
          if (bad) { ctx.toastError(new Error(`The schedule change didn’t save: ${bad.error.message}`)); ctx.reload(); }
        });
      };

      /* move a scene to a day (or null = unscheduled), before/after a reference strip or at the end */
      const move = (id, toDay, refId, after) => {
        const b = buckets(d);
        const s = d.scenes.find((x) => x.id === id);
        if (!s) return null;
        const fromDay = s.shoot_day_id && b.by.has(s.shoot_day_id) ? s.shoot_day_id : null;
        const listOf = (dayId) => (dayId ? b.by.get(dayId) : b.none);
        const from = listOf(fromDay).filter((x) => x.id !== id);
        const to = toDay === fromDay ? from : listOf(toDay).filter((x) => x.id !== id);
        const idx = refId ? to.findIndex((x) => x.id === refId) : -1;
        if (idx < 0) to.push(s); else to.splice(after ? idx + 1 : idx, 0, s);
        const changes = [];
        const reindex = (list, dayId) => list.forEach((x, i) => {
          if (x.shoot_day_id !== dayId || x.day_sort !== i) { x.shoot_day_id = dayId; x.day_sort = i; changes.push(x); }
        });
        reindex(to, toDay);
        if (to !== from) reindex(from, fromDay);
        persist(changes);
        paint();
        if (toDay === fromDay) return '';
        const day = d.days.find((x) => x.id === toDay);
        return day ? `Day ${day.day_no}${day.date ? ' · ' + MPH.date(day.date, 'day') : ''}` : 'Unscheduled';
      };

      root.addEventListener('click', (e) => {
        let b;
        if (e.target.closest('[data-add-day]')) return openDay(ctx, d, null, paint);
        if ((b = e.target.closest('[data-edit-day]'))) { const day = d.days.find((x) => x.id === b.dataset.editDay); if (day) openDay(ctx, d, day, paint); return; }
        if ((b = e.target.closest('[data-ai]'))) { if (!b.disabled) openAi(ctx, d, paint); }
      });

      /* keyboard and touch: the "Move to…" menu on each strip */
      root.addEventListener('change', (e) => {
        const sel = e.target.closest('[data-move]');
        if (!sel || !sel.value) return;
        const id = sel.dataset.move;
        const s = d.scenes.find((x) => x.id === id);
        const v = sel.value;
        let where = '';
        if (v === 'up' || v === 'down') {
          const b = buckets(d);
          const dayId = s.shoot_day_id && b.by.has(s.shoot_day_id) ? s.shoot_day_id : null;
          const list = dayId ? b.by.get(dayId) : b.none;
          const i = list.indexOf(s);
          const ref = list[v === 'up' ? i - 1 : i + 1];
          if (ref) move(id, dayId, ref.id, v === 'down');
        } else if (v === 'none') where = move(id, null, null, false);
        else if (v.startsWith('day:')) where = move(id, v.slice(4), null, false);
        const again = root.querySelector(`[data-move="${id}"]`);
        if (again) again.focus();
        if (where) ctx.toast(`Sc. ${s.num} moved to ${where}`, 'move');
      });

      /* native drag and drop between days and the boneyard */
      let drag = null;
      const board = () => root.querySelector('.stb-board');
      const clearMarks = () => root.querySelectorAll('.drop-before, .drop-after, .drop-end').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-end'));
      root.addEventListener('dragstart', (e) => {
        const st = e.target.closest && e.target.closest('.stb-strip');
        if (!st) return;
        drag = st.dataset.id;
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', drag); } catch (err) { /* restricted */ }
        requestAnimationFrame(() => { st.classList.add('dragging'); const bd = board(); if (bd) bd.classList.add('is-dragging'); });
      });
      root.addEventListener('dragover', (e) => {
        if (!drag) return;
        const zone = e.target.closest && e.target.closest('[data-zone]');
        clearMarks();
        if (!zone) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const st = e.target.closest('.stb-strip');
        if (st && st.dataset.id !== drag) { const r = st.getBoundingClientRect(); st.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after'); }
        else if (!st) zone.classList.add('drop-end');
      });
      root.addEventListener('drop', (e) => {
        const zone = e.target.closest && e.target.closest('[data-zone]');
        if (!zone || !drag) return;
        e.preventDefault();
        const id = drag; drag = null;
        const st = e.target.closest('.stb-strip');
        clearMarks();
        if (st && st.dataset.id === id) return paint();
        let ref = null, after = false;
        if (st) { const r = st.getBoundingClientRect(); ref = st.dataset.id; after = e.clientY >= r.top + r.height / 2; }
        const toDay = zone.dataset.zone === 'none' ? null : zone.dataset.zone;
        const s = d.scenes.find((x) => x.id === id);
        const where = move(id, toDay, ref, after);
        if (where && s) ctx.toast(`Sc. ${s.num} moved to ${where}`, 'move');
      });
      root.addEventListener('dragend', () => {
        drag = null; clearMarks();
        root.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging'));
        const bd = board(); if (bd) bd.classList.remove('is-dragging');
      });
    },
  });
})();

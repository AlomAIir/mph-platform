/* Shoot Day (#p.<id>.shootday[.<shootDayId>]): the on-set view, team only, built for a phone in one hand.
   One day at a time: live header (clock, calls, sunset, schedule status), one-tap attendance, shot progress,
   the day log, change orders logged on set, receipts read by the AI, and the daily production report (DPR).
   Money boundary: change-order cost (change_order_costs), receipts and budget lines are read only when
   ctx.canSeeInternal; the client-safe DPR never includes costs, attendance or receipts. */
(function () {
  const { esc } = MPH;

  /* per-viewer UI state (not data) */
  const S = { tab: 'crew', filter: 'all', dpr: 'internal', reading: {}, reasons: {}, unreadable: {}, uploading: null };

  const LOG = {
    call: ['Crew call', 'users'], first_shot: ['First shot', 'clapperboard'], meal: ['Meal', 'utensils'],
    move: ['Company move', 'truck'], delay: ['Delay', 'timer'], incident: ['Incident', 'shield-alert'],
    wrap: ['Wrap', 'flag'], note: ['Note', 'message-square-text'],
  };
  const QUICK = ['call', 'first_shot', 'meal', 'move', 'delay', 'incident', 'wrap'];
  const CO_STATUS = { draft: ['Draft', ''], sent: ['Sent · awaiting client', 'info'], approved: ['Approved', 'ok'], declined: ['Declined', 'danger'] };

  /* sunset: a few Saudi cities matched from the day's location text; Riyadh otherwise */
  const CITIES = [
    [/jedd?ah|جدة/i, 'Jeddah', 21.54, 39.17], [/makk?ah|mecca|مكة/i, 'Makkah', 21.39, 39.86], [/madin|medina|المدينة/i, 'Madinah', 24.47, 39.61],
    [/dammam|khobar|dhahran|الدمام|الخبر/i, 'Dammam', 26.42, 50.09], [/al ?ula|العلا/i, 'AlUla', 26.61, 37.92], [/abha|أبها/i, 'Abha', 18.22, 42.51],
    [/taif|الطائف/i, 'Taif', 21.27, 40.42], [/tabuk|neom|تبوك|نيوم/i, 'Tabuk', 28.38, 36.57], [/hail|حائل/i, 'Hail', 27.52, 41.69],
  ];
  const cityOf = (text) => { const c = CITIES.find(([re]) => re.test(String(text || ''))); return c ? { name: c[1], lat: c[2], lng: c[3] } : { name: 'Riyadh', lat: 24.71, lng: 46.68 }; };
  /* NOAA approximation, good to a minute or two */
  function sunsetOf(dateIso, lat, lng) {
    if (!dateIso) return null;
    const [y, m, dd] = dateIso.split('-').map(Number);
    const N = Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(y, 0, 0)) / 86400000);
    const g = (2 * Math.PI / 365) * (N - 1);
    const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const r = Math.PI / 180;
    const cosH = Math.cos(90.833 * r) / (Math.cos(lat * r) * Math.cos(decl)) - Math.tan(lat * r) * Math.tan(decl);
    if (cosH < -1 || cosH > 1) return null;
    const mins = 720 - 4 * (lng - Math.acos(cosH) / r) - eqt;
    return new Date(Date.UTC(y, m - 1, dd) + mins * 60000);
  }

  /* ------------------------------------------------------------ small helpers */
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const pad = (x) => String(x).padStart(2, '0');
  const localIso = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hhmm = (t) => (t ? String(t).slice(0, 5) : '');
  const clock = (iso) => { if (!iso) return ''; const d = iso instanceof Date ? iso : new Date(iso); return isNaN(d) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const at = (dateIso, t) => (dateIso && t ? new Date(`${dateIso}T${hhmm(t)}:00`) : null);
  const dur = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${pad(m % 60)}m` : `${m}m`; };
  const plural = (k, one, many) => `${k} ${k === 1 ? one : (many || one + 's')}`;
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
  const est = (s) => n(s.est_minutes) || 15;
  const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || '';
  const clean = (v, max = 300) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
  const money = (v) => MPH.sar(v);
  /* receipts keep their halalas */
  const sar2 = (v) => 'SAR ' + n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isImage = (p) => /\.(jpe?g|png|webp|gif|heic)$/i.test(p || '');
  const lineLabel = (l) => `${l.category}${l.code ? ' ' + l.code : ''} · ${l.description}`;

  /* ------------------------------------------------------------ derived state */
  function callOf(d, p) { return d.sheetCalls[p.id] || hhmm(p.default_call) || hhmm(d.day.crew_call) || ''; }
  function stateOf(d, p) { const a = d.att[p.id]; return a ? a.status : 'none'; }
  function lateBy(d, p, a) {
    const call = at(d.day.date || localIso(), callOf(d, p));
    if (!call || !a || !a.checked_in_at) return 0;
    return Math.max(0, new Date(a.checked_in_at) - call);
  }
  function counts(d) {
    const c = { total: d.people.length, none: 0, in: 0, late: 0, absent: 0, released: 0 };
    d.people.forEach((p) => { c[stateOf(d, p)] += 1; });
    c.onSet = c.in + c.late;
    c.arrived = c.onSet + c.released;
    return c;
  }
  const logsOf = (d, kind) => d.logs.filter((l) => l.kind === kind).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const delayMinutes = (d) => logsOf(d, 'delay').reduce((s, l) => { const m = /(\d+)\s*(?:min|m\b|دقيقة)/i.exec(l.body || ''); return s + (m ? n(m[1]) : 0); }, 0);
  const nowShot = (d) => d.shots.find((s) => !s.done) || null;
  const nameOf = (ctx, d, uid) => (!uid ? '' : uid === ctx.session.user.id ? 'you' : firstName(d.names[uid]) || 'a teammate');

  function phaseOf(d, now = new Date()) {
    const day = d.day;
    if (!day.date) return 'undated';
    const today = localIso(now);
    return day.date === today ? 'live' : day.date > today ? 'upcoming' : 'past';
  }

  function scheduleStatus(d, now = new Date()) {
    const day = d.day;
    const done = d.shots.filter((s) => s.done).length;
    const total = d.shots.length;
    const wrapLog = logsOf(d, 'wrap').pop();
    const phase = phaseOf(d, now);
    if (wrapLog) return { label: 'Wrapped', sub: `Wrap logged ${clock(wrapLog.at)} · ${done} of ${total} shots`, kind: 'ok' };
    if (phase === 'undated') return { label: 'No date', sub: 'Set the date on the stripboard', kind: '' };
    if (phase === 'upcoming') { const k = daysBetween(localIso(now), day.date); return { label: k === 1 ? 'Tomorrow' : `In ${k} days`, sub: `${plural(total, 'shot')} planned`, kind: '' }; }
    if (phase === 'past') return total && done === total ? { label: 'Complete', sub: `All ${total} shots done`, kind: 'ok' } : { label: 'Day over', sub: `${done} of ${total} shots done`, kind: total ? 'warn' : '' };
    const callAt = at(day.date, day.crew_call);
    const started = done > 0 || d.logs.some((l) => l.kind === 'call' || l.kind === 'first_shot');
    if (callAt && now < callAt && !started) return { label: `Call in ${dur(callAt - now)}`, sub: `Crew call ${hhmm(day.crew_call)}`, kind: '' };
    if (!total) return { label: 'Rolling', sub: 'No shots listed for today', kind: '' };
    if (done === total) return { label: 'All shots done', sub: 'Log the wrap when you release the crew', kind: 'ok' };
    const first = logsOf(d, 'first_shot')[0];
    const start = first ? new Date(first.at) : at(day.date, d.shootCall) || (callAt ? new Date(+callAt + 60 * 60000) : null);
    const remaining = d.shots.filter((s) => !s.done).reduce((s, x) => s + est(x), 0);
    const proj = new Date(+now + remaining * 60000);
    let wrapAt = at(day.date, day.wrap);
    if (wrapAt && callAt && wrapAt < callAt) wrapAt = new Date(+wrapAt + 86400000);
    const over = wrapAt && proj > wrapAt ? ` · ${dur(proj - wrapAt)} past wrap` : '';
    if (!start || now < start) return { label: 'Setting up', sub: `First shot due ${clock(start) || 'soon'} · wrap ≈ ${clock(proj)}`, kind: '' };
    const elapsed = (now - start) / 60000;
    let cum = 0, expected = 0;
    for (const s of d.shots) { cum += est(s); if (cum <= elapsed) expected += 1; else break; }
    const diff = done - expected;
    return {
      label: diff > 0 ? `${plural(diff, 'shot')} ahead` : diff === 0 ? 'On schedule' : `${plural(-diff, 'shot')} behind`,
      sub: `Wrap ≈ ${clock(proj)}${over}`,
      kind: diff >= 0 ? (over ? 'warn' : 'ok') : 'danger',
    };
  }

  /* ------------------------------------------------------------ the daily production report (plain text, WhatsApp-ready) */
  function dprText(ctx, d, mode) {
    const client = mode === 'client';
    const withMoney = ctx.canSeeInternal && !client;
    const p = ctx.production, day = d.day;
    const done = d.shots.filter((s) => s.done).length;
    const first = logsOf(d, 'first_shot')[0];
    const wrap = logsOf(d, 'wrap').pop();
    const meals = logsOf(d, 'meal');
    const moves = logsOf(d, 'move');
    const delays = logsOf(d, 'delay');
    const incidents = logsOf(d, 'incident');
    const out = [];
    out.push(`*${client ? 'Daily report' : 'Daily production report'}* · ${p.title}`);
    out.push(`Day ${day.day_no} of ${d.total}${day.date ? ' · ' + MPH.date(day.date, 'long') : ''}`);
    if (d.location) out.push(`Location: ${d.location}`);
    out.push('');
    out.push(`Crew call ${hhmm(day.crew_call) || 'TBC'} · Wrap ${wrap ? clock(wrap.at) : (hhmm(day.wrap) ? hhmm(day.wrap) + ' (scheduled)' : 'TBC')}`);
    out.push(`First shot: ${first ? clock(first.at) : 'not logged'}`);
    if (meals.length) out.push(`Meal: ${meals.map((l) => clock(l.at)).join(', ')}`);
    if (moves.length) out.push(`Company move: ${moves.map((l) => `${clock(l.at)}${l.body && l.body !== 'Company move' ? ' ' + l.body : ''}`).join('; ')}`);
    out.push('');
    out.push(`*Shots* ${done} of ${d.shots.length} done`);
    d.scenes.forEach((s) => {
      const sh = d.shots.filter((x) => x.scene_id === s.id);
      const k = sh.filter((x) => x.done).length;
      out.push(`• Sc ${s.num} ${s.heading || s.location || ''}`.trim() + ` · ${sh.length ? (k === sh.length ? 'complete' : `${k}/${sh.length} shots`) : 'no shots listed'}`);
    });
    if (!client) {
      const c = counts(d);
      const long = d.people.filter((x) => { const a = d.att[x.id]; return a && a.checked_in_at && ((a.checked_out_at ? new Date(a.checked_out_at) : new Date()) - new Date(a.checked_in_at)) >= 12 * 3600000; });
      out.push('');
      out.push(`*Attendance* ${c.arrived} of ${c.total} checked in · ${c.late} late · ${c.absent} absent${c.none ? ` · ${c.none} not checked in` : ''}`);
      const lates = d.people.filter((x) => stateOf(d, x) === 'late' || (stateOf(d, x) === 'released' && lateBy(d, x, d.att[x.id]) > 0));
      if (lates.length) out.push(`Late: ${lates.map((x) => { const lb = lateBy(d, x, d.att[x.id]); return lb >= 60000 ? `${x.name} (${dur(lb)})` : x.name; }).join(', ')}`);
      if (long.length) out.push(`Over 12 h: ${long.map((x) => x.name).join(', ')}`);
    }
    out.push('');
    const dm = delayMinutes(d);
    out.push(`*Delays* ${delays.length ? `${delays.length}${dm ? ` · ${dm} min` : ''}` : 'none'}`);
    delays.forEach((l) => out.push(`• ${clock(l.at)} ${l.body}`));
    out.push(`*Incidents* ${incidents.length || 'none'}`);
    incidents.forEach((l) => out.push(`• ${clock(l.at)} ${l.body}`));
    const cos = d.dayCos.filter((c) => !client || c.status !== 'draft');
    out.push('');
    out.push(`*Change orders* ${cos.length || 'none'}`);
    cos.forEach((c) => {
      const cost = withMoney && d.costs[c.id] != null ? ` · cost ${MPH.sar(d.costs[c.id])}` : '';
      const st = client ? { sent: 'awaiting your approval', approved: 'approved', declined: 'declined' }[c.status] : CO_STATUS[c.status][0].toLowerCase();
      out.push(`• ${c.code || ''} ${c.title}${n(c.price) ? ' · ' + MPH.sar(c.price) : ''}${cost} · ${st}`.replace(/\s+/g, ' '));
    });
    if (withMoney) {
      const tot = d.receipts.reduce((s, r) => s + n(r.total), 0);
      const vat = d.receipts.reduce((s, r) => s + n(r.vat), 0);
      const code = d.receipts.filter((r) => !r.budget_line_id).length;
      out.push('');
      out.push(`*Receipts* ${d.receipts.length ? `${d.receipts.length} · ${sar2(tot)} (VAT ${sar2(vat)})${code ? ` · ${code} to code` : ''}` : 'none'}`);
    }
    if (day.notes && !client) { out.push(''); out.push(`Notes: ${day.notes}`); }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ------------------------------------------------------------ pieces */
  function dayPicker(ctx, d) {
    const today = localIso();
    return `<nav class="sd-days" aria-label="Shoot days">${d.days.map((x) => {
      const on = x.id === d.day.id;
      const cls = [on ? 'on' : '', x.date === today ? 'today' : '', x.date && x.date < today ? 'past' : ''].join(' ');
      return `<a class="sd-daychip ${cls}" href="#p.${ctx.production.id}.shootday.${x.id}" aria-current="${on ? 'page' : 'false'}">
        <span class="tiny">Day ${esc(x.day_no)}${x.date === today ? ' · <b>Today</b>' : ''}</span>
        <span class="small strong">${x.date ? esc(MPH.date(x.date, 'day')) : 'Date TBC'}</span></a>`;
    }).join('')}</nav>`;
  }

  function hero(ctx, d) {
    const { ui } = ctx;
    const day = d.day;
    const phase = phaseOf(d);
    const st = scheduleStatus(d);
    const city = cityOf(d.location);
    const sunset = sunsetOf(day.date, city.lat, city.lng);
    const eyebrow = {
      live: `<span class="sd-live" aria-hidden="true"></span>Live · Day ${esc(day.day_no)} of ${esc(d.total)}`,
      upcoming: `Up next · Day ${esc(day.day_no)} of ${esc(d.total)}`,
      past: `Day ${esc(day.day_no)} of ${esc(d.total)} · past`,
      undated: `Day ${esc(day.day_no)} of ${esc(d.total)}`,
    }[phase];
    const maps = d.mapsUrl || (d.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.location)}` : '');
    const sunsetLive = phase === 'live' && sunset && sunset > new Date() && sunset - new Date() < 9 * 3600000;
    return `
      <section class="sd-hero ${phase}">
        <div class="sd-hero-main">
          <span class="eyebrow sd-eyebrow">${eyebrow}</span>
          <h1 class="h1 sd-title">${esc(d.location || 'Location TBC')}</h1>
          <span class="small muted">${day.date ? esc(MPH.date(day.date, 'long')) : 'Date TBC'}${maps ? ` · <a class="accent" href="${esc(maps)}" target="_blank" rel="noopener">Open in Maps</a>` : ''}${d.sheet ? ` · <a class="accent" href="#p.${ctx.production.id}.callsheets.${d.sheet.id}">Call sheet v${esc(d.sheet.version)}</a>` : ''}</span>
        </div>
        <div class="sd-clocks">
          <div class="sd-clock now"><span class="tiny muted">Now</span><span class="sd-time" data-sd-now>${clock(new Date())}</span><span class="tiny faint">${phase === 'live' ? 'Local time' : 'Today ' + esc(MPH.date(localIso(), 'day'))}</span></div>
          <div class="sd-clock"><span class="tiny muted">Crew call → wrap</span><span class="sd-time">${esc(hhmm(day.crew_call) || '--:--')}<span class="sd-arrow">→</span>${esc(hhmm(day.wrap) || '--:--')}</span><span class="tiny faint">${d.shootCall ? `First shot due ${esc(d.shootCall)}` : 'Scheduled'}</span></div>
          ${sunset ? `<div class="sd-clock sun"><span class="tiny muted">${sunsetLive ? 'Sunset in' : 'Sunset'}</span><span class="sd-time" ${sunsetLive ? `data-sd-until="${sunset.toISOString()}"` : ''}>${sunsetLive ? dur(sunset - new Date()) : clock(sunset)}</span><span class="tiny faint">${sunsetLive ? clock(sunset) + ' · ' : ''}${esc(city.name)}, approx.</span></div>` : ''}
          <div class="sd-clock ${st.kind}"><span class="tiny muted">Schedule</span><span class="sd-time sd-time-text">${esc(st.label)}</span><span class="tiny faint">${esc(st.sub)}</span></div>
        </div>
      </section>`;
  }

  function stats(ctx, d) {
    const { ui } = ctx;
    const c = counts(d);
    const done = d.shots.filter((s) => s.done).length;
    const tile = (inner, cls = '') => `<div class="panel sd-stat ${cls}"><div class="panel-body">${inner}</div></div>`;
    const delays = logsOf(d, 'delay').length, incidents = logsOf(d, 'incident').length, dm = delayMinutes(d);
    const rTotal = d.receipts.reduce((s, r) => s + n(r.total), 0);
    return `<div class="grid-4 sd-stats">
      ${tile(ui.stat(`${done}<span class="sd-of">/${d.shots.length}</span>`, 'Shots done', `${ui.bar(d.shots.length ? done / d.shots.length : 0)}`), 'shots')}
      ${tile(ui.stat(`${c.onSet}<span class="sd-of">/${c.total}</span>`, 'On set now', `<span class="tiny faint">${c.late} late · ${c.absent} absent · ${c.released} released</span>`), 'crew')}
      ${tile(ui.stat(`${delays}${dm ? `<span class="sd-of"> · ${dm} min</span>` : ''}`, 'Delays logged',`<span class="tiny ${incidents ? '' : 'faint'}" style="${incidents ? 'color:var(--danger)' : ''}">${plural(incidents, 'incident')} logged</span>`), 'log')}
      ${ctx.canSeeInternal
        ? tile(ui.stat(money(rTotal), 'Receipts today', `<span class="tiny">${ui.lockNote(`${plural(d.receipts.length, 'receipt')} · internal`)}</span>`), 'money')
        : tile(ui.stat(String(d.dayCos.length), 'Change orders today', `<span class="tiny faint">${d.dayCos.filter((x) => x.status === 'draft').length} draft</span>`), 'money')}
    </div>`;
  }

  function shotsPanel(ctx, d) {
    const { ui } = ctx;
    const pid = ctx.production.id;
    const done = d.shots.filter((s) => s.done).length;
    const now = nowShot(d);
    if (!d.scenes.length) {
      return ui.panel({ title: 'Shot progress', icon: 'clapperboard', cls: 'sd-sec', body: ui.empty('rows-3', 'No scenes scheduled for this day', 'Drag scenes into this day on the stripboard. Their shots from the shot list show up here in shooting order.', `<a class="btn btn-outline btn-sm" href="#p.${pid}.stripboard">${ui.icon('rows-3')}Open stripboard</a>`) });
    }
    const row = (s) => {
      const isNow = now && s.id === now.id;
      const tags = [s.size, s.movement, s.lens].filter(Boolean).map((t) => `<span class="sd-tag">${esc(t)}</span>`).join('');
      const inner = `
        <span class="sd-shot-state">${s.done ? ui.icon('check') : isNow ? '<span class="sd-rec"></span>' : ''}</span>
        <span class="mono small strong sd-shot-code">${esc(s.code || '—')}</span>
        <span class="grow stack sd-shot-txt"><span class="small ${s.done ? 'muted' : ''}">${esc(s.description || s.subject || 'No description')}</span>${tags ? `<span class="row wrap sd-tags">${tags}</span>` : ''}</span>
        <span class="tiny faint nowrap sd-shot-meta">${s.setup ? `Setup ${esc(s.setup)} · ` : ''}${est(s)}m</span>
        ${ctx.canEdit ? `<span class="sd-shot-act tiny">${s.done ? 'Undo' : isNow ? 'Mark done' : 'Done'}</span>` : ''}`;
      return ctx.canEdit
        ? `<button type="button" class="sd-shot ${s.done ? 'done' : ''} ${isNow ? 'shooting' : ''} ${S.just === s.id ? 'just' : ''}" data-sd="shot" data-id="${s.id}" aria-pressed="${s.done}">${inner}</button>`
        : `<div class="sd-shot ${s.done ? 'done' : ''} ${isNow ? 'shooting' : ''}">${inner}</div>`;
    };
    const nowCard = now ? `
      <div class="sd-now">
        <div class="stack tight grow" style="gap:2px;min-width:0">
          <span class="eyebrow row" style="gap:6px"><span class="sd-rec"></span>Now shooting</span>
          <span class="sd-now-t"><span class="mono">${esc(now.code || '—')}</span> ${esc(now.description || now.subject || '')}</span>
          <span class="tiny muted">Sc ${esc((d.scenes.find((x) => x.id === now.scene_id) || {}).num || '?')}${now.setup ? ` · setup ${esc(now.setup)}` : ''} · ${est(now)} min planned</span>
        </div>
        ${ctx.canEdit ? `<button class="btn btn-primary sd-big" data-sd="shot" data-id="${now.id}">${ui.icon('check')}Mark ${esc(now.code || 'shot')} done</button>` : ''}
      </div>`
      : d.shots.length ? `<div class="sd-now all">${ui.icon('circle-check-big')}<span class="grow small"><span class="strong">All ${d.shots.length} shots done.</span> <span class="muted">Log the wrap in the day log when the crew is released.</span></span></div>` : '';
    return `
      <section class="panel flush sd-sec" id="sd-sec-shots">
        <header class="panel-head">${ui.icon('clapperboard')}<h3 class="h3">Shot progress · ${done} of ${d.shots.length}</h3><a class="btn btn-ghost btn-xs" href="#p.${pid}.shotlist">${ui.icon('list-video')}Shot list</a></header>
        <div class="sd-progress">${ui.bar(d.shots.length ? done / d.shots.length : 0)}<span class="tiny muted num">${d.shots.length ? Math.round((done / d.shots.length) * 100) : 0}%</span></div>
        ${nowCard}
        ${d.scenes.map((s) => {
          const sh = d.shots.filter((x) => x.scene_id === s.id);
          const k = sh.filter((x) => x.done).length;
          return `<div class="sd-scene-head"><span class="grow truncate">Sc ${esc(s.num)} · ${esc(s.heading || s.location || 'Untitled scene')}</span><span class="num">${k}/${sh.length}</span></div>
            ${sh.length ? sh.map(row).join('') : `<div class="sd-shot empty"><span class="tiny muted">No shots for this scene yet. <a class="accent" href="#p.${pid}.shotlist">Add them in the shot list</a>.</span></div>`}`;
        }).join('')}
      </section>`;
  }

  function crewTab(ctx, d) {
    const { ui } = ctx;
    const pid = ctx.production.id;
    if (!d.people.length) return ui.empty('users', 'No crew or talent yet', 'Add the people on this job in Crew & Talent. They appear here with their call time so you can check them in with one tap.', `<a class="btn btn-primary btn-sm" href="#p.${pid}.crew">${ui.icon('user-plus')}Open Crew & Talent</a>`);
    const c = counts(d);
    const nowD = new Date();
    const filters = [['all', 'Everyone', c.total], ['none', 'Not in', c.none], ['on', 'On set', c.onSet], ['late', 'Late', c.late], ['absent', 'Absent', c.absent], ['released', 'Released', c.released]];
    const match = (p) => { const s = stateOf(d, p); return S.filter === 'all' || (S.filter === 'on' ? (s === 'in' || s === 'late') : s === S.filter); };
    const list = d.people.filter(match);
    const row = (p) => {
      const a = d.att[p.id];
      const s = a ? a.status : 'none';
      const call = callOf(d, p);
      const callAt = at(d.day.date || localIso(), call);
      const lateNow = s === 'none' && callAt && nowD > callAt;
      const since = a && a.checked_in_at && (s === 'in' || s === 'late' || s === 'released');
      const end = a && a.checked_out_at ? new Date(a.checked_out_at) : nowD;
      const onFor = since ? end - new Date(a.checked_in_at) : 0;
      const flag = since && onFor >= 12 * 3600000 ? ui.pill('Over 12 h', 'danger', 'alarm-clock') : since && onFor >= 11 * 3600000 && s !== 'released' ? ui.pill('Near 12 h', 'warn', 'alarm-clock') : '';
      const lb = lateBy(d, p, a);
      const pill = {
        none: lateNow ? `<span class="tiny sd-due late">Due ${esc(call)}</span>` : call ? `<span class="tiny sd-due">Call ${esc(call)}</span>` : '',
        in: ui.pill('On set', 'ok'),
        late: ui.pill(lb >= 60000 ? `Late ${dur(lb)}` : 'Late', 'warn'),
        absent: ui.pill('Absent', 'danger'),
        released: ui.pill(`Released ${clock(a && a.checked_out_at)}`, ''),
      }[s];
      const acts = !ctx.canEdit ? '' : {
        none: `<button class="btn ${lateNow ? 'btn-market' : 'btn-primary'} sd-big" data-sd="in" data-id="${p.id}">${ui.icon('log-in')}Check in${lateNow ? ' late' : ''}</button>
               <button class="btn btn-ghost sd-mid" data-sd="absent" data-id="${p.id}">Absent</button>`,
        in: `<button class="btn btn-outline sd-mid" data-sd="out" data-id="${p.id}">${ui.icon('log-out')}Release</button><button class="btn btn-ghost btn-icon sd-mid" data-sd="undo" data-id="${p.id}" title="Undo check-in" aria-label="Undo check-in for ${esc(p.name)}">${ui.icon('undo-2')}</button>`,
        late: `<button class="btn btn-outline sd-mid" data-sd="out" data-id="${p.id}">${ui.icon('log-out')}Release</button><button class="btn btn-ghost btn-icon sd-mid" data-sd="undo" data-id="${p.id}" title="Undo check-in" aria-label="Undo check-in for ${esc(p.name)}">${ui.icon('undo-2')}</button>`,
        absent: `<button class="btn btn-ghost sd-mid" data-sd="undo" data-id="${p.id}">${ui.icon('undo-2')}Undo</button>`,
        released: `<button class="btn btn-ghost sd-mid" data-sd="undo" data-id="${p.id}">${ui.icon('undo-2')}Undo release</button>`,
      }[s];
      const meta = [
        p.role || p.kind,
        call && s !== 'none' ? `call ${call}` : '',
        a && a.checked_in_at ? `in ${clock(a.checked_in_at)}` : '',
      ].filter(Boolean).map(esc).join(' · ');
      return `<div class="sd-person st-${s} ${S.just === p.id ? 'just' : ''}">
        ${ui.av(p.name)}
        <div class="grow stack sd-person-main">
          <span class="row wrap" style="gap:6px"><span class="small strong truncate">${esc(p.name)}</span>${pill}${flag}</span>
          <span class="tiny muted truncate">${meta}${since ? ` · <span class="sd-onclock ${onFor >= 12 * 3600000 ? 'over' : ''}" ${s !== 'released' ? `data-sd-since="${esc(a.checked_in_at)}"` : ''}>${dur(onFor)}</span> on the clock` : ''}</span>
        </div>
        ${acts ? `<div class="sd-person-act">${acts}</div>` : ''}
      </div>`;
    };
    return `
      <div class="sd-counts">
        <div class="sd-count ok"><span class="v num">${c.onSet}</span><span class="l">On set</span></div>
        <div class="sd-count warn"><span class="v num">${c.late}</span><span class="l">Late</span></div>
        <div class="sd-count danger"><span class="v num">${c.absent}</span><span class="l">Absent</span></div>
        <div class="sd-count"><span class="v num">${c.none}</span><span class="l">Not in yet</span></div>
      </div>
      <div class="sd-filters" role="group" aria-label="Filter people">${filters.map(([id, label, k]) => `<button class="sd-chip ${S.filter === id ? 'on' : ''}" data-sd="filter" data-f="${id}" aria-pressed="${S.filter === id}">${label}<span class="num">${k}</span></button>`).join('')}</div>
      <div class="sd-people">${list.length ? list.map(row).join('') : `<p class="small muted sd-pad">Nobody here.</p>`}</div>
      <p class="tiny faint sd-pad">Call times come from ${d.sheet ? `the published call sheet (v${esc(d.sheet.version)})` : 'each person’s default call in Crew & Talent, else the crew call'}. Checking in after the call time marks the person late.</p>`;
  }

  function changesTab(ctx, d) {
    const { ui } = ctx;
    const others = d.cos.length - d.dayCos.length;
    const card = (c) => {
      const [label, kind] = CO_STATUS[c.status] || [c.status, ''];
      const cost = d.costs[c.id];
      const by = nameOf(ctx, d, c.created_by);
      const actions = [];
      if (c.status === 'draft' && ctx.canSeeInternal) {
        actions.push(n(c.price) > 0
          ? `<button class="btn btn-sm btn-primary" data-sd="co-send" data-id="${c.id}">${ui.icon('send')}Send to client</button>`
          : `<button class="btn btn-sm btn-outline" data-sd="co-edit" data-id="${c.id}">${ui.icon('badge-dollar-sign')}Add a client price to send</button>`);
      }
      if (c.status === 'draft' && ctx.canEdit) {
        actions.push(`<button class="btn btn-sm btn-ghost" data-sd="co-edit" data-id="${c.id}">${ui.icon('pencil')}Edit</button>`);
        actions.push(`<button class="btn btn-sm btn-ghost" data-sd="co-del" data-id="${c.id}">${ui.icon('trash-2')}Delete</button>`);
      }
      return `<article class="sd-co st-${esc(c.status)} ${S.just === c.id ? 'just' : ''}">
        <div class="row between wrap" style="gap:8px"><span class="row" style="gap:8px;min-width:0"><span class="mono small strong">${esc(c.code || 'CO')}</span><span class="strong truncate">${esc(c.title)}</span></span>${ui.pill(label, kind)}</div>
        ${c.reason ? `<p class="small muted">${esc(c.reason)}</p>` : ''}
        <div class="row wrap small" style="gap:16px">
          <span>Client price <span class="strong num">${n(c.price) ? money(c.price) : '<span class="faint">not set</span>'}</span></span>
          ${ctx.canSeeInternal ? `<span class="row lock-note" style="gap:5px">${ui.icon('lock')}Cost <span class="strong num">${cost != null ? money(cost) : '—'}</span>${cost != null && n(c.price) ? ` · margin ${money(n(c.price) - n(cost))}` : ''}</span>` : ''}
        </div>
        ${c.client_note ? `<div class="sd-client-note">${ui.icon('message-circle')}<span class="small"><span class="strong">Client:</span> ${esc(c.client_note)}</span></div>` : ''}
        <span class="tiny faint">Logged${by ? ' by ' + esc(by) : ''} ${esc(clock(c.created_at))}${c.sent_at ? ` · sent ${esc(MPH.date(c.sent_at))} ${esc(clock(c.sent_at))}` : ''}${c.decided_at ? ` · ${esc(c.status)} ${esc(MPH.date(c.decided_at))}` : ''}</span>
        ${actions.length ? `<div class="row wrap" style="gap:6px">${actions.join('')}</div>` : ''}
      </article>`;
    };
    return `<div class="stack sd-pad">
      ${ctx.canEdit ? `<button class="btn btn-outline sd-big sd-wide" data-sd="co-new">${ui.icon('file-plus')}Log a change on set</button>` : ''}
      ${d.dayCos.length ? d.dayCos.map(card).join('') : `<p class="small muted">No change orders on this day. When the client asks for something that wasn’t in the bid (an extra hour, a new location, more extras), log it here so it’s priced and approved in writing.</p>`}
      ${others > 0 ? `<p class="tiny faint">${plural(others, 'other change order')} on this production. <a class="accent" href="#p.${ctx.production.id}.budget">See them in Budget & Bid</a>.</p>` : ''}
      ${ctx.canSeeInternal ? `<span class="lock-note">${ui.icon('lock')}The client sees the title, reason and price once you send it. Never the cost.</span>` : `<span class="tiny faint">Producers add the price and send it to the client.</span>`}
    </div>`;
  }

  function receiptsTab(ctx, d, urls) {
    const { ui } = ctx;
    const byId = Object.fromEntries(d.lines.map((l) => [l.id, l]));
    const tot = d.receipts.reduce((s, r) => s + n(r.total), 0);
    const vat = d.receipts.reduce((s, r) => s + n(r.vat), 0);
    const toCode = d.receipts.filter((r) => !r.budget_line_id).length;
    const cats = [...new Set(d.lines.map((l) => l.category))];
    const lineSelect = (r) => `<select class="select sd-line-sel" data-sd-line="${r.id}" aria-label="Budget line for this receipt">
        <option value="">${r.budget_line_id ? 'Clear budget line' : 'Choose a budget line'}</option>
        ${cats.map((c) => `<optgroup label="${esc(c)}">${d.lines.filter((l) => l.category === c).map((l) => `<option value="${l.id}" ${l.id === r.budget_line_id ? 'selected' : ''}>${esc(lineLabel(l))}</option>`).join('')}</optgroup>`).join('')}
      </select>`;
    const row = (r) => {
      const url = urls[r.image_path];
      const reading = S.reading[r.id];
      const thumb = url && isImage(r.image_path) ? `<img src="${esc(url)}" alt="Receipt photo" loading="lazy">` : ui.icon(r.image_path && /\.pdf$/i.test(r.image_path) ? 'file-text' : 'receipt');
      const line = byId[r.budget_line_id];
      const title = reading ? 'Reading the receipt…' : r.vendor || (r.status === 'uploaded' ? 'Not read yet' : S.unreadable[r.id] ? 'Couldn’t read this receipt' : 'Unknown vendor');
      const meta = [r.receipt_date ? MPH.date(r.receipt_date) : '', r.vat_number ? `VAT no. ${r.vat_number}` : '', Array.isArray(r.lines) && r.lines.length ? plural(r.lines.length, 'line') : '', nameOf(ctx, d, r.created_by) ? `by ${nameOf(ctx, d, r.created_by)}` : ''].filter(Boolean).map(esc).join(' · ');
      const status = reading ? `<span class="row tiny muted" style="gap:6px">${ui.spinner()}This takes 5 to 20 seconds</span>`
        : ctx.canSeeInternal ? `<div class="row wrap" style="gap:6px">${lineSelect(r)}${r.status === 'uploaded' ? `<button class="btn btn-xs btn-outline" data-sd="r-read" data-id="${r.id}">${ui.icon('sparkles')}Read with AI</button>` : ''}</div>${S.reasons[r.id] ? `<span class="tiny faint">${ui.icon('sparkles')} ${esc(S.reasons[r.id])}</span>` : ''}`
        : line ? ui.pill(lineLabel(line), 'ok', 'link') : r.budget_line_id ? ui.pill('Matched to a budget line', 'ok', 'link') : ui.pill(r.status === 'uploaded' ? 'Waiting for a producer' : 'Sent to the producer to code', '');
      return `<div class="sd-rcpt st-${esc(r.status)} ${reading ? 'busy' : ''} ${S.just === r.id ? 'just' : ''}">
        ${url ? `<a class="sd-thumb" href="${esc(url)}" target="_blank" rel="noopener" aria-label="Open the receipt file">${thumb}</a>` : `<span class="sd-thumb">${thumb}</span>`}
        <div class="grow stack sd-rcpt-main">
          <span class="row wrap" style="gap:6px"><span class="small strong">${esc(title)}</span>${!reading && r.status !== 'uploaded' ? ui.aiBadge('AI read') : ''}</span>
          ${meta ? `<span class="tiny muted">${meta}</span>` : ''}
          ${status}
        </div>
        <div class="sd-rcpt-amt">
          <span class="strong num">${r.total != null ? sar2(r.total) : '—'}</span>
          ${r.vat != null ? `<span class="tiny faint num">VAT ${sar2(r.vat)}</span>` : ''}
          ${ctx.canSeeInternal && !reading ? `<button class="btn btn-ghost btn-xs btn-icon" data-sd="r-del" data-id="${r.id}" aria-label="Delete receipt" title="Delete receipt">${ui.icon('trash-2')}</button>` : ''}
        </div>
      </div>`;
    };
    return `<div class="stack sd-pad">
      ${ctx.canEdit ? `<label class="sd-snap ${S.uploading ? 'busy' : ''}">
          <input type="file" id="sd-file" accept="image/*,application/pdf" capture="environment" ${S.uploading ? 'disabled' : ''}>
          <span class="sd-snap-ico">${S.uploading ? ui.spinner() : ui.icon('camera')}</span>
          <span class="stack tight" style="gap:2px"><span class="strong">${S.uploading ? esc(S.uploading) : 'Snap a receipt'}</span><span class="tiny muted">${S.uploading ? 'Keep this screen open' : 'Photo or PDF. The AI reads the vendor, VAT number, lines and total' + (ctx.canSeeInternal ? ' and matches a budget line.' : '.')}</span></span>
        </label>` : ''}
      ${ctx.canSeeInternal ? `<div class="sd-rtotals">
          <div><span class="tiny muted">Today</span><span class="strong num">${sar2(tot)}</span></div>
          <div><span class="tiny muted">VAT</span><span class="strong num">${sar2(vat)}</span></div>
          <div><span class="tiny muted">Receipts</span><span class="strong num">${d.receipts.length}</span></div>
          <div class="${toCode ? 'warn' : ''}"><span class="tiny muted">To code</span><span class="strong num">${toCode}</span></div>
        </div>` : ''}
      ${d.receipts.length ? `<div class="sd-rlist">${d.receipts.map(row).join('')}</div>` : `<p class="small muted">No receipts for this day yet. Photograph each one as it comes in: fuel, parking, ice and water, props bought on the day.</p>`}
      ${ctx.canSeeInternal ? (d.lines.length ? '' : `<p class="tiny faint">There are no budget lines yet, so receipts can’t be matched. <a class="accent" href="#p.${ctx.production.id}.budget">Build the budget</a> first.</p>`) : ''}
      <span class="lock-note">${ui.icon('lock')}Internal. Clients never see receipts${ctx.canSeeInternal ? '' : '; you see the ones you added'}.</span>
    </div>`;
  }

  function logPanel(ctx, d) {
    const { ui } = ctx;
    const list = d.logs.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return `
      <section class="panel flush sd-sec" id="sd-sec-log">
        <header class="panel-head">${ui.icon('scroll-text')}<h3 class="h3">Day log · ${d.logs.length}</h3></header>
        ${ctx.canEdit ? `<div class="sd-log-add">
          <div class="sd-quick">${QUICK.map((k) => `<button class="sd-qbtn k-${k}" data-sd="log" data-k="${k}">${ui.icon(LOG[k][1])}<span>${LOG[k][0]}</span></button>`).join('')}</div>
          <div class="sd-note-row">
            <input class="input" id="sd-note" maxlength="500" placeholder="Add a note, e.g. Generator swapped at unit base" aria-label="Note">
            <input class="input sd-note-time num" id="sd-note-time" type="time" aria-label="Time (leave empty for now)" title="Time. Leave empty for now">
            <button class="btn btn-primary" data-sd="note">${ui.icon('plus')}Add</button>
          </div>
          <span class="tiny faint">Quick buttons log the time now (or the time you set). Type first to add detail.</span>
        </div>` : ''}
        <div class="sd-log">${list.length ? list.map((l) => `
          <div class="sd-log-row k-${esc(l.kind)} ${S.just === l.id ? 'just' : ''}">
            <span class="mono tiny sd-log-time">${esc(clock(l.at))}</span>
            <span class="sd-log-dot">${ui.icon((LOG[l.kind] || LOG.note)[1])}</span>
            <span class="stack" style="gap:1px;min-width:0"><span class="small">${esc(l.body)}</span><span class="tiny faint">${esc((LOG[l.kind] || LOG.note)[0])}${nameOf(ctx, d, l.created_by) ? ' · ' + esc(nameOf(ctx, d, l.created_by)) : ''}</span></span>
            ${ctx.canEdit ? `<button class="btn btn-ghost btn-xs btn-icon sd-log-del" data-sd="log-del" data-id="${l.id}" aria-label="Delete log entry" title="Delete">${ui.icon('x')}</button>` : '<span></span>'}
          </div>`).join('') : `<p class="small muted sd-pad">Nothing logged yet. Tap Crew call when the unit is in, then First shot, Meal and Wrap as the day goes. They build the daily report.</p>`}</div>
      </section>`;
  }

  function dprPanel(ctx, d) {
    const { ui } = ctx;
    const mode = S.dpr === 'client' ? 'client' : 'internal';
    const text = dprText(ctx, d, mode);
    return `
      <section class="panel flush sd-sec" id="sd-sec-dpr">
        <header class="panel-head">${ui.icon('file-text')}<h3 class="h3">Daily production report</h3></header>
        <div class="stack sd-pad">
          <div class="seg" role="group" aria-label="Report version">
            <button class="${mode === 'internal' ? 'on' : ''}" data-sd="dpr" data-m="internal">${ui.icon('lock')}${ctx.canSeeInternal ? 'Internal' : 'Team'}</button>
            <button class="${mode === 'client' ? 'on' : ''}" data-sd="dpr" data-m="client">${ui.icon('eye')}Client-safe</button>
          </div>
          <pre class="sd-dpr" id="sd-dpr" dir="auto">${esc(text)}</pre>
          <span class="tiny ${mode === 'client' ? 'lock-note' : 'faint'}">${mode === 'client' ? `${ui.icon('shield-check')}No costs, attendance or receipts. Draft change orders are left out.` : ctx.canSeeInternal ? 'Includes attendance, internal costs and receipts. For the production team only.' : 'Includes attendance. Costs and receipts are left out.'}</span>
          <div class="row wrap">
            <button class="btn btn-sm btn-outline" data-sd="dpr-copy">${ui.icon('copy')}Copy</button>
            <a class="btn btn-sm btn-outline" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">${ui.wa(14)}Share on WhatsApp</a>
          </div>
        </div>
      </section>`;
  }

  function jumpBar(ctx) {
    const items = [['sd-sec-shots', 'Shots', 'clapperboard'], ['sd-sec-tabs', 'Crew', 'users', 'crew'], ['sd-sec-log', 'Log', 'scroll-text'], ['sd-sec-tabs', 'Changes', 'file-plus', 'changes']];
    if (ctx.canEdit) items.push(['sd-sec-tabs', 'Receipts', 'receipt', 'receipts']);
    items.push(['sd-sec-dpr', 'Report', 'file-text']);
    return `<nav class="sd-jump" aria-label="Jump to section">${items.map(([to, label, icon, tab]) => `<button data-sd="jump" data-to="${to}" ${tab ? `data-tab="${tab}"` : ''}>${ctx.ui.icon(icon)}${label}</button>`).join('')}</nav>`;
  }

  /* ------------------------------------------------------------ page */
  function renderPage(ctx, d) {
    const { ui } = ctx;
    const pid = ctx.production.id;
    if (d.blocked) return `<div class="page">${ui.empty('lock', 'Team only', 'The on-set view holds attendance, receipts and internal detail.')}</div>`;
    if (!d.days.length) {
      return `<div class="page">${ui.pageHead({ eyebrow: 'Shoot', title: 'Shoot Day', sub: 'The on-set view: attendance, shot progress, the day log, change orders, receipts and the daily report.' })}
        <div class="panel">${ui.empty('radio', 'No shoot days yet', 'Add shoot days on the stripboard and schedule scenes into them. On the day, this screen runs the set.', `<a class="btn btn-primary btn-sm" href="#p.${pid}.stripboard">${ui.icon('rows-3')}Open stripboard</a>`)}</div></div>`;
    }
    const tabs = [['crew', 'Attendance', counts(d).onSet + '/' + d.people.length], ['changes', 'Change orders', d.dayCos.length]];
    if (ctx.canEdit) tabs.push(['receipts', 'Receipts', d.receipts.length]);
    const tab = tabs.some(([id]) => id === S.tab) ? S.tab : 'crew';
    return `
      <div class="page sd-page ${S.seen === d.day.id ? '' : 'sd-intro'}">
        ${dayPicker(ctx, d)}
        ${hero(ctx, d)}
        ${jumpBar(ctx)}
        ${!ctx.canEdit ? `<div class="callout info">${ui.icon('eye')}<span class="small">Read only. Owners, producers and heads of department run check-ins, shots and the log.</span></div>` : ''}
        ${stats(ctx, d)}
        <div class="sd-grid">
          <div class="stack loose sd-col">
            ${shotsPanel(ctx, d)}
            <section class="panel flush sd-sec" id="sd-sec-tabs">
              <div class="tabs sd-tabs" role="tablist">${tabs.map(([id, label, k]) => `<button role="tab" class="${tab === id ? 'on' : ''}" aria-selected="${tab === id}" data-sd="tab" data-t="${id}">${label}<span class="count">${k}</span></button>`).join('')}</div>
              <div class="sd-tabbody">${tab === 'crew' ? crewTab(ctx, d) : tab === 'changes' ? changesTab(ctx, d) : receiptsTab(ctx, d, d.urls)}</div>
            </section>
          </div>
          <div class="stack loose sd-col">
            ${logPanel(ctx, d)}
            ${dprPanel(ctx, d)}
          </div>
        </div>
      </div>`;
  }

  /* shrink big phone photos so the AI accepts them (it takes images up to about 5 MB) */
  async function prepareFile(file) {
    if (!/^image\//.test(file.type) || (file.size < 3.5 * 1024 * 1024 && /jpe?g|png|webp/i.test(file.type))) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
      if (!blob) return file;
      return new File([blob], (file.name || 'receipt').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch (e) { return file; }
  }

  /* ------------------------------------------------------------ view */
  MPH.view('shootday', {
    async load(ctx) {
      if (ctx.isClient || !ctx.isTeam) return { blocked: true };
      const { sb } = ctx;
      const { must } = ctx.api;
      const pid = ctx.production.id;
      let res = await sb.from('shoot_days').select('id, day_no, date, location, crew_call, wrap, notes, location_id, locations(name, address, maps_url)').eq('production_id', pid).order('day_no');
      if (res.error) res = await sb.from('shoot_days').select('id, day_no, date, location, crew_call, wrap, notes').eq('production_id', pid).order('day_no');
      const days = must(res) || [];
      if (!days.length) return { days };

      // which day: the one in the route, else today, else the next upcoming, else the most recent
      const today = localIso();
      const dated = days.filter((x) => x.date).sort((a, b) => a.date.localeCompare(b.date));
      const day = days.find((x) => x.id === ctx.params[0])
        || dated.find((x) => x.date === today) || dated.find((x) => x.date > today) || dated.filter((x) => x.date < today).pop() || days[0];

      const internal = ctx.canSeeInternal;
      const [people, scenes, sheet, att, logs, cos, costs, receipts, lines] = await Promise.all([
        sb.from('people').select('id, name, role, dept, kind, phone, default_call, status').eq('production_id', pid).order('name'),
        sb.from('active_scenes').select('id, num, heading, location, day_night, sort, day_sort').eq('production_id', pid).eq('shoot_day_id', day.id).order('day_sort').order('sort'),
        sb.from('call_sheets').select('id, version, content, published_at').eq('shoot_day_id', day.id).eq('status', 'published').order('version', { ascending: false }).limit(1),
        sb.from('attendance').select('*').eq('shoot_day_id', day.id),
        sb.from('day_logs').select('*').eq('shoot_day_id', day.id).order('at'),
        sb.from('change_orders').select('*').eq('production_id', pid).order('created_at'),
        internal ? sb.from('change_order_costs').select('change_order_id, cost').eq('production_id', pid) : Promise.resolve({ data: [] }),
        ctx.canEdit ? sb.from('receipts').select('*').eq('production_id', pid).eq('shoot_day_id', day.id).order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
        internal ? sb.from('budget_lines').select('id, category, code, description, sort').eq('production_id', pid).order('category').order('sort') : Promise.resolve({ data: [] }),
      ]);
      const d = {
        days, day, total: Math.max(days.length, ...days.map((x) => x.day_no || 0)),
        people: must(people) || [], scenes: must(scenes) || [], att: {}, logs: must(logs) || [],
        cos: must(cos) || [], costs: {}, receipts: must(receipts) || [], lines: must(lines) || [], names: {}, urls: {},
      };
      (must(att) || []).forEach((a) => { d.att[a.person_id] = a; });
      (must(costs) || []).forEach((c) => { d.costs[c.change_order_id] = c.cost; });
      d.dayCos = d.cos.filter((c) => c.shoot_day_id === day.id);
      d.sheet = (must(sheet) || [])[0] || null;
      const content = (d.sheet && d.sheet.content) || {};
      d.sheetCalls = {};
      (content.people || []).forEach((x) => { if (x.id && x.call) d.sheetCalls[x.id] = hhmm(x.call); });
      d.shootCall = hhmm(content.day && content.day.shoot_call) || '';
      const loc = day.locations || null;
      d.location = (content.location || '').trim() || (loc && loc.name) || day.location || '';
      d.mapsUrl = (loc && loc.maps_url) || '';

      // people ordered by call time, then name
      d.people.sort((a, b) => (callOf(d, a) || '99:99').localeCompare(callOf(d, b) || '99:99') || a.name.localeCompare(b.name));

      const sceneIds = d.scenes.map((s) => s.id);
      const [shots, names, urls] = await Promise.all([
        sceneIds.length ? sb.from('shots').select('id, scene_id, code, size, angle, movement, lens, description, subject, setup, est_minutes, done, sort').in('scene_id', sceneIds).order('sort') : Promise.resolve({ data: [] }),
        (() => {
          const ids = [...new Set([...d.logs, ...d.cos, ...d.receipts].map((x) => x.created_by).filter(Boolean))];
          return ids.length ? sb.from('profiles').select('id, full_name, email').in('id', ids) : Promise.resolve({ data: [] });
        })(),
        d.receipts.length ? ctx.api.mediaUrls(d.receipts.map((r) => r.image_path)) : Promise.resolve({}),
      ]);
      const order = Object.fromEntries(sceneIds.map((id, i) => [id, i]));
      d.shots = (must(shots) || []).sort((a, b) => (order[a.scene_id] - order[b.scene_id]) || (n(a.sort) - n(b.sort)));
      (names.data || []).forEach((p) => { d.names[p.id] = p.full_name || p.email || ''; });
      d.urls = urls || {};
      return d;
    },

    render(ctx, d) { return renderPage(ctx, d); },

    mount(root, ctx, d) {
      if (d.blocked || !d.days.length) return;
      const { ui, sb, api } = ctx;
      const pid = ctx.production.id;
      const uid = ctx.session.user.id;
      S.seen = d.day.id; // the entrance animation plays once per day opened, not on every tap
      const paint = (just) => { S.just = just || null; root.innerHTML = renderPage(ctx, d); S.just = null; MPH.icons(); };

      /* ---------------- live clock and durations */
      const tick = () => {
        if (!root.isConnected) { clearInterval(timer); return; }
        const now = new Date();
        root.querySelectorAll('[data-sd-now]').forEach((el) => { el.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`; });
        if (now.getSeconds() % 15 === 0) {
          root.querySelectorAll('[data-sd-since]').forEach((el) => { const ms = now - new Date(el.dataset.sdSince); el.textContent = dur(ms); el.classList.toggle('over', ms >= 12 * 3600000); });
          root.querySelectorAll('[data-sd-until]').forEach((el) => { el.textContent = dur(new Date(el.dataset.sdUntil) - now); });
        }
        // a full refresh every five minutes keeps the schedule status and 12-hour flags current, when nobody is typing
        if (now.getSeconds() === 0 && now.getMinutes() % 5 === 0) {
          const busy = root.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
          if (!busy && document.getElementById('overlay').hidden && !S.uploading) paint();
        }
      };
      const timer = setInterval(tick, 1000);
      tick();

      const person = (id) => d.people.find((x) => x.id === id);
      const nowIso = () => new Date().toISOString();

      /* ---------------- writes */
      async function checkIn(id, absent = false) {
        const p = person(id);
        const call = at(d.day.date || localIso(), callOf(d, p));
        const status = absent ? 'absent' : call && new Date() > call ? 'late' : 'in';
        const row = api.must(await sb.from('attendance').upsert({
          production_id: pid, shoot_day_id: d.day.id, person_id: id, status,
          checked_in_at: absent ? null : nowIso(), checked_out_at: null, method: 'manual',
        }, { onConflict: 'shoot_day_id,person_id' }).select().single());
        d.att[id] = row;
        paint(id);
        ctx.toast(absent ? `${p.name} marked absent` : status === 'late' ? `${p.name} checked in late` : `${p.name} checked in`, absent ? 'user-x' : 'user-check');
      }
      async function checkOut(id) {
        const a = d.att[id];
        const row = api.must(await sb.from('attendance').update({ status: 'released', checked_out_at: nowIso() }).eq('id', a.id).select().single());
        d.att[id] = row;
        paint(id);
        ctx.toast(`${person(id).name} released after ${dur(new Date(row.checked_out_at) - new Date(row.checked_in_at))}`, 'log-out');
      }
      async function undo(id) {
        const a = d.att[id];
        if (!a) return;
        if (a.status === 'released') {
          const late = lateBy(d, person(id), a) > 0;
          d.att[id] = api.must(await sb.from('attendance').update({ status: late ? 'late' : 'in', checked_out_at: null }).eq('id', a.id).select().single());
        } else {
          api.must(await sb.from('attendance').delete().eq('id', a.id));
          delete d.att[id];
        }
        paint(id);
      }

      async function addLog(kind, body, time) {
        const when = time && d.day.date ? at(d.day.date, time) : time ? at(localIso(), time) : new Date();
        const row = api.must(await sb.from('day_logs').insert({
          production_id: pid, shoot_day_id: d.day.id, kind, body: String(body).slice(0, 500), at: when.toISOString(), created_by: uid,
        }).select().single());
        d.logs.push(row);
        return row;
      }

      async function toggleShot(id) {
        const s = d.shots.find((x) => x.id === id);
        if (!s) return;
        const was = s.done;
        s.done = !was;
        paint(id);
        try { api.must(await sb.from('shots').update({ done: s.done }).eq('id', s.id)); } catch (ex) { s.done = was; paint(); throw ex; }
        const next = nowShot(d);
        let extra = '';
        // first shot of a live day: log it once, so the report has it without an extra tap
        if (s.done && phaseOf(d) === 'live' && !logsOf(d, 'first_shot').length && d.shots.filter((x) => x.done).length === 1) {
          try { await addLog('first_shot', `First shot: ${s.code || 'shot 1'}`); extra = ' First shot logged.'; paint(id); } catch (e) { /* the shot itself saved */ }
        }
        ctx.toast(s.done ? `${s.code || 'Shot'} done.${next ? ` Now shooting ${next.code || 'the next shot'}.` : ' That’s every shot.'}${extra}` : `${s.code || 'Shot'} back on the list`, s.done ? 'check' : 'undo-2');
      }

      /* change orders */
      /* next code after the highest across ALL of the production's change orders (Budget creates them too),
         read fresh at save time so a code made on another screen since this view loaded is never reused */
      const nextCode = async () => {
        const { data } = await sb.from('change_orders').select('code').eq('production_id', pid);
        const codes = (data || d.cos).map((c) => c.code).concat(d.cos.map((c) => c.code));
        const max = codes.reduce((m, c) => { const x = /CO-(\d+)/i.exec(c || ''); return Math.max(m, x ? n(x[1]) : 0); }, 0);
        return `CO-${pad(max + 1)}`;
      };
      function coForm(co) {
        const internal = ctx.canSeeInternal;
        const cost = co ? d.costs[co.id] : null;
        const dlg = ctx.modal(ctx.frame({
          title: co ? `Edit ${esc(co.code || 'change order')}` : 'Log a change on set',
          sub: co ? 'Draft. Nothing reaches the client until a producer sends it.' : 'It becomes a change order the client approves in writing. Verbal agreements get lost; this doesn’t.',
          body: `<div class="stack">
            <div class="field"><label for="sd-co-title">What changed</label><input id="sd-co-title" class="input" maxlength="160" value="${esc(co ? co.title : '')}" placeholder="e.g. Extra hour at the location"></div>
            <div class="field"><label for="sd-co-reason">Why</label><textarea id="sd-co-reason" class="textarea" rows="3" maxlength="1000" placeholder="e.g. The client asked for an extra setup with the product on the balcony.">${esc(co ? co.reason || '' : '')}</textarea></div>
            ${internal ? `<div class="grid-2">
              <div class="field"><label for="sd-co-price">Client price (SAR, excl. VAT)</label><input id="sd-co-price" class="input num" type="number" min="0" step="50" inputmode="decimal" value="${co && n(co.price) ? esc(co.price) : ''}" placeholder="0"></div>
              <div class="field"><label for="sd-co-cost">Internal cost (SAR)</label><input id="sd-co-cost" class="input num" type="number" min="0" step="50" inputmode="decimal" value="${cost != null ? esc(cost) : ''}" placeholder="0"></div>
            </div>
            <span class="lock-note">${ui.icon('lock')}The client sees the price only, never the cost.</span>`
            : `<div class="callout info">${ui.icon('info')}<span class="small">Saved as a draft without a price. A producer adds the price and sends it to the client.</span></div>`}
            <div id="sd-co-err"></div>
          </div>`,
          foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="sd-co-save">${ui.icon(co ? 'save' : 'file-plus')}${co ? 'Save changes' : 'Save as draft'}</button>`,
        }));
        const btn = dlg.querySelector('#sd-co-save');
        btn.addEventListener('click', async () => {
          const title = clean(dlg.querySelector('#sd-co-title').value, 160);
          const err = dlg.querySelector('#sd-co-err');
          if (!title) { err.innerHTML = ui.errorBox('Say what changed.'); MPH.icons(); return; }
          const row = { title, reason: clean(dlg.querySelector('#sd-co-reason').value, 1000) };
          const priceEl = dlg.querySelector('#sd-co-price');
          const costEl = dlg.querySelector('#sd-co-cost');
          if (priceEl) row.price = Math.max(0, n(priceEl.value));
          btn.disabled = true; btn.innerHTML = `${ui.spinner()} Saving`;
          try {
            let saved;
            if (co) {
              saved = api.must(await sb.from('change_orders').update(row).eq('id', co.id).eq('status', 'draft').select().single());
              Object.assign(co, saved);
            } else {
              saved = api.must(await sb.from('change_orders').insert({ ...row, production_id: pid, shoot_day_id: d.day.id, code: await nextCode(), status: 'draft', created_by: uid }).select().single());
              d.cos.push(saved); d.dayCos.push(saved);
            }
            if (costEl && costEl.value !== '') {
              const c = Math.max(0, n(costEl.value));
              api.must(await sb.from('change_order_costs').upsert({ change_order_id: saved.id, production_id: pid, cost: c }, { onConflict: 'change_order_id' }));
              d.costs[saved.id] = c;
            }
            ctx.closeOverlay();
            S.tab = 'changes';
            paint(saved.id);
            ctx.toast(co ? `${saved.code} saved` : `${saved.code} saved as a draft`, 'file-plus');
          } catch (ex) { btn.disabled = false; btn.innerHTML = `${ui.icon('file-plus')}Try again`; MPH.icons(); ctx.toastError(ex); }
        });
      }
      function sendCo(co) {
        const dlg = ctx.modal(ctx.frame({
          title: `Send ${esc(co.code)} to the client`,
          sub: esc(co.title),
          body: `<dl class="kv"><dt>Client price</dt><dd class="num strong">${money(co.price)} <span class="tiny muted">excl. VAT</span></dd>${co.reason ? `<dt>Reason</dt><dd>${esc(co.reason)}</dd>` : ''}</dl>
            <div class="callout info">${ui.icon('eye')}<span class="small">The client sees the title, reason and price in Budget & Bid and approves or declines it there. The internal cost stays hidden.</span></div>`,
          foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="sd-co-go">${ui.icon('send')}Send to client</button>`,
        }));
        const go = dlg.querySelector('#sd-co-go');
        go.addEventListener('click', async () => {
          go.disabled = true; go.innerHTML = `${ui.spinner()} Sending`;
          try {
            const saved = api.must(await sb.from('change_orders').update({ status: 'sent', sent_at: nowIso() }).eq('id', co.id).eq('status', 'draft').select().single());
            Object.assign(co, saved);
            try { await addLog('note', `${co.code} sent to the client: ${co.title} · ${MPH.sar(co.price)}`); } catch (e) { /* the change order itself is sent */ }
            ctx.closeOverlay(); paint(co.id);
            ctx.toast(`${co.code} sent to the client`, 'send');
          } catch (ex) { go.disabled = false; go.innerHTML = `${ui.icon('send')}Send to client`; MPH.icons(); ctx.toastError(ex); }
        });
      }

      /* receipts */
      const mapReceipt = (out) => {
        const lineIds = new Set(d.lines.map((l) => l.id));
        const line = out && lineIds.has(out.budget_line_id) ? out.budget_line_id : null;
        const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
        const readable = !!(out && out.readable !== false);
        return {
          vendor: readable ? clean(out.vendor, 160) : null,
          vat_number: readable ? clean(String(out.vat_number || '').replace(/\s+/g, ''), 20) : null,
          receipt_date: readable && /^\d{4}-\d{2}-\d{2}$/.test(out.receipt_date || '') ? out.receipt_date : null,
          total: readable ? num(out.total) : null,
          vat: readable ? num(out.vat) : null,
          lines: readable && Array.isArray(out.lines) ? out.lines.slice(0, 60).map((l) => ({ description: String(l.description || '').slice(0, 200), amount: num(l.amount) })) : [],
          budget_line_id: line,
          status: line ? 'matched' : 'unmatched',
        };
      };
      const aiRead = async (path) => {
        const out = await api.ai('receipt', { production_id: pid, file_path: path });
        return out;
      };
      const noteAi = (id, out) => {
        if (out && out.readable === false) S.unreadable[id] = true;
        if (out && out.match_reason) S.reasons[id] = String(out.match_reason).slice(0, 200);
      };
      async function readRow(r) {
        S.reading[r.id] = true; paint();
        try {
          const out = await aiRead(r.image_path);
          const saved = api.must(await sb.from('receipts').update(mapReceipt(out)).eq('id', r.id).select().single());
          Object.assign(r, saved);
          noteAi(r.id, out);
          ctx.toast(out && out.readable === false ? 'The AI couldn’t read this receipt. Choose the budget line yourself.' : `${r.vendor || 'Receipt'} · ${r.total != null ? sar2(r.total) : 'no total'}${r.budget_line_id ? ' · matched' : ''}`, 'receipt');
        } catch (ex) { ctx.toastError(ex); }
        delete S.reading[r.id]; paint(r.id);
      }
      async function addReceipt(input) {
        let file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        if (!/^image\//.test(file.type) && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return ctx.toast('Choose a photo or a PDF', 'triangle-alert', 'error');
        S.tab = 'receipts';
        S.uploading = 'Uploading…'; paint();
        let path = null;
        try {
          file = await prepareFile(file);
          if (file.size > 20 * 1024 * 1024) throw new Error('This file is larger than 20 MB. Take a closer photo or a smaller PDF.');
          path = await api.uploadMedia(pid, file, 'internal', 'receipts');
          d.urls = Object.assign(d.urls, await api.mediaUrls([path]));
          if (ctx.canSeeInternal) {
            const r = api.must(await sb.from('receipts').insert({ production_id: pid, shoot_day_id: d.day.id, image_path: path, status: 'uploaded', created_by: uid }).select().single());
            d.receipts.unshift(r);
            S.uploading = null;
            await readRow(r);
          } else {
            // heads of department can add receipts but not edit them afterwards, so read first and insert once
            S.uploading = 'Reading the receipt… 5 to 20 seconds'; paint();
            let out = null;
            try { out = await aiRead(path); } catch (ex) { ctx.toastError(ex); }
            const r = api.must(await sb.from('receipts').insert({
              production_id: pid, shoot_day_id: d.day.id, image_path: path, created_by: uid,
              ...(out ? mapReceipt(out) : { status: 'uploaded' }),
            }).select().single());
            noteAi(r.id, out);
            d.receipts.unshift(r);
            S.uploading = null; paint(r.id);
            ctx.toast(out ? `${r.vendor || 'Receipt'} added${r.total != null ? ' · ' + sar2(r.total) : ''}` : 'Receipt saved. A producer can have it read later.', 'receipt');
          }
        } catch (ex) {
          if (path && !d.receipts.some((r) => r.image_path === path)) { try { await api.removeMedia([path]); } catch (e) { /* best effort */ } }
          S.uploading = null; paint(); ctx.toastError(ex);
        }
      }

      /* armed confirm on a button: first tap asks, second tap acts */
      const armed = (el, label) => {
        if (el.dataset.armed === '1') return true;
        const old = el.innerHTML;
        el.dataset.armed = '1'; el.classList.add('btn-danger'); el.innerHTML = `${ui.icon('trash-2')}${label}`; MPH.icons();
        setTimeout(() => { if (el.isConnected && el.dataset.armed === '1') { el.dataset.armed = ''; el.classList.remove('btn-danger'); el.innerHTML = old; MPH.icons(); } }, 3000);
        return false;
      };

      /* ---------------- events */
      root.addEventListener('click', async (e) => {
        const el = e.target.closest('[data-sd]');
        if (!el || el.disabled) return;
        const a = el.dataset.sd;
        const id = el.dataset.id;
        try {
          if (a === 'tab') { S.tab = el.dataset.t; return paint(); }
          if (a === 'filter') { S.filter = el.dataset.f; return paint(); }
          if (a === 'dpr') { S.dpr = el.dataset.m; return paint(); }
          if (a === 'jump') {
            if (el.dataset.tab && S.tab !== el.dataset.tab) { S.tab = el.dataset.tab; paint(); }
            const t = root.querySelector('#' + el.dataset.to);
            if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
          if (a === 'dpr-copy') {
            const text = dprText(ctx, d, S.dpr === 'client' ? 'client' : 'internal');
            try { await navigator.clipboard.writeText(text); ctx.toast('Report copied'); } catch (ex) {
              const pre = root.querySelector('#sd-dpr'); const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
              ctx.toast('Selected. Copy it with your keyboard or the share menu.', 'info');
            }
            return;
          }
          if (!ctx.canEdit) return;
          el.disabled = true;
          const release = () => { if (el.isConnected) el.disabled = false; };
          try {
            if (a === 'shot') return await toggleShot(id);
            if (a === 'in') return await checkIn(id);
            if (a === 'absent') return await checkIn(id, true);
            if (a === 'out') return await checkOut(id);
            if (a === 'undo') return await undo(id);
            if (a === 'log' || a === 'note') {
              const noteEl = root.querySelector('#sd-note');
              const timeEl = root.querySelector('#sd-note-time');
              const text = clean(noteEl && noteEl.value, 500);
              const time = timeEl && timeEl.value;
              const k = a === 'note' ? 'note' : el.dataset.k;
              if (a === 'note' && !text) { ctx.toast('Type the note first', 'info'); if (noteEl) noteEl.focus(); return; }
              if ((k === 'delay' || k === 'incident') && !text) { release(); return logDetail(k, time); }
              const c = counts(d);
              const done = d.shots.filter((s) => s.done).length;
              const ns = nowShot(d);
              const auto = {
                call: `Crew call · ${c.arrived} of ${c.total} checked in`,
                first_shot: `First shot${ns ? ': ' + (ns.code || '') : ''}`.trim(),
                meal: 'Meal break',
                move: 'Company move',
                wrap: `Wrap · ${done} of ${d.shots.length} shots done`,
              }[k];
              const row = await addLog(k, text ? (k === 'note' ? text : `${LOG[k][0]}: ${text}`) : auto, time);
              paint(row.id);
              ctx.toast(`${LOG[k][0]} logged`, LOG[k][1]);
              return;
            }
            if (a === 'log-del') {
              if (!armed(el, 'Delete?')) return;
              api.must(await sb.from('day_logs').delete().eq('id', id));
              d.logs = d.logs.filter((l) => l.id !== id);
              return paint();
            }
            if (a === 'co-new') return coForm(null);
            if (a === 'co-edit') return coForm(d.cos.find((c) => c.id === id));
            if (a === 'co-send') return sendCo(d.cos.find((c) => c.id === id));
            if (a === 'co-del') {
              if (!armed(el, 'Delete draft?')) return;
              api.must(await sb.from('change_orders').delete().eq('id', id).eq('status', 'draft'));
              d.cos = d.cos.filter((c) => c.id !== id); d.dayCos = d.dayCos.filter((c) => c.id !== id);
              paint(); return ctx.toast('Draft deleted', 'trash-2');
            }
            if (a === 'r-read') return await readRow(d.receipts.find((r) => r.id === id));
            if (a === 'r-del') {
              if (!armed(el, '')) return;
              const r = d.receipts.find((x) => x.id === id);
              api.must(await sb.from('receipts').delete().eq('id', id));
              if (r && r.image_path) { try { await api.removeMedia([r.image_path]); } catch (ex) { /* best effort */ } }
              d.receipts = d.receipts.filter((x) => x.id !== id);
              paint(); return ctx.toast('Receipt deleted', 'trash-2');
            }
          } finally { release(); }
        } catch (ex) { ctx.toastError(ex); }
      });

      function logDetail(kind, time) {
        const delay = kind === 'delay';
        const dlg = ctx.modal(ctx.frame({
          title: delay ? 'Log a delay' : 'Log an incident',
          sub: delay ? 'It goes into the daily report with the time lost.' : 'Injuries, damage, near misses, complaints. Keep it factual.',
          body: `<div class="stack">
            ${delay ? `<div class="field"><label for="sd-dl-min">Minutes lost</label><input id="sd-dl-min" class="input num" type="number" min="1" step="5" inputmode="numeric" placeholder="e.g. 30"></div>` : ''}
            <div class="field"><label for="sd-dl-text">${delay ? 'Reason' : 'What happened'}</label><textarea id="sd-dl-text" class="textarea" rows="3" maxlength="400" placeholder="${delay ? 'e.g. Wind held the tracking rig' : 'e.g. Grip cut his hand on a C-stand; first aid on set, back at work'}"></textarea></div>
            <div id="sd-dl-err"></div>
          </div>`,
          foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="sd-dl-go">${ui.icon(LOG[kind][1])}Log ${delay ? 'delay' : 'incident'}</button>`,
        }));
        const go = dlg.querySelector('#sd-dl-go');
        go.addEventListener('click', async () => {
          const text = clean(dlg.querySelector('#sd-dl-text').value, 400);
          const mins = delay ? Math.round(n(dlg.querySelector('#sd-dl-min').value)) : 0;
          if (!text && !mins) { dlg.querySelector('#sd-dl-err').innerHTML = ui.errorBox(delay ? 'Add the minutes lost or the reason.' : 'Describe what happened.'); MPH.icons(); return; }
          go.disabled = true;
          try {
            const row = await addLog(kind, delay ? `Delay${mins ? ` ${mins} min` : ''}${text ? ': ' + text : ''}` : `Incident: ${text}`, time);
            ctx.closeOverlay(); paint(row.id);
            ctx.toast(`${LOG[kind][0]} logged`, LOG[kind][1]);
          } catch (ex) { go.disabled = false; ctx.toastError(ex); }
        });
      }

      root.addEventListener('change', async (e) => {
        const t = e.target;
        if (t.id === 'sd-file') return addReceipt(t);
        if (t.dataset.sdLine && ctx.canSeeInternal) {
          const r = d.receipts.find((x) => x.id === t.dataset.sdLine);
          const v = t.value || null;
          t.disabled = true;
          try {
            Object.assign(r, api.must(await sb.from('receipts').update({ budget_line_id: v, status: v ? 'matched' : 'unmatched' }).eq('id', r.id).select().single()));
            delete S.reasons[r.id];
            const l = d.lines.find((x) => x.id === v);
            ctx.toast(l ? `Coded to ${lineLabel(l)}` : 'Budget line cleared', 'link');
            paint(r.id);
          } catch (ex) { t.disabled = false; ctx.toastError(ex); }
        }
      });
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.target.id === 'sd-note' || e.target.id === 'sd-note-time')) { e.preventDefault(); const b = root.querySelector('[data-sd="note"]'); if (b) b.click(); }
      });
    },
  });
})();

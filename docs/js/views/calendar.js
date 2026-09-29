/* Calendar (#p.<id>.calendar) — client-visible
   Month, Week and Agenda views of one production: events (prep, recce, casting, fitting, meeting, shoot, travel,
   post, review, delivery, other), shoot days from the stripboard (read only, link to it) and the production's own
   milestones (shoot start and wrap, delivery). A phase strip above the grid shows pre-production, shoot and post
   with a Today marker. Editors add events by clicking a day, edit them in a modal, and drag them to another day in
   month view (the duration is kept).
   Clients: read only, never internal events (RLS filters them; we also filter and never select the internal column),
   and only when productions.share_calendar is on. Shoot days aren't readable by clients, so they aren't queried. */
(function () {
  /* type id -> [label, colour, icon] (ids match the events.type check constraint) */
  const TYPES = {
    prep: ['Prep', '#86B8E8', 'clipboard-check'],
    recce: ['Recce', '#FAB771', 'binoculars'],
    casting: ['Casting', '#F29CC3', 'drama'],
    fitting: ['Fitting', '#6FC3D8', 'shirt'],
    meeting: ['Meeting', '#F2C94C', 'users'],
    shoot: ['Shoot', '#ACD062', 'clapperboard'],
    travel: ['Travel', '#B79CF0', 'plane'],
    post: ['Post', '#7FB2A6', 'film'],
    review: ['Review', '#D8C8A8', 'message-square-text'],
    delivery: ['Delivery', '#F07A6A', 'package-check'],
    other: ['Other', '#9FB0AA', 'calendar'],
  };
  const PHASE_COL = { pre: '#ACD062', shoot: '#FAB771', post: '#7FB2A6' };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DOW_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const H0 = 5, H1 = 24, PX = 28; // week grid: hours shown, px per hour
  const CLIENT_COLS = 'id, title, type, starts_at, ends_at, all_day, location, notes, attendees';

  /* ------------------------------------------------------------ dates (local time, yyyy-mm-dd keys) */
  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const pd = (k) => new Date(k + 'T00:00:00');
  const addK = (k, n) => { const d = pd(k); d.setDate(d.getDate() + n); return keyOf(d); };
  const diffK = (a, b) => Math.round((pd(b) - pd(a)) / 86400000);
  const weekStart = (k) => addK(k, -pd(k).getDay());
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const todayK = () => keyOf(new Date());
  const toMin = (t) => { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
  const fromMin = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
  const ar = () => MPH.state.lang === 'ar';
  const monthLabel = (k) => `${(ar() ? MONTHS_AR : MONTHS)[pd(k).getMonth()]} ${pd(k).getFullYear()}`;
  const dowName = (i) => (ar() ? DOW_AR : DOW)[i];
  const isWknd = (k) => pd(k).getDay() >= 5; // Friday and Saturday: the Saudi weekend
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const typeOf = (t) => TYPES[t] || TYPES.other;
  const clean = (v, max = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
  const mapsHref = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;

  /* ------------------------------------------------------------ items: events + shoot days + milestones */
  function buildItems(ctx, d) {
    const p = ctx.production;
    const items = [];
    d.events.forEach((e) => {
      const s = new Date(e.starts_at);
      if (isNaN(s)) return;
      const en = e.ends_at ? new Date(e.ends_at) : null;
      const sk = keyOf(s);
      let ek = sk;
      if (e.all_day && en && !isNaN(en) && keyOf(en) > sk) ek = keyOf(en);
      items.push({
        kind: 'event', id: e.id, type: TYPES[e.type] ? e.type : 'other', title: e.title || 'Untitled', allDay: !!e.all_day, sk, ek,
        time: e.all_day ? '' : hm(s), end: !e.all_day && en && !isNaN(en) ? hm(en) : '', location: e.location || '',
        internal: e.internal === true, ev: e,
      });
    });
    const dated = (d.days || []).filter((x) => x.date);
    dated.forEach((x) => items.push({
      kind: 'shoot', id: 'sd-' + x.id, type: 'shoot', title: `Shoot day ${x.day_no}`, allDay: true, sk: x.date, ek: x.date,
      time: MPH.time(x.crew_call), end: MPH.time(x.wrap), location: x.location || '', day: x,
    }));
    const mile = (k, title, type, until) => { if (k) items.push({ kind: 'mile', id: 'm-' + title, type, title, allDay: true, sk: k, ek: until && until > k ? until : k, time: '', end: '', location: '' }); };
    // no dated shoot days to show (always the case for clients): the production's shoot dates as one band
    if (!dated.length) mile(p.shoot_start, 'Shoot', 'shoot', p.shoot_end);
    mile(p.delivery, 'Final delivery', 'delivery');
    return items;
  }
  const rank = (it) => (it.kind === 'mile' ? 0 : it.ek !== it.sk ? 1 : it.kind === 'shoot' ? 2 : it.allDay ? 3 : 4);
  const order = (a, b) => rank(a) - rank(b) || (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0) || String(a.time).localeCompare(String(b.time)) || a.title.localeCompare(b.title);
  const onDay = (it, k) => k >= it.sk && k <= it.ek;
  const timeLabel = (it) => {
    if (it.kind === 'mile') return it.ek !== it.sk ? `${MPH.date(it.sk)} – ${MPH.date(it.ek)}` : 'Milestone';
    if (it.kind === 'shoot') return it.time ? `Call ${it.time}${it.end ? ' · wrap ' + it.end : ''}` : 'Shoot day';
    if (it.allDay) return it.ek !== it.sk ? `${MPH.date(it.sk)} – ${MPH.date(it.ek)}` : 'All day';
    return `${it.time}${it.end ? '–' + it.end : ''}`;
  };

  /* ------------------------------------------------------------ view state (per viewer) */
  function viewState(ctx, items) {
    const st = ctx.state, pid = ctx.production.id;
    if (st.calFor !== pid || !st.calCursor) {
      // open on this month if anything happens in it, otherwise on the next thing coming up
      const t = todayK();
      const ym = t.slice(0, 7);
      const thisMonth = items.some((i) => i.sk.slice(0, 7) <= ym && i.ek.slice(0, 7) >= ym);
      const next = items.filter((i) => i.ek >= t).sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0))[0];
      st.calCursor = thisMonth || !next ? t : next.sk;
      st.calFor = pid;
      st.calOff = [];
    }
    if (!st.calView) st.calView = window.innerWidth < 720 ? 'agenda' : 'month';
    return { view: st.calView, cursor: st.calCursor, off: st.calOff || [] };
  }

  /* ------------------------------------------------------------ pieces */
  function chip(ctx, it, k) {
    const { esc, ui } = ctx;
    const color = typeOf(it.type)[1];
    const multi = it.ek !== it.sk;
    const segStart = !multi || k === it.sk || pd(k).getDay() === 0;
    const cls = multi ? `${k === it.sk ? 'span-s' : ''} ${k === it.ek ? 'span-e' : ''} ${k !== it.sk && k !== it.ek ? 'span-m' : ''}` : '';
    const tip = esc(`${it.title} · ${timeLabel(it)}${it.location ? ' · ' + it.location : ''}`);
    const inner = segStart
      ? `${it.kind === 'mile' ? ui.icon(it.type === 'shoot' ? 'clapperboard' : 'flag') : ''}${it.kind === 'shoot' ? ui.icon('clapperboard') : ''}${it.internal ? ui.icon('lock') : ''}${it.time && it.kind === 'event' ? `<bdi class="cal-t num" dir="ltr">${esc(it.time)}</bdi>` : ''}<span class="truncate" dir="auto">${esc(it.title)}</span>`
      : '<span class="truncate cal-cont">&nbsp;</span>';
    if (it.kind === 'shoot') return `<a class="cal-chip is-shoot" style="--c:${color}" href="#p.${ctx.production.id}.stripboard" title="${tip} · Open the stripboard">${inner}</a>`;
    if (it.kind === 'mile') return `<span class="cal-chip is-mile ${cls}" style="--c:${color}" title="${tip}">${inner}</span>`;
    const drag = ctx.canEdit && !ctx.isClient;
    return `<div class="cal-chip ${cls} ${it.internal ? 'is-internal' : ''}" style="--c:${color}" role="button" tabindex="0" data-cal-ev="${it.id}" data-cal-from="${k}" ${drag ? 'draggable="true"' : ''} title="${tip}">${inner}</div>`;
  }

  /* one row in the agenda and in day lists */
  function agendaRow(ctx, it, k) {
    const { esc, ui } = ctx;
    const [label, color, icon] = typeOf(it.type);
    const meta = [it.location ? `${ui.icon('map-pin')}<span class="truncate" dir="auto">${esc(it.location)}</span>` : '',
      it.ev && it.ev.attendees && it.ev.attendees.length ? `${ui.icon('users')}<span class="truncate" dir="auto">${esc(it.ev.attendees.slice(0, 4).join(', '))}${it.ev.attendees.length > 4 ? ` +${it.ev.attendees.length - 4}` : ''}</span>` : '']
      .filter(Boolean).map((x) => `<span class="cal-ag-meta">${x}</span>`).join('');
    const multi = it.ek !== it.sk ? `<span class="tiny faint">Day ${diffK(it.sk, k) + 1} of ${diffK(it.sk, it.ek) + 1}</span>` : '';
    const body = `
      <span class="cal-ag-bar"></span>
      <span class="cal-ag-time num" title="${esc(timeLabel(it))}"><bdi dir="ltr">${esc(it.kind === 'event' && it.allDay ? 'All day' : it.kind === 'shoot' ? (it.time ? `Call ${it.time}` : 'Shoot day') : timeLabel(it))}</bdi></span>
      <span class="cal-ag-main">
        <span class="cal-ag-title"><span class="truncate" dir="auto">${esc(it.title)}</span>${it.internal ? `<span class="cal-int">${ui.icon('lock')}Internal</span>` : ''}${multi}</span>
        ${meta ? `<span class="cal-ag-metas">${meta}</span>` : ''}
      </span>
      <span class="cal-type-pill" style="--c:${color}">${ui.icon(icon)}${esc(it.kind === 'mile' && it.ek === it.sk ? 'Milestone' : label)}</span>`;
    if (it.kind === 'shoot') return `<a class="cal-ag-item" style="--c:${color}" href="#p.${ctx.production.id}.stripboard">${body}</a>`;
    if (it.kind === 'mile') return `<div class="cal-ag-item is-static" style="--c:${color}">${body}</div>`;
    return `<div class="cal-ag-item" style="--c:${color}" role="button" tabindex="0" data-cal-ev="${it.id}">${body}</div>`;
  }

  /* ------------------------------------------------------------ phase strip */
  function timeline(ctx, d, items, view, cursor) {
    const { ui, esc } = ctx;
    const p = ctx.production;
    const dates = (d.days || []).map((x) => x.date).filter(Boolean).sort();
    const ss = p.shoot_start || dates[0] || null;
    let se = p.shoot_end || dates[dates.length - 1] || ss;
    if (ss && se && se < ss) se = ss;
    const del = p.delivery || null;
    if (!ss && !del) {
      return ctx.isClient ? '' : `<div class="callout info cal-tl-empty">${ui.icon('calendar-range')}<span class="small">Add the shoot dates and the delivery date to the production (Overview, then Edit details) to see pre-production, shoot and post on a timeline here.</span></div>`;
    }
    const created = p.created_at ? keyOf(new Date(p.created_at)) : null;
    const ph = [];
    if (ss) {
      if (!created || created < ss) ph.push(['Pre-production', created || addK(ss, -21), addK(ss, -1), PHASE_COL.pre]);
      ph.push(['Shoot', ss, se, PHASE_COL.shoot]);
      if (del && del > se) ph.push(['Post', addK(se, 1), del, PHASE_COL.post]);
    } else {
      ph.push(['Prep and shoot', created && created < del ? created : addK(del, -30), del, PHASE_COL.pre]);
    }
    const miles = [];
    if (del) miles.push({ k: del, title: 'Final delivery', c: TYPES.delivery[1] });
    items.filter((i) => i.kind === 'event' && ['review', 'delivery'].includes(i.type)).forEach((i) => miles.push({ k: i.sk, title: i.title, c: typeOf(i.type)[1] }));
    let start = ph.reduce((m, x) => (x[1] < m ? x[1] : m), ph[0][1]);
    let end = ph.reduce((m, x) => (x[2] > m ? x[2] : m), ph[0][2]);
    start = addK(start, -3); end = addK(end, 6);
    const inR = (k) => k >= start && k <= end;
    const span = diffK(start, end) + 1;
    const pos = (k) => (Math.max(0, Math.min(span, diffK(start, k))) / span) * 100;
    const months = [];
    for (let m = pd(start.slice(0, 7) + '-01'); keyOf(m) <= end; m.setMonth(m.getMonth() + 1, 1)) months.push(keyOf(m));
    const t = todayK();
    let box = '';
    if (view !== 'week') {
      const ms = cursor.slice(0, 7) + '-01';
      const me = addK(keyOf(new Date(pd(ms).getFullYear(), pd(ms).getMonth() + 1, 1)), 0);
      if (me > start && ms <= end) box = `<span class="cal-tl-box" style="inset-inline-start:${pos(ms)}%;width:${pos(me) - pos(ms)}%"></span>`;
    } else {
      const ws = weekStart(cursor), we = addK(ws, 7);
      if (we > start && ws <= end) box = `<span class="cal-tl-box" style="inset-inline-start:${pos(ws)}%;width:${Math.max(0.6, pos(we) - pos(ws))}%"></span>`;
    }
    const until = ss ? diffK(t, ss) : null;
    const status = ss && t < ss ? `Shoot in ${plural(until, 'day')}` : ss && t <= se ? `Shooting now · day ${diffK(ss, t) + 1} of ${diffK(ss, se) + 1}` : del && t <= del ? `Delivery in ${plural(diffK(t, del), 'day')}` : del ? 'Delivered' : '';
    return `
      <section class="panel cal-tl" aria-label="Production timeline">
        <div class="cal-tl-top"><span class="eyebrow">Production timeline</span>${status ? `<span class="cal-tl-status">${esc(status)}</span>` : ''}</div>
        <div class="cal-tl-grid">
          <div class="cal-tl-labels"><span class="cal-tl-axis-l"></span>${ph.map(([l, , , c]) => `<span class="cal-tl-l"><span class="dot" style="color:${c}"></span>${esc(l)}</span>`).join('')}${miles.length ? '<span class="cal-tl-l faint">Milestones</span>' : ''}</div>
          <div class="cal-tl-track">
            ${box}
            <div class="cal-tl-axis">${months.map((m) => `<span style="inset-inline-start:${pos(m)}%">${esc((ar() ? MONTHS_AR : MONTHS)[pd(m).getMonth()].slice(0, ar() ? 12 : 3))}</span>`).join('')}</div>
            ${ph.map(([l, s, e, c], i) => `<div class="cal-tl-row"><button class="cal-tl-bar" data-cal-jump="${s}" style="inset-inline-start:${pos(s)}%;width:${Math.max(1.2, pos(addK(e, 1)) - pos(s))}%;--c:${c};animation-delay:${i * 80}ms" title="${esc(l)}: ${MPH.date(s)} – ${MPH.date(e)}. Show on the calendar"><span class="truncate">${MPH.date(s)}${s !== e ? ' – ' + MPH.date(e) : ''}</span></button></div>`).join('')}
            ${miles.length ? `<div class="cal-tl-row">${miles.filter((m) => inR(m.k)).map((m) => `<button class="cal-tl-mile" data-cal-jump="${m.k}" style="inset-inline-start:${pos(m.k)}%;--c:${m.c}" title="${esc(m.title)} · ${MPH.date(m.k, 'long')}" aria-label="${esc(m.title)}, ${MPH.date(m.k, 'long')}"></button>`).join('')}</div>` : ''}
            ${inR(t) ? `<span class="cal-tl-today" style="inset-inline-start:${pos(t)}%"><span>Today</span></span>` : ''}
          </div>
        </div>
      </section>`;
  }

  /* ------------------------------------------------------------ month */
  function monthView(ctx, items, cursor) {
    const { ui } = ctx;
    const ym = cursor.slice(0, 7);
    const gs = weekStart(ym + '-01');
    const [y, m] = ym.split('-').map(Number);
    const ge = addK(weekStart(keyOf(new Date(y, m, 0))), 6);
    const n = diffK(gs, ge) + 1;
    const t = todayK();
    const ed = ctx.canEdit && !ctx.isClient;
    const sorted = items.slice().sort(order);
    const cells = [];
    for (let i = 0; i < n; i++) {
      const k = addK(gs, i);
      const evs = sorted.filter((it) => onDay(it, k));
      const shoot = evs.find((it) => it.kind === 'shoot');
      const shown = evs.slice(0, 3);
      cells.push(`
        <div class="cal-cell ${k.slice(0, 7) === ym ? '' : 'is-out'} ${isWknd(k) ? 'is-wknd' : ''} ${k === t ? 'is-today' : ''} ${shoot ? 'is-shoot' : ''} ${ed ? 'can-add' : ''}" data-cal-date="${k}" data-cal-drop="${k}">
          <div class="cal-cell-h">
            <button class="cal-dnum num" data-cal-week="${k}" aria-label="Show the week of ${MPH.date(k, 'long')}">${pd(k).getDate()}</button>
            ${ed ? `<button class="cal-add" data-cal-new="${k}" aria-label="Add an event on ${MPH.date(k, 'long')}" title="Add an event">${ui.icon('plus')}</button>` : ''}
          </div>
          <div class="cal-evs">
            ${shown.map((it) => chip(ctx, it, k)).join('')}
            ${evs.length > 3 ? `<button class="cal-more" data-cal-more="${k}">+${evs.length - 3} more</button>` : ''}
          </div>
        </div>`);
    }
    return `
      <div class="cal-month-wrap">
        <div class="cal-month" role="grid" aria-label="${monthLabel(ym + '-01')}">
          ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<div class="cal-dow ${i >= 5 ? 'is-wknd' : ''}">${dowName(i)}</div>`).join('')}
          ${cells.join('')}
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------ week (time grid) */
  function weekView(ctx, items, cursor) {
    const { ui, esc } = ctx;
    const ws = weekStart(cursor);
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addK(ws, i));
    const t = todayK();
    const ed = ctx.canEdit && !ctx.isClient;
    const hours = [];
    for (let h = H0; h < H1; h++) hours.push(h);
    const allDay = (k) => items.filter((it) => onDay(it, k) && (it.allDay || it.kind !== 'event')).sort(order);
    const timed = (k) => items.filter((it) => it.kind === 'event' && !it.allDay && it.sk === k).sort(order);
    const cols = days.map((k) => {
      const lanes = [];
      const placed = timed(k).map((it) => {
        const s = toMin(it.time);
        let en = it.end ? toMin(it.end) : s + 60;
        if (en <= s) en = 24 * 60; // runs past midnight: draw to the end of the day
        en = Math.max(s + 30, en);
        let lane = lanes.findIndex((endAt) => endAt <= s);
        if (lane < 0) { lane = lanes.length; lanes.push(en); } else lanes[lane] = en;
        return { it, s, en, lane };
      });
      const nl = Math.max(1, lanes.length);
      return `
        <div class="cal-col ${isWknd(k) ? 'is-wknd' : ''} ${k === t ? 'is-today' : ''} ${ed ? 'can-add' : ''}" data-cal-col="${k}" data-cal-drop="${k}" style="height:${(H1 - H0) * PX}px">
          ${placed.map(({ it, s, en, lane }) => {
            const color = typeOf(it.type)[1];
            const top = Math.max(0, ((Math.max(s, H0 * 60) - H0 * 60) / 60) * PX);
            const h = Math.max(22, ((Math.min(en, H1 * 60) - Math.max(s, H0 * 60)) / 60) * PX - 2);
            return `<div class="cal-block ${it.internal ? 'is-internal' : ''}" role="button" tabindex="0" data-cal-ev="${it.id}" data-cal-from="${k}" ${ed ? 'draggable="true"' : ''} style="--c:${color};top:${top}px;height:${h}px;inset-inline-start:calc(${(lane / nl) * 100}% + 2px);width:calc(${100 / nl}% - 4px)" title="${esc(it.title)} · ${esc(timeLabel(it))}">
              <span class="cal-block-t num">${it.internal ? ui.icon('lock') : ''}<bdi dir="ltr">${esc(timeLabel(it))}</bdi></span>
              <span class="cal-block-n" dir="auto">${esc(it.title)}</span>
              ${h > 50 && it.location ? `<span class="cal-block-l truncate" dir="auto">${esc(it.location)}</span>` : ''}
            </div>`;
          }).join('')}
          ${k === t ? (() => { const now = new Date(); const mm = now.getHours() * 60 + now.getMinutes(); return mm >= H0 * 60 ? `<span class="cal-now" style="top:${((mm - H0 * 60) / 60) * PX}px"></span>` : ''; })() : ''}
        </div>`;
    }).join('');
    return `
      <div class="cal-tg-wrap">
        <div class="cal-tg">
          <div class="cal-tg-corner"></div>
          ${days.map((k) => `<div class="cal-tg-dh ${isWknd(k) ? 'is-wknd' : ''} ${k === t ? 'is-today' : ''}"><span class="tiny">${dowName(pd(k).getDay())}</span><span class="cal-tg-dn num">${pd(k).getDate()}</span></div>`).join('')}
          <div class="cal-tg-corner tiny faint">All day</div>
          ${days.map((k) => `<div class="cal-tg-ad ${isWknd(k) ? 'is-wknd' : ''}" data-cal-drop="${k}">${allDay(k).map((it) => chip(ctx, it, k)).join('')}</div>`).join('')}
          <div class="cal-tg-hours">${hours.map((h) => `<span style="height:${PX}px" class="tiny faint num">${pad(h)}:00</span>`).join('')}</div>
          ${cols}
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------ agenda (phones) */
  function agendaView(ctx, items, cursor) {
    const { ui, esc } = ctx;
    const ym = cursor.slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const last = keyOf(new Date(y, m, 0));
    const t = todayK();
    const groups = [];
    for (let k = ym + '-01'; k <= last; k = addK(k, 1)) {
      const list = items.filter((it) => onDay(it, k)).sort(order);
      if (list.length) groups.push([k, list]);
    }
    if (!groups.length) {
      const ed = ctx.canEdit && !ctx.isClient;
      return `<div class="cal-ag-empty">${ui.empty('calendar-x-2', `Nothing on the calendar in ${monthLabel(ym + '-01')}`, ed ? 'Add a recce, casting session, fitting or client review, or move to another month.' : 'Move to another month to see what’s planned.',
        ed ? `<button class="btn btn-sm btn-primary" data-cal-new="${ym === t.slice(0, 7) ? t : ym + '-01'}">${ui.icon('plus')}Add event</button>` : '')}</div>`;
    }
    return `
      <div class="cal-agenda">
        ${groups.map(([k, list]) => `
          <section class="cal-ag-day ${k === t ? 'is-today' : ''} ${isWknd(k) ? 'is-wknd' : ''} ${k < t ? 'is-past' : ''}">
            <div class="cal-ag-date"><span class="cal-ag-dow">${dowName(pd(k).getDay())}</span><span class="cal-ag-dn num">${pd(k).getDate()}</span>${k === t ? '<span class="cal-ag-today">Today</span>' : ''}</div>
            <div class="cal-ag-list">${list.map((it) => agendaRow(ctx, it, k)).join('')}</div>
          </section>`).join('')}
      </div>`;
  }

  /* ------------------------------------------------------------ page */
  function renderPage(ctx, d) {
    const { ui, esc } = ctx;
    const p = ctx.production;
    const client = ctx.isClient;
    if (client && !d.shared) {
      return `
        <div class="page cal-page">
          ${ui.pageHead({ title: ctx.t('Calendar'), sub: esc(p.title) })}
          ${ui.panel({ body: ui.empty('calendar-days', 'The team hasn’t shared the calendar yet.', 'When they do, you’ll see prep dates, reviews, the shoot and delivery here.') })}
        </div>`;
    }
    const all = buildItems(ctx, d);
    const { view, cursor, off } = viewState(ctx, all);
    const items = all.filter((i) => !off.includes(i.type));
    const ed = ctx.canEdit && !client;
    const shared = !!p.share_calendar;

    let title;
    if (view === 'week') { const ws = weekStart(cursor), we = addK(ws, 6); title = `${MPH.date(ws)} – ${MPH.date(we)} ${we.slice(0, 4)}`; }
    else title = monthLabel(cursor);

    const internalN = d.events.filter((e) => e.internal).length;
    const upcoming = all.filter((i) => i.kind !== 'mile' && i.ek >= todayK()).length;
    const sub = client
      ? `Key dates for ${esc(p.title)}, shared by the production team.`
      : `Prep, shoot, post and client reviews for ${esc(p.title)}. ${upcoming ? `${plural(upcoming, 'date')} coming up.` : ''}`;
    const shareBtn = ctx.canSeeInternal && !client ? `
      <button class="cal-share ${shared ? 'on' : ''}" data-cal-share role="switch" aria-checked="${shared}" title="${shared ? 'Your client can see every event that isn’t marked internal' : 'Your client can’t open the calendar'}">
        <span class="toggle ${shared ? 'on' : ''}" aria-hidden="true"></span><span>Share with client</span>
      </button>` : '';
    const head = ui.pageHead({
      title: ctx.t('Calendar'), sub,
      actions: `${shareBtn}${ed ? `<button class="btn btn-sm btn-primary" data-cal-new="${cursor.slice(0, 7) === todayK().slice(0, 7) ? todayK() : cursor}">${ui.icon('plus')}Add event</button>` : ''}`,
    });

    const counts = {};
    all.forEach((i) => { counts[i.type] = (counts[i.type] || 0) + 1; });
    const present = Object.keys(TYPES).filter((k) => counts[k]);
    const note = client
      ? `<span class="tiny muted cal-note">${ui.icon('eye')}Showing the dates the team shared with you.</span>`
      : !shared
        ? `<span class="tiny muted cal-note">${ui.icon('eye-off')}Not shared with the client.</span>`
        : `<span class="tiny muted cal-note">${ui.icon('lock')}${internalN ? `${plural(internalN, 'internal event')} hidden from the client.` : 'Mark an event internal to hide it from the client.'}</span>`;
    const legend = `
      <div class="cal-legend" role="group" aria-label="Filter by type">
        ${present.length > 1 ? present.map((k) => {
          const [label, color] = TYPES[k];
          const isOn = !off.includes(k);
          return `<button class="chip cal-type ${isOn ? 'on' : ''}" style="--c:${color}" data-cal-type="${k}" aria-pressed="${isOn}"><span class="dot"></span>${label}<span class="tiny faint num">${counts[k]}</span></button>`;
        }).join('') : ''}
        ${off.length ? `<button class="btn btn-xs btn-ghost" data-cal-alltypes>Show all</button>` : ''}
        <span class="spacer"></span>${note}
      </div>`;

    const toolbar = `
      <div class="cal-toolbar">
        <div class="row cal-nav">
          <button class="btn btn-sm btn-outline btn-icon" data-cal-nav="-1" aria-label="${view === 'week' ? 'Previous week' : 'Previous month'}">${ui.icon('chevron-left', 'cal-flip')}</button>
          <button class="btn btn-sm btn-outline btn-icon" data-cal-nav="1" aria-label="${view === 'week' ? 'Next week' : 'Next month'}">${ui.icon('chevron-right', 'cal-flip')}</button>
          <button class="btn btn-sm btn-ghost" data-cal-today>Today</button>
          <h2 class="h2 cal-title" aria-live="polite">${esc(title)}</h2>
        </div>
        <span class="spacer"></span>
        <div class="seg" role="group" aria-label="Calendar view">${[['month', 'Month', 'calendar-days'], ['week', 'Week', 'calendar-range'], ['agenda', 'Agenda', 'list']].map(([k, l, ic]) => `<button class="${view === k ? 'on' : ''}" data-cal-view="${k}" aria-pressed="${view === k}">${ui.icon(ic)}${l}</button>`).join('')}</div>
      </div>`;

    const body = view === 'week' ? weekView(ctx, items, cursor) : view === 'agenda' ? agendaView(ctx, items, cursor) : monthView(ctx, items, cursor);
    const starter = ed && !d.events.length ? `
      <div class="callout cal-starter">${ui.icon('calendar-plus')}
        <div class="stack tight grow" style="gap:4px">
          <span class="strong small">Plan the dates around the shoot</span>
          <span class="small">Add the recces, casting sessions, fittings, the pre-production meeting and client reviews. ${view === 'agenda' ? 'Use Add event to start.' : 'Click any day to add an event'}${d.days.some((x) => x.date) ? '; shoot days from the stripboard are already here.' : '.'}</span>
        </div>
      </div>` : '';

    return `
      <div class="page full cal-page" data-view="${view}">
        ${head}
        ${timeline(ctx, d, all, view, cursor)}
        ${starter}
        <div class="panel cal-panel">
          <div class="cal-head">${toolbar}${legend}</div>
          ${body}
          ${view === 'month' ? `<p class="tiny faint cal-foot">${ui.icon('info')}Friday and Saturday are shaded as the weekend.${ed ? ' Drag an event to another day to move it; its times stay the same.' : ''}</p>` : ''}
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------ event editor */
  function openEditor(ctx, d, ev, preset, paint) {
    const { ui, esc } = ctx;
    const isNew = !ev;
    const s = ev ? new Date(ev.starts_at) : null;
    const en = ev && ev.ends_at ? new Date(ev.ends_at) : null;
    const v = {
      title: ev ? ev.title : '', type: ev ? ev.type : (preset.type || 'meeting'),
      date: ev ? keyOf(s) : preset.date, allDay: ev ? !!ev.all_day : !!preset.allDay,
      start: ev && !ev.all_day ? hm(s) : (preset.start || '09:00'),
      end: ev && !ev.all_day ? (en ? hm(en) : '') : (preset.end || fromMin((toMin(preset.start || '09:00') + 60) % 1440)),
      endDate: ev && ev.all_day && en && keyOf(en) > keyOf(s) ? keyOf(en) : '',
      location: ev ? ev.location || '' : '', notes: ev ? ev.notes || '' : '', internal: ev ? !!ev.internal : false,
    };
    const att = ev ? [...(ev.attendees || [])] : [];
    const locNames = [...new Set([...(d.locs || []).map((l) => l.name), ...(d.days || []).map((x) => x.location)].filter(Boolean))];
    const people = [...new Set((d.people || []).map((x) => x.name).filter(Boolean))];
    const el = ctx.modal(ctx.frame({
      title: isNew ? 'Add event' : 'Edit event',
      sub: isNew ? `On the ${esc(ctx.production.title)} calendar` : esc(ev.title),
      body: `
        <form class="stack cal-form" data-cal-form novalidate>
          <div class="field"><label for="ce-title">Title</label><input id="ce-title" class="input" dir="auto" maxlength="160" value="${esc(v.title)}" placeholder="e.g. Recce: Al Thumamah dunes"></div>
          <div class="field">
            <span class="label">Type</span>
            <div class="cal-types" role="radiogroup" aria-label="Event type">${Object.entries(TYPES).map(([k, [l, c, ic]]) => `
              <button type="button" class="cal-type-opt ${v.type === k ? 'on' : ''}" style="--c:${c}" role="radio" aria-checked="${v.type === k}" data-type-opt="${k}">${ui.icon(ic)}${l}</button>`).join('')}</div>
          </div>
          <div class="grid-2">
            <div class="field"><label for="ce-date">${v.allDay ? 'First day' : 'Date'}</label><input id="ce-date" class="input" type="date" value="${esc(v.date || '')}"></div>
            <div class="field cal-allday-f"><span class="label">&nbsp;</span><label class="check"><input type="checkbox" id="ce-allday" ${v.allDay ? 'checked' : ''}>All day</label></div>
          </div>
          <div class="grid-2" data-timed ${v.allDay ? 'hidden' : ''}>
            <div class="field"><label for="ce-start">Starts</label><input id="ce-start" class="input" type="time" value="${esc(v.start)}"></div>
            <div class="field"><label for="ce-end">Ends</label><input id="ce-end" class="input" type="time" value="${esc(v.end)}"></div>
          </div>
          <div class="grid-2" data-allday ${v.allDay ? '' : 'hidden'}>
            <div class="field"><label for="ce-enddate">Last day (optional)</label><input id="ce-enddate" class="input" type="date" value="${esc(v.endDate)}"><span class="tiny faint">For something that runs over several days, like an offline edit.</span></div>
          </div>
          <div class="field"><label for="ce-loc">Location (optional)</label><input id="ce-loc" class="input" dir="auto" maxlength="200" list="ce-locs" value="${esc(v.location)}" placeholder="e.g. Qamar Creative, King Fahd Rd"><datalist id="ce-locs">${locNames.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist></div>
          <div class="field">
            <label for="ce-att">Attendees (optional)</label>
            <div class="cal-att-box" data-att-box>
              <span class="cal-att-chips" data-att-chips></span>
              <input id="ce-att" class="cal-att-input" dir="auto" maxlength="80" list="ce-people" placeholder="Type a name and press Enter" autocomplete="off">
              <datalist id="ce-people">${people.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
            </div>
          </div>
          <div class="field"><label for="ce-notes">Notes (optional)</label><textarea id="ce-notes" class="textarea" dir="auto" maxlength="4000" style="min-height:70px" placeholder="What to bring, who drives, what needs deciding…">${esc(v.notes)}</textarea></div>
          <label class="cal-int-row">
            <input type="checkbox" id="ce-internal" ${v.internal ? 'checked' : ''}>
            <span class="toggle ${v.internal ? 'on' : ''}" aria-hidden="true"></span>
            <span class="stack" style="gap:1px"><span class="small strong">Internal (hidden from client)</span><span class="tiny muted">Cost reviews, rate negotiations, anything the client shouldn’t see.</span></span>
          </label>
          <div data-ce-error hidden></div>
        </form>`,
      foot: `${isNew ? '' : `<button class="btn btn-ghost cal-del" data-ce-del>${ui.icon('trash-2')}Delete</button>`}<span class="spacer"></span>
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" data-ce-save>${isNew ? `${ui.icon('plus')}Add event` : 'Save changes'}</button>`,
    }));
    let type = TYPES[v.type] ? v.type : 'other';
    const $ = (sel) => el.querySelector(sel);
    const attInput = $('#ce-att');
    const paintAtt = () => {
      $('[data-att-chips]').innerHTML = att.map((n, i) => `<span class="cal-att-chip" dir="auto">${esc(n)}<button type="button" data-att-rm="${i}" aria-label="Remove ${esc(n)}">${ui.icon('x')}</button></span>`).join('');
      MPH.icons();
    };
    const addAtt = (raw) => {
      String(raw || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((n) => {
        if (att.length < 40 && !att.some((a) => a.toLowerCase() === n.toLowerCase())) att.push(n.slice(0, 80));
      });
      attInput.value = '';
      paintAtt();
    };
    paintAtt();
    const err = (m) => { const b = $('[data-ce-error]'); b.hidden = false; b.innerHTML = ui.errorBox(m); MPH.icons(); };

    el.addEventListener('click', (e) => {
      let b;
      if ((b = e.target.closest('[data-type-opt]'))) {
        type = b.dataset.typeOpt;
        el.querySelectorAll('[data-type-opt]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      } else if ((b = e.target.closest('[data-att-rm]'))) { att.splice(Number(b.dataset.attRm), 1); paintAtt(); attInput.focus(); }
      else if (e.target.closest('[data-att-box]') && !e.target.closest('input')) attInput.focus();
      else if ((b = e.target.closest('[data-ce-save]'))) save(b);
      else if ((b = e.target.closest('[data-ce-del]'))) del(b);
    });
    $('#ce-allday').addEventListener('change', (e) => {
      const on = e.target.checked;
      $('[data-timed]').hidden = on; $('[data-allday]').hidden = !on;
      $('label[for="ce-date"]').textContent = on ? 'First day' : 'Date';
    });
    $('#ce-internal').addEventListener('change', (e) => $('.cal-int-row .toggle').classList.toggle('on', e.target.checked));
    attInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); e.stopPropagation(); if (attInput.value.trim()) addAtt(attInput.value); }
      else if (e.key === 'Backspace' && !attInput.value && att.length) { att.pop(); paintAtt(); }
    });
    attInput.addEventListener('input', (e) => {
      // a name picked from the suggestions list goes straight in as a chip
      if ((!e.inputType || e.inputType === 'insertReplacementText') && people.includes(attInput.value)) addAtt(attInput.value);
    });
    attInput.addEventListener('blur', () => { if (attInput.value.trim()) addAtt(attInput.value); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('input:not(#ce-att):not([type=checkbox])')) { e.preventDefault(); save($('[data-ce-save]')); }
    });
    el.addEventListener('submit', (e) => e.preventDefault());

    async function save(btn) {
      if (!btn || btn.disabled) return;
      if (attInput.value.trim()) addAtt(attInput.value);
      const title = clean($('#ce-title').value, 160);
      const date = $('#ce-date').value;
      const allDay = $('#ce-allday').checked;
      if (!title) { $('#ce-title').focus(); return err('Give the event a title.'); }
      if (!date) return err('Choose the date.');
      let starts, ends = null;
      if (allDay) {
        starts = new Date(`${date}T00:00:00`);
        const endDate = $('#ce-enddate').value;
        if (endDate && endDate < date) return err('The last day can’t be before the first day.');
        if (endDate && endDate > date) ends = new Date(`${endDate}T00:00:00`);
      } else {
        const st = $('#ce-start').value || '09:00';
        const et = $('#ce-end').value;
        starts = new Date(`${date}T${st}`);
        if (et) { ends = new Date(`${date}T${et}`); if (ends <= starts) ends.setDate(ends.getDate() + 1); }
      }
      if (isNaN(starts) || (ends && isNaN(ends))) return err('That date or time doesn’t look right.');
      const row = {
        title, type, all_day: allDay, starts_at: starts.toISOString(), ends_at: ends ? ends.toISOString() : null,
        location: clean($('#ce-loc').value, 200), notes: clean($('#ce-notes').value, 4000), attendees: att.slice(), internal: $('#ce-internal').checked,
      };
      btn.disabled = true;
      try {
        if (isNew) {
          const ins = ctx.api.must(await ctx.sb.from('events').insert({ ...row, production_id: ctx.production.id, created_by: ctx.session.user.id }).select().single());
          d.events.push(ins);
          ctx.toast(`${title} added on ${MPH.date(date, 'day')}`, 'calendar-check');
        } else {
          ctx.api.must(await ctx.sb.from('events').update(row).eq('id', ev.id));
          Object.assign(ev, row);
          ctx.toast(`${title} saved`, 'calendar-check');
        }
        ctx.state.calCursor = date;
        ctx.closeOverlay();
        paint();
      } catch (ex) { btn.disabled = false; err(ex.message); }
    }

    async function del(btn) {
      if (!btn.dataset.armed) {
        btn.dataset.armed = '1';
        btn.classList.add('is-armed');
        btn.innerHTML = `${ui.icon('trash-2')}Delete this event?`; MPH.icons();
        setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.classList.remove('is-armed'); btn.innerHTML = `${ui.icon('trash-2')}Delete`; MPH.icons(); } }, 3500);
        return;
      }
      btn.disabled = true;
      try {
        ctx.api.must(await ctx.sb.from('events').delete().eq('id', ev.id));
        d.events = d.events.filter((x) => x.id !== ev.id);
        ctx.closeOverlay();
        paint();
        ctx.toast(`${ev.title} deleted`, 'trash-2');
      } catch (ex) { btn.disabled = false; err(ex.message); }
    }
  }

  /* ------------------------------------------------------------ read-only detail (clients and viewers) */
  function openDetail(ctx, d, it) {
    const { ui, esc } = ctx;
    const e = it.ev;
    const [label, color, icon] = typeOf(it.type);
    const when = it.allDay
      ? (it.ek !== it.sk ? `${MPH.date(it.sk, 'long')} – ${MPH.date(it.ek, 'long')}` : `${MPH.date(it.sk, 'long')} · all day`)
      : `${MPH.date(it.sk, 'long')} · <bdi dir="ltr">${esc(timeLabel(it))}</bdi>`;
    ctx.drawer(ctx.frame({
      title: `<span dir="auto">${esc(it.title)}</span>`,
      sub: esc(ctx.production.title),
      body: `
        <div class="row wrap"><span class="cal-type-pill" style="--c:${color}">${ui.icon(icon)}${label}</span>${it.internal ? ui.lockNote('Internal. Clients never see this event.') : ''}</div>
        <dl class="kv">
          <dt>When</dt><dd>${when}</dd>
          ${it.location ? `<dt>Where</dt><dd dir="auto">${esc(it.location)}<br><a class="tiny accent" href="${esc(mapsHref(it.location))}" target="_blank" rel="noopener">Open in Maps</a></dd>` : ''}
          ${e.attendees && e.attendees.length ? `<dt>Attendees</dt><dd><div class="row wrap" style="gap:4px">${e.attendees.map((n) => `<span class="cal-att-chip ro" dir="auto">${esc(n)}</span>`).join('')}</div></dd>` : ''}
          ${e.notes ? `<dt>Notes</dt><dd class="small cal-notes" dir="auto">${esc(e.notes)}</dd>` : ''}
        </dl>`,
      foot: '<button class="btn btn-primary" data-close>Close</button>',
    }));
  }

  /* ------------------------------------------------------------ one day's list (+N more) */
  function openDayList(ctx, d, k, items, onPick) {
    const list = items.filter((it) => onDay(it, k)).sort(order);
    const el = ctx.drawer(ctx.frame({
      title: MPH.date(k, 'long'),
      sub: plural(list.length, 'item'),
      body: `<div class="cal-agenda is-drawer"><div class="cal-ag-list">${list.map((it) => agendaRow(ctx, it, k)).join('')}</div></div>`,
      foot: ctx.canEdit && !ctx.isClient ? `<button class="btn btn-ghost" data-close>Close</button><button class="btn btn-primary" data-dl-new>${ctx.ui.icon('plus')}Add event on this day</button>` : '<button class="btn btn-primary" data-close>Close</button>',
    }));
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cal-ev]');
      if (b) return onPick(b.dataset.calEv);
      if (e.target.closest('[data-dl-new]')) onPick(null, k);
      if (e.target.closest('a[href]')) ctx.closeOverlay();
    });
  }

  /* ------------------------------------------------------------ view */
  MPH.view('calendar', {
    async load(ctx) {
      const pid = ctx.production.id;
      if (ctx.isClient) {
        // producers previewing see exactly what a client sees: nothing unless shared, and never internal events
        if (!ctx.production.share_calendar) return { shared: false, events: [], days: [] };
        const ev = await ctx.sb.from('events').select(CLIENT_COLS).eq('production_id', pid).eq('internal', false).order('starts_at');
        return { shared: true, events: ctx.api.must(ev) || [], days: [] };
      }
      const none = Promise.resolve({ data: [], error: null });
      const [ev, days, people, locs] = await Promise.all([
        ctx.sb.from('events').select('*').eq('production_id', pid).order('starts_at'),
        ctx.sb.from('shoot_days').select('id, day_no, date, location, crew_call, wrap').eq('production_id', pid).order('day_no'),
        ctx.canEdit ? ctx.sb.from('people').select('name').eq('production_id', pid) : none,
        ctx.canEdit ? ctx.sb.from('locations').select('name').eq('production_id', pid) : none,
      ]);
      return {
        shared: true, events: ctx.api.must(ev) || [], days: ctx.api.must(days) || [],
        people: people.error ? [] : people.data || [], locs: locs.error ? [] : locs.data || [],
      };
    },

    render: renderPage,

    mount(root, ctx, d) {
      if (ctx.isClient && !d.shared) return;
      const st = ctx.state;
      const ed = ctx.canEdit && !ctx.isClient;
      const paint = () => { if (!root.isConnected) return; root.innerHTML = renderPage(ctx, d); MPH.icons(); };
      const findEv = (id) => d.events.find((x) => x.id === id);
      const itemFor = (id) => buildItems(ctx, d).find((x) => x.id === id);
      const openEv = (id) => {
        const ev = findEv(id);
        if (!ev) return;
        if (ed) openEditor(ctx, d, ev, {}, paint);
        else { const it = itemFor(id); if (it) openDetail(ctx, d, it); }
      };
      const create = (preset) => { if (ed) openEditor(ctx, d, null, preset, paint); };

      root.addEventListener('click', async (e) => {
        const t = e.target;
        let b;
        if ((b = t.closest('[data-cal-type]'))) {
          const off = new Set(st.calOff || []); const k = b.dataset.calType;
          if (off.has(k)) off.delete(k); else off.add(k);
          st.calOff = [...off]; return paint();
        }
        if (t.closest('[data-cal-alltypes]')) { st.calOff = []; return paint(); }
        if ((b = t.closest('[data-cal-view]'))) { st.calView = b.dataset.calView; return paint(); }
        if ((b = t.closest('[data-cal-nav]'))) {
          const n = Number(b.dataset.calNav);
          if (st.calView === 'week') st.calCursor = addK(st.calCursor, 7 * n);
          else { const c = pd(st.calCursor); st.calCursor = keyOf(new Date(c.getFullYear(), c.getMonth() + n, 1)); }
          return paint();
        }
        if (t.closest('[data-cal-today]')) { st.calCursor = todayK(); return paint(); }
        if ((b = t.closest('[data-cal-jump]'))) { st.calCursor = b.dataset.calJump; return paint(); }
        if ((b = t.closest('[data-cal-week]'))) { st.calCursor = b.dataset.calWeek; st.calView = 'week'; return paint(); }
        if ((b = t.closest('[data-cal-more]'))) {
          const all = buildItems(ctx, d).filter((i) => !(st.calOff || []).includes(i.type));
          return openDayList(ctx, d, b.dataset.calMore, all, (id, k) => { if (id) openEv(id); else create({ date: k }); });
        }
        if ((b = t.closest('[data-cal-new]'))) return create({ date: b.dataset.calNew });
        if ((b = t.closest('[data-cal-ev]'))) return openEv(b.dataset.calEv);
        if ((b = t.closest('[data-cal-share]'))) {
          if (!ctx.canSeeInternal || b.disabled) return;
          const on = !ctx.production.share_calendar;
          b.disabled = true;
          try {
            ctx.api.must(await ctx.sb.from('productions').update({ share_calendar: on }).eq('id', ctx.production.id));
            ctx.production.share_calendar = on;
            paint();
            ctx.toast(on ? 'Calendar shared. Your client sees every event not marked internal.' : 'Calendar hidden from your client', on ? 'eye' : 'eye-off');
          } catch (ex) { b.disabled = false; ctx.toastError(ex); }
          return;
        }
        if (!ed || t.closest('a, button, [role=button]')) return;
        // click on empty space: a month cell creates an all-day-or-timed event on that day; a week column at that time
        if ((b = t.closest('[data-cal-col]'))) {
          const r = b.getBoundingClientRect();
          const mins = Math.min(23 * 60, H0 * 60 + Math.max(0, Math.floor(((e.clientY - r.top) / PX) * 2)) * 30);
          return create({ date: b.dataset.calCol, start: fromMin(mins), end: fromMin(Math.min(mins + 60, 23 * 60 + 59)) });
        }
        if ((b = t.closest('[data-cal-date]'))) return create({ date: b.dataset.calDate });
      });

      root.addEventListener('keydown', (e) => {
        const b = e.target.closest('[data-cal-ev]');
        if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openEv(b.dataset.calEv); }
      });

      if (!ed) return;
      /* drag an event to another day: both ends move by the same number of days, so times and duration stay */
      let drag = null;
      root.addEventListener('dragstart', (e) => {
        const c = e.target.closest && e.target.closest('[data-cal-ev][draggable]');
        if (!c) return;
        drag = { id: c.dataset.calEv, from: c.dataset.calFrom };
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', drag.id); } catch (err) { /* restricted */ }
        requestAnimationFrame(() => { root.querySelectorAll(`[data-cal-ev="${drag && drag.id}"]`).forEach((x) => x.classList.add('is-dragging')); root.querySelector('.cal-panel')?.classList.add('is-dragging'); });
      });
      const clear = () => root.querySelectorAll('.is-drop').forEach((x) => x.classList.remove('is-drop'));
      root.addEventListener('dragover', (e) => {
        if (!drag) return;
        const z = e.target.closest && e.target.closest('[data-cal-drop]');
        if (!z) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!z.classList.contains('is-drop')) { clear(); z.classList.add('is-drop'); }
      });
      root.addEventListener('dragleave', (e) => { if (e.target === root) clear(); });
      root.addEventListener('drop', async (e) => {
        const z = e.target.closest && e.target.closest('[data-cal-drop]');
        if (!z || !drag) return;
        e.preventDefault();
        const { id, from } = drag; drag = null;
        clear();
        const to = z.dataset.calDrop;
        const delta = diffK(from, to);
        const ev = findEv(id);
        if (!ev || !delta) return paint();
        const shift = (iso) => { if (!iso) return null; const x = new Date(iso); x.setDate(x.getDate() + delta); return x.toISOString(); };
        const prev = { starts_at: ev.starts_at, ends_at: ev.ends_at };
        const next = { starts_at: shift(ev.starts_at), ends_at: shift(ev.ends_at) };
        Object.assign(ev, next);
        paint();
        try {
          ctx.api.must(await ctx.sb.from('events').update(next).eq('id', id));
          ctx.toast(`${ev.title} moved to ${MPH.date(keyOf(new Date(next.starts_at)), 'day')}`, 'move');
        } catch (ex) { Object.assign(ev, prev); paint(); ctx.toastError(new Error(`The move didn’t save: ${ex.message}`)); }
      });
      root.addEventListener('dragend', () => {
        drag = null; clear();
        root.querySelectorAll('.is-dragging').forEach((x) => x.classList.remove('is-dragging'));
      });
    },
  });
})();

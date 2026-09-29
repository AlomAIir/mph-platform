/* Locations (#p.<id>.locations) — team only
   Every place the production shoots: address and map link, contact with WhatsApp, permit status and reference,
   parking, nearest hospital, power, access, notes and recce photos (media bucket, <pid>/internal/locations/).
   A permit tracker counts needed / applied / approved / refused and warns when a shoot day in the next 14 days
   uses a location whose permit isn't cleared. The shoot-day panel links each day to a location: it writes
   shoot_days.location_id and shoot_days.location (the name), so the stripboard and call sheets keep working. */
(function () {
  const PERMIT = {
    needed: ['Permit needed', 'warn', 'file-warning'],
    applied: ['Applied', 'info', 'send'],
    approved: ['Approved', 'ok', 'badge-check'],
    refused: ['Refused', 'danger', 'circle-x'],
    not_needed: ['No permit needed', '', 'circle-minus'],
  };
  const TRACK = ['needed', 'applied', 'approved', 'refused'];
  const TRACK_COL = { needed: 'var(--warn)', applied: 'var(--info)', approved: 'var(--ok)', refused: 'var(--danger)', not_needed: 'var(--line-2)' };
  const KINDS = ['Studio', 'Residential', 'Heritage site', 'Desert', 'Desert camp', 'Office', 'Retail', 'Restaurant or café', 'Street', 'Hotel', 'Warehouse', 'Farm', 'Vehicle', 'Other'];
  const MAX_MB = 15;
  const WARN_DAYS = 14;

  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayK = () => keyOf(new Date());
  const diffK = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const clean = (v, max = 300) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
  const cleared = (s) => s === 'approved' || s === 'not_needed';
  const permitOf = (s) => PERMIT[s] || PERMIT.needed;
  const safeUrl = (u) => { const s = String(u || '').trim(); return /^https?:\/\/\S+$/i.test(s) ? s : ''; };
  const mapsFor = (l) => safeUrl(l.maps_url) || (l.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(l.address)}` : '');
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const permitPill = (s) => { const [l, k, ic] = permitOf(s); return MPH.ui.pill(l, k, ic); };
  const daysFor = (d, loc) => d.days.filter((x) => x.location_id === loc.id).sort((a, b) => a.day_no - b.day_no);
  const dayLabel = (x) => `Day ${x.day_no}${x.date ? ' · ' + MPH.date(x.date, 'day') : ''}`;

  /* shoot days in the next 14 days on a location whose permit isn't cleared */
  function permitRisks(d) {
    const t = todayK();
    return d.days.filter((x) => x.date && x.location_id && diffK(t, x.date) >= 0 && diffK(t, x.date) <= WARN_DAYS)
      .map((x) => ({ day: x, loc: d.locs.find((l) => l.id === x.location_id) }))
      .filter((r) => r.loc && !cleared(r.loc.permit_status))
      .sort((a, b) => (a.day.date < b.day.date ? -1 : 1));
  }

  function photoBox(ctx, d, l, cls = '') {
    const { ui, esc } = ctx;
    const first = (l.photo_paths || []).find((p) => d.urls[p]);
    const h = MPH.hue(l.name);
    return `
      <div class="loc-ph ${cls} ${first ? '' : 'is-empty'}" style="--h:${h}">
        ${first ? `<img src="${esc(d.urls[first])}" alt="${esc(l.name)}" loading="lazy">` : `<span class="loc-ph-glyph">${ui.icon('map-pin')}</span>`}
        ${l.kind ? `<span class="loc-ph-tag">${esc(l.kind)}</span>` : ''}
        ${(l.photo_paths || []).length > 1 ? `<span class="loc-ph-count">${ui.icon('images')}${l.photo_paths.length}</span>` : ''}
      </div>`;
  }

  function waFor(ctx, l) {
    const n = ctx.ui.waNumber(l.contact_phone);
    if (n.length < 8) return '';
    const me = ctx.session && ctx.session.profile && ctx.session.profile.full_name;
    const hi = l.contact_name ? `Hi ${String(l.contact_name).trim().split(/\s+/)[0]}` : 'Hello';
    return ctx.ui.waLink(n, `${hi}, ${me ? `this is ${me} ` : ''}about filming ${ctx.production.title} at ${l.name}.`);
  }

  /* ------------------------------------------------------------ page pieces */
  function card(ctx, d, l, i) {
    const { ui, esc } = ctx;
    const days = daysFor(d, l);
    const wa = waFor(ctx, l);
    return `
      <article class="loc-card" data-loc="${l.id}" role="button" tabindex="0" aria-label="Open ${esc(l.name)}" style="animation-delay:${Math.min(i, 12) * 40}ms">
        ${photoBox(ctx, d, l)}
        <div class="loc-card-body">
          <div class="row" style="gap:6px"><span class="loc-card-name truncate grow" dir="auto">${esc(l.name)}</span>${days.length ? `<span class="pill accent">${days.length === 1 ? 'Day' : 'Days'} ${days.map((x) => x.day_no).join(', ')}</span>` : ''}</div>
          <span class="tiny muted row loc-line">${ui.icon('map-pin')}<span class="truncate" dir="auto">${l.address ? esc(l.address) : '<span class="faint">No address yet</span>'}</span></span>
          <div class="row wrap" style="gap:6px">${permitPill(l.permit_status)}${l.permit_ref ? `<span class="tiny mono muted truncate">${esc(l.permit_ref)}</span>` : ''}</div>
          ${l.contact_name || l.contact_phone ? `
            <div class="row loc-line tiny muted">${ui.icon('user-round')}<span class="truncate grow" dir="auto">${esc(l.contact_name || l.contact_phone)}</span>
              ${wa ? `<a class="loc-wa" href="${esc(wa)}" target="_blank" rel="noopener" title="Message ${esc(l.contact_name || 'the contact')} on WhatsApp" aria-label="Message ${esc(l.contact_name || 'the location contact')} on WhatsApp">${ui.wa(16)}</a>` : ''}
            </div>` : ''}
        </div>
      </article>`;
  }

  function tracker(ctx, d) {
    const { ui, esc } = ctx;
    const n = d.locs.length;
    const counts = { needed: 0, applied: 0, approved: 0, refused: 0, not_needed: 0 };
    d.locs.forEach((l) => { counts[PERMIT[l.permit_status] ? l.permit_status : 'needed'] += 1; });
    const ok = counts.approved + counts.not_needed;
    const f = ctx.state.locFilter;
    const risks = permitRisks(d);
    const seg = (k) => counts[k] ? `<span style="flex:${counts[k]};background:${TRACK_COL[k]}" title="${esc(permitOf(k)[0])}: ${counts[k]}"></span>` : '';
    return `
      <section class="panel loc-tracker">
        <div class="loc-track-head">
          <span class="row" style="gap:8px">${ui.icon('file-badge')}<span class="h3">Permit tracker</span></span>
          <span class="spacer"></span>
          <span class="small muted num">${ok} of ${plural(n, 'location')} cleared${counts.not_needed ? ` · ${counts.not_needed} need no permit` : ''}</span>
        </div>
        <div class="loc-track-bar" aria-hidden="true">${[...TRACK, 'not_needed'].map(seg).join('')}</div>
        <div class="loc-track-stats" role="group" aria-label="Filter by permit status">
          ${TRACK.map((k) => `
            <button class="loc-track-stat ${f === k ? 'on' : ''}" data-loc-filter="${k}" aria-pressed="${f === k}" style="--c:${TRACK_COL[k]}">
              <span class="loc-track-v num">${counts[k]}</span>
              <span class="loc-track-l"><span class="dot"></span>${esc(k === 'needed' ? 'Needed' : permitOf(k)[0])}</span>
            </button>`).join('')}
        </div>
        ${risks.length ? `<div class="loc-risks">${risks.map((r) => {
          const until = diffK(todayK(), r.day.date);
          return `<button class="loc-risk" data-loc="${r.loc.id}">
            ${ui.icon('triangle-alert')}
            <span class="grow small"><strong>${esc(dayLabel(r.day))}</strong> at <span dir="auto">${esc(r.loc.name)}</span>: permit ${r.loc.permit_status === 'refused' ? 'refused' : r.loc.permit_status === 'applied' ? 'applied for, not approved yet' : 'not applied for yet'}.
            <span class="muted">${until === 0 ? 'Shooting today.' : until === 1 ? 'Shooting tomorrow.' : `${until} days to go.`}</span></span>
            ${ui.icon('chevron-right', 'loc-flip faint')}
          </button>`;
        }).join('')}</div>` : counts.needed + counts.applied + counts.refused && d.days.some((x) => x.date && x.location_id) ? `<p class="tiny faint loc-risk-none">${ui.icon('circle-check')}No shoot day in the next ${WARN_DAYS} days is waiting on a permit.</p>` : ''}
      </section>`;
  }

  function dayPanel(ctx, d) {
    const { ui, esc } = ctx;
    const pid = ctx.production.id;
    const days = d.days.slice().sort((a, b) => a.day_no - b.day_no);
    const ed = ctx.canEdit;
    const pending = days.filter((x) => !x.location_id && clean(x.location));
    let body;
    if (!days.length) {
      body = `<div class="loc-side-empty">${ui.icon('calendar-plus')}<span class="small muted">Add shoot days on the stripboard, then choose where each one happens here.</span><a class="btn btn-sm btn-outline" href="#p.${pid}.stripboard">${ui.icon('rows-3')}Open stripboard</a></div>`;
    } else {
      const t = todayK();
      body = `
        ${ed && pending.length ? `
          <div class="loc-link-note">
            <span class="small">${plural(pending.length, 'shoot day has', 'shoot days have')} a location typed on the stripboard but not linked here.</span>
            <button class="btn btn-xs btn-outline" data-loc-import>${ui.icon('link')}Link ${pending.length === 1 ? 'it' : 'them'}</button>
          </div>` : ''}
        <div class="loc-days">${days.map((x) => {
          const loc = d.locs.find((l) => l.id === x.location_id);
          const soon = x.date && diffK(t, x.date) >= 0 && diffK(t, x.date) <= WARN_DAYS;
          const risk = loc && soon && !cleared(loc.permit_status);
          return `
            <div class="loc-day ${risk ? 'is-risk' : ''} ${x.date && x.date < t ? 'is-past' : ''}">
              <div class="loc-day-n"><strong>Day ${esc(x.day_no)}</strong><span class="tiny muted">${x.date ? MPH.date(x.date, 'day') : 'No date'}</span></div>
              <div class="loc-day-pick">
                ${ed ? `<select class="select loc-day-sel" data-day-loc="${x.id}" aria-label="Location for day ${esc(x.day_no)}">
                    <option value="">No location yet</option>
                    ${d.locs.map((l) => `<option value="${l.id}" ${l.id === x.location_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
                  </select>`
                  : `<span class="small" dir="auto">${loc ? esc(loc.name) : '<span class="faint">No location yet</span>'}</span>`}
                ${!loc && x.location ? `<span class="tiny faint truncate" dir="auto" title="${esc(x.location)}">Stripboard: ${esc(x.location)}</span>` : ''}
                ${risk ? `<span class="tiny loc-day-warn">${ui.icon('triangle-alert')}Permit ${loc.permit_status === 'refused' ? 'refused' : 'not approved'}</span>` : ''}
              </div>
            </div>`;
        }).join('')}</div>`;
    }
    return `
      <aside class="loc-side">
        ${ui.panel({ title: 'Shoot days', icon: 'calendar-days', flush: true, actions: days.length ? `<a class="btn btn-xs btn-ghost" href="#p.${pid}.stripboard">Stripboard${ui.icon('chevron-right', 'loc-flip')}</a>` : '', body })}
      </aside>`;
  }

  function renderPage(ctx, d) {
    const { ui, esc } = ctx;
    const p = ctx.production;
    const ed = ctx.canEdit;
    const market = `<a class="btn btn-ghost btn-sm loc-market" href="${esc(window.MPH_CONFIG.demoUrl)}#market.locations" target="_blank" rel="noopener" title="The locations marketplace arrives in a later phase. Opens the demo.">${ui.icon('store')}Find more locations<span class="soon-tag">Marketplace, coming soon</span></a>`;
    const head = ui.pageHead({
      title: ctx.t('Locations'),
      sub: `${d.locs.length ? `${plural(d.locs.length, 'location')} for ${esc(p.title)}.` : esc(p.title)} Permits, access and safety details in one place. ${ui.lockNote('Team only. Clients never see this module.')}`,
      actions: `${market}${ed ? `<button class="btn btn-primary btn-sm" data-loc-add>${ui.icon('map-pin-plus')}Add location</button>` : ''}`,
    });

    if (!d.locs.length) {
      const pending = d.days.filter((x) => !x.location_id && clean(x.location));
      const names = [...new Set(pending.map((x) => norm(x.location)))];
      return `
        <div class="page loc-page">
          ${head}
          ${ui.panel({ body: ui.empty('map-pinned', 'No locations yet',
            ed ? 'Add each place you’ll shoot: the address, who to call, the permit and what the unit needs to know about parking, power and the nearest hospital.' : 'Producers and heads of department add the shoot locations here.',
            ed ? `<div class="row wrap" style="justify-content:center">
                <button class="btn btn-primary btn-sm" data-loc-add>${ui.icon('map-pin-plus')}Add the first location</button>
                ${names.length ? `<button class="btn btn-outline btn-sm" data-loc-import>${ui.icon('rows-3')}Add ${plural(names.length, 'location')} from the stripboard</button>` : ''}
                ${market}
              </div>` : '') })}
        </div>`;
    }

    const f = ctx.state.locFilterFor === p.id ? ctx.state.locFilter : null;
    if (ctx.state.locFilterFor !== p.id) { ctx.state.locFilter = null; ctx.state.locFilterFor = p.id; }
    const shown = f ? d.locs.filter((l) => (PERMIT[l.permit_status] ? l.permit_status : 'needed') === f) : d.locs;
    return `
      <div class="page full loc-page">
        ${head}
        ${tracker(ctx, d)}
        <div class="loc-layout">
          <section class="loc-main">
            ${f ? `<div class="row loc-filter-note"><span class="small muted">Showing ${esc(f === 'needed' ? 'locations that need a permit' : `permits ${permitOf(f)[0].toLowerCase()}`)} · ${shown.length} of ${d.locs.length}</span><button class="btn btn-xs btn-ghost" data-loc-filter="">Show all</button></div>` : ''}
            ${shown.length ? `<div class="loc-cards">${shown.map((l, i) => card(ctx, d, l, i)).join('')}</div>`
              : ui.panel({ body: ui.empty('filter-x', 'No locations with this status', '', '<button class="btn btn-sm btn-outline" data-loc-filter="">Show all</button>') })}
          </section>
          ${dayPanel(ctx, d)}
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------ drawer: view, edit, photos */
  function openLocation(ctx, d, loc, mode, paint) {
    const { ui, esc } = ctx;
    const pid = ctx.production.id;
    const ed = ctx.canEdit;
    const el = ctx.drawer('<div></div>');
    let busy = false;

    const val = (v) => (v ? `<span dir="auto">${esc(v)}</span>` : '<span class="faint">Not added yet</span>');
    const viewHtml = () => {
      const l = loc;
      const days = daysFor(d, l);
      const maps = mapsFor(l);
      const wa = waFor(ctx, l);
      const tel = String(l.contact_phone || '').replace(/[^\d+]/g, '');
      const photos = (l.photo_paths || []);
      return ctx.frame({
        title: `<span dir="auto">${esc(l.name)}</span>`,
        sub: [l.kind ? esc(l.kind) : '', days.length ? plural(days.length, 'shoot day') : 'Not on a shoot day yet'].filter(Boolean).join(' · '),
        body: `
          <section class="loc-gallery ${photos.length ? '' : 'is-empty'}">
            ${photos.map((pth, i) => `
              <figure class="loc-shot ${i === 0 ? 'is-cover' : ''}">
                ${d.urls[pth] ? `<a href="${esc(d.urls[pth])}" target="_blank" rel="noopener" aria-label="Open photo ${i + 1} full size"><img src="${esc(d.urls[pth])}" alt="${esc(l.name)} photo ${i + 1}" loading="lazy"></a>` : `<span class="loc-shot-missing">${ui.icon('image-off')}</span>`}
                ${ed ? `<button class="loc-shot-rm" data-photo-rm="${esc(pth)}" aria-label="Remove photo ${i + 1}" title="Remove photo">${ui.icon('x')}</button>` : ''}
              </figure>`).join('')}
            ${!photos.length && !ed ? `<div class="loc-shot-none">${ui.icon('image')}<span class="small muted">No recce photos yet</span></div>` : ''}
            ${ed ? `
              <label class="dropzone loc-drop" data-photo-drop>
                <input type="file" accept="image/*" multiple hidden data-photo-input>
                ${ui.icon('image-plus')}<span class="small"><strong>${photos.length ? 'Add more photos' : 'Add recce photos'}</strong></span>
                <span class="tiny faint">Drop images here or choose files. Team only.</span>
              </label>` : ''}
          </section>
          <div class="row wrap" style="gap:6px">${permitPill(l.permit_status)}${l.permit_ref ? `<span class="pill mono">${esc(l.permit_ref)}</span>` : ''}</div>
          ${maps || wa || tel ? `<div class="row wrap loc-quick">
            ${maps ? `<a class="btn btn-sm btn-outline" href="${esc(maps)}" target="_blank" rel="noopener">${ui.icon('map')}Open in Maps</a>` : ''}
            ${wa ? `<a class="btn btn-sm btn-outline" href="${esc(wa)}" target="_blank" rel="noopener">${ui.wa(15)}WhatsApp ${esc(String(l.contact_name || 'contact').split(/\s+/)[0])}</a>` : ''}
            ${tel ? `<a class="btn btn-sm btn-ghost" href="tel:${esc(tel)}">${ui.icon('phone')}<span class="num" dir="ltr">${esc(l.contact_phone)}</span></a>` : ''}
          </div>` : ''}
          ${days.length ? `<section class="stack tight"><span class="eyebrow">Shoot days here</span>
            <div class="list loc-list-box">${days.map((x) => `<a class="list-row" href="#p.${pid}.stripboard">${ui.icon('clapperboard')}<span class="grow small">${esc(dayLabel(x))}${x.crew_call ? ` · crew call ${MPH.time(x.crew_call)}` : ''}</span>${ui.icon('chevron-right', 'faint loc-flip')}</a>`).join('')}</div></section>` : ''}
          <dl class="kv loc-kv">
            <dt>Address</dt><dd>${val(l.address)}</dd>
            <dt>Contact</dt><dd>${l.contact_name || l.contact_phone ? `${val(l.contact_name)}${l.contact_phone ? `<br><span class="tiny muted num" dir="ltr">${esc(l.contact_phone)}</span>` : ''}` : val('')}</dd>
            <dt>Permit</dt><dd>${esc(permitOf(l.permit_status)[0])}${l.permit_ref ? ` · <span class="mono">${esc(l.permit_ref)}</span>` : ''}${l.permit_notes ? `<br><span class="small muted" dir="auto">${esc(l.permit_notes)}</span>` : ''}</dd>
            <dt>Parking</dt><dd>${val(l.parking)}</dd>
            <dt>Nearest hospital</dt><dd>${val(l.nearest_hospital)}</dd>
            <dt>Power</dt><dd>${val(l.power)}</dd>
            <dt>Access</dt><dd>${val(l.access_notes)}</dd>
            <dt>Notes</dt><dd class="loc-pre">${val(l.notes)}</dd>
          </dl>`,
        foot: ed
          ? `<button class="btn btn-ghost loc-del" data-loc-del>${ui.icon('trash-2')}Delete</button><span class="spacer"></span><button class="btn btn-ghost" data-close>Close</button><button class="btn btn-primary" data-loc-edit>${ui.icon('pencil')}Edit details</button>`
          : '<button class="btn btn-primary" data-close>Close</button>',
      });
    };

    const input = (id, label, value, opts = {}) => `
      <div class="field ${opts.cls || ''}"><label for="${id}">${label}</label>
        ${opts.area ? `<textarea id="${id}" class="textarea" dir="auto" maxlength="${opts.max || 2000}" style="min-height:${opts.h || 60}px" placeholder="${esc(opts.ph || '')}">${esc(value || '')}</textarea>`
          : `<input id="${id}" class="input ${opts.num ? 'num' : ''}" ${opts.type ? `type="${opts.type}"` : ''} dir="${opts.dir || 'auto'}" maxlength="${opts.max || 300}" ${opts.list ? `list="${opts.list}"` : ''} ${opts.mode ? `inputmode="${opts.mode}"` : ''} value="${esc(value || '')}" placeholder="${esc(opts.ph || '')}">`}
        ${opts.hint ? `<span class="tiny faint">${opts.hint}</span>` : ''}
      </div>`;
    const editHtml = () => {
      const l = loc || { permit_status: 'needed' };
      return ctx.frame({
        title: loc ? `Edit <span dir="auto">${esc(loc.name)}</span>` : 'Add location',
        sub: loc ? 'Changes save for the whole team' : `For ${esc(ctx.production.title)}`,
        body: `
          <form class="stack loc-form" novalidate>
            ${input('lf-name', 'Name', l.name, { ph: 'e.g. At-Turaif, Diriyah', max: 160 })}
            ${input('lf-kind', 'Kind', l.kind, { ph: 'e.g. Heritage site', list: 'lf-kinds', max: 60 })}
            <datalist id="lf-kinds">${KINDS.map((k) => `<option value="${esc(k)}"></option>`).join('')}</datalist>
            ${input('lf-address', 'Address', l.address, { ph: 'Street, district, city. Add the gate or entrance crew should use.', area: true, h: 56, max: 500 })}
            ${input('lf-maps', 'Google Maps link (optional)', l.maps_url, { ph: 'https://maps.app.goo.gl/…', dir: 'ltr', type: 'url', max: 600, hint: 'Paste the share link from Google Maps. Without one, “Open in Maps” searches the address.' })}
            <div class="grid-2">
              ${input('lf-cname', 'Contact name', l.contact_name, { ph: 'e.g. Abeer Al-Sudairi', max: 120 })}
              ${input('lf-cphone', 'Contact phone (WhatsApp)', l.contact_phone, { ph: '+966 5x xxx xxxx', dir: 'ltr', type: 'tel', mode: 'tel', num: true, max: 40 })}
            </div>
            <div class="field"><span class="label">Permit</span>
              <div class="loc-permit-opts" role="radiogroup" aria-label="Permit status">${Object.entries(PERMIT).map(([k, [lab, kind, ic]]) => `
                <button type="button" class="loc-permit-opt k-${kind || 'none'} ${l.permit_status === k ? 'on' : ''}" role="radio" aria-checked="${l.permit_status === k}" data-permit="${k}">${ui.icon(ic)}${esc(lab)}</button>`).join('')}</div>
            </div>
            <div class="grid-2">
              ${input('lf-pref', 'Permit reference', l.permit_ref, { ph: 'e.g. DC-FP-2611', dir: 'ltr', max: 80 })}
              ${input('lf-hosp', 'Nearest hospital', l.nearest_hospital, { ph: 'e.g. King Salman Hospital, 24 min', max: 200 })}
            </div>
            ${input('lf-pnotes', 'Permit notes', l.permit_notes, { area: true, h: 50, ph: 'Who issues it, when you applied, conditions such as drone or time limits', max: 1000 })}
            <div class="grid-2">
              ${input('lf-parking', 'Parking', l.parking, { area: true, h: 50, ph: 'Where trucks and crew cars go', max: 500 })}
              ${input('lf-power', 'Power', l.power, { area: true, h: 50, ph: 'House power, tie-in, or generator', max: 500 })}
            </div>
            ${input('lf-access', 'Access notes', l.access_notes, { area: true, h: 50, ph: 'Gate codes, 4x4 only after km 12, quiet hours…', max: 1000 })}
            ${input('lf-notes', 'Notes', l.notes, { area: true, h: 70, ph: 'Light, sound, house rules, what the recce found', max: 4000 })}
            <div data-lf-error hidden></div>
          </form>`,
        foot: `<button class="btn btn-ghost" ${loc ? 'data-loc-cancel' : 'data-close'}>Cancel</button><button class="btn btn-primary" data-loc-save>${loc ? 'Save changes' : `${ui.icon('map-pin-plus')}Add location`}</button>`,
      });
    };

    let permit = loc ? loc.permit_status : 'needed';
    const draw = (m) => {
      mode = m;
      el.innerHTML = m === 'edit' ? editHtml() : viewHtml();
      permit = loc ? (PERMIT[loc.permit_status] ? loc.permit_status : 'needed') : 'needed';
      MPH.icons();
      el.scrollTop = 0;
      if (m === 'edit') { const f = el.querySelector('#lf-name'); if (f) f.focus({ preventScroll: true }); }
    };
    const err = (m) => { const b = el.querySelector('[data-lf-error]'); if (!b) return ctx.toastError(new Error(m)); b.hidden = false; b.innerHTML = ui.errorBox(m); MPH.icons(); };

    async function save(btn) {
      const v = (id) => el.querySelector(id).value;
      const row = {
        name: clean(v('#lf-name'), 160), kind: clean(v('#lf-kind'), 60), address: clean(v('#lf-address'), 500), maps_url: clean(v('#lf-maps'), 600),
        contact_name: clean(v('#lf-cname'), 120), contact_phone: clean(v('#lf-cphone'), 40), permit_status: permit,
        permit_ref: clean(v('#lf-pref'), 80), permit_notes: clean(v('#lf-pnotes'), 1000), parking: clean(v('#lf-parking'), 500),
        nearest_hospital: clean(v('#lf-hosp'), 200), power: clean(v('#lf-power'), 500), access_notes: clean(v('#lf-access'), 1000), notes: clean(v('#lf-notes'), 4000),
      };
      if (!row.name) { el.querySelector('#lf-name').focus(); return err('Give the location a name.'); }
      if (row.maps_url && !safeUrl(row.maps_url)) return err('Paste the full Maps link, starting with https://');
      if (d.locs.some((x) => x !== loc && norm(x.name) === norm(row.name))) return err('There’s already a location with this name.');
      btn.disabled = true;
      try {
        if (loc) {
          const renamed = loc.name !== row.name;
          ctx.api.must(await ctx.sb.from('locations').update(row).eq('id', loc.id));
          Object.assign(loc, row);
          if (renamed && daysFor(d, loc).length) {
            // keep the stripboard and call sheets in step with the new name
            ctx.api.must(await ctx.sb.from('shoot_days').update({ location: row.name }).eq('location_id', loc.id));
            daysFor(d, loc).forEach((x) => { x.location = row.name; });
          }
          ctx.toast(`${row.name} saved`);
        } else {
          loc = ctx.api.must(await ctx.sb.from('locations').insert({ ...row, production_id: pid }).select().single());
          d.locs.push(loc);
          ctx.toast(`${row.name} added. Add recce photos next.`, 'map-pin');
        }
        paint();
        draw('view');
      } catch (ex) { btn.disabled = false; err(ex.message); }
    }

    async function upload(files) {
      if (busy) return;
      const all = [...files];
      const list = all.filter((f) => /^image\//.test(f.type) && f.size <= MAX_MB * 1024 * 1024);
      if (!list.length) return ctx.toast(all.length ? `Choose image files up to ${MAX_MB} MB` : 'No files chosen', 'image-off', 'error');
      if (list.length < all.length) ctx.toast(`${all.length - list.length} file${all.length - list.length === 1 ? ' was' : 's were'} skipped: images up to ${MAX_MB} MB only`, 'info');
      busy = true;
      const drop = el.querySelector('[data-photo-drop]');
      if (drop) { drop.classList.add('is-busy'); drop.innerHTML = `<span class="spin"></span><span class="small">Uploading ${plural(list.length, 'photo')}…</span>`; }
      const paths = [];
      try {
        for (const f of list) paths.push(await ctx.api.uploadMedia(pid, f, 'internal', 'locations'));
        const next = [...(loc.photo_paths || []), ...paths];
        ctx.api.must(await ctx.sb.from('locations').update({ photo_paths: next }).eq('id', loc.id));
        loc.photo_paths = next;
        Object.assign(d.urls, await ctx.api.mediaUrls(paths));
        ctx.toast(`${plural(paths.length, 'photo')} added`, 'image-plus');
      } catch (ex) {
        await ctx.api.removeMedia(paths).catch(() => {});
        ctx.toastError(ex);
      }
      busy = false;
      paint();
      if (el.isConnected) draw('view');
    }

    async function removePhoto(btn) {
      const pth = btn.dataset.photoRm;
      if (!btn.dataset.armed) {
        btn.dataset.armed = '1'; btn.classList.add('is-armed'); btn.innerHTML = 'Remove?';
        setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.classList.remove('is-armed'); btn.innerHTML = ui.icon('x'); MPH.icons(); } }, 3000);
        return;
      }
      btn.disabled = true;
      try {
        const next = (loc.photo_paths || []).filter((x) => x !== pth);
        ctx.api.must(await ctx.sb.from('locations').update({ photo_paths: next }).eq('id', loc.id));
        loc.photo_paths = next;
        await ctx.api.removeMedia([pth]).catch(() => {});
        paint(); draw('view');
        ctx.toast('Photo removed', 'image-minus');
      } catch (ex) { btn.disabled = false; ctx.toastError(ex); }
    }

    async function remove(btn) {
      const n = daysFor(d, loc).length;
      if (!btn.dataset.armed) {
        btn.dataset.armed = '1'; btn.classList.add('is-armed');
        btn.innerHTML = `${ui.icon('trash-2')}${n ? `Delete? ${plural(n, 'shoot day')} lose${n === 1 ? 's' : ''} the link` : 'Delete this location?'}`; MPH.icons();
        setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.classList.remove('is-armed'); btn.innerHTML = `${ui.icon('trash-2')}Delete`; MPH.icons(); } }, 4000);
        return;
      }
      btn.disabled = true;
      try {
        ctx.api.must(await ctx.sb.from('locations').delete().eq('id', loc.id));
        await ctx.api.removeMedia(loc.photo_paths || []).catch(() => {});
        d.locs = d.locs.filter((x) => x.id !== loc.id);
        d.days.forEach((x) => { if (x.location_id === loc.id) x.location_id = null; }); // the database sets it null too; the name stays on the day
        ctx.closeOverlay();
        paint();
        ctx.toast(`${loc.name} deleted`, 'trash-2');
      } catch (ex) { btn.disabled = false; ctx.toastError(ex); }
    }

    el.addEventListener('click', (e) => {
      let b;
      if ((b = e.target.closest('[data-permit]'))) {
        permit = b.dataset.permit;
        el.querySelectorAll('[data-permit]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      } else if (e.target.closest('[data-loc-edit]')) draw('edit');
      else if (e.target.closest('[data-loc-cancel]')) draw('view');
      else if ((b = e.target.closest('[data-loc-save]'))) { if (!b.disabled) save(b); }
      else if ((b = e.target.closest('[data-loc-del]'))) { if (!b.disabled) remove(b); }
      else if ((b = e.target.closest('[data-photo-rm]'))) { e.preventDefault(); if (!b.disabled) removePhoto(b); }
      else if (e.target.closest('.list-row[href]')) ctx.closeOverlay();
    });
    el.addEventListener('change', (e) => { if (e.target.matches('[data-photo-input]') && e.target.files.length) upload(e.target.files); });
    el.addEventListener('dragover', (e) => { const z = e.target.closest('[data-photo-drop]'); if (z) { e.preventDefault(); z.classList.add('over'); } });
    el.addEventListener('dragleave', (e) => { const z = e.target.closest('[data-photo-drop]'); if (z && !z.contains(e.relatedTarget)) z.classList.remove('over'); });
    el.addEventListener('drop', (e) => {
      const z = e.target.closest('[data-photo-drop]');
      if (!z) return;
      e.preventDefault(); z.classList.remove('over');
      if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
    });
    el.addEventListener('keydown', (e) => {
      if (mode === 'edit' && e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); const b = el.querySelector('[data-loc-save]'); if (b && !b.disabled) save(b); }
    });
    el.addEventListener('submit', (e) => e.preventDefault());
    draw(ed || !loc ? mode : 'view');
  }

  /* ------------------------------------------------------------ link the stripboard's typed locations */
  async function importFromDays(ctx, d, paint, btn) {
    const pending = d.days.filter((x) => !x.location_id && clean(x.location));
    if (!pending.length) return;
    btn.disabled = true;
    try {
      const byName = new Map(d.locs.map((l) => [norm(l.name), l]));
      const create = [...new Map(pending.filter((x) => !byName.has(norm(x.location))).map((x) => [norm(x.location), clean(x.location, 160)])).values()];
      if (create.length) {
        const ins = ctx.api.must(await ctx.sb.from('locations').insert(create.map((name) => ({ production_id: ctx.production.id, name }))).select());
        ins.forEach((l) => { d.locs.push(l); byName.set(norm(l.name), l); });
      }
      const res = await Promise.all(pending.map((x) => {
        const l = byName.get(norm(x.location));
        x.location_id = l.id; x.location = l.name;
        return ctx.sb.from('shoot_days').update({ location_id: l.id, location: l.name }).eq('id', x.id);
      }));
      const bad = res.find((r) => r.error);
      if (bad) throw new Error(bad.error.message);
      paint();
      ctx.toast(`${plural(pending.length, 'shoot day')} linked${create.length ? `, ${plural(create.length, 'new location')} added` : ''}`, 'link');
    } catch (ex) { ctx.toastError(ex); ctx.reload(); }
  }

  /* ------------------------------------------------------------ view */
  MPH.view('locations', {
    async load(ctx) {
      const pid = ctx.production.id;
      if (ctx.isClient) return { locs: [], days: [], urls: {} };
      const [locs, days] = await Promise.all([
        ctx.sb.from('locations').select('*').eq('production_id', pid).order('created_at'),
        ctx.sb.from('shoot_days').select('id, day_no, date, location, location_id, crew_call').eq('production_id', pid).order('day_no'),
      ]);
      const d = { locs: ctx.api.must(locs) || [], days: ctx.api.must(days) || [], urls: {} };
      const paths = d.locs.flatMap((l) => l.photo_paths || []);
      if (paths.length) d.urls = await ctx.api.mediaUrls(paths);
      return d;
    },

    render(ctx, d) {
      if (ctx.isClient) return `<div class="page">${ctx.ui.empty('lock', 'Not shared with clients', 'Locations hold internal production detail.')}</div>`;
      return renderPage(ctx, d);
    },

    mount(root, ctx, d) {
      if (ctx.isClient) return;
      const paint = () => { if (!root.isConnected) return; root.innerHTML = renderPage(ctx, d); MPH.icons(); };
      const open = (id) => { const l = d.locs.find((x) => x.id === id); if (l) openLocation(ctx, d, l, 'view', paint); };

      root.addEventListener('click', (e) => {
        let b;
        if (e.target.closest('a[href]')) return; // WhatsApp, maps, marketplace and stripboard links
        if ((b = e.target.closest('[data-loc-filter]'))) {
          const k = b.dataset.locFilter || null;
          ctx.state.locFilter = ctx.state.locFilter === k ? null : k;
          ctx.state.locFilterFor = ctx.production.id;
          return paint();
        }
        if (e.target.closest('[data-loc-add]')) { if (ctx.canEdit) openLocation(ctx, d, null, 'edit', paint); return; }
        if ((b = e.target.closest('[data-loc-import]'))) { if (ctx.canEdit && !b.disabled) importFromDays(ctx, d, paint, b); return; }
        if ((b = e.target.closest('[data-loc]'))) open(b.dataset.loc);
      });
      root.addEventListener('keydown', (e) => {
        const b = e.target.closest('.loc-card[data-loc]');
        if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(b.dataset.loc); }
      });

      root.addEventListener('change', async (e) => {
        const sel = e.target.closest('[data-day-loc]');
        if (!sel || !ctx.canEdit) return;
        const day = d.days.find((x) => x.id === sel.dataset.dayLoc);
        if (!day) return;
        const loc = d.locs.find((l) => l.id === sel.value) || null;
        const prevLoc = d.locs.find((l) => l.id === day.location_id) || null;
        const prev = { location_id: day.location_id, location: day.location };
        // the day's typed location follows the linked one; clearing only removes the name we set
        const row = { location_id: loc ? loc.id : null, location: loc ? loc.name : (prevLoc && day.location === prevLoc.name ? null : day.location) };
        sel.disabled = true;
        try {
          ctx.api.must(await ctx.sb.from('shoot_days').update(row).eq('id', day.id));
          Object.assign(day, row);
          paint();
          ctx.toast(loc ? `Day ${day.day_no} is at ${loc.name}` : `Day ${day.day_no} has no location`, 'map-pin');
          const again = root.querySelector(`[data-day-loc="${day.id}"]`);
          if (again) again.focus();
        } catch (ex) { Object.assign(day, prev); sel.disabled = false; sel.value = prev.location_id || ''; ctx.toastError(ex); }
      });
    },
  });
})();

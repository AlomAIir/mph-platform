/* Production overview: an illustrated film-set hero, key numbers, then each phase as a coloured band of
   horizontal step cards with big pitch-style illustrations, live status and progress. */

/* one step card: big illustration, name, status line, progress. "Soon" steps are softer and open the demo page. */
function ovCard({ id, label, line, kind = '', ratio = 0, live, href }) {
  const { esc, ui } = MPH;
  return `
    <a class="ov-step ${live ? '' : 'soon'} ${kind ? 'k-' + kind : ''}" href="${href}" role="listitem">
      <span class="ov-step-art">${MPH.art.step(id)}</span>
      <span class="ov-step-body">
        <span class="ov-step-name">${esc(label)}${live ? '' : `<span class="soon-tag">${MPH.t('Soon')}</span>`}</span>
        <span class="ov-step-line">${esc(line)}</span>
      </span>
      ${live ? `<span class="ov-step-bar"><span style="width:${Math.round(Math.max(0, Math.min(1, ratio || 0)) * 100)}%"></span></span>` : ''}
      <span class="ov-step-go">${ui.icon(live ? 'arrow-right' : 'eye')}</span>
    </a>`;
}

MPH.view('overview', {
  async load(ctx) {
    const pid = ctx.production.id;
    const q = (t, sel = 'id') => ctx.sb.from(t).select(sel).eq('production_id', pid);
    if (ctx.isClient) {
      const [scripts, bids] = await Promise.all([
        q('scripts', 'id, version, locked, created_at'),
        ctx.sb.from('client_bids').select('id, version, status, total, sent_at').eq('production_id', pid).neq('status', 'draft').order('version', { ascending: false }),
      ]);
      return { scripts: scripts.data || [], bids: bids.data || [] };
    }
    const [scripts, scenes, elements, shots, days, people, sheets, lines, bids] = await Promise.all([
      q('scripts', 'id, version, locked, breakdown_status'),
      ctx.sb.from('active_scenes').select('id, shoot_day_id').eq('production_id', pid),
      q('elements', 'id, status'),
      q('shots', 'id, done'),
      q('shoot_days', 'id, day_no, date'),
      q('people', 'id, status'),
      q('call_sheets', 'id, status, version, shoot_day_id'),
      ctx.canSeeInternal ? q('budget_lines', 'qty, unit_cost, markup_pct') : Promise.resolve({ data: null }),
      q('client_bids', 'id, version, status, total'),
    ]);
    return {
      scripts: scripts.data || [], scenes: scenes.data || [], elements: elements.data || [], shots: shots.data || [],
      days: days.data || [], people: people.data || [], sheets: sheets.data || [], lines: lines.data,
      bids: (bids.data || []).sort((a, b) => b.version - a.version),
    };
  },

  render(ctx, d) {
    const { ui, esc, production: p } = ctx;
    const art = MPH.art;
    const latestBid = d.bids[0];
    const bidPill = (b) => !b ? ui.pill('No bid yet') : b.status === 'approved' ? ui.pill(`v${b.version} approved`, 'ok') : b.status === 'sent' ? ui.pill(`v${b.version} with client`, 'warn') : b.status === 'changes_requested' ? ui.pill(`v${b.version} changes requested`, 'danger') : ui.pill(`v${b.version} draft`);
    const dates = p.shoot_start ? `${MPH.date(p.shoot_start)}${p.shoot_end && p.shoot_end !== p.shoot_start ? ' – ' + MPH.date(p.shoot_end) : ''}` : 'Dates TBC';
    const until = p.shoot_start ? MPH.daysUntil(p.shoot_start) : null;

    const hero = `
      <section class="ov-hero">
        <div class="ov-hero-art">${art.set()}</div>
        <div class="ov-hero-shade"></div>
        <div class="ov-hero-body">
          <span class="eyebrow ov-eyebrow">${esc(p.client_name || 'No client yet')}${p.agency ? ' · ' + esc(p.agency) : ''}</span>
          <h1 class="ov-title">${esc(p.title)}${p.title_ar ? ` <span class="ar">${esc(p.title_ar)}</span>` : ''}</h1>
          ${p.summary ? `<p class="ov-summary">${esc(p.summary)}</p>` : ''}
          <div class="ov-meta">
            <span class="ov-chip">${ui.icon('clapperboard')}${esc(p.format || 'Format TBC')}</span>
            <span class="ov-chip">${ui.icon('calendar')}Shoot ${dates}${until > 0 ? ` · in ${until} day${until === 1 ? '' : 's'}` : ''}</span>
            <span class="ov-chip">${ui.icon('package-check')}Delivery ${p.delivery ? MPH.date(p.delivery) : 'TBC'}</span>
            ${p.code ? `<span class="ov-chip mono">${esc(p.code)}</span>` : ''}
          </div>
        </div>
        ${ctx.canSeeInternal && !ctx.isClient ? `<button class="btn btn-sm ov-edit" data-edit>${ui.icon('pencil')}Edit details</button>` : ''}
      </section>`;

    /* ---------------- client view: hero + two big cards */
    if (ctx.isClient) {
      const script = [...d.scripts].sort((a, b) => b.version - a.version)[0];
      return `
        <div class="page ov">
          ${hero}
          <div class="ov-band" style="--pc:#ACD062">
            <div class="ov-band-head"><span class="ov-band-num">For you</span><span class="ov-band-title">Your production</span></div>
            <div class="ov-steps">
              ${ovCard({ id: 'script', label: 'Script', line: script ? `Version ${script.version}${script.locked ? ' · locked' : ''}` : 'Not shared yet', live: true, href: `#p.${p.id}.script` })}
              ${ovCard({ id: 'budget', label: 'Bid', line: latestBid ? (latestBid.status === 'sent' ? 'Waiting for your decision' : `${MPH.sar(latestBid.total)} incl. VAT`) : 'No bid sent yet', kind: latestBid?.status === 'sent' ? 'warn' : '', live: true, href: `#p.${p.id}.budget` })}
            </div>
          </div>
        </div>`;
    }

    /* ---------------- team view */
    const script = [...d.scripts].sort((a, b) => b.version - a.version)[0];
    const pending = d.elements.filter((e) => e.status === 'suggested').length;
    const accepted = d.elements.length - pending;
    const scheduled = d.scenes.filter((s) => s.shoot_day_id).length;
    const internal = d.lines ? d.lines.reduce((s, l) => s + l.qty * l.unit_cost, 0) : null;
    const clientTotal = d.lines ? d.lines.reduce((s, l) => s + l.qty * l.unit_cost * (1 + l.markup_pct / 100), 0) : null;
    const published = d.sheets.filter((s) => s.status === 'published');
    const daysWithSheet = new Set(published.map((s) => s.shoot_day_id)).size;
    const confirmed = d.people.filter((x) => x.status === 'confirmed').length;

    const status = {
      script: script ? [`Version ${script.version}${script.locked ? ' · locked' : ''}`, 'ok', 1] : ['Add the script to begin', 'warn', 0],
      breakdown: !script ? ['Needs a script first', '', 0]
        : script.breakdown_status === 'running' ? ['AI is reading the script…', 'info', .5]
        : d.elements.length ? [pending ? `${pending} suggestion${pending === 1 ? '' : 's'} to review` : `${d.elements.length} elements confirmed`, pending ? 'warn' : 'ok', accepted / d.elements.length]
        : ['Ready to run', 'info', 0],
      shotlist: d.shots.length ? [`${d.shots.length} shots · ${d.shots.filter((s) => s.done).length} done`, '', d.shots.filter((s) => s.done).length / d.shots.length] : [d.scenes.length ? 'Suggest shots with AI' : 'Needs scenes', '', 0],
      stripboard: d.scenes.length ? [`${scheduled} of ${d.scenes.length} scenes on ${d.days.length} day${d.days.length === 1 ? '' : 's'}`, scheduled === d.scenes.length ? 'ok' : '', scheduled / d.scenes.length] : ['Needs scenes', '', 0],
      budget: d.lines == null ? [latestBid ? `Bid ${MPH.sarK(latestBid.total)}` : 'Owners and producers only', '', latestBid ? 1 : 0]
        : d.lines.length ? [`${MPH.sarK(clientTotal)} client · ${MPH.pct((clientTotal - internal) / clientTotal, 0)} margin`, '', latestBid ? 1 : .5] : ['Draft with AI or add lines', '', 0],
      crew: d.people.length ? [`${d.people.length} people · ${confirmed} confirmed`, confirmed === d.people.length ? 'ok' : '', confirmed / d.people.length] : ['Add your crew', '', 0],
      callsheets: published.length ? [`${daysWithSheet} of ${d.days.length || daysWithSheet} days sent`, 'ok', d.days.length ? daysWithSheet / d.days.length : 1] : [d.days.length ? 'Create the first call sheet' : 'Needs shoot days', '', 0],
    };

    const phaseState = (ph) => {
      const order = MPH.PHASES.map((x) => x.id), cur = order.indexOf(MPH.phaseOf(p));
      const i = order.indexOf(ph.id);
      return i < cur ? 'Complete' : i === cur ? 'In progress' : 'Up next';
    };
    const PHASE_NAMES = { pre: ['Phase one', 'Pre-production'], prod: ['Phase two', 'Production'], post: ['Phase three', 'Post and delivery'] };

    /* the three phases side by side (as in the pitch), each with its activities grouped and numbered in sequence */
    const bands = `<div class="ov-flow">${MPH.PHASES.map((ph, pi) => {
      const [num, title] = PHASE_NAMES[ph.id];
      const live = ph.tabs.filter((t) => t[3]).length;
      const tab = (id) => ph.tabs.find((x) => x[0] === id);
      const groups = (ph.groups || [['', ph.tabs.map((x) => x[0])]]).map(([label, ids], gi) => `
        ${gi ? `<span class="ov-garrow" aria-hidden="true">${ui.icon('chevron-right')}</span>` : ''}
        <div class="ov-group" style="--n:${ids.length}">
          ${label ? `<span class="ov-group-label"><b>${gi + 1}</b>${esc(ctx.t(label))}</span>` : ''}
          <div class="ov-group-cards" role="list">
            ${ids.map((id) => {
              const [, stepLabel, , isLive] = tab(id);
              const [line, kind, ratio] = status[id] || ['Coming soon', '', 0];
              return ovCard({ id, label: ctx.t(stepLabel), line, kind, ratio, live: !!isLive, href: `#p.${p.id}.${id}` });
            }).join('')}
          </div>
        </div>`).join('');
      return `${pi ? `<span class="ov-arrow" aria-hidden="true">${ui.icon('arrow-down')}</span>` : ''}
        <section class="ov-band ov-phase" style="--pc:${ph.color};animation-delay:${pi * 90}ms">
          <header class="ov-band-head">
            <span class="stack" style="gap:2px"><span class="ov-band-num">${ctx.t(num)}</span><span class="ov-band-title">${ctx.t(title)}</span></span>
            <span class="ov-band-state">${phaseState(ph)}<br>${live ? `${live} live` : ctx.t('Coming soon')}</span>
          </header>
          <div class="ov-groups">${groups}</div>
        </section>`;
    }).join('')}</div>`;

    const tiles = [
      ['clapperboard', d.scenes.length, 'Scenes', `${d.elements.length} elements`],
      ['list-video', d.shots.length, 'Shots', `${d.shots.filter((s) => s.done).length} done`],
      ['users', d.people.length, 'People on the job', `${confirmed} confirmed`],
      ['receipt', latestBid ? MPH.sarK(latestBid.total) : '—', 'Client bid', ''],
    ];

    return `
      <div class="page ov">
        ${hero}
        <div class="ov-tiles">
          ${tiles.map(([icon, v, l, sub], i) => `
            <div class="ov-tile" style="animation-delay:${i * 60}ms"><span class="ov-tile-ico">${ui.icon(icon)}</span>
              <div class="stack tight" style="gap:0"><span class="ov-tile-v num">${v}</span><span class="small muted">${esc(l)}</span></div>
              ${i === 3 ? `<span class="ov-tile-sub">${bidPill(latestBid)}</span>` : `<span class="tiny faint ov-tile-sub">${esc(sub)}</span>`}
            </div>`).join('')}
        </div>
        ${bands}
      </div>`;
  },

  mount(root, ctx) {
    const edit = root.querySelector('[data-edit]');
    if (edit) edit.addEventListener('click', () => MPH.openProductionForm(ctx, ctx.production));
    // spotlight that follows the pointer on step cards
    root.querySelectorAll('.ov-step').forEach((el) => el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`); el.style.setProperty('--my', `${e.clientY - r.top}px`);
    }));
  },
});

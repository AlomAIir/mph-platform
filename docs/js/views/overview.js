/* Production overview: details, the Phase 1 pipeline with live status, and money at a glance. */
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
      q('scenes', 'id, shoot_day_id'),
      q('elements', 'id, status'),
      q('shots', 'id, done'),
      q('shoot_days', 'id, day_no, date'),
      q('people', 'id, status'),
      q('call_sheets', 'id, status, version'),
      ctx.canSeeInternal ? q('budget_lines', 'qty, unit_cost, markup_pct') : Promise.resolve({ data: null }),
      q('client_bids', 'id, version, status, total'),
    ]);
    return {
      scripts: scripts.data || [], scenes: scenes.data || [], elements: elements.data || [], shots: shots.data || [],
      days: days.data || [], people: people.data || [], sheets: sheets.data || [], lines: lines.data, bids: (bids.data || []).sort((a, b) => b.version - a.version),
    };
  },

  render(ctx, d) {
    const { ui, esc, production: p } = ctx;
    const latestBid = d.bids[0];
    const bidPill = (b) => !b ? ui.pill('No bid yet') : b.status === 'approved' ? ui.pill(`v${b.version} approved`, 'ok') : b.status === 'sent' ? ui.pill(`v${b.version} with client`, 'warn') : b.status === 'changes_requested' ? ui.pill(`v${b.version} changes requested`, 'danger') : ui.pill(`v${b.version} draft`);

    const head = `
      <section class="cover" style="${ui.coverStyle(p)};padding:26px;min-height:150px;display:flex;align-items:flex-end">
        <div style="position:absolute;inset:0;background:linear-gradient(0deg, rgba(6,12,11,.85), rgba(6,12,11,.15) 70%)"></div>
        <div class="stack" style="position:relative;gap:6px;max-width:760px">
          <span class="eyebrow" style="color:rgba(245,244,239,.75)">${esc(p.client_name || 'No client yet')}${p.agency ? ' · ' + esc(p.agency) : ''}</span>
          <h1 class="h1" style="font-size:32px">${esc(p.title)} ${p.title_ar ? `<span class="ar" style="font-size:22px;opacity:.7;margin-inline-start:8px">${esc(p.title_ar)}</span>` : ''}</h1>
          ${p.summary ? `<p style="color:rgba(245,244,239,.85)">${esc(p.summary)}</p>` : ''}
        </div>
        ${ctx.canSeeInternal && !ctx.isClient ? `<button class="btn btn-sm btn-outline" data-edit style="position:absolute;inset-block-start:14px;inset-inline-end:14px;background:rgba(10,20,19,.55)">${ui.icon('pencil')}Edit details</button>` : ''}
      </section>`;

    if (ctx.isClient) {
      const script = d.scripts.sort((a, b) => b.version - a.version)[0];
      return `
        <div class="page">
          ${head}
          <div class="grid-3">
            <div class="panel"><div class="panel-body">${ui.stat(p.shoot_start ? MPH.date(p.shoot_start, 'day') : 'TBC', 'First shoot day')}</div></div>
            <div class="panel"><div class="panel-body">${ui.stat(p.delivery ? MPH.date(p.delivery, 'day') : 'TBC', 'Delivery')}</div></div>
            <div class="panel"><div class="panel-body">${ui.stat(latestBid ? MPH.sarK(latestBid.total) : '—', 'Quoted total incl. VAT', `<span>${bidPill(latestBid)}</span>`)}</div></div>
          </div>
          <div class="grid-2">
            <a class="card link" href="#p.${p.id}.script">${ui.icon('file-text')}<span class="strong">Script</span><span class="small muted">${script ? `Version ${script.version}${script.locked ? ' · locked' : ''}` : 'Not shared yet'}</span></a>
            <a class="card link" href="#p.${p.id}.budget">${ui.icon('calculator')}<span class="strong">Bid</span><span class="small muted">${latestBid ? (latestBid.status === 'sent' ? 'Waiting for your decision' : 'Open the bid') : 'No bid sent yet'}</span></a>
          </div>
        </div>`;
    }

    const script = d.scripts.sort((a, b) => b.version - a.version)[0];
    const pending = d.elements.filter((e) => e.status === 'suggested').length;
    const scheduled = d.scenes.filter((s) => s.shoot_day_id).length;
    const internal = d.lines ? d.lines.reduce((s, l) => s + l.qty * l.unit_cost, 0) : null;
    const client = d.lines ? d.lines.reduce((s, l) => s + l.qty * l.unit_cost * (1 + l.markup_pct / 100), 0) : null;
    const published = d.sheets.filter((s) => s.status === 'published').length;

    const step = (id, icon, label, line, kind = '') => `
      <a class="list-row" href="#p.${p.id}.${id}">${ui.icon(icon)}<span class="strong grow">${ctx.t(label)}</span>
        <span class="small truncate" style="max-width:62%;${kind ? `color:var(--${kind})` : 'color:var(--muted)'}">${esc(line)}</span>${ui.icon('chevron-right', 'faint')}</a>`;

    return `
      <div class="page">
        ${head}
        <div class="grid-4">
          <div class="panel"><div class="panel-body">${ui.stat(p.shoot_start ? MPH.date(p.shoot_start, 'day') : 'TBC', 'First shoot day', p.shoot_start && MPH.daysUntil(p.shoot_start) > 0 ? `<span class="tiny faint">${MPH.daysUntil(p.shoot_start)} days away</span>` : '')}</div></div>
          <div class="panel"><div class="panel-body">${ui.stat(String(d.scenes.length), 'Scenes', `<span class="tiny faint">${d.elements.length} elements · ${d.shots.length} shots</span>`)}</div></div>
          <div class="panel"><div class="panel-body">${ui.stat(String(d.people.length), 'People on the job', `<span class="tiny faint">${d.people.filter((x) => x.status === 'confirmed').length} confirmed</span>`)}</div></div>
          <div class="panel"><div class="panel-body">${client != null && client > 0
            ? ui.stat(MPH.pct((client - internal) / client, 1), 'Planned margin', `<span class="tiny">${ui.lockNote('Internal')}</span>`)
            : ui.stat(latestBid ? MPH.sarK(latestBid.total) : '—', 'Latest bid', `<span>${bidPill(latestBid)}</span>`)}</div></div>
        </div>

        <div class="split">
          <div class="stack">
            ${ui.panel({ title: '1 · Pre-production', icon: 'pencil-ruler', flush: true, body: `<div class="list">
              ${step('script', 'file-text', 'Script', script ? `Version ${script.version}${script.locked ? ' · locked' : ''}` : 'Add the script', script ? '' : 'warn')}
              ${step('breakdown', 'scan-text', 'AI Breakdown', !script ? 'Needs a script' : script.breakdown_status === 'running' ? 'Running…' : d.elements.length ? `${d.elements.length} elements · ${pending} to review` : 'Not run yet', pending ? 'warn' : '')}
              ${step('shotlist', 'list-video', 'Shot List', d.shots.length ? `${d.shots.length} shots · ${d.shots.filter((s) => s.done).length} done` : 'No shots yet')}
              ${step('stripboard', 'rows-3', 'Stripboard', d.days.length ? `${d.days.length} shoot days · ${scheduled} of ${d.scenes.length} scenes scheduled` : 'No shoot days yet')}
              ${step('budget', 'calculator', 'Budget & Bid', d.lines ? (d.lines.length ? `Internal ${MPH.sarK(internal)} · client ${MPH.sarK(client)}` : 'No budget lines yet') : 'Bid', '')}
            </div>` })}
            ${ui.panel({ title: '2 · Production', icon: 'clapperboard', flush: true, body: `<div class="list">
              ${step('crew', 'users', 'Crew & Talent', d.people.length ? `${d.people.length} people · ${d.people.filter((x) => x.status !== 'confirmed').length} not confirmed` : 'Add your crew')}
              ${step('callsheets', 'clipboard-list', 'Call Sheets', published ? `${published} published` : d.sheets.length ? 'Drafts only' : 'None yet')}
            </div>` })}
            ${ui.panel({ title: '3 · Post-production', icon: 'film', body: `<p class="small muted">Dailies, edit versions, client review and deliverables arrive in a later phase. <a class="accent" href="${esc(window.MPH_CONFIG.demoUrl)}#p.sahm-explainer.review" target="_blank" rel="noopener">See them in the demo</a>.</p>` })}
          </div>
          <div class="stack">
            ${ui.panel({ title: 'Details', icon: 'info', body: `<dl class="kv">
              <dt>Client</dt><dd>${esc(p.client_name || '—')}</dd>
              <dt>Agency</dt><dd>${esc(p.agency || '—')}</dd>
              <dt>Format</dt><dd>${esc(p.format || '—')}</dd>
              <dt>Shoot</dt><dd>${p.shoot_start ? MPH.date(p.shoot_start, 'long') + (p.shoot_end && p.shoot_end !== p.shoot_start ? ' – ' + MPH.date(p.shoot_end, 'long') : '') : 'TBC'}</dd>
              <dt>Delivery</dt><dd>${p.delivery ? MPH.date(p.delivery, 'long') : 'TBC'}</dd>
              <dt>Code</dt><dd class="mono">${esc(p.code || '—')}</dd>
            </dl>` })}
            ${ui.panel({ title: 'Client bid', icon: 'receipt', body: `<div class="stack">
              <div class="row between">${bidPill(latestBid)}${latestBid ? `<span class="strong num">${MPH.sar(latestBid.total)}</span>` : ''}</div>
              <a class="btn btn-sm btn-outline" href="#p.${p.id}.budget">${ui.icon('calculator')}Open Budget & Bid</a>
              ${ctx.canSeeInternal ? `<a class="btn btn-sm btn-ghost" href="#team">${ui.icon('user-plus')}Invite the client</a>` : ''}
            </div>` })}
          </div>
        </div>
      </div>`;
  },

  mount(root, ctx) {
    const edit = root.querySelector('[data-edit]');
    if (edit) edit.addEventListener('click', () => MPH.openProductionForm(ctx, ctx.production));
  },
});

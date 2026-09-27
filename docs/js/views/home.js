/* Home: what's running, and the next step on each production. */
MPH.view('home', {
  async load(ctx) {
    const prods = ctx.api.must(await ctx.sb.from('productions').select('*').order('updated_at', { ascending: false }));
    const ids = prods.map((p) => p.id);
    if (!ids.length) return { prods, stats: {} };
    const [scripts, pending, shots, sheets] = await Promise.all([
      ctx.sb.from('scripts').select('production_id, breakdown_status').in('production_id', ids),
      ctx.sb.from('elements').select('production_id', { count: 'exact', head: false }).in('production_id', ids).eq('status', 'suggested'),
      ctx.sb.from('shots').select('production_id').in('production_id', ids),
      ctx.sb.from('call_sheets').select('production_id, status').in('production_id', ids),
    ]);
    const by = (rows, pid) => (rows.data || []).filter((r) => r.production_id === pid);
    const stats = {};
    prods.forEach((p) => {
      stats[p.id] = {
        scripts: by(scripts, p.id).length,
        broken: by(scripts, p.id).some((s) => s.breakdown_status === 'done'),
        pending: by(pending, p.id).length,
        shots: by(shots, p.id).length,
        sheets: by(sheets, p.id).filter((s) => s.status === 'published').length,
      };
    });
    return { prods, stats };
  },

  render(ctx, { prods, stats }) {
    const { ui, esc } = ctx;
    const s = ctx.session;
    const name = (s.profile.full_name || s.profile.email || '').split(' ')[0];
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const clientOnly = !s.orgs.length;
    const canCreate = ['owner', 'producer'].includes(s.role);

    const next = (p) => {
      const st = stats[p.id] || {};
      if (clientOnly) return ['Open', `p.${p.id}.overview`, 'arrow-right'];
      if (!st.scripts) return ['Add the script', `p.${p.id}.script`, 'file-up'];
      if (!st.broken) return ['Run the AI breakdown', `p.${p.id}.breakdown`, 'sparkles'];
      if (st.pending) return [`Review ${st.pending} AI suggestions`, `p.${p.id}.breakdown`, 'scan-text'];
      if (!st.shots) return ['Build the shot list', `p.${p.id}.shotlist`, 'list-video'];
      if (!st.sheets) return ['Schedule and send call sheets', `p.${p.id}.stripboard`, 'rows-3'];
      return ['Open', `p.${p.id}.overview`, 'arrow-right'];
    };

    const card = (p) => {
      const [label, href, icon] = next(p);
      return `
        <div class="card">
          <a class="row" href="#p.${p.id}.overview">${ui.prodThumb(p, 36)}<div class="stack tight grow" style="gap:0"><span class="strong truncate">${esc(p.title)}</span><span class="tiny muted truncate">${esc(p.client_name || 'No client yet')}${p.format ? ' · ' + esc(p.format) : ''}</span></div></a>
          <div class="row between">${ui.statusPill(p.status)}<span class="tiny muted">${p.shoot_start ? (MPH.daysUntil(p.shoot_start) > 0 ? `Shoot in ${MPH.daysUntil(p.shoot_start)} days` : `Shoot ${MPH.date(p.shoot_start)}`) : 'Shoot dates TBC'}</span></div>
          <a class="btn btn-sm btn-outline" href="#${href}">${ui.icon(icon)}${esc(label)}</a>
        </div>`;
    };

    return `
      <div class="page">
        ${ui.pageHead({
          eyebrow: MPH.date(MPH.today(), 'long'),
          title: `${greet}${name ? ', ' + esc(name) : ''}`,
          sub: clientOnly ? 'Productions shared with you.' : `${esc(s.org.name)} · ${prods.length} production${prods.length === 1 ? '' : 's'}`,
          actions: canCreate ? `<a class="btn btn-primary" href="#productions.new">${ui.icon('plus')}${ctx.t('New production')}</a>` : '',
        })}
        ${prods.length ? `<div class="cards">${prods.map(card).join('')}</div>` : ui.panel({ body: ui.empty('clapperboard', 'No productions yet',
          clientOnly ? 'When a production house shares a production with you, it appears here.' : 'Create your first production, add its script, and the AI drafts the breakdown for you to review.',
          canCreate ? `<a class="btn btn-primary" href="#productions.new">${ui.icon('plus')}${ctx.t('New production')}</a>` : '') })}
        ${clientOnly ? '' : `
        <div class="callout">${ui.icon('route')}<div class="stack tight"><span class="strong small">How Phase 1 works</span>
          <span class="small muted">Script → AI breakdown (accept or correct each suggestion) → shot list → stripboard → budget and client bid → crew → call sheets sent by link. Invite your team and clients from <a class="accent" href="#team">Team</a>.</span></div></div>`}
      </div>`;
  },
});

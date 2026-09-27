/* Productions: list, filter, create. #productions.new opens the create form. */
MPH.view('productions', {
  async load(ctx) {
    return ctx.api.must(await ctx.sb.from('productions').select('*').order('created_at', { ascending: false }));
  },

  render(ctx, prods) {
    const { ui, esc } = ctx;
    const filter = ctx.state.prodFilter || 'All';
    const statuses = ['All', 'Development', 'Bidding', 'Pre-production', 'Shooting', 'Post-production', 'Delivered'];
    const list = prods.filter((p) => filter === 'All' || p.status === filter);
    const canCreate = ['owner', 'producer'].includes(ctx.session.role);
    return `
      <div class="page">
        ${ui.pageHead({
          title: ctx.t('Productions'),
          sub: ctx.session.org ? `${esc(ctx.session.org.name)} · unlimited seats` : 'Shared with you',
          actions: canCreate ? `<button class="btn btn-primary" data-new>${ui.icon('plus')}${ctx.t('New production')}</button>` : '',
        })}
        <div class="row wrap" style="gap:6px">${statuses.map((s) => `<button class="chip ${filter === s ? 'on' : ''}" data-filter="${s}">${s}<span class="faint">${s === 'All' ? prods.length : prods.filter((p) => p.status === s).length}</span></button>`).join('')}</div>
        ${list.length ? `
        <div class="panel flush"><div class="table-wrap"><table class="table">
          <thead><tr><th>Production</th><th>Client</th><th>Status</th><th>Shoot</th><th>Delivery</th></tr></thead>
          <tbody>${list.map((p) => `
            <tr style="cursor:pointer" data-href="#p.${p.id}.overview">
              <td><div class="row">${ui.prodThumb(p, 28)}<div class="stack tight" style="gap:0"><span class="strong">${esc(p.title)}</span><span class="tiny muted">${esc(p.format || '')}${p.code ? ' · ' + esc(p.code) : ''}</span></div></div></td>
              <td>${esc(p.client_name || '—')}</td><td>${ui.statusPill(p.status)}</td>
              <td class="nowrap">${p.shoot_start ? MPH.date(p.shoot_start) + (p.shoot_end && p.shoot_end !== p.shoot_start ? '–' + MPH.date(p.shoot_end) : '') : '<span class="faint">TBC</span>'}</td>
              <td class="nowrap">${p.delivery ? MPH.date(p.delivery) : '<span class="faint">TBC</span>'}</td>
            </tr>`).join('')}</tbody>
        </table></div></div>` : ui.panel({ body: ui.empty('clapperboard', prods.length ? 'No productions at this stage' : 'No productions yet', '', canCreate && !prods.length ? `<button class="btn btn-primary" data-new>${ui.icon('plus')}${ctx.t('New production')}</button>` : '') })}
      </div>`;
  },

  mount(root, ctx) {
    root.addEventListener('click', (e) => {
      const f = e.target.closest('[data-filter]');
      if (f) { ctx.state.prodFilter = f.dataset.filter; return ctx.reload(); }
      const row = e.target.closest('[data-href]');
      if (row) return ctx.go(row.dataset.href);
      if (e.target.closest('[data-new]')) MPH.openProductionForm(ctx);
    });
    if (ctx.params[0] === 'new' && ['owner', 'producer'].includes(ctx.session.role)) MPH.openProductionForm(ctx);
  },
});

/* create or edit a production (shared with Overview) */
MPH.openProductionForm = (ctx, prod = null) => {
  const { ui, esc } = ctx;
  const v = (k) => esc(prod?.[k] ?? '');
  const statuses = ['Development', 'Bidding', 'Pre-production', 'Shooting', 'Post-production', 'Delivered'];
  const el = ctx.modal(ctx.frame({
    title: prod ? 'Edit production' : ctx.t('New production'),
    sub: prod ? '' : 'You can change any of this later.',
    body: `
      <form id="pf" class="stack">
        <div class="grid-2">
          <div class="field"><label for="pf-title">Title</label><input id="pf-title" class="input" required value="${v('title')}" placeholder="e.g. Desert Launch"></div>
          <div class="field"><label for="pf-title-ar">Arabic title (optional)</label><input id="pf-title-ar" class="input ar" dir="rtl" value="${v('title_ar')}"></div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="pf-client">Client</label><input id="pf-client" class="input" value="${v('client_name')}" placeholder="Brand or client"></div>
          <div class="field"><label for="pf-agency">Agency (optional)</label><input id="pf-agency" class="input" value="${v('agency')}"></div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="pf-format">Format</label><input id="pf-format" class="input" value="${v('format')}" placeholder="TVC · 60s + 30s"></div>
          <div class="field"><label for="pf-status">Status</label><select id="pf-status" class="select">${statuses.map((s) => `<option ${((prod?.status) || 'Pre-production') === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        </div>
        <div class="grid-3">
          <div class="field"><label for="pf-start">Shoot starts</label><input id="pf-start" class="input" type="date" value="${v('shoot_start')}"></div>
          <div class="field"><label for="pf-end">Shoot ends</label><input id="pf-end" class="input" type="date" value="${v('shoot_end')}"></div>
          <div class="field"><label for="pf-delivery">Delivery</label><input id="pf-delivery" class="input" type="date" value="${v('delivery')}"></div>
        </div>
        <div class="field"><label for="pf-summary">One-line summary (optional)</label><textarea id="pf-summary" class="textarea" style="min-height:60px">${v('summary')}</textarea></div>
        <div id="pf-error" hidden></div>
      </form>`,
    foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="pf-save">${prod ? 'Save changes' : `${ui.icon('plus')}Create production`}</button>`,
  }));
  el.querySelector('#pf-save').addEventListener('click', async () => {
    const val = (id) => el.querySelector(id).value.trim() || null;
    const row = {
      title: val('#pf-title'), title_ar: val('#pf-title-ar'), client_name: val('#pf-client'), agency: val('#pf-agency'),
      format: val('#pf-format'), status: el.querySelector('#pf-status').value,
      shoot_start: val('#pf-start'), shoot_end: val('#pf-end'), delivery: val('#pf-delivery'), summary: val('#pf-summary'),
    };
    const err = el.querySelector('#pf-error');
    if (!row.title) { err.hidden = false; err.innerHTML = ui.errorBox('Give the production a title.'); return MPH.icons(); }
    try {
      if (prod) {
        ctx.api.must(await ctx.sb.from('productions').update(row).eq('id', prod.id));
        ctx.closeOverlay(); ctx.toast('Saved'); ctx.refreshAll();
      } else {
        const count = (await ctx.sb.from('productions').select('id', { count: 'exact', head: true }).eq('org_id', ctx.session.org.id)).count || 0;
        row.org_id = ctx.session.org.id;
        row.created_by = ctx.session.user.id;
        row.code = `${(ctx.session.org.name.match(/\b\w/g) || ['P']).join('').slice(0, 3).toUpperCase()}-${String(new Date().getFullYear()).slice(2)}${String(count + 1).padStart(2, '0')}`;
        const created = ctx.api.must(await ctx.sb.from('productions').insert(row).select().single());
        ctx.closeOverlay(); ctx.toast(`${created.title} created`);
        ctx.go(`p.${created.id}.script`);
      }
    } catch (ex) { err.hidden = false; err.innerHTML = ui.errorBox(ex.message); MPH.icons(); }
  });
};

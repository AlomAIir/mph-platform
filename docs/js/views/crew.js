/* Crew & Talent (#p.<id>.crew)
   Everyone on the job, grouped by department: status (changeable inline), phone with a WhatsApp link, default call,
   and day rate × days for owners and producers only. Add one person, pull the cast from the AI Breakdown, or paste a
   list from a spreadsheet. */
(function () {
  const DEPTS = ['Production', 'Direction', 'Camera', 'Grip & Electric', 'Lighting', 'Art', 'Wardrobe', 'Hair & Makeup', 'Sound', 'Locations', 'Transport', 'Catering', 'Post', 'Casting', 'Cast', 'Extras', 'Vendors', 'Client'];
  const KIND = { crew: 'Crew', talent: 'Talent', extra: 'Extra', vendor: 'Vendor', client: 'Client' };
  const KIND_FILTER = [['all', 'All'], ['crew', 'Crew'], ['talent', 'Talent'], ['extra', 'Extras'], ['vendor', 'Vendors']];
  const STATUS = { confirmed: 'Confirmed', hold: 'On hold', invited: 'Invited' };
  const PUBLIC_COLS = 'id, production_id, name, role, dept, kind, phone, email, default_call, status, notes, created_at';

  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const canonDept = (s) => { const t = String(s || '').trim(); if (!t) return ''; return DEPTS.find((x) => x.toLowerCase() === t.toLowerCase()) || t; };
  const deptOf = (p) => canonDept(p.dept) || ({ talent: 'Cast', extra: 'Extras', vendor: 'Vendors', client: 'Client' }[p.kind]) || 'No department';
  const deptRank = (d) => { const i = DEPTS.indexOf(d); return i >= 0 ? i : d === 'No department' ? 999 : 500; };
  const cost = (p) => (Number(p.day_rate) || 0) * (Number(p.days) || 0);
  const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
  /* WhatsApp needs an international number: Saudi national format (05XXXXXXXX) becomes 9665XXXXXXXX */
  const waNumber = (ph) => {
    let n = String(ph || '').replace(/\D/g, '');
    if (n.startsWith('00')) n = n.slice(2);
    else if (/^0\d{8,9}$/.test(n)) n = '966' + n.slice(1); // national format, e.g. 05XXXXXXXX
    else if (/^5\d{8}$/.test(n)) n = '966' + n;
    return n.length >= 8 ? n : '';
  };
  const clean = (v, max = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };

  /* ------------------------------------------------------------ pieces */
  function summaryHtml(ctx, d) {
    const { ui } = ctx;
    const n = d.people.length;
    const conf = d.people.filter((p) => p.status === 'confirmed').length;
    const hold = d.people.filter((p) => p.status === 'hold').length;
    const inv = d.people.filter((p) => p.status === 'invited').length;
    const talent = d.people.filter((p) => p.kind === 'talent').length;
    const tile = (inner) => `<div class="panel"><div class="panel-body">${inner}</div></div>`;
    let money;
    if (ctx.canSeeInternal) {
      const total = d.people.reduce((a, p) => a + cost(p), 0);
      const missing = d.people.filter((p) => p.day_rate == null || !p.days).length;
      money = ui.stat(MPH.sar(total), 'Crew and talent cost', `<span class="tiny">${ui.lockNote('Internal · day rate × days')}</span>${missing ? `<span class="tiny faint">${plural(missing, 'person', 'people')} without a rate or days</span>` : ''}`);
    } else {
      const depts = new Set(d.people.map(deptOf)).size;
      money = ui.stat(String(depts), depts === 1 ? 'Department' : 'Departments');
    }
    return `
      ${tile(ui.stat(String(n), n === 1 ? 'Person on the job' : 'People on the job', `<span class="tiny faint">${n - talent} crew and vendors · ${talent} talent</span>`))}
      ${tile(ui.stat(`${conf}<span class="cr-of"> of ${n}</span>`, 'Confirmed', ui.bar(n ? conf / n : 0)))}
      ${tile(ui.stat(String(hold + inv), 'Not confirmed yet', `<span class="tiny faint">${hold} on hold · ${inv} invited</span>`))}
      ${tile(money)}`;
  }

  function rowHtml(ctx, p) {
    const { ui, esc } = ctx;
    const ed = ctx.canEdit, internal = ctx.canSeeInternal;
    const wa = waNumber(p.phone);
    const me = ctx.session && ctx.session.profile && ctx.session.profile.full_name;
    const msg = `${p.kind === 'vendor' ? 'Hello' : `Hi ${firstName(p.name)}`}, ${me ? `this is ${me} ` : ''}about ${ctx.production.title}.`;
    const sub = [p.kind && p.kind !== 'crew' ? KIND[p.kind] : '', p.email || ''].filter(Boolean);
    const q = [p.name, p.role, deptOf(p), p.phone, p.email].filter(Boolean).join(' ').toLowerCase();
    const st = STATUS[p.status] ? p.status : 'confirmed';
    return `
      <tr class="cr-row" data-id="${p.id}" data-kind="${esc(p.kind || 'crew')}" data-q="${esc(q)}">
        <td><div class="row cr-who">${ui.av(p.name)}<div class="stack" style="gap:1px;min-width:0">
          ${ed ? `<button class="cr-name strong truncate" data-edit dir="auto" title="Edit ${esc(p.name)}">${esc(p.name)}</button>` : `<span class="strong truncate" dir="auto">${esc(p.name)}</span>`}
          ${sub.length ? `<span class="tiny muted truncate">${sub.map(esc).join(' · ')}</span>` : ''}
        </div></div></td>
        <td class="small" dir="auto">${esc(p.role || '')}${p.notes ? ` <span class="cr-note" title="${esc(p.notes)}">${ui.icon('sticky-note')}</span>` : ''}</td>
        <td>${ed
          ? `<select class="cr-status cr-st-${st}" data-status aria-label="Status for ${esc(p.name)}">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${k === st ? 'selected' : ''}>${l}</option>`).join('')}</select>`
          : ui.pill(STATUS[st], { confirmed: 'ok', hold: 'warn', invited: 'info' }[st])}</td>
        <td>${p.phone ? `<span class="row nowrap cr-phone"><a class="num muted" href="tel:${esc(String(p.phone).replace(/[^\d+]/g, ''))}" dir="ltr">${esc(p.phone)}</a>${wa ? `<a class="cr-wa" href="${esc(ui.waLink(wa, msg))}" target="_blank" rel="noopener" title="Message ${esc(firstName(p.name))} on WhatsApp" aria-label="Message ${esc(p.name)} on WhatsApp">${ui.wa(16)}</a>` : ''}</span>` : '<span class="tiny faint">No phone</span>'}</td>
        <td class="num small">${MPH.time(p.default_call) || '<span class="faint">—</span>'}</td>
        ${internal ? `
          <td class="r num small">${p.day_rate != null ? MPH.sar(p.day_rate, { bare: true }) : '<span class="faint">—</span>'}</td>
          <td class="r num small">${p.days != null ? esc(p.days) : '<span class="faint">—</span>'}</td>
          <td class="r num small strong">${cost(p) ? MPH.sar(cost(p), { bare: true }) : '<span class="faint">—</span>'}</td>` : ''}
        ${ed ? `<td class="r"><div class="row cr-acts">
          <button class="btn btn-ghost btn-xs btn-icon" data-edit aria-label="Edit ${esc(p.name)}" title="Edit">${ui.icon('pencil')}</button>
          <button class="btn btn-ghost btn-xs btn-icon cr-del" data-del aria-label="Remove ${esc(p.name)}" title="Remove from the job">${ui.icon('trash-2')}</button>
        </div></td>` : ''}
      </tr>`;
  }

  function tableHtml(ctx, d) {
    const { ui, esc } = ctx;
    const internal = ctx.canSeeInternal, ed = ctx.canEdit;
    const colN = 5 + (internal ? 3 : 0) + (ed ? 1 : 0);
    const groups = new Map();
    d.people.forEach((p) => { const k = deptOf(p); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
    const ordered = [...groups.entries()].sort((a, b) => deptRank(a[0]) - deptRank(b[0]) || a[0].localeCompare(b[0]));
    return `
      <div class="panel flush"><div class="table-wrap">
        <table class="table cr-table">
          <thead><tr>
            <th>Person</th><th>Role</th><th>Status</th><th>Phone</th><th>Call</th>
            ${internal ? `<th class="r"><span class="cr-lock" title="Internal: owners and producers only">${ui.icon('lock')}</span>Day rate</th><th class="r">Days</th><th class="r">Total</th>` : ''}
            ${ed ? '<th class="r"><span class="cr-sr">Actions</span></th>' : ''}
          </tr></thead>
          ${ordered.map(([dept, list]) => `
            <tbody class="cr-group">
              <tr class="group"><td colspan="${colN}"><div class="row"><span>${esc(dept)}</span><span class="tiny faint">${list.length}</span><span class="spacer"></span>${internal && list.some((p) => cost(p)) ? `<span class="tiny faint num">${MPH.sar(list.reduce((a, p) => a + cost(p), 0))}</span>` : ''}</div></td></tr>
              ${list.map((p) => rowHtml(ctx, p)).join('')}
            </tbody>`).join('')}
        </table>
        <div class="cr-none" data-cr-none hidden>${ui.empty('search-x', 'No one matches', 'Try another filter or search.', '<button class="btn btn-sm btn-outline" data-clear>Clear filters</button>')}</div>
      </div></div>`;
  }

  function renderPage(ctx, d) {
    const { ui, esc } = ctx;
    const p = ctx.production;
    const ed = ctx.canEdit;
    let kind = ctx.state.crKind || 'all';
    const market = `<a class="btn btn-ghost btn-sm" href="${esc(window.MPH_CONFIG.demoUrl)}#market" target="_blank" rel="noopener" title="The marketplace arrives in a later phase. Opens the demo.">${ui.icon('store')}Open marketplace<span class="soon-tag">Coming soon</span></a>`;
    const head = ui.pageHead({
      title: ctx.t('Crew & Talent'),
      sub: `${d.people.length ? `${plural(d.people.length, 'person', 'people')} on ${esc(p.title)}, grouped by department.` : esc(p.title)} ${ctx.canSeeInternal ? ui.lockNote('Day rates and cost are internal. Clients never see this module.') : ''}`,
      actions: `${market}${ed ? `
        <button class="btn btn-outline btn-sm" data-from-bd>${ui.icon('scan-text')}Add from breakdown</button>
        <button class="btn btn-outline btn-sm" data-bulk>${ui.icon('clipboard-paste')}Paste a list</button>
        <button class="btn btn-primary btn-sm" data-add>${ui.icon('user-plus')}Add person</button>` : ''}`,
    });

    if (!d.people.length) {
      return `
        <div class="page cr-page">
          ${head}
          ${ui.panel({ body: ui.empty('users', 'No one on this job yet',
            ed ? 'Add your crew and cast one by one, paste a list straight from a spreadsheet, or pull the cast roles from the AI Breakdown and fill in who plays them.' : 'Producers and heads of department add the crew and cast here.',
            ed ? `<div class="row wrap" style="justify-content:center">
                <button class="btn btn-primary btn-sm" data-add>${ui.icon('user-plus')}Add person</button>
                <button class="btn btn-outline btn-sm" data-bulk>${ui.icon('clipboard-paste')}Paste a list</button>
                <button class="btn btn-outline btn-sm" data-from-bd>${ui.icon('scan-text')}Add cast from breakdown</button>
              </div>` : '') })}
        </div>`;
    }

    const counts = { all: d.people.length };
    d.people.forEach((x) => { counts[x.kind] = (counts[x.kind] || 0) + 1; });
    const kinds = KIND_FILTER.filter(([k]) => k === 'all' || counts[k]);
    if (kinds.length <= 2 || !kinds.some(([k]) => k === kind)) { kind = 'all'; ctx.state.crKind = 'all'; }
    const toolbar = `
      <div class="toolbar cr-toolbar">
        ${kinds.length > 2 ? `<div class="seg" role="group" aria-label="Show">${kinds.map(([k, l]) => `<button class="${kind === k ? 'on' : ''}" data-kind-filter="${k}" aria-pressed="${kind === k}">${l}<span class="faint num">${counts[k] || 0}</span></button>`).join('')}</div>` : ''}
        <label class="cr-search">${ui.icon('search')}<input data-search value="${esc(ctx.state.crQ || '')}" placeholder="Search name, role, department, phone" aria-label="Search people"></label>
      </div>`;

    return `
      <div class="page full cr-page">
        ${head}
        <div class="grid-4 cr-summary" data-cr-summary>${summaryHtml(ctx, d)}</div>
        ${toolbar}
        ${tableHtml(ctx, d)}
      </div>`;
  }

  function applyFilter(root, ctx) {
    const kind = ctx.state.crKind || 'all';
    const q = String(ctx.state.crQ || '').trim().toLowerCase();
    let shown = 0;
    root.querySelectorAll('tbody.cr-group').forEach((tb) => {
      let n = 0;
      tb.querySelectorAll('tr.cr-row').forEach((tr) => {
        const ok = (kind === 'all' || tr.dataset.kind === kind) && (!q || tr.dataset.q.includes(q));
        tr.hidden = !ok; if (ok) n++;
      });
      tb.hidden = !n; shown += n;
    });
    const none = root.querySelector('[data-cr-none]');
    if (none) none.hidden = shown > 0 || !root.querySelector('tbody.cr-group');
  }

  /* ------------------------------------------------------------ add / edit one person */
  function openPerson(ctx, d, person, paint) {
    const { ui, esc } = ctx;
    const internal = ctx.canSeeInternal;
    const v = person || { kind: 'crew', status: 'confirmed' };
    const depts = [...new Set([...DEPTS, ...d.people.map((x) => canonDept(x.dept)).filter(Boolean)])];
    const el = ctx.modal(ctx.frame({
      title: person ? `Edit ${esc(person.name)}` : 'Add person',
      sub: person ? esc(person.role || '') : `To ${esc(ctx.production.title)}`,
      body: `
        <form class="stack" data-person-form>
          <div class="grid-2">
            <div class="field"><label for="pp-name">Full name</label><input id="pp-name" class="input" dir="auto" required maxlength="120" value="${esc(v.name || '')}" placeholder="e.g. Bader Al-Otaibi"></div>
            <div class="field"><label for="pp-role">Role</label><input id="pp-role" class="input" dir="auto" maxlength="120" value="${esc(v.role || '')}" placeholder="e.g. Gaffer, or the character name"></div>
          </div>
          <div class="grid-2">
            <div class="field"><label for="pp-dept">Department</label><input id="pp-dept" class="input" list="pp-depts" dir="auto" maxlength="60" value="${esc(v.dept || '')}" placeholder="e.g. Camera"><datalist id="pp-depts">${depts.map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist></div>
            <div class="field"><label for="pp-kind">Type</label><select id="pp-kind" class="select">${Object.entries(KIND).filter(([k]) => k !== 'client').map(([k, l]) => `<option value="${k}" ${v.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          </div>
          <div class="grid-2">
            <div class="field"><label for="pp-status">Status</label><select id="pp-status" class="select">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${v.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
            <div class="field"><label for="pp-call">Default call time</label><input id="pp-call" class="input" type="time" value="${esc(MPH.time(v.default_call))}"></div>
          </div>
          <div class="grid-2">
            <div class="field"><label for="pp-phone">Phone (WhatsApp)</label><input id="pp-phone" class="input num" type="tel" inputmode="tel" dir="ltr" maxlength="40" value="${esc(v.phone || '')}" placeholder="+966 5x xxx xxxx"></div>
            <div class="field"><label for="pp-email">Email (optional)</label><input id="pp-email" class="input" type="email" dir="ltr" maxlength="120" value="${esc(v.email || '')}" placeholder="name@company.com"></div>
          </div>
          ${internal ? `
          <div class="grid-2">
            <div class="field"><label for="pp-rate">Day rate (SAR) ${ui.lockNote('Internal')}</label><input id="pp-rate" class="input num" type="number" min="0" step="50" inputmode="decimal" value="${v.day_rate ?? ''}"></div>
            <div class="field"><label for="pp-days">Days</label><input id="pp-days" class="input num" type="number" min="0" step="1" inputmode="numeric" value="${v.days ?? ''}"></div>
          </div>` : ''}
          <div class="field"><label for="pp-notes">Notes (optional)</label><textarea id="pp-notes" class="textarea" dir="auto" style="min-height:60px" placeholder="Agent, dietary needs, guardian for a minor…">${esc(v.notes || '')}</textarea></div>
          <div data-pp-error hidden></div>
        </form>`,
      foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-pp-save>${person ? 'Save changes' : `${ui.icon('user-plus')}Add person`}</button>`,
    }));
    const err = (m) => { const b = el.querySelector('[data-pp-error]'); b.hidden = false; b.innerHTML = ui.errorBox(m); MPH.icons(); };
    const save = async () => {
      const val = (id) => el.querySelector(id).value;
      const row = {
        name: clean(val('#pp-name'), 120), role: clean(val('#pp-role'), 120), dept: clean(canonDept(val('#pp-dept')), 60),
        kind: val('#pp-kind'), status: val('#pp-status'), default_call: clean(val('#pp-call')),
        phone: clean(val('#pp-phone'), 40), email: clean(val('#pp-email'), 120), notes: clean(val('#pp-notes'), 2000),
      };
      if (!row.name) return err('Add the person’s name.');
      if (row.email && !/^\S+@\S+\.\S+$/.test(row.email)) return err('That email address doesn’t look right.');
      if (internal) {
        const r = val('#pp-rate').trim(), n = val('#pp-days').trim();
        row.day_rate = r === '' ? null : Number(r);
        row.days = n === '' ? null : Math.round(Number(n));
        if ((row.day_rate != null && !(row.day_rate >= 0)) || (row.days != null && !(row.days >= 0))) return err('Day rate and days must be zero or more.');
      }
      const btn = el.querySelector('[data-pp-save]');
      btn.disabled = true;
      // the rate is stored separately in people_rates (owners/producers only)
      const { day_rate: rate, ...personRow } = row;
      const saveRate = async (personId) => {
        if (!internal) return;
        ctx.api.must(await ctx.sb.from('people_rates').upsert({ person_id: personId, production_id: ctx.production.id, day_rate: rate, updated_at: new Date().toISOString() }));
      };
      try {
        if (person) {
          ctx.api.must(await ctx.sb.from('people').update(personRow).eq('id', person.id));
          await saveRate(person.id);
          Object.assign(person, row);
          ctx.toast(`${row.name} saved`);
        } else {
          const ins = ctx.api.must(await ctx.sb.from('people').insert({ ...personRow, production_id: ctx.production.id }).select(internal ? '*' : PUBLIC_COLS).single());
          await saveRate(ins.id);
          d.people.push({ ...ins, day_rate: internal ? rate : undefined });
          ctx.toast(`${row.name} added`, 'user-plus');
        }
        ctx.closeOverlay();
        paint();
      } catch (ex) { btn.disabled = false; err(ex.message); }
    };
    el.querySelector('[data-pp-save]').addEventListener('click', save);
    el.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); save(); } });
  }

  /* ------------------------------------------------------------ cast from the breakdown */
  function openFromBreakdown(ctx, d, paint) {
    const { ui, esc } = ctx;
    const pid = ctx.production.id;
    const roles = new Map();
    d.cast.forEach((c) => {
      const n = String(c.name || '').trim(); if (!n) return;
      const k = n.toLowerCase();
      if (!roles.has(k)) roles.set(k, { name: n, scenes: new Set() });
      roles.get(k).scenes.add(c.scene_id);
    });
    const taken = () => new Set(d.people.map((x) => String(x.role || '').trim().toLowerCase()).filter(Boolean));
    const open = () => [...roles.values()].filter((r) => !taken().has(r.name.toLowerCase()));

    const el = ctx.modal(ctx.frame({
      title: 'Add cast from the breakdown',
      sub: 'Accepted cast roles that aren’t on the job yet',
      body: '<div class="stack" data-bd-body></div>',
      foot: '<div class="row stb-modal-foot" data-bd-foot></div>',
    }), { wide: true });
    const body = el.querySelector('[data-bd-body]');
    const foot = el.querySelector('[data-bd-foot]');

    const draw = () => {
      const list = open();
      if (!roles.size) {
        body.innerHTML = ui.empty('scan-text', 'No accepted cast yet', 'Run the AI Breakdown and accept its cast suggestions. Each character then shows up here, ready for you to add the actor who plays them.',
          `<a class="btn btn-primary btn-sm" href="#p.${pid}.breakdown">${ui.icon('scan-text')}Open AI Breakdown</a>`);
        foot.innerHTML = '<button class="btn btn-ghost" data-close>Close</button>';
      } else if (!list.length) {
        body.innerHTML = ui.empty('circle-check', 'Every cast role is on the job', 'All the accepted cast roles in the breakdown already have someone assigned.');
        foot.innerHTML = '<button class="btn btn-primary" data-close>Done</button>';
      } else {
        body.innerHTML = `
          <p class="small muted">Type who plays each role, then add them. They join as talent with the character as their role, under Cast. Not cast yet? Type “TBC” and update the name once they’re booked.</p>
          <div class="cr-bd-list">${list.map((r) => `
            <div class="cr-bd-row" data-char="${esc(r.name)}">
              <div class="stack" style="gap:1px;min-width:0"><span class="strong truncate" dir="auto">${esc(r.name)}</span><span class="tiny muted">${plural(r.scenes.size, 'scene')}</span></div>
              <input class="input" data-actor dir="auto" maxlength="120" placeholder="Actor’s name" aria-label="Actor playing ${esc(r.name)}">
              <input class="input num" data-phone type="tel" dir="ltr" inputmode="tel" maxlength="40" placeholder="Phone (optional)" aria-label="Phone for the actor playing ${esc(r.name)}">
              <button class="btn btn-sm btn-outline" data-add-one>${ui.icon('plus')}Add</button>
            </div>`).join('')}</div>`;
        foot.innerHTML = `<button class="btn btn-ghost" data-close>Close</button><span class="spacer"></span><button class="btn btn-primary" data-add-all>${ui.icon('user-plus')}Add everyone with a name</button>`;
      }
      MPH.icons();
    };

    const add = async (rows) => {
      const picks = rows.map((row) => ({
        row,
        rec: {
          production_id: pid, name: clean(row.querySelector('[data-actor]').value, 120), role: row.dataset.char,
          dept: 'Cast', kind: 'talent', status: 'invited', phone: clean(row.querySelector('[data-phone]').value, 40),
        },
      })).filter((x) => x.rec.name);
      if (!picks.length) {
        const first = rows[0] && rows[0].querySelector('[data-actor]');
        if (first) first.focus();
        return ctx.toast('Type the actor’s name first (or TBC)', 'info');
      }
      el.querySelectorAll('[data-add-one], [data-add-all]').forEach((b) => { b.disabled = true; });
      try {
        const ins = ctx.api.must(await ctx.sb.from('people').insert(picks.map((x) => x.rec)).select(ctx.canSeeInternal ? '*' : PUBLIC_COLS));
        d.people.push(...ins);
        paint();
        ctx.toast(ins.length === 1 ? `${ins[0].name} added as ${ins[0].role}` : `${ins.length} cast added`, 'user-plus');
        const keep = new Map([...body.querySelectorAll('.cr-bd-row')].map((r) => [r.dataset.char, [r.querySelector('[data-actor]').value, r.querySelector('[data-phone]').value]]));
        draw();
        body.querySelectorAll('.cr-bd-row').forEach((r) => { const k = keep.get(r.dataset.char); if (k) { r.querySelector('[data-actor]').value = k[0]; r.querySelector('[data-phone]').value = k[1]; } });
      } catch (ex) {
        el.querySelectorAll('[data-add-one], [data-add-all]').forEach((b) => { b.disabled = false; });
        ctx.toastError(ex);
      }
    };

    el.addEventListener('click', (e) => {
      let b;
      if ((b = e.target.closest('[data-add-one]'))) add([b.closest('.cr-bd-row')]);
      else if (e.target.closest('[data-add-all]')) add([...body.querySelectorAll('.cr-bd-row')]);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('.cr-bd-row input')) { e.preventDefault(); add([e.target.closest('.cr-bd-row')]); }
    });
    draw();
    const first = body.querySelector('[data-actor]');
    if (first) first.focus();
  }

  /* ------------------------------------------------------------ bulk paste */
  function openBulk(ctx, d, paint) {
    const { ui, esc } = ctx;
    const picks = new Map();
    const el = ctx.modal(ctx.frame({
      title: 'Paste a list',
      sub: 'Add many people at once, straight from a spreadsheet or a message',
      body: `
        <div class="field">
          <label for="cb-text">One person per line: Name, Role, Department, Phone</label>
          <textarea id="cb-text" class="textarea cr-bulk-ta" dir="auto" rows="7" placeholder="Bader Al-Otaibi, Gaffer, Grip &amp; Electric, 0551234567&#10;Noura Al-Harbi, Wardrobe stylist, Wardrobe, +966 55 765 4321&#10;Faisal Al-Qahtani, Sound mixer, Sound"></textarea>
          <span class="tiny faint">Commas or tabs both work, so you can paste columns from Excel or Google Sheets. Only the name is required; leave a field empty with two commas.</span>
        </div>
        <div class="grid-2">
          <div class="field"><label for="cb-kind">Add as</label><select id="cb-kind" class="select">${Object.entries(KIND).filter(([k]) => k !== 'client').map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select><span class="tiny faint">Anyone in the Cast department is added as talent.</span></div>
          <div class="field"><label for="cb-status">Status</label><select id="cb-status" class="select">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        </div>
        <div data-cb-preview></div>`,
      foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-cb-import disabled>${ui.icon('users')}<span data-cb-label>Paste a list first</span></button>`,
    }), { wide: true });
    const ta = el.querySelector('#cb-text');
    const prev = el.querySelector('[data-cb-preview]');
    const btn = el.querySelector('[data-cb-import]');
    let rows = [];

    const parse = () => {
      const existing = new Set(d.people.map((x) => String(x.name || '').trim().toLowerCase()));
      const seen = new Set();
      const lines = ta.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return lines.map((line, i) => {
        const parts = (line.includes('\t') ? line.split('\t') : line.split(',')).map((x) => x.trim());
        const [name = '', role = '', dept = '', ...rest] = parts;
        const phone = rest.join(', ').trim();
        if (i === 0 && /^name$/i.test(name)) return null;
        const key = name.toLowerCase();
        let note = '';
        if (!name) note = 'Missing name';
        else if (existing.has(key)) note = 'Already on the job';
        else if (seen.has(key)) note = 'Listed twice';
        seen.add(key);
        return { line, name, role, dept: canonDept(dept), phone, note };
      }).filter(Boolean);
    };
    /* ticked by default unless flagged; the user's own ticks win */
    const checked = (r) => !!r.name && (picks.has(r.line) ? picks.get(r.line) : !r.note);

    const draw = () => {
      rows = parse();
      if (!rows.length) { prev.innerHTML = ''; }
      else {
        prev.innerHTML = `
          <div class="table-wrap cr-bulk-wrap"><table class="table cr-bulk-table">
            <thead><tr><th class="sl-check-c"><span class="cr-sr">Add</span></th><th>Name</th><th>Role</th><th>Department</th><th>Phone</th><th></th></tr></thead>
            <tbody>${rows.map((r, i) => `
              <tr class="${checked(r) ? '' : 'is-off'}">
                <td class="sl-check-c"><input type="checkbox" class="sl-check" data-cb-pick="${i}" ${checked(r) ? 'checked' : ''} ${r.name ? '' : 'disabled'} aria-label="Add ${esc(r.name || 'this line')}"></td>
                <td class="small strong" dir="auto">${esc(r.name) || '<span class="faint">—</span>'}</td>
                <td class="small" dir="auto">${esc(r.role)}</td>
                <td class="small" dir="auto">${esc(r.dept)}</td>
                <td class="small num" dir="ltr">${esc(r.phone)}</td>
                <td class="tiny">${r.note ? `<span class="${r.name ? 'muted' : 'cr-bad'}">${esc(r.note)}</span>` : ''}</td>
              </tr>`).join('')}</tbody>
          </table></div>`;
      }
      const n = rows.filter(checked).length;
      btn.disabled = !n;
      el.querySelector('[data-cb-label]').textContent = n ? `Add ${plural(n, 'person', 'people')}` : rows.length ? 'Nothing selected' : 'Paste a list first';
    };
    const redraw = MPH.debounce(draw, 150);
    ta.addEventListener('input', redraw);
    prev.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-cb-pick]'); if (!cb) return;
      picks.set(rows[+cb.dataset.cbPick].line, cb.checked);
      draw();
    });
    btn.addEventListener('click', async () => {
      const kind = el.querySelector('#cb-kind').value, status = el.querySelector('#cb-status').value;
      const recs = rows.filter(checked).map((r) => ({
        production_id: ctx.production.id, name: r.name.slice(0, 120), role: clean(r.role, 120), dept: clean(r.dept, 60), phone: clean(r.phone, 40),
        kind: r.dept.toLowerCase() === 'cast' ? 'talent' : kind, status,
      }));
      if (!recs.length) return;
      btn.disabled = true; btn.innerHTML = `${ui.spinner()}Adding…`;
      try {
        const ins = ctx.api.must(await ctx.sb.from('people').insert(recs).select(ctx.canSeeInternal ? '*' : PUBLIC_COLS));
        d.people.push(...ins);
        ctx.closeOverlay();
        paint();
        ctx.toast(`${plural(ins.length, 'person', 'people')} added`, 'users');
      } catch (ex) {
        btn.disabled = false; btn.innerHTML = `${ui.icon('users')}<span data-cb-label>Try again</span>`; MPH.icons();
        ctx.toastError(ex);
      }
    });
  }

  /* ------------------------------------------------------------ view */
  MPH.view('crew', {
    async load(ctx) {
      const pid = ctx.production.id;
      const [people, cast] = await Promise.all([
        // rates come from people_rates, which the database only returns to owners/producers
        ctx.sb.from('people').select(ctx.canSeeInternal ? '*, people_rates(day_rate)' : PUBLIC_COLS).eq('production_id', pid).order('created_at'),
        ctx.canEdit
          ? ctx.sb.from('elements').select('name, scene_id').eq('production_id', pid).eq('category', 'cast').eq('status', 'accepted')
          : Promise.resolve({ data: [], error: null }),
      ]);
      const rows = (ctx.api.must(people) || []).map(({ people_rates: pr, ...p }) => ({ ...p, day_rate: pr ? pr.day_rate : null }));
      return { people: rows, cast: ctx.api.must(cast) || [] };
    },

    render: renderPage,

    mount(root, ctx, d) {
      const paint = () => { if (!root.isConnected) return; root.innerHTML = renderPage(ctx, d); MPH.icons(); applyFilter(root, ctx); };
      const person = (el) => { const tr = el.closest('tr[data-id]'); return tr && d.people.find((x) => x.id === tr.dataset.id); };
      applyFilter(root, ctx);

      root.addEventListener('click', async (e) => {
        let b;
        if ((b = e.target.closest('[data-kind-filter]'))) {
          ctx.state.crKind = b.dataset.kindFilter;
          root.querySelectorAll('[data-kind-filter]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
          return applyFilter(root, ctx);
        }
        if (e.target.closest('[data-clear]')) {
          ctx.state.crKind = 'all'; ctx.state.crQ = '';
          return paint();
        }
        if (!ctx.canEdit) return;
        if (e.target.closest('[data-add]')) return openPerson(ctx, d, null, paint);
        if (e.target.closest('[data-bulk]')) return openBulk(ctx, d, paint);
        if (e.target.closest('[data-from-bd]')) return openFromBreakdown(ctx, d, paint);
        if ((b = e.target.closest('[data-edit]'))) { const p = person(b); if (p) openPerson(ctx, d, p, paint); return; }
        if ((b = e.target.closest('[data-del]'))) {
          const p = person(b);
          if (!p) return;
          if (!b.dataset.armed) {
            b.dataset.armed = '1';
            const html = b.innerHTML;
            b.classList.add('is-armed'); b.textContent = 'Remove?';
            setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.classList.remove('is-armed'); b.innerHTML = html; } }, 3000);
            return;
          }
          b.disabled = true;
          try {
            ctx.api.must(await ctx.sb.from('people').delete().eq('id', p.id));
            d.people.splice(d.people.indexOf(p), 1);
            paint();
            ctx.toast(`${p.name} removed from the job`, 'user-minus');
          } catch (ex) { b.disabled = false; ctx.toastError(ex); }
        }
      });

      root.addEventListener('input', (e) => {
        if (e.target.matches('[data-search]')) { ctx.state.crQ = e.target.value; applyFilter(root, ctx); }
      });

      root.addEventListener('change', async (e) => {
        const sel = e.target.closest('[data-status]');
        if (!sel || !ctx.canEdit) return;
        const p = person(sel);
        if (!p) return;
        const prev = p.status;
        p.status = sel.value;
        sel.className = `cr-status cr-st-${p.status}`;
        const sum = root.querySelector('[data-cr-summary]');
        const refresh = () => { if (sum) { sum.innerHTML = summaryHtml(ctx, d); MPH.icons(); } };
        refresh();
        try { ctx.api.must(await ctx.sb.from('people').update({ status: p.status }).eq('id', p.id)); }
        catch (ex) { p.status = prev; sel.value = prev; sel.className = `cr-status cr-st-${prev}`; refresh(); ctx.toastError(ex); }
      });
    },
  });
})();

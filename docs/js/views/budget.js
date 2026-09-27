/* Budget & Bid: the client-safe boundary made real.
   Producer path (owners/producers): internal `budget_lines` with cost and markup, and the client bids built from them.
   Client path (client accounts and producer preview): reads ONLY `client_bids` that are not drafts. It never queries
   budget_lines or people, so no internal number can reach a client screen. RLS enforces the same rule in the database. */
(function () {
  const { esc } = MPH;

  const CATS = [
    { id: 'A', name: 'Pre-production & wrap' },
    { id: 'B', name: 'Shooting crew' },
    { id: 'C', name: 'Talent & usage' },
    { id: 'D', name: 'Locations & permits' },
    { id: 'E', name: 'Equipment' },
    { id: 'F', name: 'Art & wardrobe' },
    { id: 'G', name: 'Transport & catering' },
    { id: 'H', name: 'Post-production' },
    { id: 'I', name: 'Insurance & contingency', client: 'Insurance & production cover' },
    { id: 'J', name: 'Production fee' },
  ];
  const OTHER = { id: '?', name: 'Uncategorised', client: 'Other' };
  const UNITS = ['day', 'flat', 'head', 'hour', 'week', 'item'];
  const VAT = 0.15;

  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const r2 = (v) => Math.round(n(v) * 100) / 100;
  const cost = (l) => n(l.qty) * n(l.unit_cost);
  const price = (l) => cost(l) * (1 + n(l.markup_pct) / 100);
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const bare = (v) => MPH.sar(v, { bare: true });
  const catIds = CATS.map((c) => c.id);
  const catKey = (l) => (catIds.includes(l.category) ? l.category : '?');
  const catOf = (id) => CATS.find((c) => c.id === id) || OTHER;
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const bySort = (a, b) => (n(a.sort) - n(b.sort)) || String(a.created_at || '').localeCompare(String(b.created_at || ''));

  /* per-production UI state (not data) */
  const S = { closed: {}, viewBid: {}, pendingAI: {} };
  const closedFor = (pid) => (S.closed[pid] = S.closed[pid] || new Set());

  /* ------------------------------------------------------------ shared: the client bid document (client prices only) */
  function bidLines(b) { return Array.isArray(b.lines) ? b.lines : []; }

  function bidDoc(b, prod) {
    const { ui } = MPH;
    const lines = bidLines(b);
    return `
      <div class="bid-doc">
        <div class="bid-doc-head">
          <div class="stack tight" style="gap:2px;min-width:0">
            <span class="eyebrow">Quote v${esc(b.version)}</span>
            <span class="h3 truncate">${esc(prod.title)}</span>
            ${prod.client_name ? `<span class="tiny muted">${esc(prod.client_name)}${prod.agency ? ' · via ' + esc(prod.agency) : ''}</span>` : ''}
          </div>
          <div class="stack tight bid-doc-sum">
            <span class="tiny muted">Total incl. VAT</span>
            <span class="bid-doc-total num">${MPH.sar(b.total)}</span>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table bid-client-t">
            <thead><tr><th style="width:40px"></th><th>Item</th><th class="r">Amount (SAR)</th></tr></thead>
            <tbody>${lines.length ? lines.map((l) => `
              <tr><td>${l.category && l.category !== '?' ? `<span class="bid-letter">${esc(l.category)}</span>` : ''}</td>
                <td class="strong">${esc(l.label)}</td>
                <td class="r num">${bare(l.amount)}</td></tr>`).join('')
              : `<tr><td></td><td class="muted" colspan="2">No items</td></tr>`}</tbody>
            <tfoot>
              <tr><td></td><td class="muted">Subtotal (excl. VAT)</td><td class="r num">${bare(b.subtotal)}</td></tr>
              <tr><td></td><td class="muted">VAT 15%</td><td class="r num">${bare(b.vat)}</td></tr>
              <tr class="bid-total"><td></td><td class="strong">Total incl. VAT</td><td class="r num strong">${MPH.sar(b.total)}</td></tr>
            </tfoot>
          </table>
        </div>
        ${b.note ? `<div class="bid-doc-note"><span class="label">${ui.icon('message-square-text')}Note from your producer</span><p>${esc(b.note)}</p></div>` : ''}
      </div>`;
  }

  const producerPill = (b, superseded = false) => {
    const { ui } = MPH;
    if (superseded && b.status === 'sent') return ui.pill('Superseded', '', 'history');
    return {
      draft: ui.pill('Draft', '', 'file-pen-line'),
      sent: ui.pill('With client', 'warn', 'send'),
      approved: ui.pill('Approved', 'ok', 'check'),
      changes_requested: ui.pill('Changes requested', 'danger', 'message-square'),
    }[b.status] || ui.pill(b.status);
  };
  const clientPill = (b, latest) => {
    const { ui } = MPH;
    if (!latest && b.status === 'sent') return ui.pill('Superseded');
    return {
      sent: ui.pill('Awaiting your decision', 'warn', 'clock'),
      approved: ui.pill('Approved', 'ok', 'check'),
      changes_requested: ui.pill('Changes requested', 'danger', 'message-square'),
    }[b.status] || ui.pill(b.status);
  };

  /* ------------------------------------------------------------ client path: client_bids only */
  function renderClient(ctx, d) {
    const { ui, production: p } = ctx;
    const preview = !ctx.realClient;
    if (!d.bids.length) {
      return `<div class="page">
        ${ui.pageHead({ eyebrow: 'Budget', title: 'Your quote', sub: esc(p.title) })}
        <div class="panel">${ui.empty('receipt', 'No quote shared yet', preview
          ? 'Your client sees their quote here once you send a client bid. Drafts never appear in this view.'
          : 'Your producer will share the quote here. You’ll be able to approve it or ask for changes.')}</div>
      </div>`;
    }
    const latest = d.bids[0];
    const b = d.bids.find((x) => x.id === S.viewBid[p.id]) || latest;
    const isLatest = b.id === latest.id;

    let decision = '';
    if (!isLatest) {
      decision = `<div class="callout info">${ui.icon('history')}<div class="grow"><span class="strong">You’re viewing quote v${esc(b.version)}.</span> <span class="muted">The latest quote is v${esc(latest.version)}.</span></div>
        <button class="btn btn-sm" data-b="view-bid" data-id="${latest.id}">Open v${esc(latest.version)}</button></div>`;
    } else if (b.status === 'sent') {
      decision = `<div class="callout bid-decide">${ui.icon('bell-ring')}
        <div class="grow stack tight">
          <span><span class="strong">This quote is waiting for your decision.</span> <span class="muted">Approving tells your producer to go ahead at this price. Requesting changes sends them your note.</span></span>
          ${preview ? `<span class="tiny bid-int-text">${ui.icon('eye')}Clients see these buttons. They’re disabled in preview.</span>` : ''}
        </div>
        <div class="row wrap">
          <button class="btn btn-sm btn-primary" data-b="approve" ${preview ? 'disabled' : ''}>${ui.icon('check')}Approve quote</button>
          <button class="btn btn-sm btn-outline" data-b="changes" ${preview ? 'disabled' : ''}>${ui.icon('message-square')}Request changes</button>
        </div></div>`;
    } else if (b.status === 'approved') {
      decision = `<div class="callout">${ui.icon('circle-check')}<div class="grow"><span class="strong">Approved${b.decided_at ? ' on ' + esc(MPH.date(b.decided_at, 'long')) : ''}.</span>${b.client_note ? ` <span class="muted">Your note: “${esc(b.client_note)}”</span>` : ''}</div></div>`;
    } else if (b.status === 'changes_requested') {
      decision = `<div class="callout market">${ui.icon('message-square')}<div class="grow"><span class="strong">Changes requested${b.decided_at ? ' on ' + esc(MPH.date(b.decided_at, 'long')) : ''}.</span>${b.client_note ? ` <span class="muted">“${esc(b.client_note)}”</span>` : ''} <span class="muted">Your producer will send a revised quote.</span></div></div>`;
    }

    return `
      <div class="page">
        ${ui.pageHead({
          eyebrow: `Budget · Quote v${esc(b.version)}${b.sent_at ? ' · sent ' + esc(MPH.date(b.sent_at, 'long')) : ''}`,
          title: 'Your quote',
          sub: `What ${esc(p.client_name || 'you')} ${p.client_name ? 'has' : 'have'} been quoted for ${esc(p.title)}. Amounts are in Saudi riyals.`,
          actions: clientPill(b, isLatest),
        })}
        ${decision}
        <div class="bid-totals bid-totals-client">
          <div class="bid-tot">${ui.stat(MPH.sar(b.subtotal), 'Quoted (excl. VAT)')}</div>
          <div class="bid-tot">${ui.stat(MPH.sar(b.vat), 'VAT 15%')}</div>
          <div class="bid-tot bid-tot-hero">${ui.stat(MPH.sar(b.total), 'Total incl. VAT')}</div>
        </div>
        <div class="split">
          <div class="stack">${bidDoc(b, p)}</div>
          <div class="stack">
            ${ui.panel({ title: `Versions · ${d.bids.length}`, icon: 'history', flush: true, body: `<div class="list">${d.bids.map((x, i) => `
              <button class="list-row bid-ver ${x.id === b.id ? 'on' : ''}" data-b="view-bid" data-id="${x.id}" aria-pressed="${x.id === b.id}">
                <span class="mono small strong">v${esc(x.version)}</span>
                <span class="grow stack" style="gap:2px;align-items:flex-start">
                  ${clientPill(x, i === 0)}
                  <span class="tiny muted">${x.sent_at ? 'Sent ' + esc(MPH.date(x.sent_at)) : ''}${x.decided_at ? ' · decided ' + esc(MPH.date(x.decided_at)) : ''}</span>
                </span>
                <span class="num small strong">${MPH.sar(x.total)}</span>
              </button>`).join('')}</div>` })}
          </div>
        </div>
      </div>`;
  }

  function mountClient(root, ctx, d) {
    const { ui } = ctx;
    const pid = ctx.production.id;
    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-b]');
      if (!el || el.disabled) return;
      const act = el.dataset.b;
      if (act === 'view-bid') { S.viewBid[pid] = el.dataset.id; root.innerHTML = renderClient(ctx, d); MPH.icons(); return; }
      if (act !== 'approve' && act !== 'changes') return;
      if (!ctx.realClient) return; // preview: never decide on the client's behalf
      const b = d.bids[0];
      const approve = act === 'approve';
      const dlg = ctx.modal(ctx.frame({
        title: approve ? `Approve quote v${esc(b.version)}` : `Request changes to quote v${esc(b.version)}`,
        sub: `${esc(ctx.production.title)} · ${MPH.sar(b.total)} incl. VAT`,
        body: approve
          ? `<p>Approving tells your producer to go ahead at <span class="strong num">${MPH.sar(b.total)}</span> including VAT.</p>
             <div class="field"><label for="bd-note">Note to your producer (optional)</label><textarea id="bd-note" class="textarea" rows="3" placeholder="e.g. Approved. Please send the invoice to finance@company.com"></textarea></div>`
          : `<div class="field"><label for="bd-note">What should change?</label><textarea id="bd-note" class="textarea" rows="4" placeholder="e.g. Can we drop the second shoot day and see the saving?"></textarea></div>`,
        foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn ${approve ? 'btn-primary' : 'btn-outline'}" id="bd-go">${ui.icon(approve ? 'check' : 'send')}${approve ? 'Approve quote' : 'Send request'}</button>`,
      }));
      const go = dlg.querySelector('#bd-go');
      go.addEventListener('click', async () => {
        const note = dlg.querySelector('#bd-note').value.trim();
        if (!approve && !note) { dlg.querySelector('#bd-note').focus(); return ctx.toast('Tell your producer what should change', 'message-square'); }
        go.disabled = true; go.innerHTML = `${ui.spinner()} Sending`;
        try {
          ctx.api.must(await ctx.sb.rpc('decide_bid', { p_bid: b.id, p_decision: approve ? 'approved' : 'changes_requested', p_note: note || null }));
          ctx.closeOverlay();
          ctx.toast(approve ? 'Quote approved. Your producer can see it now.' : 'Change request sent to your producer', approve ? 'check' : 'send');
          ctx.reload();
        } catch (ex) { go.disabled = false; go.innerHTML = `${ui.icon(approve ? 'check' : 'send')}${approve ? 'Approve quote' : 'Send request'}`; MPH.icons(); ctx.toastError(ex); }
      });
    });
  }

  /* ------------------------------------------------------------ producer path */
  function totalsOf(lines) {
    const c = sum(lines, cost), pr = sum(lines, price);
    return { cost: c, client: pr, margin: pr - c, vat: pr * VAT, total: pr * (1 + VAT) };
  }

  function totalsHtml(lines) {
    const { ui } = MPH;
    const T = totalsOf(lines);
    return `
      <div class="bid-totals" data-totals>
        <div class="bid-tot bid-tot-int">${ui.stat(MPH.sar(T.cost), 'Internal cost', `<span class="tiny">${ui.lockNote('Internal')}</span>`)}</div>
        <div class="bid-tot">${ui.stat(MPH.sar(T.client), 'Client subtotal', '<span class="tiny faint">Before VAT</span>')}</div>
        <div class="bid-tot bid-tot-int">${ui.stat(`${MPH.sar(T.margin)} <span class="bid-pct">${T.client ? MPH.pct(T.margin / T.client, 1) : '—'}</span>`, 'Margin', `<span class="tiny">${ui.lockNote('Internal')}</span>`)}</div>
        <div class="bid-tot">${ui.stat(MPH.sar(T.vat), 'VAT 15%')}</div>
        <div class="bid-tot bid-tot-hero">${ui.stat(MPH.sar(T.total), 'Client total incl. VAT')}</div>
      </div>`;
  }

  function groupRow(cat, ls, open) {
    const { ui } = MPH;
    const c = sum(ls, cost), pr = sum(ls, price);
    return `
      <tr class="group bid-cat" data-cat="${cat.id}" aria-expanded="${open}">
        <td><span class="row" style="gap:6px">${ls.length ? ui.icon(open ? 'chevron-down' : 'chevron-right') : '<span class="bid-chev-sp"></span>'}<span class="bid-letter">${cat.id === '?' ? '?' : cat.id}</span></span></td>
        <td colspan="3"><span class="strong">${esc(cat.name)}</span> <span class="tiny faint">· ${ls.length ? `${ls.length} line${ls.length === 1 ? '' : 's'}` : 'no lines yet'}</span></td>
        <td class="bid-int"></td>
        <td class="r bid-int num tiny">${c ? MPH.pct((pr - c) / c, 0) : ''}</td>
        <td class="r bid-int num">${ls.length ? bare(c) : ''}</td>
        <td class="r num strong">${ls.length ? bare(pr) : ''}</td>
        <td></td>
        <td class="r">${cat.id === '?' ? '' : `<button class="btn btn-xs btn-ghost" data-b="add" data-cat="${cat.id}" title="Add a line to ${esc(cat.name)}">${ui.icon('plus')}Add</button>`}</td>
      </tr>`;
  }

  function lineRow(l, code) {
    const { ui } = MPH;
    const unitOpts = [...new Set([...UNITS, l.unit || 'flat'])];
    const lab = (f) => `aria-label="${f}, line ${code}"`;
    return `
      <tr class="bid-line" data-id="${l.id}">
        <td class="mono tiny muted">${code}</td>
        <td><div class="row" style="gap:4px"><input class="cell-input" data-f="description" value="${esc(l.description)}" ${lab('Description')}>${l.ai ? `<span title="Drafted by AI">${ui.aiBadge('')}</span>` : ''}</div></td>
        <td class="bid-w-qty"><input class="cell-input num" type="number" step="any" inputmode="decimal" data-f="qty" value="${esc(n(l.qty))}" ${lab('Quantity')}></td>
        <td class="bid-w-unit"><select class="cell-input" data-f="unit" ${lab('Unit')}>${unitOpts.map((u) => `<option value="${esc(u)}" ${u === (l.unit || 'flat') ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></td>
        <td class="bid-int bid-w-cost"><input class="cell-input num" type="number" step="any" inputmode="decimal" data-f="unit_cost" value="${esc(n(l.unit_cost))}" ${lab('Unit cost')}></td>
        <td class="bid-int bid-w-mk"><input class="cell-input num" type="number" step="any" inputmode="decimal" data-f="markup_pct" value="${esc(n(l.markup_pct))}" ${lab('Markup percent')}></td>
        <td class="r bid-int num" data-c="cost">${bare(cost(l))}</td>
        <td class="r num strong" data-c="price">${bare(price(l))}</td>
        <td class="bid-w-notes"><input class="cell-input" data-f="notes" value="${esc(l.notes || '')}" placeholder="Add a note" ${lab('Notes')}></td>
        <td class="r"><button class="btn btn-xs btn-ghost btn-icon bid-del" data-b="del" data-id="${l.id}" aria-label="Delete line ${code}" title="Delete line">${ui.icon('trash-2')}</button></td>
      </tr>`;
  }

  function linesTable(ctx, d) {
    const { ui } = ctx;
    const closed = closedFor(ctx.production.id);
    const cats = [...CATS];
    if (d.lines.some((l) => catKey(l) === '?')) cats.push(OTHER);
    const lockTh = (label) => `<th class="r bid-int" title="Internal only. Never sent to client accounts.">${ui.icon('lock')}${label}</th>`;
    const rows = cats.map((c) => {
      const ls = d.lines.filter((l) => catKey(l) === c.id).sort(bySort);
      const open = !closed.has(c.id);
      return groupRow(c, ls, open) + (open ? ls.map((l, i) => lineRow(l, `${c.id}.${i + 1}`)).join('') : '');
    }).join('');
    const allOpen = cats.every((c) => !closed.has(c.id));
    return `
      <section class="panel flush">
        <header class="panel-head">${ui.icon('table-2')}<h3 class="h3">Budget lines <span class="tiny faint">· ${d.lines.length}</span></h3>
          ${ui.lockNote('Locked columns are internal and never sent to client accounts')}
          <button class="btn btn-ghost btn-xs" data-b="toggle-all">${ui.icon('chevrons-up-down')}${allOpen ? 'Collapse all' : 'Expand all'}</button>
        </header>
        ${d.lines.length ? '' : `<div class="bid-first">${ui.empty('calculator', 'Start the budget', 'Draft every line with AI from the breakdown, pull in crew day rates, or add lines by hand in any category below.',
          `<div class="row wrap" style="justify-content:center"><button class="btn btn-primary btn-sm" data-b="ai">${ui.icon('sparkles')}Draft with AI</button><button class="btn btn-sm" data-b="import">${ui.icon('users')}Import crew costs</button><button class="btn btn-sm btn-ghost" data-b="add" data-cat="A">${ui.icon('plus')}Add a line</button></div>`)}</div>`}
        <div class="table-wrap bid-scroll">
          <table class="table bid-table">
            <thead><tr>
              <th style="width:70px">Code</th><th>Description</th><th class="r">Qty</th><th>Unit</th>
              ${lockTh('Unit cost')}${lockTh('Markup %')}${lockTh('Internal total')}
              <th class="r">Client price</th><th>Notes</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
            <tfoot>${footRow(d.lines)}</tfoot>
          </table>
        </div>
      </section>`;
  }

  function footRow(lines) {
    const T = totalsOf(lines);
    return `<tr class="bid-total" data-foot>
      <td></td><td colspan="3" class="strong">Total</td><td class="bid-int"></td>
      <td class="r bid-int num tiny">${T.cost ? MPH.pct(T.margin / T.cost, 1) : ''}</td>
      <td class="r bid-int num strong">${bare(T.cost)}</td>
      <td class="r num strong">${bare(T.client)}</td><td></td><td></td></tr>`;
  }

  function bidsPanel(ctx, d) {
    const { ui } = ctx;
    const T = totalsOf(d.lines);
    const last = d.bids[0];
    const drift = last && d.lines.length && Math.abs(r2(T.client) - r2(last.subtotal)) >= 1;
    const liveId = (d.bids.find((b) => b.status !== 'draft') || {}).id; // what the client sees as current
    return ui.panel({
      title: `Client bids · ${d.bids.length}`, icon: 'receipt', flush: true,
      actions: `<button class="btn btn-sm btn-primary" data-b="prepare" ${d.lines.length ? '' : 'disabled'}>${ui.icon('file-output')}Prepare client bid</button>`,
      body: `
        ${drift ? `<div class="bid-drift">${ui.icon('git-compare')}<span class="small">The budget has changed since v${esc(last.version)}: client subtotal is now <span class="strong num">${MPH.sar(T.client)}</span>, v${esc(last.version)} quoted <span class="num">${MPH.sar(last.subtotal)}</span>. Prepare a new bid to share the change.</span></div>` : ''}
        ${d.bids.length ? `<div class="list">${d.bids.map((b) => `
          <div class="list-row bid-row">
            <span class="mono small strong">v${esc(b.version)}</span>
            <div class="grow stack" style="gap:3px">
              <span class="row wrap" style="gap:8px">${producerPill(b, b.id !== liveId)}<span class="tiny muted">${b.status === 'draft' ? `Saved ${esc(MPH.date(b.created_at))} · not visible to the client` : `Sent ${esc(MPH.date(b.sent_at))}`}${b.decided_at ? ` · decided ${esc(MPH.date(b.decided_at))}` : ''} · ${bidLines(b).length} item${bidLines(b).length === 1 ? '' : 's'}</span></span>
              ${b.client_note ? `<span class="small bid-cnote">${ui.icon('quote')}${esc(b.client_note)}</span>` : ''}
            </div>
            <span class="num small strong nowrap">${MPH.sar(b.total)}</span>
            <div class="row" style="gap:4px">
              <button class="btn btn-xs btn-outline" data-b="preview-bid" data-id="${b.id}">${ui.icon('eye')}Preview</button>
              ${b.status === 'draft' ? `<button class="btn btn-xs btn-primary" data-b="send-bid" data-id="${b.id}">${ui.icon('send')}Send to client</button>
                <button class="btn btn-xs btn-ghost btn-icon" data-b="del-bid" data-id="${b.id}" aria-label="Delete draft v${esc(b.version)}" title="Delete draft">${ui.icon('trash-2')}</button>` : ''}
            </div>
          </div>`).join('')}</div>`
          : `<div class="panel-body"><p class="small muted">No client bids yet. When the budget is ready, prepare a bid: it’s a snapshot of client prices only, saved as a draft so you can check it before sending.</p></div>`}`,
    });
  }

  function renderProducer(ctx, d) {
    const { ui, production: p } = ctx;
    return `
      <div class="page">
        ${ui.pageHead({
          eyebrow: 'Plan · Commercial bid',
          title: 'Budget & Bid',
          sub: `Internal budget and client bids for ${esc(p.title)}. Figures in SAR, VAT added on the client total.`,
          actions: `
            <button class="btn btn-sm btn-outline" data-b="import">${ui.icon('users')}Import crew costs</button>
            <button class="btn btn-sm" data-b="ai">${ui.icon('sparkles')}Draft with AI</button>
            <button class="btn btn-sm btn-primary" data-b="prepare" ${d.lines.length ? '' : 'disabled'}>${ui.icon('file-output')}Prepare client bid</button>`,
        })}
        <div class="callout info">${ui.icon('lock')}<div><span class="strong">Internal figures and client figures are separate objects. Client accounts have no path to internal ones.</span>
          <span class="muted"> Budget lines (unit cost, markup, margin, notes) are readable only by owners and producers, enforced by the database. A client bid is a separate snapshot of client prices that you prepare and send. Check it with “Preview client view” in the top bar.</span></div></div>
        ${totalsHtml(d.lines)}
        ${linesTable(ctx, d)}
        <div class="bid-bids">${bidsPanel(ctx, d)}</div>
      </div>`;
  }

  /* build the client-safe snapshot: amounts are client prices; no cost, markup or notes ever leave this function */
  function snapshot(lines, mode) {
    let out;
    if (mode === 'lines') {
      const order = [...catIds, '?'];
      out = [...lines].sort((a, b) => (order.indexOf(catKey(a)) - order.indexOf(catKey(b))) || bySort(a, b))
        .map((l) => ({ category: catKey(l), label: String(l.description || '').trim() || 'Item', amount: r2(price(l)) }))
        .filter((x) => x.amount !== 0);
    } else {
      out = [...CATS, OTHER].map((c) => ({ category: c.id, label: c.client || c.name, amount: r2(sum(lines.filter((l) => catKey(l) === c.id), price)) }))
        .filter((x) => x.amount !== 0);
    }
    const subtotal = r2(sum(out, (x) => x.amount));
    const vat = r2(subtotal * VAT);
    return { lines: out, subtotal, vat, total: r2(subtotal + vat) };
  }

  function mountProducer(root, ctx, d) {
    const { ui, sb, api } = ctx;
    const pid = ctx.production.id;
    const closed = closedFor(pid);
    const rerender = () => { root.innerHTML = renderProducer(ctx, d); MPH.icons(); };
    const lineById = (id) => d.lines.find((l) => l.id === id);

    const patch = (l) => {
      const tr = root.querySelector(`tr.bid-line[data-id="${l.id}"]`);
      if (tr) {
        tr.querySelector('[data-c=cost]').textContent = bare(cost(l));
        tr.querySelector('[data-c=price]').textContent = bare(price(l));
      }
      const cat = catOf(catKey(l));
      const g = root.querySelector(`tr.bid-cat[data-cat="${cat.id}"]`);
      if (g) g.outerHTML = groupRow(cat, d.lines.filter((x) => catKey(x) === cat.id), !closed.has(cat.id));
      const t = root.querySelector('[data-totals]');
      if (t) t.outerHTML = totalsHtml(d.lines);
      const f = root.querySelector('tr[data-foot]');
      if (f) f.outerHTML = footRow(d.lines);
      const bp = root.querySelector('.bid-bids');
      if (bp) { bp.outerHTML = `<div class="bid-bids">${bidsPanel(ctx, d)}</div>`; }
      MPH.icons();
    };

    /* inline editing: commit on change */
    root.addEventListener('change', async (e) => {
      const el = e.target.closest('[data-f]');
      const tr = el && el.closest('tr.bid-line');
      if (!tr) return;
      const l = lineById(tr.dataset.id);
      if (!l) return;
      const f = el.dataset.f;
      const prev = l[f];
      let v = el.value;
      if (['qty', 'unit_cost', 'markup_pct'].includes(f)) {
        v = el.value.trim() === '' ? 0 : Number(el.value);
        if (!Number.isFinite(v)) { el.value = n(prev); return ctx.toast('Enter a number', 'triangle-alert', 'error'); }
        if (f === 'qty' && v < 0) { el.value = n(prev); return ctx.toast('Quantity can’t be negative', 'triangle-alert', 'error'); }
      } else if (f === 'description') {
        v = v.trim();
        if (!v) { el.value = prev; return ctx.toast('A line needs a description', 'triangle-alert', 'error'); }
      } else if (f === 'notes') {
        v = v.trim() || null;
      }
      if (v === prev) return;
      l[f] = v;
      patch(l);
      try {
        api.must(await sb.from('budget_lines').update({ [f]: v }).eq('id', l.id));
      } catch (ex) {
        l[f] = prev;
        el.value = prev ?? '';
        patch(l);
        ctx.toastError(ex);
      }
    });

    /* Enter moves down the same column, like a spreadsheet */
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.matches('input.cell-input')) return;
      e.preventDefault();
      const f = e.target.dataset.f;
      const inputs = [...root.querySelectorAll(`input.cell-input[data-f="${f}"]`)];
      const next = inputs[inputs.indexOf(e.target) + (e.shiftKey ? -1 : 1)];
      if (next) { next.focus(); next.select(); } else e.target.blur();
    });

    root.addEventListener('click', async (e) => {
      const el = e.target.closest('[data-b]');
      const grp = e.target.closest('tr.bid-cat');
      if (!el && grp) {
        const id = grp.dataset.cat;
        if (closed.has(id)) closed.delete(id); else closed.add(id);
        return rerender();
      }
      if (!el || el.disabled) return;
      const act = el.dataset.b;
      try {
        if (act === 'toggle-all') {
          const cats = [...CATS, OTHER].map((c) => c.id);
          const allOpen = cats.every((c) => !closed.has(c));
          cats.forEach((c) => (allOpen ? closed.add(c) : closed.delete(c)));
          return rerender();
        }
        if (act === 'add') return await addLine(el.dataset.cat);
        if (act === 'del') return await delLine(el);
        if (act === 'ai') return openAI();
        if (act === 'import') return openImport();
        if (act === 'prepare') return openPrepare();
        if (act === 'preview-bid') return openPreview(d.bids.find((b) => b.id === el.dataset.id));
        if (act === 'send-bid') return openSend(d.bids.find((b) => b.id === el.dataset.id));
        if (act === 'del-bid') return await delBid(el);
      } catch (ex) { ctx.toastError(ex); }
    });

    async function addLine(cat) {
      const same = d.lines.filter((l) => l.category === cat);
      const sort = same.reduce((m, l) => Math.max(m, n(l.sort)), 0) + 1;
      const row = api.must(await sb.from('budget_lines').insert({
        production_id: pid, category: cat, description: 'New line', qty: 1, unit: cat === 'J' || cat === 'I' ? 'flat' : 'day',
        unit_cost: 0, markup_pct: cat === 'J' ? 0 : 20, sort,
      }).select().single());
      d.lines.push(row);
      closed.delete(cat);
      rerender();
      const input = root.querySelector(`tr.bid-line[data-id="${row.id}"] [data-f=description]`);
      if (input) { input.focus(); input.select(); input.scrollIntoView({ block: 'nearest' }); }
    }

    async function delLine(el) {
      if (el.dataset.armed !== '1') {
        el.dataset.armed = '1';
        el.classList.add('btn-danger'); el.classList.remove('btn-icon', 'btn-ghost');
        el.innerHTML = `${ui.icon('trash-2')}Delete?`; MPH.icons();
        setTimeout(() => { if (el.isConnected && el.dataset.armed === '1') { el.dataset.armed = ''; el.classList.remove('btn-danger'); el.classList.add('btn-icon', 'btn-ghost'); el.innerHTML = ui.icon('trash-2'); MPH.icons(); } }, 3000);
        return;
      }
      const id = el.dataset.id;
      api.must(await sb.from('budget_lines').delete().eq('id', id));
      d.lines = d.lines.filter((l) => l.id !== id);
      rerender();
      ctx.toast('Line deleted', 'trash-2');
    }

    async function delBid(el) {
      if (el.dataset.armed !== '1') {
        el.dataset.armed = '1';
        el.classList.add('btn-danger'); el.classList.remove('btn-icon', 'btn-ghost');
        el.innerHTML = `${ui.icon('trash-2')}Delete draft?`; MPH.icons();
        setTimeout(() => { if (el.isConnected && el.dataset.armed === '1') { el.dataset.armed = ''; el.classList.remove('btn-danger'); el.classList.add('btn-icon', 'btn-ghost'); el.innerHTML = ui.icon('trash-2'); MPH.icons(); } }, 3000);
        return;
      }
      const id = el.dataset.id;
      api.must(await sb.from('client_bids').delete().eq('id', id).eq('status', 'draft'));
      d.bids = d.bids.filter((b) => b.id !== id);
      rerender();
      ctx.toast('Draft bid deleted', 'trash-2');
    }

    /* ---------------- AI draft */
    function openAI() {
      const dlg = ctx.modal(ctx.frame({
        title: 'Draft the budget with AI',
        sub: 'Claude reads the scenes, accepted breakdown elements, shoot days and crew day rates, then prices each line at Riyadh 2026 rates.',
        body: `
          <div class="field"><label for="ai-brief">Notes for the AI (optional)</label>
            <textarea id="ai-brief" class="textarea" rows="4" placeholder="e.g. Two shoot days in Riyadh, one-year GCC digital usage, grade and mix in-house, no drone."></textarea>
            <span class="tiny faint">Anything the script doesn’t say: usage, travel, deliverables, rates you already agreed.</span></div>
          <div class="callout info">${ui.icon('lock')}<span class="small">The draft is internal. You review every line before it’s added, and nothing reaches the client until you prepare and send a client bid.</span></div>
          <div id="ai-status"></div>`,
        foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="ai-go">${ui.icon('sparkles')}Draft budget</button>`,
      }), { wide: true });
      if (S.pendingAI[pid]) { const out = S.pendingAI[pid]; delete S.pendingAI[pid]; return showAIResult(dlg, out); }
      const go = dlg.querySelector('#ai-go');
      go.addEventListener('click', async () => {
        const brief = dlg.querySelector('#ai-brief').value.trim();
        const status = dlg.querySelector('#ai-status');
        go.disabled = true; go.innerHTML = `${ui.spinner()} Drafting`;
        dlg.querySelector('#ai-brief').disabled = true;
        const t0 = Date.now();
        status.innerHTML = `<div class="bid-ai-run"><span class="spin"></span><div class="stack tight" style="gap:2px"><span class="small strong">Reading the breakdown and pricing each line…</span><span class="tiny muted">This usually takes 30 to 90 seconds. <span id="ai-secs">0</span>s so far. You can close this window; the draft will be waiting when you reopen it.</span></div></div>`;
        const timer = setInterval(() => { const s = dlg.querySelector('#ai-secs'); if (s) s.textContent = Math.round((Date.now() - t0) / 1000); }, 1000);
        try {
          const out = await api.ai('budget', { production_id: pid, brief: brief || undefined });
          clearInterval(timer);
          if (!out || !Array.isArray(out.lines) || !out.lines.length) throw new Error('The AI didn’t return any lines. Add scenes or notes and try again.');
          if (!dlg.isConnected) { S.pendingAI[pid] = out; ctx.toast('Your AI budget draft is ready. Choose Draft with AI to review it.', 'sparkles'); return; }
          showAIResult(dlg, out);
        } catch (ex) {
          clearInterval(timer);
          if (!dlg.isConnected) return ctx.toastError(ex);
          status.innerHTML = ui.errorBox(ex.message || String(ex));
          go.disabled = false; go.innerHTML = `${ui.icon('sparkles')}Try again`;
          dlg.querySelector('#ai-brief').disabled = false;
          MPH.icons();
        }
      });
    }

    function showAIResult(dlg, out) {
      const lines = out.lines.map((l, i) => ({
        i, category: catIds.includes(l.category) ? l.category : 'A', description: String(l.description || 'Item'),
        qty: n(l.qty) || 1, unit: l.unit || 'flat', unit_cost: n(l.unit_cost), markup_pct: n(l.markup_pct), notes: l.notes || '',
      }));
      const T = totalsOf(lines);
      const body = dlg.querySelector('.overlay-body');
      const foot = dlg.querySelector('.overlay-foot');
      dlg.querySelector('.overlay-head .h2').textContent = 'Review the AI draft';
      body.innerHTML = `
        <div class="row wrap between">
          <span class="small">${ui.aiBadge(`${lines.length} lines`)} <span class="muted">· internal <span class="num">${MPH.sar(T.cost)}</span> · client <span class="num">${MPH.sar(T.client)}</span> before VAT</span></span>
          <label class="check small"><input type="checkbox" id="ai-all" checked> Select all</label>
        </div>
        ${d.lines.length ? `<div class="callout info">${ui.icon('info')}<span class="small">These add to your existing ${d.lines.length} line${d.lines.length === 1 ? '' : 's'}. Nothing is replaced.</span></div>` : ''}
        ${Array.isArray(out.assumptions) && out.assumptions.length ? `<details class="bid-assume" open><summary class="small strong">Assumptions the AI made · ${out.assumptions.length}</summary><ul>${out.assumptions.map((a) => `<li class="small">${esc(a)}</li>`).join('')}</ul></details>` : ''}
        <div class="table-wrap bid-ai-wrap"><table class="table bid-ai-t">
          <thead><tr><th style="width:34px"></th><th>Line</th><th class="r">Qty</th><th class="r">${ui.icon('lock')}Unit cost</th><th class="r">${ui.icon('lock')}Markup</th><th class="r">${ui.icon('lock')}Internal</th><th class="r">Client</th></tr></thead>
          <tbody>${CATS.map((c) => {
            const ls = lines.filter((l) => l.category === c.id);
            if (!ls.length) return '';
            return `<tr class="group"><td><input type="checkbox" class="ai-cat" data-cat="${c.id}" checked aria-label="Select all in ${esc(c.name)}"></td><td colspan="6"><span class="row" style="gap:8px"><span class="bid-letter">${c.id}</span>${esc(c.name)} <span class="tiny faint">· ${MPH.sar(sum(ls, price))}</span></span></td></tr>` +
              ls.map((l) => `<tr>
                <td><input type="checkbox" class="ai-line" data-i="${l.i}" data-cat="${c.id}" checked aria-label="Include ${esc(l.description)}"></td>
                <td><div class="stack" style="gap:1px"><span class="small">${esc(l.description)}</span>${l.notes ? `<span class="tiny muted">${esc(l.notes)}</span>` : ''}</div></td>
                <td class="r num small nowrap">${esc(l.qty)} ${esc(l.unit)}</td>
                <td class="r num small">${bare(l.unit_cost)}</td>
                <td class="r num small">${esc(l.markup_pct)}%</td>
                <td class="r num small">${bare(cost(l))}</td>
                <td class="r num small strong">${bare(price(l))}</td></tr>`).join('');
          }).join('')}</tbody></table></div>`;
      foot.innerHTML = `<button class="btn btn-ghost" data-close>Discard</button><button class="btn btn-outline" id="ai-add-sel">${ui.icon('check')}Add selected (<span id="ai-n">${lines.length}</span>)</button><button class="btn btn-primary" id="ai-add-all">${ui.icon('check-check')}Add all ${lines.length}</button>`;
      MPH.icons();
      const boxes = () => [...body.querySelectorAll('.ai-line')];
      const count = () => { const c = foot.querySelector('#ai-n'); if (c) c.textContent = boxes().filter((b) => b.checked).length; };
      body.addEventListener('change', (e) => {
        if (e.target.id === 'ai-all') boxes().concat([...body.querySelectorAll('.ai-cat')]).forEach((b) => { b.checked = e.target.checked; });
        else if (e.target.classList.contains('ai-cat')) boxes().filter((b) => b.dataset.cat === e.target.dataset.cat).forEach((b) => { b.checked = e.target.checked; });
        else if (e.target.classList.contains('ai-line')) {
          const cat = e.target.dataset.cat;
          const cb = body.querySelector(`.ai-cat[data-cat="${cat}"]`);
          if (cb) cb.checked = boxes().filter((b) => b.dataset.cat === cat).every((b) => b.checked);
        }
        count();
      });
      const add = async (btn, pick) => {
        if (!pick.length) return ctx.toast('Select at least one line', 'info');
        foot.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        btn.innerHTML = `${ui.spinner()} Adding`;
        const base = {};
        const rows = pick.map((l) => {
          if (base[l.category] == null) base[l.category] = d.lines.filter((x) => x.category === l.category).reduce((m, x) => Math.max(m, n(x.sort)), 0);
          base[l.category] += 1;
          return { production_id: pid, category: l.category, description: l.description, qty: l.qty, unit: l.unit, unit_cost: l.unit_cost, markup_pct: l.markup_pct, notes: l.notes || null, ai: true, sort: base[l.category] };
        });
        try {
          const ins = api.must(await sb.from('budget_lines').insert(rows).select());
          d.lines.push(...ins);
          ctx.closeOverlay();
          rerender();
          ctx.toast(`${ins.length} AI line${ins.length === 1 ? '' : 's'} added. Check the rates before you bid.`, 'sparkles');
        } catch (ex) {
          foot.querySelectorAll('button').forEach((b) => { b.disabled = false; });
          btn.innerHTML = btn.id === 'ai-add-all' ? `${ui.icon('check-check')}Add all ${lines.length}` : `${ui.icon('check')}Add selected (<span id="ai-n">${boxes().filter((b) => b.checked).length}</span>)`;
          MPH.icons();
          ctx.toastError(ex);
        }
      };
      foot.querySelector('#ai-add-all').addEventListener('click', (e) => add(e.currentTarget, lines));
      foot.querySelector('#ai-add-sel').addEventListener('click', (e) => add(e.currentTarget, boxes().filter((b) => b.checked).map((b) => lines[Number(b.dataset.i)])));
    }

    /* ---------------- import crew costs from people (day_rate × days) */
    function openImport() {
      const have = new Set(d.lines.map((l) => norm(l.description)));
      const descOf = (p) => `${p.role ? p.role + ' · ' : ''}${p.name}`;
      const withRate = d.people.filter((p) => n(p.day_rate) > 0 && ['crew', 'talent', 'extra'].includes(p.kind));
      const add = withRate.filter((p) => !have.has(norm(descOf(p))));
      const skipped = withRate.length - add.length;
      const noRate = d.people.filter((p) => ['crew', 'talent', 'extra'].includes(p.kind) && !(n(p.day_rate) > 0)).length;
      const catFor = (p) => (p.kind === 'crew' ? 'B' : 'C');
      const total = sum(add, (p) => n(p.day_rate) * (n(p.days) || 1));
      const dlg = ctx.modal(ctx.frame({
        title: 'Import crew costs',
        sub: 'Adds a line per person from Crew & Talent: day rate × days. Crew go to B, talent and extras to C.',
        body: !withRate.length
          ? ui.empty('users', 'No day rates yet', 'Add people with a day rate in Crew & Talent, then import them here.', `<a class="btn btn-sm btn-outline" href="#p.${pid}.crew">${ui.icon('users')}Open Crew & Talent</a>`)
          : `${add.length ? `<div class="list bid-imp">${add.map((p) => `
              <div class="list-row"><span class="bid-letter">${catFor(p)}</span>
                <div class="grow stack" style="gap:0"><span class="small strong">${esc(descOf(p))}</span><span class="tiny muted">${esc(n(p.days) || 1)} day${(n(p.days) || 1) === 1 ? '' : 's'} × ${MPH.sar(p.day_rate)}${n(p.days) ? '' : ' · days not set, using 1'}</span></div>
                <span class="num small">${MPH.sar(n(p.day_rate) * (n(p.days) || 1))}</span></div>`).join('')}</div>
              <div class="row between small"><span class="muted">Internal cost added</span><span class="strong num">${MPH.sar(total)}</span></div>`
            : `<div class="callout">${ui.icon('check')}<span class="small">Everyone with a day rate is already in the budget.</span></div>`}
            ${skipped ? `<p class="tiny muted">${skipped} already imported (matched by description) and skipped.</p>` : ''}
            ${noRate ? `<p class="tiny muted">${noRate} ${noRate === 1 ? 'person has' : 'people have'} no day rate and ${noRate === 1 ? 'isn’t' : 'aren’t'} included.</p>` : ''}
            <p class="tiny muted">Lines use 20% markup. Adjust it per line after import.</p>`,
        foot: `<button class="btn btn-ghost" data-close>Cancel</button>${add.length ? `<button class="btn btn-primary" id="imp-go">${ui.icon('download')}Add ${add.length} line${add.length === 1 ? '' : 's'}</button>` : ''}`,
      }));
      const go = dlg.querySelector('#imp-go');
      if (!go) return;
      go.addEventListener('click', async () => {
        go.disabled = true; go.innerHTML = `${ui.spinner()} Adding`;
        const base = {};
        const rows = add.map((p) => {
          const cat = catFor(p);
          if (base[cat] == null) base[cat] = d.lines.filter((x) => x.category === cat).reduce((m, x) => Math.max(m, n(x.sort)), 0);
          base[cat] += 1;
          return { production_id: pid, category: cat, description: descOf(p), qty: n(p.days) || 1, unit: 'day', unit_cost: n(p.day_rate), markup_pct: 20, notes: 'From Crew & Talent', sort: base[cat] };
        });
        try {
          const ins = api.must(await sb.from('budget_lines').insert(rows).select());
          d.lines.push(...ins);
          closed.delete('B'); closed.delete('C');
          ctx.closeOverlay(); rerender();
          ctx.toast(`${ins.length} crew line${ins.length === 1 ? '' : 's'} added`, 'users');
        } catch (ex) { go.disabled = false; go.innerHTML = `${ui.icon('download')}Add ${add.length} lines`; MPH.icons(); ctx.toastError(ex); }
      });
    }

    /* ---------------- client bid: prepare → draft → preview → send */
    function openPrepare() {
      if (!d.lines.length) return ctx.toast('Add budget lines first', 'info');
      let mode = 'categories';
      const draft = () => snapshot(d.lines, mode);
      const nextV = d.bids.reduce((m, b) => Math.max(m, n(b.version)), 0) + 1;
      const fake = () => ({ version: nextV, note: dlg.querySelector('#pb-note').value.trim(), ...draft() });
      const dlg = ctx.modal(ctx.frame({
        title: `Prepare client bid v${nextV}`,
        sub: 'A snapshot of client prices. Internal cost, markup, margin and line notes are never included.',
        body: `
          <div class="field"><span class="label">Show the client</span>
            <div class="seg" role="group" aria-label="Bid detail">
              <button class="on" data-mode="categories">${ui.icon('layers')}Category totals</button>
              <button data-mode="lines">${ui.icon('list')}Line by line</button>
            </div>
            <span class="tiny faint" id="pb-mode-note">One amount per category (A–J). Empty categories are left out.</span></div>
          <div class="field"><label for="pb-note">Note to the client (optional)</label>
            <textarea id="pb-note" class="textarea" rows="3" placeholder="e.g. This quote assumes two shoot days in Riyadh and one-year GCC digital usage."></textarea></div>
          <div class="stack tight"><span class="label">${ui.icon('eye')} Exactly what the client will see</span><div id="pb-preview">${bidDoc({ version: nextV, note: '', ...draft() }, ctx.production)}</div></div>`,
        foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="pb-save">${ui.icon('save')}Save draft v${nextV}</button>`,
      }), { wide: true });
      const refresh = () => { dlg.querySelector('#pb-preview').innerHTML = bidDoc(fake(), ctx.production); MPH.icons(); };
      dlg.querySelector('.seg').addEventListener('click', (e) => {
        const b = e.target.closest('[data-mode]');
        if (!b) return;
        mode = b.dataset.mode;
        dlg.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
        dlg.querySelector('#pb-mode-note').textContent = mode === 'lines' ? 'Each line’s description and client price. Check descriptions read well for the client.' : 'One amount per category (A–J). Empty categories are left out.';
        refresh();
      });
      dlg.querySelector('#pb-note').addEventListener('input', MPH.debounce(refresh, 250));
      const save = dlg.querySelector('#pb-save');
      save.addEventListener('click', async () => {
        save.disabled = true; save.innerHTML = `${ui.spinner()} Saving`;
        try {
          const snap = draft();
          const version = await api.nextVersion('client_bids', pid);
          const row = api.must(await sb.from('client_bids').insert({
            production_id: pid, version, status: 'draft', lines: snap.lines, subtotal: snap.subtotal, vat: snap.vat, total: snap.total,
            note: dlg.querySelector('#pb-note').value.trim() || null,
          }).select().single());
          d.bids.unshift(row);
          d.bids.sort((a, b) => b.version - a.version);
          rerender();
          openSend(row, true);
        } catch (ex) { save.disabled = false; save.innerHTML = `${ui.icon('save')}Save draft v${nextV}`; MPH.icons(); ctx.toastError(ex); }
      });
    }

    function openPreview(b) {
      if (!b) return;
      if (b.status === 'draft') return openSend(b);
      ctx.modal(ctx.frame({
        title: `Client bid v${esc(b.version)}`,
        sub: `${b.sent_at ? 'Sent ' + esc(MPH.date(b.sent_at, 'long')) : ''}${b.decided_at ? ' · decided ' + esc(MPH.date(b.decided_at, 'long')) : ''}`,
        body: `<div class="row wrap" style="gap:8px">${producerPill(b)}${b.client_note ? `<span class="small bid-cnote">${ui.icon('quote')}${esc(b.client_note)}</span>` : ''}</div>${bidDoc(b, ctx.production)}`,
        foot: `<button class="btn btn-ghost" data-close>Close</button>`,
      }), { wide: true });
    }

    function openSend(b, justSaved = false) {
      if (!b) return;
      const dlg = ctx.modal(ctx.frame({
        title: `Send client bid v${esc(b.version)}`,
        sub: `${esc(ctx.production.client_name || 'Client')}${ctx.production.agency ? ' · via ' + esc(ctx.production.agency) : ''}`,
        body: `
          ${justSaved ? `<div class="callout">${ui.icon('check')}<span class="small"><span class="strong">Draft v${esc(b.version)} saved.</span> Nothing has been sent yet. Clients never see drafts.</span></div>` : ''}
          <p class="small muted">This is exactly what the client’s account shows once you send it:</p>
          ${bidDoc(b, ctx.production)}
          <div class="callout info">${ui.icon('lock')}<span class="small">Not included: unit costs, markup, margin, line notes, crew rates. Clients sign in to see the bid and approve it or ask for changes. No client account yet? <a class="accent" href="#team">Invite them from Team</a>.</span></div>`,
        foot: `<button class="btn btn-ghost" data-close>${justSaved ? 'Keep as draft' : 'Close'}</button><button class="btn btn-primary" id="bs-go">${ui.icon('send')}Send to client</button>`,
      }), { wide: true });
      const go = dlg.querySelector('#bs-go');
      go.addEventListener('click', async () => {
        go.disabled = true; go.innerHTML = `${ui.spinner()} Sending`;
        try {
          const row = api.must(await sb.from('client_bids').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', b.id).eq('status', 'draft').select().single());
          Object.assign(b, row);
          ctx.closeOverlay(); rerender();
          ctx.toast(`Bid v${b.version} sent. The client sees it in their account.`, 'send');
        } catch (ex) { go.disabled = false; go.innerHTML = `${ui.icon('send')}Send to client`; MPH.icons(); ctx.toastError(ex); }
      });
    }
  }

  /* ------------------------------------------------------------ view */
  MPH.view('budget', {
    async load(ctx) {
      const pid = ctx.production.id;
      const { must } = ctx.api;
      if (ctx.isClient) {
        // client path: the published bid object only. Drafts are excluded here too (RLS already hides them from real clients).
        const bids = must(await ctx.sb.from('client_bids')
          .select('id, version, status, lines, subtotal, vat, total, note, client_note, sent_at, decided_at, created_at')
          .eq('production_id', pid).neq('status', 'draft').order('version', { ascending: false }));
        return { mode: 'client', bids: bids || [] };
      }
      if (!ctx.canSeeInternal) return { mode: 'locked' };
      const [lines, bids, people] = await Promise.all([
        ctx.sb.from('budget_lines').select('*').eq('production_id', pid).order('sort').order('created_at'),
        ctx.sb.from('client_bids').select('*').eq('production_id', pid).order('version', { ascending: false }),
        ctx.sb.from('people').select('id, name, role, dept, kind, days, people_rates(day_rate)').eq('production_id', pid),
      ]);
      const crew = (must(people) || []).map(({ people_rates: pr, ...p }) => ({ ...p, day_rate: pr ? pr.day_rate : null }));
      return { mode: 'producer', lines: must(lines) || [], bids: must(bids) || [], people: crew };
    },

    render(ctx, d) {
      const { ui } = ctx;
      if (d.mode === 'client') return renderClient(ctx, d);
      if (d.mode === 'locked') {
        return `<div class="page">
          ${ui.pageHead({ eyebrow: 'Plan', title: 'Budget & Bid' })}
          <div class="panel">${ui.empty('lock', 'Budgets are visible to owners and producers.', 'Internal cost, markup and client bids are limited to owners and producers of the house. Ask a producer if you need a figure.')}</div>
        </div>`;
      }
      return renderProducer(ctx, d);
    },

    mount(root, ctx, d) {
      if (d.mode === 'client') return mountClient(root, ctx, d);
      if (d.mode === 'producer') return mountProducer(root, ctx, d);
    },
  });
})();

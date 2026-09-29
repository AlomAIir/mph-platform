/* Budget & Bid: the client-safe boundary made real.
   Producer path (owners/producers): internal `budget_lines` with cost and markup, and the client bids built from them.
   Client path (client accounts and producer preview): reads ONLY `client_bids` that are not drafts. It never queries
   budget_lines or people, so no internal number can reach a client screen. RLS enforces the same rule in the database.
   Also here: the workspace rate card (rate_cards, owners/producers) that calibrates "Draft with AI", and change orders
   (client price on change_orders, internal cost in change_order_costs). Clients see sent change orders and decide them
   through rpc('decide_change_order'); client mode never reads change_order_costs or rate_cards. */
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
  const S = { closed: {}, viewBid: {}, pendingAI: {}, pendingRC: {} };
  const closedFor = (pid) => (S.closed[pid] = S.closed[pid] || new Set());
  const plural = (k, one, many) => `${k} ${k === 1 ? one : (many || one + 's')}`;
  const signed = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(0)}%`;

  /* ------------------------------------------------------------ rate card: reference jobs
     Rates imported from a past budget carry the job in their source, e.g.
     "Past budget: Tawuniya.pdf (2 shoot days, SAR 245,000)". The budget AI never reads `source`, so this stays out of prompts. */
  const REF_RE = /\((\d+) shoot days?, SAR ([\d,]+(?:\.\d+)?)\)\s*$/;
  function refJobs(rates) {
    const m = new Map();
    (rates || []).forEach((r) => {
      const x = REF_RE.exec(r.source || '');
      if (!x) return;
      if (!m.has(r.source)) {
        m.set(r.source, { source: r.source, label: r.source.replace(REF_RE, '').replace(/^Past budget:\s*/i, '').trim() || 'Past budget', days: Number(x[1]), total: Number(x[2].replace(/,/g, '')), lines: 0 });
      }
      m.get(r.source).lines += 1;
    });
    return [...m.values()];
  }
  const refSource = (label, job) => {
    const days = Math.max(0, Math.round(n(job && job.shoot_days)));
    const total = Math.round(n(job && job.total));
    return total > 0 ? `${label} (${plural(days, 'shoot day')}, SAR ${total.toLocaleString('en-US')})` : label;
  };

  /* ------------------------------------------------------------ change orders
     change_orders.price is what the client pays (excl. VAT). The internal cost sits in change_order_costs, which only
     owners and producers can read; client mode never queries it. */
  const coApproved = (cos) => sum((cos || []).filter((c) => c.status === 'approved'), (c) => n(c.price));
  const coPill = (c, client = false) => {
    const { ui } = MPH;
    return ({
      draft: ui.pill('Draft', '', 'file-pen-line'),
      sent: client ? ui.pill('Awaiting your decision', 'warn', 'clock') : ui.pill('With client', 'warn', 'send'),
      approved: ui.pill('Approved', 'ok', 'check'),
      declined: ui.pill('Declined', 'danger', 'x'),
    })[c.status] || ui.pill(c.status);
  };

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

  /* ------------------------------------------------------------ client path: client_bids + sent change orders only */
  function clientCOs(ctx, d) {
    const { ui } = ctx;
    const cos = d.cos || [];
    if (!cos.length) return '';
    const preview = !ctx.realClient;
    const appr = coApproved(cos);
    const waiting = cos.filter((c) => c.status === 'sent').length;
    return ui.panel({
      title: `Change orders · ${cos.length}`, icon: 'file-diff', flush: true,
      actions: waiting ? ui.pill(`${waiting} waiting for you`, 'warn', 'clock') : '',
      body: `
        <p class="small muted rc-co-intro">Changes to the agreed scope, each priced separately from the quote. Approving one adds its price to what you pay.${preview ? ` <span class="bid-int-text">${ui.icon('eye')}Clients see Approve and Decline here. They’re disabled in preview.</span>` : ''}</p>
        <div class="list">${cos.map((c) => `
          <div class="list-row rc-co-row">
            <span class="mono small strong rc-co-code">${esc(c.code || 'CO')}</span>
            <div class="grow stack" style="gap:3px">
              <span class="small strong">${esc(c.title)}</span>
              ${c.reason ? `<span class="small muted rc-pre">${esc(c.reason)}</span>` : ''}
              <span class="row wrap" style="gap:8px">${coPill(c, true)}<span class="tiny muted">${c.sent_at ? 'Sent ' + esc(MPH.date(c.sent_at)) : ''}${c.decided_at ? ' · decided ' + esc(MPH.date(c.decided_at)) : ''}</span></span>
              ${c.client_note ? `<span class="small bid-cnote">${ui.icon('quote')}${esc(c.client_note)}</span>` : ''}
            </div>
            <div class="stack rc-co-price" style="gap:2px"><span class="num strong nowrap">${MPH.sar(c.price)}</span><span class="tiny faint nowrap">excl. VAT</span></div>
            ${c.status === 'sent' ? `<div class="row wrap rc-co-act">
              <button class="btn btn-xs btn-primary" data-b="co-approve" data-id="${c.id}" ${preview ? 'disabled' : ''}>${ui.icon('check')}Approve</button>
              <button class="btn btn-xs btn-outline" data-b="co-decline" data-id="${c.id}" ${preview ? 'disabled' : ''}>${ui.icon('x')}Decline</button></div>` : ''}
          </div>`).join('')}</div>
        ${appr ? `<div class="rc-co-sum"><span class="small muted grow">Approved changes</span><span class="num small">${MPH.sar(appr)} excl. VAT</span><span class="num small strong">${MPH.sar(appr * (1 + VAT))} incl. VAT</span></div>` : ''}`,
    });
  }

  function renderClient(ctx, d) {
    const { ui, production: p } = ctx;
    const preview = !ctx.realClient;
    if (!d.bids.length) {
      return `<div class="page">
        ${ui.pageHead({ eyebrow: 'Budget', title: 'Your quote', sub: esc(p.title) })}
        <div class="panel">${ui.empty('receipt', 'No quote shared yet', preview
          ? 'Your client sees their quote here once you send a client bid. Drafts never appear in this view.'
          : 'Your producer will share the quote here. You’ll be able to approve it or ask for changes.')}</div>
        ${clientCOs(ctx, d)}
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
          <div class="bid-tot ${coApproved(d.cos) ? '' : 'bid-tot-hero'}">${ui.stat(MPH.sar(b.total), 'Total incl. VAT')}</div>
          ${coApproved(d.cos) ? `<div class="bid-tot">${ui.stat('+' + MPH.sar(coApproved(d.cos)), 'Approved changes', '<span class="tiny faint">Excl. VAT</span>')}</div>
          <div class="bid-tot bid-tot-hero">${ui.stat(MPH.sar(r2(n(b.subtotal) + coApproved(d.cos)) * (1 + VAT)), 'Quote + changes incl. VAT')}</div>` : ''}
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
        ${clientCOs(ctx, d)}
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
      if (act === 'co-approve' || act === 'co-decline') {
        if (!ctx.realClient) return; // preview: never decide on the client's behalf
        const co = (d.cos || []).find((c) => c.id === el.dataset.id);
        if (co && co.status === 'sent') decideCO(co, act === 'co-approve');
        return;
      }
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

    function decideCO(co, approve) {
      const label = approve ? 'Approve change' : 'Decline change';
      const dlg = ctx.modal(ctx.frame({
        title: `${approve ? 'Approve' : 'Decline'} ${esc(co.code || 'change order')}`,
        sub: `${esc(co.title)} · ${MPH.sar(co.price)} excl. VAT`,
        body: `${approve
            ? `<p>Approving tells your producer to go ahead with this change. <span class="strong num">${MPH.sar(co.price)}</span> excl. VAT (<span class="num">${MPH.sar(n(co.price) * (1 + VAT))}</span> incl. VAT) is added to what you pay.</p>`
            : '<p>Declining tells your producer not to go ahead. Nothing is added to what you pay.</p>'}
          ${co.reason ? `<div class="callout info">${ui.icon('info')}<span class="small">${esc(co.reason)}</span></div>` : ''}
          <div class="field"><label for="co-note">${approve ? 'Note to your producer (optional)' : 'Why, or what would work instead? (optional)'}</label>
            <textarea id="co-note" class="textarea" rows="3" placeholder="${approve ? 'e.g. Approved. Please add it to the next invoice.' : 'e.g. Let’s keep the original location and skip the extra day.'}"></textarea></div>`,
        foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn ${approve ? 'btn-primary' : 'btn-outline'}" id="co-go">${ui.icon(approve ? 'check' : 'x')}${label}</button>`,
      }));
      const go = dlg.querySelector('#co-go');
      go.addEventListener('click', async () => {
        go.disabled = true; go.innerHTML = `${ui.spinner()} Sending`;
        try {
          ctx.api.must(await ctx.sb.rpc('decide_change_order', { p_id: co.id, p_decision: approve ? 'approved' : 'declined', p_note: dlg.querySelector('#co-note').value.trim() || null }));
          ctx.closeOverlay();
          ctx.toast(approve ? `${co.code || 'Change order'} approved. Your producer can see it now.` : `${co.code || 'Change order'} declined. Your producer can see your decision.`, approve ? 'check' : 'x');
          ctx.reload();
        } catch (ex) { go.disabled = false; go.innerHTML = `${ui.icon(approve ? 'check' : 'x')}${label}`; MPH.icons(); ctx.toastError(ex); }
      });
    }
  }

  /* ------------------------------------------------------------ producer path */
  function totalsOf(lines) {
    const c = sum(lines, cost), pr = sum(lines, price);
    return { cost: c, client: pr, margin: pr - c, vat: pr * VAT, total: pr * (1 + VAT) };
  }

  function totalsHtml(lines, cos = []) {
    const { ui } = MPH;
    const T = totalsOf(lines);
    const appr = (cos || []).filter((c) => c.status === 'approved');
    const ch = coApproved(appr), chCost = sum(appr, (c) => n(c.cost));
    const base = T.client + ch;
    return `
      <div class="bid-totals" data-totals>
        <div class="bid-tot bid-tot-int">${ui.stat(MPH.sar(T.cost), 'Internal cost', `<span class="tiny">${ui.lockNote('Internal')}</span>`)}</div>
        <div class="bid-tot">${ui.stat(MPH.sar(T.client), 'Client subtotal', '<span class="tiny faint">Before VAT</span>')}</div>
        <div class="bid-tot bid-tot-int">${ui.stat(`${MPH.sar(T.margin)} <span class="bid-pct">${T.client ? MPH.pct(T.margin / T.client, 1) : '—'}</span>`, 'Margin', `<span class="tiny">${ui.lockNote('Internal')}</span>`)}</div>
        ${(cos || []).length ? `<div class="bid-tot">${ui.stat(`+${MPH.sar(ch)}`, 'Approved changes', `<span class="tiny faint">${appr.length ? `${plural(appr.length, 'change order')} · cost ${MPH.sar(chCost)}` : 'None approved yet'}</span>`)}</div>` : ''}
        <div class="bid-tot">${ui.stat(MPH.sar(base * VAT), 'VAT 15%')}</div>
        <div class="bid-tot bid-tot-hero">${ui.stat(MPH.sar(base * (1 + VAT)), 'Client total incl. VAT', ch ? `<span class="tiny faint">Includes ${MPH.sar(ch)} approved changes</span>` : '')}</div>
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
        ${d.lines.length ? '' : `<div class="bid-first">${ui.empty('calculator', 'Start the budget', d.rates.length
            ? `Draft every line with AI from your rate card (${plural(d.rates.length, 'rate')}) and the breakdown, pull in crew day rates, or add lines by hand in any category below.`
            : 'Draft every line with AI from the breakdown, pull in crew day rates, or add lines by hand in any category below. Import one of your past budgets into the rate card first so the AI prices the way you do.',
          `<div class="row wrap" style="justify-content:center"><button class="btn btn-primary btn-sm" data-b="ai">${ui.icon('sparkles')}Draft with AI</button>${d.rates.length ? '' : `<button class="btn btn-sm" data-b="ratecard" data-view="import">${ui.icon('tags')}Import a past budget</button>`}<button class="btn btn-sm" data-b="import">${ui.icon('users')}Import crew costs</button><button class="btn btn-sm btn-ghost" data-b="add" data-cat="A">${ui.icon('plus')}Add a line</button></div>`)}</div>`}
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

  function coPanel(ctx, d) {
    const { ui } = ctx;
    const cos = d.cos;
    const appr = cos.filter((c) => c.status === 'approved');
    const lockTh = (label) => `<th class="r rc-int" title="Internal only. Never sent to client accounts.">${ui.icon('lock')}${label}</th>`;
    const row = (c) => {
      const has = c.cost != null;
      const m = n(c.price) - n(c.cost);
      return `<tr class="rc-co-line" data-id="${c.id}">
        <td class="mono small strong nowrap">${esc(c.code || '—')}</td>
        <td><div class="stack" style="gap:2px"><span class="small strong">${esc(c.title)}</span>
          ${c.reason ? `<span class="tiny muted rc-clamp">${esc(c.reason)}</span>` : ''}
          ${c.client_note ? `<span class="tiny bid-cnote">${ui.icon('quote')}${esc(c.client_note)}</span>` : ''}</div></td>
        <td><div class="stack" style="gap:2px;align-items:flex-start">${coPill(c)}<span class="tiny faint nowrap">${c.status === 'draft' ? 'Not visible to the client' : c.decided_at ? 'Decided ' + esc(MPH.date(c.decided_at)) : c.sent_at ? 'Sent ' + esc(MPH.date(c.sent_at)) : ''}</span></div></td>
        <td class="r rc-int num small">${has ? bare(c.cost) : '<span class="faint">—</span>'}</td>
        <td class="r num small strong">${bare(c.price)}</td>
        <td class="r rc-int num small">${has && n(c.price) ? `${bare(m)} <span class="tiny faint">${MPH.pct(m / n(c.price), 0)}</span>` : '<span class="faint">—</span>'}</td>
        <td class="r nowrap"><div class="row" style="gap:4px;justify-content:flex-end">
          ${c.status === 'draft' ? `<button class="btn btn-xs btn-primary" data-b="co-send" data-id="${c.id}">${ui.icon('send')}Send to client</button>` : ''}
          <button class="btn btn-xs btn-ghost" data-b="co-edit" data-id="${c.id}">${ui.icon(c.status === 'draft' ? 'pencil' : 'lock')}${c.status === 'draft' ? 'Edit' : 'Cost'}</button>
          ${c.status === 'draft' ? `<button class="btn btn-xs btn-ghost btn-icon bid-del" data-b="co-del" data-id="${c.id}" aria-label="Delete draft ${esc(c.code || '')}" title="Delete draft">${ui.icon('trash-2')}</button>` : ''}
        </div></td></tr>`;
    };
    return ui.panel({
      title: `Change orders · ${cos.length}`, icon: 'file-diff', flush: true,
      actions: `${ui.lockNote('Cost and margin are internal')}<button class="btn btn-sm btn-outline" data-b="co-new">${ui.icon('plus')}New change order</button>`,
      body: cos.length ? `<div class="table-wrap"><table class="table rc-co-t">
          <thead><tr><th style="width:74px">Code</th><th>Change</th><th>Status</th>${lockTh('Internal cost')}<th class="r">Client price</th>${lockTh('Margin')}<th></th></tr></thead>
          <tbody>${cos.map(row).join('')}</tbody>
          <tfoot><tr class="bid-total"><td></td><td colspan="2" class="strong">Approved changes <span class="tiny faint">· ${appr.length} of ${cos.length}</span></td>
            <td class="r rc-int num strong">${bare(sum(appr, (c) => n(c.cost)))}</td><td class="r num strong">${bare(coApproved(appr))}</td>
            <td class="r rc-int num">${bare(coApproved(appr) - sum(appr, (c) => n(c.cost)))}</td><td></td></tr></tfoot>
        </table></div>`
        : `<div class="panel-body"><p class="small muted">No change orders yet. When the client asks for something outside the agreed quote, such as an extra shoot day, a new location or more cast, raise a change order: you set the client price and keep the cost internal. The client approves or declines it from their account.</p></div>`,
    });
  }

  function renderProducer(ctx, d) {
    const { ui, production: p } = ctx;
    const rc = d.rates.length;
    return `
      <div class="page">
        ${ui.pageHead({
          eyebrow: 'Plan · Commercial bid',
          title: 'Budget & Bid',
          sub: `Internal budget and client bids for ${esc(p.title)}. Figures in SAR, VAT added on the client total.`,
          actions: `
            <button class="btn btn-sm btn-outline" data-b="import">${ui.icon('users')}Import crew costs</button>
            <span class="rc-aipair">
              <button class="btn btn-sm btn-outline" data-b="ratecard" title="Your workspace’s real rates. Draft with AI prices from them first.">${ui.icon('tags')}Rate card <span class="rc-count ${rc ? '' : 'none'}" data-rc-count>${rc}</span></button>
              <button class="btn btn-sm" data-b="ai" title="${rc ? `Uses the ${plural(rc, 'rate')} on your rate card` : 'Your rate card is empty: every line will be an estimate'}">${ui.icon('sparkles')}Draft with AI</button>
            </span>
            <button class="btn btn-sm btn-primary" data-b="prepare" ${d.lines.length ? '' : 'disabled'}>${ui.icon('file-output')}Prepare client bid</button>`,
        })}
        <div class="callout info">${ui.icon('lock')}<div><span class="strong">Internal figures and client figures are separate objects. Client accounts have no path to internal ones.</span>
          <span class="muted"> Budget lines (unit cost, markup, margin, notes) are readable only by owners and producers, enforced by the database. A client bid is a separate snapshot of client prices that you prepare and send. Check it with “Preview client view” in the top bar.</span></div></div>
        ${totalsHtml(d.lines, d.cos)}
        ${linesTable(ctx, d)}
        <div class="bid-bids">${bidsPanel(ctx, d)}</div>
        <div class="rc-cos">${coPanel(ctx, d)}</div>
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
      if (t) t.outerHTML = totalsHtml(d.lines, d.cos);
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
        if (act === 'ratecard') return openRateCard(el.dataset.view || 'table');
        if (act === 'co-new') return openCO(null);
        if (act === 'co-edit') return openCO(d.cos.find((c) => c.id === el.dataset.id));
        if (act === 'co-send') return await sendCO(el);
        if (act === 'co-del') return await delCO(el);
      } catch (ex) { ctx.toastError(ex); }
    });

    /* arm-to-confirm for small destructive or outward buttons */
    const arm = (el, html, restore) => {
      if (el.dataset.armed === '1') return true;
      el.dataset.armed = '1';
      const was = { cls: el.className, html: el.innerHTML };
      el.classList.add(...(restore || ['btn-danger'])); el.classList.remove('btn-icon', 'btn-ghost');
      el.innerHTML = html; MPH.icons();
      setTimeout(() => { if (el.isConnected && el.dataset.armed === '1') { el.dataset.armed = ''; el.className = was.cls; el.innerHTML = was.html; MPH.icons(); } }, 3500);
      return false;
    };
    const repaintCOs = () => {
      const w = root.querySelector('.rc-cos'); if (w) w.innerHTML = coPanel(ctx, d);
      const t = root.querySelector('[data-totals]'); if (t) t.outerHTML = totalsHtml(d.lines, d.cos);
      MPH.icons();
    };
    const refreshCount = () => {
      root.querySelectorAll('[data-rc-count]').forEach((x) => { x.textContent = d.rates.length; x.classList.toggle('none', !d.rates.length); });
      const b = root.querySelector('.page-head [data-b="ai"]');
      if (b) b.title = d.rates.length ? `Uses the ${plural(d.rates.length, 'rate')} on your rate card` : 'Your rate card is empty: every line will be an estimate';
    };

    /* ---------------- change orders (producer) */
    function openCO(co) {
      const isNew = !co;
      const locked = !!co && co.status !== 'draft';
      const v = co || { title: '', reason: '', price: 0, cost: null };
      const dlg = ctx.modal(ctx.frame({
        title: isNew ? 'New change order' : locked ? `${esc(co.code || 'Change order')} · internal cost` : `Edit ${esc(co.code || 'change order')}`,
        sub: locked ? `${esc(co.title)} · the client has this at ${MPH.sar(co.price)}. Only the internal cost can change.` : 'Saved as a draft. The client sees it only after you send it.',
        body: `
          <div class="field"><label for="co-title">What changes</label><input id="co-title" class="input" value="${esc(v.title)}" placeholder="e.g. Extra half day at the desert location" ${locked ? 'disabled' : ''}></div>
          <div class="field"><label for="co-reason">Reason the client sees</label><textarea id="co-reason" class="textarea" rows="3" placeholder="e.g. The client asked to add a sunrise scene on day 2, which needs a 04:00 call and a second location." ${locked ? 'disabled' : ''}>${esc(v.reason || '')}</textarea></div>
          <div class="grid-2">
            <div class="field"><label for="co-price">Client price (SAR, excl. VAT)</label><input id="co-price" class="input num" type="number" min="0" step="any" inputmode="decimal" value="${esc(n(v.price))}" ${locked ? 'disabled' : ''}></div>
            <div class="field"><label for="co-cost">${ui.icon('lock')} Internal cost (SAR)</label><input id="co-cost" class="input num" type="number" min="0" step="any" inputmode="decimal" value="${v.cost == null ? '' : esc(n(v.cost))}" placeholder="What it costs you"></div>
          </div>
          <div class="rc-co-calc" id="co-calc"></div>
          <div data-co-err hidden></div>`,
        foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="co-save">${ui.icon('save')}${isNew ? 'Save draft' : 'Save'}</button>`,
      }));
      const $ = (s) => dlg.querySelector(s);
      const calc = () => {
        const p = n($('#co-price').value), c = n($('#co-cost').value);
        $('#co-calc').innerHTML = `<span class="small muted">Client pays <span class="num strong">${MPH.sar(p * (1 + VAT))}</span> incl. VAT</span>
          <span class="small bid-int-text">${ui.icon('lock')}Margin <span class="num strong">${MPH.sar(p - c)}</span>${p ? ` · ${MPH.pct((p - c) / p, 0)}` : ''}</span>`;
        MPH.icons();
      };
      calc();
      $('#co-price').addEventListener('input', calc);
      $('#co-cost').addEventListener('input', calc);
      const save = $('#co-save');
      save.addEventListener('click', async () => {
        const fail = (m) => { const b = $('[data-co-err]'); b.hidden = false; b.innerHTML = ui.errorBox(m); MPH.icons(); };
        const title = $('#co-title').value.trim();
        const priceV = $('#co-price').value.trim() === '' ? 0 : Number($('#co-price').value);
        const costRaw = $('#co-cost').value.trim();
        const costV = costRaw === '' ? null : Number(costRaw);
        if (!locked && !title) { $('#co-title').focus(); return fail('Say what changes, in a few words the client will understand.'); }
        if (!Number.isFinite(priceV) || priceV < 0) return fail('Enter the client price as a number, or 0.');
        if (costV != null && (!Number.isFinite(costV) || costV < 0)) return fail('Enter the internal cost as a number, or leave it empty.');
        save.disabled = true; save.innerHTML = `${ui.spinner()} Saving`;
        try {
          let row = co;
          if (isNew) {
            const codes = new Set(d.cos.map((c) => c.code));
            let k = d.cos.length + 1, code;
            do { code = `CO-${String(k).padStart(2, '0')}`; k += 1; } while (codes.has(code));
            row = api.must(await sb.from('change_orders').insert({
              production_id: pid, code, title, reason: $('#co-reason').value.trim() || null, price: priceV, status: 'draft', created_by: ctx.session.user.id,
            }).select().single());
          } else if (!locked) {
            row = api.must(await sb.from('change_orders').update({ title, reason: $('#co-reason').value.trim() || null, price: priceV }).eq('id', co.id).eq('status', 'draft').select().single());
          }
          if (costV != null) api.must(await sb.from('change_order_costs').upsert({ change_order_id: row.id, production_id: pid, cost: costV }));
          else if (!isNew && co.cost != null) api.must(await sb.from('change_order_costs').delete().eq('change_order_id', row.id));
          const merged = { ...row, cost: costV };
          if (isNew) d.cos.unshift(merged); else Object.assign(co, merged);
          ctx.closeOverlay(); repaintCOs();
          ctx.toast(isNew ? `${merged.code} saved as a draft. Send it when it’s ready.` : 'Change order saved', 'check');
        } catch (ex) { save.disabled = false; save.innerHTML = `${ui.icon('save')}${isNew ? 'Save draft' : 'Save'}`; MPH.icons(); fail(ex.message || String(ex)); }
      });
    }

    async function sendCO(el) {
      const co = d.cos.find((c) => c.id === el.dataset.id);
      if (!co) return;
      if (!arm(el, `${ui.icon('send')}Send ${MPH.sar(co.price)}?`, ['btn-primary'])) return;
      el.disabled = true; el.innerHTML = `${ui.spinner()} Sending`;
      try {
        const row = api.must(await sb.from('change_orders').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', co.id).eq('status', 'draft').select().single());
        Object.assign(co, row);
        repaintCOs();
        ctx.toast(`${co.code || 'Change order'} sent. The client can approve or decline it in their account.`, 'send');
      } catch (ex) { el.disabled = false; repaintCOs(); throw ex; }
    }

    async function delCO(el) {
      if (!arm(el, `${ui.icon('trash-2')}Delete draft?`)) return;
      const id = el.dataset.id;
      api.must(await sb.from('change_orders').delete().eq('id', id).eq('status', 'draft'));
      d.cos = d.cos.filter((c) => c.id !== id);
      repaintCOs();
      ctx.toast('Draft change order deleted', 'trash-2');
    }

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
    const LEVELS = [
      ['lean', 'Lean', 'The smallest crew that can deliver. Right for most corporate and digital work.'],
      ['standard', 'Standard', 'A normal TVC crew.'],
      ['premium', 'Premium', 'A large broadcast TVC crew.'],
    ];
    function openAI() {
      const rc = d.rates.length;
      const refs = refJobs(d.rates);
      const defDays = d.shootDays || 1;
      let level = 'lean';
      const dlg = ctx.modal(ctx.frame({
        title: 'Draft the budget with AI',
        sub: 'Claude prices the job from your rate card first, then reads the scenes, accepted breakdown elements and crew day rates.',
        body: `
          <div class="rc-ai-card ${rc ? '' : 'empty'}">${ui.icon(rc ? 'tags' : 'triangle-alert')}
            <div class="grow stack tight" style="gap:1px">
              <span class="small strong">${rc ? `Your rate card holds ${plural(rc, 'rate')}` : 'Your rate card is empty'}</span>
              <span class="tiny muted">${rc ? `The draft uses these rates and packages first${refs.length ? `, with ${plural(refs.length, 'past job')} for scale` : ''}. Anything the card doesn’t cover is marked as an estimate.` : 'Every line will be an estimate. Import one of your past budgets first for a draft that prices the way you really do.'}</span>
            </div>
            <button class="btn btn-xs btn-outline" data-ai-rc>${ui.icon(rc ? 'tags' : 'upload')}${rc ? 'Open rate card' : 'Import a past budget'}</button>
          </div>
          <div class="rc-ai-grid">
            <div class="field"><label for="ai-days">Shoot days</label>
              <input id="ai-days" class="input num rc-days" type="number" min="1" max="60" step="1" inputmode="numeric" value="${defDays}">
              <span class="tiny faint">${d.shootDays ? `${plural(d.shootDays, 'shoot day')} on the stripboard` : 'No shoot days on the stripboard yet'}</span></div>
            <div class="field"><span class="label" id="ai-lvl-l">Crew level</span>
              <div class="seg rc-seg" role="radiogroup" aria-labelledby="ai-lvl-l">${LEVELS.map(([id, label]) => `<button type="button" role="radio" data-lvl="${id}" aria-checked="${id === level}" class="${id === level ? 'on' : ''}">${label}</button>`).join('')}</div>
              <span class="tiny faint" id="ai-lvl-note">${LEVELS[0][2]}</span></div>
          </div>
          <label class="check rc-check"><input type="checkbox" id="ai-loc"><span>The client provides the location <span class="tiny faint">· no location fee is budgeted</span></span></label>
          <div class="field"><label for="ai-brief">Notes for the AI (optional)</label>
            <textarea id="ai-brief" class="textarea" rows="3" placeholder="e.g. One-year GCC digital usage, grade and mix in-house, no drone, cast through our usual cast manager."></textarea>
            <span class="tiny faint">Anything the script doesn’t say: usage, travel, deliverables, rates you already agreed.</span></div>
          <div class="callout info">${ui.icon('lock')}<span class="small">The draft is internal. You review every line before it’s added, and nothing reaches the client until you prepare and send a client bid.</span></div>
          <div id="ai-status"></div>`,
        foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="ai-go">${ui.icon('sparkles')}Draft budget</button>`,
      }), { wide: true });
      dlg.querySelector('[data-ai-rc]').addEventListener('click', () => openRateCard(rc ? 'table' : 'import'));
      if (S.pendingAI[pid]) { const pend = S.pendingAI[pid]; delete S.pendingAI[pid]; return showAIResult(dlg, pend.out, pend.params); }
      const seg = dlg.querySelector('.rc-seg');
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('[data-lvl]');
        if (!b || b.disabled) return;
        level = b.dataset.lvl;
        seg.querySelectorAll('[data-lvl]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
        dlg.querySelector('#ai-lvl-note').textContent = LEVELS.find((l) => l[0] === level)[2];
      });
      const go = dlg.querySelector('#ai-go');
      const inputs = () => [...dlg.querySelectorAll('#ai-days, #ai-loc, #ai-brief, [data-lvl]')];
      go.addEventListener('click', async () => {
        const days = Math.round(Number(dlg.querySelector('#ai-days').value));
        if (!Number.isFinite(days) || days < 1 || days > 60) { dlg.querySelector('#ai-days').focus(); return ctx.toast('Enter the number of shoot days, from 1 to 60', 'triangle-alert', 'error'); }
        const params = { brief: dlg.querySelector('#ai-brief').value.trim() || undefined, shoot_days: days, client_location: dlg.querySelector('#ai-loc').checked, crew_level: level };
        const status = dlg.querySelector('#ai-status');
        go.disabled = true; go.innerHTML = `${ui.spinner()} Drafting`;
        inputs().forEach((x) => { x.disabled = true; });
        const t0 = Date.now();
        status.innerHTML = `<div class="bid-ai-run"><span class="spin"></span><div class="stack tight" style="gap:2px"><span class="small strong">Pricing ${plural(days, 'shoot day')} at a ${level} crew level${rc ? ' from your rate card' : ''}…</span><span class="tiny muted">This usually takes 30 to 90 seconds. <span id="ai-secs">0</span>s so far. You can close this window; the draft will be waiting when you reopen it.</span></div></div>`;
        const timer = setInterval(() => { const s = dlg.querySelector('#ai-secs'); if (s) s.textContent = Math.round((Date.now() - t0) / 1000); }, 1000);
        try {
          const out = await api.ai('budget', { production_id: pid, ...params });
          clearInterval(timer);
          if (!out || !Array.isArray(out.lines) || !out.lines.length) throw new Error('The AI didn’t return any lines. Add scenes or notes and try again.');
          if (!dlg.isConnected) { S.pendingAI[pid] = { out, params }; ctx.toast('Your AI budget draft is ready. Choose Draft with AI to review it.', 'sparkles'); return; }
          showAIResult(dlg, out, params);
        } catch (ex) {
          clearInterval(timer);
          if (!dlg.isConnected) return ctx.toastError(ex);
          status.innerHTML = ui.errorBox(ex.message || String(ex));
          go.disabled = false; go.innerHTML = `${ui.icon('sparkles')}Try again`;
          inputs().forEach((x) => { x.disabled = false; });
          MPH.icons();
        }
      });
    }

    /* the draft against the reference jobs on the rate card (their totals are as read from each past budget) */
    function compareHtml(T, params) {
      const refs = refJobs(d.rates);
      const days = n(params && params.shoot_days) || null;
      const lvl = (LEVELS.find((l) => l[0] === (params && params.crew_level)) || LEVELS[0])[1];
      if (!refs.length) {
        return `<p class="tiny muted rc-cmp-none">${ui.icon('scale')}No past jobs on your rate card yet, so there’s nothing to compare this draft with. Import a past budget to see the comparison here next time.</p>`;
      }
      const tone = (x) => (Math.abs(x) <= 0.15 ? 'ok' : Math.abs(x) <= 0.4 ? 'warn' : 'danger');
      return `<div class="rc-cmp">
        <div class="rc-cmp-head">${ui.icon('scale')}<span class="small strong grow">Against your past jobs</span><span class="tiny faint">Client price before VAT</span></div>
        <div class="rc-cmp-row me"><span class="grow small"><span class="strong">This draft</span> · ${days ? plural(days, 'shoot day') : 'days not set'} · ${esc(lvl)}${params && params.client_location ? ' · client location' : ''}</span>
          <span class="num small muted nowrap">${ui.icon('lock')}cost ${MPH.sar(T.cost)}</span><span class="num small strong nowrap">${MPH.sar(T.client)}</span><span class="rc-delta"></span></div>
        ${refs.map((r) => {
          const x = r.total ? (T.client - r.total) / r.total : null;
          const perDay = days && r.days && days !== r.days && r.total ? ((T.client / days) - (r.total / r.days)) / (r.total / r.days) : null;
          return `<div class="rc-cmp-row"><span class="grow small truncate" title="${esc(r.source)}">${esc(r.label)} · ${r.days ? plural(r.days, 'shoot day') : 'days unknown'}</span>
            <span class="num small nowrap">${MPH.sar(r.total)}</span>
            <span class="rc-delta ${x == null ? '' : tone(x)}">${x == null ? '—' : `${signed(x)}${perDay != null ? ` <span class="tiny faint">· ${signed(perDay)} per day</span>` : ''}`}</span></div>`;
        }).join('')}
        <span class="tiny faint">Past totals are as read from each budget. Check whether they included markup or VAT before comparing.</span>
      </div>`;
    }

    function showAIResult(dlg, out, params = {}) {
      const lines = out.lines.map((l, i) => ({
        i, category: catIds.includes(l.category) ? l.category : 'A', description: String(l.description || 'Item'),
        qty: n(l.qty) || 1, unit: l.unit || 'flat', unit_cost: n(l.unit_cost), markup_pct: n(l.markup_pct), notes: l.notes || '',
      }));
      const T = totalsOf(lines);
      const body = dlg.querySelector('.overlay-body');
      const foot = dlg.querySelector('.overlay-foot');
      dlg.querySelector('.overlay-head .h2').textContent = 'Review the AI draft';
      body.innerHTML = `
        ${Array.isArray(out.assumptions) && out.assumptions.length ? `<details class="bid-assume rc-assume" open><summary class="small strong">${ui.icon('list-checks')}Assumptions the AI made · ${out.assumptions.length}</summary><ul>${out.assumptions.map((a) => `<li class="small">${esc(a)}</li>`).join('')}</ul></details>` : ''}
        ${compareHtml(T, params)}
        <div class="row wrap between">
          <span class="small">${ui.aiBadge(`${lines.length} lines`)} <span class="muted">· internal <span class="num">${MPH.sar(T.cost)}</span> · client <span class="num">${MPH.sar(T.client)}</span> before VAT</span></span>
          <label class="check small"><input type="checkbox" id="ai-all" checked> Select all</label>
        </div>
        ${d.lines.length ? `<div class="callout info">${ui.icon('info')}<span class="small">These add to your existing ${d.lines.length} line${d.lines.length === 1 ? '' : 's'}. Nothing is replaced.</span></div>` : ''}
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

    /* ---------------- rate card (per workspace: rate_cards where org_id = production.org_id; owners and producers only) */
    function openRateCard(view = 'table') {
      const org = ctx.production.org_id;
      const orgName = ((ctx.session.orgs || []).find((o) => o.id === org) || {}).name || 'Your workspace';
      const dlg = ctx.modal(ctx.frame({
        title: 'Rate card',
        sub: `${esc(orgName)} · your real rates. Draft with AI prices every budget from these first.`,
        body: '<div class="stack rc-body" data-rc-body></div>',
        foot: '<span></span>',
      }), { wide: true });
      dlg.classList.add('rc-modal');
      const body = dlg.querySelector('[data-rc-body]');
      const foot = dlg.querySelector('.overlay-foot');
      const title = dlg.querySelector('.overlay-head .h2');
      const R = { q: '', mode: 'file', file: null, text: '', running: false };
      const catOpts = (sel) => CATS.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''} title="${esc(c.name)}">${c.id} · ${esc(c.name)}</option>`).join('');
      const unitOpts = (sel) => [...new Set([...UNITS, sel || 'day'])].map((u) => `<option value="${esc(u)}" ${u === sel ? 'selected' : ''}>${esc(u)}</option>`).join('');
      const sorted = () => [...d.rates].sort((a, b) => (catIds.indexOf(a.category) - catIds.indexOf(b.category)) || String(a.item).localeCompare(String(b.item)));

      /* ---- table view */
      const rateRow = (r) => `
        <tr class="rc-line" data-rc-id="${r.id}">
          <td class="rc-w-cat"><select class="cell-input" data-f="category" aria-label="Category">${catOpts(r.category)}</select></td>
          <td class="rc-w-item"><input class="cell-input" data-f="item" value="${esc(r.item)}" aria-label="Item"></td>
          <td class="rc-w-unit"><select class="cell-input" data-f="unit" aria-label="Unit">${unitOpts(r.unit)}</select></td>
          <td class="rc-w-rate"><input class="cell-input num" type="number" step="any" min="0" inputmode="decimal" data-f="rate" value="${esc(n(r.rate))}" aria-label="Rate in SAR"></td>
          <td class="rc-w-who"><input class="cell-input" data-f="who" value="${esc(r.who || '')}" placeholder="Supplier or person" aria-label="Who"></td>
          <td class="rc-w-notes"><input class="cell-input" data-f="notes" value="${esc(r.notes || '')}" placeholder="What the rate covers" aria-label="Notes"></td>
          <td class="rc-w-src"><input class="cell-input" data-f="source" value="${esc(r.source || '')}" placeholder="Where it came from" aria-label="Source"></td>
          <td class="r"><button class="btn btn-xs btn-ghost btn-icon bid-del" data-rc="del" data-id="${r.id}" aria-label="Delete rate" title="Delete rate">${ui.icon('trash-2')}</button></td>
        </tr>`;
      const tableHtml = () => {
        const q = R.q.trim().toLowerCase();
        const list = sorted().filter((r) => !q || [r.item, r.who, r.notes, r.source, catOf(r.category).name].join(' ').toLowerCase().includes(q));
        if (!list.length) return `<div class="rc-none small muted">No rates match “${esc(R.q)}”.</div>`;
        let last = null;
        return `<div class="table-wrap rc-scroll"><table class="table rc-table">
          <thead><tr><th>Category</th><th>Item</th><th>Unit</th><th class="r">Rate (SAR)</th><th>Who</th><th>Notes</th><th>Source</th><th></th></tr></thead>
          <tbody>${list.map((r) => {
            const g = r.category !== last ? `<tr class="group"><td colspan="8"><span class="row" style="gap:8px"><span class="bid-letter">${esc(r.category)}</span>${esc(catOf(r.category).name)}</span></td></tr>` : '';
            last = r.category;
            return g + rateRow(r);
          }).join('')}</tbody></table></div>`;
      };
      const refsHtml = () => {
        const refs = refJobs(d.rates);
        if (!refs.length) return '';
        return `<div class="rc-refs"><span class="tiny faint rc-refs-l">${ui.icon('history')}Reference jobs</span>${refs.map((r) => `
          <span class="rc-ref"><span class="small strong truncate" title="${esc(r.source)}">${esc(r.label)}</span>
            <span class="tiny muted nowrap">${r.days ? plural(r.days, 'day') + ' · ' : ''}${MPH.sar(r.total)} · ${plural(r.lines, 'rate')}</span>
            <button class="btn btn-xs btn-ghost btn-icon" data-rc="del-src" data-src="${esc(r.source)}" aria-label="Remove all rates from ${esc(r.label)}" title="Remove all ${r.lines} rates from this job">${ui.icon('x')}</button></span>`).join('')}</div>`;
      };
      const tableView = () => {
        title.textContent = 'Rate card';
        body.innerHTML = d.rates.length ? `
          <div class="rc-bar">
            <label class="dc-search rc-search">${ui.icon('search')}<input data-rc-q placeholder="Filter rates" value="${esc(R.q)}" aria-label="Filter rates"></label>
            <span class="tiny muted">${plural(d.rates.length, 'rate')}</span><span class="spacer"></span>
            <button class="btn btn-sm btn-outline" data-rc="import">${ui.icon('upload')}Import from a past budget</button>
            <button class="btn btn-sm" data-rc="add">${ui.icon('plus')}Add a rate</button>
          </div>
          ${refsHtml()}
          <div data-rc-table>${tableHtml()}</div>`
          : `<div class="rc-empty">${ui.empty('tags', 'Teach the AI how you price', 'Your rate card is the house’s real rates: crew packages, key creative fees, equipment and suppliers. Import one of your past budgets and Claude turns every priced line into a reusable rate, or add rates by hand.',
              `<div class="row wrap" style="justify-content:center"><button class="btn btn-primary btn-sm" data-rc="import">${ui.icon('upload')}Import from a past budget</button><button class="btn btn-sm btn-ghost" data-rc="add">${ui.icon('plus')}Add a rate</button></div>`)}</div>`;
        foot.innerHTML = `<span class="tiny muted rc-foot-note">${ui.icon('lock')}Only owners and producers see the rate card. Rates in SAR, excluding VAT.</span><span class="spacer"></span><button class="btn btn-primary" data-close>Done</button>`;
        MPH.icons();
      };
      const repaintTable = () => {
        const t = body.querySelector('[data-rc-table]');
        if (!t) return tableView();
        t.innerHTML = tableHtml();
        const refs = body.querySelector('.rc-refs');
        const html = refsHtml();
        if (refs) { if (html) refs.outerHTML = html; else refs.remove(); } else if (html) t.insertAdjacentHTML('beforebegin', html);
        const cnt = body.querySelector('.rc-bar .tiny.muted'); if (cnt) cnt.textContent = plural(d.rates.length, 'rate');
        MPH.icons();
      };

      /* ---- import view: a past budget (file or pasted text) → AI → preview */
      const importView = (err = '') => {
        title.textContent = 'Import from a past budget';
        body.innerHTML = `
          <p class="small muted">Upload one of your real budgets, a PDF or a photo, or paste it as text. Claude reads every priced line, turns it into a unit rate, notes packages and suppliers, and maps each one to a bid category A–J. You choose which rates to keep.</p>
          <div class="seg" role="tablist" aria-label="Budget source">
            <button type="button" role="tab" data-rc-mode="file" aria-selected="${R.mode === 'file'}" class="${R.mode === 'file' ? 'on' : ''}">${ui.icon('file-up')}Upload a file</button>
            <button type="button" role="tab" data-rc-mode="text" aria-selected="${R.mode === 'text'}" class="${R.mode === 'text' ? 'on' : ''}">${ui.icon('clipboard-paste')}Paste text</button>
          </div>
          ${R.mode === 'file' ? `
            <label class="dropzone rc-drop" data-rc-drop>
              ${ui.icon(R.file ? 'file-check-2' : 'file-up')}
              ${R.file ? `<span class="small strong" style="color:var(--text)">${esc(R.file.name)}</span><span class="tiny">${(R.file.size / 1024 / 1024).toFixed(1)} MB · choose another file to replace it</span>`
                : `<span class="small"><span class="strong" style="color:var(--text)">Drop a past budget here</span> or choose a file</span><span class="tiny">PDF, JPG, PNG or WebP, up to 20 MB. It’s deleted as soon as Claude has read it.</span>`}
              <input type="file" hidden data-rc-file accept=".pdf,application/pdf,image/jpeg,image/png,image/webp">
            </label>`
            : `<div class="field"><label for="rc-text">Budget text</label><textarea id="rc-text" class="textarea rc-text" rows="10" placeholder="Paste the budget lines, for example:\nDirector, fixed fee: 25,000\nDoP incl. camera package, 1 day: 12,000\nGaffer + grip + lighting package (Lumiere Rentals): 18,000\n…">${esc(R.text)}</textarea>
                <span class="tiny faint">Copy it straight from Excel or a PDF. Keep the item names, quantities and amounts.</span></div>`}
          <div data-rc-status>${err ? ui.errorBox(err) : ''}</div>`;
        foot.innerHTML = `<button class="btn btn-ghost" data-rc="back">${ui.icon('arrow-left')}Back to the rate card</button><span class="spacer"></span><button class="btn btn-primary" data-rc="read">${ui.icon('sparkles')}Read the budget</button>`;
        MPH.icons();
      };

      async function runImport(btn) {
        if (R.running) return;
        const say = (m) => { const s2 = body.querySelector('[data-rc-status]'); if (s2) { s2.innerHTML = ui.errorBox(m); MPH.icons(); } };
        if (R.mode === 'text') { const t = body.querySelector('#rc-text'); R.text = t ? t.value : R.text; }
        if (R.mode === 'file' && !R.file) return say('Choose a PDF or a photo of a past budget first.');
        if (R.mode === 'text' && R.text.trim().length < 20) return say('Paste the budget lines first: item names with their amounts.');
        if (R.mode === 'file') {
          const okType = /pdf$/i.test(R.file.type) || /\.pdf$/i.test(R.file.name) || /^image\/(jpeg|png|webp)$/i.test(R.file.type);
          if (!okType) return say('Upload a PDF or a photo (JPG, PNG or WebP). For Excel files, copy the cells and use Paste text.');
          if (R.file.size > 20 * 1024 * 1024) return say('This file is larger than 20 MB. Export a smaller PDF or paste the lines as text.');
        }
        R.running = true;
        btn.disabled = true; btn.innerHTML = `${ui.spinner()} Reading`;
        body.querySelectorAll('[data-rc-mode], #rc-text').forEach((x) => { x.disabled = true; });
        const t0 = Date.now();
        const st2 = body.querySelector('[data-rc-status]');
        st2.innerHTML = `<div class="bid-ai-run"><span class="spin"></span><div class="stack tight" style="gap:2px"><span class="small strong">Reading the budget and working out unit rates…</span><span class="tiny muted">This usually takes 20 to 60 seconds. <span data-rc-secs>0</span>s so far. You can close this window; the rates will be waiting when you reopen the rate card.</span></div></div>`;
        const timer = setInterval(() => { const x = dlg.querySelector('[data-rc-secs]'); if (x) x.textContent = Math.round((Date.now() - t0) / 1000); }, 1000);
        const src = R.mode === 'file' ? `Past budget: ${R.file.name}` : `Past budget: pasted text, ${MPH.date(MPH.today())} ${MPH.today().slice(0, 4)}`;
        let path = null, out;
        try {
          if (R.mode === 'file') {
            path = await api.uploadMedia(pid, R.file, 'internal', 'ratecards');
            out = await api.ai('ratecard', { production_id: pid, file_path: path });
          } else {
            out = await api.ai('ratecard', { production_id: pid, text: R.text });
          }
          if (!out || !Array.isArray(out.lines) || !out.lines.length) throw new Error('Claude didn’t find any priced lines. Check the file shows item names with amounts, or paste the lines as text.');
        } catch (ex) {
          clearInterval(timer);
          R.running = false;
          if (path) await api.removeMedia(path).catch(() => {});
          if (!dlg.isConnected) return ctx.toastError(ex);
          importView(ex.message || String(ex));
          return;
        }
        clearInterval(timer);
        R.running = false;
        if (path) await api.removeMedia(path).catch(() => {}); // the past budget itself is never kept
        S.pendingRC[pid] = { out, src }; // kept until the rates are added or discarded, even if this window closes
        if (!dlg.isConnected) { ctx.toast('Your past budget has been read. Open the rate card to choose which rates to keep.', 'tags'); return; }
        previewView(out, src);
      }

      /* ---- preview: tick the rates to keep */
      const previewView = (out, src) => {
        title.textContent = 'Choose the rates to keep';
        const have = new Set(d.rates.map((r) => `${r.category}|${norm(r.item)}`));
        const lines = out.lines.map((l, i) => {
          const category = catIds.includes(l.category) ? l.category : 'B';
          const item = String(l.item || '').trim() || 'Item';
          return { i, category, item, unit: l.unit || 'flat', rate: n(l.rate), who: String(l.who || '').trim(), notes: String(l.notes || '').trim(), dup: have.has(`${category}|${norm(item)}`) };
        });
        const job = out.job || {};
        const dups = lines.filter((l) => l.dup).length;
        body.innerHTML = `
          <div class="rc-job">
            <span class="rc-job-ic">${ui.icon('file-search')}</span>
            <div class="grow stack tight" style="gap:4px;min-width:0">
              <span class="small strong">What Claude read</span>
              ${job.summary ? `<span class="small rc-pre">${esc(job.summary)}</span>` : ''}
            </div>
            <div class="rc-job-stats">
              ${ui.stat(job.shoot_days ? String(job.shoot_days) : '—', 'Shoot days')}
              ${ui.stat(n(job.total) ? MPH.sarK(job.total) : '—', 'Job total')}
              ${ui.stat(String(lines.length), 'Rates found')}
            </div>
          </div>
          <div class="field"><label for="rc-src">Source label</label><input id="rc-src" class="input" value="${esc(src)}">
            <span class="tiny faint">Saved with every rate so you know where it came from${n(job.total) ? `. The job’s shoot days and total are added for comparing future drafts: “${esc(refSource('', job).trim())}”` : ''}.</span></div>
          <div class="row wrap between">
            <span class="small">${ui.aiBadge(plural(lines.length, 'rate'))}${dups ? ` <span class="muted">· ${dups} already on your card, left unticked</span>` : ''}</span>
            <label class="check small"><input type="checkbox" id="rc-all" ${dups ? '' : 'checked'}> Select all</label>
          </div>
          <div class="table-wrap bid-ai-wrap"><table class="table bid-ai-t rc-prev-t">
            <thead><tr><th style="width:34px"></th><th>Item</th><th>Unit</th><th class="r">Rate (SAR)</th><th>Who</th></tr></thead>
            <tbody>${CATS.map((c) => {
              const ls = lines.filter((l) => l.category === c.id);
              if (!ls.length) return '';
              return `<tr class="group"><td></td><td colspan="4"><span class="row" style="gap:8px"><span class="bid-letter">${c.id}</span>${esc(c.name)} <span class="tiny faint">· ${ls.length}</span></span></td></tr>` +
                ls.map((l) => `<tr class="${l.dup ? 'rc-dup' : ''}">
                  <td><input type="checkbox" class="rc-pick" data-i="${l.i}" ${l.dup ? '' : 'checked'} aria-label="Keep ${esc(l.item)}"></td>
                  <td><div class="stack" style="gap:1px"><span class="small">${esc(l.item)}${l.dup ? ' <span class="tiny faint">· already on your card</span>' : ''}</span>${l.notes ? `<span class="tiny muted">${esc(l.notes)}</span>` : ''}</div></td>
                  <td class="small">${esc(l.unit)}</td>
                  <td class="r num small strong">${bare(l.rate)}</td>
                  <td class="small muted">${esc(l.who || '—')}</td></tr>`).join('');
            }).join('')}</tbody></table></div>`;
        const picks = () => [...body.querySelectorAll('.rc-pick')];
        const count = () => picks().filter((b) => b.checked).length;
        const paintFoot = () => {
          foot.innerHTML = `<button class="btn btn-ghost" data-rc="discard">Discard</button><span class="spacer"></span><button class="btn btn-primary" data-rc="keep">${ui.icon('check')}Add ${plural(count(), 'rate')} to the rate card</button>`;
          MPH.icons();
        };
        paintFoot();
        MPH.icons();
        body.onchange = (e) => {
          if (e.target.id === 'rc-all') picks().forEach((b) => { b.checked = e.target.checked; });
          else if (e.target.classList.contains('rc-pick')) { const all = body.querySelector('#rc-all'); if (all) all.checked = picks().every((b) => b.checked); }
          else return;
          paintFoot();
        };
        R.keep = async (btn) => {
          const pick = picks().filter((b) => b.checked).map((b) => lines[Number(b.dataset.i)]);
          if (!pick.length) return ctx.toast('Tick at least one rate to keep', 'info');
          const label = body.querySelector('#rc-src').value.trim() || src;
          const source = refSource(label, job);
          btn.disabled = true; btn.innerHTML = `${ui.spinner()} Adding`;
          try {
            const ins = api.must(await sb.from('rate_cards').insert(pick.map((l) => ({
              org_id: org, category: l.category, item: l.item, unit: l.unit, rate: l.rate, who: l.who || null, notes: l.notes || null, source,
            }))).select());
            d.rates.push(...ins);
            delete S.pendingRC[pid];
            R.file = null; R.text = ''; R.keep = null; body.onchange = null;
            refreshCount(); tableView();
            ctx.toast(`${plural(ins.length, 'rate')} added to the rate card. Draft with AI uses them from now on.`, 'tags');
          } catch (ex) { btn.disabled = false; paintFoot(); ctx.toastError(ex); }
        };
      };

      /* ---- events */
      dlg.addEventListener('click', async (e) => {
        const mb = e.target.closest('[data-rc-mode]');
        if (mb && !mb.disabled) {
          if (R.mode === 'text') { const t = body.querySelector('#rc-text'); if (t) R.text = t.value; }
          R.mode = mb.dataset.rcMode; return importView();
        }
        const el = e.target.closest('[data-rc]');
        if (!el || el.disabled) return;
        const act = el.dataset.rc;
        try {
          if (act === 'import') return importView();
          if (act === 'back') { if (R.running) return ctx.toast('Claude is still reading the budget. Wait for it, or close this window and come back.', 'info'); return tableView(); }
          if (act === 'read') return await runImport(el);
          if (act === 'discard') { delete S.pendingRC[pid]; R.keep = null; body.onchange = null; return tableView(); }
          if (act === 'keep') return R.keep && await R.keep(el);
          if (act === 'add') {
            const row = api.must(await sb.from('rate_cards').insert({ org_id: org, category: 'B', item: 'New rate', unit: 'day', rate: 0, source: 'Added by hand' }).select().single());
            d.rates.push(row); R.q = ''; refreshCount();
            tableView();
            const inp = body.querySelector(`tr[data-rc-id="${row.id}"] [data-f=item]`);
            if (inp) { inp.focus(); inp.select(); inp.scrollIntoView({ block: 'nearest' }); }
            return;
          }
          if (act === 'del') {
            if (!arm(el, `${ui.icon('trash-2')}Delete?`)) return;
            api.must(await sb.from('rate_cards').delete().eq('id', el.dataset.id));
            d.rates = d.rates.filter((r) => r.id !== el.dataset.id);
            refreshCount(); if (d.rates.length) repaintTable(); else tableView();
            return;
          }
          if (act === 'del-src') {
            const src = el.dataset.src;
            const k = d.rates.filter((r) => r.source === src).length;
            if (!arm(el, `${ui.icon('trash-2')}Remove ${plural(k, 'rate')}?`)) return;
            api.must(await sb.from('rate_cards').delete().eq('org_id', org).eq('source', src));
            d.rates = d.rates.filter((r) => r.source !== src);
            refreshCount(); if (d.rates.length) repaintTable(); else tableView();
            ctx.toast(`${plural(k, 'rate')} removed from the rate card`, 'trash-2');
          }
        } catch (ex) { ctx.toastError(ex); }
      });
      /* inline edits commit on change, like budget lines */
      dlg.addEventListener('change', async (e) => {
        const fi = e.target.closest('[data-rc-file]');
        if (fi) { if (fi.files[0]) { R.file = fi.files[0]; importView(); } return; }
        const el = e.target.closest('[data-f]');
        const tr = el && el.closest('tr[data-rc-id]');
        if (!tr) return;
        const r = d.rates.find((x) => x.id === tr.dataset.rcId);
        if (!r) return;
        const f = el.dataset.f, prev = r[f];
        let v = el.value;
        if (f === 'rate') {
          v = v.trim() === '' ? 0 : Number(v);
          if (!Number.isFinite(v) || v < 0) { el.value = n(prev); return ctx.toast('Enter the rate as a number', 'triangle-alert', 'error'); }
        } else if (f === 'item') {
          v = v.trim();
          if (!v) { el.value = prev; return ctx.toast('A rate needs an item name', 'triangle-alert', 'error'); }
        } else if (['who', 'notes', 'source'].includes(f)) v = v.trim() || null;
        if (v === prev) return;
        r[f] = v;
        try {
          api.must(await sb.from('rate_cards').update({ [f]: v }).eq('id', r.id));
          if (f === 'category' || f === 'source') repaintTable();
        } catch (ex) { r[f] = prev; el.value = prev ?? ''; ctx.toastError(ex); }
      });
      dlg.addEventListener('input', (e) => {
        if (e.target.matches('[data-rc-q]')) { R.q = e.target.value; const t = body.querySelector('[data-rc-table]'); if (t) { t.innerHTML = tableHtml(); MPH.icons(); } }
        else if (e.target.id === 'rc-text') R.text = e.target.value;
      });
      dlg.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !e.target.matches('input.cell-input')) return;
        e.preventDefault();
        const f = e.target.dataset.f;
        const all = [...body.querySelectorAll(`input.cell-input[data-f="${f}"]`)];
        const next = all[all.indexOf(e.target) + (e.shiftKey ? -1 : 1)];
        if (next) { next.focus(); next.select(); } else e.target.blur();
      });
      ['dragenter', 'dragover'].forEach((t) => dlg.addEventListener(t, (e) => {
        const z = e.target.closest && e.target.closest('[data-rc-drop]');
        if (!z) return;
        e.preventDefault(); z.classList.add('over');
      }));
      ['dragleave', 'drop'].forEach((t) => dlg.addEventListener(t, (e) => {
        const z = e.target.closest && e.target.closest('[data-rc-drop]');
        if (!z) return;
        e.preventDefault(); z.classList.remove('over');
        if (t === 'drop' && e.dataTransfer.files[0]) { R.file = e.dataTransfer.files[0]; importView(); }
      }));

      if (S.pendingRC[pid]) previewView(S.pendingRC[pid].out, S.pendingRC[pid].src);
      else if (view === 'import') importView();
      else tableView();
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
        // Change orders: client-facing columns only, never drafts, and never change_order_costs.
        const [bids, cos] = await Promise.all([
          ctx.sb.from('client_bids')
            .select('id, version, status, lines, subtotal, vat, total, note, client_note, sent_at, decided_at, created_at')
            .eq('production_id', pid).neq('status', 'draft').order('version', { ascending: false }),
          ctx.sb.from('change_orders')
            .select('id, code, title, reason, price, status, client_note, sent_at, decided_at, created_at')
            .eq('production_id', pid).neq('status', 'draft').order('created_at', { ascending: true }),
        ]);
        return { mode: 'client', bids: must(bids) || [], cos: cos.error ? [] : (cos.data || []) };
      }
      if (!ctx.canSeeInternal) return { mode: 'locked' };
      const [lines, bids, people, rates, days, cos, coCosts] = await Promise.all([
        ctx.sb.from('budget_lines').select('*').eq('production_id', pid).order('sort').order('created_at'),
        ctx.sb.from('client_bids').select('*').eq('production_id', pid).order('version', { ascending: false }),
        ctx.sb.from('people').select('id, name, role, dept, kind, days, people_rates(day_rate)').eq('production_id', pid),
        ctx.sb.from('rate_cards').select('*').eq('org_id', ctx.production.org_id).order('category').order('created_at'),
        ctx.sb.from('shoot_days').select('id', { count: 'exact', head: true }).eq('production_id', pid),
        ctx.sb.from('change_orders').select('*').eq('production_id', pid).order('created_at', { ascending: false }),
        ctx.sb.from('change_order_costs').select('change_order_id, cost').eq('production_id', pid),
      ]);
      const crew = (must(people) || []).map(({ people_rates: pr, ...p }) => ({ ...p, day_rate: pr ? pr.day_rate : null }));
      const costOf = Object.fromEntries((must(coCosts) || []).map((c) => [c.change_order_id, c.cost]));
      return {
        mode: 'producer', lines: must(lines) || [], bids: must(bids) || [], people: crew,
        rates: must(rates) || [], shootDays: days.error ? 0 : (days.count || 0),
        cos: (must(cos) || []).map((c) => ({ ...c, cost: costOf[c.id] ?? null })),
      };
    },

    render(ctx, d) {
      const { ui } = ctx;
      if (d.mode === 'client') return renderClient(ctx, d);
      if (d.mode === 'locked') {
        return `<div class="page">
          ${ui.pageHead({ eyebrow: 'Plan', title: 'Budget & Bid' })}
          <div class="panel">${ui.empty('lock', 'Budgets are visible to owners and producers.', 'Internal cost, markup and client bids are limited to owners and producers of the workspace. Ask a producer if you need a figure.')}</div>
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

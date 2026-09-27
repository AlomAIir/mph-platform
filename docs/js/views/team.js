/* Team: house members and roles, client access per production, invite links. */
MPH.view('team', {
  async load(ctx) {
    const org = ctx.session.org;
    const members = ctx.api.must(await ctx.sb.from('org_members').select('user_id, role, created_at').eq('org_id', org.id));
    const prods = ctx.api.must(await ctx.sb.from('productions').select('id, title').eq('org_id', org.id).order('created_at', { ascending: false }));
    const clients = prods.length ? ctx.api.must(await ctx.sb.from('production_members').select('production_id, user_id, role').in('production_id', prods.map((p) => p.id))) : [];
    const ids = [...new Set([...members.map((m) => m.user_id), ...clients.map((c) => c.user_id)])];
    const profiles = ids.length ? ctx.api.must(await ctx.sb.from('profiles').select('id, email, full_name, phone').in('id', ids)) : [];
    const canInvite = ['owner', 'producer'].includes(org.role);
    const invites = canInvite ? ctx.api.must(await ctx.sb.from('invites').select('*').is('claimed_at', null).order('created_at', { ascending: false })) : [];
    return { members, prods, clients, profiles, invites, canInvite };
  },

  render(ctx, d) {
    const { ui, esc } = ctx;
    const org = ctx.session.org;
    const isOwner = org.role === 'owner';
    const prof = (id) => d.profiles.find((p) => p.id === id) || { email: 'Unknown user' };
    const ROLE = { owner: 'Owner', producer: 'Producer', hod: 'Head of department', crew: 'Crew', client: 'Client' };
    const tierNote = {
      owner: 'Everything, including billing and internal cost.',
      producer: 'Runs productions. Sees internal cost, margin and rates.',
      hod: 'Edits schedules, shots and crew. No internal budget.',
      crew: 'Reads production detail. No budget.',
      client: 'One production: script, overview and the bid sent to them. Never internal cost.',
    };
    const inviteUrl = (tok) => `${location.origin}${location.pathname}#invite.${tok}`;

    return `
      <div class="page">
        ${ui.pageHead({ title: 'Team', sub: `${esc(org.name)} · unlimited seats. Everyone gets exactly the access their role allows, enforced by the database.`,
          actions: d.canInvite ? `<button class="btn btn-primary" data-invite>${ui.icon('user-plus')}Invite someone</button>` : '' })}

        ${ui.panel({ title: `House members · ${d.members.length}`, icon: 'users-round', flush: true, body: `<div class="table-wrap"><table class="table">
          <thead><tr><th>Person</th><th>Role</th><th>Access</th><th></th></tr></thead>
          <tbody>${d.members.map((m) => {
            const p = prof(m.user_id); const me = m.user_id === ctx.session.user.id;
            return `<tr>
              <td><div class="row">${ui.av(p, 'sm')}<div class="stack tight" style="gap:0"><span class="strong small">${esc(p.full_name || p.email)}${me ? ' <span class="faint">(you)</span>' : ''}</span><span class="tiny muted">${esc(p.email || '')}</span></div></div></td>
              <td>${isOwner && !me ? `<select class="cell-input" data-role="${m.user_id}" style="width:auto">${['owner', 'producer', 'hod', 'crew'].map((r) => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${ROLE[r]}</option>`).join('')}</select>` : ui.pill(ROLE[m.role], m.role === 'owner' ? 'accent' : '')}</td>
              <td class="small muted">${tierNote[m.role]}</td>
              <td class="r">${isOwner && !me ? `<button class="btn btn-xs btn-ghost" data-remove="${m.user_id}">${ui.icon('user-minus')}Remove</button>` : ''}</td>
            </tr>`;
          }).join('')}</tbody></table></div>` })}

        ${ui.panel({ title: 'Clients by production', icon: 'eye', flush: true, body: d.clients.length ? `<div class="list">${d.clients.map((c) => {
            const p = prof(c.user_id); const prod = d.prods.find((x) => x.id === c.production_id);
            return `<div class="list-row">${ui.av(p, 'sm')}<div class="grow stack tight" style="gap:0"><span class="small strong">${esc(p.full_name || p.email)}</span><span class="tiny muted">${esc(p.email || '')}</span></div>
              <span class="small muted">${esc(prod?.title || '')}</span>
              ${d.canInvite ? `<button class="btn btn-xs btn-ghost" data-unclient="${c.production_id}|${c.user_id}">${ui.icon('x')}Remove access</button>` : ''}</div>`;
          }).join('')}</div>` : `<div class="panel-body">${ui.empty('eye', 'No clients yet', 'Invite a client to a production. They see the overview, the script and any bid you send them. Nothing else.')}</div>` })}

        ${d.canInvite ? ui.panel({ title: `Pending invites · ${d.invites.length}`, icon: 'send', flush: true, body: d.invites.length ? `<div class="list">${d.invites.map((i) => {
            const prod = d.prods.find((x) => x.id === i.production_id);
            return `<div class="list-row">${ui.icon('mail')}<div class="grow stack tight" style="gap:0"><span class="small strong">${esc(i.email)}</span>
              <span class="tiny muted">${ROLE[i.role]}${prod ? ' · ' + esc(prod.title) : ''} · created ${MPH.date(i.created_at)}</span></div>
              <button class="btn btn-xs btn-outline" data-copy="${esc(inviteUrl(i.token))}">${ui.icon('copy')}Copy link</button>
              <button class="btn btn-xs btn-ghost" data-revoke="${i.id}">${ui.icon('trash-2')}Revoke</button></div>`;
          }).join('')}</div>` : `<div class="panel-body"><p class="small muted">No pending invites.</p></div>` }) : ''}
      </div>`;
  },

  mount(root, ctx, d) {
    const { ui, esc } = ctx;
    const copy = async (text) => {
      try { await navigator.clipboard.writeText(text); ctx.toast('Invite link copied'); }
      catch (e) { ctx.toast('Select the link and copy it'); }
    };
    root.addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-role]');
      if (!sel) return;
      try { ctx.api.must(await ctx.sb.from('org_members').update({ role: sel.value }).eq('org_id', ctx.session.org.id).eq('user_id', sel.dataset.role)); ctx.toast('Role updated'); }
      catch (ex) { ctx.toastError(ex); ctx.reload(); }
    });
    root.addEventListener('click', async (e) => {
      const t = (s) => e.target.closest(s);
      let el;
      if ((el = t('[data-copy]'))) return copy(el.dataset.copy);
      try {
        if ((el = t('[data-revoke]'))) { ctx.api.must(await ctx.sb.from('invites').delete().eq('id', el.dataset.revoke)); ctx.toast('Invite revoked'); return ctx.reload(); }
        if ((el = t('[data-remove]'))) { ctx.api.must(await ctx.sb.from('org_members').delete().eq('org_id', ctx.session.org.id).eq('user_id', el.dataset.remove)); ctx.toast('Removed from the house'); return ctx.reload(); }
        if ((el = t('[data-unclient]'))) { const [pid, uid] = el.dataset.unclient.split('|'); ctx.api.must(await ctx.sb.from('production_members').delete().eq('production_id', pid).eq('user_id', uid)); ctx.toast('Client access removed'); return ctx.reload(); }
      } catch (ex) { return ctx.toastError(ex); }
      if (!t('[data-invite]')) return;

      const dlg = ctx.modal(ctx.frame({
        title: 'Invite someone',
        sub: 'You’ll get a private link to send them, by WhatsApp or email. It works once.',
        body: `
          <div class="field"><label for="iv-email">Their email</label><input id="iv-email" class="input" type="email" placeholder="name@company.com"></div>
          <div class="field"><label for="iv-role">Role</label><select id="iv-role" class="select">
            <option value="producer">Producer: runs productions, sees internal cost</option>
            <option value="hod">Head of department: schedules, shots, crew; no budget</option>
            <option value="crew">Crew: reads production detail; no budget</option>
            <option value="client">Client: one production, bid and script only</option>
            ${ctx.session.org.role === 'owner' ? '<option value="owner">Owner: everything</option>' : ''}
          </select></div>
          <div class="field" id="iv-prod-wrap" hidden><label for="iv-prod">Production</label><select id="iv-prod" class="select">${d.prods.map((p) => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}</select></div>
          <div id="iv-result" hidden></div>`,
        foot: `<button class="btn btn-ghost" data-close>Close</button><button class="btn btn-primary" id="iv-create">${ui.icon('link')}Create invite link</button>`,
      }));
      const roleSel = dlg.querySelector('#iv-role');
      roleSel.addEventListener('change', () => { dlg.querySelector('#iv-prod-wrap').hidden = roleSel.value !== 'client'; });
      dlg.querySelector('#iv-create').addEventListener('click', async () => {
        const email = dlg.querySelector('#iv-email').value.trim();
        const role = roleSel.value;
        const out = dlg.querySelector('#iv-result');
        if (!/^\S+@\S+\.\S+$/.test(email)) { out.hidden = false; out.innerHTML = ui.errorBox('Enter a valid email address.'); return MPH.icons(); }
        if (role === 'client' && !d.prods.length) { out.hidden = false; out.innerHTML = ui.errorBox('Create a production first, then invite its client.'); return MPH.icons(); }
        try {
          const row = { email, role, invited_by: ctx.session.user.id };
          if (role === 'client') row.production_id = dlg.querySelector('#iv-prod').value; else row.org_id = ctx.session.org.id;
          const inv = ctx.api.must(await ctx.sb.from('invites').insert(row).select().single());
          const url = `${location.origin}${location.pathname}#invite.${inv.token}`;
          const msg = `You're invited to ${ctx.session.org.name} on ${window.MPH_CONFIG.brand}. Open this link to join: ${url}`;
          out.hidden = false;
          out.innerHTML = `<div class="callout">${ui.icon('link')}<div class="stack tight grow" style="min-width:0">
            <span class="small strong">Invite link ready</span>
            <input class="input mono small" readonly value="${esc(url)}" id="iv-url">
            <div class="row wrap"><button class="btn btn-sm btn-outline" id="iv-copy">${ui.icon('copy')}Copy link</button>
              <a class="btn btn-sm btn-outline" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">${ui.wa(14)}Share on WhatsApp</a>
              <a class="btn btn-sm btn-ghost" href="mailto:${esc(email)}?subject=${encodeURIComponent('Invite to ' + ctx.session.org.name)}&body=${encodeURIComponent(msg)}">${ui.icon('mail')}Email</a></div>
            <span class="tiny faint">They must sign up or sign in with ${esc(email)}, then open the link.</span></div></div>`;
          MPH.icons();
          out.querySelector('#iv-copy').addEventListener('click', () => { copy(url); out.querySelector('#iv-url').select(); });
          dlg.querySelector('#iv-create').disabled = true;
          ctx.reload();
        } catch (ex) { out.hidden = false; out.innerHTML = ui.errorBox(ex.message); MPH.icons(); }
      });
    });
  },
});

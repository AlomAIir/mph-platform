/* Account: name, phone, password, sign out. */
MPH.view('account', {
  render(ctx) {
    const { ui, esc } = ctx;
    const p = ctx.session.profile;
    return `
      <div class="page" style="max-width:720px">
        ${ui.pageHead({ title: 'Account', sub: esc(ctx.session.user.email) })}
        ${ui.panel({ title: 'Profile', icon: 'user', body: `<form id="acc-form" class="stack">
          <div class="field"><label for="acc-name">Full name</label><input id="acc-name" class="input" value="${esc(p.full_name || '')}"></div>
          <div class="field"><label for="acc-phone">Mobile (for WhatsApp)</label><input id="acc-phone" class="input" value="${esc(p.phone || '')}" placeholder="+966 5…"></div>
          <div><button class="btn btn-primary" type="submit">Save profile</button></div>
        </form>` })}
        ${ui.panel({ title: 'Password', icon: 'key-round', body: `<form id="pw-form" class="stack">
          <div class="field"><label for="acc-pw">New password</label><input id="acc-pw" class="input" type="password" minlength="8" autocomplete="new-password"></div>
          <div><button class="btn btn-outline" type="submit">Change password</button></div>
        </form>` })}
        ${ui.panel({ title: 'Workspaces', icon: 'building-2', body: `<div class="stack">
          ${ctx.session.orgs.map((o) => `<div class="row between"><span class="strong small">${esc(o.name)}</span>${ui.pill(o.role)}</div>`).join('') || '<p class="small muted">You’re not a member of a workspace yet.</p>'}
          <a class="btn btn-sm btn-ghost" href="#setup" style="align-self:flex-start">${ui.icon('plus')}Create another workspace</a>
        </div>` })}
        <div><button class="btn btn-danger" data-act="signout">${ui.icon('log-out')}${ctx.t('Sign out')}</button></div>
      </div>`;
  },
  mount(root, ctx) {
    root.querySelector('#acc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        ctx.api.must(await ctx.sb.from('profiles').upsert({ id: ctx.session.user.id, email: ctx.session.user.email, full_name: root.querySelector('#acc-name').value.trim(), phone: root.querySelector('#acc-phone').value.trim() || null }));
        await ctx.api.loadSession(); ctx.toast('Profile saved'); ctx.refreshAll();
      } catch (ex) { ctx.toastError(ex); }
    });
    root.querySelector('#pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = root.querySelector('#acc-pw').value;
      if (pw.length < 8) return ctx.toast('Use at least 8 characters.', 'triangle-alert', 'error');
      const { error } = await ctx.sb.auth.updateUser({ password: pw });
      if (error) ctx.toastError(error); else { ctx.toast('Password changed'); root.querySelector('#acc-pw').value = ''; }
    });
  },
});

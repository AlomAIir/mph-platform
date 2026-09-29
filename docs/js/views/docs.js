/* Documents (#p.<id>.docs): production paperwork in folders, files in the private "media" bucket.
   Team: every document. Owners, producers and HoDs add, edit, share and delete (RLS: can_edit).
   Client (real client accounts and producer preview): only rows with client_shared = true. RLS enforces that for
   real clients; the query filters it too so the preview is exact. Read and download only, and notes never load.
   Storage rule: a shared document's file lives under <pid>/client/docs/, an internal one under <pid>/internal/docs/.
   Turning "Share with client" on or off moves the file between the two (download, upload, update row, remove old),
   so a client can never open an internal file even by guessing its path. */
(function () {
  const { esc } = MPH;

  const FOLDERS = [
    { id: 'contracts', label: 'Contracts', icon: 'file-pen-line', type: 'Contract' },
    { id: 'releases', label: 'Releases & usage', icon: 'user-round-check', type: 'Release' },
    { id: 'permits', label: 'Permits', icon: 'stamp', type: 'Permit' },
    { id: 'insurance', label: 'Insurance', icon: 'umbrella', type: 'Insurance certificate' },
    { id: 'client', label: 'Client-shared', icon: 'eye', type: '' },
    { id: 'other', label: 'Other', icon: 'folder', type: '' },
  ];
  const STATUS = {
    draft: ['Draft', '', 'file-pen-line'],
    sent: ['Sent', 'info', 'send'],
    signed: ['Signed', 'ok', 'pen-line'],
    approved: ['Approved', 'ok', 'stamp'],
    expired: ['Expired', 'danger', 'calendar-x'],
  };
  const TYPES = ['Crew deal memo', 'Talent release', 'Usage agreement', 'Location agreement', 'Filming permit', 'Drone permit', 'NDA',
    'Music licence', 'Insurance certificate', 'Purchase order', 'Signed bid', 'Invoice', 'Approval', 'Delivery schedule'];
  const FILE_ICON = { pdf: 'file-text', doc: 'file-type', docx: 'file-type', txt: 'file-text', rtf: 'file-type', xls: 'file-spreadsheet', xlsx: 'file-spreadsheet', csv: 'file-spreadsheet',
    png: 'file-image', jpg: 'file-image', jpeg: 'file-image', webp: 'file-image', heic: 'file-image', gif: 'file-image', zip: 'file-archive', mp4: 'file-video', mov: 'file-video', mp3: 'file-audio', wav: 'file-audio' };
  const WATCH_DAYS = 60;

  /* per-production UI state (not data) */
  const S = {};
  const st = (pid) => (S[pid] = S[pid] || { folder: 'all', status: 'all', q: '' });

  /* ------------------------------------------------------------ helpers */
  const folderOf = (id) => FOLDERS.find((f) => f.id === id) || FOLDERS[FOLDERS.length - 1];
  const inFolder = (d, f) => f === 'all' || (f === 'client' ? (d.client_shared || d.folder === 'client') : d.folder === f);
  const fileName = (path) => String(path || '').split('/').pop().replace(/^\d+_[a-z0-9]{0,6}_/, '');
  const extOf = (path) => { const n = fileName(path); return n.includes('.') ? n.split('.').pop().toLowerCase() : ''; };
  const scopeOf = (path) => String(path || '').split('/')[1] || '';
  const baseName = (name) => String(name || '').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  const thisYear = () => MPH.today().slice(0, 4);
  const dateY = (iso) => (iso ? `${MPH.date(iso)}${String(iso).slice(0, 4) !== thisYear() ? ' ' + String(iso).slice(0, 4) : ''}` : '');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const statusPill = (ui, s) => { const [l, k, i] = STATUS[s] || [s || '—', '', 'file']; return ui.pill(l, k, i); };
  const byExpiry = (a, b) => String(a.expires_on).localeCompare(String(b.expires_on));
  const watchOf = (docs) => docs.filter((d) => d.expires_on && d.status !== 'expired' && MPH.daysUntil(d.expires_on) <= WATCH_DAYS).sort(byExpiry);

  function expiryCell(d) {
    if (!d.expires_on) return '<span class="faint">—</span>';
    const n = MPH.daysUntil(d.expires_on);
    let label = '', tone = '';
    if (n < 0) { tone = 'danger'; label = n === -1 ? 'Expired yesterday' : `Expired ${-n} days ago`; }
    else if (n === 0) { tone = 'danger'; label = 'Expires today'; }
    else if (n <= 30) { tone = 'warn'; label = `in ${plural(n, 'day')}`; }
    return `<div class="stack" style="gap:0"><span class="small">${esc(dateY(d.expires_on))}</span>${label ? `<span class="tiny dc-days ${tone}">${label}</span>` : ''}</div>`;
  }

  /* ------------------------------------------------------------ render */
  function renderPage(ctx, D) {
    const { ui, production: p } = ctx;
    const client = ctx.isClient;
    const edit = ctx.canEdit && !client;
    const s = st(p.id);
    const docs = D.docs;
    const clientName = p.client_name || 'the client';

    const head = ui.pageHead({
      eyebrow: client ? 'Documents · Shared with you' : 'Production · Documents',
      title: 'Documents',
      sub: client
        ? `Papers the production team has shared with ${esc(p.client_name || 'you')} for ${esc(p.title)}. Open or download any of them.`
        : `Contracts, releases, permits and insurance for ${esc(p.title)}, with signing status and expiry dates. Only what you share appears in ${esc(clientName)}’s account.`,
      actions: edit ? `<button class="btn btn-outline" data-dc="new">${ui.icon('file-plus-2')}Add a record</button>
        <button class="btn btn-primary" data-dc="pick">${ui.icon('upload')}Upload files</button>` : '',
    });
    const picker = edit ? '<input type="file" multiple hidden data-dc-file aria-label="Choose files to upload">' : '';

    if (!docs.length) {
      const body = client
        ? ui.empty('folder-open', 'Nothing shared yet', ctx.realClient
          ? `When the production team shares a document with you, such as the signed bid, a purchase order or an approval, it appears here.`
          : `Your client sees documents here once you turn on “Share with client” for them. Nothing is shared yet.`)
        : edit
          ? `<div class="dc-first" data-dc-drop>
              <div class="dropzone dc-first-drop" data-dc="pick" role="button" tabindex="0">
                ${ui.icon('folder-up')}
                <span class="h3" style="color:var(--text)">Add the production’s paperwork</span>
                <span class="small">Drop contracts, talent releases, permits and insurance certificates here, or choose files. PDFs, Word files and photos all work.</span>
                <span class="btn btn-primary btn-sm">${ui.icon('upload')}Choose files</span>
              </div>
              <p class="tiny muted dc-first-note">${ui.icon('lock')}Uploads are internal. Share a document with ${esc(clientName)} from its details when you’re ready.</p>
            </div>`
          : ui.empty('folder-open', 'No documents yet', 'Producers and heads of department add contracts, releases, permits and insurance here.');
      return `<div class="page">${head}${picker}<div class="panel">${body}</div><div class="dc-up" data-dc-progress hidden></div></div>`;
    }

    /* stats */
    const sent = docs.filter((d) => d.status === 'sent');
    const done = docs.filter((d) => d.status === 'signed' || d.status === 'approved');
    const watch = watchOf(docs);
    const shared = docs.filter((d) => d.client_shared);
    const stats = client
      ? `<div class="grid-3 dc-stats">
          <div class="panel"><div class="panel-body">${ui.stat(String(docs.length), 'Shared with you')}</div></div>
          <div class="panel"><div class="panel-body">${ui.stat(String(done.length), 'Signed or approved')}</div></div>
          <div class="panel"><div class="panel-body">${ui.stat(String(sent.length), 'Sent, not yet signed')}</div></div>
        </div>`
      : `<div class="grid-4 dc-stats">
          <div class="panel"><div class="panel-body">${ui.stat(String(docs.length), 'Documents', `<span class="tiny faint">${shared.length ? `${shared.length} shared with ${esc(clientName)}` : 'None shared with the client'}</span>`)}</div></div>
          <div class="panel"><div class="panel-body">${ui.stat(String(sent.length), 'Awaiting signature', `<span class="tiny faint">${sent.length ? esc(sent.slice(0, 2).map((d) => d.name).join(', ')) + (sent.length > 2 ? ` +${sent.length - 2}` : '') : 'Nothing outstanding'}</span>`)}</div></div>
          <div class="panel"><div class="panel-body">${ui.stat(String(done.length), 'Signed or approved', `<span class="tiny faint">${docs.length ? Math.round((done.length / docs.length) * 100) + '% of documents' : ''}</span>`)}</div></div>
          <div class="panel"><div class="panel-body">${ui.stat(String(watch.length), `Expiring within ${WATCH_DAYS} days`, `<span class="tiny ${watch.some((d) => MPH.daysUntil(d.expires_on) <= 30) ? 'dc-warn' : 'faint'}">${watch.length ? esc(watch[0].name) + ', ' + esc(dateY(watch[0].expires_on)) : 'Nothing expiring soon'}</span>`)}</div></div>
        </div>`;

    /* expiry watchlist (team only) */
    const watchlist = client || !watch.length ? '' : `
      <section class="dc-watch" aria-label="Expiry watchlist">
        <header class="dc-watch-head">${ui.icon('calendar-clock')}
          <div class="grow stack tight" style="gap:1px"><span class="strong">${watch.some((d) => MPH.daysUntil(d.expires_on) < 0) ? 'Expired or expiring' : 'Expiring'} in the next ${WATCH_DAYS} days</span>
            <span class="tiny muted">Permits, usage terms and insurance that lapse soon. Renew, replace or mark them expired.</span></div></header>
        <div class="dc-watch-list">${watch.map((d) => {
          const n = MPH.daysUntil(d.expires_on);
          return `<div class="dc-watch-row">
            <span class="dc-watch-days ${n < 0 ? 'past' : n <= 30 ? 'hot' : ''}"><span class="num">${Math.abs(n)}</span><span class="tiny">${n < 0 ? 'days ago' : n === 1 ? 'day' : 'days'}</span></span>
            <div class="stack tight grow" style="gap:1px;min-width:0"><span class="small strong truncate">${esc(d.name)}</span>
              <span class="tiny muted truncate">${esc(folderOf(d.folder).label)}${d.parties ? ' · ' + esc(d.parties) : ''}</span></div>
            <span class="small nowrap num">${n < 0 ? 'Expired' : 'Expires'} ${esc(dateY(d.expires_on))}</span>
            <button class="btn btn-xs btn-outline" data-dc="open" data-id="${d.id}">${ui.icon('panel-right-open')}Details</button>
          </div>`;
        }).join('')}</div>
      </section>`;

    /* folder tree (team only) */
    const count = (f) => docs.filter((d) => inFolder(d, f)).length;
    const tree = client ? '' : `
      <aside class="dc-tree" aria-label="Folders">
        <button class="dc-folder ${s.folder === 'all' ? 'on' : ''}" data-folder="all" aria-pressed="${s.folder === 'all'}">${ui.icon('folders')}<span class="grow">All documents</span><span class="count num">${docs.length}</span></button>
        <div class="dc-tree-sep"></div>
        ${FOLDERS.map((f) => `<button class="dc-folder ${s.folder === f.id ? 'on' : ''}" data-folder="${f.id}" aria-pressed="${s.folder === f.id}">${ui.icon(f.icon)}<span class="grow">${esc(f.label)}</span>${f.id === 'client' ? `<span class="dc-folder-flag" title="Visible to ${esc(clientName)}">${ui.icon('users')}</span>` : ''}<span class="count num">${count(f.id)}</span></button>`).join('')}
        <p class="tiny muted dc-tree-note">${ui.icon('lock')}<span>${esc(p.client_name || 'Your client')} only ever sees Client-shared.</span></p>
      </aside>`;

    const f = client ? null : (s.folder === 'all' ? null : folderOf(s.folder));
    const title = client ? `Shared with ${p.client_name || 'you'}` : f ? f.label : 'All documents';
    const icon = client ? 'eye' : f ? f.icon : 'folders';
    const main = `
      <section class="panel flush dc-panel" ${edit ? 'data-dc-drop' : ''}>
        <header class="panel-head dc-head">
          ${ui.icon(icon)}<h3 class="h3">${esc(title)}</h3>
          ${!client && s.folder === 'client' ? ui.pill(`Visible to ${clientName}`, 'info', 'eye') : ''}
          <label class="dc-search">${ui.icon('search')}<input data-dc-q placeholder="Filter by name, type or party" value="${esc(s.q)}" aria-label="Filter documents"></label>
        </header>
        <div class="dc-chips" data-dc-chips>${chipsHtml(ctx, D)}</div>
        ${edit ? `<div class="dc-dropbar" data-dc="pick" role="button" tabindex="0">${ui.icon('upload')}<span class="small"><span class="strong">Drop files here</span> or choose files to add them to ${esc(f ? f.label : 'Other')}${s.folder === 'client' ? `, shared with ${esc(clientName)}` : ''}.</span></div>` : ''}
        <div class="dc-up" data-dc-progress hidden></div>
        <div data-dc-list>${listHtml(ctx, D)}</div>
      </section>`;

    return `
      <div class="page">
        ${head}${picker}
        ${stats}
        ${watchlist}
        <div class="dc-layout ${client ? 'solo' : ''}">
          ${tree}
          <div class="dc-main">${main}</div>
        </div>
      </div>`;
  }

  const visibleRows = (ctx, D) => {
    const s = st(ctx.production.id);
    const q = s.q.trim().toLowerCase();
    return D.docs
      .filter((d) => ctx.isClient || inFolder(d, s.folder))
      .filter((d) => s.status === 'all' || d.status === s.status)
      .filter((d) => !q || [d.name, d.doc_type, d.parties, fileName(d.file_path)].join(' ').toLowerCase().includes(q));
  };

  function chipsHtml(ctx, D) {
    const s = st(ctx.production.id);
    const base = D.docs.filter((d) => ctx.isClient || inFolder(d, s.folder));
    return ['all', ...Object.keys(STATUS)].map((k) => {
      const c = k === 'all' ? base.length : base.filter((d) => d.status === k).length;
      if (k !== 'all' && !c && s.status !== k) return '';
      return `<button class="chip ${s.status === k ? 'on' : ''}" data-status="${k}" aria-pressed="${s.status === k}">${k === 'all' ? 'All' : STATUS[k][0]} <span class="tiny faint num">${c}</span></button>`;
    }).join('');
  }

  function listHtml(ctx, D) {
    const { ui } = ctx;
    const s = st(ctx.production.id);
    const rows = visibleRows(ctx, D);
    const edit = ctx.canEdit && !ctx.isClient;
    if (!rows.length) {
      const filtered = s.q.trim() || s.status !== 'all';
      return ui.empty('folder-open', filtered ? 'No documents match' : 'This folder is empty',
        filtered ? 'Try another status or clear the filter.' : edit ? 'Drop files above, or add a record for a document you don’t have a file for yet.' : '',
        filtered ? `<button class="btn btn-sm btn-ghost" data-dc="clear">${ui.icon('x')}Clear filters</button>` : '');
    }
    const grouped = !ctx.isClient && s.folder === 'all';
    const body = grouped
      ? FOLDERS.filter((f) => f.id !== 'client').map((f) => {
          const g = rows.filter((d) => d.folder === f.id);
          return g.length ? `<tr class="group"><td colspan="7">${ui.icon(f.icon)}${esc(f.label)} <span class="faint">· ${g.length}</span></td></tr>${g.map((d) => rowHtml(ctx, d)).join('')}` : '';
        }).join('')
      : rows.map((d) => rowHtml(ctx, d)).join('');
    return `<div class="table-wrap"><table class="table dc-table">
      <thead><tr><th>Name</th><th>Type</th><th>Parties</th><th>Status</th><th>Signed on</th><th>Expires on</th><th>File</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  function rowHtml(ctx, d) {
    const { ui } = ctx;
    const ext = extOf(d.file_path);
    return `<tr class="dc-row" data-dc="open" data-id="${d.id}" tabindex="0" aria-label="Open ${esc(d.name)}">
      <td><div class="row" style="gap:10px">
        <span class="dc-doc-ic">${ui.icon(FILE_ICON[ext] || (d.file_path ? 'file' : 'file-question'))}</span>
        <div class="stack" style="gap:1px;min-width:0"><span class="small strong dc-name">${esc(d.name)}</span>
          ${!ctx.isClient && d.notes ? `<span class="tiny muted truncate dc-sub">${esc(d.notes)}</span>` : ''}</div>
        ${!ctx.isClient && d.client_shared ? `<span class="dc-shared" title="Shared with the client">${ui.icon('eye')}</span>` : ''}
      </div></td>
      <td class="small muted">${d.doc_type ? esc(d.doc_type) : '<span class="faint">—</span>'}</td>
      <td class="small dc-parties">${d.parties ? esc(d.parties) : '<span class="faint">—</span>'}</td>
      <td>${statusPill(ui, d.status)}</td>
      <td class="small nowrap num">${d.signed_on ? esc(dateY(d.signed_on)) : '<span class="faint">—</span>'}</td>
      <td class="nowrap num">${expiryCell(d)}</td>
      <td class="nowrap">${d.file_path
        ? `<button class="btn btn-xs btn-outline dc-filebtn" data-dc="file" data-id="${d.id}" title="Open ${esc(fileName(d.file_path))} in a new tab">${ui.icon('external-link')}${esc((ext || 'file').toUpperCase())}</button>`
        : '<span class="tiny faint">No file</span>'}</td>
    </tr>`;
  }

  /* ------------------------------------------------------------ mount */
  function mount(root, ctx, D) {
    const { ui, api, sb } = ctx;
    const pid = ctx.production.id;
    const s = st(pid);
    const edit = ctx.canEdit && !ctx.isClient;
    const byId = (id) => D.docs.find((d) => d.id === id);

    const rerender = () => {
      const q = root.querySelector('[data-dc-q]');
      const focused = q && document.activeElement === q ? q.selectionStart : null;
      root.innerHTML = renderPage(ctx, D);
      MPH.icons();
      if (focused != null) { const n = root.querySelector('[data-dc-q]'); if (n) { n.focus(); n.setSelectionRange(focused, focused); } }
    };
    const repaintList = () => {
      const l = root.querySelector('[data-dc-list]');
      const c = root.querySelector('[data-dc-chips]');
      if (l) l.innerHTML = listHtml(ctx, D);
      if (c) c.innerHTML = chipsHtml(ctx, D);
      MPH.icons();
    };

    /* open a file in a new tab. The tab opens synchronously so pop-up blockers allow it, then gets the signed link. */
    async function openFile(doc) {
      if (!doc || !doc.file_path) return;
      const w = window.open('about:blank', '_blank');
      try { if (w) w.opener = null; } catch (e) { /* cross-origin */ }
      const url = await api.mediaUrl(doc.file_path);
      if (!url) {
        if (w) w.close();
        return ctx.toast(ctx.isClient ? 'This file isn’t available to you yet. Ask your producer to share it again.' : 'The file couldn’t be opened. It may have been removed from storage.', 'triangle-alert', 'error');
      }
      if (w) w.location.href = url; else window.location.assign(url);
    }
    async function downloadFile(doc) {
      if (!doc || !doc.file_path) return;
      const name = fileName(doc.file_path);
      const { data, error } = await sb.storage.from('media').createSignedUrl(doc.file_path, 120, { download: name });
      if (error || !data) return ctx.toast('The file couldn’t be downloaded. Try again.', 'triangle-alert', 'error');
      const a = document.createElement('a');
      a.href = data.signedUrl; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    }

    /* ---------------- uploads (page level) */
    const picker = () => root.querySelector('[data-dc-file]');
    async function uploadMany(files) {
      files = [...files].filter((f) => f && f.size >= 0);
      if (!files.length || !edit) return;
      const folder = s.folder === 'all' ? 'other' : s.folder;
      const shared = folder === 'client';
      const prog = root.querySelector('[data-dc-progress]');
      const say = (html) => { if (prog) { prog.hidden = false; prog.innerHTML = html; MPH.icons(); } };
      const added = [], failed = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        say(`<span class="spin sm"></span><span class="small">Uploading ${files.length > 1 ? `${i + 1} of ${files.length}: ` : ''}<span class="strong">${esc(file.name)}</span>…</span>`);
        let path = null;
        try {
          path = await api.uploadMedia(pid, file, shared ? 'client' : 'internal', 'docs');
          const row = api.must(await sb.from('documents').insert({
            production_id: pid, folder, name: baseName(file.name) || file.name, doc_type: folderOf(folder).type || null,
            status: 'draft', file_path: path, client_shared: shared, created_by: ctx.session.user.id,
          }).select().single());
          added.push(row);
        } catch (ex) {
          if (path) await api.removeMedia(path).catch(() => {});
          failed.push(`${file.name}: ${ex.message || ex}`);
        }
      }
      D.docs.unshift(...added.reverse());
      rerender();
      if (failed.length) {
        const p2 = root.querySelector('[data-dc-progress]');
        if (p2) { p2.hidden = false; p2.innerHTML = ui.errorBox(`${plural(failed.length, 'file')} couldn’t be added. ${failed.join(' · ')}`); MPH.icons(); }
      }
      if (added.length === 1 && !failed.length) {
        ctx.toast(`${added[0].name} added${shared ? ' and shared with the client' : ''}. Add its details.`, 'upload');
        openDrawer(added[0]);
      } else if (added.length) {
        ctx.toast(`${plural(added.length, 'document')} added to ${folderOf(folder).label}${shared ? ', shared with the client' : ''}`, 'upload');
      }
    }

    /* ---------------- events */
    root.addEventListener('click', async (e) => {
      const fb = e.target.closest('[data-folder]');
      if (fb) { s.folder = fb.dataset.folder; s.status = 'all'; return rerender(); }
      const sb2 = e.target.closest('[data-status]');
      if (sb2) { s.status = sb2.dataset.status; return repaintList(); }
      const el = e.target.closest('[data-dc]');
      if (!el) return;
      const act = el.dataset.dc;
      try {
        if (act === 'pick') { const inp = picker(); if (inp) { inp.value = ''; inp.click(); } return; }
        if (act === 'new') return openDrawer(null);
        if (act === 'clear') { s.q = ''; s.status = 'all'; return rerender(); }
        if (act === 'file') { e.stopPropagation(); return await openFile(byId(el.dataset.id)); }
        if (act === 'open') { const doc = byId(el.dataset.id); if (doc) openDrawer(doc); return; }
      } catch (ex) { ctx.toastError(ex); }
    });
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target;
      if (t.matches('tr.dc-row') || t.matches('[role=button][data-dc]')) { e.preventDefault(); t.click(); }
    });
    root.addEventListener('input', (e) => {
      if (!e.target.matches('[data-dc-q]')) return;
      s.q = e.target.value;
      repaintList();
    });
    root.addEventListener('change', (e) => {
      if (e.target.matches('[data-dc-file]')) uploadMany(e.target.files);
    });
    if (edit) {
      const zone = () => root.querySelector('[data-dc-drop]');
      const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
      root.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; const z = zone(); if (z) z.classList.add('dc-over'); });
      root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) { const z = zone(); if (z) z.classList.remove('dc-over'); } });
      root.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        const z = zone(); if (z) z.classList.remove('dc-over');
        uploadMany(e.dataTransfer.files);
      });
    }

    /* ---------------- details drawer (create, edit, or read-only for clients and crew) */
    function openDrawer(doc) {
      const isNew = !doc;
      const clientName = ctx.production.client_name || 'the client';
      const startFolder = isNew ? (s.folder === 'all' ? 'other' : s.folder) : doc.folder;
      const v = isNew
        ? { name: '', doc_type: folderOf(startFolder).type, folder: startFolder, status: 'draft', parties: '', signed_on: '', expires_on: '', notes: '', client_shared: startFolder === 'client', file_path: null }
        : { ...doc };
      let share = !!v.client_shared;
      let pending = null; // a File chosen in the drawer (attach or replace)

      if (!edit) {
        const el = ctx.drawer(ctx.frame({
          title: esc(doc.name),
          sub: `${esc(folderOf(doc.folder).label)}${doc.doc_type ? ' · ' + esc(doc.doc_type) : ''}`,
          body: `
            <div class="dc-dhead"><span class="dc-doc-ic lg">${ui.icon(FILE_ICON[extOf(doc.file_path)] || 'file-text')}</span>
              <div class="stack tight grow" style="gap:4px"><div class="row wrap">${statusPill(ui, doc.status)}</div>
                <span class="small muted">${doc.file_path ? esc(fileName(doc.file_path)) : 'No file attached'}</span></div></div>
            <dl class="kv">
              <dt>Type</dt><dd>${esc(doc.doc_type || '—')}</dd>
              <dt>Parties</dt><dd>${esc(doc.parties || '—')}</dd>
              <dt>Signed on</dt><dd>${doc.signed_on ? esc(MPH.date(doc.signed_on, 'long')) : '—'}</dd>
              <dt>Expires on</dt><dd>${doc.expires_on ? expiryCell(doc) : '—'}</dd>
              ${!ctx.isClient && doc.notes ? `<dt>Notes</dt><dd class="dc-pre">${esc(doc.notes)}</dd>` : ''}
            </dl>
            ${ctx.isClient ? '' : `<p class="tiny muted">${ui.icon('lock')} Only owners, producers and heads of department can change documents.</p>`}`,
          foot: `<button class="btn btn-ghost" data-close>Close</button>${doc.file_path ? `<span class="spacer"></span><button class="btn btn-outline" data-dd="download">${ui.icon('download')}Download</button><button class="btn btn-primary" data-dd="open">${ui.icon('external-link')}Open</button>` : ''}`,
        }));
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-dd]');
          if (!b) return;
          if (b.dataset.dd === 'open') openFile(doc).catch(ctx.toastError);
          if (b.dataset.dd === 'download') downloadFile(doc).catch(ctx.toastError);
        });
        return;
      }

      const fileBlock = () => {
        if (pending) {
          return `<div class="dc-file"><span class="dc-doc-ic">${ui.icon(FILE_ICON[extOf(pending.name)] || 'file')}</span>
            <div class="stack grow" style="gap:0;min-width:0"><span class="small strong truncate">${esc(pending.name)}</span>
              <span class="tiny accent">${v.file_path ? 'Replaces the current file when you save' : 'Uploads when you save'}</span></div>
            <button class="btn btn-xs btn-ghost" data-dd="unpick">${ui.icon('x')}Remove</button></div>`;
        }
        if (v.file_path) {
          return `<div class="dc-file"><span class="dc-doc-ic">${ui.icon(FILE_ICON[extOf(v.file_path)] || 'file')}</span>
            <div class="stack grow" style="gap:0;min-width:0"><span class="small strong truncate">${esc(fileName(v.file_path))}</span>
              <span class="tiny muted">${scopeOf(v.file_path) === 'client' ? 'Stored in the client-shared area' : 'Stored internally'}</span></div>
            <div class="row" style="gap:4px"><button class="btn btn-xs btn-outline" data-dd="open">${ui.icon('external-link')}Open</button>
              <button class="btn btn-xs btn-outline btn-icon" data-dd="download" aria-label="Download" title="Download">${ui.icon('download')}</button>
              <button class="btn btn-xs btn-ghost" data-dd="pick">${ui.icon('replace')}Replace</button></div></div>`;
        }
        return `<div class="dropzone dc-attach" data-dd="pick" role="button" tabindex="0">${ui.icon('paperclip')}<span class="small">Drop a file here or <span class="accent strong">choose one</span></span></div>`;
      };
      const shareNote = () => share
        ? `Visible in ${esc(clientName)}’s account under Documents. They can open and download the file. Notes stay internal.`
        : `Internal. ${esc(clientName)} can’t see this document or its file.`;

      const el = ctx.drawer(ctx.frame({
        title: isNew ? 'Add a document' : 'Document details',
        sub: isNew ? 'Track a document even before you have its file.' : esc(doc.name),
        body: `
          <div class="field"><label for="dd-name">Name</label><input id="dd-name" class="input" value="${esc(v.name)}" placeholder="e.g. Talent release · Ahmed Al-Malki"></div>
          <div class="grid-2 dc-g2">
            <div class="field"><label for="dd-type">Type</label><input id="dd-type" class="input" list="dd-types" value="${esc(v.doc_type || '')}" placeholder="e.g. Filming permit">
              <datalist id="dd-types">${TYPES.map((t) => `<option value="${esc(t)}"></option>`).join('')}</datalist></div>
            <div class="field"><label for="dd-folder">Folder</label><select id="dd-folder" class="select">${FOLDERS.map((f) => `<option value="${f.id}" ${v.folder === f.id ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></div>
          </div>
          <div class="field"><span class="label" id="dd-status-l">Status</span>
            <div class="seg dc-seg" role="radiogroup" aria-labelledby="dd-status-l">${Object.entries(STATUS).map(([k, [l]]) => `<button type="button" role="radio" aria-checked="${v.status === k}" class="${v.status === k ? 'on' : ''}" data-st="${k}">${esc(l)}</button>`).join('')}</div></div>
          <div class="field"><label for="dd-parties">Parties</label><input id="dd-parties" class="input" value="${esc(v.parties || '')}" placeholder="e.g. Ahmed Al-Malki, Life Circles"></div>
          <div class="grid-2 dc-g2">
            <div class="field"><label for="dd-signed">Signed on</label><input id="dd-signed" type="date" class="input" value="${esc(v.signed_on || '')}"></div>
            <div class="field"><label for="dd-expires">Expires on</label><input id="dd-expires" type="date" class="input" value="${esc(v.expires_on || '')}"><span class="tiny faint" id="dd-exp-note"></span></div>
          </div>
          <div class="field"><label for="dd-notes">Notes</label><textarea id="dd-notes" class="textarea" rows="3" placeholder="e.g. Usage: TV and digital, KSA and GCC, 12 months from first air">${esc(v.notes || '')}</textarea>
            <span class="tiny faint">${ui.icon('lock')} Internal. Clients never see notes.</span></div>
          <div class="dc-share ${share ? 'on' : ''}" data-share-box>
            <button type="button" class="toggle ${share ? 'on' : ''}" role="switch" aria-checked="${share}" aria-labelledby="dd-share-l" data-dd="share"></button>
            <div class="stack tight grow" style="gap:1px"><span class="small strong" id="dd-share-l">Share with ${esc(clientName)}</span><span class="tiny muted" data-share-note>${shareNote()}</span></div>
          </div>
          <div class="field"><span class="label">File</span><div data-file-box>${fileBlock()}</div>
            <input type="file" hidden data-dd-file aria-label="Choose a file"></div>
          <div data-dd-err hidden></div>`,
        foot: `${isNew ? '' : `<button class="btn btn-ghost dc-del" data-dd="delete">${ui.icon('trash-2')}Delete</button>`}<span class="spacer"></span>
          <button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-dd="save">${ui.icon(isNew ? 'plus' : 'save')}${isNew ? 'Add document' : 'Save changes'}</button>`,
      }));
      el.querySelector('.overlay-foot')?.classList.add('dc-foot');
      const $ = (sel) => el.querySelector(sel);
      const paintFile = () => { $('[data-file-box]').innerHTML = fileBlock(); MPH.icons(); };
      const paintShare = () => {
        const box = $('[data-share-box]');
        box.classList.toggle('on', share);
        const t = box.querySelector('.toggle'); t.classList.toggle('on', share); t.setAttribute('aria-checked', String(share));
        box.querySelector('[data-share-note]').innerHTML = shareNote();
      };
      const expNote = () => {
        const x = $('#dd-expires').value;
        const n = x ? MPH.daysUntil(x) : null;
        const t = $('#dd-exp-note');
        t.className = `tiny ${n == null ? 'faint' : n < 0 ? 'dc-days danger' : n <= 30 ? 'dc-days warn' : 'faint'}`;
        t.textContent = n == null ? '' : n < 0 ? `Expired ${plural(-n, 'day')} ago` : n === 0 ? 'Expires today' : `In ${plural(n, 'day')}`;
      };
      expNote();
      const fail = (m) => { const b = $('[data-dd-err]'); b.hidden = false; b.innerHTML = ui.errorBox(m); MPH.icons(); };

      $('#dd-expires').addEventListener('input', expNote);
      $('#dd-folder').addEventListener('change', (e) => {
        if (e.target.value === 'client' && !share) { share = true; paintShare(); }
        const t = $('#dd-type');
        if (!t.value.trim()) t.value = folderOf(e.target.value).type || '';
      });
      $('[data-dd-file]').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) { pending = f; paintFile(); } });
      const fb = $('[data-file-box]');
      fb.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); fb.classList.add('dc-over'); } });
      fb.addEventListener('dragleave', () => fb.classList.remove('dc-over'));
      fb.addEventListener('drop', (e) => { e.preventDefault(); fb.classList.remove('dc-over'); const f = e.dataTransfer.files[0]; if (f) { pending = f; paintFile(); } });
      el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button][data-dd]')) { e.preventDefault(); e.target.click(); } });

      el.addEventListener('click', async (e) => {
        const stb = e.target.closest('[data-st]');
        if (stb) {
          v.status = stb.dataset.st;
          el.querySelectorAll('[data-st]').forEach((b) => { b.classList.toggle('on', b === stb); b.setAttribute('aria-checked', String(b === stb)); });
          if (v.status === 'signed' && !$('#dd-signed').value) $('#dd-signed').value = MPH.today();
          return;
        }
        const b = e.target.closest('[data-dd]');
        if (!b || b.disabled) return;
        const act = b.dataset.dd;
        try {
          if (act === 'share') {
            if (share && $('#dd-folder').value === 'client') return ctx.toast('Documents in the Client-shared folder are always shared. Move it to another folder first.', 'info');
            share = !share; return paintShare();
          }
          if (act === 'pick') { const i = $('[data-dd-file]'); i.value = ''; return i.click(); }
          if (act === 'unpick') { pending = null; return paintFile(); }
          if (act === 'open') return await openFile(v);
          if (act === 'download') return await downloadFile(v);
          if (act === 'delete') return await del(b);
          if (act === 'save') return await save(b);
        } catch (ex) { ctx.toastError(ex); }
      });

      async function del(b) {
        if (b.dataset.armed !== '1') {
          b.dataset.armed = '1'; b.classList.add('btn-danger'); b.classList.remove('btn-ghost');
          b.innerHTML = `${ui.icon('trash-2')}${doc.file_path ? 'Delete document and file?' : 'Delete document?'}`; MPH.icons();
          setTimeout(() => { if (b.isConnected && b.dataset.armed === '1') { b.dataset.armed = ''; b.classList.remove('btn-danger'); b.classList.add('btn-ghost'); b.innerHTML = `${ui.icon('trash-2')}Delete`; MPH.icons(); } }, 3500);
          return;
        }
        b.disabled = true; b.innerHTML = `${ui.spinner()} Deleting`;
        try {
          api.must(await sb.from('documents').delete().eq('id', doc.id));
        } catch (ex) { b.disabled = false; b.dataset.armed = ''; b.classList.remove('btn-danger'); b.classList.add('btn-ghost'); b.innerHTML = `${ui.icon('trash-2')}Delete`; MPH.icons(); throw ex; }
        let fileLeft = false;
        if (doc.file_path) { const { error } = await sb.storage.from('media').remove([doc.file_path]); fileLeft = !!error; }
        D.docs = D.docs.filter((x) => x.id !== doc.id);
        ctx.closeOverlay(); rerender();
        ctx.toast(fileLeft ? 'Document deleted, but its file couldn’t be removed from storage.' : `${doc.name} deleted`, fileLeft ? 'triangle-alert' : 'trash-2');
      }

      /* copy a stored file into the other scope (client ↔ internal); returns the new path */
      async function moveTo(path, scope) {
        const { data: blob, error } = await sb.storage.from('media').download(path);
        if (error || !blob) throw new Error('The file couldn’t be read to move it, so nothing was changed. Try again.');
        const file = new File([blob], fileName(path) || 'document', { type: blob.type || 'application/octet-stream' });
        return api.uploadMedia(pid, file, scope, 'docs');
      }

      async function save(b) {
        const name = $('#dd-name').value.trim() || (pending ? baseName(pending.name) : '');
        if (!name) { $('#dd-name').focus(); return fail('Give the document a name.'); }
        const folder = $('#dd-folder').value;
        if (folder === 'client') share = true;
        const signed = $('#dd-signed').value || null, expires = $('#dd-expires').value || null;
        if (signed && expires && expires < signed) return fail('The expiry date is before the signing date. Check the dates.');
        const row = {
          name, folder, status: v.status, doc_type: $('#dd-type').value.trim() || null, parties: $('#dd-parties').value.trim() || null,
          signed_on: signed, expires_on: expires, notes: $('#dd-notes').value.trim() || null, client_shared: share,
        };
        const scope = share ? 'client' : 'internal';
        const label = b.innerHTML;
        el.querySelectorAll('.overlay-foot button').forEach((x) => { x.disabled = true; });
        b.innerHTML = `${ui.spinner()} ${pending ? 'Uploading' : 'Saving'}`;
        let newPath = null, oldPath = null;
        try {
          if (pending) {
            newPath = await api.uploadMedia(pid, pending, scope, 'docs');
            oldPath = v.file_path || null;
          } else if (v.file_path && scopeOf(v.file_path) !== scope) {
            b.innerHTML = `${ui.spinner()} Moving the file`;
            newPath = await moveTo(v.file_path, scope);
            oldPath = v.file_path;
          }
          if (newPath) row.file_path = newPath;
          let saved;
          try {
            saved = isNew
              ? api.must(await sb.from('documents').insert({ ...row, production_id: pid, created_by: ctx.session.user.id }).select().single())
              : api.must(await sb.from('documents').update(row).eq('id', doc.id).select().single());
          } catch (ex) { if (newPath) await api.removeMedia(newPath).catch(() => {}); throw ex; }
          let leftover = false;
          if (oldPath) { const { error } = await sb.storage.from('media').remove([oldPath]); leftover = !!error; }
          if (isNew) D.docs.unshift(saved); else Object.assign(doc, saved);
          ctx.closeOverlay(); rerender();
          const moved = !pending && newPath;
          if (leftover && scopeOf(oldPath) === 'client') ctx.toast('Saved, but the old copy in the client area couldn’t be removed. Delete and re-upload the document to be sure the client can’t open it.', 'triangle-alert', 'error');
          else ctx.toast(isNew ? `${saved.name} added` : moved ? (share ? `Shared with ${clientName}. The file moved to the client area.` : 'No longer shared. The file moved back to internal storage.') : 'Document saved', moved ? 'eye' : 'check');
        } catch (ex) {
          el.querySelectorAll('.overlay-foot button').forEach((x) => { x.disabled = false; });
          b.innerHTML = label; MPH.icons();
          fail(ex.message || String(ex));
        }
      }
    }
  }

  /* ------------------------------------------------------------ view */
  MPH.view('docs', {
    async load(ctx) {
      const pid = ctx.production.id;
      let q = ctx.sb.from('documents')
        .select(ctx.isClient ? 'id, folder, name, doc_type, status, parties, file_path, signed_on, expires_on, client_shared, created_at' : '*')
        .eq('production_id', pid);
      if (ctx.isClient) q = q.eq('client_shared', true); // exact client preview; RLS already does this for real clients
      const docs = ctx.api.must(await q.order('created_at', { ascending: false }));
      return { docs: docs || [] };
    },
    render: (ctx, D) => renderPage(ctx, D),
    mount,
  });
})();

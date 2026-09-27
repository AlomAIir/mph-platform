/* Script: the production's script versions (pasted text, PDF or Word), a scene-by-scene reading view once the
   AI breakdown has run, and the way into the breakdown. Clients get a read-only view of the latest version.
   Also defines MPH.scriptKit (text helpers shared with the breakdown view, which loads after this file). */
(function () {
  const { esc } = MPH;

  /* ------------------------------------------------------------ shared text helpers */
  const AR_CHAR = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
  const LATIN_CHAR = /[A-Za-zÀ-ɏ]/;
  const LANG = { ar: 'Arabic', en: 'English', 'ar+en': 'Arabic + English' };
  const norm = (t) => String(t ?? '').replace(/\r\n?/g, '\n');
  const words = (t) => (String(t || '').match(/\S+/g) || []).length;
  const firstStrong = (s) => {
    for (const ch of s) { if (AR_CHAR.test(ch)) return 'ar'; if (LATIN_CHAR.test(ch)) return 'lat'; }
    return null;
  };
  const langGuess = (t) => {
    let a = 0, l = 0;
    for (const ch of String(t || '').slice(0, 40000)) { if (AR_CHAR.test(ch)) a++; else if (LATIN_CHAR.test(ch)) l++; }
    if (!a && !l) return null;
    const r = a / (a + l);
    return r > 0.85 ? 'ar' : r < 0.03 ? 'en' : 'ar+en';
  };

  /* one display line: Arabic-first lines read right to left, everything else follows its own first strong letter */
  const lineDiv = (raw, html) => {
    const ar = firstStrong(raw) === 'ar';
    return `<div class="sc-ln${ar ? ' ar' : ''}" dir="${ar ? 'rtl' : 'auto'}">${html || '<br>'}</div>`;
  };

  /* Render script text line by line, whitespace preserved. `marks` are non-overlapping highlight ranges
     [{ s, e, cls, ids, title }] on norm(text), sorted by s. Every slice of text is escaped. */
  function renderBody(text, marks = []) {
    const src = norm(text);
    const lines = src.split('\n');
    let off = 0, mi = 0, out = '';
    for (const line of lines) {
      const ls = off, le = off + line.length;
      let html = '', pos = ls;
      while (mi < marks.length && marks[mi].e <= ls) mi++;
      for (let k = mi; k < marks.length && marks[k].s < le; k++) {
        const m = marks[k];
        const s = Math.max(m.s, ls, pos), e = Math.min(m.e, le);
        if (e <= s) continue;
        if (s > pos) html += esc(src.slice(pos, s));
        html += `<span class="${m.cls}" data-ids="${esc(m.ids)}" title="${esc(m.title)}">${esc(src.slice(s, e))}</span>`;
        pos = e;
      }
      html += esc(src.slice(pos, le));
      out += lineDiv(line, html);
      off = le + 1;
    }
    return out;
  }

  /* where a quote occurs in the text: exact matches first, then ignoring case and whitespace differences */
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  function findAll(text, quote) {
    const q = norm(quote).trim();
    const hits = [];
    if (q.length < 2 || !text) return hits;
    let at = text.indexOf(q), guard = 0;
    while (at !== -1 && guard++ < 200) { hits.push([at, at + q.length]); at = text.indexOf(q, at + q.length); }
    if (hits.length) return hits;
    let re;
    try { re = new RegExp(q.split(/\s+/).map(escRe).join('\\s+'), 'gi'); } catch (e) { return hits; }
    let m;
    while ((m = re.exec(text)) && guard++ < 200) {
      if (!m[0].length) { re.lastIndex++; continue; }
      hits.push([m.index, m.index + m[0].length]);
    }
    return hits;
  }

  /* "EXT. AT-TURAIF, DIRIYAH – GOLDEN HOUR" -> { ie: 'EXT', set: 'AT-TURAIF, DIRIYAH', time: 'GOLDEN HOUR' } */
  const splitHeading = (h) => {
    const m = /^\s*(INT\.?\s*\/\s*EXT|I\/E|INT|EXT)\.?\s*(.+?)(?:\s+[–—-]\s+([^–—-]+))?\s*$/i.exec(h || '');
    return m ? { ie: m[1].toUpperCase(), set: m[2], time: m[3] || '' } : { ie: '', set: h || '', time: '' };
  };
  const fileName = (path) => String(path || '').split('/').pop().replace(/^\d+_/, '');
  const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  MPH.scriptKit = { norm, words, langGuess, renderBody, findAll, splitHeading, fileName, LANG };

  /* ------------------------------------------------------------ Word (.docx) conversion, loaded on demand */
  let mammothP = null;
  function loadMammoth() {
    if (window.mammoth) return Promise.resolve(window.mammoth);
    if (!mammothP) {
      mammothP = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/mammoth@1.12.3/mammoth.browser.min.js';
        s.async = true;
        s.onload = () => (window.mammoth ? resolve(window.mammoth) : reject(new Error('The Word converter didn’t load. Try again.')));
        s.onerror = () => { mammothP = null; s.remove(); reject(new Error('Couldn’t load the Word converter. Check your connection and try again.')); };
        document.head.appendChild(s);
      });
    }
    return mammothP;
  }

  /* ------------------------------------------------------------ add a script (first version or a new one) */
  const SRC = { text: 'Pasted text', pdf: 'PDF', docx: 'Word document' };
  const KINDS = { pdf: 'PDF', docx: 'Word document', txt: 'Text file', fountain: 'Fountain screenplay' };
  const PDF_MAX = 20 * 1048576;

  function formHtml(ctx, version, inModal = false) {
    const { ui } = ctx;
    return `
      <div class="sc-form stack" data-form>
        <div class="seg" role="tablist" aria-label="How to add the script">
          <button type="button" class="on" role="tab" aria-selected="true" data-src="paste">${ui.icon('clipboard-paste')}Paste text</button>
          <button type="button" role="tab" aria-selected="false" data-src="file">${ui.icon('upload')}Upload a file</button>
        </div>
        <div class="stack tight" data-pane="paste">
          <textarea class="textarea sc-paste" dir="auto" spellcheck="false" aria-label="Script text" placeholder="Paste the script here: Arabic, English or both. Screenplay format and two-column AV scripts (VIDEO | AUDIO) both work."></textarea>
          <span class="tiny faint" data-count>Nothing pasted yet</span>
        </div>
        <div class="stack tight" data-pane="file" hidden>
          <label class="dropzone" data-drop>
            ${ui.icon('file-up')}
            <span class="strong">Drop the script here, or click to choose a file</span>
            <span class="small">PDF, Word (.docx), .txt or .fountain</span>
            <input type="file" data-file-input hidden accept=".pdf,.docx,.txt,.fountain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain">
          </label>
          <div class="stack tight" data-chosen hidden></div>
        </div>
        <div class="field"><label for="sc-note-${version}">Version note (optional)</label>
          <input class="input" id="sc-note-${version}" data-note dir="auto" maxlength="160" placeholder="e.g. Client round 2: new end line"></div>
        <div data-err hidden></div>
        ${inModal ? '' : `<div class="row"><button type="button" class="btn btn-primary" data-save>${ui.icon('save')}Save as script v${version}</button></div>`}
      </div>`;
  }

  /* scope holds the form and its [data-save] button (the modal puts the button in its footer) */
  function bindForm(scope, ctx, onSaved) {
    const { ui, api, sb } = ctx;
    const pid = ctx.production.id;
    const form = scope.querySelector('[data-form]');
    const saveBtn = scope.querySelector('[data-save]');
    const errBox = form.querySelector('[data-err]');
    const ta = form.querySelector('.sc-paste');
    const count = form.querySelector('[data-count]');
    const drop = form.querySelector('[data-drop]');
    const input = form.querySelector('[data-file-input]');
    const chosenBox = form.querySelector('[data-chosen]');
    let src = 'paste', chosen = null, busy = false;

    const showErr = (m) => { errBox.hidden = !m; errBox.innerHTML = m ? ui.errorBox(m) : ''; MPH.icons(); };

    ta.addEventListener('input', () => {
      const n = words(ta.value);
      count.textContent = n ? `${n.toLocaleString('en-US')} words · ${LANG[langGuess(ta.value)] || 'no letters found'}` : 'Nothing pasted yet';
    });
    form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-src]');
      if (b) {
        src = b.dataset.src;
        form.querySelectorAll('[data-src]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
        form.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== src; });
        showErr('');
        if (src === 'paste') ta.focus();
        return;
      }
      if (e.target.closest('[data-clear]')) { chosen = null; renderChosen(); }
    });

    input.addEventListener('change', () => { const f = input.files && input.files[0]; input.value = ''; if (f) take(f); });
    ['dragenter', 'dragover'].forEach((t) => form.addEventListener(t, (e) => { e.preventDefault(); if (drop.contains(e.target)) drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => form.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    form.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && src === 'file') take(f);
    });

    async function take(file) {
      showErr('');
      const ext = ((/\.([a-z0-9]+)$/i.exec(file.name) || [])[1] || '').toLowerCase();
      if (!KINDS[ext]) {
        chosen = null; renderChosen();
        return showErr(ext === 'doc' ? 'Older .doc files can’t be read. Open it in Word and save it as .docx, or export a PDF.'
          : ext === 'fdx' ? 'Final Draft files aren’t supported yet. Export the script from Final Draft as a PDF and upload that.'
          : 'That file type isn’t supported. Upload a PDF, Word (.docx), .txt or .fountain file.');
      }
      if (ext === 'pdf' && file.size > PDF_MAX) { chosen = null; renderChosen(); return showErr(`This PDF is ${size(file.size)}. The AI can read PDFs up to 20 MB: export a lighter PDF (no embedded images) and try again.`); }
      if (file.size > 50 * 1048576) { chosen = null; renderChosen(); return showErr('That file is over 50 MB. Upload a smaller file.'); }
      chosen = { file, ext, text: null, reading: ext !== 'pdf' };
      renderChosen();
      if (ext === 'pdf') return;
      try {
        let text;
        if (ext === 'docx') {
          const m = await loadMammoth();
          const res = await m.extractRawText({ arrayBuffer: await file.arrayBuffer() });
          // mammoth ends every paragraph with a blank line; keep one line per paragraph so spacing matches the document
          text = norm(res.value).replace(/\n\n/g, '\n');
        } else {
          text = norm(await file.text());
        }
        if (!chosen || chosen.file !== file) return;
        text = text.replace(/\n{4,}/g, '\n\n\n').trim();
        if (!text) { chosen = null; renderChosen(); return showErr('No text found in that file. If it’s a scan, upload it as a PDF instead.'); }
        chosen.text = text; chosen.reading = false;
        renderChosen();
      } catch (ex) {
        chosen = null; renderChosen();
        showErr(ext === 'docx' && !/converter/.test(ex.message || '')
          ? 'That Word file couldn’t be read. Open it in Word and save it again as .docx, or export a PDF and upload that.'
          : ex.message || 'That file couldn’t be read.');
      }
    }

    function renderChosen() {
      drop.hidden = !!chosen;
      chosenBox.hidden = !chosen;
      if (!chosen) { chosenBox.innerHTML = ''; return; }
      const { file, ext, text, reading } = chosen;
      chosenBox.innerHTML = `
        <div class="sc-file">
          <span class="sc-file-ic">${ui.icon(ext === 'pdf' ? 'file-text' : 'file-type')}</span>
          <div class="grow stack" style="gap:2px;min-width:0">
            <span class="strong truncate" dir="auto">${esc(file.name)}</span>
            <span class="tiny muted">${KINDS[ext]} · ${size(file.size)}${text ? ` · ${words(text).toLocaleString('en-US')} words · ${LANG[langGuess(text)] || ''}` : ''}</span>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-clear>${ui.icon('x')}Choose another</button>
        </div>
        ${reading ? `<div class="row small muted">${ui.spinner()}Reading the file…</div>` : ''}
        ${ext === 'pdf' ? `<p class="small muted">The AI reads the PDF directly, Arabic included. Once the breakdown has run you can read it here scene by scene. The original file stays in your private project storage.</p>` : ''}
        ${ext === 'docx' ? `<p class="small muted">The text below was taken from the Word file. The original is kept too, so you can download it later.</p>` : ''}
        ${text ? `<span class="eyebrow">Preview</span><div class="sc-preview">${renderBody(text.slice(0, 2000))}${text.length > 2000 ? '<div class="sc-ln faint">…</div>' : ''}</div>` : ''}`;
      MPH.icons();
    }

    saveBtn.addEventListener('click', async () => {
      if (busy) return;
      const note = form.querySelector('[data-note]').value.trim() || null;
      let row, file = null;
      if (src === 'paste') {
        const text = norm(ta.value).trim();
        if (!text) { ta.focus(); return showErr('Paste the script text first.'); }
        row = { source_type: 'text', raw_text: text, language: langGuess(text) || 'ar+en' };
      } else {
        if (!chosen) return showErr('Choose a file first.');
        if (chosen.reading) return showErr('Still reading the file. One moment.');
        const { ext, text } = chosen;
        if (ext === 'pdf') { row = { source_type: 'pdf' }; file = chosen.file; }
        else if (ext === 'docx') { row = { source_type: 'docx', raw_text: text, language: langGuess(text) || 'ar+en' }; file = chosen.file; }
        else row = { source_type: 'text', raw_text: text, language: langGuess(text) || 'ar+en' };
      }
      busy = true;
      const label = saveBtn.innerHTML;
      saveBtn.disabled = true;
      saveBtn.innerHTML = `${ui.spinner()}${file ? 'Uploading…' : 'Saving…'}`;
      showErr('');
      let path = null;
      try {
        if (file) row.file_path = path = await api.uploadScript(pid, file);
        const version = await api.nextVersion('scripts', pid);
        const created = api.must(await sb.from('scripts').insert({ ...row, production_id: pid, version, title: note, created_by: ctx.session.user.id }).select('id, version').single());
        onSaved(created);
      } catch (ex) {
        if (path) sb.storage.from('scripts').remove([path]).catch(() => {});
        showErr(/duplicate key/i.test(ex.message) ? 'Someone added a version at the same moment. Save again to add yours after it.' : ex.message);
        busy = false; saveBtn.disabled = false; saveBtn.innerHTML = label; MPH.icons();
      }
    });
  }

  /* ------------------------------------------------------------ pieces */
  const uiState = (ctx) => {
    const all = (ctx.state.scriptUI = ctx.state.scriptUI || {});
    return (all[ctx.production.id] = all[ctx.production.id] || { ver: null, mode: 'scenes', edit: null });
  };
  const canWrite = (ctx) => ctx.canEdit && !ctx.isClient;

  function bdPill(ui, s) {
    return {
      none: ui.pill('Not run yet'),
      running: ui.pill('Running', 'warn', 'loader'),
      done: ui.pill(`Done${s.breakdown_at ? ' · ' + MPH.date(s.breakdown_at) : ''}`, 'ok', 'check'),
      failed: ui.pill('Last run failed', 'danger', 'triangle-alert'),
    }[s.breakdown_status] || '';
  }

  function emptyPage(ctx) {
    const { ui, production: p } = ctx;
    if (!canWrite(ctx)) {
      return `<div class="page">
        ${ui.pageHead({ eyebrow: 'Pre-production · Script', title: esc(p.title) })}
        <div class="panel">${ctx.isClient
          ? ui.empty('file-text', 'The script hasn’t been shared yet', 'Your production team will share the script here.')
          : ui.empty('file-text', 'No script yet', 'A producer or head of department can add the script here.')}</div>
      </div>`;
    }
    return `<div class="page sc-page">
      ${ui.pageHead({ eyebrow: 'Pre-production · Script', title: 'Add the script', sub: `${esc(p.title)} · start with the latest draft. You can add new versions at any time.` })}
      <div class="sc-start">
        <section class="panel">
          <header class="panel-head">${ui.icon('file-plus')}<h3 class="h3">Script v1</h3></header>
          <div class="panel-body">${formHtml(ctx, 1)}</div>
        </section>
        <aside class="panel">
          <header class="panel-head">${ui.icon('route')}<h3 class="h3">What happens next</h3></header>
          <div class="panel-body">
            <ol class="sc-steps">
              <li><strong>Add the script.</strong> Paste it, or upload the PDF or Word file the agency sent.</li>
              <li><strong>Run the AI breakdown.</strong> It reads Arabic and English, splits the script into scenes and tags cast, extras, props, wardrobe, vehicles and locations against the exact words.</li>
              <li><strong>Review every suggestion.</strong> Accept, correct or remove each tag. Nothing counts until you say yes.</li>
              <li><strong>Plan from it.</strong> The shot list, stripboard, crew and budget work from the accepted breakdown.</li>
            </ol>
          </div>
        </aside>
      </div>
    </div>`;
  }

  function details(ctx, d) {
    const { ui } = ctx;
    const s = d.script;
    const text = s.raw_text && s.raw_text.trim();
    return `
      <div class="panel">
        <div class="panel-body stack tight">
          <span class="eyebrow">Version ${s.version}</span>
          ${s.title ? `<span class="small" dir="auto">${esc(s.title)}</span>` : ''}
          <dl class="kv sc-kv">
            <dt>Source</dt><dd>${esc(SRC[s.source_type] || s.source_type)}</dd>
            ${s.file_path && !ctx.isClient ? `<dt>File</dt><dd class="truncate" dir="auto" title="${esc(fileName(s.file_path))}">${esc(fileName(s.file_path))}</dd>` : ''}
            ${s.language ? `<dt>Language</dt><dd>${esc(LANG[s.language] || s.language)}</dd>` : ''}
            ${text ? `<dt>Length</dt><dd>${words(text).toLocaleString('en-US')} words</dd>` : ''}
            <dt>Added</dt><dd>${MPH.date(s.created_at, 'long')}</dd>
            ${ctx.isClient ? '' : `<dt>Breakdown</dt><dd>${bdPill(ui, s)}</dd>`}
            ${d.scenes.length ? `<dt>Scenes</dt><dd>${d.scenes.length}</dd>` : ''}
          </dl>
        </div>
      </div>`;
  }

  function breakdownCard(ctx, d) {
    const { ui, production: p } = ctx;
    const s = d.script;
    if (!canWrite(ctx) || s.id !== d.latest.id || d.scenes.length) return '';
    const running = s.breakdown_status === 'running';
    return `
      <div class="panel sc-bd-card">
        <div class="panel-body stack tight">
          <span class="row" style="gap:8px">${ui.aiBadge('AI breakdown')}</span>
          <p class="small">${running ? 'A breakdown of this version is running.' : 'Split this script into scenes and tag everything each department needs. It takes about a minute.'}</p>
          <a class="btn btn-primary btn-sm" href="#p.${p.id}.breakdown${running ? '' : '.run'}">${ui.icon(running ? 'loader' : 'sparkles')}${running ? 'See progress' : 'Run AI breakdown'}</a>
        </div>
      </div>`;
  }

  function scenesView(ctx, d) {
    const { ui } = ctx;
    const side = `
      <aside class="sc-side">
        <div class="panel flush">
          <header class="panel-head">${ui.icon('list')}<h3 class="h3">Scenes</h3><span class="tiny faint num">${d.scenes.length}</span></header>
          <nav class="sc-scenes" aria-label="Scenes">
            ${d.scenes.map((s, i) => {
              const h = splitHeading(s.heading);
              return `<button class="sc-scn ${i === 0 ? 'on' : ''}" data-a="jump" data-id="${s.id}">
                <span class="sc-scn-num">${esc(s.num)}</span>
                <span class="grow stack" style="gap:1px;min-width:0">
                  <span class="sc-scn-h truncate" dir="auto">${esc(h.set || s.location || s.heading || 'Scene ' + s.num)}</span>
                  <span class="tiny muted truncate">${[s.int_ext, s.day_night].filter(Boolean).map(esc).join(' · ')}</span>
                </span>
                <span class="tiny faint num sc-scn-pg" title="Length in pages">${MPH.eighths(s.pages_eighths)}</span>
              </button>`;
            }).join('')}
          </nav>
        </div>
        ${details(ctx, d)}
      </aside>`;
    const main = `
      <section class="panel flush sc-read">
        ${d.scenes.map((s) => `
          <article class="sc-scene" id="sc-s-${s.id}" data-scene="${s.id}">
            <header class="sc-scene-head">
              <span class="sc-num">${esc(s.num)}</span>
              <span class="sc-heading" dir="auto">${esc(s.heading || s.location || 'Scene ' + s.num)}</span>
              <span class="spacer"></span>
              ${s.location ? `<span class="tiny muted row nowrap sc-meta" dir="auto">${ui.icon('map-pin')}${esc(s.location)}</span>` : ''}
              <span class="tiny muted row nowrap sc-meta">${ui.icon('file-text')}${MPH.eighths(s.pages_eighths)} pg</span>
            </header>
            ${s.synopsis ? `<p class="sc-syn small muted" dir="auto">${esc(s.synopsis)}</p>` : ''}
            <div class="sc-body">${s.body && s.body.trim() ? renderBody(s.body) : '<div class="sc-ln faint">No text for this scene.</div>'}</div>
          </article>`).join('')}
      </section>`;
    return `<div class="sc-layout">${side}${main}</div>`;
  }

  function textView(ctx, d) {
    return `
      <div class="sc-layout">
        <aside class="sc-side">${details(ctx, d)}${breakdownCard(ctx, d)}</aside>
        <section class="panel flush sc-read"><div class="sc-body sc-raw">${renderBody(d.script.raw_text)}</div></section>
      </div>`;
  }

  function fileView(ctx, d) {
    const { ui, production: p } = ctx;
    const s = d.script;
    const latest = s.id === d.latest.id;
    const running = s.breakdown_status === 'running';
    const body = ctx.isClient
      ? ui.empty('file-text', `Version ${s.version} was shared as a PDF`, 'A readable version appears here once your production team has processed it.')
      : `<div class="sc-pdf">
          <span class="sc-pdf-ic">${ui.icon('file-text')}</span>
          <div class="stack tight" style="align-items:center">
            <span class="h3" dir="auto">${esc(fileName(s.file_path) || 'Script PDF')}</span>
            <span class="small muted">PDF · script v${s.version}</span>
          </div>
          <p class="small muted" style="max-width:52ch">The AI reads this PDF directly, Arabic included. Run the breakdown to split it into scenes you can read and review here.</p>
          <div class="row wrap" style="justify-content:center">
            ${canWrite(ctx) && latest ? `<a class="btn btn-primary" href="#p.${p.id}.breakdown${running ? '' : '.run'}">${ui.icon('sparkles')}${running ? 'See breakdown progress' : 'Run AI breakdown'}</a>` : ''}
            ${d.fileUrl ? `<a class="btn btn-outline" href="${esc(d.fileUrl)}" download>${ui.icon('download')}Download original</a>` : ''}
          </div>
        </div>`;
    return `
      <div class="sc-layout">
        <aside class="sc-side">${details(ctx, d)}</aside>
        <section class="panel">${body}</section>
      </div>`;
  }

  function editorView(ctx, d) {
    const { ui } = ctx;
    const s = d.script;
    const nextV = d.latest.version + 1;
    return `
      <section class="panel flush sc-editor">
        <header class="panel-head">${ui.icon('pencil')}<h3 class="h3">Editing script v${s.version}</h3><span class="tiny faint num" data-ed-count>${words(s.raw_text).toLocaleString('en-US')} words</span></header>
        ${d.scenes.length ? `<div class="sc-warn">${ui.icon('triangle-alert')}<span class="small">This version already has a breakdown. Saving changes here doesn’t update its scenes or elements. To keep the two in step, save as v${nextV} and run the breakdown on it.</span></div>` : ''}
        <div class="panel-body"><textarea class="textarea sc-edit-ta" dir="auto" spellcheck="false" aria-label="Script text">${esc(s.raw_text)}</textarea></div>
        <footer class="sc-ed-foot">
          <span class="tiny muted">Saving as v${nextV} keeps v${s.version} exactly as it is.</span>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-sm" data-a="cancel-edit">Cancel</button>
          <button class="btn btn-outline btn-sm" data-a="save-new">${ui.icon('copy-plus')}Save as v${nextV}</button>
          <button class="btn btn-primary btn-sm" data-a="save-edit">${ui.icon('save')}Save changes</button>
        </footer>
      </section>`;
  }

  function openNewVersion(ctx, d) {
    const { ui } = ctx;
    const v = d.latest.version + 1;
    const el = ctx.modal(ctx.frame({
      title: `Add script v${v}`,
      sub: `v${d.latest.version} stays as it is${d.latest.locked ? ' (locked)' : ''}. Each version keeps its own breakdown.`,
      body: formHtml(ctx, v, true),
      foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-save>${ui.icon('save')}Save as script v${v}</button>`,
    }), { wide: true });
    bindForm(el, ctx, (created) => {
      const st = uiState(ctx);
      st.ver = created.version; st.edit = null;
      ctx.closeOverlay();
      ctx.toast(`Script v${created.version} saved`);
      ctx.reload();
    });
  }

  /* ------------------------------------------------------------ view */
  MPH.view('script', {
    async load(ctx) {
      const { sb, api } = ctx;
      const pid = ctx.production.id;
      const list = api.must(await sb.from('scripts').select('id, version, title, source_type, file_path, locked, breakdown_status, breakdown_at, created_at').eq('production_id', pid).order('version'));
      if (!list.length) return { list, script: null, scenes: [] };
      const latest = list[list.length - 1];
      const st = uiState(ctx);
      const pick = ctx.isClient ? latest : (list.find((x) => x.version === st.ver) || latest);
      const [full, scenes] = await Promise.all([
        sb.from('scripts').select('*').eq('id', pick.id).single(),
        sb.from('scenes').select('id, num, heading, int_ext, day_night, location, synopsis, body, pages_eighths, sort').eq('script_id', pick.id).order('sort'),
      ]);
      const script = api.must(full);
      let fileUrl = null;
      if (!ctx.isClient && script.file_path) {
        try {
          const { data } = await sb.storage.from('scripts').createSignedUrl(script.file_path, 3600, { download: fileName(script.file_path) });
          fileUrl = (data && data.signedUrl) || null;
        } catch (e) { fileUrl = null; }
      }
      return { list, latest, script, scenes: api.must(scenes), fileUrl };
    },

    render(ctx, d) {
      const { ui, production: p } = ctx;
      if (!d.script) return emptyPage(ctx);
      const st = uiState(ctx);
      const edit = canWrite(ctx);
      const s = d.script;
      const isLatest = s.id === d.latest.id;
      const hasScenes = d.scenes.length > 0;
      const hasText = !!(s.raw_text && s.raw_text.trim());
      const editing = edit && st.edit === s.id && hasText && !s.locked;
      const mode = hasScenes && (st.mode !== 'text' || !hasText) ? 'scenes' : hasText ? 'text' : 'file';
      const running = d.latest.breakdown_status === 'running';
      const latestHasScenes = isLatest ? hasScenes : null;

      const cta = !edit ? '' : !isLatest
        ? `<button class="btn btn-outline" data-a="ver" data-v="${d.latest.version}">${ui.icon('arrow-up-right')}Go to v${d.latest.version}</button>`
        : latestHasScenes
          ? `<a class="btn btn-primary" href="#p.${p.id}.breakdown">${ui.icon('scan-text')}Open AI breakdown</a>`
          : `<a class="btn btn-primary" href="#p.${p.id}.breakdown${running ? '' : '.run'}">${ui.icon(running ? 'loader' : 'sparkles')}${running ? 'Breakdown running' : 'Run AI breakdown'}</a>`;

      const sub = ctx.isClient
        ? `Script v${s.version}${hasScenes ? ` · ${d.scenes.length} scenes` : ''} · read only`
        : `Version ${s.version}${s.title ? ` · <span dir="auto">${esc(s.title)}</span>` : ''} · ${esc(SRC[s.source_type] || s.source_type)} · added ${MPH.date(s.created_at)}`;

      const toolbar = ctx.isClient ? '' : `
        <div class="sc-toolbar">
          <div class="seg sc-vers" role="tablist" aria-label="Script version">
            ${d.list.map((v) => `<button class="${v.id === s.id ? 'on' : ''}" role="tab" aria-selected="${v.id === s.id}" data-a="ver" data-v="${v.version}" title="${esc(v.title || `Version ${v.version}`)}">${v.locked ? ui.icon('lock') : ''}v${v.version}</button>`).join('')}
          </div>
          ${s.locked ? ui.pill('Locked', 'ok', 'lock') : ui.pill('Draft', '', 'pencil')}
          ${edit ? `<button class="btn btn-ghost btn-sm sc-lock" data-a="lock" role="switch" aria-checked="${s.locked}" title="${s.locked ? 'Unlock to allow edits' : 'Lock this version so nobody can edit its text'}"><span class="toggle ${s.locked ? 'on' : ''}" aria-hidden="true"></span>Lock version</button>` : ''}
          ${hasScenes && hasText && !editing ? `<span class="sep"></span>
            <div class="seg" role="tablist" aria-label="Display">${[['scenes', 'Scenes'], ['text', 'Original text']].map(([id, l]) => `<button class="${mode === id ? 'on' : ''}" role="tab" aria-selected="${mode === id}" data-a="mode" data-m="${id}">${l}</button>`).join('')}</div>` : ''}
          <span class="spacer"></span>
          ${edit && hasText && !s.locked && !editing ? `<button class="btn btn-outline btn-sm" data-a="edit">${ui.icon('pencil')}Edit text</button>` : ''}
          ${d.fileUrl && mode !== 'file' ? `<a class="btn btn-outline btn-sm" href="${esc(d.fileUrl)}" download>${ui.icon('download')}Download original</a>` : ''}
        </div>`;

      const older = !isLatest && !ctx.isClient ? `
        <div class="callout info">${ui.icon('history')}<div class="grow small">You’re viewing <strong>v${s.version}</strong> from ${MPH.date(s.created_at, 'long')}. The current version is <strong>v${d.latest.version}</strong>, and the AI breakdown works from it.</div>
          <button class="btn btn-sm btn-outline" data-a="ver" data-v="${d.latest.version}">Back to v${d.latest.version}</button></div>` : '';

      const body = editing ? editorView(ctx, d) : mode === 'scenes' ? scenesView(ctx, d) : mode === 'text' ? textView(ctx, d) : fileView(ctx, d);

      return `
        <div class="page sc-page">
          ${ui.pageHead({
            eyebrow: 'Pre-production · Script',
            title: esc(p.title),
            sub,
            actions: `${cta}${edit ? `<button class="btn btn-outline" data-a="new">${ui.icon('plus')}New version</button>` : ''}`,
          })}
          ${toolbar}
          ${older}
          ${body}
        </div>`;
    },

    mount(root, ctx, d) {
      if (!d.script) {
        if (root.querySelector('[data-form]')) {
          bindForm(root, ctx, (created) => { uiState(ctx).ver = created.version; ctx.toast(`Script v${created.version} saved`); ctx.reload(); });
        }
        return;
      }
      const { sb, api } = ctx;
      const st = uiState(ctx);
      const s = d.script;

      const setActive = (id) => root.querySelectorAll('.sc-scn').forEach((x) => x.classList.toggle('on', x.dataset.id === id));

      const afterPaint = () => {
        const ta = root.querySelector('.sc-edit-ta');
        if (ta) {
          const c = root.querySelector('[data-ed-count]');
          ta.addEventListener('input', () => { c.textContent = `${words(ta.value).toLocaleString('en-US')} words`; });
        }
        if (root._scIO) { root._scIO.disconnect(); root._scIO = null; }
        const arts = root.querySelectorAll('.sc-scene[data-scene]');
        const content = document.getElementById('content');
        if (arts.length > 1 && content && 'IntersectionObserver' in window) {
          const io = new IntersectionObserver((entries) => {
            if (!root.isConnected) { io.disconnect(); return; }
            const top = entries.filter((x) => x.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
            if (top) setActive(top.target.dataset.scene);
          }, { root: content, rootMargin: '0px 0px -65% 0px' });
          arts.forEach((a) => io.observe(a));
          root._scIO = io;
        }
      };
      const repaint = () => { root.innerHTML = MPH.views.script.render(ctx, d); MPH.icons(); afterPaint(); };
      afterPaint();

      const busy = (b, on, text) => {
        if (on) { b.dataset.label = b.innerHTML; b.disabled = true; b.innerHTML = `${ctx.ui.spinner()}${text}`; }
        else { b.disabled = false; if (b.dataset.label) b.innerHTML = b.dataset.label; MPH.icons(); }
      };

      root.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-a]');
        if (!b || !root.contains(b)) return;
        const a = b.dataset.a;

        if (a === 'ver') { st.ver = Number(b.dataset.v); st.edit = null; ctx.reload(); }
        else if (a === 'mode') { st.mode = b.dataset.m; repaint(); }
        else if (a === 'jump') {
          const t = root.querySelector(`#sc-s-${b.dataset.id}`);
          if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
          setActive(b.dataset.id);
        }
        else if (a === 'new') openNewVersion(ctx, d);
        else if (a === 'lock') {
          const next = !s.locked;
          b.disabled = true;
          try {
            api.must(await sb.from('scripts').update({ locked: next }).eq('id', s.id));
            s.locked = next;
            const row = d.list.find((x) => x.id === s.id); if (row) row.locked = next;
            if (next && st.edit === s.id) st.edit = null;
            repaint();
            ctx.toast(next ? `Script v${s.version} locked. Unlock it to edit the text.` : `Script v${s.version} unlocked`, next ? 'lock' : 'lock-open');
          } catch (ex) { b.disabled = false; ctx.toastError(ex); }
        }
        else if (a === 'edit') {
          st.edit = s.id; repaint();
          const ta = root.querySelector('.sc-edit-ta'); if (ta) ta.focus({ preventScroll: true });
        }
        else if (a === 'cancel-edit') {
          const ta = root.querySelector('.sc-edit-ta');
          if (ta && norm(ta.value) !== norm(s.raw_text) && !window.confirm('Discard your changes to the script text?')) return;
          st.edit = null; repaint();
        }
        else if (a === 'save-edit' || a === 'save-new') {
          const ta = root.querySelector('.sc-edit-ta');
          const text = norm(ta.value).trim();
          if (!text) { ta.focus(); return ctx.toast('The script can’t be empty.', 'triangle-alert', 'error'); }
          root.querySelectorAll('.sc-ed-foot .btn').forEach((x) => { x.disabled = true; });
          busy(b, true, 'Saving…');
          try {
            if (a === 'save-edit') {
              if (text !== norm(s.raw_text).trim()) api.must(await sb.from('scripts').update({ raw_text: text, language: langGuess(text) || s.language }).eq('id', s.id));
              s.raw_text = text; st.edit = null;
              repaint();
              ctx.toast(`Script v${s.version} saved`);
            } else {
              const version = await api.nextVersion('scripts', ctx.production.id);
              const created = api.must(await sb.from('scripts').insert({
                production_id: ctx.production.id, version, source_type: 'text', raw_text: text, language: langGuess(text) || s.language,
                title: `Edited from v${s.version}`, created_by: ctx.session.user.id,
              }).select('id, version').single());
              st.ver = created.version; st.edit = null;
              ctx.toast(`Saved as script v${created.version}`);
              ctx.reload();
            }
          } catch (ex) {
            root.querySelectorAll('.sc-ed-foot .btn').forEach((x) => { x.disabled = false; });
            busy(b, false);
            ctx.toastError(ex);
          }
        }
      });
    },
  });
})();

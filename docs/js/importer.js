/* Importing outside work into the platform's format.
   MPH.importer.treatment(ctx, { hasScript, onDone }): a treatment deck (PDF, slide images or Word) becomes a treatment
     version (sections), lookbook images sorted onto boards, palette swatches, and optionally a script outline,
     the production summary and the original filed under Documents. The producer reviews everything before it is saved.
   MPH.importer.moods(ctx, files, { onDone }): mood-board images (or a PDF of them) are sorted onto boards with captions.
   PDF pages are drawn in the browser with pdf.js, uploaded to the media bucket under <pid>/client/lookbook/, and read by
   the "ai" Edge Function a few pages at a time (treatment_extract, treatment_merge, moodboard). */
(function () {
  const esc = MPH.esc;
  const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/';
  const PAGE_W = 1400;          // rendered page width in px; large enough to read, small enough to send
  const MAX_PAGES = 60;
  const GROUP = 6;              // pages per AI call
  const PARALLEL = 3;
  const BOARDS = ['Mood', 'Light', 'Locations', 'Casting', 'Wardrobe', 'Art', 'Story', 'Product', 'Other'];
  const newId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const extOf = (name) => (String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const baseName = (name) => String(name || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();

  /* ------------------------------------------------------------ loaders */
  let pdfP = null;
  const loadPdfJs = () => {
    if (!pdfP) {
      pdfP = import(PDFJS + 'pdf.min.mjs').then((lib) => { lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'; return lib; })
        .catch(() => { pdfP = null; throw new Error('Couldn’t load the PDF reader. Check your connection and try again.'); });
    }
    return pdfP;
  };
  let mammothP = null;
  const loadMammoth = () => {
    if (window.mammoth) return Promise.resolve(window.mammoth);
    if (!mammothP) {
      mammothP = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/mammoth@1.12.3/mammoth.browser.min.js';
        s.onload = () => (window.mammoth ? resolve(window.mammoth) : reject(new Error('The Word converter didn’t load. Try again.')));
        s.onerror = () => { mammothP = null; s.remove(); reject(new Error('Couldn’t load the Word converter. Check your connection and try again.')); };
        document.head.appendChild(s);
      });
    }
    return mammothP;
  };

  /* ------------------------------------------------------------ pages → images */
  const toBlob = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Couldn’t draw a page.'))), 'image/jpeg', 0.8));

  /* most common colours of a canvas, as counts per 4-bit bucket (feeds the palette) */
  function colorCounts(canvas) {
    const w = 48, h = Math.max(8, Math.round(48 * canvas.height / canvas.width));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(canvas, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    const out = new Map();
    for (let i = 0; i < px.length; i += 4) {
      const k = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
      out.set(k, (out.get(k) || 0) + 1);
    }
    return out;
  }

  /* pick up to n distinct colours, preferring ones with some saturation and skipping paper white and ink black */
  function palette(countMaps, n = 6) {
    const all = new Map();
    countMaps.forEach((m) => m.forEach((v, k) => all.set(k, (all.get(k) || 0) + v)));
    const cands = [...all.entries()].map(([k, v]) => {
      const r = ((k >> 8) & 15) * 17 + 8, g = ((k >> 4) & 15) * 17 + 8, b = (k & 15) * 17 + 8;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 510, s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
      return { r, g, b, l, s, score: v * (0.1 + s) };
    }).filter((c) => c.l > 0.1 && c.l < 0.92).sort((a, b) => b.score - a.score);
    // slide backgrounds are grey: allow at most two near-neutrals so the real colours of the film come through
    const picked = [];
    let neutrals = 0;
    for (const c of cands) {
      if (picked.length >= n) break;
      const neutral = c.s < 0.15;
      if (neutral && neutrals >= 2) continue;
      if (picked.every((p) => Math.hypot(p.r - c.r, p.g - c.g, p.b - c.b) > 70)) { picked.push(c); if (neutral) neutrals++; }
    }
    const hex = (v) => Math.min(255, v).toString(16).padStart(2, '0');
    return picked.map((c) => `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`.toUpperCase());
  }

  function fitCanvas(srcW, srcH, maxW = PAGE_W) {
    const k = Math.min(1, maxW / srcW, 2000 / srcH);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(srcW * k)); c.height = Math.max(1, Math.round(srcH * k));
    return { c, k };
  }

  /* a PDF or a list of images → [{ n, blob, preview (object URL), colors }] via onPage as each page is ready */
  async function drawPages(files, onPage, alive) {
    const pages = [];
    const push = async (canvas) => {
      const blob = await toBlob(canvas);
      const page = { n: pages.length + 1, blob, preview: URL.createObjectURL(blob), colors: colorCounts(canvas) };
      pages.push(page);
      onPage(page);
    };
    for (const file of files) {
      if (!alive()) break;
      if (extOf(file.name) === 'pdf' || file.type === 'application/pdf') {
        const lib = await loadPdfJs();
        const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
        const total = Math.min(doc.numPages, MAX_PAGES - pages.length);
        for (let i = 1; i <= total && alive(); i++) {
          const pg = await doc.getPage(i);
          const v1 = pg.getViewport({ scale: 1 });
          const { c, k } = fitCanvas(v1.width, v1.height);
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          await pg.render({ canvasContext: g, viewport: pg.getViewport({ scale: k }) }).promise;
          await push(c);
          pg.cleanup();
        }
        doc.destroy();
      } else if (/^image\//.test(file.type)) {
        const bmp = await createImageBitmap(file);
        const { c } = fitCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close && bmp.close();
        await push(c);
      }
      if (pages.length >= MAX_PAGES) break;
    }
    return pages;
  }

  /* run fn over items with at most n in flight */
  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
    }));
    return out;
  }
  const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

  /* ------------------------------------------------------------ shared modal bits */
  const css = `
    .im-drop{display:grid;place-items:center;gap:8px;text-align:center;padding:36px 20px;border:1.5px dashed var(--line-2);border-radius:var(--radius-lg);cursor:pointer;transition:border-color .2s,background .2s}
    .im-drop:hover,.im-drop.over{border-color:var(--accent);background:var(--accent-soft)}
    .im-drop svg{width:34px;height:34px;color:var(--accent)}
    .im-steps{display:grid;gap:8px;margin:0;padding:0;list-style:none}
    .im-steps li{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--muted)}
    .im-steps li.on{color:var(--text)} .im-steps li.done{color:var(--text-2)}
    .im-steps li .im-dot{width:18px;height:18px;display:grid;place-items:center;flex:none}
    .im-steps li.done .im-dot svg{width:16px;height:16px;color:var(--accent)}
    .im-strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px;max-height:260px;overflow:auto;padding:2px}
    .im-strip figure{margin:0;position:relative;border-radius:var(--radius-sm);overflow:hidden;background:var(--surface);aspect-ratio:16/10;animation:im-in .35s ease both}
    .im-strip img{width:100%;height:100%;object-fit:cover;display:block}
    .im-strip .im-n{position:absolute;left:4px;bottom:4px;font:600 10px/1 var(--font-mono);background:rgba(10,20,19,.8);color:var(--text);padding:3px 5px;border-radius:4px}
    .im-strip figure.read::after{content:"";position:absolute;inset:0;box-shadow:inset 0 0 0 2px var(--accent);border-radius:inherit}
    @keyframes im-in{from{opacity:0;transform:translateY(6px) scale(.97)}}
    .im-review{display:grid;gap:18px}
    .im-secs{display:grid;gap:6px}
    .im-sec{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:var(--radius);background:var(--surface);cursor:pointer}
    .im-sec input{margin-top:3px;accent-color:var(--accent)}
    .im-sec .im-sec-t{font-weight:600}
    .im-sec .im-sec-b{font-size:12.5px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .im-pages{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;max-height:420px;overflow:auto;padding:2px}
    .im-pg{display:grid;gap:6px;padding:6px;border-radius:var(--radius);background:var(--surface);transition:opacity .2s}
    .im-pg.off{opacity:.42}
    .im-pg .im-pg-img{position:relative;aspect-ratio:16/10;border-radius:var(--radius-sm);overflow:hidden;cursor:pointer}
    .im-pg img{width:100%;height:100%;object-fit:cover;display:block}
    .im-pg .im-pg-img input{position:absolute;top:6px;left:6px;width:16px;height:16px;accent-color:var(--accent)}
    .im-pg .im-n{position:absolute;right:5px;bottom:5px;font:600 10px/1 var(--font-mono);background:rgba(10,20,19,.8);color:var(--text);padding:3px 5px;border-radius:4px}
    .im-pg select{font-size:12px;padding:4px 6px;background:var(--bg-2);color:var(--text);border:1px solid var(--line);border-radius:6px}
    .im-pg .im-cap{font-size:11.5px;color:var(--muted);line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .im-sw{display:flex;flex-wrap:wrap;gap:8px}
    .im-sw label{display:flex;align-items:center;gap:6px;padding:4px 8px 4px 4px;border-radius:999px;background:var(--surface);cursor:pointer;font:500 11px/1 var(--font-mono)}
    .im-sw label span{width:22px;height:22px;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)}
    .im-sw input,.im-opts input{accent-color:var(--accent)}
    .im-opts{display:grid;gap:8px}
    .im-opts label{display:flex;gap:10px;align-items:flex-start;font-size:13px;cursor:pointer}
    .im-opts label input{margin-top:2px}
    .im-h{display:flex;align-items:baseline;gap:8px}
    .im-h .eyebrow{margin:0}
    .im-log{font-size:12.5px;color:var(--muted)}`;
  const ensureCss = () => { if (!document.getElementById('im-css')) { const s = document.createElement('style'); s.id = 'im-css'; s.textContent = css; document.head.appendChild(s); } };

  /* watch a modal: a stray click on the backdrop doesn't close it while work runs, and onGone runs once it closes */
  function guardModal(el, onGone) {
    const ov = el.parentElement;
    const state = { busy: true };
    const guard = (e) => { if (state.busy && e.target === ov) e.stopImmediatePropagation(); };
    ov.addEventListener('click', guard, true);
    const watch = new MutationObserver(() => {
      if (el.isConnected) return;
      watch.disconnect(); ov.removeEventListener('click', guard, true); onGone();
    });
    watch.observe(ov, { childList: true });
    return state;
  }

  /* ------------------------------------------------------------ treatment import */
  MPH.importer = {};

  MPH.importer.treatment = function (ctx, opts = {}) {
    ensureCss();
    const { ui, api, sb } = ctx;
    const pid = ctx.production.id;
    const el = ctx.modal(ctx.frame({
      title: 'Import a treatment',
      sub: esc(ctx.production.title),
      body: `<div data-im-body></div>`,
      foot: `<div class="row grow" data-im-foot><button class="btn btn-ghost" data-close>Cancel</button></div>`,
    }), { wide: true });
    const body = el.querySelector('[data-im-body]');
    const foot = el.querySelector('[data-im-foot]');
    const alive = () => el.isConnected;
    const uploaded = [];  // media paths to clean up if the import is abandoned
    let saved = false;
    let hasScript = false;
    sb.from('scripts').select('id', { count: 'exact', head: true }).eq('production_id', pid).then((r) => { hasScript = (r.count || 0) > 0; });
    const cleanup = () => { if (!saved && uploaded.length) api.removeMedia(uploaded.splice(0)).catch(() => {}); };
    const guard = guardModal(el, cleanup);
    guard.busy = false; // nothing to lose until a file is chosen

    /* step 1: choose the file */
    body.innerHTML = `
      <div class="stack">
        <p class="small muted">Bring in a treatment made outside MPH. The AI reads every page, writes the text into your treatment sections, sorts the images onto lookbook boards and pulls out the palette. You check everything before it is saved.</p>
        <label class="im-drop" data-im-drop>${ui.icon('file-up')}
          <span class="strong">Drop the treatment here, or choose a file</span>
          <span class="small muted">A PDF deck, photos or exports of the slides (JPG, PNG), or a Word document. Up to ${MAX_PAGES} pages.</span>
          <input type="file" accept=".pdf,application/pdf,.docx,image/*" multiple hidden data-im-file></label>
        <p class="tiny faint">${ui.icon('info')} PowerPoint or Keynote: export the deck as a PDF first.</p>
        <div data-im-err></div>
      </div>`;
    MPH.icons();
    const drop = body.querySelector('[data-im-drop]');
    const showErr = (m) => { const e = body.querySelector('[data-im-err]'); if (e) e.innerHTML = m ? ui.errorBox(m) : ''; MPH.icons(); };
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); start([...e.dataTransfer.files]); });
    body.querySelector('[data-im-file]').addEventListener('change', (e) => start([...e.target.files]));

    function start(files) {
      files = files.filter(Boolean);
      if (!files.length) return;
      const pdfs = files.filter((f) => extOf(f.name) === 'pdf');
      const docx = files.filter((f) => extOf(f.name) === 'docx');
      const imgs = files.filter((f) => /^image\//.test(f.type));
      if (files.some((f) => ['ppt', 'pptx', 'key'].includes(extOf(f.name)))) return showErr('Export the presentation as a PDF first, then import the PDF.');
      if (files.some((f) => extOf(f.name) === 'doc')) return showErr('Older .doc files can’t be read. Save it as .docx or export a PDF.');
      if (docx.length && (pdfs.length || imgs.length || docx.length > 1)) return showErr('Import one Word document on its own.');
      if (pdfs.length > 1) return showErr('Import one PDF at a time.');
      if (pdfs.length && imgs.length) return showErr('Import either a PDF or slide images, not both.');
      if (!pdfs.length && !docx.length && !imgs.length) return showErr('That file type isn’t supported. Use a PDF, slide images or a Word (.docx) document.');
      const big = files.find((f) => f.size > 60 * 1048576);
      if (big) return showErr(`${big.name} is over 60 MB. Export a lighter version and try again.`);
      if (docx.length) return runWord(docx[0]);
      imgs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      return runDeck(pdfs.length ? pdfs : imgs);
    }

    /* progress view */
    const STEPS = [['draw', 'Opening the pages'], ['upload', 'Saving page images'], ['read', 'Reading the pages with AI'], ['merge', 'Writing the treatment sections']];
    function progress(name, files) {
      guard.busy = true;
      body.innerHTML = `
        <div class="stack">
          <div class="row"><span class="ai-badge">${ui.icon('sparkles')}Importing</span><span class="strong truncate" dir="auto">${esc(name)}</span><span class="small muted">${files}</span></div>
          <ol class="im-steps">${STEPS.map(([k, l]) => `<li data-st="${k}"><span class="im-dot"></span><span>${l}</span><span class="tiny faint" data-st-n></span></li>`).join('')}</ol>
          <div class="im-strip" data-im-strip></div>
          <p class="tiny faint">${ui.icon('info')} Keep this window open. A 30-page deck takes about two minutes.</p>
        </div>`;
      foot.innerHTML = '<button class="btn btn-ghost" data-close>Cancel import</button>';
      MPH.icons();
    }
    const step = (k, state, note) => {
      const li = body.querySelector(`[data-st="${k}"]`);
      if (!li) return;
      li.className = state;
      li.querySelector('.im-dot').innerHTML = state === 'done' ? ui.icon('circle-check') : state === 'on' ? '<span class="spin sm"></span>' : '';
      if (note !== undefined) li.querySelector('[data-st-n]').textContent = note;
      MPH.icons();
    };
    const fail = (ex) => {
      if (!alive()) return;
      guard.busy = false;
      cleanup();
      body.innerHTML = `<div class="stack">${ui.errorBox(ex.message || String(ex))}<p class="small muted">Nothing was saved. Try again, or import a lighter PDF.</p></div>`;
      foot.innerHTML = '<button class="btn btn-ghost" data-close>Close</button>';
      MPH.icons();
    };

    /* a PDF deck or slide images */
    async function runDeck(files) {
      progress(files.length === 1 ? files[0].name : `${files.length} slide images`, '');
      const strip = body.querySelector('[data-im-strip]');
      try {
        step('draw', 'on');
        const pages = await drawPages(files, (p) => {
          strip.insertAdjacentHTML('beforeend', `<figure data-pg="${p.n}"><img src="${p.preview}" alt=""><span class="im-n">${p.n}</span></figure>`);
          step('draw', 'on', `${p.n}`);
        }, alive);
        if (!alive()) return;
        if (!pages.length) throw new Error('No pages found in that file.');
        step('draw', 'done', plural(pages.length, 'page'));

        step('upload', 'on');
        let up = 0;
        await pool(pages, 4, async (p) => {
          if (!alive()) return;
          const f = new File([p.blob], `page-${String(p.n).padStart(2, '0')}.jpg`, { type: 'image/jpeg' });
          p.path = await api.uploadMedia(pid, f, 'client', 'lookbook');
          uploaded.push(p.path);
          step('upload', 'on', `${++up} of ${pages.length}`);
        });
        if (!alive()) return;
        step('upload', 'done', '');

        step('read', 'on', `0 of ${pages.length}`);
        let read = 0;
        const groups = chunk(pages, GROUP);
        const failedPages = [];
        const readGroup = async (g, depth = 0) => {
          try {
            const out = await api.ai('treatment_extract', { production_id: pid, image_paths: g.map((p) => p.path), first_page: g[0].n, total_pages: pages.length });
            return { pages: out.pages || [], notes: out.notes || [], language: out.language };
          } catch (ex) {
            if (!alive()) throw ex;
            if (g.length > 1 && depth < 2) {
              const half = Math.ceil(g.length / 2);
              const [a, b] = await Promise.all([readGroup(g.slice(0, half), depth + 1), readGroup(g.slice(half), depth + 1)]);
              return { pages: [...a.pages, ...b.pages], notes: [...a.notes, ...b.notes], language: a.language || b.language };
            }
            failedPages.push(...g.map((p) => p.n));
            return { pages: [], notes: [], language: null };
          }
        };
        const results = await pool(groups, PARALLEL, async (g) => {
          const r = await readGroup(g);
          if (alive()) {
            read += g.length;
            step('read', 'on', `${read} of ${pages.length}`);
            g.forEach((p) => { const f = strip.querySelector(`[data-pg="${p.n}"]`); if (f) f.classList.add('read'); });
          }
          return r;
        });
        if (!alive()) return;
        if (failedPages.length === pages.length) throw new Error('The AI couldn’t read the pages. Try again in a minute.');
        const info = new Map();
        results.forEach((r) => r.pages.forEach((x) => info.set(Number(x.page), x)));
        pages.forEach((p) => {
          const x = info.get(p.n) || {};
          p.board = BOARDS.includes(x.board) ? x.board : (x.board === 'Skip' ? 'Skip' : 'Mood');
          p.caption = String(x.caption || '').slice(0, 300);
          p.keep = p.board !== 'Skip';
          if (p.board === 'Skip') p.board = 'Other';
        });
        step('read', 'done', failedPages.length ? `${plural(failedPages.length, 'page')} couldn’t be read` : '');

        const notes = results.flatMap((r) => r.notes).filter((n) => n && String(n.text || '').trim());
        let doc = { title: baseName(files[0].name), logline: '', sections: [], scene_outline: '', language: results.find((r) => r.language)?.language };
        if (notes.length) {
          step('merge', 'on');
          doc = await mergeNotes({ notes });
          if (!alive()) return;
        }
        step('merge', 'done', plural(doc.sections.length, 'section'));
        review({ name: files.length === 1 ? files[0].name : `${files.length} slides`, original: files.length === 1 ? files[0] : null, pages, doc, failedPages });
      } catch (ex) { fail(ex); }
    }

    async function mergeNotes(payload) {
      let out;
      try { out = await api.ai('treatment_merge', { production_id: pid, ...payload }); } catch (ex) {
        if (ex.code !== 'too_slow') throw ex;
        out = await api.ai('treatment_merge', { production_id: pid, ...payload });
      }
      return {
        title: String(out.title || '').slice(0, 300),
        logline: String(out.logline || '').slice(0, 600),
        language: out.language,
        sections: (out.sections || []).filter((s) => s && (String(s.title || '').trim() || String(s.body || '').trim()))
          .map((s) => ({ title: String(s.title || '').trim(), body: String(s.body || '').trim(), keep: true })),
        scene_outline: String(out.scene_outline || '').trim(),
      };
    }

    /* a Word document: text only */
    async function runWord(file) {
      progress(file.name, '');
      body.querySelector('[data-st="draw"]').remove();
      body.querySelector('[data-st="upload"]').remove();
      body.querySelector('[data-st="read"] span:nth-child(2)').textContent = 'Reading the document';
      try {
        step('read', 'on');
        const m = await loadMammoth();
        const res = await m.extractRawText({ arrayBuffer: await file.arrayBuffer() });
        const text = String(res.value || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
        if (!text) throw new Error('No text found in that Word document.');
        step('read', 'done', `${text.split(/\s+/).length.toLocaleString('en-US')} words`);
        step('merge', 'on');
        const doc = await mergeNotes({ text, file_name: file.name });
        if (!alive()) return;
        step('merge', 'done', plural(doc.sections.length, 'section'));
        review({ name: file.name, original: file, pages: [], doc, failedPages: [] });
      } catch (ex) { fail(ex); }
    }

    /* step 3: review */
    function review(R) {
      const { pages, doc } = R;
      guard.busy = false;
      const colors = palette(pages.filter((p) => p.keep).map((p) => p.colors));
      R.colors = colors.map((hex) => ({ hex, keep: true }));
      const summaryEmpty = !String(ctx.production.summary || '').trim();
      R.opts = { doc: !!R.original, script: !!doc.scene_outline && !hasScript, summary: summaryEmpty && !!doc.logline };
      const boardSel = (p) => `<select data-im-board="${p.n}" aria-label="Board for page ${p.n}">${BOARDS.map((b) => `<option ${b === p.board ? 'selected' : ''}>${b}</option>`).join('')}</select>`;
      const kept = () => pages.filter((p) => p.keep).length;
      body.innerHTML = `
        <div class="im-review">
          ${R.failedPages.length ? `<div class="callout market">${ui.icon('triangle-alert')}<span class="small">The AI couldn’t read page${R.failedPages.length > 1 ? 's' : ''} ${R.failedPages.join(', ')}. ${R.failedPages.length > 1 ? 'They are' : 'It is'} still in the lookbook below; add any text from ${R.failedPages.length > 1 ? 'them' : 'it'} by hand.</span></div>` : ''}
          <div class="field"><label for="im-title">Treatment title</label><input class="input" id="im-title" dir="auto" maxlength="300" value="${esc(doc.title || ctx.production.title)}"></div>
          ${doc.logline ? `<p class="small muted" dir="auto">${ui.icon('quote')} ${esc(doc.logline)}</p>` : ''}
          <div class="stack tight">
            <div class="im-h"><span class="eyebrow">Sections</span><span class="tiny faint">${doc.sections.length ? 'Untick any you don’t want. Everything stays editable after import.' : 'No text was found to turn into sections.'}</span></div>
            <div class="im-secs">${doc.sections.map((s, i) => `
              <label class="im-sec"><input type="checkbox" data-im-sec="${i}" checked><span class="stack" style="gap:2px;min-width:0">
                <span class="im-sec-t" dir="auto">${esc(s.title)}</span><span class="im-sec-b" dir="auto">${esc(s.body)}</span></span></label>`).join('')}</div>
          </div>
          ${pages.length ? `<div class="stack tight">
            <div class="im-h"><span class="eyebrow">Lookbook</span><span class="tiny faint" data-im-kept>${kept()} of ${pages.length} pages</span><span class="tiny faint">Pages the AI found no imagery on start unticked. Change a board with the menu.</span></div>
            <div class="im-pages">${pages.map((p) => `
              <div class="im-pg ${p.keep ? '' : 'off'}" data-im-pg="${p.n}">
                <label class="im-pg-img"><img src="${p.preview}" alt="Page ${p.n}"><input type="checkbox" data-im-keep="${p.n}" ${p.keep ? 'checked' : ''} aria-label="Keep page ${p.n}"><span class="im-n">${p.n}</span></label>
                ${boardSel(p)}${p.caption ? `<span class="im-cap" title="${esc(p.caption)}">${esc(p.caption)}</span>` : ''}
              </div>`).join('')}</div>
          </div>` : ''}
          ${colors.length ? `<div class="stack tight">
            <div class="im-h"><span class="eyebrow">Palette</span><span class="tiny faint">Added to the Mood board as colour swatches.</span></div>
            <div class="im-sw">${R.colors.map((c, i) => `<label><input type="checkbox" data-im-col="${i}" checked><span style="background:${c.hex}"></span>${c.hex}</label>`).join('')}</div>
          </div>` : ''}
          <div class="stack tight"><span class="eyebrow">Also</span>
            <div class="im-opts">
              ${doc.scene_outline ? `<label><input type="checkbox" data-im-opt="script" ${R.opts.script ? 'checked' : ''}><span><span class="strong">Add the scenes as a script version</span><br><span class="small muted">${hasScript ? 'You already have a script; this adds the treatment’s scene outline as a new version.' : 'The treatment describes scenes. Save them as a script outline so you can run the AI breakdown.'}</span></span></label>` : ''}
              ${doc.logline ? `<label><input type="checkbox" data-im-opt="summary" ${R.opts.summary ? 'checked' : ''}><span><span class="strong">Use the logline as the production description</span><br><span class="small muted">${summaryEmpty ? 'The production has no description yet.' : 'Replaces the current description.'}</span></span></label>` : ''}
              ${R.original ? `<label><input type="checkbox" data-im-opt="doc" ${R.opts.doc ? 'checked' : ''}><span><span class="strong">File the original under Documents</span><br><span class="small muted">Internal; your client doesn’t see it.</span></span></label>` : ''}
            </div></div>
        </div>`;
      const count = () => {
        const n = doc.sections.filter((s) => s.keep).length, k = kept(), c = R.colors.filter((x) => x.keep).length;
        const go = foot.querySelector('[data-im-save]');
        if (go) {
          go.disabled = !n && !k;
          go.innerHTML = `${ui.icon('download')}Import ${[n && plural(n, 'section'), k && plural(k, 'image'), c && plural(c, 'colour')].filter(Boolean).join(', ') || 'nothing'}`;
          MPH.icons();
        }
        const kl = body.querySelector('[data-im-kept]'); if (kl) kl.textContent = `${k} of ${pages.length} pages`;
      };
      foot.innerHTML = `<button class="btn btn-ghost" data-close>Cancel</button><span class="spacer"></span><button class="btn btn-primary" data-im-save></button>`;
      count();
      body.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.imSec !== undefined) doc.sections[t.dataset.imSec].keep = t.checked;
        else if (t.dataset.imKeep !== undefined) { const p = pages.find((x) => x.n === Number(t.dataset.imKeep)); p.keep = t.checked; t.closest('.im-pg').classList.toggle('off', !t.checked); }
        else if (t.dataset.imBoard !== undefined) { const p = pages.find((x) => x.n === Number(t.dataset.imBoard)); p.board = t.value; if (!p.keep) { p.keep = true; const cb = body.querySelector(`[data-im-keep="${p.n}"]`); cb.checked = true; cb.closest('.im-pg').classList.remove('off'); } }
        else if (t.dataset.imCol !== undefined) R.colors[t.dataset.imCol].keep = t.checked;
        else if (t.dataset.imOpt) R.opts[t.dataset.imOpt] = t.checked;
        count();
      });
      foot.querySelector('[data-im-save]').addEventListener('click', (e) => save(R, e.currentTarget));
      MPH.icons();
    }

    /* step 4: save */
    async function save(R, btn) {
      const { pages, doc } = R;
      btn.disabled = true; btn.innerHTML = `${ui.spinner()}Importing…`;
      const title = (body.querySelector('#im-title')?.value || '').trim() || doc.title || ctx.production.title;
      let row = null;
      try {
        const secs = doc.sections.filter((s) => s.keep).map((s) => ({ id: newId(), title: s.title, body: s.body }));
        if (secs.length) {
          const version = await api.nextVersion('treatments', pid);
          row = api.must(await sb.from('treatments').insert({ production_id: pid, version, title, sections: secs, status: 'draft', created_by: ctx.session.user.id }).select().single());
        }
        const keep = pages.filter((p) => p.keep);
        const colors = R.colors.filter((c) => c.keep);
        if (keep.length || colors.length) {
          let sort = await api.nextVersion('lookbook_items', pid, 'sort');
          const items = [
            ...keep.map((p) => ({ production_id: pid, board: p.board, kind: 'image', image_path: p.path, caption: p.caption || null, sort: sort++ })),
            ...colors.map((c, i) => ({ production_id: pid, board: 'Mood', kind: 'color', color: c.hex, caption: `${title} ${i + 1}`.slice(0, 300), sort: sort++ })),
          ];
          api.must(await sb.from('lookbook_items').insert(items));
        }
        saved = true;
        const drop = pages.filter((p) => !p.keep).map((p) => p.path);
        if (drop.length) api.removeMedia(drop).catch(() => {});
      } catch (ex) {
        // undo a half-finished import so it can be run again cleanly
        if (row) await sb.from('treatments').delete().eq('id', row.id);
        btn.disabled = false; btn.innerHTML = `${ui.icon('download')}Try again`; MPH.icons();
        return ctx.toastError(ex);
      }

      const extras = [];
      if (R.opts.script && doc.scene_outline) {
        extras.push((async () => {
          const version = await api.nextVersion('scripts', pid);
          api.must(await sb.from('scripts').insert({ production_id: pid, version, title: `Scene outline from ${R.name}`.slice(0, 200), source_type: 'text', raw_text: doc.scene_outline, language: doc.language || 'ar+en', created_by: ctx.session.user.id }));
        })());
      }
      if (R.opts.summary && doc.logline) {
        extras.push((async () => {
          api.must(await sb.from('productions').update({ summary: doc.logline }).eq('id', pid));
          ctx.production.summary = doc.logline;
          if (!ctx.production.cover && MPH.illus && MPH.illus.cover) MPH.illus.cover(ctx, pid).then(() => ctx.refreshAll && ctx.refreshAll()).catch(() => {});
        })());
      }
      if (R.opts.doc && R.original) {
        extras.push((async () => {
          const path = await api.uploadMedia(pid, R.original, 'internal', 'docs');
          try {
            api.must(await sb.from('documents').insert({ production_id: pid, folder: 'other', name: baseName(R.original.name) || R.original.name, doc_type: 'Treatment', status: 'draft', file_path: path, client_shared: false, notes: 'Imported into the treatment.', created_by: ctx.session.user.id }));
          } catch (ex) { await api.removeMedia(path).catch(() => {}); throw ex; }
        })());
      }
      const res = await Promise.allSettled(extras);
      const bad = res.find((r) => r.status === 'rejected');
      pages.forEach((p) => URL.revokeObjectURL(p.preview));
      ctx.closeOverlay();
      const n = pages.filter((p) => p.keep).length;
      ctx.toast(`Imported ${[row && `treatment v${row.version}`, n && plural(n, 'lookbook image')].filter(Boolean).join(' and ') || 'the palette'}`, 'download');
      if (bad) ctx.toastError(new Error(`Part of the import didn’t finish: ${bad.reason?.message || bad.reason}`));
      if (opts.onDone) opts.onDone(row);
    }
  };

  /* ------------------------------------------------------------ mood-board import */
  MPH.importer.moods = function (ctx, fileList, opts = {}) {
    ensureCss();
    const { ui, api, sb } = ctx;
    const pid = ctx.production.id;
    const files = [...(fileList || [])].filter((f) => /^image\//.test(f.type) || extOf(f.name) === 'pdf');
    if (!files.length) return ctx.toast('Choose images (JPG, PNG, WebP) or a PDF', 'image-off');
    const el = ctx.modal(ctx.frame({
      title: 'Import a mood board',
      sub: esc(ctx.production.title),
      body: `<div class="stack">
        <div class="row"><span class="ai-badge">${ui.icon('sparkles')}Sorting</span><span class="small muted" data-mb-say>Opening the images…</span></div>
        <div class="im-strip" data-im-strip></div>
        <p class="tiny faint">${ui.icon('info')} The AI puts each image on a board (Mood, Light, Locations, Casting, Wardrobe…) with a caption, drops near-duplicates and adds the palette.</p></div>`,
      foot: '<button class="btn btn-ghost" data-close>Cancel</button>',
    }), { wide: true });
    const alive = () => el.isConnected;
    const strip = el.querySelector('[data-im-strip]');
    const say = (t) => { const s = el.querySelector('[data-mb-say]'); if (s) s.textContent = t; };
    const paths = [];
    let saved = false;
    const guard = guardModal(el, () => { if (!saved && paths.length) api.removeMedia(paths.filter(Boolean)).catch(() => {}); });
    MPH.icons();

    (async () => {
      try {
        const pages = await drawPages(files, (p) => { strip.insertAdjacentHTML('beforeend', `<figure data-pg="${p.n}"><img src="${p.preview}" alt=""><span class="im-n">${p.n}</span></figure>`); say(`Opening ${p.n}…`); }, alive);
        if (!alive()) return;
        if (!pages.length) throw new Error('No images found.');
        let up = 0;
        await pool(pages, 4, async (p) => {
          if (!alive()) return;
          p.path = await api.uploadMedia(pid, new File([p.blob], `mood-${String(p.n).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }), 'client', 'lookbook');
          paths.push(p.path);
          say(`Saving ${++up} of ${pages.length}…`);
        });
        if (!alive()) return;
        let done = 0;
        say(`Sorting 0 of ${pages.length}…`);
        await pool(chunk(pages, 8), 2, async (g) => {
          try {
            const out = await api.ai('moodboard', { production_id: pid, image_paths: g.map((p) => p.path) });
            (out.images || []).forEach((x) => {
              const p = g[Number(x.index) - 1];
              if (!p) return;
              p.board = BOARDS.includes(x.board) ? x.board : 'Mood';
              p.caption = String(x.caption || '').slice(0, 300);
              const dup = Number(x.duplicate_of);
              p.dup = dup > 0 && dup < Number(x.index);
            });
          } catch (ex) { /* unsorted images still go on the Mood board */ }
          g.forEach((p) => { const f = strip.querySelector(`[data-pg="${p.n}"]`); if (f) f.classList.add('read'); });
          done += g.length;
          say(`Sorting ${done} of ${pages.length}…`);
        });
        if (!alive()) return;
        const keep = pages.filter((p) => !p.dup);
        const dups = pages.filter((p) => p.dup);
        const colors = palette(keep.map((p) => p.colors), 5);
        let sort = await api.nextVersion('lookbook_items', pid, 'sort');
        const items = [
          ...keep.map((p) => ({ production_id: pid, board: p.board || 'Mood', kind: 'image', image_path: p.path, caption: p.caption || null, sort: sort++ })),
          ...colors.map((hex) => ({ production_id: pid, board: 'Mood', kind: 'color', color: hex, caption: null, sort: sort++ })),
        ];
        api.must(await sb.from('lookbook_items').insert(items));
        saved = true;
        if (dups.length) api.removeMedia(dups.map((p) => p.path)).catch(() => {});
        pages.forEach((p) => URL.revokeObjectURL(p.preview));
        const boards = [...new Set(keep.map((p) => p.board || 'Mood'))];
        ctx.closeOverlay();
        ctx.toast(`Added ${plural(keep.length, 'image')} to ${boards.join(', ')}${dups.length ? ` · skipped ${plural(dups.length, 'duplicate')}` : ''}`, 'images');
        if (opts.onDone) opts.onDone();
      } catch (ex) {
        if (!alive()) return;
        guard.busy = false;
        if (paths.length) api.removeMedia(paths.splice(0)).catch(() => {});
        el.querySelector('.stack').innerHTML = `${ui.errorBox(ex.message || String(ex))}<p class="small muted">Nothing was saved.</p>`;
        MPH.icons();
      }
    })();
  };
})();

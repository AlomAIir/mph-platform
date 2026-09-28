/* AI Breakdown: MPH's signature feature. The AI reads the latest script version and proposes scenes plus the
   elements each department needs, each tied to the words that call for it. The producer accepts, corrects or
   removes every suggestion; every action is saved to `elements` straight away.
   Depends on MPH.scriptKit from views/script.js (loaded first). */
(function () {
  const { esc } = MPH;
  const HIGH = 0.75;   // "Accept all high-confidence"
  const AUTO = 0.9;    // accepted on arrival
  const RUNS = {};     // scriptId -> { started, done, error, stage, onDone, promise }  (runs live as long as the tab)
  const AUTO_USED = {};
  const META_KEY = 'mph.platform.bdmeta';
  const STATUS = [
    'Reading the script',
    'Finding scenes and sluglines',
    'Reading the Arabic and English dialogue',
    'Tagging cast, props and locations',
    'Tagging wardrobe, vehicles and special equipment',
    'Flagging implied needs like generators, permits and guardians',
    'Estimating shoot time',
    'Checking confidence on every tag',
  ];
  const NOUNS = {
    cast: ['cast member', 'cast'], extras: ['extra', 'extras'], props: ['prop', 'props'],
    wardrobe: ['wardrobe item', 'wardrobe items'], makeup: ['hair and makeup look', 'hair and makeup looks'],
    vehicles: ['vehicle', 'vehicles'], location: ['location', 'locations'], sfx: ['special effect', 'special effects'],
    equipment: ['piece of special equipment', 'pieces of special equipment'], animals: ['animal', 'animals'],
    sound: ['sound or music cue', 'sound and music cues'], vfx: ['VFX or graphic', 'VFX and graphics'], stunts: ['stunt', 'stunts'],
  };

  const K = () => MPH.scriptKit;
  const catLabel = (id) => (MPH.ui.cat(id) || {}).label || id;
  const catIdx = (id) => MPH.ui.CATEGORIES.findIndex((c) => c.id === id);
  const pct = (c) => Math.round((Number(c) || 0) * 100);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const clock = (n) => `${Math.floor(n / 60)}:${String(Math.round(n) % 60).padStart(2, '0')}`;
  const fmtMin = (m) => { m = Number(m) || 0; return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`; };
  const isRecentRun = (s) => s.breakdown_status === 'running' && s.breakdown_at && Date.now() - Date.parse(s.breakdown_at) < 5 * 60000;

  /* notes + runtime from the AI: stored on scripts when the columns exist, else kept in this browser */
  const readMeta = () => { try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch (e) { return {}; } };
  const writeMeta = (id, m) => {
    try {
      const all = readMeta(); all[id] = m;
      const keys = Object.keys(all); if (keys.length > 60) delete all[keys[0]];
      localStorage.setItem(META_KEY, JSON.stringify(all));
    } catch (e) { /* storage unavailable */ }
  };
  const metaFor = (s) => {
    const local = readMeta()[s.id] || {};
    return { notes: s.breakdown_notes ?? local.notes ?? '', runtime: s.runtime_seconds ?? local.runtime ?? null };
  };

  const uiState = (ctx, d) => {
    const all = (ctx.state.bdUI = ctx.state.bdUI || {});
    const u = (all[ctx.production.id] = all[ctx.production.id] || { scene: null, filter: null, view: 'scene' });
    if (d && d.scenes.length && !d.scenes.some((s) => s.id === u.scene)) u.scene = d.scenes[0].id;
    return u;
  };

  /* ------------------------------------------------------------ running the AI and saving its answer */
  function clean(out) {
    const cats = new Set(MPH.ui.CATEGORIES.map((c) => c.id));
    const IE = ['INT', 'EXT', 'INT/EXT'];
    const str = (v, max = 4000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const int = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
    const scenes = Array.isArray(out && out.scenes) ? out.scenes : [];
    return scenes.filter((s) => s && typeof s === 'object').map((s, i) => {
      let ie = str(s.int_ext).toUpperCase().replace(/[\s.]+/g, '');
      if (ie === 'I/E' || ie === 'EXT/INT') ie = 'INT/EXT';
      const seen = new Map();
      (Array.isArray(s.elements) ? s.elements : []).forEach((e) => {
        if (!e || !cats.has(e.category) || !str(e.name)) return;
        const conf = Number(e.confidence);
        const el = {
          category: e.category, name: str(e.name, 200), qty: int(e.qty, 1, 100000, 1),
          confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null,
          source_quote: str(e.source_quote, 1000) || null, reason: str(e.reason, 1000) || null,
        };
        const k = `${el.category}|${el.name.toLowerCase()}`;
        const prev = seen.get(k);
        if (!prev || (el.confidence ?? 0) > (prev.confidence ?? 0)) seen.set(k, el);
      });
      return {
        num: str(s.num, 16) || String(i + 1),
        heading: str(s.heading, 300) || null,
        int_ext: IE.includes(ie) ? ie : null,
        day_night: str(s.day_night, 40) || null,
        location: str(s.location, 300) || null,
        synopsis: str(s.synopsis, 1000) || null,
        body: typeof s.text === 'string' ? K().norm(s.text).trim() : null,
        pages_eighths: int(s.pages_eighths, 1, 9999, 1),
        est_minutes: int(s.est_minutes, 1, 5000, 60),
        elements: [...seen.values()],
      };
    });
  }

  /* ------------------------------------------------------------ long scripts: read in parts, in parallel
     One AI call must finish inside the server's time limit (about 150 s), so PDFs longer than a few pages and long
     texts are split, read three parts at a time, then stitched back together in order. */
  const PART_PAGES = 4, PART_CHARS = 14000, PARALLEL = 3;
  const loadLib = (src, name) => window[name] ? Promise.resolve(window[name]) : new Promise((ok, bad) => {
    const s = document.createElement('script'); s.src = src; s.onload = () => ok(window[name]); s.onerror = () => bad(new Error('Couldn’t load the PDF tools. Check your connection.')); document.head.appendChild(s);
  });

  async function pdfParts(ctx, script) {
    const { data: blob, error } = await ctx.sb.storage.from('scripts').download(script.file_path);
    if (error || !blob) throw new Error('The script file couldn’t be read from storage.');
    const PDFLib = await loadLib('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js', 'PDFLib');
    const src = await PDFLib.PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true });
    const n = src.getPageCount();
    if (n <= PART_PAGES) return null; // short enough for one call
    const parts = [];
    for (let start = 0; start < n; start += PART_PAGES) parts.push({ idx: Array.from({ length: Math.min(PART_PAGES, n - start) }, (_, k) => start + k) });
    return { src, n, parts, stamp: Date.now(), made: 0 };
  }
  /* save a page range as its own PDF (only when a worker is about to send it) */
  async function makePdfPart(ctx, script, doc, part) {
    const out = await PDFLib.PDFDocument.create();
    (await out.copyPages(doc.src, part.idx)).forEach((pg) => out.addPage(pg));
    const path = `${ctx.production.id}/parts/${script.id}-${doc.stamp}-${++doc.made}.pdf`;
    ctx.api.must(await ctx.sb.storage.from('scripts').upload(path, new Blob([await out.save()], { type: 'application/pdf' }), { contentType: 'application/pdf' }));
    const a = part.idx[0] + 1, b = part.idx[part.idx.length - 1] + 1;
    return { file_path: path, pages: `${a === b ? a : `${a}–${b}`} of ${doc.n}` };
  }

  function textParts(text, force = false) {
    if (!text || (!force && text.length <= PART_CHARS * 1.3)) return null;
    if (force && text.length <= PART_CHARS) return splitText(text);
    // cut at scene headings (INT./EXT./numbered scenes) where possible, otherwise at blank lines
    const cuts = [];
    let pos = 0;
    while (text.length - pos > PART_CHARS) {
      const win = text.slice(pos + PART_CHARS * 0.6, pos + PART_CHARS);
      const m = [...win.matchAll(/\n(?=\s*(?:\d+[.)]?\s+)?(?:INT|EXT|I\/E|داخلي|خارجي)[.\s])/gi)].pop() || [...win.matchAll(/\n\s*\n/g)].pop();
      const cut = pos + Math.round(PART_CHARS * 0.6) + (m ? m.index + 1 : win.length);
      cuts.push(text.slice(pos, cut)); pos = cut;
    }
    cuts.push(text.slice(pos));
    return cuts.map((t) => ({ text: t }));
  }

  /* one merged answer, shaped like a single-call breakdown */
  function mergeParts(outs) {
    const scenes = [];
    let runtime = 0; const notes = []; const langs = new Set();
    outs.forEach((o) => {
      (o.scenes || []).forEach((s) => {
        const cont = /\(cont(\.|inued)?\)\s*$/i.test(s.heading || '');
        const prev = scenes[scenes.length - 1];
        if (cont && prev) {
          prev.text = [prev.text, s.text].filter(Boolean).join('\n');
          prev.elements = (prev.elements || []).concat(s.elements || []);
          prev.pages_eighths = (Number(prev.pages_eighths) || 0) + (Number(s.pages_eighths) || 0);
          prev.est_minutes = (Number(prev.est_minutes) || 0) + (Number(s.est_minutes) || 0);
        } else scenes.push({ ...s });
      });
      if (Number(o.runtime_seconds) > runtime) runtime = Number(o.runtime_seconds);
      if (o.notes && !notes.includes(o.notes.trim())) notes.push(o.notes.trim());
      if (o.language) langs.add(o.language);
    });
    scenes.forEach((s, i) => { s.num = String(i + 1); });
    const language = langs.has('ar+en') || (langs.has('ar') && langs.has('en')) ? 'ar+en' : [...langs][0];
    return { scenes, runtime_seconds: runtime || null, notes: notes.join(' '), language };
  }

  async function runBreakdown(ctx, script, run) {
    const pid = ctx.production.id;
    const one = () => ctx.api.ai('breakdown', { production_id: pid, script_id: script.id });
    let doc = null, parts = null;
    if (script.source_type === 'pdf' && script.file_path) {
      run.stage = 'Preparing the PDF';
      doc = await pdfParts(ctx, script);
      if (doc) parts = doc.parts;
    } else parts = textParts(script.raw_text);

    // short scripts: one call. If even that is too slow, fall through to reading it in parts.
    if (!parts) {
      try { return await one(); } catch (err) {
        if (err.code !== 'too_slow') throw err;
        if (doc === null && script.source_type === 'pdf') throw new Error('This PDF is taking the AI too long to read. Try again, or split it into smaller files.');
        parts = textParts(script.raw_text, true);
        if (!parts) throw err;
      }
    }

    // parts are read three at a time; a part that is still too slow is split in half and put back in its place
    const uploaded = [];
    const pendingPart = () => parts.find((x) => !x.out && !x.busy);
    const worker = async () => {
      for (let part = pendingPart(); part; part = pendingPart()) {
        part.busy = true;
        try {
          const payload = doc ? await makePdfPart(ctx, script, doc, part) : { text: part.text };
          if (payload.file_path) uploaded.push(payload.file_path);
          const i = parts.indexOf(part);
          part.out = await ctx.api.ai('breakdown', { production_id: pid, script_id: script.id, ...payload, part: i + 1, parts: parts.length });
        } catch (err) {
          const size = doc ? part.idx.length : part.text.length;
          if (err.code !== 'too_slow' || size <= (doc ? 1 : 2000)) throw err;
          const halves = doc
            ? [{ idx: part.idx.slice(0, Math.ceil(size / 2)) }, { idx: part.idx.slice(Math.ceil(size / 2)) }]
            : splitText(part.text);
          parts.splice(parts.indexOf(part), 1, ...halves);
        }
        const done = parts.filter((x) => x.out).length;
        run.stage = `Read ${done} of ${parts.length} parts`;
      }
    };
    run.stage = `Reading ${parts.length} parts`;
    try {
      await Promise.all(Array.from({ length: Math.min(PARALLEL, parts.length) }, worker));
    } finally {
      if (uploaded.length) await ctx.sb.storage.from('scripts').remove(uploaded);
    }
    return mergeParts(parts.map((x) => x.out));
  }
  const splitText = (t) => {
    const mid = Math.floor(t.length / 2);
    const cut = t.lastIndexOf('\n', mid) > mid * 0.5 ? t.lastIndexOf('\n', mid) + 1 : mid;
    return [{ text: t.slice(0, cut) }, { text: t.slice(cut) }];
  };

  function startRun(ctx, script, opts = {}) {
    const { sb, api } = ctx;
    const pid = ctx.production.id;
    const run = (RUNS[script.id] = { started: Date.now(), done: false, error: null, stage: '', onDone: null });
    run.promise = (async () => {
      try {
        api.must(await sb.from('scripts').update({ breakdown_status: 'running', breakdown_at: new Date().toISOString() }).eq('id', script.id));
        const out = await runBreakdown(ctx, script, run);
        const scenes = clean(out);
        if (!scenes.length) throw new Error('The AI didn’t find any scenes. Check that this version holds the script itself, then run it again.');
        run.stage = 'Saving scenes and elements';
        api.must(await sb.from('scenes').delete().eq('script_id', script.id));
        if (opts.clearOlder) api.must(await sb.from('scenes').delete().eq('production_id', pid).neq('script_id', script.id));
        const inserted = api.must(await sb.from('scenes').insert(scenes.map((s, i) => ({
          production_id: pid, script_id: script.id, num: s.num, heading: s.heading, int_ext: s.int_ext, day_night: s.day_night,
          location: s.location, synopsis: s.synopsis, body: s.body, pages_eighths: s.pages_eighths, est_minutes: s.est_minutes, sort: i,
        }))).select('id, sort'));
        const idBySort = new Map(inserted.map((r) => [Number(r.sort), r.id]));
        const els = [];
        scenes.forEach((s, i) => s.elements.forEach((e) => els.push({
          production_id: pid, scene_id: idBySort.get(i), ...e, ai: true, status: (e.confidence ?? 0) >= AUTO ? 'accepted' : 'suggested',
        })));
        for (let i = 0; i < els.length; i += 400) api.must(await sb.from('elements').insert(els.slice(i, i + 400)));

        const rt = Number(out.runtime_seconds);
        const meta = { notes: typeof out.notes === 'string' ? out.notes.trim() : '', runtime: Number.isFinite(rt) && rt > 0 ? Math.round(rt) : null };
        writeMeta(script.id, meta);
        const done = { breakdown_status: 'done', breakdown_at: new Date().toISOString() };
        if (['ar', 'en', 'ar+en'].includes(out.language)) done.language = out.language;
        // breakdown_notes / runtime_seconds are optional columns; fall back if the schema doesn't have them
        const withMeta = await sb.from('scripts').update({ ...done, breakdown_notes: meta.notes || null, runtime_seconds: meta.runtime }).eq('id', script.id);
        if (withMeta.error) api.must(await sb.from('scripts').update(done).eq('id', script.id));

        const pending = els.filter((e) => e.status === 'suggested').length;
        delete RUNS[script.id];
        MPH.toast(`Breakdown of script v${script.version} is ready: ${plural(scenes.length, 'scene', 'scenes')}, ${plural(els.length, 'element', 'elements')}${pending ? `, ${pending} to review` : ''}.`, 'sparkles');
      } catch (err) {
        run.error = (err && err.message) || String(err);
        try { await sb.from('scripts').update({ breakdown_status: 'failed' }).eq('id', script.id); } catch (e) { /* offline */ }
      } finally {
        run.done = true;
        if (run.onDone) run.onDone(run);
      }
    })();
    return run;
  }

  function paintProgress(root, run) {
    const secs = Math.floor((Date.now() - run.started) / 1000);
    const el = root.querySelector('[data-elapsed]');
    if (el) el.textContent = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
    const line = root.querySelector('[data-line]');
    const txt = run.stage || (secs >= 100 ? 'Still working. Long scripts take a little longer' : STATUS[Math.min(STATUS.length - 1, Math.floor(secs / 8))]);
    if (line && line.dataset.txt !== txt) {
      line.dataset.txt = txt; line.textContent = `${txt}…`;
      line.classList.remove('bd-fade'); void line.offsetWidth; line.classList.add('bd-fade');
    }
    const bar = root.querySelector('[data-prog]');
    if (bar) bar.style.width = `${run.stage ? 97 : Math.round(4 + 90 * (1 - Math.exp(-secs / 40)))}%`;
  }
  function tick(root, run) {
    paintProgress(root, run);
    const t = setInterval(() => {
      if (!root.isConnected || run.done) { clearInterval(t); return; }
      paintProgress(root, run);
    }, 1000);
  }

  /* ------------------------------------------------------------ highlighting */
  function marksFor(scene, filter) {
    const text = K().norm(scene.body || '');
    const raw = [];
    scene.elements.forEach((el) => {
      if (el.source_quote) K().findAll(text, el.source_quote).forEach(([s, e]) => raw.push({ s, e, el }));
    });
    raw.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s) || (a.el.status === 'accepted' ? -1 : 1));
    const merged = [];
    raw.forEach((r) => {
      const last = merged[merged.length - 1];
      if (last && r.s === last.s && r.e === last.e) { if (!last.els.includes(r.el)) last.els.push(r.el); return; }
      if (last && r.s < last.e) return;
      merged.push({ s: r.s, e: r.e, els: [r.el] });
    });
    const found = new Set();
    const marks = merged.map((m) => {
      m.els.forEach((x) => found.add(x.id));
      const lead = (filter && m.els.find((x) => x.category === filter)) || m.els.find((x) => x.status === 'accepted') || m.els[0];
      const sug = m.els.every((x) => x.status === 'suggested');
      const dim = filter && !m.els.some((x) => x.category === filter);
      return {
        s: m.s, e: m.e,
        cls: `hl cat-${lead.category}${sug ? ' suggested' : ''}${dim ? ' bd-dim' : ''}`,
        ids: m.els.map((x) => x.id).join(' '),
        title: m.els.map((x) => `${catLabel(x.category)}: ${x.name}${x.status === 'suggested' ? ' (AI suggestion, not accepted yet)' : ''}`).join('\n'),
      };
    });
    return { text, marks, found };
  }

  /* ------------------------------------------------------------ pieces */
  const head = (ctx, sub, actions = '') => ctx.ui.pageHead({ eyebrow: 'Pre-production · AI Breakdown', title: 'Script breakdown', sub, actions });

  function sourceLine(s) {
    if (s.source_type === 'pdf') return `PDF · ${esc(K().fileName(s.file_path))}`;
    const n = K().words(s.raw_text);
    return `${s.source_type === 'docx' ? 'Word document' : 'Text'} · ${n.toLocaleString('en-US')} words${s.language ? ' · ' + esc(K().LANG[s.language] || s.language) : ''}`;
  }

  const failCallout = (ctx, msg, actions) => `
    <div class="callout danger bd-fail">${ctx.ui.icon('triangle-alert')}
      <div class="grow stack tight"><span class="small strong">The breakdown didn’t finish</span><span class="small">${esc(msg)}</span>
        ${actions ? '<span class="tiny muted">The breakdown below is unchanged.</span>' : ''}</div>
      ${actions ? `<div class="toolbar"><button class="btn btn-sm btn-outline" data-a="retry">${ctx.ui.icon('rotate-ccw')}Retry</button><button class="btn btn-sm btn-ghost" data-a="dismiss">Dismiss</button></div>` : ''}
    </div>`;

  function runningPage(ctx, d) {
    const { ui } = ctx;
    return `
      <div class="page bd-page">
        ${head(ctx, `${esc(ctx.production.title)} · script v${d.script.version} · ${sourceLine(d.script)}`)}
        <section class="panel bd-run">
          <div class="bd-run-orb" aria-hidden="true"><span class="bd-run-ring"></span>${ui.icon('sparkles')}</div>
          <div class="grow stack" style="gap:10px;min-width:0">
            <span class="h2">Breaking down script v${d.script.version}</span>
            <span class="bd-run-line" data-line aria-live="polite">Reading the script…</span>
            <div class="bar bd-run-bar"><span data-prog style="width:4%"></span></div>
            <span class="small muted"><span class="num strong" data-elapsed>0 s</span> elapsed · this usually takes 20 to 90 seconds.</span>
            <span class="tiny faint">Keep this tab open. You can work in other screens meanwhile; the breakdown saves itself when it’s done.</span>
          </div>
        </section>
        ${d.scenes.length ? `<div class="callout info">${ui.icon('info')}<span class="small">Your current breakdown stays as it is until the new one is ready. If the run fails, nothing changes.</span></div>` : ''}
      </div>`;
  }

  function startPage(ctx, d, run) {
    const { ui, production: p } = ctx;
    const s = d.script;
    const edit = ctx.canEdit;
    const stale = !run && s.breakdown_status === 'running' && !isRecentRun(s);
    const failedMsg = run && run.error ? run.error
      : s.breakdown_status === 'failed' ? 'The last breakdown attempt didn’t finish. Run it again.'
      : stale ? 'The last breakdown run stopped before it finished. Run it again.' : '';
    const elsewhere = !run && isRecentRun(s);
    return `
      <div class="page bd-page">
        ${head(ctx, `${esc(p.title)} · script v${s.version}`)}
        ${failedMsg ? failCallout(ctx, failedMsg, false) : ''}
        ${elsewhere ? `<div class="callout info">${ui.icon('loader')}<div class="grow small">A breakdown of v${s.version} started at ${MPH.date(s.breakdown_at, 'time')}, in another tab or by someone on your team. It usually finishes within two minutes.</div>
          <button class="btn btn-sm btn-outline" data-a="check">${ui.icon('refresh-cw')}Check again</button></div>` : ''}
        <section class="panel bd-start">
          <span class="bd-start-orb">${ui.icon('scan-text')}</span>
          <h2 class="h2">Run the AI breakdown on script v${s.version}</h2>
          <p class="muted bd-start-lede">The AI reads the script in Arabic and English, splits it into scenes and tags what every department needs against the exact words that call for it. Tags at 90% confidence or more are accepted for you; everything else waits for your yes.</p>
          <div class="bd-start-src">${ui.icon(s.source_type === 'pdf' ? 'file-text' : 'file-type')}<span dir="auto">Script v${s.version} · ${sourceLine(s)}</span><a class="accent" href="#p.${p.id}.script">View</a></div>
          <div class="bd-start-cats" aria-label="What it tags">${ui.CATEGORIES.map((c) => ui.catTag(c.id)).join('')}</div>
          ${edit ? `
            ${d.older ? `<label class="check small bd-older"><input type="checkbox" data-clear-older><span>Also remove the breakdown of earlier script versions (${plural(d.older, 'scene', 'scenes')}). Their shots and stripboard placement go with them.</span></label>` : ''}
            <button class="btn btn-primary bd-big" data-a="run">${ui.icon('sparkles')}${failedMsg ? 'Run the breakdown again' : `Run AI breakdown on script v${s.version}`}</button>
            <span class="tiny faint">Takes 20 to 90 seconds.</span>`
          : `<p class="small muted">A producer or head of department can run the breakdown.</p>`}
        </section>
      </div>`;
  }

  function aibar(ctx, d) {
    const { ui } = ctx;
    const all = d.scenes.flatMap((s) => s.elements);
    const pending = all.filter((e) => e.status === 'suggested');
    const high = pending.filter((e) => (Number(e.confidence) || 0) >= HIGH);
    const accepted = all.length - pending.length;
    const meta = metaFor(d.script);
    const s = d.script;
    return `
      <section class="bd-aibar">
        <span class="bd-ai-orb">${ui.icon('sparkles')}</span>
        <div class="grow stack" style="gap:6px;min-width:0">
          <div class="row wrap" style="gap:6px 10px">
            <span class="strong">AI read script v${s.version}</span>
            <span class="bd-aistat"><span class="num">${d.scenes.length}</span> ${d.scenes.length === 1 ? 'scene' : 'scenes'}</span>
            <span class="bd-aistat"><span class="num">${all.length}</span> ${all.length === 1 ? 'element' : 'elements'}</span>
            <span class="bd-aistat ${pending.length ? 'warn' : 'ok'}"><span class="num">${pending.length}</span> to review</span>
            ${meta.runtime ? `<span class="bd-aistat" title="Runtime from the script’s timecodes, or the AI’s estimate">${ui.icon('timer')}<span class="num">${clock(meta.runtime)}</span> runtime</span>` : ''}
            ${s.language ? `<span class="bd-aistat">${esc(K().LANG[s.language] || s.language)}</span>` : ''}
            ${s.breakdown_at && s.breakdown_status === 'done' ? `<span class="tiny faint">${MPH.date(s.breakdown_at)} · ${MPH.date(s.breakdown_at, 'time')}</span>` : ''}
          </div>
          <div class="row" style="gap:10px">${ui.bar(all.length ? accepted / all.length : 1)}<span class="tiny muted nowrap num">${accepted} of ${all.length} accepted</span></div>
          ${meta.notes ? `<p class="bd-notes small">${ui.icon('info')}<span dir="auto">${esc(meta.notes)}</span></p>` : ''}
        </div>
        ${ctx.canEdit ? `<div class="toolbar">
          ${pending.length ? `<button class="btn btn-ghost btn-sm" data-a="next">${ui.icon('arrow-down-to-line')}Next to review</button>` : ''}
          <button class="btn btn-primary btn-sm" data-a="accept-high" ${high.length ? '' : 'disabled'} title="Accept every suggestion at 75% confidence or more">${ui.icon('check-check')}Accept all high-confidence (≥ 75%)${high.length ? ` · ${high.length}` : ''}</button>
        </div>` : ''}
      </section>`;
  }

  function navHtml(ctx, d, u, cur) {
    const { ui } = ctx;
    const pool = u.view === 'scene' ? cur.elements : d.scenes.flatMap((s) => s.elements);
    const counts = {};
    pool.forEach((e) => { counts[e.category] = (counts[e.category] || 0) + 1; });
    return `
      <nav class="bd-nav" aria-label="Scenes and categories">
        <div class="panel flush">
          <header class="panel-head">${ui.icon('clapperboard')}<h3 class="h3">Scenes</h3><span class="tiny faint num">${d.scenes.length}</span></header>
          <div class="bd-scenes">
            ${d.scenes.map((s) => {
              const h = K().splitHeading(s.heading);
              const pend = s.elements.filter((e) => e.status === 'suggested').length;
              return `<button class="bd-scn ${s.id === cur.id && u.view === 'scene' ? 'on' : ''}" data-a="scene" data-id="${s.id}" title="${esc(s.heading || '')}">
                <span class="bd-scn-num">${esc(s.num)}</span>
                <span class="grow stack" style="gap:2px;min-width:0">
                  <span class="small strong truncate" dir="auto">${esc(h.set || s.location || s.heading || 'Scene ' + s.num)}</span>
                  <span class="row tiny" style="gap:5px">${s.int_ext ? `<span class="bd-ie">${esc(s.int_ext)}</span>` : ''}${s.day_night ? `<span class="muted truncate">${esc(s.day_night)}</span>` : ''}<span class="faint nowrap">· ${s.elements.length}</span></span>
                </span>
                ${pend ? `<span class="bd-pend" title="${plural(pend, 'suggestion', 'suggestions')} to review"><span class="dot"></span>${pend}</span>`
                  : s.elements.length ? `<span class="bd-done" title="All reviewed">${ui.icon('check')}</span>` : ''}
              </button>`;
            }).join('')}
          </div>
        </div>
        <div class="panel flush">
          <header class="panel-head">${ui.icon('tags')}<h3 class="h3">Elements</h3><span class="tiny faint">${u.view === 'scene' ? `Sc. ${esc(cur.num)}` : 'All scenes'}</span></header>
          <div class="bd-cats">
            <button class="bd-cat ${!u.filter ? 'on' : ''}" data-a="filter" data-cat=""><span class="bd-cat-dot all"></span><span class="grow">All elements</span><span class="num tiny">${pool.length}</span></button>
            ${ui.CATEGORIES.map((c) => `<button class="bd-cat cat-${c.id} ${u.filter === c.id ? 'on' : ''} ${counts[c.id] ? '' : 'zero'}" data-a="filter" data-cat="${c.id}" aria-pressed="${u.filter === c.id}"><span class="bd-cat-dot"></span><span class="grow truncate">${esc(c.label)}</span><span class="num tiny">${counts[c.id] || 0}</span></button>`).join('')}
          </div>
        </div>
      </nav>`;
  }

  function scriptPane(ctx, d, s, mk) {
    const { ui } = ctx;
    const i = d.scenes.indexOf(s);
    const prev = d.scenes[i - 1], next = d.scenes[i + 1];
    return `
      <section class="bd-script panel flush">
        <header class="bd-script-head">
          <div class="row wrap" style="gap:8px"><span class="bd-scn-num lg">${esc(s.num)}</span><span class="bd-heading" dir="auto">${esc(s.heading || 'Scene ' + s.num)}</span></div>
          ${s.synopsis ? `<p class="small muted" dir="auto">${esc(s.synopsis)}</p>` : ''}
          <div class="row wrap tiny muted" style="gap:6px 14px">
            ${s.location ? `<span class="row" style="gap:4px" dir="auto">${ui.icon('map-pin')}${esc(s.location)}</span>` : ''}
            ${s.int_ext || s.day_night ? `<span class="row" style="gap:4px">${ui.icon('sun-moon')}${[s.int_ext, s.day_night].filter(Boolean).map(esc).join(' · ')}</span>` : ''}
            <span class="row" style="gap:4px">${ui.icon('file-text')}${MPH.eighths(s.pages_eighths)} pg</span>
            <span class="row" style="gap:4px">${ui.icon('timer')}about ${fmtMin(s.est_minutes)} to shoot</span>
          </div>
        </header>
        <div class="bd-hint">
          ${ctx.canEdit ? `${ui.icon('text-select')}<span>Select any words to tag them as an element.</span>` : `${ui.icon('highlighter')}<span>Tagged words are highlighted.</span>`}
          <span class="spacer"></span>
          <span class="row tiny" style="gap:10px"><span class="hl cat-props">accepted</span><span class="hl cat-props suggested">AI suggestion</span></span>
        </div>
        <div class="bd-body sc-body" data-scene="${s.id}">${s.body && s.body.trim() ? K().renderBody(mk.text, mk.marks) : '<div class="sc-ln faint">The AI didn’t return text for this scene.</div>'}</div>
        ${prev || next ? `<footer class="bd-pager">
          ${prev ? `<button class="btn btn-ghost btn-sm" data-a="scene" data-id="${prev.id}">${ui.icon('chevron-left', 'bd-flip')}Sc. ${esc(prev.num)}</button>` : '<span></span>'}
          ${next ? `<button class="btn btn-ghost btn-sm" data-a="scene" data-id="${next.id}">Sc. ${esc(next.num)}${ui.icon('chevron-right', 'bd-flip')}</button>` : '<span></span>'}
        </footer>` : ''}
      </section>`;
  }

  function elRow(ctx, el, found) {
    const { ui } = ctx;
    const sug = el.status === 'suggested';
    const conf = el.confidence != null ? pct(el.confidence) : null;
    return `
      <div class="bd-el ${sug ? 'is-sug' : ''}" data-id="${el.id}" id="bd-el-${el.id}">
        <span class="bd-el-dot cat-${el.category}" aria-hidden="true"></span>
        <div class="grow stack" style="gap:4px;min-width:0">
          <div class="row wrap" style="gap:6px">
            <span class="bd-el-name" dir="auto">${esc(el.name)}</span>
            ${el.qty > 1 ? `<span class="bd-qty num">×${el.qty}</span>` : ''}
            ${el.ai && !el.source_quote ? `<span class="bd-src bd-implied" title="${esc(el.reason || 'Implied by the scene rather than written in it')}">Implied</span>` : ''}
            ${!el.ai ? '<span class="bd-flag">Added by you</span>' : ''}
            ${!sug && el.ai && conf != null ? `<span class="bd-conf tiny faint num" title="${esc(`AI confidence${el.reason ? ': ' + el.reason : ''}`)}">${conf}%</span>` : ''}
          </div>
          ${sug ? `
            <div class="bd-why">${ui.aiBadge(conf != null ? `${conf}%` : 'AI')}<span dir="auto">${esc(el.reason || 'Suggested by the AI.')}</span></div>
            ${el.source_quote ? `<button class="bd-quote" dir="auto" ${found.has(el.id) ? `data-a="locate" data-id="${el.id}" title="Show in the script"` : 'disabled title="These exact words weren’t found in the scene text"'}>“${esc(el.source_quote)}”</button>` : ''}
            ${ctx.canEdit ? `<div class="row bd-sug-acts">
              <button class="btn btn-primary btn-xs" data-a="accept" data-id="${el.id}">${ui.icon('check')}Accept</button>
              <button class="btn btn-outline btn-xs" data-a="correct" data-id="${el.id}">${ui.icon('pencil')}Correct</button>
              <button class="btn btn-ghost btn-xs" data-a="remove" data-id="${el.id}">${ui.icon('x')}Remove</button>
            </div>` : ''}` : ''}
        </div>
        ${!sug && ctx.canEdit ? `<div class="bd-el-acts">
          <button class="btn btn-ghost btn-xs btn-icon" data-a="correct" data-id="${el.id}" aria-label="Edit ${esc(el.name)}" title="Edit">${ui.icon('pencil')}</button>
          <button class="btn btn-ghost btn-xs btn-icon" data-a="remove" data-id="${el.id}" aria-label="Remove ${esc(el.name)}" title="Remove">${ui.icon('trash-2')}</button>
        </div>` : ''}
      </div>`;
  }

  function sheetHtml(ctx, s, u, found) {
    const { ui } = ctx;
    const groups = ui.CATEGORIES.map((c) => ({ c, items: s.elements.filter((e) => e.category === c.id) })).filter((g) => g.items.length);
    const pend = s.elements.filter((e) => e.status === 'suggested').length;
    return `
      <aside class="bd-sheet panel flush">
        <header class="panel-head">${ui.icon('clipboard-list')}<h3 class="h3">Breakdown sheet · Sc. ${esc(s.num)}</h3>
          ${ctx.canEdit ? `<button class="btn btn-outline btn-xs" data-a="add">${ui.icon('plus')}Add element</button>` : ''}</header>
        <div class="bd-sheet-sum">
          <span class="small"><span class="num strong">${s.elements.length}</span> <span class="muted">${s.elements.length === 1 ? 'element' : 'elements'}</span></span>
          ${pend ? `<span class="small bd-warn"><span class="num strong">${pend}</span> to review</span>` : s.elements.length ? `<span class="small bd-ok">${ui.icon('circle-check')}All reviewed</span>` : ''}
          <span class="small muted">${MPH.eighths(s.pages_eighths)} pg · ${fmtMin(s.est_minutes)}</span>
        </div>
        ${groups.length ? `<div class="bd-groups">${groups.map((g) => `
          <section class="bd-group ${u.filter && u.filter !== g.c.id ? 'bd-dim' : ''}">
            <div class="bd-group-head">${ui.catTag(g.c.id)}<span class="tiny faint num">${g.items.length}</span></div>
            ${g.items.map((el) => elRow(ctx, el, found)).join('')}
          </section>`).join('')}</div>`
        : `<div class="bd-sheet-empty small muted">${ctx.canEdit ? 'No elements in this scene yet. Select words in the script to tag them, or use Add element.' : 'No elements in this scene.'}</div>`}
      </aside>`;
  }

  function aggregate(d, filter) {
    const map = new Map();
    d.scenes.forEach((s) => s.elements.forEach((e) => {
      if (filter && e.category !== filter) return;
      const k = `${e.category}|${e.name.trim().toLowerCase()}`;
      let r = map.get(k);
      if (!r) map.set(k, (r = { cat: e.category, name: e.name.trim(), scenes: [], qty: 0, pending: 0, total: 0 }));
      if (!r.scenes.includes(s)) r.scenes.push(s);
      r.qty += e.qty || 1; r.total++;
      if (e.status === 'suggested') r.pending++;
    }));
    return [...map.values()].sort((a, b) => catIdx(a.cat) - catIdx(b.cat) || b.scenes.length - a.scenes.length || a.name.localeCompare(b.name));
  }
  const statusText = (r) => (!r.pending ? 'Accepted' : r.pending === r.total ? 'Suggested' : `${r.pending} of ${r.total} to review`);

  function listHtml(ctx, d, u) {
    const { ui } = ctx;
    const rows = aggregate(d, u.filter);
    let last = null;
    return `
      <div class="panel flush">
        <header class="panel-head">${ui.icon('list')}<h3 class="h3">Element list</h3>
          <span class="tiny muted">${plural(rows.length, 'unique element', 'unique elements')}${u.filter ? ' · ' + esc(catLabel(u.filter)) : ''}</span>
          <button class="btn btn-outline btn-xs" data-a="csv" ${rows.length ? '' : 'disabled'}>${ui.icon('file-down')}Export CSV</button></header>
        <div class="table-wrap"><table class="table bd-table">
          <thead><tr><th>Category</th><th>Element</th><th>Scenes</th><th class="r">Total qty</th><th>Status</th></tr></thead>
          <tbody>
            ${rows.map((r) => {
              const first = r.cat !== last; last = r.cat;
              return `<tr class="${first ? 'bd-first' : ''}">
                <td class="nowrap">${first ? ui.catTag(r.cat) : ''}</td>
                <td><span class="row" style="gap:8px"><span class="bd-el-dot cat-${r.cat}" aria-hidden="true"></span><span dir="auto">${esc(r.name)}</span></span></td>
                <td><span class="row wrap" style="gap:4px">${r.scenes.map((s) => `<button class="bd-scchip" data-a="scene" data-id="${s.id}" title="${esc(s.heading || 'Scene ' + s.num)}">${esc(s.num)}</button>`).join('')}</span></td>
                <td class="r">${r.qty}</td>
                <td>${!r.pending ? ui.pill('Accepted', 'ok', 'check') : ui.pill(r.pending === r.total ? 'Suggested' : `${r.pending} to review`, 'warn', 'sparkles')}</td>
              </tr>`;
            }).join('') || `<tr><td colspan="5">${ui.empty('search-x', u.filter ? 'Nothing in this category yet' : 'No elements yet')}</td></tr>`}
          </tbody>
        </table></div>
      </div>`;
  }

  function reqHtml(ctx, d) {
    const { ui } = ctx;
    const pid = ctx.production.id;
    const acc = {};
    let pend = 0;
    d.scenes.forEach((s) => s.elements.forEach((e) => {
      if (e.status !== 'accepted') { pend++; return; }
      const m = (acc[e.category] = acc[e.category] || new Map());
      const k = e.name.trim().toLowerCase();
      m.set(k, Math.max(m.get(k) || 0, e.qty || 1));
    }));
    const parts = ui.CATEGORIES.filter((c) => acc[c.id]).map((c) => {
      const n = [...acc[c.id].values()].reduce((a, b) => a + b, 0);
      const [one, many] = NOUNS[c.id] || [c.label, c.label];
      return `<strong class="num">${n}</strong> ${esc(n === 1 ? one : many)}`;
    });
    return `
      <section class="callout bd-req">${ui.icon('clipboard-check')}
        <div class="grow stack" style="gap:6px;min-width:0">
          <span class="h3">What this job needs</span>
          <span class="small">${parts.length ? parts.join(', ') + '.' : 'Nothing accepted yet. Accept elements to build the list of what the job needs.'}${pend ? ` <span class="muted">Plus ${plural(pend, 'suggestion', 'suggestions')} still to review.</span>` : ''}</span>
          <span class="tiny muted">Counted from accepted elements: once per element across all scenes, at the largest quantity any scene needs.</span>
        </div>
        <div class="toolbar">
          <a class="btn btn-outline btn-sm" href="#p.${pid}.crew">${ui.icon('users')}Crew &amp; Talent</a>
          <a class="btn btn-outline btn-sm" href="#p.${pid}.shotlist">${ui.icon('list-video')}Shot List</a>
        </div>
      </section>`;
  }

  function mainPage(ctx, d) {
    const { ui, production: p } = ctx;
    const u = uiState(ctx, d);
    const cur = d.scenes.find((s) => s.id === u.scene) || d.scenes[0];
    const run = RUNS[d.script.id];
    const views = [['scene', 'Scenes', 'scan-text'], ['list', 'Element list', 'list']];
    let body;
    if (u.view === 'list') {
      body = `<div class="bd-layout bd-layout-report">${navHtml(ctx, d, u, cur)}<div class="stack" style="min-width:0">${listHtml(ctx, d, u)}</div></div>`;
    } else {
      const mk = marksFor(cur, u.filter);
      body = `<div class="bd-layout">${navHtml(ctx, d, u, cur)}${scriptPane(ctx, d, cur, mk)}${sheetHtml(ctx, cur, u, mk.found)}</div>`;
    }
    return `
      <div class="page bd-page">
        ${head(ctx, `${esc(p.title)} · script v${d.script.version} · every AI tag waits for your yes`, `
          <div class="seg" role="tablist" aria-label="Breakdown view">${views.map(([id, l, ic]) => `<button class="${id === u.view ? 'on' : ''}" role="tab" aria-selected="${id === u.view}" data-a="view" data-v="${id}">${ui.icon(ic)}${l}</button>`).join('')}</div>
          ${ctx.canEdit ? `<button class="btn btn-outline btn-sm" data-a="rerun">${ui.icon('refresh-cw')}Re-run breakdown</button>` : ''}`)}
        ${run && run.error ? failCallout(ctx, run.error, ctx.canEdit)
          : d.script.breakdown_status === 'failed' ? `<div class="callout info">${ui.icon('info')}<span class="small">The last re-run didn’t finish, so this is the breakdown from the run before it.</span></div>` : ''}
        ${aibar(ctx, d)}
        ${body}
        ${reqHtml(ctx, d)}
      </div>`;
  }

  /* ------------------------------------------------------------ overlays */
  function openEdit(ctx, d, sceneId, el, done) {
    const { ui, sb, api } = ctx;
    const scene = d.scenes.find((x) => x.id === sceneId);
    const sug = el && el.status === 'suggested';
    const u = uiState(ctx, d);
    const cat0 = (el && el.category) || u.filter || 'props';
    const m = ctx.modal(ctx.frame({
      title: !el ? 'Add element' : sug ? 'Correct AI suggestion' : 'Edit element',
      sub: el ? `Sc. ${esc(scene.num)} · ${esc(scene.heading || '')}` : 'Added elements count as accepted.',
      body: `
        ${sug ? `<div class="callout">${ui.icon('sparkles')}<div class="small stack tight">
          <span><strong>AI suggested</strong> “<span dir="auto">${esc(el.name)}</span>” as ${esc(catLabel(el.category))}${el.confidence != null ? ` (${pct(el.confidence)}% confident)` : ''}.</span>
          ${el.reason ? `<span class="muted" dir="auto">${esc(el.reason)}</span>` : ''}
          ${el.source_quote ? `<span class="bd-quote" dir="auto">“${esc(el.source_quote)}”</span>` : ''}</div></div>` : ''}
        <form class="stack" data-f novalidate>
          <div class="field"><label for="bd-e-name">Element</label><input class="input" id="bd-e-name" dir="auto" maxlength="200" value="${el ? esc(el.name) : ''}" placeholder="e.g. Brass dallah and finjan cups" required></div>
          <div class="grid-2">
            <div class="field"><label for="bd-e-cat">Category</label><select class="select" id="bd-e-cat">${ui.CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === cat0 ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
            <div class="field"><label for="bd-e-qty">Quantity</label><input class="input" id="bd-e-qty" type="number" min="1" step="1" inputmode="numeric" value="${(el && el.qty) || 1}"></div>
          </div>
          ${!el ? `<div class="field"><label for="bd-e-scene">Scene</label><select class="select" id="bd-e-scene">${d.scenes.map((s) => `<option value="${s.id}" ${s.id === sceneId ? 'selected' : ''}>Sc. ${esc(s.num)} · ${esc(s.heading || s.location || '')}</option>`).join('')}</select></div>
            <p class="tiny muted">Tip: select words in the scene text to tag them in place, so the element stays linked to its line.</p>` : ''}
          <div data-err hidden></div>
          <button type="submit" hidden></button>
        </form>`,
      foot: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-save>${ui.icon('check')}${!el ? 'Add element' : sug ? 'Save and accept' : 'Save changes'}</button>`,
    }));
    const btn = m.querySelector('[data-save]');
    const err = m.querySelector('[data-err]');
    const save = async () => {
      const nameI = m.querySelector('#bd-e-name');
      const name = nameI.value.replace(/\s+/g, ' ').trim();
      if (!name) { err.hidden = false; err.innerHTML = ui.errorBox('Give the element a name.'); MPH.icons(); nameI.focus(); return; }
      const qty = Math.max(1, Math.min(100000, parseInt(m.querySelector('#bd-e-qty').value, 10) || 1));
      const category = m.querySelector('#bd-e-cat').value;
      btn.disabled = true;
      try {
        if (el) {
          const patch = { name, qty, category, status: 'accepted' };
          api.must(await sb.from('elements').update(patch).eq('id', el.id));
          const changed = name !== el.name || category !== el.category || qty !== el.qty;
          Object.assign(el, patch);
          ctx.closeOverlay();
          done(sug ? (changed ? `Corrected and accepted: ${name}` : `Accepted: ${name}`) : `Saved ${name}`, el.id);
        } else {
          const target = d.scenes.find((s) => s.id === m.querySelector('#bd-e-scene').value) || scene;
          const row = api.must(await sb.from('elements').insert({ production_id: ctx.production.id, scene_id: target.id, category, name, qty, status: 'accepted', ai: false }).select().single());
          target.elements.push(row);
          u.scene = target.id;
          ctx.closeOverlay();
          done(`Added ${name} to Sc. ${target.num} as ${catLabel(category)}`, row.id);
        }
      } catch (ex) {
        btn.disabled = false;
        err.hidden = false; err.innerHTML = ui.errorBox(ex.message); MPH.icons();
      }
    };
    btn.addEventListener('click', save);
    m.querySelector('[data-f]').addEventListener('submit', (e) => { e.preventDefault(); save(); });
  }

  async function openRerun(ctx, d, go) {
    const { ui, sb } = ctx;
    const all = d.scenes.flatMap((s) => s.elements);
    const reviewed = all.filter((e) => e.status === 'accepted' && (!e.ai || (Number(e.confidence) || 0) < AUTO)).length;
    const scheduled = d.scenes.filter((s) => s.shoot_day_id).length;
    let shots = null;
    try {
      const { count, error } = await sb.from('shots').select('id', { count: 'exact', head: true }).in('scene_id', d.scenes.map((s) => s.id).slice(0, 300));
      if (!error) shots = count || 0;
    } catch (e) { shots = null; }
    const v = d.script.version;
    const lost = [
      `the ${plural(d.scenes.length, 'scene', 'scenes')} and ${plural(all.length, 'element', 'elements')} of script v${v}${reviewed ? `, including ${reviewed} you accepted, corrected or added by hand` : ''}`,
      scheduled ? `the shoot-day assignments of ${plural(scheduled, 'scheduled scene', 'scheduled scenes')} on the stripboard` : 'any shoot-day assignments for these scenes on the stripboard',
      shots == null ? 'the shots on the shot list for these scenes' : shots ? `${plural(shots, 'shot', 'shots')} on the shot list for these scenes` : '',
    ].filter(Boolean);
    const m = ctx.modal(ctx.frame({
      title: `Re-run the breakdown on script v${v}?`,
      body: `
        <p>The AI reads script v${v} again from scratch. When it finishes, its new scenes and elements <strong>replace</strong> the current breakdown of this version.</p>
        <div class="callout danger">${ui.icon('triangle-alert')}<div class="small stack tight"><span class="strong">Deleted when the new breakdown is saved:</span>
          <ul class="bd-lost">${lost.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>
        <p class="small muted">Your current breakdown stays untouched while the AI works. If the run fails, nothing changes.</p>`,
      foot: `<button class="btn btn-ghost" data-close>Keep the current breakdown</button><button class="btn btn-danger" data-go>${ui.icon('refresh-cw')}Replace and re-run</button>`,
    }));
    m.querySelector('[data-go]').addEventListener('click', () => { ctx.closeOverlay(); go(); });
  }

  function exportCsv(ctx, d, u) {
    const rows = aggregate(d, u.filter);
    const cell = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheet apps from treating text as a formula
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [['Category', 'Element', 'Scenes', 'Scene count', 'Total quantity', 'Status']]
      .concat(rows.map((r) => [catLabel(r.cat), r.name, r.scenes.map((s) => s.num).join(', '), r.scenes.length, r.qty, statusText(r)]));
    const csv = '﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const base = String(ctx.production.code || ctx.production.title || 'production').replace(/[^\w؀-ۿ-]+/g, '-').replace(/^-+|-+$/g, '') || 'production';
    const a = document.createElement('a');
    a.href = url;
    a.download = `${base}-breakdown-v${d.script.version}${u.filter ? '-' + u.filter : ''}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    ctx.toast(`Exported ${plural(rows.length, 'element', 'elements')} as CSV`, 'file-down');
  }

  /* ------------------------------------------------------------ view */
  MPH.view('breakdown', {
    async load(ctx) {
      const { sb, api } = ctx;
      const pid = ctx.production.id;
      const script = api.must(await sb.from('scripts').select('*').eq('production_id', pid).order('version', { ascending: false }).limit(1))[0] || null;
      if (!script) return { script: null, scenes: [], older: 0 };
      const scenes = api.must(await sb.from('scenes').select('*, elements(*)').eq('script_id', script.id).order('sort'));
      scenes.forEach((s) => { s.elements = (s.elements || []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))); });
      let older = 0;
      if (!scenes.length) {
        const { count } = await sb.from('scenes').select('id', { count: 'exact', head: true }).eq('production_id', pid).neq('script_id', script.id);
        older = count || 0;
      }
      return { script, scenes, older };
    },

    render(ctx, d) {
      const { ui, production: p } = ctx;
      if (!d.script) {
        return `<div class="page bd-page">${head(ctx, esc(p.title))}
          <div class="panel">${ui.empty('scan-text', 'No script to break down yet',
            'Add the script first. The AI reads it in Arabic and English and suggests cast, props, wardrobe, vehicles, locations and more against each line, and you accept or correct every one.',
            `<a class="btn btn-primary" href="#p.${p.id}.script">${ui.icon('file-text')}Go to Script</a>`)}</div></div>`;
      }
      const run = RUNS[d.script.id];
      if (run && !run.done) return runningPage(ctx, d);
      if (!d.scenes.length) return startPage(ctx, d, run);
      return mainPage(ctx, d);
    },

    mount(root, ctx, d) {
      const script = d.script;
      if (!script) return;
      const { sb, api, ui } = ctx;
      const pid = ctx.production.id;
      const u = uiState(ctx, d);

      const repaint = () => {
        const sc = root.querySelector('.bd-scenes');
        const top = sc ? sc.scrollTop : 0;
        root.innerHTML = MPH.views.breakdown.render(ctx, d);
        MPH.icons();
        const sc2 = root.querySelector('.bd-scenes');
        if (sc2) sc2.scrollTop = top;
      };
      const findEl = (id) => {
        for (const s of d.scenes) { const el = s.elements.find((x) => x.id === id); if (el) return { el, scene: s }; }
        return {};
      };
      const current = () => d.scenes.find((s) => s.id === u.scene) || d.scenes[0];
      const pulse = (node, cls) => { if (!node) return; node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); };
      const flash = (id) => {
        const row = root.querySelector(`#bd-el-${id}`);
        if (!row) return;
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        pulse(row, 'flash');
      };

      /* running */
      const attach = (run) => { run.onDone = () => { if (root.isConnected) ctx.reload(); }; tick(root, run); };
      const begin = (opts = {}) => {
        const cur = RUNS[script.id];
        if (cur && !cur.done) return;
        hideTagger();
        const run = startRun(ctx, script, opts);
        repaint();
        attach(run);
      };
      if (RUNS[script.id] && !RUNS[script.id].done) attach(RUNS[script.id]);
      if (ctx.params[0] === 'run') {
        try { history.replaceState(null, '', `#p.${pid}.breakdown`); } catch (e) { /* ignore */ }
        if (ctx.canEdit && !d.scenes.length && !RUNS[script.id] && !isRecentRun(script) && !d.older && !AUTO_USED[script.id]) {
          AUTO_USED[script.id] = true;
          begin();
        }
      }

      /* tagging by selection */
      function hideTagger() { const p = root.querySelector('.bd-tagger'); if (p) p.remove(); }
      function showTagger(rect, text) {
        let pop = root.querySelector('.bd-tagger');
        if (!pop) {
          pop = document.createElement('div');
          pop.className = 'bd-tagger';
          pop.setAttribute('role', 'dialog');
          pop.setAttribute('aria-label', 'Tag the selected words');
          root.appendChild(pop);
        }
        pop.dataset.text = text;
        const short = text.length > 48 ? text.slice(0, 46) + '…' : text;
        pop.innerHTML = `
          <div class="row" style="gap:6px"><span class="tiny muted nowrap">Tag</span><span class="small strong truncate grow" dir="auto">“${esc(short.replace(/\s+/g, ' '))}”</span>
            <button class="btn btn-ghost btn-xs btn-icon" data-tag-close aria-label="Close">${ui.icon('x')}</button></div>
          <div class="bd-tg-cats">${ui.CATEGORIES.map((c) => `<button type="button" class="bd-tg-cat cat-${c.id}" data-tag="${c.id}">${ui.icon(c.icon)}<span class="truncate">${esc(c.label)}</span></button>`).join('')}</div>
          <span class="tiny faint">Adds an accepted element to Sc. ${esc(current().num)}. You can edit it on the sheet.</span>`;
        MPH.icons();
        const w = pop.offsetWidth, h = pop.offsetHeight;
        let top = rect.bottom + 8;
        if (top + h > window.innerHeight - 8) top = rect.top - h - 8;
        top = Math.max(8, Math.min(window.innerHeight - h - 8, top));
        const left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
        pop.style.top = `${top}px`;
        pop.style.left = `${left}px`;
      }
      async function tagSelection(cat) {
        const pop = root.querySelector('.bd-tagger');
        if (!pop) return;
        const quote = pop.dataset.text;
        let name = quote.replace(/\s+/g, ' ').replace(/^["'“”«»(\[]+|["'“”«»)\].,:;!?،؛؟]+$/g, '').trim().slice(0, 200) || quote.slice(0, 200);
        if (/^[a-z]/.test(name)) name = name[0].toUpperCase() + name.slice(1);
        const s = current();
        pop.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        try {
          const row = api.must(await sb.from('elements').insert({ production_id: pid, scene_id: s.id, category: cat, name, qty: 1, status: 'accepted', ai: false, source_quote: quote }).select().single());
          s.elements.push(row);
          hideTagger();
          const sel = window.getSelection(); if (sel) sel.removeAllRanges();
          repaint();
          flash(row.id);
          ctx.toast(`Tagged “${name}” as ${catLabel(cat)}`, 'tag');
        } catch (ex) {
          pop.querySelectorAll('button').forEach((x) => { x.disabled = false; });
          ctx.toastError(ex);
        }
      }

      root.addEventListener('mouseup', (e) => {
        if (!ctx.canEdit || e.target.closest('.bd-tagger')) return;
        setTimeout(() => {
          const body = root.querySelector('.bd-body');
          const sel = window.getSelection();
          if (!body || !sel || sel.isCollapsed || !sel.rangeCount) { hideTagger(); return; }
          const range = sel.getRangeAt(0);
          if (!body.contains(range.commonAncestorContainer)) { hideTagger(); return; }
          const text = sel.toString().replace(/ /g, ' ').trim();
          if (text.length < 2 || text.length > 300) { hideTagger(); return; }
          showTagger(range.getBoundingClientRect(), text);
        }, 0);
      });
      const onDoc = (e) => {
        if (!root.isConnected) { document.removeEventListener('keydown', onDoc); document.removeEventListener('mousedown', onDoc); return; }
        const pop = root.querySelector('.bd-tagger');
        if (!pop) return;
        if (e.type === 'keydown' && e.key === 'Escape') hideTagger();
        if (e.type === 'mousedown' && !pop.contains(e.target) && !root.contains(e.target)) hideTagger();
      };
      document.addEventListener('keydown', onDoc);
      document.addEventListener('mousedown', onDoc);
      const content = document.getElementById('content');
      if (content) {
        const onScroll = () => { if (!root.isConnected) { content.removeEventListener('scroll', onScroll); return; } hideTagger(); };
        content.addEventListener('scroll', onScroll, { passive: true });
      }

      /* hovering a sheet row lights up its words in the script */
      root.addEventListener('mouseover', (e) => {
        const row = e.target.closest('.bd-el[data-id]');
        const id = row ? row.dataset.id : null;
        root.querySelectorAll('.bd-body .hl.bd-hot').forEach((x) => { if (!id || !x.dataset.ids.split(' ').includes(id)) x.classList.remove('bd-hot'); });
        if (id) root.querySelectorAll(`.bd-body .hl[data-ids~="${id}"]`).forEach((x) => x.classList.add('bd-hot'));
      });

      root.addEventListener('click', async (e) => {
        if (e.target.closest('[data-tag-close]')) { hideTagger(); return; }
        const tg = e.target.closest('[data-tag]');
        if (tg) { tagSelection(tg.dataset.tag); return; }
        const hl = e.target.closest('.bd-body .hl[data-ids]');
        if (hl && window.getSelection().isCollapsed) { flash(hl.dataset.ids.split(' ')[0]); return; }
        const b = e.target.closest('[data-a]');
        if (!b || !root.contains(b)) return;
        const a = b.dataset.a;
        const id = b.dataset.id;
        try {
          if (a === 'run' || a === 'retry') {
            const box = root.querySelector('[data-clear-older]');
            begin({ clearOlder: !!(box && box.checked) });
          }
          else if (a === 'check') ctx.reload();
          else if (a === 'dismiss') { delete RUNS[script.id]; repaint(); }
          else if (a === 'view') { u.view = b.dataset.v; hideTagger(); repaint(); }
          else if (a === 'scene') {
            u.scene = id; u.view = 'scene'; hideTagger(); repaint();
            const lay = root.querySelector('.bd-layout');
            if (lay && lay.getBoundingClientRect().top < 0) lay.scrollIntoView({ block: 'start' });
          }
          else if (a === 'filter') { const c = b.dataset.cat || null; u.filter = u.filter === c ? null : c; repaint(); }
          else if (a === 'locate') {
            const target = root.querySelector(`.bd-body .hl[data-ids~="${id}"]`);
            if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); pulse(target, 'bd-ping'); }
          }
          else if (a === 'accept') {
            const { el } = findEl(id);
            if (!el) return;
            b.disabled = true;
            api.must(await sb.from('elements').update({ status: 'accepted' }).eq('id', id));
            el.status = 'accepted';
            repaint();
            ctx.toast(`Accepted: ${el.name}`);
          }
          else if (a === 'remove') {
            const { el, scene } = findEl(id);
            if (!el) return;
            b.disabled = true;
            api.must(await sb.from('elements').delete().eq('id', id));
            scene.elements = scene.elements.filter((x) => x.id !== id);
            repaint();
            ctx.toast(`Removed ${el.name} from Sc. ${scene.num}`, 'trash-2');
          }
          else if (a === 'correct') {
            const { el, scene } = findEl(id);
            if (el) openEdit(ctx, d, scene.id, el, (msg, eid) => { repaint(); ctx.toast(msg); flash(eid); });
          }
          else if (a === 'add') openEdit(ctx, d, current().id, null, (msg, eid) => { u.view = 'scene'; repaint(); ctx.toast(msg, 'plus'); flash(eid); });
          else if (a === 'accept-high') {
            const high = d.scenes.flatMap((s) => s.elements).filter((x) => x.status === 'suggested' && (Number(x.confidence) || 0) >= HIGH);
            if (!high.length) return;
            b.disabled = true; b.innerHTML = `${ui.spinner()}Accepting…`;
            try {
              for (let i = 0; i < high.length; i += 100) {
                api.must(await sb.from('elements').update({ status: 'accepted' }).in('id', high.slice(i, i + 100).map((x) => x.id)));
              }
            } catch (ex) { ctx.toastError(ex); ctx.reload(); return; }
            high.forEach((x) => { x.status = 'accepted'; });
            const left = d.scenes.reduce((n, s) => n + s.elements.filter((x) => x.status === 'suggested').length, 0);
            repaint();
            ctx.toast(`Accepted ${plural(high.length, 'suggestion', 'suggestions')} at 75% confidence or more. ${left ? `${left} left for you to review.` : 'Everything is reviewed.'}`, 'check-check');
          }
          else if (a === 'next') {
            const has = (s) => s.elements.some((x) => x.status === 'suggested');
            const cur = current();
            const idx = d.scenes.indexOf(cur);
            const order = d.scenes.slice(idx + 1).concat(d.scenes.slice(0, idx));
            const target = u.view === 'scene' && has(cur) ? cur : order.find(has) || (has(cur) ? cur : null);
            if (!target) return;
            u.scene = target.id; u.view = 'scene'; repaint();
            const row = root.querySelector('.bd-el.is-sug');
            if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); pulse(row, 'flash'); }
          }
          else if (a === 'rerun') openRerun(ctx, d, () => begin());
          else if (a === 'csv') exportCsv(ctx, d, u);
        } catch (ex) {
          if (b.isConnected) b.disabled = false;
          ctx.toastError(ex);
        }
      });
    },
  });
})();

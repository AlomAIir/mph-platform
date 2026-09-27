/* MPH platform core: namespace, view registry, UI state, formatting, i18n. */
(function () {
  const MPH = (window.MPH = window.MPH || {});

  /* ---------- view registry ----------
     A view is {
       load?(ctx)            -> Promise<data>   fetch what the screen needs (runs before render)
       render(ctx, data)     -> html string
       mount?(root, ctx, data)                  attach listeners (root is a fresh node every render)
     }
     ctx: { route, params, production, role, isClient, canEdit, canSeeInternal, go, reload, toast, modal, drawer,
            closeOverlay, frame, t, ui, esc, api, sb, state, session } */
  MPH.views = {};
  MPH.view = (id, def) => { MPH.views[id] = def; };

  /* ---------- UI state (per viewer, not data) ---------- */
  const saved = (() => { try { return JSON.parse(localStorage.getItem('mph.platform.ui') || '{}'); } catch (e) { return {}; } })();
  MPH.state = Object.assign({ lang: 'en', previewClient: false, orgId: null }, saved);
  MPH.saveState = () => {
    try { localStorage.setItem('mph.platform.ui', JSON.stringify({ lang: MPH.state.lang, orgId: MPH.state.orgId })); } catch (e) { /* storage unavailable */ }
  };

  /* ---------- formatting ---------- */
  MPH.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  MPH.sar = (n, opts = {}) => {
    const v = Math.round(Number(n) || 0).toLocaleString('en-US');
    return opts.bare ? v : 'SAR ' + v;
  };
  MPH.sarK = (n) => {
    n = Number(n) || 0;
    return 'SAR ' + (Math.abs(n) >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'K' : Math.round(n));
  };
  MPH.pct = (n, d = 0) => ((Number(n) || 0) * 100).toFixed(d) + '%';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  MPH.date = (iso, style = 'short') => {
    if (!iso) return '';
    const d = new Date(String(iso).length === 10 ? iso + 'T00:00:00' : iso);
    if (isNaN(d)) return '';
    if (style === 'day') return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
    if (style === 'long') return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    if (style === 'time') return d.toTimeString().slice(0, 5);
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  };
  MPH.time = (t) => (t ? String(t).slice(0, 5) : '');
  MPH.today = () => new Date().toISOString().slice(0, 10);
  MPH.daysUntil = (iso) => iso ? Math.round((new Date(iso + 'T00:00:00') - new Date(MPH.today() + 'T00:00:00')) / 86400000) : null;
  MPH.eighths = (n) => { n = Number(n) || 0; const w = Math.floor(n / 8), r = n % 8; return w ? (r ? `${w} ${r}/8` : `${w}`) : `${r}/8`; };
  MPH.hue = (s) => { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  MPH.debounce = (fn, ms = 400) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  /* ---------- i18n (shell and common labels) ---------- */
  const AR = {
    'Home': 'الرئيسية', 'Productions': 'الإنتاجات', 'Marketplace': 'السوق', 'Messages': 'الرسائل', 'Tasks': 'المهام', 'Settings': 'الإعدادات', 'Team': 'الفريق',
    'Overview': 'نظرة عامة', 'Script': 'النص', 'AI Breakdown': 'التفريغ الذكي', 'Stripboard': 'لوحة الجدولة', 'Shot List': 'قائمة اللقطات',
    'Storyboard': 'القصة المصورة', 'Budget & Bid': 'الميزانية والعرض', 'Crew & Talent': 'الطاقم والمواهب', 'Calendar': 'التقويم',
    'Call Sheets': 'أوراق الاستدعاء', 'Locations': 'المواقع', 'Review & Approvals': 'المراجعة والاعتماد',
    'Pre-production': 'ما قبل الإنتاج', 'Production': 'الإنتاج', 'Post-production': 'ما بعد الإنتاج',
    'Dailies & Media': 'اللقطات اليومية والوسائط', 'Edit & Versions': 'المونتاج والنسخ', 'Finishing': 'التشطيب',
    'Deliverables': 'التسليمات', 'Wrap Report': 'تقرير الختام', 'Shoot Day': 'يوم التصوير',
    'Treatment & Lookbook': 'المعالجة ولوحة المزاج', 'Documents': 'المستندات',
    'Search': 'بحث', 'Preview client view': 'معاينة عرض العميل', 'Back to producer view': 'العودة لعرض المنتج',
    'New production': 'إنتاج جديد', 'Sign out': 'تسجيل الخروج', 'Soon': 'قريبًا', 'Coming soon': 'قريبًا',
    'Story': 'القصة', 'Breakdown': 'التفريغ', 'Visualize': 'التصوّر', 'Schedule': 'الجدولة', 'Budget': 'الميزانية',
    'Team & places': 'الفريق والمواقع', 'Shoot': 'التصوير', 'Edit': 'المونتاج', 'Approve': 'الاعتماد', 'Finish & deliver': 'التشطيب والتسليم', 'Close': 'الختام',
    'Phase one': 'المرحلة الأولى', 'Phase two': 'المرحلة الثانية', 'Phase three': 'المرحلة الثالثة', 'Post and delivery': 'ما بعد الإنتاج والتسليم',
  };
  MPH.t = (s) => (MPH.state.lang === 'ar' && AR[s]) || s;
})();

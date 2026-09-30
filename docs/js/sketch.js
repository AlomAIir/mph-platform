/* MPH.sketch(spec, opts): draws a flat, pitch-deck-style illustration of a shot from a small scene spec.
   The AI writes the spec (see the "illustrate" and "cover" actions); this file turns it into an SVG in milliseconds.

   spec = {
     time:    'dawn' | 'day' | 'golden' | 'dusk' | 'night' | 'interior',
     setting: 'desert' | 'city' | 'road' | 'coast' | 'heritage' | 'office' | 'hospital' | 'home' | 'studio' | 'camp' | 'park' | 'mall',
     size:    'EWS' | 'WS' | 'MWS' | 'MS' | 'MCU' | 'CU' | 'ECU' | 'Insert',
     angle:   'eye' | 'low' | 'high' | 'overhead',
     motion:  'static' | 'pan' | 'track' | 'push' | 'pull' | 'drone' | 'crane' | 'handheld',
     subjects: [{ kind: 'person' | 'child' | 'group' | 'car' | 'animal' | 'object', x: 0..1, facing: 'left' | 'right', label? }],
     props:    [{ kind: 'palm' | 'tree' | 'fire' | 'lamp' | 'tent' | 'table' | 'desk' | 'screen' | 'sofa' | 'bed' | 'telescope' | 'coffee' | 'sign' | 'building', x: 0..1 }],
     light:   'warm' | 'cool' | 'neutral',
     seed?:   number
   }
   opts = { wide: true } draws a 960×300 banner (production covers) instead of a 320×180 frame; opts.aspect overrides the frame ratio. */
(function () {
  const C = { lime: '#ACD062', limeD: '#8DB44A', apricot: '#FAB771', apricotD: '#E89A55', teal: '#4E8A7E', tealL: '#7FB2A6', tealD: '#2F5E55',
    cream: '#F5F4EF', creamD: '#D9DDD6', ink: '#0E2422', inkS: '#16302C', sand: '#E3B878', sandD: '#C9965A', brick: '#C98A4B', brickD: '#9E6636', coral: '#F07A6A' };

  /* small seeded random so the same spec always draws the same picture */
  const rng = (seed) => { let s = (seed >>> 0) || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
  const hash = (o) => { const t = JSON.stringify(o || {}); let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const f = (n) => Math.round(n * 10) / 10;

  const SKY = {
    dawn: ['#F2B878', '#B9C7B5', '#6F9BA2'], day: ['#A9D2DE', '#D6E8E2', '#EEF2EA'], golden: ['#F6C177', '#EBA06A', '#C9785A'],
    dusk: ['#3E3D6B', '#8E5E7A', '#E48A5A'], night: ['#08142A', '#10243E', '#1D3B55'], interior: ['#2A4B46', '#23403C', '#1C3532'],
  };
  const SIZE = { EWS: .22, WS: .4, MWS: .58, MS: .82, MCU: 1.15, CU: 1.7, ECU: 2.6, Insert: 1.9 };
  const PEOPLE = [C.apricot, C.tealL, C.lime, C.cream, C.coral];

  function sketch(spec = {}, opts = {}) {
    const W = opts.wide ? 960 : 320;
    const H = opts.wide ? 300 : Math.round(320 / (opts.aspect || 16 / 9));
    const r = rng(spec.seed || hash(spec));
    const time = SKY[spec.time] ? spec.time : 'day';
    const setting = spec.setting || 'desert';
    const indoor = time === 'interior' || ['office', 'hospital', 'home', 'studio', 'mall'].includes(setting);
    const angle = spec.angle || 'eye';
    const size = SIZE[spec.size] ? spec.size : 'WS';
    const scale = SIZE[size] * (opts.wide ? .9 : 1);
    const hz = angle === 'overhead' ? -1 : H * (angle === 'low' ? .72 : angle === 'high' ? .42 : .6); // horizon line
    const id = 'sk' + (hash(spec) % 1e6) + (opts.wide ? 'w' : '');
    const out = [];

    /* ---------------- sky or wall */
    const sky = SKY[indoor ? 'interior' : time];
    out.push(`<defs><linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset=".6" stop-color="${sky[1]}"/><stop offset="1" stop-color="${sky[2]}"/></linearGradient>
      <radialGradient id="${id}l" cx=".7" cy=".3" r=".8"><stop offset="0" stop-color="${spec.light === 'cool' ? C.tealL : C.apricot}" stop-opacity=".35"/><stop offset="1" stop-color="${C.apricot}" stop-opacity="0"/></radialGradient></defs>`);
    out.push(`<rect width="${W}" height="${H}" fill="url(#${id}s)"/>`);
    if (!indoor && angle !== 'overhead') {
      if (time === 'night') for (let i = 0; i < (opts.wide ? 40 : 16); i++) out.push(`<circle class="sk-star" style="animation-delay:${f(r() * 3)}s" cx="${f(r() * W)}" cy="${f(r() * hz * .8)}" r="${f(.5 + r() * 1.1)}" fill="${C.cream}"/>`);
      if (['dawn', 'golden', 'dusk'].includes(time)) out.push(`<circle cx="${f(W * (.62 + r() * .2))}" cy="${f(hz - H * .04)}" r="${f(H * .12)}" fill="#FFE1A8" opacity=".9"/>`);
      if (time === 'day') out.push(`<circle cx="${f(W * .82)}" cy="${f(H * .18)}" r="${f(H * .07)}" fill="#FFF6D8"/>`);
      if (time === 'night') out.push(`<circle cx="${f(W * .8)}" cy="${f(H * .2)}" r="${f(H * .06)}" fill="${C.cream}"/><circle cx="${f(W * .8 + H * .025)}" cy="${f(H * .19)}" r="${f(H * .055)}" fill="${sky[0]}"/>`);
    }

    /* ---------------- ground / set */
    const ground = hz < 0 ? 0 : hz;
    const G = (fill, d) => out.push(`<path d="${d}" fill="${fill}"/>`);
    if (angle === 'overhead') {
      const base = { desert: C.sand, road: '#3A4744', coast: C.sand, heritage: C.sand, city: '#3A4744', camp: C.sandD, park: C.limeD }[setting] || '#2F4A45';
      out.push(`<rect width="${W}" height="${H}" fill="${indoor ? '#3B5751' : base}"/>`);
      if (setting === 'road' || setting === 'city') out.push(`<rect x="0" y="${f(H * .38)}" width="${W}" height="${f(H * .24)}" fill="#26312F"/>${Array.from({ length: 8 }, (_, i) => `<rect x="${f(i * W / 8 + 6)}" y="${f(H * .495)}" width="${f(W / 16)}" height="3" fill="${C.cream}" opacity=".7"/>`).join('')}`);
      if (setting === 'desert') for (let i = 0; i < 5; i++) out.push(`<path d="M0 ${f(H * (.15 + i * .2))} Q${f(W * .3)} ${f(H * (.08 + i * .2))} ${f(W * .6)} ${f(H * (.17 + i * .2))} T${W} ${f(H * (.14 + i * .2))}" fill="none" stroke="${C.sandD}" stroke-width="2" opacity=".5"/>`);
      if (setting === 'coast') out.push(`<path d="M0 0 H${W} V${f(H * .45)} Q${f(W * .5)} ${f(H * .55)} 0 ${f(H * .42)}Z" fill="${C.teal}"/>`);
    } else if (indoor) {
      out.push(`<rect y="${f(ground)}" width="${W}" height="${f(H - ground)}" fill="${setting === 'studio' ? '#C9CFC9' : setting === 'hospital' ? '#9FB9B2' : '#3B5751'}"/>`);
      if (setting === 'studio') out.push(`<path d="M0 ${f(ground - H * .05)} Q${f(W * .5)} ${f(ground + H * .12)} ${W} ${f(ground - H * .05)} V${H} H0Z" fill="#DADFD9"/>`);
      else {
        const wx = W * (.08 + r() * .5), ww = W * .26, wy = H * .12, wh = Math.max(10, ground - H * .22);
        out.push(`<rect x="${f(wx)}" y="${f(wy)}" width="${f(ww)}" height="${f(wh)}" rx="3" fill="${time === 'night' ? '#10243E' : '#CFE3E0'}" opacity=".85"/><rect x="${f(wx + ww / 2 - 1)}" y="${f(wy)}" width="2" height="${f(wh)}" fill="${C.inkS}" opacity=".35"/>`);
        out.push(`<rect width="${W}" height="${H}" fill="url(#${id}l)"/>`);
        if (setting === 'home') out.push(`<rect x="${f(W * .1)}" y="${f(ground + (H - ground) * .35)}" width="${f(W * .8)}" height="${f((H - ground) * .4)}" rx="4" fill="${C.brickD}" opacity=".55"/>`);
        if (setting === 'office' || setting === 'mall') out.push(`<rect x="0" y="${f(ground - 2)}" width="${W}" height="3" fill="${C.cream}" opacity=".2"/>`);
      }
    } else {
      if (setting === 'desert' || setting === 'camp') {
        G(C.sandD, `M0 ${f(ground)} Q${f(W * .25)} ${f(ground - H * .1)} ${f(W * .5)} ${f(ground - H * .02)} T${W} ${f(ground - H * .06)} V${H} H0Z`);
        G(C.sand, `M0 ${f(ground + H * .08)} Q${f(W * .35)} ${f(ground - H * .02)} ${f(W * .7)} ${f(ground + H * .07)} T${W} ${f(ground + H * .04)} V${H} H0Z`);
      } else if (setting === 'coast') {
        out.push(`<rect y="${f(ground)}" width="${W}" height="${f(H * .12)}" fill="${C.teal}"/><rect y="${f(ground + H * .12)}" width="${W}" height="${H}" fill="${C.sand}"/>`);
      } else if (setting === 'road') {
        G(C.sandD, `M0 ${f(ground)} H${W} V${H} H0Z`);
        out.push(`<path d="M${f(W * .44)} ${f(ground)} L${f(W * .56)} ${f(ground)} L${f(W * .95)} ${H} L${f(W * .05)} ${H}Z" fill="#303B39"/>`);
        for (let i = 0; i < 4; i++) { const t = (i + .5) / 4, y = ground + (H - ground) * t; out.push(`<rect x="${f(W / 2 - 1 - t * 2)}" y="${f(y)}" width="${f(2 + t * 4)}" height="${f(3 + t * 8)}" fill="${C.cream}" opacity=".8"/>`); }
      } else if (setting === 'heritage') {
        G(C.sand, `M0 ${f(ground)} H${W} V${H} H0Z`);
        const wh = H * .26;
        out.push(`<rect x="0" y="${f(ground - wh)}" width="${W}" height="${f(wh)}" fill="${C.brick}"/>`);
        for (let x = 0; x < W; x += W / 18) out.push(`<rect x="${f(x)}" y="${f(ground - wh - 6)}" width="${f(W / 36)}" height="7" fill="${C.brick}"/>`);
        for (let i = 0; i < 4; i++) out.push(`<rect x="${f(W * (.1 + i * .23))}" y="${f(ground - wh * .7)}" width="${f(W * .03)}" height="${f(wh * .35)}" rx="2" fill="${C.brickD}"/>`);
      } else if (setting === 'city' || setting === 'park') {
        for (let i = 0, x = 0; x < W; i++) { const bw = W * (.05 + r() * .07), bh = H * (.15 + r() * .35); out.push(`<rect x="${f(x)}" y="${f(ground - bh)}" width="${f(bw)}" height="${f(bh)}" fill="${time === 'night' ? '#0C1C2E' : C.tealD}" opacity=".9"/>`); if (time === 'night' || time === 'dusk') for (let k = 0; k < 3; k++) out.push(`<rect x="${f(x + 3 + r() * (bw - 6))}" y="${f(ground - bh + 4 + r() * (bh - 8))}" width="2.5" height="2.5" fill="${C.apricot}" opacity=".8"/>`); x += bw + 2; }
        G(setting === 'park' ? C.limeD : '#3A4744', `M0 ${f(ground)} H${W} V${H} H0Z`);
      } else G(C.tealD, `M0 ${f(ground)} H${W} V${H} H0Z`);
    }

    /* ---------------- props (behind subjects) */
    const baseY = angle === 'overhead' ? H * .6 : ground + (H - ground) * .55;
    (spec.props || []).slice(0, 6).forEach((p) => {
      const x = W * Math.min(.95, Math.max(.05, Number(p.x) || r())), s = H * .35 * Math.min(1.4, Math.max(.6, scale));
      switch (p.kind) {
        case 'palm': out.push(`<rect x="${f(x - 2)}" y="${f(baseY - s * 1.2)}" width="4" height="${f(s * 1.2)}" fill="${C.inkS}"/>${[-60, -20, 20, 60].map((a) => `<ellipse cx="${f(x)}" cy="${f(baseY - s * 1.2)}" rx="${f(s * .4)}" ry="${f(s * .08)}" transform="rotate(${a} ${f(x)} ${f(baseY - s * 1.2)})" fill="${C.limeD}"/>`).join('')}`); break;
        case 'tree': out.push(`<rect x="${f(x - 2.5)}" y="${f(baseY - s * .7)}" width="5" height="${f(s * .7)}" fill="${C.inkS}"/><ellipse cx="${f(x)}" cy="${f(baseY - s * .8)}" rx="${f(s * .55)}" ry="${f(s * .28)}" fill="${C.limeD}"/>`); break;
        case 'fire': out.push(`<g class="sk-fire" style="transform-origin:${f(x)}px ${f(baseY)}px"><path d="M${f(x - s * .18)} ${f(baseY)} Q${f(x - s * .2)} ${f(baseY - s * .3)} ${f(x)} ${f(baseY - s * .5)} Q${f(x + s * .2)} ${f(baseY - s * .3)} ${f(x + s * .18)} ${f(baseY)}Z" fill="${C.apricot}"/><path d="M${f(x - s * .08)} ${f(baseY)} Q${f(x)} ${f(baseY - s * .3)} ${f(x + s * .08)} ${f(baseY)}Z" fill="#FFE1A8"/></g><ellipse cx="${f(x)}" cy="${f(baseY)}" rx="${f(s * .5)}" ry="${f(s * .12)}" fill="${C.apricot}" opacity=".25"/>`); break;
        case 'lamp': out.push(`<rect x="${f(x - 1.5)}" y="${f(baseY - s)}" width="3" height="${f(s)}" fill="${C.inkS}"/><path d="M${f(x - s * .14)} ${f(baseY - s)} h${f(s * .28)} l-${f(s * .05)} -${f(s * .14)} h-${f(s * .18)}z" fill="${C.cream}"/>`); break;
        case 'tent': out.push(`<path d="M${f(x - s * .7)} ${f(baseY)} L${f(x)} ${f(baseY - s * .7)} L${f(x + s * .7)} ${f(baseY)}Z" fill="${C.cream}"/><path d="M${f(x - s * .12)} ${f(baseY)} L${f(x)} ${f(baseY - s * .45)} L${f(x + s * .12)} ${f(baseY)}Z" fill="${C.inkS}"/>`); break;
        case 'table': case 'desk': out.push(`<rect x="${f(x - s * .5)}" y="${f(baseY - s * .32)}" width="${f(s)}" height="${f(s * .07)}" fill="${C.creamD}"/><rect x="${f(x - s * .45)}" y="${f(baseY - s * .27)}" width="3" height="${f(s * .27)}" fill="${C.inkS}"/><rect x="${f(x + s * .43)}" y="${f(baseY - s * .27)}" width="3" height="${f(s * .27)}" fill="${C.inkS}"/>`); break;
        case 'screen': out.push(`<rect x="${f(x - s * .2)}" y="${f(baseY - s * .55)}" width="${f(s * .4)}" height="${f(s * .26)}" rx="2" fill="${C.ink}"/><rect x="${f(x - s * .17)}" y="${f(baseY - s * .52)}" width="${f(s * .34)}" height="${f(s * .2)}" fill="${C.tealL}"/><rect x="${f(x - 1.5)}" y="${f(baseY - s * .29)}" width="3" height="${f(s * .08)}" fill="${C.ink}"/>`); break;
        case 'sofa': out.push(`<rect x="${f(x - s * .6)}" y="${f(baseY - s * .3)}" width="${f(s * 1.2)}" height="${f(s * .3)}" rx="${f(s * .08)}" fill="${C.brickD}"/><rect x="${f(x - s * .6)}" y="${f(baseY - s * .45)}" width="${f(s * 1.2)}" height="${f(s * .18)}" rx="${f(s * .06)}" fill="${C.brick}"/>`); break;
        case 'bed': out.push(`<rect x="${f(x - s * .7)}" y="${f(baseY - s * .25)}" width="${f(s * 1.4)}" height="${f(s * .18)}" rx="3" fill="${C.cream}"/><rect x="${f(x - s * .7)}" y="${f(baseY - s * .4)}" width="${f(s * .12)}" height="${f(s * .4)}" fill="${C.line || C.creamD}"/>`); break;
        case 'telescope': out.push(`<path d="M${f(x)} ${f(baseY - s * .35)} l-${f(s * .15)} ${f(s * .35)} M${f(x)} ${f(baseY - s * .35)} l${f(s * .15)} ${f(s * .35)}" stroke="${C.inkS}" stroke-width="2.5"/><rect x="${f(x - s * .05)}" y="${f(baseY - s * .5)}" width="${f(s * .45)}" height="${f(s * .08)}" rx="2" transform="rotate(-25 ${f(x)} ${f(baseY - s * .45)})" fill="${C.cream}"/>`); break;
        case 'coffee': out.push(`<path d="M${f(x - s * .1)} ${f(baseY - s * .3)} h${f(s * .2)} l-${f(s * .03)} ${f(s * .25)} h-${f(s * .14)}z" fill="${C.apricotD}"/><path d="M${f(x)} ${f(baseY - s * .3)} l${f(s * .12)} -${f(s * .08)}" stroke="${C.apricotD}" stroke-width="3"/>`); break;
        case 'sign': out.push(`<rect x="${f(x - 1.5)}" y="${f(baseY - s * .7)}" width="3" height="${f(s * .7)}" fill="${C.inkS}"/><rect x="${f(x - s * .25)}" y="${f(baseY - s * .75)}" width="${f(s * .5)}" height="${f(s * .2)}" rx="3" fill="${C.lime}"/>`); break;
        case 'building': out.push(`<rect x="${f(x - s * .35)}" y="${f(baseY - s * 1.4)}" width="${f(s * .7)}" height="${f(s * 1.4)}" fill="${C.tealD}"/>${Array.from({ length: 6 }, (_, i) => `<rect x="${f(x - s * .25 + (i % 2) * s * .3)}" y="${f(baseY - s * 1.3 + Math.floor(i / 2) * s * .4)}" width="${f(s * .18)}" height="${f(s * .2)}" fill="${C.creamD}" opacity=".6"/>`).join('')}`); break;
        default: out.push(`<rect x="${f(x - s * .15)}" y="${f(baseY - s * .3)}" width="${f(s * .3)}" height="${f(s * .3)}" rx="3" fill="${C.creamD}"/>`);
      }
    });

    /* ---------------- subjects */
    const subs = (spec.subjects || []).slice(0, 6);
    const close = SIZE[size] >= 1.15;
    subs.forEach((sb, i) => {
      const x = W * Math.min(.94, Math.max(.06, sb.x != null ? Number(sb.x) : (i + 1) / (subs.length + 1)));
      const col = PEOPLE[(i + (spec.seed || 0)) % PEOPLE.length];
      const h = H * .52 * scale * (sb.kind === 'child' ? .72 : 1);
      // close shots: frame the head and shoulders (people) or the thing itself (objects) in the middle of the frame
      const foot = angle === 'overhead' ? H * .55
        : close ? (sb.kind === 'object' ? H * .5 + h * .25 : sb.kind === 'car' ? H * .78 : H + h * .06)
        : baseY;
      if (sb.kind === 'car') {
        const w = h * 2.1, ch = h * .55, y = foot - ch;
        out.push(`<g><path d="M${f(x - w / 2)} ${f(y + ch * .45)} Q${f(x - w / 2)} ${f(y + ch * .15)} ${f(x - w * .3)} ${f(y + ch * .12)} L${f(x - w * .18)} ${f(y - ch * .25)} H${f(x + w * .22)} L${f(x + w * .36)} ${f(y + ch * .12)} Q${f(x + w / 2)} ${f(y + ch * .15)} ${f(x + w / 2)} ${f(y + ch * .45)} V${f(y + ch * .8)} H${f(x - w / 2)}Z" fill="${C.cream}"/>
          <path d="M${f(x - w * .14)} ${f(y - ch * .18)} H${f(x + w * .02)} V${f(y + ch * .1)} H${f(x - w * .26)}Z M${f(x + w * .06)} ${f(y - ch * .18)} H${f(x + w * .2)} L${f(x + w * .3)} ${f(y + ch * .1)} H${f(x + w * .06)}Z" fill="${C.tealD}"/>
          <circle cx="${f(x - w * .3)}" cy="${f(y + ch * .8)}" r="${f(ch * .28)}" fill="${C.ink}"/><circle cx="${f(x + w * .3)}" cy="${f(y + ch * .8)}" r="${f(ch * .28)}" fill="${C.ink}"/>
          <rect x="${f(sb.facing === 'left' ? x - w / 2 : x + w / 2 - 6)}" y="${f(y + ch * .3)}" width="6" height="${f(ch * .14)}" rx="2" fill="#FFE1A8"/></g>`);
      } else if (sb.kind === 'animal') {
        out.push(`<g fill="${C.sandD}"><ellipse cx="${f(x)}" cy="${f(foot - h * .45)}" rx="${f(h * .45)}" ry="${f(h * .18)}"/><ellipse cx="${f(x - h * .05)}" cy="${f(foot - h * .62)}" rx="${f(h * .14)}" ry="${f(h * .12)}"/>
          <path d="M${f(x + h * .35)} ${f(foot - h * .5)} q${f(h * .2)} -${f(h * .3)} ${f(h * .2)} -${f(h * .45)}" stroke="${C.sandD}" stroke-width="${f(h * .08)}" fill="none"/><circle cx="${f(x + h * .56)}" cy="${f(foot - h * .98)}" r="${f(h * .07)}"/>
          ${[-.3, -.1, .15, .32].map((d) => `<rect x="${f(x + h * d)}" y="${f(foot - h * .32)}" width="${f(h * .05)}" height="${f(h * .32)}"/>`).join('')}</g>`);
      } else if (sb.kind === 'object') {
        out.push(`<rect x="${f(x - h * .25)}" y="${f(foot - h * .5)}" width="${f(h * .5)}" height="${f(h * .5)}" rx="${f(h * .06)}" fill="${C.cream}"/><rect x="${f(x - h * .18)}" y="${f(foot - h * .42)}" width="${f(h * .36)}" height="${f(h * .06)}" fill="${C.lime}"/>`);
      } else {
        const n = sb.kind === 'group' ? 3 : 1;
        for (let k = 0; k < n; k++) {
          const px = x + (k - (n - 1) / 2) * h * .42, ph = h * (k === 1 ? 1 : .95), c = PEOPLE[(i + k) % PEOPLE.length];
          const head = ph * .16, bodyW = ph * .34, bodyH = ph * .5;
          out.push(`<g class="sk-person"><rect x="${f(px - bodyW / 2)}" y="${f(foot - bodyH)}" width="${f(bodyW)}" height="${f(bodyH + 4)}" rx="${f(bodyW / 2)}" fill="${n > 1 ? c : col}"/>
            <circle cx="${f(px)}" cy="${f(foot - bodyH - head * 1.05)}" r="${f(head)}" fill="${n > 1 ? c : col}" opacity=".92"/>
            ${close && n === 1 ? `<rect x="${f(px + (sb.facing === 'left' ? -head * .9 : head * .35))}" y="${f(foot - bodyH - head * 1.2)}" width="${f(head * .55)}" height="${f(head * .18)}" rx="${f(head * .09)}" fill="${C.ink}" opacity=".45"/>` : ''}</g>`);
        }
      }
    });

    /* ---------------- camera move + framing guides */
    const m = spec.motion || 'static';
    const ac = 'fill="none" stroke="' + C.cream + '" stroke-width="' + (opts.wide ? 3 : 2) + '" stroke-linecap="round" stroke-dasharray="' + (opts.wide ? '8 7' : '5 5') + '" opacity=".85"';
    const tip = (x, y, dir) => `<path d="M${f(x)} ${f(y)} l${f(-8 * dir)} -5 v10z" fill="${C.cream}" opacity=".9"/>`;
    if (m === 'pan' || m === 'track') out.push(`<path d="M${f(W * .22)} ${f(H * .9)} H${f(W * .78)}" ${ac}/>${tip(W * .8, H * .9, 1)}`);
    if (m === 'push') out.push(`<rect x="${f(W * .2)}" y="${f(H * .2)}" width="${f(W * .6)}" height="${f(H * .6)}" ${ac}/><rect x="${f(W * .32)}" y="${f(H * .32)}" width="${f(W * .36)}" height="${f(H * .36)}" ${ac}/>`);
    if (m === 'pull') out.push(`<rect x="${f(W * .08)}" y="${f(H * .1)}" width="${f(W * .84)}" height="${f(H * .8)}" ${ac}/>`);
    if (m === 'crane') out.push(`<path d="M${f(W * .15)} ${f(H * .8)} Q${f(W * .2)} ${f(H * .2)} ${f(W * .5)} ${f(H * .14)}" ${ac}/>${tip(W * .52, H * .14, 1)}`);
    if (m === 'drone') out.push(`<g opacity=".9"><rect x="${f(W * .47)}" y="${f(H * .08)}" width="${f(W * .06)}" height="${f(H * .03)}" rx="2" fill="${C.cream}"/><path d="M${f(W * .44)} ${f(H * .08)} h${f(W * .12)}" stroke="${C.cream}" stroke-width="2"/><path d="M${f(W * .5)} ${f(H * .12)} L${f(W * .35)} ${f(H * .7)} M${f(W * .5)} ${f(H * .12)} L${f(W * .65)} ${f(H * .7)}" ${ac}/></g>`);
    const corner = opts.wide ? 0 : 12, cw = 1.6;
    if (!opts.wide) out.push(`<g stroke="${C.cream}" stroke-width="${cw}" opacity=".55" fill="none"><path d="M6 ${6 + corner} V6 H${6 + corner}"/><path d="M${W - 6 - corner} 6 H${W - 6} V${6 + corner}"/><path d="M${W - 6} ${H - 6 - corner} V${H - 6} H${W - 6 - corner}"/><path d="M${6 + corner} ${H - 6} H6 V${H - 6 - corner}"/></g>`);
    const tilt = m === 'handheld' ? ` transform="rotate(-2.2 ${W / 2} ${H / 2})"` : '';
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false" class="sk"><g${tilt}>${out.join('')}</g></svg>`;
  }

  MPH.sketch = sketch;
})();

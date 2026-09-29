/* MPH data layer: Supabase client, session and membership, AI calls, small query helpers.
   Every query runs as the signed-in user; the database's Row Level Security decides what comes back. */
(function () {
  const cfg = window.MPH_CONFIG;
  const configured = !/PLACEHOLDER/.test(cfg.supabaseUrl + cfg.supabaseKey);
  const sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  }) : null;
  MPH.sb = sb;

  const api = (MPH.api = { configured });

  /* session: { user, profile, orgs: [{ id, name, role }], org, clientProductions: [ids] } */
  MPH.session = null;

  api.loadSession = async () => {
    if (!sb) return null;
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { MPH.session = null; return null; }
    const user = session.user;
    const [{ data: profile }, { data: memberships }, { data: clientRows }] = await Promise.all([
      sb.from('profiles').select('*').eq('id', user.id).maybeSingle(),
      sb.from('org_members').select('role, org_id, orgs(id, name, name_ar, city)').eq('user_id', user.id),
      sb.from('production_members').select('production_id').eq('user_id', user.id).eq('role', 'client'),
    ]);
    const orgs = (memberships || []).filter((m) => m.orgs).map((m) => ({ ...m.orgs, role: m.role }));
    const org = orgs.find((o) => o.id === MPH.state.orgId) || orgs[0] || null;
    MPH.session = {
      user,
      profile: profile || { id: user.id, email: user.email, full_name: user.email },
      orgs, org,
      role: org?.role || null,
      clientProductions: (clientRows || []).map((r) => r.production_id),
    };
    return MPH.session;
  };

  api.signIn = (email, password) => sb.auth.signInWithPassword({ email, password });
  api.signUp = (email, password, fullName) => sb.auth.signUp({ email, password, options: { data: { full_name: fullName } } });
  api.signOut = () => sb.auth.signOut();
  api.resetPassword = (email) => sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname + '#account' });

  /* throw on Supabase errors so views can use try/catch */
  api.must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

  /* permissions for one production, from the session */
  api.accessFor = (prod) => {
    const s = MPH.session;
    if (!s || !prod) return { role: null, isTeam: false, isClient: false, canEdit: false, canSeeInternal: false };
    const org = s.orgs.find((o) => o.id === prod.org_id);
    const role = org?.role || (s.clientProductions.includes(prod.id) ? 'client' : null);
    return {
      role,
      isTeam: !!org,
      isClient: role === 'client',
      canEdit: ['owner', 'producer', 'hod'].includes(role),
      canSeeInternal: ['owner', 'producer'].includes(role),
    };
  };

  /* AI: POST to the "ai" Edge Function. Resolves with the JSON result or throws Error(message). */
  api.ai = async (action, payload) => {
    const { data, error } = await sb.functions.invoke('ai', { body: { action, ...payload } });
    if (error) {
      // turn gateway errors into something a producer can act on; prefer the function's own message when it sent one
      const status = error.context && error.context.status;
      let msg = {
        504: 'The AI took longer than the server allows for one request. Try again; long scripts are now read in parts.',
        546: 'The AI took longer than the server allows for one request. Try again; long scripts are now read in parts.',
        413: 'This file is too large to send in one go.',
        429: 'The AI is busy right now. Wait a minute and try again.',
        401: 'Your session has expired. Sign in again.',
      }[status] || (error.name === 'FunctionsFetchError' ? 'Couldn’t reach the AI service. Check your connection and try again.' : `The AI service returned an error${status ? ` (${status})` : ''}. Try again.`);
      let code = [504, 546].includes(status) ? 'too_slow' : null;
      try { const body = await error.context.clone().json(); if (body?.error) msg = body.error; if (body?.code) code = body.code; } catch (e) { /* not JSON */ }
      const ex = new Error(msg); ex.status = status; ex.code = code;
      throw ex;
    }
    return data;
  };

  /* file upload into the private "scripts" bucket under <production_id>/ */
  api.uploadScript = async (productionId, file) => {
    const safe = file.name.replace(/[^\w.\-]+/g, '_');
    const path = `${productionId}/${Date.now()}_${safe}`;
    api.must(await sb.storage.from('scripts').upload(path, file, { contentType: file.type || 'application/octet-stream' }));
    return path;
  };

  /* media (images and files) in the private "media" bucket.
     scope 'client'   → <pid>/client/<sub>/…   (a client may open it once the row that uses it is shared with them)
     scope 'internal' → <pid>/internal/<sub>/… (team only: receipts, internal documents, location photos) */
  api.uploadMedia = async (productionId, file, scope = 'internal', sub = 'files') => {
    if (!['client', 'internal'].includes(scope)) throw new Error('Unknown media scope');
    const safe = (file.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
    const path = `${productionId}/${scope}/${sub}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${safe}`;
    api.must(await sb.storage.from('media').upload(path, file, { contentType: file.type || 'application/octet-stream' }));
    return path;
  };
  const urlCache = new Map();
  /* a signed link valid for an hour, cached for 50 minutes */
  api.mediaUrl = async (path) => {
    if (!path) return null;
    const hit = urlCache.get(path);
    if (hit && hit.until > Date.now()) return hit.url;
    const { data, error } = await sb.storage.from('media').createSignedUrl(path, 3600);
    if (error) return null;
    urlCache.set(path, { url: data.signedUrl, until: Date.now() + 50 * 60 * 1000 });
    return data.signedUrl;
  };
  /* sign many paths in one request: returns { path: url } */
  api.mediaUrls = async (paths) => {
    const need = [...new Set(paths.filter(Boolean))].filter((p) => !(urlCache.get(p)?.until > Date.now()));
    if (need.length) {
      const { data } = await sb.storage.from('media').createSignedUrls(need, 3600);
      (data || []).forEach((d) => { if (d.signedUrl) urlCache.set(d.path, { url: d.signedUrl, until: Date.now() + 50 * 60 * 1000 }); });
    }
    return Object.fromEntries(paths.filter(Boolean).map((p) => [p, urlCache.get(p)?.url || null]));
  };
  api.removeMedia = async (paths) => { const list = [].concat(paths).filter(Boolean); if (list.length) await sb.storage.from('media').remove(list); };

  /* realtime-free "next number" helper for versions/sorts */
  api.nextVersion = async (table, productionId, column = 'version') => {
    const { data } = await sb.from(table).select(column).eq('production_id', productionId).order(column, { ascending: false }).limit(1);
    return ((data && data[0] && data[0][column]) || 0) + 1;
  };
})();

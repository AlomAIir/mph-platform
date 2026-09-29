# MPH Platform (Phase 1): build guide for view authors

This is the **real, working** platform, not the click-through demo (`C:\Claude\MPH`, which must stay untouched). Data lives in Supabase (Postgres + Auth + Storage) and the AI runs in a Supabase Edge Function that calls Claude. The front end reuses the demo's design system and conventions, but every screen reads and writes the real database.

Phase 1 scope: accounts and roles, productions, **Script → AI Breakdown → Shot List → Stripboard → Budget & Bid → Crew & Talent → Call Sheets** (shared with crew by link), and a client view enforced by the database.

## Layout
```
platform/
  docs/                  static site (GitHub Pages serves this folder)
    index.html           loads lucide, supabase-js UMD, then js/config → core → ui → api → views → app
    callsheet.html       public call sheet page (crew open it by link, no account)
    css/app.css          shared design system (copied from the demo, do not edit)
    css/platform.css     platform additions (lead owns)
    css/views/*.css      one stylesheet per builder (see below)
    js/config.js         Supabase URL + publishable key (public by design)
    js/core.js           MPH namespace, view registry, formatting (MPH.sar, MPH.date, MPH.time, MPH.eighths, MPH.hue…)
    js/ui.js             HTML helpers (MPH.ui): icon, av, pill, statusPill, CATEGORIES, catTag, prodThumb, stat, panel, empty, bar,
                         aiBadge, pageHead, lockNote, loading, spinner, errorBox, wa, waLink
    js/api.js            MPH.sb (supabase client), MPH.api: loadSession, accessFor, ai(action, payload), uploadScript, must, nextVersion
    js/app.js            router, auth screens, shell, phases, overlays (lead owns)
    js/views/*.js        one file per screen
  supabase/migrations/20260926194427_phase1_core.sql   THE schema. Read it fully before writing any query.
  supabase/functions/ai/index.ts                       AI actions: breakdown, shots, schedule, budget
```
Shared files (`index.html`, `app.css`, `platform.css`, `config.js`, `core.js`, `ui.js`, `api.js`, `app.js`, the migration, the AI function) are owned by the lead. If you need a change there, say so in your report.

## View contract (differs from the demo: async load)
```js
MPH.view('shotlist', {
  async load(ctx) { return { shots: ctx.api.must(await ctx.sb.from('shots').select('*').eq('production_id', ctx.production.id).order('sort')) }; },
  render(ctx, data) { return `<div class="page">…</div>`; },   // sync, returns HTML
  mount(root, ctx, data) { root.addEventListener('click', …); }, // root is a fresh element on every render
});
```
`ctx` = `{ route, params, production, role, isTeam, isClient, realClient, canEdit, canSeeInternal, go(hash), reload(), refreshAll(),
toast(msg, icon?), toastError(err), modal(html,{wide}), drawer(html), closeOverlay(), frame({title, sub, body, foot}), t, ui, esc, api, sb, state, session }`.
- `ctx.reload()` re-runs load + render for the current view (use it after writes). For quick inline edits, update the row and patch the DOM instead of reloading, so the user keeps focus.
- `ctx.isClient` is true for real client accounts **and** when a producer uses "Preview client view". `ctx.canSeeInternal` = owner/producer. `ctx.canEdit` = owner/producer/HoD. Hide edit controls when `!ctx.canEdit`.
- Errors: wrap writes in try/catch and call `ctx.toastError(err)`. `ctx.api.must({data, error})` throws on error.
- AI: `const out = await ctx.api.ai('breakdown', { production_id, script_id })`. It takes 20–90 seconds, so always show a clear running state (spinner plus copy like "Reading the script… this takes about a minute") and disable the button. On error, show the message.
- Icons: `ui.icon('lucide-name')`. After injecting HTML outside render, call `MPH.icons()`.
- ALWAYS escape data with `esc()`. Users type these strings.
- Routes: `#p.<productionId>.<module>[.<param>]`.

## Database rules you must respect (RLS enforces them anyway)
- Team (org members) can read everything in their productions; owner/producer/HoD can write; only owner/producer can touch `budget_lines`, `client_bids` and `production_members`.
- Clients can read `productions`, `scripts`, `scenes` and `client_bids` whose status isn't draft. Nothing else. They see only: Overview, Script (read only), Budget (= their bid).
- `budget_lines` is internal. The client bid (`client_bids.lines` jsonb `[{category, label, amount}]`, plus subtotal/vat/total) is a separate object created by "Send to client". **Never compute a client view from budget_lines in client mode.** Read `client_bids`.
- Call sheets: when published, write a full snapshot into `call_sheets.content` (everything the crew page needs: day, date, calls, location, schedule, cast and crew with call times, notes, contacts), **without rates or costs**. The public page reads it via `rpc('get_call_sheet', {p_token})` and records responses via `rpc('respond_call_sheet', {p_token, p_person, p_name, p_status})`.
- Scenes: `num` is text. Scheduling uses `scenes.shoot_day_id` + `scenes.day_sort`; unscheduled scenes have `shoot_day_id = null`.
- Elements: `category` must be one of the ids in `MPH.ui.CATEGORIES`; `status` is `suggested` or `accepted`; AI rows have `ai = true`, `confidence`, `source_quote` and `reason`.

## Design
Dark only. Use the design-system tokens and classes (see `css/app.css`): `.page .page-head .panel .card .btn(-primary/-outline/-ghost/-sm/-xs) .pill .chip .tag.cat-<id> .hl.cat-<id>(.suggested) .table .tabs .seg .field .input .select .textarea .toggle .callout .list .list-row .row .stack .grid-2/3/4 .split .kv .h1/.h2/.h3 .muted .small .mono .num .ar`, plus platform additions `.cell-input` (inline table editing), `.dropzone`, `.spin`. Match the click-through demo's screens for look and layout. Its source is in `C:\Claude\MPH\js\views\` (read only, for reference). Use logical CSS properties for RTL. Prefix new classes with your module prefix, in your own stylesheet only.
Copy: plain, specific, active voice. Buttons say exactly what happens. No lorem ipsum, no emoji. Real users will type real data, so design good empty states that tell them what to do first.

## Newer schema and helpers (read before building the new modules)
- Migrations: `supabase/migrations/*phase1_core.sql`, `*profile_onboarding.sql`, `*preprod_prod_modules.sql`. The last one adds treatments, lookbook_items,
  storyboard_frames, events, locations (+ shoot_days.location_id), attendance, day_logs, change_orders + change_order_costs (internal),
  receipts (internal), documents, rate_cards (per workspace, owners/producers only), productions.share_storyboard / share_calendar,
  RPCs decide_treatment / decide_change_order, and a private `media` storage bucket.
- Media: `await ctx.api.uploadMedia(pid, file, 'client'|'internal', 'lookbook')` → path; `await ctx.api.mediaUrls([paths])` → {path: signedUrl};
  `ctx.api.mediaUrl(path)`; `ctx.api.removeMedia(paths)`. Files a client may see MUST use scope 'client'; receipts/internal docs/location photos 'internal'.
- AI actions (all POST via `ctx.api.ai(action, {...})`, all need `production_id`):
  - `treatment` {brief?, sections?[]} → {title, sections:[{title, body}]}
  - `ratecard` {file_path (media bucket), text?} → {lines:[{category, item, unit, rate, who, notes}], job:{shoot_days,total,summary}}
  - `receipt` {file_path (media, image or PDF)} → {vendor, vat_number, receipt_date, currency, total, vat, lines[], budget_line_id, match_reason, readable}
  - `budget` {brief?, shoot_days?, client_location?, crew_level: 'lean'|'standard'|'premium'} (now uses the workspace rate card)
- Errors from `ctx.api.ai` carry `err.code` ('too_slow') and `err.status`.
- Scenes: always read `active_scenes` (latest broken-down script version), never `scenes`, for anything except writes.
- Workspace id for rate cards: `ctx.production.org_id`.
- Client-visible modules: overview, treatment, script, storyboard (only when productions.share_storyboard), calendar (non-internal events,
  when share_calendar), budget (bid + sent change orders), docs (client_shared only). Always check `ctx.isClient` and never query internal tables then.

## Testing
**Signed-in session for testing:** the browser pane is signed in to a test account whose profile hasn't finished onboarding, so the app shows the
"Tell us about you" screen. Don't complete it. Instead, in your own tab run `await MPH.api.loadSession(); MPH.session.profile.onboarded_at = 'test'; MPH.render();`
(in memory only; no database change) to reach the real app with real data. Create test data ONLY in a production whose title starts with
"Test · " and delete it (and any media you uploaded) when done. Never touch other productions. AI calls cost real money: keep them few.

The site is served at **http://localhost:5173/platform/docs/** (the already-running preview server serves C:\Claude\MPH, so the platform lives under /platform/docs/). You can only test against the live database once the lead has connected it and the user has signed in in the browser pane. Open your OWN tab (`mcp__Claude_Browser__tabs_create`) and pass its tabId to every browser call. You share the user's signed-in session, and **anything you create is real data in the user's project**: put test data only in a production named "Test · <your module>", and delete it when you're done. Never delete or edit anything else. Until then, check syntax with `node --check <file>` (Node is at `C:\Program Files\nodejs`) and self-review carefully.

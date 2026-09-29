// MPH AI service (Supabase Edge Function).
// Every request runs as the signed-in user: data is read through their own Supabase session,
// so Row Level Security decides what the AI can see. The Anthropic key lives only in this
// function's secrets (ANTHROPIC_API_KEY), never in the browser.
//
// POST { action: "breakdown" | "shots" | "schedule" | "budget", ...params }
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5";
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ------------------------------------------------------------------ Claude call with structured JSON output
async function askJSON<T>(opts: {
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[] | string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  timeoutMs?: number;
}): Promise<T> {
  const stream = anthropic.beta.messages.stream({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: opts.effort ?? "medium", format: { type: "json_schema", schema: opts.schema } },
    // If a safety classifier declines, re-run on Anthropic's recommended fallback model instead of failing.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: opts.system,
    messages: [{ role: "user", content: opts.content }],
    // deno-lint-ignore no-explicit-any
  } as any, {
    // finish before the platform's 150 s wall clock, so the caller gets a clear "too slow" instead of a dropped request
    timeout: opts.timeoutMs ?? 130_000,
    maxRetries: 0,
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new HttpError(422, "The AI declined to process this content.");
  if (msg.stop_reason === "max_tokens") throw new HttpError(422, "The script is too long to process in one pass. Split it into parts and try again.");
  const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(502, "The AI returned an unreadable answer. Try again.");
  }
}

// strict JSON-schema helper: every property required, no extras
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const arr = (items: unknown) => ({ type: "array", items });

const CATEGORIES = ["cast", "extras", "props", "wardrobe", "makeup", "vehicles", "location", "sfx", "equipment", "animals", "sound", "vfx", "stunts"];

// ------------------------------------------------------------------ actions
/* Long scripts are broken down in parts so each call stays inside the server's time limit. The browser splits the
   document and sends one part per call: either `file_path` (a page range saved as its own PDF under the production's
   folder) or `text` (a slice of the script text), with `part`/`parts`/`pages` describing where it sits. */
async function breakdown(db: SupabaseClient, p: { production_id: string; script_id: string; file_path?: string; text?: string; part?: number; parts?: number; pages?: string }) {
  const { data: script, error } = await db.from("scripts").select("*").eq("id", p.script_id).eq("production_id", p.production_id).single();
  if (error || !script) throw new HttpError(404, "Script not found, or you don't have access to it.");
  if (p.file_path && !p.file_path.startsWith(`${p.production_id}/`)) throw new HttpError(400, "That file doesn't belong to this production.");
  if (p.text && p.text.length > 80000) throw new HttpError(413, "This part of the script is too long. Split it into smaller parts.");
  const filePath = p.file_path || (script.source_type === "pdf" ? script.file_path : null);

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (p.text?.trim()) {
    content.push({ type: "text", text: `<script>\n${p.text}\n</script>` });
  } else if (filePath) {
    const { data: file, error: dlErr } = await db.storage.from("scripts").download(filePath);
    if (dlErr || !file) throw new HttpError(404, "The script file could not be read from storage.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: btoa(bin) } });
  } else if (script.raw_text?.trim()) {
    content.push({ type: "text", text: `<script>\n${script.raw_text}\n</script>` });
  } else {
    throw new HttpError(400, "This script has no text or file to read.");
  }
  const multi = (p.parts ?? 1) > 1;
  content.push({
    type: "text",
    text: multi
      ? `This is part ${p.part} of ${p.parts} of a longer document${p.pages ? ` (pages ${p.pages})` : ""}. Break down only what is in this part, numbering scenes from 1 within it. If the part starts in the middle of a scene that began in the previous part, include it as the first scene with the same heading followed by " (cont.)". Set runtime_seconds to 0 unless this part states the spot's runtime.`
      : "Break down this script.",
  });

  const schema = obj({
    language: { type: "string", enum: ["ar", "en", "ar+en"] },
    runtime_seconds: int,
    notes: str,
    scenes: arr(obj({
      num: str,
      heading: str,
      int_ext: { type: "string", enum: ["INT", "EXT", "INT/EXT"] },
      day_night: { type: "string", enum: ["Day", "Night", "Dawn", "Dusk", "Golden hour"] },
      location: str,
      synopsis: str,
      text: str,
      pages_eighths: int,
      est_minutes: int,
      elements: arr(obj({
        category: { type: "string", enum: CATEGORIES },
        name: str,
        qty: int,
        confidence: num,
        source_quote: str,
        reason: str,
      })),
    })),
  });

  const system = `You are the first assistant director and production manager on a Saudi commercial (TVC, digital, branded content). You break scripts down for scheduling and budgeting.

Scripts may be in Arabic, English or both, and may be screenplay format or two-column AV format (VIDEO | AUDIO). Read Arabic dialogue and Gulf/Najdi dialect naturally; keep Arabic text in Arabic.

For each scene:
- num: the scene number as written, or "1", "2"… in order if unnumbered.
- heading: a standard slugline in English capitals, e.g. "EXT. AT-TURAIF, DIRIYAH – GOLDEN HOUR".
- text: the scene's script text verbatim, in its original language(s), video and audio lines flattened in reading order with line breaks.
- synopsis: one short English sentence.
- pages_eighths: length in eighths of a page (1 = 1/8). est_minutes: realistic shooting time for a commercial crew.
- elements: everything a department must prepare. Categories: cast (speaking/featured roles), extras (background, give qty), props, wardrobe, makeup (hair & makeup), vehicles (incl. picture and camera cars), location, sfx (practical effects), equipment (special: drones, cranes, car rigs, generators), animals, sound (music, VO, playback), vfx (supers, graphics, screen replacements), stunts.
- source_quote: the exact words in "text" that justify the element (copy them exactly so they can be highlighted), or "" if the element is implied rather than written.
- confidence: 0–1. Use below 0.7 for anything implied or inferred, and say why in "reason".
Include implied needs a producer would want flagged (e.g. a generator for a night exterior with no power, a child-performer guardian), marked with low confidence.
runtime_seconds: the spot's runtime if timecodes or durations are given, else your estimate.
notes: one or two sentences on anything the producer should check (e.g. permits, child performers, night drone use).`;

  // parts of long documents use lighter thinking so each one returns well inside the time limit
  const out = await askJSON<{ scenes: unknown[] }>({ system, content, schema, effort: multi ? "low" : "medium", maxTokens: 64000 });
  return out;
}

async function shots(db: SupabaseClient, p: { production_id: string; scene_id: string }) {
  const { data: scene } = await db.from("scenes").select("num, heading, synopsis, body, day_night, location").eq("id", p.scene_id).eq("production_id", p.production_id).single();
  if (!scene) throw new HttpError(404, "Scene not found.");
  const { data: els } = await db.from("elements").select("category, name").eq("scene_id", p.scene_id).eq("status", "accepted");

  const schema = obj({
    shots: arr(obj({
      size: { type: "string", enum: ["EWS", "WS", "MWS", "MS", "MCU", "CU", "ECU", "Insert", "OTS", "POV", "Two-shot"] },
      angle: { type: "string", enum: ["Eye level", "High", "Low", "Overhead", "Aerial", "Dutch"] },
      movement: { type: "string", enum: ["Static", "Pan", "Tilt", "Dolly", "Tracking", "Crane", "Drone", "Handheld", "Gimbal", "Car mount", "Push in", "Pull out"] },
      lens: str,
      description: str,
      subject: str,
      setup: int,
      est_minutes: int,
    })),
    notes: str,
  });
  return await askJSON({
    system: "You are a commercial director of photography planning coverage for a Saudi TVC. Propose a practical shot list for the scene: enough coverage for the edit, grouped into camera setups (same setup number = same lighting/camera position), with realistic time estimates. Descriptions in English, short and specific. Lens as focal length, e.g. \"32mm\".",
    content: `Scene ${scene.num}: ${scene.heading}\nTime of day: ${scene.day_night}\nLocation: ${scene.location}\nSynopsis: ${scene.synopsis}\n\nScript:\n${scene.body}\n\nConfirmed elements: ${(els ?? []).map((e) => `${e.category}: ${e.name}`).join("; ") || "none yet"}`,
    schema,
    effort: "low",
    maxTokens: 16000,
  });
}

async function schedule(db: SupabaseClient, p: { production_id: string; days?: number }) {
  const { data: scenes } = await db.from("active_scenes").select("id, num, heading, int_ext, day_night, location, est_minutes, pages_eighths").eq("production_id", p.production_id).order("sort");
  if (!scenes?.length) throw new HttpError(400, "Run the breakdown first so there are scenes to schedule.");
  const { data: days } = await db.from("shoot_days").select("day_no, date, location, crew_call").eq("production_id", p.production_id).order("day_no");
  const { data: cast } = await db.from("elements").select("scene_id, name").eq("production_id", p.production_id).eq("category", "cast");
  const castBy: Record<string, string[]> = {};
  (cast ?? []).forEach((c) => { (castBy[c.scene_id] ??= []).push(c.name); });

  const schema = obj({
    days: arr(obj({ day_no: int, scene_ids: arr(str), rationale: str })),
    unscheduled_scene_ids: arr(str),
    notes: str,
  });
  const dayCount = days?.length || p.days || Math.max(1, Math.ceil(scenes.reduce((s, x) => s + (x.est_minutes || 60), 0) / 600));
  return await askJSON({
    system: "You are a first AD scheduling a Saudi commercial shoot. Group scenes into shoot days to minimise company moves and cast days, respect daylight (dawn/golden hour/night scenes need the right time), keep crew days under 12 hours including moves, and allow 10-hour turnaround between days. Child performers: keep their hours short and avoid late nights. Use only the scene ids given.",
    content: `Shoot days available: ${dayCount}\n${(days ?? []).map((d) => `Day ${d.day_no}: ${d.date ?? "date TBC"} ${d.location ?? ""} call ${d.crew_call ?? "TBC"}`).join("\n")}\n\nScenes:\n${scenes.map((s) => `${s.id} | Sc ${s.num} | ${s.heading} | ${s.int_ext} ${s.day_night} | ${s.location} | ${s.est_minutes} min | cast: ${(castBy[s.id] ?? []).join(", ") || "none"}`).join("\n")}`,
    schema,
    effort: "medium",
    maxTokens: 16000,
  });
}

/* read a file from storage as a Claude content block (PDF document or image) */
async function fileBlock(db: SupabaseClient, bucket: string, path: string): Promise<Anthropic.Beta.BetaContentBlockParam> {
  const { data: file, error } = await db.storage.from(bucket).download(path);
  if (error || !file) throw new HttpError(404, "The file could not be read from storage.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > 20 * 1024 * 1024) throw new HttpError(413, "This file is larger than 20 MB.");
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const data = btoa(bin);
  const type = (file.type || "").toLowerCase();
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (type === "application/pdf" || ext === "pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  const img = type.startsWith("image/") ? type : ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[ext];
  if (!img) throw new HttpError(415, "Upload a PDF or a photo (JPG, PNG or WebP).");
  return { type: "image", source: { type: "base64", media_type: img as "image/jpeg", data } };
}
const ownPath = (prod: string, path?: string) => { if (path && !path.startsWith(`${prod}/`)) throw new HttpError(400, "That file doesn't belong to this production."); return path; };

const CATEGORY_GUIDE = "A Pre-production & wrap, B Shooting crew, C Talent & usage, D Locations & permits, E Equipment, F Art & wardrobe, G Transport & catering, H Post-production, I Insurance & contingency, J Production fee";

/* past budget → rate card lines. Source: a file in the media bucket, or pasted text. */
async function ratecard(db: SupabaseClient, p: { production_id: string; file_path?: string; bucket?: string; text?: string }) {
  const { data: allowed } = await db.rpc("can_see_internal", { p_prod: p.production_id });
  if (!allowed) throw new HttpError(403, "Only owners and producers can build a rate card.");
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (p.file_path) content.push(await fileBlock(db, p.bucket === "scripts" ? "scripts" : "media", ownPath(p.production_id, p.file_path)!));
  else if (p.text?.trim()) content.push({ type: "text", text: `<budget>\n${p.text.slice(0, 60000)}\n</budget>` });
  else throw new HttpError(400, "Upload a past budget or paste it as text.");
  content.push({ type: "text", text: "Extract the rate card from this budget." });
  const schema = obj({
    lines: arr(obj({
      category: { type: "string", enum: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] },
      item: str, unit: { type: "string", enum: ["day", "flat", "head", "hour", "week", "item"] },
      rate: num, who: str, notes: str,
    })),
    job: obj({ shoot_days: int, total: num, summary: str }),
  });
  return await askJSON({
    system: `You turn a Saudi production house's real budget into a reusable rate card. For every line with a price, give the unit rate (not the line total: divide by quantity), the unit, who supplied it if named, and a short note (e.g. "package: includes all lighting and grip equipment", "client's own location, no fee", "fixed fee for the whole job"). Keep packages as one line; don't split them. Map each line to a commercial bid category: ${CATEGORY_GUIDE}. Rates in SAR, excluding VAT. Also summarise the job: shoot days, total and what kind of production it was.`,
    content, schema, effort: "low", maxTokens: 16000,
  });
}

/* receipt photo → vendor, VAT number, lines, total; suggest the budget line it belongs to */
async function receipt(db: SupabaseClient, p: { production_id: string; file_path: string }) {
  const block = await fileBlock(db, "media", ownPath(p.production_id, p.file_path)!);
  const { data: lines } = await db.from("budget_lines").select("id, category, code, description").eq("production_id", p.production_id).order("sort");
  const schema = obj({
    vendor: str, vat_number: str, receipt_date: str, currency: str, total: num, vat: num,
    lines: arr(obj({ description: str, amount: num })),
    budget_line_id: str, match_reason: str, readable: { type: "boolean" },
  });
  return await askJSON({
    system: "You read receipts and tax invoices photographed on a Saudi film set (Arabic or English). Extract the vendor, VAT registration number (15 digits, starts with 3), date as YYYY-MM-DD, each line and the totals in SAR. Then choose the budget line it most likely belongs to from the list, using its id, or \"\" if none fits. If the image isn't a readable receipt, set readable to false.",
    content: [block, { type: "text", text: `Budget lines:\n${(lines ?? []).map((l) => `${l.id} | ${l.category} ${l.code ?? ""} ${l.description}`).join("\n") || "(no budget lines yet)"}` }],
    schema, effort: "low", maxTokens: 8000,
  });
}

/* draft a director's treatment from the script and a short brief */
async function treatment(db: SupabaseClient, p: { production_id: string; brief?: string; sections?: string[] }) {
  const { data: prod } = await db.from("productions").select("title, client_name, format, summary").eq("id", p.production_id).single();
  const { data: scenes } = await db.from("active_scenes").select("num, heading, synopsis, body").eq("production_id", p.production_id).order("sort");
  const wanted = (p.sections?.length ? p.sections : ["Vision", "Story", "Look & light", "Casting", "Locations", "Wardrobe & art", "Sound & music"]).slice(0, 10);
  const schema = obj({ title: str, sections: arr(obj({ title: str, body: str })) });
  return await askJSON({
    system: "You are a commercial director writing a treatment for a client. Warm, visual, concise: two to four short paragraphs per section, concrete images rather than adjectives, no budget talk. Write in the language of the script (Arabic, English or both, following its lead).",
    content: `Production: ${prod?.title ?? ""} for ${prod?.client_name ?? "the client"} · ${prod?.format ?? ""}\n${prod?.summary ? `Summary: ${prod.summary}\n` : ""}${p.brief ? `Director's notes: ${p.brief}\n` : ""}Write these sections: ${wanted.join(", ")}.\n\nScript:\n${(scenes ?? []).map((s) => `Sc ${s.num} ${s.heading}\n${s.body ?? s.synopsis ?? ""}`).join("\n\n").slice(0, 60000) || "(no script breakdown yet: work from the summary and notes)"}`,
    schema, effort: "medium", maxTokens: 16000,
  });
}

async function budget(db: SupabaseClient, p: { production_id: string; brief?: string; shoot_days?: number; client_location?: boolean; crew_level?: string }) {
  const { data: allowed } = await db.rpc("can_see_internal", { p_prod: p.production_id });
  if (!allowed) throw new HttpError(403, "Only owners and producers can draft budgets.");
  const { data: prod } = await db.from("productions").select("org_id, title, format, client_name, shoot_start, shoot_end").eq("id", p.production_id).single();
  const { data: rates } = await db.from("rate_cards").select("category, item, unit, rate, who, notes, source").eq("org_id", prod?.org_id ?? "").order("category");
  const { data: scenes } = await db.from("active_scenes").select("num, heading, day_night, location").eq("production_id", p.production_id).order("sort");
  const { data: els } = await db.from("elements").select("category, name, qty").eq("production_id", p.production_id).eq("status", "accepted");
  const { data: days } = await db.from("shoot_days").select("day_no").eq("production_id", p.production_id);
  const { data: peopleRows } = await db.from("people").select("role, dept, days, kind, people_rates(day_rate)").eq("production_id", p.production_id);
  // deno-lint-ignore no-explicit-any
  const people = (peopleRows ?? []).map((x: any) => ({ ...x, day_rate: x.people_rates?.day_rate ?? null }));

  const schema = obj({
    lines: arr(obj({
      category: { type: "string", enum: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] },
      description: str,
      qty: num,
      unit: { type: "string", enum: ["day", "flat", "head", "hour", "week", "item"] },
      unit_cost: num,
      markup_pct: num,
      notes: str,
    })),
    assumptions: arr(str),
  });
  const shootDays = p.shoot_days || days?.length || null;
  const level = ["lean", "standard", "premium"].includes(p.crew_level ?? "") ? p.crew_level : "lean";
  return await askJSON({
    system: `You are the line producer of a Saudi production house drafting the INTERNAL cost of a job in SAR (exclude VAT). Budget the way Riyadh houses actually do, not like an international agency bid:
- Use the house RATE CARD first, at its rates and in its structure. Only estimate items the rate card doesn't cover, and say so in notes ("estimate").
- Buy packages where the house does: e.g. gaffer + key grip + camera/light assistants + all lighting, grip and camera equipment as ONE line. Don't itemise equipment separately when a package covers it.
- Key creatives (producer, director, DoP, AD) are usually one fixed fee for the whole job (unit "flat"), not day rates.
- Cast is often one package through a cast manager.
- Budget exactly the shoot days given. Don't add days, locations, departments or crew the script doesn't need.
- If the client provides the location, locations cost 0 (keep one line "Client location" at 0).
- Crew level "${level}": lean = the smallest crew that can deliver (most corporate and digital work), standard = a normal TVC crew, premium = a large broadcast TVC.
- No padding: no separate insurance, contingency or catering lines unless the rate card or the job clearly needs them. Petty cash for production and props is one line.
- Scale check: a lean one-day corporate or digital shoot in Riyadh typically costs SAR 80,000–150,000 internally; a standard two- to three-day TVC SAR 250,000–600,000. If you land far outside the band for this job, re-check.
Categories: ${CATEGORY_GUIDE}. unit_cost is the internal cost per unit. markup_pct is the house markup for the client price (default 20%; 0 for J Production fee). Put each assumption in "assumptions", starting with the shoot days and crew level you used.`,
    content: `Production: ${prod?.title} · ${prod?.format ?? ""} · client ${prod?.client_name ?? ""} · shoot ${prod?.shoot_start ?? "TBC"} to ${prod?.shoot_end ?? "TBC"}
Shoot days: ${shootDays ?? "not set: assume 1 unless the script clearly needs more, and say so"}
Location: ${p.client_location ? "provided by the client (no location fee)" : "to be sourced"}
Crew level: ${level}
${p.brief ? `Producer notes: ${p.brief}\n` : ""}
House rate card (${rates?.length ?? 0} lines):
${(rates ?? []).map((r) => `${r.category} | ${r.item} | SAR ${r.rate} per ${r.unit}${r.who ? ` | ${r.who}` : ""}${r.notes ? ` | ${r.notes}` : ""}`).join("\n") || "(empty: use lean Riyadh rates and say every line is an estimate)"}

Scenes:
${(scenes ?? []).map((s) => `Sc ${s.num} ${s.heading} (${s.day_night}, ${s.location})`).join("\n") || "(no breakdown yet)"}

Confirmed elements:
${(els ?? []).map((e) => `${e.category}: ${e.name}${e.qty > 1 ? ` ×${e.qty}` : ""}`).join("\n") || "(none yet)"}

Team on the job:
${(people ?? []).map((x) => `${x.role} (${x.dept ?? x.kind})${x.day_rate ? ` SAR ${x.day_rate}/day` : ""}${x.days ? ` × ${x.days} days` : ""}`).join("\n") || "not entered yet"}`,
    schema,
    effort: "medium",
    maxTokens: 24000,
  });
}

// ------------------------------------------------------------------ entry
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) throw new HttpError(401, "Sign in to use the AI.");
    // the caller's own session: RLS applies to every read below
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    });
    const { data: { user } } = await db.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
    if (!user) throw new HttpError(401, "Your session has expired. Sign in again.");
    if (!Deno.env.get("ANTHROPIC_API_KEY")) throw new HttpError(503, "The AI isn't configured yet: the ANTHROPIC_API_KEY secret is missing.");

    const body = await req.json();
    if (!body?.production_id) throw new HttpError(400, "production_id is required.");
    const { data: canRead } = await db.rpc("is_team", { p_prod: body.production_id });
    if (!canRead) throw new HttpError(403, "Only the production team can use the AI on this production.");

    switch (body.action) {
      case "breakdown": return json(await breakdown(db, body));
      case "shots": return json(await shots(db, body));
      case "schedule": return json(await schedule(db, body));
      case "budget": return json(await budget(db, body));
      case "ratecard": return json(await ratecard(db, body));
      case "receipt": return json(await receipt(db, body));
      case "treatment": return json(await treatment(db, body));
      default: throw new HttpError(400, `Unknown action: ${body.action}`);
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      return json({ error: "This part took the AI too long to read.", code: "too_slow" }, 504);
    }
    if (err instanceof Anthropic.RateLimitError) return json({ error: "The AI is busy. Try again in a minute." }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "The AI key is invalid. Check the ANTHROPIC_API_KEY secret." }, 503);
    if (err instanceof Anthropic.APIError) return json({ error: `AI service error (${err.status ?? "network"}). Try again.` }, 502);
    console.error(err);
    return json({ error: "Something went wrong on the server." }, 500);
  }
});

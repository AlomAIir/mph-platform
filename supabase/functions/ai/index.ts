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
  } as any);
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
async function breakdown(db: SupabaseClient, p: { production_id: string; script_id: string }) {
  const { data: script, error } = await db.from("scripts").select("*").eq("id", p.script_id).eq("production_id", p.production_id).single();
  if (error || !script) throw new HttpError(404, "Script not found, or you don't have access to it.");

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (script.file_path && script.source_type === "pdf") {
    const { data: file, error: dlErr } = await db.storage.from("scripts").download(script.file_path);
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
  content.push({ type: "text", text: "Break down this script." });

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

  const out = await askJSON<{ scenes: unknown[] }>({ system, content, schema, effort: "medium", maxTokens: 64000 });
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

async function budget(db: SupabaseClient, p: { production_id: string; brief?: string }) {
  const { data: allowed } = await db.rpc("can_see_internal", { p_prod: p.production_id });
  if (!allowed) throw new HttpError(403, "Only owners and producers can draft budgets.");
  const { data: prod } = await db.from("productions").select("title, format, client_name, shoot_start, shoot_end").eq("id", p.production_id).single();
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
  return await askJSON({
    system: `You are a Saudi commercial line producer drafting an internal cost budget in SAR (exclude VAT). Use commercial bid categories:
A Pre-production & wrap, B Shooting crew, C Talent & usage, D Locations & permits, E Equipment, F Art & wardrobe, G Transport & catering, H Post-production, I Insurance & contingency, J Production fee.
Use Riyadh market rates for 2026. Where the team list gives a day rate, use it. unit_cost is internal cost per unit; markup_pct is the markup applied for the client price (typically 15–25%, 0 for the production fee line which is already a client-facing figure). Keep lines specific (one role or item per line), realistic and complete for the breakdown given. List your key assumptions.`,
    content: `Production: ${prod?.title} · ${prod?.format ?? ""} · client ${prod?.client_name ?? ""} · shoot ${prod?.shoot_start ?? "TBC"} to ${prod?.shoot_end ?? "TBC"}\nShoot days: ${days?.length || "TBC"}\n${p.brief ? `Producer notes: ${p.brief}\n` : ""}\nScenes:\n${(scenes ?? []).map((s) => `Sc ${s.num} ${s.heading} (${s.day_night}, ${s.location})`).join("\n")}\n\nConfirmed elements:\n${(els ?? []).map((e) => `${e.category}: ${e.name}${e.qty > 1 ? ` ×${e.qty}` : ""}`).join("\n")}\n\nTeam on the job:\n${(people ?? []).map((x) => `${x.role} (${x.dept ?? x.kind})${x.day_rate ? ` SAR ${x.day_rate}/day` : ""}${x.days ? ` × ${x.days} days` : ""}`).join("\n") || "not entered yet"}`,
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
      default: throw new HttpError(400, `Unknown action: ${body.action}`);
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "The AI is busy. Try again in a minute." }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "The AI key is invalid. Check the ANTHROPIC_API_KEY secret." }, 503);
    if (err instanceof Anthropic.APIError) return json({ error: `AI service error (${err.status ?? "network"}). Try again.` }, 502);
    console.error(err);
    return json({ error: "Something went wrong on the server." }, 500);
  }
});

import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// ------- tiny CORS allowlist for local dev -------
const ALLOW_ORIGINS = new Set([
  "http://localhost:3000",  // add prod origin later
]);

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOW_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

// ------- load mlbrules.json at cold start -------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RULES_PATH = path.join(__dirname, "data", "mlbrules.json");

let RULES = [];      // normalized array of rule objects
let LOADED = false;
let LOAD_ERROR = null;

async function loadRulesOnce() {
  if (LOADED || LOAD_ERROR) return;
  try {
    const raw = await readFile(RULES_PATH, "utf-8");
    const json = JSON.parse(raw);

    // Accept array or object-of-objects
    const arr = Array.isArray(json) ? json : (
      Array.isArray(json.rules) ? json.rules :
      (json.rules ? Object.values(json.rules) : Object.values(json))
    );

    RULES = (arr || []).filter(Boolean);

    LOADED = true;
    logger.info("mlbrules.json loaded", { count: RULES.length });
  } catch (err) {
    LOAD_ERROR = String(err);
    logger.error("Failed to load mlbrules.json", { error: LOAD_ERROR });
  }
}

// ------- helpers to read unknown schemas safely -------
function getTitle(r) {
  return r.title ?? r.heading ?? r.name ?? null;
}
function getCitation(r) {
  return r.citation ?? r.rule ?? r.rule_id ?? r.section ?? r.number ?? null;
}
function getContent(r) {
  return r.content ?? r.text ?? r.body ?? r.description ?? "";
}
function getId(r) {
  return r.id ?? r.rule_id ?? r.citation ?? null;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function scoreRule(rule, terms) {
  const hayTitle = (getTitle(rule) || "").toLowerCase();
  const hayBody  = (getContent(rule) || "").toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (!t) continue;
    const rx = new RegExp(`\\b${escapeRegex(t)}\\b`, "g");
    score += (hayTitle.match(rx)?.length || 0) * 3;
    score += (hayBody.match(rx)?.length || 0);
  }
  return score;
}

function makeExcerpt(text, terms, maxLen = 220) {
  if (!text) return "";
  const lower = text.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0) { idx = i; break; }
  }
  if (idx < 0) idx = 0;
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, start + maxLen);
  const chunk = text.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "… " : "") + chunk + (end < text.length ? " …" : "");
}

// ------- main handler -------
export const rulebook = onRequest({ region: "us-central1", invoker: "public" }, async (req, res) => {
  if (setCors(req, res)) return;

  await loadRulesOnce();
  if (LOAD_ERROR) {
    return res.status(500).json({ ok: false, error: "Rules failed to load", detail: LOAD_ERROR });
  }

  // No query -> return health + schema preview to help you verify fields
  const q = (req.query.q || req.body?.q || "").toString().trim();
  if (!q) {
    const preview = (RULES[0] ? Object.keys(RULES[0]).slice(0, 20) : []);
    return res.status(200).json({
      ok: true,
      message: "RefflyAI rulebook is live. Pass ?q=your+question or POST {q}.",
      rules_loaded: RULES.length,
      first_item_keys: preview,   // quick peek at your schema
      example: "curl \"<FUNCTION_URL>?q=What%20is%20interference?\""
    });
  }

  const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);

  const scored = RULES
    .map((r, idx) => ({ r, s: scoreRule(r, terms), idx }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5);

  const results = scored.map(({ r, s }) => ({
    id: getId(r),
    title: getTitle(r),
    citation: getCitation(r),
    score: s,
    excerpt: makeExcerpt(getContent(r), terms),
  }));

  return res.status(200).json({
    ok: true,
    query: q,
    hits: results.length,
    results
  });
});

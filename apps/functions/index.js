/* apps/functions/index.js  (ESM, Node 20, 2nd-gen Functions)
 * RefflyAI — MLB Rulebook Search
 * - GET/POST /rulebook?q=... with ?limit & ?offset; &highlight=1
 * - Friendlier titles & consistent citations
 * - Lightweight synonyms
 * - CORS: OPEN (Access-Control-Allow-Origin: *) for quick unblock
 * - Structured logs
 * - No template literals (avoids CI masking quirks)
 */

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// --- ESM __dirname shim ----------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ----------------------------------------------------------------
const REGION = "us-central1";

// --- Synonyms (starter) ----------------------------------------------------
const SYNONYMS = {
  "offensive interference": ["batter’s interference", "batter interference"],
  "batter interference": ["offensive interference", "batter’s interference"],
  "balks": ["balk"],
  "tag up": ["retouch", "time play"],
  "obstruction": ["fielder obstruction"],
  "infield fly": ["ifr", "infield fly rule"],
};

// --- Load rulebook JSON once per instance ---------------------------------
const RULES_PATH = path.join(__dirname, "data", "mlbrules.json");

let RULES = [];
let FIELD_KEYS = [];

try {
  const raw = fs.readFileSync(RULES_PATH, "utf8");
  RULES = JSON.parse(raw);
  FIELD_KEYS = RULES.length ? Object.keys(RULES[0]) : [];
  logger.info("rulebook_loaded", { count: RULES.length });
} catch (err) {
  logger.error("rulebook_load_failed", { error: String(err) });
  RULES = [];
  FIELD_KEYS = [];
}

// --- Helpers ---------------------------------------------------------------
function clean(s) {
  return (s || "").toString().replace(/\s+/g, " ").replace(/[^\S\r\n]+/g, " ").trim();
}
function lc(s) {
  return (s || "").toString().toLowerCase();
}
function buildTitle(rule) {
  const parts = [];
  if (rule.parentRule) parts.push(clean(rule.parentRule));
  if (rule.title) parts.push(clean(rule.title));
  if (rule.subsection) parts.push(clean(rule.subsection));
  if (!parts.length && rule.subtitle) parts.push(clean(rule.subtitle));
  const joined = parts.join(" — ");
  return joined || clean(rule.subtitle) || "Rule";
}
function getCitation(rule) {
  const candidates = [rule.citation, rule.citation1, rule.rule_id, rule.ruleId, rule.id].map(clean);
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i]) return candidates[i];
  }
  return "";
}
function expandQueryWithSynonyms(q) {
  const terms = [q];
  const base = lc(q);
  Object.keys(SYNONYMS).forEach(function (key) {
    if (base.indexOf(key) !== -1) {
      SYNONYMS[key].forEach(function (alt) {
        if (terms.indexOf(alt) === -1) terms.push(alt);
      });
    }
  });
  const uniq = [];
  for (let i = 0; i < terms.length; i++) if (uniq.indexOf(terms[i]) === -1) uniq.push(terms[i]);
  return uniq;
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function safeWordRegex(term) { try { return new RegExp("\\b" + escapeRegExp(term) + "\\b", "i"); } catch { return null; } }
function scoreRule(rule, queries) {
  const fields = { title: 3, subtitle: 2, content: 4, references: 1, parentRule: 2, subsection: 2 };
  let score = 0;
  const blob = {};
  Object.keys(fields).forEach(function (f) { blob[f] = lc(clean(rule[f])); });
  for (let qi = 0; qi < queries.length; qi++) {
    const term = lc(queries[qi]);
    const termRe = safeWordRegex(term);
    Object.keys(fields).forEach(function (f) {
      const wt = fields[f]; const hay = blob[f] || "";
      if (!hay) return;
      if (termRe && termRe.test(hay)) score += 5 * wt;
      if (hay.indexOf(term) >= 0) score += 1 * wt;
    });
    if (blob.content && blob.content.indexOf(term) !== -1) score += 3;
  }
  return score;
}
function makeExcerpt(text, queries, maxLen) {
  const MAX = maxLen || 220;
  const t = clean(text);
  if (!t) return "";
  const base = lc(t);
  let foundAt = -1;
  for (let i = 0; i < queries.length; i++) {
    const q = lc(queries[i]); const idx = base.indexOf(q);
    if (idx !== -1 && (foundAt === -1 || idx < foundAt)) foundAt = idx;
  }
  if (foundAt === -1) return t.length <= MAX ? t : t.slice(0, MAX - 1).trimEnd() + "…";
  const PAD = Math.floor(MAX / 2);
  const start = Math.max(0, foundAt - PAD);
  const end = Math.min(t.length, start + MAX);
  const snippet = t.slice(start, end).trim();
  return (start > 0 ? "… " : "") + snippet + (end < t.length ? " …" : "");
}
function highlight(text, queries) {
  if (!text) return "";
  let out = text; const seen = {};
  for (let i = 0; i < queries.length; i++) {
    const term = (queries[i] || "").trim(); if (!term || seen[term]) continue; seen[term] = true;
    try { const re = new RegExp("(" + escapeRegExp(term) + ")", "gi"); out = out.replace(re, "«$1»"); } catch {}
  }
  return out;
}
function parseBool(v, def) { if (v == null) return !!def; const s = String(v).toLowerCase(); return s === "1" || s === "true" || s === "yes"; }
function parseIntSafe(v, def) { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : def; }

// --- Core search -----------------------------------------------------------
function searchRules(opts) {
  const q = opts.q;
  const limit = opts.limit || 5;
  const offset = opts.offset || 0;
  const doHighlight = !!opts.doHighlight;

  const rawQuery = clean(q || "");
  if (!rawQuery) return { hits: 0, results: [] };

  const queries = expandQueryWithSynonyms(rawQuery);

  const scored = [];
  for (let i = 0; i < RULES.length; i++) {
    const r = RULES[i];
    const s = scoreRule(r, queries);
    if (s > 0) scored.push({ r: r, s: s });
  }
  scored.sort(function (a, b) { return b.s - a.s; });

  const slice = scored.slice(offset, offset + limit);
  const results = [];
  for (let i = 0; i < slice.length; i++) {
    const item = slice[i];
    const r = item.r;
    const s = item.s;
    const title = buildTitle(r);
    const citation = getCitation(r);
    const content = clean(r.content);
    let excerpt = makeExcerpt(content, queries, 240);
    if (doHighlight && excerpt) excerpt = highlight(excerpt, queries);
    results.push({
      id: String(r.id != null ? r.id : (r.rule_id != null ? r.rule_id : (r.ruleId != null ? r.ruleId : ""))),
      title, citation, score: s, excerpt
    });
  }
  return { hits: scored.length, results };
}

// --- HTTP handler ----------------------------------------------------------
export const rulebook = onRequest({ region: REGION }, async function (req, res) {
  try {
    // OPEN CORS (for debugging / bring-up)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") return res.status(204).end();

    // Health-like response if no query provided
    const q =
      (req.method === "GET" && (req.query.q || req.query.query)) ||
      (req.method === "POST" && (req.body && (req.body.q || req.body.query)));
    if (!q) {
      const example1 = "https://us-central1-primal-prism-471217-c5.cloudfunctions.net/rulebook?q=interference";
      const example2 = "https://us-central1-primal-prism-471217-c5.cloudfunctions.net/rulebook?q=infield+fly&limit=3&highlight=1";
      return res.status(200).json({
        ok: true,
        message: "RefflyAI rulebook is live. Pass ?q=your+question or POST {\"q\": \"...\"}",
        rules_loaded: RULES.length,
        first_item_keys: FIELD_KEYS.slice(0, 9),
        examples: [example1, example2],
      });
    }

    // Params
    const limit = parseIntSafe(req.query.limit, 5);
    const offset = parseIntSafe(req.query.offset, 0);
    const highlightFlag = parseBool(req.query.highlight, false);

    const result = searchRules({ q, limit, offset, doHighlight: highlightFlag });

    // Structured log
    logger.info({ event: "search", q, hits: result.hits, limit, offset });

    return res.status(200).json({
      ok: true, query: q, limit, offset, highlight: highlightFlag,
      hits: result.hits, results: result.results,
    });
  } catch (err) {
    logger.error("rulebook_error", { error: String(err) });
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

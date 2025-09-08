/* apps/functions/index.js
 * RefflyAI — MLB Rulebook Search (Node 20, 2nd-gen Functions)
 * Features:
 * - Health check (rules_loaded, first_item_keys)
 * - GET /rulebook?q=... (or POST {q}) with limit/offset
 * - Friendly synthesized titles
 * - Consistent citations (rule_id or citation)
 * - Clean excerpts
 * - Optional highlighting: &highlight=1 wraps matches with «…»
 * - Basic synonym expansion hook
 * - CORS allowlist (localhost + ready for reffly.com)
 */

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const path = require("path");
const fs = require("fs");

// ---- Config ---------------------------------------------------------------

const REGION = "us-central1";
const ALLOW_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  // TODO: add production origins when ready:
  // "https://www.reffly.com",
  // "https://reffly.com",
]);

// Synonym map (very lightweight starter). Keys must be lowercase.
const SYNONYMS = {
  "offensive interference": ["batter’s interference", "batter interference"],
  "batter interference": ["offensive interference", "batter’s interference"],
  "balks": ["balk"],
  "tag up": ["retouch", "time play"],
  "obstruction": ["fielder obstruction"],
  "infield fly": ["ifr", "infield fly rule"],
};

// ---- Load rules once per instance ----------------------------------------

/** Co-located JSON: apps/functions/data/mlbrules.json */
const RULES_PATH = path.join(__dirname, "data", "mlbrules.json");

let RULES = [];
let FIELD_KEYS = [];

try {
  const raw = fs.readFileSync(RULES_PATH, "utf8");
  RULES = JSON.parse(raw);
  FIELD_KEYS = RULES.length ? Object.keys(RULES[0]) : [];
  logger.info(`Loaded ${RULES.length} rules from ${RULES_PATH}`);
} catch (err) {
  logger.error("Failed to load mlbrules.json", err);
  RULES = [];
  FIELD_KEYS = [];
}

// ---- Helpers --------------------------------------------------------------

const clean = (s) =>
  (s || "")
    .toString()
    .replace(/\s+/g, " ")
    .replace(/[^\S\r\n]+/g, " ")
    .trim();

const lc = (s) => (s || "").toString().toLowerCase();

function buildTitle(rule) {
  // Try to produce a concise, human-friendly title
  const parts = [];
  if (rule.parentRule) parts.push(clean(rule.parentRule));
  if (rule.title) parts.push(clean(rule.title));
  if (rule.subsection) parts.push(clean(rule.subsection));
  if (!parts.length && rule.subtitle) parts.push(clean(rule.subtitle));
  const joined = parts.join(" — ");
  return joined || clean(rule.subtitle) || "Rule";
}

function getCitation(rule) {
  // Prefer explicit citation-ish fields, then fallback to id
  const candidates = [
    rule.citation,
    rule.citation1,
    rule.rule_id,
    rule.ruleId,
    rule.id,
  ].map(clean);
  return candidates.find((x) => x) || "";
}

function expandQueryWithSynonyms(q) {
  const terms = [q];
  const base = lc(q);
  Object.entries(SYNONYMS).forEach(([key, alts]) => {
    if (base.includes(key)) {
      alts.forEach((a) => terms.push(a));
    }
  });
  return Array.from(new Set(terms));
}

function scoreRule(rule, queries) {
  // Simple keyword matching with light field boosts
  const fields = {
    title: 3,
    subtitle: 2,
    content: 4,
    references: 1,
    parentRule: 2,
    subsection: 2,
  };

  let score = 0;
  const blob = {};
  for (const f of Object.keys(fields)) blob[f] = lc(clean(rule[f]));

  for (const q of queries) {
    const term = lc(q);
    const termRe = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
    for (const [f, wt] of Object.entries(fields)) {
      const hay = blob[f] || "";
      if (!hay) continue;
      // whole word match gets a boost
      if (termRe.test(hay)) score += 5 * wt;
      // substring fallbacks
      const idx = hay.indexOf(term);
      if (idx >= 0) score += 1 * wt;
    }
    // Exact phrase boost inside content
    if (blob.content && blob.content.includes(term)) score += 3;
  }

  return score;
}

function makeExcerpt(text, queries, maxLen = 220) {
  const t = clean(text);
  if (!t) return "";
  const base = lc(t);

  // Find first occurrence of any query
  let pos = 0;
  let foundAt = -1;
  for (const q of queries) {
    const idx = base.indexOf(lc(q));
    if (idx !== -1 && (foundAt === -1 || idx < foundAt)) {
      foundAt = idx;
    }
  }

  if (foundAt === -1) {
    return t.length <= maxLen ? t : t.slice(0, maxLen - 1).trimEnd() + "…";
  }

  // Center around the match
  const PAD = Math.floor(maxLen / 2);
  const start = Math.max(0, foundAt - PAD);
  const end = Math.min(t.length, start + maxLen);
  const snippet = t.slice(start, end).trim();

  return (start > 0 ? "… " : "") + snippet + (end < t.length ? " …" : "");
}

function highlight(text, queries) {
  if (!text) return "";
  let out = text;
  // wrap each unique term; keep it simple to avoid catastrophic regex
  const seen = new Set();
  for (const q of queries) {
    const term = q.trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    try {
      const re = new RegExp(`(${escapeRegExp(term)})`, "gi");
      out = out.replace(re, "«$1»");
    } catch {
      // skip bad regex input
    }
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBool(v, def = false) {
  if (v === undefined || v === null) return def;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function parseIntSafe(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

// ---- Core search ----------------------------------------------------------

function searchRules({ q, limit = 5, offset = 0, doHighlight = false }) {
  const rawQuery = clean(q || "");
  if (!rawQuery) {
    return { hits: 0, results: [] };
  }

  const queries = expandQueryWithSynonyms(rawQuery);

  // Score all rules (fast enough for ~1.2k in-memory)
  const scored = RULES.map((r) => ({
    r,
    s: scoreRule(r, queries),
  })).filter((x) => x.s > 0);

  scored.sort((a, b) => b.s - a.s);

  const slice = scored.slice(offset, offset + limit);

  const results = slice.map(({ r, s }) => {
    const title = buildTitle(r);
    const citation = getCitation(r);
    const content = clean(r.content);
    let excerpt = makeExcerpt(content, queries, 240);

    if (doHighlight && excerpt) {
      excerpt = highlight(excerpt, queries);
    }

    return {
      id: String(r.id ?? r.rule_id ?? r.ruleId ?? ""),
      title,
      citation,
      score: s,
      excerpt,
    };
  });

  return { hits: scored.length, results };
}

// ---- HTTP handler ---------------------------------------------------------

exports.rulebook = onRequest({ region: REGION }, async (req, res) => {
  try {
    // CORS
    const origin = req.headers.origin || "";
    if (ALLOW_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Requested-With"
      );
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS"
      );
      res.setHeader("Access-Control-Max-Age", "86400");
    }
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    // Health check (no q)
    const q =
      (req.method === "GET" && (req.query.q || req.query.query)) ||
      (req.method === "POST" &&
        (req.body?.q || req.body?.query));

    if (!q) {
      return res.status(200).json({
        ok: true,
        message:
          'RefflyAI rulebook is live. Pass ?q=your+question or POST {"q": "..."}',
        rules_loaded: RULES.length,
        first_item_keys: FIELD_KEYS.slice(0, 9),
        examples: [
          `${req.protocol}://${req.get("host")}${req.baseUrl}?q=interference`,
          `${req.protocol}://${req.get("host")}${req.b

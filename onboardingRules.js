/*
 * Department Onboarding Agent — the rules that must live in code, not in the
 * model's judgment (Build Spec, Part 4 "Keep rules in code"):
 *
 *   §2  department code lookup / proposal
 *   §3  Drive folder names
 *   §6  collection title
 *   §7  department tag
 *   §9  tags, vendor, options
 *   §10 SKU generation and validation
 *   §11 product description structure
 *   Appendix A colour codes, Appendix B standard text
 *
 * Everything here is pure and synchronous so it can be unit-tested without
 * Shopify, Drive, or OpenAI. Spelling, capitalisation, hyphens, slashes and
 * spaces matter — the values below are copied from the spec verbatim.
 */

/* ---------------------------------------------------------------------------
   Appendix B — standard text (verbatim)
   ------------------------------------------------------------------------- */

const LOGO_DISCLAIMER = "Logo size & placement are an approximation";

const NON_STOCK_NOTICE = {
  title: "Non-Stock Item Notice",
  paragraphs: [
    "Please Note: Items marked Non-Stock are not kept in our warehouse. We order these items from our suppliers after you place your order.",
    "Because we have to wait for the item to arrive, Non-Stock Items may take longer than one week to ship.",
    "We'll work to get your order to you as quickly as possible!"
  ]
};

// HTML form used for the collection description and product descriptions.
// Mirrors the markup already live on department collections (Bishop, Sept 2026).
const NON_STOCK_NOTICE_HTML =
  `<h3>${NON_STOCK_NOTICE.title}</h3>\n` +
  `<p><strong>Please Note:</strong> Items marked <strong>Non-Stock</strong> are not kept in our warehouse. We order these items from our suppliers after you place your order.</p>\n` +
  `<p>Because we have to wait for the item to arrive, <strong>Non-Stock Items may take longer than one week to ship.</strong></p>\n` +
  `<p>We’ll work to get your order to you as quickly as possible!</p>`;

const LOGO_DISCLAIMER_HTML = `<p>Logo size &amp; placement are an approximation</p>`;

/* ---------------------------------------------------------------------------
   §9.5 Vendor values, §9.4 tags, §9.6 option names (exact strings)
   ------------------------------------------------------------------------- */

const VENDOR_ONE_WEEK = "One Week Item";
const VENDOR_NON_STOCK = "Non Stock Item";
const VENDORS = [VENDOR_ONE_WEEK, VENDOR_NON_STOCK];

const TAG_EMBROIDERED = "Embroidered";
const TAG_UNIFORM = "Uniform";

const OPTION_COLOR = "Color";
const OPTION_SIZE = "Size";
const OPTION_STYLE = "Style";

const DECORATION_PRINT = "print";
const DECORATION_EMBROIDERY = "embroidery";

/* ---------------------------------------------------------------------------
   Appendix A — colour code list, as delivered (duplicates flagged for Dan)
   ------------------------------------------------------------------------- */

const COLOR_CODES_SEED = [
  { code: "ALL", color: "Alloy Heathered" },
  { code: "ARM", color: "Army" },
  { code: "ART", color: "Army/Tan" },
  { code: "AST", color: "Assorted", note: "When used?", status: "flagged" },
  { code: "BB", color: "Breaker Blue" },
  { code: "BCM", color: "Blue Camo" },
  { code: "BLA", color: "Black", note: "Duplicate of BLK", status: "flagged", duplicateOf: "BLK" },
  { code: "BLB", color: "Black W/Black/Red Rope", note: "Duplicate of BLR", status: "flagged", duplicateOf: "BLR" },
  { code: "BLK", color: "Black", note: "Duplicate of BLA", status: "flagged", preferred: true },
  { code: "BLR", color: "Black W/Black/Red Rope", note: "Duplicate of BLB", status: "flagged", preferred: true },
  { code: "BRK", color: "Brown/Khaki" },
  { code: "BRN", color: "Brown" },
  { code: "BWB", color: "Black/White/Black" },
  { code: "C_B", color: "Charcoal/Black" },
  { code: "CHA", color: "Charcoal", note: "Duplicate of CHL", status: "flagged", duplicateOf: "CHL" },
  { code: "CHL", color: "Charcoal", note: "Duplicate of CHA", status: "flagged", preferred: true },
  { code: "CMB", color: "Carmel/Black" },
  { code: "CNY", color: "Charcoal/Neon Yellow" },
  { code: "COY", color: "Coyote Brown/Black" },
  { code: "DKN", color: "Dark Navy" },
  { code: "FG", color: "Frost Grey" },
  { code: "FOS", color: "Fossil" },
  { code: "G_W", color: "Grey/White" },
  { code: "GG", color: "Gusty Grey" },
  { code: "GRY", color: "Grey" },
  { code: "HBK", color: "Heather/Black" },
  { code: "HBL", color: "Heather Blue Lagoon" },
  { code: "HDC", color: "Heather/Dark Charcoal" },
  { code: "HEA", color: "Heather Grey" },
  { code: "HEW", color: "Heather/White" },
  { code: "KHA", color: "Khaki" },
  { code: "L_B", color: "Loden/Black" },
  { code: "LDN", color: "Loden" },
  { code: "LNV", color: "Light Navy" },
  { code: "MN", color: "Midnight Navy" },
  { code: "NAT", color: "Natural" },
  { code: "NAW", color: "Navy/White" },
  { code: "NVY", color: "Navy" },
  { code: "ODG", color: "Olive Drab Green" },
  { code: "OLV", color: "Olive" },
  // OSFA is a size code, not a colour — Appendix A flags it for removal. It is
  // kept here as "retired" so a legacy row never resolves to a colour.
  { code: "OSFA", color: "OSFA", note: "This is a size code, not a color", status: "retired" },
  { code: "RED", color: "Red" },
  { code: "SAI", color: "Sail" },
  { code: "SBL", color: "Steel Blue" },
  { code: "SG", color: "Steel Green" },
  { code: "TBD", color: "TBD", note: "When used?", status: "flagged" },
  { code: "WHI", color: "White" },
  { code: "WHR", color: "White w/Rope" }
];

/* ---------------------------------------------------------------------------
   §10 sizes
   ------------------------------------------------------------------------- */

const ALPHA_SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL"];
const TALL_SIZES = ["LT", "XLT", "2XLT", "3XLT", "4XLT"];
const YOUTH_SIZES = ["YXS", "YS", "YM", "YL", "YXL"];
const HAT_SIZES = ["OSFA", "S/M", "L/XL"];
const NUMERIC_MIN = 28;
const NUMERIC_MAX = 56;
const INSEAM_MIN = 26;
const INSEAM_MAX = 40;

const SIZE_ALIASES = {
  XXS: "XS",
  XXL: "2XL",
  XXXL: "3XL",
  XXXXL: "4XL",
  "ONE SIZE": "OSFA",
  "ONE SIZE FITS ALL": "OSFA",
  OS: "OSFA",
  "S-M": "S/M",
  "L-XL": "L/XL",
  SM: "S/M",
  LXL: "L/XL"
};

/*
 * Normalise a size the way the SKU needs it. Returns { size, kind } or
 * { error } for anything the rules don't recognise. Kinds: alpha, tall,
 * youth, hat, numeric, waistInseam, fitted.
 */
function normalizeSize(input) {
  let raw = String(input == null ? "" : input).trim().toUpperCase();
  if (!raw) return { error: "Size is empty" };
  raw = raw.replace(/\s+/g, " ");
  if (SIZE_ALIASES[raw]) raw = SIZE_ALIASES[raw];
  if (ALPHA_SIZES.includes(raw)) return { size: raw, kind: "alpha" };
  if (TALL_SIZES.includes(raw)) return { size: raw, kind: "tall" };
  if (YOUTH_SIZES.includes(raw)) return { size: raw, kind: "youth" };
  if (HAT_SIZES.includes(raw)) return { size: raw, kind: "hat" };
  // Waist x inseam (pants): 30x32, 30X32, 30/32 → 30x32 (open item #6 —
  // waist+inseam is what the live Ripon pants use).
  const wi = raw.match(/^(\d{2})\s*[X\/]\s*(\d{2})$/);
  if (wi) {
    const waist = Number(wi[1]);
    const inseam = Number(wi[2]);
    if (waist < NUMERIC_MIN || waist > NUMERIC_MAX) return { error: `Waist ${waist} is outside ${NUMERIC_MIN}–${NUMERIC_MAX}` };
    if (inseam < INSEAM_MIN || inseam > INSEAM_MAX) return { error: `Inseam ${inseam} is outside ${INSEAM_MIN}–${INSEAM_MAX}` };
    return { size: `${waist}x${inseam}`, kind: "waistInseam" };
  }
  if (/^\d{2}$/.test(raw)) {
    const n = Number(raw);
    if (n < NUMERIC_MIN || n > NUMERIC_MAX) return { error: `Numeric size ${n} is outside ${NUMERIC_MIN}–${NUMERIC_MAX}` };
    return { size: raw, kind: "numeric" };
  }
  // Fitted hats: "7 1/8" → "71/8" (spaces removed, as the live PTS65 SKUs do).
  if (/^[678](\s?\d\/\d)?$/.test(raw)) return { size: raw.replace(/\s+/g, ""), kind: "fitted" };
  return { error: `Unrecognised size "${input}"` };
}

/* ---------------------------------------------------------------------------
   §10 decoration codes
   ------------------------------------------------------------------------- */

// Order within the SKU: front, back, right sleeve, left sleeve, embroidery.
// Open item #2 (both sleeves): RS before LS is an assumption and is reported
// as such by validateProduct.
/*
 * P## (a sewn-on patch) is NOT in the spec's Appendix, but it is in the live
 * store: Bishop's hats ship as "R112-OSFA-NVY-BSH-P01" (patch) alongside
 * "R112-OSFA-NVY-BSH-E01" (embroidery), and its job shirts carry P01 for
 * velcro name/rank patches. Rejecting it would make the agent unable to
 * reproduce stores Dan has already built, so it is supported and every product
 * that uses it reports an assumption for Dan to confirm.
 *
 * It groups with embroidery rather than print: a patch is applied to the
 * garment, not printed on it, so P and E may share an item while F/B/RS/LS
 * may not (spec §10 "either all print or all embroidery").
 */
const DECORATION_PREFIX_ORDER = ["F", "B", "RS", "LS", "E", "P"];
const PRINT_PREFIXES = ["F", "B", "RS", "LS"];
const EMBROIDERY_PREFIXES = ["E", "P"];
const PATCH_PREFIXES = ["P"];
const DECORATION_RE = /^(F|B|RS|LS|E|P)(\d{2})$/;

const DECORATION_LOCATIONS = {
  F: "front",
  B: "back",
  RS: "right sleeve",
  LS: "left sleeve",
  E: "embroidery",
  P: "patch"
};

function parseDecorationCode(input) {
  const raw = String(input == null ? "" : input).trim().toUpperCase();
  const m = raw.match(DECORATION_RE);
  if (!m) return { error: `Decoration code "${input}" must look like F01, B01, RS01, LS01, E01 or P01 (two digits)` };
  const number = Number(m[2]);
  if (number < 1) return { error: `Decoration code "${input}" must be numbered 01–99` };
  return {
    code: `${m[1]}${m[2]}`,
    prefix: m[1],
    number,
    location: DECORATION_LOCATIONS[m[1]],
    method: EMBROIDERY_PREFIXES.includes(m[1]) ? DECORATION_EMBROIDERY : DECORATION_PRINT,
    patch: PATCH_PREFIXES.includes(m[1])
  };
}

/*
 * Accepts "F01/B01", "F01, B01", ["F01","B01"] and returns the codes sorted
 * into SKU order (front, back, right sleeve, left sleeve, embroidery; numeric
 * within a location). Mixed print/embroidery is rejected (§10 rule 1).
 */
function normalizeDecorations(input) {
  const list = Array.isArray(input)
    ? input
    : String(input == null ? "" : input).split(/[\/,\s]+/);
  const parsed = [];
  const errors = [];
  for (const item of list) {
    if (!String(item || "").trim()) continue;
    const p = parseDecorationCode(item);
    if (p.error) errors.push(p.error);
    else parsed.push(p);
  }
  const seen = new Set();
  const unique = parsed.filter((p) => {
    if (seen.has(p.code)) return false;
    seen.add(p.code);
    return true;
  });
  const methods = new Set(unique.map((p) => p.method));
  if (methods.size > 1) {
    errors.push(
      "An item is either all print or all embroidery. Never mix F/B/RS/LS codes with E codes — a mixed item is a custom order and is not built in the store."
    );
  }
  const assumptions = [];
  if (unique.some((p) => p.patch)) {
    assumptions.push(
      "P## is a sewn-patch code used in the live store but not listed in the spec's decoration codes. It is treated as applied decoration (it may share an item with E##, never with F/B/RS/LS). Confirm with Dan."
    );
  }
  unique.sort((a, b) => {
    const ai = DECORATION_PREFIX_ORDER.indexOf(a.prefix);
    const bi = DECORATION_PREFIX_ORDER.indexOf(b.prefix);
    return ai - bi || a.number - b.number;
  });
  return {
    codes: unique.map((p) => p.code),
    decorations: unique,
    method: methods.size === 1 ? [...methods][0] : null,
    errors,
    assumptions
  };
}

/*
 * The production file name a decoration code must match in the Omni Printer
 * folder (§10 rule 2): "VAC-F01". Extension is not part of the rule.
 */
function decorationFileStem(departmentCode, decorationCode) {
  return `${departmentCode}-${decorationCode}`;
}

/*
 * Match decoration codes to file names found in the department's Omni Printer
 * folder. Returns { matched: {code: fileName}, missing: [codes] }.
 */
function matchDecorationFiles(departmentCode, decorationCodes, fileNames) {
  const stems = new Map();
  for (const name of fileNames || []) {
    const stem = String(name).replace(/\.[a-z0-9]+$/i, "").trim().toUpperCase();
    stems.set(stem, name);
  }
  const matched = {};
  const missing = [];
  for (const code of decorationCodes || []) {
    const stem = decorationFileStem(departmentCode, code).toUpperCase();
    if (stems.has(stem)) matched[code] = stems.get(stem);
    else missing.push(code);
  }
  return { matched, missing };
}

/* ---------------------------------------------------------------------------
   Colour codes
   ------------------------------------------------------------------------- */

function normalizeColorName(name) {
  return String(name == null ? "" : name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\bw\/\b/g, "w/");
}

/*
 * Resolve a colour name against the colour code table. Returns
 *   { code, entry }                    — exact, active (or preferred duplicate)
 *   { code, entry, warning }           — resolved to a flagged code Dan must confirm
 *   { proposal, alternatives, missing } — not on the list: a new code is proposed
 *                                        and must be approved before use.
 */
function resolveColorCode(colorName, table = COLOR_CODES_SEED) {
  const wanted = normalizeColorName(colorName);
  if (!wanted) return { error: "Color name is empty" };
  const candidates = table.filter(
    (row) => row.status !== "retired" && normalizeColorName(row.color) === wanted
  );
  if (candidates.length) {
    const preferred = candidates.find((row) => row.preferred) || candidates.find((row) => row.status !== "flagged") || candidates[0];
    const result = { code: preferred.code, entry: preferred };
    if (candidates.length > 1) {
      result.warning = `Color "${colorName}" has duplicate codes on the Color Code List (${candidates
        .map((row) => row.code)
        .join(" / ")}). Using ${preferred.code}; Dan must confirm which code stays.`;
    } else if (preferred.status === "flagged") {
      result.warning = `Color code ${preferred.code} is flagged on the Color Code List (${preferred.note || "review"}).`;
    }
    return result;
  }
  // Direct code entry ("MN") is accepted when it is on the list.
  const asCode = String(colorName).trim().toUpperCase();
  const byCode = table.find((row) => row.code === asCode && row.status !== "retired");
  if (byCode) return { code: byCode.code, entry: byCode };
  const used = new Set(table.map((row) => row.code));
  const alternatives = proposeColorCodes(colorName).filter((code) => !used.has(code));
  return {
    missing: true,
    proposal: alternatives[0] || null,
    alternatives,
    error: `Color "${colorName}" is not on the Color Code List. Propose a code and get Dan's approval before using it.`
  };
}

function proposeColorCodes(colorName) {
  const words = String(colorName || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\/ ]+/g, " ")
    .split(/[\s\/]+/)
    .filter(Boolean);
  if (!words.length) return [];
  const out = [];
  const push = (code) => {
    if (code && /^[A-Z0-9_]{2,4}$/.test(code) && !out.includes(code)) out.push(code);
  };
  if (words.length === 1) {
    push(words[0].slice(0, 3));
    push(words[0].replace(/[AEIOU]/g, "").slice(0, 3));
    push(words[0].slice(0, 2));
  } else {
    push(words.map((w) => w[0]).join("").slice(0, 4));
    push(`${words[0].slice(0, 2)}${words[1][0]}`);
    push(`${words[0][0]}_${words[1][0]}`);
    push(words[0].slice(0, 3));
  }
  return out;
}

/* ---------------------------------------------------------------------------
   §2 department codes
   ------------------------------------------------------------------------- */

const DEPARTMENT_CODE_RE = /^[A-Z]{3,4}$/;

const AGENCY_STOP_WORDS = new Set([
  "FIRE", "DEPARTMENT", "DEPT", "DISTRICT", "PROTECTION", "FPD", "FD", "CITY", "OF", "COUNTY",
  "THE", "AND", "&", "RESCUE", "EMS", "SERVICES", "SERVICE", "AUTHORITY", "VOLUNTEER", "VFD",
  "CSD", "TOWNSHIP", "TOWN", "AREA", "REGIONAL", "COMMUNITY", "CO", "STATION"
]);

function agencyWords(name) {
  return String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function significantWords(name) {
  const words = agencyWords(name).filter((w) => !AGENCY_STOP_WORDS.has(w));
  return words.length ? words : agencyWords(name);
}

/*
 * Propose codes for a department that is not on the list (§2.2):
 *   Bahama Fire Department        → BAH  (first three letters)
 *   Granville Township Fire Dept  → GTFD (acronym, 4 letters)
 * Returns candidates in preference order; each carries `inUse` when the code
 * is already taken (list or in-use set).
 */
function proposeDepartmentCodes(name, { taken = new Set() } = {}) {
  const all = agencyWords(name);
  const sig = significantWords(name);
  const out = [];
  const push = (code, reason) => {
    const c = String(code || "").toUpperCase().replace(/[^A-Z]/g, "");
    if (!DEPARTMENT_CODE_RE.test(c)) return;
    if (out.some((o) => o.code === c)) return;
    out.push({ code: c, reason, inUse: taken.has(c) });
  };
  if (sig.length) push(sig[0].slice(0, 3), "first three letters of the name");
  if (all.length >= 3) push(all.map((w) => w[0]).join("").slice(0, 4), "acronym of the full name");
  if (sig.length >= 2) push(sig.map((w) => w[0]).join("").slice(0, 4), "acronym of the significant words");
  if (sig.length >= 2) push(`${sig[0].slice(0, 2)}${sig[1][0]}`, "two letters plus the next word");
  if (sig.length) push(sig[0].slice(0, 4), "first four letters of the name");
  if (sig.length) push(`${sig[0].slice(0, 3)}F`, "first three letters plus F for Fire");
  return out;
}

/*
 * Look a department up on the Department Code List. `list` rows look like
 * { code, agency, city?, state?, source? }. Returns ranked matches; a score of
 * 1 is an exact (normalised) agency match.
 */
function lookupDepartmentCode(name, list) {
  const want = significantWords(name).join(" ");
  const wantAll = agencyWords(name).join(" ");
  const results = [];
  for (const row of list || []) {
    const agencyAll = agencyWords(row.agency).join(" ");
    const agencySig = significantWords(row.agency).join(" ");
    let score = 0;
    if (agencyAll === wantAll) score = 1;
    else if (agencySig && agencySig === want) score = 0.95;
    else if (agencySig && (agencySig.startsWith(want) || want.startsWith(agencySig))) score = 0.8;
    else {
      const a = new Set(agencySig.split(" "));
      const b = want.split(" ").filter(Boolean);
      const hit = b.filter((w) => a.has(w)).length;
      if (hit && hit === b.length) score = 0.7;
      else if (hit) score = 0.4 * (hit / Math.max(b.length, a.size));
    }
    if (score > 0) results.push({ ...row, score });
  }
  results.sort((a, b) => b.score - a.score || String(a.agency).localeCompare(String(b.agency)));
  return results.slice(0, 8);
}

function validateDepartmentCode(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!DEPARTMENT_CODE_RE.test(c)) return { error: "Department codes are 3 or 4 letters (A–Z), e.g. VAC or GTFD." };
  return { code: c };
}

/* ---------------------------------------------------------------------------
   §3 Drive folders, §6 collection title, §7 department tag
   ------------------------------------------------------------------------- */

function departmentFolderName(name, code) {
  return `${String(name).trim()} (${code})`;
}

function productionFolderName(name, code) {
  return `(${code}) ${String(name).trim()}`;
}

function collectionTitle(storeName, ordinal = 1) {
  const n = Number(ordinal) >= 1 ? Math.floor(Number(ordinal)) : 1;
  return `${n}. ${String(storeName).trim()}`;
}

function departmentTag(name) {
  // The department tag is the department name spelled exactly as used
  // everywhere else. Only surrounding whitespace is trimmed; case is kept.
  return String(name || "").trim().replace(/\s+/g, " ");
}

/* ---------------------------------------------------------------------------
   §9 tags, vendor, options, §10 SKUs
   ------------------------------------------------------------------------- */

function productTags(departmentCode, { embroidered = false, classB = false } = {}) {
  const tags = [departmentCode];
  if (embroidered) tags.push(TAG_EMBROIDERED);
  if (classB) tags.push(TAG_UNIFORM);
  return tags;
}

function normalizeVendor(input) {
  const raw = String(input || "").trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  if (!raw) return { error: "Fulfillment (Vendor) is required: One Week Item or Non Stock Item." };
  if (raw === "one week item" || raw === "one week" || raw === "ows") return { vendor: VENDOR_ONE_WEEK };
  if (raw === "non stock item" || raw === "non stock" || raw === "nonstock item" || raw === "nonstock") return { vendor: VENDOR_NON_STOCK };
  return { error: `Vendor must be exactly "${VENDOR_ONE_WEEK}" or "${VENDOR_NON_STOCK}" (no hyphens); got "${input}".` };
}

function styleName(index) {
  return `Style ${index}`;
}

function normalizeStyleNumber(input) {
  const raw = String(input || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!raw) return { error: "Style number is required (e.g. NL3600)." };
  if (!/^[A-Z0-9][A-Z0-9.\-]*$/.test(raw)) return { error: `Style number "${input}" may only contain letters, digits, dots and dashes.` };
  return { styleNumber: raw };
}

/*
 * STYLE-SIZE-COLOR-CODE-DECORATIONS. When an item carries no decoration at
 * all (stock pants), the trailing segment is omitted.
 */
function buildSku({ styleNumber, size, colorCode, departmentCode, decorationCodes = [] }) {
  const parts = [styleNumber, size, colorCode, departmentCode];
  if (decorationCodes.length) parts.push(decorationCodes.join("/"));
  return parts.join("-");
}

/*
 * Read a SKU back into its parts. Two shapes exist in the live store:
 *
 *   NL3600-L-NVY-VAC-F01/B01   STYLE-SIZE-COLOR-CODE-DECORATIONS (the spec)
 *   FP52MN-30-RIP              STYLE-SIZE-CODE, used on tailored Class B items
 *                              whose manufacturer style number already carries
 *                              the colour (FP52 + MN) and that ship undecorated
 *
 * The department code is the anchor: it is the last segment when there are no
 * decorations, otherwise the one before them. Returns null when the string is
 * not a SKU at all.
 */
function parseSku(sku, { departmentCode = "" } = {}) {
  const raw = String(sku == null ? "" : sku).trim();
  if (!raw) return null;
  const parts = raw.split("-");
  if (parts.length < 3) return null;

  // The decoration segment is the trailing one made only of decoration codes.
  const last = parts[parts.length - 1];
  const looksLikeDecorations =
    last.split("/").length > 0 && last.split("/").every((c) => DECORATION_RE.test(c.trim().toUpperCase()));
  const decorations = looksLikeDecorations ? last.split("/").map((c) => c.trim().toUpperCase()) : [];
  const head = looksLikeDecorations ? parts.slice(0, -1) : parts;
  if (head.length < 3) return null;

  const code = head[head.length - 1];
  if (departmentCode && code.toUpperCase() !== String(departmentCode).toUpperCase()) {
    // Not this department's SKU; still parse it so callers can report why.
    return { style: head[0], size: head.slice(1, -2).concat(head[head.length - 2]).join("-"), colorCode: null, code, decorations, shape: "unknown" };
  }
  if (head.length === 3) {
    return { style: head[0], size: head[1], colorCode: null, code, decorations, shape: "style-size-code" };
  }
  return {
    style: head[0],
    size: head.slice(1, head.length - 2).join("-"),
    colorCode: head[head.length - 2],
    code,
    decorations,
    shape: "style-size-color-code"
  };
}

/*
 * Expand one product row into its full variant matrix and SKUs.
 *
 * product = {
 *   brand, styleNumber, type, title?,
 *   colors: ["Navy", ...] (names) — or objects {name, code?}
 *   sizes: ["S", ...],
 *   decorationMethod: "print" | "embroidery" | "" (derived from codes when empty)
 *   decorationCodes: "F01/B01" | [..]           (single-style items)
 *   styles: [{ name?: "Style 1", decorationCodes }] (multi-style items)
 *   fulfillment: "One Week Item" | "Non Stock Item"
 *   classB: boolean
 * }
 *
 * Returns { ok, product (normalised), variants, options, errors, warnings, assumptions }.
 */
function expandProduct(product, { departmentCode, colorTable = COLOR_CODES_SEED, productionFiles = null } = {}) {
  const errors = [];
  const warnings = [];
  const assumptions = [];

  const dc = validateDepartmentCode(departmentCode);
  if (dc.error) errors.push(dc.error);
  const code = dc.code || String(departmentCode || "").toUpperCase();

  const sn = normalizeStyleNumber(product.styleNumber);
  if (sn.error) errors.push(sn.error);
  const styleNumber = sn.styleNumber || "";

  const vendor = normalizeVendor(product.fulfillment || product.vendor);
  if (vendor.error) errors.push(vendor.error);

  // Colours — always an option, even with a single colour (§9.6).
  const colorInputs = (product.colors || []).map((c) => (typeof c === "string" ? { name: c } : c || {})).filter((c) => c.name);
  if (!colorInputs.length) errors.push("At least one color is required (Color is always a variant option).");
  const colors = [];
  for (const c of colorInputs) {
    const resolved = c.code
      ? { code: String(c.code).toUpperCase(), entry: colorTable.find((row) => row.code === String(c.code).toUpperCase()) }
      : resolveColorCode(c.name, colorTable);
    if (resolved.error && !resolved.code) {
      errors.push(resolved.error);
      colors.push({ name: c.name, code: null, proposal: resolved.proposal, alternatives: resolved.alternatives, missing: true });
      continue;
    }
    if (resolved.warning) warnings.push(resolved.warning);
    if (c.code && !resolved.entry) warnings.push(`Color code ${resolved.code} for "${c.name}" is not on the Color Code List — it must be approved and added.`);
    colors.push({ name: c.name, code: resolved.code, entry: resolved.entry || null });
  }
  const colorNames = new Set();
  for (const c of colors) {
    const key = normalizeColorName(c.name);
    if (colorNames.has(key)) errors.push(`Color "${c.name}" is listed twice.`);
    colorNames.add(key);
  }

  // Sizes — always an option (§9.6).
  const sizeInputs = Array.isArray(product.sizes) ? product.sizes : String(product.sizes || "").split(/[,\s]+/);
  const sizes = [];
  for (const s of sizeInputs) {
    if (!String(s || "").trim()) continue;
    const n = normalizeSize(s);
    if (n.error) errors.push(n.error);
    else if (!sizes.some((x) => x.size === n.size)) sizes.push(n);
  }
  if (!sizes.length) errors.push("At least one size is required (Size is always a variant option).");
  const sizeKinds = new Set(sizes.map((s) => s.kind));
  if (sizeKinds.has("waistInseam")) assumptions.push("Pants sizing in the SKU uses waist x inseam (open item #6). Waist-only sizes are also accepted.");

  // Styles — only when the same blank has more than one logo set-up (§9.6).
  const styleInputs = Array.isArray(product.styles) && product.styles.length
    ? product.styles
    : [{ decorationCodes: product.decorationCodes }];
  const styles = [];
  const allCodes = new Set();
  styleInputs.forEach((s, i) => {
    const nd = normalizeDecorations(s.decorationCodes);
    nd.errors.forEach((e) => errors.push(`${styleInputs.length > 1 ? `${styleName(i + 1)}: ` : ""}${e}`));
    (nd.assumptions || []).forEach((a) => {
      if (!assumptions.includes(a)) assumptions.push(a);
    });
    nd.codes.forEach((c) => allCodes.add(c));
    styles.push({ name: styleInputs.length > 1 ? styleName(i + 1) : null, decorationCodes: nd.codes, method: nd.method, decorations: nd.decorations });
  });
  if (styles.length > 1) {
    const sigs = styles.map((s) => s.decorationCodes.join("/"));
    if (new Set(sigs).size !== sigs.length) errors.push("Two Styles have the same decoration codes — Styles must differ.");
    if (styles.some((s) => !s.decorationCodes.length)) errors.push("Every Style needs at least one decoration code.");
  }
  const methods = new Set(styles.map((s) => s.method).filter(Boolean));
  if (methods.size > 1) errors.push("Styles on one product must all be print or all be embroidery.");
  const derivedMethod = methods.size === 1 ? [...methods][0] : null;
  const declared = String(product.decorationMethod || "").trim().toLowerCase();
  if (declared && derivedMethod && declared !== derivedMethod) {
    errors.push(`Decoration method is "${declared}" but the decoration codes are ${derivedMethod} codes.`);
  }
  const method = derivedMethod || (declared === DECORATION_EMBROIDERY || declared === DECORATION_PRINT ? declared : null);
  const hasDecoration = allCodes.size > 0;
  if (!hasDecoration) {
    assumptions.push("No decoration codes: treated as a plain stock item (e.g. pants) — stock image, no mockup, no decoration segment in the SKU.");
  }
  if ([...allCodes].some((c) => /^(RS|LS)/.test(c)) && [...allCodes].some((c) => c.startsWith("RS")) && [...allCodes].some((c) => c.startsWith("LS"))) {
    assumptions.push("Both sleeves decorated: SKU order is RS then LS (open item #2).");
  }
  if (productionFiles && hasDecoration && method === DECORATION_PRINT) {
    const { missing } = matchDecorationFiles(code, [...allCodes], productionFiles);
    if (missing.length) errors.push(`No print-ready file in the Omni Printer folder for: ${missing.map((c) => decorationFileStem(code, c)).join(", ")}.`);
  }

  const options = [
    { name: OPTION_COLOR, values: colors.map((c) => c.name) },
    { name: OPTION_SIZE, values: sizes.map((s) => s.size) }
  ];
  if (styles.length > 1) options.push({ name: OPTION_STYLE, values: styles.map((s) => s.name) });

  const variants = [];
  const skus = new Set();
  for (const color of colors) {
    for (const size of sizes) {
      for (const style of styles) {
        const sku = color.code
          ? buildSku({ styleNumber, size: size.size, colorCode: color.code, departmentCode: code, decorationCodes: style.decorationCodes })
          : null;
        if (sku) {
          if (skus.has(sku)) errors.push(`Duplicate SKU ${sku} — every size × color × style combination needs its own SKU.`);
          skus.add(sku);
        }
        const optionValues = [
          { optionName: OPTION_COLOR, name: color.name },
          { optionName: OPTION_SIZE, name: size.size }
        ];
        if (style.name) optionValues.push({ optionName: OPTION_STYLE, name: style.name });
        variants.push({ sku, color: color.name, colorCode: color.code, size: size.size, style: style.name, decorationCodes: style.decorationCodes, optionValues });
      }
    }
  }

  const embroidered = method === DECORATION_EMBROIDERY;
  const tags = productTags(code, { embroidered, classB: Boolean(product.classB) });

  return {
    ok: errors.length === 0,
    product: {
      brand: String(product.brand || "").trim(),
      styleNumber,
      type: String(product.type || "").trim(),
      title: String(product.title || "").trim() || defaultProductTitle(product),
      colors,
      sizes: sizes.map((s) => s.size),
      styles,
      decorationMethod: method,
      hasDecoration,
      fulfillment: vendor.vendor || null,
      classB: Boolean(product.classB),
      tags
    },
    options,
    variants,
    errors,
    warnings,
    assumptions
  };
}

function defaultProductTitle(product) {
  const brand = String(product.brand || "").trim();
  const type = String(product.type || "").trim();
  return [brand, type].filter(Boolean).join(" ");
}

/* ---------------------------------------------------------------------------
   §11 product description, §6 collection description
   ------------------------------------------------------------------------- */

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/*
 * Section 11 structure:
 *  1. logo disclaimer — only on products with a digital mockup of a decoration
 *  2. Brand (Style Number)
 *  3. bullets: materials and product details
 *  4. product measurements / sizing (a table, or rows)
 *  5. Non-Stock Item Notice — only when the vendor is Non Stock Item
 * `measurementsHtml` (a ready <table>) wins over `measurements` rows.
 */
function buildProductDescriptionHtml({ brand, styleNumber, bullets = [], measurements = null, measurementsHtml = "", hasMockup = true, vendor, extraNotes = [] }) {
  const parts = [];
  if (hasMockup) parts.push(LOGO_DISCLAIMER_HTML);
  parts.push(`<p>${escapeHtml(brand)} (${escapeHtml(styleNumber)})</p>`);
  const items = (bullets || []).map((b) => String(b || "").trim()).filter(Boolean);
  if (items.length) parts.push(`<ul>\n${items.map((b) => `<li>${escapeHtml(b)}</li>`).join("\n")}\n</ul>`);
  if (measurementsHtml && /<table[\s>]/i.test(measurementsHtml)) {
    parts.push(measurementsHtml.trim());
  } else if (measurements && Array.isArray(measurements.rows) && measurements.rows.length) {
    const header = measurements.sizes || [];
    const rows = measurements.rows;
    const table = [
      `<table border="1" cellpadding="0" cellspacing="0" dir="ltr">`,
      `<tbody>`,
      `<tr><td>${escapeHtml(measurements.title || "Product Measurements")}</td>${header.map(() => "<td></td>").join("")}</tr>`,
      `<tr><td></td>${header.map((h) => `<td>${escapeHtml(h)}</td>`).join("")}</tr>`,
      ...rows.map((r) => `<tr><td>${escapeHtml(r.label)}</td>${(r.values || []).map((v) => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`),
      `</tbody>`,
      `</table>`
    ];
    parts.push(table.join("\n"));
  }
  for (const note of extraNotes || []) {
    if (String(note || "").trim()) parts.push(`<p>${escapeHtml(note)}</p>`);
  }
  if (vendor === VENDOR_NON_STOCK) parts.push(NON_STOCK_NOTICE_HTML);
  return parts.join("\n");
}

function collectionDescriptionHtml() {
  return NON_STOCK_NOTICE_HTML;
}

/*
 * Pull the reusable pieces (bullets + measurement table) out of an existing
 * product's description so a duplicated product keeps the manufacturer data
 * without carrying over another department's wording.
 */
function extractDescriptionParts(descriptionHtml) {
  const html = String(descriptionHtml || "");
  const bullets = [];
  const ulMatches = html.match(/<ul[\s\S]*?<\/ul>/gi) || [];
  for (const ul of ulMatches) {
    const lis = ul.match(/<li[^>]*>[\s\S]*?<\/li>/gi) || [];
    for (const li of lis) {
      const text = li.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
      if (text) bullets.push(text);
    }
  }
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  const measurementsHtml = tableMatch ? tableMatch[0].replace(/\s(?:data-sheets-[a-z]+|xmlns)="[^"]*"/gi, "") : "";
  const brandLine = (html.match(/<p>\s*([^<]{2,80}?\([A-Z0-9.\-]{2,}\))\s*<\/p>/) || [])[1] || "";
  return { bullets, measurementsHtml, brandLine };
}

/* ---------------------------------------------------------------------------
   §5 mockup file names, §6 banner logo choice
   ------------------------------------------------------------------------- */

function mockupFileName({ departmentCode, styleNumber, colorCode, style = null, face }) {
  const parts = [departmentCode, styleNumber, colorCode];
  if (style) parts.push(String(style).replace(/\s+/g, ""));
  parts.push(String(face).toUpperCase());
  return `${parts.join("_")}.png`;
}

const MOCKUP_SIZE = 2000;
const BANNER_WIDTH = 3584;
const BANNER_HEIGHT = 2048;

/*
 * Logo choice for the banner (§6.3): department's pick → scramble → chest →
 * back. `artwork` rows: { id, role: "pick"|"scramble"|"chest"|"back"|other }.
 */
function chooseBannerLogo(artwork = []) {
  const order = ["pick", "scramble", "chest", "back"];
  for (const role of order) {
    const hit = artwork.find((a) => a && a.role === role);
    if (hit) return { ...hit, reason: role === "pick" ? "the department's pick" : `the ${role} logo` };
  }
  return null;
}

/* ---------------------------------------------------------------------------
   §8a Mega Menu position: below the last department store, above the first
   public store.
   ------------------------------------------------------------------------- */

const PUBLIC_STORE_TITLES = ["FN Simple Merch", "SF City Gear", "Barrier", "Firefighter", "Bay Area Firefighter", "LOGIN to see your Shop"];

function isPublicStoreTitle(title) {
  const t = String(title || "").trim().toLowerCase();
  return PUBLIC_STORE_TITLES.some((p) => t === p.toLowerCase() || t.startsWith(p.toLowerCase()));
}

/*
 * The MENU item is named WITHOUT the collection's "N." ordinal: the live
 * megamenu has 108 department entries and not one carries it ("Bishop Fire
 * Department" links to /collections/1-bishop-fire-department). The ordinal
 * orders the collections; the menu is ordered by position. §8a never names the
 * item, so the store's own convention decides.
 */
function megaMenuItemTitle(collectionTitle) {
  return String(collectionTitle || "").trim().replace(/^\d+\.\s*/, "").trim();
}

/*
 * Given the "Store" submenu items (in order), return the index at which the
 * new department item must be inserted: directly before the first public
 * store, i.e. directly after the last department store.
 */
function megaMenuInsertIndex(items) {
  const idx = (items || []).findIndex((it) => isPublicStoreTitle(it.title));
  return idx === -1 ? (items || []).length : idx;
}

/* ---------------------------------------------------------------------------
   §8c Helium: alphabetical insertion point
   ------------------------------------------------------------------------- */

function alphabeticalInsertIndex(values, newValue) {
  const cmp = (a, b) => String(a).localeCompare(String(b), "en", { sensitivity: "base" });
  let i = 0;
  while (i < values.length && cmp(values[i], newValue) < 0) i++;
  return i;
}

/* ---------------------------------------------------------------------------
   §12 report
   ------------------------------------------------------------------------- */

const NEEDS_DAN_ALWAYS = [
  "Pricing",
  "Cost per item",
  "Easify options",
  "Final review",
  "Setting products Active",
  "Sending the store link to the department rep"
];

function emptyReport() {
  return { completed: [], needsDan: [...NEEDS_DAN_ALWAYS], missingInformation: [], warnings: [] };
}

module.exports = {
  // standard text
  LOGO_DISCLAIMER,
  LOGO_DISCLAIMER_HTML,
  NON_STOCK_NOTICE,
  NON_STOCK_NOTICE_HTML,
  // constants
  VENDOR_ONE_WEEK,
  VENDOR_NON_STOCK,
  VENDORS,
  TAG_EMBROIDERED,
  TAG_UNIFORM,
  OPTION_COLOR,
  OPTION_SIZE,
  OPTION_STYLE,
  DECORATION_PRINT,
  DECORATION_EMBROIDERY,
  COLOR_CODES_SEED,
  ALPHA_SIZES,
  TALL_SIZES,
  YOUTH_SIZES,
  HAT_SIZES,
  MOCKUP_SIZE,
  BANNER_WIDTH,
  BANNER_HEIGHT,
  NEEDS_DAN_ALWAYS,
  PUBLIC_STORE_TITLES,
  PATCH_PREFIXES,
  // sizes / decorations / colours
  normalizeSize,
  parseDecorationCode,
  normalizeDecorations,
  decorationFileStem,
  matchDecorationFiles,
  normalizeColorName,
  resolveColorCode,
  proposeColorCodes,
  // department codes
  proposeDepartmentCodes,
  lookupDepartmentCode,
  validateDepartmentCode,
  significantWords,
  // names
  departmentFolderName,
  productionFolderName,
  collectionTitle,
  departmentTag,
  // products
  productTags,
  normalizeVendor,
  normalizeStyleNumber,
  styleName,
  buildSku,
  parseSku,
  expandProduct,
  defaultProductTitle,
  // descriptions
  buildProductDescriptionHtml,
  collectionDescriptionHtml,
  extractDescriptionParts,
  escapeHtml,
  // images
  mockupFileName,
  chooseBannerLogo,
  // shared settings
  isPublicStoreTitle,
  megaMenuInsertIndex,
  megaMenuItemTitle,
  alphabeticalInsertIndex,
  // report
  emptyReport
};

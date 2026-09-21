/*
 * Source-of-truth tables the Department Onboarding Agent reads from and adds
 * to — only with Dan's approval (Build Spec, Part 4):
 *
 *   department-codes   California MACS list (Drive doc "Department-ID-Agency-List")
 *                      plus every non-California / FN code already in use
 *   color-codes        Appendix A, cleaned up; new colours need approval
 *   blank-library      style number, brand, type, sizes, colours, fulfilment,
 *                      master product id, description data, blank photos
 *   standard-text      Appendix B
 *
 * Each table is one JSON document in the platform-config blob container:
 *   { rows: [...], proposals: [...], updatedAt, source }
 * Proposals are rows waiting for approval; approving one moves it into rows.
 */

const { jsonBlob, blobConfigured } = require("./platformBlob");
const rules = require("./onboardingRules");

const CONTAINER = "platform-config";
const TABLES = {
  "department-codes": { blob: "department-codes.json", key: "code" },
  "color-codes": { blob: "color-codes.json", key: "code" },
  "blank-library": { blob: "blank-library.json", key: "styleNumber" },
  "standard-text": { blob: "standard-text.json", key: "id" }
};

const cache = new Map();

/* ---------------------------------------------------------------------------
   Parsers for the Google Docs plain-text exports (tables come out as one cell
   per line, continuation cells prefixed with a tab).
   ------------------------------------------------------------------------- */

/*
 * Google Docs plain-text export: table cells are separated by "\n\t"; a line
 * break INSIDE a cell is a bare "\n" ("(NL3600) \n~$24"). Page headers between
 * tables ("CALIFORNIA MACS IDS 02_10_22") land inside a cell and are dropped.
 */
const PAGE_HEADER_RE = /CALIFORNIA MACS IDS/i;

function docCells(text) {
  return String(text || "")
    .replace(/^﻿/, "")
    .split(/\r?\n\t/)
    .map((cell) =>
      cell
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !PAGE_HEADER_RE.test(line))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    );
}

const MACS_CODE_RE = /^[A-Z]{2,4}(?:-[A-Z]{2,4})?$/;

/*
 * "Department-ID-Agency-List": repeating MACS-ID / AGENCY / CITY cells.
 * Returns [{ code, agency, city, source: "macs" }].
 */
function parseDepartmentCodeListText(text) {
  const cells = docCells(text);
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i].replace(/\*/g, "").trim();
    if (!MACS_CODE_RE.test(cell)) continue;
    if (cell === "MACS-ID" || cell === "AGENCY" || cell === "CITY") continue;
    const agency = String(cells[i + 1] || "").replace(/\*/g, "").trim();
    const city = String(cells[i + 2] || "").replace(/\*/g, "").trim();
    // A real row's agency cell is never itself a code and never a header.
    if (!agency || MACS_CODE_RE.test(agency) || /^(AGENCY|CITY)$/i.test(agency)) continue;
    if (/CALIFORNIA MACS IDS/i.test(agency)) continue;
    const key = `${cell}|${agency}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ code: cell, agency, city: MACS_CODE_RE.test(city) ? "" : city, source: "macs", state: cell.includes("-") ? cell.split("-")[0] : "CA" });
    i += MACS_CODE_RE.test(city) ? 1 : 2;
  }
  return rows;
}

/*
 * "FN Simple Stores Menu_Detailed": Item Name / Brand / Print-Embroidery /
 * "(STYLE) ~$price" cells. Returns blank-library seed rows.
 */
function parseStoresMenuText(text) {
  const cells = docCells(text);
  const rows = [];
  for (let i = 0; i < cells.length; i++) {
    const m = cells[i].match(/\(([A-Za-z0-9.\-]{2,})\)\s*(?:~?\$?\s*([0-9]+(?:\.[0-9]+)?)(?:\s*-\s*([0-9]+))?\s*(?:and up|\+)?)?/);
    if (!m) continue;
    const itemName = cells[i - 3];
    const brand = cells[i - 2];
    const decoration = cells[i - 1];
    if (!itemName || !brand || !decoration) continue;
    if (/^(Item Name|Brand)$/i.test(itemName)) continue;
    const dec = decoration.toLowerCase();
    rows.push({
      styleNumber: m[1].toUpperCase(),
      brand: brand.trim(),
      type: itemName.trim(),
      decoration: dec.includes("tailored") ? "tailored" : dec.includes("print") && dec.includes("embroidery") ? "print or embroidery" : dec.includes("embroidery") ? "embroidery" : "print",
      approxPrice: m[2] ? Number(m[2]) : null,
      fulfillmentDefault: dec.includes("tailored") ? rules.VENDOR_NON_STOCK : rules.VENDOR_ONE_WEEK,
      source: "stores-menu"
    });
  }
  return rows;
}

/*
 * Department codes already in use, read off Drive folder names:
 *   "Vacaville Fire Department (VAC)"  and  "(VAC) Vacaville Fire Department"
 */
function codesFromFolderNames(names) {
  const out = [];
  for (const name of names || []) {
    const s = String(name || "").trim();
    let m = s.match(/^\(([A-Z]{2,5})\)\s*(.*)$/);
    if (m) {
      out.push({ code: m[1], agency: m[2].trim(), source: "drive-omni" });
      continue;
    }
    m = s.match(/^(.+?)\s*\(([A-Z]{2,5})\)\s*$/);
    if (m) out.push({ code: m[2], agency: m[1].trim(), source: "drive-departments" });
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Table storage
   ------------------------------------------------------------------------- */

function seedFor(name) {
  const now = new Date().toISOString();
  if (name === "color-codes") {
    return { rows: rules.COLOR_CODES_SEED.map((r) => ({ status: "active", ...r, source: "appendix-a" })), proposals: [], updatedAt: now, source: "Build Spec Appendix A" };
  }
  if (name === "standard-text") {
    return {
      rows: [
        { id: "logo-disclaimer", title: "Logo disclaimer", text: rules.LOGO_DISCLAIMER, html: rules.LOGO_DISCLAIMER_HTML, use: "On every product with a digital mockup of a decoration." },
        { id: "non-stock-notice", title: rules.NON_STOCK_NOTICE.title, text: rules.NON_STOCK_NOTICE.paragraphs.join("\n\n"), html: rules.NON_STOCK_NOTICE_HTML, use: "Every department collection description, and every product whose Vendor is Non Stock Item." }
      ],
      proposals: [],
      updatedAt: now,
      source: "Build Spec Appendix B"
    };
  }
  return { rows: [], proposals: [], updatedAt: now, source: "" };
}

function assertTable(name) {
  if (!TABLES[name]) throw new Error(`Unknown reference table "${name}"`);
  return TABLES[name];
}

async function loadTable(name) {
  assertTable(name);
  if (cache.has(name)) return cache.get(name);
  let doc = null;
  if (blobConfigured()) {
    doc = await jsonBlob(CONTAINER, TABLES[name].blob).read(null);
  }
  if (!doc || !Array.isArray(doc.rows)) doc = seedFor(name);
  if (!Array.isArray(doc.proposals)) doc.proposals = [];
  cache.set(name, doc);
  return doc;
}

async function saveTable(name, doc) {
  assertTable(name);
  doc.updatedAt = new Date().toISOString();
  cache.set(name, doc);
  if (blobConfigured()) await jsonBlob(CONTAINER, TABLES[name].blob).write(doc);
  return doc;
}

function invalidate(name) {
  if (name) cache.delete(name);
  else cache.clear();
}

async function getRows(name) {
  return (await loadTable(name)).rows;
}

/*
 * Insert or update rows keyed by the table's key column. Existing rows keep
 * fields the update does not mention. Returns the number of rows changed.
 */
async function upsertRows(name, rows, { source = "", by = "" } = {}) {
  const table = assertTable(name);
  const doc = await loadTable(name);
  let changed = 0;
  for (const incoming of rows || []) {
    const key = String(incoming[table.key] || "").trim();
    if (!key) continue;
    const idx = doc.rows.findIndex((r) => String(r[table.key]).toUpperCase() === key.toUpperCase());
    const stamped = { ...incoming, [table.key]: key, updatedAt: new Date().toISOString(), ...(source ? { source } : {}), ...(by ? { updatedBy: by } : {}) };
    if (idx === -1) {
      doc.rows.push(stamped);
      changed++;
    } else {
      const before = JSON.stringify(doc.rows[idx]);
      doc.rows[idx] = { ...doc.rows[idx], ...stamped };
      if (JSON.stringify(doc.rows[idx]) !== before) changed++;
    }
  }
  await saveTable(name, doc);
  return changed;
}

async function removeRow(name, key) {
  const table = assertTable(name);
  const doc = await loadTable(name);
  const before = doc.rows.length;
  doc.rows = doc.rows.filter((r) => String(r[table.key]).toUpperCase() !== String(key).toUpperCase());
  await saveTable(name, doc);
  return before - doc.rows.length;
}

/*
 * Proposals: rows the agent wants to add (a new department code, a new colour
 * code) that must wait for Dan. A proposal carries where it came from so the
 * onboarding record can show its state.
 */
async function propose(name, row, { onboardingId = "", reason = "" } = {}) {
  const table = assertTable(name);
  const doc = await loadTable(name);
  const key = String(row[table.key] || "").trim();
  if (!key) throw new Error(`A ${name} proposal needs a ${table.key}`);
  const existingRow = doc.rows.find((r) => String(r[table.key]).toUpperCase() === key.toUpperCase());
  if (existingRow) throw new Error(`${table.key} ${key} is already on the ${name} table`);
  const existing = doc.proposals.find((p) => String(p.row[table.key]).toUpperCase() === key.toUpperCase() && p.status === "pending");
  if (existing) return existing;
  const proposal = {
    id: `${name}-${key}-${Date.now().toString(36)}`,
    table: name,
    row: { ...row, [table.key]: key },
    onboardingId,
    reason,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  doc.proposals.push(proposal);
  await saveTable(name, doc);
  return proposal;
}

async function decideProposal(name, proposalId, { approve, by = "", edits = null } = {}) {
  const table = assertTable(name);
  const doc = await loadTable(name);
  const proposal = doc.proposals.find((p) => p.id === proposalId);
  if (!proposal) throw new Error(`Proposal ${proposalId} not found on ${name}`);
  if (proposal.status !== "pending") return proposal;
  proposal.decidedAt = new Date().toISOString();
  proposal.decidedBy = by;
  if (approve) {
    const row = { ...proposal.row, ...(edits || {}), status: "active", approvedAt: proposal.decidedAt, approvedBy: by, source: proposal.row.source || "approved-proposal" };
    const key = String(row[table.key]).trim();
    const idx = doc.rows.findIndex((r) => String(r[table.key]).toUpperCase() === key.toUpperCase());
    if (idx === -1) doc.rows.push(row);
    else doc.rows[idx] = { ...doc.rows[idx], ...row };
    proposal.status = "approved";
    proposal.row = row;
  } else {
    proposal.status = "rejected";
  }
  await saveTable(name, doc);
  return proposal;
}

async function pendingProposals(name) {
  const doc = await loadTable(name);
  return doc.proposals.filter((p) => p.status === "pending");
}

/* ---------------------------------------------------------------------------
   Department code helpers on top of the table
   ------------------------------------------------------------------------- */

async function departmentCodeRows() {
  return getRows("department-codes");
}

/*
 * Every code that is taken: the MACS list, FN's own additions, and any code
 * observed in use (Drive folders, Shopify tags) that the caller passes in.
 */
async function takenDepartmentCodes(extra = []) {
  const rows = await departmentCodeRows();
  const taken = new Set(rows.map((r) => String(r.code).toUpperCase()));
  for (const c of extra) if (c) taken.add(String(c).toUpperCase());
  return taken;
}

async function lookupDepartment(name) {
  const rows = await departmentCodeRows();
  return rules.lookupDepartmentCode(name, rows);
}

/*
 * Colour helpers: the live table (seed + approved additions) is what the SKU
 * generator resolves against.
 */
async function colorTable() {
  return getRows("color-codes");
}

async function blankByStyleNumber(styleNumber) {
  const key = String(styleNumber || "").trim().toUpperCase();
  if (!key) return null;
  const rows = await getRows("blank-library");
  return rows.find((r) => String(r.styleNumber).toUpperCase() === key) || null;
}

/*
 * Remember a blank once it has been entered (Part 4: "Blank Product Library").
 * Merges non-empty fields only so a later onboarding never blanks out data.
 */
async function rememberBlank(blank, { by = "" } = {}) {
  const key = String(blank.styleNumber || "").trim().toUpperCase();
  if (!key) return null;
  const existing = (await blankByStyleNumber(key)) || {};
  const merged = { ...existing };
  for (const [k, v] of Object.entries(blank)) {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (Array.isArray(v) && Array.isArray(existing[k])) {
      merged[k] = [...new Set([...existing[k], ...v])];
    } else if (v && typeof v === "object" && !Array.isArray(v) && existing[k] && typeof existing[k] === "object") {
      merged[k] = { ...existing[k], ...v };
    } else {
      merged[k] = v;
    }
  }
  merged.styleNumber = key;
  await upsertRows("blank-library", [merged], { by });
  return merged;
}

async function standardText(id) {
  const rows = await getRows("standard-text");
  return rows.find((r) => r.id === id) || null;
}

async function summary() {
  const out = {};
  for (const name of Object.keys(TABLES)) {
    const doc = await loadTable(name);
    out[name] = { rows: doc.rows.length, pending: doc.proposals.filter((p) => p.status === "pending").length, updatedAt: doc.updatedAt, source: doc.source || "" };
  }
  return out;
}

module.exports = {
  TABLES,
  CONTAINER,
  parseDepartmentCodeListText,
  parseStoresMenuText,
  codesFromFolderNames,
  loadTable,
  saveTable,
  invalidate,
  getRows,
  upsertRows,
  removeRow,
  propose,
  decideProposal,
  pendingProposals,
  departmentCodeRows,
  takenDepartmentCodes,
  lookupDepartment,
  colorTable,
  blankByStyleNumber,
  rememberBlank,
  standardText,
  summary
};

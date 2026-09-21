/*
 * Department Onboarding Agent — the orchestrator (Build Spec Part 3, §1–§12).
 *
 * Every phase of an onboarding runs through here: the packet, the department
 * code, the Drive folders, the policy review, the product rows, the build
 * (mockups → collection → lock → products → shared settings → final check)
 * and the report. Nothing in this file decides a SKU, a tag, a vendor value,
 * a folder name or an insert position — those come from onboardingRules.js.
 * The model is only reached through onboardingPolicy / onboardingMockups.
 *
 * Three properties this file exists to guarantee:
 *
 *   1. ADDITIVE. The build never deletes. A re-run skips products that already
 *      exist (products[].shopify.productId + productExists), keeps the Drive
 *      files it already uploaded, and reuses the collection it already made.
 *      The Omni Printer folder is only ever READ — print files are downloaded
 *      as copies and never written back (§3, §5).
 *   2. APPROVAL-GATED. A proposed department code, a new colour code and every
 *      shared setting (Mega Menu, Flow, Helium) wait for Dan and land in
 *      approvals[] with who and when (§2.4, §8, §10).
 *   3. OBSERVABLE AND RESUMABLE. Progress is flushed into the record after
 *      every step with a heartbeat, exactly like intakeBuild.js, so a build
 *      killed by a deploy is picked back up by the watchdog in server.js.
 *
 * Collaborators are reached through dep() so the tests can inject fakes with
 * setDeps() — and so loading this module never pulls in sharp, the OpenAI SDK
 * or the Azure client until a real call needs them.
 */

const rules = require("./onboardingRules");

/* ---------------------------------------------------------------------------
   Injectable collaborators
   ------------------------------------------------------------------------- */

const LOADERS = {
  store: () => require("./onboardingStore"),
  shopify: () => require("./shopifyOnboarding"),
  shopifyCore: () => require("./shopify"),
  catalog: () => require("./catalog"),
  locksmith: () => require("./locksmith"),
  helium: () => require("./helium"),
  mockups: () => require("./onboardingMockups"),
  policy: () => require("./onboardingPolicy"),
  drive: () => require("./drive"),
  auth: () => require("./auth"),
  referenceTables: () => require("./referenceTables")
};

const loaded = new Map();
let injected = {};

function dep(name) {
  if (Object.prototype.hasOwnProperty.call(injected, name)) return injected[name];
  if (!loaded.has(name)) {
    const loader = LOADERS[name];
    if (!loader) throw new Error(`Unknown onboarding agent dependency "${name}"`);
    loaded.set(name, loader());
  }
  return loaded.get(name);
}

/**
 * Test hook: replace any subset of the collaborators
 * ({ store, shopify, shopifyCore, catalog, locksmith, helium, mockups,
 * policy, drive, auth, referenceTables }). setDeps(null) restores every
 * real module. Returns the previous overrides so a test can put them back.
 */
function setDeps(partial) {
  const previous = injected;
  injected = partial ? { ...injected, ...partial } : {};
  return previous;
}

const store = () => dep("store");
const shop = () => dep("shopify");
const shopCore = () => dep("shopifyCore");
const catalog = () => dep("catalog");
const locksmith = () => dep("locksmith");
const helium = () => dep("helium");
const mockups = () => dep("mockups");
const policy = () => dep("policy");
const drive = () => dep("drive");
const auth = () => dep("auth");
const tables = () => dep("referenceTables");

/* ---------------------------------------------------------------------------
   Small shared helpers
   ------------------------------------------------------------------------- */

const FOLDER_MIME = "application/vnd.google-apps.folder";
const POLICY_TEXT_CAP = 20000;
const DEPARTMENT_CODE_TAG_RE = /^[A-Z]{3,4}$/;
const LIST_MATCH_AUTO_APPROVE = 0.95;
// What upsertRows stamps on rows imported from the Drive document, and
// therefore what "the list has already been imported" looks like on disk.
const DEPARTMENT_LIST_SOURCE = "Department-ID-Agency-List";

function badRequest(message) {
  const error = new Error(message);
  error.code = "BAD_REQUEST";
  return error;
}

function clean(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function errorText(error) {
  return String(error?.message || error || "unknown error");
}

function nowIso() {
  return new Date().toISOString();
}

/* Every step of every phase leaves a trace: an event on the record always, and
   a build log line too while a build owns the record. */
function note(record, { type = "note", message = "", by = "" } = {}, build = null) {
  store().appendEvent(record, { type, message, by });
  if (build) store().buildLog(record, message);
  return record;
}

function recordApproval(record, { kind, subject, decision = "approved", by = "" }) {
  if (!Array.isArray(record.approvals)) record.approvals = [];
  record.approvals.push({ kind, subject: clean(subject), decision, by: clean(by), at: nowIso() });
  return record;
}

function productById(record, productId) {
  if (!clean(productId)) return null;
  return (record.products || []).find((p) => p.id === productId) || null;
}

function onlyRowForStyle(record, styleNumber) {
  const want = clean(styleNumber).toUpperCase();
  if (!want) return null;
  const hits = (record.products || []).filter((p) => clean(p.styleNumber).toUpperCase() === want);
  return hits.length === 1 ? hits[0] : null;
}

function departmentCode(record) {
  return record?.department?.code?.value || "";
}

function storefrontDomain() {
  return String(process.env.SHOPIFY_STOREFRONT_DOMAIN || "fnsimple.com")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "") || "fnsimple.com";
}

function storefrontCollectionUrl(handle) {
  const h = clean(handle).replace(/^\/+|\/+$/g, "");
  return h ? `https://${storefrontDomain()}/collections/${h}` : "";
}

/* The record only ever stores names for production files; the id is needed to
   download a copy, so both live in drive.productionFiles. */
function productionFileNames(record) {
  return (record?.drive?.productionFiles || []).map((f) => f.name).filter(Boolean);
}

function productionFilesForValidation(record) {
  // Only match decoration codes against the folder once it has actually been
  // read — an unread folder is "unknown", not "empty", and must not produce
  // "no print-ready file" errors on every row.
  return record?.drive?.productionFilesReadAt ? productionFileNames(record) : null;
}

/* ---------------------------------------------------------------------------
   §1 capabilities — what this deployment can actually do right now
   ------------------------------------------------------------------------- */

const MEGA_MENU_CACHE_MS = 5 * 60 * 1000;
let megaMenuCache = { at: 0, value: null };

async function megaMenuCapability() {
  if (megaMenuCache.value && Date.now() - megaMenuCache.at < MEGA_MENU_CACHE_MS) return megaMenuCache.value;
  let value;
  try {
    const read = await shop().readMegaMenu();
    value = read.available
      ? { readable: true, writable: true, reason: "" }
      : { readable: false, writable: false, reason: read.reason || "The Mega Menu could not be read." };
  } catch (error) {
    value = { readable: false, writable: false, reason: errorText(error) };
  }
  // Reading needs read_online_store_navigation and writing needs the write
  // scope; only an actual menuUpdate proves the write scope, so "writable"
  // means "worth attempting" — applyMegaMenuInsert reports ACCESS_DENIED and
  // the item falls back to a checklist.
  megaMenuCache = { at: Date.now(), value };
  return value;
}

async function capabilities() {
  const megaMenu = await megaMenuCapability();
  let forms = [];
  try {
    forms = helium().configuredForms();
  } catch {
    forms = [];
  }
  return {
    storage: Boolean(store().storeConfigured()),
    shopify: Boolean(shopCore().shopifyConnected()),
    drive: Boolean(auth().googleConnected()),
    imageModel: require("./azureOpenai").imageModel(),
    locksmith: { configured: Boolean(locksmith().configured()) },
    helium: { forms },
    megaMenu,
    omniPrinterFolder: clean(process.env.GDRIVE_OMNI_PRINTER_FOLDER_ID),
    departmentCodeDoc: clean(process.env.DEPARTMENT_CODE_LIST_DOC_ID)
  };
}

/* ---------------------------------------------------------------------------
   Phase 1 — the packet
   ------------------------------------------------------------------------- */

const FIELD_KINDS = { policies: "policy", artwork: "artwork", contacts: "contacts", other: "other" };

/* multer hands back either { field: [file] } (upload.fields) or a flat array
   (upload.array); both shapes arrive here. */
function flattenFiles(files) {
  if (!files) return [];
  if (Array.isArray(files)) return files.filter(Boolean);
  const out = [];
  for (const [field, list] of Object.entries(files)) {
    for (const file of list || []) if (file) out.push({ ...file, fieldname: file.fieldname || field });
  }
  return out;
}

/*
 * §6.3 banner order needs a role on every artwork file. The file name is the
 * only hint the packet carries, so it seeds the role and Dan can correct it;
 * "scramble" wins over "chest" because a scramble file is often named
 * "VFD-scramble-front.png".
 */
function defaultArtworkRole(name) {
  const n = String(name || "");
  if (/scramble/i.test(n)) return "scramble";
  if (/chest|front|f01/i.test(n)) return "chest";
  if (/back|b01/i.test(n)) return "back";
  return "";
}

async function describePacketFile(file, kind, log) {
  const out = { text: "", description: "", role: "" };
  if (kind === "artwork") {
    out.role = defaultArtworkRole(file.originalname);
    out.description = await policy().describeArtwork(file, { onLog: log });
    return out;
  }
  if (kind === "policy" || kind === "contacts" || kind === "other") {
    const text = await policy().extractPacketText(file, { onLog: log });
    out.text = String(text || "").slice(0, POLICY_TEXT_CAP);
  }
  return out;
}

async function storePacketFiles(id, files, { kind = null, log = () => {} } = {}) {
  const stored = [];
  for (const file of files) {
    if (!file || !file.buffer) continue;
    const fileKind = kind || FIELD_KINDS[file.fieldname] || "other";
    const asset = await store().putAsset(id, {
      name: file.originalname || "file",
      contentType: file.mimetype || "application/octet-stream",
      buffer: file.buffer,
      kind: fileKind
    });
    const extra = await describePacketFile(file, fileKind, log);
    stored.push({
      assetId: asset.assetId,
      name: asset.name,
      kind: fileKind,
      contentType: asset.contentType,
      size: asset.size,
      driveFileId: "",
      driveUrl: "",
      role: extra.role,
      text: extra.text,
      description: extra.description
    });
  }
  return stored;
}

/**
 * Phase 1: open the record, store every packet file as an asset, read the
 * policies and describe the artwork. Never touches Shopify or Drive.
 */
async function createOnboarding({ payload = {}, files = [], by = "" } = {}) {
  const departmentName = clean(payload.departmentName);
  if (!departmentName) throw badRequest("Department name is required.");
  const created = await store().createOnboarding({
    departmentName,
    state: payload.state,
    storeOrdinal: payload.storeOrdinal,
    storeName: payload.storeName,
    contacts: payload.contacts,
    notes: payload.notes,
    by
  });
  const list = flattenFiles(files);
  if (!list.length) return created;
  const stored = await storePacketFiles(created.id, list);
  return store().updateOnboarding(created.id, (record) => {
    record.packet.files.push(...stored);
    note(record, { type: "packet", message: `${stored.length} packet file(s) added`, by });
    return record;
  });
}

/**
 * Add files to an existing record. `kind` decides where they land:
 *   blank → products[].blankPhotos[color][face]
 *   proof → products[].proofs[decorationCode]
 *   print → a packet file of kind "print" (a print file Dan uploaded by hand)
 *   anything else → packet.files
 */
async function addFiles(id, { files = [], kind = "other", productId = "", color = "", face = "front", decorationCode = "", role = "", by = "" } = {}) {
  const list = flattenFiles(files);
  if (!list.length) throw badRequest("No files were uploaded.");
  const wanted = clean(kind).toLowerCase() || "other";

  if (wanted === "blank" || wanted === "proof") {
    const record = await store().getOnboarding(id);
    if (!productById(record, productId)) throw badRequest(`Product "${productId}" is not on this onboarding.`);
    if (wanted === "blank" && !clean(color)) throw badRequest("A colour is required for a blank photo.");
    if (wanted === "proof" && !clean(decorationCode)) throw badRequest("A decoration code is required for an embroidery proof.");
    /* One slot, one file. Storing several and keeping the last wrote the rest
       into blob storage with nothing pointing at them — invisible in the
       record, unreachable by removeFile, and paid for forever. Refusing is
       both cheaper and clearer than cleaning up afterwards. */
    if (list.length > 1) {
      throw badRequest(
        wanted === "blank"
          ? "A blank photo is one file per colour and face — upload them one at a time."
          : "A proof is one file per decoration code — upload them one at a time."
      );
    }
  }

  const stored = await storePacketFiles(id, list, { kind: wanted });
  return store().updateOnboarding(id, (record) => {
    if (wanted === "blank") {
      const product = productById(record, productId);
      const faceKey = clean(face).toLowerCase() === "back" ? "back" : "front";
      const colorKey = clean(color);
      if (!product.blankPhotos[colorKey]) product.blankPhotos[colorKey] = {};
      product.blankPhotos[colorKey][faceKey] = stored[stored.length - 1].assetId;
      note(record, { type: "files", message: `Blank photo added for ${product.styleNumber || product.id} ${colorKey} ${faceKey}`, by });
      return record;
    }
    if (wanted === "proof") {
      const product = productById(record, productId);
      const codeKey = clean(decorationCode).toUpperCase();
      product.proofs[codeKey] = stored[stored.length - 1].assetId;
      note(record, { type: "files", message: `Embroidery proof added for ${product.styleNumber || product.id} ${codeKey}`, by });
      return record;
    }
    for (const file of stored) {
      if (clean(role)) file.role = clean(role).toLowerCase();
      record.packet.files.push(file);
    }
    note(record, { type: "files", message: `${stored.length} ${wanted} file(s) added`, by });
    return record;
  });
}

/** Remove one asset and every reference to it. Drive copies are left alone. */
async function removeFile(id, assetId, { by = "" } = {}) {
  await store().deleteAsset(id, assetId);
  return store().updateOnboarding(id, (record) => {
    const removed = record.packet.files.filter((f) => f.assetId === assetId).map((f) => f.name);
    record.packet.files = record.packet.files.filter((f) => f.assetId !== assetId);
    for (const product of record.products) {
      for (const [color, faces] of Object.entries(product.blankPhotos || {})) {
        for (const [face, value] of Object.entries(faces || {})) {
          if (value === assetId) delete product.blankPhotos[color][face];
        }
        if (!Object.keys(product.blankPhotos[color] || {}).length) delete product.blankPhotos[color];
      }
      for (const [code, value] of Object.entries(product.proofs || {})) {
        if (value === assetId) delete product.proofs[code];
      }
      product.mockups = (product.mockups || []).filter((m) => m.assetId !== assetId);
    }
    if (record.collection.bannerAssetId === assetId) record.collection.bannerAssetId = "";
    note(record, { type: "files", message: `Removed ${removed[0] || assetId}`, by });
    return record;
  });
}

/* ---------------------------------------------------------------------------
   Phase 2 — setup: department code, Drive folders, policy review
   ------------------------------------------------------------------------- */

/* §2.3 "Check that the proposed code isn't already used." Codes in use are
   read off the two Drive parents' folder names and off the Shopify product
   tags. Both are best-effort: a disconnected Drive must not stop the lookup,
   it only makes the collision check weaker, and that is said out loud. */
async function observedCodes(warnings) {
  const codes = [];
  const seen = [];

  for (const [label, parentId] of [
    ["Departments", process.env.GDRIVE_PARENT_FOLDER_ID],
    ["Omni Printer", process.env.GDRIVE_OMNI_PRINTER_FOLDER_ID]
  ]) {
    if (!clean(parentId)) {
      warnings.push(`The ${label} folder id is not configured, so codes in use there were not checked.`);
      continue;
    }
    try {
      const folders = await drive().listFilesInFolder(parentId, { mimeType: FOLDER_MIME });
      const names = folders.map((f) => f.name);
      seen.push(...tables().codesFromFolderNames(names));
    } catch (error) {
      warnings.push(`Drive folder names in ${label} could not be read (${errorText(error)}), so codes in use there were not checked.`);
    }
  }

  try {
    const tags = await shop().allProductTags();
    for (const tag of tags) {
      const value = clean(tag).toUpperCase();
      if (DEPARTMENT_CODE_TAG_RE.test(value)) seen.push({ code: value, agency: "", source: "shopify-tag" });
    }
  } catch (error) {
    warnings.push(`Shopify product tags could not be read (${errorText(error)}), so codes in use there were not checked.`);
  }

  for (const row of seen) if (row.code) codes.push(row.code.toUpperCase());
  return { codes: [...new Set(codes)], rows: seen };
}

/*
 * §2.1 says to SEARCH the Drive file "Department ID Agency List". That search
 * runs against the department-codes reference table, so on a platform where
 * nobody has pressed "Sync from Drive" the table is empty and the search
 * silently matches nothing — the agent would propose a code for a department
 * that is already on the official list. So the first setup that finds the
 * table without any imported rows imports them itself.
 *
 * Rows FN added by hand (source "fn"/"onboarding") do not count as the list:
 * the check looks for rows that came from the document.
 */
async function ensureDepartmentCodeList(warnings, by = "") {
  const docId = clean(process.env.DEPARTMENT_CODE_LIST_DOC_ID);
  if (!docId) {
    warnings.push("DEPARTMENT_CODE_LIST_DOC_ID is not set, so the Department Code List was not searched.");
    return 0;
  }
  try {
    const rows = await tables().getRows("department-codes");
    /* upsertRows stamps its own `source` over the parsed row's, so the stored
       rows read "Department-ID-Agency-List" and never "macs". Checking only
       for "macs" meant the guard never fired and every single setup re-imported
       a thousand agencies. Both spellings count as "already imported". */
    if (rows.some((row) => row.source === DEPARTMENT_LIST_SOURCE || row.source === "macs")) return 0;
    const text = await drive().exportFileText(docId, "text/plain");
    const parsed = tables().parseDepartmentCodeListText(text);
    if (!parsed.length) {
      warnings.push("The Department Code List document was read but no agencies could be parsed from it.");
      return 0;
    }
    return await tables().upsertRows("department-codes", parsed, { source: DEPARTMENT_LIST_SOURCE, by: by || "setup" });
  } catch (error) {
    warnings.push(`The Department Code List could not be imported (${errorText(error)}).`);
    return 0;
  }
}

/**
 * §2: look the department up on the Department Code List, auto-approve an
 * unambiguous hit, otherwise propose codes and wait for Dan. When the code is
 * already approved this continues straight into the folders, the packet upload
 * and the policy review.
 */
async function runSetup(id, { by = "" } = {}) {
  let record = await store().getOnboarding(id);
  if (!clean(record.department.name)) throw badRequest("The onboarding has no department name.");

  if (record.department.code.approved && record.department.code.value) return continueSetup(id, { by });

  const warnings = [];
  const observed = await observedCodes(warnings);
  await ensureDepartmentCodeList(warnings, by);
  let matches = [];
  try {
    matches = await tables().lookupDepartment(record.department.name);
  } catch (error) {
    warnings.push(`The Department Code List could not be read (${errorText(error)}).`);
  }
  const taken = await tables().takenDepartmentCodes(observed.codes);
  const top = matches[0] || null;
  /* The list scores on the agency NAME alone, and fire department names repeat
     across states. Auto-approving a same-named California agency for an
     out-of-state department would put another department's code in this one's
     SKUs, so a state that disagrees drops through to Dan. */
  const wantState = clean(record.department.state).toUpperCase();
  const topState = clean(top?.state).toUpperCase();
  const stateConflict = Boolean(top && wantState && topState && wantState !== topState);
  if (stateConflict) {
    warnings.push(
      `"${top.agency}" (${top.code}) is on the Department Code List but in ${topState}, and this department is in ${wantState} — approve a code rather than inheriting that one.`
    );
  }

  if (top && !stateConflict && Number(top.score) >= LIST_MATCH_AUTO_APPROVE) {
    record = await store().updateOnboarding(id, (r) => {
      r.department.code = {
        value: String(top.code).toUpperCase(),
        source: "list",
        approved: true,
        approvedAt: nowIso(),
        approvedBy: by || "Department Code List",
        candidates: [],
        matches: matches.map(matchRow)
      };
      r.status = "setup";
      r.phase = "setup";
      recordApproval(r, { kind: "code", subject: `${r.department.code.value} (on the Department Code List as "${top.agency}")`, by: by || "list" });
      for (const w of warnings) note(r, { type: "warning", message: w, by });
      note(r, { type: "code", message: `Department code ${r.department.code.value} found on the Department Code List (${top.agency}).`, by });
      return r;
    });
    return continueSetup(id, { by });
  }

  const candidates = rules.proposeDepartmentCodes(record.department.name, { taken }).map((candidate) => {
    const owner = observed.rows.find((r) => r.code === candidate.code && clean(r.agency)) || null;
    return { ...candidate, agency: owner ? owner.agency : agencyForCode(matches, candidate.code) };
  });

  return store().updateOnboarding(id, (r) => {
    r.department.code.candidates = candidates;
    r.department.code.matches = matches.map(matchRow);
    r.department.code.source = r.department.code.source || "proposed";
    r.status = "setup";
    r.phase = "setup";
    for (const w of warnings) note(r, { type: "warning", message: w, by });
    note(r, {
      type: "code",
      message: candidates.length
        ? `${r.department.name} is not on the Department Code List. Proposed: ${candidates.map((c) => `${c.code}${c.inUse ? " (in use)" : ""}`).join(", ")}. Waiting for approval.`
        : `No department code could be proposed for ${r.department.name}. Enter one by hand.`,
      by
    });
    return r;
  });
}

function matchRow(row) {
  return { code: String(row.code || "").toUpperCase(), agency: clean(row.agency), city: clean(row.city), state: clean(row.state), score: Number(row.score) || 0 };
}

function agencyForCode(matches, code) {
  const hit = (matches || []).find((m) => String(m.code).toUpperCase() === code);
  return hit ? clean(hit.agency) : "";
}

function sameAgency(a, b) {
  /* Compare WORD LISTS, never joined strings. A character-prefix test made
     "Ross Fire Department" the same agency as "Ross Valley Fire Department"
     and "Ripon" the same as "Riponville", which would hand one department's
     code to another — the exact collision §2.3 exists to prevent. A shorter
     name still matches a longer one, but only on whole-word boundaries. */
  const left = rules.significantWords(a);
  const right = rules.significantWords(b);
  if (!left.length || !right.length) return false;
  /* Exact word-list equality. significantWords already strips the boilerplate
     ("City of Vacaville FD" and "Vacaville Fire Department" both reduce to
     ["VACAVILLE"]), so what is left really is the identity of the agency. A
     prefix rule would still call "Ross" and "Ross Valley" the same department;
     erring towards "different" only costs Dan a confirmation, while erring the
     other way hands away a code that is already in use. */
  return left.length === right.length && left.every((word, i) => word === right[i]);
}

/**
 * §2.4: Dan approves the code. A code already owned by a DIFFERENT agency is
 * refused outright — reusing one would collide in SKUs, tags and file names.
 */
async function approveCode(id, { code, by = "" } = {}) {
  const valid = rules.validateDepartmentCode(code);
  if (valid.error) throw badRequest(valid.error);
  const record = await store().getOnboarding(id);
  const name = record.department.name;

  const rows = await tables().departmentCodeRows();
  const owner = rows.find((row) => String(row.code).toUpperCase() === valid.code);
  const isNew = !owner;
  if (owner && clean(owner.agency) && !sameAgency(owner.agency, name)) {
    throw badRequest(`Department code ${valid.code} is already used by "${clean(owner.agency)}". Pick a different code.`);
  }

  if (isNew) {
    // A code Dan approves becomes part of the source of truth so the next
    // onboarding sees it as taken (Part 4, "tables the agent adds to").
    try {
      const proposal = await tables().propose(
        "department-codes",
        { code: valid.code, agency: name, state: record.department.state || "", source: "onboarding" },
        { onboardingId: id, reason: `Approved for ${name}` }
      );
      await tables().decideProposal("department-codes", proposal.id, { approve: true, by });
    } catch {
      // Already on the table (a race, or added by hand between the read and
      // here) — nothing to add, and nothing worth failing the approval over.
    }
  }

  await store().updateOnboarding(id, (r) => {
    const source = r.department.code.candidates.some((c) => c.code === valid.code) ? "proposed" : "manual";
    r.department.code = {
      ...r.department.code,
      value: valid.code,
      source: r.department.code.source === "list" && r.department.code.value === valid.code ? "list" : source,
      approved: true,
      approvedAt: nowIso(),
      approvedBy: clean(by)
    };
    recordApproval(r, { kind: "code", subject: valid.code, by });
    note(r, { type: "code", message: `Department code ${valid.code} approved${isNew ? " and added to the Department Code List" : ""}.`, by });
    return r;
  });

  return continueSetup(id, { by });
}

/* Once the code is approved the rest of §2–§4 can run unattended. Drive
   failures degrade to warnings: a missing folder must not lose the packet. */
async function continueSetup(id, { by = "" } = {}) {
  await ensureDriveFolders(id, { by });
  await uploadPacketToDrive(id, { by });
  await refreshProductionFiles(id, { by, quiet: true });
  await reviewPolicy(id, { by });
  return store().updateOnboarding(id, (r) => {
    r.status = r.status === "packet" || r.status === "setup" ? "inputs" : r.status;
    r.phase = r.phase === "packet" || r.phase === "setup" ? "inputs" : r.phase;
    return r;
  });
}

/**
 * §3: "Departments/<Name> (<CODE>)" with a "Product Images" subfolder, and
 * "Omni Printer/(<CODE>) <Name>". Find-or-create only: an existing folder is
 * reused, never trashed and never overwritten.
 */
async function ensureDriveFolders(id, { by = "" } = {}) {
  const record = await store().getOnboarding(id);
  const code = departmentCode(record);
  if (!code) throw badRequest("The department code must be approved before the Drive folders are created.");
  const name = record.department.name;
  const parentId = clean(process.env.GDRIVE_PARENT_FOLDER_ID);
  const omniId = clean(process.env.GDRIVE_OMNI_PRINTER_FOLDER_ID);
  const found = { departmentFolder: null, productImages: null, productionFolder: null };
  const warnings = [];

  if (!parentId) warnings.push("GDRIVE_PARENT_FOLDER_ID is not set, so the department folder was not created.");
  else {
    try {
      found.departmentFolder = await drive().ensureSubfolder(rules.departmentFolderName(name, code), parentId);
      found.productImages = await drive().ensureSubfolder("Product Images", found.departmentFolder.id);
    } catch (error) {
      warnings.push(`The department folder could not be created (${errorText(error)}).`);
    }
  }

  if (!omniId) warnings.push("GDRIVE_OMNI_PRINTER_FOLDER_ID is not set, so the production folder was not created.");
  else {
    try {
      found.productionFolder = await drive().ensureSubfolder(rules.productionFolderName(name, code), omniId);
    } catch (error) {
      warnings.push(`The production folder could not be created (${errorText(error)}).`);
    }
  }

  return store().updateOnboarding(id, (r) => {
    if (found.departmentFolder) {
      r.drive.departmentFolderId = found.departmentFolder.id;
      r.drive.departmentFolderUrl = found.departmentFolder.webViewLink || `https://drive.google.com/drive/folders/${found.departmentFolder.id}`;
      note(r, { type: "drive", message: `Department folder "${rules.departmentFolderName(r.department.name, code)}" ready.`, by });
    }
    if (found.productImages) r.drive.productImagesFolderId = found.productImages.id;
    if (found.productionFolder) {
      r.drive.productionFolderId = found.productionFolder.id;
      r.drive.productionFolderUrl = found.productionFolder.webViewLink || `https://drive.google.com/drive/folders/${found.productionFolder.id}`;
      note(r, { type: "drive", message: `Production folder "${rules.productionFolderName(r.department.name, code)}" ready.`, by });
    }
    for (const w of warnings) note(r, { type: "warning", message: w, by });
    return r;
  });
}

/* §3 "Save the packet here." A file already in the folder under the same name
   is left alone — the agent never uploads a second copy. */
async function uploadPacketToDrive(id, { by = "" } = {}) {
  const record = await store().getOnboarding(id);
  const folderId = record.drive.departmentFolderId;
  if (!folderId) return record;
  const pending = record.packet.files.filter((f) => !f.driveFileId);
  if (!pending.length) return record;

  let existing = [];
  try {
    existing = (await drive().listFilesInFolder(folderId)).map((f) => ({ id: f.id, name: f.name, url: f.webViewLink }));
  } catch (error) {
    return store().updateOnboarding(id, (r) => note(r, { type: "warning", message: `The department folder could not be listed (${errorText(error)}); packet files were not uploaded.`, by }));
  }

  const uploaded = [];
  const warnings = [];
  for (const file of pending) {
    const already = existing.find((f) => clean(f.name).toLowerCase() === clean(file.name).toLowerCase());
    if (already) {
      uploaded.push({ assetId: file.assetId, driveFileId: already.id, driveUrl: already.url || "" });
      continue;
    }
    try {
      const asset = await store().getAsset(id, file.assetId);
      if (!asset) continue;
      const created = await drive().uploadBuffer({ originalname: file.name, mimetype: asset.contentType, buffer: asset.buffer }, folderId);
      uploaded.push({ assetId: file.assetId, driveFileId: created.id, driveUrl: created.webViewLink || "" });
    } catch (error) {
      warnings.push(`"${file.name}" could not be uploaded to Drive (${errorText(error)}).`);
    }
  }

  return store().updateOnboarding(id, (r) => {
    for (const up of uploaded) {
      const file = r.packet.files.find((f) => f.assetId === up.assetId);
      if (file) {
        file.driveFileId = up.driveFileId;
        file.driveUrl = up.driveUrl;
      }
    }
    if (uploaded.length) note(r, { type: "drive", message: `${uploaded.length} packet file(s) in the department folder.`, by });
    for (const w of warnings) note(r, { type: "warning", message: w, by });
    return r;
  });
}

/** Re-read the department's Omni Printer folder (§10: SKUs must match these names). */
async function refreshProductionFiles(id, { by = "", quiet = false } = {}) {
  const record = await store().getOnboarding(id);
  const folderId = record.drive.productionFolderId;
  if (!folderId) {
    if (quiet) return record;
    throw badRequest("The production folder does not exist yet — run setup first.");
  }
  let files;
  try {
    files = await drive().listFilesInFolder(folderId);
  } catch (error) {
    if (quiet) return store().updateOnboarding(id, (r) => note(r, { type: "warning", message: `The production folder could not be listed (${errorText(error)}).`, by }));
    throw error;
  }
  return store().updateOnboarding(id, (r) => {
    r.drive.productionFiles = files.map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime || "" }));
    r.drive.productionFilesReadAt = nowIso();
    note(r, { type: "drive", message: `${files.length} print-ready file(s) in the production folder.`, by });
    return r;
  });
}

/**
 * §4: read the policy and artwork, list confirmed vs missing, draft the rep
 * email, and write both into the department folder as Google Docs. The email
 * is never sent.
 */
async function reviewPolicy(id, { by = "" } = {}) {
  const record = await store().getOnboarding(id);
  const artwork = record.packet.files
    .filter((f) => f.kind === "artwork")
    .map((f) => ({ name: f.name, role: f.role, description: f.description }));
  const policyText = record.packet.files
    .filter((f) => f.kind === "policy" && f.text)
    .map((f) => f.text)
    .join("\n\n");
  const review = await policy().reviewPolicy({
    departmentName: record.department.name,
    repName: record.department.contacts[0]?.name || "",
    policyText,
    artwork,
    knownProducts: record.products.length ? record.products : record.policyReview.suggestedProducts,
    notes: record.packet.notes
  });

  const docs = await writeReviewDocs(record, review, by);

  return store().updateOnboarding(id, (r) => {
    r.policyReview = {
      ...r.policyReview,
      reviewedAt: nowIso(),
      confirmed: review.confirmed || [],
      missing: review.missing || [],
      questions: review.questions || [],
      emailDraft: review.emailDraft || { subject: "", body: "" },
      suggestedProducts: review.suggestedProducts || [],
      driveDocId: docs.reviewDocId || r.policyReview.driveDocId,
      driveDocUrl: docs.reviewDocUrl || r.policyReview.driveDocUrl,
      emailDocUrl: docs.emailDocUrl || r.policyReview.emailDocUrl || ""
    };
    note(r, {
      type: "review",
      message: `Policy reviewed: ${(review.confirmed || []).length} confirmed, ${(review.missing || []).length} missing. Rep email drafted (not sent).`,
      by
    });
    for (const w of docs.warnings) note(r, { type: "warning", message: w, by });
    return r;
  });
}

async function writeReviewDocs(record, review, by) {
  const out = { reviewDocId: "", reviewDocUrl: "", emailDocUrl: "", warnings: [] };
  const folderId = record.drive.departmentFolderId;
  if (!folderId) return out;
  const code = departmentCode(record);
  const suffix = `${record.department.name}${code ? ` (${code})` : ""}`;
  const wanted = [
    { name: `Policy Review — ${suffix}`, html: policy().reviewDocHtml({ departmentName: record.department.name, review, artwork: record.packet.files.filter((f) => f.kind === "artwork") }), key: "review" },
    { name: `Rep Email Draft — ${suffix}`, html: policy().emailDraftHtml(review.emailDraft || {}), key: "email" }
  ];

  let existing = [];
  try {
    existing = await drive().listFilesInFolder(folderId);
  } catch (error) {
    out.warnings.push(`The department folder could not be listed (${errorText(error)}); the review documents were not written.`);
    return out;
  }

  for (const doc of wanted) {
    // A doc with the same name is Dan's copy of this review; a second one
    // would just be noise in the folder.
    const already = existing.find((f) => clean(f.name).toLowerCase() === doc.name.toLowerCase());
    const file = already || (await drive().uploadHtmlDocument(doc.name, doc.html, folderId).catch((error) => {
      out.warnings.push(`"${doc.name}" could not be written to Drive (${errorText(error)}).`);
      return null;
    }));
    if (!file) continue;
    if (doc.key === "review") {
      out.reviewDocId = file.id;
      out.reviewDocUrl = file.webViewLink || "";
    } else {
      out.emailDocUrl = file.webViewLink || "";
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Phase 3 — product rows
   ------------------------------------------------------------------------- */

/*
 * Validate and save the product list. Every save re-runs the §10 rules: SKU
 * preview, decoration files matched against the production folder, colours
 * resolved (an unknown colour becomes a proposal on the Color Code List),
 * vendor exact, print and embroidery never mixed.
 */
async function saveProducts(id, products, { by = "" } = {}) {
  if (!Array.isArray(products)) throw badRequest("products must be an array of rows.");
  const record = await store().getOnboarding(id);
  const code = departmentCode(record);
  if (!code) throw badRequest("Approve the department code before saving product rows.");
  const colorTable = await tables().colorTable();
  const productionFiles = productionFilesForValidation(record);

  const rows = [];
  const proposals = [];
  const warnedStyleChanges = [];
  // Server-owned state: produced by a build, never sent by the form, and only
  // meaningful for the blank it was produced for.
  const BUILD_OWNED = ["shopify", "mockups", "blankPhotos", "proofs", "sourceProduct", "buildState", "buildError"];
  // An id may back exactly one incoming row. Without this, two fresh rows that
  // share a style number both resolved to the same stored row and one of them
  // vanished from the save without a word.
  const claimed = new Set();
  const usedIds = new Set();
  for (let i = 0; i < products.length; i++) {
    const incoming = products[i] || {};
    // A row the console sends back carries its id; a row typed fresh does not,
    // so an unambiguous style number is the fallback key — without it a re-save
    // would silently drop the photos and proofs already attached to that row.
    let existing = productById(record, incoming.id) || (incoming.id ? null : onlyRowForStyle(record, incoming.styleNumber));
    if (existing && claimed.has(existing.id)) existing = null;
    if (existing) claimed.add(existing.id);

    /* The id is a slot, not an identity. When the row in that slot is now a
       different blank, everything the previous build produced for it — its
       Shopify product, its mockups, the photos and proofs uploaded for that
       garment — belongs to the old style and would otherwise be inherited by
       the new one. Keep the slot, drop the history. */
    const styleChanged =
      existing && clean(existing.styleNumber).toUpperCase() !== clean(incoming.styleNumber).toUpperCase() && clean(incoming.styleNumber);
    const carried = existing ? { ...existing } : {};
    if (styleChanged) for (const key of BUILD_OWNED) delete carried[key];

    let nextId = incoming.id || existing?.id || `p${i + 1}`;
    while (usedIds.has(nextId)) nextId = `p${rows.length + 1}-${usedIds.size}`;
    usedIds.add(nextId);

    // A saved row carries state the console form does not send back (photos,
    // proofs, mockups, the Shopify ids); merging keeps a re-save from wiping it.
    const merged = store().normalizeProduct({ ...carried, ...incoming, id: nextId }, i);
    if (styleChanged) {
      warnedStyleChanges.push(`${merged.styleNumber || "a row"} replaced ${existing.styleNumber} — its mockups and Shopify product were not carried over.`);
    }

    const blank = await tables().blankByStyleNumber(merged.styleNumber).catch(() => null);
    if (blank) {
      if (!clean(merged.brand) && blank.brand) merged.brand = blank.brand;
      if (!clean(merged.type) && blank.type) merged.type = blank.type;
      if (!clean(merged.fulfillment) && blank.fulfillment) merged.fulfillment = blank.fulfillment;
      if (!clean(merged.sourceProduct.id) && blank.masterProductId) merged.sourceProduct = { ...merged.sourceProduct, id: blank.masterProductId, kind: "master" };
    }

    const expanded = rules.expandProduct(merged, { departmentCode: code, colorTable, productionFiles });
    merged.validation = {
      ok: expanded.ok,
      errors: expanded.errors,
      warnings: expanded.warnings,
      assumptions: expanded.assumptions,
      skuPreview: expanded.variants.map((v) => v.sku).filter(Boolean)
    };
    if (!clean(merged.title)) merged.title = expanded.product.title;
    if (!clean(merged.decorationMethod) && expanded.product.decorationMethod) merged.decorationMethod = expanded.product.decorationMethod;

    for (const color of expanded.product.colors) {
      if (color.code || !color.proposal) continue;
      proposals.push({ color: color.name, code: color.proposal });
    }

    if (merged.styleNumber) {
      await tables()
        .rememberBlank(
          {
            styleNumber: merged.styleNumber,
            brand: merged.brand,
            type: merged.type,
            sizes: expanded.product.sizes,
            colors: expanded.product.colors.map((c) => c.name),
            fulfillment: expanded.product.fulfillment || merged.fulfillment
          },
          { by }
        )
        .catch(() => null);
    }
    rows.push(merged);
  }

  const proposed = [];
  for (const p of proposals) {
    try {
      const proposal = await tables().propose("color-codes", { code: p.code, color: p.color, status: "proposed" }, { onboardingId: id, reason: `New colour on ${record.department.name}` });
      proposed.push(`${p.color} → ${proposal.row.code}`);
    } catch {
      // Already proposed or already on the list; the validation error on the
      // row is what tells Dan the colour still needs approving.
    }
  }

  return store().updateOnboarding(id, (r) => {
    r.products = rows;
    if (r.status === "packet" || r.status === "setup") r.status = "inputs";
    if (r.phase === "packet" || r.phase === "setup") r.phase = "inputs";
    const bad = rows.filter((row) => row.validation.ok !== true).length;
    note(r, { type: "products", message: `${rows.length} product row(s) saved; ${bad} need attention.`, by });
    if (proposed.length) note(r, { type: "color", message: `Colour code proposal(s) waiting for approval: ${proposed.join(", ")}.`, by });
    // Losing a built product's mockups is never silent — Dan has to know the
    // row he edited is not the row that was built.
    for (const warning of warnedStyleChanges) note(r, { type: "warning", message: warning, by });
    return r;
  });
}

/** §10 COLOR: approve a new colour code, add it to the list, re-validate. */
async function proposeColor(id, { color, code, by = "" } = {}) {
  const name = clean(color);
  const value = clean(code).toUpperCase();
  if (!name) throw badRequest("A colour name is required.");
  if (!/^[A-Z0-9_]{2,4}$/.test(value)) throw badRequest(`"${code}" is not a colour code (2–4 letters, digits or underscore).`);
  const rows = await tables().colorTable();
  const owner = rows.find((row) => String(row.code).toUpperCase() === value);
  if (owner && rules.normalizeColorName(owner.color) !== rules.normalizeColorName(name)) {
    throw badRequest(`Colour code ${value} is already "${owner.color}" on the Color Code List. Pick a different code.`);
  }
  if (!owner) {
    let proposal;
    try {
      proposal = await tables().propose("color-codes", { code: value, color: name }, { onboardingId: id, reason: `Approved for ${name}` });
    } catch (error) {
      throw badRequest(errorText(error));
    }
    await tables().decideProposal("color-codes", proposal.id, { approve: true, by });
  }
  await store().updateOnboarding(id, (r) => {
    recordApproval(r, { kind: "color", subject: `${name} → ${value}`, by });
    note(r, { type: "color", message: `Colour code ${value} approved for "${name}".`, by });
    return r;
  });
  const record = await store().getOnboarding(id);
  return saveProducts(id, record.products, { by });
}

/* ---------------------------------------------------------------------------
   Phase 4 — the build
   ------------------------------------------------------------------------- */

const HEARTBEAT_EVERY_MS = 60 * 1000;
const STALE_WITH_HEARTBEAT_MS = 5 * 60 * 1000;
const STALE_WITHOUT_HEARTBEAT_MS = 15 * 60 * 1000;

// One build per onboarding at a time; several DIFFERENT onboardings may run at
// once, so the guard is per record (the platform runs a single replica).
const activeBuilds = new Map();

function newBuildState() {
  return { state: "running", startedAt: nowIso(), heartbeatAt: nowIso(), finishedAt: null, error: null, steps: [], log: [] };
}

function lastBuildActivity(build) {
  const stamps = [build?.startedAt, build?.heartbeatAt, ...(build?.steps || []).flatMap((s) => [s.startedAt, s.finishedAt])]
    .map((v) => Date.parse(v || ""))
    .filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : 0;
}

function buildLooksDead(build) {
  if (!build || build.state !== "running") return false;
  const staleAfter = build.heartbeatAt ? STALE_WITH_HEARTBEAT_MS : STALE_WITHOUT_HEARTBEAT_MS;
  return Date.now() - lastBuildActivity(build) > staleAfter;
}

function stepStart(build, key, label) {
  const step = { key, label, state: "running", startedAt: nowIso(), finishedAt: "", detail: "" };
  build.steps.push(step);
  return step;
}

function stepDone(step, detail = "") {
  step.state = "complete";
  step.detail = detail;
  step.finishedAt = nowIso();
}

function stepSkip(step, detail = "") {
  step.state = "skipped";
  step.detail = detail;
  step.finishedAt = nowIso();
}

function stepFail(step, error) {
  step.state = "failed";
  step.detail = errorText(error);
  step.finishedAt = nowIso();
}

/* Every flush doubles as a liveness beat: the watchdog reads heartbeatAt to
   tell a slow build from one whose process died. */
async function saveBuild(id, build, mutate) {
  return store().updateOnboarding(id, async (record) => {
    build.heartbeatAt = nowIso();
    record.build = build;
    if (mutate) await mutate(record);
    return record;
  });
}

function buildLogger(build) {
  return (message) => {
    build.log.push(`${nowIso().slice(11, 19)} ${String(message == null ? "" : message)}`);
    if (build.log.length > 300) build.log.splice(0, build.log.length - 300);
  };
}

/**
 * Start (or refuse to double-start) a build. Fire-and-forget safe: all
 * progress lands in the record. `wait` awaits the run (used by tests and by
 * the resume watchdog).
 */
async function startBuild(id, { force = false, by = "", wait = false } = {}) {
  // Reserve the slot BEFORE any await: two concurrent starts must not both
  // pass the check.
  if (activeBuilds.has(id)) return { started: false, reason: "A build for this onboarding is already running.", build: null };
  const placeholder = { state: "starting" };
  activeBuilds.set(id, placeholder);

  let record;
  try {
    record = await store().getOnboarding(id);
  } catch (error) {
    activeBuilds.delete(id);
    throw error;
  }
  if (record.build?.state === "running" && !buildLooksDead(record.build) && !force) {
    activeBuilds.delete(id);
    return { started: false, reason: "This onboarding is already building.", build: record.build };
  }
  if (activeBuilds.get(id) !== placeholder) return { started: false, reason: "A build for this onboarding is already running.", build: null };

  const build = newBuildState();
  activeBuilds.set(id, build);
  // Step flushes are the normal heartbeat, but one image call can run for
  // minutes without one; this timer keeps the record fresh.
  const heartbeat = setInterval(() => {
    if (build.state === "running") saveBuild(id, build).catch(() => {});
  }, HEARTBEAT_EVERY_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const task = runBuild(id, build, { by })
    .catch(async (error) => {
      build.state = "failed";
      build.error = errorText(error);
      build.finishedAt = nowIso();
      await saveBuild(id, build, (r) => {
        r.status = "build-error";
        r.phase = "build";
        note(r, { type: "build", message: `Build failed: ${build.error}`, by }, build);
      }).catch(() => {});
    })
    .finally(() => {
      clearInterval(heartbeat);
      activeBuilds.delete(id);
    });

  if (wait) await task;
  return { started: true, build };
}

/** Whether a build for this onboarding is running in THIS process right now. */
function isBuildActive(id) {
  return activeBuilds.has(id);
}

function preflight(record) {
  const problems = [];
  if (!record.department.code.approved || !departmentCode(record)) problems.push("The department code is not approved yet.");
  if (!record.products.length) problems.push("No product rows have been saved.");
  for (const product of record.products) {
    if (product.validation?.ok !== true) {
      problems.push(`"${product.title || product.styleNumber || product.id}" has not passed validation: ${(product.validation?.errors || ["not validated"]).join("; ")}`);
    }
  }
  if (!shopCore().shopifyConnected()) problems.push("Shopify is not connected.");
  if (problems.length) throw badRequest(problems.join(" "));
}

async function runBuild(id, build, { by = "" } = {}) {
  const log = buildLogger(build);
  let record = await store().getOnboarding(id);
  const failures = [];

  let step = stepStart(build, "preflight", "Preflight");
  try {
    preflight(record);
    log(`Preflight passed: ${record.products.length} product row(s), department ${departmentCode(record)}.`);
    stepDone(step, `${record.products.length} product row(s) ready`);
  } catch (error) {
    stepFail(step, error);
    throw error;
  }
  record = await saveBuild(id, build, (r) => {
    r.status = "building";
    r.phase = "build";
    note(r, { type: "build", message: "Build started.", by }, build);
  });

  // §5 mockups — before the products, because the product images are these.
  for (const row of record.products) {
    const product = productById(record, row.id);
    step = stepStart(build, `mockups:${product.id}`, `Mockups — ${product.title || product.styleNumber || product.id}`);
    try {
      /* Mockups are the most expensive thing the agent does — one image-model
         call per face, per colour, per Style — and re-rendering them on a
         re-run also uploads a second copy of every image to Drive and strands
         the assets the last run wrote. A row that already has its images keeps
         them; `force` re-runs the build, it does not mean "spend it all
         again". Only rows with no usable render are redone. */
      const renderedAlready =
        Array.isArray(product.mockups) &&
        product.mockups.length > 0 &&
        product.mockups.every((m) => m && m.assetId && m.path !== "render-failed");
      if (renderedAlready) {
        log(`Mockups for ${product.title || product.id}: reusing ${product.mockups.length} image(s) from the previous run.`);
        stepDone(step, `${product.mockups.length} image(s) reused`);
        continue;
      }
      const made = await buildMockups(id, record, product, log);
      record = await saveBuild(id, build, (r) => {
        const target = productById(r, product.id);
        if (target) {
          target.mockups = made.mockups;
          target.buildState = "mockups";
        }
        for (const w of made.warnings) note(r, { type: "warning", message: w, by }, build);
      });
      stepDone(step, `${made.mockups.length} image(s)`);
    } catch (error) {
      stepFail(step, error);
      failures.push(`Mockups for ${product.title || product.id}: ${errorText(error)}`);
      log(`Mockups failed for ${product.title || product.id}: ${errorText(error)}`);
      record = await saveBuild(id, build);
    }
  }

  // §6 collection — created BEFORE any product.
  step = stepStart(build, "collection", "Collection");
  try {
    const collection = await buildCollection(id, record, log);
    record = await saveBuild(id, build, (r) => {
      r.collection = { ...r.collection, ...collection.collection };
      for (const w of collection.warnings) note(r, { type: "warning", message: w, by }, build);
      note(r, { type: "build", message: `Collection "${collection.collection.title}" ready.`, by }, build);
    });
    stepDone(step, collection.collection.title);
  } catch (error) {
    stepFail(step, error);
    await saveBuild(id, build);
    throw error; // No collection means no products to put in it.
  }

  // §7 lock
  step = stepStart(build, "lock", "Locksmith lock");
  try {
    const lock = await buildLock(record, log);
    record = await saveBuild(id, build, (r) => {
      r.lock = { ...r.lock, ...lock };
      note(r, { type: "lock", message: lock.status === "created" ? "Locksmith lock created." : "Locksmith is not configured — the lock is a checklist for Dan.", by }, build);
    });
    stepDone(step, lock.status);
  } catch (error) {
    stepFail(step, error);
    failures.push(`Lock: ${errorText(error)}`);
    record = await saveBuild(id, build, (r) => {
      r.lock = { ...r.lock, status: "error", error: errorText(error), checklist: locksmith().manualChecklist({ collectionTitle: r.collection.title, departmentTag: r.department.tag }) };
    });
  }

  // §9 products
  for (const row of record.products) {
    const product = productById(record, row.id);
    step = stepStart(build, `products:${product.id}`, `Product — ${product.title || product.styleNumber || product.id}`);
    try {
      if (product.shopify?.gid && (await catalog().productExists(product.shopify.gid))) {
        stepSkip(step, "already created");
        log(`${product.title || product.id} already exists in Shopify; skipped.`);
        record = await saveBuild(id, build, (r) => {
          const target = productById(r, product.id);
          if (target) target.buildState = "created";
        });
        continue;
      }
      const built = await buildProduct(id, record, product, log);
      record = await saveBuild(id, build, (r) => {
        const target = productById(r, product.id);
        if (target) {
          target.sourceProduct = built.sourceProduct;
          target.shopify = built.shopify;
          target.buildState = "created";
          target.buildError = "";
        }
        for (const w of built.warnings) note(r, { type: "warning", message: w, by }, build);
      });
      stepDone(step, `${built.shopify.variantCount} variants`);
    } catch (error) {
      // One product must not sink the run — the rest still get built and the
      // report says which one needs Dan.
      stepFail(step, error);
      failures.push(`${product.title || product.id}: ${errorText(error)}`);
      log(`${product.title || product.id} failed: ${errorText(error)}`);
      record = await saveBuild(id, build, (r) => {
        const target = productById(r, product.id);
        if (target) {
          target.buildState = "failed";
          target.buildError = errorText(error);
        }
      });
    }
  }

  // §8 shared settings — proposals only; applying needs a separate approval.
  step = stepStart(build, "shared-settings", "Shared settings");
  try {
    record = await proposeSharedSettings(id, { by });
    stepDone(step, "proposed; waiting for approval");
    log("Mega Menu, Flow and Helium changes proposed — none saved without approval.");
  } catch (error) {
    stepFail(step, error);
    failures.push(`Shared settings: ${errorText(error)}`);
  }
  record = await saveBuild(id, build);

  // §12 final check
  step = stepStart(build, "final-check", "Final check");
  try {
    record = await finalCheck(id, { by, build });
    stepDone(step, `${record.report.completed.length} done, ${record.report.missingInformation.length} missing`);
  } catch (error) {
    stepFail(step, error);
    failures.push(`Final check: ${errorText(error)}`);
  }

  const created = record.products.filter((p) => p.buildState === "created").length;
  build.state = failures.length ? (created ? "partial" : "failed") : "complete";
  build.error = failures.length ? failures.join(" | ") : null;
  build.finishedAt = nowIso();
  await saveBuild(id, build, (r) => {
    if (r.status !== "complete") r.status = failures.length ? (created ? "built-partial" : "build-error") : "built";
    r.phase = "report";
    note(r, { type: "build", message: `Build ${build.state}: ${created} product(s) created.`, by }, build);
  });
  return { state: build.state, created, failures };
}

/* §5 mockups for one product. Print artwork is a COPY downloaded from the
   Omni Printer folder — the source file is never touched. */
async function buildMockups(id, record, product, log) {
  const code = departmentCode(record);
  const colorTable = await tables().colorTable();
  const expanded = rules.expandProduct(product, { departmentCode: code, colorTable, productionFiles: productionFilesForValidation(record) });
  const warnings = [];
  const codes = [...new Set(expanded.product.styles.flatMap((s) => s.decorationCodes))];
  const artwork = {};

  /* Split on the decoration METHOD, not the letter. P## (a sewn patch) is
     applied decoration like embroidery — treating it as print made the agent
     look for a print file named CODE-P01 that does not exist and never load
     the proof that does. */
  const parsedCodes = codes.map((c) => ({ code: c, parsed: rules.parseDecorationCode(c) }));
  const printCodes = parsedCodes.filter((p) => p.parsed.method === rules.DECORATION_PRINT).map((p) => p.code);
  const appliedCodes = parsedCodes.filter((p) => p.parsed.method === rules.DECORATION_EMBROIDERY).map((p) => p.code);
  if (printCodes.length) {
    const { matched, missing } = rules.matchDecorationFiles(code, printCodes, productionFileNames(record));
    for (const [decoration, fileName] of Object.entries(matched)) {
      const file = (record.drive.productionFiles || []).find((f) => f.name === fileName);
      if (!file?.id) continue;
      try {
        const copy = await drive().downloadFileBuffer(file.id);
        artwork[decoration] = { buffer: copy.buffer, mimetype: copy.mimeType, name: copy.name };
        log(`Downloaded a copy of ${copy.name} for ${decoration}.`);
      } catch (error) {
        warnings.push(`The print file for ${rules.decorationFileStem(code, decoration)} could not be downloaded (${errorText(error)}).`);
      }
    }
    for (const decoration of missing) {
      warnings.push(`No print-ready file named ${rules.decorationFileStem(code, decoration)} in the Omni Printer folder.`);
    }
  }

  for (const decoration of appliedCodes) {
    const assetId = product.proofs?.[decoration];
    if (!assetId) {
      warnings.push(`No ${decoration.startsWith("P") ? "patch artwork" : "embroidery proof"} uploaded for ${decoration}.`);
      continue;
    }
    const asset = await store().getAsset(id, assetId);
    if (asset) artwork[decoration] = { buffer: asset.buffer, mimetype: asset.contentType, name: asset.name };
  }

  const blankPhotos = {};
  for (const [color, faces] of Object.entries(product.blankPhotos || {})) {
    blankPhotos[color] = {};
    for (const [face, assetId] of Object.entries(faces || {})) {
      const asset = await store().getAsset(id, assetId);
      if (asset) blankPhotos[color][face] = { buffer: asset.buffer, mimetype: asset.contentType };
    }
  }

  const rendered = await mockups().renderProductMockups({
    product: { ...product, ...expanded.product },
    departmentCode: code,
    artwork,
    blankPhotos,
    onLog: log
  });

  const out = [];
  for (const image of rendered) {
    const entry = {
      color: image.color,
      colorCode: image.colorCode || null,
      style: image.style || null,
      face: image.face,
      assetId: "",
      driveFileId: "",
      driveUrl: "",
      fileName: image.fileName,
      path: image.path,
      // Why it is not a render, straight from the renderer.
      reason: image.reason || "",
      /* Where the garment itself came from: "photo" (Dan's), "supplier" (a real
         catalogue picture) or "generated" (invented by the image model).
         `path` says what was done TO the image; this says whether the garment
         in it is real. Dropping it made a photograph and an invention look
         identical everywhere downstream. */
      base: image.base || null,
      verified: image.verified || null,
      warnings: image.warnings || []
    };
    warnings.push(...(image.warnings || []));
    if (image.buffer) {
      const asset = await store().putAsset(id, { name: image.fileName, contentType: "image/png", buffer: image.buffer, kind: "mockup" });
      entry.assetId = asset.assetId;
      if (record.drive.productImagesFolderId) {
        try {
          const file = await drive().uploadGeneratedImage(image.fileName, image.buffer, record.drive.productImagesFolderId);
          entry.driveFileId = file.id;
          entry.driveUrl = file.webViewLink || "";
        } catch (error) {
          warnings.push(`${image.fileName} could not be uploaded to the Product Images folder (${errorText(error)}).`);
        }
      }
    }
    out.push(entry);
  }
  log(`${product.title || product.id}: ${out.length} mockup image(s).`);
  return { mockups: out, warnings };
}

/* §6 collection: title, banner (§6.3 logo order), Non-Stock notice. */
async function buildCollection(id, record, log) {
  const warnings = [];
  const title = record.collection.title || rules.collectionTitle(record.department.storeOrdinal > 1 && record.department.storeName ? record.department.storeName : record.department.name, record.department.storeOrdinal);

  let bannerBuffer = null;
  let bannerAssetId = "";
  let bannerLogoAssetId = "";
  let bannerLogoReason = "";
  let bannerDriveUrl = "";
  const choice = rules.chooseBannerLogo(record.packet.files.filter((f) => f.kind === "artwork" || f.role).map((f) => ({ ...f, id: f.assetId })));
  if (!choice) {
    warnings.push("No artwork is marked as the department's pick, scramble, chest or back logo, so the collection has no banner.");
  } else {
    try {
      const asset = await store().getAsset(id, choice.assetId);
      if (!asset) throw new Error("the artwork file is missing from the record");
      const banner = await mockups().renderBanner({ logoBuffer: asset.buffer, logoMimetype: asset.contentType });
      bannerBuffer = banner.buffer;
      bannerLogoAssetId = choice.assetId;
      bannerLogoReason = choice.reason || "";
      const stored = await store().putAsset(id, { name: `${title.replace(/[^\w]+/g, "-")}-banner.png`, contentType: "image/png", buffer: banner.buffer, kind: "banner" });
      bannerAssetId = stored.assetId;
      if (record.drive.departmentFolderId) {
        try {
          const file = await drive().uploadGeneratedImage(stored.name, banner.buffer, record.drive.departmentFolderId);
          bannerDriveUrl = file.webViewLink || "";
        } catch (error) {
          warnings.push(`The banner could not be uploaded to Drive (${errorText(error)}).`);
        }
      }
      log(`Banner rendered from ${choice.name} (${bannerLogoReason}).`);
    } catch (error) {
      warnings.push(`The banner could not be rendered (${errorText(error)}).`);
    }
  }

  const result = await shop().ensureDepartmentCollection(
    { title, descriptionHtml: rules.collectionDescriptionHtml(), bannerBuffer, bannerAlt: `${record.department.name} banner` },
    { onLog: log }
  );
  warnings.push(...(result.warnings || []));

  return {
    warnings,
    collection: {
      title: result.title || title,
      id: String(result.id || ""),
      gid: result.gid || "",
      handle: result.handle || "",
      url: shop().collectionAdminUrl(result.id),
      storefrontUrl: storefrontCollectionUrl(result.handle),
      bannerAssetId,
      bannerDriveUrl,
      bannerLogoAssetId,
      bannerLogoReason,
      descriptionSet: true
    }
  };
}

/* §7 lock: the API when Locksmith is configured, a checklist when it is not. */
async function buildLock(record, log) {
  const title = record.collection.title;
  const tag = record.department.tag;
  if (!locksmith().configured()) {
    log("Locksmith is not configured (LOCKSMITH_ACCESS_TOKEN); handing Dan the checklist.");
    return {
      status: "manual",
      checklist: locksmith().manualChecklist({ collectionTitle: title, departmentTag: tag }),
      error: "",
      // Dan has not built the lock yet, so nothing about it is established.
      settings: { enabled: null, protectProducts: null, hideFromNavigation: null, hideFromLists: null }
    };
  }
  const created = await locksmith().createCollectionLock(
    {
      collectionLegacyId: record.collection.id,
      collectionTitle: title,
      departmentTag: tag,
      collectionHandle: record.collection.handle,
      storefrontDomain: storefrontDomain()
    },
    { onLog: log }
  );
  return {
    status: "created",
    locksmithLockId: created.id == null ? "" : String(created.id),
    secretCode: created.secretCode || "",
    secretLink: created.secretLink || "",
    tagKey: tag,
    checklist: [],
    error: ""
  };
}

/* §9 one product: duplicate a source, overwrite the copy, attach the mockups. */
async function buildProduct(id, record, product, log) {
  const warnings = [];
  const code = departmentCode(record);
  const colorTable = await tables().colorTable();
  const expanded = rules.expandProduct(product, { departmentCode: code, colorTable, productionFiles: productionFilesForValidation(record) });
  if (!expanded.ok) throw badRequest(expanded.errors.join("; "));

  const source = clean(product.sourceProduct?.id)
    ? { id: product.sourceProduct.id, title: product.sourceProduct.title, kind: product.sourceProduct.kind || "master", url: product.sourceProduct.url || "" }
    : await shop().findSourceProduct(expanded.product.styleNumber);
  if (!source?.id) {
    throw new Error(`No product to duplicate for style ${expanded.product.styleNumber}. Create a master draft product for this blank, or add one to the Blank Product Library.`);
  }
  log(`Duplicating ${source.kind === "master" ? "the master draft" : "the most recent"} product "${source.title || source.id}".`);

  let sourceDetail = null;
  try {
    sourceDetail = await shop().readProductForDuplication(source.id);
  } catch (error) {
    warnings.push(`The source product could not be read for its description (${errorText(error)}).`);
  }

  const title = clean(product.title) || expanded.product.title || sourceDetail?.title || expanded.product.styleNumber;
  const duplicate = await shop().duplicateProduct(source.id, title);

  const hasMockup = (product.mockups || []).some((m) => m.path === "render");
  const descriptionData = await policy().descriptionDataFor(
    {
      brand: expanded.product.brand,
      styleNumber: expanded.product.styleNumber,
      type: expanded.product.type,
      colors: expanded.product.colors.map((c) => c.name),
      sourceDescriptionHtml: sourceDetail?.descriptionHtml || "",
      vendor: expanded.product.fulfillment
    },
    { onLog: log }
  );
  if (descriptionData.note) warnings.push(`${title}: ${descriptionData.note}`);
  const descriptionHtml = policy().buildDescription({
    brand: expanded.product.brand,
    styleNumber: expanded.product.styleNumber,
    descriptionData,
    hasMockup,
    vendor: expanded.product.fulfillment
  });

  const defaults = sourceDetail?.variantDefaults || {};
  const result = await shop().setProduct(
    {
      productId: duplicate.id,
      sourceProductId: source.id,
      title,
      descriptionHtml,
      vendor: expanded.product.fulfillment,
      tags: expanded.product.tags,
      productType: sourceDetail?.productType || expanded.product.type,
      options: expanded.options,
      variants: expanded.variants.map((v) => ({ ...v, taxable: defaults.taxable !== false, tracked: Boolean(defaults.tracked), requiresShipping: defaults.requiresShipping !== false })),
      collectionGids: record.collection.gid ? [record.collection.gid] : []
    },
    { onLog: log }
  );
  warnings.push(...(result.warnings || []));

  const images = await mockupImages(id, product, result.variants, title);
  if (images.length) await shop().attachMockups(result.id, images, { onLog: log });
  else warnings.push(`${title}: no mockup images were attached.`);

  return {
    warnings,
    sourceProduct: { id: source.id, title: source.title || "", kind: source.kind || "", url: source.url || "" },
    shopify: { productId: result.legacyId, gid: result.id, url: result.url, variantCount: result.variants.length, createdAt: nowIso() }
  };
}

/*
 * §9.10: each variant gets the FRONT image that matches its Style and Color;
 * back images stay in the gallery. Fronts are listed first because Shopify
 * binds the first media offered for a variant (shopify.uploadProductImages).
 */
function variantIdsForMockup(variants, mockup) {
  return (variants || [])
    .filter((variant) => {
      const options = new Map((variant.selectedOptions || []).map((o) => [o.name, o.value]));
      if (rules.normalizeColorName(options.get(rules.OPTION_COLOR)) !== rules.normalizeColorName(mockup.color)) return false;
      if (mockup.style) return options.get(rules.OPTION_STYLE) === mockup.style;
      return true;
    })
    .map((variant) => variant.id);
}

async function mockupImages(id, product, variants, title) {
  const usable = (product.mockups || []).filter((m) => m.assetId);
  const ordered = [...usable.filter((m) => m.face === "front"), ...usable.filter((m) => m.face !== "front")];
  const images = [];
  for (const mockup of ordered) {
    const asset = await store().getAsset(id, mockup.assetId);
    if (!asset) continue;
    images.push({
      filename: mockup.fileName,
      buffer: asset.buffer,
      alt: `${title} — ${mockup.color}${mockup.style ? ` ${mockup.style}` : ""} ${mockup.face}`,
      variantIds: mockup.face === "front" ? variantIdsForMockup(variants, mockup) : []
    });
  }
  return images;
}

/* ---------------------------------------------------------------------------
   §8 shared settings
   ------------------------------------------------------------------------- */

function megaMenuChecklist({ collectionTitle, insertAfter, insertBefore }) {
  const steps = [
    'Content > Menus > Mega Menu > "Add menu item to store." Link it to the new collection.',
    `Name the item exactly "${collectionTitle}".`
  ];
  if (insertAfter && insertBefore) steps.push(`Drag it directly below "${insertAfter}" and directly above "${insertBefore}".`);
  else if (insertBefore) steps.push(`Drag it directly above "${insertBefore}" (the first public store).`);
  else if (insertAfter) steps.push(`Drag it directly below "${insertAfter}" (the last department store).`);
  else steps.push("Department stores are listed oldest to newest, above the public stores; place the new store directly below the last department store and directly above the first public store.");
  steps.push("Keep every existing entry. Save.");
  return steps;
}

/** §8: show Dan exactly what will change. Nothing is saved here. */
async function proposeSharedSettings(id, { by = "" } = {}) {
  const record = await store().getOnboarding(id);
  const title = record.collection.title;
  const tag = record.department.tag;

  const menu = {
    status: "manual",
    proposal: { insertAfter: "", insertBefore: "", index: 0, title, url: record.collection.storefrontUrl || "", newItem: null, collectionHandle: record.collection.handle || "", collectionGid: record.collection.gid || "" },
    checklist: [],
    error: ""
  };
  try {
    const read = await shop().readMegaMenu();
    if (read.available) {
      const proposal = shop().proposeMegaMenuInsert(read.menu, { title, collectionHandle: record.collection.handle, collectionGid: record.collection.gid });
      /* newItem/collectionHandle/collectionGid travel with the proposal
         because applyMegaMenuInsert re-reads the live menu and rebuilds the
         insert from them — a stored proposal without newItem cannot be
         applied at all, it just throws "needs the proposal to apply". */
      menu.proposal = {
        insertAfter: proposal.insertAfter || "",
        insertBefore: proposal.insertBefore || "",
        index: proposal.index,
        title,
        url: proposal.newItem?.url || "",
        newItem: proposal.newItem || null,
        collectionHandle: record.collection.handle || "",
        collectionGid: record.collection.gid || ""
      };
      menu.status = proposal.alreadyPresent ? "verified" : "proposed";
      menu.checklist = megaMenuChecklist({ collectionTitle: title, insertAfter: menu.proposal.insertAfter, insertBefore: menu.proposal.insertBefore });
      if (proposal.reason) menu.error = proposal.reason;
    } else {
      menu.error = read.reason || "";
      menu.checklist = megaMenuChecklist({ collectionTitle: title });
    }
  } catch (error) {
    menu.error = errorText(error);
    menu.checklist = megaMenuChecklist({ collectionTitle: title });
  }

  // A form the platform cannot read still gets a checklist; only the
  // verification is lost, so a failure here is never fatal.
  const forms = await helium()
    .checkAllForms(tag)
    .catch(() => []);

  return store().updateOnboarding(id, (r) => {
    r.sharedSettings.megaMenu = { ...r.sharedSettings.megaMenu, ...menu };
    r.sharedSettings.flow = { ...r.sharedSettings.flow, status: r.sharedSettings.flow.status === "confirmed" ? "confirmed" : "proposed", checklist: helium().flowChecklist({ departmentTag: tag }) };
    r.sharedSettings.helium = {
      ...r.sharedSettings.helium,
      status: r.sharedSettings.helium.status === "verified" ? "verified" : "proposed",
      forms,
      checklist: helium().manualChecklist({ departmentTag: tag, forms })
    };
    note(r, { type: "shared-settings", message: "Mega Menu, Flow and Helium changes proposed — nothing saved without approval.", by });
    return r;
  });
}

const SHARED_KINDS = { megaMenu: "menu", flow: "flow", helium: "helium" };

/**
 * §8: Dan approves one shared setting. `applied: true` means he made the
 * change by hand; otherwise the Mega Menu is applied through the API when the
 * scope allows it and becomes a checklist when it does not.
 */
async function approveSharedSetting(id, kind, { by = "", applied = false } = {}) {
  const key = clean(kind);
  // hasOwnProperty, not truthiness: "toString" and "constructor" are truthy on
  // any object literal, and neither equals "flow" or "helium", so they used to
  // fall through into the Mega Menu branch and try to apply a menu change.
  if (!Object.prototype.hasOwnProperty.call(SHARED_KINDS, key)) {
    throw badRequest(`"${kind}" is not a shared setting (megaMenu, flow or helium).`);
  }
  const record = await store().getOnboarding(id);

  if (key === "flow") {
    return store().updateOnboarding(id, (r) => {
      r.sharedSettings.flow = { ...r.sharedSettings.flow, status: "confirmed", confirmedAt: nowIso(), confirmedBy: clean(by) };
      recordApproval(r, { kind: "flow", subject: r.department.tag, by });
      note(r, { type: "shared-settings", message: `Shopify Flow condition confirmed for "${r.department.tag}".`, by });
      return r;
    });
  }

  if (key === "helium") {
    /* A read that FAILED is not a confirmation. Falling back to the forms
       already on the record and stamping them "confirmed" would report a tag
       verified on data nobody just looked at. */
    let forms = null;
    let readError = "";
    try {
      forms = await helium().checkAllForms(record.department.tag);
    } catch (error) {
      readError = errorText(error);
    }
    return store().updateOnboarding(id, (r) => {
      const stamped = (forms || r.sharedSettings.helium.forms || []).map((f) => ({ ...f, confirmedAt: nowIso() }));
      /* §8c names three forms: Edit Account, Registration and the Registration
         backup copy. "Verified" means every one of them was actually READ and
         actually carries the tag with the same capitalisation — a form the
         agent could not read, or one that is not configured at all, is
         unverified, not satisfied. Dan still confirms those by hand. */
      const readable = stamped.filter((f) => f.public !== false);
      const expected = helium().EXPECTED_FORM_LABELS || [];
      const covered = expected.every((label) =>
        readable.some((f) => clean(f.label).toLowerCase() === clean(label).toLowerCase() && f.present && f.exactCase)
      );
      const verified = !readError && readable.length > 0 && readable.every((f) => f.present && f.exactCase) && covered;
      r.sharedSettings.helium = {
        ...r.sharedSettings.helium,
        forms: stamped,
        status: verified ? "verified" : "partial",
        error: readError
      };
      recordApproval(r, { kind: "helium", subject: r.department.tag, by });
      const unverified = expected.filter(
        (label) => !readable.some((f) => clean(f.label).toLowerCase() === clean(label).toLowerCase() && f.present && f.exactCase)
      );
      note(r, {
        type: "shared-settings",
        message: verified
          ? `Helium forms verified for "${r.department.tag}".`
          : `Helium confirmed by ${clean(by) || "an operator"} for "${r.department.tag}" — still unverified here: ${unverified.join(", ") || readError || "a form could not be read"}.`,
        by
      });
      return r;
    });
  }

  const menu = record.sharedSettings.megaMenu;
  const patch = { approvedAt: nowIso(), approvedBy: clean(by) };
  if (applied) {
    patch.status = "applied";
    patch.appliedAt = nowIso();
  } else {
    const capability = await megaMenuCapability();
    if (!capability.writable) {
      patch.status = "manual";
      patch.error = capability.reason || "The Mega Menu cannot be written with the current scopes.";
    } else {
      try {
        const read = await shop().readMegaMenu();
        if (!read.available) throw new Error(read.reason || "The Mega Menu could not be read.");
        const proposal = shop().proposeMegaMenuInsert(read.menu, { title: record.collection.title, collectionHandle: record.collection.handle, collectionGid: record.collection.gid });
        // The recomputed proposal must match what Dan approved; applyMegaMenuInsert
        // refuses a stale one rather than inserting in the wrong place.
        /* Carry what Dan APPROVED, not what we just recomputed, or the
           staleness check inside applyMegaMenuInsert compares the live menu
           against itself and can never fail. The record stores an absent
           neighbour as "", which has to survive as null: a new store that
           lands FIRST in the list legitimately has no item above it, and a
           truthiness fallback would silently replace that with whatever the
           fresh read produced. */
        const approvedNeighbour = (stored, fresh) => (stored === undefined ? fresh : stored === "" ? null : stored);
        proposal.index = menu.proposal?.index ?? proposal.index;
        proposal.insertAfter = approvedNeighbour(menu.proposal?.insertAfter, proposal.insertAfter);
        proposal.insertBefore = approvedNeighbour(menu.proposal?.insertBefore, proposal.insertBefore);
        const result = await shop().applyMegaMenuInsert(read.menu, proposal, {});
        patch.status = "applied";
        patch.appliedAt = nowIso();
        patch.error = "";
        patch.menuItemId = result.menuItemId || "";
      } catch (error) {
        patch.status = "manual";
        patch.error = errorText(error);
      }
    }
  }

  return store().updateOnboarding(id, (r) => {
    r.sharedSettings.megaMenu = { ...r.sharedSettings.megaMenu, ...patch };
    recordApproval(r, { kind: "menu", subject: r.collection.title, by });
    note(r, {
      type: "shared-settings",
      message: patch.status === "applied" ? `Mega Menu item "${r.collection.title}" saved.` : `Mega Menu change approved but not writable here (${patch.error || "no scope"}); Dan applies the checklist.`,
      by
    });
    return r;
  });
}

/** §8/§12: read the shared settings back and record what is actually true. */
async function verifySharedSettings(id, { by = "" } = {}) {
  const record = await store().getOnboarding(id);
  const tag = record.department.tag;

  let menu = null;
  try {
    menu = await shop().verifyMegaMenu(record.collection.title);
  } catch (error) {
    menu = { available: false, present: false, reason: errorText(error) };
  }
  const forms = await helium()
    .checkAllForms(tag)
    .catch(() => record.sharedSettings.helium.forms || []);

  return store().updateOnboarding(id, (r) => {
    if (menu.available && menu.present) {
      r.sharedSettings.megaMenu = { ...r.sharedSettings.megaMenu, status: "verified", verifiedAt: nowIso(), error: "" };
    } else if (!menu.available) {
      r.sharedSettings.megaMenu = { ...r.sharedSettings.megaMenu, error: menu.reason || "The Mega Menu could not be read." };
    }
    const verifiable = forms.filter((f) => f.public !== false);
    const present = verifiable.filter((f) => f.present && f.exactCase);
    r.sharedSettings.helium = {
      ...r.sharedSettings.helium,
      forms,
      status: verifiable.length && present.length === verifiable.length ? "verified" : present.length ? "partial" : r.sharedSettings.helium.status
    };
    note(r, {
      type: "shared-settings",
      message: `Verified: Mega Menu ${menu.present ? "present" : "not confirmed"}, Helium ${present.length}/${verifiable.length || 0} form(s) carry "${tag}".`,
      by
    });
    return r;
  });
}

/* ---------------------------------------------------------------------------
   §7 lock — manual record and API creation outside a build
   ------------------------------------------------------------------------- */

/** Record a lock Dan made by hand (or correct the one the API made). */
async function recordLock(id, { secretLink = "", secretCode = "", locksmithLockId = "", by = "" } = {}) {
  let inspected = null;
  if (clean(locksmithLockId)) {
    const record = await store().getOnboarding(id);
    try {
      inspected = await locksmith().verifyLock(clean(locksmithLockId), { departmentTag: record.department.tag });
    } catch (error) {
      inspected = { ok: false, error: errorText(error) };
    }
  }
  return store().updateOnboarding(id, (r) => {
    r.lock = {
      ...r.lock,
      status: inspected?.ok ? "verified" : clean(locksmithLockId) ? "created" : "manual",
      locksmithLockId: clean(locksmithLockId) || r.lock.locksmithLockId,
      secretLink: clean(secretLink) || r.lock.secretLink,
      secretCode: clean(secretCode) || r.lock.secretCode,
      tagKey: r.department.tag,
      verifiedAt: inspected?.ok ? nowIso() : r.lock.verifiedAt,
      error: inspected?.error || ""
    };
    note(r, { type: "lock", message: inspected?.ok ? "Locksmith lock verified." : "Lock details recorded.", by });
    return r;
  });
}

/** Create the lock through the Locksmith API outside a build. */
async function createLock(id, { by = "" } = {}) {
  const record = await store().getOnboarding(id);
  if (!record.collection.id) throw badRequest("The collection must exist before the lock is created.");
  if (!locksmith().configured()) throw badRequest("LOCKSMITH_ACCESS_TOKEN is not set, so the lock must be created by hand — use the checklist.");
  const lock = await buildLock(record, () => {});
  return store().updateOnboarding(id, (r) => {
    r.lock = { ...r.lock, ...lock };
    note(r, { type: "lock", message: "Locksmith lock created.", by });
    return r;
  });
}

/* ---------------------------------------------------------------------------
   §12 final check and report
   ------------------------------------------------------------------------- */

function tagsOfOtherDepartments(tags, code) {
  return (tags || []).filter((tag) => DEPARTMENT_CODE_TAG_RE.test(clean(tag)) && clean(tag) !== code);
}

async function checkProduct(record, product, colorTable) {
  const code = departmentCode(record);
  const label = product.title || product.styleNumber || product.id;
  const issues = [];
  const warnings = [];
  if (!product.shopify?.gid) {
    issues.push(`${label} was not created in Shopify${product.buildError ? ` (${product.buildError})` : ""}.`);
    return { issues, warnings, ok: false };
  }

  let snapshot;
  try {
    snapshot = await shop().productSnapshot(product.shopify.gid);
  } catch (error) {
    warnings.push(`${label} could not be read back from Shopify (${errorText(error)}).`);
    return { issues, warnings, ok: false };
  }
  if (!snapshot) {
    issues.push(`${label} no longer exists in Shopify.`);
    return { issues, warnings, ok: false };
  }

  if (snapshot.status !== "DRAFT") issues.push(`${label} is ${snapshot.status}, not Draft.`);
  if (record.collection.gid && !snapshot.collections.some((c) => c.gid === record.collection.gid || String(c.id) === String(record.collection.id))) {
    issues.push(`${label} is not in "${record.collection.title}".`);
  }

  const expanded = rules.expandProduct(product, { departmentCode: code, colorTable, productionFiles: productionFilesForValidation(record) });
  /* §12 re-checks the rules against what is actually there NOW, so a row that
     stopped validating since it was built — a print file renamed in the Omni
     Printer folder, a colour code withdrawn — has to reopen the report rather
     than pass because it validated once. */
  for (const error of expanded.errors) issues.push(`${label}: ${error}`);
  for (const tag of expanded.product.tags) {
    if (!snapshot.tags.some((t) => clean(t) === tag)) issues.push(`${label} is missing the tag "${tag}".`);
  }
  const foreign = tagsOfOtherDepartments(snapshot.tags, code);
  if (foreign.length) issues.push(`${label} still carries another department's tag: ${foreign.join(", ")}.`);
  if (clean(snapshot.vendor) !== expanded.product.fulfillment) {
    issues.push(`${label} has Vendor "${snapshot.vendor}" — it must be exactly "${expanded.product.fulfillment}".`);
  }

  const expectedSkus = new Set(expanded.variants.map((v) => v.sku).filter(Boolean));
  const liveSkus = snapshot.variants.map((v) => clean(v.sku)).filter(Boolean);
  const duplicates = liveSkus.filter((sku, index) => liveSkus.indexOf(sku) !== index);
  if (duplicates.length) issues.push(`${label} has duplicate SKUs: ${[...new Set(duplicates)].join(", ")}.`);
  const unexpected = liveSkus.filter((sku) => !expectedSkus.has(sku));
  if (unexpected.length) issues.push(`${label} has SKUs that do not follow the rules: ${[...new Set(unexpected)].slice(0, 5).join(", ")}.`);
  const missingSkus = [...expectedSkus].filter((sku) => !liveSkus.includes(sku));
  if (missingSkus.length) issues.push(`${label} is missing ${missingSkus.length} SKU(s), e.g. ${missingSkus.slice(0, 3).join(", ")}.`);
  if (snapshot.variants.some((v) => !clean(v.sku))) issues.push(`${label} has variants with no SKU.`);
  if (snapshot.variants.some((v) => v.inventoryPolicy !== "CONTINUE")) issues.push(`${label} has variants without "Continue selling when out of stock".`);

  // §9.10 the storefront image must change with Style and Color, so every
  // Style+Color group needs its own front image.
  const groups = new Map();
  for (const variant of snapshot.variants) {
    const options = new Map((variant.selectedOptions || []).map((o) => [o.name, o.value]));
    const key = `${options.get(rules.OPTION_STYLE) || ""}|${options.get(rules.OPTION_COLOR) || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(variant);
  }
  const imageless = [...groups.entries()].filter(([, variants]) => variants.every((v) => !v.image?.url)).map(([key]) => key.replace("|", " ").trim());
  if (imageless.length) issues.push(`${label} has no front image for: ${imageless.join(", ")}.`);
  const hasBack = (product.mockups || []).some((m) => m.face === "back" && m.assetId);
  if (hasBack && snapshot.media.length <= groups.size) warnings.push(`${label}: the back image may not be attached (${snapshot.media.length} image(s) for ${groups.size} variant group(s)).`);

  const hasRenderedMockup = (product.mockups || []).some((m) => m.path === "render");
  if (hasRenderedMockup) {
    try {
      const live = await catalog().getProduct(snapshot.id);
      if (!clean(live.descriptionHtml).startsWith(rules.LOGO_DISCLAIMER_HTML)) {
        issues.push(`${label} has a decoration mockup, so its description must start with "${rules.LOGO_DISCLAIMER}".`);
      }
    } catch (error) {
      warnings.push(`${label}: the description could not be read back (${errorText(error)}).`);
    }
  }

  return { issues, warnings, ok: issues.length === 0 };
}

/**
 * §12: check everything against live Shopify, then report in four sections.
 * Never "complete" while anything is unresolved.
 */
/*
 * §7 measured from outside the store. The product count comes from what was
 * actually created in Shopify, not from the rows, because a collection that is
 * simply empty must never read as "closed to the public".
 */
async function lockAccessVerdict(record, { liveProductCount = null } = {}) {
  /*
   * Count PUBLISHED products, not created ones.
   *
   * §9.2 keeps every product Draft until Dan prices it, and a Draft product
   * renders nowhere. So a freshly built department shows zero products to the
   * public whether or not the lock works: "closed" proves nothing, and the
   * secret link looks broken when it is merely opening onto an empty store.
   * Measured on the first lock the agent ever created — 4 products, all Draft,
   * verdict closedToPublic=true / opensWithSecretLink=false, both meaningless.
   *
   * The lock's settings are still checked structurally against the Locksmith
   * API; this is only the from-outside proof, and it has to wait for launch.
   */
  const productCount = Number.isFinite(liveProductCount)
    ? liveProductCount
    : (record.products || []).filter((product) => clean(product?.shopify?.productId)).length;
  const base = {
    checked: false,
    closedToPublic: null,
    opensWithSecretLink: null,
    publicProductLinks: null,
    collectionUrl: "",
    productCount,
    pendingLaunch: false,
    reason: ""
  };
  if (!clean(record.collection?.handle)) return { ...base, reason: "The collection has no handle yet." };
  if (!(productCount > 0)) {
    return {
      ...base,
      pendingLaunch: true,
      reason: "Every product is still Draft, so the storefront shows nothing with or without the lock. Re-check once Dan has priced and published them."
    };
  }
  try {
    const verdict = await locksmith().checkPublicAccess({
      storefrontDomain: storefrontDomain(),
      collectionHandle: record.collection.handle,
      productCount,
      secretLink: record.lock?.secretLink || ""
    });
    return { ...base, ...verdict, productCount };
  } catch (error) {
    return { ...base, reason: `The storefront check failed: ${errorText(error)}` };
  }
}

async function finalCheck(id, { by = "", build = null } = {}) {
  let record = await store().getOnboarding(id);
  const report = rules.emptyReport();
  const unresolved = [];
  const code = departmentCode(record);
  const colorTable = await tables().colorTable();

  if (record.department.code.approved && code) report.completed.push(`Department code ${code} approved (${record.department.code.source || "manual"}).`);
  else unresolved.push("The department code is not approved.");

  if (record.drive.departmentFolderId) report.completed.push(`Drive folder "${rules.departmentFolderName(record.department.name, code)}" exists.`);
  else unresolved.push(`The Drive folder "${rules.departmentFolderName(record.department.name, code)}" does not exist.`);
  if (record.drive.productionFolderId) report.completed.push(`Production folder "${rules.productionFolderName(record.department.name, code)}" exists.`);
  else unresolved.push(`The production folder "${rules.productionFolderName(record.department.name, code)}" does not exist.`);

  // Products the PUBLIC can actually see; the lock proof below needs it.
  let liveProductCount = null;
  if (!record.collection.id) {
    unresolved.push("The department collection has not been created.");
  } else {
    try {
      const snapshot = await shop().collectionSnapshot(record.collection.id);
      if (!snapshot) unresolved.push(`Collection ${record.collection.id} no longer exists in Shopify.`);
      else {
        if (clean(snapshot.title) !== clean(record.collection.title)) unresolved.push(`The collection is titled "${snapshot.title}" — it must be "${record.collection.title}".`);
        else report.completed.push(`Collection "${snapshot.title}" created.`);
        if (clean(snapshot.descriptionHtml) !== clean(rules.collectionDescriptionHtml())) unresolved.push("The collection description is not the Non-Stock Item Notice.");
        else report.completed.push("Collection description is the Non-Stock Item Notice.");
        if (!snapshot.image?.url) unresolved.push("The collection has no banner image.");
        else report.completed.push("Collection banner set.");
        liveProductCount = (snapshot.products || []).filter((product) => String(product.status).toUpperCase() === "ACTIVE").length;
      }
    } catch (error) {
      report.warnings.push(`The collection could not be read back (${errorText(error)}).`);
    }
  }

  /* §7 / §12. A recorded secret link used to be enough to report the store as
     locked, which meant a lock nobody built — or one built with a box unticked
     — passed. Locksmith's option names are undocumented, so asserting them
     would prove nothing either. Check what the lock is FOR instead: the public
     must not be able to see the department's products, and the secret link
     must open them. */
  const access = await lockAccessVerdict(record, { liveProductCount });
  if (access.checked) {
    record = await store().updateOnboarding(record.id, (r) => {
      r.lock.access = {
        checkedAt: nowIso(),
        closedToPublic: access.closedToPublic,
        opensWithSecretLink: access.opensWithSecretLink,
        publicProductLinks: access.publicProductLinks,
        reason: access.reason || ""
      };
      return r;
    });
  }
  const lockRecorded =
    record.lock.status === "verified" || ((record.lock.status === "created" || record.lock.status === "manual") && clean(record.lock.secretLink));
  if (!lockRecorded) {
    unresolved.push(`The Locksmith lock is not confirmed (${record.lock.status}). ${record.lock.checklist?.length ? "Follow the lock checklist and record the secret link." : ""}`.trim());
  } else if (access.closedToPublic === false) {
    unresolved.push(`The department's products are still visible to the public at ${access.collectionUrl}. ${access.reason}`.trim());
  } else if (access.pendingLaunch) {
    /* Not a failure and not a pass: the proof is simply unavailable until the
       products are live. Blocking here would gate every onboarding on
       something §9.2 guarantees cannot be true yet. */
    report.needsDan.push(
      `After pricing and publishing, open ${access.collectionUrl} signed out to confirm the store is private, then open the secret link to confirm it lets you in.`
    );
  } else if (access.closedToPublic === null) {
    unresolved.push(`The lock could not be checked from outside, so the store is not confirmed private. ${access.reason}`.trim());
  } else if (access.opensWithSecretLink === false) {
    unresolved.push(`The store is private, but the recorded secret link does not open it. ${access.reason}`.trim());
  } else {
    report.completed.push(
      `Private store lock in place — the public sees none of the ${access.productCount} product(s)${
        access.opensWithSecretLink ? " and the secret link opens the store" : ""
      }${record.lock.secretLink ? `; secret link: ${record.lock.secretLink}` : ""}.`
    );
  }

  const menuStatus = record.sharedSettings.megaMenu.status;
  if (menuStatus === "verified" || menuStatus === "applied") report.completed.push(`Mega Menu carries "${record.collection.title}".`);
  else unresolved.push(`The Mega Menu item for "${record.collection.title}" is not confirmed (${menuStatus}).`);
  if (record.sharedSettings.flow.status === "confirmed") report.completed.push(`Shopify Flow condition carries "${record.department.tag}".`);
  else unresolved.push(`The Shopify Flow condition for "${record.department.tag}" is not confirmed (${record.sharedSettings.flow.status}).`);
  if (record.sharedSettings.helium.status === "verified") report.completed.push(`All Helium forms carry "${record.department.tag}".`);
  else unresolved.push(`The Helium forms for "${record.department.tag}" are not confirmed (${record.sharedSettings.helium.status}).`);

  let created = 0;
  for (const product of record.products) {
    const result = await checkProduct(record, product, colorTable);
    report.warnings.push(...result.warnings);
    unresolved.push(...result.issues);
    if (result.ok) {
      created++;
      report.completed.push(`${product.title || product.id}: Draft, ${product.shopify.variantCount} variants with SKUs and images.`);
    }
  }
  if (created) report.completed.push(`${created} of ${record.products.length} product(s) built and checked.`);

  /* §4 gaps are missing information until Dan answers them — and the product
     list IS the answer (§1 "Phase 2 build inputs, after he talks to the rep").
     Once every row validates, a stale review gap must not hold the report
     open forever; it stays visible in policyReview either way. */
  const rowsAnswerThePolicy = record.products.length > 0 && record.products.every((p) => p.validation?.ok === true);
  if (!rowsAnswerThePolicy) {
    for (const missing of record.policyReview.missing || []) {
      report.missingInformation.push(`${missing.topic}: ${missing.detail || "not stated in the policy"}`);
    }
  }
  for (const product of record.products) {
    for (const mockup of product.mockups || []) {
      if (mockup.path === "missing-artwork" || mockup.path === "render-failed") {
        /* The path-specific reason, not warnings[0] — that slot belongs to
           whichever colour/Class B/AI-blank notice landed first, which is how
           a missing embroidery proof got reported as a missing blank photo. */
        report.missingInformation.push(`${product.title || product.id} ${mockup.color} ${mockup.face}: ${mockup.reason || mockup.warnings?.[0] || mockup.path}`);
      }
    }
    /* Part 2 makes the blank photo Dan's to supply; when none arrived the
       agent invents the garment. That is a deliberate fallback, so it is a
       warning rather than missing information — it says what happened without
       blocking the store. One line per product: a six-colour row would
       otherwise emit twelve. */
    const generatedBlanks = (product.mockups || []).filter((mockup) => mockup && mockup.base === "generated");
    if (generatedBlanks.length) {
      const colors = [...new Set(generatedBlanks.map((mockup) => mockup.color).filter(Boolean))];
      report.warnings.push(
        `${product.title || product.id}: ${generatedBlanks.length} image(s) show an AI-generated blank, not the real garment (${colors.join(", ")}). Upload blank photos and re-run to replace them.`
      );
    }
    for (const warning of product.validation?.warnings || []) report.warnings.push(`${product.title || product.id}: ${warning}`);
    for (const assumption of product.validation?.assumptions || []) report.warnings.push(`${product.title || product.id}: assumption — ${assumption}`);
  }

  report.missingInformation.push(...unresolved.filter((u) => /not confirmed|does not exist|not approved|has not been created/i.test(u)));
  report.warnings.push(...unresolved.filter((u) => !/not confirmed|does not exist|not approved|has not been created/i.test(u)));
  report.missingInformation = [...new Set(report.missingInformation)];
  report.warnings = [...new Set(report.warnings)];
  report.generatedAt = nowIso();

  // §12 "Never report an onboarding as complete while anything is unresolved"
  // — that includes anything still listed as missing information.
  const complete = unresolved.length === 0 && report.missingInformation.length === 0;
  record = await store().updateOnboarding(id, (r) => {
    if (build) {
      build.heartbeatAt = nowIso();
      r.build = build;
    }
    r.report = { ...r.report, ...report };
    // §12 "Never report an onboarding as complete while anything is unresolved."
    if (complete) {
      r.status = "complete";
      r.phase = "report";
    } else if (r.status === "complete") {
      r.status = r.products.some((p) => p.buildState === "created") ? "built-partial" : "built";
    }
    note(r, { type: "report", message: complete ? "Final check passed — nothing unresolved." : `Final check: ${unresolved.length} item(s) still unresolved.`, by }, build);
    return r;
  });

  const docUrl = await saveReportDoc(record).catch(() => "");
  if (docUrl && docUrl !== record.report.driveDocUrl) {
    record = await store().updateOnboarding(id, (r) => {
      r.report.driveDocUrl = docUrl;
      return r;
    });
  }
  return record;
}

async function saveReportDoc(record) {
  const folderId = record.drive.departmentFolderId;
  if (!folderId) return "";
  const code = departmentCode(record);
  // Dated so a re-check writes a new report instead of silently leaving the
  // folder with a stale one; same-day re-runs reuse the day's document.
  const name = `Onboarding Report — ${record.department.name}${code ? ` (${code})` : ""} ${nowIso().slice(0, 10)}`;
  const existing = await drive().listFilesInFolder(folderId);
  const already = existing.find((f) => clean(f.name).toLowerCase() === name.toLowerCase());
  if (already) return already.webViewLink || "";
  const file = await drive().uploadHtmlDocument(name, reportHtml(record), folderId);
  return file.webViewLink || "";
}

const esc = rules.escapeHtml;

function reportSection(title, items, empty) {
  const rows = (items || []).filter(Boolean);
  if (!rows.length) return `<h2>${esc(title)}</h2>\n<p>${esc(empty)}</p>`;
  return `<h2>${esc(title)}</h2>\n<ul>\n${rows.map((item) => `<li>${esc(item)}</li>`).join("\n")}\n</ul>`;
}

/*
 * The §12 report, normalised. "Needs Dan" ALWAYS carries pricing, cost per
 * item, Easify, final review, setting products Active and sending the link —
 * the spec lists them as permanent entries, so they must be there even before
 * a final check has ever run. Reading record.report straight out of the store
 * would show an empty list on a fresh onboarding.
 */
function reportFor(record) {
  const stored = record?.report || rules.emptyReport();
  return {
    ...rules.emptyReport(),
    ...stored,
    completed: stored.completed || [],
    needsDan: [...new Set([...(stored.needsDan || []), ...rules.NEEDS_DAN_ALWAYS])],
    missingInformation: stored.missingInformation || [],
    warnings: stored.warnings || []
  };
}

/** The §12 report as HTML — the console renders it and Drive stores it. */
function reportHtml(record) {
  const report = reportFor(record);
  const code = departmentCode(record);
  const needsDan = report.needsDan;
  const head = [
    `<h1>${esc(record?.department?.name || "Department")}${code ? ` (${esc(code)})` : ""}</h1>`,
    `<p>Store: ${esc(record?.collection?.title || "not created")}${record?.collection?.url ? ` — <a href="${esc(record.collection.url)}">Shopify admin</a>` : ""}</p>`,
    `<p>Status: <strong>${esc(record?.status || "")}</strong>${report.generatedAt ? ` · checked ${esc(report.generatedAt)}` : ""}</p>`
  ].join("\n");
  return [
    head,
    reportSection("1. Completed", report.completed, "Nothing has been completed yet."),
    reportSection("2. Needs Dan", needsDan, "Nothing."),
    reportSection("3. Missing information", report.missingInformation, "Nothing is missing."),
    reportSection("4. Warnings and errors", report.warnings, "No warnings.")
  ].join("\n");
}

/* ---------------------------------------------------------------------------
   Shutdown and resume (wired in server.js)
   ------------------------------------------------------------------------- */

/**
 * Called on SIGTERM/SIGINT: stamp every in-flight build "interrupted" so the
 * record tells the truth while this process dies and the watchdog resumes it
 * immediately instead of waiting out the staleness window.
 */
async function markActiveBuildsInterrupted(reason = "server shutdown") {
  const flushes = [];
  for (const [id, build] of activeBuilds) {
    if (!build || build.state !== "running") continue; // placeholders have no record yet
    build.state = "interrupted";
    build.log.push(`${nowIso().slice(11, 19)} interrupted by ${reason}; the build resumes automatically and keeps what it already created`);
    flushes.push(saveBuild(id, build).catch(() => {}));
  }
  await Promise.all(flushes);
  return flushes.length;
}

// Random per process: the claim below makes two replicas that both see the
// same dead build agree on a single resumer.
const INSTANCE_ID = Math.random().toString(36).slice(2, 10);
const RESUME_SETTLE_MS = 4000;

/**
 * Scan every onboarding for a build that died — "interrupted" by a clean
 * shutdown, or "running" with no heartbeat — and start it again. Safe because
 * the build is additive: finished products are skipped.
 */
async function resumeInterruptedBuilds({ onLog = () => {} } = {}) {
  if (!store().storeConfigured() || !shopCore().shopifyConnected()) return { resumed: 0 };
  let summaries;
  try {
    summaries = await store().listOnboardings();
  } catch (error) {
    onLog(`resume scan skipped: ${errorText(error)}`);
    return { resumed: 0 };
  }

  let resumed = 0;
  for (const summary of summaries) {
    const state = summary.build?.state;
    if (state !== "running" && state !== "interrupted") continue;
    if (isBuildActive(summary.id)) continue;

    let record;
    try {
      record = await store().getOnboarding(summary.id);
    } catch (error) {
      onLog(`could not read ${summary.id}: ${errorText(error)}`);
      continue;
    }
    const interrupted = record.build.state === "interrupted";
    if (!interrupted && !buildLooksDead(record.build)) continue;

    /* Two replicas may both see this corpse. Whoever's claim survives a short
       settle owns the resume. Written without touching heartbeatAt so the
       freshness re-check inside startBuild still sees a dead build. */
    try {
      await store().updateOnboarding(summary.id, (r) => {
        r.build.resumeClaim = { owner: INSTANCE_ID, at: nowIso() };
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, RESUME_SETTLE_MS));
      const check = await store().getOnboarding(summary.id);
      if (check.build?.resumeClaim?.owner !== INSTANCE_ID) continue;
    } catch (error) {
      onLog(`could not claim ${summary.id} for resume: ${errorText(error)}`);
      continue;
    }

    onLog(`resuming ${record.department.name || summary.id}: build was ${interrupted ? "interrupted by a shutdown" : "running with no heartbeat"}`);
    try {
      const result = await startBuild(summary.id, { force: true, by: "resume" });
      if (result.started) resumed++;
      else onLog(`resume of ${summary.id} not started: ${result.reason}`);
    } catch (error) {
      onLog(`resume of ${summary.id} failed: ${errorText(error)}`);
    }
  }
  return { resumed };
}

module.exports = {
  setDeps,
  capabilities,
  createOnboarding,
  addFiles,
  removeFile,
  runSetup,
  approveCode,
  ensureDriveFolders,
  refreshProductionFiles,
  reviewPolicy,
  saveProducts,
  proposeColor,
  startBuild,
  proposeSharedSettings,
  approveSharedSetting,
  verifySharedSettings,
  recordLock,
  createLock,
  finalCheck,
  reportFor,
  reportHtml,
  isBuildActive,
  markActiveBuildsInterrupted,
  resumeInterruptedBuilds,
  // exported for tests
  defaultArtworkRole,
  variantIdsForMockup,
  megaMenuChecklist
};

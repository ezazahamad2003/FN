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
 *      The department's Omni Printer folder is created and never read: print
 *      files are production's, and the mockups come from the packet logos.
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
  supplierPhotos: () => require("./supplierPhotos"),
  locksmith: () => require("./locksmith"),
  helium: () => require("./helium"),
  mockups: () => require("./onboardingMockups"),
  policy: () => require("./onboardingPolicy"),
  drive: () => require("./drive"),
  auth: () => require("./auth"),
  referenceTables: () => require("./referenceTables"),
  menuGuard: () => require("./megaMenuGuard")
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
 * policy, drive, auth, referenceTables, menuGuard }). setDeps(null) restores
 * every real module. Returns the previous overrides so a test can put them
 * back. The cached Mega Menu health is forgotten: it was read through the
 * collaborators being replaced.
 */
function setDeps(partial) {
  const previous = injected;
  injected = partial ? { ...injected, ...partial } : {};
  menuHealthCache = { at: 0, value: null };
  return previous;
}

const store = () => dep("store");
const shop = () => dep("shopify");
const shopCore = () => dep("shopifyCore");
const catalog = () => dep("catalog");
const supplierPhotos = () => dep("supplierPhotos");
const locksmith = () => dep("locksmith");
const helium = () => dep("helium");
const mockups = () => dep("mockups");
const policy = () => dep("policy");
const drive = () => dep("drive");
const auth = () => dep("auth");
const tables = () => dep("referenceTables");
const menuGuard = () => dep("menuGuard");

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

/* Some master products carry their type HTML-escaped ("Tees &amp; Tanks");
   Shopify shows it literally, so the copy is decoded. */
function plainText(value) {
  return clean(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
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

/* ---------------------------------------------------------------------------
   The Mega Menu's health. menuUpdate replaces the whole tree, and on 13 Oct
   2026 the agent wrote one store into a Store list somebody else had emptied,
   making the wipe permanent. So every successful read of the live menu is
   judged by megaMenuGuard against the last good copy, the copies are kept,
   and the console's banner is refreshed from that same read.
   ------------------------------------------------------------------------- */

const MENU_HEALTH_CACHE_MS = 60 * 1000;
// How many missing titles a "blocked" record keeps; the banner has the rest.
const HEALTH_MISSING_CAP = 50;
let menuHealthCache = { at: 0, value: null };

// "Unknown is not an alarm": a menu that cannot be read raises no banner.
function unknownMenuHealth(baseline = null) {
  return { checkedAt: nowIso(), available: false, healthy: true, storeCount: 0, baseline, missing: [], nestedMissing: 0, reasons: [], message: "" };
}

/* The console's MenuHealth from what observe() returned. A healthy read just
   became the baseline, so nothing is missing from it any more; a read the
   baseline could not move to (storage down) still lists what it lacks. */
function menuHealthFrom(seen) {
  return {
    checkedAt: nowIso(),
    available: true,
    healthy: seen.healthy,
    storeCount: seen.storeCount,
    baseline: seen.baseline || null,
    missing: seen.advanced ? [] : seen.missing,
    nestedMissing: seen.advanced ? 0 : seen.nestedMissing,
    reasons: seen.healthy ? [] : seen.reasons,
    message: seen.healthy ? "" : seen.message
  };
}

// What a "blocked" record keeps about the menu it refused to touch.
function recordMenuHealth(seen) {
  return {
    storeCount: seen.storeCount,
    baselineCount: seen.baselineCount,
    baselineAt: seen.baselineAt,
    missing: (seen.missing || []).slice(0, HEALTH_MISSING_CAP).map((item) => item.title)
  };
}

// "The Store list has 0 stores; …" read as the end of a sentence.
function wipedReason(seen) {
  const text = (seen?.reasons || []).join(" ");
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : "the menu could not be judged.";
}

const RESTORE_FIRST = "Restore the Mega Menu first.";

function restoreMenuFirstStep(seen) {
  return `${RESTORE_FIRST} ${seen.message} Put the missing items back from the agent's saved copy (or by hand in Shopify admin), or accept the menu as it is if the change was on purpose. The agent will not change the menu until then.`;
}

// Once the record is out of "blocked", the step telling Dan to restore the
// menu first is history; left in, a verified card still says "the agent will
// not change the menu until then".
function withoutRestoreStep(checklist) {
  return (checklist || []).filter((step) => !String(step).startsWith(RESTORE_FIRST));
}

function menuSuspectError(seen) {
  const error = new Error(`${seen.message} Nothing was written to it.`);
  error.code = "MENU_SUSPECT";
  error.assessment = seen;
  return error;
}

/* Every successful read of the live menu goes through here. Returns the
   guard's verdict, or null when the guard itself failed — "unknown", which
   the Shopify layer's own check still covers on every write. */
async function observeMenu(menu, reason, { by = "", snapshot = true } = {}) {
  if (!menu || !Array.isArray(menu.items)) return null;
  try {
    const seen = await menuGuard().observe(menu, { reason, by: clean(by), snapshot });
    menuHealthCache = { at: Date.now(), value: menuHealthFrom(seen) };
    return seen;
  } catch {
    return null;
  }
}

// The last good copy a write is judged against; none when storage is down,
// which leaves the absolute rules (an empty Store list is never written to).
async function baselineForWrite() {
  try {
    return await menuGuard().loadBaseline();
  } catch {
    return null;
  }
}

// A restore point. Losing one must not stop the write it brackets.
async function keepMenuSnapshot(menu, reason, by) {
  if (!menu) return null;
  try {
    return await menuGuard().saveSnapshot(menu, { reason, by: clean(by) });
  } catch {
    return null;
  }
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
    if (read.available) await observeMenu(read.menu, "capability");
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
 *   anything else → packet.files
 */
async function addFiles(id, { files = [], kind = "other", productId = "", color = "", face = "front", decorationCode = "", role = "", by = "" } = {}) {
  const list = flattenFiles(files);
  if (!list.length) throw badRequest("No files were uploaded.");
  const wanted = clean(kind).toLowerCase() || "other";

  let existing = null;
  if (wanted === "blank" || wanted === "proof") {
    existing = await store().getOnboarding(id);
    if (!productById(existing, productId)) throw badRequest(`Product "${productId}" is not on this onboarding.`);
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
  /* A blank photo goes into the link book as well, so the next department
     that orders this garment and colour gets the real blank instead of a
     search that may find nothing and an invented garment: Foresthill's Delta
     FF180 was uploaded, then drawn again for SCC the same day. The upload
     stands whether or not the book could keep it; the event says which. */
  let kept = null;
  if (wanted === "blank") {
    kept = await supplierPhotos()
      .bookBlankPhoto({
        product: productById(existing, productId),
        color: clean(color),
        face: clean(face).toLowerCase() === "back" ? "back" : "front",
        file: list[0],
        origin: { onboardingId: id, assetId: stored[stored.length - 1].assetId, department: existing.department?.name || "" },
        by
      })
      .catch((error) => ({ booked: false, reason: error.message }));
  }
  return store().updateOnboarding(id, (record) => {
    if (wanted === "blank") {
      const product = productById(record, productId);
      const faceKey = clean(face).toLowerCase() === "back" ? "back" : "front";
      const colorKey = clean(color);
      if (!product.blankPhotos[colorKey]) product.blankPhotos[colorKey] = {};
      product.blankPhotos[colorKey][faceKey] = stored[stored.length - 1].assetId;
      note(record, {
        type: "files",
        message:
          `Blank photo added for ${product.styleNumber || product.id} ${colorKey} ${faceKey}` +
          (kept?.booked
            ? " — kept for every department that orders this garment and colour"
            : ` (not kept for other departments: ${kept?.reason || "unknown"})`),
        by
      });
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
  const existing = await store().getOnboarding(id);
  await store().deleteAsset(id, assetId);
  const updated = await store().updateOnboarding(id, (record) => {
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
  // A blank photo the link book learned from this row goes with it.
  for (const product of existing.products || []) {
    for (const [color, faces] of Object.entries(product.blankPhotos || {})) {
      for (const [face, value] of Object.entries(faces || {})) {
        if (value !== assetId) continue;
        await supplierPhotos()
          .unbookBlankPhoto({ product, color, face, assetId })
          .catch(() => {});
      }
    }
  }
  return updated;
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
  /* The list scores on the agency NAME alone, and fire department names repeat
     across states. Among equally good matches the one in this department's
     state comes first, so a same-named agency elsewhere never wins a tie. */
  const wantState = clean(record.department.state).toUpperCase();
  const inState = (row) => (wantState && clean(row?.state).toUpperCase() === wantState ? 1 : 0);
  matches = [...matches].sort((a, b) => Number(b.score) - Number(a.score) || inState(b) - inState(a));
  const top = matches[0] || null;
  /* Auto-approving a same-named agency from another state would put another
     department's code in this one's SKUs, so a state that disagrees drops
     through to Dan. */
  const topState = clean(top?.state).toUpperCase();
  const stateConflict = Boolean(top && wantState && topState && wantState !== topState);
  if (stateConflict) {
    warnings.push(
      `"${top.agency}" (${top.code}) is on the Department Code List but in ${topState}, and this department is in ${wantState} — approve a code rather than inheriting that one.`
    );
  }
  // Two rows that match equally well with different codes: Dan picks.
  const tie = Boolean(
    top &&
      matches.some((m) => m !== top && Number(m.score) === Number(top.score) && inState(m) === inState(top) && String(m.code).toUpperCase() !== String(top.code).toUpperCase())
  );
  if (tie) {
    warnings.push(`More than one agency on the Department Code List matches "${record.department.name}" equally well — pick the right code.`);
  }
  /* The collection title, the menu item and the customer's department tag
     are all the department NAME, so a namesake that already has a different
     code (another state, or another folder) would share them. Said before any
     code is approved; the build refuses a namesake's collection outright. */
  const namesakes = [
    ...matches.filter((m) => sameAgency(m.agency, record.department.name) && !inState(m) && clean(m.state)),
    ...observed.rows.filter((r) => clean(r.agency) && sameAgency(r.agency, record.department.name))
  ];
  const namesakeCodes = [...new Set(namesakes.map((n) => String(n.code).toUpperCase()))];
  if (namesakeCodes.length && !(top && !stateConflict && !tie && Number(top.score) >= LIST_MATCH_AUTO_APPROVE && namesakeCodes.every((c) => c === String(top.code).toUpperCase()))) {
    warnings.push(
      `A department named "${record.department.name}" already exists with code ${namesakeCodes.join(", ")}${namesakes.some((n) => clean(n.state)) ? ` (${[...new Set(namesakes.map((n) => clean(n.state)).filter(Boolean))].join(", ")})` : ""}. ` +
        "If that is this department, approve that code. If it is a different department, change this onboarding's name (for example add the state) — the store collection, menu item and customer tag all use the name."
    );
  }

  if (top && !stateConflict && !tie && Number(top.score) >= LIST_MATCH_AUTO_APPROVE) {
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

  const recommendation = recommendCode({
    name: record.department.name,
    state: wantState,
    top,
    tie,
    matches,
    namesakes,
    candidates,
    knownAgencies: [...matches, ...observed.rows]
  });

  return store().updateOnboarding(id, (r) => {
    r.department.code.candidates = candidates;
    r.department.code.matches = matches.map(matchRow);
    r.department.code.recommendation = recommendation;
    r.department.code.source = r.department.code.source || "proposed";
    r.status = "setup";
    r.phase = "setup";
    for (const w of warnings) note(r, { type: "warning", message: w, by });
    note(r, {
      type: "code",
      message: recommendation
        ? `Recommended for Dan: ${recommendation.summary}`
        : candidates.length
          ? `${r.department.name} is not on the Department Code List. Proposed: ${candidates.map((c) => `${c.code}${c.inUse ? " (in use)" : ""}`).join(", ")}. Waiting for approval.`
          : `No department code could be proposed for ${r.department.name}. Enter one by hand.`,
      by
    });
    return r;
  });
}

/* "Fire Protection District" and "Fire Department" are different agencies
   that often share a town name (Vacaville FD vs Vacaville FPD). */
function agencyKind(name) {
  const words = rules.agencyWords(name);
  if (words.includes("FPD") || words.includes("DISTRICT")) return "district";
  if (words.includes("FD") || words.includes("DEPARTMENT") || words.includes("DEPT")) return "department";
  return "";
}

/*
 * The agent's single recommendation for a code it could not auto-approve —
 * the code (and, for a namesake, the store name) Dan approves with one click,
 * and one sentence saying why. Null when there is nothing safe to recommend.
 *
 *   tie on the list   → the row whose kind (district/department) matches
 *   namesake elsewhere→ "<name> <STATE>" plus the first free code
 *   not on the list   → the first free proposed code
 */
function recommendCode({ name, state, top, tie, matches, namesakes, candidates, knownAgencies }) {
  const free = (candidates || []).find((c) => !c.inUse) || null;

  if (tie && top) {
    const tied = matches.filter((m) => Number(m.score) === Number(top.score));
    const kind = agencyKind(name);
    const sameKind = kind ? tied.filter((m) => agencyKind(m.agency) === kind) : [];
    const listed = tied.map((m) => `${String(m.code).toUpperCase()} (${clean(m.agency)}${m.city ? `, ${clean(m.city)}` : ""})`).join(" and ");
    if (sameKind.length === 1) {
      const pick = sameKind[0];
      return {
        code: String(pick.code).toUpperCase(),
        name: "",
        summary: `approve ${String(pick.code).toUpperCase()} — the list has ${listed}; "${name}" is a fire ${kind}, and only ${clean(pick.agency)} is one. Pick the other if that is wrong.`
      };
    }
    return { code: "", name: "", summary: `the list has ${listed}. Both are real agencies — pick the one this department is.` };
  }

  // A different agency already owns this exact name: give this one a name of
  // its own and a fresh code.
  const elsewhere = (namesakes || []).filter((n) => clean(n.state) && state && clean(n.state).toUpperCase() !== state);
  if (elsewhere.length && state) {
    const suggested = `${name} ${state}`;
    const clash = (knownAgencies || []).some((a) => clean(a.agency) && sameAgency(a.agency, suggested));
    const others = [...new Set(elsewhere.map((n) => `${String(n.code).toUpperCase()} in ${clean(n.state).toUpperCase()}`))].join(", ");
    if (!free || clash) {
      return { code: "", name: "", summary: `"${name}" is already ${others}. Give this department a different store name and pick a free code by hand.` };
    }
    return {
      code: free.code,
      name: suggested,
      summary:
        `rename the store to "${suggested}" and approve ${free.code}. "${name}" is already ${others}, and the collection, menu item and customer tag all use the name, so the two must differ. ` +
        `Helium and Flow then use "${suggested}" — the checklist at the end covers both.`
    };
  }

  // Same name in FN's own Drive or products with no state to compare: most
  // likely this very department coming back.
  const ours = (namesakes || []).find((n) => !clean(n.state));
  if (ours) {
    const code = String(ours.code).toUpperCase();
    return {
      code,
      name: "",
      summary: `approve ${code} — "${clean(ours.agency)}" already has a Drive folder with that code, so this is most likely the same department. If it is a different department, rename this one instead.`
    };
  }

  if (free) return { code: free.code, name: "", summary: `approve ${free.code} (${free.reason}) — no other department uses it.` };
  return null;
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
async function approveCode(id, { code, name: rename = "", by = "" } = {}) {
  const valid = rules.validateDepartmentCode(code);
  if (valid.error) throw badRequest(valid.error);
  let record = await store().getOnboarding(id);

  /* The recommendation for a namesake is a new store name AND a code, approved
     together. The name is the collection title, menu item and customer tag,
     so it can only change before anything is built under the old one. */
  const newName = rules.departmentTag(rename);
  if (newName && newName !== record.department.name) {
    if (record.collection.id || record.collection.gid || record.drive.departmentFolderId) {
      throw badRequest("The store name cannot change after its folders or collection exist.");
    }
    const previous = record.department.name;
    record = await store().updateOnboarding(id, (r) => {
      r.department.name = newName;
      recordApproval(r, { kind: "name", subject: `${previous} → ${newName}`, by });
      note(r, { type: "code", message: `Store name changed from "${previous}" to "${newName}" so it does not share a name with another department.`, by });
      return r;
    });
  }
  const name = record.department.name;

  const rows = await tables().departmentCodeRows();
  const owner = rows.find((row) => String(row.code).toUpperCase() === valid.code);
  const isNew = !owner;
  if (owner && clean(owner.agency) && !sameAgency(owner.agency, name)) {
    throw badRequest(`Department code ${valid.code} is already used by "${clean(owner.agency)}". Pick a different code.`);
  }
  // Same name is not the same department when the states differ.
  const ownerState = clean(owner?.state).toUpperCase();
  const state = clean(record.department.state).toUpperCase();
  if (owner && ownerState && state && ownerState !== state) {
    throw badRequest(
      `Department code ${valid.code} belongs to "${clean(owner.agency)}" in ${ownerState}, and this department is in ${state}. Pick a different code.`
    );
  }
  /* Not on the list does not mean free: older stores have codes that only
     show in Drive folder names and Shopify product tags. Reusing one would
     merge two departments' SKUs, tags and print files. */
  if (isNew) {
    const observed = await observedCodes([]);
    const users = observed.rows.filter((row) => String(row.code).toUpperCase() === valid.code);
    const foreign = users.find((row) => clean(row.agency) && !sameAgency(row.agency, name));
    if (foreign) {
      throw badRequest(`Department code ${valid.code} is already used by "${clean(foreign.agency)}" (its Drive folder). Pick a different code.`);
    }
    if (users.length && !users.some((row) => clean(row.agency))) {
      throw badRequest(
        `Department code ${valid.code} is already on Shopify products, and no department on the list or in Drive claims it. Check which store uses it, or pick a different code.`
      );
    }
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
    repEmail: record.department.contacts[0]?.email || "",
    policyText,
    artwork,
    knownProducts: record.products.length ? record.products : record.policyReview.suggestedProducts,
    notes: record.packet.notes
  });

  const docs = await writeReviewDocs(record, review, by);

  return store().updateOnboarding(id, (r) => {
    // Rows remember which suggestion they came from by its place in the list;
    // a new review is a new list, so those places no longer mean anything.
    for (const product of r.products || []) delete product.fromSuggestion;
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
async function saveProducts(id, products, { by = "", only = null } = {}) {
  if (!Array.isArray(products)) throw badRequest("products must be an array of rows.");
  const record = await store().getOnboarding(id);
  const code = departmentCode(record);
  if (!code) throw badRequest("Approve the department code before saving product rows.");
  const colorTable = await tables().colorTable();
  /* `only`: the ids of the rows this save is about. Every other row that is
     already saved is kept exactly as it stands — not resolved, profiled and
     validated against Shopify again. One product added to a store of twenty
     from the Departments page is one row's worth of Shopify reads, not
     twenty-one. */
  const onlyIds = Array.isArray(only) && only.length ? new Set(only.map(clean).filter(Boolean)) : null;

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
    const incoming = { ...(products[i] || {}) };
    // Owed images are the build's to track, never the console's to send.
    delete incoming.replaceImages;
    if (onlyIds && incoming.id && !onlyIds.has(clean(incoming.id))) {
      const kept = productById(record, incoming.id);
      if (kept && !claimed.has(kept.id)) {
        claimed.add(kept.id);
        usedIds.add(kept.id);
        rows.push(kept);
        continue;
      }
    }
    /* A row with nothing in it (+ Add product, then Save) is not a product.
       Saving it showed four "is required" errors on an empty row and kept
       the store's product list "needing attention" for no reason. */
    const filled = ["brand", "styleNumber", "type", "title", "decorationCodes"].some((k) => clean(incoming[k])) ||
      (Array.isArray(incoming.colors) && incoming.colors.some((c) => clean(c))) ||
      (Array.isArray(incoming.sizes) && incoming.sizes.some((s) => clean(s)));
    if (!filled) continue;
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
    /* The console sends the saved row back with its edits on top, so the old
       garment's Shopify product, mockups and master came back in through
       `incoming` too — dropping them from `carried` alone did nothing, and the
       masterMissing check was skipped because sourceProduct was still set.
       Anything derived from the old garment goes, on both sides: the build
       history, and the title and Vendor that were filled from its store
       profile (a title or Vendor Dan typed himself is kept). */
    const STYLE_DERIVED = [...BUILD_OWNED, "storeProfile", "masterMissing", "colorIssues", "replaceImages"];
    if (styleChanged) {
      for (const key of STYLE_DERIVED) {
        // Only the old garment's value echoed back goes; something new the
        // console set on purpose (the master just created for the new
        // garment) is kept.
        if (key in incoming && JSON.stringify(incoming[key]) === JSON.stringify(existing[key])) delete incoming[key];
        delete carried[key];
      }
      const oldTitle = clean(existing.title);
      const autoTitle =
        (existing.storeProfile?.name && oldTitle.startsWith(existing.storeProfile.name)) ||
        oldTitle === clean([existing.brand, existing.type].filter(Boolean).join(" "));
      if (oldTitle && clean(incoming.title) === oldTitle && autoTitle) incoming.title = "";
      if (clean(incoming.fulfillment) && clean(incoming.fulfillment) === clean(existing.storeProfile?.vendor) && clean(incoming.fulfillment) === clean(existing.fulfillment)) incoming.fulfillment = "";
    }

    let nextId = incoming.id || existing?.id || `p${i + 1}`;
    while (usedIds.has(nextId)) nextId = `p${rows.length + 1}-${usedIds.size}`;
    usedIds.add(nextId);

    // A saved row carries state the console form does not send back (photos,
    // proofs, mockups, the Shopify ids); merging keeps a re-save from wiping it.
    const merged = store().normalizeProduct({ ...carried, ...incoming, id: nextId }, i);
    /* "Another logo on this garment": the Styles, the logo for each Style's
       code and the spot of each embroidered one are worked out from the row's
       placements and its other logos on every save — before the spec check
       below, so adding a logo to a built product drops its old mockups and
       says it must be rebuilt. */
    const logoSetup = rules.logoStyles(merged, { previous: existing });
    merged.styles = logoSetup.styles;
    merged.logoMap = logoSetup.logoMap;
    merged.placements = logoSetup.placements;
    merged.otherLogos = logoSetup.otherLogos;
    if (styleChanged) {
      warnedStyleChanges.push(`${merged.styleNumber || "a row"} replaced ${existing.styleNumber} — its mockups and Shopify product were not carried over.`);
    }

    /* Same blank, different spec. Mockups were only dropped when the style
       number changed, so fixing a row's logos (Pine Hollow's tee went from no
       codes to F01/B01) kept the logo-less mockups and the re-run reused them.
       Anything that changes what the garment looks like or which SKUs it has
       invalidates the mockups; a product already built from the old spec is
       called out on the row, because a re-run skips a product that exists. */
    const specKey = (p) =>
      JSON.stringify([
        clean(p?.decorationMethod).toLowerCase(),
        clean(p?.decorationCodes).toUpperCase(),
        (Array.isArray(p?.styles) ? p.styles : []).map((s) => clean(s?.decorationCodes).toUpperCase()),
        (Array.isArray(p?.colors) ? p.colors : []).map((c) => clean(c).toLowerCase()),
        // Compared as the sizes they mean: "S-3XL" and "S, M, L, XL, 2XL, 3XL"
        // are the same spec (saving writes the expanded form back).
        [
          ...new Set(
            rules.expandSizeList(Array.isArray(p?.sizes) ? p.sizes : [], { hat: rules.isHeadwearText(`${p?.type || ""} ${p?.title || ""}`) }).map((s) => {
              const n = rules.normalizeSize(s);
              return n.error ? clean(s).toUpperCase() : n.size;
            })
          )
        ].sort(),
        // Moving an embroidered logo (Front → Back) changes the picture even
        // when its code stays E01.
        Object.entries(p?.placements && typeof p.placements === "object" ? p.placements : {})
          .filter(([, v]) => v)
          .sort(([a], [b]) => a.localeCompare(b)),
        // Which uploaded logo each placement uses changes the picture too.
        Object.entries(p?.logoMap && typeof p.logoMap === "object" ? p.logoMap : {})
          .filter(([, v]) => v)
          .sort(([a], [b]) => a.localeCompare(b))
      ]);
    let specWarning = "";
    if (existing && !styleChanged && specKey(existing) !== specKey(merged)) {
      if (Array.isArray(merged.mockups) && merged.mockups.length) merged.mockups = [];
      if (merged.shopify?.gid) {
        specWarning = `Already built in Shopify from the previous details. Delete that draft${merged.shopify.url ? ` (${merged.shopify.url})` : ""} and re-run the build to recreate it with these SKUs and logos.`;
      }
    }

    /* Start the row from how the store already sells this blank: the style as
       the store writes it ("Richardson 112" → R112), the house product name
       with this department's code ("Standard Short Sleeve PIN"), and the
       Vendor every other department uses for it. Only empty fields are filled
       — what Dan typed always wins — and a Shopify hiccup never blocks a save. */
    try {
      if (clean(merged.styleNumber)) merged.styleNumber = await shop().resolveStyleNumber(merged.brand, merged.styleNumber);
      const profile = clean(merged.styleNumber) ? await shop().storeProfile(merged.styleNumber) : null;
      merged.storeProfile = profile
        ? { name: profile.name, vendor: profile.vendor, colorCodes: profile.colorCodes.slice(0, 6), sampleSize: profile.sampleSize }
        : null;
      if (profile) {
        if (!clean(merged.title) && profile.name) merged.title = `${profile.name} ${code}`;
        if (!clean(merged.fulfillment) && rules.VENDORS.includes(profile.vendor)) merged.fulfillment = profile.vendor;
      }
    } catch {
      // The suggestions are a convenience; validation below is what matters.
    }

    const blank = await tables().blankByStyleNumber(merged.styleNumber).catch(() => null);
    if (blank) {
      if (!clean(merged.brand) && blank.brand) merged.brand = blank.brand;
      if (!clean(merged.type) && blank.type) merged.type = blank.type;
      if (!clean(merged.fulfillment) && blank.fulfillment) merged.fulfillment = blank.fulfillment;
      if (!clean(merged.sourceProduct.id) && blank.masterProductId) merged.sourceProduct = { ...merged.sourceProduct, id: blank.masterProductId, kind: "master" };
    }

    const expanded = rules.expandProduct(merged, { departmentCode: code, colorTable });
    merged.validation = {
      ok: expanded.ok,
      errors: expanded.errors,
      warnings: expanded.warnings,
      assumptions: expanded.assumptions,
      skuPreview: expanded.variants.map((v) => v.sku).filter(Boolean)
    };
    if (specWarning) merged.validation.warnings = [...merged.validation.warnings, specWarning];
    if (logoSetup.errors.length) {
      merged.validation.ok = false;
      merged.validation.errors = [...merged.validation.errors, ...logoSetup.errors];
    }
    /* "S-3XL" is saved as the sizes it means, so the row shows exactly which
       variants the build will create. Only when every size was understood —
       a typo stays as typed, next to its error. */
    const sizeTrouble = expanded.errors.some((e) => /size|waist|inseam/i.test(e) && !/at least one size/i.test(e));
    if (!sizeTrouble && expanded.product.sizes.length) merged.sizes = expanded.product.sizes;
    /* The build duplicates the style's master. A style the store has never
       sold has none, and the build failed on it ("No product to duplicate").
       Say so on the row, where "Create the master" fixes it in one click. A
       Shopify error here is not a verdict, so only a clean "not found" counts. */
    merged.masterMissing = false;
    if (clean(merged.styleNumber) && !clean(merged.sourceProduct?.id)) {
      const source = await shop()
        .findSourceProduct(merged.styleNumber)
        .catch(() => undefined);
      if (source === null) {
        merged.masterMissing = true;
        merged.validation.ok = false;
        merged.validation.errors = [
          ...merged.validation.errors,
          `The store has no master product for ${merged.styleNumber} yet, so it cannot be built. Press "Create the master" on this row.`
        ];
      }
    }
    if (!clean(merged.title)) merged.title = expanded.product.title;
    if (!clean(merged.decorationMethod) && expanded.product.decorationMethod) merged.decorationMethod = expanded.product.decorationMethod;

    for (const color of expanded.product.colors) {
      if (color.code || !color.proposal) continue;
      proposals.push({ color: color.name, code: color.proposal });
    }
    /* A colour the list does not have, and the two ways out, on the row
       itself: add it under the proposed code, or use the closest colour the
       list already has ("Deep Navy" → Navy, NVY). Before this the row said
       "propose a code and get Dan's approval" — to Dan, with the proposal
       already made and the approval only reachable on another page. */
    merged.colorIssues = expanded.product.colors
      .filter((c) => c.missing)
      .map((c) => ({ color: c.name, code: c.proposal || "", nearest: nearestListColor(c.name, colorTable) }));

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
    if (onlyIds) {
      const touched = rows.filter((row) => onlyIds.has(row.id));
      const name = (row) => row.title || row.styleNumber || row.id;
      note(r, {
        type: "products",
        message: `${touched.map(name).join(", ") || "A product row"} saved${touched.some((row) => row.validation.ok !== true) ? "; it needs attention" : ""}.`,
        by
      });
    } else note(r, { type: "products", message: `${rows.length} product row(s) saved; ${bad} need attention.`, by });
    if (proposed.length) note(r, { type: "color", message: `Colour code proposal(s) waiting for approval: ${proposed.join(", ")}.`, by });
    // Losing a built product's mockups is never silent — Dan has to know the
    // row he edited is not the row that was built.
    for (const warning of warnedStyleChanges) note(r, { type: "warning", message: warning, by });
    return r;
  });
}

/* ---------------------------------------------------------------------------
   One product at a time — the "New product" form on the Departments page.
   The same row, the same rules and the same build as the onboarding's
   Products step, for a store that already exists: the row is saved and
   checked on its own, and created on its own (createProducts), while the
   collection, the lock, the menu and every other product are left alone.
   ------------------------------------------------------------------------- */

function nextRowId(record) {
  const used = new Set((record.products || []).map((p) => String(p.id || "")));
  let n = used.size + 1;
  while (used.has(`p${n}`)) n += 1;
  return `p${n}`;
}

/** Save and validate ONE row; every other saved row is kept as it stands. */
async function saveProduct(id, productId, product, { by = "" } = {}) {
  const record = await store().getOnboarding(id);
  const incoming = product && typeof product === "object" ? product : {};
  const rowId = clean(productId) || clean(incoming.id) || nextRowId(record);
  const rows = record.products.map((p) => (p.id === rowId ? { ...incoming, id: rowId } : p));
  if (!rows.some((p) => p.id === rowId)) rows.push({ ...incoming, id: rowId });
  const saved = await saveProducts(id, rows, { by, only: [rowId] });
  const row = productById(saved, rowId);
  if (!row) throw badRequest("Pick a garment first: the row has nothing on it yet.");
  return { onboarding: saved, product: row };
}

/** Drop a row that was never built. Its uploaded proofs and blank photos go
    with it; a blank photo already kept in the link book stays there for the
    other departments (the book holds its own copy). */
async function removeProduct(id, productId, { by = "" } = {}) {
  const record = await store().getOnboarding(id);
  const row = productById(record, productId);
  if (!row) throw badRequest(`No product row "${productId}" on this onboarding.`);
  if (row.shopify?.gid) throw badRequest(`"${row.title || row.styleNumber || productId}" is already in Shopify. Delete it there if it is not wanted.`);
  if (isBuildActive(id)) throw badRequest("A build is running for this store. Wait for it to finish.");
  const assets = [
    ...Object.values(row.proofs || {}),
    ...Object.values(row.blankPhotos || {}).flatMap((faces) => Object.values(faces || {})),
    ...(row.mockups || []).map((m) => m?.assetId)
  ].filter(Boolean);
  for (const assetId of assets) await store().deleteAsset(id, assetId).catch(() => {});
  return store().updateOnboarding(id, (r) => {
    r.products = r.products.filter((p) => p.id !== row.id);
    note(r, { type: "products", message: `${row.title || row.styleNumber || row.id} removed before it was built.`, by });
    return r;
  });
}

/**
 * Create the products named, and nothing else: their mockups, their Shopify
 * drafts in the store's collection, their images. The rows must validate and
 * must not be in Shopify already (that is "Redo images", not "create").
 */
async function createProducts(id, productIds, { by = "", wait = false } = {}) {
  if (activeBuilds.has(id)) return { started: false, reason: "A build for this store is already running.", build: null };
  const ids = [...new Set((Array.isArray(productIds) ? productIds : [productIds]).map(clean).filter(Boolean))];
  if (!ids.length) throw badRequest("Pick at least one product to create.");
  const record = await store().getOnboarding(id);
  if (!record.collection.gid && !record.collection.id) {
    throw badRequest("The store's collection is not known yet, so a product cannot be added to it. Build the store first.");
  }
  for (const productId of ids) {
    const row = productById(record, productId);
    if (!row) throw badRequest(`No product row "${productId}" on this store.`);
    const name = row.title || row.styleNumber || productId;
    if (row.validation?.ok !== true) {
      throw badRequest(`"${name}" has not passed validation: ${(row.validation?.errors || ["not validated"]).join("; ")}`);
    }
    if (row.shopify?.gid && (await catalog().productExists(row.shopify.gid).catch(() => true))) {
      throw badRequest(`"${name}" is already in Shopify${row.shopify.url ? ` (${row.shopify.url})` : ""}. Use Redo images to change its pictures.`);
    }
  }
  return startBuild(id, { force: true, by, wait, only: ids, kind: "products" });
}

/* ---------------------------------------------------------------------------
   A store the agent did not build (the 100+ that predate it) gets a record of
   its own the first time a product is added to it from the Departments page.
   The record holds what that needs — the collection, the department code,
   the logos, the rows — and nothing is created in Shopify or Drive for it:
   the store is already there. Such a record is marked `adopted`, is never
   deletable from the console, and its code comes from the store itself:
   every SKU in it carries the code (STYLE-SIZE-COLOR-CODE-…), so a code read
   from the SKUs is the store's own by definition. A store with no readable
   code waits for the operator to type it.
   ------------------------------------------------------------------------- */
function codeFromStoreProducts(products) {
  const counts = new Map();
  const bump = (code, weight) => {
    const value = clean(code).toUpperCase();
    if (!DEPARTMENT_CODE_TAG_RE.test(value) || value === "FN") return;
    counts.set(value, (counts.get(value) || 0) + weight);
  };
  for (const p of products || []) {
    const parsed = rules.parseSku(p.sku);
    // A SKU names the code outright; a tag only hints at it.
    if (parsed?.code) bump(parsed.code, 3);
    for (const tag of p.tags || []) bump(tag, 1);
  }
  let best = "";
  let n = 0;
  for (const [code, count] of counts) if (count > n) [best, n] = [code, count];
  return best;
}

// The Drive folders an older store already has, found by its code in their
// names: "<Name> (CODE)" under Departments, "(CODE) <Name>" under Omni Printer.
async function findDriveFoldersByCode(code) {
  const out = { departmentFolder: null, productionFolder: null, warnings: [] };
  const wanted = clean(code).toUpperCase();
  if (!wanted) return out;
  for (const [key, parentId, pick] of [
    ["departmentFolder", process.env.GDRIVE_PARENT_FOLDER_ID, (name) => new RegExp(`\\(${wanted}\\)\\s*$`, "i").test(name)],
    ["productionFolder", process.env.GDRIVE_OMNI_PRINTER_FOLDER_ID, (name) => new RegExp(`^\\(${wanted}\\)`, "i").test(name)]
  ]) {
    if (!clean(parentId)) continue;
    try {
      const folders = await drive().listFilesInFolder(parentId, { mimeType: FOLDER_MIME });
      out[key] = folders.find((f) => pick(String(f.name || "").trim())) || null;
    } catch (error) {
      out.warnings.push(`Drive could not be searched for the store's ${key === "departmentFolder" ? "department" : "production"} folder (${errorText(error)}).`);
    }
  }
  return out;
}

async function approveStoreCode(record, code, by) {
  const valid = rules.validateDepartmentCode(code);
  if (valid.error) throw badRequest(valid.error);
  // The list's owner of that code must be this department, or nobody.
  const rows = await tables().departmentCodeRows().catch(() => []);
  const owner = rows.find((row) => String(row.code).toUpperCase() === valid.code);
  if (owner && clean(owner.agency) && !sameAgency(owner.agency, record.department.name)) {
    throw badRequest(`Department code ${valid.code} belongs to "${clean(owner.agency)}" on the Department Code List. Check the store's SKUs for its code.`);
  }
  return valid.code;
}

async function linkStoreDriveFolders(id, code, by) {
  const found = await findDriveFoldersByCode(code);
  let productImages = null;
  if (found.departmentFolder) {
    try {
      productImages = await drive().ensureSubfolder("Product Images", found.departmentFolder.id);
    } catch (error) {
      found.warnings.push(`The Product Images subfolder could not be made in the store's Drive folder (${errorText(error)}).`);
    }
  }
  return store().updateOnboarding(id, (r) => {
    if (found.departmentFolder) {
      r.drive.departmentFolderId = found.departmentFolder.id;
      r.drive.departmentFolderUrl = found.departmentFolder.webViewLink || `https://drive.google.com/drive/folders/${found.departmentFolder.id}`;
      note(r, { type: "drive", message: `Linked to the store's Drive folder "${found.departmentFolder.name}".`, by });
    } else note(r, { type: "drive", message: `No Drive folder named with (${code}) was found under Departments, so mockups are kept on the record only.`, by });
    if (productImages) r.drive.productImagesFolderId = productImages.id;
    if (found.productionFolder) {
      r.drive.productionFolderId = found.productionFolder.id;
      r.drive.productionFolderUrl = found.productionFolder.webViewLink || `https://drive.google.com/drive/folders/${found.productionFolder.id}`;
    }
    for (const w of found.warnings) note(r, { type: "warning", message: w, by });
    return r;
  });
}

async function adoptStore(collectionId, { code = "", by = "" } = {}) {
  const existing = await recordForCollection(collectionId);
  if (existing) {
    if (existing.department.code.approved || !clean(code)) return existing;
    // An adopted store whose code could not be read, now typed by the operator.
    const approved = await approveStoreCode(existing, code, by);
    await store().updateOnboarding(existing.id, (r) => {
      r.department.code = { ...r.department.code, value: approved, source: "manual", approved: true, approvedAt: nowIso(), approvedBy: clean(by) };
      recordApproval(r, { kind: "code", subject: approved, by });
      note(r, { type: "code", message: `Department code ${approved} approved for this store.`, by });
      return r;
    });
    return linkStoreDriveFolders(existing.id, approved, by);
  }

  const live = await shop().storeProducts(collectionId);
  const title = clean(live.title);
  if (!title) throw badRequest("That collection has no title, so it cannot be adopted as a store.");
  const m = title.match(/^(\d+)\.\s*(.+)$/);
  const ordinal = m ? Math.max(1, Number(m[1])) : 1;
  const name = rules.departmentTag(m ? m[2] : title);
  let found = codeFromStoreProducts(live.products);
  let source = "store";
  if (!found && clean(code)) {
    found = await approveStoreCode({ department: { name } }, code, by);
    source = "manual";
  }

  const created = await store().createOnboarding({ departmentName: name, storeOrdinal: ordinal, storeName: ordinal > 1 ? name : "", by });
  const record = await store().updateOnboarding(created.id, (r) => {
    r.adopted = { at: nowIso(), by: clean(by), collectionId: String(live.id || collectionId) };
    r.collection = {
      ...r.collection,
      title,
      id: String(live.id || ""),
      gid: live.gid || "",
      handle: live.handle || "",
      url: live.id ? shop().collectionAdminUrl(live.id) : "",
      storefrontUrl: storefrontCollectionUrl(live.handle),
      descriptionSet: true
    };
    // Built outside the agent: there is nothing for the wizard to do here.
    r.status = "complete";
    r.phase = "report";
    if (found) {
      r.department.code = { ...r.department.code, value: found, source, approved: true, approvedAt: nowIso(), approvedBy: clean(by) };
      recordApproval(r, { kind: "code", subject: found, by });
    }
    note(r, {
      type: "created",
      message: `Record opened for the existing store "${title}" (${live.products.length} product(s) in Shopify)${
        found ? `, department code ${found} ${source === "store" ? "read from its SKUs" : "typed by the operator"}` : "; its department code could not be read from its products"
      }.`,
      by
    });
    return r;
  });
  if (!found) return record;
  return linkStoreDriveFolders(record.id, found, by);
}

/* The colour already on the list that a manufacturer's name is a shade of:
   the longest list colour contained in it as whole words ("True Navy" →
   Navy; "Heather Charcoal" → Charcoal). Null when nothing fits. */
function nearestListColor(name, colorTable) {
  const wanted = ` ${rules.normalizeColorName(name)} `;
  let best = null;
  for (const row of colorTable || []) {
    // A flagged duplicate (BLA for BLK) is skipped; the preferred one of the pair is fine.
    if (!row?.code || row.status === "retired" || (row.status === "flagged" && !row.preferred)) continue;
    const color = rules.normalizeColorName(row.color);
    if (!color || color === wanted.trim()) continue;
    if (wanted.includes(` ${color} `) && (!best || color.length > rules.normalizeColorName(best.color).length)) best = { code: row.code, color: row.color };
  }
  return best;
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
  // Any other code still proposed for this same colour is now moot.
  for (const other of await tables().pendingProposals("color-codes").catch(() => [])) {
    if (rules.normalizeColorName(other.row?.color) === rules.normalizeColorName(name)) {
      await tables().decideProposal("color-codes", other.id, { approve: false, by }).catch(() => {});
    }
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
/*
 * "Redo images" for one product or several: new artwork, a real blank photo,
 * or a better supplier photo arrived after they were built. A re-run used to
 * reuse the old mockups and skip the existing Shopify product, so nothing
 * changed. This clears each row's mockups and marks it, then runs a build
 * scoped to those rows alone: their mockups are rendered again and the images
 * on their existing drafts are swapped. Nothing else in the store is walked —
 * one hat's pictures no longer cost a pass over 27 products.
 */
async function redoProductImages(id, productIds, { by = "", wait = false } = {}) {
  if (activeBuilds.has(id)) return { started: false, reason: "A build for this onboarding is already running.", build: null };
  const ids = [...new Set((Array.isArray(productIds) ? productIds : [productIds]).map(clean).filter(Boolean))];
  if (!ids.length) throw badRequest("Pick at least one product whose images should be made again.");
  const record = await store().getOnboarding(id);
  for (const productId of ids) {
    if (!productById(record, productId)) throw badRequest(`No product row "${productId}" on this onboarding.`);
  }
  await store().updateOnboarding(id, (r) => {
    for (const productId of ids) {
      const target = productById(r, productId);
      target.mockups = [];
      if (target.shopify?.gid) target.replaceImages = true;
      note(r, { type: "build", message: `${target.title || target.styleNumber || productId}: images will be made again${target.shopify?.gid ? " and replaced on the Shopify draft" : ""}.`, by });
    }
    return r;
  });
  return startBuild(id, { force: true, by, wait, only: ids });
}

async function startBuild(id, { force = false, by = "", wait = false, only = null, kind = "images" } = {}) {
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
  // Which products this run is for — "Redo images" for some of them, or the
  // products added to a store that is already built. A full build has no scope.
  const scopedIds = Array.isArray(only) ? [...new Set(only.map(clean).filter(Boolean))] : [];
  const scopeKind = kind === "products" ? "products" : "images";
  if (scopedIds.length) build.scope = { kind: scopeKind, productIds: scopedIds };
  activeBuilds.set(id, build);
  // Step flushes are the normal heartbeat, but one image call can run for
  // minutes without one; this timer keeps the record fresh.
  const heartbeat = setInterval(() => {
    if (build.state === "running") saveBuild(id, build).catch(() => {});
  }, HEARTBEAT_EVERY_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const task = runBuild(id, build, { by, only: scopedIds.length ? scopedIds : null, kind: scopeKind })
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

// `rows` is the part of the product list this run is for (all of it for a build).
function preflight(record, rows = record.products) {
  const problems = [];
  if (!record.department.code.approved || !departmentCode(record)) problems.push("The department code is not approved yet.");
  if (!rows.length) problems.push("No product rows have been saved.");
  for (const product of rows) {
    if (product.validation?.ok !== true) {
      problems.push(`"${product.title || product.styleNumber || product.id}" has not passed validation: ${(product.validation?.errors || ["not validated"]).join("; ")}`);
    }
  }
  if (!shopCore().shopifyConnected()) problems.push("Shopify is not connected.");
  if (problems.length) throw badRequest(problems.join(" "));
}

async function runBuild(id, build, { by = "", only = null, kind = "images" } = {}) {
  const log = buildLogger(build);
  let record = await store().getOnboarding(id);
  const failures = [];
  /* "Redo images" for some products runs only their steps: their mockups are
     made again and their Shopify drafts get the new pictures. The collection,
     the lock, every other product, the shared-settings proposals and the
     record's status are left exactly as they are. Redoing one hat used to walk
     every step of the store again (minutes, for one picture) and left a
     finished record reading "built" instead of "complete".

     A "products" scope is the other partial run: products added to a store
     that is already built (the Departments page's New product). Their
     mockups are made and they are created in the store's collection; the
     rest of the store is left alone in the same way. */
  const scoped = Array.isArray(only) && only.length ? new Set(only) : null;
  const partial = Boolean(scoped);
  const productsOnly = partial && kind === "products";
  const imagesOnly = partial && !productsOnly;
  const rowsOf = (r) => (scoped ? r.products.filter((p) => scoped.has(p.id)) : r.products);

  let step = stepStart(build, "preflight", "Preflight");
  try {
    preflight(record, rowsOf(record));
    log(`Preflight passed: ${rowsOf(record).length} product row(s), department ${departmentCode(record)}.`);
    stepDone(step, `${rowsOf(record).length} product row(s) ready`);
  } catch (error) {
    stepFail(step, error);
    throw error;
  }
  record = await saveBuild(id, build, (r) => {
    if (!partial) {
      r.status = "building";
      r.phase = "build";
    }
    const message = productsOnly
      ? `Adding ${rowsOf(r).length} product(s) to the store; the rest of the store is left as it is.`
      : imagesOnly
        ? `Images started for ${rowsOf(r).length} product(s); the rest of the store is left as it is.`
        : "Build started.";
    note(r, { type: "build", message, by }, build);
  });

  // §5 mockups — before the products, because the product images are these.
  for (const row of rowsOf(record)) {
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
      await trashSupersededImages(record, made.mockups, log);
      stepDone(step, `${made.mockups.length} image(s)`);
    } catch (error) {
      stepFail(step, error);
      failures.push(`Mockups for ${product.title || product.id}: ${errorText(error)}`);
      log(`Mockups failed for ${product.title || product.id}: ${errorText(error)}`);
      record = await saveBuild(id, build);
    }
  }

  // §6 collection — created BEFORE any product. A partial run has one.
  if (!partial) {
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
  }

  // §7 lock
  if (!partial) {
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
  }

  // §9 products
  for (const row of rowsOf(record)) {
    const product = productById(record, row.id);
    step = stepStart(build, `products:${product.id}`, `Product — ${product.title || product.styleNumber || product.id}`);
    try {
      if (product.shopify?.gid && product.replaceImages && (await catalog().productExists(product.shopify.gid))) {
        /* "Redo images": the product stays as built (title, SKUs, price
           work Dan may have done); only its pictures are swapped for the
           mockups this run just rendered. */
        const fresh = productById(record, product.id);
        const title = fresh.title || product.title || "";
        const snapshot = await shop().productSnapshot(product.shopify.gid);
        const images = await mockupImages(id, fresh, snapshot?.variants || [], title);
        /* Never strip a product bare: replacing deletes every image first, so
           a re-render that produced nothing usable (all faces failed, assets
           missing) would leave the Shopify product with no pictures at all. */
        if (!images.length) {
          await saveBuild(id, build, (r) => {
            const target = productById(r, product.id);
            if (target) delete target.replaceImages;
          });
          throw new Error(`No new images were made for ${title || product.id}, so its existing Shopify images were kept. Check the mockup step above and try Redo images again.`);
        }
        const replaced = await shop().replaceProductImages(product.shopify.gid, images, { onLog: log });
        record = await saveBuild(id, build, (r) => {
          const target = productById(r, product.id);
          if (target) {
            target.buildState = "created";
            delete target.replaceImages;
          }
          note(r, { type: "build", message: `${title}: images replaced (${replaced.removed} removed, ${replaced.added} added).`, by }, build);
          for (const w of unboundFrontWarnings(images, title)) note(r, { type: "warning", message: w, by }, build);
        });
        stepDone(step, `images replaced (${replaced.added})`);
        continue;
      }
      if (product.shopify?.gid && (await catalog().productExists(product.shopify.gid))) {
        const label = product.title || product.id;
        /* Not created again — but a variant showing no image gets its front
           bound, so a re-run repairs what an interrupted one left behind.
           A failed READ keeps the old skip (the final check still tests the
           images); a failed bind fails the step, like any other write. */
        let snapshot = null;
        try {
          snapshot = await shop().productSnapshot(product.shopify.gid);
        } catch (error) {
          log(`${label}: could not read it back to check its images (${errorText(error)}).`);
        }
        const bound = snapshot ? await bindMissingFrontImages(id, product, snapshot, log) : 0;
        if (bound) {
          stepDone(step, `already created; ${bound} variant image(s) re-attached`);
          log(`${label} already exists in Shopify; re-attached ${bound} variant image(s) that were missing.`);
        } else {
          stepSkip(step, "already created");
          log(`${label} already exists in Shopify; skipped.`);
        }
        record = await saveBuild(id, build, (r) => {
          const target = productById(r, product.id);
          if (target) target.buildState = "created";
          if (bound) note(r, { type: "build", message: `${label}: ${bound} variant(s) showed no image; their front image was attached.`, by }, build);
        });
        continue;
      }
      if (imagesOnly) {
        /* Not in Shopify yet (its first build failed, or it was added since):
           its new images are kept on the row and the next full build creates
           it with them. A product is never created outside a full build. */
        stepSkip(step, "not in Shopify yet — the next build creates it with these images");
        log(`${product.title || product.id} is not in Shopify yet; its new images wait for the next build.`);
        continue;
      }
      const built = await buildProduct(id, record, product, log, {
        onCreated: (shopify) =>
          saveBuild(id, build, (r) => {
            const target = productById(r, product.id);
            if (target) {
              target.shopify = shopify;
              target.buildState = "images";
              // Images are owed: a resume replaces whatever partial set landed.
              target.replaceImages = true;
            }
          })
      });
      record = await saveBuild(id, build, (r) => {
        const target = productById(r, product.id);
        if (target) {
          target.sourceProduct = built.sourceProduct;
          target.shopify = built.shopify;
          target.buildState = "created";
          target.buildError = "";
          // A "Redo images" whose product had been deleted in Shopify lands
          // here (built fresh). Left set, the flag would make every later
          // build delete all of the new product's images.
          delete target.replaceImages;
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
  // A partial run proposes nothing: the store's settings did not change.
  if (!partial) {
    step = stepStart(build, "shared-settings", "Shared settings");
    try {
      record = await proposeSharedSettings(id, { by });
      // The build log says what happened: a wiped menu got no proposal.
      if (record.sharedSettings.megaMenu.status === "blocked") {
        stepDone(step, "Flow and Helium proposed; the Mega Menu looks wiped, so nothing was proposed for it");
        log(`Flow and Helium changes proposed — none saved without approval. ${record.sharedSettings.megaMenu.error} The agent will not change the menu until it is restored, or accepted as it is.`);
      } else {
        stepDone(step, "proposed; waiting for approval");
        log("Mega Menu, Flow and Helium changes proposed — none saved without approval.");
      }
    } catch (error) {
      stepFail(step, error);
      failures.push(`Shared settings: ${errorText(error)}`);
    }
  }
  record = await saveBuild(id, build);

  // §12 final check. Not for a partial run: the final check re-judges the
  // whole store and, by §12, takes "complete" away while anything is
  // unresolved — on 2026-10-27 redoing three hats on Truckee Meadows (which
  // Dan had finished) left it "built-partial". New pictures, or one more
  // Draft, change nothing the final check judges; the next full build or
  // final check refreshes it.
  if (!partial) {
    step = stepStart(build, "final-check", "Final check");
    try {
      record = await finalCheck(id, { by, build });
      stepDone(step, `${record.report.completed.length} done, ${record.report.missingInformation.length} missing`);
    } catch (error) {
      stepFail(step, error);
      failures.push(`Final check: ${errorText(error)}`);
    }
  }

  const created = rowsOf(record).filter((p) => p.buildState === "created").length;
  build.state = failures.length ? (created ? "partial" : "failed") : "complete";
  build.error = failures.length ? failures.join(" | ") : null;
  build.finishedAt = nowIso();
  await saveBuild(id, build, (r) => {
    if (!partial) {
      if (r.status !== "complete") r.status = failures.length ? (created ? "built-partial" : "build-error") : "built";
      r.phase = "report";
    }
    const message = productsOnly
      ? `Products ${build.state}: ${created} of ${rowsOf(r).length} added to the store${failures.length ? `; ${failures.length} failed` : ""}.`
      : imagesOnly
        ? `Images ${build.state}: ${rowsOf(r).length} product(s) made again${failures.length ? `; ${failures.length} failed` : ""}.`
        : `Build ${build.state}: ${created} product(s) created.`;
    note(r, { type: "build", message, by }, build);
  });
  return { state: build.state, created, failures };
}

/* §5 mockups for one product, made from the department's own logos. Omni's
   print-ready files are never fetched: the agent builds the store, and the
   pick on the row (or the packet artwork by role) is the logo to show. */
async function buildMockups(id, record, product, log) {
  const code = departmentCode(record);
  const colorTable = await tables().colorTable();
  const expanded = rules.expandProduct(product, { departmentCode: code, colorTable });
  const warnings = [];
  const codes = [...new Set(expanded.product.styles.flatMap((s) => s.decorationCodes))];
  const artwork = {};

  /* Split on the decoration METHOD, not the letter. P## (a sewn patch) is
     applied decoration like embroidery, so an uploaded proof applies to it. */
  const parsedCodes = codes.map((c) => ({ code: c, parsed: rules.parseDecorationCode(c) }));
  const appliedCodes = parsedCodes.filter((p) => p.parsed.method === rules.DECORATION_EMBROIDERY).map((p) => p.code);

  for (const decoration of appliedCodes) {
    const assetId = product.proofs?.[decoration];
    if (!assetId) continue;
    const asset = await store().getAsset(id, assetId);
    if (asset) artwork[decoration] = { buffer: asset.buffer, mimetype: asset.contentType, name: asset.name };
  }

  /* Any code still without artwork takes the department's own logo from the
     packet: the back logo for B, the chest logo (or the department's pick,
     or the scramble) for everything else. The product images are the point
     of the agent; waiting for a print file or an embroidery proof shipped
     Pine Hollow's tee and hat as blanks with no logo at all. */
  const packetArt = (Array.isArray(record.packet?.files) ? record.packet.files : []).filter((f) => f?.kind === "artwork" && f.assetId && !/proof/i.test(f.name || ""));
  const byRole = (roles) => {
    for (const role of roles) {
      const hit = packetArt.find((f) => (f.role || "") === role);
      if (hit) return hit;
    }
    return null;
  };
  for (const decoration of codes) {
    if (artwork[decoration]) continue;
    const prefix = rules.parseDecorationCode(decoration).prefix;
    // The logo the operator picked for this placement on the row wins; the
    // artwork roles are only the default when nothing was picked.
    const chosenId = product.logoMap && typeof product.logoMap === "object" ? product.logoMap[decoration] : "";
    const chosen = chosenId ? packetArt.find((f) => f.assetId === chosenId) : null;
    // An embroidered code ticked on the Back takes the back logo too.
    const onBack = prefix === "B" || (product.placements && product.placements[decoration] === "B");
    const file =
      chosen ||
      (onBack
        ? byRole(["back", "scramble"])
        : byRole(["chest", "pick", "scramble", ""]) || packetArt.find((f) => (f.role || "") !== "back") || null);
    if (!file) {
      warnings.push(`No logo for ${decoration}: upload the department's ${onBack ? "back" : "chest"} logo in the packet${prefix === "E" ? " or the embroidery proof on the row" : ""}.`);
      continue;
    }
    const asset = await store().getAsset(id, file.assetId);
    if (!asset) continue;
    artwork[decoration] = { buffer: asset.buffer, mimetype: asset.contentType, name: asset.name || file.name };
    log(`${decoration}: using the department's ${file.role || "uploaded"} logo (${file.name}) from the packet.`);
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
      // The earlier Style's file this one is the same picture as (a back that
      // does not change between Styles); it stays out of the Shopify gallery.
      sameAs: image.sameAs || "",
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

/*
 * A re-render uploads every mockup again under the same file name and Drive
 * keeps both: after Ripon's tee was redone, Product Images held two
 * RIPO_NL3600_MN_FRONT.png and nothing said which one was current. Once the
 * new copies are up, older files with those names go to the Drive trash
 * (recoverable for 30 days). The new file always stays, so a name is never
 * left with no file. Best effort: a failure is logged, never fails the build.
 */
async function trashSupersededImages(record, mockups, log) {
  const folderId = record.drive?.productImagesFolderId;
  const uploaded = (mockups || []).filter((m) => m.driveFileId);
  if (!folderId || !uploaded.length) return;
  const names = new Set(uploaded.map((m) => m.fileName));
  const keep = new Set(uploaded.map((m) => m.driveFileId));
  let stale = [];
  try {
    stale = (await drive().listFilesInFolder(folderId)).filter((f) => names.has(f.name) && !keep.has(f.id));
  } catch (error) {
    log(`Product Images: could not check for older copies (${errorText(error)}).`);
    return;
  }
  let trashed = 0;
  for (const file of stale) {
    try {
      await drive().trashFile(file.id);
      trashed += 1;
    } catch (error) {
      log(`Product Images: could not move the older ${file.name} to the trash (${errorText(error)}).`);
    }
  }
  if (trashed) log(`Product Images: moved ${trashed} older cop${trashed === 1 ? "y" : "ies"} of these images to the Drive trash.`);
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
    {
      title,
      descriptionHtml: rules.collectionDescriptionHtml(),
      bannerBuffer,
      bannerAlt: `${record.department.name} banner`,
      departmentCode: departmentCode(record),
      knownCollectionGid: record.collection.gid || ""
    },
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
  /* A re-run must not lock the collection twice. Creating is not idempotent,
     and this step used to create unconditionally — a resumed or re-run build
     added a second lock to the same collection. The lock already on this
     collection is the one, whoever made it. */
  const existing = await locksmith()
    .findLockForCollection(record.collection.id)
    .catch(() => null);
  if (existing) {
    const existingId = existing.id != null ? existing.id : existing._id;
    log(`Locksmith: the collection already has lock ${existingId}; keeping it.`);
    return {
      status: "created",
      locksmithLockId: existingId == null ? "" : String(existingId),
      secretCode: record.lock?.secretCode || "",
      secretLink: record.lock?.secretLink || "",
      tagKey: tag,
      checklist: [],
      error: ""
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
async function buildProduct(id, record, product, log, { onCreated } = {}) {
  const warnings = [];
  const code = departmentCode(record);
  const colorTable = await tables().colorTable();
  const expanded = rules.expandProduct(product, { departmentCode: code, colorTable });
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
      productType: plainText(sourceDetail?.productType) || expanded.product.type,
      options: expanded.options,
      variants: expanded.variants.map((v) => ({ ...v, taxable: defaults.taxable !== false, tracked: Boolean(defaults.tracked), requiresShipping: defaults.requiresShipping !== false })),
      collectionGids: record.collection.gid ? [record.collection.gid] : []
    },
    { onLog: log }
  );
  warnings.push(...(result.warnings || []));

  /* Recorded the moment the product exists, before its images upload. A
     deploy that interrupted the upload used to leave the record without the
     product, and the resumed build made a second one (Ripon's hat, caught
     and repaired by hand). With the id saved and the images still owed, the
     resume finishes the images on THIS product instead. */
  if (onCreated) await onCreated({ productId: result.legacyId, gid: result.id, url: result.url, variantCount: result.variants.length, createdAt: nowIso() });
  const images = await mockupImages(id, product, result.variants, title);
  if (images.length) await shop().attachMockups(result.id, images, { onLog: log });
  else warnings.push(`${title}: no mockup images were attached.`);
  warnings.push(...unboundFrontWarnings(images, title));

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

// The alt text doubles as the image's identity: a re-run finds a front that
// uploaded but was never bound by it (bindMissingFrontImages).
function mockupAlt(title, mockup) {
  return `${title} — ${mockup.color}${mockup.style ? ` ${mockup.style}` : ""} ${mockup.face}`;
}

async function mockupImages(id, product, variants, title) {
  /* A back that is the same in every Style goes in the gallery once. A front
     is never dropped: each Style's variants are bound to their own. */
  const usable = (product.mockups || []).filter((m) => m.assetId && !(m.sameAs && m.face !== "front"));
  const ordered = [...usable.filter((m) => m.face === "front"), ...usable.filter((m) => m.face !== "front")];
  const images = [];
  for (const mockup of ordered) {
    const asset = await store().getAsset(id, mockup.assetId);
    if (!asset) continue;
    images.push({
      filename: mockup.fileName,
      buffer: asset.buffer,
      alt: mockupAlt(title, mockup),
      face: mockup.face,
      variantIds: mockup.face === "front" ? variantIdsForMockup(variants, mockup) : []
    });
  }
  return images;
}

/* A front that matches no variant uploads into the gallery and binds to
   nothing — no error, a product step that says "complete", and a §9.10
   failure only the final check would find. Say so at build time. */
function unboundFrontWarnings(images, title) {
  return (images || [])
    .filter((image) => image.face === "front" && !(image.variantIds || []).length)
    .map((image) => `${title}: the front image "${image.alt}" matched no variant's Color, so no variant shows it. Check the colour on the product row matches the variant's Color option.`);
}

/*
 * An existing product whose variants show no image: the mockups uploaded but
 * were never bound — a deploy between the two calls, or a record repaired by
 * hand without marking the images owed (Ripon's hat). A re-run used to skip
 * it as "already created", so only the final check noticed and nothing fixed
 * it. Bind the front already in the gallery, found by its alt text; upload
 * only a front that is not there at all. Nothing is deleted, so a photo Dan
 * added by hand survives. Returns how many variants now show an image.
 */
async function bindMissingFrontImages(id, product, snapshot, log) {
  const bare = (snapshot?.variants || []).filter((variant) => !variant.image?.url);
  if (!bare.length) return 0;
  const titles = [...new Set([clean(snapshot.title), clean(product.title)].filter(Boolean))];
  const links = [];
  const uploads = [];
  for (const mockup of (product.mockups || []).filter((m) => m && m.face === "front" && m.assetId)) {
    const variantIds = variantIdsForMockup(bare, mockup);
    if (!variantIds.length) continue;
    const alts = titles.map((title) => mockupAlt(title, mockup));
    const media = (snapshot.media || []).find((m) => alts.includes(clean(m.alt)));
    if (media) {
      for (const variantId of variantIds) links.push({ variantId, mediaId: media.id });
      continue;
    }
    const asset = await store().getAsset(id, mockup.assetId);
    if (asset) uploads.push({ filename: mockup.fileName, buffer: asset.buffer, alt: alts[0], variantIds });
  }
  if (links.length) await shop().linkVariantImages(snapshot.gid, links, { onLog: log });
  if (uploads.length) await shop().attachMockups(snapshot.gid, uploads, { onLog: log });
  return links.length + uploads.reduce((count, upload) => count + upload.variantIds.length, 0);
}

/* ---------------------------------------------------------------------------
   §8 shared settings
   ------------------------------------------------------------------------- */

function megaMenuChecklist({ menuTitle, collectionTitle, insertAfter, insertBefore }) {
  const steps = [
    `Content > Menus > Mega Menu > "Add menu item to store." Link it to "${collectionTitle}".`,
    // Every other entry in the live menu is named without the ordinal.
    `Name the item exactly "${menuTitle || collectionTitle}" — no "N." prefix, like every other store in the menu.`
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
  // The collection keeps its "N." ordinal; the menu item never carries one.
  const menuTitle = rules.megaMenuItemTitle(title);
  const tag = record.department.tag;

  /* `health` is set only while the menu is "blocked"; every other outcome —
     a healthy read above all — clears what an earlier blocked read left. */
  const menu = {
    status: "manual",
    proposal: { insertAfter: "", insertBefore: "", index: 0, title: menuTitle, url: record.collection.storefrontUrl || "", newItem: null, collectionHandle: record.collection.handle || "", collectionGid: record.collection.gid || "" },
    checklist: [],
    error: "",
    health: null
  };
  let blocked = null;
  try {
    const read = await shop().readMegaMenu();
    const seen = read.available ? await observeMenu(read.menu, "propose", { by }) : null;
    if (seen && !seen.healthy) {
      /* A position computed from a wiped Store list is "first, between
         nothing and nothing" — exactly what was proposed, approved and
         written on 13 Oct 2026. Nothing is proposed: the placeholder stays
         (no newItem), so an approval after the menu is restored works from
         a fresh read instead of from this one. */
      blocked = seen;
      menu.status = "blocked";
      menu.error = seen.message;
      menu.health = recordMenuHealth(seen);
      menu.checklist = [restoreMenuFirstStep(seen), ...megaMenuChecklist({ menuTitle, collectionTitle: title })];
    } else if (read.available) {
      const proposal = shop().proposeMegaMenuInsert(read.menu, { title: menuTitle, collectionHandle: record.collection.handle, collectionGid: record.collection.gid });
      /* newItem/collectionHandle/collectionGid travel with the proposal
         because applyMegaMenuInsert re-reads the live menu and rebuilds the
         insert from them — a stored proposal without newItem cannot be
         applied at all, it just throws "needs the proposal to apply". */
      menu.proposal = {
        insertAfter: proposal.insertAfter || "",
        insertBefore: proposal.insertBefore || "",
        index: proposal.index,
        title: menuTitle,
        url: proposal.newItem?.url || "",
        newItem: proposal.newItem || null,
        collectionHandle: record.collection.handle || "",
        collectionGid: record.collection.gid || ""
      };
      menu.status = proposal.alreadyPresent ? "verified" : "proposed";
      menu.checklist = megaMenuChecklist({ menuTitle, collectionTitle: title, insertAfter: menu.proposal.insertAfter, insertBefore: menu.proposal.insertBefore });
      if (proposal.reason) menu.error = proposal.reason;
    } else {
      menu.error = read.reason || "";
      menu.checklist = megaMenuChecklist({ menuTitle, collectionTitle: title });
    }
  } catch (error) {
    menu.error = errorText(error);
    menu.checklist = megaMenuChecklist({ menuTitle, collectionTitle: title });
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
      // A re-run (Redo images) must not undo what Dan already confirmed by hand.
      status: ["verified", "confirmed"].includes(r.sharedSettings.helium.status) ? r.sharedSettings.helium.status : "proposed",
      forms,
      checklist: helium().manualChecklist({ departmentTag: tag, forms })
    };
    note(r, { type: "shared-settings", message: `${blocked ? "Flow and Helium" : "Mega Menu, Flow and Helium"} changes proposed — nothing saved without approval.`, by });
    if (blocked) {
      note(r, {
        type: "warning",
        message: `Mega Menu NOT proposed — it looks wiped: ${wipedReason(blocked)} The agent will not change the menu until it is restored, or accepted as it is.`,
        by
      });
    }
    return r;
  });
}

const SHARED_KINDS = { megaMenu: "menu", flow: "flow", helium: "helium" };

// The refusal Dan reads when a Helium form the agent just read lacks the tag:
// which form, what to type where, and why a save a moment ago may not show.
function heliumTagMissing(tag, lacking) {
  const parts = lacking.map((form) => {
    const label = clean(form.label) || form.id;
    const what = form.present ? `does not have "${tag}" spelled exactly that way yet` : `does not have "${tag}" yet`;
    return `Helium's ${label} form ${what} — the agent just read it. ${helium().insertionSentence(tag, form)}`.trim();
  });
  const error = new Error(
    `${parts.join(" ")} Save it in Helium, then confirm again. If you saved it within the last minute, wait a moment: Helium can take a minute to publish.`
  );
  error.code = "HELIUM_TAG_MISSING";
  return error;
}

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
    /* Dan's word stands in for a form the agent CANNOT read — never against
       one it just read. On 13 Oct 2026 the Registration form was read, the
       tag was not on it, and this recorded "confirmed" anyway because the box
       had been ticked "to do later". A read that proves the tag is missing (or
       spelled differently) refuses the confirmation and says exactly what to
       type; nothing on the record changes but one warning note. */
    const tag = record.department.tag;
    const lacking = (forms || []).filter((f) => f.public !== false && !f.error && !(f.present && f.exactCase));
    if (lacking.length) {
      const labels = lacking.map((f) => clean(f.label) || f.id);
      await store().updateOnboarding(id, (r) => {
        note(r, { type: "warning", message: `Helium confirmation refused: ${labels.join(", ")} ${labels.length === 1 ? "does" : "do"} not carry "${tag}".`, by });
        return r;
      });
      throw heliumTagMissing(tag, lacking);
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
      /* Helium has no write API, so editing the three forms is Dan's job and
         always will be. Pressing this button IS his sign-off, exactly as it is
         for Shopify Flow, which is equally unautomatable.
         "verified" stays the higher bar: every one of the three forms read
         back carrying the tag. "confirmed" is Dan saying he did it on forms
         the agent cannot read — which is every form that is not configured.
         Requiring "verified" meant no onboarding could ever finish, because
         only one of the three form ids is known. A gate nothing can pass is
         not a safety check, it is a dead end. */
      r.sharedSettings.helium = {
        ...r.sharedSettings.helium,
        forms: stamped,
        status: verified ? "verified" : "confirmed",
        confirmedBy: verified ? "" : clean(by),
        confirmedAt: verified ? "" : nowIso(),
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
  const menuTitle = rules.megaMenuItemTitle(record.collection.title);
  const patch = { approvedAt: nowIso(), approvedBy: clean(by) };
  /* The position the manual checklist should name if the write does not
     happen. It starts as whatever the build stored and is replaced the moment
     a live read gives something better. */
  let checklistFrom = menu.proposal?.newItem ? menu.proposal : null;
  // The guard's verdict when it refused the write, and anything a write lost.
  let suspect = null;
  let lostItems = [];
  // Where the item went, when the record held no real position to approve.
  let writtenAt = null;
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
        /* Judged here, on the read the position comes from, and again inside
           applyMegaMenuInsert on its own fresh read against the same copy — a
           menu wiped between the two reads is caught by the second. */
        const seen = await observeMenu(read.menu, "approve", { by });
        if (seen && !seen.healthy) throw menuSuspectError(seen);
        const proposal = shop().proposeMegaMenuInsert(read.menu, { title: menuTitle, collectionHandle: record.collection.handle, collectionGid: record.collection.gid });
        checklistFrom = proposal;
        /* applyMegaMenuInsert refuses a stale proposal rather than inserting
           where Dan did not approve, so it has to be given what he APPROVED,
           not what we just recomputed — otherwise it compares the live menu
           against itself and can never fail. Two things the record does not
           say outright:

           • An absent neighbour is stored as "" and has to survive as null. A
             store that lands FIRST legitimately has nothing above it, and a
             truthiness fallback would quietly swap that for the fresh read.
           • Only a proposal the build derived from a real menu read is a
             position Dan approved. When the read was unavailable, the record
             holds a placeholder — index 0, both neighbours "" — and carrying
             THAT over fires the staleness check on every finish, reporting a
             menu change that never happened. `newItem` is the field only a
             real proposal carries, and applyMegaMenuInsert already requires
             it, so it is the marker here too. */
        const approved = menu.proposal?.newItem ? menu.proposal : null;
        const approvedNeighbour = (stored, fresh) => (stored === undefined ? fresh : stored === "" ? null : stored);
        proposal.index = approved?.index ?? proposal.index;
        proposal.insertAfter = approvedNeighbour(approved?.insertAfter, proposal.insertAfter);
        proposal.insertBefore = approvedNeighbour(approved?.insertBefore, proposal.insertBefore);
        // A restore point either side of the write: the menu it was computed
        // from, and the menu Shopify answered with.
        await keepMenuSnapshot(read.menu, "before-insert", by);
        const result = await shop().applyMegaMenuInsert(read.menu, proposal, { baseline: await baselineForWrite() });
        if (!result.alreadyPresent && result.after) {
          await keepMenuSnapshot(result.after, "after-insert", by);
          await observeMenu(result.after, "after-insert", { by, snapshot: false });
        }
        patch.status = "applied";
        patch.appliedAt = nowIso();
        patch.error = "";
        patch.menuItemId = result.menuItemId || "";
        /* A placeholder (proposed while the menu was blocked or unreadable)
           names no position, so the record keeps the one the write used —
           otherwise the card goes on saying "at the end (position 1)". */
        if (!approved) {
          writtenAt = {
            index: result.index ?? proposal.index,
            insertAfter: result.insertAfter || "",
            insertBefore: result.insertBefore || "",
            newItem: proposal.newItem || null
          };
        }
        lostItems = result.lostItems || [];
        if (lostItems.length) {
          patch.error = `The write removed ${lostItems.length} item(s) that were in the menu before it: ${lostItems.map((item) => `"${item.title}"`).join(", ")}. Put them back from the saved copy.`;
        }
      } catch (error) {
        if (error.code === "MENU_SUSPECT" && error.assessment) {
          suspect = error.assessment;
          patch.status = "blocked";
          patch.error = suspect.message;
          patch.health = recordMenuHealth(suspect);
        } else {
          patch.status = "manual";
          patch.error = errorText(error);
        }
      }
    }
  }
  if (patch.status !== "blocked") patch.health = null;

  /* Re-derive the checklist from the rule as it stands now, not as it stood
     when the build ran. Records built before the menu item lost its "N."
     prefix still carry a checklist that tells Dan to name the item
     "1. Bishop Fire Department" — the one entry out of 109 named that way,
     and precisely the instruction he follows when the write did not happen. */
  if (patch.status !== "applied") {
    patch.checklist = megaMenuChecklist({
      menuTitle,
      collectionTitle: record.collection.title,
      insertAfter: checklistFrom?.insertAfter || "",
      insertBefore: checklistFrom?.insertBefore || ""
    });
    // A position read off a wiped menu is no position: restoring comes first.
    if (suspect) patch.checklist = [restoreMenuFirstStep(suspect), ...megaMenuChecklist({ menuTitle, collectionTitle: record.collection.title })];
    patch.proposal = { ...(menu.proposal || {}), title: menuTitle };
  } else {
    // Applied — through the API, or by Dan's hand after a blocked read.
    patch.checklist = withoutRestoreStep(menu.checklist);
    if (writtenAt) patch.proposal = { ...(menu.proposal || {}), ...writtenAt, title: menuTitle };
  }

  return store().updateOnboarding(id, (r) => {
    r.sharedSettings.megaMenu = { ...r.sharedSettings.megaMenu, ...patch };
    recordApproval(r, { kind: "menu", subject: r.collection.title, by });
    if (patch.status === "blocked") {
      note(r, { type: "warning", message: `Mega Menu NOT changed — it looks wiped: ${wipedReason(suspect)} Restore it, or accept it as it is, then approve again.`, by });
    } else {
      note(r, {
        type: "shared-settings",
        message: patch.status === "applied" ? `Mega Menu item "${r.collection.title}" saved.` : `Mega Menu change approved but not writable here (${patch.error || "no scope"}); Dan applies the checklist.`,
        by
      });
    }
    if (lostItems.length) {
      note(r, { type: "warning", message: `The Mega Menu write removed ${lostItems.length} item(s) that were there before: ${lostItems.map((item) => `"${item.title}"`).join(", ")}.`, by });
    }
    return r;
  });
}

/** §8/§12: read the shared settings back and record what is actually true. */
async function verifySharedSettings(id, { by = "" } = {}) {
  const record = await store().getOnboarding(id);
  const tag = record.department.tag;

  let menu = null;
  try {
    menu = await shop().verifyMegaMenu(rules.megaMenuItemTitle(record.collection.title), { collectionGid: record.collection.gid, includeMenu: true });
  } catch (error) {
    menu = { available: false, present: false, reason: errorText(error) };
  }
  // The item being there is not proof the menu is: alone in a wiped Store
  // list it is "there" too.
  const seen = menu.available ? await observeMenu(menu.menu, "verify", { by }) : null;
  const wiped = Boolean(seen && !seen.healthy);
  const forms = await helium()
    .checkAllForms(tag)
    .catch(() => record.sharedSettings.helium.forms || []);

  return store().updateOnboarding(id, (r) => {
    if (wiped) {
      r.sharedSettings.megaMenu = { ...r.sharedSettings.megaMenu, error: seen.message };
    } else if (menu.available && menu.present) {
      r.sharedSettings.megaMenu = { ...r.sharedSettings.megaMenu, status: "verified", verifiedAt: nowIso(), error: "", health: null, checklist: withoutRestoreStep(r.sharedSettings.megaMenu.checklist) };
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
      message: `Verified: Mega Menu ${wiped ? "not confirmed (it looks wiped)" : menu.present ? "present" : "not confirmed"}, Helium ${present.length}/${verifiable.length || 0} form(s) carry "${tag}".`,
      by
    });
    return r;
  });
}

/* ---------------------------------------------------------------------------
   The Mega Menu as a whole: is it healthy, accept it, put it back
   ------------------------------------------------------------------------- */

/**
 * MenuHealth for the console's banner: { checkedAt, available, healthy,
 * storeCount, baseline, missing, nestedMissing, reasons, message }. Answered
 * from the last read any part of the agent made in the past minute, unless
 * `fresh`. A menu that cannot be read is "available: false, healthy: true" —
 * unknown is not an alarm.
 */
async function menuHealth({ fresh = false } = {}) {
  if (!fresh && menuHealthCache.value && Date.now() - menuHealthCache.at < MENU_HEALTH_CACHE_MS) return menuHealthCache.value;
  let read;
  try {
    read = await shop().readMegaMenu();
  } catch (error) {
    read = { available: false, reason: errorText(error) };
  }
  const seen = read.available ? await observeMenu(read.menu, "health-check") : null;
  if (seen) return menuHealthCache.value;
  let baseline = null;
  try {
    baseline = menuGuard().baselineSummary(await menuGuard().loadBaseline());
  } catch {
    baseline = null;
  }
  menuHealthCache = { at: Date.now(), value: unknownMenuHealth(baseline) };
  return menuHealthCache.value;
}

/**
 * Dan: "the menu is right as it is now". The live menu becomes the copy every
 * later read is judged against; the copy it replaces is kept in history. A
 * menu with no Store list, or an empty one, is refused (BAD_REQUEST) — that
 * is never right, and accepting it would bury the copy a restore needs.
 */
async function acceptMenuBaseline({ by = "" } = {}) {
  const read = await shop().readMegaMenu();
  if (!read.available) throw new Error(`The Mega Menu could not be read, so it cannot be accepted as it is: ${read.reason || "no reason given"}`);
  await menuGuard().acceptBaseline(read.menu, { by: clean(by), reason: "accepted" });
  const seen = await observeMenu(read.menu, "accepted", { by, snapshot: false });
  return seen ? menuHealthCache.value : unknownMenuHealth(null);
}

/**
 * Put back what the last good copy has and the live menu lost, without
 * moving or removing anything live (shopifyOnboarding.restoreMegaMenuItems).
 * → { restored: [title], skipped: [{ title, reason }], health }.
 */
async function restoreMegaMenu({ by = "" } = {}) {
  const baseline = await menuGuard().loadBaseline();
  if (!baseline) throw badRequest("There is no saved copy of the Mega Menu yet, so there is nothing to restore it from.");
  // The restore point is the menu as it stood just before the write.
  const before = await shop().readMegaMenu();
  if (before.available) await keepMenuSnapshot(before.menu, "before-restore", by);
  const result = await shop().restoreMegaMenuItems(baseline.menu, {});
  if (result.applied) await keepMenuSnapshot(result.after, "after-restore", by);
  const seen = await observeMenu(result.after, "after-restore", { by, snapshot: false });
  return {
    restored: result.restored.map((item) => item.title),
    skipped: result.skipped.map((item) => ({ title: item.title, reason: item.reason })),
    health: seen ? menuHealthCache.value : unknownMenuHealth(menuGuard().baselineSummary(baseline))
  };
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

/*
 * Why this face is not a render, in words that point at the real fix.
 *
 * `warnings[]` is a mixed bag — colour notes, the Class B caveat, the AI-blank
 * notice — so whichever landed first is not the explanation. Falling back to
 * warnings[0] told Dan to "upload a front photo of the blank" for a hat whose
 * actual problem was a missing E01 embroidery proof: he would have uploaded a
 * photo, re-run, and hit the same wall. Records built before the renderer
 * carried `reason` are still in the store, so those are read the same way —
 * the warning that explains THIS path, never the first one.
 */
function mockupReason(mockup) {
  const warnings = (mockup.warnings || []).map(clean).filter(Boolean);
  let text =
    clean(mockup.reason) ||
    warnings.find((w) => /^No artwork for /i.test(w) || /^No \w+ blank for /i.test(w)) ||
    `the ${mockup.face} image could not be rendered (${mockup.path}).`;
  /* The caller prefixes "<product> <colour> <face>: " and some warnings carry
     "<colour> <face>: " of their own, which read as "Navy front: Navy front:". */
  const prefix = `${mockup.color} ${mockup.face}:`;
  if (text.toLowerCase().startsWith(prefix.toLowerCase())) text = text.slice(prefix.length).trim();
  return text;
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

  const expanded = rules.expandProduct(product, { departmentCode: code, colorTable });
  /* §12 re-checks the rules against what is actually there NOW, so a row that
     stopped validating since it was built — a colour code withdrawn, say —
     has to reopen the report rather than pass because it validated once. */
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
  /* Every branch carries the URL, not just the one that reaches the storefront
     check: the "after pricing and publishing, open <url> signed out" line in
     "Needs Dan" is the most-read instruction in the report, and the
     pendingLaunch branch used to leave a hole where the link should be. */
  const handle = clean(record.collection?.handle);
  const base = {
    checked: false,
    closedToPublic: null,
    opensWithSecretLink: null,
    publicProductLinks: null,
    collectionUrl: clean(record.collection?.storefrontUrl) || (handle ? `https://${storefrontDomain()}/collections/${handle}` : ""),
    productCount,
    pendingLaunch: false,
    reason: ""
  };
  if (!handle) return { ...base, reason: "The collection has no handle yet." };
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

  /* §12 the menu is readable and writable with the app's current scopes, so a
     recorded "applied" is a claim and the live menu is the proof — read it
     back and let what is actually there decide. The recorded status only
     stands in when the menu cannot be read at all (scope withdrawn, Shopify
     down); trusting it otherwise is how an item nobody created passes. */
  const menuStatus = record.sharedSettings.megaMenu.status;
  let menuCheck;
  try {
    menuCheck = await shop().verifyMegaMenu(rules.megaMenuItemTitle(record.collection.title), { collectionGid: record.collection.gid, includeMenu: true });
  } catch (error) {
    menuCheck = { available: false, present: false, reason: errorText(error) };
  }
  /* The item being in the live menu proves the item, not the menu. On 13 Oct
     2026 it was there — alone, in a Store list that had held 112 stores an
     hour earlier — and this check reported "Mega Menu carries …" and let the
     record complete. A menu that looks wiped holds the record open until it
     is restored or Dan accepts it as it is. "is not confirmed" is what files
     the line under missing information (see the classifier below). */
  const menuSeen = menuCheck.available ? await observeMenu(menuCheck.menu, "final-check", { by }) : null;
  const menuWiped = Boolean(menuSeen && !menuSeen.healthy);
  if (menuWiped) {
    unresolved.push(`The Mega Menu's Store list is not confirmed healthy: ${menuSeen.reasons.join(" ")} Restore it, or accept it as it is, before finishing.`);
  }
  if (menuCheck.available && menuCheck.present) {
    if (!menuWiped) report.completed.push(
      `Mega Menu carries "${record.collection.title}"${menuCheck.before ? `, directly below "${menuCheck.before}"` : ""}${
        menuCheck.after ? ` and above "${menuCheck.after}"` : ""
      } (read back from the live menu).`
    );
  } else if (menuCheck.available) {
    /* "is not confirmed" is load-bearing: the classifier at the end of this
       function sorts unresolved lines into missing information vs. warnings by
       exactly that phrase, and an absent menu item is missing information. */
    unresolved.push(
      `The Mega Menu item for "${record.collection.title}" is not confirmed — the live menu was read back and the item is not there (recorded ${menuStatus}).`
    );
  } else if (menuStatus === "verified" || menuStatus === "applied") {
    report.completed.push(
      `Mega Menu recorded as ${menuStatus} for "${record.collection.title}", but the menu could not be read back to prove it (${menuCheck.reason || "the menu could not be read"}).`
    );
  } else {
    unresolved.push(`The Mega Menu item for "${record.collection.title}" is not confirmed (${menuStatus}).`);
  }
  /* Flow has no API: "confirmed" is the operator's word, so the report says
     whose word it is instead of claiming the condition carries the tag. */
  if (record.sharedSettings.flow.status === "confirmed") {
    report.completed.push(
      `Shopify Flow confirmed by ${clean(record.sharedSettings.flow.confirmedBy) || "the operator"} for "${record.department.tag}" — Flow has no API, so the agent cannot read it back.`
    );
  } else unresolved.push(`The Shopify Flow condition for "${record.department.tag}" is not confirmed (${record.sharedSettings.flow.status}).`);
  const heliumStatus = record.sharedSettings.helium.status;
  if (heliumStatus === "verified") report.completed.push(`All Helium forms carry "${record.department.tag}" (read back and checked).`);
  else if (heliumStatus === "confirmed")
    report.completed.push(
      `Helium forms confirmed by ${clean(record.sharedSettings.helium.confirmedBy) || "the operator"} for "${record.department.tag}" — Helium has no API to read them all back.`
    );
  else unresolved.push(`The Helium forms for "${record.department.tag}" are not confirmed (${heliumStatus}).`);

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
        report.missingInformation.push(`${product.title || product.id} ${mockup.color} ${mockup.face}: ${mockupReason(mockup)}`);
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
  /* The exact list that kept this from "complete". The classifier above sorts
     unresolved lines into missing information vs. warnings, so a blocker like
     "no front image" landed among the non-blocking warnings: the finish card
     showed nothing unresolved and the button appeared to do nothing. */
  report.unresolved = [...new Set([...unresolved, ...report.missingInformation])];
  record = await store().updateOnboarding(id, (r) => {
    if (build) {
      build.heartbeatAt = nowIso();
      r.build = build;
    }
    r.report = { ...r.report, ...report };
    // The read-back above is the same proof verifySharedSettings records, so
    // the console shows "verified" rather than the operator's "applied".
    if (menuCheck.available && menuCheck.present && !menuWiped && r.sharedSettings.megaMenu.status !== "verified") {
      r.sharedSettings.megaMenu = { ...r.sharedSettings.megaMenu, status: "verified", verifiedAt: nowIso(), error: "", health: null, checklist: withoutRestoreStep(r.sharedSettings.megaMenu.checklist) };
    }
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
      // A partial run (Redo images, or products added to a built store)
      // resumes as one; the rest of the store is not walked again.
      const scope = record.build?.scope;
      const only = Array.isArray(scope?.productIds) && scope.productIds.length ? scope.productIds : null;
      const result = await startBuild(summary.id, { force: true, by: "resume", only, kind: scope?.kind || "images" });
      if (result.started) resumed++;
      else onLog(`resume of ${summary.id} not started: ${result.reason}`);
    } catch (error) {
      onLog(`resume of ${summary.id} failed: ${errorText(error)}`);
    }
  }
  return { resumed };
}

/* ---------------------------------------------------------------------------
   A store the agent built: where it lives, and deleting all of it
   ------------------------------------------------------------------------- */

// The onboarding record behind a Shopify collection, or null for a store the
// agent did not build (the 100+ stores that predate it).
async function recordForCollection(collectionId) {
  const want = String(collectionId || "").replace(/^gid:\/\/shopify\/Collection\//, "");
  if (!want) return null;
  for (const summary of await store().listOnboardings()) {
    const record = await store().getOnboarding(summary.id);
    const id = String(record.collection.id || "") || String(record.collection.gid || "").replace(/^gid:\/\/shopify\/Collection\//, "");
    if (id && id === want) return record;
  }
  return null;
}

// What the department page shows: the Drive links and whether it can delete.
async function storeInfo(collectionId) {
  const record = await recordForCollection(collectionId);
  if (!record) {
    return { builtByAgent: false, adopted: false, deletable: false, reason: "This store was not built by the Onboarding Agent, so it cannot be deleted from here." };
  }
  /* An adopted record only holds the products added from the Departments
     page; the store itself was built outside the agent and stays undeletable. */
  const adopted = Boolean(record.adopted);
  return {
    builtByAgent: !adopted,
    adopted,
    building: isBuildActive(record.id),
    deletable: !adopted && !isBuildActive(record.id),
    reason: adopted
      ? "This store was not built by the Onboarding Agent, so it cannot be deleted from here."
      : isBuildActive(record.id)
        ? "The store is building. Wait for the build to finish."
        : "",
    onboardingId: record.id,
    departmentName: record.department.name,
    code: departmentCode(record),
    collectionTitle: record.collection.title,
    drive: {
      departmentFolderUrl: record.drive.departmentFolderUrl || "",
      productionFolderUrl: record.drive.productionFolderUrl || ""
    }
  };
}

/*
 * Delete a store the agent built: the Mega Menu item and Locksmith lock that
 * point at it, its products, the collection, both Drive folders (trashed, so
 * Drive keeps them 30 days), its row on the Department Code List and the
 * onboarding record. Every step runs and reports on its own; one failure never
 * hides the others. Refused for any store the agent did not build, for a
 * store with a live (Active) product, and unless the name is typed exactly.
 */
async function deleteStore(collectionId, { confirmName = "", by = "" } = {}) {
  const record = await recordForCollection(collectionId);
  if (!record) throw badRequest("Only stores built by the Onboarding Agent can be deleted here.");
  if (record.adopted) {
    throw badRequest("This store was not built by the Onboarding Agent (its record only holds the products added from the Departments page), so it cannot be deleted from here.");
  }
  if (isBuildActive(record.id)) {
    const error = new Error("The store is building. Wait for the build to finish before deleting it.");
    error.code = "BUILD_RUNNING";
    throw error;
  }
  const names = [record.department.name, record.collection.title].map((n) => clean(n).toLowerCase());
  if (!names.includes(clean(confirmName).toLowerCase())) {
    throw badRequest(`Type the store name exactly ("${record.collection.title || record.department.name}") to delete it.`);
  }

  const gid = record.collection.gid || `gid://shopify/Collection/${record.collection.id}`;
  const code = departmentCode(record);
  /* A delete that stopped half-way (a Drive or Locksmith failure keeps the
     record) must be finishable. The first attempt already removed the
     collection, and refusing "not found" here left the lock, the folders and
     the record stranded with no way to delete them from the console. */
  let products = [];
  let collectionGone = false;
  try {
    ({ products } = await shop().storeProducts(gid));
  } catch (error) {
    if (!/not found/i.test(errorText(error))) throw error;
    collectionGone = true;
  }
  const live = products.filter((p) => p.status === "ACTIVE");
  if (live.length) {
    throw badRequest(`${live.length} product(s) are Active and selling (${live.map((p) => p.title).join(", ")}). Set them to Draft first — a live store is never deleted from here.`);
  }

  const done = [];
  const manual = [];
  const failed = [];
  const step = async (label, run) => {
    try {
      const result = await run();
      if (result) done.push(result);
    } catch (error) {
      failed.push(`${label}: ${errorText(error)}`);
    }
  };

  /* The removal is a whole-tree menuUpdate like the insert, so a menu that
     looks wiped is left exactly as it is: taking one item out of it would
     make the wipe permanent. Judged on a read here, and again by
     removeMegaMenuItemsFor on its own read against the same copy. */
  await step("Mega Menu", async () => {
    const leftAlone = (reason) =>
      manual.push(`The Mega Menu looks wiped, so the agent did not touch it: ${reason} Once it is restored, remove "${record.collection.title}" from it by hand if it is there.`);
    const read = await shop().readMegaMenu();
    const seen = read.available ? await observeMenu(read.menu, "delete-store", { by }) : null;
    if (seen && !seen.healthy) {
      leftAlone(wipedReason(seen));
      return "";
    }
    const result = await shop().removeMegaMenuItemsFor(gid, { baseline: await baselineForWrite() });
    if (result.suspect) {
      leftAlone(wipedReason({ reasons: [result.reason] }));
      return "";
    }
    if (!result.available) {
      manual.push(`Check the Mega Menu by hand — it could not be read (${result.reason}).`);
      return "";
    }
    return result.removed ? `Removed ${result.removed} Mega Menu item(s).` : "";
  });

  await step("Locksmith lock", async () => {
    if (!locksmith().configured()) {
      manual.push(`Delete the Locksmith lock on "${record.collection.title}" by hand.`);
      return "";
    }
    const lock = await locksmith().findLockForCollection(record.collection.id);
    if (!lock) return "";
    // Locksmith's own lock objects carry `_id`; `lock.id` was undefined and
    // the delete went to /locks/undefined.json.
    const lockId = lock.id != null ? lock.id : lock._id;
    try {
      await locksmith().deleteLock(lockId);
      return `Deleted Locksmith lock ${lockId}.`;
    } catch (error) {
      manual.push(`Delete Locksmith lock ${lockId} ("${record.collection.title}") by hand — the API refused (${errorText(error)}).`);
      return "";
    }
  });

  /* Every product that lives ONLY in this collection goes with it — all of
     them are Draft (checked above), and leaving them would orphan them. One
     tagged with another department's code is still deleted, but named, since
     it was built into this collection by mistake. A product that is also in
     another collection is only taken out of this one by the collection delete
     and is otherwise left alone. */
  let deleted = 0;
  const foreign = [];
  for (const product of products) {
    if (product.otherCollections.length) {
      manual.push(`"${product.title}" was left in Shopify — it is also in ${product.otherCollections.join(", ")}.`);
      continue;
    }
    const ours = !code || product.tags.map((t) => String(t).toUpperCase()).includes(code);
    await step(`Product "${product.title}"`, async () => {
      await shop().deleteProduct(product.gid);
      deleted += 1;
      if (!ours) foreign.push(`${product.title} (${product.tags.filter((t) => /^[A-Z]{3,4}$/.test(t)).join(", ") || "no department tag"})`);
      return "";
    });
  }
  if (deleted) done.push(`Deleted ${deleted} product(s).`);
  if (foreign.length) done.push(`Also deleted products from another department that were built into this collection: ${foreign.join("; ")}.`);

  await step("Collection", async () => {
    if (collectionGone) return `The collection "${record.collection.title}" was already deleted.`;
    await shop().deleteCollection(gid);
    return `Deleted the collection "${record.collection.title}".`;
  });

  for (const [label, folderId] of [
    ["Department folder", record.drive.departmentFolderId],
    ["Production folder", record.drive.productionFolderId]
  ]) {
    if (!folderId) continue;
    await step(label, async () => {
      await drive().trashFile(folderId);
      return `Moved the ${label.toLowerCase()} to the Drive trash (restorable for 30 days).`;
    });
  }

  await step("Department Code List", async () => {
    if (!code) return "";
    const rows = await tables().getRows("department-codes");
    const row = rows.find((r) => String(r.code).toUpperCase() === code && sameAgency(r.agency, record.department.name));
    // A code from the official list stays: the agency still exists.
    if (!row || !["onboarding", "fn"].includes(String(row.source || ""))) return "";
    await tables().removeRow("department-codes", row.code);
    return `Freed the code ${code} on the Department Code List.`;
  });

  manual.push(`Remove "${record.department.tag}" from the Helium registration form's Department options, if it was added.`);
  manual.push(`Remove "${record.department.tag}" from the Shopify Flow condition, if it was added.`);

  // The record goes last, and only when Shopify is clean — it is the only map
  // back to anything a failed step left behind.
  if (!failed.length) {
    await step("Onboarding record", async () => {
      await store().deleteOnboarding(record.id);
      return "Deleted the onboarding record.";
    });
  } else {
    manual.push("The onboarding record was kept because a step failed — fix it and delete again.");
  }

  return { deleted: !failed.length, storeName: record.collection.title || record.department.name, done, manual, failed, by: clean(by) };
}

module.exports = {
  setDeps,
  storeInfo,
  deleteStore,
  capabilities,
  createOnboarding,
  addFiles,
  removeFile,
  runSetup,
  approveCode,
  ensureDriveFolders,
  reviewPolicy,
  saveProducts,
  saveProduct,
  removeProduct,
  createProducts,
  adoptStore,
  proposeColor,
  startBuild,
  redoProductImages,
  proposeSharedSettings,
  approveSharedSetting,
  verifySharedSettings,
  menuHealth,
  acceptMenuBaseline,
  restoreMegaMenu,
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

const crypto = require("crypto");
const { blobConfigured, containerClient, readJson, deleteBlob } = require("./platformBlob");
const rules = require("./onboardingRules");

/*
 * Department Onboarding Agent — the onboarding record store.
 *
 * One record per department onboarding (Build Spec, Part 4: "One onboarding
 * record per department holding products, decorations, files, variants, SKUs,
 * Shopify IDs, and status"). Records are JSON blobs in the
 * "department-onboardings" container, named by their id
 * ("2026-09-21-vacaville-fire-department-1a2b3c4d.json"), exactly like
 * customer intakes. Binary packet files, blank photos, proofs, mockups and the
 * banner are separate blobs under "<id without .json>/assets/<assetId>" so a
 * record stays small enough to read on every list and every build step.
 *
 * Writes to one record are serialised through a per-id promise chain and
 * always re-read the blob first, so a running build flushing progress and a
 * console PATCH landing at the same moment never overwrite each other (the
 * same read-modify-write discipline as linkBook.js).
 *
 * The blob layer is reached through a small adapter so unit tests can swap in
 * an in-memory fake (setBlobAdapter / memoryBlobAdapter) — no storage account,
 * no network. The real adapter builds on platformBlob's cached container
 * client; it only adds blob metadata, which platformBlob's writers do not take
 * and which keeps records identifiable in the portal without downloading them.
 */

const CONTAINER = "department-onboardings";
const SCHEMA_VERSION = 1;
const EVENTS_RING = 200;
const BUILD_LOG_RING = 300;
const ASSET_ID_RE = /^[a-z0-9-]+(\.[a-z0-9]+)?$/i;
// Generated ids are lowercase alphanumerics and dashes ending in ".json"; the
// charset rules out "/", "\" and ".." so an id can never escape the container
// root or point at an asset blob.
const RECORD_ID_RE = /^[a-z0-9][a-z0-9-]*\.json$/i;
const LIST_BATCH = 10;

/* ---------------------------------------------------------------------------
   Blob adapter
   ------------------------------------------------------------------------- */

function azureBlobAdapter() {
  return {
    configured: () => blobConfigured(),
    readJson: (name) => readJson(CONTAINER, name, null),
    async writeJson(name, value, metadata) {
      const client = await containerClient(CONTAINER);
      const body = Buffer.from(JSON.stringify(value, null, 2), "utf8");
      await client.getBlockBlobClient(name).upload(body, body.length, {
        blobHTTPHeaders: { blobContentType: "application/json" },
        metadata
      });
      return { size: body.length };
    },
    async writeBuffer(name, buffer, contentType, metadata) {
      const client = await containerClient(CONTAINER);
      await client.getBlockBlobClient(name).upload(buffer, buffer.length, {
        blobHTTPHeaders: { blobContentType: contentType || "application/octet-stream" },
        metadata
      });
      return { size: buffer.length };
    },
    async readBlob(name) {
      const client = await containerClient(CONTAINER);
      const blob = client.getBlockBlobClient(name);
      try {
        const [buffer, properties] = await Promise.all([blob.downloadToBuffer(), blob.getProperties()]);
        return { buffer, contentType: properties.contentType || "", metadata: properties.metadata || {} };
      } catch (error) {
        if (error?.statusCode === 404) return null;
        throw error;
      }
    },
    deleteBlob: (name) => deleteBlob(CONTAINER, name),
    async listBlobs(prefix = "") {
      const client = await containerClient(CONTAINER);
      const out = [];
      for await (const item of client.listBlobsFlat({ prefix, includeMetadata: true })) {
        out.push({
          name: item.name,
          size: Number(item.properties?.contentLength || 0),
          contentType: item.properties?.contentType || "",
          metadata: item.metadata || {},
          createdOn: item.properties?.createdOn ? new Date(item.properties.createdOn).toISOString() : "",
          lastModified: item.properties?.lastModified ? new Date(item.properties.lastModified).toISOString() : ""
        });
      }
      return out;
    }
  };
}

/*
 * In-memory stand-in with the same surface as the Azure adapter. Exported for
 * tests (this module's and the agent's / routes') so every suite does not
 * re-implement the fake. Never used in production.
 */
function memoryBlobAdapter() {
  const blobs = new Map();
  const stamp = () => new Date().toISOString();
  return {
    blobs,
    configured: () => true,
    async readJson(name) {
      const blob = blobs.get(name);
      return blob ? JSON.parse(blob.body.toString("utf8")) : null;
    },
    async writeJson(name, value, metadata) {
      const body = Buffer.from(JSON.stringify(value, null, 2), "utf8");
      const prior = blobs.get(name);
      blobs.set(name, { body, contentType: "application/json", metadata: { ...(metadata || {}) }, createdOn: prior?.createdOn || stamp(), lastModified: stamp() });
      return { size: body.length };
    },
    async writeBuffer(name, buffer, contentType, metadata) {
      const prior = blobs.get(name);
      blobs.set(name, { body: Buffer.from(buffer), contentType: contentType || "application/octet-stream", metadata: { ...(metadata || {}) }, createdOn: prior?.createdOn || stamp(), lastModified: stamp() });
      return { size: buffer.length };
    },
    async readBlob(name) {
      const blob = blobs.get(name);
      return blob ? { buffer: Buffer.from(blob.body), contentType: blob.contentType, metadata: { ...blob.metadata } } : null;
    },
    async deleteBlob(name) {
      blobs.delete(name);
    },
    async listBlobs(prefix = "") {
      return [...blobs.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, blob]) => ({ name, size: blob.body.length, contentType: blob.contentType, metadata: { ...blob.metadata }, createdOn: blob.createdOn, lastModified: blob.lastModified }));
    }
  };
}

let adapter = azureBlobAdapter();

/** Test hook: swap the blob layer. Returns the previous adapter so a test can restore it. */
function setBlobAdapter(next) {
  const previous = adapter;
  adapter = next || azureBlobAdapter();
  return previous;
}

function storeConfigured() {
  return Boolean(adapter.configured());
}

function requireStore() {
  if (storeConfigured()) return;
  const error = new Error("AZURE_STORAGE_CONNECTION_STRING is not set, so department onboardings cannot be stored.");
  error.code = "STORAGE_UNCONFIGURED";
  throw error;
}

function notFound(what) {
  const error = new Error(`${what} was not found.`);
  error.code = "NOT_FOUND";
  return error;
}

function badRequest(message) {
  const error = new Error(message);
  error.code = "BAD_REQUEST";
  return error;
}

/* Blob metadata values must be ASCII; anything else would fail the write of
   the whole record over a label. Non-ASCII bytes are dropped, not the field;
   a value that ends up empty is dropped because the service rejects it. */
function cleanMetadata(metadata = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    // eslint-disable-next-line no-control-regex
    const ascii = String(value).replace(/[^\x20-\x7e]/g, "").trim().slice(0, 256);
    if (ascii) clean[key] = ascii;
  }
  return clean;
}

/* ---------------------------------------------------------------------------
   Ids
   ------------------------------------------------------------------------- */

function clean(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function slug(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "department";
}

function isRecordId(id) {
  const s = String(id || "");
  return RECORD_ID_RE.test(s) && !s.includes("..") && !s.includes("/") && !s.includes("\\");
}

function assertRecordId(id) {
  if (!isRecordId(id)) throw notFound(`Onboarding "${String(id)}"`);
  return String(id);
}

/* "<id minus .json>" — the folder every asset of the record lives under. */
function recordBase(id) {
  return String(id).replace(/\.json$/i, "");
}

function assetPrefix(id) {
  return `${recordBase(id)}/assets/`;
}

function assetBlobName(id, assetId) {
  return `${assetPrefix(id)}${assetId}`;
}

/*
 * "YYYY-MM-DD-<slug>-<8 hex>.json". The hex defaults to the first 8 of a
 * fresh uuid; createOnboarding passes the record's own requestId so the id
 * and the request correlate exactly the way customer intakes do.
 */
function newOnboardingId(departmentName, now = new Date(), hex = null) {
  const date = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  const tail = String(hex || crypto.randomUUID().replace(/-/g, "")).toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 8);
  return `${date}-${slug(departmentName)}-${tail || crypto.randomUUID().replace(/-/g, "").slice(0, 8)}.json`;
}

function newAssetId(name) {
  const ext = (String(name || "").match(/\.([a-z0-9]{1,8})$/i) || [])[1];
  // 36^6 (2.18e9) fits a uint32 modulo without bias worth caring about here.
  const random = (crypto.randomBytes(4).readUInt32BE(0) % 36 ** 6).toString(36).padStart(6, "0");
  return `${Date.now().toString(36)}-${random}${ext ? `.${ext.toLowerCase()}` : ""}`;
}

/* ---------------------------------------------------------------------------
   Record shape (design doc §2)
   ------------------------------------------------------------------------- */

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/*
 * Fill every missing field of `target` from `defaults`, recursing into plain
 * objects. Existing values — including unknown keys — are kept, so a record
 * written by an older schema gains new fields without losing anything, and a
 * partial object from a PATCH becomes whole. Arrays are taken as-is (their
 * elements are normalised by the caller where the shape is known).
 */
function fill(target, defaults) {
  const out = isPlainObject(target) ? target : {};
  for (const [key, def] of Object.entries(defaults)) {
    const current = out[key];
    if (current === undefined) out[key] = deepClone(def);
    else if (isPlainObject(def)) out[key] = fill(current === null ? {} : current, def);
    else if (Array.isArray(def) && !Array.isArray(current)) out[key] = deepClone(def);
  }
  return out;
}

function normalizeContact(input) {
  if (!isPlainObject(input)) return null;
  const contact = { name: clean(input.name), role: clean(input.role), email: clean(input.email), phone: clean(input.phone) };
  return contact.name || contact.role || contact.email || contact.phone ? contact : null;
}

function normalizeOrdinal(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function normalizeCodeValue(value) {
  const s = clean(value).toUpperCase();
  return s || null;
}

const PACKET_FILE_DEFAULTS = {
  assetId: "",
  name: "",
  kind: "other",
  contentType: "",
  size: 0,
  driveFileId: "",
  driveUrl: "",
  role: "",
  text: "",
  description: ""
};

const PRODUCT_DEFAULTS = {
  id: "",
  brand: "",
  styleNumber: "",
  type: "",
  title: "",
  colors: [],
  sizes: [],
  decorationMethod: "",
  decorationCodes: "",
  styles: [],
  fulfillment: "",
  classB: false,
  notes: "",
  blankPhotos: {},
  proofs: {},
  sourceProduct: { id: "", title: "", kind: "", url: "" },
  // ok: null means "not validated yet" — distinct from a validated failure
  // (false, with errors) so the UI never shows an unexplained red state.
  validation: { ok: null, errors: [], warnings: [], assumptions: [], skuPreview: [] },
  mockups: [],
  shopify: { productId: "", gid: "", url: "", variantCount: 0, createdAt: "" },
  buildState: "pending",
  buildError: ""
};

function normalizePacketFile(input) {
  const file = fill(isPlainObject(input) ? input : {}, PACKET_FILE_DEFAULTS);
  file.size = Number(file.size) || 0;
  return file;
}

/** One product row with every sub-object present. `index` seeds a missing id ("p1", "p2"…). */
function normalizeProduct(input, index = 0) {
  const product = fill(isPlainObject(input) ? input : {}, PRODUCT_DEFAULTS);
  if (!clean(product.id)) product.id = `p${index + 1}`;
  product.classB = product.classB === true || product.classB === "true" || product.classB === "yes";
  return product;
}

function collectionTitleFor(department) {
  const ordinal = normalizeOrdinal(department.storeOrdinal);
  const storeName = ordinal > 1 && clean(department.storeName) ? clean(department.storeName) : clean(department.name);
  return storeName ? rules.collectionTitle(storeName, ordinal) : "";
}

function recordDefaults({ name = "", state = "", storeOrdinal = 1, storeName = "", contacts = [], notes = "" } = {}) {
  const tag = rules.departmentTag(name);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: null,
    requestId: null,
    createdAt: null,
    updatedAt: null,
    status: "packet",
    phase: "packet",
    department: {
      name: clean(name),
      tag,
      state: clean(state).toUpperCase(),
      storeOrdinal: normalizeOrdinal(storeOrdinal),
      storeName: clean(storeName),
      contacts: (Array.isArray(contacts) ? contacts : []).map(normalizeContact).filter(Boolean),
      code: { value: null, source: null, approved: false, approvedAt: null, approvedBy: "", candidates: [], matches: [] }
    },
    packet: { files: [], notes: String(notes == null ? "" : notes) },
    drive: {
      departmentFolderId: "",
      departmentFolderUrl: "",
      productImagesFolderId: "",
      productionFolderId: "",
      productionFolderUrl: "",
      productionFiles: [],
      productionFilesReadAt: ""
    },
    policyReview: {
      reviewedAt: "",
      confirmed: [],
      missing: [],
      questions: [],
      emailDraft: { subject: "", body: "" },
      driveDocId: "",
      driveDocUrl: "",
      suggestedProducts: []
    },
    products: [],
    collection: {
      title: "",
      id: "",
      gid: "",
      handle: "",
      url: "",
      storefrontUrl: "",
      bannerAssetId: "",
      bannerDriveUrl: "",
      bannerLogoAssetId: "",
      bannerLogoReason: "",
      descriptionSet: false
    },
    lock: {
      status: "pending",
      locksmithLockId: "",
      secretCode: "",
      secretLink: "",
      tagKey: "",
      /* §7.2's four settings. null is "nobody has established this yet" —
         they used to default to true, which is how a lock that did not exist
         yet reported all four as checked. */
      settings: { enabled: null, protectProducts: null, hideFromNavigation: null, hideFromLists: null },
      /* What the lock actually DOES, measured from outside: Locksmith's option
         names are undocumented, so this is the only honest evidence. */
      access: { checkedAt: "", closedToPublic: null, opensWithSecretLink: null, publicProductLinks: null, reason: "" },
      checklist: [],
      error: "",
      verifiedAt: ""
    },
    sharedSettings: {
      megaMenu: {
        status: "pending",
        proposal: { insertAfter: "", insertBefore: "", index: 0, title: "", url: "" },
        checklist: [],
        approvedAt: "",
        approvedBy: "",
        appliedAt: "",
        verifiedAt: "",
        error: ""
      },
      flow: { status: "pending", checklist: [], confirmedAt: "", confirmedBy: "" },
      helium: { status: "pending", forms: [] }
    },
    approvals: [],
    build: { state: "", startedAt: "", heartbeatAt: "", finishedAt: null, error: null, steps: [], log: [] },
    report: { generatedAt: "", completed: [], needsDan: [], missingInformation: [], warnings: [], driveDocUrl: "" },
    events: []
  };
}

/**
 * The full default record for a new packet. Pure: no id, requestId or
 * timestamps — createOnboarding assigns those when it writes the blob.
 */
function emptyRecord({ departmentName = "", state = "", storeOrdinal = 1, storeName = "", contacts = [], notes = "" } = {}) {
  const record = recordDefaults({ name: departmentName, state, storeOrdinal, storeName, contacts, notes });
  record.collection.title = collectionTitleFor(record.department);
  return record;
}

/**
 * Bring any stored or incoming record up to the current shape: every
 * sub-object present, defaults filled, unknown keys kept, department.tag
 * recomputed from the name (the tag IS the name by rule, so it can never
 * drift), updatedAt untouched. Returns a new object.
 */
function normalizeRecord(input) {
  const source = isPlainObject(input) ? deepClone(input) : {};
  const dept = isPlainObject(source.department) ? source.department : {};
  const record = fill(source, recordDefaults({
    name: dept.name,
    state: dept.state,
    storeOrdinal: dept.storeOrdinal,
    storeName: dept.storeName,
    contacts: dept.contacts,
    notes: isPlainObject(source.packet) ? source.packet.notes : ""
  }));

  record.schemaVersion = Number(record.schemaVersion) || SCHEMA_VERSION;
  record.status = clean(record.status) || "packet";
  record.phase = clean(record.phase) || "packet";

  const department = record.department;
  department.name = clean(department.name);
  department.tag = rules.departmentTag(department.name);
  department.state = clean(department.state).toUpperCase();
  department.storeOrdinal = normalizeOrdinal(department.storeOrdinal);
  department.storeName = clean(department.storeName);
  department.contacts = (Array.isArray(department.contacts) ? department.contacts : []).map(normalizeContact).filter(Boolean);
  department.code.value = normalizeCodeValue(department.code.value);
  department.code.approved = department.code.approved === true;
  if (!Array.isArray(department.code.candidates)) department.code.candidates = [];
  if (!Array.isArray(department.code.matches)) department.code.matches = [];

  record.packet.notes = String(record.packet.notes == null ? "" : record.packet.notes);
  record.packet.files = record.packet.files.map(normalizePacketFile);
  record.products = record.products.map((row, index) => normalizeProduct(row, index));

  // The title follows the rules until the collection exists in Shopify; after
  // that the live title is the truth, whatever the department is renamed to.
  if (!clean(record.collection.id) && !clean(record.collection.gid)) {
    record.collection.title = collectionTitleFor(department);
  }

  record.events = record.events.filter(isPlainObject).slice(-EVENTS_RING);
  record.build.log = record.build.log.map((line) => String(line)).slice(-BUILD_LOG_RING);
  if (!Array.isArray(record.approvals)) record.approvals = [];
  return record;
}

/* ---------------------------------------------------------------------------
   Pure helpers on a record
   ------------------------------------------------------------------------- */

/** Append to the audit trail (ring of 200, newest last). Mutates and returns the record. */
function appendEvent(record, { type = "note", message = "", by = "" } = {}) {
  if (!Array.isArray(record.events)) record.events = [];
  record.events.push({ at: new Date().toISOString(), type: clean(type) || "note", message: String(message == null ? "" : message), by: clean(by) });
  if (record.events.length > EVENTS_RING) record.events.splice(0, record.events.length - EVENTS_RING);
  return record;
}

/** Append a build log line in the same "HH:MM:SS message" form intakeBuild.js uses (ring of 300). */
function buildLog(record, message) {
  if (!isPlainObject(record.build)) record.build = deepClone(recordDefaults().build);
  if (!Array.isArray(record.build.log)) record.build.log = [];
  record.build.log.push(`${new Date().toISOString().slice(11, 19)} ${String(message == null ? "" : message)}`);
  if (record.build.log.length > BUILD_LOG_RING) record.build.log.splice(0, record.build.log.length - BUILD_LOG_RING);
  return record;
}

/** The list-view shape (design doc §2). Pure and tolerant of partial records. */
function summarize(record) {
  const r = isPlainObject(record) ? record : {};
  const department = isPlainObject(r.department) ? r.department : {};
  const code = isPlainObject(department.code) ? department.code : {};
  const products = Array.isArray(r.products) ? r.products : [];
  const packetFiles = isPlainObject(r.packet) && Array.isArray(r.packet.files) ? r.packet.files : [];
  const collection = isPlainObject(r.collection) ? r.collection : {};
  const build = isPlainObject(r.build) ? r.build : {};
  const report = isPlainObject(r.report) ? r.report : {};
  const name = clean(department.name);
  return {
    id: r.id || null,
    requestId: r.requestId || null,
    createdAt: r.createdAt || null,
    updatedAt: r.updatedAt || null,
    status: clean(r.status) || "packet",
    phase: clean(r.phase) || "packet",
    department: {
      name,
      tag: rules.departmentTag(name),
      code: { value: code.value || null, approved: code.approved === true, source: code.source || null }
    },
    counts: {
      products: products.length,
      mockups: products.reduce((sum, product) => sum + (Array.isArray(product?.mockups) ? product.mockups.length : 0), 0),
      packetFiles: packetFiles.length
    },
    collection: { title: collection.title || "", url: collection.url || "" },
    // stepsDone/stepsTotal, not the whole steps array: the queue card draws a
    // progress bar from them, and without any step data it always read 0%.
    build: {
      state: build.state || "",
      startedAt: build.startedAt || "",
      finishedAt: build.finishedAt || null,
      error: build.error || null,
      stepsDone: (build.steps || []).filter((step) => step && step.state === "complete").length,
      stepsTotal: (build.steps || []).length
    },
    report: { generatedAt: report.generatedAt || "" }
  };
}

/* ---------------------------------------------------------------------------
   Records
   ------------------------------------------------------------------------- */

function recordMetadata(record) {
  return cleanMetadata({
    kind: "department-onboarding",
    status: record.status,
    department: record.department?.name,
    requestId: record.requestId
  });
}

// Per-record write queues. Reads happen inside the queued step so every writer
// sees the latest blob, not the copy it was holding when it queued.
const chains = new Map();

function serialized(id, work) {
  const previous = chains.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  chains.set(id, next);
  const settle = () => {
    if (chains.get(id) === next) chains.delete(id);
  };
  next.then(settle, settle);
  return next;
}

/** Resolves once every queued write has reached storage (scripts await this before exiting). */
async function flushWrites() {
  await Promise.all([...chains.values()].map((p) => p.catch(() => {})));
}

async function readRecord(id) {
  const raw = await adapter.readJson(id);
  if (!raw) throw notFound(`Onboarding "${id}"`);
  return normalizeRecord(raw);
}

async function writeRecord(record) {
  await adapter.writeJson(record.id, record, recordMetadata(record));
  return record;
}

async function createOnboarding(fields = {}) {
  requireStore();
  const departmentName = clean(fields.departmentName);
  if (!departmentName) throw badRequest("Department name is required.");
  const record = emptyRecord({ ...fields, departmentName });
  const now = new Date();
  record.requestId = crypto.randomUUID();
  record.id = newOnboardingId(departmentName, now, record.requestId.replace(/-/g, "").slice(0, 8));
  record.createdAt = now.toISOString();
  record.updatedAt = record.createdAt;
  appendEvent(record, { type: "created", message: `Packet opened for ${departmentName}`, by: fields.by });
  return serialized(record.id, () => writeRecord(record));
}

async function getOnboarding(id) {
  requireStore();
  return readRecord(assertRecordId(id));
}

async function listOnboardings() {
  requireStore();
  const names = (await adapter.listBlobs("")).map((blob) => blob.name).filter(isRecordId);
  const summaries = [];
  for (let i = 0; i < names.length; i += LIST_BATCH) {
    const batch = names.slice(i, i + LIST_BATCH).map(async (name) => {
      try {
        const raw = await adapter.readJson(name);
        if (!raw) return null;
        return summarize(normalizeRecord({ ...raw, id: name }));
      } catch (error) {
        // One corrupt blob must not hide every other onboarding from the console.
        return { ...summarize({ id: name, status: "error" }), error: String(error?.message || error) };
      }
    });
    summaries.push(...(await Promise.all(batch)));
  }
  return summaries
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || String(b.id).localeCompare(String(a.id)));
}

/**
 * Read-modify-write one record. `mutator` is a function (record) => record |
 * void | Promise (in-place mutation allowed) or a plain object merged at the
 * top level. The stored record is re-read inside the per-id queue, so two
 * writers (a build flush and a UI PATCH) apply in order on fresh data.
 */
async function updateOnboarding(id, mutator) {
  requireStore();
  const recordId = assertRecordId(id);
  return serialized(recordId, async () => {
    const stored = await readRecord(recordId);
    let next = stored;
    if (typeof mutator === "function") {
      const result = await mutator(stored);
      next = isPlainObject(result) ? result : stored;
    } else if (isPlainObject(mutator)) {
      next = { ...stored, ...mutator };
    } else if (mutator !== undefined && mutator !== null) {
      throw badRequest("updateOnboarding expects a mutator function or a plain object.");
    }
    const record = normalizeRecord(next);
    // Identity never changes through an update, whatever the mutator did.
    record.id = recordId;
    record.requestId = stored.requestId || record.requestId;
    record.createdAt = stored.createdAt || record.createdAt;
    record.updatedAt = new Date().toISOString();
    return writeRecord(record);
  });
}

/** Removes the record and every asset under its prefix. Never touches Shopify or Drive. */
async function deleteOnboarding(id) {
  requireStore();
  const recordId = assertRecordId(id);
  return serialized(recordId, async () => {
    await readRecord(recordId);
    const assets = await adapter.listBlobs(assetPrefix(recordId));
    for (const asset of assets) await adapter.deleteBlob(asset.name);
    await adapter.deleteBlob(recordId);
    return { deletedAssets: assets.length };
  });
}

/* ---------------------------------------------------------------------------
   Assets
   ------------------------------------------------------------------------- */

function isAssetId(assetId) {
  return ASSET_ID_RE.test(String(assetId || ""));
}

async function putAsset(id, { name, contentType, buffer, kind, meta } = {}) {
  requireStore();
  const recordId = assertRecordId(id);
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw badRequest("putAsset needs a Buffer.");
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  // An asset without a record would be unreachable and never cleaned up.
  await readRecord(recordId);
  const assetName = clean(name) || "asset";
  const type = clean(contentType) || "application/octet-stream";
  const assetKind = clean(kind) || "other";
  const assetId = newAssetId(assetName);
  const metadata = cleanMetadata({ ...(isPlainObject(meta) ? meta : {}), kind: assetKind, name: assetName, contentType: type });
  await adapter.writeBuffer(assetBlobName(recordId, assetId), body, type, metadata);
  return { assetId, name: assetName, contentType: type, size: body.length, kind: assetKind, createdAt: new Date().toISOString() };
}

async function getAsset(id, assetId) {
  requireStore();
  const recordId = assertRecordId(id);
  if (!isAssetId(assetId)) return null;
  const blob = await adapter.readBlob(assetBlobName(recordId, assetId));
  if (!blob) return null;
  const metadata = blob.metadata || {};
  return {
    buffer: blob.buffer,
    contentType: metadata.contentType || blob.contentType || "application/octet-stream",
    name: metadata.name || String(assetId),
    kind: metadata.kind || "other",
    size: blob.buffer.length
  };
}

async function deleteAsset(id, assetId) {
  requireStore();
  const recordId = assertRecordId(id);
  if (!isAssetId(assetId)) throw badRequest(`"${String(assetId)}" is not an asset id.`);
  await adapter.deleteBlob(assetBlobName(recordId, assetId));
}

async function listAssets(id) {
  requireStore();
  const recordId = assertRecordId(id);
  const prefix = assetPrefix(recordId);
  return (await adapter.listBlobs(prefix))
    .map((blob) => {
      const assetId = blob.name.slice(prefix.length);
      const metadata = blob.metadata || {};
      return { assetId, name: metadata.name || assetId, contentType: metadata.contentType || blob.contentType || "", size: Number(blob.size) || 0, kind: metadata.kind || "other" };
    })
    .filter((asset) => isAssetId(asset.assetId))
    .sort((a, b) => a.assetId.localeCompare(b.assetId));
}

module.exports = {
  CONTAINER,
  SCHEMA_VERSION,
  EVENTS_RING,
  BUILD_LOG_RING,
  // ids
  newOnboardingId,
  isRecordId,
  isAssetId,
  recordBase,
  assetPrefix,
  // pure record helpers
  emptyRecord,
  normalizeRecord,
  normalizeProduct,
  appendEvent,
  buildLog,
  summarize,
  cleanMetadata,
  // storage
  storeConfigured,
  createOnboarding,
  getOnboarding,
  listOnboardings,
  updateOnboarding,
  deleteOnboarding,
  flushWrites,
  // assets
  putAsset,
  getAsset,
  deleteAsset,
  listAssets,
  // test hooks
  setBlobAdapter,
  memoryBlobAdapter
};

/*
 * Locksmith Admin API client for the Department Onboarding Agent (Build Spec
 * §7 "Locksmith lock").
 *
 * Locksmith exposes an (unstable) Admin API:
 *   https://uselocksmith.com/api/unstable
 *   headers  x-shopify-shop-domain, x-locksmith-access-token
 *   GET  /locks.json, GET /locks/:id.json
 *   POST /lock?install=true[&dryrun=true]
 *
 * The customer_tag condition is documented; the secret-link condition is not.
 * Rather than guessing its JSON shape, learnKeyTemplates() copies it from the
 * newest existing collection lock on the store (Locksmith's own docs say to
 * copy shapes from the app). When there is no lock to learn from, the shape
 * is guessed and validated with a dry run before the real create.
 *
 * Nothing here logs; callers pass an onLog callback. Every network call goes
 * through request(), which uses the injectable fetch so tests never touch the
 * network. When the token is missing, configured() is false and the caller
 * falls back to manualChecklist() — the agent never throws its way out of a
 * build step because an optional integration is absent.
 */

const crypto = require("crypto");

const BASE_URL = "https://uselocksmith.com/api/unstable";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_ERROR_BODY = 500;

// Resource types Locksmith uses for a collection lock, across app versions.
const COLLECTION_RESOURCE_TYPES = ["custom_collection", "collection", "smart_collection"];
const CUSTOMER_TAG_TYPE = "customer_tag";
const SECRET_TYPE_RE = /secret/i;
// Option keys on a secret-link condition that carry the code itself.
const SECRET_OPTION_KEY_RE = /secret|code|link/i;

// §7.2 — the four settings, by their names in the Locksmith UI.
const LOCK_SETTINGS = [
  "Enable this lock",
  "Protect products in this collection",
  "Hide from navigation menus",
  "Hide from lists"
];

/*
 * Lock options the spec's four settings map onto in the API. These always win
 * over anything learned from a template lock, so an older lock configured
 * differently can never loosen a new department's privacy.
 */
const SPEC_LOCK_OPTIONS = {
  hide_links_to_resource: true, // Hide from navigation menus
  hide_resource: true, // Hide from lists
  hide_resource_from_sitemaps: true,
  manual: false, // the lock applies automatically, no manual liquid
  noindex: true
};

// Key options Locksmith expects on every key; a template may add to them.
const DEFAULT_KEY_OPTIONS = {
  customer_autotag: "",
  force_open: false,
  redirect_url: "",
  inverse: false
};

/* ---------------------------------------------------------------------------
   HTTP
   ------------------------------------------------------------------------- */

let fetchImpl = null;

// Tests inject a fake; production uses Node 22's global fetch.
function setFetch(fn) {
  fetchImpl = fn;
}

function getFetch() {
  const fn = fetchImpl || globalThis.fetch;
  if (!fn) throw new Error("Node 18+ fetch is required for the Locksmith API.");
  return fn;
}

function configured() {
  return Boolean(String(process.env.SHOPIFY_STORE || "").trim()) && Boolean(String(process.env.LOCKSMITH_ACCESS_TOKEN || "").trim());
}

function headers() {
  return {
    "x-shopify-shop-domain": String(process.env.SHOPIFY_STORE || "").trim(),
    "x-locksmith-access-token": String(process.env.LOCKSMITH_ACCESS_TOKEN || "").trim(),
    "content-type": "application/json",
    accept: "application/json"
  };
}

function timeoutSignal() {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
}

async function request(method, path, body) {
  if (!configured()) {
    throw new Error("Locksmith is not configured: set SHOPIFY_STORE and LOCKSMITH_ACCESS_TOKEN (Locksmith settings > access tokens).");
  }
  const url = `${BASE_URL}${path}`;
  let res;
  try {
    res = await getFetch()(url, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutSignal()
    });
  } catch (error) {
    const wrapped = new Error(`Locksmith ${method} ${path} failed: ${error.message}`);
    wrapped.cause = error;
    throw wrapped;
  }
  const text = await res.text();
  if (!res.ok) {
    const error = new Error(`Locksmith ${method} ${path} returned ${res.status}: ${text.slice(0, MAX_ERROR_BODY)}`);
    error.status = res.status;
    error.body = text.slice(0, MAX_ERROR_BODY);
    throw error;
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    const wrapped = new Error(`Locksmith ${method} ${path} returned non-JSON: ${text.slice(0, MAX_ERROR_BODY)}`);
    wrapped.status = res.status;
    wrapped.body = text.slice(0, MAX_ERROR_BODY);
    throw wrapped;
  }
}

async function listLocks() {
  const data = await request("GET", "/locks.json");
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.locks)) return data.locks;
  return [];
}

async function getLock(id) {
  const data = await request("GET", `/locks/${encodeURIComponent(String(id))}.json`);
  if (data && data.lock && typeof data.lock === "object") return data.lock;
  return data;
}

/* ---------------------------------------------------------------------------
   Lock inspection (pure)
   ------------------------------------------------------------------------- */

// A lock's resources, whether the API nests them or keeps one at top level.
function lockResources(lock) {
  if (!lock || typeof lock !== "object") return [];
  if (Array.isArray(lock.resources) && lock.resources.length) return lock.resources.filter(Boolean);
  if (lock.resource_type || lock.resource_id != null) {
    return [{ resource_type: lock.resource_type, resource_id: lock.resource_id, resource_options: lock.resource_options }];
  }
  return [];
}

function isCollectionResource(resource) {
  return Boolean(resource) && COLLECTION_RESOURCE_TYPES.includes(String(resource.resource_type || ""));
}

function isCollectionLock(lock) {
  return lockResources(lock).some(isCollectionResource);
}

function lockKeys(lock) {
  return Array.isArray(lock && lock.keys) ? lock.keys.filter(Boolean) : [];
}

function keyConditions(key) {
  if (!key) return [];
  if (Array.isArray(key.conditions)) return key.conditions.filter(Boolean);
  if (Array.isArray(key.key_conditions)) return key.key_conditions.filter(Boolean);
  return [];
}

function isTagCondition(condition) {
  return Boolean(condition) && String(condition.type || "") === CUSTOMER_TAG_TYPE;
}

function isSecretCondition(condition) {
  return Boolean(condition) && SECRET_TYPE_RE.test(String(condition.type || ""));
}

function findCondition(lock, predicate) {
  for (const key of lockKeys(lock)) {
    const condition = keyConditions(key).find(predicate);
    if (condition) return { key, condition };
  }
  return null;
}

async function findLockForCollection(collectionLegacyId) {
  const wanted = String(collectionLegacyId == null ? "" : collectionLegacyId).trim();
  if (!wanted) return null;
  const locks = await listLocks();
  return (
    locks.find((lock) => lockResources(lock).some((r) => isCollectionResource(r) && String(r.resource_id) === wanted)) || null
  );
}

/* ---------------------------------------------------------------------------
   Template learning (pure)
   ------------------------------------------------------------------------- */

// Keys the API echoes back that must never be sent in a create body.
const PRIVATE_KEY_RE = /^_/;
const DROP_KEY_RE = /^(id|.*_id|created_at|updated_at)$/;
const KEEP_KEYS = new Set(["resource_id"]);

/*
 * Deep copy with every "_private" key and every id/timestamp removed, so a
 * shape read back from the API can be re-posted as a fresh object.
 */
function stripPrivate(value) {
  if (Array.isArray(value)) return value.map(stripPrivate);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (PRIVATE_KEY_RE.test(k)) continue;
    if (DROP_KEY_RE.test(k) && !KEEP_KEYS.has(k)) continue;
    out[k] = stripPrivate(v);
  }
  return out;
}

function lockTimestamp(lock) {
  const t = Date.parse(lock && (lock.created_at || lock.updated_at || ""));
  return Number.isFinite(t) ? t : 0;
}

function lockNumericId(lock) {
  const n = Number(lock && lock.id);
  return Number.isFinite(n) ? n : 0;
}

function emptyTemplates() {
  return { customerTag: null, secretLink: null, keyOptions: null, secretKeyOptions: null, lockOptions: null, resourceOptions: null, fromLockId: null };
}

/*
 * Learn the exact key/condition JSON from the newest collection lock that has
 * BOTH a customer_tag condition and a secret-link condition — i.e. a lock Dan
 * built by hand following §7. Returns clean deep copies (no "_" keys, no ids)
 * ready to be re-posted, plus which lock they came from.
 */
function learnKeyTemplates(locks) {
  const candidates = (Array.isArray(locks) ? locks : [])
    .filter((lock) => isCollectionLock(lock) && findCondition(lock, isTagCondition) && findCondition(lock, isSecretCondition))
    .sort((a, b) => lockTimestamp(b) - lockTimestamp(a) || lockNumericId(b) - lockNumericId(a));
  const source = candidates[0];
  if (!source) return emptyTemplates();
  const tag = findCondition(source, isTagCondition);
  const secret = findCondition(source, isSecretCondition);
  const resource = lockResources(source).find(isCollectionResource);
  return {
    customerTag: stripPrivate(tag.condition),
    secretLink: stripPrivate(secret.condition),
    keyOptions: tag.key.options ? stripPrivate(tag.key.options) : null,
    secretKeyOptions: secret.key.options ? stripPrivate(secret.key.options) : null,
    lockOptions: source.options ? stripPrivate(source.options) : null,
    resourceOptions: resource && resource.resource_options ? stripPrivate(resource.resource_options) : null,
    fromLockId: source.id == null ? null : source.id
  };
}

/* ---------------------------------------------------------------------------
   Secret links
   ------------------------------------------------------------------------- */

// 16 random bytes → 22 base64url chars, exactly the [A-Za-z0-9-_] alphabet.
function generateSecretCode() {
  return crypto.randomBytes(16).toString("base64url");
}

function normalizeDomain(domain) {
  return String(domain || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function secretLinkFor({ storefrontDomain, collectionHandle, code }) {
  const domain = normalizeDomain(storefrontDomain || process.env.SHOPIFY_STOREFRONT_DOMAIN || process.env.SHOPIFY_STORE);
  if (!domain) throw new Error("A storefront domain is required to build the secret link (SHOPIFY_STOREFRONT_DOMAIN).");
  const handle = String(collectionHandle || "").trim().replace(/^\/+|\/+$/g, "");
  if (!handle) throw new Error("A collection handle is required to build the secret link.");
  return `https://${domain}/collections/${handle}?ls=${encodeURIComponent(String(code || ""))}`;
}

/* ---------------------------------------------------------------------------
   Lock body (pure)
   ------------------------------------------------------------------------- */

// The code a learned secret condition carries, so it can be swapped out.
function templateSecretCode(secretLink) {
  const options = (secretLink && secretLink.options) || {};
  for (const [k, v] of Object.entries(options)) {
    if (SECRET_OPTION_KEY_RE.test(k) && typeof v === "string" && v) return v;
  }
  return "";
}

function templateTag(customerTag) {
  const options = (customerTag && customerTag.options) || {};
  return typeof options.customer_tag === "string" ? options.customer_tag : "";
}

/*
 * Replace values copied from the template lock that belong to the OTHER
 * department: its tag and its secret code. Anything else (booleans, redirect
 * urls) is kept as learned.
 */
function substituteOptions(options, replacements) {
  const out = {};
  for (const [k, v] of Object.entries(options || {})) {
    let value = v;
    if (typeof v === "string") {
      for (const [from, to] of replacements) {
        if (from && v === from) value = to;
      }
    }
    out[k] = value;
  }
  return out;
}

/*
 * Build the POST /lock body for a department collection (§7): the lock is
 * enabled, hides the collection from menus and lists, and carries two keys —
 * customer tagged with the department tag, or customer arrives via the secret
 * link. Returns { body, guessed }; guessed is true when no template lock
 * existed and the secret-link condition shape had to be assumed. A guessed
 * body also carries body._guessedSecretShape (stripped before sending) so the
 * caller validates it with a dry run first.
 */
function buildCollectionLock({ collectionLegacyId, collectionTitle, departmentTag, secretCode, templates = null }) {
  const id = Number(collectionLegacyId);
  if (!Number.isFinite(id) || id <= 0) throw new Error(`A numeric collection id is required for the Locksmith lock (got "${collectionLegacyId}").`);
  const tag = String(departmentTag || "").trim();
  if (!tag) throw new Error("A department tag is required for the Locksmith tag key.");
  const code = String(secretCode || "").trim();
  if (!code) throw new Error("A secret code is required for the Locksmith secret-link key.");
  const t = { ...emptyTemplates(), ...(templates || {}) };

  const oldTag = templateTag(t.customerTag);
  const oldCode = templateSecretCode(t.secretLink);
  const replacements = [
    [oldTag, tag],
    [oldCode, code]
  ];

  // Tag key — documented shape; a template only contributes extra option keys.
  const tagCondition = t.customerTag ? stripPrivate(t.customerTag) : {};
  tagCondition.type = CUSTOMER_TAG_TYPE;
  tagCondition.inverse = false;
  tagCondition.options = { ...substituteOptions(tagCondition.options, replacements), customer_tag: tag };
  const tagKey = {
    options: { ...DEFAULT_KEY_OPTIONS, ...substituteOptions(t.keyOptions, replacements) },
    conditions: [tagCondition]
  };

  // Secret-link key — learned when possible, guessed (then dry-run) otherwise.
  let guessed = false;
  let secretCondition;
  if (t.secretLink) {
    secretCondition = stripPrivate(t.secretLink);
    const options = {};
    for (const [k, v] of Object.entries(secretCondition.options || {})) {
      options[k] = typeof v === "string" && ((oldCode && v === oldCode) || SECRET_OPTION_KEY_RE.test(k)) ? code : v;
    }
    secretCondition.options = options;
    if (typeof secretCondition.inverse !== "boolean") secretCondition.inverse = false;
  } else {
    guessed = true;
    secretCondition = { type: "secret_link", inverse: false, options: { secret_link: code } };
  }
  const secretKey = {
    options: { ...DEFAULT_KEY_OPTIONS, ...substituteOptions(t.secretKeyOptions || t.keyOptions, replacements) },
    conditions: [secretCondition]
  };

  const body = {
    name: String(collectionTitle || "").trim(),
    resource_type: "custom_collection",
    resources: [
      {
        resource_type: "custom_collection",
        resource_id: id,
        resource_options: { ...(t.resourceOptions || {}) }
      }
    ],
    enabled: true,
    // Learned options first, the spec's settings last so they always win.
    options: { ...(t.lockOptions || {}), ...SPEC_LOCK_OPTIONS },
    keys: [tagKey, secretKey]
  };
  if (guessed) body._guessedSecretShape = true;
  return { body, guessed };
}

// The API must never see our own bookkeeping keys.
function sendableBody(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (!PRIVATE_KEY_RE.test(k)) out[k] = v;
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Create / verify
   ------------------------------------------------------------------------- */

function lockPath({ install, dryRun }) {
  return `/lock?install=${install ? "true" : "false"}${dryRun ? "&dryrun=true" : ""}`;
}

function unwrapLock(data) {
  if (data && data.lock && typeof data.lock === "object") return data.lock;
  return data;
}

/*
 * Create the department's collection lock. Learns the key shapes from the
 * store's existing locks, builds the body, dry-runs it when the secret-link
 * shape was guessed, then creates for real. With { dryRun: true } nothing is
 * created and the dry-run response is returned.
 *
 * args: { collectionLegacyId, collectionTitle, departmentTag, collectionHandle,
 *         storefrontDomain?, secretCode? }
 */
async function createCollectionLock(args, { dryRun = false, install = true, onLog = null } = {}) {
  const log = typeof onLog === "function" ? onLog : () => {};
  const secretCode = String(args.secretCode || "").trim() || generateSecretCode();

  let templates = emptyTemplates();
  let templateError = "";
  try {
    templates = learnKeyTemplates(await listLocks());
  } catch (error) {
    // Listing is only there to learn shapes; a failure means we guess and
    // let the dry run decide, while the real error stays visible.
    templateError = error.message;
    log(`Locksmith: could not read existing locks to learn key shapes (${error.message}); the secret-link shape will be validated with a dry run.`);
  }
  if (templates.fromLockId != null) log(`Locksmith: key shapes learned from lock ${templates.fromLockId}.`);

  const { body, guessed } = buildCollectionLock({ ...args, secretCode, templates });
  const payload = sendableBody(body);
  const secretLink = secretLinkFor({ storefrontDomain: args.storefrontDomain, collectionHandle: args.collectionHandle, code: secretCode });

  let dryRunResult = null;
  if (guessed || dryRun) {
    log(`Locksmith: dry run of the lock for "${payload.name}"${guessed ? " (secret-link shape guessed)" : ""}.`);
    dryRunResult = await request("POST", lockPath({ install, dryRun: true }), payload);
  }
  if (dryRun) {
    return { ok: true, dryRun: true, lock: unwrapLock(dryRunResult), id: null, secretCode, secretLink, guessed, body: payload, templateLockId: templates.fromLockId, templateError };
  }

  log(`Locksmith: creating the lock for "${payload.name}".`);
  const created = unwrapLock(await request("POST", lockPath({ install, dryRun: false }), payload));
  const id = created && created.id != null ? created.id : null;
  return { ok: true, dryRun: false, lock: created, id, secretCode, secretLink, guessed, body: payload, templateLockId: templates.fromLockId, templateError };
}

/*
 * Re-read a lock and check §7's requirements: enabled, a customer-tag key and
 * a secret-link key. Pass { departmentTag } to also check the tag spelling.
 */
async function verifyLock(lockId, { departmentTag = "" } = {}) {
  const lock = await getLock(lockId);
  return inspectLock(lock, { departmentTag });
}

function inspectLock(lock, { departmentTag = "" } = {}) {
  if (!lock || typeof lock !== "object") {
    return { ok: false, id: lockId(lock), enabled: false, hasTagKey: false, hasSecretKey: false, tag: "", tagMatches: null, options: {}, error: "Lock not found" };
  }
  const enabled = typeof lock.enabled === "boolean" ? lock.enabled : Boolean(lock.options && lock.options.enabled);
  const tag = findCondition(lock, isTagCondition);
  const secret = findCondition(lock, isSecretCondition);
  const tagValue = tag ? templateTag(tag.condition) : "";
  const expected = String(departmentTag || "").trim();
  const tagMatches = expected ? tagValue === expected : null;
  return {
    ok: enabled && Boolean(tag) && Boolean(secret) && tagMatches !== false,
    id: lockId(lock),
    enabled,
    hasTagKey: Boolean(tag),
    hasSecretKey: Boolean(secret),
    tag: tagValue,
    tagMatches,
    options: lock.options && typeof lock.options === "object" ? { ...lock.options } : {}
  };
}

function lockId(lock) {
  return lock && lock.id != null ? lock.id : null;
}

/* ---------------------------------------------------------------------------
   §7 checked by behaviour rather than by configuration
   ------------------------------------------------------------------------- */

/*
 * Locksmith's option names are undocumented, so asserting them would prove
 * nothing about the spec's four settings — a name we guessed wrong is accepted
 * and ignored, and the store stays open while the report says it is locked.
 *
 * What the four settings EXIST to produce is observable from outside with no
 * credentials at all: a locked department collection renders none of its
 * products to the public, and the secret link opens it. That is the thing Dan
 * actually needs to be true, and it holds however Locksmith spells its
 * options internally.
 *
 * Measured against the live store: the public "FN Simple Merch" collection
 * renders 16 distinct product links, while Vacaville (58 products) and Benicia
 * (41 products) render 0.
 */
const PRODUCT_LINK_RE = /\/products\/[a-z0-9][a-z0-9-]*/gi;

function productLinkCount(html) {
  const found = String(html || "").match(PRODUCT_LINK_RE) || [];
  return new Set(found.map((link) => link.toLowerCase())).size;
}

async function fetchPublicHtml(url) {
  const res = await getFetch()(url, { redirect: "follow", signal: timeoutSignal() });
  const html = await res.text();
  return { status: res.status, html };
}

/**
 * Does the lock actually do its job? Fetches the collection as the public sees
 * it, and — when a secret link is known — through that link.
 *
 * Every verdict is `true`, `false`, or `null` for "could not be established".
 * Null is not a pass: an empty collection proves nothing, and neither does a
 * storefront that would not answer.
 */
async function checkPublicAccess({ storefrontDomain, collectionHandle, productCount = 0, secretLink = "" } = {}) {
  const out = {
    checked: false,
    collectionUrl: "",
    publicProductLinks: null,
    closedToPublic: null,
    opensWithSecretLink: null,
    reason: ""
  };
  let domain;
  try {
    domain = normalizeDomain(storefrontDomain || process.env.SHOPIFY_STOREFRONT_DOMAIN || process.env.SHOPIFY_STORE);
  } catch {
    domain = "";
  }
  const handle = String(collectionHandle || "").trim().replace(/^\/+|\/+$/g, "");
  if (!domain || !handle) {
    out.reason = "A storefront domain and collection handle are needed to check public access.";
    return out;
  }
  out.collectionUrl = `https://${domain}/collections/${handle}`;

  if (!(Number(productCount) > 0)) {
    out.reason = "The collection has no products yet, so an empty public page would prove nothing.";
    return out;
  }

  try {
    const { status, html } = await fetchPublicHtml(out.collectionUrl);
    out.publicProductLinks = productLinkCount(html);
    out.closedToPublic = out.publicProductLinks === 0;
    out.checked = true;
    if (!out.closedToPublic) {
      out.reason = `The collection page shows ${out.publicProductLinks} product link(s) to the public (HTTP ${status}); the lock is not hiding them.`;
    }
  } catch (error) {
    out.reason = `Could not read ${out.collectionUrl}: ${error.message}`;
    return out;
  }

  const link = String(secretLink || "").trim();
  if (!link) return out;
  try {
    const { html } = await fetchPublicHtml(link);
    const withLink = productLinkCount(html);
    out.opensWithSecretLink = withLink > 0;
    if (!out.opensWithSecretLink) {
      out.reason = `${out.reason ? out.reason + " " : ""}The secret link showed no products, so it does not open the store.`.trim();
    }
  } catch (error) {
    out.reason = `${out.reason ? out.reason + " " : ""}Could not follow the secret link: ${error.message}`.trim();
  }
  return out;
}

/* ---------------------------------------------------------------------------
   §7 as a checklist for Dan (when the API is unavailable or fails)
   ------------------------------------------------------------------------- */

function manualChecklist({ collectionTitle, departmentTag }) {
  const title = String(collectionTitle || "").trim();
  const tag = String(departmentTag || "").trim();
  return [
    `On the collection${title ? ` "${title}"` : ""}: More Actions > Locksmith > create a lock.`,
    `In the Settings box, check all four: ${LOCK_SETTINGS.join(", ")}.`,
    "Add two keys (either one unlocks the store):",
    `Key 1 — Customer is tagged with the department tag: type "${tag}" exactly (case-sensitive; no customer account setup is needed).`,
    "Key 2 — Customer arrives via secret link.",
    "Save the lock. Record the secret link in the report."
  ];
}

module.exports = {
  BASE_URL,
  LOCK_SETTINGS,
  SPEC_LOCK_OPTIONS,
  COLLECTION_RESOURCE_TYPES,
  setFetch,
  configured,
  listLocks,
  getLock,
  findLockForCollection,
  isCollectionLock,
  learnKeyTemplates,
  stripPrivate,
  generateSecretCode,
  secretLinkFor,
  buildCollectionLock,
  sendableBody,
  createCollectionLock,
  verifyLock,
  inspectLock,
  checkPublicAccess,
  productLinkCount,
  manualChecklist
};

/*
 * Department Onboarding Agent — the Mega Menu guard.
 *
 * Shopify's menuUpdate REPLACES THE WHOLE TREE: every item that is not sent is
 * deleted. On 13 Oct 2026 something outside the agent (Shopify admin, Sidekick
 * or another app) rewrote the MegaMenu keeping only its top-level items — the
 * ~112 stores under "Store", Contact's three sub-items and the twenty "Station
 * Stores" went. Two hours later the agent read the EMPTY Store list, proposed
 * "index 0, nothing above, nothing below", and the finish wrote
 * Store = [the new store] and reported it "saved … read back from the live
 * menu". Its read was correct; nothing stopped it from writing into a menu
 * that was obviously wrong, and there was no copy to put it back from.
 *
 * This module is that missing check and that missing copy:
 *
 *   • assessMenu(menu, baseline) — pure. Is this menu fit to be written to?
 *     A Store list that is gone or empty never is; one that lost a big share
 *     of the stores the last good read had is not either.
 *   • observe(menu) — every successful read of the live menu goes through it.
 *     A healthy read becomes the new baseline (the last good copy); an
 *     unhealthy one NEVER does, and is kept in history as "suspect".
 *   • the baseline and a rolling history live in the platform-config blob
 *     container under megamenu/, so a wipe can be restored from them.
 *
 * Matching an item across two reads uses what survives a wipe-and-rebuild:
 * the linked resource, else the url, else the title. Menu item ids do NOT
 * survive one (a hand-rebuilt store gets a new id), so they are never used to
 * decide whether something is missing.
 *
 * Nothing here talks to Shopify. Storage is injectable (setStorage) for the
 * tests, and falls back to memory when blob storage is not configured, so a
 * local run never throws on it.
 */

const crypto = require("crypto");

const STORE_ITEM_TITLE = "Store";
const CONTAINER = "platform-config";
const PREFIX = "megamenu/";
const BASELINE_NAME = `${PREFIX}baseline.json`;
const HISTORY_PREFIX = `${PREFIX}history/`;
const HISTORY_KEEP = 60;
// A drop smaller than this is somebody tidying the menu, not a wipe.
const MIN_LOSS = 3;
const LOSS_SHARE = 0.1;

/* ---------------------------------------------------------------------------
   Reading a menu (pure)
   ------------------------------------------------------------------------- */

function normText(value) {
  return String(value == null ? "" : value).trim().replace(/\s+/g, " ").toLowerCase();
}

function normUrl(value) {
  return String(value == null ? "" : value).trim().replace(/\/+$/, "").toLowerCase();
}

// The "Store" item is the top-level entry the department stores hang under:
// by title first (the store's menu names it "Store"), else the COLLECTIONS-type
// entry. shopifyOnboarding re-exports this, so the insert and the guard can
// never disagree about which item is the Store list.
function findStoreItem(menu) {
  const items = menu?.items || [];
  return items.find((it) => normText(it.title) === normText(STORE_ITEM_TITLE)) || items.find((it) => it.type === "COLLECTIONS") || null;
}

/* Every item below the top level, in pre-order (so in menu order), with the
   node and parent kept for the matcher and the restore planner. depth 1 is a
   child of a top-level item (a store under "Store"), depth 2 one further down
   (a station under "Station Stores"). */
function flatten(menu) {
  const store = findStoreItem(menu);
  const out = [];
  const walk = (items, parent, depth) => {
    for (const node of items || []) {
      out.push({
        id: node.id || null,
        title: node.title,
        type: node.type || "",
        url: node.url || null,
        resourceId: node.resourceId || null,
        parentTitle: parent.title,
        depth,
        storeChild: depth === 1 && parent === store,
        node,
        parent
      });
      walk(node.items, node, depth + 1);
    }
  };
  for (const top of menu?.items || []) walk(top.items, top, 1);
  return out;
}

function summarizeMenu(menu) {
  const store = findStoreItem(menu);
  const items = flatten(menu).map(({ id, title, url, resourceId, parentTitle, depth }) => ({ id, title, url, resourceId, parentTitle, depth }));
  return {
    store: store ? { id: store.id || null, title: store.title } : null,
    storeCount: store ? (store.items || []).length : 0,
    nestedCount: items.filter((item) => item.depth >= 2).length,
    items
  };
}

// Same linked resource when both have one, else the same url, else the same
// title. Never the id: a store Dan rebuilds by hand gets a new one.
function sameItem(a, b) {
  if (a.resourceId && b.resourceId) return a.resourceId === b.resourceId;
  if (a.url && b.url) return normUrl(a.url) === normUrl(b.url);
  return normText(a.title) === normText(b.title);
}

function sameParent(a, b) {
  if (a.depth === 1) return a.storeChild === b.storeChild && (a.storeChild || normText(a.parentTitle) === normText(b.parentTitle));
  return sameItem(a.parent, b.parent);
}

/*
 * Pairs every baseline item with at most one live item. First pass: the same
 * item in the same place. Second pass: the same item anywhere — a store Dan
 * moved into a group is not missing. One-to-one, because the live menu links
 * the same collection twice ("Station Stores" and its own "Station 1").
 */
function matchMenus(baselineMenu, liveMenu) {
  const baseline = flatten(baselineMenu);
  const live = flatten(liveMenu);
  const used = new Set();
  const pairs = new Map();
  const claim = (b, accept) => {
    const hit = live.find((l) => !used.has(l) && sameItem(b, l) && accept(l));
    if (!hit) return;
    used.add(hit);
    pairs.set(b, hit);
  };
  for (const b of baseline) claim(b, (l) => l.depth === b.depth && sameParent(b, l));
  for (const b of baseline) if (!pairs.has(b)) claim(b, () => true);
  return { baseline, live, pairs };
}

/* ---------------------------------------------------------------------------
   Is it fit to write to? (pure)
   ------------------------------------------------------------------------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "13 Oct 2026, 15:17 UTC" — Dan reads this, so no ISO strings.
function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an earlier read";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function lossThreshold(count) {
  return Math.max(MIN_LOSS, Math.ceil(LOSS_SHARE * count));
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function lowerFirst(text) {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

// A baseline document ({ at, menu }) or a bare menu; null when there is none.
function baselineDoc(baseline) {
  if (!baseline) return null;
  if (baseline.menu && Array.isArray(baseline.menu.items)) return baseline;
  if (Array.isArray(baseline.items)) return { at: null, menu: baseline };
  return null;
}

/**
 * { healthy, reasons, message, storeCount, baselineCount, baselineAt,
 *   missing: [{ title, url, parentTitle }], nestedMissing }.
 * Unhealthy when there is no Store item, when the Store list is empty, or —
 * against a baseline — when the Store list or the items nested one level
 * further down lost max(3, 10%) of what the baseline had. A smaller loss is
 * still listed in `missing` but does not flip the verdict: that is somebody
 * tidying the menu, and the next healthy read makes it the new baseline.
 */
function assessMenu(menu, baseline) {
  const doc = baselineDoc(baseline);
  const store = findStoreItem(menu);
  const storeCount = store ? (store.items || []).length : 0;
  const when = doc ? formatWhen(doc.at) : "";
  const lastGood = doc ? (doc.at ? `the last good read (${when})` : "the last good copy") : "";
  const base = doc ? summarizeMenu(doc.menu) : null;
  const reasons = [];

  let missingEntries = [];
  if (doc) {
    const match = matchMenus(doc.menu, menu);
    missingEntries = match.baseline.filter((entry) => !match.pairs.has(entry));
  }

  if (!store) {
    reasons.push(`The Mega Menu has no "${STORE_ITEM_TITLE}" item${base?.store ? `; ${lastGood} had one with ${plural(base.storeCount, "store", "stores")}` : ""}.`);
  } else if (storeCount === 0) {
    reasons.push(`The Store list has 0 stores${base?.storeCount ? `; ${lastGood} had ${base.storeCount}` : ""}.`);
  } else if (base) {
    const storeLost = missingEntries.filter((entry) => entry.storeChild).length;
    if (storeLost >= lossThreshold(base.storeCount)) {
      reasons.push(`The Store list has ${plural(storeCount, "store", "stores")}; ${lastGood} had ${base.storeCount}, and ${storeLost} of those are gone.`);
    }
  }
  const nestedLost = missingEntries.filter((entry) => entry.depth >= 2);
  // Stations that went with their own store are already in the sentence
  // about the Store list; saying so twice is noise, not a second alarm.
  const missingNodes = new Set(missingEntries.map((entry) => entry.node));
  const implied = reasons.length > 0 && nestedLost.every((entry) => missingNodes.has(entry.parent));
  if (base && base.nestedCount && nestedLost.length >= lossThreshold(base.nestedCount) && !implied) {
    reasons.push(
      `${plural(nestedLost.length, "item", "items")} inside other menu items (for example under "${nestedLost[0].parentTitle}") ${nestedLost.length === 1 ? "is" : "are"} gone since ${lastGood}.`
    );
  }

  const healthy = reasons.length === 0;
  return {
    healthy,
    reasons,
    message: healthy ? "" : `The Mega Menu looks wiped: ${lowerFirst(reasons[0])}`,
    storeCount,
    baselineCount: base ? base.storeCount : null,
    baselineAt: doc ? doc.at || null : null,
    missing: missingEntries.map((entry) => ({ title: entry.title, url: entry.url, parentTitle: entry.parentTitle })),
    nestedMissing: nestedLost.length
  };
}

/* A stable fingerprint of the tree — every field menuUpdate round-trips, in
   order — so the baseline is rewritten only when the menu really changed. */
function canonicalItems(items) {
  return (items || []).map((item) => [
    item.id || null,
    String(item.title == null ? "" : item.title),
    item.type || "",
    item.url || null,
    item.resourceId || null,
    Array.isArray(item.tags) ? [...item.tags] : [],
    canonicalItems(item.items)
  ]);
}

function menuHash(menu) {
  return crypto.createHash("sha1").update(JSON.stringify(canonicalItems(menu?.items))).digest("hex");
}

/* ---------------------------------------------------------------------------
   Storage: megamenu/baseline.json and megamenu/history/ in platform-config
   ------------------------------------------------------------------------- */

function memoryStorage() {
  const blobs = new Map();
  return {
    async read(name) {
      return blobs.has(name) ? JSON.parse(blobs.get(name)) : null;
    },
    async write(name, value) {
      blobs.set(name, JSON.stringify(value));
      return value;
    },
    async list(prefix) {
      return [...blobs.keys()].filter((name) => name.startsWith(prefix)).sort();
    },
    async remove(name) {
      blobs.delete(name);
    }
  };
}

function blobStorage() {
  const blob = require("./platformBlob");
  return {
    read: (name) => blob.readJson(CONTAINER, name, null),
    write: (name, value) => blob.writeJson(CONTAINER, name, value),
    list: async (prefix) => (await blob.listBlobs(CONTAINER, prefix)).sort(),
    remove: (name) => blob.deleteBlob(CONTAINER, name)
  };
}

let injectedStorage = null;
let fallbackStorage = null;
let realStorage = null;
// Hashes already kept as "suspect", so a wiped menu read every minute is
// written to history once, not sixty times an hour.
let suspectSeen = new Set();

function storage() {
  if (injectedStorage) return injectedStorage;
  if (require("./platformBlob").blobConfigured()) {
    if (!realStorage) realStorage = blobStorage();
    return realStorage;
  }
  if (!fallbackStorage) fallbackStorage = memoryStorage();
  return fallbackStorage;
}

/** Test hook: an adapter { read, write, list, remove }, or null for the default. */
function setStorage(adapter) {
  injectedStorage = adapter || null;
  if (!adapter) fallbackStorage = null;
  suspectSeen = new Set();
  return injectedStorage;
}

function stamp(at) {
  return at.replace(/[:.]/g, "-");
}

function slug(reason) {
  return String(reason || "snapshot").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "snapshot";
}

function baselineSummary(doc) {
  if (!doc) return null;
  return { at: doc.at || null, by: doc.by || "", reason: doc.reason || "", storeCount: summarizeMenu(doc.menu).storeCount };
}

async function loadBaseline() {
  const doc = await storage().read(BASELINE_NAME);
  return doc && doc.menu && Array.isArray(doc.menu.items) ? doc : null;
}

async function writeBaseline(menu, { by = "", reason = "" } = {}) {
  const doc = { at: new Date().toISOString(), by: String(by || ""), reason: String(reason || ""), hash: menuHash(menu), menu };
  await storage().write(BASELINE_NAME, doc);
  return doc;
}

async function listHistory() {
  return (await storage().list(HISTORY_PREFIX)).filter((name) => name.endsWith(".json")).sort();
}

// The newest HISTORY_KEEP snapshots stay; the names sort by time.
async function pruneHistory() {
  const names = await listHistory();
  for (const name of names.slice(0, Math.max(0, names.length - HISTORY_KEEP))) await storage().remove(name);
}

async function saveSnapshot(menu, { reason = "snapshot", by = "" } = {}) {
  const at = new Date().toISOString();
  const name = `${HISTORY_PREFIX}${stamp(at)}-${slug(reason)}.json`;
  const summary = summarizeMenu(menu);
  await storage().write(name, { at, reason: String(reason || ""), by: String(by || ""), hash: menuHash(menu), storeCount: summary.storeCount, menu });
  await pruneHistory();
  return { name, at };
}

async function loadSnapshot(name) {
  const full = String(name || "").startsWith(HISTORY_PREFIX) ? String(name) : `${HISTORY_PREFIX}${name}`;
  const doc = await storage().read(full.endsWith(".json") ? full : `${full}.json`);
  return doc && doc.menu ? doc : null;
}

/* ---------------------------------------------------------------------------
   observe / accept
   ------------------------------------------------------------------------- */

/**
 * Judge a menu the agent just read, and keep the copies. Healthy → it becomes
 * the baseline (written only when the tree changed) with a history snapshot.
 * Unhealthy → the baseline is NEVER moved, and the menu is kept once as
 * "suspect". Storage trouble never breaks the read that called this: the
 * verdict is returned either way, with storageError saying what failed.
 * `snapshot: false` skips the history write when the caller keeps its own.
 */
async function observe(menu, { reason = "read", by = "", snapshot = true } = {}) {
  let baseline = null;
  let storageError = "";
  try {
    baseline = await loadBaseline();
  } catch (error) {
    storageError = String(error?.message || error);
  }
  const assessment = assessMenu(menu, baseline);
  const hash = menuHash(menu);
  let current = baseline;
  let advanced = false;
  if (!storageError) {
    try {
      if (assessment.healthy) {
        if (!baseline || (baseline.hash || menuHash(baseline.menu)) !== hash) {
          current = await writeBaseline(menu, { by, reason });
          advanced = true;
          if (snapshot) await saveSnapshot(menu, { reason, by });
        }
      } else if (!suspectSeen.has(hash)) {
        const suspectReason = `suspect-${hash.slice(0, 8)}`;
        const kept = (await listHistory()).some((name) => name.endsWith(`-${suspectReason}.json`));
        if (!kept) await saveSnapshot(menu, { reason: suspectReason, by });
        suspectSeen.add(hash);
      }
    } catch (error) {
      storageError = String(error?.message || error);
    }
  }
  return { ...assessment, hash, advanced, baseline: baselineSummary(current), storageError };
}

/**
 * Dan says the menu is right as it is now. The previous baseline goes to
 * history first, so accepting never destroys the copy a restore would need —
 * and a menu that fails the absolute rules (no Store list, or an empty one) is
 * refused outright: that is never "right as it is".
 */
async function acceptBaseline(menu, { by = "", reason = "accepted" } = {}) {
  const verdict = assessMenu(menu, null);
  if (!verdict.healthy) {
    const error = new Error(`${verdict.reasons.join(" ")} That cannot be accepted as the Mega Menu — restore it instead.`);
    error.code = "BAD_REQUEST";
    throw error;
  }
  const previous = await loadBaseline();
  if (previous) await saveSnapshot(previous.menu, { reason: "replaced-baseline", by });
  const doc = await writeBaseline(menu, { by, reason });
  await saveSnapshot(menu, { reason, by });
  return doc;
}

module.exports = {
  STORE_ITEM_TITLE,
  CONTAINER,
  BASELINE_NAME,
  HISTORY_PREFIX,
  HISTORY_KEEP,
  // pure
  findStoreItem,
  summarizeMenu,
  sameItem,
  matchMenus,
  assessMenu,
  menuHash,
  formatWhen,
  // storage
  memoryStorage,
  setStorage,
  loadBaseline,
  saveSnapshot,
  listHistory,
  loadSnapshot,
  baselineSummary,
  observe,
  acceptBaseline
};

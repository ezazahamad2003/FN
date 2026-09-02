const { BlobServiceClient } = require("@azure/storage-blob");

/*
 * The supplier link book: a durable record of which product page and which
 * flat-front photo URL resolves each garment a department can order.
 *
 * Keyed exactly like the in-memory cache in blanks.js -
 * "vendor|style|color|productType" - one entry per combination:
 *
 *   status "verified": imageUrl passed the vision gate once; builds use it
 *     directly with a single download - no web search, no vision spend, and
 *     the same garment resolves identically on every build.
 *   status "failed": a full live search found nothing usable. These entries
 *     are the work queue for the seeding/repair agents.
 *   status "stale": a verified link that stopped downloading (vendors
 *     reorganise CDNs). Repair runs re-resolve these.
 *
 * The book lives next to the platform's other durable state (oauth tokens,
 * intake records) in the storage account. Builds write to it as they succeed
 * or fail, so it grows from real usage; seeding scripts and agents write to
 * it in bulk. A missing or unreachable book never blocks a build - callers
 * fall back to the live search path.
 */

const CONTAINER_NAME = "platform-config";
const BLOB_NAME = "supplier-link-book.json";
// One replica writes today, but reads happen on every build: keep an
// in-memory copy and refresh it on a short clock so out-of-process writers
// (the seeding script) are picked up without a restart.
const REFRESH_MS = 5 * 60 * 1000;

let containerPromise = null;
let bookCache = null;
let bookLoadedAt = 0;
// Serialise writes: two products resolving concurrently must not interleave
// their read-modify-write cycles and drop each other's entries.
let writeChain = Promise.resolve();

function linkBookConfigured() {
  return Boolean(String(process.env.AZURE_STORAGE_CONNECTION_STRING || "").trim());
}

async function container() {
  if (!linkBookConfigured()) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set, so the supplier link book is unavailable.");
  }
  if (!containerPromise) {
    containerPromise = (async () => {
      const service = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
      const client = service.getContainerClient(CONTAINER_NAME);
      await client.createIfNotExists();
      return client;
    })();
    containerPromise.catch(() => {
      containerPromise = null;
    });
  }
  return containerPromise;
}

async function readBook() {
  try {
    const client = await container();
    const buffer = await client.getBlockBlobClient(BLOB_NAME).downloadToBuffer();
    const parsed = JSON.parse(buffer.toString("utf8"));
    return parsed && typeof parsed === "object" && parsed.entries ? parsed : { entries: {} };
  } catch (error) {
    if (error?.statusCode === 404) return { entries: {} };
    throw error;
  }
}

async function loadedBook({ maxAgeMs = REFRESH_MS } = {}) {
  if (!bookCache || Date.now() - bookLoadedAt > maxAgeMs) {
    bookCache = await readBook();
    bookLoadedAt = Date.now();
  }
  return bookCache;
}

async function writeBook(book) {
  const body = Buffer.from(JSON.stringify(book, null, 2), "utf8");
  const client = await container();
  await client.getBlockBlobClient(BLOB_NAME).upload(body, body.length, {
    blobHTTPHeaders: { blobContentType: "application/json" }
  });
}

/** The entry for a cache key, or null. Never throws when unconfigured. */
async function lookupSupplierLink(key) {
  if (!linkBookConfigured()) return null;
  const book = await loadedBook();
  return book.entries[key] || null;
}

/**
 * Merge one entry into the book (replacing any previous entry for the key).
 * Reads the blob fresh inside the serialised write so concurrent writers in
 * this process never drop each other's entries.
 */
async function saveSupplierLink(key, entry) {
  if (!linkBookConfigured()) return;
  writeChain = writeChain.then(async () => {
    const book = await readBook();
    book.entries[key] = { ...entry, updatedAt: new Date().toISOString() };
    await writeBook(book);
    bookCache = book;
    bookLoadedAt = Date.now();
  });
  return writeChain;
}

/** Every entry, keyed - for seeding scripts, repair runs, and the console. */
async function listSupplierLinks() {
  if (!linkBookConfigured()) return {};
  return (await loadedBook({ maxAgeMs: 0 })).entries;
}

/** Remove one entry outright (bad seed, retired style, test data). */
async function removeSupplierLink(key) {
  if (!linkBookConfigured()) return;
  writeChain = writeChain.then(async () => {
    const book = await readBook();
    delete book.entries[key];
    await writeBook(book);
    bookCache = book;
    bookLoadedAt = Date.now();
  });
  return writeChain;
}

/**
 * Resolves once every write queued so far has reached the blob. Callers that
 * exit the process (seeding scripts) MUST await this before exiting, or the
 * tail of the serialised write queue dies with the process.
 */
async function flushSupplierLinkWrites() {
  return writeChain;
}

module.exports = {
  flushSupplierLinkWrites,
  linkBookConfigured,
  lookupSupplierLink,
  saveSupplierLink,
  listSupplierLinks,
  removeSupplierLink
};

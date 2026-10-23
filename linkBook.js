const { BlobServiceClient } = require("@azure/storage-blob");

/*
 * The supplier link book: a durable record of which product page and which
 * flat-front photo resolves each garment a department can order.
 *
 * Keyed exactly like the in-memory cache in blanks.js -
 * "vendor|style|color|productType" - one entry per combination:
 *
 *   status "verified": imageUrl passed the vision gate once; builds use it
 *     directly with a single download - no web search, no vision spend, and
 *     the same garment resolves identically on every build. A verified entry
 *     may carry `photoBlob` instead: a blank photo an operator uploaded on a
 *     department's row, copied in beside the book (supplierPhotos.js). No
 *     photo of Delta's FF180 exists online; Dan uploaded his own for
 *     Foresthill, and the next department to order the same hat was drawn an
 *     invented one the same day, because his photo lived only on Foresthill's
 *     row. The book keeps it now, so one upload fixes the garment for every
 *     department after it.
 *   status "failed": a full live search found nothing usable. These entries
 *     are the work queue for the seeding/repair agents.
 *   status "stale": a verified link that stopped downloading (vendors
 *     reorganise CDNs). Repair runs re-resolve these.
 *
 * The book lives next to the platform's other durable state (oauth tokens,
 * intake records) in the storage account; uploaded photos sit beside it under
 * supplier-photos/. Builds write to it as they succeed or fail, so it grows
 * from real usage; seeding scripts and agents write to it in bulk. A missing
 * or unreachable book never blocks a build - callers fall back to the live
 * search path.
 */

const CONTAINER_NAME = "platform-config";
const BLOB_NAME = "supplier-link-book.json";
const PHOTO_PREFIX = "supplier-photos/";
// One replica writes today, but reads happen on every build: keep an
// in-memory copy and refresh it on a short clock so out-of-process writers
// (the seeding script) are picked up without a restart.
const REFRESH_MS = 5 * 60 * 1000;

/* The storage behind the book: Azure blobs in production. The tests swap in
   memoryBookAdapter(), the way onboardingStore's tests swap the record store. */
function azureBookAdapter() {
  let containerPromise = null;
  const configured = () => Boolean(String(process.env.AZURE_STORAGE_CONNECTION_STRING || "").trim());

  async function container() {
    if (!configured()) {
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

  return {
    configured,
    async readBuffer(name) {
      try {
        return await (await container()).getBlockBlobClient(name).downloadToBuffer();
      } catch (error) {
        if (error?.statusCode === 404) return null;
        throw error;
      }
    },
    async writeBuffer(name, buffer, contentType) {
      await (await container()).getBlockBlobClient(name).upload(buffer, buffer.length, {
        blobHTTPHeaders: { blobContentType: contentType }
      });
    },
    async deleteBlob(name) {
      await (await container()).getBlockBlobClient(name).deleteIfExists();
    }
  };
}

function memoryBookAdapter() {
  const blobs = new Map();
  return {
    blobs,
    configured: () => true,
    async readBuffer(name) {
      return blobs.has(name) ? Buffer.from(blobs.get(name)) : null;
    },
    async writeBuffer(name, buffer) {
      blobs.set(name, Buffer.from(buffer));
    },
    async deleteBlob(name) {
      blobs.delete(name);
    }
  };
}

let adapter = azureBookAdapter();
let bookCache = null;
let bookLoadedAt = 0;
// Serialise writes: two products resolving concurrently must not interleave
// their read-modify-write cycles and drop each other's entries.
let writeChain = Promise.resolve();

/** Test hook: the storage behind the book (null restores Azure). */
function setBookAdapter(next) {
  adapter = next || azureBookAdapter();
  bookCache = null;
  bookLoadedAt = 0;
  writeChain = Promise.resolve();
}

function linkBookConfigured() {
  return adapter.configured();
}

async function readBook() {
  const buffer = await adapter.readBuffer(BLOB_NAME);
  if (!buffer) return { entries: {} };
  const parsed = JSON.parse(buffer.toString("utf8"));
  return parsed && typeof parsed === "object" && parsed.entries ? parsed : { entries: {} };
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
  await adapter.writeBuffer(BLOB_NAME, body, "application/json");
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

/** Every entry as this process already holds it (refreshed on the usual
    clock) - for lookups that scan the whole book, where a blob read per
    product would cost more than a few minutes' staleness. A write from this
    process is visible at once. Never throws when unconfigured. */
async function cachedSupplierLinks() {
  if (!linkBookConfigured()) return {};
  return (await loadedBook()).entries;
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

/* ---------------------------------------------------------------------------
   Uploaded blank photos, kept beside the book. An entry points at one with
   `photoBlob` (front) or `backPhotoBlob` (back); supplierPhotos.js writes
   them and blanks.js reads them.
   ------------------------------------------------------------------------- */

/** The blob name for an uploaded photo: the entry's key, the face and the
    upload it came from, so two uploads of one garment never collide. */
function supplierPhotoName(key, face, uploadId, format) {
  const slug = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const ext = slug(format).replace(/^jpg$/, "jpeg") || "bin";
  return `${PHOTO_PREFIX}${slug(key)}-${face === "back" ? "back" : "front"}-${slug(uploadId)}.${ext}`;
}

function isPhotoName(name) {
  return typeof name === "string" && name.startsWith(PHOTO_PREFIX) && name.length > PHOTO_PREFIX.length && !name.includes("..");
}

async function saveSupplierPhoto(name, buffer, contentType = "application/octet-stream") {
  if (!linkBookConfigured()) return;
  if (!isPhotoName(name)) throw new Error(`"${name}" is not a supplier photo name; use supplierPhotoName().`);
  await adapter.writeBuffer(name, buffer, contentType);
}

/** The photo's bytes, or null when it is not there. Never throws for a bad name. */
async function readSupplierPhoto(name) {
  if (!linkBookConfigured() || !isPhotoName(name)) return null;
  return adapter.readBuffer(name);
}

async function removeSupplierPhoto(name) {
  if (!linkBookConfigured() || !isPhotoName(name)) return;
  await adapter.deleteBlob(name);
}

module.exports = {
  flushSupplierLinkWrites,
  linkBookConfigured,
  lookupSupplierLink,
  saveSupplierLink,
  listSupplierLinks,
  cachedSupplierLinks,
  removeSupplierLink,
  // uploaded blank photos
  supplierPhotoName,
  saveSupplierPhoto,
  readSupplierPhoto,
  removeSupplierPhoto,
  // test hooks
  setBookAdapter,
  memoryBookAdapter
};

/* -----------------------------------------------------------------------------
   Blank photos the link book learns from the operator.

   A blank photo Dan adds to a product row used to live only on that row. On
   2026-10-13 Foresthill's Delta FF180 hat had no supplier photo anywhere
   online, so its first build drew an invented hat; Dan uploaded a photo of
   the real blank and redid the images. Two hours later SCC ordered the same
   hat in the same colour, the build searched the web again, found nothing
   again, drew another invented hat, and Dan uploaded the same photo again.

   The link book is the one memory every department's build consults, so an
   uploaded blank photo goes in there too: copied beside the book and booked
   as the verified blank for that vendor, style, colour and face. The next
   build of that garment, for any department, takes the photo with no search
   and no invented garment. Removing the photo from the row that supplied it
   forgets it again.
   -------------------------------------------------------------------------- */

const sharp = require("sharp");
const linkBook = require("./linkBook");
const { blankCacheKey, familyKeys, clearCachedBlank, clearCachedBlanksForStyle, clearCachedBack, MIN_UPLOAD_EDGE } = require("./blanks");
const { supplierQuery } = require("./onboardingMockups");

/* The bar an uploaded photo has to clear to be kept for other departments
   (blanks.MIN_UPLOAD_EDGE). It used to be the web thumbnail bar (500px), which
   refused photos the row itself rendered fine: Cochiti's PC61 and PC61LS
   uploads were "too small to reuse" and Truckee Meadows was drawn invented
   tees for the same garments the next day. */
const MIN_EDGE = MIN_UPLOAD_EDGE;

/* The book is keyed the way a build looks the garment up, so the row goes
   through the same mapping the build uses (onboardingMockups.supplierQuery). */
function keysFor(product, color) {
  const query = supplierQuery(product, color);
  return { query, key: blankCacheKey(query), family: familyKeys(query) };
}

function faceOf(face) {
  return String(face || "").toLowerCase() === "back" ? "back" : "front";
}

/**
 * Book an uploaded blank photo for every department.
 *
 * `file` is the upload ({ buffer, mimetype }); `origin` says which row it
 * came from ({ onboardingId, assetId, department }), so removing that upload
 * later forgets exactly this photo and not a newer one from another row.
 *
 * Resolves { booked: true, key, photoBlob } or { booked: false, reason }.
 * Never throws for an unusable file: the upload itself must still succeed.
 */
async function bookBlankPhoto({ product, color, face = "front", file, origin = {}, by = "" }) {
  if (!linkBook.linkBookConfigured()) return { booked: false, reason: "the link book is not configured" };
  if (!product || !file || !Buffer.isBuffer(file.buffer)) return { booked: false, reason: "no file" };
  const { query, key, family } = keysFor(product, color);
  if (!query.brandStyle && !query.vendor) return { booked: false, reason: "the row has no brand or style number to file it under" };

  let meta;
  try {
    meta = await sharp(file.buffer).metadata();
  } catch {
    return { booked: false, reason: "the file is not an image" };
  }
  if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_EDGE) {
    return { booked: false, reason: `the photo is too small to reuse (${meta.width || 0}x${meta.height || 0}; ${MIN_EDGE}px on the short edge needed)` };
  }

  const side = faceOf(face);
  const name = linkBook.supplierPhotoName(key, side, origin.assetId || Date.now().toString(36), meta.format);
  await linkBook.saveSupplierPhoto(name, file.buffer, file.mimetype || `image/${meta.format}`);

  const previous = (await linkBook.lookupSupplierLink(key)) || {};
  const from = {
    onboardingId: origin.onboardingId || "",
    assetId: origin.assetId || "",
    productId: product.id || "",
    department: origin.department || "",
    by,
    at: new Date().toISOString()
  };
  /* The query's fields first so a fresh entry names its garment; the previous
     entry on top so a spec, facts or order link found earlier survive. An
     operator's photo outranks whatever verdict the search reached. */
  const entry =
    side === "front"
      ? { ...query, ...previous, status: "verified", photoBlob: name, photoFrom: from, source: "upload", staleReason: undefined, failReason: undefined, reason: undefined }
      : { ...query, ...previous, backPhotoBlob: name, backPhotoFrom: from, backStatus: "verified" };
  await linkBook.saveSupplierLink(key, entry);

  // The copy this upload replaces is referenced by nothing now.
  const replaced = side === "front" ? previous.photoBlob : previous.backPhotoBlob;
  if (replaced && replaced !== name) await linkBook.removeSupplierPhoto(replaced).catch(() => {});

  // A build in this process may have cached the search that found nothing —
  // or, for a back, the verdict that this front has no back photo. Another
  // department may have looked the garment up under another spelling of the
  // maker; that verdict goes too.
  for (const cached of new Set([key, ...family])) clearCachedBlank(cached);
  clearCachedBlanksForStyle(query);
  if (side === "back") clearCachedBack(previous.photoBlob || previous.imageUrl);
  return { booked: true, key, photoBlob: name };
}

/**
 * Forget a booked photo when the upload it came from is removed. Only the
 * photo this exact upload supplied is forgotten: a newer upload of the same
 * garment from another row stays. Resolves { forgotten, key }.
 */
async function unbookBlankPhoto({ product, color, face = "front", assetId }) {
  if (!linkBook.linkBookConfigured() || !product || !assetId) return { forgotten: false };
  const { key, family } = keysFor(product, color);
  const entry = await linkBook.lookupSupplierLink(key);
  const side = faceOf(face);
  const from = side === "front" ? entry?.photoFrom : entry?.backPhotoFrom;
  if (!entry || !from || from.assetId !== assetId) return { forgotten: false, key };

  const next = { ...entry };
  if (side === "front") {
    await linkBook.removeSupplierPhoto(entry.photoBlob).catch(() => {});
    delete next.photoBlob;
    delete next.photoFrom;
    // Without the photo the entry is what the search last made of it: its web
    // photo if it had one, otherwise back in the repair queue.
    if (!next.imageUrl) {
      next.status = "failed";
      next.failReason = `The blank photo uploaded for ${from.department || "a department"} was removed.`;
    }
  } else {
    await linkBook.removeSupplierPhoto(entry.backPhotoBlob).catch(() => {});
    delete next.backPhotoBlob;
    delete next.backPhotoFrom;
    if (!next.backImageUrl) {
      delete next.backStatus;
      delete next.backCheckedFrom;
    }
  }
  await linkBook.saveSupplierLink(key, next);
  for (const cached of new Set([key, ...family])) clearCachedBlank(cached);
  clearCachedBlanksForStyle(keysFor(product, color).query);
  if (side === "back") clearCachedBack(entry.photoBlob || entry.imageUrl);
  return { forgotten: true, key };
}

module.exports = { bookBlankPhoto, unbookBlankPhoto, MIN_EDGE };

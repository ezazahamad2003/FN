const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

/* No web search in here: a garment the book cannot supply must come back
   empty, never reach the network. The photo path does not depend on the
   switch, so the only way these pass is through the book. */
process.env.SUPPLIER_BLANKS = "off";
delete process.env.AZURE_STORAGE_CONNECTION_STRING;

const linkBook = require("../linkBook");
linkBook.setBookAdapter(linkBook.memoryBookAdapter());
const blanks = require("../blanks");
const { bookBlankPhoto, unbookBlankPhoto } = require("../supplierPhotos");

// Foresthill's row of the hat, as the console saves it.
const HAT = { id: "p13", brand: "Delta", styleNumber: "FF180", type: "Hat", title: "Delta Flex Fit" };
const KEY = "delta|ff180|navy|hat";
const FORESTHILL = { onboardingId: "2026-10-12-foresthill-fire-protection-district-ee9d3bb3.json", assetId: "mv6vs7rp-m22yn1.jpg", department: "Foresthill Fire Protection District" };

function photo(size = 600, background = "#1f2a44") {
  return sharp({ create: { width: size, height: size, channels: 3, background } }).png().toBuffer();
}

/* 2026-10-13: Foresthill's FF180 search found nothing, Dan uploaded the blank
   and redid the hat; SCC ordered the same hat two hours later and was drawn an
   invented one, because the upload lived only on Foresthill's row. */
test("a blank photo uploaded on one department is the blank for every department's build of that garment", async () => {
  await linkBook.saveSupplierLink(KEY, { status: "failed", failReason: "No supplier photo found online for FF180. Generated from fetched specs instead." });
  const before = await blanks.findSupplierBlank({ vendor: "Delta", brandStyle: "FF180", garmentColor: "Navy", productType: "Hat" });
  assert.equal(before.imageBuffer, null);

  const upload = await photo();
  const booked = await bookBlankPhoto({ product: HAT, color: "Navy", face: "front", file: { buffer: upload, mimetype: "image/png" }, origin: FORESTHILL, by: "dan" });
  assert.equal(booked.booked, true, booked.reason);
  assert.equal(booked.key, KEY);
  const entry = await linkBook.lookupSupplierLink(KEY);
  assert.equal(entry.status, "verified");
  assert.equal(entry.source, "upload");
  assert.equal(entry.failReason, undefined);
  assert.deepEqual([entry.vendor, entry.brandStyle, entry.garmentColor, entry.productType], ["Delta", "FF180", "Navy", "Hat"]);

  // SCC's build of the same hat: the search that found nothing was cached in
  // this process, and the photo still wins.
  const log = [];
  const scc = await blanks.findSupplierBlank({ vendor: "Delta", brandStyle: "FF180", garmentColor: "Navy", productType: "Hat", productLabel: "Delta Flexfit" }, { onLog: (m) => log.push(m) });
  assert.ok(scc.imageBuffer, log.join("\n"));
  assert.equal(scc.photoBlob, entry.photoBlob);
  assert.equal(scc.imageUrl, null);
  assert.match(scc.note, /uploaded for Foresthill Fire Protection District/);
  assert.ok(log.some((m) => /link book hit: the blank photo uploaded for Foresthill/.test(m)), log.join("\n"));

  // The same hat written the way another form writes it is the same key family.
  const snapback = await blanks.findSupplierBlank({ vendor: "Delta", brandStyle: "FF180", garmentColor: "Navy", productType: "Snapback hat" });
  assert.ok(snapback.imageBuffer);
  assert.equal(snapback.photoBlob, entry.photoBlob);
});

test("the back photo is kept too, and an uploaded front never has a supplier CDN to derive a back from", async () => {
  const entry = await linkBook.lookupSupplierLink(KEY);
  const product = { vendor: "Delta", brandStyle: "FF180", garmentColor: "Navy", productType: "Hat" };
  // No back on file: nothing is invented and nothing is fetched.
  assert.equal(await blanks.findSupplierBack(product, { frontUrl: entry.photoBlob }), null);

  const back = await photo(600, "#2a2f3a");
  const booked = await bookBlankPhoto({ product: HAT, color: "Navy", face: "back", file: { buffer: back, mimetype: "image/png" }, origin: { ...FORESTHILL, assetId: "mv6vs7rp-back.jpg" }, by: "dan" });
  assert.equal(booked.booked, true, booked.reason);
  const found = await blanks.findSupplierBack(product, { frontUrl: entry.photoBlob });
  assert.ok(found && found.imageBuffer);
  assert.equal(found.photoBlob, (await linkBook.lookupSupplierLink(KEY)).backPhotoBlob);
});

test("removing the upload from the row that supplied it forgets it; another row's removal does not", async () => {
  const entry = await linkBook.lookupSupplierLink(KEY);
  const other = await unbookBlankPhoto({ product: HAT, color: "Navy", face: "front", assetId: "some-other-upload.jpg" });
  assert.equal(other.forgotten, false);
  assert.equal((await linkBook.lookupSupplierLink(KEY)).photoBlob, entry.photoBlob);

  const gone = await unbookBlankPhoto({ product: HAT, color: "Navy", face: "front", assetId: FORESTHILL.assetId });
  assert.equal(gone.forgotten, true);
  const after = await linkBook.lookupSupplierLink(KEY);
  assert.equal(after.status, "failed");
  assert.equal(after.photoBlob, undefined);
  assert.match(after.failReason, /uploaded for Foresthill Fire Protection District was removed/);
  assert.equal(await linkBook.readSupplierPhoto(entry.photoBlob), null);
  // The back photo on the same entry is untouched.
  assert.ok(after.backPhotoBlob);

  const miss = await blanks.findSupplierBlank({ vendor: "Delta", brandStyle: "FF180", garmentColor: "Navy", productType: "Hat" });
  assert.equal(miss.imageBuffer, null);
});

test("an upload that is not a usable photo is refused with a reason, not booked", async () => {
  const notImage = await bookBlankPhoto({ product: HAT, color: "Navy", file: { buffer: Buffer.from("not a picture"), mimetype: "image/png" }, origin: FORESTHILL });
  assert.deepEqual(notImage, { booked: false, reason: "the file is not an image" });
  const tiny = await bookBlankPhoto({ product: HAT, color: "Navy", file: { buffer: await photo(200), mimetype: "image/png" }, origin: FORESTHILL });
  assert.equal(tiny.booked, false);
  assert.match(tiny.reason, /too small to reuse \(200x200/);
  const nameless = await bookBlankPhoto({ product: { id: "p9", type: "Hat" }, color: "Navy", file: { buffer: await photo(), mimetype: "image/png" }, origin: FORESTHILL });
  assert.match(nameless.reason, /no brand or style number/);
  assert.equal((await linkBook.lookupSupplierLink(KEY)).status, "failed");
});

test("a booked photo that is gone from storage is marked stale and not shipped", async () => {
  await linkBook.saveSupplierLink("delta|ff180|black|hat", { status: "verified", photoBlob: "supplier-photos/delta-ff180-black-hat-front-lost.png", photoFrom: { department: "Pine Hollow" } });
  const log = [];
  const result = await blanks.findSupplierBlank({ vendor: "Delta", brandStyle: "FF180", garmentColor: "Black", productType: "Hat" }, { onLog: (m) => log.push(m) });
  assert.equal(result.imageBuffer, null);
  await linkBook.flushSupplierLinkWrites();
  const entry = await linkBook.lookupSupplierLink("delta|ff180|black|hat");
  assert.equal(entry.status, "stale");
  assert.match(entry.staleReason, /no longer in storage/);
  assert.equal(entry.photoBlob, undefined);
  assert.ok(log.some((m) => /marking stale/.test(m)), log.join("\n"));
});

test("a verified web photo stays the fallback when its uploaded photo is lost", async () => {
  await linkBook.saveSupplierLink("delta|ff180|red|hat", {
    status: "verified",
    imageUrl: "https://cdn.example.com/ff180-red-front.jpg",
    photoBlob: "supplier-photos/delta-ff180-red-hat-front-lost.png",
    photoFrom: { department: "Pine Hollow" }
  });
  // The search is off, so the web photo is never fetched; what matters is the entry.
  await blanks.findSupplierBlank({ vendor: "Delta", brandStyle: "FF180", garmentColor: "Red", productType: "Hat" });
  await linkBook.flushSupplierLinkWrites();
  const entry = await linkBook.lookupSupplierLink("delta|ff180|red|hat");
  assert.equal(entry.status, "verified");
  assert.equal(entry.imageUrl, "https://cdn.example.com/ff180-red-front.jpg");
  assert.equal(entry.photoBlob, undefined);
});

test("supplierPhotoName is a safe blob name that keeps two uploads of one garment apart", () => {
  const a = linkBook.supplierPhotoName(KEY, "front", "mv6vs7rp-m22yn1.jpg", "jpeg");
  const b = linkBook.supplierPhotoName(KEY, "front", "mv734m4q-5zjhzc.jpg", "jpg");
  assert.equal(a, "supplier-photos/delta-ff180-navy-hat-front-mv6vs7rp-m22yn1-jpg.jpeg");
  assert.equal(b, "supplier-photos/delta-ff180-navy-hat-front-mv734m4q-5zjhzc-jpg.jpeg");
  assert.notEqual(a, b);
  assert.equal(linkBook.supplierPhotoName("port & company|pc61|navy|shirt", "back", "x", "png"), "supplier-photos/port-company-pc61-navy-shirt-back-x.png");
});

/* Cochiti, 2026-10-22: Dan uploaded blank photos for "Zapped" BLKHWK and "YP
   Classics (Yupoong)" 6006. Truckee Meadows ordered the same hats the next day
   as "Zapped Headwear" and "YP Classics"; both missed the book, and the 6006
   was drawn by the image model again. The maker's spelling is not the identity. */
test("a photo uploaded under one spelling of the maker is the blank under another", async () => {
  const upload = await photo();
  const booked = await bookBlankPhoto({
    product: { id: "p10", brand: "Zapped", styleNumber: "BLKHWK", type: "Hat", title: "Blackhawk Snapback" },
    color: "Navy",
    face: "front",
    file: { buffer: upload, mimetype: "image/png" },
    origin: { ...FORESTHILL, department: "Cochiti Fire Department" },
    by: "dan"
  });
  assert.equal(booked.booked, true, booked.reason);
  assert.equal(booked.key, "zapped|blkhwk|navy|hat");
  // A web photo is already booked under the other spelling; Dan's photo still wins.
  await linkBook.saveSupplierLink("zapped headwear|blkhwk|navy|hat", { status: "verified", imageUrl: "https://cdn.test/blkhwk-navy.png" });

  const log = [];
  const found = await blanks.findSupplierBlank({ vendor: "Zapped Headwear", brandStyle: "BLKHWK", garmentColor: "Navy", productType: "Hat" }, { onLog: (m) => log.push(m) });
  assert.ok(found.imageBuffer, log.join("\n"));
  assert.equal(found.photoBlob, booked.photoBlob);
  assert.match(found.note, /uploaded for Cochiti Fire Department/);
  assert.ok(log.some((m) => /booked as "zapped\|blkhwk\|navy\|hat".*another spelling of the maker/.test(m)), log.join("\n"));

  // Another colour never borrows it, and neither does a maker that shares no word with the one booked.
  const black = await blanks.findSupplierBlank({ vendor: "Zapped Headwear", brandStyle: "BLKHWK", garmentColor: "Black", productType: "Hat" });
  assert.equal(black.imageBuffer, null);
  const other = await blanks.findSupplierBlank({ vendor: "Richardson", brandStyle: "BLKHWK", garmentColor: "Navy", productType: "Hat" });
  assert.equal(other.imageBuffer, null);

  // The 6006 case: a failed search is booked under the new spelling, the photo under the old.
  await linkBook.saveSupplierLink("yp classics|6006|navy|hat", { status: "failed", failReason: "No usable supplier photo for 6006." });
  const trucker = await bookBlankPhoto({
    product: { id: "p13", brand: "YP Classics (Yupoong)", styleNumber: "6006", type: "Hat" },
    color: "Navy",
    face: "front",
    file: { buffer: upload, mimetype: "image/png" },
    origin: { ...FORESTHILL, department: "Cochiti Fire Department" },
    by: "dan"
  });
  const truckee = await blanks.findSupplierBlank({ vendor: "YP Classics", brandStyle: "6006", garmentColor: "Navy", productType: "Hat" });
  assert.equal(truckee.photoBlob, trucker.photoBlob);
});

/* Cochiti's PC61 photo was 483x724: the row rendered it, the book refused it
   as "too small to reuse", and Truckee Meadows was drawn an invented tee. */
test("a blank photo the row itself renders is kept for other departments even below the web-photo bar", async () => {
  const upload = await sharp({ create: { width: 483, height: 724, channels: 3, background: "#1f2a44" } }).png().toBuffer();
  const booked = await bookBlankPhoto({
    product: { id: "p3", brand: "Port & Company", styleNumber: "PC61", type: "T-shirt" },
    color: "Deep Navy",
    face: "front",
    file: { buffer: upload, mimetype: "image/png" },
    origin: FORESTHILL,
    by: "dan"
  });
  assert.equal(booked.booked, true, booked.reason);
  const found = await blanks.findSupplierBlank({ vendor: "Port & Company", brandStyle: "PC61", garmentColor: "Deep Navy", productType: "T-shirt" });
  assert.ok(found.imageBuffer);
  assert.equal(found.photoBlob, booked.photoBlob);

  // A thumbnail that could never pass as a product image is still refused.
  const tiny = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#1f2a44" } }).png().toBuffer();
  const refused = await bookBlankPhoto({
    product: { id: "p4", brand: "Port & Company", styleNumber: "PC61T", type: "T-shirt" },
    color: "Deep Navy",
    face: "front",
    file: { buffer: tiny, mimetype: "image/png" },
    origin: FORESTHILL,
    by: "dan"
  });
  assert.equal(refused.booked, false);
  assert.match(refused.reason, /too small/);
});

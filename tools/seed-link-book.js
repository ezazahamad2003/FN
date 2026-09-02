/* -----------------------------------------------------------------------------
   Seed the supplier link book.

   Runs the SAME search+vision pipeline the store builder uses
   (blanks.findSupplierBlank) over a fixed grid of vendor x style x color, so
   every entry that lands in the book carries the same verification a real
   build would have done. The pipeline itself writes each success ("verified")
   and each dead end ("failed") into the book; what this script adds is the
   grid, a concurrency pool, and the CANONICAL copies:

   A customer who names only a vendor ("Richardson trucker hat, navy") produces
   the key "richardson|richardson|navy|hat" - brandStyle falls back to the
   vendor. For styles marked canonical below, the verified entry is copied to
   that vendor-only key, so no-style orders resolve deterministically to the
   style chosen here instead of whatever a live search ranks first that day.

   Usage (from the project root, .env supplies the keys):
     node tools/seed-link-book.js
   -------------------------------------------------------------------------- */

require("dotenv").config();
const { findSupplierBlank } = require("../blanks");
const { flushSupplierLinkWrites, lookupSupplierLink, saveSupplierLink } = require("../linkBook");

// productType strings MUST match CUSTOMER_INTAKE_CATEGORIES[].type in
// customerIntakes.js - the book key is built from what the intake stores.
const STYLES = [
  { vendor: "Richardson", style: "112", type: "hat", canonical: true },
  { vendor: "Richardson", style: "115", type: "hat" },
  { vendor: "Next Level", style: "3600", type: "shirt", canonical: true },
  { vendor: "Next Level", style: "6210", type: "shirt" },
  { vendor: "Next Level", style: "3601", type: "long sleeve shirt", canonical: true },
  { vendor: "Bella+Canvas", style: "3001", type: "shirt", canonical: true },
  { vendor: "Bella+Canvas", style: "3719", type: "hoodie", canonical: true },
  { vendor: "Gildan", style: "5000", type: "shirt", canonical: true },
  { vendor: "Gildan", style: "18500", type: "hoodie", canonical: true },
  { vendor: "Gildan", style: "2400", type: "long sleeve shirt", canonical: true },
  { vendor: "Gildan", style: "18000", type: "sweatshirt", canonical: true },
  { vendor: "Comfort Colors", style: "1717", type: "shirt", canonical: true },
  { vendor: "Carhartt", style: "K87", type: "shirt", canonical: true },
  { vendor: "Carhartt", style: "K121", type: "hoodie", canonical: true },
  { vendor: "Port & Company", style: "PC61", type: "shirt", canonical: true },
  { vendor: "Port & Company", style: "PC78H", type: "hoodie", canonical: true },
  { vendor: "Port & Company", style: "PC78", type: "sweatshirt", canonical: true },
  { vendor: "Port Authority", style: "K500", type: "polo", canonical: true },
  { vendor: "Port Authority", style: "C112", type: "hat", canonical: true },
  { vendor: "Port Authority", style: "CP90", type: "hat" },
  { vendor: "Sport-Tek", style: "ST350", type: "shirt", canonical: true },
  { vendor: "Yupoong", style: "6606", type: "hat", canonical: true },
  { vendor: "Flexfit", style: "6606", type: "hat", canonical: true }
];

const COLORS = ["navy", "black", "charcoal", "red", "royal", "white", "grey", "maroon"];
const CONCURRENCY = 3;

const keyOf = (vendor, style, color, type) => `${vendor}|${style}|${color}|${type}`.toLowerCase();

async function seedOne({ vendor, style, type, canonical }, color) {
  const key = keyOf(vendor, style, color, type);
  const existing = await lookupSupplierLink(key).catch(() => null);
  if (existing?.status === "verified") {
    console.log(`RESULT skipped ${key} (already verified)`);
    return "skipped";
  }

  const result = await findSupplierBlank(
    { vendor, brandStyle: style, garmentColor: color, productType: type },
    { onLog: () => {} } // per-candidate chatter stays out of the seed log
  );
  const ok = Boolean(result.imageBuffer);
  console.log(`RESULT ${ok ? "verified" : "failed"} ${key}${ok ? ` -> ${result.imageUrl}` : ""}`);

  // The vendor-only key is what a no-style order produces; point it at the
  // canonical style's verified link so those orders resolve deterministically.
  if (ok && canonical) {
    const vendorKey = keyOf(vendor, vendor, color, type);
    const current = await lookupSupplierLink(vendorKey).catch(() => null);
    if (current?.status !== "verified") {
      await saveSupplierLink(vendorKey, {
        vendor,
        brandStyle: vendor,
        garmentColor: color,
        productType: type,
        status: "verified",
        imageUrl: result.imageUrl,
        sourceUrl: result.sourceUrl,
        spec: result.spec || "",
        facts: result.facts || null,
        canonicalStyle: style,
        verifiedAt: new Date().toISOString(),
        source: "seed"
      });
      console.log(`RESULT canonical ${vendorKey} -> ${style}`);
    }
  }
  return ok ? "verified" : "failed";
}

(async () => {
  const combos = [];
  for (const entry of STYLES) for (const color of COLORS) combos.push([entry, color]);
  console.log(`SEED starting: ${combos.length} combos, concurrency ${CONCURRENCY}`);

  const counts = { verified: 0, failed: 0, skipped: 0, errored: 0 };
  let index = 0;
  const worker = async () => {
    while (index < combos.length) {
      const [entry, color] = combos[index++];
      try {
        counts[await seedOne(entry, color)]++;
      } catch (error) {
        counts.errored++;
        console.log(`RESULT errored ${keyOf(entry.vendor, entry.style, color, entry.type)} (${error.message})`);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } catch (error) {
    console.log(`FATAL ${error.message}`);
  }
  // The pipeline queues its book writes fire-and-forget; exiting before the
  // queue drains would silently drop the tail of the results.
  console.log("SEED draining book writes...");
  await flushSupplierLinkWrites().catch((error) => console.log(`FATAL flush failed: ${error.message}`));
  console.log(
    `SUMMARY verified=${counts.verified} failed=${counts.failed} skipped=${counts.skipped} errored=${counts.errored} total=${combos.length}`
  );
  process.exit(0);
})().catch((error) => {
  console.log(`FATAL ${error.message}`);
  process.exit(1);
});

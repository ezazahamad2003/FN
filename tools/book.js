/* -----------------------------------------------------------------------------
   Supplier link book CLI - the hands an operator (or a Claude agent working
   this folder) uses on the book. All writes go through linkBook.js, the same
   module the build pipeline reads, so anything recorded here is used by the
   very next build.

   Usage (from the project root, .env supplies the storage key):
     node tools/book.js list [status]           every entry (or just one status)
     node tools/book.js queue                   entries needing work (failed/stale)
     node tools/book.js get "<key>"             one entry, full JSON
     node tools/book.js verify "<key>" <imageUrl> [sourceUrl]
                                                download-check the image and save
                                                the entry as verified
     node tools/book.js fail "<key>" "<reason>" mark a combo unavailable (e.g. the
                                                colorway is not made) so nothing
                                                keeps hunting for it
     node tools/book.js remove "<key>"          delete an entry outright

   Keys look like "vendor|style|color|productType", all lowercase - exactly
   what blanks.js builds from an intake. "queue" prints them ready to paste.
   -------------------------------------------------------------------------- */

require("dotenv").config();
const fetch = require("node-fetch");
const sharp = require("sharp");
const { listSupplierLinks, lookupSupplierLink, saveSupplierLink, removeSupplierLink } = require("../linkBook");

const MIN_EDGE = 500;

function parseKey(key) {
  const [vendor = "", brandStyle = "", garmentColor = "", productType = ""] = String(key).split("|");
  return { vendor, brandStyle, garmentColor, productType };
}

async function main() {
  const [command, key, arg1, arg2] = process.argv.slice(2);

  if (command === "list" || command === "queue") {
    const wanted = command === "queue" ? ["failed", "stale"] : key ? [key] : null;
    const entries = await listSupplierLinks();
    const rows = Object.entries(entries).filter(([, entry]) => !wanted || wanted.includes(entry.status));
    rows.sort(([a], [b]) => a.localeCompare(b));
    for (const [entryKey, entry] of rows) {
      const detail =
        entry.status === "verified"
          ? entry.imageUrl
          : entry.status === "stale"
            ? `was ${entry.imageUrl} (${entry.staleReason || "stopped downloading"})`
            : entry.failReason || entry.reason || "";
      console.log(`${entry.status.padEnd(11)} ${entryKey}${detail ? `  ${detail}` : ""}`);
    }
    console.log(`${rows.length} entr${rows.length === 1 ? "y" : "ies"}`);
    return;
  }

  if (!key) throw new Error(`"${command}" needs a key. See the usage block at the top of tools/book.js.`);

  if (command === "get") {
    console.log(JSON.stringify((await lookupSupplierLink(key)) || null, null, 2));
    return;
  }

  if (command === "verify") {
    if (!arg1) throw new Error("verify needs an image URL.");
    const response = await fetch(arg1, {
      headers: {
        accept: "image/*",
        // Some vendor CDNs refuse node's default agent; the pipeline browses
        // as a desktop browser, so validation must too.
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
      },
      redirect: "follow",
      timeout: 20000
    });
    if (!response.ok) throw new Error(`image URL returned ${response.status}`);
    const type = String(response.headers.get("content-type") || "");
    if (!type.startsWith("image/")) throw new Error(`not an image (${type || "unknown type"})`);
    const buffer = await response.buffer();
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_EDGE) {
      throw new Error(`image too small (${meta.width || 0}x${meta.height || 0}); need ${MIN_EDGE}px on the short edge`);
    }
    const previous = (await lookupSupplierLink(key)) || {};
    await saveSupplierLink(key, {
      ...parseKey(key),
      ...previous,
      status: "verified",
      imageUrl: arg1,
      sourceUrl: arg2 || previous.sourceUrl || null,
      verifiedAt: new Date().toISOString(),
      source: "agent",
      staleReason: undefined,
      failReason: undefined
    });
    console.log(`verified ${key} (${meta.width}x${meta.height}) -> ${arg1}`);
    return;
  }

  if (command === "fail") {
    const previous = (await lookupSupplierLink(key)) || {};
    await saveSupplierLink(key, {
      ...parseKey(key),
      ...previous,
      status: "unavailable",
      reason: arg1 || "not available",
      source: "agent"
    });
    console.log(`marked unavailable ${key}: ${arg1 || "not available"}`);
    return;
  }

  if (command === "remove") {
    await removeSupplierLink(key);
    console.log(`removed ${key}`);
    return;
  }

  throw new Error(`Unknown command "${command}". See the usage block at the top of tools/book.js.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });

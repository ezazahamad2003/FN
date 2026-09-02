/* -----------------------------------------------------------------------------
   Derive missing colorways from verified siblings.

   Vendor CDNs encode the colorway in the image filename
   ("richardson_112-navy-front.jpg", "5000_Sport%20Grey_flat.png"), so when
   one color of a style has a verified link and another color of the SAME
   style failed, the failed one can usually be addressed directly: find the
   color token in the verified URL, substitute the target color's known
   aliases, and download-test each guess. A hit is recorded as verified with
   source "derived" (and derivedFrom naming the sibling), pointing at the
   sibling's product page.

   The download check proves the URL serves a big-enough image; it cannot see
   whether the color is right, which is why derived entries name their source:
   spot-check a sample visually (open the imageUrl) after a run.

   Usage (from the project root): node tools/derive-colorways.js
   -------------------------------------------------------------------------- */

require("dotenv").config();
const fetch = require("node-fetch");
const sharp = require("sharp");
const { flushSupplierLinkWrites, listSupplierLinks, saveSupplierLink } = require("../linkBook");

const MIN_EDGE = 500;
const MAX_GUESSES_PER_KEY = 12;

// Word-array aliases, conservative: only names vendors use for the SAME color.
const COLOR_ALIASES = {
  navy: [["navy"], ["true", "navy"], ["navy", "blue"], ["midnight", "navy"], ["new", "navy"]],
  black: [["black"], ["jet", "black"], ["true", "black"]],
  charcoal: [["charcoal"], ["charcoal", "grey"], ["charcoal", "gray"], ["heather", "charcoal"], ["charcoal", "heather"]],
  red: [["red"], ["true", "red"], ["classic", "red"]],
  royal: [["royal"], ["true", "royal"], ["royal", "blue"], ["flag", "royal"]],
  white: [["white"], ["true", "white"], ["pfd", "white"]],
  grey: [["grey"], ["gray"], ["sport", "grey"], ["sport", "gray"], ["athletic", "heather"], ["heather", "grey"], ["heather", "gray"]],
  maroon: [["maroon"], ["true", "maroon"]]
};

const SEPARATORS = ["", "-", "_", "%20", " "];

function joinAlias(words, separator) {
  return words.join(separator);
}

function matchCase(sample, replacement) {
  if (sample === sample.toUpperCase() && /[A-Z]/.test(sample)) return replacement.toUpperCase();
  if (/^[A-Z]/.test(sample)) return replacement.replace(/(^|[-_ ]|%20)([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
  return replacement;
}

/* Every URL obtained by swapping the source color's token for the target
   color's aliases, most-similar formatting first. */
function candidateUrls(sourceUrl, sourceColor, targetColor) {
  const sourceAliases = COLOR_ALIASES[sourceColor] || [[sourceColor]];
  const targetAliases = COLOR_ALIASES[targetColor] || [[targetColor]];
  const out = [];
  for (const sourceWords of sourceAliases) {
    for (const separator of SEPARATORS) {
      const token = joinAlias(sourceWords, separator);
      const index = sourceUrl.toLowerCase().indexOf(token.toLowerCase());
      if (index < 0) continue;
      const found = sourceUrl.slice(index, index + token.length);
      for (const targetWords of targetAliases) {
        // Keep the separator style and case the CDN actually uses.
        const replacement = matchCase(found, joinAlias(targetWords, separator));
        const candidate = sourceUrl.slice(0, index) + replacement + sourceUrl.slice(index + token.length);
        if (candidate !== sourceUrl && !out.includes(candidate)) out.push(candidate);
      }
    }
  }
  return out.slice(0, MAX_GUESSES_PER_KEY);
}

async function testImage(url) {
  const response = await fetch(url, {
    headers: {
      accept: "image/*",
      // Some vendor CDNs refuse node's default agent; browse like a browser.
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    },
    redirect: "follow",
    timeout: 15000
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const type = String(response.headers.get("content-type") || "");
  if (!type.startsWith("image/")) throw new Error(`not an image (${type})`);
  const buffer = await response.buffer();
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_EDGE) {
    throw new Error(`too small (${meta.width || 0}x${meta.height || 0})`);
  }
  return meta;
}

(async () => {
  const entries = await listSupplierLinks();
  const groups = new Map(); // vendor|style|type -> {verified: [], missing: []}
  for (const [key, entry] of Object.entries(entries)) {
    const groupKey = `${entry.vendor}|${entry.brandStyle}|${entry.productType}`.toLowerCase();
    if (!groups.has(groupKey)) groups.set(groupKey, { verified: [], missing: [] });
    if (entry.status === "verified" && entry.imageUrl) groups.get(groupKey).verified.push({ key, entry });
    else if (entry.status === "failed" || entry.status === "stale") groups.get(groupKey).missing.push({ key, entry });
  }

  let derived = 0;
  let unresolved = 0;
  for (const [groupKey, group] of groups) {
    if (!group.verified.length || !group.missing.length) continue;
    for (const { key, entry } of group.missing) {
      const targetColor = String(entry.garmentColor || "").toLowerCase();
      let hit = null;
      for (const sibling of group.verified) {
        const sourceColor = String(sibling.entry.garmentColor || "").toLowerCase();
        for (const candidate of candidateUrls(sibling.entry.imageUrl, sourceColor, targetColor)) {
          try {
            const meta = await testImage(candidate);
            hit = { candidate, sibling, meta };
            break;
          } catch {
            // guesses are free to fail; the next one may resolve
          }
        }
        if (hit) break;
      }
      if (hit) {
        derived++;
        console.log(`RESULT derived ${key} -> ${hit.candidate} (${hit.meta.width}x${hit.meta.height}, from ${hit.sibling.key})`);
        await saveSupplierLink(key, {
          vendor: entry.vendor,
          brandStyle: entry.brandStyle,
          garmentColor: entry.garmentColor,
          productType: entry.productType,
          status: "verified",
          imageUrl: hit.candidate,
          sourceUrl: hit.sibling.entry.sourceUrl || null,
          spec: hit.sibling.entry.spec || "",
          facts: hit.sibling.entry.facts || null,
          verifiedAt: new Date().toISOString(),
          source: "derived",
          derivedFrom: hit.sibling.key
        });
      } else {
        unresolved++;
        console.log(`RESULT unresolved ${key} (${groupKey}: ${group.verified.length} verified sibling${group.verified.length === 1 ? "" : "s"}, no guess landed)`);
      }
    }
  }

  await flushSupplierLinkWrites().catch((error) => console.log(`FATAL flush failed: ${error.message}`));
  console.log(`SUMMARY derived=${derived} unresolved=${unresolved}`);
  process.exit(0);
})().catch((error) => {
  console.log(`FATAL ${error.message}`);
  process.exit(1);
});

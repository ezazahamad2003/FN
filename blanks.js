const OpenAI = require("openai");
const fetch = require("node-fetch");
const sharp = require("sharp");

/*
 * Source the BLANK garment photo from the supplier instead of generating it.
 *
 * An image model does not know what "NL3600" looks like — it draws a plausible
 * t-shirt, which is why generated bases did not match the style numbers the
 * department ordered. Manufacturers and authorised distributors publish flat,
 * front-facing, undecorated photos of every style; that photo IS the correct
 * garment, so the department's logo lands on the real thing.
 *
 * Order of preference:
 *   1. the supplier's own flat-front product photo (exact garment), else
 *   2. generation guided by the specs fetched here (close, not exact), else
 *   3. generation from the policy wording alone (the original behaviour).
 *
 * Nothing here is trusted on faith. A search result is a claim about a URL, not
 * evidence: every candidate is downloaded and then checked by vision for the
 * right garment, the right colour, no decoration, and a flat front view. A
 * model shot is rejected outright — placement maths assumes a flat lay, so a
 * photo of a person would put the logo on a face.
 */

const SEARCH_MODEL = process.env.OPENAI_SEARCH_MODEL || "gpt-4o";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const PAGE_TIMEOUT_MS = 20000;
const MAX_HTML_BYTES = 3_000_000;
const MAX_IMAGE_BYTES = 12_000_000;
const MIN_IMAGE_EDGE = 500;
const CANVAS = 1024;

// Repeated onboarding runs and multi-colour departments hit the same styles, so
// keep results for the life of the process. Cheap, and it keeps a re-run after
// a review-gate rejection from paying for the same searches twice.
const cache = new Map();

function client() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing. Add a fresh key to .env before running onboarding.");
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function supplierBlanksEnabled() {
  return String(process.env.SUPPLIER_BLANKS || "on").toLowerCase() !== "off";
}

function parseJsonLoose(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    // Web-search answers often wrap JSON in prose; take the outermost object.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch (inner) {
        return null;
      }
    }
    return null;
  }
}

function absoluteUrl(raw, pageUrl) {
  try {
    const url = new URL(String(raw).replace(/&amp;/g, "&"), pageUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch (error) {
    return null;
  }
}

/*
 * Score an image URL by what its filename says about the shot. Suppliers encode
 * the view in the filename ("NL3600RedFlatFront8.jpg", "...ModelBack..."), and
 * the declared pixel width ("1200W-", "?width=1200") tells us which size to
 * take. Negative scores are dropped before anything is downloaded.
 */
function scoreImageUrl(url) {
  const name = url.toLowerCase();
  if (/(swatch|sprite|icon|logo|placeholder|thumb|favicon|badge|size.?chart)/.test(name)) return -1;
  // Back and side views cannot take a front-chest logo.
  if (/(modelback|model_back|-back-|back\d|modelside|model_side|-side-|detail)/.test(name)) return -1;

  let score = 0;
  if (/flat.?front/.test(name)) score += 100;
  else if (/(flat|laydown|lay.?down|ghost|invisible.?man)/.test(name)) score += 70;
  else if (/model/.test(name)) score -= 40; // usable only as a last resort; vision will reject it
  if (/front/.test(name)) score += 20;

  const declared = Math.max(
    ...[...name.matchAll(/(?:^|[^a-z0-9])(\d{3,4})w(?:[^a-z0-9]|$)/g)].map((m) => +m[1]),
    ...[...name.matchAll(/[?&]width=(\d{3,4})/g)].map((m) => +m[1]),
    0
  );
  if (declared) score += Math.min(declared, 2000) / 100;
  return score;
}

/*
 * Vision cannot police style identity. NL3600 and NL3214 are both plain navy
 * tees; a verifier looking at pixels passes the wrong one happily, which is
 * precisely how a search result for "NL3600" ended up returning a 3214 photo in
 * testing. Style identity therefore has to come from provenance: the image's
 * own URL must name the style. Anything that cannot prove which style it shows
 * is dropped, and generation takes over.
 */
function styleTokens(brandStyle) {
  const tokens = new Set();
  for (const word of String(brandStyle).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (!/\d/.test(word)) continue; // "next", "level" say nothing about identity
    if (word.length >= 3) tokens.add(word);
    // Letters BEFORE the digits are a brand prefix ("nl"3600), so the bare
    // number still identifies the style — suppliers often file it that way.
    // Letters AFTER the digits are part of the style ("cs410"LS is the long
    // sleeve of CS410), so the bare number must NOT be used or the wrong
    // garment matches.
    if (/^[a-z]*\d+$/.test(word)) {
      for (const run of word.match(/\d{3,}/g) || []) tokens.add(run);
    }
  }
  return [...tokens];
}

function matchesStyle(url, tokens) {
  if (!tokens.length) return true; // nothing to check against
  const flat = url.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return tokens.some((token) => flat.includes(token));
}

/*
 * Search engines land on whichever colourway ranks highest, so a lookup for a
 * navy tee routinely returns the right style in the wrong colour. Suppliers
 * encode the colourway in the filename ("NL3600_antiquegold_flat_front.jpg"),
 * so the sibling image can be addressed directly. These URLs are guesses: most
 * 404, and any that resolve still face the same vision check as everything
 * else, so a wrong guess costs a failed request and nothing more.
 */
const COLOR_ALIASES = {
  navy: ["navy", "truenavy", "midnightnavy", "navyblue"],
  black: ["black", "jetblack", "trueblack"],
  red: ["red", "truered", "classicred"],
  grey: ["grey", "gray", "heathergrey", "darkheathergrey"],
  gray: ["gray", "grey", "heathergray", "darkheathergray"],
  white: ["white", "truewhite"],
  royal: ["royal", "trueroyal", "royalblue"]
};

function colorVariants(garmentColor) {
  const base = String(garmentColor || "").toLowerCase().trim();
  if (!base) return [];
  const compact = base.replace(/[^a-z0-9]+/g, "");
  const words = base.split(/\s+/).filter(Boolean);
  const variants = new Set([compact, ...words]);
  for (const word of [...words, compact]) {
    for (const alias of COLOR_ALIASES[word] || []) variants.add(alias);
  }
  return [...variants].filter((value) => value.length >= 3).slice(0, 5);
}

function recoloredUrls(url, garmentColor, tokens) {
  const colors = colorVariants(garmentColor);
  if (!colors.length || !tokens.length) return [];
  const pattern = new RegExp(
    `((?:${tokens.join("|")})[-_])([a-z0-9%.\\s]{2,24}?)([-_](?:flat|front|back|model|laydown))`,
    "i"
  );
  if (!pattern.test(url)) return [];
  const out = new Set();
  for (const color of colors) out.add(url.replace(pattern, `$1${color}$3`));
  out.delete(url);
  return [...out].slice(0, 4);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml" },
    timeout: PAGE_TIMEOUT_MS,
    size: MAX_HTML_BYTES,
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`page returned ${response.status}`);
  return response.text();
}

async function fetchImage(url) {
  const response = await fetch(url, {
    headers: { "user-agent": BROWSER_UA, accept: "image/*" },
    timeout: PAGE_TIMEOUT_MS,
    size: MAX_IMAGE_BYTES,
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`image returned ${response.status}`);
  const type = String(response.headers.get("content-type") || "");
  if (!type.startsWith("image/")) throw new Error(`not an image (${type || "unknown type"})`);
  return response.buffer();
}

// Pull every plausible product image off a product page, best shot first.
async function imageCandidatesFromPage(pageUrl) {
  const html = await fetchText(pageUrl);
  const raw = new Set();

  for (const match of html.matchAll(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)/gi)) {
    raw.add(match[1]);
  }
  for (const match of html.matchAll(/<img[^>]+(?:data-)?src=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)/gi)) {
    raw.add(match[1]);
  }
  // Product galleries frequently keep the high-res set in inline JSON only, and
  // usually protocol-relative ("//cdn.host/…") with the slashes JSON-escaped,
  // so the protocol cannot be required here.
  for (const match of html.matchAll(/(?:https?:)?\\?\/\\?\/[^"'\s\\<>()]+?\.(?:jpg|jpeg|png)/gi)) {
    raw.add(match[0].replace(/\\/g, ""));
  }

  return [...raw]
    .map((value) => absoluteUrl(value, pageUrl))
    .filter(Boolean)
    .map((url) => ({ url, score: scoreImageUrl(url) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.url);
}

/*
 * Ask the web where this style lives and what it looks like. The spec paragraph
 * is returned even when no usable photo is found — it is what lets the
 * generation fallback produce something close instead of a generic garment.
 */
async function searchSupplier({ brandStyle, garmentColor, productType }) {
  const openai = client();
  const colorPhrase = garmentColor ? ` in ${garmentColor}` : "";
  const response = await openai.responses.create({
    model: SEARCH_MODEL,
    tools: [{ type: "web_search" }],
    input: `Find the blank wholesale apparel style "${brandStyle}"${colorPhrase}${
      productType ? ` (a ${productType})` : ""
    } on the manufacturer's site or an authorised wholesale distributor (SanMar, S&S Activewear, alphabroder, Next Level Apparel, Richardson, Augusta, Carhartt, or the brand's own site).

I need the plain product photo of the garment with NO decoration on it.

Return ONLY a JSON object and no other text:
{
  "productPages": ["product page URLs for this exact style, best first, max 4"],
  "imageUrls": ["direct URLs ending in .jpg or .png showing this style, prefer a flat/laydown front view over a photo on a model, max 4"],
  "spec": "one paragraph describing exactly what this style looks like: silhouette and cut, neckline or collar, sleeve length, cuffs, placket and buttons, hem, pockets, fabric texture and weight, and how it hangs"
}

Only list URLs you actually saw in the search results. If you cannot confirm the style, use empty arrays but still write the best spec paragraph you can.`
  });

  const parsed = parseJsonLoose(response.output_text) || {};
  const clean = (list) =>
    (Array.isArray(list) ? list : [])
      .map((value) => absoluteUrl(value, "https://example.com"))
      .filter(Boolean)
      .slice(0, 4);

  return {
    productPages: clean(parsed.productPages),
    imageUrls: clean(parsed.imageUrls),
    spec: String(parsed.spec || "").trim()
  };
}

/*
 * The gate that makes this safe to publish. A search result asserting "this is
 * NL3600 in navy" is not evidence; the pixels are. Reject anything that is not
 * the right garment, the right colour, undecorated, and shot flat from the
 * front, because every one of those failures ends up on a customer listing.
 */
async function verifyBlankPhoto(buffer, mimeType, { brandStyle, garmentColor, productType, productLabel }) {
  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `This image is a candidate product photo for a blank garment that a fire department will have its logo embroidered onto.

Expected garment: ${productLabel || productType || "garment"}${brandStyle ? ` (style ${brandStyle})` : ""}
Expected colour: ${garmentColor || "not specified — accept any colour"}

Return JSON only:
{
  "garmentMatches": true|false,   // is this the expected KIND of garment (t-shirt vs polo vs pants vs cap, correct sleeve length)?
  "garmentSeen": "what garment is actually shown",
  "colourMatches": true|false,    // true if the expected colour was not specified
  "colourSeen": "the garment's actual colour",
  "undecorated": true|false,      // false if ANY logo, text, emblem, patch or printed graphic appears on the garment
  "decorationSeen": "what decoration is on it, if any",
  "shotType": "flat-front" | "model" | "back" | "side" | "other",
  "backgroundClean": true|false,  // plain white or plain neutral studio background
  "singleGarment": true|false     // false if the image shows several garments, a colour grid, or a collage
}

"flat-front" means the garment alone, laid flat or on an invisible mannequin, photographed from the front. A photo containing a human model is "model", never "flat-front". Ignore brand neck labels and sewn-in care tags — those are not decoration.`
          },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${buffer.toString("base64")}` } }
        ]
      }
    ],
    max_tokens: 400
  });

  const parsed = parseJsonLoose(response.choices[0]?.message?.content) || {};
  const reasons = [];
  if (parsed.garmentMatches !== true) reasons.push(`wrong garment (saw ${parsed.garmentSeen || "something else"})`);
  if (parsed.colourMatches !== true) reasons.push(`wrong colour (saw ${parsed.colourSeen || "unknown"})`);
  if (parsed.undecorated !== true) reasons.push(`already decorated (${parsed.decorationSeen || "artwork present"})`);
  if (parsed.shotType !== "flat-front") reasons.push(`${parsed.shotType || "unknown"} shot, not a flat front view`);
  if (parsed.backgroundClean !== true) reasons.push("background is not a clean studio backdrop");
  if (parsed.singleGarment !== true) reasons.push("image shows more than one garment");

  return { usable: reasons.length === 0, reasons, seen: parsed };
}

// Put every base on the same square white canvas so a store mixing supplier
// photos and generated ones still looks like one catalogue.
async function normalizeBase(buffer) {
  return sharp(buffer)
    .resize({ width: CANVAS, height: CANVAS, fit: "inside", withoutEnlargement: false })
    .flatten({ background: "#ffffff" })
    .extend({ background: "#ffffff", top: 0, bottom: 0, left: 0, right: 0 })
    .resize({ width: CANVAS, height: CANVAS, fit: "contain", background: "#ffffff" })
    .png()
    .toBuffer();
}

async function tryCandidate(url, expectations, log) {
  const buffer = await fetchImage(url);
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_IMAGE_EDGE) {
    throw new Error(`too small (${meta.width || 0}x${meta.height || 0})`);
  }
  const verdict = await verifyBlankPhoto(buffer, `image/${meta.format === "jpg" ? "jpeg" : meta.format}`, expectations);
  if (!verdict.usable) throw new Error(verdict.reasons.join("; "));
  log(`accepted supplier photo: ${url}`);
  return normalizeBase(buffer);
}

/*
 * Find a usable supplier photo for one style. Always resolves — a failure here
 * must never fail the onboarding run, it just falls back to generation.
 */
async function findSupplierBlank(product, { onLog } = {}) {
  const brandStyle = String(product.brandStyle || "").trim();
  const log = (message) => {
    if (onLog) onLog(message);
  };

  const empty = { imageBuffer: null, imageUrl: null, sourceUrl: null, spec: "", note: "" };
  if (!brandStyle) {
    return { ...empty, note: "No brand/style number stated, so no supplier photo could be looked up." };
  }
  if (!supplierBlanksEnabled()) {
    return { ...empty, note: "Supplier photo lookup is disabled (SUPPLIER_BLANKS=off)." };
  }

  const cacheKey = `${brandStyle}|${product.garmentColor || ""}`.toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const expectations = {
    brandStyle,
    garmentColor: product.garmentColor || "",
    productType: product.productType || "",
    productLabel: product.productLabel || ""
  };

  let result;
  try {
    const found = await searchSupplier(expectations);
    const rejected = [];
    const tokens = styleTokens(brandStyle);

    // Images harvested from a product page we fetched ourselves come first:
    // their provenance is verifiable. A bare image URL the search model handed
    // back is the weakest input, so it is only tried once pages are exhausted.
    const candidates = [];
    for (const pageUrl of found.productPages) {
      try {
        candidates.push(...(await imageCandidatesFromPage(pageUrl)));
      } catch (error) {
        log(`could not read ${pageUrl}: ${error.message}`);
      }
    }
    candidates.push(
      ...found.imageUrls
        .map((url) => ({ url, score: scoreImageUrl(url) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((item) => item.url)
    );

    const identified = [...new Set(candidates)].filter((url) => {
      if (matchesStyle(url, tokens)) return true;
      log(`skipped ${url.split("/").pop()}: filename does not name style ${brandStyle}`);
      return false;
    });

    let imageBuffer = null;
    let imageUrl = null;
    const shortlist = identified.slice(0, 6);
    for (const url of shortlist) {
      try {
        imageBuffer = await tryCandidate(url, expectations, log);
        imageUrl = url;
        break;
      } catch (error) {
        rejected.push(`${url.split("/").pop()} — ${error.message}`);
        log(`rejected ${url}: ${error.message}`);
      }
    }

    // Right style, wrong colourway: address the correct colour's file directly.
    if (!imageBuffer) {
      const recolored = [...new Set(shortlist.flatMap((url) => recoloredUrls(url, expectations.garmentColor, tokens)))];
      for (const url of recolored.slice(0, 5)) {
        try {
          imageBuffer = await tryCandidate(url, expectations, log);
          imageUrl = url;
          log(`recovered the correct colourway by URL: ${url}`);
          break;
        } catch (error) {
          log(`recolour attempt failed ${url}: ${error.message}`);
        }
      }
    }

    result = {
      imageBuffer,
      imageUrl,
      sourceUrl: found.productPages[0] || null,
      spec: found.spec,
      note: imageBuffer
        ? `Blank garment is the supplier's own photo of ${brandStyle}.`
        : rejected.length
          ? `No usable supplier photo for ${brandStyle} (${rejected.length} candidate${
              rejected.length === 1 ? "" : "s"
            } rejected: ${rejected[0]}). Generated from fetched specs instead.`
          : `No supplier photo found online for ${brandStyle}. Generated from fetched specs instead.`
    };
  } catch (error) {
    log(`supplier lookup failed for ${brandStyle}: ${error.message}`);
    result = { ...empty, note: `Supplier lookup failed for ${brandStyle} (${error.message}). Generated instead.` };
  }

  cache.set(cacheKey, result);
  return result;
}

module.exports = {
  findSupplierBlank,
  supplierBlanksEnabled,
  // exported for tests
  scoreImageUrl,
  imageCandidatesFromPage,
  styleTokens,
  matchesStyle
};

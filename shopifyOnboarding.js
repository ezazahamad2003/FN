/*
 * Department Onboarding Agent — the Shopify Admin GraphQL layer (Build Spec
 * §6 collection, §8a Mega Menu, §9 products, §12 final check).
 *
 * Everything the agent does in Shopify goes through here: find the product
 * to duplicate from, duplicate it, overwrite the copy with the department's
 * options/variants/SKUs (productSet), attach mockups, create the department
 * collection with its banner and description, read/insert the Mega Menu
 * item (never into a menu megaMenuGuard says looks wiped), put a wiped menu
 * back from the last good copy, and take the verification snapshots the final
 * check compares.
 *
 * Rules (SKUs, tags, vendor, titles, insertion positions) are NOT decided
 * here — callers pass what onboardingRules.js produced. This module talks to
 * Shopify on the version pinned in shopify.js (2026-01); every field below was
 * confirmed against the live store's schema: productSet names the product to
 * overwrite through `identifier: { id }` (ProductSetInput.id is deprecated),
 * productDuplicate returns `newProduct`, and menus/menuUpdate and
 * publishablePublish are present.
 *
 * Transport is injectable (setGraphql / setTransports) so the unit tests run
 * without a store, a token, or the network. Nothing here logs to the
 * console; long operations accept an `onLog` callback.
 */

const nodeFetch = require("node-fetch");
const shopify = require("./shopify");
const catalog = require("./catalog");
const rules = require("./onboardingRules");
const menuGuard = require("./megaMenuGuard");

const MASTER_REFERENCE_TAG = "Master Reference";
const ONLINE_STORE_PUBLICATION = "Online Store";
const MEGA_MENU_HANDLE = "megamenu";
const STORE_ITEM_TITLE = "Store";
const DEFAULT_STOREFRONT_DOMAIN = "fnsimple.com";

// Shopify caps a connection page at 250 nodes (productTags too).
const PAGE_SIZE = 250;
// productSet runs synchronously up to 100 variants; above that it is an
// operation we poll — the same split shopify.js createProductWithVariants uses.
const SYNC_VARIANT_LIMIT = 100;
const MAX_VARIANTS = shopify.MAX_VARIANTS;
const OPERATION_POLL_MS = 2000;
const OPERATION_TIMEOUT_MS = 180 * 1000;
const STOREFRONT_TIMEOUT_MS = 15 * 1000;
// The storefront is behind the standard Shopify bot screen for empty UAs, so
// the verification read presents itself as a browser.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/* ---------------------------------------------------------------------------
   Transport (injectable for tests)
   ------------------------------------------------------------------------- */

// Staged uploads finish with a multipart POST to Google Cloud Storage. Node
// 22's global fetch/FormData/Blob handle multipart; node-fetch@2 does not.
async function defaultUploadToTarget(target, { filename, buffer, mimeType }) {
  const form = new FormData();
  for (const param of target.parameters || []) form.append(param.name, param.value);
  form.append("file", new Blob([buffer], { type: mimeType }), filename);
  const res = await globalThis.fetch(target.url, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`Staged upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}

const defaults = {
  graphql: shopify.graphql,
  uploadProductImages: shopify.uploadProductImages,
  productExists: catalog.productExists,
  fetch: nodeFetch,
  uploadToTarget: defaultUploadToTarget,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

const transports = { ...defaults };

function setGraphql(fn) {
  transports.graphql = typeof fn === "function" ? fn : defaults.graphql;
  return transports.graphql;
}

// Override any transport (fetch, uploadToTarget, sleep, uploadProductImages,
// productExists); `null`/undefined restores the default for that key.
function setTransports(overrides = {}) {
  for (const key of Object.keys(defaults)) {
    if (!(key in overrides)) continue;
    transports[key] = typeof overrides[key] === "function" ? overrides[key] : defaults[key];
  }
  return { ...transports };
}

function gql(query, variables = {}) {
  return transports.graphql(query, variables);
}

function logger(onLog) {
  return typeof onLog === "function" ? onLog : () => {};
}

// shopify.js keeps its assertNoUserErrors private, so the same shape lives here.
function assertNoUserErrors(operation, userErrors) {
  if (userErrors?.length) {
    throw new Error(`Shopify ${operation}: ${userErrors.map((e) => e.message).join("; ")}`);
  }
}

function isAccessDenied(error) {
  return /ACCESS_DENIED|access denied|access scope|not approved to access/i.test(String(error?.message || error || ""));
}

function normText(value) {
  return String(value == null ? "" : value).trim().replace(/\s+/g, " ").toLowerCase();
}

function productGid(id) {
  return shopify.gid("Product", id);
}

function collectionGid(id) {
  return shopify.gid("Collection", id);
}

/* ---------------------------------------------------------------------------
   §9.1 Source product: the master draft product for the style number, else
   the most recently created product for that blank.
   ------------------------------------------------------------------------- */

const SOURCE_PRODUCTS_QUERY = `
query sourceProducts($query: String!) {
  products(first: 25, query: $query, sortKey: CREATED_AT, reverse: true) {
    nodes {
      id
      legacyResourceId
      title
      createdAt
      tags
      status
      variants(first: 1) { nodes { sku } }
    }
  }
}`;

function isMasterReference(product) {
  return (product?.tags || []).some((tag) => normText(tag) === normText(MASTER_REFERENCE_TAG));
}

function firstSku(product) {
  return product?.variants?.nodes?.[0]?.sku || "";
}

// "NL3600-" as a prefix, so NL3600 never matches NL36001 or NL3600L.
function skuMatchesStyle(sku, style) {
  return String(sku || "").toUpperCase().startsWith(`${style}-`);
}

function titleMentionsStyle(title, style) {
  return String(title || "").toUpperCase().includes(`(${style})`);
}

function pickSourceProduct(candidates) {
  if (!candidates.length) return null;
  const master = candidates.find(isMasterReference);
  const newest = [...candidates].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  const chosen = master || newest;
  return {
    id: chosen.id,
    legacyId: String(chosen.legacyResourceId),
    title: chosen.title,
    kind: master ? "master" : "latest",
    createdAt: chosen.createdAt,
    url: shopify.adminProductUrl(chosen.legacyResourceId),
    tags: chosen.tags || []
  };
}

async function findSourceProduct(styleNumber) {
  const sn = rules.normalizeStyleNumber(styleNumber);
  if (sn.error) throw new Error(sn.error);
  const style = sn.styleNumber;

  const masters = await gql(SOURCE_PRODUCTS_QUERY, { query: `tag:'${MASTER_REFERENCE_TAG}' AND ${style}` }).catch(() => null);
  const masterHits = (masters?.products?.nodes || []).filter((p) => isMasterReference(p) && (titleMentionsStyle(p.title, style) || skuMatchesStyle(firstSku(p), style)));
  const tagged = pickSourceProduct(masterHits);
  if (tagged) return tagged;

  const bySku = await gql(SOURCE_PRODUCTS_QUERY, { query: `sku:${style}*` });
  const skuHits = (bySku?.products?.nodes || []).filter((p) => skuMatchesStyle(firstSku(p), style));
  const fromSku = pickSourceProduct(skuHits);
  if (fromSku && fromSku.kind === "master") return fromSku;

  // Older listings carry the style only in the title, "Next Level … (NL3600)".
  // Parentheses are grouping syntax in Shopify search, so search the bare
  // style and match the "(STYLE)" form locally.
  const byTitle = await gql(SOURCE_PRODUCTS_QUERY, { query: style });
  const titleHits = (byTitle?.products?.nodes || []).filter((p) => titleMentionsStyle(p.title, style));
  /* §9.1 duplicates the MASTER. A master that has no SKUs (one made by the
     agent, or by hand) is only found by its "(STYLE)" title, so it must win
     over a department product the SKU search found first. */
  const fromTitle = pickSourceProduct(titleHits);
  if (fromTitle && fromTitle.kind === "master") return fromTitle;
  return fromSku || fromTitle;
}

/* ---------------------------------------------------------------------------
   How the store already sells a blank. Every department product built on
   NL3600 is called "Standard Short Sleeve <CODE>", sells as "One Week Item"
   and comes in Midnight Navy (MN) — that is the house standard, and a new
   department's row should start from it rather than from "Next Level
   T-shirt". Read from the department products themselves (SKU
   STYLE-SIZE-COLOR-CODE-…), never from FN's own merch.
   ------------------------------------------------------------------------- */
const STORE_PROFILE_QUERY = `
query storeProfile($query: String!) {
  products(first: 60, query: $query) {
    nodes { title vendor tags variants(first: 1) { nodes { sku } } }
  }
}`;

const FN_OWN_VENDOR = /fn simple/i;

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = "";
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return { value: best, count: n };
}

async function storeProfile(styleNumber) {
  const sn = rules.normalizeStyleNumber(styleNumber);
  if (sn.error) return null;
  const style = sn.styleNumber;
  const data = await gql(STORE_PROFILE_QUERY, { query: `sku:${style}-*` });
  const names = [];
  const vendors = [];
  const colorCodes = [];
  for (const p of data?.products?.nodes || []) {
    const sku = String(p?.variants?.nodes?.[0]?.sku || "").trim().toUpperCase();
    const parts = sku.split("-");
    if (parts[0] !== style || p.tags?.includes(MASTER_REFERENCE_TAG) || FN_OWN_VENDOR.test(p.vendor || "")) continue;
    // The department's code is one of the SKU segments; the house name is the
    // title with that code taken out ("Snap Back Hat  BNC" → "Snap Back Hat").
    const segments = new Set(parts.slice(1));
    const name = String(p.title || "")
      .split(/\s+/)
      .filter((word) => word && !(segments.has(word.toUpperCase()) && /^[A-Z]{2,4}$/.test(word)))
      .join(" ")
      .trim();
    names.push(name);
    vendors.push(String(p.vendor || "").trim());
    // STYLE-SIZE-COLOR-CODE-…: tailored items (STYLE-SIZE-CODE) have no colour.
    if (parts.length >= 4) colorCodes.push(parts[2]);
  }
  if (!names.length) return null;
  const counts = new Map();
  for (const c of colorCodes) counts.set(c, (counts.get(c) || 0) + 1);
  return {
    styleNumber: style,
    name: mostCommon(names).value,
    vendor: mostCommon(vendors).value,
    colorCodes: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code),
    sampleSize: names.length
  };
}

/*
 * The garments FN sells, for the console's "pick a garment" list: every
 * Master Reference product (the masters each department product is
 * duplicated from) with its brand, style, a plain garment type and sizes.
 * Masters whose title names no style ("Black Hawk Snapback Hat") are left
 * out — a row needs a style to find its master.
 */
const MASTER_GARMENTS_QUERY = `
query masterGarments($query: String!) {
  products(first: 100, query: $query, sortKey: TITLE) {
    nodes { title vendor productType options { name optionValues { name } } }
  }
}`;

function decodeEntities(s) {
  return String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// The title decides; the product type is only a fallback ("Tees & Tanks"
// names both, so reading it first made every tee a tank top).
function garmentType(title, productType) {
  const read = (t) => {
    // Garment words that contain a headwear or "short" word come first: a
    // "Knit Polo" is a polo, a "Cap Sleeve Tee" is a tee, a "Short Sleeve
    // Tee" is a tee (not shorts), a "Crew Neck T-Shirt" is a tee.
    if (/polo/.test(t)) return "Polo";
    if (/hood/.test(t)) return "Hoodie";
    if (/quarter[\s-]*zip|1\/4[\s-]*zip/.test(t)) return "Quarter Zip";
    if (/job shirt/.test(t)) return "Job Shirt";
    if (/class ?b|uniform shirt|work shirt|button[\s-]*(up|down)|station shirt/.test(t)) return "Class B Shirt";
    if (/sweatshirt|fleece crew|(crew ?neck|crewneck)(?!.*\b(tee|t-shirt)\b)/.test(t) && !/\b(tee|t-shirt)\b/.test(t)) return "Sweatshirt";
    if (/jacket|soft ?shell|parka/.test(t)) return "Jacket";
    if (/\bvest\b/.test(t)) return "Vest";
    if (/beanie|watch cap|knit cap|knit hat|toque/.test(t)) return "Beanie";
    if (/\b(hat|snapback|trucker|flex ?fit|headwear|visor)\b/.test(t) || (/\bcaps?\b/.test(t) && !/cap sleeve/.test(t))) return "Hat";
    if (/tank/.test(t)) return "Tank Top";
    if (/long sleeve/.test(t)) return "Long Sleeve Shirt";
    if (/\bshorts\b/.test(t)) return "Shorts";
    if (/\bpants?\b|trousers?/.test(t)) return "Pants";
    if (/\btee\b|t-shirt|shirt/.test(t)) return "T-shirt";
    return "";
  };
  // A type the agent itself wrote on a master (Job Shirt, Class B Shirt…) is
  // taken as written; otherwise the title decides and the type is a fallback.
  const known = require("./blanks").GARMENT_TYPES || [];
  const typed = decodeEntities(productType).trim();
  const exact = known.find((k) => k.toLowerCase() === typed.toLowerCase() && k !== "Other");
  if (exact) return exact;
  return read(String(title).toLowerCase()) || read(typed.toLowerCase()) || typed || "Garment";
}

let garmentCache = { at: 0, list: null };

async function masterGarments({ maxAgeMs = 10 * 60 * 1000 } = {}) {
  if (garmentCache.list && Date.now() - garmentCache.at < maxAgeMs) return garmentCache.list;
  const data = await gql(MASTER_GARMENTS_QUERY, { query: `tag:'${MASTER_REFERENCE_TAG}'` });
  const out = [];
  for (const p of data?.products?.nodes || []) {
    const title = decodeEntities(p.title).trim();
    const paren = title.match(/\(([A-Z0-9][A-Z0-9.\-]*)\)\s*$/i);
    const token = title.split(/\s+/).find((w) => /^[A-Z]*\d+[A-Z0-9]*$/.test(w) && /[A-Z]/.test(w));
    const styleNumber = (paren?.[1] || token || "").toUpperCase();
    if (!styleNumber) continue;
    const sizes = ((p.options || []).find((o) => /size/i.test(o.name))?.optionValues || []).map((v) => v.name);
    out.push({
      label: title.replace(/\s*\([^)]*\)\s*$/, ""),
      brand: decodeEntities(p.vendor).trim(),
      styleNumber,
      type: garmentType(title, p.productType),
      group: /headwear/i.test(p.productType) ? "Headwear" : decodeEntities(p.productType) || "Other",
      sizes
    });
  }
  garmentCache = { at: Date.now(), list: out };
  return out;
}

/*
 * A master draft for a garment the store has never sold. Every department
 * product is duplicated from a master (§9.1), so a new style used to fail at
 * the build ("No product to duplicate for style …") until someone made one
 * by hand. This makes the same kind of master the store already has: Draft,
 * tagged Master Reference + Needs Review, titled "<Brand> <Name> (<STYLE>)"
 * so the build finds it, one variant per size, price left at 0 for Dan.
 */
async function createMasterDraft({ brand = "", styleNumber = "", name = "", type = "", sizes = [] } = {}, { onLog } = {}) {
  const log = logger(onLog);
  const sn = rules.normalizeStyleNumber(styleNumber);
  if (sn.error) throw new Error(sn.error);
  /* Never a second master for a style the store already has under another
     spelling: the policy's "112" is the store's R112, "3600" is NL3600. */
  const resolved = await resolveStyleNumber(brand, sn.styleNumber).catch(() => sn.styleNumber);
  for (const style of [...new Set([resolved, sn.styleNumber])]) {
    const existing = await findSourceProduct(style);
    if (existing) return { created: false, id: existing.id, legacyId: existing.legacyId || "", title: existing.title, url: existing.url || "", styleNumber: style };
  }

  /* Real sizes only: ranges expanded ("S-3XL"), each one a size the rules
     accept. An empty list used to become XS–3XL even on a hat. */
  const hat = rules.isHeadwearText(`${type} ${name}`);
  const apparel = !hat && rules.isApparelText(`${type} ${name}`);
  const variantsSizes = [];
  const unknown = [];
  for (const raw of rules.expandSizeList((Array.isArray(sizes) ? sizes : []).map((s) => String(s).trim()).filter(Boolean), { hat, apparel })) {
    const n = rules.normalizeSize(raw);
    if (n.error) unknown.push(raw);
    else if (!variantsSizes.includes(n.size)) variantsSizes.push(n.size);
  }
  // A size the rules do not know would be left off the master without a
  // word, and every later row picking this garment would inherit the gap.
  if (unknown.length) throw new Error(`Fix these sizes on the row first — they are not sizes the store uses: ${unknown.join(", ")}.`);
  if (!variantsSizes.length) {
    if (hat) variantsSizes.push("OSFA");
    else throw new Error("Fill in the sizes on the row first (e.g. S-3XL) — the master gets one variant per size.");
  }
  const cleanName = String(name || type || "Garment").trim();
  const cleanBrand = String(brand || "").trim();
  const title = `${cleanBrand && !cleanName.toLowerCase().startsWith(cleanBrand.toLowerCase()) ? `${cleanBrand} ` : ""}${cleanName} (${sn.styleNumber})`;
  const result = await shopify.createProductWithVariants({
    title,
    bodyHtml: `<p>${cleanBrand} ${cleanName} (${sn.styleNumber}). Master draft created by the Onboarding Agent — review the description, cost and images.</p>`,
    price: "0.00",
    productType: String(type || "").trim(),
    vendor: cleanBrand,
    tags: [MASTER_REFERENCE_TAG, "Needs Review", "Agent Created"],
    sizes: variantsSizes,
    status: "DRAFT"
  });
  garmentCache = { at: 0, list: null };
  log(`Created the master draft "${title}".`);
  return { created: true, id: result.productGid, legacyId: result.productId, title, url: shopify.adminProductUrl ? shopify.adminProductUrl(result.productId) : "", styleNumber: sn.styleNumber, sizes: variantsSizes };
}

/*
 * The style number as the store writes it. Policies say "Richardson 112";
 * the store's blank is R112, and its master is titled "Richardson 112
 * Snapback (R112)". Unchanged when the style is already found as typed.
 */
async function resolveStyleNumber(brand, styleNumber) {
  const sn = rules.normalizeStyleNumber(styleNumber);
  if (sn.error) return styleNumber;
  /* The policy review can hand back words with the number ("112 snapback"),
     which squashes to 112SNAPBACK and matches nothing. Try the whole thing,
     then each word that carries a digit. */
  const candidates = [sn.styleNumber];
  for (const word of String(styleNumber || "").split(/\s+/)) {
    const w = rules.normalizeStyleNumber(word);
    if (!w.error && /\d/.test(w.styleNumber) && !candidates.includes(w.styleNumber)) candidates.push(w.styleNumber);
  }
  for (const style of candidates) {
    if (await findSourceProduct(style).catch(() => null)) return style;
  }
  const b = String(brand || "").trim();
  if (!b) return candidates[candidates.length - 1];
  for (const style of candidates) {
    const data = await gql(SOURCE_PRODUCTS_QUERY, { query: `tag:'${MASTER_REFERENCE_TAG}' AND title:*${style}*` });
    const want = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^()]*\\b${style}\\b`, "i");
    for (const p of data?.products?.nodes || []) {
      const title = String(p?.title || "");
      const m = title.match(/\(([A-Z0-9][A-Z0-9.\-]*)\)\s*$/i);
      if (m && want.test(title)) return m[1].toUpperCase();
    }
  }
  /* A style written as bare digits ("3600") whose master carries the brand's
     letter prefix ("NL3600"), same brand. Only for digit-led styles: a
     lettered style is never re-lettered, so a ladies' LST350 never becomes
     the men's ST350, nor L500 → K500. */
  for (const style of candidates) {
    if (!/^\d/.test(style)) continue;
    const twin = (await masterGarments().catch(() => [])).find((g) => sameBrand(g.brand, b) && g.styleNumber.replace(/^[A-Z]+/, "") === style);
    if (twin) return twin.styleNumber;
  }
  return candidates[candidates.length - 1];
}

// "Next Level" / "Next Level Apparel", "Port & Company" / "Port and Co": the
// first word decides.
function sameBrand(a, b) {
  const first = (s) => String(s || "").toLowerCase().replace(/&/g, "and").trim().split(/\s+/)[0] || "";
  return Boolean(first(a)) && first(a) === first(b);
}

/* ---------------------------------------------------------------------------
   Read the product being duplicated: description parts, option names, and
   the per-variant defaults (tax, shipping, tracking, weight) the copy keeps.
   ------------------------------------------------------------------------- */

const PRODUCT_FOR_DUPLICATION_QUERY = `
query productForDuplication($id: ID!) {
  product(id: $id) {
    id
    legacyResourceId
    title
    descriptionHtml
    productType
    vendor
    tags
    options { name position optionValues { name } }
    mediaCount { count }
    variants(first: 1) {
      nodes {
        taxable
        inventoryItem {
          tracked
          requiresShipping
          measurement { weight { value unit } }
        }
      }
    }
  }
}`;

async function readProductForDuplication(id) {
  const data = await gql(PRODUCT_FOR_DUPLICATION_QUERY, { id: productGid(id) });
  const product = data?.product;
  if (!product) throw new Error(`Product ${id} was not found in Shopify.`);
  const sample = product.variants?.nodes?.[0] || {};
  const item = sample.inventoryItem || {};
  const weight = item.measurement?.weight;
  return {
    id: product.id,
    legacyId: String(product.legacyResourceId),
    title: product.title,
    descriptionHtml: product.descriptionHtml || "",
    productType: product.productType || "",
    vendor: product.vendor || "",
    tags: product.tags || [],
    options: (product.options || []).map((o) => ({ name: o.name, values: (o.optionValues || []).map((v) => v.name) })),
    variantDefaults: {
      taxable: sample.taxable !== false,
      requiresShipping: item.requiresShipping !== false,
      tracked: Boolean(item.tracked),
      weight: weight && weight.value != null ? { value: weight.value, unit: weight.unit } : null
    },
    descriptionParts: rules.extractDescriptionParts(product.descriptionHtml || ""),
    mediaCount: product.mediaCount?.count ?? 0
  };
}

/* ---------------------------------------------------------------------------
   §9.1 Duplicate — DRAFT, no images (the department's mockups replace them),
   synchronous so the new product id is in hand for productSet.
   ------------------------------------------------------------------------- */

const PRODUCT_DUPLICATE_MUTATION = `
mutation productDuplicate($productId: ID!, $newTitle: String!) {
  productDuplicate(productId: $productId, newTitle: $newTitle, newStatus: DRAFT, includeImages: false, synchronous: true) {
    newProduct { id legacyResourceId title }
    userErrors { field message }
  }
}`;

async function duplicateProduct(sourceId, newTitle) {
  const title = String(newTitle || "").trim();
  if (!title) throw new Error("duplicateProduct needs a title for the new product.");
  const data = await gql(PRODUCT_DUPLICATE_MUTATION, { productId: productGid(sourceId), newTitle: title });
  assertNoUserErrors("productDuplicate", data?.productDuplicate?.userErrors);
  const product = data?.productDuplicate?.newProduct;
  if (!product?.id) throw new Error(`Shopify productDuplicate did not return a new product for "${title}".`);
  return { id: product.id, legacyId: String(product.legacyResourceId), title: product.title };
}

/* ---------------------------------------------------------------------------
   §9.2–§9.9 productSet: overwrite the duplicated product with the
   department's title, description, vendor, tags, collection, options and
   variants (SKU per variant, price cleared, continue selling). Everything
   not in the input — the source department's variants, tags, images — is
   replaced, which is exactly the "remove carried-over" rule.
   ------------------------------------------------------------------------- */

// The product being overwritten is named through `identifier`, not through an
// `id` inside the input: ProductSetInput.id is deprecated ("Use `identifier`
// instead to get the product's ID") and will eventually be removed.
const PRODUCT_SET_MUTATION = `
mutation productSet($identifier: ProductSetIdentifiers, $input: ProductSetInput!, $synchronous: Boolean!) {
  productSet(identifier: $identifier, input: $input, synchronous: $synchronous) {
    product { id legacyResourceId title }
    productSetOperation { id status }
    userErrors { code field message }
  }
}`;

const PRODUCT_OPERATION_QUERY = `
query productOperation($id: ID!) {
  productOperation(id: $id) {
    ... on ProductSetOperation {
      id
      status
      product { id legacyResourceId title }
      userErrors { code field message }
    }
  }
}`;

const PRODUCT_VARIANTS_QUERY = `
query productVariants($id: ID!, $after: String) {
  product(id: $id) {
    id
    legacyResourceId
    title
    variants(first: ${PAGE_SIZE}, after: $after) {
      nodes { id sku title selectedOptions { name value } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const PRODUCT_COLLECTIONS_QUERY = `
query productCollections($id: ID!) {
  product(id: $id) {
    collections(first: 50) { nodes { id legacyResourceId title } }
  }
}`;

const COLLECTION_ADD_PRODUCTS_MUTATION = `
mutation collectionAddProducts($id: ID!, $productIds: [ID!]!) {
  collectionAddProducts(id: $id, productIds: $productIds) {
    collection { id }
    userErrors { field message }
  }
}`;

const COLLECTION_REMOVE_PRODUCTS_MUTATION = `
mutation collectionRemoveProducts($id: ID!, $productIds: [ID!]!) {
  collectionRemoveProducts(id: $id, productIds: $productIds) {
    job { id }
    userErrors { field message }
  }
}`;

/*
 * Pure: the ProductSetInput for one department product. Exported so tests can
 * pin the invariants without a store: status DRAFT, price "0.00", CONTINUE
 * selling, positions 1..n, and never a cost.
 */
function buildProductSetInput(input) {
  const productOptions = (input.options || []).map((option, index) => ({
    name: option.name,
    position: index + 1,
    values: (option.values || []).map((name) => ({ name }))
  }));
  const variants = (input.variants || []).map((variant) => ({
    optionValues: (variant.optionValues || []).map((ov) => ({ optionName: ov.optionName, name: ov.name })),
    sku: String(variant.sku || ""),
    // §9.9 price and cost are cleared; Dan sets them. Cost is never sent.
    price: "0.00",
    // §9.8 "Continue selling when out of stock" on every variant.
    inventoryPolicy: "CONTINUE",
    taxable: variant.taxable !== false,
    inventoryItem: {
      tracked: Boolean(variant.tracked),
      requiresShipping: variant.requiresShipping !== false
    }
  }));
  const out = {
    title: input.title,
    descriptionHtml: input.descriptionHtml || "",
    vendor: input.vendor || "",
    tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter(Boolean) : [],
    productType: input.productType || "",
    // §9.2 everything stays Draft until Dan prices it — whatever the caller says.
    status: "DRAFT",
    productOptions,
    variants
  };
  const collections = (input.collectionGids || []).map(collectionGid);
  if (collections.length) out.collections = collections;
  return out;
}

async function fetchAllVariants(id) {
  const variants = [];
  let after = null;
  let product = null;
  do {
    const data = await gql(PRODUCT_VARIANTS_QUERY, { id, after });
    product = data?.product;
    if (!product) throw new Error(`Shopify product ${id} not found after productSet.`);
    variants.push(...(product.variants?.nodes || []));
    after = product.variants?.pageInfo?.hasNextPage ? product.variants.pageInfo.endCursor : null;
  } while (after);
  return { product, variants };
}

async function waitForProductOperation(operationId, label) {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  for (;;) {
    const poll = await gql(PRODUCT_OPERATION_QUERY, { id: operationId });
    const operation = poll?.productOperation;
    assertNoUserErrors("productSet operation", operation?.userErrors);
    if (operation?.status === "COMPLETE") return operation.product?.id || null;
    if (Date.now() > deadline) throw new Error(`Shopify productSet for "${label}" timed out after ${OPERATION_TIMEOUT_MS / 1000}s.`);
    await transports.sleep(OPERATION_POLL_MS);
  }
}

// §9.3 "Remove any collection carried over from the duplicated product":
// productSet's `collections` adds membership but is not documented to remove
// it, so the copy's memberships are read back and anything outside the
// department's collection is detached. Smart collections cannot be edited
// this way; those become warnings for the report rather than failures.
async function removeForeignCollections(id, keepGids, log) {
  const keep = new Set(keepGids.map(collectionGid));
  const data = await gql(PRODUCT_COLLECTIONS_QUERY, { id });
  const memberships = data?.product?.collections?.nodes || [];
  const removed = [];
  const warnings = [];
  for (const collection of memberships) {
    if (keep.has(collection.id)) continue;
    try {
      const res = await gql(COLLECTION_REMOVE_PRODUCTS_MUTATION, { id: collection.id, productIds: [id] });
      assertNoUserErrors("collectionRemoveProducts", res?.collectionRemoveProducts?.userErrors);
      removed.push({ id: String(collection.legacyResourceId), gid: collection.id, title: collection.title });
      log(`Removed carried-over collection "${collection.title}"`);
    } catch (error) {
      warnings.push(`Could not remove carried-over collection "${collection.title}": ${error.message}`);
    }
  }
  return { removed, warnings };
}

async function setProduct(input, { onLog } = {}) {
  const log = logger(onLog);
  if (!input?.productId) throw new Error("setProduct needs productId — the duplicated product to overwrite.");
  const id = productGid(input.productId);
  // §9.1 "Never edit the product you duplicated from."
  if (input.sourceProductId && productGid(input.sourceProductId) === id) {
    throw new Error("Refusing to overwrite the source product: setProduct must target the duplicate, never the product it was duplicated from.");
  }
  const title = String(input.title || "").trim();
  if (!title) throw new Error("setProduct needs a title.");
  const variantCount = Array.isArray(input.variants) ? input.variants.length : 0;
  if (!variantCount) throw new Error(`${title}: at least one variant is required.`);
  if (variantCount > MAX_VARIANTS) {
    throw new Error(`${title}: ${variantCount} variants exceed Shopify's ${MAX_VARIANTS}-variant limit. Split the product (e.g. one product per Style) or reduce sizes/colors.`);
  }
  if (!(await transports.productExists(id))) {
    throw new Error(`Product ${id} does not exist in Shopify, so there is nothing to overwrite. Duplicate the source product first.`);
  }

  const productSetInput = buildProductSetInput({ ...input, title });
  const collectionGids = productSetInput.collections || [];
  const synchronous = variantCount <= SYNC_VARIANT_LIMIT;
  log(`productSet ${title}: ${variantCount} variants (${synchronous ? "synchronous" : "async operation"})`);

  let data;
  let collectionsFallback = false;
  try {
    data = await gql(PRODUCT_SET_MUTATION, { identifier: { id }, input: productSetInput, synchronous });
  } catch (error) {
    /* The pinned version accepts `collections` on ProductSetInput. Should the
       store ever run one that rejects it, the membership is added separately.
       The match has to be narrow: matching any error mentioning "collections"
       also caught throttle errors whose text happens to name the field, and
       retrying one of those writes the product TWICE. Only a schema rejection
       of the field itself is a reason to drop it. */
    const schemaRejectsCollections =
      /(field|argument|parameter).{0,40}['"`]?collections['"`]?.{0,40}(does ?n[o']t exist|is not defined|unknown|unsupported|invalid)/i.test(String(error.message)) ||
      /(does ?n[o']t exist|is not defined|unknown|unsupported|invalid).{0,40}['"`]?collections['"`]?/i.test(String(error.message));
    if (!collectionGids.length || !schemaRejectsCollections) throw error;
    const { collections, ...withoutCollections } = productSetInput;
    data = await gql(PRODUCT_SET_MUTATION, { identifier: { id }, input: withoutCollections, synchronous });
    collectionsFallback = true;
  }
  const userErrors = data?.productSet?.userErrors || [];
  if (userErrors.length && collectionGids.length && userErrors.every((e) => (e.field || []).join(".").includes("collections"))) {
    const { collections, ...withoutCollections } = productSetInput;
    data = await gql(PRODUCT_SET_MUTATION, { identifier: { id }, input: withoutCollections, synchronous });
    collectionsFallback = true;
  }
  assertNoUserErrors("productSet", data?.productSet?.userErrors);

  let resultGid = data?.productSet?.product?.id || null;
  if (!synchronous) {
    const operationId = data?.productSet?.productSetOperation?.id;
    if (!operationId) throw new Error("Shopify productSet did not return an operation id.");
    resultGid = await waitForProductOperation(operationId, title);
  }
  if (!resultGid) throw new Error(`Shopify did not return a product for "${title}".`);

  if (collectionsFallback) {
    for (const cid of collectionGids) {
      const res = await gql(COLLECTION_ADD_PRODUCTS_MUTATION, { id: cid, productIds: [resultGid] });
      assertNoUserErrors("collectionAddProducts", res?.collectionAddProducts?.userErrors);
    }
  }

  const { product, variants } = await fetchAllVariants(resultGid);
  const foreign = collectionGids.length ? await removeForeignCollections(resultGid, collectionGids, log) : { removed: [], warnings: [] };
  log(`productSet ${title}: ${variants.length} variants written`);
  return {
    id: resultGid,
    legacyId: String(product.legacyResourceId),
    url: shopify.adminProductUrl(product.legacyResourceId),
    title: product.title,
    variants: variants.map((v) => ({ id: v.id, sku: v.sku || "", title: v.title, selectedOptions: v.selectedOptions || [] })),
    removedCollections: foreign.removed,
    warnings: foreign.warnings,
    collectionsFallback
  };
}

/* ---------------------------------------------------------------------------
   §9.10 Images — the front mockup listed first for a variant becomes its
   variant image; back mockups stay in the gallery. shopify.uploadProductImages
   already implements exactly that (one media per variant, first wins).
   ------------------------------------------------------------------------- */

async function attachMockups(id, images = [], { onLog } = {}) {
  const log = logger(onLog);
  const list = (images || []).filter((img) => img && img.buffer && img.filename);
  if (!list.length) return [];
  log(`Uploading ${list.length} mockup image(s)`);
  return transports.uploadProductImages(productGid(id), list.map((img) => ({
    filename: img.filename,
    buffer: img.buffer,
    alt: img.alt || "",
    variantIds: img.variantIds || []
  })));
}

/*
 * Swap a built product's images for new mockups. The old media are deleted
 * first: a variant carries exactly one attached image and Shopify refuses a
 * second ("already has attached media"), and deleting a media file detaches
 * it from its variants. Only media on THIS product are touched.
 */
const FILE_DELETE_MUTATION = `
mutation fileDelete($fileIds: [ID!]!) {
  fileDelete(fileIds: $fileIds) {
    deletedFileIds
    userErrors { field message }
  }
}`;

/*
 * Bind images that are ALREADY on the product to variants showing none.
 * Nothing is uploaded or deleted. This is the repair for a build cut off
 * between the upload and the bind: the pictures are in the gallery, the
 * variants are bare, and §9.10 fails until each one is attached.
 */
const VARIANT_APPEND_MEDIA_MUTATION = `
mutation productVariantAppendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
  productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
    product { id }
    userErrors { code field message }
  }
}`;

async function linkVariantImages(id, links = [], { onLog } = {}) {
  const log = logger(onLog);
  const list = (links || []).filter((link) => link && link.variantId && link.mediaId);
  if (!list.length) return 0;
  const data = await gql(VARIANT_APPEND_MEDIA_MUTATION, {
    productId: productGid(id),
    variantMedia: list.map((link) => ({ variantId: link.variantId, mediaIds: [link.mediaId] }))
  });
  assertNoUserErrors("productVariantAppendMedia", data?.productVariantAppendMedia?.userErrors);
  log(`Bound ${list.length} existing image(s) to variant(s) that showed none.`);
  return list.length;
}

async function replaceProductImages(id, images = [], { onLog } = {}) {
  const log = logger(onLog);
  const snapshot = await productSnapshot(id);
  if (!snapshot) throw new Error(`Product ${id} was not found in Shopify.`);
  const oldIds = (snapshot.media || []).map((m) => m.id).filter(Boolean);
  if (oldIds.length) {
    const data = await gql(FILE_DELETE_MUTATION, { fileIds: oldIds });
    assertNoUserErrors("fileDelete", data?.fileDelete?.userErrors);
    log(`Removed ${oldIds.length} old image(s) from "${snapshot.title}".`);
  }
  await attachMockups(snapshot.gid, images, { onLog });
  return { removed: oldIds.length, added: (images || []).length, variants: snapshot.variants, title: snapshot.title };
}

/* ---------------------------------------------------------------------------
   §6 Collection: exact title, Non-Stock notice description, 3584×2048
   banner, published to the Online Store.
   ------------------------------------------------------------------------- */

const COLLECTION_FIELDS = `
  id
  legacyResourceId
  title
  handle
  descriptionHtml
  image { url altText width height }`;

const FIND_COLLECTIONS_QUERY = `
query findCollections($query: String!) {
  collections(first: 10, query: $query) {
    nodes { ${COLLECTION_FIELDS} }
  }
}`;

const COLLECTION_CREATE_MUTATION = `
mutation collectionCreate($input: CollectionInput!) {
  collectionCreate(input: $input) {
    collection { ${COLLECTION_FIELDS} }
    userErrors { field message }
  }
}`;

const COLLECTION_UPDATE_MUTATION = `
mutation collectionUpdate($input: CollectionInput!) {
  collectionUpdate(input: $input) {
    collection { ${COLLECTION_FIELDS} }
    userErrors { field message }
  }
}`;

const STAGED_UPLOADS_MUTATION = `
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

const PUBLICATIONS_QUERY = `
query publications {
  publications(first: 20) { nodes { id name } }
}`;

const PUBLISHABLE_PUBLISH_MUTATION = `
mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    userErrors { field message }
  }
}`;

function searchPhrase(field, value) {
  return `${field}:"${String(value).replace(/["\\]/g, "\\$&")}"`;
}

// Exact, case-sensitive title match. Shopify's search is a loose token match,
// so the phrase query narrows and `===` decides; "1. Bishop Fire Department"
// must never resolve to "2. Bishop Fire Department".
async function findCollectionByExactTitle(title) {
  const want = String(title || "").trim();
  if (!want) return null;
  const exact = (nodes) => (nodes || []).find((c) => c.title === want) || null;
  const phrase = await gql(FIND_COLLECTIONS_QUERY, { query: searchPhrase("title", want) });
  const hit = exact(phrase?.collections?.nodes);
  if (hit) return hit;
  // Punctuation in the "N. Name" prefix can defeat the phrase search; retry on
  // the bare name and let the exact comparison decide.
  const bare = want.replace(/^\d+\.\s*/, "");
  if (bare === want) return null;
  const loose = await gql(FIND_COLLECTIONS_QUERY, { query: searchPhrase("title", bare) });
  return exact(loose?.collections?.nodes);
}

async function stageCollectionImage(filename, buffer) {
  const data = await gql(STAGED_UPLOADS_MUTATION, {
    input: [{ filename, mimeType: "image/png", httpMethod: "POST", resource: "COLLECTION_IMAGE" }]
  });
  assertNoUserErrors("stagedUploadsCreate", data?.stagedUploadsCreate?.userErrors);
  const target = data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error("Shopify did not return a staged upload target for the collection banner.");
  await transports.uploadToTarget(target, { filename, buffer, mimeType: "image/png" });
  return stagedFileUrl(target);
}

/*
 * Where the uploaded file actually is. For COLLECTION_IMAGE Shopify returns a
 * resourceUrl that is only the bucket ("https://shopify-staged-uploads…com/")
 * with no file path, and collectionUpdate rejects it with "Error updating
 * collection with this image" — no onboarding ever got its banner. The file
 * lives at the bucket URL plus the `key` form parameter.
 */
function stagedFileUrl(target) {
  const resource = String(target?.resourceUrl || "");
  let hasPath = false;
  try {
    hasPath = new URL(resource).pathname.replace(/\/+$/, "") !== "";
  } catch {
    hasPath = false;
  }
  if (hasPath) return resource;
  const key = (target?.parameters || []).find((p) => p?.name === "key")?.value;
  if (!key) return resource;
  return `${String(target.url || resource).replace(/\/+$/, "")}/${String(key).replace(/^\/+/, "")}`;
}

async function publishToOnlineStore(gid) {
  try {
    const pubs = await gql(PUBLICATIONS_QUERY);
    const online = (pubs?.publications?.nodes || []).find((p) => normText(p.name) === normText(ONLINE_STORE_PUBLICATION));
    if (!online) return { published: false, reason: `No "${ONLINE_STORE_PUBLICATION}" publication is visible to the app token.` };
    const data = await gql(PUBLISHABLE_PUBLISH_MUTATION, { id: gid, input: [{ publicationId: online.id }] });
    const errors = data?.publishablePublish?.userErrors || [];
    const alreadyPublished = errors.length > 0 && errors.every((e) => /already published/i.test(e.message));
    if (errors.length && !alreadyPublished) return { published: false, reason: errors.map((e) => e.message).join("; ") };
    return { published: true, publicationId: online.id, alreadyPublished };
  } catch (error) {
    return { published: false, reason: error.message };
  }
}

function sameHtml(a, b) {
  const squash = (s) => String(s || "").replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
  return squash(a) === squash(b);
}

function collectionResult(node, extras) {
  return {
    id: String(node.legacyResourceId),
    gid: node.id,
    title: node.title,
    handle: node.handle,
    url: shopify.adminCollectionUrl(node.legacyResourceId),
    storefrontPath: `/collections/${node.handle}`,
    descriptionHtml: node.descriptionHtml || "",
    image: node.image ? { url: node.image.url, alt: node.image.altText || "", width: node.image.width ?? null, height: node.image.height ?? null } : null,
    ...extras
  };
}

const COLLECTION_PRODUCT_TAGS_QUERY = `
query collectionProductTags($id: ID!) {
  collection(id: $id) {
    products(first: 50) { nodes { tags } }
  }
}`;

/*
 * Fire department names repeat across states, and the collection is found by
 * title. A same-titled collection whose products all carry ANOTHER
 * department's code tag belongs to a namesake; filling it would mix two
 * departments' products behind one lock. An empty collection, or one with any
 * product tagged with this code, is this department's.
 */
async function assertCollectionBelongsTo(node, departmentCode) {
  const code = String(departmentCode || "").trim().toUpperCase();
  if (!code || !node?.id) return;
  const data = await gql(COLLECTION_PRODUCT_TAGS_QUERY, { id: node.id });
  const tagLists = (data?.collection?.products?.nodes || []).map((p) => (p.tags || []).map((t) => String(t).toUpperCase()));
  if (!tagLists.length) return;
  if (tagLists.some((tags) => tags.includes(code))) return;
  const others = [...new Set(tagLists.flat().filter((t) => /^[A-Z]{3,4}$/.test(t)))].slice(0, 5);
  throw new Error(
    `A collection named "${node.title}" already exists and its products belong to another department${others.length ? ` (tagged ${others.join(", ")})` : ""}, not ${code}. ` +
      "Two departments with the same name need different names in the store — rename this onboarding (for example add the state) before building."
  );
}

async function ensureDepartmentCollection({ title, descriptionHtml, bannerBuffer, bannerAlt, departmentCode = "", knownCollectionGid = "" } = {}, { onLog } = {}) {
  const log = logger(onLog);
  const wantTitle = String(title || "").trim();
  if (!wantTitle) throw new Error("ensureDepartmentCollection needs a title.");
  /* An empty description is never what the caller meant: §6.4 requires the
     Non-Stock Item Notice on every department collection, and writing "" to an
     existing collection would wipe the notice Dan already has. Blank of any
     kind falls back to the notice. */
  const wantDescription = String(descriptionHtml ?? "").trim() ? String(descriptionHtml) : rules.collectionDescriptionHtml();
  const warnings = [];

  let node = await findCollectionByExactTitle(wantTitle);
  // A collection this onboarding already made is its own; anything else found
  // by title is checked before a single product is added to it.
  if (node && node.id !== knownCollectionGid) await assertCollectionBelongsTo(node, departmentCode);
  const created = !node;
  let descriptionUpdated = false;
  if (created) {
    const data = await gql(COLLECTION_CREATE_MUTATION, { input: { title: wantTitle, descriptionHtml: wantDescription } });
    assertNoUserErrors("collectionCreate", data?.collectionCreate?.userErrors);
    node = data?.collectionCreate?.collection;
    if (!node?.id) throw new Error(`Shopify collectionCreate did not return a collection for "${wantTitle}".`);
    log(`Created collection "${wantTitle}"`);
  } else {
    log(`Found existing collection "${wantTitle}" (${node.id})`);
    if (!sameHtml(node.descriptionHtml, wantDescription)) {
      const data = await gql(COLLECTION_UPDATE_MUTATION, { input: { id: node.id, descriptionHtml: wantDescription } });
      assertNoUserErrors("collectionUpdate", data?.collectionUpdate?.userErrors);
      node = data?.collectionUpdate?.collection || { ...node, descriptionHtml: wantDescription };
      descriptionUpdated = true;
      log("Updated collection description to the Non-Stock Item Notice");
    }
  }

  // Banner: only on a brand-new collection or one with no image at all. An
  // existing image may be one Dan set by hand, and that is never replaced.
  const banner = { set: false, reason: "", error: "" };
  if (!bannerBuffer) {
    banner.reason = "no banner supplied";
  } else if (!created && node.image?.url) {
    banner.reason = "existing collection already has an image; kept as-is (Dan may have set it)";
  } else {
    try {
      const filename = `${node.handle || "collection"}-banner.png`;
      const resourceUrl = await stageCollectionImage(filename, bannerBuffer);
      const data = await gql(COLLECTION_UPDATE_MUTATION, {
        input: { id: node.id, image: { src: resourceUrl, altText: bannerAlt || `${wantTitle} banner` } }
      });
      assertNoUserErrors("collectionUpdate (image)", data?.collectionUpdate?.userErrors);
      node = data?.collectionUpdate?.collection || node;
      banner.set = true;
      banner.reason = created ? "set on the new collection" : "collection had no image";
      log("Collection banner set");
    } catch (error) {
      banner.error = error.message;
      banner.reason = "banner upload failed";
      warnings.push(`Collection banner was not set: ${error.message}`);
    }
  }

  const publish = await publishToOnlineStore(node.id);
  if (!publish.published) warnings.push(`Collection is not confirmed published to the Online Store: ${publish.reason}`);

  return collectionResult(node, {
    created,
    published: publish.published,
    publishReason: publish.reason || (publish.alreadyPublished ? "already published" : ""),
    descriptionUpdated,
    banner,
    warnings
  });
}

/* ---------------------------------------------------------------------------
   §12 verification snapshots
   ------------------------------------------------------------------------- */

const COLLECTION_SNAPSHOT_QUERY = `
query collectionSnapshot($id: ID!, $after: String) {
  collection(id: $id) {
    ${COLLECTION_FIELDS}
    productsCount { count }
    products(first: ${PAGE_SIZE}, after: $after) {
      nodes { id legacyResourceId title status tags vendor variantsCount { count } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

async function collectionSnapshot(idOrGid) {
  const id = collectionGid(idOrGid);
  const products = [];
  let collection = null;
  let after = null;
  do {
    const data = await gql(COLLECTION_SNAPSHOT_QUERY, { id, after });
    collection = data?.collection;
    if (!collection) return null;
    products.push(...(collection.products?.nodes || []));
    after = collection.products?.pageInfo?.hasNextPage ? collection.products.pageInfo.endCursor : null;
  } while (after);
  return {
    id: String(collection.legacyResourceId),
    gid: collection.id,
    title: collection.title,
    handle: collection.handle,
    descriptionHtml: collection.descriptionHtml || "",
    image: collection.image ? { url: collection.image.url, width: collection.image.width ?? null, height: collection.image.height ?? null } : null,
    productsCount: collection.productsCount?.count ?? products.length,
    products: products.map((p) => ({
      id: String(p.legacyResourceId),
      gid: p.id,
      title: p.title,
      status: p.status,
      tags: p.tags || [],
      vendor: p.vendor || "",
      variantCount: p.variantsCount?.count ?? 0
    }))
  };
}

const PRODUCT_SNAPSHOT_QUERY = `
query productSnapshot($id: ID!, $after: String) {
  product(id: $id) {
    id
    legacyResourceId
    title
    status
    vendor
    tags
    productType
    options { name optionValues { name } }
    media(first: ${PAGE_SIZE}) { nodes { ... on MediaImage { id alt image { url } } } }
    collections(first: 50) { nodes { id legacyResourceId title } }
    variants(first: ${PAGE_SIZE}, after: $after) {
      nodes { id sku price inventoryPolicy selectedOptions { name value } image { url } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

async function productSnapshot(idOrGid) {
  const id = productGid(idOrGid);
  const variants = [];
  let product = null;
  let after = null;
  do {
    const data = await gql(PRODUCT_SNAPSHOT_QUERY, { id, after });
    product = data?.product;
    if (!product) return null;
    variants.push(...(product.variants?.nodes || []));
    after = product.variants?.pageInfo?.hasNextPage ? product.variants.pageInfo.endCursor : null;
  } while (after);
  return {
    id: String(product.legacyResourceId),
    gid: product.id,
    title: product.title,
    status: product.status,
    vendor: product.vendor || "",
    tags: product.tags || [],
    productType: product.productType || "",
    options: (product.options || []).map((o) => ({ name: o.name, values: (o.optionValues || []).map((v) => v.name) })),
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku || "",
      price: v.price,
      inventoryPolicy: v.inventoryPolicy,
      selectedOptions: v.selectedOptions || [],
      image: v.image?.url ? { url: v.image.url } : null
    })),
    // alt is how a re-run finds a mockup that uploaded but was never bound.
    media: (product.media?.nodes || []).filter((m) => m && m.id).map((m) => ({ id: m.id, url: m.image?.url || null, alt: m.alt || "" })),
    collections: (product.collections?.nodes || []).map((c) => ({ id: String(c.legacyResourceId), gid: c.id, title: c.title }))
  };
}

// Every product tag in the store — the department codes already in use are
// read off this list (§2.3) so a proposed code never collides.
const PRODUCT_TAGS_QUERY = `
query productTags($after: String) {
  productTags(first: ${PAGE_SIZE}, after: $after) {
    edges { node }
    pageInfo { hasNextPage endCursor }
  }
}`;

async function allProductTags() {
  const tags = [];
  let after = null;
  do {
    const data = await gql(PRODUCT_TAGS_QUERY, { after });
    const connection = data?.productTags;
    if (!connection) break;
    tags.push(...(connection.edges || []).map((e) => e.node).filter((t) => t != null));
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return tags;
}

/* ---------------------------------------------------------------------------
   §8a Mega Menu — read, propose (pure), build the update tree (pure), apply
   after approval, verify. Needs read/write_online_store_navigation; without
   it the read reports { available:false } and the agent hands Dan a checklist.
   ------------------------------------------------------------------------- */

const MENU_ITEM_FIELDS = "id title type url resourceId tags";

const MENUS_QUERY = `
query megaMenu {
  menus(first: 50) {
    nodes {
      id
      title
      handle
      items {
        ${MENU_ITEM_FIELDS}
        items {
          ${MENU_ITEM_FIELDS}
          items { ${MENU_ITEM_FIELDS} }
        }
      }
    }
  }
}`;

const MENU_UPDATE_MUTATION = `
mutation menuUpdate($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
  menuUpdate(id: $id, title: $title, items: $items) {
    menu {
      id
      title
      handle
      items {
        ${MENU_ITEM_FIELDS}
        items {
          ${MENU_ITEM_FIELDS}
          items { ${MENU_ITEM_FIELDS} }
        }
      }
    }
    userErrors { field message }
  }
}`;

function normalizeMenuItem(item) {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    url: item.url || null,
    resourceId: item.resourceId || null,
    tags: Array.isArray(item.tags) ? item.tags : [],
    items: (item.items || []).map(normalizeMenuItem)
  };
}

function normalizeMenu(menu) {
  return { id: menu.id, title: menu.title, handle: menu.handle, items: (menu.items || []).map(normalizeMenuItem) };
}

function pickMegaMenu(menus) {
  return (
    menus.find((m) => normText(m.handle) === MEGA_MENU_HANDLE) ||
    menus.find((m) => /mega/i.test(String(m.title || ""))) ||
    menus.find((m) => /mega/i.test(String(m.handle || ""))) ||
    null
  );
}

async function readMegaMenu() {
  let menus;
  try {
    const data = await gql(MENUS_QUERY);
    menus = data?.menus?.nodes || [];
  } catch (error) {
    return { available: false, accessDenied: isAccessDenied(error), reason: error.message };
  }
  const menu = pickMegaMenu(menus);
  if (!menu) {
    return {
      available: false,
      accessDenied: false,
      reason: `No menu with handle "${MEGA_MENU_HANDLE}" or a title containing "Mega" among ${menus.length} menu(s): ${menus.map((m) => m.handle).join(", ") || "none"}.`
    };
  }
  return { available: true, menu: normalizeMenu(menu) };
}

// The "Store" item is the top-level entry the department stores hang under:
// by title first (the store's menu names it "Store"), else the COLLECTIONS-type
// entry. The rule lives in megaMenuGuard so the insert and the guard that
// decides whether the menu is fit to write to can never disagree about it.
const { findStoreItem } = menuGuard;

function menuTitleMatches(item, title, gid) {
  return normText(item.title) === normText(title) || (Boolean(gid) && item.resourceId === gid);
}

function proposeMegaMenuInsert(menu, { title, collectionHandle, collectionGid: gid } = {}) {
  const wantTitle = String(title || "").trim();
  const handle = String(collectionHandle || "").trim();
  const newItem = { title: wantTitle, type: "COLLECTION", url: `/collections/${handle}`, resourceId: gid || null };
  const base = { newItem, title: wantTitle, collectionHandle: handle, collectionGid: gid || null };
  const store = findStoreItem(menu);
  if (!store) {
    return { ...base, storeItemId: null, storeItemTitle: null, index: -1, insertAfter: null, insertBefore: null, alreadyPresent: false, existingItemId: null, itemsPreview: [], reason: `The Mega Menu has no "${STORE_ITEM_TITLE}" item to insert under.` };
  }
  const children = store.items || [];
  const titles = children.map((it) => it.title);
  const existingIndex = children.findIndex((it) => menuTitleMatches(it, wantTitle, gid));
  const alreadyPresent = existingIndex !== -1;
  const index = alreadyPresent ? existingIndex : rules.megaMenuInsertIndex(children);
  const resulting = alreadyPresent ? titles : [...titles.slice(0, index), wantTitle, ...titles.slice(index)];
  return {
    ...base,
    storeItemId: store.id,
    storeItemTitle: store.title,
    index,
    insertAfter: index > 0 ? titles[index - 1] : null,
    insertBefore: alreadyPresent ? titles[index + 1] ?? null : titles[index] ?? null,
    alreadyPresent,
    existingItemId: alreadyPresent ? children[existingIndex].id : null,
    itemsPreview: resulting.slice(Math.max(0, index - 3), index + 4)
  };
}

function toMenuItemUpdateInput(item) {
  const out = { title: item.title, type: item.type };
  if (item.id) out.id = item.id;
  if (item.resourceId) out.resourceId = item.resourceId;
  if (item.url) out.url = item.url;
  if (Array.isArray(item.tags) && item.tags.length) out.tags = [...item.tags];
  if (Array.isArray(item.items) && item.items.length) out.items = item.items.map(toMenuItemUpdateInput);
  return out;
}

// menuUpdate replaces the whole tree, so every existing item goes back with
// its id (an item without an id would be recreated and lose its identity).
// "Keep every existing entry" (§8) is enforced by construction here.
function buildMenuUpdateItems(menu, proposal) {
  if (!proposal?.storeItemId) throw new Error(proposal?.reason || "No Mega Menu insertion point (Store item) was proposed.");
  const items = menu?.items || [];
  if (!items.some((it) => it.id === proposal.storeItemId)) throw new Error("The proposed Store item is not in this menu — re-read the menu and propose again.");
  return items.map((item) => {
    const converted = toMenuItemUpdateInput(item);
    if (item.id !== proposal.storeItemId || proposal.alreadyPresent) return converted;
    const children = (item.items || []).map(toMenuItemUpdateInput);
    const at = Math.min(Math.max(proposal.index, 0), children.length);
    const inserted = { title: proposal.newItem.title, type: "COLLECTION" };
    if (proposal.newItem.resourceId) inserted.resourceId = proposal.newItem.resourceId;
    if (proposal.newItem.url) inserted.url = proposal.newItem.url;
    children.splice(at, 0, inserted);
    converted.items = children;
    return converted;
  });
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/* Refuses a menu that looks wiped. menuUpdate replaces the whole tree, so a
   write computed from a Store list somebody else emptied makes the emptying
   permanent — on 13 Oct 2026 it turned ~112 stores into one. The live read is
   judged against the last good copy (`baseline`, from megaMenuGuard) and, with
   no copy at all, against the absolute rules: an empty Store list is never
   written to. */
function assertMenuHealthy(live, baseline) {
  const assessment = menuGuard.assessMenu(live, baseline || null);
  if (assessment.healthy) return assessment;
  const error = codedError(`${assessment.message} Nothing was written to it.`, "MENU_SUSPECT");
  error.assessment = assessment;
  throw error;
}

function allItemIds(items, out = new Map()) {
  for (const item of items || []) {
    if (item.id) out.set(item.id, item.title);
    allItemIds(item.items, out);
  }
  return out;
}

// Every item that was in `before` and is not in `after`, by id: an insert
// sends every existing item back with its id, so any id that vanished is an
// item the write deleted.
function lostMenuItems(before, after) {
  const kept = allItemIds(after?.items);
  return [...allItemIds(before?.items)].filter(([id]) => !kept.has(id)).map(([id, title]) => ({ id, title }));
}

// Applies an APPROVED proposal. The menu is re-read and the position
// recomputed first: approval covered the exact change Dan saw, so if another
// department landed in between, this stops rather than inserting elsewhere.
// A re-read that looks wiped stops it too (MENU_SUSPECT), before anything is
// computed from it.
async function applyMegaMenuInsert(menu, proposal, { onLog, baseline = null } = {}) {
  const log = logger(onLog);
  if (!proposal?.newItem?.title) throw new Error("applyMegaMenuInsert needs the proposal to apply.");
  const fresh = await readMegaMenu();
  if (!fresh.available) {
    throw codedError(`Mega Menu is not writable: ${fresh.reason}`, fresh.accessDenied ? "ACCESS_DENIED" : "MENU_UNAVAILABLE");
  }
  const live = fresh.menu;
  assertMenuHealthy(live, baseline);
  if (menu?.id && live.id !== menu.id) {
    throw codedError(`Mega Menu id changed (${menu.id} → ${live.id}); propose again.`, "STALE_PROPOSAL");
  }
  const recomputed = proposeMegaMenuInsert(live, {
    title: proposal.newItem.title,
    collectionHandle: proposal.collectionHandle || String(proposal.newItem.url || "").replace(/^\/collections\//, ""),
    collectionGid: proposal.collectionGid || proposal.newItem.resourceId || null
  });
  if (recomputed.alreadyPresent) {
    log(`"${proposal.newItem.title}" is already in the Mega Menu`);
    return { applied: true, alreadyPresent: true, menuItemId: recomputed.existingItemId, index: recomputed.index, insertAfter: recomputed.insertAfter, insertBefore: recomputed.insertBefore, lostItems: [], before: live, after: live };
  }
  if (!recomputed.storeItemId) throw codedError(recomputed.reason, "MENU_UNAVAILABLE");
  if (recomputed.index !== proposal.index || recomputed.insertAfter !== proposal.insertAfter || recomputed.insertBefore !== proposal.insertBefore) {
    /* A store that lands first legitimately has nothing above it, and a store
       that lands last nothing below; interpolating those straight into the
       sentence reported `after "null"` to Dan as if a menu item were named
       that. Say what an absent neighbour means instead. */
    const neighbour = (value) => (value ? `"${value}"` : "nothing");
    throw codedError(
      `The Mega Menu changed since the proposal was approved (approved: after ${neighbour(proposal.insertAfter)} / before ${neighbour(proposal.insertBefore)}; now: after ${neighbour(recomputed.insertAfter)} / before ${neighbour(recomputed.insertBefore)}). Propose again.`,
      "STALE_PROPOSAL"
    );
  }
  const items = buildMenuUpdateItems(live, recomputed);
  let data;
  try {
    data = await gql(MENU_UPDATE_MUTATION, { id: live.id, title: live.title, items });
  } catch (error) {
    if (isAccessDenied(error)) throw codedError(`Mega Menu is not writable: ${error.message}`, "ACCESS_DENIED");
    throw error;
  }
  assertNoUserErrors("menuUpdate", data?.menuUpdate?.userErrors);
  const updated = data?.menuUpdate?.menu ? normalizeMenu(data.menuUpdate.menu) : null;
  const store = updated ? findStoreItem(updated) : null;
  const inserted = (store?.items || []).find((it) => menuTitleMatches(it, proposal.newItem.title, recomputed.collectionGid));
  log(`Inserted "${proposal.newItem.title}" into the Mega Menu at index ${recomputed.index}`);
  /* The tree Shopify answered with is the proof the write kept everything.
     `before` goes back too, so the caller can keep it as a restore point. */
  const lostItems = updated ? lostMenuItems(live, updated) : [];
  if (lostItems.length) log(`The Mega Menu write dropped ${lostItems.length} item(s) that were there before: ${lostItems.map((it) => it.title).join(", ")}`);
  return {
    applied: true,
    alreadyPresent: false,
    menuItemId: inserted?.id || null,
    index: recomputed.index,
    insertAfter: recomputed.insertAfter,
    insertBefore: recomputed.insertBefore,
    lostItems,
    before: live,
    after: updated
  };
}

/* ---------------------------------------------------------------------------
   Store deletion — only ever called by deleteStore() in the agent, for a store
   the agent built, after Dan typed its name.
   ------------------------------------------------------------------------- */

const STORE_PRODUCTS_QUERY = `
query storeProducts($id: ID!, $after: String) {
  collection(id: $id) {
    id
    title
    products(first: 100, after: $after) {
      nodes { id legacyResourceId title status tags collections(first: 5) { nodes { id title } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const PRODUCT_DELETE_MUTATION = `
mutation productDelete($input: ProductDeleteInput!) {
  productDelete(input: $input) { deletedProductId userErrors { field message } }
}`;

const COLLECTION_DELETE_MUTATION = `
mutation collectionDelete($input: CollectionDeleteInput!) {
  collectionDelete(input: $input) { deletedCollectionId userErrors { field message } }
}`;

async function storeProducts(collectionGidOrId) {
  const id = collectionGid(collectionGidOrId);
  const out = [];
  let after = null;
  let title = "";
  do {
    const data = await gql(STORE_PRODUCTS_QUERY, { id, after });
    const collection = data?.collection;
    if (!collection) throw new Error(`Collection ${collectionGidOrId} was not found in Shopify.`);
    title = collection.title;
    for (const p of collection.products.nodes || []) {
      out.push({
        gid: p.id,
        id: String(p.legacyResourceId),
        title: p.title,
        status: p.status,
        tags: p.tags || [],
        otherCollections: (p.collections?.nodes || []).filter((c) => c.id !== id).map((c) => c.title)
      });
    }
    after = collection.products.pageInfo?.hasNextPage ? collection.products.pageInfo.endCursor : null;
  } while (after);
  return { title, products: out };
}

async function deleteProduct(gidOrId) {
  const data = await gql(PRODUCT_DELETE_MUTATION, { input: { id: productGid(gidOrId) } });
  assertNoUserErrors("productDelete", data?.productDelete?.userErrors);
  return data?.productDelete?.deletedProductId || null;
}

async function deleteCollection(gidOrId) {
  const data = await gql(COLLECTION_DELETE_MUTATION, { input: { id: collectionGid(gidOrId) } });
  assertNoUserErrors("collectionDelete", data?.collectionDelete?.userErrors);
  return data?.collectionDelete?.deletedCollectionId || null;
}

// Drop every Mega Menu item that links to this collection, matched by the
// collection's id only — never by title, so no other store can be touched.
// The same whole-tree write as the insert, so the same guard: a menu that
// looks wiped is reported (`suspect`) and left exactly as it is.
async function removeMegaMenuItemsFor(gidOrId, { baseline = null } = {}) {
  const gid = collectionGid(gidOrId);
  const read = await readMegaMenu();
  if (!read.available) return { removed: 0, available: false, reason: read.reason };
  const assessment = menuGuard.assessMenu(read.menu, baseline);
  if (!assessment.healthy) return { removed: 0, available: true, suspect: true, reason: assessment.reasons.join(" ") };
  let removed = 0;
  const prune = (items) =>
    (items || [])
      .filter((item) => {
        if (item.resourceId === gid) {
          removed += 1;
          return false;
        }
        return true;
      })
      .map((item) => ({ ...item, items: prune(item.items) }));
  const items = prune(read.menu.items);
  if (!removed) return { removed: 0, available: true };
  const data = await gql(MENU_UPDATE_MUTATION, { id: read.menu.id, title: read.menu.title, items: items.map(toMenuItemUpdateInput) });
  assertNoUserErrors("menuUpdate", data?.menuUpdate?.userErrors);
  return { removed, available: true };
}

/* `collectionGid` matters: an item Dan added by hand is named however he named
   it, and matching on the title alone reports a store that IS in the menu as
   missing. menuTitleMatches accepts either, exactly as the proposal's
   already-present check does.
   `includeMenu` hands back the menu that was read, so the agent can judge
   the whole menu from the same read instead of reading it twice. */
async function verifyMegaMenu(title, { collectionGid = null, includeMenu = false } = {}) {
  const fresh = await readMegaMenu();
  if (!fresh.available) return { available: false, present: false, index: -1, before: null, after: null, reason: fresh.reason, accessDenied: Boolean(fresh.accessDenied) };
  const store = findStoreItem(fresh.menu);
  const children = store?.items || [];
  const index = children.findIndex((it) => menuTitleMatches(it, title, collectionGid));
  const result = {
    available: true,
    present: index !== -1,
    index,
    before: index > 0 ? children[index - 1].title : null,
    after: index !== -1 && children[index + 1] ? children[index + 1].title : null,
    storeItemTitle: store?.title || null
  };
  if (includeMenu) result.menu = fresh.menu;
  return result;
}

/* ---------------------------------------------------------------------------
   Putting a wiped Mega Menu back from the last good copy
   ------------------------------------------------------------------------- */

const MENU_RESOURCES_QUERY = `
query menuResources($ids: [ID!]!) {
  nodes(ids: $ids) { id }
}`;

// Shopify caps nodes(ids:) at 250 ids per call.
const NODES_PAGE = 250;

function restoredNode(item) {
  return { title: item.title, type: item.type, url: item.url || null, resourceId: item.resourceId || null, tags: Array.isArray(item.tags) ? [...item.tags] : [], items: [] };
}

function cloneMenuItems(items, map) {
  return (items || []).map((item) => {
    const copy = { ...item, tags: Array.isArray(item.tags) ? [...item.tags] : [], items: [] };
    map.set(item, copy);
    copy.items = cloneMenuItems(item.items, map);
    return copy;
  });
}

/**
 * The whole menuUpdate tree that puts back what the last good copy had and
 * the live menu lost. Pure. The live menu is never edited, only added to:
 * every live item keeps its id, its place and its children, so nothing a
 * person did since — a "Get Scanned" link, a store rebuilt by hand — is
 * removed, renamed or reordered.
 *
 * A missing item goes back under its own parent (top-level parents by title,
 * the Store list by the Store rule), directly after the nearest item that came
 * before it in the copy and is still there — else first — and brings its own
 * missing children with it. Restored items carry no id: menuUpdate creates
 * them. An item whose parent is gone and cannot itself come back, or whose
 * collection was deleted (`goneResourceIds`), is skipped with the reason.
 *
 * → { items: MenuItemUpdateInput[], restored: [{ title, parentTitle, type,
 *     resourceId }], skipped: [{ title, reason }] }
 */
function planMenuRestore(liveMenu, baselineMenu, { goneResourceIds = [] } = {}) {
  const gone = new Set(goneResourceIds);
  const { baseline, pairs } = menuGuard.matchMenus(baselineMenu, liveMenu);
  const entryOf = new Map(baseline.map((entry) => [entry.node, entry]));
  const cloneOf = new Map();
  const tree = cloneMenuItems(liveMenu?.items, cloneOf);
  // Where each copy item sits in the working tree: its live twin, or the
  // node made for it here.
  const placed = new Map();
  const restored = [];
  const skipped = [];

  // A missing item that cannot come back takes its missing children with it;
  // a child that is still live somewhere keeps having its own children put
  // back under it.
  const skipMissing = (item, reason) => {
    skipped.push({ title: item.title, reason });
    for (const child of item.items || []) {
      const twin = pairs.get(entryOf.get(child));
      if (twin) walk(child, cloneOf.get(twin.node), child.title);
      else skipMissing(child, `"${item.title}", the item it sat under, could not be put back`);
    }
  };

  // Puts back the missing children of `copyParent` under `target` (a node in
  // the working tree, or null when the parent is gone for good).
  function walk(copyParent, target, parentTitle) {
    const children = copyParent.items || [];
    children.forEach((item, i) => {
      const twin = pairs.get(entryOf.get(item));
      if (twin) {
        const node = cloneOf.get(twin.node);
        placed.set(item, node);
        walk(item, node, item.title);
        return;
      }
      if (!target) {
        skipMissing(item, `"${parentTitle}", the item it sat under, is no longer in the menu`);
        return;
      }
      if (item.resourceId && gone.has(item.resourceId)) {
        skipMissing(item, /\/Collection\//.test(item.resourceId) ? "the collection no longer exists" : "what it linked to no longer exists");
        return;
      }
      let at = 0;
      for (let j = i - 1; j >= 0; j--) {
        const index = target.items.indexOf(placed.get(children[j]));
        if (index !== -1) {
          at = index + 1;
          break;
        }
      }
      const node = restoredNode(item);
      target.items.splice(at, 0, node);
      placed.set(item, node);
      restored.push({ title: item.title, parentTitle, type: item.type, resourceId: item.resourceId || null });
      walk(item, node, item.title);
    });
  }

  const copyStore = menuGuard.findStoreItem(baselineMenu);
  const liveStore = menuGuard.findStoreItem({ items: tree });
  for (const top of baselineMenu?.items || []) {
    const twin =
      tree.find((item) => normText(item.title) === normText(top.title)) || (top === copyStore ? liveStore : null);
    walk(top, twin || null, top.title);
  }

  return { items: tree.map(toMenuItemUpdateInput), restored, skipped };
}

// Which of these resource ids Shopify no longer has (nodes() answers null).
async function missingResources(ids) {
  const gone = [];
  for (let i = 0; i < ids.length; i += NODES_PAGE) {
    const page = ids.slice(i, i + NODES_PAGE);
    const data = await gql(MENU_RESOURCES_QUERY, { ids: page });
    const nodes = data?.nodes || [];
    page.forEach((id, k) => {
      if (!nodes[k]) gone.push(id);
    });
  }
  return gone;
}

/**
 * Put back what `baselineMenu` has and the live menu lost — one menuUpdate,
 * and only additions (planMenuRestore). Collections deleted since the copy
 * are checked first and skipped, because a menu item cannot link to a
 * collection that does not exist. The menu is then read back: every item
 * that was live before must still be there (else RESTORE_LOST_ITEMS), and an
 * item Shopify did not keep is reported as skipped, never as restored.
 * Nothing to restore → no write.
 */
async function restoreMegaMenuItems(baselineMenu, { onLog } = {}) {
  const log = logger(onLog);
  if (!baselineMenu || !Array.isArray(baselineMenu.items)) throw new Error("restoreMegaMenuItems needs the copy of the menu to restore from.");
  const fresh = await readMegaMenu();
  if (!fresh.available) {
    throw codedError(`Mega Menu could not be read: ${fresh.reason}`, fresh.accessDenied ? "ACCESS_DENIED" : "MENU_UNAVAILABLE");
  }
  const live = fresh.menu;
  let plan = planMenuRestore(live, baselineMenu);
  const collectionIds = [...new Set(plan.restored.map((item) => item.resourceId).filter((id) => /^gid:\/\/shopify\/Collection\//.test(String(id || ""))))];
  if (collectionIds.length) {
    const gone = await missingResources(collectionIds);
    if (gone.length) {
      log(`${gone.length} collection(s) in the copy no longer exist and will not be put back`);
      plan = planMenuRestore(live, baselineMenu, { goneResourceIds: gone });
    }
  }
  if (!plan.restored.length) {
    log("Nothing to restore — the Mega Menu already has everything in the copy");
    return { applied: false, restored: [], skipped: plan.skipped, before: live, after: live };
  }

  let data;
  try {
    data = await gql(MENU_UPDATE_MUTATION, { id: live.id, title: live.title, items: plan.items });
  } catch (error) {
    if (isAccessDenied(error)) throw codedError(`Mega Menu is not writable: ${error.message}`, "ACCESS_DENIED");
    throw error;
  }
  assertNoUserErrors("menuUpdate", data?.menuUpdate?.userErrors);
  const reread = await readMegaMenu();
  const after = reread.available ? reread.menu : data?.menuUpdate?.menu ? normalizeMenu(data.menuUpdate.menu) : null;
  if (!after) throw codedError("The Mega Menu was written but could not be read back to check it.", "MENU_UNAVAILABLE");

  const lost = lostMenuItems(live, after);
  if (lost.length) {
    const error = codedError(
      `The restore write dropped ${lost.length} item(s) that were in the menu before it: ${lost.map((it) => it.title).join(", ")}. Restore again from the copy taken just before the write.`,
      "RESTORE_LOST_ITEMS"
    );
    error.lostItems = lost;
    throw error;
  }
  // What the copy still has and the menu still lacks did not come back.
  const check = menuGuard.matchMenus(baselineMenu, after);
  const stillMissing = check.baseline.filter((entry) => !check.pairs.has(entry));
  const notKept = (item) => stillMissing.some((entry) => entry.title === item.title && entry.parentTitle === item.parentTitle);
  const restored = plan.restored.filter((item) => !notKept(item));
  const skipped = [...plan.skipped, ...plan.restored.filter(notKept).map((item) => ({ title: item.title, reason: "Shopify did not keep it when the menu was saved" }))];
  log(`Restored ${restored.length} Mega Menu item(s)${skipped.length ? `; ${skipped.length} could not be put back` : ""}`);
  return { applied: true, restored, skipped, before: live, after };
}

/* ---------------------------------------------------------------------------
   Storefront verification: does the live navigation show the new store?
   ------------------------------------------------------------------------- */

function htmlToText(html) {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#0*39;|&apos;|&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function storefrontNavContains(html, title) {
  const want = normText(title);
  if (!want || !html) return false;
  const navs = String(html).match(/<nav\b[\s\S]*?<\/nav>/gi) || [];
  if (navs.some((nav) => htmlToText(nav).includes(want))) return true;
  // Themes render mega menus in drawers/details outside <nav>; the page text
  // is the fallback.
  return htmlToText(html).includes(want);
}

/*
 * Whether the storefront can prove anything about a DEPARTMENT store's menu
 * entry — and it cannot. Locksmith's "Hide from navigation menus" (spec §7.2)
 * is one of the four settings every department lock carries, so a correctly
 * locked store is deliberately absent from the public navigation.
 *
 * Verified against the live store: the storefront HTML lists "FN Simple Merch"
 * but neither "Bishop Fire Department" nor "Ripon Fire District", both of
 * which ARE in the Mega Menu in admin. Reporting "missing" from this signal
 * would send Dan to re-add a menu item that is already there, so a negative is
 * always inconclusive and only a positive is evidence.
 */
function storefrontMenuVerdict(html, title) {
  const present = storefrontNavContains(html, title);
  return {
    present,
    conclusive: present,
    reason: present
      ? "found in the live storefront navigation"
      : "a locked department store is hidden from the public navigation by its Locksmith lock, so its absence here proves nothing — check the Mega Menu in Shopify admin"
  };
}

function storefrontDomain() {
  return String(process.env.SHOPIFY_STOREFRONT_DOMAIN || DEFAULT_STOREFRONT_DOMAIN)
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "") || DEFAULT_STOREFRONT_DOMAIN;
}

async function fetchStorefrontHtml(path = "/") {
  const suffix = String(path || "/");
  const url = `https://${storefrontDomain()}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
  const res = await transports.fetch(url, {
    headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    timeout: STOREFRONT_TIMEOUT_MS
  });
  if (!res.ok) throw new Error(`Storefront ${url} returned ${res.status}`);
  return res.text();
}

/* ---------------------------------------------------------------------------
   Admin URLs (re-exported so callers need only this module)
   ------------------------------------------------------------------------- */

const productAdminUrl = shopify.adminProductUrl;
const collectionAdminUrl = shopify.adminCollectionUrl;
const adminUrls = { productAdminUrl, collectionAdminUrl };

module.exports = {
  // constants
  MASTER_REFERENCE_TAG,
  ONLINE_STORE_PUBLICATION,
  MEGA_MENU_HANDLE,
  STORE_ITEM_TITLE,
  MAX_VARIANTS,
  SYNC_VARIANT_LIMIT,
  // transport
  setGraphql,
  setTransports,
  // products
  findSourceProduct,
  createMasterDraft,
  masterGarments,
  stagedFileUrl,
  storeProfile,
  resolveStyleNumber,
  readProductForDuplication,
  duplicateProduct,
  buildProductSetInput,
  setProduct,
  attachMockups,
  linkVariantImages,
  replaceProductImages,
  // collection
  ensureDepartmentCollection,
  // verification reads
  collectionSnapshot,
  productSnapshot,
  allProductTags,
  // store deletion
  storeProducts,
  deleteProduct,
  deleteCollection,
  removeMegaMenuItemsFor,
  // mega menu
  readMegaMenu,
  findStoreItem,
  proposeMegaMenuInsert,
  buildMenuUpdateItems,
  applyMegaMenuInsert,
  verifyMegaMenu,
  planMenuRestore,
  restoreMegaMenuItems,
  // storefront
  storefrontNavContains,
  storefrontMenuVerdict,
  fetchStorefrontHtml,
  // admin urls
  productAdminUrl,
  collectionAdminUrl,
  adminUrls,
  // internals exposed for tests
  isMasterReference,
  skuMatchesStyle,
  isAccessDenied
};

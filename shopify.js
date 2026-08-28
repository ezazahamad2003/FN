const fetch = require("node-fetch");
const sharp = require("sharp");

// GraphQL Admin API. Product creation MUST use GraphQL: the store sells one
// product per garment with a Front Logo variant per uploaded logo (30+ logos ×
// 7 sizes on real departments), and REST products are capped at 100 variants.
// GraphQL supports up to 2048 variants per product.
const API_VERSION = "2024-07";

// Re-mint the token a few minutes before it actually expires so requests never
// race the expiry boundary.
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
// Proactive background refresh interval — comfortably inside the ~24h token life.
const TOKEN_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

const DEFAULT_SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL"];
// GraphQL variant cap per product. Beyond this the caller splits per logo.
const MAX_VARIANTS = 2048;

let cachedToken = null;
let tokenExpiresAt = 0;
let mintPromise = null;

function hasClientCredentials() {
  return Boolean(
    process.env.SHOPIFY_CLIENT_ID &&
      process.env.SHOPIFY_CLIENT_SECRET &&
      process.env.SHOPIFY_STORE
  );
}

function shopifyConnected() {
  return hasClientCredentials() || Boolean(process.env.SHOPIFY_ACCESS_TOKEN);
}

function shopifyUrl(path) {
  return `https://${process.env.SHOPIFY_STORE}/admin/api/${API_VERSION}${path}`;
}

// Exchange the app's client credentials for a fresh Admin API access token.
// Shopify's client_credentials tokens are short-lived (~24h), so we cache the
// result and refresh as needed.
async function mintAccessToken() {
  const res = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Shopify token mint failed (${res.status}): ${json.error_description || json.error || "unknown error"}`
    );
  }
  cachedToken = json.access_token;
  const ttlMs = (json.expires_in || 86400) * 1000;
  tokenExpiresAt = Date.now() + ttlMs - TOKEN_REFRESH_BUFFER_MS;
  // Keep the env var populated so existing connection checks stay accurate.
  process.env.SHOPIFY_ACCESS_TOKEN = cachedToken;
  return cachedToken;
}

// Always return a currently-valid token. In client-credentials (internal app)
// mode this auto-mints and caches; otherwise it falls back to a static token.
async function getAccessToken() {
  if (!hasClientCredentials()) return process.env.SHOPIFY_ACCESS_TOKEN;
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  if (!mintPromise) {
    mintPromise = mintAccessToken().finally(() => {
      mintPromise = null;
    });
  }
  return mintPromise;
}

// Mint a token on startup and keep it fresh on a timer so the app stays stable
// without any manual token rotation.
function startTokenAutoRefresh() {
  if (!hasClientCredentials()) return;
  mintAccessToken().catch((error) =>
    console.error("Initial Shopify token mint failed:", error.message)
  );
  const timer = setInterval(() => {
    mintAccessToken().catch((error) =>
      console.error("Scheduled Shopify token refresh failed:", error.message)
    );
  }, TOKEN_REFRESH_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

async function shopifyRequest(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(shopifyUrl(path), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = json.errors ? JSON.stringify(json.errors) : text;
    throw new Error(`Shopify ${res.status}: ${detail}`);
  }
  return json;
}

async function graphql(query, variables = {}) {
  const json = await shopifyRequest("/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query, variables })
  });
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// Shopify accepts either a numeric legacy id or a full gid in most inputs, but
// GraphQL node lookups need the gid form. Callers pass whichever they have.
function gid(resource, id) {
  const value = String(id);
  return value.startsWith("gid://") ? value : `gid://shopify/${resource}/${value}`;
}

function legacyIdOf(value) {
  return String(value).split("/").pop();
}

function assertNoUserErrors(operation, userErrors) {
  if (userErrors?.length) {
    throw new Error(`Shopify ${operation}: ${userErrors.map((e) => e.message).join("; ")}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------------------------------------------------------------------
   Collections — REST custom collections + collects (unaffected by the
   variant limits that deprecate REST product endpoints).
   ------------------------------------------------------------------------- */

async function findCollectionByTitle(title) {
  const params = new URLSearchParams({ title, limit: "250" });
  const json = await shopifyRequest(`/custom_collections.json?${params}`);
  return json.custom_collections?.find((collection) => collection.title === title) || null;
}

async function ensureManualCollection(title) {
  const existing = await findCollectionByTitle(title);
  if (existing) return existing;
  const json = await shopifyRequest("/custom_collections.json", {
    method: "POST",
    body: JSON.stringify({
      custom_collection: {
        title,
        published: true
      }
    })
  });
  return json.custom_collection;
}

async function collectionImageInput(image) {
  if (!image?.buffer) return null;
  const normalized = await sharp(image.buffer, { density: 300 })
    .rotate()
    .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  return {
    attachment: normalized.toString("base64"),
    alt: image.alt || ""
  };
}

async function setCollectionImage(collectionId, imageInput) {
  const json = await shopifyRequest(`/custom_collections/${collectionId}.json`, {
    method: "PUT",
    body: JSON.stringify({
      custom_collection: {
        id: collectionId,
        image: imageInput
      }
    })
  });
  return json.custom_collection;
}

// Shopify reliably accepts base64 `attachment` for collection images on update.
// Create/reuse the collection first, then PUT the image in a separate request.
async function ensureManualCollectionWithImage(title, image) {
  const collection = await ensureManualCollection(title);
  if (!image?.buffer) return collection;

  try {
    const imageInput = await collectionImageInput(image);
    return await setCollectionImage(collection.id, imageInput);
  } catch (error) {
    throw new Error(`Collection image upload failed for "${title}": ${error.message}`);
  }
}

async function addProductToCollection(productId, collectionId) {
  const json = await shopifyRequest("/collects.json", {
    method: "POST",
    body: JSON.stringify({
      collect: {
        product_id: productId,
        collection_id: collectionId
      }
    })
  });
  return json.collect;
}

/* ---------------------------------------------------------------------------
   Products — GraphQL productSet with Front Logo × Size variants.
   ------------------------------------------------------------------------- */

const PRODUCT_SET_MUTATION = `
mutation productSet($input: ProductSetInput!, $synchronous: Boolean!) {
  productSet(input: $input, synchronous: $synchronous) {
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
    variants(first: 250, after: $after) {
      nodes { id title selectedOptions { name value } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

async function fetchAllVariants(productGid) {
  const variants = [];
  let after = null;
  let product = null;
  do {
    const data = await graphql(PRODUCT_VARIANTS_QUERY, { id: productGid, after });
    product = data.product;
    if (!product) throw new Error(`Shopify product ${productGid} not found after creation.`);
    variants.push(...product.variants.nodes);
    after = product.variants.pageInfo.hasNextPage ? product.variants.pageInfo.endCursor : null;
  } while (after);
  return { product, variants };
}

// Create one product per garment, matching the store's merchandising: options
// "Front Logo" (one value per logo) and "Size". Single-logo products get only
// a Size option. Large departments (30+ logos × 7 sizes) go through the async
// productSet path, which supports up to 2048 variants.
async function createProductWithVariants({ title, bodyHtml, price, productType, vendor, tags, logoValues = [], sizes = [], status = "ACTIVE", logoOptionName = "Front Logo" }) {
  const sizeValues = sizes.length ? sizes : DEFAULT_SIZES;
  const useLogoOption = logoValues.length > 1;

  const productOptions = useLogoOption
    ? [
        { name: logoOptionName, position: 1, values: logoValues.map((name) => ({ name })) },
        { name: "Size", position: 2, values: sizeValues.map((name) => ({ name })) }
      ]
    : [{ name: "Size", position: 1, values: sizeValues.map((name) => ({ name })) }];

  const variants = [];
  if (useLogoOption) {
    for (const logo of logoValues) {
      for (const size of sizeValues) {
        variants.push({
          optionValues: [
            { optionName: logoOptionName, name: logo },
            { optionName: "Size", name: size }
          ],
          price
        });
      }
    }
  } else {
    for (const size of sizeValues) {
      variants.push({ optionValues: [{ optionName: "Size", name: size }], price });
    }
  }
  if (variants.length > MAX_VARIANTS) {
    throw new Error(`${title}: ${variants.length} variants exceed Shopify's ${MAX_VARIANTS}-variant limit. Split the product or reduce sizes/logos.`);
  }

  const input = {
    title,
    descriptionHtml: bodyHtml,
    // Intake auto-builds pass DRAFT so nothing a customer submitted goes live
    // on the storefront until an operator has reviewed it.
    status: status === "DRAFT" ? "DRAFT" : "ACTIVE",
    productType: productType || "",
    vendor: vendor || "",
    tags: tags || [],
    productOptions,
    variants
  };

  // Synchronous productSet caps at 100 variants; larger products run as an
  // async operation that we poll to completion.
  const synchronous = variants.length <= 100;
  const data = await graphql(PRODUCT_SET_MUTATION, { input, synchronous });
  assertNoUserErrors("productSet", data.productSet.userErrors);

  let productGid = data.productSet.product?.id || null;
  if (!synchronous) {
    const operationId = data.productSet.productSetOperation?.id;
    if (!operationId) throw new Error("Shopify productSet did not return an operation id.");
    const deadline = Date.now() + 180 * 1000;
    for (;;) {
      const poll = await graphql(PRODUCT_OPERATION_QUERY, { id: operationId });
      const operation = poll.productOperation;
      assertNoUserErrors("productSet operation", operation?.userErrors);
      if (operation?.status === "COMPLETE") {
        productGid = operation.product?.id;
        break;
      }
      if (Date.now() > deadline) throw new Error(`Shopify productSet for "${title}" timed out.`);
      await sleep(2000);
    }
  }
  if (!productGid) throw new Error(`Shopify did not return a product for "${title}".`);

  const { product, variants: createdVariants } = await fetchAllVariants(productGid);
  return {
    productGid,
    productId: String(product.legacyResourceId),
    title: product.title,
    variants: createdVariants,
    variantCount: createdVariants.length,
    useLogoOption,
    logoOptionName
  };
}

// Map each logo option value to its variant GIDs so every logo's mockup
// image can be attached to exactly its variants.
function variantIdsByLogo(variants, useLogoOption, logoOptionName = "Front Logo") {
  const map = new Map();
  for (const variant of variants) {
    const key = useLogoOption
      ? variant.selectedOptions.find((option) => option.name === logoOptionName)?.value || "__all__"
      : "__all__";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(variant.id);
  }
  return map;
}

/* ---------------------------------------------------------------------------
   Product images — staged upload → productCreateMedia → attach to variants.
   GraphQL media has no base64 attachment path, so images go through Shopify's
   staged upload targets (multipart POST via the Node 18+ global fetch).
   ------------------------------------------------------------------------- */

const STAGED_UPLOADS_MUTATION = `
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

const PRODUCT_CREATE_MEDIA_MUTATION = `
mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    media { ... on MediaImage { id status } }
    mediaUserErrors { code field message }
  }
}`;

const MEDIA_STATUS_QUERY = `
query mediaStatus($ids: [ID!]!) {
  nodes(ids: $ids) { ... on MediaImage { id status } }
}`;

const VARIANT_APPEND_MEDIA_MUTATION = `
mutation productVariantAppendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
  productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
    product { id }
    userErrors { code field message }
  }
}`;

async function stagedUpload(filename, buffer) {
  const data = await graphql(STAGED_UPLOADS_MUTATION, {
    input: [{ filename, mimeType: "image/png", httpMethod: "POST", resource: "IMAGE" }]
  });
  assertNoUserErrors("stagedUploadsCreate", data.stagedUploadsCreate.userErrors);
  const target = data.stagedUploadsCreate.stagedTargets?.[0];
  if (!target) throw new Error("Shopify did not return a staged upload target.");

  // Node 18+ global FormData/Blob (node-fetch@2 lacks multipart support).
  const form = new FormData();
  for (const param of target.parameters) form.append(param.name, param.value);
  form.append("file", new Blob([buffer], { type: "image/png" }), filename);
  const uploadRes = await globalThis.fetch(target.url, { method: "POST", body: form });
  if (!uploadRes.ok) {
    throw new Error(`Staged image upload failed (${uploadRes.status}): ${(await uploadRes.text()).slice(0, 300)}`);
  }
  return target.resourceUrl;
}

async function waitForMediaReady(mediaIds) {
  const deadline = Date.now() + 90 * 1000;
  let pending = [...mediaIds];
  while (pending.length) {
    const data = await graphql(MEDIA_STATUS_QUERY, { ids: pending });
    const failed = (data.nodes || []).filter((node) => node && node.status === "FAILED");
    if (failed.length) throw new Error(`Shopify media processing failed for ${failed.map((f) => f.id).join(", ")}`);
    pending = (data.nodes || []).filter((node) => node && node.status !== "READY").map((node) => node.id);
    if (!pending.length) break;
    if (Date.now() > deadline) throw new Error("Timed out waiting for Shopify media processing.");
    await sleep(1500);
  }
}

// Upload every logo's mockup and bind it to that logo's variants. `images` is
// [{ filename, buffer, alt, variantIds }].
async function uploadProductImages(productGid, images) {
  if (!images.length) return [];

  const media = [];
  for (const image of images) {
    const resourceUrl = await stagedUpload(image.filename, image.buffer);
    media.push({ originalSource: resourceUrl, alt: image.alt || "", mediaContentType: "IMAGE" });
  }

  const created = await graphql(PRODUCT_CREATE_MEDIA_MUTATION, { productId: productGid, media });
  assertNoUserErrors("productCreateMedia", created.productCreateMedia.mediaUserErrors);
  // productCreateMedia returns media in input order, so index-align with images.
  const mediaIds = (created.productCreateMedia.media || []).map((node) => node.id);
  if (mediaIds.length !== images.length) {
    throw new Error(`Shopify created ${mediaIds.length} of ${images.length} product images.`);
  }

  await waitForMediaReady(mediaIds);

  // A Shopify variant carries exactly ONE attached media (the image shown
  // when that variant is selected) — appending a second returns "The given
  // variant already has attached media." So each variant gets its FIRST image
  // (the front mockup; callers order front-first), and every other view stays
  // in the product gallery, which productCreateMedia already populated.
  const mediaByVariant = new Map();
  images.forEach((image, index) => {
    for (const variantId of image.variantIds || []) {
      if (!mediaByVariant.has(variantId)) mediaByVariant.set(variantId, mediaIds[index]);
    }
  });
  const variantMedia = [...mediaByVariant.entries()].map(([variantId, mediaId]) => ({ variantId, mediaIds: [mediaId] }));
  if (variantMedia.length) {
    const appended = await graphql(VARIANT_APPEND_MEDIA_MUTATION, { productId: productGid, variantMedia });
    assertNoUserErrors("productVariantAppendMedia", appended.productVariantAppendMedia.userErrors);
  }
  return mediaIds;
}

/* ---------------------------------------------------------------------------
   Cleanup (undo a published run).
   ------------------------------------------------------------------------- */

const PRODUCT_DELETE_MUTATION = `
mutation productDelete($input: ProductDeleteInput!) {
  productDelete(input: $input) {
    deletedProductId
    userErrors { field message }
  }
}`;

// Deleting an already-deleted resource is treated as success so cleanup can be
// retried safely.
async function deleteProduct(productGid) {
  const data = await graphql(PRODUCT_DELETE_MUTATION, { input: { id: productGid } });
  const errors = data.productDelete.userErrors || [];
  const alreadyGone = errors.every((e) => /does not exist|not found/i.test(e.message));
  if (errors.length && !alreadyGone) assertNoUserErrors("productDelete", errors);
}

async function deleteCollection(collectionId) {
  try {
    await shopifyRequest(`/custom_collections/${collectionId}.json`, { method: "DELETE" });
  } catch (error) {
    if (!/^Shopify 404/.test(String(error?.message || ""))) throw error;
  }
}

function adminCollectionUrl(collectionId) {
  return `https://${process.env.SHOPIFY_STORE}/admin/collections/${collectionId}`;
}

function adminProductUrl(productId) {
  return `https://${process.env.SHOPIFY_STORE}/admin/products/${productId}`;
}

module.exports = {
  DEFAULT_SIZES,
  MAX_VARIANTS,
  addProductToCollection,
  adminCollectionUrl,
  adminProductUrl,
  createProductWithVariants,
  deleteCollection,
  deleteProduct,
  ensureManualCollectionWithImage,
  gid,
  graphql,
  legacyIdOf,
  shopifyConnected,
  startTokenAutoRefresh,
  uploadProductImages,
  variantIdsByLogo
};

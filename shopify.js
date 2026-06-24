const fetch = require("node-fetch");

const API_VERSION = "2024-01";

// Re-mint the token a few minutes before it actually expires so requests never
// race the expiry boundary.
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
// Proactive background refresh interval — comfortably inside the ~24h token life.
const TOKEN_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

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

async function createProduct({ title, bodyHtml, price }) {
  const json = await shopifyRequest("/products.json", {
    method: "POST",
    body: JSON.stringify({
      product: {
        title,
        body_html: bodyHtml,
        status: "active",
        variants: [{ price }]
      }
    })
  });
  return json.product;
}

async function uploadProductImage(productId, filename, buffer) {
  const json = await shopifyRequest(`/products/${productId}/images.json`, {
    method: "POST",
    body: JSON.stringify({
      image: {
        attachment: buffer.toString("base64"),
        filename
      }
    })
  });
  return json.image;
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

function adminCollectionUrl(collectionId) {
  return `https://${process.env.SHOPIFY_STORE}/admin/collections/${collectionId}`;
}

function adminProductUrl(productId) {
  return `https://${process.env.SHOPIFY_STORE}/admin/products/${productId}`;
}

module.exports = {
  addProductToCollection,
  adminCollectionUrl,
  adminProductUrl,
  createProduct,
  ensureManualCollection,
  getAccessToken,
  shopifyConnected,
  startTokenAutoRefresh,
  uploadProductImage
};

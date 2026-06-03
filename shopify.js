const fetch = require("node-fetch");

const API_VERSION = "2024-01";

function shopifyUrl(path) {
  return `https://${process.env.SHOPIFY_STORE}/admin/api/${API_VERSION}${path}`;
}

async function shopifyRequest(path, options = {}) {
  const res = await fetch(shopifyUrl(path), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
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
  uploadProductImage
};

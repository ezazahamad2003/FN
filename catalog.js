/* =============================================================================
   Shopify catalog browsing & editing.
   -----------------------------------------------------------------------------
   The onboarding flow (server.js) CREATES a department: Drive folder, generated
   images, a collection, and its products. This module is the other half — it
   READS what already exists so the console can browse every department
   (= collection) in the store, open one, and edit or extend its products.

   Everything here is GraphQL. The store's products carry Front Logo × Size
   variants (hundreds per product), which the REST product endpoints cannot
   represent, so reads and writes both stay on GraphQL for consistency.
   ========================================================================== */

const { graphql, gid, legacyIdOf } = require("./shopify");

// Shopify caps a single connection page at 250 nodes.
const PAGE_SIZE = 250;
// productVariantsBulkUpdate accepts at most 250 variants per call.
const VARIANT_CHUNK = 250;

/* ---------------------------------------------------------------------------
   Collections (= departments)
   ------------------------------------------------------------------------- */

const COLLECTIONS_QUERY = `
query collections($first: Int!, $after: String) {
  collections(first: $first, after: $after, sortKey: TITLE) {
    nodes {
      id
      legacyResourceId
      title
      handle
      updatedAt
      description
      image { url altText }
      productsCount { count }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

function mapCollection(node) {
  return {
    id: node.legacyResourceId,
    gid: node.id,
    title: node.title,
    handle: node.handle,
    updatedAt: node.updatedAt,
    description: node.description || "",
    imageUrl: node.image?.url || null,
    imageAlt: node.image?.altText || "",
    productCount: node.productsCount?.count ?? 0
  };
}

// Collection titles in this store carry a merchandising prefix ("1. Benicia
// Fire Department", "10. Station 2"). Shopify's sortKey: TITLE is a plain
// lexicographic sort, which puts "10." and "11." ahead of "2." — so the list
// gets re-sorted here with numeric-aware comparison instead.
const naturalCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

// Every collection in the store, in natural title order. Departments are
// modest in number (one per fire department), so this walks all pages rather
// than exposing cursors to the UI.
async function listCollections() {
  const collections = [];
  let after = null;
  do {
    const data = await graphql(COLLECTIONS_QUERY, { first: PAGE_SIZE, after });
    collections.push(...data.collections.nodes.map(mapCollection));
    after = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (after);
  return collections.sort((a, b) => naturalCollator.compare(a.title, b.title));
}

const COLLECTION_PRODUCTS_QUERY = `
query collectionProducts($id: ID!, $first: Int!, $after: String) {
  collection(id: $id) {
    id
    legacyResourceId
    title
    handle
    description
    image { url altText }
    productsCount { count }
    products(first: $first, after: $after, sortKey: TITLE) {
      nodes {
        id
        legacyResourceId
        title
        handle
        status
        productType
        vendor
        totalInventory
        featuredMedia { preview { image { url altText } } }
        variantsCount { count }
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

function mapProductSummary(node) {
  return {
    id: node.legacyResourceId,
    gid: node.id,
    title: node.title,
    handle: node.handle,
    status: node.status,
    productType: node.productType || "",
    vendor: node.vendor || "",
    totalInventory: node.totalInventory ?? null,
    imageUrl: node.featuredMedia?.preview?.image?.url || null,
    imageAlt: node.featuredMedia?.preview?.image?.altText || "",
    variantCount: node.variantsCount?.count ?? 0,
    minPrice: node.priceRangeV2?.minVariantPrice?.amount || null,
    maxPrice: node.priceRangeV2?.maxVariantPrice?.amount || null,
    currency: node.priceRangeV2?.minVariantPrice?.currencyCode || ""
  };
}

// One department page: the collection plus every product in it.
async function getCollectionWithProducts(collectionId) {
  const collectionGid = gid("Collection", collectionId);
  const products = [];
  let after = null;
  let collection = null;

  do {
    const data = await graphql(COLLECTION_PRODUCTS_QUERY, {
      id: collectionGid,
      first: PAGE_SIZE,
      after
    });
    collection = data.collection;
    if (!collection) throw new Error(`Collection ${collectionId} was not found in Shopify.`);
    products.push(...collection.products.nodes.map(mapProductSummary));
    after = collection.products.pageInfo.hasNextPage ? collection.products.pageInfo.endCursor : null;
  } while (after);

  return {
    collection: {
      id: collection.legacyResourceId,
      gid: collection.id,
      title: collection.title,
      handle: collection.handle,
      description: collection.description || "",
      imageUrl: collection.image?.url || null,
      productCount: collection.productsCount?.count ?? products.length
    },
    products
  };
}

/* ---------------------------------------------------------------------------
   Product detail & editing
   ------------------------------------------------------------------------- */

// Variants are capped at one page: a product can carry 2000+ (logos × sizes)
// and the editor only needs a representative sample plus the option lists,
// which `options` already gives in full.
const PRODUCT_QUERY = `
query product($id: ID!) {
  product(id: $id) {
    id
    legacyResourceId
    title
    handle
    status
    descriptionHtml
    productType
    vendor
    tags
    onlineStoreUrl
    variantsCount { count }
    options { id name position optionValues { id name } }
    priceRangeV2 {
      minVariantPrice { amount currencyCode }
      maxVariantPrice { amount currencyCode }
    }
    media(first: 50) {
      nodes {
        ... on MediaImage {
          id
          image { url altText }
        }
      }
    }
    variants(first: 100) {
      nodes {
        id
        title
        sku
        price
        selectedOptions { name value }
      }
    }
    collections(first: 25) { nodes { id legacyResourceId title } }
  }
}`;

async function getProduct(productId) {
  const data = await graphql(PRODUCT_QUERY, { id: gid("Product", productId) });
  const product = data.product;
  if (!product) throw new Error(`Product ${productId} was not found in Shopify.`);

  return {
    id: product.legacyResourceId,
    gid: product.id,
    title: product.title,
    handle: product.handle,
    status: product.status,
    descriptionHtml: product.descriptionHtml || "",
    productType: product.productType || "",
    vendor: product.vendor || "",
    tags: product.tags || [],
    onlineStoreUrl: product.onlineStoreUrl || null,
    variantCount: product.variantsCount?.count ?? 0,
    minPrice: product.priceRangeV2?.minVariantPrice?.amount || null,
    maxPrice: product.priceRangeV2?.maxVariantPrice?.amount || null,
    currency: product.priceRangeV2?.minVariantPrice?.currencyCode || "",
    options: (product.options || []).map((option) => ({
      name: option.name,
      position: option.position,
      values: (option.optionValues || []).map((value) => value.name)
    })),
    images: (product.media?.nodes || [])
      .filter((node) => node && node.image)
      .map((node) => ({ id: node.id, url: node.image.url, alt: node.image.altText || "" })),
    variantSample: (product.variants?.nodes || []).map((variant) => ({
      id: variant.id,
      title: variant.title,
      sku: variant.sku || "",
      price: variant.price,
      options: variant.selectedOptions
    })),
    collections: (product.collections?.nodes || []).map((node) => ({
      id: node.legacyResourceId,
      title: node.title
    }))
  };
}

// `input:` rather than the newer `product: ProductUpdateInput` — the app pins
// API 2024-07, where the `product` argument does not exist yet. `input` is
// marked deprecated on current versions but still accepted, so this one form
// works either side of an API bump.
const PRODUCT_UPDATE_MUTATION = `
mutation productUpdate($input: ProductInput!) {
  productUpdate(input: $input) {
    product { id legacyResourceId title }
    userErrors { field message }
  }
}`;

const VARIANTS_BULK_UPDATE_MUTATION = `
mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price }
    userErrors { field message }
  }
}`;

const VARIANT_IDS_QUERY = `
query variantIds($id: ID!, $after: String) {
  product(id: $id) {
    variants(first: 250, after: $after) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

function assertNoUserErrors(operation, userErrors) {
  if (userErrors?.length) {
    throw new Error(`Shopify ${operation}: ${userErrors.map((e) => e.message).join("; ")}`);
  }
}

async function allVariantIds(productGid) {
  const ids = [];
  let after = null;
  do {
    const data = await graphql(VARIANT_IDS_QUERY, { id: productGid, after });
    const connection = data.product?.variants;
    if (!connection) break;
    ids.push(...connection.nodes.map((node) => node.id));
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return ids;
}

// Apply one price to every variant of a product. Products here are priced flat
// (one price across all logo × size combinations), matching how the store
// merchandises them, so a single field in the editor is the right control.
async function setProductPrice(productGid, price) {
  const variantIds = await allVariantIds(productGid);
  for (let i = 0; i < variantIds.length; i += VARIANT_CHUNK) {
    const chunk = variantIds.slice(i, i + VARIANT_CHUNK).map((id) => ({ id, price }));
    const data = await graphql(VARIANTS_BULK_UPDATE_MUTATION, { productId: productGid, variants: chunk });
    assertNoUserErrors("productVariantsBulkUpdate", data.productVariantsBulkUpdate.userErrors);
  }
  return variantIds.length;
}

const EDITABLE_FIELDS = ["title", "descriptionHtml", "productType", "vendor", "status", "tags"];

// Patch semantics: only the keys present in `fields` are sent to Shopify, so
// the editor can save a single field without clobbering the rest.
async function updateProduct(productId, fields) {
  const productGid = gid("Product", productId);
  const input = { id: productGid };
  for (const key of EDITABLE_FIELDS) {
    if (fields[key] === undefined) continue;
    input[key] = key === "tags" ? toTags(fields.tags) : fields[key];
  }

  if (Object.keys(input).length > 1) {
    const data = await graphql(PRODUCT_UPDATE_MUTATION, { input });
    assertNoUserErrors("productUpdate", data.productUpdate.userErrors);
  }

  let repricedVariants = 0;
  if (fields.price !== undefined && String(fields.price).trim()) {
    repricedVariants = await setProductPrice(productGid, String(fields.price).trim());
  }

  return { ...(await getProduct(legacyIdOf(productGid))), repricedVariants };
}

function toTags(tags) {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean);
  return String(tags || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

module.exports = {
  getCollectionWithProducts,
  getProduct,
  listCollections,
  updateProduct
};

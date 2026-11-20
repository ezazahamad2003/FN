/*
 * The Department Onboarding Agent's console on fake collaborators, to look at
 * and click through the UI without touching Shopify, Drive, blob storage or
 * any model:
 *
 *   node test/onboarding-preview.js          # then open the URL it prints
 *
 * The real `npm start` runs the build-resume watchdog against the live store,
 * so it is no way to try a console change. This starts the real express
 * router and the real agent with records in memory and every collaborator a
 * stub (the same shapes test/onboardingAgent.test.js uses), then seeds one
 * record at the Products step with three packet logos and the row Dan had
 * on 2026-11-02: a 5.11 job shirt, method Embroidery, codes E02/E01/B02 —
 * an embroidered front crest and a printed full back.
 *
 * Nothing here writes anywhere: close it and it is gone. Pass
 * PREVIEW_PORT to move it off 3499.
 */

delete process.env.AZURE_STORAGE_CONNECTION_STRING;
delete process.env.OPENAI_API_KEY;
delete process.env.AZURE_OPENAI_ENDPOINT;
delete process.env.LOCKSMITH_ACCESS_TOKEN;
process.env.GDRIVE_PARENT_FOLDER_ID = "parent-departments";
process.env.GDRIVE_OMNI_PRINTER_FOLDER_ID = "parent-omni";
process.env.SHOPIFY_STOREFRONT_DOMAIN = "fnsimple.com";

const path = require("path");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");

const agent = require("../onboardingAgent");
const store = require("../onboardingStore");
const referenceTables = require("../referenceTables");
const rules = require("../onboardingRules");
const realPolicy = require("../onboardingPolicy");
const realHelium = require("../helium");
const menuGuard = require("../megaMenuGuard");
const linkBook = require("../linkBook");
const createOnboardingRouter = require("../onboardingRoutes");

const PORT = Number(process.env.PREVIEW_PORT || 3499);
const DEPARTMENT = "East Whittier Fire Department";
const CODE = "EWP";
// A second store, already built and live (see seedBuiltStore).
const BUILT_DEPARTMENT = "Harbor Point Fire Department";
const BUILT_CODE = "HPF";

// The store's own blanks, as the garment picker lists them.
const GARMENTS = [
  { styleNumber: "72534", label: "5.11 1/4 Zip Job Shirt", group: "Job shirts", brand: "5.11 Tactical", type: "Job Shirt", sizes: ["S", "M", "L", "XL", "2XL", "3XL"], colors: ["Heather Gray", "Black", "Fire Navy", "Ranger Green"] },
  { styleNumber: "NL3600", label: "Next Level Cotton Tee", group: "Tees", brand: "Next Level", type: "T-shirt", sizes: ["S", "M", "L", "XL", "2XL"], colors: ["Navy", "Black"] },
  { styleNumber: "R112", label: "Richardson Trucker", group: "Hats", brand: "Richardson", type: "Hat", sizes: ["OSFA"], colors: ["Navy"] }
];

/* ---- stubs ---------------------------------------------------------------- */

function fakeDrive() {
  const folders = new Map();
  let n = 0;
  return {
    async ensureSubfolder(name, parentId) {
      const id = `folder-${name}`;
      folders.set(id, { id, name, parentId });
      return { id, name, webViewLink: `https://drive.test/${id}` };
    },
    async listFilesInFolder() {
      return [];
    },
    async uploadBuffer(file) {
      n += 1;
      return { id: `file-${n}`, name: file.originalname, webViewLink: `https://drive.test/file-${n}` };
    },
    async uploadHtmlDocument(name) {
      n += 1;
      return { id: `doc-${n}`, name, webViewLink: `https://drive.test/doc-${n}` };
    },
    async uploadGeneratedImage(name) {
      n += 1;
      return { id: `img-${n}`, name, webViewLink: `https://drive.test/img-${n}` };
    },
    async downloadFileBuffer(fileId) {
      return { id: fileId, name: "unknown.png", mimeType: "image/png", size: 4, buffer: Buffer.from("art") };
    },
    async exportFileText() {
      return "";
    }
  };
}

function fakePolicy() {
  return {
    ...realPolicy,
    async describeArtwork(file) {
      return `a description of ${file.originalname}`;
    },
    async extractPacketText(file) {
      return `text of ${file.originalname}`;
    },
    async reviewPolicy() {
      return {
        confirmed: [{ topic: "Colors", detail: "Navy.", source: "policy" }],
        missing: [],
        questions: [],
        emailDraft: { subject: `${DEPARTMENT} store — a few questions`, body: "Hi there," },
        suggestedProducts: []
      };
    },
    async descriptionDataFor() {
      return { bullets: ["Preview product"], measurements: null, measurementsHtml: "", note: "", source: "source-product" };
    }
  };
}

function fakeHelium() {
  return {
    ...realHelium,
    async checkAllForms(tag) {
      return realHelium.EXPECTED_FORM_LABELS.map((label, i) => ({
        id: `form${i}`,
        label,
        public: true,
        present: false,
        exactCase: false,
        index: 3,
        insertAfter: "Suisun City Fire Department",
        insertBefore: "Vallejo Fire Department",
        total: 12,
        similar: [],
        checkedAt: new Date().toISOString(),
        tag
      }));
    }
  };
}

function fakeMenu() {
  const item = (title, i) => ({ id: `gid://shopify/MenuItem/${700 + i}`, title, type: "COLLECTION", url: `/collections/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, resourceId: `gid://shopify/Collection/${700 + i}`, tags: [], items: [] });
  return {
    id: "gid://shopify/Menu/1",
    handle: "megamenu",
    title: "Mega Menu",
    items: [
      { id: "gid://shopify/MenuItem/1", title: "Home", type: "FRONTPAGE", url: "/", resourceId: null, tags: [], items: [] },
      { id: "gid://shopify/MenuItem/9", title: "Store", type: "COLLECTIONS", url: "/collections", resourceId: null, tags: [], items: ["Bishop Fire Department", "Ripon Fire District", "Suisun City Fire Department", "FN Simple Merch"].map(item) }
    ]
  };
}

/* A small Shopify that remembers: collections by title and every product
   made in them, with their variants, prices and pictures. The Departments
   page (list, one department, Edit) reads it, and "Update product" adds to
   it — an option, variants, images — so the whole edit-an-existing-product
   path can be clicked through here. */
function fakeShopify() {
  const collections = new Map(); // legacy id → { id, gid, title, handle }
  const products = new Map(); // legacy id → live product
  let nextProduct = 900;
  let nextVariant = 1;
  let nextMedia = 1;
  const legacy = (id) => String(id || "").replace(/^gid:\/\/shopify\/\w+\//, "");
  const optionValue = (variant, name) => variant.selectedOptions.find((o) => o.name === name)?.value;
  const optionsOf = (product) =>
    product.optionNames.map((name) => ({ name, values: [...new Set(product.variants.map((v) => optionValue(v, name)).filter(Boolean))] }));
  const snapshot = (product) => ({
    id: product.id,
    gid: product.gid,
    title: product.title,
    status: product.status,
    vendor: product.vendor,
    tags: product.tags,
    productType: product.productType,
    options: optionsOf(product),
    variants: product.variants.map((v) => ({ id: v.id, sku: v.sku, price: v.price, inventoryPolicy: "CONTINUE", selectedOptions: v.selectedOptions, image: v.mediaId ? { url: `/preview-media/${legacy(v.mediaId)}` } : null })),
    media: product.media.map((m) => ({ id: m.id, url: `/preview-media/${legacy(m.id)}`, alt: m.alt })),
    collections: product.collectionIds.map((id) => ({ id, gid: `gid://shopify/Collection/${id}`, title: collections.get(id)?.title || "" }))
  });
  const attach = (product, images) =>
    images.map((image) => {
      const media = { id: `gid://shopify/MediaImage/${nextMedia++}`, alt: image.alt || "", buffer: image.buffer };
      product.media.push(media);
      for (const variantId of image.variantIds || []) {
        const variant = product.variants.find((v) => v.id === variantId);
        if (variant && !variant.mediaId) variant.mediaId = media.id;
      }
      return media.id;
    });

  return {
    // Read by the preview's own /api/collections and /api/products routes.
    preview: {
      collections: () => [...collections.values()],
      productsIn: (collectionId) => [...products.values()].filter((p) => p.collectionIds.includes(String(collectionId))),
      product: (id) => products.get(legacy(id)) || null,
      media: (id) => [...products.values()].flatMap((p) => p.media).find((m) => legacy(m.id) === String(id)) || null,
      // Dan prices a product and makes it Active once it is built.
      launch(id, priceBySize, fallback) {
        const product = products.get(legacy(id));
        if (!product) return;
        product.status = "ACTIVE";
        for (const variant of product.variants) variant.price = priceBySize[optionValue(variant, rules.OPTION_SIZE)] || fallback;
      },
      optionsOf
    },
    collectionAdminUrl: (id) => `https://admin.test/collections/${id}`,
    async storeProducts(collectionId) {
      const collection = collections.get(legacy(collectionId));
      if (!collection) throw new Error(`Collection ${collectionId} was not found in Shopify.`);
      return {
        ...collection,
        products: [...products.values()]
          .filter((p) => p.collectionIds.includes(collection.id))
          .map((p) => ({ gid: p.gid, id: p.id, title: p.title, status: p.status, tags: p.tags, vendor: p.vendor, productType: p.productType, sku: p.variants[0]?.sku || "", otherCollections: [] }))
      };
    },
    async allProductTags() {
      return ["VAC", "BSH", "Embroidered", "Uniform"];
    },
    async resolveStyleNumber(brand, style) {
      return style;
    },
    async storeProfile(style) {
      const garment = GARMENTS.find((g) => g.styleNumber === String(style).toUpperCase());
      return garment ? { styleNumber: garment.styleNumber, name: garment.label, vendor: "Non Stock Item", colorCodes: ["NVY"], sampleSize: 4 } : null;
    },
    async masterGarments() {
      return GARMENTS;
    },
    async ensureDepartmentCollection(input) {
      let collection = [...collections.values()].find((c) => c.title === input.title);
      if (!collection) {
        const id = String(111 + collections.size * 111);
        collection = { id, gid: `gid://shopify/Collection/${id}`, title: input.title, handle: input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") };
        collections.set(id, collection);
      }
      return { ...collection, descriptionHtml: input.descriptionHtml, image: null, created: true, warnings: [] };
    },
    async findSourceProduct(styleNumber) {
      return { id: "gid://shopify/Product/1", legacyId: "1", title: `Master (${styleNumber})`, kind: "master", url: "https://admin.test/products/1", tags: ["Master Reference"] };
    },
    async readProductForDuplication() {
      return {
        id: "gid://shopify/Product/1",
        legacyId: "1",
        title: "Master",
        descriptionHtml: "<p>Master</p>",
        productType: "Job Shirts",
        vendor: "5.11 Tactical",
        tags: ["Master Reference"],
        options: [],
        variantDefaults: { taxable: true, requiresShipping: true, tracked: false, weight: null },
        descriptionParts: { bullets: [], measurementsHtml: "", brandLine: "" },
        mediaCount: 0
      };
    },
    async duplicateProduct(sourceId, title) {
      const id = String(nextProduct++);
      products.set(id, { id, gid: `gid://shopify/Product/${id}`, title, status: "DRAFT", vendor: "", tags: [], productType: "", descriptionHtml: "", optionNames: [], variants: [], media: [], collectionIds: [] });
      return { id: `gid://shopify/Product/${id}`, legacyId: id, title };
    },
    async setProduct(input) {
      const product = products.get(legacy(input.productId));
      if (!product) throw new Error(`Product ${input.productId} does not exist.`);
      Object.assign(product, {
        title: input.title,
        vendor: input.vendor,
        tags: input.tags,
        productType: input.productType,
        descriptionHtml: input.descriptionHtml,
        status: "DRAFT",
        optionNames: input.options.map((o) => o.name),
        collectionIds: (input.collectionGids || []).map(legacy),
        variants: input.variants.map((variant) => ({
          id: `gid://shopify/ProductVariant/${nextVariant++}`,
          sku: variant.sku,
          price: "0.00",
          mediaId: "",
          selectedOptions: variant.optionValues.map((ov) => ({ name: ov.optionName, value: ov.name }))
        }))
      });
      return {
        id: product.gid,
        legacyId: product.id,
        url: `https://admin.test/products/${product.id}`,
        title: product.title,
        variants: product.variants.map((v) => ({ id: v.id, sku: v.sku, title: v.sku, selectedOptions: v.selectedOptions })),
        removedCollections: [],
        warnings: [],
        collectionsFallback: false
      };
    },
    async attachMockups(id, images) {
      const product = products.get(legacy(id));
      return product ? attach(product, images) : [];
    },
    async linkVariantImages(id, links) {
      const product = products.get(legacy(id));
      for (const link of links) {
        const variant = product?.variants.find((v) => v.id === link.variantId);
        if (variant) variant.mediaId = link.mediaId;
      }
      return links.length;
    },
    async replaceProductImages(id, images) {
      const product = products.get(legacy(id));
      const removed = product.media.length;
      product.media = [];
      for (const variant of product.variants) variant.mediaId = "";
      attach(product, images);
      return { removed, added: images.length, variants: snapshot(product).variants, title: product.title };
    },
    async productVariantDetail(id) {
      const product = products.get(legacy(id));
      if (!product) throw new Error(`Product ${id} was not found in Shopify.`);
      return product.variants.map((v) => ({ id: v.id, sku: v.sku, price: v.price, compareAtPrice: null, taxable: true, inventoryPolicy: "CONTINUE", selectedOptions: v.selectedOptions, mediaId: v.mediaId || "", tracked: false, requiresShipping: true, weight: null }));
    },
    async addProductOption(id, option) {
      const product = products.get(legacy(id));
      product.optionNames.push(option.name);
      for (const variant of product.variants) variant.selectedOptions = [...variant.selectedOptions, { name: option.name, value: option.values[0] }];
      return optionsOf(product);
    },
    async addProductVariants(id, variants) {
      const product = products.get(legacy(id));
      // Slow enough to see the progress view; a real run is far slower.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const made = variants.map((variant) => ({
        id: `gid://shopify/ProductVariant/${nextVariant++}`,
        sku: variant.sku,
        price: variant.price,
        mediaId: "",
        selectedOptions: variant.optionValues.map((ov) => ({ name: ov.optionName, value: ov.name }))
      }));
      product.variants.push(...made);
      return made.map((v) => ({ id: v.id, sku: v.sku, title: v.sku, selectedOptions: v.selectedOptions }));
    },
    async collectionSnapshot(id) {
      const collection = collections.get(legacy(id)) || [...collections.values()][0];
      return { ...collection, descriptionHtml: rules.collectionDescriptionHtml(), image: null, productsCount: 0, products: [] };
    },
    async productSnapshot(id) {
      const product = products.get(legacy(id));
      return product ? snapshot(product) : null;
    },
    async readMegaMenu() {
      return { available: true, menu: fakeMenu() };
    },
    proposeMegaMenuInsert(menu, { title } = {}) {
      return { newItem: { title, type: "COLLECTION", url: "/collections/1-east-whittier-fire-department" }, index: 3, insertAfter: "Suisun City Fire Department", insertBefore: "FN Simple Merch", alreadyPresent: false, storeItemId: "gid://shopify/MenuItem/9" };
    },
    async applyMegaMenuInsert() {
      return { applied: true, alreadyPresent: false, menuItemId: "gid://shopify/MenuItem/50", index: 3 };
    },
    async verifyMegaMenu() {
      return { available: true, present: false, index: -1, before: "Suisun City Fire Department", after: null };
    },
    async removeMegaMenuItemsFor() {
      return { available: true, removed: 0 };
    }
  };
}

// A flat colour per garment colour, a shade lighter for each further Style,
// so a new colour or a new logo is visibly a new picture.
const SWATCHES = { navy: [34, 51, 85], black: [28, 28, 30], red: [150, 30, 36], charcoal: [70, 74, 80], "royal blue": [30, 70, 160], white: [236, 236, 236] };

function fakeMockups() {
  return {
    async renderProductMockups({ product, departmentCode }) {
      const out = [];
      // A row sold in Styles (other logos) gets a front and back per Style, as the real renderer does.
      const styles = (product.styles || []).filter((s) => s.name).map((s) => s.name);
      for (const color of product.colors || []) {
        for (const style of styles.length ? styles : [null]) {
          for (const face of ["front", "back"]) {
            const base = SWATCHES[String(color.name).toLowerCase()] || [90, 90, 110];
            const lift = (style ? styles.indexOf(style) : 0) * 38 + (face === "back" ? 12 : 0);
            const [r, g, b] = base.map((c) => Math.min(255, c + lift));
            out.push({
              color: color.name,
              colorCode: color.code,
              style,
              face,
              buffer: await sharp({ create: { width: 200, height: 200, channels: 3, background: { r, g, b } } }).png().toBuffer(),
              fileName: rules.mockupFileName({ departmentCode, styleNumber: product.styleNumber, colorCode: color.code, style, face }),
              path: "render",
              base: "photo",
              warnings: [],
              verified: { ok: true, notes: "preview" }
            });
          }
        }
      }
      // The real renderer takes about a minute a picture.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return out;
    },
    async renderBanner() {
      return { buffer: await sharp({ create: { width: 320, height: 180, channels: 3, background: "#ffffff" } }).png().toBuffer(), background: "#ffffff", logo: { width: 1600, height: 1200 } };
    }
  };
}

function fakeLocksmith() {
  const real = require("../locksmith");
  return {
    ...real,
    configured: () => false,
    async checkPublicAccess() {
      return { checked: true, collectionUrl: "https://fnsimple.com/collections/preview", publicProductLinks: 0, closedToPublic: true, opensWithSecretLink: true, reason: "" };
    }
  };
}

/* ---- the seeded records ---------------------------------------------------- */

async function png(width, height, background) {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
}

const file = (name, buffer) => ({ fieldname: "artwork", originalname: name, mimetype: "image/png", buffer, size: buffer.length });

async function seed() {
  store.setBlobAdapter(store.memoryBlobAdapter());
  menuGuard.setStorage(menuGuard.memoryStorage());
  linkBook.setBookAdapter(linkBook.memoryBookAdapter());
  referenceTables.invalidate();
  const shopify = fakeShopify();
  agent.setDeps({
    shopify,
    drive: fakeDrive(),
    policy: fakePolicy(),
    helium: fakeHelium(),
    mockups: fakeMockups(),
    locksmith: fakeLocksmith(),
    catalog: {
      async productExists(id) {
        return Boolean(shopify.preview.product(id));
      },
      async getProduct(id) {
        const product = shopify.preview.product(id);
        return product ? { id: product.id, gid: product.gid, title: product.title, descriptionHtml: product.descriptionHtml, status: product.status, tags: product.tags, vendor: product.vendor } : null;
      }
    },
    shopifyCore: { shopifyConnected: () => true, adminProductUrl: (id) => `https://admin.test/products/${id}` },
    auth: { googleConnected: () => true }
  });
  await referenceTables.upsertRows(
    "department-codes",
    [
      { code: CODE, agency: DEPARTMENT, city: "Whittier", state: "CA" },
      { code: BUILT_CODE, agency: BUILT_DEPARTMENT, city: "Harbor", state: "CT" }
    ],
    { source: "preview" }
  );

  const created = await agent.createOnboarding({
    payload: { departmentName: DEPARTMENT, state: "CA" },
    files: {
      artwork: [
        file(`${CODE}-F01 agent.png`, await png(600, 600, "#c8102e")),
        file(`${CODE}-B02 agent.png`, await png(900, 600, "#1f3a93")),
        file(`${CODE}-E01 agent.png`, await png(600, 600, "#f2b705"))
      ]
    }
  });
  await agent.runSetup(created.id, { by: "preview" });
  const art = (created.packet?.files || []).filter((f) => f.kind === "artwork");
  const asset = (name) => art.find((f) => f.name === name)?.assetId || "";

  // Dan's row as he had it when the video starts.
  await agent.saveProducts(
    created.id,
    [
      {
        id: "p1",
        brand: "5.11 Tactical",
        styleNumber: "72534",
        type: "Job Shirt",
        title: "5.11 1/4 Zip Job Shirt",
        colors: ["Navy"],
        sizes: ["S", "M", "L", "XL", "2XL", "3XL"],
        decorationMethod: "embroidery",
        decorationCodes: "E02/E01/B02",
        placements: { E02: "F", E01: "B" },
        logoMap: { E02: asset(`${CODE}-F01 agent.png`), E01: asset(`${CODE}-B02 agent.png`), B02: asset(`${CODE}-B02 agent.png`) },
        fulfillment: "Non Stock Item"
      }
    ],
    { by: "preview" }
  );
  const builtId = await seedBuiltStore(shopify);
  return { id: created.id, builtId, shopify };
}

/* A second store that is BUILT, priced and live — what Noroton Heights was
   on 2026-11-20 when it sent two more logos: one colour and one logo per
   product. Its Departments page is where "Add colours, sizes or logos" and
   "Add a logo to products" are tried. Two products were made by hand and are
   not on the agent's record: one the agent can read back off its SKUs, one
   (a single "Title" option) it has to refuse. */
async function seedBuiltStore(shopify) {
  const created = await agent.createOnboarding({
    payload: { departmentName: BUILT_DEPARTMENT, state: "CT" },
    files: {
      artwork: [
        file(`${BUILT_CODE}-crest.png`, await png(600, 600, "#b3122b")),
        file(`${BUILT_CODE}-B01 back.png`, await png(900, 600, "#1f3a93")),
        file(`${BUILT_CODE}-engine-2.png`, await png(600, 600, "#f2b705")),
        file(`${BUILT_CODE}-truck-1.png`, await png(600, 600, "#2e8b57"))
      ]
    }
  });
  await agent.runSetup(created.id, { by: "preview" });
  const art = (created.packet?.files || []).filter((f) => f.kind === "artwork");
  const crest = art.find((f) => /crest/.test(f.name))?.assetId || "";
  const back = art.find((f) => /back/.test(f.name))?.assetId || "";
  await agent.saveProducts(
    created.id,
    [
      { id: "p1", brand: "5.11 Tactical", styleNumber: "72534", type: "Job Shirt", title: "5.11 1/4 Zip Job Shirt", colors: ["Black"], sizes: ["S", "M", "L", "XL", "2XL", "3XL"], decorationMethod: "embroidery", decorationCodes: "E01", placements: { E01: "F" }, logoMap: { E01: crest }, fulfillment: "Non Stock Item" },
      { id: "p2", brand: "5.11 Tactical", styleNumber: "72534", type: "Job Shirt", title: "5.11 1/4 Zip Job Shirt", colors: ["Navy"], sizes: ["S", "M", "L", "XL", "2XL", "3XL"], decorationMethod: "embroidery", decorationCodes: "E01", placements: { E01: "F" }, logoMap: { E01: crest }, fulfillment: "Non Stock Item" },
      { id: "p3", brand: "Next Level", styleNumber: "NL3600", type: "T-shirt", title: "Next Level Cotton Tee", colors: ["Navy"], sizes: ["S", "M", "L", "XL", "2XL"], decorationMethod: "print", decorationCodes: "F01/B01", logoMap: { F01: crest, B01: back }, fulfillment: "One Week Item" },
      { id: "p4", brand: "Richardson", styleNumber: "R112", type: "Hat", title: "Richardson Trucker", colors: ["Navy"], sizes: ["OSFA"], decorationMethod: "embroidery", decorationCodes: "E01", placements: { E01: "F" }, logoMap: { E01: crest }, fulfillment: "Non Stock Item" }
    ],
    { by: "preview" }
  );
  await agent.startBuild(created.id, { by: "preview", wait: true });
  const record = await store.getOnboarding(created.id);
  for (const row of record.products) {
    const upcharge = row.styleNumber === "72534" ? { "2XL": "112.00", "3XL": "114.00" } : row.styleNumber === "NL3600" ? { "2XL": "24.00" } : {};
    shopify.preview.launch(row.shopify.gid, upcharge, row.styleNumber === "72534" ? "107.00" : row.styleNumber === "NL3600" ? "22.00" : "26.00");
  }

  // Made by hand in Shopify, in this store's collection.
  const collectionId = record.collection.id;
  const byHand = async (title, productType, options, variants) => {
    const { legacyId } = await shopify.duplicateProduct("1", title);
    const product = shopify.preview.product(legacyId);
    Object.assign(product, {
      status: "ACTIVE",
      vendor: "Non Stock Item",
      tags: [BUILT_CODE],
      productType,
      optionNames: options,
      collectionIds: [collectionId],
      variants: variants.map((v, i) => ({ id: `gid://shopify/ProductVariant/h${legacyId}-${i}`, sku: v.sku, price: v.price, mediaId: "", selectedOptions: v.options.map(([name, value]) => ({ name, value })) }))
    });
  };
  await byHand(
    "Port Authority Beanie",
    "Hats",
    ["Color", "Size"],
    ["Navy", "Black"].map((color) => ({ sku: `CP90-OSFA-${color === "Navy" ? "NVY" : "BLK"}-${BUILT_CODE}-E01`, price: "18.00", options: [["Color", color], ["Size", "OSFA"]] }))
  );
  await byHand("Challenge Coin", "Accessories", ["Title"], [{ sku: "COIN-01", price: "12.00", options: [["Title", "Default Title"]] }]);
  return created.id;
}

/* ---- the app ---------------------------------------------------------------- */

/* The Departments page reads these three from the real server (catalog.js).
   Here they answer from the fake store, in catalog.js's shapes. */
function departmentRoutes(app, shopify) {
  const prices = (product) => product.variants.map((v) => Number(v.price)).filter(Number.isFinite);
  const firstImage = (product) => (product.media[0] ? `/preview-media/${product.media[0].id.split("/").pop()}` : null);
  const summary = (product) => ({
    id: product.id,
    gid: product.gid,
    title: product.title,
    status: product.status,
    productType: product.productType,
    vendor: product.vendor,
    imageUrl: firstImage(product),
    imageAlt: product.media[0]?.alt || "",
    variantCount: product.variants.length,
    minPrice: prices(product).length ? Math.min(...prices(product)).toFixed(2) : null,
    maxPrice: prices(product).length ? Math.max(...prices(product)).toFixed(2) : null
  });
  app.get("/api/collections", (req, res) =>
    res.json({ collections: shopify.preview.collections().map((c) => ({ id: c.id, gid: c.gid, title: c.title, handle: c.handle, imageUrl: null, productCount: shopify.preview.productsIn(c.id).length })) })
  );
  app.get("/api/collections/:id", (req, res) => {
    const collection = shopify.preview.collections().find((c) => c.id === req.params.id);
    if (!collection) return res.status(404).json({ error: "Collection not found." });
    const products = shopify.preview.productsIn(collection.id).sort((a, b) => a.title.localeCompare(b.title));
    res.json({ collection: { ...collection, description: "", imageUrl: null, productCount: products.length }, products: products.map(summary) });
  });
  app.get("/api/products/:id", (req, res) => {
    const product = shopify.preview.product(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found." });
    res.json({
      product: {
        ...summary(product),
        handle: "",
        descriptionHtml: product.descriptionHtml,
        tags: product.tags,
        onlineStoreUrl: null,
        currency: "USD",
        options: shopify.preview.optionsOf(product).map((o, i) => ({ ...o, position: i + 1 })),
        images: product.media.map((m) => ({ id: m.id, url: `/preview-media/${m.id.split("/").pop()}`, alt: m.alt })),
        variantSample: product.variants.slice(0, 100).map((v) => ({ id: v.id, title: v.sku, sku: v.sku, price: v.price, options: v.selectedOptions })),
        collections: []
      }
    });
  });
  app.patch("/api/products/:id", (req, res) => res.status(400).json({ error: "The preview does not save product edits; this drawer's Save writes to Shopify on the real server." }));
  app.get("/preview-media/:id", (req, res) => {
    const media = shopify.preview.media(req.params.id);
    if (!media?.buffer) return res.status(404).end();
    res.set("Content-Type", "image/png").send(media.buffer);
  });
}

async function main() {
  const { id, builtId, shopify } = await seed();
  const built = await store.getOnboarding(builtId);
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const openGate = (req, res, next) => next();
  // The garment picker reads the live store's masters; here it reads the list above.
  app.get("/api/onboardings/garments", (req, res) => res.json({ garments: GARMENTS }));
  departmentRoutes(app, shopify);
  app.use("/api", createOnboardingRouter({ requireAdminToken: openGate, upload: multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 50 } }) }));
  app.get("/api/platform/status", (req, res) => res.json({ ok: true, preview: true }));
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));
  app.listen(PORT, () => {
    console.log(`Onboarding console preview (nothing real behind it):`);
    console.log(`  http://127.0.0.1:${PORT}/#/onboarding/${id}          a record at the Products step`);
    console.log(`  http://127.0.0.1:${PORT}/#/departments/${built.collection.id}   a built, live store (edit a product, add a logo)`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

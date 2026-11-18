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
const COLLECTION_GID = "gid://shopify/Collection/111";
const PRODUCT_GID = "gid://shopify/Product/999";

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

function fakeShopify() {
  let lastSet = null;
  return {
    collectionAdminUrl: (id) => `https://admin.test/collections/${id}`,
    async storeProducts() {
      return { title: `1. ${DEPARTMENT}`, id: "111", gid: COLLECTION_GID, handle: "1-east-whittier-fire-department", products: [] };
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
      return { id: "111", gid: COLLECTION_GID, title: input.title, handle: "1-east-whittier-fire-department", descriptionHtml: input.descriptionHtml, image: null, created: true, warnings: [] };
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
      return { id: PRODUCT_GID, legacyId: "999", title };
    },
    async setProduct(input) {
      lastSet = input;
      return {
        id: PRODUCT_GID,
        legacyId: "999",
        url: "https://admin.test/products/999",
        title: input.title,
        variants: input.variants.map((variant, i) => ({ id: `gid://shopify/ProductVariant/${i + 1}`, sku: variant.sku, title: variant.sku, selectedOptions: variant.optionValues.map((ov) => ({ name: ov.optionName, value: ov.name })) })),
        removedCollections: [],
        warnings: [],
        collectionsFallback: false
      };
    },
    async attachMockups(id, images) {
      return images.map((_, i) => `gid://shopify/MediaImage/${i + 1}`);
    },
    async collectionSnapshot() {
      return { id: "111", gid: COLLECTION_GID, title: `1. ${DEPARTMENT}`, handle: "1-east-whittier-fire-department", descriptionHtml: rules.collectionDescriptionHtml(), image: null, productsCount: 0, products: [] };
    },
    async productSnapshot() {
      return lastSet ? { id: "999", gid: PRODUCT_GID, title: lastSet.title, status: "DRAFT", vendor: lastSet.vendor, tags: lastSet.tags, productType: lastSet.productType, options: lastSet.options, variants: [], media: [], collections: [] } : null;
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

function fakeMockups() {
  return {
    async renderProductMockups({ product, departmentCode }) {
      const out = [];
      // A row sold in Styles (other logos) gets a front and back per Style, as the real renderer does.
      const styles = (product.styles || []).filter((s) => s.name).map((s) => s.name);
      for (const color of product.colors || []) {
        for (const style of styles.length ? styles : [null]) {
          for (const face of ["front", "back"]) {
            out.push({
              color: color.name,
              colorCode: color.code,
              style,
              face,
              buffer: await sharp({ create: { width: 200, height: 200, channels: 3, background: "#223355" } }).png().toBuffer(),
              fileName: rules.mockupFileName({ departmentCode, styleNumber: product.styleNumber, colorCode: color.code, style, face }),
              path: "render",
              base: "photo",
              warnings: [],
              verified: { ok: true, notes: "preview" }
            });
          }
        }
      }
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

/* ---- the seeded record ----------------------------------------------------- */

async function png(width, height, background) {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
}

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
    catalog: { async productExists() { return true; }, async getProduct() { return { id: "999", gid: PRODUCT_GID, title: "preview", descriptionHtml: "", status: "DRAFT", tags: [], vendor: "" }; } },
    shopifyCore: { shopifyConnected: () => true },
    auth: { googleConnected: () => true }
  });
  await referenceTables.upsertRows("department-codes", [{ code: CODE, agency: DEPARTMENT, city: "Whittier", state: "CA" }], { source: "preview" });

  const file = (name, buffer) => ({ fieldname: "artwork", originalname: name, mimetype: "image/png", buffer, size: buffer.length });
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
  return created.id;
}

/* ---- the app ---------------------------------------------------------------- */

async function main() {
  const id = await seed();
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const openGate = (req, res, next) => next();
  // The garment picker reads the live store's masters; here it reads the list above.
  app.get("/api/onboardings/garments", (req, res) => res.json({ garments: GARMENTS }));
  app.use("/api", createOnboardingRouter({ requireAdminToken: openGate, upload: multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 50 } }) }));
  app.get("/api/platform/status", (req, res) => res.json({ ok: true, preview: true }));
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));
  app.listen(PORT, () => {
    console.log(`Onboarding console preview (nothing real behind it):`);
    console.log(`  http://127.0.0.1:${PORT}/#/onboarding/${id}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

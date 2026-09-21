const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const multer = require("multer");

const agent = require("../onboardingAgent");
const store = require("../onboardingStore");
const referenceTables = require("../referenceTables");
const rules = require("../onboardingRules");
const realPolicy = require("../onboardingPolicy");
const realHelium = require("../helium");
const createOnboardingRouter = require("../onboardingRoutes");

/*
 * No blob storage, no Shopify, no Drive, no keys: the record store runs on
 * onboardingStore's in-memory adapter, the reference tables fall back to their
 * seeds (platformBlob is unconfigured), and every other collaborator is a fake
 * injected with setDeps(). Anything that tried to reach the network would
 * throw before it got there.
 */
delete process.env.AZURE_STORAGE_CONNECTION_STRING;
delete process.env.OPENAI_API_KEY;
delete process.env.AZURE_OPENAI_ENDPOINT;
delete process.env.LOCKSMITH_ACCESS_TOKEN; // §7 falls back to the checklist
process.env.GDRIVE_PARENT_FOLDER_ID = "parent-departments";
process.env.GDRIVE_OMNI_PRINTER_FOLDER_ID = "parent-omni";
process.env.SHOPIFY_STOREFRONT_DOMAIN = "fnsimple.com";

const DEPARTMENT = "Vacaville Fire Department";
const COLLECTION_TITLE = "1. Vacaville Fire Department";
const COLLECTION_GID = "gid://shopify/Collection/111";
const PRODUCT_GID = "gid://shopify/Product/999";

/* ---------------------------------------------------------------------------
   Fakes
   ------------------------------------------------------------------------- */

function fakeDrive({ productionFiles = [] } = {}) {
  const calls = { uploads: [], docs: [], images: [], downloads: [] };
  const folders = new Map();
  const drive = {
    calls,
    folders,
    async ensureSubfolder(name, parentId) {
      const id = `folder-${name}`;
      folders.set(id, { id, name, parentId });
      return { id, name, webViewLink: `https://drive.test/${id}` };
    },
    async listFilesInFolder(folderId) {
      if (folderId === `folder-${rules.productionFolderName(DEPARTMENT, "VAC")}`) {
        return productionFiles.map((name, i) => ({ id: `print-${i}`, name, mimeType: "image/png", modifiedTime: "2026-09-20T00:00:00.000Z" }));
      }
      return [];
    },
    async uploadBuffer(file, folderId) {
      calls.uploads.push({ name: file.originalname, folderId });
      return { id: `file-${calls.uploads.length}`, name: file.originalname, webViewLink: `https://drive.test/file-${calls.uploads.length}` };
    },
    async uploadHtmlDocument(name, html, folderId) {
      calls.docs.push({ name, folderId, html });
      return { id: `doc-${calls.docs.length}`, name, webViewLink: `https://drive.test/doc-${calls.docs.length}` };
    },
    async uploadGeneratedImage(name, buffer, folderId) {
      calls.images.push({ name, folderId, bytes: buffer.length });
      return { id: `img-${calls.images.length}`, name, webViewLink: `https://drive.test/img-${calls.images.length}` };
    },
    async downloadFileBuffer(fileId) {
      calls.downloads.push(fileId);
      const index = Number(String(fileId).replace("print-", ""));
      const name = productionFiles[index] || "unknown.png";
      return { id: fileId, name, mimeType: "image/png", size: 4, buffer: Buffer.from(`art:${name}`) };
    },
    async exportFileText() {
      return "";
    }
  };
  return drive;
}

function fakePolicy(overrides = {}) {
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
        confirmed: [{ topic: "Colors", detail: "Navy and Midnight Navy.", source: "policy" }],
        missing: [{ topic: "Logo size", detail: "The policy never gives a logo size." }],
        questions: ["How big should the chest logo be?"],
        emailDraft: { subject: `${DEPARTMENT} store — a few questions`, body: "Hi there," },
        suggestedProducts: []
      };
    },
    async descriptionDataFor() {
      return { bullets: ["100% combed ring-spun cotton"], measurements: null, measurementsHtml: "", note: "", source: "source-product" };
    },
    ...overrides
  };
}

function fakeHelium({ present = false } = {}) {
  return {
    ...realHelium,
    async checkAllForms(tag) {
      return realHelium.EXPECTED_FORM_LABELS.map((label, i) => ({
        id: `form${i}`,
        label,
        public: true,
        present,
        exactCase: present,
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

/* The Shopify layer: records every call so the tests can assert on the exact
   input productSet / attachMockups received. */
/* megaMenuAvailable defaults to true: the app's token carries
   write_online_store_navigation, so a suite that defaults to "no scope" tests
   a store we do not run. menuTitles is the live menu — verifyMegaMenu answers
   from it, so an item nobody inserted cannot be "verified". */
function fakeShopify({ megaMenuAvailable = true, order = [], liveProducts = 0, menuTitles = [] } = {}) {
  const liveMenuTitles = [...menuTitles];
  const calls = { setProduct: [], attachMockups: [], duplicate: [], collection: [] };
  let lastSet = null;
  const shopify = {
    calls,
    collectionAdminUrl: (id) => `https://admin.test/collections/${id}`,
    async allProductTags() {
      return ["VAC", "BSH", "Embroidered", "Uniform"];
    },
    async ensureDepartmentCollection(input) {
      order.push("collection");
      calls.collection.push(input);
      return {
        id: "111",
        gid: COLLECTION_GID,
        title: input.title,
        handle: "1-vacaville-fire-department",
        descriptionHtml: input.descriptionHtml,
        image: input.bannerBuffer ? { url: "https://cdn.test/banner.png", width: 3584, height: 2048 } : null,
        created: true,
        warnings: []
      };
    },
    async findSourceProduct(styleNumber) {
      return { id: "gid://shopify/Product/1", legacyId: "1", title: `Next Level Cotton Tee (${styleNumber})`, kind: "master", url: "https://admin.test/products/1", tags: ["Master Reference"] };
    },
    async readProductForDuplication() {
      return {
        id: "gid://shopify/Product/1",
        legacyId: "1",
        title: "Next Level Cotton Tee (NL3600)",
        descriptionHtml: "<p>Next Level (NL3600)</p><ul><li>100% cotton</li></ul>",
        productType: "Tees & Tanks",
        vendor: "Next Level",
        tags: ["Master Reference"],
        options: [],
        variantDefaults: { taxable: true, requiresShipping: true, tracked: false, weight: null },
        descriptionParts: { bullets: ["100% cotton"], measurementsHtml: "", brandLine: "Next Level (NL3600)" },
        mediaCount: 2
      };
    },
    async duplicateProduct(sourceId, title) {
      calls.duplicate.push({ sourceId, title });
      return { id: PRODUCT_GID, legacyId: "999", title };
    },
    async setProduct(input) {
      order.push("product");
      calls.setProduct.push(input);
      lastSet = input;
      return {
        id: PRODUCT_GID,
        legacyId: "999",
        url: "https://admin.test/products/999",
        title: input.title,
        variants: input.variants.map((variant, i) => ({
          id: `gid://shopify/ProductVariant/${i + 1}`,
          sku: variant.sku,
          title: variant.sku,
          selectedOptions: variant.optionValues.map((ov) => ({ name: ov.optionName, value: ov.name }))
        })),
        removedCollections: [],
        warnings: [],
        collectionsFallback: false
      };
    },
    async attachMockups(id, images) {
      calls.attachMockups.push({ id, images });
      return images.map((_, i) => `gid://shopify/MediaImage/${i + 1}`);
    },
    async collectionSnapshot() {
      return {
        id: "111",
        gid: COLLECTION_GID,
        title: COLLECTION_TITLE,
        handle: "1-vacaville-fire-department",
        descriptionHtml: rules.collectionDescriptionHtml(),
        image: { url: "https://cdn.test/banner.png", width: 3584, height: 2048 },
        productsCount: 1,
        /* §9.2 keeps real products Draft, and a Draft product renders nowhere —
           so the from-outside lock proof is only possible after launch. Tests
           that exercise that proof pass liveProducts to say the store is live. */
        products: Array.from({ length: liveProducts }, (_, i) => ({ id: String(i + 1), gid: PRODUCT_GID, title: "Live product", status: "ACTIVE", tags: [], vendor: "", variantCount: 1 }))
      };
    },
    async productSnapshot() {
      if (!lastSet) return null;
      return {
        id: "999",
        gid: PRODUCT_GID,
        title: lastSet.title,
        status: "DRAFT",
        vendor: lastSet.vendor,
        tags: lastSet.tags,
        productType: lastSet.productType,
        options: lastSet.options,
        variants: lastSet.variants.map((variant, i) => ({
          id: `gid://shopify/ProductVariant/${i + 1}`,
          sku: variant.sku,
          price: "0.00",
          inventoryPolicy: "CONTINUE",
          selectedOptions: variant.optionValues.map((ov) => ({ name: ov.optionName, value: ov.name })),
          image: { url: `https://cdn.test/${variant.sku}.png` }
        })),
        media: lastSet.variants.map((variant, i) => ({ id: `m${i}`, url: `https://cdn.test/${variant.sku}.png` })),
        collections: [{ id: "111", gid: COLLECTION_GID, title: COLLECTION_TITLE }]
      };
    },
    async readMegaMenu() {
      if (!megaMenuAvailable) return { available: false, accessDenied: true, reason: "Access denied to menus." };
      return { available: true, menu: { id: "gid://shopify/Menu/1", handle: "megamenu", title: "Mega Menu", items: [] } };
    },
    // Echoes the title it is asked for, so a caller that asks for the wrong
    // one (the collection's "N." ordinal) shows up in the live menu below.
    proposeMegaMenuInsert(menu, { title } = {}) {
      return { newItem: { title, type: "COLLECTION", url: "/collections/1-vacaville-fire-department" }, index: 3, insertAfter: "Suisun City Fire Department", insertBefore: "FN Simple Merch", alreadyPresent: false, storeItemId: "gid://shopify/MenuItem/9" };
    },
    async applyMegaMenuInsert(menu, proposal) {
      if (!megaMenuAvailable) throw new Error("Mega Menu is not writable: Access denied to menus.");
      liveMenuTitles.push(proposal.newItem.title);
      return { applied: true, alreadyPresent: false, menuItemId: "gid://shopify/MenuItem/50", index: 3 };
    },
    async verifyMegaMenu(title) {
      if (!megaMenuAvailable) return { available: false, present: false, index: -1, before: null, after: null, reason: "Access denied to menus.", accessDenied: true };
      const index = liveMenuTitles.indexOf(title);
      return { available: true, present: index !== -1, index, before: index > 0 ? liveMenuTitles[index - 1] : "Suisun City Fire Department", after: index === -1 ? null : "FN Simple Merch" };
    },
    // A change made by hand in Shopify admin, which the API never saw.
    addMenuTitleByHand: (title) => liveMenuTitles.push(title),
    liveMenuTitles: () => [...liveMenuTitles],
    lastSetProduct: () => lastSet
  };
  return shopify;
}

function fakeMockups({ base = "photo" } = {}) {
  return {
    async renderProductMockups({ product, departmentCode }) {
      const out = [];
      const styles = (product.styles || []).filter((s) => s.name).map((s) => s.name);
      const styleList = styles.length ? styles : [null];
      for (const color of product.colors || []) {
        for (const style of styleList) {
          for (const face of ["front", "back"]) {
            out.push({
              color: color.name,
              colorCode: color.code,
              style,
              face,
              buffer: Buffer.from(`${color.code}-${style || ""}-${face}`),
              fileName: rules.mockupFileName({ departmentCode, styleNumber: product.styleNumber, colorCode: color.code, style, face }),
              path: "render",
              base,
              warnings: [],
              verified: { ok: true, notes: "artwork visible" }
            });
          }
        }
      }
      return out;
    },
    async renderBanner() {
      return { buffer: Buffer.from("banner"), background: "#ffffff", logo: { width: 1600, height: 1200 } };
    }
  };
}

function fakeCatalog({ descriptionHtml = () => "" } = {}) {
  return {
    async productExists() {
      return true;
    },
    async getProduct() {
      return { id: "999", gid: PRODUCT_GID, title: "tee", descriptionHtml: descriptionHtml(), status: "DRAFT", tags: [], vendor: "" };
    }
  };
}

/* ---------------------------------------------------------------------------
   Harness
   ------------------------------------------------------------------------- */

const PRODUCTION_FILES = ["VAC-F01.png", "VAC-B01.png", "VAC-F02.png"];

/*
 * The real Locksmith module, minus the network: unconfigured (so the build
 * takes the §7 checklist path) and with a canned verdict for the storefront
 * check that final check now makes. Pass `lockAccess` to change the verdict.
 */
function fakeLocksmith(access = {}) {
  const real = require("../locksmith");
  return {
    ...real,
    configured: () => false,
    async checkPublicAccess() {
      return {
        checked: true,
        collectionUrl: "https://fnsimple.com/collections/1-vacaville-fire-department",
        publicProductLinks: 0,
        closedToPublic: true,
        opensWithSecretLink: true,
        reason: "",
        ...access
      };
    }
  };
}

function harness(options = {}) {
  store.setBlobAdapter(store.memoryBlobAdapter());
  referenceTables.invalidate();
  const order = [];
  const shopify = options.shopify || fakeShopify({ order, liveProducts: options.liveProducts || 0, ...(options.shopifyOptions || {}) });
  const drive = options.drive || fakeDrive({ productionFiles: options.productionFiles || PRODUCTION_FILES });
  const deps = {
    shopify,
    drive,
    order,
    policy: options.policy || fakePolicy(),
    helium: options.helium || fakeHelium({ present: false }),
    mockups: options.mockups || fakeMockups(),
    locksmith: options.locksmith || fakeLocksmith(options.lockAccess),
    catalog: options.catalog || fakeCatalog({ descriptionHtml: () => shopify.lastSetProduct()?.descriptionHtml || "" }),
    shopifyCore: { shopifyConnected: () => true },
    auth: { googleConnected: () => true }
  };
  agent.setDeps({
    shopify: deps.shopify,
    drive: deps.drive,
    policy: deps.policy,
    helium: deps.helium,
    mockups: deps.mockups,
    locksmith: deps.locksmith,
    catalog: deps.catalog,
    shopifyCore: deps.shopifyCore,
    auth: deps.auth
  });
  return deps;
}

function packetFile(fieldname, originalname, mimetype = "application/pdf") {
  return { fieldname, originalname, mimetype, buffer: Buffer.from(`bytes of ${originalname}`), size: 12 };
}

const TEE_ROW = {
  id: "p1",
  brand: "Next Level",
  styleNumber: "NL3600",
  type: "T-shirt",
  title: "Next Level Cotton Tee",
  colors: ["Navy", "Midnight Navy"],
  sizes: ["S", "M"],
  styles: [{ decorationCodes: "F01/B01" }, { decorationCodes: "F02/B01" }],
  fulfillment: "Non Stock Item",
  classB: false
};

async function seedVacavilleOnList() {
  await referenceTables.upsertRows("department-codes", [{ code: "VAC", agency: "Vacaville Fire Department", city: "Vacaville", state: "CA" }], { source: "test" });
}

test.afterEach(() => {
  agent.setDeps(null);
  referenceTables.invalidate();
});

/* ---------------------------------------------------------------------------
   Phase 1 — the packet
   ------------------------------------------------------------------------- */

test("createOnboarding stores the packet, reads the policies and roles the artwork", async () => {
  harness();
  const record = await agent.createOnboarding({
    payload: { departmentName: DEPARTMENT, state: "CA", contacts: [{ name: "Chief Ramos", email: "ramos@example.gov" }], notes: "Union store later." },
    files: {
      policies: [packetFile("policies", "uniform-policy.pdf")],
      artwork: [packetFile("artwork", "VFD-scramble.png", "image/png"), packetFile("artwork", "vfd-chest-f01.png", "image/png"), packetFile("artwork", "vfd-back.png", "image/png")]
    },
    by: "dan"
  });

  assert.equal(record.department.name, DEPARTMENT);
  assert.equal(record.department.tag, DEPARTMENT);
  assert.equal(record.status, "packet");
  assert.equal(record.packet.files.length, 4);

  const policyFile = record.packet.files.find((f) => f.kind === "policy");
  assert.equal(policyFile.text, "text of uniform-policy.pdf");
  assert.deepEqual(
    record.packet.files.filter((f) => f.kind === "artwork").map((f) => f.role),
    ["scramble", "chest", "back"]
  );
  assert.match(record.packet.files.find((f) => f.name === "VFD-scramble.png").description, /VFD-scramble\.png/);
  const asset = await store.getAsset(record.id, policyFile.assetId);
  assert.equal(asset.buffer.toString(), "bytes of uniform-policy.pdf");
});

test("defaultArtworkRole follows the §6.3 order (scramble beats chest beats back)", () => {
  assert.equal(agent.defaultArtworkRole("VFD scramble back.png"), "scramble");
  assert.equal(agent.defaultArtworkRole("VAC-F01.png"), "chest");
  assert.equal(agent.defaultArtworkRole("vac-back-logo.png"), "back");
  assert.equal(agent.defaultArtworkRole("random.pdf"), "");
});

/* ---------------------------------------------------------------------------
   Phase 2 — the department code
   ------------------------------------------------------------------------- */

test("runSetup auto-approves a department already on the list and continues into setup", async () => {
  const deps = harness();
  await seedVacavilleOnList();
  const created = await agent.createOnboarding({ payload: { departmentName: DEPARTMENT, state: "CA" }, files: [packetFile("policies", "policy.pdf")] });

  const record = await agent.runSetup(created.id, { by: "dan" });

  assert.equal(record.department.code.value, "VAC");
  assert.equal(record.department.code.source, "list");
  assert.equal(record.department.code.approved, true);
  assert.equal(record.approvals.filter((a) => a.kind === "code").length, 1);

  // §3 both folders, with the Product Images subfolder
  assert.equal(record.drive.departmentFolderId, `folder-${rules.departmentFolderName(DEPARTMENT, "VAC")}`);
  assert.equal(record.drive.productImagesFolderId, "folder-Product Images");
  assert.equal(record.drive.productionFolderId, `folder-${rules.productionFolderName(DEPARTMENT, "VAC")}`);
  assert.deepEqual(record.drive.productionFiles.map((f) => f.name), PRODUCTION_FILES);

  // §3 the packet is saved in the department folder, §4 the review is written
  assert.equal(deps.drive.calls.uploads.length, 1);
  assert.deepEqual(deps.drive.calls.docs.map((d) => d.name), [`Policy Review — ${DEPARTMENT} (VAC)`, `Rep Email Draft — ${DEPARTMENT} (VAC)`]);
  assert.ok(record.policyReview.reviewedAt);
  assert.equal(record.policyReview.emailDraft.subject, `${DEPARTMENT} store — a few questions`);
  assert.equal(record.status, "inputs");
});

test("runSetup proposes codes for a department that is not on the list, and approveCode records it", async () => {
  harness();
  await seedVacavilleOnList();
  const created = await agent.createOnboarding({ payload: { departmentName: "Bahama Fire Department", state: "NC" } });

  const proposed = await agent.runSetup(created.id, { by: "dan" });
  assert.equal(proposed.department.code.approved, false);
  assert.equal(proposed.status, "setup");
  assert.equal(proposed.department.code.candidates[0].code, "BAH");
  assert.ok(proposed.department.code.candidates.some((c) => c.code === "BFD"));

  // A code another agency owns is refused outright.
  await assert.rejects(() => agent.approveCode(created.id, { code: "VAC", by: "dan" }), /already used by "Vacaville Fire Department"/);

  const approved = await agent.approveCode(created.id, { code: "BAH", by: "dan" });
  assert.equal(approved.department.code.value, "BAH");
  assert.equal(approved.department.code.approved, true);
  assert.equal(approved.department.code.source, "proposed");
  assert.deepEqual(
    approved.approvals.map((a) => [a.kind, a.subject, a.by]),
    [["code", "BAH", "dan"]]
  );
  const rows = await referenceTables.departmentCodeRows();
  assert.equal(rows.find((r) => r.code === "BAH").agency, "Bahama Fire Department");
  assert.equal(approved.drive.departmentFolderId, "folder-Bahama Fire Department (BAH)");
});

test("approveCode refuses anything that is not a 3–4 letter code", async () => {
  harness();
  const created = await agent.createOnboarding({ payload: { departmentName: "Bahama Fire Department" } });
  await assert.rejects(() => agent.approveCode(created.id, { code: "B4" }), /3 or 4 letters/);
});

/* ---------------------------------------------------------------------------
   Phase 3 — product rows
   ------------------------------------------------------------------------- */

async function readyForProducts() {
  const deps = harness();
  await seedVacavilleOnList();
  const created = await agent.createOnboarding({
    payload: { departmentName: DEPARTMENT, state: "CA" },
    files: { artwork: [packetFile("artwork", "VFD-scramble.png", "image/png")] }
  });
  await agent.runSetup(created.id, { by: "dan" });
  return { deps, id: created.id };
}

test("saveProducts validates every row, previews the SKUs and proposes an unknown colour", async () => {
  const { id } = await readyForProducts();

  const record = await agent.saveProducts(id, [TEE_ROW, { ...TEE_ROW, id: "p2", styleNumber: "PC61", colors: ["Fire Engine Red"], styles: [{ decorationCodes: "F01" }] }], { by: "dan" });

  const tee = record.products.find((p) => p.id === "p1");
  assert.equal(tee.validation.ok, true);
  assert.deepEqual(tee.validation.errors, []);
  assert.deepEqual(tee.validation.skuPreview, [
    "NL3600-S-NVY-VAC-F01/B01",
    "NL3600-S-NVY-VAC-F02/B01",
    "NL3600-M-NVY-VAC-F01/B01",
    "NL3600-M-NVY-VAC-F02/B01",
    "NL3600-S-MN-VAC-F01/B01",
    "NL3600-S-MN-VAC-F02/B01",
    "NL3600-M-MN-VAC-F01/B01",
    "NL3600-M-MN-VAC-F02/B01"
  ]);

  const red = record.products.find((p) => p.id === "p2");
  assert.equal(red.validation.ok, false);
  assert.match(red.validation.errors.join(" "), /not on the Color Code List/);
  const pending = await referenceTables.pendingProposals("color-codes");
  assert.deepEqual(pending.map((p) => p.row.code), ["FER"]);

  // The blank is remembered for the next department (Part 4).
  const blank = await referenceTables.blankByStyleNumber("NL3600");
  assert.equal(blank.brand, "Next Level");
  assert.equal(blank.fulfillment, rules.VENDOR_NON_STOCK);
});

test("proposeColor approves the code, adds it to the list and re-validates the rows", async () => {
  const { id } = await readyForProducts();
  await agent.saveProducts(id, [{ ...TEE_ROW, id: "p2", styleNumber: "PC61", colors: ["Fire Engine Red"], styles: [{ decorationCodes: "F01" }] }], { by: "dan" });

  const record = await agent.proposeColor(id, { color: "Fire Engine Red", code: "FER", by: "dan" });

  assert.equal(record.products[0].validation.ok, true);
  assert.equal(record.products[0].validation.skuPreview[0], "PC61-S-FER-VAC-F01");
  assert.deepEqual(
    record.approvals.filter((a) => a.kind === "color").map((a) => a.subject),
    ["Fire Engine Red → FER"]
  );
  const colors = await referenceTables.colorTable();
  assert.equal(colors.find((c) => c.code === "FER").color, "Fire Engine Red");
});

test("re-saving a row keeps the blank photos already attached to it", async () => {
  const { id } = await readyForProducts();
  await agent.saveProducts(id, [TEE_ROW], { by: "dan" });
  await agent.addFiles(id, { files: [packetFile("files", "navy-front.png", "image/png")], kind: "blank", productId: "p1", color: "Navy", face: "front" });

  // The console sends the row back with its id; a fresh row without one is
  // matched on its style number.
  const withId = await agent.saveProducts(id, [{ ...TEE_ROW, sizes: ["S", "M", "L"] }], { by: "dan" });
  assert.ok(withId.products[0].blankPhotos.Navy.front);
  const { id: _dropped, ...idless } = TEE_ROW;
  const withoutId = await agent.saveProducts(id, [idless], { by: "dan" });
  assert.ok(withoutId.products[0].blankPhotos.Navy.front);
  assert.equal(withoutId.products.length, 1);
});

test("saveProducts refuses a row before the department code is approved", async () => {
  harness();
  const created = await agent.createOnboarding({ payload: { departmentName: DEPARTMENT } });
  await assert.rejects(() => agent.saveProducts(created.id, [TEE_ROW]), /Approve the department code/);
});

/* ---------------------------------------------------------------------------
   Phase 4 — the build
   ------------------------------------------------------------------------- */

async function builtOnboarding(options = {}) {
  const deps = harness(options);
  await seedVacavilleOnList();
  const created = await agent.createOnboarding({
    payload: { departmentName: DEPARTMENT, state: "CA" },
    files: { artwork: [packetFile("artwork", "VFD-scramble.png", "image/png")], policies: [packetFile("policies", "policy.pdf")] }
  });
  await agent.runSetup(created.id, { by: "dan" });
  await agent.saveProducts(created.id, [TEE_ROW], { by: "dan" });
  const result = await agent.startBuild(created.id, { by: "dan", wait: true });
  return { deps, id: created.id, result, record: await store.getOnboarding(created.id) };
}

test("the build creates the collection before any product and writes §9 exactly", async () => {
  const { deps, record } = await builtOnboarding();

  assert.equal(record.build.state, "complete", record.build.error || "");
  assert.deepEqual(deps.order, ["collection", "product"]);
  assert.equal(record.collection.id, "111");
  assert.equal(record.collection.title, COLLECTION_TITLE);
  assert.equal(deps.shopify.calls.collection[0].descriptionHtml, rules.collectionDescriptionHtml());
  assert.ok(deps.shopify.calls.collection[0].bannerBuffer, "the banner is rendered from the scramble logo");
  assert.equal(record.collection.bannerLogoReason, "the scramble logo");

  // §9.1 duplicate the master, never edit it
  assert.deepEqual(deps.shopify.calls.duplicate, [{ sourceId: "gid://shopify/Product/1", title: "Next Level Cotton Tee" }]);
  const input = deps.shopify.calls.setProduct[0];
  assert.equal(input.productId, PRODUCT_GID);
  assert.equal(input.sourceProductId, "gid://shopify/Product/1");

  // §9.4 tags, §9.5 vendor, §9.6 options
  assert.deepEqual(input.tags, ["VAC"]);
  assert.equal(input.vendor, rules.VENDOR_NON_STOCK);
  assert.deepEqual(input.options.map((o) => o.name), [rules.OPTION_COLOR, rules.OPTION_SIZE, rules.OPTION_STYLE]);
  assert.deepEqual(input.options[2].values, ["Style 1", "Style 2"]);

  // §10 a SKU for every size × colour × style
  assert.deepEqual(input.variants.map((v) => v.sku), [
    "NL3600-S-NVY-VAC-F01/B01",
    "NL3600-S-NVY-VAC-F02/B01",
    "NL3600-M-NVY-VAC-F01/B01",
    "NL3600-M-NVY-VAC-F02/B01",
    "NL3600-S-MN-VAC-F01/B01",
    "NL3600-S-MN-VAC-F02/B01",
    "NL3600-M-MN-VAC-F01/B01",
    "NL3600-M-MN-VAC-F02/B01"
  ]);
  assert.equal(new Set(input.variants.map((v) => v.sku)).size, 8);

  // §9.2 Draft, §11 the disclaimer leads a decorated product's description
  assert.equal(record.products[0].buildState, "created");
  assert.ok(input.descriptionHtml.startsWith(rules.LOGO_DISCLAIMER_HTML));
  assert.ok(input.descriptionHtml.includes(rules.NON_STOCK_NOTICE.title));
  assert.deepEqual(input.collectionGids, [COLLECTION_GID]);
  assert.equal(record.products[0].shopify.variantCount, 8);
});

test("the build never touches the production files — it downloads copies", async () => {
  const { deps } = await builtOnboarding();
  // F01, B01 and F02 are the three codes across both Styles; each is a read.
  assert.equal(deps.drive.calls.downloads.length, 3);
  assert.ok(!Object.keys(deps.drive).includes("trashFile"));
});

test("front mockups bind to the variants of their own Style and Colour; backs stay in the gallery", async () => {
  const { deps, record } = await builtOnboarding();

  const { images } = deps.shopify.calls.attachMockups[0];
  assert.equal(images.length, 8, "front and back for 2 colours × 2 styles");
  // Fronts first: Shopify binds the FIRST media offered for a variant.
  assert.deepEqual(images.slice(0, 4).map((i) => i.filename.endsWith("FRONT.png")), [true, true, true, true]);

  const variants = deps.shopify.calls.setProduct[0].variants.map((variant, i) => ({
    id: `gid://shopify/ProductVariant/${i + 1}`,
    sku: variant.sku,
    options: Object.fromEntries(variant.optionValues.map((ov) => [ov.optionName, ov.name]))
  }));
  const navyStyle1 = images.find((i) => i.filename === "VAC_NL3600_NVY_Style1_FRONT.png");
  const expected = variants.filter((v) => v.options.Color === "Navy" && v.options.Style === "Style 1").map((v) => v.id);
  assert.equal(expected.length, 2);
  assert.deepEqual(navyStyle1.variantIds, expected);

  const mnStyle2 = images.find((i) => i.filename === "VAC_NL3600_MN_Style2_FRONT.png");
  assert.deepEqual(
    mnStyle2.variantIds,
    variants.filter((v) => v.options.Color === "Midnight Navy" && v.options.Style === "Style 2").map((v) => v.id)
  );
  for (const back of images.filter((i) => i.filename.endsWith("BACK.png"))) assert.deepEqual(back.variantIds, []);

  // Every mockup is kept as an asset and copied into Product Images.
  assert.equal(record.products[0].mockups.length, 8);
  assert.ok(record.products[0].mockups.every((m) => m.assetId && m.driveUrl));
  assert.equal(deps.drive.calls.images.filter((i) => i.folderId === "folder-Product Images").length, 8);
});

test("an AI-generated blank is recorded and reported, never passed off as the garment", async () => {
  const { id, record } = await builtOnboarding({ mockups: fakeMockups({ base: "generated" }) });

  // The provenance survives the hop from renderer to record. It used to be
  // computed and then dropped, which made an invention and a photograph of the
  // real garment indistinguishable everywhere downstream.
  assert.ok(record.products[0].mockups.length > 0);
  assert.ok(
    record.products[0].mockups.every((mockup) => mockup.base === "generated"),
    `bases: ${JSON.stringify(record.products[0].mockups.map((m) => m.base))}`
  );

  const checked = await agent.finalCheck(id, { by: "dan" });
  const warning = checked.report.warnings.find((w) => /AI-generated blank/.test(w));
  assert.ok(warning, `report warnings: ${JSON.stringify(checked.report.warnings)}`);
  assert.match(warning, /Upload blank photos and re-run/);
  // One line per product, not one per image.
  assert.equal(checked.report.warnings.filter((w) => /AI-generated blank/.test(w)).length, 1);
  // A warning, not missing information: generation is a deliberate fallback,
  // so saying so must not create a second gate the store can never pass.
  assert.equal(checked.report.missingInformation.some((m) => /AI-generated/.test(m)), false);
});

test("a face with no artwork names the artwork, not whichever warning came first", async () => {
  const { id } = await builtOnboarding();
  const face = await store.updateOnboarding(id, (r) => {
    const mockup = r.products[0].mockups[0];
    // Records built before the renderer carried `reason` are still in the
    // store, and this one is a hat with no embroidery proof.
    delete mockup.reason;
    mockup.path = "missing-artwork";
    mockup.warnings = [
      `${mockup.color} ${mockup.face}: no blank photo was supplied and no supplier photo was found, so this garment is AI-generated rather than a picture of the real item. Upload a ${mockup.face} photo of the blank and re-run to replace it.`,
      `No artwork for E01 (VAC-E01); the ${mockup.face} image is the blank.`
    ];
    return r;
  }).then((r) => r.products[0].mockups[0]);

  const checked = await agent.finalCheck(id, { by: "dan" });
  const line = checked.report.missingInformation.find((m) => /No artwork for E01/.test(m));
  assert.ok(line, JSON.stringify(checked.report.missingInformation));

  /* Telling Dan to upload a blank photo for a hat whose real problem is a
     missing E01 proof sends him round the loop again. */
  assert.equal(/Upload a \w+ photo of the blank/.test(line), false, line);
  const prefix = `${face.color} ${face.face}:`;
  assert.equal(line.split(prefix).length - 1, 1, `"${prefix}" should appear once: ${line}`);
});


test("a blank from a real photo raises no invented-garment warning", async () => {
  const { id, record } = await builtOnboarding();
  assert.ok(record.products[0].mockups.every((mockup) => mockup.base === "photo"));
  const checked = await agent.finalCheck(id, { by: "dan" });
  assert.equal(checked.report.warnings.some((w) => /AI-generated blank/.test(w)), false);
});

test("without Locksmith the lock becomes the §7 checklist, not a silent skip", async () => {
  const { record } = await builtOnboarding();
  assert.equal(record.lock.status, "manual");
  assert.equal(record.lock.checklist.length, 6);
  assert.match(record.lock.checklist[1], /Enable this lock, Protect products in this collection, Hide from navigation menus, Hide from lists/);
  assert.match(record.lock.checklist[3], /"Vacaville Fire Department" exactly/);
});

test("a re-run skips the product that already exists instead of creating a second one", async () => {
  const { deps, id } = await builtOnboarding();
  assert.equal(deps.shopify.calls.setProduct.length, 1);

  await agent.startBuild(id, { by: "dan", wait: true, force: true });
  const record = await store.getOnboarding(id);
  assert.equal(deps.shopify.calls.setProduct.length, 1, "the product was not created twice");
  assert.equal(record.build.steps.find((s) => s.key === "products:p1").state, "skipped");
});

test("one failing product does not sink the run", async () => {
  const shopify = fakeShopify({ order: [] });
  shopify.duplicateProduct = async () => {
    throw new Error("Shopify productDuplicate: throttled");
  };
  const { record } = await builtOnboarding({ shopify, shopifyOptions: {} });
  assert.equal(record.products[0].buildState, "failed");
  assert.match(record.products[0].buildError, /throttled/);
  assert.equal(record.build.state, "failed");
  // The collection still exists — the run went as far as it could.
  assert.equal(record.collection.id, "111");
});

test("the build refuses to start while a row has not passed validation", async () => {
  harness();
  await seedVacavilleOnList();
  const created = await agent.createOnboarding({ payload: { departmentName: DEPARTMENT } });
  await agent.runSetup(created.id, { by: "dan" });
  await agent.saveProducts(created.id, [{ ...TEE_ROW, colors: ["Fire Engine Red"] }], { by: "dan" });
  await agent.startBuild(created.id, { wait: true });
  const record = await store.getOnboarding(created.id);
  assert.equal(record.build.state, "failed");
  assert.equal(record.status, "build-error");
  assert.match(record.build.error, /has not passed validation/);
});

/* ---------------------------------------------------------------------------
   §12 final check
   ------------------------------------------------------------------------- */

test("final check stays open until the shared settings are confirmed, then completes", async () => {
  const { deps, id, record } = await builtOnboarding({ liveProducts: 1 });

  // The build's own final check ran and left it open: §8 is only proposed.
  assert.notEqual(record.status, "complete");
  assert.ok(record.report.missingInformation.some((m) => /Mega Menu/.test(m)));
  assert.ok(record.report.missingInformation.some((m) => /Shopify Flow/.test(m)));
  assert.ok(record.report.missingInformation.some((m) => /Helium/.test(m)));
  assert.ok(record.report.missingInformation.some((m) => /Locksmith lock is not confirmed/.test(m)));
  // §12 "Needs Dan" always carries the six standing items.
  for (const item of rules.NEEDS_DAN_ALWAYS) assert.ok(record.report.needsDan.includes(item), item);
  assert.ok(record.report.completed.some((c) => c.includes(COLLECTION_TITLE)));

  await agent.recordLock(id, { secretLink: "https://fnsimple.com/collections/1-vacaville-fire-department?ls=abc123", by: "dan" });
  // applied:false is what the finish card sends now the scope is granted: the
  // agent performs the insert rather than recording one it never made.
  await agent.approveSharedSetting(id, "megaMenu", { by: "dan", applied: false });
  await agent.approveSharedSetting(id, "flow", { by: "dan" });
  deps.helium.checkAllForms = fakeHelium({ present: true }).checkAllForms;
  await agent.approveSharedSetting(id, "helium", { by: "dan" });
  const verified = await agent.verifySharedSettings(id, { by: "dan" });
  assert.equal(verified.sharedSettings.megaMenu.status, "verified");
  /* Every one of the 108 entries in the live megamenu is named without the
     collection's "N." ordinal, so inserting "1. Vacaville Fire Department"
     would be the only odd one out — and would then fail to verify. */
  assert.equal(verified.sharedSettings.megaMenu.proposal.title, MENU_ITEM_TITLE);
  assert.ok(deps.shopify.liveMenuTitles().includes(MENU_ITEM_TITLE), JSON.stringify(deps.shopify.liveMenuTitles()));
  assert.equal(verified.sharedSettings.helium.status, "verified");
  assert.equal(verified.sharedSettings.flow.status, "confirmed");
  assert.deepEqual(
    verified.approvals.filter((a) => ["menu", "flow", "helium"].includes(a.kind)).map((a) => a.kind),
    ["menu", "flow", "helium"]
  );

  const checked = await agent.finalCheck(id, { by: "dan" });
  assert.deepEqual(checked.report.missingInformation, []);
  assert.equal(checked.status, "complete");
  assert.ok(checked.report.completed.some((c) => c.includes("secret link")));
  assert.ok(checked.report.driveDocUrl, "the report is saved to the department folder");
  assert.ok(agent.reportHtml(checked).includes("1. Completed"));
});

/* The Mega Menu is the one shared setting the agent can now write itself, so
   the record's own word for it stopped being evidence. These three pin what
   counts as proof. */

const MENU_LINK = "https://fnsimple.com/collections/1-vacaville-fire-department?ls=abc123";
// §8a: the menu item is named without the collection's ordinal.
const MENU_ITEM_TITLE = "Vacaville Fire Department";

// Everything except the menu, so the menu alone decides the verdict.
async function settleAllButTheMenu(deps, id) {
  await agent.recordLock(id, { secretLink: MENU_LINK, by: "dan" });
  await agent.approveSharedSetting(id, "flow", { by: "dan" });
  deps.helium.checkAllForms = fakeHelium({ present: true }).checkAllForms;
  await agent.approveSharedSetting(id, "helium", { by: "dan" });
}

test("a menu item recorded as applied but absent from the live menu never passes", async () => {
  const { deps, id } = await builtOnboarding({ liveProducts: 1 });
  await settleAllButTheMenu(deps, id);

  // "I did this" on a menu nobody edited. The console used to send exactly
  // this from the finish button, which recorded an item it never created.
  await agent.approveSharedSetting(id, "megaMenu", { by: "dan", applied: true });
  assert.equal((await store.getOnboarding(id)).sharedSettings.megaMenu.status, "applied");

  const checked = await agent.finalCheck(id, { by: "dan" });
  assert.notEqual(checked.status, "complete");
  assert.ok(
    checked.report.missingInformation.some((m) => /Mega Menu/.test(m) && /not there/.test(m)),
    JSON.stringify(checked.report.missingInformation)
  );
  assert.equal(checked.report.completed.some((c) => /Mega Menu carries/.test(c)), false);
});

test("a menu item added by hand is proof as soon as the live menu shows it", async () => {
  const { deps, id } = await builtOnboarding({ liveProducts: 1 });
  await settleAllButTheMenu(deps, id);

  deps.shopify.addMenuTitleByHand(MENU_ITEM_TITLE);
  await agent.approveSharedSetting(id, "megaMenu", { by: "dan", applied: true });

  const checked = await agent.finalCheck(id, { by: "dan" });
  assert.equal(checked.status, "complete", JSON.stringify(checked.report.missingInformation));
  assert.ok(checked.report.completed.some((c) => /Mega Menu carries/.test(c) && /read back from the live menu/.test(c)));
  // The read-back is the same proof verifySharedSettings records.
  assert.equal(checked.sharedSettings.megaMenu.status, "verified");
});

test("a menu that cannot be read falls back to what was recorded, and says so", async () => {
  const { deps, id } = await builtOnboarding({ liveProducts: 1, shopifyOptions: { megaMenuAvailable: false } });
  await settleAllButTheMenu(deps, id);

  // No scope, so the checklist is the only path and Dan's word is all there is.
  await agent.approveSharedSetting(id, "megaMenu", { by: "dan", applied: true });

  const checked = await agent.finalCheck(id, { by: "dan" });
  assert.equal(checked.status, "complete", JSON.stringify(checked.report.missingInformation));
  const line = checked.report.completed.find((c) => /Mega Menu/.test(c));
  assert.match(line, /could not be read back to prove it/);
});


const SECRET_LINK = "https://fnsimple.com/collections/1-vacaville-fire-department?ls=abc123";

/* §7/§12: a recorded secret link used to be all it took to report a store as
   locked. These three cases all record one and must still not pass. */

test("a store still visible to the public is never reported as locked", async () => {
  const { id } = await builtOnboarding({
    liveProducts: 16,
    lockAccess: { closedToPublic: false, publicProductLinks: 16, reason: "The collection page shows 16 product link(s) to the public (HTTP 200); the lock is not hiding them." }
  });
  await agent.recordLock(id, { secretLink: SECRET_LINK, by: "dan" });
  const checked = await agent.finalCheck(id, { by: "dan" });

  assert.notEqual(checked.status, "complete");
  assert.equal(checked.report.completed.some((c) => /Private store lock in place/.test(c)), false, "a leaking store is not 'in place'");
  assert.ok(checked.report.warnings.some((w) => /still visible to the public/.test(w)), JSON.stringify(checked.report.warnings));
  assert.equal(checked.lock.access.closedToPublic, false);
  assert.equal(checked.lock.access.publicProductLinks, 16);
});

test("a secret link that opens nothing keeps the onboarding open", async () => {
  const { id } = await builtOnboarding({ liveProducts: 8, lockAccess: { closedToPublic: true, opensWithSecretLink: false, reason: "The secret link showed no products, so it does not open the store." } });
  await agent.recordLock(id, { secretLink: SECRET_LINK, by: "dan" });
  const checked = await agent.finalCheck(id, { by: "dan" });

  assert.notEqual(checked.status, "complete");
  assert.ok(checked.report.warnings.some((w) => /does not open it/.test(w)), JSON.stringify(checked.report.warnings));
});

test("a lock that cannot be checked from outside is not confirmed private", async () => {
  const { id } = await builtOnboarding({
    liveProducts: 8,
    lockAccess: { checked: false, closedToPublic: null, reason: "Could not read https://fnsimple.com/collections/1-vacaville-fire-department: ECONNRESET" }
  });
  await agent.recordLock(id, { secretLink: SECRET_LINK, by: "dan" });
  const checked = await agent.finalCheck(id, { by: "dan" });

  assert.notEqual(checked.status, "complete");
  assert.ok(checked.report.missingInformation.some((m) => /not confirmed private/.test(m)), JSON.stringify(checked.report.missingInformation));
  // An unchecked verdict is never written to the record as if it were one.
  assert.equal(checked.lock.access.checkedAt, "");
});

test("a Draft-only store cannot prove or disprove the lock, and does not block on it", async () => {
  /* Found by running a real build: the agent's first live lock reported
     closedToPublic=true and opensWithSecretLink=false, and BOTH were
     meaningless — all four products were Draft, so the storefront showed
     nothing with or without a lock. §9.2 guarantees that state at build time,
     so blocking here would gate every onboarding on an impossibility. */
  const { id } = await builtOnboarding({
    lockAccess: { closedToPublic: true, opensWithSecretLink: false, reason: "should never be consulted while everything is Draft" }
  });
  await agent.recordLock(id, { secretLink: SECRET_LINK, by: "dan" });
  const checked = await agent.finalCheck(id, { by: "dan" });

  assert.equal(
    checked.report.warnings.some((w) => /does not open it/.test(w)),
    false,
    "a Draft store must not be reported as a broken secret link"
  );
  assert.ok(
    checked.report.needsDan.some((n) => /After pricing and publishing/.test(n)),
    `expected a post-launch re-check item: ${JSON.stringify(checked.report.needsDan)}`
  );
  // And the unprovable verdict is never written to the record as if it were one.
  assert.equal(checked.lock.access.checkedAt, "");
});

test("a lock proven to work is reported with the evidence, not just the link", async () => {
  const { id } = await builtOnboarding({ liveProducts: 1 });
  await agent.recordLock(id, { secretLink: SECRET_LINK, by: "dan" });
  const checked = await agent.finalCheck(id, { by: "dan" });

  const line = checked.report.completed.find((c) => /Private store lock in place/.test(c));
  assert.ok(line, JSON.stringify(checked.report.completed));
  assert.match(line, /the public sees none of the 1 product\(s\)/);
  assert.match(line, /the secret link opens the store/);
  assert.equal(checked.lock.access.closedToPublic, true);
  assert.ok(checked.lock.access.checkedAt);
});

test("Dan can confirm Helium by hand, exactly as he confirms Flow", async () => {
  /* Helium has no write API and only one of its three form ids is known, so
     "verified" — every form read back carrying the tag — can never be reached.
     Requiring it meant no onboarding could ever finish. Flow, equally
     unautomatable, has always been satisfied by Dan saying he did it. */
  const { id } = await builtOnboarding({ liveProducts: 1, helium: fakeHelium({ present: false }) });

  const after = await agent.approveSharedSetting(id, "helium", { by: "Dan" });
  assert.equal(after.sharedSettings.helium.status, "confirmed");
  assert.equal(after.sharedSettings.helium.confirmedBy, "Dan");
  assert.ok(after.sharedSettings.helium.confirmedAt);

  const checked = await agent.finalCheck(id, { by: "Dan" });
  assert.ok(
    checked.report.completed.some((c) => /Helium forms confirmed by Dan/.test(c)),
    JSON.stringify(checked.report.completed)
  );
  assert.equal(
    checked.report.missingInformation.some((m) => /Helium/.test(m)),
    false,
    "a confirmed Helium must not keep blocking the onboarding"
  );
});

test("a Helium read that finds every form still reports the stronger verdict", async () => {
  const { id } = await builtOnboarding({ liveProducts: 1 });
  agent.setDeps({ helium: fakeHelium({ present: true }) });
  const after = await agent.approveSharedSetting(id, "helium", { by: "Dan" });
  assert.equal(after.sharedSettings.helium.status, "verified", "read-back beats attestation");
  assert.equal(after.sharedSettings.helium.confirmedBy, "");
});

test("final check catches a product Shopify says is ACTIVE or carries another department's tag", async () => {
  const shopify = fakeShopify({ order: [] });
  const { id } = await builtOnboarding({ shopify });
  const snapshot = await shopify.productSnapshot();
  shopify.productSnapshot = async () => ({ ...snapshot, status: "ACTIVE", tags: [...snapshot.tags, "BSH"] });

  const record = await agent.finalCheck(id, { by: "dan" });
  assert.notEqual(record.status, "complete");
  assert.ok(record.report.warnings.some((w) => /is ACTIVE, not Draft/.test(w)));
  assert.ok(record.report.warnings.some((w) => /another department's tag: BSH/.test(w)));
});

/* ---------------------------------------------------------------------------
   The router over real HTTP
   ------------------------------------------------------------------------- */

async function withServer(run) {
  const app = express();
  app.use(express.json());
  // The router refuses to build without a gate, so the pass-through used in
  // tests is explicit rather than implied by omission.
  const openGate = (req, res, next) => next();
  app.use(
    "/api",
    createOnboardingRouter({
      requireAdminToken: openGate,
      upload: multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 50 } })
    })
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the router creates, reads and 404s an onboarding over HTTP", async () => {
  harness();
  await withServer(async (base) => {
    const form = new FormData();
    form.append("payload", JSON.stringify({ departmentName: DEPARTMENT, state: "CA", by: "dan" }));
    form.append("policies", new Blob([Buffer.from("policy bytes")], { type: "application/pdf" }), "uniform-policy.pdf");

    const created = await fetch(`${base}/api/onboardings`, { method: "POST", body: form });
    assert.equal(created.status, 201);
    const { onboarding } = await created.json();
    assert.equal(onboarding.department.name, DEPARTMENT);
    assert.equal(onboarding.packet.files.length, 1);

    const read = await fetch(`${base}/api/onboardings/${onboarding.id}`);
    assert.equal(read.status, 200);
    assert.equal((await read.json()).onboarding.id, onboarding.id);

    const list = await fetch(`${base}/api/onboardings`);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).onboardings.length, 1);

    const missing = await fetch(`${base}/api/onboardings/2026-01-01-nowhere-00000000.json`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /was not found/);

    const nonsense = await fetch(`${base}/api/onboardings/..%2Fetc%2Fpasswd`);
    assert.equal(nonsense.status, 404);

    // A traversal attempt on an asset id is refused before the blob layer.
    const traversal = await fetch(`${base}/api/onboardings/${onboarding.id}/assets/..%2F..%2F${onboarding.id}`);
    assert.equal(traversal.status, 404);

    const asset = await fetch(`${base}/api/onboardings/${onboarding.id}/assets/${onboarding.packet.files[0].assetId}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "private, max-age=300");
    assert.equal(asset.headers.get("content-type"), "application/pdf");
    assert.equal(await asset.text(), "policy bytes");

    const badBody = await fetch(`${base}/api/onboardings/${onboarding.id}/products`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ products: "nope" })
    });
    assert.equal(badBody.status, 400);

    const unknownTable = await fetch(`${base}/api/reference/not-a-table`);
    assert.equal(unknownTable.status, 404);

    const colors = await fetch(`${base}/api/reference/color-codes`);
    assert.equal(colors.status, 200);
    assert.ok((await colors.json()).rows.some((row) => row.code === "NVY"));
  });
});

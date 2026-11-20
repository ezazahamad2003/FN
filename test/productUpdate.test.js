const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const rules = require("../onboardingRules");
const productUpdate = require("../productUpdate");
const shopifyOnboarding = require("../shopifyOnboarding");
const mockups = require("../onboardingMockups");

delete process.env.AZURE_STORAGE_CONNECTION_STRING;

const JOB_SHIRT = {
  brand: "5.11 Tactical",
  styleNumber: "72534",
  type: "Job Shirt",
  title: "5.11 1/4 Zip Job Shirt",
  colors: ["Black"],
  sizes: ["S", "M", "L"],
  decorationMethod: "embroidery",
  decorationCodes: "E01",
  placements: { E01: "F" },
  fulfillment: "Non Stock Item"
};

function expand(row) {
  return rules.expandProduct(row, { departmentCode: "NRH" });
}

// The live product a row was built into, as productSnapshot reads it.
function liveFrom(row, { prices = {}, rename = (v) => v } = {}) {
  const expanded = expand(row);
  assert.equal(expanded.ok, true, expanded.errors.join(" "));
  return {
    id: "900",
    gid: "gid://shopify/Product/900",
    title: row.title,
    status: "ACTIVE",
    vendor: row.fulfillment,
    tags: ["NRH", "Embroidered"],
    productType: "Job Shirts",
    options: expanded.options.map((o) => ({ name: o.name, values: o.values.map(rename) })),
    variants: expanded.variants.map((v, i) => ({
      id: `gid://shopify/ProductVariant/${i + 1}`,
      sku: v.sku,
      price: prices[v.size] || "107.00",
      inventoryPolicy: "CONTINUE",
      selectedOptions: v.optionValues.map((ov) => ({ name: ov.optionName, value: rename(ov.name) })),
      image: { url: `https://cdn.test/${i}.png` }
    })),
    media: [],
    collections: []
  };
}

test("planProductUpdate: a row that matches the live product adds nothing", () => {
  const plan = productUpdate.planProductUpdate(expand(JOB_SHIRT), liveFrom(JOB_SHIRT), { departmentCode: "NRH" });
  assert.equal(plan.ok, true);
  assert.deepEqual([plan.variants.length, plan.newPairs.length, plan.addStyleOption, plan.liveCount], [0, 0, false, 3]);
  assert.deepEqual(plan.warnings, []);
});

test("planProductUpdate: a new colour, a new size and a new Style are exactly what is missing", () => {
  const live = liveFrom(JOB_SHIRT);
  const row = { ...JOB_SHIRT, colors: ["Black", "Navy"], sizes: ["S", "M", "L", "XL"], styles: [{ decorationCodes: "E01" }, { decorationCodes: "E02" }] };
  const plan = productUpdate.planProductUpdate(expand(row), live, { departmentCode: "NRH" });
  assert.equal(plan.ok, true, plan.problems.join(" "));
  // 2 colours x 4 sizes x 2 Styles = 16, of which Black S/M/L Style 1 exist.
  assert.equal(plan.variants.length, 13);
  assert.equal(plan.addStyleOption, true, "what is live becomes Style 1");
  assert.deepEqual(plan.newColors, ["Navy"]);
  assert.deepEqual(plan.newSizes, ["XL"]);
  assert.deepEqual(plan.newStyles, ["Style 2"]);
  assert.deepEqual(
    plan.newPairs.map((p) => `${p.color}/${p.style}`).sort(),
    ["Black/Style 2", "Navy/Style 1", "Navy/Style 2"],
    "Black Style 1 has its pictures; only its new size is added"
  );
  const xl = plan.variants.find((v) => v.color === "Black" && v.size === "XL" && v.style === "Style 1");
  assert.equal(xl.sku, "72534-XL-BLK-NRH-E01");
  assert.ok(plan.variants.every((v) => v.optionValues.length === 3 && v.optionValues[2].optionName === "Style"));
});

test("planProductUpdate: a value Shopify already has keeps Shopify's spelling and colour code", () => {
  // The product was built when Black was BLA on the list and typed "BLACK".
  const live = liveFrom(JOB_SHIRT, { rename: (v) => (v === "Black" ? "BLACK" : v) });
  live.variants.forEach((v) => {
    v.sku = v.sku.replace("-BLK-", "-BLA-");
  });
  const row = { ...JOB_SHIRT, styles: [{ decorationCodes: "E01" }, { decorationCodes: "E02" }] };
  const plan = productUpdate.planProductUpdate(expand(row), live, { departmentCode: "NRH" });
  assert.equal(plan.ok, true, plan.problems.join(" "));
  assert.deepEqual(plan.variants.map((v) => v.sku), ["72534-S-BLA-NRH-E02", "72534-M-BLA-NRH-E02", "72534-L-BLA-NRH-E02"]);
  assert.ok(plan.variants.every((v) => v.optionValues[0].name === "BLACK"), "no second colour beside the one that is there");
  assert.deepEqual(plan.warnings, [], "the product's own colour code is not a difference to report");
});

test("planProductUpdate: an ending Dan gave every SKU by hand goes on the new SKUs too", () => {
  // Noroton Heights' tees: built as …-F01/B01, then every SKU edited to end /E00.
  const tee = { ...JOB_SHIRT, decorationMethod: "print", decorationCodes: "F01/B01", placements: {}, styles: [{ decorationCodes: "F01/B01" }, { decorationCodes: "F02/B01" }] };
  const live = liveFrom(tee);
  live.variants.forEach((v) => {
    v.sku = `${v.sku}/E00`;
  });
  const row = { ...tee, styles: [...tee.styles, { decorationCodes: "F03/B01" }] };
  const plan = productUpdate.planProductUpdate(expand(row), live, { departmentCode: "NRH" });
  assert.equal(plan.ok, true, plan.problems.join(" "));
  assert.equal(plan.skuEnding, "/E00");
  assert.deepEqual(plan.variants.map((v) => v.sku), ["72534-S-BLK-NRH-F03/B01/E00", "72534-M-BLK-NRH-F03/B01/E00", "72534-L-BLK-NRH-F03/B01/E00"]);
  assert.match(plan.warnings.join(" "), /Every SKU on this product ends in "\/E00"/);
  assert.doesNotMatch(plan.warnings.join(" "), /would write differently/);

  // One variant without the ending: nothing is assumed, and it is said.
  live.variants[0].sku = live.variants[0].sku.replace("/E00", "");
  const mixed = productUpdate.planProductUpdate(expand(row), live, { departmentCode: "NRH" });
  assert.equal(mixed.skuEnding, "");
  assert.equal(mixed.variants[0].sku, "72534-S-BLK-NRH-F03/B01");
  assert.match(mixed.warnings.join(" "), /5 variants already in Shopify carry SKUs the row would write differently/);
});

test("planProductUpdate: nothing is ever removed, and a product set up by hand is refused", () => {
  const live = liveFrom({ ...JOB_SHIRT, colors: ["Black", "Navy"] });
  const fewer = productUpdate.planProductUpdate(expand(JOB_SHIRT), live, { departmentCode: "NRH" });
  assert.deepEqual([fewer.ok, fewer.variants.length, fewer.extraLive], [true, 0, 3]);
  assert.match(fewer.warnings.join(" "), /An update never removes a variant/);

  const byHand = { ...liveFrom(JOB_SHIRT), options: [{ name: "Colour", values: ["Black"] }, { name: "Size", values: ["S"] }] };
  const refused = productUpdate.planProductUpdate(expand(JOB_SHIRT), byHand, { departmentCode: "NRH" });
  assert.equal(refused.ok, false);
  assert.match(refused.problems[0], /options are Colour, Size/);

  const gone = productUpdate.planProductUpdate(expand(JOB_SHIRT), null, { departmentCode: "NRH" });
  assert.match(gone.problems[0], /no longer in Shopify/);

  const styled = liveFrom({ ...JOB_SHIRT, styles: [{ decorationCodes: "E01" }, { decorationCodes: "E02" }] });
  const rowLost = productUpdate.planProductUpdate(expand(JOB_SHIRT), styled, { departmentCode: "NRH" });
  assert.match(rowLost.problems[0], /sold in Styles, and the row has none/);
});

test("planProductUpdate: a Style whose SKU another variant already has is a problem, not a duplicate", () => {
  // Live is "Style-less E02"; the row calls its first logo E01 and adds E02.
  const live = liveFrom({ ...JOB_SHIRT, decorationCodes: "E02", placements: { E02: "F" } });
  const row = { ...JOB_SHIRT, styles: [{ decorationCodes: "E01" }, { decorationCodes: "E02" }] };
  const plan = productUpdate.planProductUpdate(expand(row), live, { departmentCode: "NRH" });
  assert.equal(plan.ok, false);
  assert.match(plan.problems[0], /would get the SKU 72534-S-BLK-NRH-E02, which another variant of this product already has/);
});

test("rowFromLiveProduct reads the row back off a styled product, and it plans to add nothing", () => {
  const built = { ...JOB_SHIRT, colors: ["Black", "Navy"], decorationCodes: "E01/B01", styles: [{ decorationCodes: "E01/B01" }, { decorationCodes: "E02/B01" }] };
  const live = liveFrom(built);
  const { row, problems } = productUpdate.rowFromLiveProduct(live, { departmentCode: "NRH" });
  assert.deepEqual(problems, []);
  assert.deepEqual(
    [row.styleNumber, row.title, row.fulfillment, row.decorationCodes, row.decorationMethod],
    ["72534", "5.11 1/4 Zip Job Shirt", "Non Stock Item", "E01/B01", ""]
  );
  assert.deepEqual(row.colors, ["Black", "Navy"]);
  assert.deepEqual(row.sizes, ["S", "M", "L"]);
  assert.deepEqual(row.styles, [{ decorationCodes: "E01/B01" }, { decorationCodes: "E02/B01" }]);
  const plan = productUpdate.planProductUpdate(expand(row), live, { departmentCode: "NRH" });
  assert.deepEqual([plan.ok, plan.variants.length], [true, 0]);
});

test("additiveChange: only colours, sizes and Styles gained count as an update", () => {
  const built = { ...JOB_SHIRT, logoMap: { E01: "crest.png" } };
  const add = (extra) => productUpdate.additiveChange(built, { ...built, ...extra });
  assert.equal(add({ colors: ["Black", "Navy"] }), true);
  assert.equal(add({ sizes: ["S-2XL"] }), true, "S-2XL holds S, M, L");
  assert.equal(add({ styles: [{ decorationCodes: "E01" }, { decorationCodes: "E02" }], logoMap: { E01: "crest.png", E02: "ems.png" }, placements: { E01: "F", E02: "F" } }), true);
  assert.equal(add({ colors: ["Navy"] }), false, "a colour was taken off");
  assert.equal(add({ sizes: ["S", "M"] }), false);
  assert.equal(add({ logoMap: { E01: "other.png" } }), false, "the logo it was built with changed");
  assert.equal(add({ placements: { E01: "B" } }), false, "the logo moved");
  assert.equal(add({ decorationCodes: "E01/B01" }), false, "Style 1 itself changed");
  assert.equal(add({ styles: [{ decorationCodes: "E02" }, { decorationCodes: "E01" }] }), false, "the Styles were reordered");
  assert.equal(productUpdate.additiveChange({ ...built, logoMap: {} }, built), false, "a default logo became a picked one");
});

/* ---- Shopify: the calls an update makes ---------------------------------- */

test("buildVariantCreateInput: the sibling's price, never 0.00, and the SKU on the inventory item", () => {
  const input = shopifyOnboarding.buildVariantCreateInput({
    optionValues: [{ optionName: "Color", name: "Black" }, { optionName: "Size", name: "2XL" }, { optionName: "Style", name: "Style 2" }],
    sku: "72534-2XL-BLK-NRH-E02",
    price: "112.00",
    compareAtPrice: null,
    taxable: true,
    inventoryPolicy: "CONTINUE",
    tracked: false,
    requiresShipping: true,
    weight: { value: 1.5, unit: "POUNDS" }
  });
  assert.deepEqual(input, {
    optionValues: [{ optionName: "Color", name: "Black" }, { optionName: "Size", name: "2XL" }, { optionName: "Style", name: "Style 2" }],
    price: "112.00",
    inventoryPolicy: "CONTINUE",
    taxable: true,
    inventoryItem: { sku: "72534-2XL-BLK-NRH-E02", tracked: false, requiresShipping: true, measurement: { weight: { value: 1.5, unit: "POUNDS" } } }
  });
  assert.equal("status" in input, false);
});

test("addProductOption, addProductVariants and productVariantDetail send what Shopify's schema takes", async () => {
  const sent = [];
  shopifyOnboarding.setGraphql(async (query, variables) => {
    sent.push({ query, variables });
    if (/mutation productOptionsCreate/.test(query)) return { productOptionsCreate: { product: { id: variables.productId, options: [{ name: "Style", optionValues: [{ name: "Style 1" }] }] }, userErrors: [] } };
    if (/mutation productVariantsBulkCreate/.test(query)) {
      return { productVariantsBulkCreate: { productVariants: variables.variants.map((v, i) => ({ id: `gid://shopify/ProductVariant/${sent.length}-${i}`, sku: v.inventoryItem.sku, title: "t", selectedOptions: v.optionValues.map((o) => ({ name: o.optionName, value: o.name })) })), userErrors: [] } };
    }
    if (/query productVariantDetail/.test(query)) {
      return {
        product: {
          id: variables.id,
          variants: {
            nodes: [{ id: "gid://shopify/ProductVariant/1", sku: "A-S-BLK-NRH-E01", price: "107.00", compareAtPrice: null, taxable: true, inventoryPolicy: "CONTINUE", selectedOptions: [{ name: "Size", value: "S" }], media: { nodes: [{ id: "gid://shopify/MediaImage/5" }] }, inventoryItem: { tracked: false, requiresShipping: true, measurement: { weight: { value: 2, unit: "POUNDS" } } } }],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      };
    }
    throw new Error(`no handler for ${query.slice(0, 40)}`);
  });
  try {
    await shopifyOnboarding.addProductOption("900", { name: "Style", values: ["Style 1"] });
    assert.match(sent[0].query, /variantStrategy: LEAVE_AS_IS/);
    assert.deepEqual(sent[0].variables, { productId: "gid://shopify/Product/900", options: [{ name: "Style", values: [{ name: "Style 1" }] }] });

    const variants = Array.from({ length: 130 }, (_, i) => ({ optionValues: [{ optionName: "Size", name: `S${i}` }], sku: `SKU-${i}`, price: "107.00" }));
    const created = await shopifyOnboarding.addProductVariants("gid://shopify/Product/900", variants);
    assert.equal(created.length, 130);
    assert.deepEqual(sent.slice(1).map((s) => s.variables.variants.length), [100, 30], "sent in chunks");
    assert.equal(sent[1].variables.variants[0].inventoryItem.sku, "SKU-0");
    assert.equal(created[129].sku, "SKU-129");
    assert.deepEqual(await shopifyOnboarding.addProductVariants("900", []), []);

    const detail = await shopifyOnboarding.productVariantDetail("900");
    assert.deepEqual(detail[0], {
      id: "gid://shopify/ProductVariant/1",
      sku: "A-S-BLK-NRH-E01",
      price: "107.00",
      compareAtPrice: null,
      taxable: true,
      inventoryPolicy: "CONTINUE",
      selectedOptions: [{ name: "Size", value: "S" }],
      mediaId: "gid://shopify/MediaImage/5",
      tracked: false,
      requiresShipping: true,
      weight: { value: 2, unit: "POUNDS" }
    });

    shopifyOnboarding.setGraphql(async () => ({ productVariantsBulkCreate: { productVariants: [], userErrors: [{ field: ["variants", "0"], message: "The variant 'Black / S' already exists." }] } }));
    await assert.rejects(() => shopifyOnboarding.addProductVariants("900", variants.slice(0, 1)), /already exists/);
  } finally {
    shopifyOnboarding.setGraphql(null);
  }
});

/* ---- the renderer draws only what is new ---------------------------------- */

test("renderProductMockups with `existing` draws only the new colour and Style, and no back that is already there", async () => {
  const solid = (background) => sharp({ create: { width: 200, height: 200, channels: 3, background } }).png().toBuffer();
  const renders = [];
  const lookups = [];
  mockups.setRenderers({
    renderFaceImage: async (options) => {
      renders.push(options.face);
      return { buffer: options.face === options.sourceFace ? options.baseBuffer : await options.getBackBlank(), path: "render" };
    },
    deriveBackBlank: async () => solid("#202060"),
    generateBlankGarment: async () => solid("#404040"),
    findSupplierBlank: async () => null,
    reason: async () => "{}"
  });
  try {
    const product = rules.expandProduct(
      { brand: "Next Level", styleNumber: "NL3600", type: "T-shirt", colors: ["Navy", "Black"], sizes: ["S"], styles: [{ decorationCodes: "F01/B01" }, { decorationCodes: "F02/B01" }], fulfillment: "One Week Item" },
      { departmentCode: "VAC" }
    ).product;
    const art = async (name) => ({ buffer: await solid("#ffcc00"), mimetype: "image/png", name });
    const photo = await solid("#1a2a5a");
    const log = [];
    const out = await mockups.renderProductMockups({
      product,
      departmentCode: "VAC",
      artwork: { F01: await art("F01.png"), B01: await art("B01.png"), F02: await art("F02.png") },
      blankPhotos: { Navy: { front: photo, back: photo }, Black: { front: photo, back: photo } },
      supplierLookup: async (...args) => {
        lookups.push(args);
        return null;
      },
      // Navy in Style 1 is what the product already sells.
      existing: (color, style) => color === "Navy" && style === "Style 1",
      onLog: (m) => log.push(m),
      verify: false,
      size: 128
    });
    assert.deepEqual(
      out.map((m) => m.fileName),
      ["VAC_NL3600_NVY_Style2_FRONT.png", "VAC_NL3600_BLK_Style1_FRONT.png", "VAC_NL3600_BLK_Style1_BACK.png", "VAC_NL3600_BLK_Style2_FRONT.png", "VAC_NL3600_BLK_Style2_BACK.png"],
      "Navy Style 2's back is Navy Style 1's, which is on the product"
    );
    assert.equal(renders.length, 4, "three fronts and Black's one back");
    assert.match(log.join("\n"), /Navy Style 2 back: the same picture is already on the product/);

    // Everything there: nothing is looked up or drawn at all.
    renders.length = 0;
    const none = await mockups.renderProductMockups({ product, departmentCode: "VAC", artwork: {}, blankPhotos: {}, existing: () => true, verify: false, size: 128 });
    assert.deepEqual([none.length, renders.length], [0, 0]);
  } finally {
    mockups.setRenderers(null);
  }
});

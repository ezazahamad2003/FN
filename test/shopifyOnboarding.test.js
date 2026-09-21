const test = require("node:test");
const assert = require("node:assert/strict");

// adminProductUrl/adminCollectionUrl read SHOPIFY_STORE, so pin it before the
// module under test is loaded to keep the returned admin URLs predictable.
process.env.SHOPIFY_STORE = "fn-simple-uniforms.myshopify.com";

const shopifyOnboarding = require("../shopifyOnboarding");
const rules = require("../onboardingRules");

/* ---------------------------------------------------------------------------
   Stub transport. Every GraphQL document in shopifyOnboarding.js is a named
   operation, so the stub dispatches on that name and records what was sent —
   no store, no token, no network.
   ------------------------------------------------------------------------- */

function operationName(query) {
  const match = /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(String(query));
  return match ? match[1] : "";
}

function stubGraphql(handlers) {
  const calls = [];
  shopifyOnboarding.setGraphql(async (query, variables = {}) => {
    const op = operationName(query);
    calls.push({ op, query, variables });
    if (!(op in handlers)) throw new Error(`Test stub has no handler for GraphQL operation "${op}"`);
    const handler = handlers[op];
    return typeof handler === "function" ? handler(variables, calls) : handler;
  });
  return calls;
}

function callsNamed(calls, op) {
  return calls.filter((c) => c.op === op);
}

// Restores the real transports so one test can never leak into the next.
function resetShopify() {
  shopifyOnboarding.setGraphql(null);
  shopifyOnboarding.setTransports({
    graphql: null,
    uploadProductImages: null,
    productExists: null,
    fetch: null,
    uploadToTarget: null,
    sleep: null
  });
}

/* ---------------------------------------------------------------------------
   §9.1 findSourceProduct
   ------------------------------------------------------------------------- */

function productNode({ id, title, sku, createdAt, tags = [], status = "ACTIVE" }) {
  return {
    id: `gid://shopify/Product/${id}`,
    legacyResourceId: String(id),
    title,
    createdAt,
    tags,
    status,
    variants: { nodes: sku ? [{ sku }] : [] }
  };
}

function sourceProductsData(nodes) {
  return { products: { nodes } };
}

test("findSourceProduct prefers the Master Reference product over a newer one", async (t) => {
  t.after(resetShopify);
  // The query sorts CREATED_AT reverse, so the newest listing arrives first.
  const calls = stubGraphql({
    sourceProducts: () =>
      sourceProductsData([
        productNode({
          id: 3001,
          title: "1. Bishop Fire Department Tee (NL3600)",
          sku: "NL3600-S-MN-BSH-F01/B01",
          createdAt: "2026-09-01T10:00:00Z"
        }),
        productNode({
          id: 2001,
          title: "Next Level Cotton Tee, Short Sleeve (NL3600)",
          sku: "NL3600-S-NVY",
          createdAt: "2025-01-15T10:00:00Z",
          tags: ["Master Reference", "Tees & Tanks"],
          status: "DRAFT"
        })
      ])
  });

  const source = await shopifyOnboarding.findSourceProduct("nl3600");
  assert.equal(source.id, "gid://shopify/Product/2001");
  assert.equal(source.legacyId, "2001");
  assert.equal(source.kind, "master");
  assert.equal(source.title, "Next Level Cotton Tee, Short Sleeve (NL3600)");
  assert.match(source.url, /\/admin\/products\/2001$/);
  assert.ok(source.tags.includes("Master Reference"));

  // The style number is normalized before it reaches Shopify, and the SKU
  // search runs first (one call — the title fallback is not needed).
  assert.equal(calls.length, 1);
  assert.equal(calls[0].variables.query, "sku:NL3600*");
});

test("findSourceProduct falls back to the newest product when none is a master", async (t) => {
  t.after(resetShopify);
  stubGraphql({
    sourceProducts: () =>
      sourceProductsData([
        productNode({ id: 3002, title: "Ripon Tee (NL3600)", sku: "NL3600-M-BLK-RIP-F01", createdAt: "2026-04-02T00:00:00Z" }),
        productNode({ id: 3003, title: "Bishop Tee (NL3600)", sku: "NL3600-S-MN-BSH-F01", createdAt: "2026-08-02T00:00:00Z" })
      ])
  });

  const source = await shopifyOnboarding.findSourceProduct("NL3600");
  // Newest wins regardless of the order Shopify returned them in.
  assert.equal(source.id, "gid://shopify/Product/3003");
  assert.equal(source.kind, "latest");
  assert.equal(source.createdAt, "2026-08-02T00:00:00Z");
});

test("findSourceProduct matches the style exactly: NL3600 is never NL36001 or NL3600LS", async (t) => {
  t.after(resetShopify);
  // Shopify's `sku:NL3600*` prefix search returns the longer styles too; the
  // "NL3600-" boundary is what keeps the wrong blank out.
  const neighbours = [
    productNode({ id: 4001, title: "Next Level Long Sleeve (NL3600LS)", sku: "NL3600LS-S-NVY", createdAt: "2026-09-10T00:00:00Z" }),
    productNode({ id: 4002, title: "Next Level Youth Tee (NL36001)", sku: "NL36001-S-NVY", createdAt: "2026-09-09T00:00:00Z" })
  ];
  const calls = stubGraphql({
    sourceProducts: (vars) =>
      vars.query === "sku:NL3600*"
        ? sourceProductsData([
            ...neighbours,
            productNode({ id: 2001, title: "Next Level Cotton Tee, Short Sleeve (NL3600)", sku: "NL3600-S-NVY", createdAt: "2025-01-15T00:00:00Z" })
          ])
        : sourceProductsData([])
  });

  const source = await shopifyOnboarding.findSourceProduct("NL3600");
  assert.equal(source.id, "gid://shopify/Product/2001");
  assert.equal(calls.length, 1, "an exact SKU hit means no title fallback");

  assert.equal(shopifyOnboarding.skuMatchesStyle("NL3600-S-NVY", "NL3600"), true);
  assert.equal(shopifyOnboarding.skuMatchesStyle("nl3600-s-nvy", "NL3600"), true);
  assert.equal(shopifyOnboarding.skuMatchesStyle("NL36001-S-NVY", "NL3600"), false);
  assert.equal(shopifyOnboarding.skuMatchesStyle("NL3600LS-S-NVY", "NL3600"), false);
  assert.equal(shopifyOnboarding.skuMatchesStyle("NL3600", "NL3600"), false);
  assert.equal(shopifyOnboarding.skuMatchesStyle("", "NL3600"), false);
});

test("findSourceProduct falls back to the title form \"(NL3600)\" when no SKU matches", async (t) => {
  t.after(resetShopify);
  const calls = stubGraphql({
    sourceProducts: (vars) => {
      if (vars.query === "sku:NL3600*") {
        // Only the neighbouring styles carry SKUs with that prefix.
        return sourceProductsData([productNode({ id: 4001, title: "Next Level Long Sleeve (NL3600LS)", sku: "NL3600LS-S-NVY", createdAt: "2026-09-10T00:00:00Z" })]);
      }
      return sourceProductsData([
        productNode({ id: 4002, title: "Next Level Youth Tee (NL36001)", sku: "", createdAt: "2026-05-01T00:00:00Z" }),
        productNode({ id: 2002, title: "Next Level Cotton Tee, Short Sleeve (NL3600)", sku: "", createdAt: "2024-02-01T00:00:00Z" })
      ]);
    }
  });

  const source = await shopifyOnboarding.findSourceProduct("NL3600");
  assert.equal(source.id, "gid://shopify/Product/2002");
  assert.equal(source.kind, "latest");
  assert.equal(calls.length, 2);
  // Parentheses are grouping syntax in Shopify search, so the fallback query is
  // the bare style and "(NL3600)" is matched locally.
  assert.equal(calls[1].variables.query, "NL3600");
});

test("findSourceProduct returns null when nothing matches, and rejects a bad style", async (t) => {
  t.after(resetShopify);
  stubGraphql({
    sourceProducts: () =>
      sourceProductsData([productNode({ id: 4001, title: "Next Level Long Sleeve (NL3600LS)", sku: "NL3600LS-S-NVY", createdAt: "2026-09-10T00:00:00Z" })])
  });
  assert.equal(await shopifyOnboarding.findSourceProduct("NL3600"), null);

  await assert.rejects(() => shopifyOnboarding.findSourceProduct(""), /Style number is required/);
});

test("isMasterReference ignores case and surrounding whitespace on the tag", () => {
  assert.equal(shopifyOnboarding.isMasterReference({ tags: ["Master Reference"] }), true);
  assert.equal(shopifyOnboarding.isMasterReference({ tags: [" master reference "] }), true);
  assert.equal(shopifyOnboarding.isMasterReference({ tags: ["Master", "Reference Sheet"] }), false);
  assert.equal(shopifyOnboarding.isMasterReference({}), false);
});

/* ---------------------------------------------------------------------------
   §9.2–§9.9 buildProductSetInput (pure)
   ------------------------------------------------------------------------- */

function sampleSetInput(overrides = {}) {
  return {
    productId: "gid://shopify/Product/555",
    title: "Bishop Fire Department Next Level Cotton Tee, Short Sleeve",
    descriptionHtml: "<ul><li>100% cotton</li></ul>",
    vendor: "Non Stock Item",
    tags: ["Bishop Fire Department", " BSH ", ""],
    productType: "Tees & Tanks",
    status: "ACTIVE",
    options: [
      { name: "Size", values: ["S", "M", "L"] },
      { name: "Color", values: ["Navy", "Black"] }
    ],
    variants: [
      {
        optionValues: [{ optionName: "Size", name: "S" }, { optionName: "Color", name: "Navy" }],
        sku: "NL3600-S-NVY-BSH-F01/B01",
        tracked: false,
        requiresShipping: true,
        taxable: true
      },
      {
        optionValues: [{ optionName: "Size", name: "M" }, { optionName: "Color", name: "Black" }],
        sku: "NL3600-M-BLK-BSH-F01/B01",
        tracked: true,
        requiresShipping: false,
        taxable: false
      }
    ],
    ...overrides
  };
}

test("buildProductSetInput carries no id — the product travels in identifier:{id}", () => {
  const out = shopifyOnboarding.buildProductSetInput(sampleSetInput());
  assert.equal("id" in out, false);
  assert.equal("productId" in out, false);
  assert.equal("sourceProductId" in out, false);
  assert.equal("collectionGids" in out, false);
});

test("buildProductSetInput pins DRAFT, price 0.00, CONTINUE and never a cost", () => {
  // status is forced even though the caller asked for ACTIVE (§9.2).
  const out = shopifyOnboarding.buildProductSetInput(sampleSetInput({ status: "ACTIVE" }));
  assert.equal(out.status, "DRAFT");
  assert.equal(out.title, "Bishop Fire Department Next Level Cotton Tee, Short Sleeve");
  assert.equal(out.vendor, "Non Stock Item");
  assert.equal(out.productType, "Tees & Tanks");
  assert.deepEqual(out.tags, ["Bishop Fire Department", "BSH"]);

  for (const variant of out.variants) {
    assert.equal(variant.price, "0.00");
    assert.equal(variant.inventoryPolicy, "CONTINUE");
    assert.equal("cost" in variant, false);
    assert.equal("cost" in variant.inventoryItem, false);
    assert.equal("compareAtPrice" in variant, false);
  }
  assert.equal(shopifyOnboarding.buildProductSetInput(sampleSetInput({ status: "DRAFT" })).status, "DRAFT");
});

test("buildProductSetInput numbers option positions 1..n and shapes optionValues", () => {
  const out = shopifyOnboarding.buildProductSetInput(sampleSetInput());
  assert.deepEqual(out.productOptions, [
    { name: "Size", position: 1, values: [{ name: "S" }, { name: "M" }, { name: "L" }] },
    { name: "Color", position: 2, values: [{ name: "Navy" }, { name: "Black" }] }
  ]);
  assert.deepEqual(out.variants[0].optionValues, [
    { optionName: "Size", name: "S" },
    { optionName: "Color", name: "Navy" }
  ]);

  const three = shopifyOnboarding.buildProductSetInput(
    sampleSetInput({ options: [{ name: "Size", values: ["S"] }, { name: "Color", values: ["Navy"] }, { name: "Style", values: ["Style 1", "Style 2"] }] })
  );
  assert.deepEqual(three.productOptions.map((o) => o.position), [1, 2, 3]);
  assert.equal(three.productOptions[2].name, "Style");
});

test("buildProductSetInput keeps the blank's inventoryItem and tax defaults per variant", () => {
  const out = shopifyOnboarding.buildProductSetInput(sampleSetInput());
  assert.deepEqual(out.variants[0].inventoryItem, { tracked: false, requiresShipping: true });
  assert.equal(out.variants[0].taxable, true);
  assert.deepEqual(out.variants[1].inventoryItem, { tracked: true, requiresShipping: false });
  assert.equal(out.variants[1].taxable, false);

  // Unspecified means "taxable, ships, untracked" — the blank's normal shape.
  const bare = shopifyOnboarding.buildProductSetInput(
    sampleSetInput({ variants: [{ optionValues: [{ optionName: "Size", name: "S" }], sku: "NL3600-S-NVY-BSH-F01" }] })
  );
  assert.deepEqual(bare.variants[0].inventoryItem, { tracked: false, requiresShipping: true });
  assert.equal(bare.variants[0].taxable, true);
  assert.equal(bare.variants[0].sku, "NL3600-S-NVY-BSH-F01");
});

test("buildProductSetInput sends collections only when the caller gives them", () => {
  assert.equal("collections" in shopifyOnboarding.buildProductSetInput(sampleSetInput()), false);
  assert.equal("collections" in shopifyOnboarding.buildProductSetInput(sampleSetInput({ collectionGids: [] })), false);

  const withCollections = shopifyOnboarding.buildProductSetInput(sampleSetInput({ collectionGids: ["gid://shopify/Collection/777", 888] }));
  assert.deepEqual(withCollections.collections, ["gid://shopify/Collection/777", "gid://shopify/Collection/888"]);
});

/* ---------------------------------------------------------------------------
   §9 setProduct
   ------------------------------------------------------------------------- */

const PRODUCT_ID = 555;
const PRODUCT_GID = `gid://shopify/Product/${PRODUCT_ID}`;
const DEPARTMENT_COLLECTION_GID = "gid://shopify/Collection/777";

function variantRows(count) {
  return Array.from({ length: count }, (_, i) => ({
    optionValues: [{ optionName: "Size", name: `S${i}` }, { optionName: "Color", name: "Navy" }],
    sku: `NL3600-S${i}-NVY-BSH-F01/B01`
  }));
}

function variantNodes(count, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `gid://shopify/ProductVariant/${9000 + offset + i}`,
    sku: `NL3600-S${offset + i}-NVY-BSH-F01/B01`,
    title: `S${offset + i} / Navy`,
    selectedOptions: [{ name: "Size", value: `S${offset + i}` }, { name: "Color", value: "Navy" }]
  }));
}

function variantsPage(nodes, { hasNextPage = false, endCursor = null } = {}) {
  return {
    product: {
      id: PRODUCT_GID,
      legacyResourceId: String(PRODUCT_ID),
      title: "Bishop Fire Department Next Level Cotton Tee, Short Sleeve",
      variants: { nodes, pageInfo: { hasNextPage, endCursor } }
    }
  };
}

function syncProductSetResult(vars) {
  return {
    productSet: {
      product: { id: PRODUCT_GID, legacyResourceId: String(PRODUCT_ID), title: vars.input.title },
      productSetOperation: null,
      userErrors: []
    }
  };
}

test("setProduct refuses to overwrite the product it was duplicated from", async (t) => {
  t.after(resetShopify);
  const calls = stubGraphql({});
  shopifyOnboarding.setTransports({ productExists: async () => true });

  await assert.rejects(
    () => shopifyOnboarding.setProduct({ productId: PRODUCT_GID, sourceProductId: PRODUCT_ID, title: "Anything", variants: variantRows(1) }),
    /Refusing to overwrite the source product/
  );
  // Numeric id and gid are the same product — the guard normalizes both.
  await assert.rejects(
    () => shopifyOnboarding.setProduct({ productId: PRODUCT_ID, sourceProductId: PRODUCT_GID, title: "Anything", variants: variantRows(1) }),
    /never the product it was duplicated from/
  );
  assert.equal(calls.length, 0, "nothing is sent to Shopify when the guard trips");
});

test("setProduct refuses more than Shopify's 2048 variants", async (t) => {
  t.after(resetShopify);
  const calls = stubGraphql({});
  shopifyOnboarding.setTransports({ productExists: async () => true });

  await assert.rejects(
    () => shopifyOnboarding.setProduct({ productId: PRODUCT_ID, title: "Huge product", variants: variantRows(shopifyOnboarding.MAX_VARIANTS + 1) }),
    /2049 variants exceed Shopify's 2048-variant limit/
  );
  await assert.rejects(
    () => shopifyOnboarding.setProduct({ productId: PRODUCT_ID, title: "Empty product", variants: [] }),
    /at least one variant is required/
  );
  assert.equal(calls.length, 0);
});

test("setProduct stops when the product to overwrite does not exist", async (t) => {
  t.after(resetShopify);
  const calls = stubGraphql({});
  shopifyOnboarding.setTransports({ productExists: async () => false });

  await assert.rejects(
    () => shopifyOnboarding.setProduct({ productId: PRODUCT_ID, title: "Missing product", variants: variantRows(1) }),
    /does not exist in Shopify/
  );
  assert.equal(calls.length, 0);
});

test("setProduct targets identifier:{id}, runs synchronously at 100 variants, and pages every variant back", async (t) => {
  t.after(resetShopify);
  const logs = [];
  const existsChecks = [];
  const calls = stubGraphql({
    productSet: syncProductSetResult,
    productVariants: (vars) =>
      vars.after
        ? variantsPage(variantNodes(40, 100))
        : variantsPage(variantNodes(100), { hasNextPage: true, endCursor: "cursor-1" }),
    productCollections: () => ({
      product: {
        collections: {
          nodes: [
            { id: DEPARTMENT_COLLECTION_GID, legacyResourceId: "777", title: "1. Bishop Fire Department" },
            { id: "gid://shopify/Collection/999", legacyResourceId: "999", title: "1. Ripon Fire Department" },
            { id: "gid://shopify/Collection/998", legacyResourceId: "998", title: "New Arrivals" }
          ]
        }
      }
    }),
    collectionRemoveProducts: (vars) =>
      vars.id === "gid://shopify/Collection/998"
        ? { collectionRemoveProducts: { job: null, userErrors: [{ field: ["id"], message: "Cannot remove products from a smart collection." }] } }
        : { collectionRemoveProducts: { job: { id: "gid://shopify/Job/1" }, userErrors: [] } }
  });
  shopifyOnboarding.setTransports({
    productExists: async (id) => {
      existsChecks.push(id);
      return true;
    }
  });

  const result = await shopifyOnboarding.setProduct(
    {
      ...sampleSetInput({ variants: variantRows(shopifyOnboarding.SYNC_VARIANT_LIMIT), collectionGids: [DEPARTMENT_COLLECTION_GID] }),
      productId: PRODUCT_ID,
      sourceProductId: 2001
    },
    { onLog: (line) => logs.push(line) }
  );

  const [productSetCall] = callsNamed(calls, "productSet");
  assert.deepEqual(productSetCall.variables.identifier, { id: PRODUCT_GID });
  assert.equal("id" in productSetCall.variables.input, false, "ProductSetInput.id is deprecated — the id rides in identifier");
  assert.equal(productSetCall.variables.synchronous, true);
  assert.equal(productSetCall.variables.input.status, "DRAFT");
  assert.deepEqual(productSetCall.variables.input.collections, [DEPARTMENT_COLLECTION_GID]);
  assert.deepEqual(existsChecks, [PRODUCT_GID]);
  assert.equal(callsNamed(calls, "productOperation").length, 0, "a synchronous productSet is never polled");

  // Both pages come back, in order.
  assert.equal(result.variants.length, 140);
  assert.equal(result.variants[0].sku, "NL3600-S0-NVY-BSH-F01/B01");
  assert.equal(result.variants[139].sku, "NL3600-S139-NVY-BSH-F01/B01");
  assert.equal(callsNamed(calls, "productVariants")[1].variables.after, "cursor-1");
  assert.equal(result.id, PRODUCT_GID);
  assert.equal(result.legacyId, String(PRODUCT_ID));
  assert.match(result.url, /\/admin\/products\/555$/);
  assert.equal(result.collectionsFallback, false);

  // §9.3 carried-over collections are detached; a smart collection cannot be
  // and becomes a warning rather than a failure.
  assert.deepEqual(result.removedCollections.map((c) => c.title), ["1. Ripon Fire Department"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /New Arrivals/);
  assert.ok(logs.some((line) => /synchronous/.test(line)), "progress is reported through onLog, never the console");
});

test("setProduct runs the async operation above 100 variants and waits for COMPLETE", async (t) => {
  t.after(resetShopify);
  const operationId = "gid://shopify/ProductSetOperation/42";
  const sleeps = [];
  let polls = 0;
  const logs = [];
  const calls = stubGraphql({
    productSet: () => ({
      productSet: { product: null, productSetOperation: { id: operationId, status: "CREATED" }, userErrors: [] }
    }),
    productOperation: () => {
      polls += 1;
      if (polls < 3) return { productOperation: { id: operationId, status: "RUNNING", product: null, userErrors: [] } };
      return {
        productOperation: {
          id: operationId,
          status: "COMPLETE",
          product: { id: PRODUCT_GID, legacyResourceId: String(PRODUCT_ID), title: "Bishop tee" },
          userErrors: []
        }
      };
    },
    productVariants: () => variantsPage(variantNodes(101))
  });
  shopifyOnboarding.setTransports({
    productExists: async () => true,
    sleep: async (ms) => {
      sleeps.push(ms);
    }
  });

  const result = await shopifyOnboarding.setProduct(
    { ...sampleSetInput({ variants: variantRows(shopifyOnboarding.SYNC_VARIANT_LIMIT + 1) }), productId: PRODUCT_ID },
    { onLog: (line) => logs.push(line) }
  );

  assert.equal(callsNamed(calls, "productSet")[0].variables.synchronous, false);
  assert.equal(callsNamed(calls, "productOperation").length, 3);
  assert.equal(callsNamed(calls, "productOperation")[0].variables.id, operationId);
  assert.deepEqual(sleeps, [2000, 2000]);
  assert.equal(result.id, PRODUCT_GID);
  assert.equal(result.variants.length, 101);
  assert.ok(logs.some((line) => /async operation/.test(line)));
});

test("setProduct surfaces productSet userErrors", async (t) => {
  t.after(resetShopify);
  stubGraphql({
    productSet: () => ({
      productSet: { product: null, productSetOperation: null, userErrors: [{ code: "INVALID", field: ["input", "variants"], message: "SKU has already been taken" }] }
    })
  });
  shopifyOnboarding.setTransports({ productExists: async () => true });

  await assert.rejects(
    () => shopifyOnboarding.setProduct({ ...sampleSetInput(), productId: PRODUCT_ID }),
    /Shopify productSet: SKU has already been taken/
  );
});

/* ---------------------------------------------------------------------------
   §6 ensureDepartmentCollection
   ------------------------------------------------------------------------- */

const COLLECTION_TITLE = "1. Bishop Fire Department";
const ONLINE_STORE_PUBLICATION_GID = "gid://shopify/Publication/1";

function collectionNode(overrides = {}) {
  return {
    id: "gid://shopify/Collection/777",
    legacyResourceId: "777",
    title: COLLECTION_TITLE,
    handle: "1-bishop-fire-department",
    descriptionHtml: rules.collectionDescriptionHtml(),
    image: null,
    ...overrides
  };
}

function publicationHandlers({ onlineStore = true } = {}) {
  return {
    publications: () => ({
      publications: {
        nodes: onlineStore
          ? [{ id: ONLINE_STORE_PUBLICATION_GID, name: "Online Store" }, { id: "gid://shopify/Publication/2", name: "Point of Sale" }]
          : [{ id: "gid://shopify/Publication/2", name: "Point of Sale" }]
      }
    }),
    publishablePublish: () => ({ publishablePublish: { userErrors: [] } })
  };
}

// collectionUpdate echoes the patched collection back the way Shopify does.
function collectionUpdateHandler(node) {
  return (vars) => {
    const next = { ...node };
    if (vars.input.descriptionHtml != null) next.descriptionHtml = vars.input.descriptionHtml;
    if (vars.input.image) next.image = { url: "https://cdn.shopify.com/banner.png", altText: vars.input.image.altText, width: 3584, height: 2048 };
    Object.assign(node, next);
    return { collectionUpdate: { collection: { ...next }, userErrors: [] } };
  };
}

test("ensureDepartmentCollection creates the collection when no exact title matches", async (t) => {
  t.after(resetShopify);
  const created = collectionNode();
  const logs = [];
  const calls = stubGraphql({
    // Shopify's loose search offers the neighbouring store; only "===" decides.
    findCollections: () => ({ collections: { nodes: [collectionNode({ id: "gid://shopify/Collection/888", legacyResourceId: "888", title: "2. Bishop Fire Department" })] } }),
    collectionCreate: (vars) => ({ collectionCreate: { collection: { ...created, title: vars.input.title, descriptionHtml: vars.input.descriptionHtml }, userErrors: [] } }),
    ...publicationHandlers()
  });

  const result = await shopifyOnboarding.ensureDepartmentCollection({ title: COLLECTION_TITLE }, { onLog: (line) => logs.push(line) });

  assert.equal(result.created, true);
  assert.equal(result.title, COLLECTION_TITLE);
  assert.equal(result.id, "777");
  assert.equal(result.gid, "gid://shopify/Collection/777");
  assert.equal(result.storefrontPath, "/collections/1-bishop-fire-department");
  assert.match(result.url, /\/admin\/collections\/777$/);
  // The description defaults to the rule, not to anything the model wrote.
  assert.equal(callsNamed(calls, "collectionCreate")[0].variables.input.descriptionHtml, rules.collectionDescriptionHtml());
  assert.equal(result.banner.set, false);
  assert.equal(result.banner.reason, "no banner supplied");
  assert.deepEqual(result.warnings, []);
  // The phrase search is retried on the bare name before giving up.
  assert.deepEqual(callsNamed(calls, "findCollections").map((c) => c.variables.query), ['title:"1. Bishop Fire Department"', 'title:"Bishop Fire Department"']);
  assert.ok(logs.some((line) => /Created collection/.test(line)));
});

test("ensureDepartmentCollection finds the exact title and never confuses store 1 with store 2", async (t) => {
  t.after(resetShopify);
  const existing = collectionNode();
  const calls = stubGraphql({
    findCollections: () => ({
      collections: {
        nodes: [
          collectionNode({ id: "gid://shopify/Collection/888", legacyResourceId: "888", title: "2. Bishop Fire Department" }),
          existing
        ]
      }
    }),
    ...publicationHandlers()
  });

  const result = await shopifyOnboarding.ensureDepartmentCollection({ title: COLLECTION_TITLE });
  assert.equal(result.created, false);
  assert.equal(result.gid, existing.id);
  assert.equal(result.descriptionUpdated, false);
  assert.equal(callsNamed(calls, "findCollections").length, 1, "an exact hit needs no second search");
  assert.equal(callsNamed(calls, "collectionCreate").length, 0);
  assert.equal(callsNamed(calls, "collectionUpdate").length, 0, "an identical description is left alone");
});

test("ensureDepartmentCollection rewrites only a description that really differs", async (t) => {
  t.after(resetShopify);
  const existing = collectionNode({ descriptionHtml: "<p>Old wording from another department.</p>" });
  const calls = stubGraphql({
    findCollections: () => ({ collections: { nodes: [existing] } }),
    collectionUpdate: collectionUpdateHandler(existing),
    ...publicationHandlers()
  });

  const result = await shopifyOnboarding.ensureDepartmentCollection({ title: COLLECTION_TITLE });
  assert.equal(result.descriptionUpdated, true);
  assert.equal(result.descriptionHtml, rules.collectionDescriptionHtml());
  assert.equal(callsNamed(calls, "collectionUpdate")[0].variables.input.id, existing.id);

  // Whitespace-only differences are not a change.
  resetShopify();
  const spaced = collectionNode({ descriptionHtml: `  ${rules.collectionDescriptionHtml().replace(/\n/g, "\n  ")}  ` });
  const calls2 = stubGraphql({
    findCollections: () => ({ collections: { nodes: [spaced] } }),
    ...publicationHandlers()
  });
  const result2 = await shopifyOnboarding.ensureDepartmentCollection({ title: COLLECTION_TITLE });
  assert.equal(result2.descriptionUpdated, false);
  assert.equal(callsNamed(calls2, "collectionUpdate").length, 0);
});

test("ensureDepartmentCollection sets a banner on a new collection but never replaces an existing image", async (t) => {
  t.after(resetShopify);
  const created = collectionNode();
  const uploads = [];
  const calls = stubGraphql({
    findCollections: () => ({ collections: { nodes: [] } }),
    collectionCreate: (vars) => ({ collectionCreate: { collection: { ...created, title: vars.input.title, descriptionHtml: vars.input.descriptionHtml }, userErrors: [] } }),
    stagedUploadsCreate: () => ({
      stagedUploadsCreate: {
        stagedTargets: [{ url: "https://storage.googleapis.com/shopify-staged", resourceUrl: "https://storage.googleapis.com/shopify-staged/banner.png", parameters: [{ name: "key", value: "tmp/banner.png" }] }],
        userErrors: []
      }
    }),
    collectionUpdate: collectionUpdateHandler(created),
    ...publicationHandlers()
  });
  shopifyOnboarding.setTransports({
    uploadToTarget: async (target, file) => {
      uploads.push({ url: target.url, filename: file.filename, mimeType: file.mimeType, bytes: file.buffer.length });
    }
  });

  const result = await shopifyOnboarding.ensureDepartmentCollection({
    title: COLLECTION_TITLE,
    bannerBuffer: Buffer.from("png-bytes"),
    bannerAlt: "Bishop Fire Department banner"
  });
  assert.equal(result.banner.set, true);
  assert.equal(result.banner.reason, "set on the new collection");
  assert.deepEqual(uploads, [{ url: "https://storage.googleapis.com/shopify-staged", filename: "1-bishop-fire-department-banner.png", mimeType: "image/png", bytes: 9 }]);
  const imageUpdate = callsNamed(calls, "collectionUpdate").find((c) => c.variables.input.image);
  assert.equal(imageUpdate.variables.input.image.src, "https://storage.googleapis.com/shopify-staged/banner.png");
  assert.equal(imageUpdate.variables.input.image.altText, "Bishop Fire Department banner");
  assert.equal(result.image.width, 3584);

  // An existing collection that already has an image keeps it — Dan may have
  // set that image by hand.
  resetShopify();
  const existing = collectionNode({ image: { url: "https://cdn.shopify.com/dan-made-this.png", altText: "", width: 3584, height: 2048 } });
  const calls2 = stubGraphql({
    findCollections: () => ({ collections: { nodes: [existing] } }),
    ...publicationHandlers()
  });
  const result2 = await shopifyOnboarding.ensureDepartmentCollection({ title: COLLECTION_TITLE, bannerBuffer: Buffer.from("png-bytes") });
  assert.equal(result2.banner.set, false);
  assert.match(result2.banner.reason, /kept as-is/);
  assert.equal(callsNamed(calls2, "stagedUploadsCreate").length, 0);
  assert.equal(callsNamed(calls2, "collectionUpdate").length, 0);
  assert.equal(result2.image.url, "https://cdn.shopify.com/dan-made-this.png");
});

test("ensureDepartmentCollection publishes to the Online Store and warns when it cannot", async (t) => {
  t.after(resetShopify);
  const existing = collectionNode();
  const calls = stubGraphql({
    findCollections: () => ({ collections: { nodes: [existing] } }),
    ...publicationHandlers()
  });

  const result = await shopifyOnboarding.ensureDepartmentCollection({ title: COLLECTION_TITLE });
  assert.equal(result.published, true);
  assert.deepEqual(callsNamed(calls, "publishablePublish")[0].variables, {
    id: existing.id,
    input: [{ publicationId: ONLINE_STORE_PUBLICATION_GID }]
  });

  // No Online Store publication visible to the token → a warning, not a throw.
  resetShopify();
  stubGraphql({
    findCollections: () => ({ collections: { nodes: [existing] } }),
    ...publicationHandlers({ onlineStore: false })
  });
  const result2 = await shopifyOnboarding.ensureDepartmentCollection({ title: COLLECTION_TITLE });
  assert.equal(result2.published, false);
  assert.equal(result2.warnings.length, 1);
  assert.match(result2.warnings[0], /not confirmed published/);

  await assert.rejects(() => shopifyOnboarding.ensureDepartmentCollection({ title: "  " }), /needs a title/);
});

/* ---------------------------------------------------------------------------
   §8a Mega Menu
   ------------------------------------------------------------------------- */

function collectionItem(id, title, collectionId, handle) {
  return {
    id: `gid://shopify/MenuItem/${id}`,
    title,
    type: "COLLECTION",
    url: `https://fnsimple.com/collections/${handle}`,
    resourceId: `gid://shopify/Collection/${collectionId}`,
    tags: [],
    items: []
  };
}

// The live Mega Menu: department stores oldest→newest under "Store", then the
// public stores, then the rest of the top-level navigation.
/* Mirrors the live megamenu: department entries are named WITHOUT the
   collection's "N." ordinal (the handle keeps it), and the public stores
   follow them. */
function megaMenuFixture() {
  return {
    id: "gid://shopify/Menu/191418204297",
    title: "Mega Menu",
    handle: "megamenu",
    items: [
      { id: "gid://shopify/MenuItem/1", title: "Home", type: "FRONTPAGE", url: "https://fnsimple.com/", resourceId: null, tags: [], items: [] },
      {
        id: "gid://shopify/MenuItem/2",
        title: "Store",
        type: "COLLECTIONS",
        url: "https://fnsimple.com/collections",
        resourceId: null,
        tags: [],
        items: [
          collectionItem(21, "Ripon Fire Department", 601, "1-ripon-fire-department"),
          collectionItem(22, "Bishop Fire Department", 602, "1-bishop-fire-department"),
          collectionItem(23, "Bishop Fire Department Union", 603, "2-bishop-fire-department-union"),
          collectionItem(24, "FN Simple Merch", 604, "fn-simple-merch"),
          collectionItem(25, "SF City Gear", 605, "sf-city-gear"),
          collectionItem(26, "Bay Area Firefighter", 606, "bay-area-firefighter"),
          { id: "gid://shopify/MenuItem/27", title: "LOGIN to see your Shop", type: "HTTP", url: "https://fnsimple.com/account/login", resourceId: null, tags: ["login"], items: [] }
        ]
      },
      { id: "gid://shopify/MenuItem/3", title: "Sizing", type: "PAGE", url: "https://fnsimple.com/pages/sizing", resourceId: "gid://shopify/Page/31", tags: [], items: [] },
      { id: "gid://shopify/MenuItem/4", title: "Custom Orders", type: "PAGE", url: "https://fnsimple.com/pages/custom-orders", resourceId: "gid://shopify/Page/32", tags: [], items: [] },
      {
        id: "gid://shopify/MenuItem/5",
        title: "Contact",
        type: "PAGE",
        url: "https://fnsimple.com/pages/contact",
        resourceId: "gid://shopify/Page/33",
        tags: [],
        items: [
          { id: "gid://shopify/MenuItem/51", title: "Contact Us", type: "PAGE", url: "https://fnsimple.com/pages/contact-us", resourceId: "gid://shopify/Page/34", tags: [], items: [] },
          { id: "gid://shopify/MenuItem/52", title: "FAQ", type: "PAGE", url: "https://fnsimple.com/pages/faq", resourceId: "gid://shopify/Page/35", tags: [], items: [] }
        ]
      },
      { id: "gid://shopify/MenuItem/6", title: "About Us", type: "PAGE", url: "https://fnsimple.com/pages/about-us", resourceId: "gid://shopify/Page/36", tags: [], items: [] }
    ]
  };
}

const NEW_STORE = {
  title: "Vacaville Fire Department",
  collectionHandle: "1-vacaville-fire-department",
  collectionGid: "gid://shopify/Collection/700"
};

// Pre-order walk of the identity fields every existing entry must keep.
function flattenItems(items) {
  const out = [];
  for (const item of items || []) {
    out.push({
      id: item.id ?? null,
      title: item.title,
      type: item.type,
      url: item.url ?? null,
      resourceId: item.resourceId ?? null
    });
    out.push(...flattenItems(item.items));
  }
  return out;
}

test("readMegaMenu normalizes the menu and reports ACCESS_DENIED instead of throwing", async (t) => {
  t.after(resetShopify);
  stubGraphql({ megaMenu: () => ({ menus: { nodes: [{ id: "gid://shopify/Menu/1", title: "Footer", handle: "footer", items: [] }, megaMenuFixture()] } }) });

  const read = await shopifyOnboarding.readMegaMenu();
  assert.equal(read.available, true);
  assert.equal(read.menu.handle, "megamenu");
  assert.deepEqual(read.menu.items.map((i) => i.title), ["Home", "Store", "Sizing", "Custom Orders", "Contact", "About Us"]);
  assert.equal(read.menu.items[4].items.length, 2);

  // The platform token has no read_online_store_navigation scope in some
  // stores; that is a checklist, not a crash.
  resetShopify();
  stubGraphql({
    megaMenu: () => {
      throw new Error("Shopify GraphQL errors: ACCESS_DENIED: This app is not approved to access the Menu object.");
    }
  });
  const denied = await shopifyOnboarding.readMegaMenu();
  assert.equal(denied.available, false);
  assert.equal(denied.accessDenied, true);
  assert.match(denied.reason, /ACCESS_DENIED/);
  assert.equal("menu" in denied, false);
  assert.equal(shopifyOnboarding.isAccessDenied(new Error("ACCESS_DENIED")), true);
  assert.equal(shopifyOnboarding.isAccessDenied(new Error("Shopify 502 Bad Gateway")), false);

  // A transport failure that is not a scope problem is still reported, but not
  // as a scope problem.
  resetShopify();
  stubGraphql({
    megaMenu: () => {
      throw new Error("Shopify 502 Bad Gateway");
    }
  });
  const down = await shopifyOnboarding.readMegaMenu();
  assert.equal(down.available, false);
  assert.equal(down.accessDenied, false);

  // No Mega Menu at all: the reason names the handles that were there.
  resetShopify();
  stubGraphql({ megaMenu: () => ({ menus: { nodes: [{ id: "gid://shopify/Menu/1", title: "Footer", handle: "footer", items: [] }] } }) });
  const missing = await shopifyOnboarding.readMegaMenu();
  assert.equal(missing.available, false);
  assert.equal(missing.accessDenied, false);
  assert.match(missing.reason, /footer/);
});

test("findStoreItem picks Store by title, else the COLLECTIONS entry", () => {
  const menu = megaMenuFixture();
  assert.equal(shopifyOnboarding.findStoreItem(menu).id, "gid://shopify/MenuItem/2");

  const renamed = megaMenuFixture();
  renamed.items[1].title = "Shop by Department";
  assert.equal(shopifyOnboarding.findStoreItem(renamed).id, "gid://shopify/MenuItem/2");

  const none = megaMenuFixture();
  none.items[1].title = "Shop by Department";
  none.items[1].type = "HTTP";
  assert.equal(shopifyOnboarding.findStoreItem(none), null);
  assert.equal(shopifyOnboarding.findStoreItem(null), null);
});

test("verifyMegaMenu finds the store by collection, not only by the exact title", async (t) => {
  t.after(resetShopify);
  stubGraphql({ megaMenu: () => ({ menus: { nodes: [megaMenuFixture()] } }) });

  const byTitle = await shopifyOnboarding.verifyMegaMenu("Bishop Fire Department");
  assert.equal(byTitle.present, true);
  assert.equal(byTitle.index, 1);
  assert.equal(byTitle.before, "Ripon Fire Department");

  /* Dan names an item he adds by hand however he likes, and the final check
     now blocks on "not there" — so a store that IS in the menu must not be
     reported missing over a spelling. */
  const renamed = await shopifyOnboarding.verifyMegaMenu("1. Bishop Fire Department", {
    collectionGid: "gid://shopify/Collection/602"
  });
  assert.equal(renamed.present, true);
  assert.equal(renamed.index, 1);

  // A collection that really is absent is still absent.
  const missing = await shopifyOnboarding.verifyMegaMenu("Vacaville Fire Department", {
    collectionGid: "gid://shopify/Collection/700"
  });
  assert.equal(missing.present, false);
  assert.equal(missing.index, -1);
});


test("proposeMegaMenuInsert lands after the last department store and before the first public store", () => {
  const menu = megaMenuFixture();
  const proposal = shopifyOnboarding.proposeMegaMenuInsert(menu, NEW_STORE);

  assert.equal(proposal.storeItemId, "gid://shopify/MenuItem/2");
  assert.equal(proposal.storeItemTitle, "Store");
  assert.equal(proposal.index, 3);
  assert.equal(proposal.insertAfter, "Bishop Fire Department Union");
  assert.equal(proposal.insertBefore, "FN Simple Merch");
  assert.equal(proposal.alreadyPresent, false);
  assert.equal(proposal.existingItemId, null);
  assert.deepEqual(proposal.newItem, {
    title: "Vacaville Fire Department",
    type: "COLLECTION",
    url: "/collections/1-vacaville-fire-department",
    resourceId: "gid://shopify/Collection/700"
  });
  assert.deepEqual(proposal.itemsPreview, [
    "Ripon Fire Department",
    "Bishop Fire Department",
    "Bishop Fire Department Union",
    "Vacaville Fire Department",
    "FN Simple Merch",
    "SF City Gear",
    "Bay Area Firefighter"
  ]);
});

test("proposeMegaMenuInsert recognises an item that is already there, and a menu with no Store", () => {
  const menu = megaMenuFixture();
  const present = shopifyOnboarding.proposeMegaMenuInsert(menu, {
    title: "Bishop Fire Department",
    collectionHandle: "1-bishop-fire-department",
    collectionGid: "gid://shopify/Collection/602"
  });
  assert.equal(present.alreadyPresent, true);
  assert.equal(present.existingItemId, "gid://shopify/MenuItem/22");
  assert.equal(present.index, 1);

  // Matched by resourceId even when the title was edited by hand.
  const renamed = shopifyOnboarding.proposeMegaMenuInsert(menu, {
    title: "Bishop FD",
    collectionHandle: "1-bishop-fire-department",
    collectionGid: "gid://shopify/Collection/602"
  });
  assert.equal(renamed.alreadyPresent, true);
  assert.equal(renamed.existingItemId, "gid://shopify/MenuItem/22");

  const noStore = { id: "gid://shopify/Menu/9", title: "Mega Menu", handle: "megamenu", items: [{ id: "gid://shopify/MenuItem/1", title: "Home", type: "FRONTPAGE", url: "/", resourceId: null, tags: [], items: [] }] };
  const orphan = shopifyOnboarding.proposeMegaMenuInsert(noStore, NEW_STORE);
  assert.equal(orphan.storeItemId, null);
  assert.equal(orphan.index, -1);
  assert.match(orphan.reason, /no "Store" item/);
});

test("buildMenuUpdateItems inserts the new store and loses nothing", () => {
  const menu = megaMenuFixture();
  const proposal = shopifyOnboarding.proposeMegaMenuInsert(menu, NEW_STORE);
  const items = shopifyOnboarding.buildMenuUpdateItems(menu, proposal);

  // Top level: same items, same order.
  assert.deepEqual(items.map((i) => i.title), ["Home", "Store", "Sizing", "Custom Orders", "Contact", "About Us"]);

  const store = items[1];
  assert.deepEqual(store.items.map((i) => i.title), [
    "Ripon Fire Department",
    "Bishop Fire Department",
    "Bishop Fire Department Union",
    "Vacaville Fire Department",
    "FN Simple Merch",
    "SF City Gear",
    "Bay Area Firefighter",
    "LOGIN to see your Shop"
  ]);

  // The new item is the only one without an id (menuUpdate creates it); every
  // other entry goes back with its id so it keeps its identity.
  const flatUpdate = flattenItems(items);
  const fresh = flatUpdate.filter((i) => i.id === null);
  assert.equal(fresh.length, 1);
  assert.deepEqual(fresh[0], {
    id: null,
    title: "Vacaville Fire Department",
    type: "COLLECTION",
    url: "/collections/1-vacaville-fire-department",
    resourceId: "gid://shopify/Collection/700"
  });
  assert.deepEqual(flatUpdate.filter((i) => i.id !== null), flattenItems(menu.items));

  // Nested children and tags survive the round trip.
  assert.deepEqual(items[4].items.map((i) => i.id), ["gid://shopify/MenuItem/51", "gid://shopify/MenuItem/52"]);
  assert.deepEqual(store.items[7].tags, ["login"]);
  assert.equal("tags" in store.items[0], false, "empty tags are not sent");
  assert.equal(store.type, "COLLECTIONS");
  assert.equal(store.id, "gid://shopify/MenuItem/2");
});

test("buildMenuUpdateItems leaves the tree alone when the store is already listed, and rejects a stale proposal", () => {
  const menu = megaMenuFixture();
  const present = shopifyOnboarding.proposeMegaMenuInsert(menu, {
    title: "Bishop Fire Department",
    collectionHandle: "1-bishop-fire-department",
    collectionGid: "gid://shopify/Collection/602"
  });
  const unchanged = shopifyOnboarding.buildMenuUpdateItems(menu, present);
  assert.deepEqual(flattenItems(unchanged), flattenItems(menu.items));

  const proposal = shopifyOnboarding.proposeMegaMenuInsert(menu, NEW_STORE);
  const otherMenu = { ...megaMenuFixture(), items: megaMenuFixture().items.filter((i) => i.title !== "Store") };
  assert.throws(() => shopifyOnboarding.buildMenuUpdateItems(otherMenu, proposal), /re-read the menu and propose again/);
  assert.throws(() => shopifyOnboarding.buildMenuUpdateItems(menu, { newItem: { title: "x" } }), /No Mega Menu insertion point/);
});

test("applyMegaMenuInsert re-reads, inserts, and refuses a proposal the menu has outgrown", async (t) => {
  t.after(resetShopify);
  const logs = [];
  const calls = stubGraphql({
    megaMenu: () => ({ menus: { nodes: [megaMenuFixture()] } }),
    menuUpdate: (vars) => {
      const menu = megaMenuFixture();
      const store = menu.items.find((i) => i.title === "Store");
      store.items.splice(3, 0, collectionItem(28, NEW_STORE.title, 700, NEW_STORE.collectionHandle));
      return { menuUpdate: { menu: { ...menu, items: menu.items, id: vars.id, title: vars.title }, userErrors: [] } };
    }
  });

  const read = await shopifyOnboarding.readMegaMenu();
  const proposal = shopifyOnboarding.proposeMegaMenuInsert(read.menu, NEW_STORE);
  const applied = await shopifyOnboarding.applyMegaMenuInsert(read.menu, proposal, { onLog: (line) => logs.push(line) });

  assert.equal(applied.applied, true);
  assert.equal(applied.alreadyPresent, false);
  assert.equal(applied.index, 3);
  assert.equal(applied.menuItemId, "gid://shopify/MenuItem/28");
  const update = callsNamed(calls, "menuUpdate")[0];
  assert.equal(update.variables.id, "gid://shopify/Menu/191418204297");
  assert.equal(update.variables.title, "Mega Menu");
  assert.equal(update.variables.items.length, 6);
  assert.ok(logs.some((line) => /Inserted/.test(line)));

  // Another department landed in between since Dan approved → stop, don't
  // insert somewhere he did not approve.
  resetShopify();
  stubGraphql({
    megaMenu: () => {
      const menu = megaMenuFixture();
      menu.items.find((i) => i.title === "Store").items.splice(3, 0, collectionItem(29, "1. Tracy Fire Department", 699, "1-tracy-fire-department"));
      return { menus: { nodes: [menu] } };
    }
  });
  await assert.rejects(() => shopifyOnboarding.applyMegaMenuInsert(read.menu, proposal), (error) => {
    assert.equal(error.code, "STALE_PROPOSAL");
    assert.match(error.message, /changed since the proposal was approved/);
    return true;
  });
});
/* ---------------------------------------------------------------------------
   §8a against the LIVE Mega Menu.

   Every test above runs on a seven-entry fixture. The real menu is 108 entries
   under "Store" — four with children of their own, one an HTTP link with no
   resource — and `test/fixtures/megamenu-live.json` is a verbatim dump of it.
   The insert is replayed here through a menuUpdate that enforces the real
   MenuItemUpdateInput contract, because this is the one write in the agent
   that no test had ever put through its own code path.
   ------------------------------------------------------------------------- */

const LIVE_MENU = require("./fixtures/megamenu-live.json");
const liveMenu = () => JSON.parse(JSON.stringify(LIVE_MENU));

// Not in the live menu — "Vacaville Fire Department" (NEW_STORE) already is,
// which is the right answer for that name and the wrong test for this one.
const LIVE_NEW_STORE = {
  title: "Zol Test Fire Department",
  collectionHandle: "1-zol-test-fire-department",
  collectionGid: "gid://shopify/Collection/900700"
};

/*
 * menuUpdate replaces the whole tree: an item sent back with its id keeps it,
 * an item without one is created. The argument is [MenuItemUpdateInput!]!, so
 * a stray key or a missing title is a schema error — assert the contract here
 * rather than discovering it against the live store.
 */
const MENU_ITEM_INPUT_FIELDS = new Set(["title", "type", "resourceId", "url", "tags", "id", "items"]);
const MENU_ITEM_TYPES = new Set([
  "FRONTPAGE", "COLLECTION", "COLLECTIONS", "PRODUCT", "CATALOG", "PAGE",
  "BLOG", "ARTICLE", "SEARCH", "SHOP_POLICY", "HTTP", "METAOBJECT", "CUSTOMER_ACCOUNT_PAGE"
]);

let nextMenuItemId = 900000;
function applyMenuUpdateInput(items, path = "items") {
  return (items || []).map((item, i) => {
    const where = `${path}[${i}] "${item.title}"`;
    for (const key of Object.keys(item)) {
      assert.ok(MENU_ITEM_INPUT_FIELDS.has(key), `${where}: "${key}" is not a MenuItemUpdateInput field`);
    }
    assert.ok(typeof item.title === "string" && item.title.length > 0, `${where}: title is non-null in the schema`);
    assert.ok(MENU_ITEM_TYPES.has(item.type), `${where}: "${item.type}" is not a MenuItemType`);
    if ("tags" in item) assert.ok(Array.isArray(item.tags) && item.tags.every((t) => typeof t === "string"), `${where}: tags must be [String!]`);
    return {
      id: item.id || `gid://shopify/MenuItem/${nextMenuItemId++}`,
      title: item.title,
      type: item.type,
      url: item.url ?? null,
      resourceId: item.resourceId ?? null,
      tags: item.tags || [],
      items: applyMenuUpdateInput(item.items, `${where}.items`)
    };
  });
}

const storeItemOf = (menu) => menu.items.find((i) => i.type === "COLLECTIONS");

test("the live 108-entry Mega Menu takes the insert before the public stores and loses nothing", async (t) => {
  t.after(resetShopify);
  let current = liveMenu();
  const calls = stubGraphql({
    megaMenu: () => ({ menus: { nodes: [current] } }),
    menuUpdate: (vars) => {
      assert.equal(vars.id, current.id, "menuUpdate targets the menu that was read");
      assert.equal(vars.title, current.title, "the menu keeps its own title");
      current = { ...current, items: applyMenuUpdateInput(vars.items) };
      return { menuUpdate: { menu: current, userErrors: [] } };
    }
  });

  const before = liveMenu();
  const storeBefore = storeItemOf(before);
  assert.equal(storeBefore.items.length, 108, "the fixture is the live menu");

  const read = await shopifyOnboarding.readMegaMenu();
  const proposal = shopifyOnboarding.proposeMegaMenuInsert(read.menu, LIVE_NEW_STORE);
  assert.equal(proposal.alreadyPresent, false);
  assert.equal(proposal.index, 104);
  assert.equal(proposal.insertAfter, "Ripon Fire District");
  assert.equal(proposal.insertBefore, "FN Simple Merch");

  const applied = await shopifyOnboarding.applyMegaMenuInsert(read.menu, proposal, {});
  assert.equal(applied.applied, true);
  assert.equal(applied.alreadyPresent, false);
  assert.equal(applied.index, 104);
  assert.ok(applied.menuItemId, "the new item's id comes back from the mutation, not from hope");

  const storeAfter = storeItemOf(current);
  assert.equal(storeAfter.items.length, 109);
  assert.equal(storeAfter.items[104].title, LIVE_NEW_STORE.title);
  assert.equal(storeAfter.items[104].resourceId, LIVE_NEW_STORE.collectionGid);
  assert.equal(storeAfter.items[104].type, "COLLECTION");
  assert.equal(storeAfter.items[104].id, applied.menuItemId);

  // Every entry that was there is still there, in order, with its id: the
  // HTTP login link, the four stores with children, the six top-level items.
  const survived = flattenItems(storeAfter.items).filter((i) => i.title !== LIVE_NEW_STORE.title);
  assert.deepEqual(survived, flattenItems(storeBefore.items));
  assert.deepEqual(current.items.map((i) => i.title), before.items.map((i) => i.title));
  assert.equal(flattenItems(current.items).length, flattenItems(before.items).length + 1);

  // Pressing finish twice must not list the store twice.
  const writes = callsNamed(calls, "menuUpdate").length;
  const again = await shopifyOnboarding.applyMegaMenuInsert(read.menu, proposal, {});
  assert.equal(again.alreadyPresent, true);
  assert.equal(again.applied, true);
  assert.equal(again.menuItemId, applied.menuItemId);
  assert.equal(callsNamed(calls, "menuUpdate").length, writes, "a store already in the menu is never written again");
});

test("a live menu that moved under the approved proposal is refused, not inserted elsewhere", async (t) => {
  t.after(resetShopify);
  let current = liveMenu();
  stubGraphql({
    megaMenu: () => ({ menus: { nodes: [current] } }),
    menuUpdate: () => {
      throw new Error("menuUpdate must not be called for a stale proposal");
    }
  });

  const read = await shopifyOnboarding.readMegaMenu();
  const proposal = shopifyOnboarding.proposeMegaMenuInsert(read.menu, LIVE_NEW_STORE);

  // Another onboarding finished in between and its store took index 104.
  current = liveMenu();
  storeItemOf(current).items.splice(104, 0, collectionItem(880, "Tracy Fire Department", 900800, "1-tracy-fire-department"));

  await assert.rejects(() => shopifyOnboarding.applyMegaMenuInsert(read.menu, proposal, {}), (error) => {
    assert.equal(error.code, "STALE_PROPOSAL");
    assert.match(error.message, /after "Ripon Fire District"/);
    assert.match(error.message, /after "Tracy Fire Department"/);
    return true;
  });
});


test("verifyMegaMenu reports where the store ended up, or why it could not look", async (t) => {
  t.after(resetShopify);
  stubGraphql({
    megaMenu: () => {
      const menu = megaMenuFixture();
      menu.items.find((i) => i.title === "Store").items.splice(3, 0, collectionItem(28, NEW_STORE.title, 700, NEW_STORE.collectionHandle));
      return { menus: { nodes: [menu] } };
    }
  });
  const verified = await shopifyOnboarding.verifyMegaMenu(NEW_STORE.title);
  assert.deepEqual(verified, {
    available: true,
    present: true,
    index: 3,
    before: "Bishop Fire Department Union",
    after: "FN Simple Merch",
    storeItemTitle: "Store"
  });

  resetShopify();
  stubGraphql({
    megaMenu: () => {
      throw new Error("ACCESS_DENIED: not approved to access the Menu object");
    }
  });
  const blind = await shopifyOnboarding.verifyMegaMenu(NEW_STORE.title);
  assert.equal(blind.available, false);
  assert.equal(blind.present, false);
  assert.equal(blind.accessDenied, true);
});

/* ---------------------------------------------------------------------------
   Storefront verification
   ------------------------------------------------------------------------- */

test("storefrontNavContains finds the store in the nav, in a drawer, or not at all", () => {
  const nav = `<header><nav class="header__inline-menu"><ul><li><a href="/collections/1-vacaville-fire-department">Vacaville Fire Department</a></li></ul></nav></header>`;
  assert.equal(shopifyOnboarding.storefrontNavContains(nav, "Vacaville Fire Department"), true);
  // Case and run-together whitespace do not matter.
  assert.equal(shopifyOnboarding.storefrontNavContains(nav, "vacaville   fire department"), true);
  assert.equal(shopifyOnboarding.storefrontNavContains(nav, "Bishop Fire Department"), false);

  // Themes render the mega menu in a <details> drawer outside <nav>.
  const drawer = `<nav><ul><li>Store</li></ul></nav><details><summary>Store</summary><a href="/collections/1-vacaville-fire-department">Vacaville Fire Department</a></details>`;
  assert.equal(shopifyOnboarding.storefrontNavContains(drawer, "Vacaville Fire Department"), true);

  // Entities are decoded, and scripts/styles never count as page text.
  assert.equal(shopifyOnboarding.storefrontNavContains("<nav><a>Bishop &amp; Sons Fire</a></nav>", "Bishop & Sons Fire"), true);
  assert.equal(shopifyOnboarding.storefrontNavContains('<script>var m = ["Vacaville Fire Department"];</script>', "Vacaville Fire Department"), false);

  assert.equal(shopifyOnboarding.storefrontNavContains("", "Vacaville Fire Department"), false);
  assert.equal(shopifyOnboarding.storefrontNavContains(nav, ""), false);
  assert.equal(shopifyOnboarding.storefrontNavContains(null, "x"), false);
});

test("fetchStorefrontHtml reads the configured domain with a browser user agent", async (t) => {
  t.after(() => {
    resetShopify();
    delete process.env.SHOPIFY_STOREFRONT_DOMAIN;
  });
  const requests = [];
  shopifyOnboarding.setTransports({
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, text: async () => "<html></html>" };
    }
  });

  process.env.SHOPIFY_STOREFRONT_DOMAIN = "https://fnsimple.com/";
  const html = await shopifyOnboarding.fetchStorefrontHtml("collections/1-vacaville-fire-department");
  assert.equal(html, "<html></html>");
  assert.equal(requests[0].url, "https://fnsimple.com/collections/1-vacaville-fire-department");
  assert.match(requests[0].options.headers["User-Agent"], /Mozilla/);

  shopifyOnboarding.setTransports({ fetch: async () => ({ ok: false, status: 404, text: async () => "" }) });
  await assert.rejects(() => shopifyOnboarding.fetchStorefrontHtml("/"), /returned 404/);
});

/* ---------------------------------------------------------------------------
   duplicateProduct — §9.1/§9.2/§9.10. The two invariants that keep another
   department's artwork and an unpriced product out of the storefront live in
   the mutation document itself, so they are asserted on the wire text.
   ------------------------------------------------------------------------- */

test("duplicateProduct copies as DRAFT and never carries the source's images", async (t) => {
  t.after(resetShopify);
  const calls = stubGraphql({
    productDuplicate: (vars) => ({
      productDuplicate: {
        newProduct: { id: "gid://shopify/Product/9001", legacyResourceId: "9001", title: vars.newTitle },
        userErrors: []
      }
    })
  });

  const result = await shopifyOnboarding.duplicateProduct(2001, "  Next Level T-Shirt  ");

  const [call] = callsNamed(calls, "productDuplicate");
  assert.equal(call.variables.productId, "gid://shopify/Product/2001", "a numeric id is widened to a gid");
  assert.equal(call.variables.newTitle, "Next Level T-Shirt", "the title is trimmed");
  // §9.2 Draft, and §9.10 "replace all carried-over images" starts by not
  // copying them: includeImages:false is what stops another department's logo
  // shipping on this product.
  assert.match(call.query, /newStatus:\s*DRAFT/);
  assert.match(call.query, /includeImages:\s*false/);
  assert.match(call.query, /synchronous:\s*true/);
  assert.deepEqual(result, { id: "gid://shopify/Product/9001", legacyId: "9001", title: "Next Level T-Shirt" });
});

test("duplicateProduct surfaces Shopify's userErrors and a missing product", async (t) => {
  t.after(resetShopify);
  stubGraphql({ productDuplicate: { productDuplicate: { newProduct: null, userErrors: [{ field: ["productId"], message: "Product does not exist" }] } } });
  await assert.rejects(() => shopifyOnboarding.duplicateProduct(1, "Tee"), /productDuplicate: Product does not exist/);

  resetShopify();
  stubGraphql({ productDuplicate: { productDuplicate: { newProduct: null, userErrors: [] } } });
  await assert.rejects(() => shopifyOnboarding.duplicateProduct(1, "Tee"), /did not return a new product/);

  await assert.rejects(() => shopifyOnboarding.duplicateProduct(1, "   "), /needs a title/);
});

/* ---------------------------------------------------------------------------
   attachMockups — §9.10: the storefront photo has to change with the
   member's Style and Color, which is the variantIds binding.
   ------------------------------------------------------------------------- */

test("attachMockups binds each image to its own variants and widens the product id", async (t) => {
  t.after(resetShopify);
  let seen = null;
  shopifyOnboarding.setTransports({
    uploadProductImages: async (gid, images) => {
      seen = { gid, images };
      return images.map((_, i) => `gid://shopify/MediaImage/${i + 1}`);
    }
  });

  const front = Buffer.from("front");
  const back = Buffer.from("back");
  const mediaIds = await shopifyOnboarding.attachMockups(555, [
    { filename: "VAC_NL3600_NVY_Style1_FRONT.png", buffer: front, alt: "front", variantIds: ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"] },
    { filename: "VAC_NL3600_NVY_Style1_BACK.png", buffer: back, alt: "back" }
  ]);

  assert.equal(seen.gid, "gid://shopify/Product/555");
  assert.equal(seen.images.length, 2);
  // Front first, because Shopify gives a variant the FIRST image listing it.
  assert.equal(seen.images[0].filename, "VAC_NL3600_NVY_Style1_FRONT.png");
  assert.deepEqual(seen.images[0].variantIds, ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"]);
  // A back view carries no variant: it belongs in the product gallery.
  assert.deepEqual(seen.images[1].variantIds, []);
  assert.equal(seen.images[1].alt, "back");
  assert.deepEqual(mediaIds, ["gid://shopify/MediaImage/1", "gid://shopify/MediaImage/2"]);
});

test("attachMockups skips unusable entries and never calls Shopify for nothing", async (t) => {
  t.after(resetShopify);
  let called = 0;
  shopifyOnboarding.setTransports({
    uploadProductImages: async (gid, images) => {
      called++;
      return images.map(() => "gid://shopify/MediaImage/1");
    }
  });

  assert.deepEqual(await shopifyOnboarding.attachMockups(1, []), []);
  assert.deepEqual(await shopifyOnboarding.attachMockups(1, [{ filename: "no-buffer.png" }, { buffer: Buffer.from("x") }, null]), []);
  assert.equal(called, 0, "an upload with no usable image must not reach Shopify");
});

/* ---------------------------------------------------------------------------
   §6.4: the Non-Stock Item Notice is the collection description, and a blank
   description must never overwrite it.
   ------------------------------------------------------------------------- */

test("ensureDepartmentCollection treats a blank description as the Non-Stock notice", async (t) => {
  t.after(resetShopify);
  const calls = stubGraphql({
    findCollections: { collections: { nodes: [] } },
    collectionCreate: (vars) => ({
      collectionCreate: {
        collection: { id: "gid://shopify/Collection/77", legacyResourceId: "77", title: vars.input.title, handle: "1-vacaville-fire-department", descriptionHtml: vars.input.descriptionHtml, image: null },
        userErrors: []
      }
    }),
    publications: { publications: { nodes: [{ id: "gid://shopify/Publication/1", name: "Online Store" }] } },
    publishablePublish: { publishablePublish: { userErrors: [] } }
  });

  await shopifyOnboarding.ensureDepartmentCollection({ title: "Vacaville Fire Department", descriptionHtml: "   " });

  const [create] = callsNamed(calls, "collectionCreate");
  assert.equal(create.variables.input.descriptionHtml, rules.collectionDescriptionHtml());
  assert.match(create.variables.input.descriptionHtml, /Non-Stock Item Notice/);
});

/* ---------------------------------------------------------------------------
   §12 verification reads. allProductTags is also the §2.3 evidence that a
   proposed department code is not already in use, so its paging has to be
   right or a collision goes unseen.
   ------------------------------------------------------------------------- */

test("allProductTags pages with the cursor and concatenates every page in order", async (t) => {
  t.after(resetShopify);
  const calls = stubGraphql({
    productTags: (vars) =>
      vars.after
        ? { productTags: { edges: [{ node: "RIP" }, { node: "Embroidered" }], pageInfo: { hasNextPage: false, endCursor: null } } }
        : { productTags: { edges: [{ node: "BSH" }, { node: "VAC" }], pageInfo: { hasNextPage: true, endCursor: "CURSOR-1" } } }
  });

  const tags = await shopifyOnboarding.allProductTags();

  const pages = callsNamed(calls, "productTags");
  assert.equal(pages.length, 2);
  assert.equal(pages[0].variables.after, null);
  assert.equal(pages[1].variables.after, "CURSOR-1", "the second page must carry the first page's endCursor");
  assert.deepEqual(tags, ["BSH", "VAC", "RIP", "Embroidered"]);
});

test("allProductTags stops instead of looping when Shopify returns no connection", async (t) => {
  t.after(resetShopify);
  const calls = stubGraphql({ productTags: { productTags: null } });
  assert.deepEqual(await shopifyOnboarding.allProductTags(), []);
  assert.equal(callsNamed(calls, "productTags").length, 1, "a null connection must break the loop, not spin");
});

test("collectionSnapshot pages its products and reports the banner size", async (t) => {
  t.after(resetShopify);
  const collectionFields = {
    id: "gid://shopify/Collection/77",
    legacyResourceId: "77",
    title: "Vacaville Fire Department",
    handle: "1-vacaville-fire-department",
    descriptionHtml: rules.collectionDescriptionHtml(),
    image: { url: "https://cdn/banner.png", width: rules.BANNER_WIDTH, height: rules.BANNER_HEIGHT },
    productsCount: { count: 3 }
  };
  const calls = stubGraphql({
    collectionSnapshot: (vars) => ({
      collection: {
        ...collectionFields,
        products: vars.after
          ? { nodes: [{ id: "gid://shopify/Product/3", legacyResourceId: "3", title: "Hat", status: "DRAFT", tags: ["VAC"], vendor: "Non Stock Item", variantsCount: { count: 1 } }], pageInfo: { hasNextPage: false, endCursor: null } }
          : {
              nodes: [
                { id: "gid://shopify/Product/1", legacyResourceId: "1", title: "Tee", status: "DRAFT", tags: ["VAC"], vendor: "One Week Item", variantsCount: { count: 6 } },
                { id: "gid://shopify/Product/2", legacyResourceId: "2", title: "Hoodie", status: "DRAFT", tags: ["VAC"], vendor: "One Week Item", variantsCount: { count: 6 } }
              ],
              pageInfo: { hasNextPage: true, endCursor: "P1" }
            }
      }
    })
  });

  const snap = await shopifyOnboarding.collectionSnapshot(77);

  assert.equal(callsNamed(calls, "collectionSnapshot").length, 2);
  assert.equal(snap.id, "77");
  assert.equal(snap.products.length, 3, "products from both pages");
  assert.deepEqual(snap.products.map((p) => p.title), ["Tee", "Hoodie", "Hat"]);
  assert.equal(snap.image.width, rules.BANNER_WIDTH);
  assert.equal(snap.image.height, rules.BANNER_HEIGHT);
  assert.match(snap.descriptionHtml, /Non-Stock Item Notice/);
});

test("collectionSnapshot and productSnapshot return null for something Shopify no longer has", async (t) => {
  t.after(resetShopify);
  stubGraphql({ collectionSnapshot: { collection: null }, productSnapshot: { product: null } });
  assert.equal(await shopifyOnboarding.collectionSnapshot(1), null);
  assert.equal(await shopifyOnboarding.productSnapshot(1), null);
});

test("productSnapshot pages variants and keeps the fields the final check tests", async (t) => {
  t.after(resetShopify);
  const base = {
    id: "gid://shopify/Product/500",
    legacyResourceId: "500",
    title: "Next Level T-Shirt",
    status: "DRAFT",
    vendor: rules.VENDOR_ONE_WEEK,
    tags: ["VAC"],
    productType: "",
    options: [{ name: "Color", optionValues: [{ name: "Navy" }] }, { name: "Size", optionValues: [{ name: "S" }, { name: "M" }] }],
    media: { nodes: [{ id: "gid://shopify/MediaImage/1", image: { url: "https://cdn/front.png" } }] },
    collections: { nodes: [{ id: "gid://shopify/Collection/77", legacyResourceId: "77", title: "Vacaville Fire Department" }] }
  };
  const variant = (sku, size) => ({
    id: "gid://shopify/ProductVariant/" + size,
    sku,
    price: "0.00",
    inventoryPolicy: "CONTINUE",
    selectedOptions: [{ name: "Color", value: "Navy" }, { name: "Size", value: size }],
    image: { url: "https://cdn/front.png" }
  });
  const calls = stubGraphql({
    productSnapshot: (vars) => ({
      product: {
        ...base,
        variants: vars.after
          ? { nodes: [variant("NL3600-M-NVY-VAC-F01/B01", "M")], pageInfo: { hasNextPage: false, endCursor: null } }
          : { nodes: [variant("NL3600-S-NVY-VAC-F01/B01", "S")], pageInfo: { hasNextPage: true, endCursor: "V1" } }
      }
    })
  });

  const snap = await shopifyOnboarding.productSnapshot(500);

  assert.equal(callsNamed(calls, "productSnapshot").length, 2);
  assert.equal(snap.status, "DRAFT");
  assert.equal(snap.vendor, rules.VENDOR_ONE_WEEK);
  assert.deepEqual(snap.variants.map((v) => v.sku), ["NL3600-S-NVY-VAC-F01/B01", "NL3600-M-NVY-VAC-F01/B01"]);
  assert.ok(snap.variants.every((v) => v.inventoryPolicy === "CONTINUE"), "§9.8 continue selling");
  assert.ok(snap.variants.every((v) => v.image && v.image.url), "§9.10 each variant carries its image");
  assert.deepEqual(snap.collections.map((c) => c.title), ["Vacaville Fire Department"]);
});

/* A throttle error that happens to name the field is not a schema rejection —
   retrying it would create the product twice. */
test("setProduct does not retry without collections when the error merely mentions the word", async (t) => {
  t.after(resetShopify);
  let productSetCalls = 0;
  shopifyOnboarding.setTransports({ productExists: async () => true });
  shopifyOnboarding.setGraphql(async (query) => {
    if (/mutation productSet/.test(query)) {
      productSetCalls++;
      throw new Error("Shopify 429: Throttled - query cost too high for collections");
    }
    throw new Error("unexpected operation");
  });

  await assert.rejects(
    () => shopifyOnboarding.setProduct({ ...sampleSetInput(), productId: 900, collectionGids: ["gid://shopify/Collection/77"] }),
    /Throttled/
  );
  assert.equal(productSetCalls, 1);
});

test("setProduct retries without collections when the schema really rejects the field", async (t) => {
  t.after(resetShopify);
  const seen = [];
  shopifyOnboarding.setTransports({ productExists: async () => true });
  shopifyOnboarding.setGraphql(async (query, variables) => {
    if (/mutation productSet/.test(query)) {
      seen.push(variables.input);
      if (seen.length === 1) throw new Error("Field 'collections' doesn't exist on type 'ProductSetInput'");
      return { productSet: { product: { id: "gid://shopify/Product/900", legacyResourceId: "900", title: "Tee" }, productSetOperation: null, userErrors: [] } };
    }
    if (/query productVariants/.test(query)) {
      return { product: { variants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
    }
    if (/mutation collectionAddProducts/.test(query)) return { collectionAddProducts: { userErrors: [] } };
    if (/query productCollections/.test(query)) return { product: { collections: { nodes: [] } } };
    throw new Error("unexpected operation: " + query.slice(0, 60));
  });

  await shopifyOnboarding.setProduct({ ...sampleSetInput(), productId: 900, collectionGids: ["gid://shopify/Collection/77"] });

  assert.equal(seen.length, 2, "one rejected attempt, one retry");
  assert.ok("collections" in seen[0]);
  assert.ok(!("collections" in seen[1]), "the retry drops the field the schema rejected");
});

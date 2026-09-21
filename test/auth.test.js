const test = require("node:test");
const assert = require("node:assert");

const { shopifyInstallUrl } = require("../auth");

/*
 * The install URL is what decides the granted scopes, and Shopify applies a
 * REDUCTION without prompting: an install flow that asks for less than the
 * store already granted silently takes access away. So the only property that
 * really matters here is that every configured scope survives into the URL.
 */
function scopesInInstallUrl(configured) {
  const before = { id: process.env.SHOPIFY_CLIENT_ID, scopes: process.env.SHOPIFY_SCOPES };
  process.env.SHOPIFY_CLIENT_ID = "test-client-id";
  if (configured === null) delete process.env.SHOPIFY_SCOPES;
  else process.env.SHOPIFY_SCOPES = configured;
  try {
    const url = new URL(shopifyInstallUrl("example.myshopify.com", "https://platform.example.com"));
    return String(url.searchParams.get("scope") || "")
      .split(",")
      .filter(Boolean);
  } finally {
    if (before.id === undefined) delete process.env.SHOPIFY_CLIENT_ID;
    else process.env.SHOPIFY_CLIENT_ID = before.id;
    if (before.scopes === undefined) delete process.env.SHOPIFY_SCOPES;
    else process.env.SHOPIFY_SCOPES = before.scopes;
  }
}

test("the install URL requests every configured scope", () => {
  const configured = [
    "read_products",
    "write_products",
    "read_files",
    "write_files",
    "read_publications",
    "write_publications",
    "write_online_store_navigation"
  ];
  const asked = scopesInInstallUrl(configured.join(","));
  for (const scope of configured) {
    assert.ok(asked.includes(scope), `install URL dropped ${scope} (asked for: ${asked.join(",") || "nothing"})`);
  }
});

test("a configured scope list is never silently narrowed to one scope", () => {
  // The regression: shopifyScopes() returned the literal "write_products" on
  // both branches of a ternary, so every configured list collapsed to one
  // scope and an install would have revoked files and publications access.
  const asked = scopesInInstallUrl("read_files,write_files,write_products");
  assert.notDeepStrictEqual(asked, ["write_products"]);
  assert.strictEqual(asked.length, 3);
});

test("write_products is added when the configured list forgets it", () => {
  const asked = scopesInInstallUrl("read_files,write_files");
  assert.ok(asked.includes("write_products"), "the platform cannot run without write_products");
  assert.ok(asked.includes("read_files") && asked.includes("write_files"), "configured scopes are kept");
});

test("an unset scope list still asks for write_products", () => {
  assert.deepStrictEqual(scopesInInstallUrl(null), ["write_products"]);
});

test("extra whitespace in the configured list is tolerated", () => {
  assert.deepStrictEqual(scopesInInstallUrl(" read_files , write_products ,, "), ["read_files", "write_products"]);
});

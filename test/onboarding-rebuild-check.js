/*
 * "Have the agent rebuild a department Dan already built ... and compare
 * results before it touches the live store." (Build Spec, Part 4.)
 *
 * This is the read-only half of that test: it takes a department Dan built by
 * hand, reads its LIVE Shopify products, and checks the rules engine against
 * them — would onboardingRules.js have produced the same SKUs, tags, vendor
 * values, options and description shape?
 *
 *   node test/onboarding-rebuild-check.js            # default: BSH
 *   node test/onboarding-rebuild-check.js RIP CON
 *
 * Nothing is written. A mismatch is reported with both sides so the rule (or
 * the assumption about the live data) can be corrected.
 */

require("dotenv").config();

const rules = require("../onboardingRules");
const { graphql } = require("../shopify");

const COLLECTION_QUERY = `
query deptCollection($query: String!) {
  collections(first: 5, query: $query) {
    nodes {
      id
      title
      handle
      descriptionHtml
      image { url width height }
      products(first: 100) {
        nodes {
          id
          title
          status
          vendor
          tags
          descriptionHtml
          options { name values }
          variants(first: 100) {
            nodes {
              sku
              inventoryPolicy
              selectedOptions { name value }
              image { url }
            }
          }
        }
      }
    }
  }
}`;

const issues = [];
const notes = [];
function issue(product, message) {
  issues.push(`${product}: ${message}`);
}

/*
 * One parser for both sides: the rules module reads a SKU back into its parts
 * (spec shape, and the STYLE-SIZE-CODE shape tailored Class B items use).
 */
function parseSku(sku, expectedCode) {
  const parsed = rules.parseSku(sku, { departmentCode: expectedCode });
  if (!parsed) return null;
  return { ...parsed, color: parsed.colorCode, decorations: parsed.decorations.join("/") };
}

function checkProduct(product, expectedCode) {
  const label = product.title;
  const variants = product.variants.nodes;
  if (!variants.length) return;

  // Every size x color x style combination has its own unique SKU (§10).
  const skus = variants.map((v) => v.sku).filter(Boolean);
  if (skus.length !== variants.length) {
    issue(label, `${variants.length - skus.length} variant(s) have no SKU`);
  }
  const dupes = skus.filter((sku, i) => skus.indexOf(sku) !== i);
  if (dupes.length) issue(label, `duplicate SKUs: ${[...new Set(dupes)].join(", ")}`);

  // "Continue selling when out of stock" on every variant (§9.8).
  const denied = variants.filter((v) => v.inventoryPolicy !== "CONTINUE");
  if (denied.length) issue(label, `${denied.length}/${variants.length} variants are not "continue selling"`);

  // Vendor is exactly One Week Item or Non Stock Item (§9.5).
  if (!rules.VENDORS.includes(product.vendor)) {
    issue(label, `vendor "${product.vendor}" is not one of ${rules.VENDORS.join(" / ")}`);
  }

  // The department code is a tag (§9.4) and every SKU carries it (§10).
  const tags = product.tags.map((t) => t.trim());
  if (!tags.includes(expectedCode)) issue(label, `tags ${JSON.stringify(tags)} do not include the department code ${expectedCode}`);

  const parsed = skus.map((sku) => parseSku(sku, expectedCode)).filter(Boolean);
  if (parsed.length !== skus.length) issue(label, `${skus.length - parsed.length} SKU(s) do not split into STYLE-SIZE-COLOR-CODE[-DECORATIONS]`);

  const wrongCode = parsed.filter((p) => p.code !== expectedCode);
  if (wrongCode.length) {
    issue(label, `${wrongCode.length} SKU(s) carry a different department code (e.g. ${wrongCode[0].code})`);
  }

  // Decoration codes: two digits, ordered front/back/sleeve, never mixed (§10).
  for (const p of parsed) {
    if (!p.decorations) continue;
    const nd = rules.normalizeDecorations(p.decorations.split("/"));
    if (nd.assumptions && nd.assumptions.length) notes.push(`${label}: ${nd.assumptions[0]}`);
    if (nd.errors.length) {
      issue(label, `SKU decorations "${p.decorations}" break the rules: ${nd.errors[0]}`);
      break;
    }
    if (nd.codes.join("/") !== p.decorations) {
      issue(label, `SKU decorations "${p.decorations}" are not in front/back/sleeve order (expected "${nd.codes.join("/")}")`);
      break;
    }
  }

  // Embroidered / Uniform tags line up with the decoration method (§9.4).
  const method = parsed.find((p) => p.decorations)
    ? parsed.some((p) => /(^|\/)E\d\d/.test(p.decorations || ""))
      ? rules.DECORATION_EMBROIDERY
      : rules.DECORATION_PRINT
    : null;
  if (method === rules.DECORATION_EMBROIDERY && !tags.includes(rules.TAG_EMBROIDERED)) {
    issue(label, `embroidered SKUs but no "${rules.TAG_EMBROIDERED}" tag`);
  }
  if (method === rules.DECORATION_PRINT && tags.includes(rules.TAG_EMBROIDERED)) {
    issue(label, `printed SKUs but tagged "${rules.TAG_EMBROIDERED}"`);
  }

  // Options: Color and Size always; Style only for multi-logo blanks (§9.6).
  const optionNames = product.options.map((o) => o.name);
  const hasStyle = optionNames.includes(rules.OPTION_STYLE);
  if (hasStyle) {
    const styleOption = product.options.find((o) => o.name === rules.OPTION_STYLE);
    const expected = styleOption.values.map((_, i) => rules.styleName(i + 1));
    if (styleOption.values.join("|") !== expected.join("|")) {
      issue(label, `Style values ${JSON.stringify(styleOption.values)} are not ${JSON.stringify(expected)}`);
    }
  }
  if (!optionNames.includes(rules.OPTION_SIZE)) notes.push(`${label}: no "${rules.OPTION_SIZE}" option (${optionNames.join(", ")})`);
  if (!optionNames.includes(rules.OPTION_COLOR)) notes.push(`${label}: no "${rules.OPTION_COLOR}" option (${optionNames.join(", ")})`);

  // Sizes and colour codes resolve through the rules tables.
  const sizeOption = product.options.find((o) => o.name === rules.OPTION_SIZE);
  for (const value of sizeOption ? sizeOption.values : []) {
    const n = rules.normalizeSize(value);
    if (n.error) notes.push(`${label}: size "${value}" is not in the size vocabulary (${n.error})`);
  }
  const colorOption = product.options.find((o) => o.name === rules.OPTION_COLOR);
  for (const value of colorOption ? colorOption.values : []) {
    const resolved = rules.resolveColorCode(value);
    if (resolved.missing) {
      notes.push(`${label}: colour "${value}" is not on the Color Code List — a run would propose ${resolved.proposal}`);
    } else {
      const used = [...new Set(parsed.map((p) => p.color))];
      if (used.length === 1 && used[0] !== resolved.code) {
        notes.push(`${label}: colour "${value}" resolves to ${resolved.code} but the live SKUs use ${used[0]}`);
      }
    }
  }

  // Descriptions: disclaimer when decorated, Non-Stock Notice when non-stock (§11).
  const html = product.descriptionHtml || "";
  const decorated = Boolean(method);
  if (decorated && !/approximation/i.test(html)) {
    notes.push(`${label}: description has no "${rules.LOGO_DISCLAIMER}" line`);
  }
  if (product.vendor === rules.VENDOR_NON_STOCK && !/Non-Stock Item Notice/i.test(html)) {
    issue(label, "Vendor is Non Stock Item but the description has no Non-Stock Item Notice");
  }

  // Variant images: the storefront photo changes with Style x Color (§9.10).
  const withImage = variants.filter((v) => v.image && v.image.url).length;
  if (withImage === 0) notes.push(`${label}: no variant carries its own image`);
}

async function checkDepartment(code) {
  console.log(`\n=== ${code} ===`);
  const data = await graphql(COLLECTION_QUERY, { query: `title:*${code}*` });
  /*
   * `title:*CON*` is a substring match, so it also returns "Butte
   * CONstruction Company", "CONtra Costa District Aide" and "Sale Store CON".
   * Their products are then measured against CON's rules and every one of
   * them fails — hundreds of violations that say nothing about this agent and
   * bury the ones that do.
   *
   * A department store is titled "N. <Department Name>" (§6.2), and it owns
   * its products: at least one carries the code as a tag (§9.4) or in a SKU
   * (§10). Require both before judging anything inside it.
   */
  const owns = (collection) =>
    (collection.products?.nodes || []).some(
      (product) =>
        (product.tags || []).some((tag) => String(tag).trim().toUpperCase() === code.toUpperCase()) ||
        (product.variants?.nodes || []).some((variant) => {
          const parsed = rules.parseSku(variant.sku, { departmentCode: code });
          return parsed && String(parsed.code).toUpperCase() === code.toUpperCase();
        })
    );
  const candidates = data.collections.nodes;
  let collections = candidates.filter((c) => /^\d+\.\s/.test(c.title) && owns(c));
  for (const skipped of candidates.filter((c) => !collections.includes(c))) {
    console.log(`  (skipped "${skipped.title}" — ${/^\d+\.\s/.test(skipped.title) ? `no product carries ${code}` : "not a numbered department store"})`);
  }
  if (!collections.length) {
    // Fall back to matching by the department tag on its products.
    const byTag = await graphql(
      `query byTag($q: String!) { products(first: 50, query: $q) { nodes { id title status vendor tags descriptionHtml options { name values } variants(first: 100) { nodes { sku inventoryPolicy selectedOptions { name value } image { url } } } } } }`,
      { q: `tag:${code}` }
    );
    if (!byTag.products.nodes.length) {
      console.log(`  no collection or tagged product found for ${code}`);
      return;
    }
    collections = [{ title: `(products tagged ${code})`, descriptionHtml: "", image: null, products: { nodes: byTag.products.nodes } }];
  }

  for (const collection of collections) {
    const products = collection.products.nodes;
    console.log(`  ${collection.title} — ${products.length} products`);

    if (collection.descriptionHtml !== undefined && collection.title.startsWith("1.")) {
      if (!/Non-Stock Item Notice/i.test(collection.descriptionHtml || "")) {
        issues.push(`${collection.title}: collection description is not the Non-Stock Item Notice`);
      }
      const expectedTitle = rules.collectionTitle(collection.title.replace(/^\d+\.\s*/, ""), Number(collection.title.split(".")[0]));
      if (expectedTitle !== collection.title) {
        issues.push(`${collection.title}: title does not match the rule (${expectedTitle})`);
      }
      if (collection.image && (collection.image.width !== rules.BANNER_WIDTH || collection.image.height !== rules.BANNER_HEIGHT)) {
        notes.push(`${collection.title}: banner is ${collection.image.width}x${collection.image.height}, the rule is ${rules.BANNER_WIDTH}x${rules.BANNER_HEIGHT}`);
      }
    }

    for (const product of products) checkProduct(product, code);
  }
}

async function main() {
  const codes = process.argv.slice(2).filter((a) => /^[A-Z]{2,5}$/i.test(a)).map((a) => a.toUpperCase());
  const targets = codes.length ? codes : ["BSH"];
  console.log("Rebuild comparison — do Dan's live stores satisfy the rules engine?");
  for (const code of targets) await checkDepartment(code);

  console.log(`\n${issues.length} rule violation(s), ${notes.length} note(s)`);
  for (const i of issues) console.log(`  VIOLATION ${i}`);
  for (const n of notes.slice(0, 40)) console.log(`  note      ${n}`);
  if (notes.length > 40) console.log(`  ... ${notes.length - 40} more notes`);
}

main().catch((error) => {
  console.error("rebuild check crashed:", error.message);
  process.exitCode = 1;
});

/*
 * Updating a product that is already in Shopify — the pure part.
 *
 * Dan, 2026-11-20: Noroton Heights sent two more logos after its store was
 * built, and the only ways to offer them were to delete every product and
 * build again, or to add the variants by hand in Shopify. A built product's
 * row can now gain colours, sizes and logos (Styles), and "Update product"
 * adds what Shopify does not have yet.
 *
 * The rule the whole feature rests on: AN UPDATE ONLY ADDS. The variants,
 * prices, SKUs and pictures already on the product are never rewritten or
 * removed, so a product Dan has priced and made Active is safe to update.
 * What is missing is worked out from the live product every time, which
 * makes a re-run (or a run resumed after a restart) add only what is still
 * missing.
 *
 *   planProductUpdate(expanded, snapshot)  what an update would add
 *   rowFromLiveProduct(snapshot)           the row of a product the agent
 *                                          has no row for, read off its SKUs
 *   additiveChange(before, after)          whether a saved row only GAINED
 *                                          colours, sizes or Styles
 *
 * No I/O here: `expanded` is rules.expandProduct's result and `snapshot` is
 * shopifyOnboarding.productSnapshot's.
 */

const rules = require("./onboardingRules");

const { OPTION_COLOR, OPTION_SIZE, OPTION_STYLE } = rules;
const KNOWN_OPTIONS = [OPTION_COLOR, OPTION_SIZE, OPTION_STYLE];
const FIRST_STYLE = rules.styleName(1);

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function sizeKey(value) {
  const n = rules.normalizeSize(value);
  return n.error ? clean(value).toUpperCase() : n.size;
}

function colorKey(value) {
  return rules.normalizeColorName(value);
}

function pairKey(color, style) {
  return `${colorKey(color)}|${clean(style)}`;
}

function variantKey(color, size, style) {
  return `${colorKey(color)}|${sizeKey(size)}|${clean(style)}`;
}

function optionMap(variant) {
  return new Map((variant?.selectedOptions || []).map((o) => [o.name, o.value]));
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) || 0) + 1);
  let best = "";
  let n = 0;
  for (const [value, count] of counts) if (count > n) [best, n] = [value, count];
  return best;
}

/* Why the agent cannot add to this product, or "" when it can: its options
   must be the agent's own — Color and Size, and Style when it has more than
   one logo set-up. A product with other options (or none) was set up by hand
   in a way the row cannot describe. */
function optionsProblem(snapshot) {
  const names = (snapshot?.options || []).map((o) => clean(o.name));
  const foreign = names.filter((n) => !KNOWN_OPTIONS.includes(n));
  if (!foreign.length && names.includes(OPTION_COLOR) && names.includes(OPTION_SIZE)) return "";
  const have = names.length ? names.join(", ") : "none";
  return `In Shopify this product's options are ${have}. The agent can add variants only to a product whose options are ${OPTION_COLOR} and ${OPTION_SIZE} (and ${OPTION_STYLE}); add to this one in Shopify.`;
}

/**
 * What "Update product" would add to the live product.
 *
 * Returns {
 *   ok, problems[], warnings[],
 *   addStyleOption   the product has no Style option yet and the row now has
 *                    Styles: the option is added and every variant already
 *                    there becomes Style 1
 *   variants[]       the variants to create: { color, size, style, sku,
 *                    optionValues }
 *   newPairs[]       { color, style } pairs no live variant has — the ones
 *                    that need mockups
 *   livePairs[]      "color|style" keys already on the product
 *   newColors[], newSizes[], newStyles[]   for saying what will happen
 *   liveCount, extraLive   variants in Shopify; those the row does not list
 * }
 */
function planProductUpdate(expanded, snapshot, { departmentCode = "" } = {}) {
  const problems = [];
  const warnings = [];
  const out = {
    ok: false,
    problems,
    warnings,
    addStyleOption: false,
    variants: [],
    newPairs: [],
    livePairs: [],
    newColors: [],
    newSizes: [],
    newStyles: [],
    liveCount: (snapshot?.variants || []).length,
    extraLive: 0,
    // An ending every live SKU carries beyond the row's own ("/E00").
    skuEnding: ""
  };
  if (!snapshot) {
    problems.push("This product is no longer in Shopify.");
    return out;
  }
  const optionTrouble = optionsProblem(snapshot);
  if (optionTrouble) {
    problems.push(optionTrouble);
    return out;
  }
  if (!expanded?.ok) {
    problems.push(...(expanded?.errors || ["The row has not passed validation."]));
    return out;
  }

  const liveHasStyle = (snapshot.options || []).some((o) => o.name === OPTION_STYLE);
  const wantStyles = expanded.product.styles.some((s) => s.name);
  if (liveHasStyle && !wantStyles) {
    problems.push(`In Shopify this product is sold in Styles, and the row has none. Add the Styles to the row as they are in Shopify before adding to it.`);
    return out;
  }
  out.addStyleOption = wantStyles && !liveHasStyle;
  // A product gaining its Style option: what is there becomes Style 1.
  const liveStyleOf = (options) => (liveHasStyle ? clean(options.get(OPTION_STYLE)) : wantStyles ? FIRST_STYLE : "");

  const liveKeys = new Map();
  const livePairs = new Set();
  const liveColors = new Set();
  const liveSizes = new Set();
  const liveStyles = new Set();
  const liveColorCodes = new Map();
  const liveSkus = new Set();
  // A value Shopify already has is named exactly as Shopify spells it, or a
  // new variant in "navy" would open a second colour beside "Navy".
  const liveColorNames = new Map();
  const liveSizeNames = new Map();
  for (const variant of snapshot.variants || []) {
    const options = optionMap(variant);
    const color = options.get(OPTION_COLOR);
    const size = options.get(OPTION_SIZE);
    const style = liveStyleOf(options);
    if (!liveColorNames.has(colorKey(color))) liveColorNames.set(colorKey(color), color);
    if (!liveSizeNames.has(sizeKey(size))) liveSizeNames.set(sizeKey(size), size);
    liveKeys.set(variantKey(color, size, style), variant);
    livePairs.add(pairKey(color, style));
    liveColors.add(colorKey(color));
    liveSizes.add(sizeKey(size));
    liveStyles.add(style);
    if (clean(variant.sku)) liveSkus.add(clean(variant.sku).toUpperCase());
    /* The colour code the product already uses for this colour. A new Style
       of a colour that is there keeps that code, whatever the Color Code List
       says today, so one colour never carries two codes on one product. */
    const parsed = rules.parseSku(variant.sku, { departmentCode });
    if (parsed?.colorCode && parsed.shape === "style-size-color-code" && !liveColorCodes.has(colorKey(color))) {
      liveColorCodes.set(colorKey(color), parsed.colorCode.toUpperCase());
    }
  }
  out.livePairs = [...livePairs];

  const wantedKeys = new Set();
  const newPairs = new Map();
  const skuFor = (variant) => {
    const liveCode = liveColorCodes.get(colorKey(variant.color));
    return liveCode && liveCode !== clean(variant.colorCode).toUpperCase()
      ? rules.buildSku({ styleNumber: expanded.product.styleNumber, size: variant.size, colorCode: liveCode, departmentCode, decorationCodes: variant.decorationCodes })
      : variant.sku;
  };
  /* An ending Dan gave every SKU of the product by hand after it was built
     (Noroton Heights' tees all end "/E00") belongs on the new ones too: when
     each variant already there is the row's SKU plus the SAME extra ending,
     the new variants take that ending. One variant without it, or two
     different endings, and nothing is assumed. */
  const endings = new Set();
  let skuDiffers = 0;
  for (const variant of expanded.variants) {
    const live = liveKeys.get(variantKey(variant.color, variant.size, clean(variant.style)));
    const mine = clean(skuFor(variant)).toUpperCase();
    const theirs = clean(live?.sku).toUpperCase();
    if (!live || !mine || !theirs) continue;
    if (theirs !== mine) skuDiffers += 1;
    endings.add(theirs.startsWith(mine) ? theirs.slice(mine.length) : null);
  }
  const ending = endings.size === 1 ? [...endings][0] : null;
  out.skuEnding = ending && /^[\/-][A-Z0-9\/-]+$/.test(ending) ? ending : "";
  if (out.skuEnding) skuDiffers = 0;

  for (const variant of expanded.variants) {
    const style = clean(variant.style);
    const key = variantKey(variant.color, variant.size, style);
    wantedKeys.add(key);
    if (liveKeys.get(key)) continue;
    const base = skuFor(variant);
    const sku = base ? `${base}${out.skuEnding}` : base;
    if (sku && liveSkus.has(clean(sku).toUpperCase())) {
      problems.push(`${variant.color} / ${variant.size}${style ? ` / ${style}` : ""} would get the SKU ${sku}, which another variant of this product already has. The row's logos do not match how the product was built; check its decoration codes.`);
      continue;
    }
    const optionValues = [
      { optionName: OPTION_COLOR, name: liveColorNames.get(colorKey(variant.color)) || variant.color },
      { optionName: OPTION_SIZE, name: liveSizeNames.get(sizeKey(variant.size)) || variant.size }
    ];
    if (style) optionValues.push({ optionName: OPTION_STYLE, name: style });
    out.variants.push({ color: variant.color, size: variant.size, style: style || null, sku, decorationCodes: variant.decorationCodes, optionValues });
    if (!livePairs.has(pairKey(variant.color, style))) newPairs.set(pairKey(variant.color, style), { color: variant.color, style: style || null });
    if (!liveColors.has(colorKey(variant.color)) && !out.newColors.includes(variant.color)) out.newColors.push(variant.color);
    if (!liveSizes.has(sizeKey(variant.size)) && !out.newSizes.includes(variant.size)) out.newSizes.push(variant.size);
    if (style && !liveStyles.has(style) && !out.newStyles.includes(style)) out.newStyles.push(style);
  }
  out.newPairs = [...newPairs.values()];
  out.extraLive = [...liveKeys.keys()].filter((key) => !wantedKeys.has(key)).length;

  if (out.skuEnding && out.variants.length) {
    warnings.push(`Every SKU on this product ends in "${out.skuEnding}" (added in Shopify after it was built), so the new SKUs end in it too.`);
  }
  if (skuDiffers) {
    warnings.push(`${skuDiffers} variant${skuDiffers === 1 ? "" : "s"} already in Shopify carr${skuDiffers === 1 ? "ies a SKU" : "y SKUs"} the row would write differently. They are left exactly as they are.`);
  }
  if (out.extraLive) {
    warnings.push(`${out.extraLive} variant${out.extraLive === 1 ? "" : "s"} in Shopify ${out.extraLive === 1 ? "is" : "are"} not on this row (a colour, size or Style removed here). An update never removes a variant; delete ${out.extraLive === 1 ? "it" : "them"} in Shopify if ${out.extraLive === 1 ? "it is" : "they are"} not wanted.`);
  }
  const total = out.liveCount + out.variants.length;
  if (total > rules.SHOPIFY_MAX_VARIANTS) {
    problems.push(`The product would have ${total} variants, more than the ${rules.SHOPIFY_MAX_VARIANTS} Shopify allows on one product. Add fewer colours, sizes or logos.`);
  }
  out.ok = problems.length === 0;
  return out;
}

/**
 * The row of a product that is in the store but not on the agent's record —
 * one built by hand, or in a store that predates the agent. Everything the
 * row needs is on the product: Color, Size and Style are its options, and
 * each SKU spells STYLE-SIZE-COLOR-CODE-DECORATIONS.
 *
 * Returns { row, problems[] }; `row` is null when the product cannot be read
 * that way, and `problems` says why in words Dan can act on.
 */
function rowFromLiveProduct(snapshot, { departmentCode = "" } = {}) {
  const problems = [];
  if (!snapshot) return { row: null, problems: ["This product is no longer in Shopify."] };
  const optionTrouble = optionsProblem(snapshot);
  if (optionTrouble) return { row: null, problems: [optionTrouble] };

  const code = clean(departmentCode).toUpperCase();
  const variants = snapshot.variants || [];
  const parsed = variants.map((variant) => ({ variant, sku: rules.parseSku(variant.sku, { departmentCode: code }) }));
  const readable = parsed.filter((p) => p.sku && p.sku.shape === "style-size-color-code");
  if (!readable.length) {
    const sample = clean(variants[0]?.sku);
    problems.push(
      sample
        ? `This product's SKUs (e.g. ${sample}) are not STYLE-SIZE-COLOUR-${code || "CODE"}-DECORATIONS, so the agent cannot tell how it was built. Add to it in Shopify.`
        : "This product's variants have no SKUs, so the agent cannot tell how it was built. Add to it in Shopify."
    );
    return { row: null, problems };
  }

  const option = (name) => (snapshot.options || []).find((o) => o.name === name)?.values || [];
  const styleValues = option(OPTION_STYLE);
  const codesOf = (list) => mostCommon(list.map((p) => p.sku.decorations.join("/")));
  let styles = [];
  let decorationCodes = codesOf(readable);
  if (styleValues.length > 1 || (styleValues.length === 1 && styleValues[0] !== FIRST_STYLE)) {
    const named = styleValues.every((value, i) => value === rules.styleName(i + 1));
    if (!named) {
      problems.push(`This product's Style option reads ${styleValues.join(", ")}. The agent names Styles "Style 1", "Style 2", … and cannot add to one named differently; add to it in Shopify.`);
      return { row: null, problems };
    }
    styles = styleValues.map((value) => ({
      decorationCodes: codesOf(readable.filter((p) => optionMap(p.variant).get(OPTION_STYLE) === value))
    }));
    if (styles.some((s) => !s.decorationCodes)) {
      problems.push("A Style on this product has no decoration codes in its SKUs, so the agent cannot tell its logos apart. Add to it in Shopify.");
      return { row: null, problems };
    }
    decorationCodes = styles[0].decorationCodes;
  }

  const allCodes = [...new Set([decorationCodes, ...styles.map((s) => s.decorationCodes)].flatMap((value) => value.split("/").filter(Boolean)))];
  const methods = new Set(allCodes.map((c) => rules.parseDecorationCode(c).method).filter(Boolean));
  const applied = allCodes.filter((c) => /^[EP]\d{2}$/.test(c));
  const tags = (snapshot.tags || []).map((t) => clean(t));
  const row = {
    brand: "",
    styleNumber: mostCommon(readable.map((p) => clean(p.sku.style).toUpperCase())),
    type: clean(snapshot.productType),
    title: clean(snapshot.title),
    colors: option(OPTION_COLOR).map(clean).filter(Boolean),
    sizes: option(OPTION_SIZE).map(clean).filter(Boolean),
    decorationMethod: methods.size === 1 ? [...methods][0] : "",
    decorationCodes,
    styles,
    otherLogos: [],
    fulfillment: rules.VENDORS.includes(clean(snapshot.vendor)) ? clean(snapshot.vendor) : "",
    classB: tags.includes(rules.TAG_UNIFORM),
    // One embroidered logo and nothing else says where it is: the front.
    placements: !styles.length && applied.length === 1 ? { [applied[0]]: "F" } : {},
    logoMap: {}
  };
  return { row, problems };
}

/* The spec of a row as far as an update cares: what each Style is, and the
   colours and sizes it comes in. */
function specOf(product) {
  const p = product || {};
  const styles = Array.isArray(p.styles) && p.styles.length ? p.styles : [{ decorationCodes: p.decorationCodes }];
  const sizes = rules.expandSizeList(Array.isArray(p.sizes) ? p.sizes : [], { hat: rules.isHeadwearText(`${p.type || ""} ${p.title || ""}`) });
  const entries = (obj) => Object.entries(obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {}).filter(([, v]) => v);
  return {
    method: clean(p.decorationMethod).toLowerCase(),
    styles: styles.map((s) => rules.normalizeDecorations(s?.decorationCodes).codes.join("/")),
    colors: (Array.isArray(p.colors) ? p.colors : []).map((c) => colorKey(typeof c === "string" ? c : c?.name)).filter(Boolean),
    sizes: [...new Set(sizes.map(sizeKey))],
    placements: new Map(entries(p.placements)),
    logoMap: new Map(entries(p.logoMap))
  };
}

/**
 * True when `after` is `before` with colours, sizes or Styles ADDED and
 * nothing that was there changed: the same Styles in the same order first,
 * the same logo and spot for every code the row already had. Then the
 * mockups already made are still right, and an update can add the rest.
 */
function additiveChange(before, after) {
  const a = specOf(before);
  const b = specOf(after);
  const within = (small, big) => small.every((value) => big.includes(value));
  if (!within(a.colors, b.colors) || !within(a.sizes, b.sizes)) return false;
  if (a.styles.length > b.styles.length) return false;
  if (!a.styles.every((codes, i) => codes === b.styles[i])) return false;
  // The method may be filled in ("" → what the codes say), never switched.
  if (a.method && b.method && a.method !== b.method) return false;
  for (const [code, value] of a.placements) if (b.placements.get(code) !== value) return false;
  for (const [code, value] of a.logoMap) if (b.logoMap.get(code) !== value) return false;
  /* A code the row already had gaining a logo or a spot changes its picture
     too ("Default" → a picked file). Codes new to the row may bring theirs. */
  const oldCodes = new Set(a.styles.flatMap((codes) => codes.split("/").filter(Boolean)));
  for (const code of b.logoMap.keys()) if (oldCodes.has(code) && !a.logoMap.has(code)) return false;
  for (const code of b.placements.keys()) if (oldCodes.has(code) && !a.placements.has(code)) return false;
  return true;
}

module.exports = {
  FIRST_STYLE,
  pairKey,
  variantKey,
  colorKey,
  sizeKey,
  optionsProblem,
  planProductUpdate,
  rowFromLiveProduct,
  additiveChange
};

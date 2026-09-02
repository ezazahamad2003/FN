const crypto = require("crypto");
const {
  ensureSubfolder,
  listFilesInFolder,
  readFileText,
  trashFile,
  updateJsonFile
} = require("./drive");
const {
  deleteRecordBlob,
  isBlobRecordId,
  listRecordBlobs,
  readRecordBlobText,
  writeRecordBlob
} = require("./intakeStore");
const { googleConnected } = require("./auth");
const {
  INTAKE_CATEGORY_META,
  feeSkuFor,
  normalizeTierLabel,
  sizesFromRangeLabel
} = require("./intake");

const INTAKE_FOLDER_NAME = "Customer Store Intakes";

const CUSTOMER_INTAKE_CATEGORIES = [
  { key: "t-shirts", title: "T-Shirts", type: "shirt", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "long-sleeve-shirts", title: "Long Sleeve Shirts", type: "long sleeve shirt", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "crewneck-sweatshirts", title: "Crewneck Sweatshirts", type: "sweatshirt", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "hooded-sweatshirts", title: "Hooded Sweatshirts", type: "hoodie", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "jackets-job-shirts", title: "Jackets / Job Shirts", type: "jacket", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "polos", title: "Polos", type: "polo", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "shorts", title: "Shorts", type: "shorts", placements: ["Left leg", "Right leg"], decorated: true },
  { key: "sweatpants", title: "Sweatpants", type: "sweatpants", placements: ["Left leg", "Right leg"], decorated: true },
  { key: "class-b-uniform-shirt", title: "Class B Uniform Shirt", type: "class b uniform shirt", placements: ["Left sleeve", "Right sleeve", "Both sleeves"], decorated: true },
  { key: "class-b-uniform-pants", title: "Class B Uniform Pants", type: "class b uniform pants", placements: [], decorated: false },
  { key: "belts", title: "Belts", type: "belt", placements: [], decorated: false, belt: true },
  { key: "hats", title: "Hats", type: "hat", placements: ["Front center", "Side"], decorated: true }
];

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function slug(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "store";
}

function normalizeNameRank(value) {
  return value === true || value === "yes" ? "yes" : value === false || value === "no" ? "no" : "";
}

const MAX_DECORATIONS_PER_VARIANT = 4;
const MAX_VARIANTS_PER_CATEGORY = 6;

/* One decorated spot on a garment: where artwork sits, how big it is, and
   which uploaded logo file(s) go there. A variant carries one or more of
   these, so "crest on the front left chest AND the full department mark
   across the back" is two decorations of one garment, not a note. */
function normalizeDecoration(input = {}, index = 0) {
  const source = input || {};
  return {
    id: clean(source.id) || `d${index + 1}`,
    placement: clean(source.placement),
    sizeTier: clean(source.sizeTier),
    customSizeTier: clean(source.customSizeTier),
    // Exact uploaded file names the customer picked for this spot. Empty
    // means "no specific assignment" - every uploaded logo is offered.
    logoSlugs: Array.isArray(source.logoSlugs) ? source.logoSlugs.map(clean).filter(Boolean).slice(0, 20) : []
  };
}

function decorationHasContent(decoration) {
  return Boolean(decoration.placement || decoration.sizeTier || decoration.customSizeTier || decoration.logoSlugs.length);
}

/* One version of a garment: its own vendor, color, decoration, and logo
   assignment. A category holds one or more of these, so "navy Next Level tee
   with the Station 7 crest AND a red Gildan tee with the EMS badge" is two
   variants of the same category instead of a note nobody parses. */
function normalizeVariant(input = {}, index = 0) {
  const source = input || {};

  let decorations = (Array.isArray(source.decorations) ? source.decorations : [])
    .filter((item) => item && typeof item === "object")
    .map((item, position) => normalizeDecoration(item, position))
    .filter(decorationHasContent)
    .slice(0, MAX_DECORATIONS_PER_VARIANT);
  // Pre-decoration variants (and any client still sending the flat fields)
  // carry a single placement/tier/logo set at the variant level; it becomes
  // decoration 1, so old records keep building and old edits keep saving.
  if (!decorations.length) {
    const legacy = normalizeDecoration(
      {
        placement: source.placement,
        sizeTier: source.sizeTier,
        customSizeTier: source.customSizeTier,
        logoSlugs: source.logoSlugs
      },
      0
    );
    if (decorationHasContent(legacy)) decorations = [legacy];
  }
  const firstDecoration = decorations[0] || normalizeDecoration({}, 0);

  return {
    id: clean(source.id) || `v${index + 1}`,
    vendor: clean(source.vendor),
    styleNumber: clean(source.styleNumber),
    colors: clean(source.colors),
    style: clean(source.style),
    decorationMethod: clean(source.decorationMethod),
    // Flat fields mirror decoration 1 so pre-decoration records round-trip
    // and every legacy consumer keeps reading the same shape.
    sizeTier: firstDecoration.sizeTier,
    customSizeTier: firstDecoration.customSizeTier,
    placement: firstDecoration.placement,
    logoSlugs: firstDecoration.logoSlugs,
    logoNotes: clean(source.logoNotes),
    nameRank: normalizeNameRank(source.nameRank),
    sizeRange: clean(source.sizeRange),
    otherSizes: clean(source.otherSizes),
    notes: clean(source.notes),
    decorations
  };
}

function variantHasContent(variant) {
  return Object.entries(variant).some(([key, value]) =>
    key !== "id" && (Array.isArray(value) ? value.length > 0 : Boolean(value)));
}

function normalizeCategory(input = {}) {
  const source = input || {};
  const definition = CUSTOMER_INTAKE_CATEGORIES.find((item) => item.key === source.key) || {};
  const include = Boolean(source.include);

  // Capped server-side too: the submit endpoint is public, and every variant
  // is a paid supplier search + image generation + Shopify product. The form
  // enforces the same limit; a crafted payload must not get to bypass it.
  let variants = (Array.isArray(source.variants) ? source.variants : [])
    .filter((item) => item && typeof item === "object")
    .slice(0, MAX_VARIANTS_PER_CATEGORY)
    .map((item, index) => normalizeVariant(item, index));
  // Pre-variant records (and any client still sending flat fields) become
  // version 1, so old submissions keep building and old edits keep saving.
  // Category-level notes stay on the category rather than the variant.
  if (!variants.length && !definition.belt) {
    const legacy = normalizeVariant({ ...source, notes: "", id: "" }, 0);
    if (variantHasContent(legacy) || include) variants = [legacy];
  }

  const first = variants[0] || normalizeVariant({}, 0);
  return {
    key: source.key || definition.key || "",
    title: source.title || definition.title || "",
    include,
    // Flat fields mirror version 1 so pre-variant records round-trip and the
    // dashboard editor's category-level fields stay populated.
    style: first.style,
    vendor: first.vendor,
    styleNumber: first.styleNumber,
    colors: first.colors,
    beltStyle: clean(source.beltStyle),
    decorationMethod: first.decorationMethod,
    logoChoice: first.logoSlugs.length || source.logoChoice === "additional" ? "additional" : "department",
    logoNotes: first.logoNotes || first.logoSlugs.join(", "),
    sizeTier: first.sizeTier,
    customSizeTier: first.customSizeTier,
    placement: first.placement,
    nameRank: first.nameRank,
    sizeRange: first.sizeRange,
    otherSizes: first.otherSizes,
    notes: clean(source.notes),
    variants
  };
}

function normalizeStore(input = {}) {
  return {
    departmentName: clean(input.departmentName),
    departmentCode: clean(input.departmentCode).toUpperCase(),
    contactName: clean(input.contactName),
    contactEmail: clean(input.contactEmail),
    contactPhone: clean(input.contactPhone),
    neededBy: clean(input.neededBy),
    notes: clean(input.notes)
  };
}

function normalizeRecord(input = {}) {
  const now = new Date().toISOString();
  const categoriesByKey = new Map((input.categories || []).map((item) => [item.key, item]));
  return {
    schemaVersion: 1,
    requestId: input.requestId || crypto.randomUUID(),
    status: input.status || "new",
    createdAt: input.createdAt || now,
    updatedAt: now,
    source: "customer-link",
    store: normalizeStore(input.store || input),
    categories: CUSTOMER_INTAKE_CATEGORIES.map((definition) => normalizeCategory({ ...definition, ...(categoriesByKey.get(definition.key) || {}) })),
    logos: Array.isArray(input.logos) ? input.logos : [],
    shopifyCollection: input.shopifyCollection || null,
    // Build progress written by the store builder. Passed through untouched so
    // a PATCH from the review UI can never wipe a build that is mid-flight.
    build: input.build || null,
    internalNotes: clean(input.internalNotes),
    customerNotes: clean(input.customerNotes || input.notes)
  };
}

function categoryDefinition(key) {
  return CUSTOMER_INTAKE_CATEGORIES.find((item) => item.key === key) || {};
}

function recordWithComputedFields(record, driveFile = {}) {
  const normalized = normalizeRecord(record);
  const included = normalized.categories.filter((category) => category.include);
  const missing = [];
  if (!normalized.store.departmentName) missing.push("Department name");
  if (!normalized.store.departmentCode) missing.push("Department code");
  if (!normalized.logos.length) missing.push("Logo files");
  if (!included.length) missing.push("At least one garment category");
  let productCount = 0;
  for (const category of included) {
    const definition = categoryDefinition(category.key);
    if (definition.belt) {
      productCount += 1;
      if (!category.beltStyle) missing.push(definition.title + ": belt style");
      continue;
    }
    const variants = category.variants?.length ? category.variants : [category];
    productCount += variants.length;
    variants.forEach((variant, index) => {
      const label = variants.length > 1 ? `${definition.title} (version ${index + 1})` : definition.title;
      if (!variant.colors) missing.push(label + ": colors");
      if (definition.decorated && !variant.decorationMethod) missing.push(label + ": decoration method");
      // "None" means the garment ships blank, so no placement is needed.
      const undecorated = /^none$/i.test(variant.decorationMethod || "");
      if (definition.decorated && definition.placements?.length && !undecorated) {
        const decorations = variant.decorations?.length ? variant.decorations : [];
        if (!decorations.length) missing.push(label + ": placement");
        decorations.forEach((decoration, position) => {
          if (!decoration.placement) {
            missing.push(label + (decorations.length > 1 ? `: placement (decoration ${position + 1})` : ": placement"));
          }
        });
      }
      if (!variant.sizeRange) missing.push(label + ": size range");
    });
  }
  return {
    ...normalized,
    id: driveFile.id || normalized.id,
    driveFile,
    summary: {
      includedCount: included.length,
      productCount,
      logoCount: normalized.logos.length,
      missing,
      ready: included.length > 0 && missing.length === 0
    }
  };
}

function stripLargeFields(record) {
  const clone = JSON.parse(JSON.stringify(record));
  clone.logos = (clone.logos || []).map((logo) => ({ name: logo.name, mimetype: logo.mimetype, size: logo.size }));
  return clone;
}

function validateCustomerIntake(record) {
  const computed = recordWithComputedFields(record);
  if (!computed.summary.ready) {
    const error = new Error("Finish the required fields first: " + computed.summary.missing.join("; "));
    // Marks the one kind of submit failure a customer can act on. Everything
    // else (storage, auth, config) is internal and must not reach the form.
    error.code = "INTAKE_INVALID";
    throw error;
  }
}

/* -----------------------------------------------------------------------------
   Record → build products, directly.

   The old path rendered the record to structured text and regex-parsed it back,
   which could only ever see ONE version of each category. Variants made that
   round-trip lossy, so the builder now constructs products straight from the
   record: one product per variant, deterministic, nothing inferred.
   -------------------------------------------------------------------------- */

function categoryMeta(key) {
  return INTAKE_CATEGORY_META.find((item) => item.key === key) || {};
}

function logoSlugsForVariant(category, variant) {
  if (variant.logoSlugs?.length) return variant.logoSlugs;
  // Legacy records assigned logos through free text; honour it the way the
  // text parser did, but only when the customer said "specific logo".
  if (category.logoChoice === "additional" && variant.logoNotes) {
    const tokens = variant.logoNotes
      .split(/[,;/]|\band\b/i)
      .map(clean)
      .filter((part) => part && !/^upload|specific|use department logo$/i.test(part));
    if (tokens.length) return tokens;
  }
  return ["all"];
}

/* A decoration's logo set: its own explicit picks first, then (for decoration
   1 only) the variant-level legacy fallbacks, then "all". */
function decorationLogoSlugs(category, variant, decoration, position) {
  if (decoration.logoSlugs?.length) return decoration.logoSlugs;
  if (position === 0) return logoSlugsForVariant(category, variant);
  return ["all"];
}

function productFromVariant(category, variant, versionIndex, versionCount) {
  const definition = categoryDefinition(category.key);
  const meta = categoryMeta(category.key);
  const brandStyle = [variant.styleNumber, variant.style].filter(Boolean).join(" ");

  // Every decorated spot on this garment, tier + fee SKU resolved per spot.
  // Pre-decoration records synthesize decoration 1 from the flat fields.
  const rawDecorations = variant.decorations?.length
    ? variant.decorations
    : [normalizeDecoration(variant, 0)].filter(decorationHasContent);
  const decorations = rawDecorations.map((decoration, position) => {
    const tier = normalizeTierLabel(decoration.sizeTier, decoration.customSizeTier);
    return {
      placement: decoration.placement,
      tier,
      feeSku: feeSkuFor({ placement: decoration.placement, productType: meta.type, tier }),
      logoSlugs: decorationLogoSlugs(category, variant, decoration, position)
    };
  });

  const first = decorations[0] || { placement: "", tier: "", feeSku: "", logoSlugs: logoSlugsForVariant(category, variant) };
  const logoSlugs = first.logoSlugs;
  const assignmentStated = decorations.some((decoration) => decoration.logoSlugs[0] !== "all");
  const decorationLines = decorations.map((decoration, position) =>
    [
      decorations.length > 1 ? `Decoration ${position + 1}: ${decoration.placement || "placement unspecified"}` : "",
      decoration.tier ? `size tier ${decoration.tier}` : "",
      decoration.feeSku ? `fee SKU ${decoration.feeSku}` : ""
    ].filter(Boolean).join(", ")
  ).filter(Boolean);

  const notes = [
    `Structured intake category: ${definition.title}${versionCount > 1 ? ` (version ${versionIndex + 1} of ${versionCount})` : ""}.`,
    first.tier ? `Decoration size tier: ${first.tier}.` : "",
    first.feeSku ? `Decoration fee SKU hint: ${first.feeSku}.` : "",
    decorationLines.length ? `${decorationLines.join(". ")}.` : "",
    variant.nameRank === "yes" ? "Name/rank personalization requested on right chest." : "",
    variant.nameRank === "no" ? "No name/rank right-chest personalization requested." : "",
    variant.notes ? `Customer note: ${variant.notes}` : "",
    category.notes ? `Category note: ${category.notes}` : ""
  ].filter(Boolean);

  return {
    productType: meta.type || definition.title || "",
    productLabel: brandStyle ? `${brandStyle} ${definition.title}` : definition.title,
    productPrompt: meta.prompt || `a ${meta.type || "garment"} laid flat`,
    garmentColor: variant.colors,
    brandStyle,
    vendor: variant.vendor,
    fabricDetails: "",
    // Flat decoration fields mirror decoration 1 for every legacy consumer;
    // the full set rides in decorations[].
    placement: first.placement,
    decorations,
    decorationMethod: /^None$/i.test(variant.decorationMethod) ? "none" : variant.decorationMethod,
    decorationSizeTier: first.tier,
    decorationFeeSku: first.feeSku,
    // Custom sizes only count when "Other" is the selection: the form keeps a
    // hidden otherSizes input's value when the customer switches back to a
    // preset range, and an ungated pass-through would build the product from
    // that stale text while every human-facing rendering shows the preset.
    sizes: sizesFromRangeLabel(variant.sizeRange, variant.sizeRange === "Other" ? variant.otherSizes : ""),
    sizeChart: null,
    productionNotes: notes.join(" "),
    logoSlugs,
    logoAssignmentStated: assignmentStated,
    assignmentNotes: assignmentStated
      ? `Structured intake logo entry: ${decorations.map((decoration) => decoration.logoSlugs.join(", ")).join(" | ")}`
      : "Structured intake selected the department logo/default logo set.",
    intakeSource: true,
    imageGuidance: [
      decorations.length
        ? `Mockup placement${decorations.length > 1 ? "s" : ""} selected in intake: ${decorations
            .map((decoration) => decoration.placement)
            .filter(Boolean)
            .join(", ")}.`
        : "",
      first.tier ? `Leave clean, unobstructed garment surface for ${first.tier} decoration.` : ""
    ].filter(Boolean).join(" ")
  };
}

function beltProduct(category) {
  const definition = categoryDefinition(category.key);
  const meta = categoryMeta(category.key);
  const brandStyle = category.beltStyle || category.style;
  return {
    productType: meta.type || "belt",
    productLabel: brandStyle ? `${brandStyle} ${definition.title}` : definition.title,
    productPrompt: meta.prompt || "a uniform belt laid flat",
    garmentColor: "",
    brandStyle,
    vendor: "",
    fabricDetails: "",
    placement: "",
    decorationMethod: "",
    decorationSizeTier: "",
    decorationFeeSku: "",
    sizes: [],
    sizeChart: null,
    productionNotes: `Structured intake category: ${definition.title}.${category.notes ? ` Customer note: ${category.notes}` : ""}`,
    logoSlugs: ["all"],
    logoAssignmentStated: false,
    assignmentNotes: "Belts ship undecorated.",
    intakeSource: true,
    imageGuidance: ""
  };
}

/* Product titles are the identity the skip-list uses across re-runs, so two
   variants must never collapse to the same title - AND a variant's title must
   not change just because a sibling was added or removed later (the skip-list
   would miss the rename and re-create an already-built product). So the FIRST
   product of a collision group always keeps its base label - the one it had
   when it was the only version - and only the later versions get color, then
   vendor, then a numeric suffix as the deterministic last resort. */
function disambiguateProductLabels(products) {
  const groups = new Map();
  for (const product of products) {
    const key = product.productLabel.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const later = group.slice(1);
    // Color first - informative even when two versions share it.
    for (const product of later) {
      const color = clean(product.garmentColor).split(/[,;/]|\band\b/i)[0].trim();
      if (color) product.productLabel = `${color} ${product.productLabel}`;
    }
    // Vendor next, only where the color-prefixed labels still collide (with
    // each other or with the base label the first version kept).
    const labels = group.map((product) => product.productLabel.toLowerCase());
    for (const product of later) {
      const vendor = clean(product.vendor);
      const key = product.productLabel.toLowerCase();
      if (vendor && labels.filter((label) => label === key).length > 1) {
        product.productLabel = `${vendor} ${product.productLabel}`;
      }
    }
  }
  const taken = new Map();
  for (const product of products) {
    const key = product.productLabel.toLowerCase();
    const n = (taken.get(key) || 0) + 1;
    taken.set(key, n);
    if (n > 1) product.productLabel = `${product.productLabel} (${n})`;
  }
}

/** Same shape parseStructuredIntakeText returns, built straight from the
 *  record - one product per variant, no text round-trip. */
function intakeFromCustomerRecord(recordInput) {
  const record = recordWithComputedFields(recordInput);
  const products = [];
  for (const category of record.categories.filter((item) => item.include)) {
    const definition = categoryDefinition(category.key);
    if (definition.belt) {
      products.push(beltProduct(category));
      continue;
    }
    const variants = category.variants?.length ? category.variants : [normalizeVariant(category, 0)];
    variants.forEach((variant, index) => products.push(productFromVariant(category, variant, index, variants.length)));
  }
  disambiguateProductLabels(products);
  return {
    present: true,
    departmentName: record.store.departmentName,
    departmentCode: record.store.departmentCode,
    products,
    ready: record.summary.ready,
    missing: record.summary.missing,
    summary: [
      `Customer store intake ${record.requestId}.`,
      record.store.departmentCode ? `Department code: ${record.store.departmentCode}.` : "Department code not provided.",
      `${products.length} garment build action${products.length === 1 ? "" : "s"} across ${record.summary.includedCount} categor${record.summary.includedCount === 1 ? "y" : "ies"}.`,
      record.summary.missing.length ? `Incomplete fields: ${record.summary.missing.join("; ")}.` : "All included category build fields are present."
    ].join(" ")
  };
}

/* -----------------------------------------------------------------------------
   The intake as a document - what the customer filled, rendered as clean HTML.
   Uploaded to the department's Drive folder as a Google Doc during the build
   and used by the console's printable/PDF view.
   -------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

function docRow(label, value) {
  return `<tr><td style="width:220px;color:#555;padding:4px 12px 4px 0;vertical-align:top"><b>${escapeHtml(label)}</b></td><td style="padding:4px 0">${escapeHtml(value || "—")}</td></tr>`;
}

function intakeDocumentHtml(recordInput) {
  const record = recordWithComputedFields(recordInput);
  const included = record.categories.filter((category) => category.include);
  const skipped = record.categories.filter((category) => !category.include);

  const categoryBlocks = included.map((category) => {
    const definition = categoryDefinition(category.key);
    if (definition.belt) {
      return `<h2>${escapeHtml(definition.title)}</h2><table>${docRow("Belt style", category.beltStyle)}${category.notes ? docRow("Notes", category.notes) : ""}</table>`;
    }
    const variants = category.variants?.length ? category.variants : [category];
    const versionBlocks = variants.map((variant, index) => {
      const decorations = (variant.decorations || []).filter((decoration) => decoration && (decoration.placement || decoration.sizeTier || (decoration.logoSlugs || []).length));
      const undecorated = /^none$/i.test(variant.decorationMethod || "");
      const decorationRows = undecorated
        ? [docRow("Decoration", "None — ships blank")]
        : decorations.length
          ? decorations.flatMap((decoration, position) => {
              const label = decorations.length > 1 ? `Decoration ${position + 1}` : "Decoration";
              const tier = decoration.sizeTier === "Custom" ? `Custom — ${decoration.customSizeTier}` : decoration.sizeTier;
              return [
                docRow(`${label} — placement`, decoration.placement),
                docRow(`${label} — size tier`, tier),
                docRow(`${label} — artwork`, (decoration.logoSlugs || []).join(", ") || "All uploaded logos offered")
              ];
            })
          : [
              docRow("Decoration size tier", variant.sizeTier === "Custom" ? `Custom — ${variant.customSizeTier}` : variant.sizeTier),
              definition.placements?.length ? docRow("Placement", variant.placement) : "",
              docRow("Logo assignment", (variant.logoSlugs || []).join(", ") || variant.logoNotes || "Department logo set (all uploaded logos)")
            ];
      const rows = [
        docRow("Vendor / brand", variant.vendor),
        docRow("Style number", variant.styleNumber),
        docRow("Color(s)", variant.colors),
        variant.style ? docRow("Style notes", variant.style) : "",
        definition.decorated ? docRow("Decoration method", variant.decorationMethod) : "",
        ...(definition.decorated ? decorationRows : []),
        definition.decorated && variant.logoNotes && decorations.length ? docRow("Logo notes (legacy)", variant.logoNotes) : "",
        definition.decorated ? docRow("Name / rank right chest", variant.nameRank === "yes" ? "Yes" : variant.nameRank === "no" ? "No" : "—") : "",
        docRow("Size range", variant.sizeRange === "Other" ? variant.otherSizes : variant.sizeRange),
        variant.notes ? docRow("Notes", variant.notes) : ""
      ].filter(Boolean).join("");
      const heading = variants.length > 1 ? `<h3>Version ${index + 1} of ${variants.length}</h3>` : "";
      return `${heading}<table>${rows}</table>`;
    }).join("");
    const categoryNotes = category.notes ? `<p><b>Category notes:</b> ${escapeHtml(category.notes)}</p>` : "";
    return `<h2>${escapeHtml(definition.title)}</h2>${versionBlocks}${categoryNotes}`;
  }).join("");

  return [
    `<h1>Store Build Request — ${escapeHtml(record.store.departmentName || "Untitled department")}</h1>`,
    `<p>FN Simple Uniforms · submitted ${escapeHtml((record.createdAt || "").slice(0, 10))} · reference ${escapeHtml(record.requestId.slice(0, 8).toUpperCase())}</p>`,
    "<h2>Department</h2>",
    `<table>${[
      docRow("Department / organization", record.store.departmentName),
      docRow("Department code", record.store.departmentCode),
      docRow("Contact", record.store.contactName),
      docRow("Email", record.store.contactEmail),
      docRow("Phone", record.store.contactPhone),
      docRow("Needed by", record.store.neededBy),
      docRow("Notes", record.store.notes)
    ].join("")}</table>`,
    "<h2>Artwork</h2>",
    `<p>${record.logos.length ? record.logos.map((logo) => escapeHtml(logo.name)).join(" · ") : "No logo files stored."}</p>`,
    categoryBlocks,
    skipped.length ? `<h2>Not requested</h2><p>${skipped.map((category) => escapeHtml(category.title)).join(" · ")}</p>` : "",
    blankSourceBlock(record)
  ].filter(Boolean).join("\n");
}

/*
 * Where each blank came from, for the people who have to ORDER the garments.
 * A "supplier photo" row links the exact vendor page the photograph was taken
 * from, so the style and colourway can be checked and purchased without
 * searching for it again. A "generated" row is a warning as much as a note:
 * that product's picture is a lookalike, not the real style.
 */
function blankSourceBlock(record) {
  const products = (record.build || {}).products || [];
  if (!products.length) return "";
  const rows = products
    .map((product) => {
      const fromSupplier = String(product.blankSource || "").startsWith("supplier");
      const origin = fromSupplier ? "Supplier photo" : "Generated lookalike";
      const link = product.blankSourceUrl
        ? `<a href="${escapeHtml(product.blankSourceUrl)}">${escapeHtml(product.blankSourceUrl)}</a>`
        : "—";
      return `<tr><td>${escapeHtml(product.title || "")}</td><td>${escapeHtml(product.vendor || "")}</td><td>${origin}</td><td>${link}</td></tr>`;
    })
    .join("");
  return (
    "<h2>Blank garment sources</h2>" +
    "<p>Where each product's plain-garment photo came from, for checking and ordering.</p>" +
    "<table><tr><th>Product</th><th>Vendor</th><th>Blank</th><th>Source page</th></tr>" +
    rows +
    "</table>"
  );
}


/* Records live in the platform's own blob store; the Drive folder remains as
   a read-only fallback so intakes submitted before the migration keep showing
   in the queue, keep building, and keep saving edits. */

async function legacyIntakeFolder() {
  const parentId = process.env.GDRIVE_PARENT_FOLDER_ID;
  if (!parentId) return null;
  return ensureSubfolder(INTAKE_FOLDER_NAME, parentId);
}

function recordMetadata(record) {
  return {
    kind: "customer-intake",
    status: record.status,
    requestId: record.requestId
  };
}

async function createCustomerIntake(payload, files = []) {
  const input = typeof payload === "string" ? JSON.parse(payload || "{}") : payload || {};
  const logos = files.map((file) => ({
    name: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
    dataUrl: "data:" + file.mimetype + ";base64," + file.buffer.toString("base64")
  }));
  const record = recordWithComputedFields(normalizeRecord({ ...input, logos }));
  validateCustomerIntake(record);
  const filename = record.createdAt.slice(0, 10) + "-" + slug(record.store.departmentName) + "-" + record.requestId.slice(0, 8) + ".json";
  const file = await writeRecordBlob(filename, record, recordMetadata(record));
  return recordWithComputedFields(record, file);
}

async function parseDriveRecord(file) {
  const text = await readFileText(file.id);
  const record = JSON.parse(text);
  return recordWithComputedFields(record, file);
}

async function parseBlobRecord(file) {
  const record = JSON.parse(await readRecordBlobText(file.id));
  return recordWithComputedFields(record, file);
}

function unreadableRecord(file, error) {
  return { id: file.id, driveFile: file, status: "error", error: error.message, store: { departmentName: file.name }, summary: { missing: [error.message], ready: false } };
}

async function listCustomerIntakes() {
  const records = [];
  for (const file of await listRecordBlobs()) {
    try {
      records.push(stripLargeFields(await parseBlobRecord(file)));
    } catch (error) {
      records.push(unreadableRecord(file, error));
    }
  }
  // Pre-migration records, best-effort: a Drive outage must never take the
  // whole queue down with it now that new intakes don't depend on Drive.
  if (googleConnected()) {
    try {
      const folder = await legacyIntakeFolder();
      const files = folder ? await listFilesInFolder(folder.id, { mimeType: "application/json", pageSize: 50 }) : [];
      for (const file of files) {
        try {
          records.push(stripLargeFields(await parseDriveRecord(file)));
        } catch (error) {
          records.push(unreadableRecord(file, error));
        }
      }
    } catch (error) {
      console.error("Legacy Drive intakes are unavailable right now:", error.message);
    }
  }
  return records.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

async function getCustomerIntake(fileId) {
  if (isBlobRecordId(fileId)) return parseBlobRecord({ id: fileId, name: fileId });
  return parseDriveRecord({ id: fileId });
}

async function deleteCustomerIntakeRecord(fileId) {
  if (isBlobRecordId(fileId)) return deleteRecordBlob(fileId);
  return trashFile(fileId);
}

async function updateCustomerIntake(fileId, patch = {}) {
  const existing = await getCustomerIntake(fileId);
  const merged = normalizeRecord({
    ...existing,
    status: patch.status || existing.status,
    store: { ...existing.store, ...(patch.store || {}) },
    categories: patch.categories || existing.categories,
    logos: patch.logos || existing.logos,
    shopifyCollection: patch.shopifyCollection === undefined ? existing.shopifyCollection : patch.shopifyCollection,
    build: patch.build === undefined ? existing.build : patch.build,
    internalNotes: patch.internalNotes ?? existing.internalNotes,
    customerNotes: patch.customerNotes ?? existing.customerNotes,
    createdAt: existing.createdAt,
    requestId: existing.requestId
  });
  const record = recordWithComputedFields(merged, existing.driveFile);
  const file = isBlobRecordId(fileId)
    ? await writeRecordBlob(fileId, record, recordMetadata(record))
    : await updateJsonFile(fileId, record, { status: record.status, requestId: record.requestId, kind: "customer-intake" });
  return recordWithComputedFields(record, file);
}

module.exports = {
  createCustomerIntake,
  deleteCustomerIntakeRecord,
  getCustomerIntake,
  intakeDocumentHtml,
  intakeFromCustomerRecord,
  listCustomerIntakes,
  updateCustomerIntake
};

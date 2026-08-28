const crypto = require("crypto");
const {
  ensureSubfolder,
  listFilesInFolder,
  readFileText,
  updateJsonFile,
  uploadJsonFile
} = require("./drive");
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

const DECORATION_METHODS = ["Embroidery", "Screen Print", "Heat Transfer", "Patch", "None"];
const SIZE_TIERS = ["Small", "Standard", "Large / Full Back", "Custom"];
const SIZE_RANGES = ["S-3XL", "S-5XL", "Youth sizes", "Women's cut", "Other"];

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function slug(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "store";
}

function checked(selected, label) {
  return clean(selected).toLowerCase() === clean(label).toLowerCase() ? "[x]" : "[ ]";
}

function choiceLine(selected, choices) {
  return choices.map((choice) => checked(selected, choice) + " " + choice).join(" ");
}

function normalizeNameRank(value) {
  return value === true || value === "yes" ? "yes" : value === false || value === "no" ? "no" : "";
}

/* One version of a garment: its own vendor, color, decoration, and logo
   assignment. A category holds one or more of these, so "navy Next Level tee
   with the Station 7 crest AND a red Gildan tee with the EMS badge" is two
   variants of the same category instead of a note nobody parses. */
function normalizeVariant(input = {}, index = 0) {
  const source = input || {};
  return {
    id: clean(source.id) || `v${index + 1}`,
    vendor: clean(source.vendor),
    styleNumber: clean(source.styleNumber),
    colors: clean(source.colors),
    style: clean(source.style),
    decorationMethod: clean(source.decorationMethod),
    sizeTier: clean(source.sizeTier),
    customSizeTier: clean(source.customSizeTier),
    placement: clean(source.placement),
    // Exact uploaded file names the customer picked for this garment. Empty
    // means "no specific assignment" - every uploaded logo is offered.
    logoSlugs: Array.isArray(source.logoSlugs) ? source.logoSlugs.map(clean).filter(Boolean).slice(0, 20) : [],
    logoNotes: clean(source.logoNotes),
    nameRank: normalizeNameRank(source.nameRank),
    sizeRange: clean(source.sizeRange),
    otherSizes: clean(source.otherSizes),
    notes: clean(source.notes)
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

  let variants = (Array.isArray(source.variants) ? source.variants : [])
    .filter((item) => item && typeof item === "object")
    .map((item, index) => normalizeVariant(item, index));
  // Pre-variant records (and any client still sending flat fields) become
  // version 1, so old submissions keep building and old edits keep saving.
  // Category-level notes stay on the category - copying them into the variant
  // would print them twice in the structured document.
  if (!variants.length && !definition.belt) {
    const legacy = normalizeVariant({ ...source, notes: "", id: "" }, 0);
    if (variantHasContent(legacy) || include) variants = [legacy];
  }

  const first = variants[0] || normalizeVariant({}, 0);
  return {
    key: source.key || definition.key || "",
    title: source.title || definition.title || "",
    include,
    // Flat fields mirror version 1 so every pre-variant consumer (structured
    // text, the plan endpoint, older records round-tripping) keeps working.
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

function structuredTextFromCustomerIntake(recordInput) {
  const record = normalizeRecord(recordInput);
  const lines = [
    "FN Simple Uniforms Store Build Automation Form",
    "Department & Store Setup",
    "Department / Organization Name " + record.store.departmentName,
    "Department Code " + record.store.departmentCode,
    "Decoration Reference (applies across all garments below)",
    "Logo file requirements: customer uploaded logo files through the intake link.",
    "Garment Selections"
  ];

  for (const category of record.categories) {
    const definition = categoryDefinition(category.key);
    lines.push("", definition.title || category.title, "Field Response / Options");
    lines.push("Include this category in store? " + (category.include ? "[x] Yes [ ] No" : "[ ] Yes [x] No"));
    if (!category.include) continue;

    if (definition.belt) {
      lines.push("Belt Style " + (category.beltStyle || category.style));
      if (category.notes) lines.push("Category Notes " + category.notes);
      continue;
    }

    const variants = category.variants?.length ? category.variants : [category];
    variants.forEach((variant, index) => {
      if (variants.length > 1) lines.push(`Version ${index + 1} of ${variants.length}`);

      // No placeholder when the style is blank: the parser turns whatever sits
      // here into the Shopify product title prefix, and "FN Simple approved
      // catalog T-Shirts" is not a product name anyone typed.
      const styleParts = [variant.styleNumber, variant.style].filter(Boolean).join(" ");
      lines.push("Style & Color(s) " + styleParts + " Color(s): " + variant.colors);
      if (variant.vendor) lines.push("Vendor / Brand " + variant.vendor + (variant.styleNumber ? " — style " + variant.styleNumber : ""));

      if (definition.decorated) {
        lines.push("Decoration Method " + choiceLine(variant.decorationMethod, DECORATION_METHODS));
        const pickedLogos = (variant.logoSlugs || []).join(", ") || variant.logoNotes;
        lines.push(pickedLogos && (variant.logoSlugs?.length || category.logoChoice === "additional")
          ? "Decoration Logo(s) [ ] Use department logo (Section A) [x] Upload additional logo(s): " + pickedLogos
          : "Decoration Logo(s) [x] Use department logo (Section A) [ ] Upload additional logo(s):");
        lines.push("Decoration Size Tier " + choiceLine(variant.sizeTier, SIZE_TIERS) + (variant.sizeTier === "Custom" ? " Custom: " + variant.customSizeTier : ""));
        if (definition.placements && definition.placements.length) lines.push("Placement " + choiceLine(variant.placement, definition.placements));
        lines.push("Name / Rank - Right Chest? " + (variant.nameRank === "yes" ? "[x] Yes [ ] No" : variant.nameRank === "no" ? "[ ] Yes [x] No" : "[ ] Yes [ ] No"));
      }

      lines.push("Size Range Needed " + choiceLine(variant.sizeRange, SIZE_RANGES) + (variant.sizeRange === "Other" ? " Other: " + variant.otherSizes : ""));
      // "Category Notes" is deliberately reused for version notes: it is a
      // known terminator label in intake.js fieldBlock, so a legacy text parse
      // never bleeds these notes into the size-range capture.
      if (variant.notes) lines.push("Category Notes " + variant.notes);
    });
    if (category.notes) lines.push("Category Notes " + category.notes);
  }

  if (record.customerNotes) lines.push("", "Customer notes", record.customerNotes);
  return lines.join("\n");
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
      if (definition.decorated && definition.placements?.length && !variant.placement) missing.push(label + ": placement");
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
    },
    structuredText: structuredTextFromCustomerIntake(normalized)
  };
}

function stripLargeFields(record) {
  const clone = JSON.parse(JSON.stringify(record));
  clone.logos = (clone.logos || []).map((logo) => ({ name: logo.name, mimetype: logo.mimetype, size: logo.size }));
  delete clone.structuredText;
  return clone;
}

function validateCustomerIntake(record) {
  const computed = recordWithComputedFields(record);
  if (!computed.summary.ready) throw new Error("Finish the required fields first: " + computed.summary.missing.join("; "));
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

function productFromVariant(category, variant, versionIndex, versionCount) {
  const definition = categoryDefinition(category.key);
  const meta = categoryMeta(category.key);
  const brandStyle = [variant.styleNumber, variant.style].filter(Boolean).join(" ");
  const tier = normalizeTierLabel(variant.sizeTier, variant.customSizeTier);
  const decorationFeeSku = feeSkuFor({ placement: variant.placement, productType: meta.type, tier });
  const logoSlugs = logoSlugsForVariant(category, variant);
  const notes = [
    `Structured intake category: ${definition.title}${versionCount > 1 ? ` (version ${versionIndex + 1} of ${versionCount})` : ""}.`,
    tier ? `Decoration size tier: ${tier}.` : "",
    decorationFeeSku ? `Decoration fee SKU hint: ${decorationFeeSku}.` : "",
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
    placement: variant.placement,
    decorationMethod: /^None$/i.test(variant.decorationMethod) ? "none" : variant.decorationMethod,
    decorationSizeTier: tier,
    decorationFeeSku,
    // Custom sizes only count when "Other" is the selection: the form keeps a
    // hidden otherSizes input's value when the customer switches back to a
    // preset range, and an ungated pass-through would build the product from
    // that stale text while every human-facing rendering shows the preset.
    sizes: sizesFromRangeLabel(variant.sizeRange, variant.sizeRange === "Other" ? variant.otherSizes : ""),
    sizeChart: null,
    productionNotes: notes.join(" "),
    logoSlugs,
    logoAssignmentStated: logoSlugs[0] !== "all",
    assignmentNotes: logoSlugs[0] === "all"
      ? "Structured intake selected the department logo/default logo set."
      : `Structured intake logo entry: ${logoSlugs.join(", ")}`,
    intakeSource: true,
    imageGuidance: [
      variant.placement ? `Mockup placement selected in intake: ${variant.placement}.` : "",
      tier ? `Leave clean, unobstructed garment surface for ${tier} decoration.` : ""
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
      const rows = [
        docRow("Vendor / brand", variant.vendor),
        docRow("Style number", variant.styleNumber),
        docRow("Color(s)", variant.colors),
        variant.style ? docRow("Style notes", variant.style) : "",
        definition.decorated ? docRow("Decoration method", variant.decorationMethod) : "",
        definition.decorated ? docRow("Decoration size tier", variant.sizeTier === "Custom" ? `Custom — ${variant.customSizeTier}` : variant.sizeTier) : "",
        definition.decorated && definition.placements?.length ? docRow("Placement", variant.placement) : "",
        definition.decorated ? docRow("Logo assignment", (variant.logoSlugs || []).join(", ") || variant.logoNotes || "Department logo set (all uploaded logos)") : "",
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
    skipped.length ? `<h2>Not requested</h2><p>${skipped.map((category) => escapeHtml(category.title)).join(" · ")}</p>` : ""
  ].filter(Boolean).join("\n");
}

async function intakeFolder() {
  const parentId = process.env.GDRIVE_PARENT_FOLDER_ID;
  if (!parentId) throw new Error("Set GDRIVE_PARENT_FOLDER_ID before accepting customer intakes.");
  return ensureSubfolder(INTAKE_FOLDER_NAME, parentId);
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
  const folder = await intakeFolder();
  const filename = record.createdAt.slice(0, 10) + "-" + slug(record.store.departmentName) + "-" + record.requestId.slice(0, 8) + ".json";
  const file = await uploadJsonFile(filename, record, folder.id, {
    kind: "customer-intake",
    status: record.status,
    requestId: record.requestId
  });
  return recordWithComputedFields(record, file);
}

async function parseDriveRecord(file) {
  const text = await readFileText(file.id);
  const record = JSON.parse(text);
  return recordWithComputedFields(record, file);
}

async function listCustomerIntakes() {
  const folder = await intakeFolder();
  const files = await listFilesInFolder(folder.id, { mimeType: "application/json", pageSize: 50 });
  const records = [];
  for (const file of files) {
    try {
      records.push(stripLargeFields(await parseDriveRecord(file)));
    } catch (error) {
      records.push({ id: file.id, driveFile: file, status: "error", error: error.message, store: { departmentName: file.name }, summary: { missing: [error.message], ready: false } });
    }
  }
  return records.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

async function getCustomerIntake(fileId) {
  return parseDriveRecord({ id: fileId });
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
  const file = await updateJsonFile(fileId, record, { status: record.status, requestId: record.requestId, kind: "customer-intake" });
  return recordWithComputedFields(record, file);
}

module.exports = {
  CUSTOMER_INTAKE_CATEGORIES,
  DECORATION_METHODS,
  SIZE_RANGES,
  SIZE_TIERS,
  createCustomerIntake,
  getCustomerIntake,
  intakeDocumentHtml,
  intakeFromCustomerRecord,
  listCustomerIntakes,
  structuredTextFromCustomerIntake,
  updateCustomerIntake
};

const crypto = require("crypto");
const {
  ensureSubfolder,
  listFilesInFolder,
  readFileText,
  updateJsonFile,
  uploadJsonFile
} = require("./drive");

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

function normalizeCategory(input = {}) {
  const source = input || {};
  const definition = CUSTOMER_INTAKE_CATEGORIES.find((item) => item.key === source.key) || {};
  return {
    key: source.key || definition.key || "",
    title: source.title || definition.title || "",
    include: Boolean(source.include),
    style: clean(source.style),
    vendor: clean(source.vendor),
    styleNumber: clean(source.styleNumber),
    colors: clean(source.colors),
    beltStyle: clean(source.beltStyle),
    decorationMethod: clean(source.decorationMethod),
    logoChoice: source.logoChoice === "additional" ? "additional" : "department",
    logoNotes: clean(source.logoNotes),
    sizeTier: clean(source.sizeTier),
    customSizeTier: clean(source.customSizeTier),
    placement: clean(source.placement),
    nameRank: source.nameRank === true || source.nameRank === "yes" ? "yes" : source.nameRank === false || source.nameRank === "no" ? "no" : "",
    sizeRange: clean(source.sizeRange),
    otherSizes: clean(source.otherSizes),
    notes: clean(source.notes)
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

    // No placeholder when the style is blank: the parser turns whatever sits
    // here into the Shopify product title prefix, and "FN Simple approved
    // catalog T-Shirts" is not a product name anyone typed.
    const styleParts = [category.styleNumber, category.style].filter(Boolean).join(" ");
    lines.push("Style & Color(s) " + styleParts + " Color(s): " + category.colors);
    if (category.vendor) lines.push("Vendor / Brand " + category.vendor + (category.styleNumber ? " — style " + category.styleNumber : ""));

    if (definition.decorated) {
      lines.push("Decoration Method " + choiceLine(category.decorationMethod, DECORATION_METHODS));
      lines.push(category.logoChoice === "additional"
        ? "Decoration Logo(s) [ ] Use department logo (Section A) [x] Upload additional logo(s): " + category.logoNotes
        : "Decoration Logo(s) [x] Use department logo (Section A) [ ] Upload additional logo(s):");
      lines.push("Decoration Size Tier " + choiceLine(category.sizeTier, SIZE_TIERS) + (category.sizeTier === "Custom" ? " Custom: " + category.customSizeTier : ""));
      if (definition.placements && definition.placements.length) lines.push("Placement " + choiceLine(category.placement, definition.placements));
      lines.push("Name / Rank - Right Chest? " + (category.nameRank === "yes" ? "[x] Yes [ ] No" : category.nameRank === "no" ? "[ ] Yes [x] No" : "[ ] Yes [ ] No"));
    }

    lines.push("Size Range Needed " + choiceLine(category.sizeRange, SIZE_RANGES) + (category.sizeRange === "Other" ? " Other: " + category.otherSizes : ""));
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
  for (const category of included) {
    const definition = categoryDefinition(category.key);
    if (definition.belt && !category.beltStyle) missing.push(definition.title + ": belt style");
    if (!definition.belt && !category.colors) missing.push(definition.title + ": colors");
    if (definition.decorated && !category.decorationMethod) missing.push(definition.title + ": decoration method");
    if (definition.decorated && definition.placements?.length && !category.placement) missing.push(definition.title + ": placement");
    if (!definition.belt && !category.sizeRange) missing.push(definition.title + ": size range");
  }
  return {
    ...normalized,
    id: driveFile.id || normalized.id,
    driveFile,
    summary: {
      includedCount: included.length,
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
  listCustomerIntakes,
  structuredTextFromCustomerIntake,
  updateCustomerIntake
};

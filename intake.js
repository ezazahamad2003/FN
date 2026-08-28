const { DEFAULT_SIZES } = require("./shopify");

const CATEGORIES = [
  { key: "t-shirts", title: "T-Shirts", type: "shirt", prompt: "a short sleeve t-shirt laid flat" },
  { key: "long-sleeve-shirts", title: "Long Sleeve Shirts", type: "long sleeve shirt", prompt: "a long sleeve shirt laid flat" },
  { key: "crewneck-sweatshirts", title: "Crewneck Sweatshirts", type: "sweatshirt", prompt: "a crewneck sweatshirt laid flat" },
  { key: "hooded-sweatshirts", title: "Hooded Sweatshirts", type: "hoodie", prompt: "a hooded sweatshirt laid flat" },
  { key: "jackets-job-shirts", title: "Jackets / Job Shirts", type: "jacket", prompt: "a jacket or job shirt laid flat" },
  { key: "polos", title: "Polos", type: "polo", prompt: "a collared polo shirt laid flat" },
  { key: "shorts", title: "Shorts", type: "shorts", prompt: "a pair of uniform shorts laid flat" },
  { key: "sweatpants", title: "Sweatpants", type: "sweatpants", prompt: "a pair of sweatpants laid flat" },
  { key: "class-b-uniform-shirt", title: "Class B Uniform Shirt", type: "class b uniform shirt", prompt: "a class b uniform shirt laid flat" },
  { key: "class-b-uniform-pants", title: "Class B Uniform Pants", type: "class b uniform pants", prompt: "a pair of class b uniform pants laid flat" },
  { key: "belts", title: "Belts", type: "belt", prompt: "a uniform belt laid flat" },
  { key: "hats", title: "Hats", type: "hat", prompt: "a structured uniform hat photographed from the front" }
];

const CATEGORY_HEADINGS = CATEGORIES.map((category) => category.title);

const DECORATION_FEE_SKU_MAP = {
  "front:small": "DEC-FRONT-SMALL",
  "front:standard": "DEC-FRONT-STANDARD",
  "front:large": "DEC-FRONT-LARGE",
  "back:standard": "DEC-BACK-STANDARD",
  "back:large": "DEC-BACK-LARGE",
  "sleeve:small": "DEC-SLEEVE-SMALL",
  "leg:small": "DEC-LEG-SMALL",
  "cap:standard": "DEC-CAP-STANDARD"
};

function configuredFeeSkuMap() {
  if (!process.env.DECORATION_FEE_SKU_MAP_JSON) return DECORATION_FEE_SKU_MAP;
  try {
    return { ...DECORATION_FEE_SKU_MAP, ...JSON.parse(process.env.DECORATION_FEE_SKU_MAP_JSON) };
  } catch (error) {
    console.warn(`DECORATION_FEE_SKU_MAP_JSON is invalid: ${error.message}`);
    return DECORATION_FEE_SKU_MAP;
  }
}

function clean(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function safeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fieldBlock(section, fieldName) {
  const labels = [
    "Include this category in store?",
    "Style & Color(s)",
    "Vendor / Brand",
    "Belt Style",
    "Decoration Method",
    "Decoration Logo(s)",
    "Decoration Size Tier",
    "Placement",
    "Name / Rank",
    "Size Range Needed",
    // Terminates the block before it: without this, a category's free-text
    // notes bled into the "Other:" custom-size capture and shipped to Shopify
    // as size variants ("4XL, 5XL Notes rush order please"). Must end in a
    // word character - the lookahead closes with \b, which never matches
    // after a colon.
    "Category Notes",
    // Multi-variant intakes emit "Version N of M" between versions. The legacy
    // parser only ever reads the FIRST version of a category, but this
    // terminator keeps a later version's lines from bleeding into the first
    // version's field captures if the document is pasted back through the
    // onboarding flow.
    "Version"
  ];
  const rest = labels.filter((label) => label !== fieldName).map(safeRegex).join("|");
  const pattern = rest
    ? new RegExp(`${safeRegex(fieldName)}\\s*([\\s\\S]*?)(?=\\s*(?:${rest})\\b|$)`, "i")
    : new RegExp(`${safeRegex(fieldName)}\\s*([\\s\\S]*)`, "i");
  return clean(section.match(pattern)?.[1] || "");
}

function checkedChoice(text, choices) {
  const source = String(text || "");
  for (const choice of choices) {
    const pattern = new RegExp(`(?:[☑☒✓✔xX]|\\[[xX]\\])\\s*${safeRegex(choice)}\\b`, "i");
    if (pattern.test(source)) return choice;
  }
  return "";
}

function splitChoiceField(text, choices) {
  const checked = checkedChoice(text, choices);
  if (checked) return checked;
  const withoutBoxes = clean(String(text || "").replace(/(?:☐|\[ \])\s*[^☐\[]+/g, " "));
  return choices.find((choice) => new RegExp(`\\b${safeRegex(choice)}\\b`, "i").test(withoutBoxes)) || withoutBoxes;
}

function checkedYesNo(text) {
  const yes = /(?:[☑☒✓✔xX]|\[[xX]\])\s*Yes\b|Yes\s*(?:[☑☒✓✔xX]|\[[xX]\])/i.test(text || "");
  const no = /(?:[☑☒✓✔xX]|\[[xX]\])\s*No\b|No\s*(?:[☑☒✓✔xX]|\[[xX]\])/i.test(text || "");
  if (yes && !no) return true;
  if (no && !yes) return false;
  return null;
}

function extractDepartmentName(text) {
  const match = text.match(/Department\s*\/?\s*Organization\s*Name\s*([^☐\n\r]+?)(?=\s*Department Code|\n|$)/i);
  const value = clean(match?.[1] || "").replace(/_+/g, "").trim();
  return value || "";
}

function extractDepartmentCode(text) {
  const line = String(text || "")
    .split(/\r?\n/)
    .find((value) => /Department Code/i.test(value)) || "";
  const answerSide = line.includes(")") ? line.slice(line.lastIndexOf(")") + 1) : line.replace(/.*Department Code/i, "");
  const stop = new Set(["FOR", "SKU", "TAG", "CONVENTION", "LETTER", "CODE", "FN", "SIMPLE", "ASSIGN", "CONFIRM", "MATCH", "EXISTING"]);
  const token = (answerSide.match(/\b[A-Z][A-Z0-9]{1,5}\b/g) || []).find((value) => !stop.has(value.toUpperCase()));
  return token ? token.toUpperCase() : "";
}

function extractCategorySections(text) {
  return CATEGORIES.map((category, index) => {
    const nextTitles = CATEGORY_HEADINGS.slice(index + 1).map(safeRegex).join("|");
    const pattern = nextTitles
      ? new RegExp(`${safeRegex(category.title)}\\s*([\\s\\S]*?)(?=\\n\\s*(?:${nextTitles})\\s*\\n|$)`, "i")
      : new RegExp(`${safeRegex(category.title)}\\s*([\\s\\S]*)`, "i");
    return { category, section: text.match(pattern)?.[1] || "" };
  });
}

function extractStyleAndColor(section) {
  const styleBlock = fieldBlock(section, "Style & Color(s)") || fieldBlock(section, "Belt Style");
  const color = clean(styleBlock.match(/Color\(s\):\s*([^☐]+?)(?=$|Vendor|Decoration|Size Range|Placement)/i)?.[1] || "")
    .replace(/_+/g, "")
    .trim();
  const style = clean(styleBlock.replace(/\[[^\]]+\]/g, "").replace(/Color\(s\):[\s\S]*/i, "").replace(/_+/g, " "));
  return { style, color };
}

/* Size-range label → concrete size list. Shared by the checkbox-text parser
   below and the direct record→products path in customerIntakes.js, so both
   expand "S-3XL" to the identical variant list. */
function sizesFromRangeLabel(label, otherSizes = "") {
  const custom = clean(otherSizes);
  if (custom) return custom.split(/,\s*/).filter(Boolean);
  const value = String(label || "");
  if (/S[-–]3XL/i.test(value)) return ["S", "M", "L", "XL", "2XL", "3XL"];
  if (/S[-–]5XL/i.test(value)) return ["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];
  if (/Youth/i.test(value)) return ["YXS", "YS", "YM", "YL", "YXL"];
  if (/Women/i.test(value)) return ["Women's XS", "Women's S", "Women's M", "Women's L", "Women's XL", "Women's 2XL", "Women's 3XL"];
  return [];
}

function normalizeSizeRange(text) {
  const value = checkedChoice(text, ["S-3XL", "S-5XL", "Youth sizes", "Women's cut"]);
  const custom = clean(String(text || "").match(/Other:\s*([^☐]+)/i)?.[1] || "").replace(/_+/g, "").trim();
  return sizesFromRangeLabel(value, custom);
}

function decorationZone(placement, categoryType) {
  const text = `${placement || ""} ${categoryType || ""}`.toLowerCase();
  if (/\bback\b/.test(text)) return "back";
  if (/\bsleeve\b/.test(text)) return "sleeve";
  if (/\bleg|thigh\b/.test(text)) return "leg";
  if (/\bhat|cap|front center|side\b/.test(text)) return "cap";
  return "front";
}

/* Tier label ("Small" / "Large / Full Back" / "Custom" + free text) → the
   canonical tier key the fee-SKU map and placement guidance use. */
function normalizeTierLabel(label, customTier = "") {
  const value = String(label || "");
  if (/Large/i.test(value)) return "large";
  if (/Standard/i.test(value)) return "standard";
  if (/Small/i.test(value)) return "small";
  const custom = clean(customTier);
  return custom ? `custom: ${custom}` : "";
}

function decorationTier(text) {
  const tier = checkedChoice(text, ["Small", "Standard", "Large / Full Back"]);
  const custom = clean(String(text || "").match(/Custom:\s*([^☐]+)/i)?.[1] || "").replace(/_+/g, "");
  return normalizeTierLabel(tier, custom);
}

function feeSkuFor({ placement, productType, tier }) {
  if (!tier || tier.startsWith("custom")) return "";
  const zone = decorationZone(placement, productType);
  const map = configuredFeeSkuMap();
  return map[`${zone}:${tier}`] || map[`${zone}:standard`] || "";
}

function logoSlugsFrom(text) {
  const source = clean(String(text || "").replace(/_+/g, " "));
  if (!source) return ["all"];
  // Only the CHECKED department-logo option means "all". The unchecked label
  // text ("[ ] Use department logo") is present on every form, and matching it
  // bare made every specific-logo selection collapse to the full set.
  if (/(?:\[[xX]\]|[☑☒✓✔])\s*Use department logo/i.test(source)) return ["all"];
  const after = source.match(/(?:garment\(s\):|logo\(s\):|additional logo\(s\):)\s*(.+)$/i)?.[1] || source;
  const tokens = after
    .split(/[,;/]|\band\b/i)
    .map((part) => clean(part))
    .filter((part) => part && !/^upload|specific|use department logo$/i.test(part));
  return tokens.length ? tokens : ["all"];
}

function extractVendor(section) {
  // "Vendor / Brand Next Level Apparel — style NL3600" from the customer form.
  const block = fieldBlock(section, "Vendor / Brand");
  return clean(String(block || "").replace(/—\s*style\b[\s\S]*/i, "").replace(/_+/g, " "));
}

function productFromCategory(category, section) {
  const include = checkedYesNo(fieldBlock(section, "Include this category in store?"));
  const { style, color } = extractStyleAndColor(section);
  const vendor = extractVendor(section);
  const method = splitChoiceField(fieldBlock(section, "Decoration Method"), ["Embroidery", "Screen Print", "Heat Transfer", "Patch", "None"]);
  const placement = splitChoiceField(fieldBlock(section, "Placement"), [
    "Front left chest",
    "Center back",
    "Left sleeve",
    "Right sleeve",
    "Both sleeves",
    "Left leg",
    "Right leg",
    "Front center",
    "Side"
  ]);
  const tier = decorationTier(fieldBlock(section, "Decoration Size Tier"));
  const sizes = normalizeSizeRange(fieldBlock(section, "Size Range Needed"));
  const nameRank = checkedYesNo(fieldBlock(section, "Name / Rank"));
  const logoSlugs = logoSlugsFrom(fieldBlock(section, "Decoration Logo(s)"));
  const categoryNotes = clean(fieldBlock(section, "Category Notes"));
  const hasAnswers = [style, color, method, placement, tier, sizes.join(""), nameRank === null ? "" : String(nameRank)].some(Boolean);

  if (include === false) return null;
  if (include !== true && !hasAnswers) return null;

  const decorationFeeSku = feeSkuFor({ placement, productType: category.type, tier });
  const label = style ? `${style} ${category.title}` : category.title;
  const notes = [
    `Structured intake category: ${category.title}.`,
    tier ? `Decoration size tier: ${tier}.` : "",
    decorationFeeSku ? `Decoration fee SKU hint: ${decorationFeeSku}.` : "",
    nameRank === true ? "Name/rank personalization requested on right chest." : "",
    nameRank === false ? "No name/rank right-chest personalization requested." : "",
    categoryNotes ? `Customer note: ${categoryNotes}` : ""
  ].filter(Boolean);

  return {
    productType: category.type,
    productLabel: label,
    productPrompt: category.prompt,
    garmentColor: color,
    brandStyle: style,
    vendor,
    fabricDetails: "",
    placement,
    decorationMethod: /^None$/i.test(method) ? "none" : method,
    decorationSizeTier: tier,
    decorationFeeSku,
    sizes,
    sizeChart: null,
    productionNotes: notes.join(" "),
    logoSlugs,
    logoAssignmentStated: logoSlugs[0] !== "all",
    assignmentNotes: logoSlugs[0] === "all" ? "Structured intake selected the department logo/default logo set." : `Structured intake logo entry: ${logoSlugs.join(", ")}`,
    intakeSource: true,
    imageGuidance: [
      placement ? `Mockup placement selected in intake: ${placement}.` : "",
      tier ? `Leave clean, unobstructed garment surface for ${tier} decoration.` : ""
    ].filter(Boolean).join(" ")
  };
}

function parseStructuredIntakeText(text) {
  const source = clean(text);
  if (!/Store Build Automation Form|Include this category in store|Department Code/i.test(source)) {
    return { present: false, departmentName: "", departmentCode: "", products: [], ready: null, summary: "" };
  }

  const products = extractCategorySections(text)
    .map(({ category, section }) => productFromCategory(category, section))
    .filter(Boolean);
  const missing = [];
  for (const product of products) {
    if (!product.brandStyle) missing.push(`${product.productLabel}: style`);
    if (!product.garmentColor && product.productType !== "belt") missing.push(`${product.productLabel}: color`);
    if (!product.placement && !["belt", "class b uniform pants"].includes(product.productType)) missing.push(`${product.productLabel}: placement`);
    if (!product.decorationMethod && !["belt", "class b uniform pants"].includes(product.productType)) missing.push(`${product.productLabel}: decoration method`);
    if (!product.sizes.length && product.productType !== "belt") missing.push(`${product.productLabel}: sizes`);
  }

  const departmentCode = extractDepartmentCode(text);
  return {
    present: true,
    departmentName: extractDepartmentName(text),
    departmentCode,
    products,
    ready: products.length > 0 && missing.length === 0,
    missing,
    summary: [
      `Structured store-build intake detected.`,
      departmentCode ? `Department code: ${departmentCode}.` : "Department code not provided.",
      `${products.length} included category ${products.length === 1 ? "build action" : "build actions"} detected.`,
      missing.length ? `Incomplete fields: ${missing.join("; ")}.` : "All included category build fields are present."
    ].join(" ")
  };
}

function combineIntakes(intakes) {
  const present = intakes.filter((item) => item.present);
  if (!present.length) return { present: false, departmentName: "", departmentCode: "", products: [], ready: null, missing: [], summary: "" };
  const products = present.flatMap((item) => item.products);
  const missing = present.flatMap((item) => item.missing || []);
  return {
    present: true,
    departmentName: present.find((item) => item.departmentName)?.departmentName || "",
    departmentCode: present.find((item) => item.departmentCode)?.departmentCode || "",
    products,
    ready: products.length > 0 && missing.length === 0,
    missing,
    summary: present.map((item) => item.summary).join("\n")
  };
}

function mergeIntakeProducts(policyProducts, intake) {
  if (!intake?.products?.length) return policyProducts;
  const existing = new Set(intake.products.map((product) => clean(product.productLabel).toLowerCase()));
  const extras = (policyProducts || []).filter((product) => !existing.has(clean(product.productLabel).toLowerCase()));
  return [...intake.products, ...extras];
}

function intakeTags(intake) {
  const tags = [];
  if (intake?.departmentCode) {
    tags.push(intake.departmentCode, `dept-${intake.departmentCode.toLowerCase()}`);
  }
  if (intake?.present) tags.push("structured-intake");
  return tags;
}

function intakeContextText(intake) {
  if (!intake?.present) return "";
  const products = intake.products.map((product) => ({
    productLabel: product.productLabel,
    productType: product.productType,
    garmentColor: product.garmentColor,
    brandStyle: product.brandStyle,
    vendor: product.vendor || "",
    placement: product.placement,
    decorationMethod: product.decorationMethod,
    decorationSizeTier: product.decorationSizeTier,
    decorationFeeSku: product.decorationFeeSku,
    sizes: product.sizes.length ? product.sizes : DEFAULT_SIZES,
    logoSlugs: product.logoSlugs
  }));
  return `Structured store-build intake summary:\n${intake.summary}\n\nDeterministic build actions from fixed fields:\n${JSON.stringify(products, null, 2)}`;
}

module.exports = {
  INTAKE_CATEGORY_META: CATEGORIES,
  combineIntakes,
  feeSkuFor,
  intakeContextText,
  intakeTags,
  mergeIntakeProducts,
  normalizeTierLabel,
  parseStructuredIntakeText,
  sizesFromRangeLabel
};

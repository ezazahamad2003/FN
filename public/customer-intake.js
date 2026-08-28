/* -----------------------------------------------------------------------------
   Customer store intake.

   A four-step wizard over the FN store build form. The schema mirrors
   customerIntakes.js on the server: every category carries the same fixed
   fields, each category holds one or more VARIANTS (a variant is one version
   of the garment - its own vendor, color, and artwork), and each variant
   holds one or more DECORATIONS - a decoration is one SPOT on the garment
   (front left chest, center back, a sleeve) with its own logo assignment and
   artwork size. "Crest on the chest AND the full department mark across the
   back" is two decorations of one shirt, picked visually, not written into a
   note nobody parses.

   Beyond rendering inputs this file:
     • draws a floating garment illustration per category that recolors live
       as the customer types a color;
     • renders each placement choice as a mini garment diagram with a marker
       dot showing exactly where the artwork lands (dashed ring = back view);
     • lets every decoration pick its logos from the uploaded artwork by
       thumbnail instead of describing files in free text;
     • validates per step - and stays a strict superset of the server's
       required-field rules, so nothing passes here and 400s there;
     • autosaves a draft to localStorage (files excluded - the browser will
       not let us re-populate a file input), so a half-finished form survives
       a closed tab.
   -------------------------------------------------------------------------- */

const CATEGORIES = [
  { key: "t-shirts", title: "T-Shirts", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "long-sleeve-shirts", title: "Long Sleeve Shirts", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "crewneck-sweatshirts", title: "Crewneck Sweatshirts", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "hooded-sweatshirts", title: "Hooded Sweatshirts", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "jackets-job-shirts", title: "Jackets / Job Shirts", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "polos", title: "Polos", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "shorts", title: "Shorts", placements: ["Left leg", "Right leg"], decorated: true },
  { key: "sweatpants", title: "Sweatpants", placements: ["Left leg", "Right leg"], decorated: true },
  { key: "class-b-uniform-shirt", title: "Class B Uniform Shirt", placements: ["Left sleeve", "Right sleeve", "Both sleeves"], decorated: true },
  { key: "class-b-uniform-pants", title: "Class B Uniform Pants", placements: [], decorated: false },
  { key: "belts", title: "Belts", placements: [], decorated: false, belt: true },
  { key: "hats", title: "Hats", placements: ["Front center", "Side"], decorated: true }
];

const METHODS = ["Embroidery", "Screen Print", "Heat Transfer", "Patch", "None"];
const TIERS = [
  { value: "Small", hint: "~4″" },
  { value: "Standard", hint: "~6″" },
  { value: "Large / Full Back", hint: "~8–10″" },
  { value: "Custom", hint: "" }
];
const SIZES = ["S-3XL", "S-5XL", "Youth sizes", "Women's cut", "Other"];
const DRAFT_KEY = "fnIntakeDraft";
const MAX_VARIANTS_PER_CATEGORY = 6;

// Placements the production standard photographs from the back. These render
// with a dashed marker and a "back" badge, and the build generates a real
// back view for them instead of printing back artwork across the chest.
const BACK_PLACEMENTS = new Set(["Center back"]);

// Wholesale houses departments actually buy from. The field is a free-text
// input with these as suggestions - any vendor name works, and naming one
// sends our sourcing agent to that vendor's catalog for the exact product
// photo used in your store mockups.
const VENDORS = [
  "Jiffy", "ShirtSpace", "Blankstyle", "AllDayShirts", "ClothingSpace",
  "B2B Sportswear", "S&S Activewear", "SanMar", "alphabroder", "Wordans",
  "Joe's USA", "ApparelnBags", "Clothing Authority", "Bella+Canvas",
  "AS Colour", "Shaka Wear", "Independent Trading Co.", "Los Angeles Apparel",
  "Royal Apparel", "Lane Seven Apparel", "Next Level Apparel", "Gildan",
  "Comfort Colors", "Port & Company", "Sport-Tek", "District", "Carhartt",
  "Richardson", "Flexfit", "Augusta Sportswear", "5.11 Tactical",
  "Flying Cross", "Elbeco", "Game Sportswear", "Snap 'n' Wear"
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

/* ── Garment illustrations ───────────────────────────────────────────────────
   Every category gets a flat-lay illustration built from the same vocabulary:
   .g-body (garment fill, recolored via --g-fill), .g-shade / .g-sheen (form),
   .g-line (seams and details). The scene floats; the shadow underneath
   breathes with it, which is what sells the "hovering product photo" read. */

function garmentSvg(inner) {
  return '<svg class="garment-svg" viewBox="0 0 220 220" aria-hidden="true" focusable="false">' + inner + "</svg>";
}

const GARMENT_INNER = {
  "t-shirts": () =>
    '<path class="g-body" d="M78 34 L46 48 L26 92 L54 106 L62 90 L62 184 L158 184 L158 90 L166 106 L194 92 L174 48 L142 34 C134 50 86 50 78 34 Z"/>' +
    '<path class="g-shade" d="M62 90 L62 184 L80 184 C72 142 72 100 76 62 L62 90 Z"/>' +
    '<path class="g-sheen" d="M126 66 C142 70 150 84 148 100 C136 96 126 82 126 66 Z"/>' +
    '<path class="g-line" d="M88 38 C96 50 124 50 132 38"/>' +
    '<path class="g-line" d="M62 92 L76 58 M158 92 L144 58 M64 172 L156 172"/>',
  "long-sleeve-shirts": () =>
    '<path class="g-body" d="M78 34 L48 46 L36 74 L30 150 L56 156 L62 102 L62 184 L158 184 L158 102 L164 156 L190 150 L184 74 L172 46 L142 34 C134 50 86 50 78 34 Z"/>' +
    '<path class="g-shade" d="M62 102 L62 184 L80 184 C73 144 72 104 76 62 L62 102 Z"/>' +
    '<path class="g-sheen" d="M126 66 C142 70 150 84 148 100 C136 96 126 82 126 66 Z"/>' +
    '<path class="g-line" d="M88 38 C96 50 124 50 132 38"/>' +
    '<path class="g-line" d="M62 102 L68 60 M158 102 L152 60 M64 172 L156 172 M31 142 L57 148 M189 142 L163 148"/>',
  "crewneck-sweatshirts": () =>
    '<path class="g-body" d="M76 32 L46 46 L32 76 L28 150 L56 158 L60 104 L60 184 L160 184 L160 104 L164 158 L192 150 L188 76 L174 46 L144 32 C136 50 84 50 76 32 Z"/>' +
    '<path class="g-shade" d="M60 104 L60 184 L80 184 C72 144 71 104 76 60 L60 104 Z"/>' +
    '<path class="g-sheen" d="M128 66 C144 72 152 86 150 102 C138 98 128 84 128 66 Z"/>' +
    '<path class="g-line" d="M84 34 C90 52 130 52 136 34 M88 40 C94 54 126 54 132 40"/>' +
    '<path class="g-line" d="M60 168 L160 168 M74 170 L74 182 M92 170 L92 182 M110 170 L110 182 M128 170 L128 182 M146 170 L146 182"/>' +
    '<path class="g-line" d="M29 142 L57 150 M191 142 L163 150 M33 148 L58 155 M187 148 L162 155"/>',
  "hooded-sweatshirts": () =>
    '<path class="g-body" d="M76 38 L46 50 L32 80 L28 152 L56 160 L60 106 L60 186 L160 186 L160 106 L164 160 L192 152 L188 80 L174 50 L144 38 C136 54 84 54 76 38 Z"/>' +
    '<path class="g-body" d="M76 38 C64 16 156 16 144 38 C134 28 86 28 76 38 Z"/>' +
    '<path class="g-shade" d="M60 106 L60 186 L80 186 C72 148 71 108 76 66 L60 106 Z"/>' +
    '<path class="g-sheen" d="M128 70 C144 76 152 90 150 106 C138 102 128 88 128 70 Z"/>' +
    '<path class="g-line" d="M80 42 C90 56 130 56 140 42"/>' +
    '<path class="g-line" d="M101 56 L99 84 M119 56 L121 84"/>' +
    '<circle class="g-dot" cx="99" cy="86" r="2.5"/><circle class="g-dot" cx="121" cy="86" r="2.5"/>' +
    '<path class="g-line" d="M82 132 L138 132 L130 172 L90 172 Z M90 136 L96 148 M130 136 L124 148"/>',
  "jackets-job-shirts": () =>
    '<path class="g-body" d="M74 36 L46 48 L32 80 L28 154 L56 160 L60 106 L60 186 L160 186 L160 106 L164 160 L192 154 L188 80 L174 48 L146 36 L146 44 L110 52 L74 44 Z"/>' +
    '<path class="g-body" d="M82 26 L138 26 L146 44 L74 44 Z"/>' +
    '<path class="g-shade" d="M60 106 L60 186 L80 186 C72 148 71 108 76 66 L60 106 Z"/>' +
    '<path class="g-sheen" d="M130 72 C146 78 152 92 150 108 C138 104 130 90 130 72 Z"/>' +
    '<path class="g-line" d="M110 52 L110 186 M104 52 L104 186"/>' +
    '<rect class="g-dot" x="103" y="62" width="8" height="12" rx="2"/>' +
    '<path class="g-line" d="M74 138 L92 158 M146 138 L128 158 M29 146 L57 153 M191 146 L163 153"/>',
  polos: () =>
    '<path class="g-body" d="M78 34 L46 48 L26 92 L54 106 L62 90 L62 184 L158 184 L158 90 L166 106 L194 92 L174 48 L142 34 C134 50 86 50 78 34 Z"/>' +
    '<path class="g-body" d="M92 30 L110 54 L76 42 Z M128 30 L110 54 L144 42 Z"/>' +
    '<path class="g-shade" d="M62 90 L62 184 L80 184 C72 142 72 100 76 62 L62 90 Z"/>' +
    '<path class="g-sheen" d="M128 68 C144 72 150 86 148 102 C136 98 128 84 128 68 Z"/>' +
    '<path class="g-line" d="M104 54 L104 92 L116 92 L116 54"/>' +
    '<circle class="g-dot" cx="110" cy="66" r="2.5"/><circle class="g-dot" cx="110" cy="80" r="2.5"/>' +
    '<path class="g-line" d="M62 92 L76 58 M158 92 L144 58 M64 172 L156 172"/>',
  shorts: () =>
    '<path class="g-body" d="M58 56 L162 56 L162 74 L170 148 L116 148 L110 102 L104 148 L50 148 L58 74 Z"/>' +
    '<path class="g-shade" d="M58 74 L50 148 L70 148 L74 74 Z"/>' +
    '<path class="g-sheen" d="M132 84 C144 88 150 100 148 114 C138 110 132 98 132 84 Z"/>' +
    '<path class="g-line" d="M58 74 L162 74 M104 62 C107 68 113 68 116 62"/>' +
    '<path class="g-line" d="M52 138 L72 138 M148 138 L168 138 M110 74 L110 102"/>',
  sweatpants: () =>
    '<path class="g-body" d="M68 34 L152 34 L152 52 L160 168 L124 168 L110 84 L96 168 L60 168 L68 52 Z"/>' +
    '<path class="g-body" d="M58 168 L98 168 L98 184 L58 184 Z M122 168 L162 168 L162 184 L122 184 Z"/>' +
    '<path class="g-shade" d="M68 52 L60 168 L78 168 L82 52 Z"/>' +
    '<path class="g-line" d="M68 52 L152 52 M102 40 C106 46 114 46 118 40"/>' +
    '<circle class="g-dot" cx="103" cy="46" r="2"/><circle class="g-dot" cx="117" cy="46" r="2"/>' +
    '<path class="g-line" d="M66 176 L90 176 M130 176 L154 176 M110 52 L110 84"/>',
  "class-b-uniform-shirt": () =>
    '<path class="g-body" d="M76 32 L48 44 L38 76 L34 150 L58 156 L62 102 L62 186 L158 186 L158 102 L162 156 L186 150 L182 76 L172 44 L144 32 L144 38 L110 48 L76 38 Z"/>' +
    '<path class="g-body" d="M90 26 L110 48 L82 40 Z M130 26 L110 48 L138 40 Z"/>' +
    '<path class="g-shade" d="M62 102 L62 186 L80 186 C73 146 72 106 76 62 L62 102 Z"/>' +
    '<path class="g-line" d="M110 48 L110 186"/>' +
    '<circle class="g-dot" cx="110" cy="64" r="2.5"/><circle class="g-dot" cx="110" cy="92" r="2.5"/><circle class="g-dot" cx="110" cy="120" r="2.5"/><circle class="g-dot" cx="110" cy="148" r="2.5"/>' +
    '<path class="g-line" d="M70 90 L98 90 L98 116 L70 116 Z M70 98 L98 98 M122 90 L150 90 L150 116 L122 116 Z M122 98 L150 98"/>' +
    '<path class="g-line" d="M62 102 L68 58 M158 102 L152 58"/>',
  "class-b-uniform-pants": () =>
    '<path class="g-body" d="M72 32 L148 32 L148 48 L154 186 L118 186 L110 84 L102 186 L66 186 L72 48 Z"/>' +
    '<path class="g-shade" d="M72 48 L66 186 L84 186 L88 48 Z"/>' +
    '<path class="g-line" d="M72 48 L148 48 M80 34 L80 46 M110 34 L110 46 M140 34 L140 46"/>' +
    '<circle class="g-dot" cx="122" cy="41" r="2.5"/>' +
    '<path class="g-line" d="M88 60 L86 176 M132 60 L134 176 M110 48 L110 84"/>',
  belts: () =>
    '<circle class="belt-ring" cx="110" cy="124" r="56"/>' +
    '<circle class="g-line" cx="110" cy="124" r="71"/>' +
    '<circle class="g-line" cx="110" cy="124" r="41"/>' +
    '<rect class="g-body" x="92" y="36" width="36" height="28" rx="5"/>' +
    '<path class="g-line" d="M110 38 L110 60"/>' +
    '<circle class="g-dot" cx="152" cy="96" r="2.5"/><circle class="g-dot" cx="160" cy="110" r="2.5"/><circle class="g-dot" cx="164" cy="126" r="2.5"/>',
  hats: () =>
    '<path class="g-body" d="M50 120 C50 64 82 42 110 42 C138 42 170 64 170 120 Z"/>' +
    '<path class="g-shade" d="M50 120 C50 64 82 42 110 42 C96 48 78 74 76 120 Z"/>' +
    '<path class="g-sheen" d="M132 56 C146 66 154 84 155 104 C144 96 134 76 132 56 Z"/>' +
    '<path class="g-line" d="M83 50 C79 78 77 100 77 120 M137 50 C141 78 143 100 143 120 M110 42 L110 120"/>' +
    '<circle class="g-dot" cx="110" cy="42" r="3.5"/>' +
    '<path class="g-body" d="M46 120 C78 136 142 136 174 120 C186 126 188 138 180 144 C146 160 74 160 40 144 C32 138 34 126 46 120 Z"/>' +
    '<path class="g-line" d="M50 124 C82 138 138 138 170 124"/>'
};

const GARMENT_ART = Object.fromEntries(
  Object.entries(GARMENT_INNER).map(([key, inner]) => [key, () => garmentSvg(inner())])
);

/* Marker dots for the placement picker: [x, y] on the 220×220 art, wearer's
   left = viewer's RIGHT, matching the production mockups. "Both sleeves"
   carries two dots. */
const PLACEMENT_SPOTS = {
  "t-shirts": { "Front left chest": [[136, 86]], "Center back": [[110, 102]], "Left sleeve": [[178, 76]], "Right sleeve": [[42, 76]] },
  "long-sleeve-shirts": { "Front left chest": [[136, 88]], "Center back": [[110, 102]], "Left sleeve": [[172, 116]], "Right sleeve": [[48, 116]] },
  "crewneck-sweatshirts": { "Front left chest": [[136, 90]], "Center back": [[110, 104]], "Left sleeve": [[176, 120]], "Right sleeve": [[44, 120]] },
  "hooded-sweatshirts": { "Front left chest": [[138, 96]], "Center back": [[110, 106]], "Left sleeve": [[178, 124]], "Right sleeve": [[42, 124]] },
  "jackets-job-shirts": { "Front left chest": [[138, 94]], "Center back": [[110, 106]], "Left sleeve": [[178, 124]], "Right sleeve": [[42, 124]] },
  polos: { "Front left chest": [[136, 90]], "Center back": [[110, 102]], "Left sleeve": [[178, 76]], "Right sleeve": [[42, 76]] },
  shorts: { "Left leg": [[140, 108]], "Right leg": [[80, 108]] },
  sweatpants: { "Left leg": [[134, 120]], "Right leg": [[86, 120]] },
  "class-b-uniform-shirt": { "Left sleeve": [[172, 116]], "Right sleeve": [[48, 116]], "Both sleeves": [[48, 116], [172, 116]] },
  hats: { "Front center": [[110, 90]], Side: [[150, 98]] }
};

function placementArt(categoryKey, placement) {
  const inner = GARMENT_INNER[categoryKey] ? GARMENT_INNER[categoryKey]() : "";
  const isBack = BACK_PLACEMENTS.has(placement);
  const spots = (PLACEMENT_SPOTS[categoryKey] || {})[placement] || [];
  const markers = spots
    .map(
      ([x, y]) =>
        `<circle class="g-marker${isBack ? " g-marker-back" : ""}" cx="${x}" cy="${y}" r="9"/>` +
        `<circle class="g-marker-core" cx="${x}" cy="${y}" r="3.4"/>`
    )
    .join("");
  return garmentSvg(inner + markers);
}

/* Color words → illustration fill. First match wins, so multi-word colors
   ("light blue", "safety green") sit above their generic fallbacks. */
const COLOR_SWATCHES = [
  [/safety\s*green|hi.?vis|neon/, "#c3d431"],
  [/light\s*blue|carolina|sky/, "#8fb3d9"],
  [/navy|midnight/, "#25324e"],
  [/charcoal|graphite|dark\s*gr[ae]y/, "#3c434c"],
  [/black/, "#23262c"],
  [/white|natural|ivory/, "#eef0f3"],
  [/heather|gr[ae]y|athletic|silver/, "#9aa3ad"],
  [/maroon|burgundy|cranberry|cardinal/, "#6e2a35"],
  [/red|scarlet|fire/, "#b23129"],
  [/royal|blue/, "#2c4f9e"],
  [/forest|hunter|dark\s*green/, "#2c4a38"],
  [/olive|military|od\s*green|army|coyote/, "#5a6047"],
  [/green|kelly/, "#2f7d4f"],
  [/orange/, "#cd6a2c"],
  [/gold|yellow/, "#d7a233"],
  [/tan|khaki|sand|stone/, "#c3a97e"],
  [/brown|chocolate/, "#6b4f3b"],
  [/purple/, "#5a3f7d"],
  [/pink/, "#d68fa7"]
];
const DEFAULT_GARMENT_FILL = "#a7b0ba";
const QUICK_COLORS = ["Navy", "Black", "Charcoal", "Red", "Royal", "Forest Green", "Athletic Grey", "White"];

function garmentFillFor(colorsText) {
  const text = String(colorsText || "").toLowerCase();
  for (const [pattern, fill] of COLOR_SWATCHES) {
    if (pattern.test(text)) return fill;
  }
  return DEFAULT_GARMENT_FILL;
}

/* Artwork size default per spot, straight from the tier table: chest and
   sleeves take Small, cap decoration takes Standard, backs take the full-back
   tier. The customer can always override. */
function defaultTierFor(placement) {
  const text = String(placement || "").toLowerCase();
  if (text.includes("back")) return "Large / Full Back";
  if (text.includes("center") || text === "side") return "Standard";
  return "Small";
}

/* ── Category cards ──────────────────────────────────────────────────────── */

let variantCounter = 0;

function segmentedHtml(groupName, options, selected, extraClass = "") {
  return (
    `<div class="segmented ${extraClass}" role="radiogroup">` +
    options
      .map((option) => {
        const value = typeof option === "string" ? option : option.value;
        const hint = typeof option === "string" ? "" : option.hint;
        return (
          `<label class="seg-option"><input type="radio" name="${esc(groupName)}" value="${esc(value)}"${value === selected ? " checked" : ""}>` +
          `<span>${esc(value)}${hint ? `<small>${esc(hint)}</small>` : ""}</span></label>`
        );
      })
      .join("") +
    "</div>"
  );
}

function decoConfigHtml(category, placement, variantId) {
  const isBack = BACK_PLACEMENTS.has(placement);
  const tier = defaultTierFor(placement);
  return (
    `<div class="deco-config" data-placement="${esc(placement)}" hidden>` +
    `<header class="deco-config-head"><span class="dch-name">${esc(placement)}</span>` +
    (isBack ? '<span class="face-badge">back view</span>' : "") +
    "</header>" +
    '<div class="deco-config-grid">' +
    '<div class="field"><span class="field-label">Artwork for this spot</span>' +
    `<div class="logo-pick" data-logo-pick data-selected="[]"></div>` +
    '<small class="hint">Nothing selected = every uploaded logo is offered here and buyers pick theirs at checkout. Pick one to lock it in.</small></div>' +
    `<div class="field"><span class="field-label">Artwork size</span>` +
    segmentedHtml(`tier-${variantId}-${placement.replace(/[^a-z0-9]+/gi, "-")}`, TIERS, tier, "seg-tiers") +
    `<input class="custom-tier-input" name="customSizeTier" placeholder="Describe the size — e.g. 3.5″ sleeve patch" hidden></div>` +
    "</div></div>"
  );
}

function variantHtml(category, index) {
  variantCounter += 1;
  const id = "v" + variantCounter;

  const decoration = category.decorated
    ? '<div class="vgroup" data-decoration>' +
      '<p class="vgroup-label">Decoration</p>' +
      '<div class="field"><span class="field-label">Method <em class="req">Required</em></span>' +
      segmentedHtml(`method-${id}`, METHODS, "", "seg-methods") +
      '<small class="hint seg-none-hint" hidden>This version ships blank — no artwork will be placed.</small></div>' +
      '<div class="deco-zone">' +
      '<div class="field"><span class="field-label">Where does the artwork go? <em class="req">Required</em></span>' +
      '<small class="hint">Pick every spot. A crest on the chest and the full mark across the back is two spots on one garment.</small>' +
      '<div class="pl-cards" role="group" aria-label="Artwork placements">' +
      category.placements
        .map((placement) => {
          const isBack = BACK_PLACEMENTS.has(placement);
          return (
            `<label class="pl-card"><input type="checkbox" name="plPick" value="${esc(placement)}">` +
            `<span class="pl-art">${placementArt(category.key, placement)}</span>` +
            `<span class="pl-name">${esc(placement)}</span>` +
            (isBack ? '<span class="pl-face">back</span>' : "") +
            "</label>"
          );
        })
        .join("") +
      "</div>" +
      '<p class="field-error placement-error" hidden></p></div>' +
      '<div class="deco-configs">' +
      category.placements.map((placement) => decoConfigHtml(category, placement, id)).join("") +
      "</div></div>" +
      '<label class="field toggle-field"><input type="checkbox" name="nameRank"> <span>Add name / rank personalization on the right chest</span></label>' +
      "</div>"
    : "";

  return (
    `<fieldset class="variant-block" data-variant-id="${id}">` +
    '<div class="variant-head">' +
    `<span class="variant-title">Version ${index + 1}</span>` +
    '<span class="variant-swatch" aria-hidden="true"></span>' +
    `<button type="button" class="variant-remove" data-remove-variant aria-label="Remove version ${index + 1}"${index === 0 ? " hidden" : ""}>&times;</button>` +
    "</div>" +
    '<div class="vgroup"><p class="vgroup-label">Garment</p><div class="customer-grid two">' +
    '<label class="field">Vendor / brand<input name="vendor" list="fnVendors" placeholder="Jiffy, SanMar, Next Level…">' +
    "<small class=\"hint\">Name one and our sourcing agent pulls the exact product photo from their catalog. Not sure? Leave it blank — we'll source the best match.</small></label>" +
    '<label class="field">Style number<input name="styleNumber" placeholder="NL3600, CTK121, 112…"></label>' +
    '<label class="field">Color(s) <em class="req">Required</em><input name="colors" placeholder="Navy, black, heather grey…">' +
    '<span class="quick-colors" aria-label="Common colors">' +
    QUICK_COLORS.map((color) => `<button type="button" class="qc-chip" data-quick-color="${esc(color)}" title="${esc(color)}"><span style="background:${garmentFillFor(color)}"></span>${esc(color)}</button>`).join("") +
    "</span></label>" +
    '<label class="field">Other style notes<input name="style" placeholder="Anything else about the cut or style"></label>' +
    "</div></div>" +
    decoration +
    '<div class="vgroup"><p class="vgroup-label">Sizes</p>' +
    '<div class="field"><span class="field-label">Size range <em class="req">Required</em></span>' +
    segmentedHtml(`sizes-${id}`, SIZES, "", "seg-sizes") +
    '<input class="other-sizes-input" name="otherSizes" placeholder="Comma-separated sizes — e.g. 4XL, 5XL, OSFA" hidden></div></div>' +
    '<label class="field">Version notes<input name="notes" placeholder="Optional details for this version"></label>' +
    "</fieldset>"
  );
}

function categoryHtml(category, index) {
  const art = GARMENT_ART[category.key] ? GARMENT_ART[category.key]() : "";
  const hint = category.belt
    ? "Short form — tell us the belt style."
    : category.decorated
      ? "Vendor, colors, artwork spots, and sizes open when selected."
      : "Short form — vendor, colors, and sizes.";

  const fields = category.belt
    ? '<label class="field">Belt style <em class="req">Required</em><input name="beltStyle" placeholder="Basket weave leather, flat leather, or a style number"></label>' +
      '<label class="field">Category notes<input name="categoryNotes" placeholder="Optional details"></label>'
    : '<div class="variant-list"></div>' +
      '<div class="variant-actions"><button type="button" class="btn btn-ghost btn-sm" data-add-variant>+ Add another version <span class="muted-inline">different color, vendor, or artwork</span></button></div>' +
      '<label class="field">Category notes<input name="categoryNotes" placeholder="Optional details that apply to every version"></label>';

  return (
    `<article class="customer-category" data-category="${esc(category.key)}" data-on="false" style="--float-delay:${index * 0.45}s">` +
    '<div class="garment-pane">' +
    `<div class="garment-scene" style="--g-fill:${DEFAULT_GARMENT_FILL}">` +
    `<div class="garment-float">${art}</div>` +
    '<div class="garment-shadow" aria-hidden="true"></div>' +
    "</div>" +
    `<p class="garment-caption">${category.belt ? "&nbsp;" : "Recolors as you type a color"}</p>` +
    "</div>" +
    '<div class="category-main">' +
    `<header><label class="toggle-line"><input type="checkbox" name="include"> <span>${esc(category.title)}</span></label>` +
    `<small>${hint}</small></header>` +
    `<div class="category-fields" hidden>${fields}</div>` +
    "</div></article>"
  );
}

function renderCategories() {
  $("#customerCategories").innerHTML =
    '<datalist id="fnVendors">' +
    VENDORS.map((vendor) => `<option value="${esc(vendor)}">`).join("") +
    "</datalist>" +
    CATEGORIES.map(categoryHtml).join("");
  // Every non-belt category starts with one version ready to fill.
  $$(".customer-category").forEach((card) => {
    const definition = CATEGORIES.find((item) => item.key === card.dataset.category) || {};
    if (!definition.belt) addVariant(card, definition);
  });
}

function addVariant(card, definition) {
  const list = $(".variant-list", card);
  if (!list) return null;
  const count = $$(".variant-block", list).length;
  if (count >= MAX_VARIANTS_PER_CATEGORY) return null;
  list.insertAdjacentHTML("beforeend", variantHtml(definition, count));
  const block = list.lastElementChild;
  renderLogoPicker(block);
  refreshVariantChrome(card);
  return block;
}

function refreshVariantChrome(card) {
  const blocks = $$(".variant-block", card);
  blocks.forEach((block, index) => {
    $(".variant-title", block).textContent = "Version " + (index + 1);
    const remove = $(".variant-remove", block);
    remove.hidden = blocks.length === 1;
    remove.setAttribute("aria-label", "Remove version " + (index + 1));
  });
  const add = $("[data-add-variant]", card);
  if (add) add.hidden = blocks.length >= MAX_VARIANTS_PER_CATEGORY;
  updateGarmentTint(card);
}

function updateCategoryState(card) {
  const active = $('[name="include"]', card).checked;
  $(".category-fields", card).hidden = !active;
  card.dataset.on = String(active);
}

/* The scene wears version 1's color; each variant head gets its own swatch so
   a multi-version category still shows every colorway at a glance. */
function updateGarmentTint(card) {
  const blocks = $$(".variant-block", card);
  const first = blocks[0] ? $('[name="colors"]', blocks[0])?.value : "";
  const scene = $(".garment-scene", card);
  if (scene) scene.style.setProperty("--g-fill", garmentFillFor(first));
  blocks.forEach((block) => {
    const swatch = $(".variant-swatch", block);
    const colors = $('[name="colors"]', block)?.value || "";
    if (swatch) {
      swatch.style.background = garmentFillFor(colors);
      swatch.dataset.on = String(Boolean(colors.trim()));
    }
  });
}

/* Show/hide the per-placement config blocks to match the checked placement
   cards, and keep the None-method state coherent. */
function refreshDecorationState(block) {
  const zone = $(".deco-zone", block);
  if (!zone) return;
  const method = $$('.seg-methods input[type="radio"]', block).find((input) => input.checked)?.value || "";
  const shipsBlank = method === "None";
  zone.hidden = shipsBlank;
  const noneHint = $(".seg-none-hint", block);
  if (noneHint) noneHint.hidden = !shipsBlank;

  const checked = new Set($$('.pl-cards input:checked', block).map((input) => input.value));
  $$(".deco-config", block).forEach((config) => {
    config.hidden = shipsBlank || !checked.has(config.dataset.placement);
  });
  // Following the instruction clears the error; it must not keep scolding.
  if (checked.size || shipsBlank) {
    const error = $(".placement-error", block);
    if (error) {
      error.hidden = true;
      error.textContent = "";
    }
  }
}

function refreshTierState(config) {
  const tier = $$('.seg-tiers input[type="radio"]', config).find((input) => input.checked)?.value || "";
  const custom = $(".custom-tier-input", config);
  if (custom) custom.hidden = tier !== "Custom";
}

function refreshSizeState(block) {
  const range = $$('.seg-sizes input[type="radio"]', block).find((input) => input.checked)?.value || "";
  const other = $(".other-sizes-input", block);
  if (other) other.hidden = range !== "Other";
}

/* ── Logo picker ─────────────────────────────────────────────────────────────
   Uploaded artwork from Step 2 rendered as selectable thumbnails inside every
   decoration config. Selections survive re-renders (files added or removed on
   Step 2, drafts restored before files exist) via data-selected on the picker:
   the chosen file NAMES are what the server matches logos by. */

const logoPreviewUrls = new Map();

function logoPreviewUrl(file) {
  const key = file.name + ":" + file.size;
  if (!logoPreviewUrls.has(key) && file.type.startsWith("image/")) {
    logoPreviewUrls.set(key, URL.createObjectURL(file));
  }
  return logoPreviewUrls.get(key) || "";
}

function releaseLogoPreview(file) {
  const key = file.name + ":" + file.size;
  const url = logoPreviewUrls.get(key);
  if (url) {
    URL.revokeObjectURL(url);
    logoPreviewUrls.delete(key);
  }
}

function pickerSelection(picker) {
  try {
    const stored = JSON.parse(picker.dataset.selected || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function renderLogoPicker(scope) {
  const files = [...logoBag.files];
  $$("[data-logo-pick]", scope).forEach((picker) => {
    const selected = new Set([
      ...pickerSelection(picker),
      ...$$("input:checked", picker).map((input) => input.value)
    ]);
    picker.dataset.selected = JSON.stringify([...selected]);
    if (!files.length) {
      picker.innerHTML = '<span class="logo-pick-empty">Upload artwork in Step 2 to assign specific logos.</span>';
      return;
    }
    picker.innerHTML = files
      .map((file) => {
        const url = logoPreviewUrl(file);
        const thumb = url
          ? `<img src="${esc(url)}" alt="">`
          : `<span class="logo-chip-doc" aria-hidden="true">${esc((file.name.split(".").pop() || "file").toUpperCase().slice(0, 4))}</span>`;
        const checked = selected.has(file.name) ? " checked" : "";
        return (
          `<label class="logo-chip"><input type="checkbox" name="logoPick" value="${esc(file.name)}"${checked}>` +
          `${thumb}<span class="logo-chip-name">${esc(file.name)}</span></label>`
        );
      })
      .join("");
  });
}

function rememberPickerSelection(picker) {
  picker.dataset.selected = JSON.stringify($$("input:checked", picker).map((input) => input.value));
}

/* ── Reading the form ────────────────────────────────────────────────────── */

function readDecorations(block) {
  const zone = $(".deco-zone", block);
  if (!zone || zone.hidden) return [];
  const checked = $$('.pl-cards input:checked', block).map((input) => input.value);
  return checked
    .map((placement) => {
      const config = $$(".deco-config", block).find((node) => node.dataset.placement === placement);
      if (!config) return null;
      const tier = $$('.seg-tiers input[type="radio"]', config).find((input) => input.checked)?.value || "";
      const picker = $("[data-logo-pick]", config);
      const renderedChips = picker ? $$("input", picker) : [];
      // Until the customer re-uploads artwork (files never survive a reload),
      // a restored draft's logo picks live only in data-selected on the
      // picker - reading just the checkboxes here would wipe them on the
      // first autosave.
      const logoSlugs = renderedChips.length
        ? renderedChips.filter((input) => input.checked).map((input) => input.value)
        : picker
          ? pickerSelection(picker)
          : [];
      return {
        placement,
        sizeTier: tier,
        customSizeTier: tier === "Custom" ? ($(".custom-tier-input", config)?.value.trim() ?? "") : "",
        logoSlugs
      };
    })
    .filter(Boolean);
}

function readVariant(block) {
  const read = (name) => $(`[name="${name}"]`, block)?.value.trim() ?? "";
  const method = $$('.seg-methods input[type="radio"]', block).find((input) => input.checked)?.value || "";
  const sizeRange = $$('.seg-sizes input[type="radio"]', block).find((input) => input.checked)?.value || "";
  const decorations = readDecorations(block);
  const first = decorations[0] || {};
  return {
    id: block.dataset.variantId || "",
    vendor: read("vendor"),
    styleNumber: read("styleNumber"),
    colors: read("colors"),
    style: read("style"),
    decorationMethod: method,
    decorations,
    // Flat mirrors of decoration 1, matching the server's normalization, so
    // legacy consumers of the record keep working.
    sizeTier: first.sizeTier || "",
    customSizeTier: first.customSizeTier || "",
    placement: first.placement || "",
    logoSlugs: first.logoSlugs || [],
    nameRank: $('[name="nameRank"]', block)?.checked ? "yes" : "",
    sizeRange,
    // A hidden Other-sizes input keeps its value when the customer switches
    // back to a preset range; submitting that stale text would override the
    // preset in the build.
    otherSizes: sizeRange === "Other" ? read("otherSizes") : "",
    notes: read("notes")
  };
}

function selectedCategories() {
  return $$(".customer-category").map((card) => {
    const definition = CATEGORIES.find((item) => item.key === card.dataset.category) || {};
    const value = {
      key: card.dataset.category,
      title: definition.title || card.dataset.category,
      include: $('[name="include"]', card)?.checked || false,
      notes: $('[name="categoryNotes"]', card)?.value.trim() || ""
    };
    if (definition.belt) value.beltStyle = $('[name="beltStyle"]', card)?.value.trim() || "";
    else value.variants = $$(".variant-block", card).map(readVariant);
    return value;
  });
}

function includedCategories() {
  return selectedCategories().filter((category) => category.include);
}

function updateCategoryCount() {
  const included = includedCategories();
  const versions = included.reduce((sum, category) => sum + (category.variants?.length || 1), 0);
  $("#categoryCount").textContent =
    included.length === 0 ? "0 selected" : `${included.length} selected · ${versions} garment${versions === 1 ? "" : "s"}`;
}

/* ── Logo files ──────────────────────────────────────────────────────────── */

// A DataTransfer is the only way to keep an accumulating file list on an
// <input type=file>: assigning .files replaces, so we rebuild it each time.
const logoBag = new DataTransfer();

const RASTER_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;

function isRasterFile(file) {
  return file.type.startsWith("image/") || RASTER_EXTENSIONS.test(file.name);
}

function syncLogoInput() {
  $("#customerLogos").files = logoBag.files;
  renderLogoList();
  renderLogoPicker(document);
}

function setLogoError(message) {
  const error = $("#logoError");
  error.hidden = !message;
  error.textContent = message || "";
}

function addLogoFiles(files) {
  // The server matches artwork to garments by exact file NAME, so a second
  // file with the same name would be unaddressable. Refuse it with a reason
  // instead of silently keeping whichever loaded first.
  const existingNames = new Set([...logoBag.files].map((file) => file.name));
  const duplicates = [];
  for (const file of files) {
    if (logoBag.files.length >= 20) break;
    if (existingNames.has(file.name)) {
      duplicates.push(file.name);
      continue;
    }
    existingNames.add(file.name);
    logoBag.items.add(file);
  }
  syncLogoInput();
  if (duplicates.length) {
    setLogoError(
      `Already in the list: ${duplicates.join(", ")}. Rename the file first if it's different artwork.`
    );
  } else if (logoBag.files.length) {
    // The "upload at least one logo" error is an instruction; once followed
    // it must not keep scolding.
    setLogoError("");
  }
}

function renderLogoList() {
  const files = [...logoBag.files];
  $("#logoDrop").dataset.hasFiles = String(files.length > 0);
  $("#logoCount").textContent = `${files.length} file${files.length === 1 ? "" : "s"}`;
  $("#rasterWarning").hidden = !files.length || files.some(isRasterFile);
  $("#customerLogoList").innerHTML = files
    .map((file, index) => {
      const url = logoPreviewUrl(file);
      const extension = (file.name.split(".").pop() || "file").toUpperCase().slice(0, 4);
      const thumb = url
        ? `<img src="${esc(url)}" alt="">`
        : `<span class="art-doc" aria-hidden="true">${esc(extension)}</span>`;
      const kind = isRasterFile(file) ? "" : '<span class="art-badge">vector / print</span>';
      return (
        `<figure class="art-card">` +
        `<div class="art-thumb">${thumb}</div>` +
        `<figcaption><span class="art-name">${esc(file.name)}</span>` +
        `<span class="art-meta">${esc(extension)} · ${Math.max(1, Math.ceil(file.size / 1024))} KB</span>${kind}</figcaption>` +
        `<button type="button" class="file-remove" data-remove="${index}" aria-label="Remove ${esc(file.name)}">&times;</button>` +
        "</figure>"
      );
    })
    .join("");
}

/* ── Draft autosave ──────────────────────────────────────────────────────── */

function storeFields() {
  const data = new FormData($("#customerIntakeForm"));
  return {
    departmentName: data.get("departmentName"),
    departmentCode: String(data.get("departmentCode") || "").toUpperCase(),
    contactName: data.get("contactName"),
    contactEmail: data.get("contactEmail"),
    contactPhone: data.get("contactPhone"),
    neededBy: data.get("neededBy"),
    notes: data.get("storeNotes")
  };
}

let saveTimer = null;
function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ store: storeFields(), categories: selectedCategories() }));
      const note = $("#saveNote");
      note.textContent = "Draft saved";
      note.dataset.on = "true";
      setTimeout(() => {
        note.dataset.on = "false";
      }, 1800);
    } catch {
      /* storage unavailable — the form still works, it just won't survive a reload */
    }
  }, 400);
}

function checkRadio(scope, selector, value) {
  const input = $$(selector + ' input[type="radio"]', scope).find((node) => node.value === value);
  if (input) input.checked = true;
  return Boolean(input);
}

function fillVariantBlock(block, saved) {
  for (const name of ["vendor", "styleNumber", "colors", "style", "notes"]) {
    const input = $(`[name="${name}"]`, block);
    if (input && saved[name]) input.value = saved[name];
  }
  if (saved.decorationMethod) checkRadio(block, ".seg-methods", saved.decorationMethod);
  if (saved.sizeRange) {
    checkRadio(block, ".seg-sizes", saved.sizeRange);
    const other = $(".other-sizes-input", block);
    if (other && saved.otherSizes) other.value = saved.otherSizes;
  }
  const nameRank = $('[name="nameRank"]', block);
  if (nameRank) nameRank.checked = saved.nameRank === "yes";

  // Decorations: pre-decoration drafts stored one flat placement set; treat
  // it as decoration 1 so nothing a customer picked is lost.
  const decorations = Array.isArray(saved.decorations) && saved.decorations.length
    ? saved.decorations
    : saved.placement
      ? [{ placement: saved.placement, sizeTier: saved.sizeTier, customSizeTier: saved.customSizeTier, logoSlugs: saved.logoSlugs }]
      : [];
  for (const decoration of decorations) {
    const cardInput = $$('.pl-cards input[type="checkbox"]', block).find((input) => input.value === decoration.placement);
    if (cardInput) cardInput.checked = true;
    const config = $$(".deco-config", block).find((node) => node.dataset.placement === decoration.placement);
    if (!config) continue;
    if (decoration.sizeTier) checkRadio(config, ".seg-tiers", decoration.sizeTier);
    const custom = $(".custom-tier-input", config);
    if (custom && decoration.customSizeTier) custom.value = decoration.customSizeTier;
    const picker = $("[data-logo-pick]", config);
    // Files never survive a reload, so the saved names wait on the picker
    // until the customer re-uploads on Step 2 - then the matching chips come
    // back checked automatically.
    if (picker && Array.isArray(decoration.logoSlugs)) picker.dataset.selected = JSON.stringify(decoration.logoSlugs);
    refreshTierState(config);
  }
  refreshDecorationState(block);
  refreshSizeState(block);
}

function restoreDraft() {
  let draft;
  try {
    draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
  } catch {
    return;
  }
  if (!draft) return;

  for (const [name, value] of Object.entries(draft.store || {})) {
    const domName = name === "notes" ? "storeNotes" : name;
    const input = $(`[name="${domName}"]`, $("#customerIntakeForm"));
    if (input && value) input.value = value;
  }
  for (const saved of draft.categories || []) {
    const card = $(`.customer-category[data-category="${saved.key}"]`);
    if (!card) continue;
    const definition = CATEGORIES.find((item) => item.key === saved.key) || {};
    $('[name="include"]', card).checked = Boolean(saved.include);
    const categoryNotes = $('[name="categoryNotes"]', card);
    if (categoryNotes && saved.notes) categoryNotes.value = saved.notes;

    if (definition.belt) {
      const beltStyle = $('[name="beltStyle"]', card);
      if (beltStyle && saved.beltStyle) beltStyle.value = saved.beltStyle;
    } else {
      // Old drafts stored flat category fields; treat them as version 1 -
      // minus notes (already restored into the category-notes input above)
      // and with any free-text logo instruction folded into version notes.
      const savedVariants = Array.isArray(saved.variants) && saved.variants.length
        ? saved.variants
        : [{ ...saved, notes: saved.logoNotes ? "Logo: " + saved.logoNotes : "" }];
      savedVariants.forEach((savedVariant, index) => {
        const block = $$(".variant-block", card)[index] || addVariant(card, definition);
        if (block) fillVariantBlock(block, savedVariant);
      });
    }
    updateCategoryState(card);
    refreshVariantChrome(card);
  }
  renderLogoPicker(document);
  updateCategoryCount();
}

/* ── Wizard ──────────────────────────────────────────────────────────────── */

let currentStep = 1;
let furthestStep = 1;
const TOTAL_STEPS = 4;

function showStep(step) {
  currentStep = step;
  furthestStep = Math.max(furthestStep, step);
  $$(".wizard-step").forEach((section) => {
    section.hidden = Number(section.dataset.step) !== step;
  });
  $$("#wizardRail li").forEach((item) => {
    const value = Number(item.dataset.step);
    item.dataset.state = value === step ? "current" : value < step ? "done" : "todo";
    $("button", item).disabled = value > furthestStep;
  });
  if (step === 3) renderLogoPicker(document);
  if (step === TOTAL_STEPS) renderReview();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function markInvalid(input, message) {
  input.setAttribute("aria-invalid", "true");
  const field = input.closest(".field");
  if (field && !$(".field-error", field)) {
    const node = document.createElement("small");
    node.className = "field-error";
    node.textContent = message;
    field.appendChild(node);
  }
}

function clearInvalid(scope) {
  $$("[aria-invalid]", scope).forEach((input) => input.removeAttribute("aria-invalid"));
  // Placement errors are PERMANENT nodes that toggle hidden — removing them
  // with the appended one-off errors would leave nowhere to show the message.
  $$(".field .field-error:not(.placement-error)", scope).forEach((node) => node.remove());
  $$(".placement-error", scope).forEach((node) => {
    node.hidden = true;
    node.textContent = "";
  });
}

/* Validation stays a strict SUPERSET of the server's required-field rules
   (customerIntakes.recordWithComputedFields): anything that passes here must
   never 400 at submit. */
function validateStep(step) {
  const section = $(`.wizard-step[data-step="${step}"]`);
  clearInvalid(section);
  let firstBad = null;

  if (step === 1) {
    for (const input of $$("input[required]", section)) {
      if (!input.value.trim()) {
        markInvalid(input, "This field is required.");
        firstBad = firstBad || input;
      } else if (input.type === "email" && !input.checkValidity()) {
        markInvalid(input, "Enter a valid email address.");
        firstBad = firstBad || input;
      }
    }
  }

  if (step === 2) {
    const ok = logoBag.files.length > 0;
    setLogoError(ok ? "" : "Upload at least one logo file so we can decorate your garments.");
    if (!ok) firstBad = $("#logoDrop");
  }

  if (step === 3) {
    const included = includedCategories();
    const error = $("#categoryError");
    if (!included.length) {
      error.hidden = false;
      error.textContent = "Select at least one garment category for the store.";
      firstBad = $("#customerCategories");
    } else {
      error.hidden = true;
      for (const category of included) {
        const definition = CATEGORIES.find((item) => item.key === category.key) || {};
        const card = $(`.customer-category[data-category="${category.key}"]`);
        if (definition.belt) {
          const input = $('[name="beltStyle"]', card);
          if (input && !input.value.trim()) {
            markInvalid(input, `Required for ${definition.title}.`);
            firstBad = firstBad || input;
          }
          continue;
        }
        $$(".variant-block", card).forEach((block, index) => {
          const versionLabel = `${definition.title} version ${index + 1}`;
          const colors = $('[name="colors"]', block);
          if (colors && !colors.value.trim()) {
            markInvalid(colors, `Required for ${versionLabel}.`);
            firstBad = firstBad || colors;
          }
          const sizeChecked = $$('.seg-sizes input[type="radio"]', block).some((input) => input.checked);
          if (!sizeChecked) {
            const field = $(".seg-sizes", block)?.closest(".field");
            if (field && !$(".field-error", field)) {
              const node = document.createElement("small");
              node.className = "field-error";
              node.textContent = `Pick a size range for ${versionLabel}.`;
              field.appendChild(node);
            }
            firstBad = firstBad || $(".seg-sizes", block);
          }
          if (definition.decorated) {
            const method = $$('.seg-methods input[type="radio"]', block).find((input) => input.checked)?.value || "";
            if (!method) {
              const field = $(".seg-methods", block)?.closest(".field");
              if (field && !$(".field-error", field)) {
                const node = document.createElement("small");
                node.className = "field-error";
                node.textContent = `Pick a decoration method for ${versionLabel}.`;
                field.appendChild(node);
              }
              firstBad = firstBad || $(".seg-methods", block);
            } else if (method !== "None" && definition.placements?.length) {
              const anyPlacement = $$('.pl-cards input:checked', block).length > 0;
              if (!anyPlacement) {
                const placementError = $(".placement-error", block);
                if (placementError) {
                  placementError.hidden = false;
                  placementError.textContent = `Pick at least one artwork spot for ${versionLabel} — or set the method to "None" for a blank garment.`;
                }
                firstBad = firstBad || $(".pl-cards", block);
              }
            }
          }
        });
      }
    }
  }

  if (firstBad) {
    firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
    if (firstBad.focus) firstBad.focus({ preventScroll: true });
    return false;
  }
  return true;
}

/* ── Review ──────────────────────────────────────────────────────────────── */

function reviewRow(label, value) {
  return `<div class="rr"><span>${esc(label)}</span><b>${value ? esc(value) : '<i class="rr-empty">Not provided</i>'}</b></div>`;
}

function decorationSummary(decoration) {
  const logos = decoration.logoSlugs?.length ? decoration.logoSlugs.join(", ") : "all logos — buyers choose";
  const tier = decoration.sizeTier === "Custom" ? decoration.customSizeTier || "Custom" : decoration.sizeTier;
  return `${decoration.placement}${tier ? ` · ${tier}` : ""} · ${logos}`;
}

function variantSummaryHtml(category, variant, index, count) {
  const definition = CATEGORIES.find((item) => item.key === category.key) || {};
  const vendorBit = [variant.vendor, variant.styleNumber].filter(Boolean).join(" ");
  const headline = [vendorBit, variant.colors].filter(Boolean).join(" · ");
  const sizes = variant.sizeRange === "Other" ? variant.otherSizes : variant.sizeRange;
  const decorations = variant.decorationMethod === "None"
    ? ['<span class="rv-deco rv-deco-blank">Ships blank — no artwork</span>']
    : (variant.decorations || []).map((decoration) => `<span class="rv-deco">${esc(decorationSummary(decoration))}</span>`);
  return (
    `<div class="rv-variant">` +
    `<b>${esc(count > 1 ? `Version ${index + 1}` : definition.title)}</b>` +
    `<span>${esc(headline || "—")}${variant.decorationMethod && variant.decorationMethod !== "None" ? esc(` · ${variant.decorationMethod}`) : ""}${sizes ? esc(` · ${sizes}`) : ""}${variant.nameRank === "yes" ? " · name/rank" : ""}</span>` +
    (decorations.length ? `<span class="rv-decos">${decorations.join("")}</span>` : "") +
    "</div>"
  );
}

function renderReview() {
  const store = storeFields();
  const included = includedCategories();

  const categoryBlock = (category) => {
    const definition = CATEGORIES.find((item) => item.key === category.key) || {};
    const art = GARMENT_ART[category.key] ? GARMENT_ART[category.key]() : "";
    const firstColors = definition.belt ? "" : category.variants?.[0]?.colors || "";
    const body = definition.belt
      ? `<div class="rv-variant"><b>${esc(definition.title)}</b><span>${esc(category.beltStyle || "—")}</span></div>`
      : (category.variants || []).map((variant, index) => variantSummaryHtml(category, variant, index, category.variants.length)).join("");
    return (
      `<article class="rv-category">` +
      `<span class="rv-art" style="--g-fill:${garmentFillFor(firstColors)}">${art}</span>` +
      `<div class="rv-category-body"><h4>${esc(definition.title)}</h4>${body}</div>` +
      "</article>"
    );
  };

  $("#reviewPanel").innerHTML =
    '<div class="review-block"><h3>Department</h3>' +
    reviewRow("Name", store.departmentName) +
    reviewRow("Code", store.departmentCode) +
    reviewRow("Contact", [store.contactName, store.contactEmail].filter(Boolean).join(" · ")) +
    reviewRow("Phone", store.contactPhone) +
    reviewRow("Needed by", store.neededBy) +
    reviewRow("Notes", store.notes) +
    '<button type="button" class="btn btn-ghost btn-sm" data-goto="1">Edit</button></div>' +
    `<div class="review-block"><h3>Artwork · ${logoBag.files.length} file${logoBag.files.length === 1 ? "" : "s"}</h3>` +
    `<div class="chips">${[...logoBag.files].map((file) => `<span class="chip"><span class="chip-name">${esc(file.name)}</span></span>`).join("")}</div>` +
    '<button type="button" class="btn btn-ghost btn-sm" data-goto="2">Edit</button></div>' +
    `<div class="review-block review-block-wide"><h3>Garments · ${included.length}</h3>` +
    `<div class="rv-categories">${included.map(categoryBlock).join("")}</div>` +
    '<button type="button" class="btn btn-ghost btn-sm" data-goto="3">Edit</button></div>';
}

/* ── Submit ──────────────────────────────────────────────────────────────── */

function payloadFromForm() {
  const store = storeFields();
  return { store, customerNotes: store.notes, categories: selectedCategories() };
}

function setSubmitState(kind, message) {
  const panel = $("#customerSubmitPanel");
  panel.dataset.state = kind;
  let node = $("#customerResult");
  if (!node) {
    node = document.createElement("p");
    node.id = "customerResult";
    node.className = "customer-result";
    panel.appendChild(node);
  }
  node.textContent = message;
}

function renderSuccess(payload) {
  const building = payload.buildStarted
    ? "<p>Your store is <b>building right now</b> — our agent is sourcing each garment from your chosen vendors, placing your artwork to production spec, and assembling the products.</p>"
    : payload.collection
      ? `<p>Your store collection <b>${esc(payload.collection.title || payload.departmentName)}</b> has been created and is queued for build.</p>`
      : "<p>Our team will start your store build shortly.</p>";
  $("#main").innerHTML =
    '<section class="card card-pad intake-done">' +
    '<span class="done-mark" aria-hidden="true">' +
    '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>' +
    "<h1>Request received</h1>" +
    `<p>Thanks, ${esc(payload.contactName || "")}. Reference <b>${esc(String(payload.requestId || "").slice(0, 8).toUpperCase())}</b>.</p>` +
    building +
    `<p class='muted'>Nothing goes live without review: our team checks every product, image, price, and size before publishing. We'll email <b>${esc(payload.contactEmail || "you")}</b> when the store is ready to approve.</p>` +
    '<a class="btn btn-ghost" href="/intake">Submit another department</a></section>';
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── Wiring ──────────────────────────────────────────────────────────────── */

renderCategories();
restoreDraft();
showStep(1);

$("#logoDrop").addEventListener("click", () => $("#customerLogos").click());
$("#logoDrop").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    $("#customerLogos").click();
  }
});
$("#logoDrop").addEventListener("dragover", (event) => {
  event.preventDefault();
  $("#logoDrop").dataset.drag = "true";
});
$("#logoDrop").addEventListener("dragleave", () => {
  $("#logoDrop").dataset.drag = "false";
});
$("#logoDrop").addEventListener("drop", (event) => {
  event.preventDefault();
  $("#logoDrop").dataset.drag = "false";
  addLogoFiles(event.dataTransfer.files);
});
$("#customerLogos").addEventListener("change", (event) => {
  addLogoFiles(event.target.files);
});
$("#customerLogoList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  const index = Number(button.dataset.remove);
  const file = logoBag.files[index];
  if (file) releaseLogoPreview(file);
  logoBag.items.remove(index);
  syncLogoInput();
  saveDraft();
});

// Department code reads best uppercase everywhere it will be stamped.
document.addEventListener("input", (event) => {
  if (event.target.name === "departmentCode") {
    const start = event.target.selectionStart;
    event.target.value = event.target.value.toUpperCase();
    try {
      event.target.setSelectionRange(start, start);
    } catch {
      /* non-text selection state */
    }
  }
  if (event.target.name === "colors") {
    const card = event.target.closest(".customer-category");
    if (card) updateGarmentTint(card);
  }
  if (event.target.closest("#customerIntakeForm")) saveDraft();
});

document.addEventListener("change", (event) => {
  const card = event.target.closest(".customer-category");
  if (card) {
    if (event.target.name === "include") updateCategoryState(card);
    if (event.target.name === "logoPick") rememberPickerSelection(event.target.closest("[data-logo-pick]"));
    const block = event.target.closest(".variant-block");
    if (block) {
      if (event.target.name === "plPick" || event.target.closest(".seg-methods")) refreshDecorationState(block);
      if (event.target.closest(".seg-sizes")) refreshSizeState(block);
      const config = event.target.closest(".deco-config");
      if (config && event.target.closest(".seg-tiers")) refreshTierState(config);
    }
    updateGarmentTint(card);
    updateCategoryCount();
  }
  if (event.target.closest("#customerIntakeForm")) saveDraft();
});

document.addEventListener("click", (event) => {
  const quickColor = event.target.closest("[data-quick-color]");
  if (quickColor) {
    const input = $('[name="colors"]', quickColor.closest(".field"));
    if (input) {
      const current = input.value.trim();
      const color = quickColor.dataset.quickColor;
      if (!current.toLowerCase().includes(color.toLowerCase())) {
        input.value = current ? `${current}, ${color}` : color;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      input.focus();
    }
    return;
  }

  const next = event.target.closest("[data-next]");
  if (next && validateStep(currentStep)) showStep(Math.min(TOTAL_STEPS, currentStep + 1));

  const back = event.target.closest("[data-back]");
  if (back) showStep(Math.max(1, currentStep - 1));

  const goto = event.target.closest("[data-goto]");
  if (goto) showStep(Number(goto.dataset.goto));

  const rail = event.target.closest("#wizardRail button");
  if (rail) {
    const target = Number(rail.closest("li").dataset.step);
    if (target <= furthestStep) showStep(target);
  }

  const addVariantButton = event.target.closest("[data-add-variant]");
  if (addVariantButton) {
    const card = addVariantButton.closest(".customer-category");
    const definition = CATEGORIES.find((item) => item.key === card.dataset.category) || {};
    const block = addVariant(card, definition);
    if (block) {
      $('[name="vendor"]', block)?.focus();
      updateCategoryCount();
      saveDraft();
    }
  }

  const removeVariantButton = event.target.closest("[data-remove-variant]");
  if (removeVariantButton) {
    const card = removeVariantButton.closest(".customer-category");
    removeVariantButton.closest(".variant-block").remove();
    refreshVariantChrome(card);
    updateCategoryCount();
    // The focused button just left the DOM; without this, keyboard focus
    // falls to <body> and the customer re-tabs from the top of the page.
    $("[data-add-variant]", card)?.focus();
    saveDraft();
  }

  const zoom = event.target.closest("[data-zoom]");
  if (zoom) {
    lightboxOpener = zoom;
    $("#refLightboxImg").src = zoom.dataset.zoom;
    $("#refLightboxImg").alt = $("img", zoom)?.alt || "";
    $("#refLightbox").hidden = false;
    $("#refLightboxClose").focus();
  }

  if (event.target.closest("#refLightboxClose") || event.target.id === "refLightbox") {
    closeLightbox();
  }
});

let lightboxOpener = null;
function closeLightbox() {
  $("#refLightbox").hidden = true;
  // Hand keyboard focus back to the diagram that opened the overlay instead of
  // dropping it at the top of the document.
  if (lightboxOpener) {
    lightboxOpener.focus();
    lightboxOpener = null;
  }
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#refLightbox").hidden) closeLightbox();
});

$("#customerIntakeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  // Enter inside a text field fires an implicit submit. Before the review
  // step that gesture means "next", never "send the whole request to FN".
  if (currentStep !== TOTAL_STEPS) {
    if (validateStep(currentStep)) showStep(Math.min(TOTAL_STEPS, currentStep + 1));
    return;
  }
  for (let step = 1; step <= 3; step++) {
    if (!validateStep(step)) {
      // Focus and scrollIntoView are no-ops inside a hidden section, so show
      // the failing step first and validate again to land on the bad field.
      showStep(step);
      validateStep(step);
      return;
    }
  }

  const button = $("#customerSubmitButton");
  const body = new FormData();
  body.append("payload", JSON.stringify(payloadFromForm()));
  [...logoBag.files].forEach((file) => body.append("logos", file));

  button.disabled = true;
  button.textContent = "Submitting…";
  setSubmitState("running", "Sending your store package to FN…");

  try {
    const res = await fetch("/api/customer-intakes", { method: "POST", body });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Submission failed.");
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* nothing to clear */
    }
    const store = storeFields();
    renderSuccess({ ...payload, contactName: store.contactName, contactEmail: store.contactEmail });
  } catch (error) {
    setSubmitState("error", error.message);
    button.disabled = false;
    button.textContent = "Submit store request";
  }
});

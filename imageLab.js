/* -----------------------------------------------------------------------------
   Image lab — iterate on product images WITHOUT building stores.

   Runs the exact production image pipeline (productImages.renderFaceImage —
   the same function intakeBuild.js ships through) across a matrix of garment
   types, colors, placements, artwork sizes, and logo shapes, and drops the
   results in test-images/ with a contact-sheet index.html for review.

     node imageLab.js                 run every case
     node imageLab.js tee-navy-chest  run cases whose id contains a term
     node imageLab.js --list          list case ids
     node imageLab.js --report-only   rebuild index.html from report.json

   Base garment photos are generated once and cached in test-images/bases/
   (the charcoal hoodie uses Independent Trading Co.'s real photo), so
   iterating on placement/blending/rendering never re-pays for bases.
   -------------------------------------------------------------------------- */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { generateBlankGarment } = require("./ai");
const { resolvePlacement } = require("./mockup");
const { renderFaceImage } = require("./productImages");

const LAB = path.join(__dirname, "test-images");
const BASES = path.join(LAB, "bases");
const OUT = path.join(LAB, "out");
const REPORT = path.join(LAB, "report.json");
for (const dir of [LAB, BASES, OUT]) fs.mkdirSync(dir, { recursive: true });

/* ── Artwork ─────────────────────────────────────────────────────────────── */

const LOGO_DIR = path.join(__dirname, "test-run", "demo", "logos");
const LOGOS = {
  crest: { file: path.join(LOGO_DIR, "Oakdale FD Main.png"), name: "Oakdale FD Main.png", mime: "image/png" }, // round, small text
  pennant: { file: path.join(LOGO_DIR, "Rescue 3.png"), name: "Rescue 3.png", mime: "image/png" }, // tall shield
  round: { file: path.join(LOGO_DIR, "EMS Division.png"), name: "EMS Division.png", mime: "image/png" },
  engine: { file: path.join(__dirname, "test-run", "inputs", "Engine 1.jpg"), name: "Engine 1.jpg", mime: "image/jpeg" },
  banner: { file: path.join(BASES, "banner-logo.png"), name: "Oakdale Banner.png", mime: "image/png" } // generated: wide, long text
};

async function ensureBannerLogo() {
  if (fs.existsSync(LOGOS.banner.file)) return;
  // A deliberately WIDE, text-heavy mark — the shape that breaks naive sizing.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="360">
    <rect x="8" y="8" width="1584" height="344" rx="26" fill="#101828" stroke="#d7a233" stroke-width="14"/>
    <text x="800" y="150" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="118" font-weight="900" fill="#d7a233">OAKDALE FIRE DEPT.</text>
    <text x="800" y="278" text-anchor="middle" font-family="Arial, sans-serif" font-size="86" font-weight="700" fill="#ffffff">PRIDE · HONOR · SERVICE</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(LOGOS.banner.file);
}

function logo(key) {
  const entry = LOGOS[key];
  return { buffer: fs.readFileSync(entry.file), mimetype: entry.mime, originalName: entry.name };
}

/* ── Bases ───────────────────────────────────────────────────────────────── */

const REAL_BASES = {
  "hoodie-charcoal-front":
    "https://www.independenttradingco.com/cdn/shop/files/Independent_Trading_Co._SS4500_Charcoal_Front_High_4cefb99e-1111-4888-a6c2-ffd615be58f1.jpg?v=1745606888&width=2048"
};

const BASE_PROMPTS = {
  tee: "a short sleeve t-shirt laid flat",
  longsleeve: "a long sleeve shirt laid flat",
  hoodie: "a hooded sweatshirt laid flat",
  classb: "a class b uniform shirt with two chest pockets and epaulets laid flat",
  polo: "a collared polo shirt laid flat",
  jacket: "a jacket laid flat",
  sweatpants: "a pair of sweatpants laid flat",
  shorts: "a pair of uniform shorts laid flat",
  hat: "a structured baseball-style uniform hat photographed from the front"
};

async function getBase(type, color, face = "front") {
  const key = `${type}-${color.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${face}`;
  const file = path.join(BASES, `${key}.png`);
  if (fs.existsSync(file)) return fs.readFileSync(file);

  if (REAL_BASES[key]) {
    const res = await fetch(REAL_BASES[key], { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0" } });
    const raw = Buffer.from(await res.arrayBuffer());
    const png = await sharp(raw)
      .resize({ width: 1024, height: 1024, fit: "contain", background: "#ffffff" })
      .flatten({ background: "#ffffff" })
      .png()
      .toBuffer();
    fs.writeFileSync(file, png);
    console.log(`  base cached (supplier photo): ${key}`);
    return png;
  }

  console.log(`  generating base: ${key} …`);
  const buffer = await generateBlankGarment({
    productPrompt: BASE_PROMPTS[type] || `a ${type} laid flat`,
    garmentColor: color,
    brandStyle: "",
    spec: "",
    imageGuidance: "",
    face
  });
  fs.writeFileSync(file, buffer);
  return buffer;
}

/* ── Cases ───────────────────────────────────────────────────────────────── */

function keysFor(productType, label) {
  if (/both\s+sleeves/i.test(label)) {
    return [
      resolvePlacement({ productType, placement: "Left sleeve", productionNotes: "" }),
      resolvePlacement({ productType, placement: "Right sleeve", productionNotes: "" })
    ];
  }
  return [resolvePlacement({ productType, placement: label, productionNotes: "" })];
}

function deco(productType, label, tier, logoKey) {
  return { logo: logo(logoKey), label, keys: keysFor(productType, label), tier };
}

// Every case runs renderFaceImage exactly as the store build would.
const CASES = [
  // The reported failures, first
  { id: "longsleeve-green-sleeve-small", base: ["longsleeve", "Safety Green"], type: "long sleeve shirt", face: "front", method: "Screen Print", decos: [["Right sleeve", "small", "crest"]], expect: "crest ON the sleeve, ~4in, printed look" },
  { id: "classb-navy-bothsleeves-small", base: ["classb", "Navy"], type: "class b uniform shirt", face: "front", method: "Embroidery", decos: [["Both sleeves", "small", "pennant"]], expect: "patch on EACH upper sleeve, on fabric, not shoulder seam" },
  { id: "hoodie-charcoal-back-large-pennant", base: ["hoodie", "Charcoal"], type: "hoodie", face: "back", cross: true, method: "Screen Print", decos: [["Center back", "large", "pennant"]], expect: "back view, pennant 8-10in wide (~35-40% of width), NOT half the garment" },

  // Chest crests across garments and colors
  { id: "tee-navy-chest-small", base: ["tee", "Navy"], type: "shirt", face: "front", method: "Screen Print", decos: [["Front left chest", "small", "crest"]], expect: "4in crest, wearer's left chest" },
  { id: "polo-white-chest-small", base: ["polo", "White"], type: "polo", face: "front", method: "Embroidery", decos: [["Front left chest", "small", "round"]], expect: "light garment + light logo still reads" },
  { id: "jacket-black-chest-small", base: ["jacket", "Black"], type: "jacket", face: "front", method: "Embroidery", decos: [["Front left chest", "small", "crest"]], expect: "clear of zipper/pockets" },
  { id: "tee-heather-chest-custom35", base: ["tee", "Heather Grey"], type: "shirt", face: "front", method: "Heat Transfer", decos: [["Front left chest", "custom: 3.5 inch", "engine"]], expect: "custom 3.5in crest" },

  // Standard / large artwork — the model-render path
  { id: "tee-red-frontcenter-standard-banner", base: ["tee", "Red"], type: "shirt", face: "front", method: "Screen Print", decos: [["Center chest", "standard", "banner"]], expect: "wide banner ~6in, centered chest, long text legible" },
  { id: "tee-white-fullfront-large-banner", base: ["tee", "White"], type: "shirt", face: "front", method: "Screen Print", decos: [["Full front", "large", "banner"]], expect: "large full-front banner ~9in wide" },
  { id: "tee-navy-back-large-pennant", base: ["tee", "Navy"], type: "shirt", face: "back", cross: true, method: "Screen Print", decos: [["Center back", "large", "pennant"]], expect: "back view from front photo, 8-10in pennant" },
  { id: "longsleeve-green-back-large-banner", base: ["longsleeve", "Safety Green"], type: "long sleeve shirt", face: "back", cross: true, method: "Screen Print", decos: [["Center back", "large", "banner"]], expect: "wide banner across upper back" },
  { id: "hat-black-front-standard", base: ["hat", "Black"], type: "hat", face: "front", method: "Embroidery", decos: [["Front center", "standard", "crest"]], expect: "fills cap front panel, embroidered look" },

  // Legs, sides, multiples
  { id: "sweatpants-grey-leg-small", base: ["sweatpants", "Athletic Grey"], type: "sweatpants", face: "front", method: "Heat Transfer", decos: [["Left leg", "small", "pennant"]], expect: "outer thigh of wearer's left leg" },
  { id: "shorts-red-leg-small", base: ["shorts", "Red"], type: "shorts", face: "front", method: "Screen Print", decos: [["Right leg", "small", "engine"]], expect: "outer thigh, wearer's right" },
  { id: "hat-navy-side-small", base: ["hat", "Navy"], type: "hat", face: "front", method: "Embroidery", decos: [["Side", "small", "round"]], expect: "small mark on cap side panel" },
  { id: "hoodie-charcoal-front-multi", base: ["hoodie", "Charcoal"], type: "hoodie", face: "front", method: "Screen Print", decos: [["Front left chest", "small", "engine"], ["Left sleeve", "small", "round"]], expect: "chest + sleeve on one front, both correct" },
  { id: "sweatpants-grey-leg-custom7", base: ["sweatpants", "Athletic Grey"], type: "sweatpants", face: "front", method: "Screen Print", decos: [["Left leg", "custom: 7 inch vertical", "pennant"]], expect: "7in strip -> model render path on legwear" }
];

/* ── Runner ──────────────────────────────────────────────────────────────── */

async function runCase(item) {
  const started = Date.now();
  const [baseType, baseColor] = item.base;
  const front = await getBase(baseType, baseColor, "front");
  const decorations = item.decos.map(([label, tier, logoKey]) => deco(item.type, label, tier, logoKey));
  const logLines = [];
  const onLog = (message) => {
    logLines.push(message);
    console.log(`  [${item.id}] ${message}`);
  };

  const produced = await renderFaceImage({
    baseBuffer: front,
    sourceFace: "front",
    face: item.cross ? "back" : item.face || "front",
    decorations,
    method: item.method,
    getBackBlank: () => getBase(baseType, baseColor, "back"),
    onLog,
    cache: {}
  });

  const file = path.join(OUT, `${item.id}.png`);
  fs.writeFileSync(file, produced.buffer);
  return {
    id: item.id,
    expect: item.expect,
    path: produced.path,
    decos: item.decos.map(([label, tier, logoKey]) => `${label} · ${tier} · ${logoKey}`),
    method: item.method,
    seconds: Math.round((Date.now() - started) / 1000),
    log: logLines,
    ranAt: new Date().toISOString()
  };
}

function writeIndex(report) {
  const rows = Object.values(report)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (entry) => `
    <figure data-path="${entry.path}">
      <img src="out/${entry.id}.png" loading="lazy" alt="${entry.id}">
      <figcaption>
        <b>${entry.id}</b>
        <span class="path ${entry.path}">${entry.path}</span>
        <small>${entry.decos.join(" + ")} · ${entry.method} · ${entry.seconds}s</small>
        <small class="expect">${entry.expect}</small>
      </figcaption>
    </figure>`
    )
    .join("\n");
  fs.writeFileSync(
    path.join(LAB, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>FN Image Lab</title>
<style>
  body { margin: 24px; background: #f5f7fa; color: #0f1720; font: 14px/1.5 system-ui, sans-serif; }
  h1 { font-size: 20px; } p { color: #4d5a6a; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; margin-top: 16px; }
  figure { margin: 0; background: #fff; border: 1px solid #dce3ec; border-radius: 10px; overflow: hidden; }
  img { display: block; width: 100%; aspect-ratio: 1; object-fit: contain; background: #fff; }
  figcaption { display: grid; gap: 3px; padding: 10px 12px; border-top: 1px solid #dce3ec; }
  .path { justify-self: start; padding: 1px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .path.render { background: #e3f0e9; color: #0b7a54; }
  .path.composite { background: #e5edf8; color: #1f6fd0; }
  .path.render-fallback-composite { background: #f6ecd9; color: #9a6206; }
  small { color: #6b7887; } .expect { color: #4d5a6a; font-style: italic; }
</style>
<h1>FN Image Lab</h1>
<p>Every image below came out of the exact production pipeline (productImages.renderFaceImage). Green = verified model render, blue = measured composite, amber = render fell back to the composite.</p>
<div class="grid">${rows}</div>`
  );
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const item of CASES) console.log(item.id);
    return;
  }
  const report = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, "utf8")) : {};
  if (args.includes("--report-only")) {
    writeIndex(report);
    console.log("index.html rebuilt");
    return;
  }

  await ensureBannerLogo();
  const terms = args.filter((value) => !value.startsWith("--"));
  const selected = terms.length ? CASES.filter((item) => terms.some((term) => item.id.includes(term))) : CASES;
  console.log(`running ${selected.length} case${selected.length === 1 ? "" : "s"}\n`);

  for (const item of selected) {
    console.log(`== ${item.id}`);
    try {
      report[item.id] = await runCase(item);
      console.log(`   -> ${report[item.id].path} in ${report[item.id].seconds}s\n`);
    } catch (error) {
      console.error(`   FAILED: ${error.message}\n`);
      report[item.id] = { id: item.id, expect: item.expect, path: "error", decos: [], method: item.method, seconds: 0, log: [error.message], ranAt: new Date().toISOString() };
    }
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    writeIndex(report);
  }
  console.log(`done — open test-images/index.html`);
})();

/* -----------------------------------------------------------------------------
   Submit three test departments to the live intake endpoint.

   Deliberately spread across placements so one run exercises the whole image
   path: a chest crest, a full-back graphic, a LEFT sleeve print, a RIGHT sleeve
   print, and a cap front. The two sleeve cases are the point — they are the
   ones that turn side-on, and right-sleeve is the placement that historically
   landed on the wrong arm.

     node test/submit-test-stores.js            submit to production
     node test/submit-test-stores.js --dry      print the payloads, send nothing

   Every department is named "… (TEST)" so they are obvious in the queue and
   safe to delete.
   -------------------------------------------------------------------------- */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const BASE = process.env.FN_URL || "https://fn-platform.kindsky-0896b767.westus3.azurecontainerapps.io";
const ART = path.join(__dirname, "test-store-art");
const dry = process.argv.includes("--dry");

/* ── Artwork ─────────────────────────────────────────────────────────────── */

// Three different SHAPES, because shape is what breaks placement: a round
// crest, a wide banner, and a tall shield each behave differently on a sleeve.
const ARTWORK = {
  "brookfield-crest.png": `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900">
    <circle cx="450" cy="450" r="430" fill="#8c1c1c"/>
    <circle cx="450" cy="450" r="360" fill="#0f2a4a" stroke="#e0b13a" stroke-width="14"/>
    <path d="M450 200 L510 380 L700 380 L545 490 L605 670 L450 560 L295 670 L355 490 L200 380 L390 380 Z" fill="#e0b13a"/>
    <text x="450" y="150" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="76" font-weight="900" fill="#ffffff">BROOKFIELD</text>
    <text x="450" y="800" text-anchor="middle" font-family="Arial, sans-serif" font-size="66" font-weight="700" fill="#e0b13a">FIRE DISTRICT</text>
  </svg>`,

  "marina-bay-banner.png": `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="420">
    <rect x="10" y="10" width="1080" height="400" rx="28" fill="#08304a" stroke="#3fb7d6" stroke-width="12"/>
    <text x="550" y="180" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="118" font-weight="900" fill="#3fb7d6">MARINA BAY</text>
    <text x="550" y="310" text-anchor="middle" font-family="Arial, sans-serif" font-size="86" font-weight="700" fill="#ffffff">FIRE &amp; RESCUE</text>
  </svg>`,

  "cedar-ridge-shield.png": `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="1000">
    <path d="M350 30 L660 150 L660 560 Q660 830 350 970 Q40 830 40 560 L40 150 Z" fill="#1c4023" stroke="#d9a441" stroke-width="16"/>
    <text x="350" y="270" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="96" font-weight="900" fill="#d9a441">CEDAR</text>
    <text x="350" y="380" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="96" font-weight="900" fill="#d9a441">RIDGE</text>
    <path d="M350 450 L392 570 L520 570 L416 646 L456 768 L350 692 L244 768 L284 646 L180 570 L308 570 Z" fill="#ffffff"/>
    <text x="350" y="880" text-anchor="middle" font-family="Arial, sans-serif" font-size="62" font-weight="700" fill="#ffffff">FIRE DEPT</text>
  </svg>`
};

async function buildArtwork() {
  fs.mkdirSync(ART, { recursive: true });
  const made = [];
  for (const [name, svg] of Object.entries(ARTWORK)) {
    const file = path.join(ART, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, await sharp(Buffer.from(svg)).png().toBuffer());
    made.push({ name, file });
  }
  return made;
}

/* ── Departments ─────────────────────────────────────────────────────────── */

const variant = (vendor, styleNumber, colors, method, decorations) => ({
  vendor,
  styleNumber,
  colors,
  style: "",
  decorationMethod: method,
  sizeRange: "S-3XL",
  decorations,
  // Flat mirrors of decoration 1, matching the server's normalisation.
  placement: decorations[0].placement,
  sizeTier: decorations[0].sizeTier,
  customSizeTier: "",
  logoSlugs: decorations[0].logoSlugs
});

const deco = (placement, sizeTier, logoSlugs) => ({ placement, sizeTier, customSizeTier: "", logoSlugs });

const STORES = [
  {
    logo: "brookfield-crest.png",
    store: {
      departmentName: "Brookfield Fire District (TEST)",
      departmentCode: "BFDT",
      contactName: "Dana Whitfield",
      contactEmail: "zaz@tryzol.com",
      contactPhone: "555-0142",
      neededBy: "",
      notes: "Internal test store — chest crest and full-back graphic."
    },
    categories: [
      { key: "t-shirts", title: "T-Shirts", include: true, notes: "",
        variants: [variant("Next Level", "3600", "Navy", "Screen Print",
          [deco("Front left chest", "Small", ["brookfield-crest.png"])])] },
      { key: "hooded-sweatshirts", title: "Hooded Sweatshirts", include: true, notes: "",
        variants: [variant("Independent Trading Co.", "SS4500", "Charcoal", "Screen Print",
          [deco("Center back", "Large / Full Back", ["brookfield-crest.png"])])] }
    ]
  },
  {
    logo: "marina-bay-banner.png",
    store: {
      departmentName: "Marina Bay Fire & Rescue (TEST)",
      departmentCode: "MBRT",
      contactName: "Alex Serrano",
      contactEmail: "zaz@tryzol.com",
      contactPhone: "555-0177",
      neededBy: "",
      notes: "Internal test store — LEFT sleeve print, the side-view case."
    },
    categories: [
      { key: "long-sleeve-shirts", title: "Long Sleeve Shirts", include: true, notes: "",
        variants: [variant("Port & Company", "PC61LS", "Navy", "Screen Print",
          [deco("Left sleeve", "Standard", ["marina-bay-banner.png"])])] },
      { key: "polos", title: "Polos", include: true, notes: "",
        variants: [variant("Port Authority", "K500", "Navy", "Embroidery",
          [deco("Front left chest", "Small", ["marina-bay-banner.png"])])] }
    ]
  },
  {
    logo: "cedar-ridge-shield.png",
    store: {
      departmentName: "Cedar Ridge Fire Dept (TEST)",
      departmentCode: "CRFT",
      contactName: "Morgan Lee",
      contactEmail: "zaz@tryzol.com",
      contactPhone: "555-0193",
      neededBy: "",
      notes: "Internal test store — RIGHT sleeve embroidery and a cap front."
    },
    categories: [
      { key: "jackets-job-shirts", title: "Jackets / Job Shirts", include: true, notes: "",
        variants: [variant("Carhartt", "CT103828", "Black", "Embroidery",
          [deco("Right sleeve", "Standard", ["cedar-ridge-shield.png"])])] },
      { key: "hats", title: "Hats", include: true, notes: "",
        variants: [variant("Richardson", "112", "Navy", "Embroidery",
          [deco("Front center", "Standard", ["cedar-ridge-shield.png"])])] }
    ]
  }
];

/* ── Submit ──────────────────────────────────────────────────────────────── */

async function submit(entry) {
  const payload = { store: entry.store, customerNotes: entry.store.notes, categories: entry.categories };
  if (dry) {
    console.log(JSON.stringify(payload, null, 2).slice(0, 900) + "\n…\n");
    return;
  }
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  const file = path.join(ART, entry.logo);
  form.append("logos", new Blob([fs.readFileSync(file)], { type: "image/png" }), entry.logo);

  const res = await fetch(BASE + "/api/customer-intakes", { method: "POST", body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log(`  FAIL ${entry.store.departmentName} :: ${res.status} ${body.error || ""}`);
    return;
  }
  console.log(`  ok   ${entry.store.departmentName}`);
  console.log(`       id=${body.id || body.requestId || "?"} collection=${body.collection?.title || "-"} build=${body.buildStarted ? "started" : "not started"}`);
}

(async () => {
  await buildArtwork();
  console.log(`${STORES.length} test departments → ${dry ? "(dry run)" : BASE}\n`);
  for (const entry of STORES) await submit(entry);
  console.log("\nWatch progress in the console, or poll /api/customer-intakes");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

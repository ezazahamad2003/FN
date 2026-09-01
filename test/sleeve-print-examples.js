/* -----------------------------------------------------------------------------
   Side sleeve print examples.

   Drives the REAL production renderer (productImages.renderFaceImage), so what
   lands here is exactly what a built store ships. Four garments, both sleeve
   sides, print and embroidery, so the side-view rule is shown across shapes
   rather than proved on one lucky case.

     node test/sleeve-print-examples.js

   Blanks are cached in test/bases/, so re-running only pays for the renders.
   Delete an output file to have it redone.
   -------------------------------------------------------------------------- */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const sharp = require("sharp");
const { renderFaceImage } = require("../productImages");
const { generateBlankGarment } = require("../ai");

const OUT = __dirname;
const BASES = path.join(OUT, "bases");

const CASES = [
  { id: "sleeve-1-longsleeve-navy-left-print", key: "longsleeve-navy", color: "Navy",
    blank: "a long sleeve shirt laid flat", type: "long sleeve shirt",
    placement: "Left sleeve", method: "Screen Print" },
  { id: "sleeve-2-hoodie-navy-right-print", key: "hoodie-navy", color: "Navy",
    blank: "a hooded sweatshirt laid flat", type: "hoodie",
    placement: "Right sleeve", method: "Screen Print" },
  { id: "sleeve-3-jacket-black-left-embroidery", key: "jacket-black", color: "Black",
    blank: "a job shirt jacket laid flat", type: "jacket",
    placement: "Left sleeve", method: "Embroidery" },
  { id: "sleeve-4-crewneck-red-left-print", key: "crewneck-red", color: "Red",
    blank: "a crewneck sweatshirt laid flat", type: "crewneck sweatshirt",
    placement: "Left sleeve", method: "Screen Print" }
];

/* A tall, text-heavy mark: the shape a sleeve print actually takes, and the
   hardest thing to keep legible once the garment is turned side-on. Sized so
   the longest word sits well inside the box - type that overflows its own SVG
   gets clipped, and the model then reproduces the clipped version faithfully. */
async function artwork() {
  const file = path.join(OUT, "source-artwork.png");
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="1100">
    <text x="380" y="240" text-anchor="middle" font-family="Arial Black, Arial, sans-serif"
          font-size="132" font-weight="900" fill="#e8541f">OAKDALE</text>
    <text x="380" y="392" text-anchor="middle" font-family="Arial Black, Arial, sans-serif"
          font-size="132" font-weight="900" fill="#e8541f">FIRE</text>
    <rect x="180" y="462" width="400" height="16" fill="#f2b134"/>
    <text x="380" y="628" text-anchor="middle" font-family="Arial, sans-serif"
          font-size="96" font-weight="700" fill="#f2b134">RESCUE</text>
    <text x="380" y="778" text-anchor="middle" font-family="Arial, sans-serif"
          font-size="96" font-weight="700" fill="#f2b134">ENGINE 12</text>
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  fs.writeFileSync(file, buffer);
  return buffer;
}

async function base(testCase) {
  const file = path.join(BASES, testCase.key + ".png");
  if (fs.existsSync(file)) return fs.readFileSync(file);
  console.log("  generating blank: " + testCase.key);
  const buffer = await generateBlankGarment({
    productPrompt: testCase.blank,
    garmentColor: testCase.color,
    brandStyle: "",
    spec: "",
    imageGuidance: "",
    face: "front"
  });
  fs.mkdirSync(BASES, { recursive: true });
  fs.writeFileSync(file, buffer);
  return buffer;
}

(async () => {
  fs.mkdirSync(BASES, { recursive: true });
  const logo = await artwork();
  console.log(`artwork ready · ${CASES.length} examples\n`);

  await Promise.all(
    CASES.map(async (testCase, i) => {
      const file = path.join(OUT, testCase.id + ".png");
      if (fs.existsSync(file)) {
        console.log(`[${i + 1}] skip ${testCase.id}`);
        return;
      }
      const notes = [];
      try {
        const produced = await renderFaceImage({
          baseBuffer: await base(testCase),
          sourceFace: "front",
          face: "front",
          decorations: [{
            logo: { buffer: logo, mimetype: "image/png", originalName: "oakdale-sleeve.png" },
            label: testCase.placement,
            tier: "Standard"
          }],
          method: testCase.method,
          productType: testCase.type,
          onLog: (message) => notes.push(message)
        });
        fs.writeFileSync(file, produced.buffer);
        console.log(`[${i + 1}] ${produced.path === "render" ? "ok  " : "BLANK"} ${testCase.id}`);
        if (notes.length) console.log("     " + notes.join(" | "));
      } catch (error) {
        console.log(`[${i + 1}] FAIL ${testCase.id} :: ${error.message.slice(0, 140)}`);
      }
    })
  );

  console.log("\nExamples in test/");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

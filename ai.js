const { PDFParse } = require("pdf-parse");
const { editImage, generateImage, reason } = require("./azureOpenai");

// Provider-agnostic stand-in for the OpenAI SDK client this file used to build
// directly.
//
// Why a shim rather than rewriting all seven call sites: the pipeline runs on
// Azure OpenAI in production, but every call here was pinned to a literal
// "gpt-4o" model id and a raw OPENAI_API_KEY, so onboarding hard-failed on a
// deploy that only had Azure configured. Keeping the SDK's call shape means the
// routing decision (Azure first, direct OpenAI as fallback) lives in exactly one
// place — azureOpenai.js — and the reasoning/vision/image call sites below read
// the same as before.
function client() {
  return {
    chat: {
      completions: {
        create: async ({ messages, max_tokens: maxTokens, temperature, response_format: responseFormat }) => {
          const content = await reason({
            messages,
            maxTokens,
            temperature,
            jsonObject: responseFormat?.type === "json_object"
          });
          return { choices: [{ message: { content } }] };
        }
      }
    },
    images: {
      generate: async ({ prompt, size, quality }) => {
        const buffer = await generateImage({ prompt, size, quality });
        return { data: [{ b64_json: buffer.toString("base64") }] };
      }
    }
  };
}

function imageDataUrl(file) {
  return `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
}

async function analyzeLogo(file) {
  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Describe this fire department logo in detail: colors, shapes, text, symbols, and overall style. Be specific -- this description is used in the production manual and product copy."
          },
          {
            type: "image_url",
            image_url: { url: imageDataUrl(file) }
          }
        ]
      }
    ],
    max_tokens: 500
  });
  return response.choices[0]?.message?.content?.trim() || "";
}

// How many times a garment base is regenerated before we accept it. Image
// models drift toward inventing chest text/logos even when told not to, so a
// rejected render is retried rather than shipped.
const BLANK_GARMENT_ATTEMPTS = 3;

// The style number matters because it is what distinguishes the garments a
// department actually ordered — NL3600 is a crew tee, NL3601 the long-sleeve
// cut, CS410 a polo, CS410LS its long-sleeve sibling. Naming the style pins the
// silhouette the model draws.
//
// Caveat worth knowing: an image model does not reproduce a specific SKU. This
// gets the CUT right; it does not guarantee catalogue-accurate detailing. Only
// a real blank photo from the supplier does that.
function blankGarmentPrompt(productPrompt, garmentColor, brandStyle, spec, imageGuidance = "", face = "front") {
  const colorPhrase = garmentColor ? ` in ${garmentColor}` : "";
  const stylePhrase = brandStyle
    ? ` The garment is a ${brandStyle} — match that style's silhouette exactly: sleeve length, collar or neckline type, placket, cuffs, and overall cut.`
    : "";
  // blanks.js fetches how the real style is built when a supplier photo itself
  // could not be used. Describing the actual garment is the difference between
  // "close to NL3600" and "some t-shirt".
  const specPhrase = spec ? ` Reproduce this style faithfully: ${spec}` : "";
  const guidancePhrase = imageGuidance ? ` Intake form mockup guidance: ${imageGuidance}` : "";
  // Back bases exist so center-back artwork lands on an actual back view —
  // naming the face here keeps the prompt from fighting the guidance sentence.
  const facePhrase = face === "back"
    ? "Photographed straight on from the BACK — the rear of the garment fills the shot, no collar placket or front details visible"
    : "Photographed straight on from the front";
  return `A professional studio product photograph of ${productPrompt}${colorPhrase}.${stylePhrase}${specPhrase}${guidancePhrase} The garment is completely blank: no logo, no text, no lettering, no numbers, no words, no letters, no symbols, no graphics, no embroidery, no patches, no tags, no labels, no brand marks, no printed design of any kind anywhere on the garment. Every surface is plain, unbroken fabric. ${facePhrase}, laid perfectly flat and centered, filling about 80 percent of the frame. Clean pure white background, soft even studio lighting, sharp commercial product photography.`;
}

async function renderGarment(prompt) {
  const openai = client();
  const response = await openai.images.generate({
    model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
    size: "1024x1024",
    quality: "medium",
    n: 1,
    prompt
  });
  const image = response.data?.[0];
  // The provider shim always returns base64 (it downloads URL results itself
  // in azureOpenai.generateImage), so a missing payload is a hard error here.
  if (!image?.b64_json) throw new Error("Image generation did not return image data.");
  return Buffer.from(image.b64_json, "base64");
}

// Gate on the one failure mode that actually reaches customers: the image model
// rendering its own text or artwork onto a garment that is supposed to be
// blank. Anything it invents is gibberish — misspelled words, fake crests, a
// scribbled brand mark — and the real logo gets composited on top of it, so it
// has to be caught before the base is used.
async function inspectGarmentForArtwork(buffer) {
  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `This image should show a completely blank garment with no decoration of any kind.

Inspect the garment itself (ignore the background, and ignore plain fabric features such as seams, stitching, buttons, zippers, pockets, collars, and folds).

Return JSON only: {"clean": true|false, "found": "short description of any text, letters, numbers, logos, emblems, patches, brand marks, or printed graphics visible on the garment"}

Set "clean" to false if ANY lettering, numbering, logo, emblem, patch, label, or printed graphic appears on the garment, even faint, partial, or blurry. Set "clean" to true only if every surface of the garment is plain undecorated fabric.`
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${buffer.toString("base64")}` } }
        ]
      }
    ],
    max_tokens: 200
  });

  try {
    const parsed = parseJsonObject(response.choices[0]?.message?.content?.trim() || "{}");
    return { clean: parsed.clean === true, found: String(parsed.found || "") };
  } catch (error) {
    // An unparseable inspection must not block a run — the composite step still
    // places the real logo correctly, so accept the base and move on.
    return { clean: true, found: "" };
  }
}

// Generate a BLANK garment photo only. The department logo is composited onto
// this base afterwards (mockup.js) so the exact uploaded artwork is preserved —
// the image model never attempts to redraw logos or text.
//
// Two layers keep gibberish out of the final product image:
//   1. this function rejects any base render that already has invented text or
//      artwork on it and tries again,
//   2. mockup.compositeLogoOnGarment pastes the exact uploaded logo file, so
//      the artwork that does appear is never model-drawn.
async function generateBlankGarment({ productPrompt, garmentColor, brandStyle, spec, imageGuidance, face = "front" }) {
  let prompt = blankGarmentPrompt(productPrompt, garmentColor, brandStyle, spec, imageGuidance, face);
  let lastBuffer = null;
  let lastFinding = "";

  for (let attempt = 1; attempt <= BLANK_GARMENT_ATTEMPTS; attempt++) {
    lastBuffer = await renderGarment(prompt);
    const inspection = await inspectGarmentForArtwork(lastBuffer);
    if (inspection.clean) return lastBuffer;

    lastFinding = inspection.found;
    // Name the offending artwork in the retry so the model stops reproducing it.
    prompt = `${blankGarmentPrompt(productPrompt, garmentColor, brandStyle, spec, imageGuidance, face)} A previous attempt incorrectly included ${
      inspection.found || "text and graphics"
    } on the garment. Do not include that or anything like it. The garment must be entirely undecorated.`;
  }

  // Out of retries: the composite still lands the real logo on top, so ship the
  // last render rather than failing the whole run, but make the reason visible.
  console.warn(
    `Blank garment for "${productPrompt}" still showed generated artwork after ${BLANK_GARMENT_ATTEMPTS} attempts (${lastFinding}). Using the last render.`
  );
  return lastBuffer;
}

// Turn the operator's free-text description of a garment ("navy job shirt,
// heavyweight, quarter zip") into the structured fields the rest of the
// pipeline already speaks. Used by the manual "create a product" flow, where a
// person describes the item instead of a policy document defining it.
//
// Same no-invention rule as policy extraction: a detail the operator did not
// give comes back empty rather than guessed, so the review chips keep telling
// the truth about what is stated versus defaulted.
async function planCustomProduct(description, hints = {}) {
  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: `An operator is adding one custom garment to a fire department uniform store. Convert their description into structured product fields.

CRITICAL RULE — no invention: use only what the description (and the operator-supplied values below) actually say. If a detail is not stated, return an empty string. Never guess fabric weights, brands, colors, or style numbers.

Return JSON only with these keys:
- productType: short lowercase type such as "shirt", "hat", "pants", "hoodie", "jacket"
- productLabel: customer-facing product name; include the garment brand only if stated (e.g. "Next Level Cotton T-Shirt"). Never include the department name.
- productPrompt: a visual phrase describing the BLANK garment for product photography (garment shape, cut, and material look only — never mention any logo, text, or decoration)
- garmentColor: color if stated, else ""
- brandStyle: brand and/or style number if stated, else ""
- fabricDetails: fabric/material details if stated, else ""
- decorationMethod: embroidery/screen print/heat transfer if stated, else ""

Operator-supplied values (these win over anything inferred from the description):
${JSON.stringify(
  {
    productLabel: hints.productLabel || "",
    productType: hints.productType || "",
    garmentColor: hints.garmentColor || ""
  },
  null,
  2
)}

Description:
${description}`
      }
    ],
    max_tokens: 600
  });

  const fallbackLabel = hints.productLabel || "Custom Garment";
  try {
    const parsed = parseJsonObject(response.choices[0]?.message?.content?.trim() || "{}");
    return {
      productType: hints.productType || parsed.productType || "product",
      productLabel: hints.productLabel || parsed.productLabel || fallbackLabel,
      productPrompt: parsed.productPrompt || `a ${hints.productType || "garment"} laid flat`,
      garmentColor: hints.garmentColor || parsed.garmentColor || "",
      brandStyle: parsed.brandStyle || "",
      fabricDetails: parsed.fabricDetails || "",
      decorationMethod: parsed.decorationMethod || ""
    };
  } catch (error) {
    return {
      productType: hints.productType || "product",
      productLabel: fallbackLabel,
      productPrompt: `a ${hints.productType || "garment"} laid flat`,
      garmentColor: hints.garmentColor || "",
      brandStyle: "",
      fabricDetails: "",
      decorationMethod: ""
    };
  }
}

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Size chart table, rendered deterministically from extracted data (never by
// the language model) so numbers can't be invented or mangled.
function sizeChartHtml(sizeChart) {
  if (!sizeChart || !Array.isArray(sizeChart.headers) || !sizeChart.headers.length || !Array.isArray(sizeChart.rows) || !sizeChart.rows.length) {
    return "";
  }
  const head = `<tr><td></td>${sizeChart.headers.map((h) => `<td><b>${escapeHtml(h)}</b></td>`).join("")}</tr>`;
  const rows = sizeChart.rows
    .map((row) => `<tr><td><b>${escapeHtml(row.label)}</b></td>${(row.values || []).map((v) => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`)
    .join("");
  return `<br><table border="1" cellpadding="4" cellspacing="0">${head}${rows}</table>`;
}

// Description layout mirrors the store's real listings: approximation note,
// short prose, brand/style line, spec bullets, size chart table. Only the
// 2-sentence prose comes from the model — every fact is assembled
// deterministically from what the policy actually stated.
async function generateProductDescription(departmentName, product) {
  // Placement reads from the full decoration set when the intake specified
  // several spots ("Front left chest + Center back"), falling back to the
  // single legacy placement field.
  const placements = (product.decorations || [])
    .map((decoration) => decoration.placement)
    .filter(Boolean);
  const placementLine = placements.length ? placements.join(" + ") : product.placement;

  // Supplier-page fabric bullets (fetched by blanks.js) each get their own
  // line, exactly as the vendor lists them; the legacy single fabricDetails
  // string stays as one line for older callers.
  const fabricBullets = Array.isArray(product.fabricBullets) && product.fabricBullets.length
    ? product.fabricBullets
    : product.fabricDetails
      ? [product.fabricDetails]
      : [];

  const specs = [
    ...fabricBullets,
    product.garmentColor ? `Garment color: ${product.garmentColor}` : "",
    placementLine ? `Logo placement: ${placementLine}` : "",
    product.decorationMethod && !/^none$/i.test(product.decorationMethod) ? `Decoration: ${product.decorationMethod}` : ""
  ].filter(Boolean);

  // Customer-facing facts only. productionNotes stays OUT of the prose
  // context: it carries internal jargon (fee SKUs, "structured intake
  // category", tier keys) that the model quoted verbatim into store listings.
  const knownFacts = [
    ["Product", product.productLabel],
    ["Garment color", product.garmentColor],
    ["Garment brand/style", product.brandStyle],
    ["Fabric details", fabricBullets.join("; ")],
    ["Logo placement", placementLine],
    ["Decoration method", product.decorationMethod && !/^none$/i.test(product.decorationMethod) ? product.decorationMethod : ""]
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");

  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: `Write exactly 2 professional, proud sentences of Shopify product description prose for official ${departmentName} gear, using ONLY the facts below. Do not invent fabric weights, materials, brand names, colors, or any spec that is not listed. Never mention SKUs, fees, size tiers, intake forms, or internal processes. Return plain text only — no HTML, no quotes, no markdown.

Facts:
${knownFacts}`
      }
    ],
    max_tokens: 160
  });
  const prose = (response.choices[0]?.message?.content?.trim() || "")
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^"|"$/g, "")
    .trim();

  const brandLine = [product.vendor, product.brandStyle]
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index)
    .join(" ");
  const parts = [
    "<p><em>Logo size &amp; placement are an approximation.</em></p>",
    prose ? `<p>${escapeHtml(prose)}</p>` : "",
    brandLine ? `<p><b>${escapeHtml(brandLine)}</b></p>` : "",
    specs.length ? `<ul>${specs.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : "",
    sizeChartHtml(product.sizeChart)
  ];
  return parts.filter(Boolean).join("\n");
}

/* -----------------------------------------------------------------------------
   Decorated product renders.

   Pasting a flat PNG onto a photo at fixed coordinates reads as a sticker -
   wrong perspective, no fabric texture, and on unusual silhouettes the
   artwork could land off the garment entirely. The primary renderer is now an
   IMAGE EDIT: gpt-image-1 receives the real garment photo plus the actual
   logo files and returns the same photo with the artwork genuinely printed
   on the fabric, at the placement and size the intake specified.

   The model is not trusted blind. Every render is verified by vision against
   the ORIGINAL inputs - artwork faithful, placement right, size sane,
   garment unchanged, nothing invented - and retried with the failure reasons
   before the caller falls back to the deterministic composite.
   -------------------------------------------------------------------------- */

const DECORATED_RENDER_ATTEMPTS = 2;

/* -----------------------------------------------------------------------------
   Garment geometry.

   Fixed fractional coordinates cannot know whether a shirt's sleeves hang
   down or stick out, where a cap's front panel starts, or how wide the
   garment physically is - which is exactly how patches ended up on shoulder
   seams and back graphics grew past their tier. So the base photo is
   MEASURED once: vision returns the patch-ready rectangle for each needed
   spot plus the garment's real-world width, and placement/sizing become
   arithmetic (4-inch crest on a 24-inch hoodie = 1/6 of its width).
   -------------------------------------------------------------------------- */

const SPOT_DESCRIPTIONS = {
  "left-chest": "the wearer's LEFT chest (viewer's right side of the photo), where a small uniform crest sits — below the shoulder, above any pocket, clear of plackets and zippers",
  "right-chest": "the wearer's RIGHT chest (viewer's left side of the photo), same rules as the other chest spot",
  "center-chest": "centered on the chest, clear of collar and placket",
  "full-front": "the large central print area of the front torso",
  "center-back": "the upper-back print area: horizontally centered, starting a couple of inches below the collar/hood seam and covering the shoulder-blade region",
  "left-sleeve": "the OUTER FACE of the wearer's LEFT sleeve (viewer's right), centered on the upper-arm section of the sleeve about 3-4 inches BELOW the shoulder seam — the box must sit fully inside the sleeve outline and must not touch or cross the shoulder seam or the garment body",
  "right-sleeve": "the OUTER FACE of the wearer's RIGHT sleeve (viewer's left), centered on the upper-arm section of the sleeve about 3-4 inches BELOW the shoulder seam — the box must sit fully inside the sleeve outline and must not touch or cross the shoulder seam or the garment body",
  "front-panel": "the front panel of the cap, centered above the brim",
  "cap-side": "the side panel of the cap over the wearer's left temple",
  "beanie-cuff": "the turned-up cuff of the beanie, front center",
  "left-thigh": "the OUTER thigh of the wearer's LEFT leg (viewer's right leg), clear of pockets and the inseam",
  "right-thigh": "the OUTER thigh of the wearer's RIGHT leg (viewer's left leg), clear of pockets and the inseam",
  "left-leg-hem": "the lower front of the wearer's LEFT leg (viewer's right leg), an inch or two above the hem opening, where shorts carry their mark",
  "right-leg-hem": "the lower front of the wearer's RIGHT leg (viewer's left leg), an inch or two above the hem opening, where shorts carry their mark"
};
// Long-sleeve alias keys measure the same spot as their base key.
SPOT_DESCRIPTIONS["left-sleeve-long"] = SPOT_DESCRIPTIONS["left-sleeve"];
SPOT_DESCRIPTIONS["right-sleeve-long"] = SPOT_DESCRIPTIONS["right-sleeve"];

/**
 * Measure a garment photo: overall garment box, physical width estimate, and
 * a patch-ready rectangle per requested spot key. All boxes are fractions of
 * the IMAGE (x, y = top-left corner). Returns null on any failure — callers
 * fall back to the static coordinate table.
 */
async function analyzeGarmentGeometry(baseBuffer, spotKeys = []) {
  const keys = [...new Set(spotKeys)].filter((key) => SPOT_DESCRIPTIONS[key]);
  const spotLines = keys.map((key) => `  "${key}": ${SPOT_DESCRIPTIONS[key]}`).join("\n");
  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `This is a product photo of a garment. Measure it precisely.

Return JSON only:
{
  "garment": {"x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1},   // tight bounding box of the garment itself, as fractions of the whole image
  "garmentWidthInches": number,                            // physical width of the garment as laid out, in inches (adult tee ~20-22, hoodie ~23-25, cap ~8-9, pants leg spread varies)
  "spots": {
${spotLines ? spotLines.replace(/^/gm, "  ") : ""}
  }
}

Each spot value is {"x","y","w","h"} — the rectangle (fractions of the whole image) where a garment decorator would actually apply artwork at that location, sized like the real print/patch area. Every spot rectangle MUST lie entirely inside the garment rectangle, on fabric — never on the background. Use null for a spot that is not visible in this photo. Be precise about left/right: "wearer's left" is the VIEWER'S RIGHT in a front-facing photo.`
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${baseBuffer.toString("base64")}` } }
        ]
      }
    ],
    max_tokens: 600
  });

  try {
    const parsed = parseJsonObject(response.choices[0]?.message?.content?.trim() || "{}") || {};
    const box = (value) =>
      value && [value.x, value.y, value.w, value.h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) && value.w > 0.005 && value.h > 0.005
        ? { x: value.x, y: value.y, w: value.w, h: value.h }
        : null;
    const garment = box(parsed.garment);
    if (!garment) return null;
    const spots = {};
    for (const key of keys) spots[key] = box(parsed.spots?.[key]);
    const width = Number(parsed.garmentWidthInches);
    return {
      garment,
      garmentWidthInches: Number.isFinite(width) && width > 3 && width < 80 ? width : null,
      spots
    };
  } catch {
    return null;
  }
}

function decorationInstruction(decoration, imageIndex, method) {
  const methodPhrase = /embroider/i.test(method || "")
    ? "embroidered with visible thread texture and slightly raised stitching"
    : /patch/i.test(method || "")
      ? "applied as a sewn-on patch with a merrowed edge"
      : "printed flat into the fabric";
  return `Apply the artwork from image ${imageIndex} ${methodPhrase}, positioned ${decoration.guidance || `at the ${decoration.placementLabel || "left chest"}`}. Size: ${decoration.widthPhrase || "about 4 inches wide"}.`;
}

async function verifyDecoratedGarment(candidateBuffer, baseBuffer, decorations, { face = "front", sourceFace = "front" } = {}) {
  const openai = client();
  const uniqueLogos = [];
  const seen = new Set();
  for (const decoration of decorations) {
    if (!seen.has(decoration.logoName)) {
      seen.add(decoration.logoName);
      uniqueLogos.push(decoration);
    }
  }
  const expectations = decorations
    .map((decoration, index) => `${index + 1}. "${decoration.logoName}" at ${decoration.placementLabel || "left chest"} (${decoration.widthPhrase || "small"})`)
    .join("\n");

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Image 1 is a CANDIDATE product photo for a uniform store. Image 2 is the original blank garment photo it must match${face !== sourceFace ? ` (image 2 shows the ${sourceFace} of the garment; the candidate should show the SAME garment from the ${face})` : ""}. The remaining image(s) are the original artwork file(s).

The candidate should show the ${face} of the same garment with this decoration:
${expectations}

Judge artwork fidelity by DESIGN and exact text - the intended finish (screen print, embroidery stitch texture, or a sewn patch) legitimately changes surface texture and softens edges; that is correct, not unfaithful.

Return JSON only:
{
  "garmentMatches": true|false,   // same garment, same color, same style as image 2 (ignore mirroring/small crop differences${face !== sourceFace ? `; the candidate legitimately shows the ${face} of it` : ""})
  "artworkFaithful": true|false,  // every applied artwork reproduces its original file accurately: same shapes, colors, and layout, and every piece of text spelled EXACTLY as the original. Lettering that reads as different, garbled, or rearranged characters is ALWAYS unfaithful — soft focus is acceptable, wrong letters never are
  "artworkProblems": "what differs from the original artwork, if anything",
  "placementCorrect": true|false, // each artwork sits at its stated position
  "placementSeen": "where the artwork actually sits",
  "sizeSeenPercent": number,      // measure it: the artwork's width as a percentage of the garment's full width in the candidate photo
  "sizeReasonable": true|false,   // sizeSeenPercent is within about a third of each artwork's stated percentage of garment width — an 8-10 inch back graphic is ~35-40% of a hoodie's width, NEVER half the garment or more
  "artworkLevel": true|false,     // the artwork sits straight and level on the garment — reject any visible rotation, tilt, or skew beyond the garment's own natural drape
  "looksPrinted": true|false,     // artwork looks genuinely applied to the fabric (follows surface, plausible lighting), not a flat sticker pasted on top
  "extraArtwork": true|false,     // any text, logo, or graphic that is NOT part of the requested decoration
  "onGarment": true|false         // all artwork fully on the garment fabric, nothing hanging into the background
}`
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${candidateBuffer.toString("base64")}` } },
          { type: "image_url", image_url: { url: `data:image/png;base64,${baseBuffer.toString("base64")}` } },
          ...uniqueLogos.map((decoration) => ({
            type: "image_url",
            image_url: { url: `data:${decoration.logoMime || "image/png"};base64,${decoration.logoBuffer.toString("base64")}` }
          }))
        ]
      }
    ],
    max_tokens: 400
  });

  let parsed = {};
  try {
    parsed = parseJsonObject(response.choices[0]?.message?.content?.trim() || "{}") || {};
  } catch {
    // An unreadable verdict must not ship an unverified render; treat as fail.
    return { usable: false, reasons: ["verification response was unreadable"] };
  }
  const reasons = [];
  if (parsed.garmentMatches !== true) reasons.push("the garment changed from the original photo");
  if (parsed.artworkFaithful !== true) reasons.push(`artwork not faithful (${parsed.artworkProblems || "differs from the original file"})`);
  if (parsed.placementCorrect !== true) reasons.push(`wrong placement (sits at ${parsed.placementSeen || "an unknown position"})`);
  if (parsed.sizeReasonable !== true) {
    reasons.push(`artwork size is off${Number.isFinite(parsed.sizeSeenPercent) ? ` (measured ~${Math.round(parsed.sizeSeenPercent)}% of garment width; match the stated size)` : ""}`);
  }
  if (parsed.artworkLevel === false) reasons.push("artwork is rotated or skewed - it must sit straight and level");
  if (parsed.extraArtwork === true) reasons.push("extra artwork or text was invented");
  if (parsed.onGarment !== true) reasons.push("artwork hangs off the garment");
  return { usable: reasons.length === 0, reasons, looksPrinted: parsed.looksPrinted === true };
}

/**
 * Render the garment photo with its decorations actually applied.
 * `decorations`: [{ logoBuffer, logoMime, logoName, placementLabel, guidance, widthPhrase }].
 *
 * Two modes:
 *   • apply (no draftBuffer): the model places the artwork itself — used for
 *     cross-face renders (turn the supplier's front photo around and decorate
 *     the back), where nothing exists to pre-composite onto.
 *   • integrate (draftBuffer given): the exact artwork was already composited
 *     pixel-perfectly at the right spot and size; the model only re-renders
 *     it INTO the fabric. This is the primary path — the model draws small
 *     logo text badly from scratch, but integrating existing pixels keeps
 *     content ours and realism its job.
 *
 * Returns the verified render, or null when every attempt failed verification
 * (the caller then falls back to the deterministic composite draft).
 */
async function renderDecoratedGarment({ baseBuffer, draftBuffer = null, decorations, face = "front", sourceFace = "front", decorationMethod = "", onLog }) {
  const log = (message) => onLog && onLog(message);
  const uniqueLogos = [];
  const indexByName = new Map();
  for (const decoration of decorations) {
    if (!indexByName.has(decoration.logoName)) {
      indexByName.set(decoration.logoName, uniqueLogos.length + 2); // image 1 is the garment
      uniqueLogos.push(decoration);
    }
  }

  const methodPhrase = /embroider/i.test(decorationMethod) ? "embroidery" : "garment printing";
  let basePrompt;
  if (draftBuffer) {
    basePrompt = `Image 1 is a product photo where the artwork has already been placed at exactly the right position and size, but it currently sits on top like a flat sticker. Re-render this exact photo so every piece of artwork looks genuinely applied to the fabric as real ${methodPhrase}: it follows the fabric's surface, weave, and folds, picks up the photo's lighting and shading, and its edges meld naturally with the garment. Keep every artwork's position, size, and design EXACTLY as shown — the remaining image(s) are the original artwork files for reference; never redraw, respell, move, or resize the artwork. Change nothing else: same garment, same color, same framing, same background, no added text or graphics.`;
  } else {
    const instructions = decorations
      .map((decoration) => decorationInstruction(decoration, indexByName.get(decoration.logoName), decorationMethod))
      .join(" ");
    // A back placement usually starts from the supplier's FRONT photo: the
    // model turns the exact garment around, which keeps front and back
    // mockups looking like the same product in a way a text-prompted
    // generation never did.
    const viewPhrase = face !== sourceFace
      ? `Image 1 is a professional product photo of a blank garment shown from the ${sourceFace}. First show this SAME garment photographed from the ${face} - identical color, fabric, cut, framing, lighting, and background, laid out the same way${face === "back" ? ", with no collar placket, buttons, zipper, or other front-only details visible" : ""}.`
      : `Image 1 is a professional product photo of a blank garment, shown from the ${face}.`;
    basePrompt = `${viewPhrase} ${instructions} Reproduce each artwork EXACTLY as in its file: identical shapes, colors, proportions, and text, sharp and legible. The decoration must look genuinely part of the garment - it follows the fabric surface and folds and picks up the photo's lighting, with the subtle texture of real ${methodPhrase}. Change NOTHING else: same garment, same color, same framing, same background, no added text or graphics anywhere else.`;
  }

  let prompt = basePrompt;
  for (let attempt = 1; attempt <= DECORATED_RENDER_ATTEMPTS; attempt++) {
    let candidate;
    try {
      candidate = await editImage({
        images: [
          { buffer: draftBuffer || baseBuffer, mimeType: "image/png", name: "garment.png" },
          ...uniqueLogos.map((decoration, index) => ({
            buffer: decoration.logoBuffer,
            mimeType: decoration.logoMime || "image/png",
            name: decoration.logoName || `logo-${index}.png`
          }))
        ],
        prompt
      });
    } catch (error) {
      log(`decorated render attempt ${attempt} failed (${error.message})`);
      continue;
    }
    const verdict = await verifyDecoratedGarment(candidate, baseBuffer, decorations, { face, sourceFace }).catch((error) => {
      log(`render verification errored (${error.message}); treating as unverified`);
      return { usable: false, reasons: ["verification unavailable"] };
    });
    if (verdict.usable) {
      log(`decorated render accepted on attempt ${attempt}`);
      return candidate;
    }
    log(`decorated render attempt ${attempt} rejected: ${verdict.reasons.join("; ")}`);
    prompt = `${basePrompt} A previous attempt was rejected because: ${verdict.reasons.join("; ")}. Correct exactly these problems.`;
  }
  return null;
}

/* -----------------------------------------------------------------------------
   Patch-level artwork integration — the small-artwork renderer.

   A 4-inch crest is ~130px on a full 1024px garment photo, and at that scale
   an image model garbles the lettering it redraws. The fix is resolution:
   the placement REGION is cropped and upscaled to the model's full canvas —
   the crest's text becomes hundreds of pixels tall — the model renders it
   genuinely printed/embroidered at that scale, the close-up is verified
   against the original artwork file, and the caller feathers the region back
   into the photo. Hyper-real integration AND correct lettering.
   -------------------------------------------------------------------------- */

const SURFACE_RENDER_PHRASES = {
  "cap-side": "This spot is the SIDE panel of a cap photographed from the front: the surface curves away steeply. The artwork must WRAP around the panel with strong perspective foreshortening — visibly compressed toward the rear, its far portion turning out of view so only roughly half to two-thirds reads fully, exactly like side-panel embroidery in a real front-view cap photo. Never render it facing the camera flat-on.",
  sleeve: "This spot is the curved OUTER face of a sleeve: apply a subtle cylindrical wrap — gentle foreshortening toward the sleeve's edges so the artwork follows the arm's roundness instead of sitting perfectly flat.",
  cuff: "This spot is a rounded knit cuff: give the artwork a slight curve following the cuff's cylinder."
};

const SURFACE_VERIFY_PHRASES = {
  "cap-side": "The spot is a cap's SIDE panel seen from the front: CORRECT rendering shows the artwork wrapped and strongly foreshortened, partially turned out of view (roughly half to two-thirds visible). Judge the design and text through that perspective; a flat, fully frontal rendering here is WRONG — set looksApplied false for it.",
  sleeve: "The spot is a sleeve's curved outer face: slight cylindrical foreshortening is correct and expected; judge the design through it.",
  cuff: "The spot is a rounded cuff: a slight curve in the artwork is correct."
};

async function verifyArtworkPatch(candidateBuffer, draftBuffer, logo, decorationMethod = "", surface = "flat") {
  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Image 1 is a CANDIDATE close-up of artwork applied to a garment. Image 2 is the same close-up BEFORE processing (the artwork correctly positioned but flat). Image 3 is the original artwork file.

The artwork was INTENTIONALLY applied as ${/embroider/i.test(decorationMethod) ? "EMBROIDERY: stitch texture, thread sheen, satin-stitch borders, and slightly softened or thickened edges are CORRECT and expected — judge the DESIGN (layout, shapes, colors as their thread equivalents) and the exact text, not the flat-vector finish" : /patch/i.test(decorationMethod) ? "a SEWN PATCH: a merrowed border, slight thickness, and fabric texture are CORRECT and expected — judge the design and exact text, not the flat-vector finish" : "SCREEN PRINT: subtle fabric texture through the ink is correct; shapes and colors should otherwise match the file closely"}.${SURFACE_VERIFY_PHRASES[surface] ? `

${SURFACE_VERIFY_PHRASES[surface]}` : ""}

Return JSON only:
{
  "artworkFaithful": true|false,  // the candidate's artwork reproduces image 3's DESIGN: same layout, same shapes (allowing the finish above), matching colors, and every piece of text spelled EXACTLY the same. Different, garbled, or rearranged letters are ALWAYS unfaithful
  "artworkProblems": "what differs from the original artwork's design, if anything",
  "samePlacement": true|false,    // the artwork sits at the same position and roughly the same size as in image 2 — reject if its center moved more than about 12% of the image or its size changed more than about 25%
  "artworkLevel": true|false,     // the artwork sits straight and level, matching image 2 — reject any added rotation, tilt, or skew
  "looksApplied": true|false,     // it reads as genuinely applied ON the fabric - follows the surface, plausible lighting - not a flat sticker
  "fabricIntact": true|false,     // the surrounding fabric, seams, and background match image 2 - nothing else changed
  "extraArtwork": true|false      // any text or graphic that is not part of the artwork
}`
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${candidateBuffer.toString("base64")}` } },
          { type: "image_url", image_url: { url: `data:image/png;base64,${draftBuffer.toString("base64")}` } },
          { type: "image_url", image_url: { url: `data:${logo.logoMime || "image/png"};base64,${logo.logoBuffer.toString("base64")}` } }
        ]
      }
    ],
    max_tokens: 300
  });

  try {
    const parsed = parseJsonObject(response.choices[0]?.message?.content?.trim() || "{}") || {};
    const reasons = [];
    if (parsed.artworkFaithful !== true) reasons.push(`artwork not faithful (${parsed.artworkProblems || "differs from the original"})`);
    if (parsed.samePlacement !== true) reasons.push("artwork moved or resized");
    if (parsed.artworkLevel === false) reasons.push("artwork was rotated or skewed");
    if (parsed.fabricIntact !== true) reasons.push("surrounding fabric changed");
    if (parsed.extraArtwork === true) reasons.push("extra artwork or text appeared");
    return { usable: reasons.length === 0, reasons };
  } catch {
    return { usable: false, reasons: ["verification response was unreadable"] };
  }
}

/**
 * Render one artwork region so the artwork looks genuinely applied.
 * `patchBuffer` is a SQUARE close-up crop (upscaled to 1024) with the exact
 * artwork already composited at the right spot. Returns the integrated patch
 * or null when no attempt verified.
 */
/* Deterministic guard: if the model's changes reach the crop's border ring,
   the artwork escaped its box (blown up, shifted, or repainted background) —
   the paste-back would show it cropped mid-letter. No vision judgment
   involved; pure pixel comparison against the original crop. */
async function patchBorderIntact(originalCrop, candidateCrop) {
  const sharp = require("sharp");
  const [a, b] = await Promise.all([
    sharp(originalCrop).resize(256, 256).greyscale().raw().toBuffer(),
    sharp(candidateCrop).resize(256, 256).greyscale().raw().toBuffer()
  ]);
  const size = 256;
  const ring = Math.round(size * 0.06);
  let changed = 0;
  let total = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inRing = x < ring || y < ring || x >= size - ring || y >= size - ring;
      if (!inRing) continue;
      const i = y * size + x;
      if (Math.abs(a[i] - b[i]) > 30) changed++;
      total++;
    }
  }
  return total === 0 || changed / total <= 0.12;
}

async function integrateArtworkPatch({ patchBuffer, logo, decorationMethod = "", surface = "flat", onLog }) {
  const log = (message) => onLog && onLog(message);
  const methodPhrase = /embroider/i.test(decorationMethod)
    ? "embroidered: dense visible thread stitching, slight raised relief, satin-stitch edges"
    : /patch/i.test(decorationMethod)
      ? "a sewn-on twill patch: merrowed border, slight thickness, stitched to the fabric"
      : "screen printed: ink laid into the fabric so the weave texture shows through it subtly";
  const basePrompt = `Image 1 is a close-up photo of a garment with artwork placed at exactly the right position and size, but it currently looks like a flat digital sticker. Image 2 is the original artwork file. Re-render this close-up photorealistically so the artwork looks genuinely ${methodPhrase}. It must follow the fabric's surface, weave, and any folds, and pick up the photo's real lighting and shadows.${SURFACE_RENDER_PHRASES[surface] ? ` ${SURFACE_RENDER_PHRASES[surface]}` : ""} Reproduce the artwork EXACTLY as in image 2 — identical shapes, colors, proportions, and text, every word spelled precisely the same, sharp and legible. Do not move or resize it. Keep the surrounding fabric, seams, and background exactly as they are. Nothing else changes.`;

  let prompt = basePrompt;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let candidate;
    try {
      candidate = await editImage({
        images: [
          { buffer: patchBuffer, mimeType: "image/png", name: "region.png" },
          { buffer: logo.logoBuffer, mimeType: logo.logoMime || "image/png", name: logo.logoName || "artwork.png" }
        ],
        prompt
      });
    } catch (error) {
      log(`patch render attempt ${attempt} failed (${error.message})`);
      continue;
    }
    if (!(await patchBorderIntact(patchBuffer, candidate).catch(() => true))) {
      log(`patch render attempt ${attempt} rejected: changes reached the region border (artwork enlarged or shifted)`);
      prompt = `${basePrompt} A previous attempt enlarged the artwork or painted to the edge of the image. Keep the artwork at EXACTLY its original position and size, and leave the outer area of the image completely untouched.`;
      continue;
    }
    const verdict = await verifyArtworkPatch(candidate, patchBuffer, logo, decorationMethod, surface).catch(() => ({ usable: false, reasons: ["verification unavailable"] }));
    if (verdict.usable) {
      log(`patch render accepted on attempt ${attempt}`);
      return candidate;
    }
    log(`patch render attempt ${attempt} rejected: ${verdict.reasons.join("; ")}`);
    prompt = `${basePrompt} A previous attempt was rejected because: ${verdict.reasons.join("; ")}. Correct exactly these problems.`;
  }
  return null;
}

/* -----------------------------------------------------------------------------
   Supplier product-page facts.

   A distributor's product page carries the two things the store listing needs
   verbatim: the fabric spec bullets ("4.3-ounce, 100% combed ring spun cotton,
   32 singles") and the size chart. Extracting them from the page the sourcing
   agent already found means the Shopify description shows the REAL garment
   data instead of model-written approximations.
   -------------------------------------------------------------------------- */
async function extractSupplierFacts(pageText, { brandStyle = "", productType = "" } = {}) {
  const text = String(pageText || "").trim();
  if (!text) return { fabric: [], sizeChart: null, fit: "" };

  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: `Below is text extracted from a wholesale apparel product page${brandStyle ? ` for style "${brandStyle}"` : ""}${productType ? ` (a ${productType})` : ""}.

CRITICAL RULE — no invention: report ONLY facts that literally appear in the text. If a field is absent, return an empty array / null / empty string for it. Never guess fabric weights, contents, or measurements.

Return JSON only:
{
  "fabric": ["each garment spec worth a bullet on a product listing, verbatim or near-verbatim: fabric weight and content, construction (side seamed, taped shoulders, rib knit, tear-away label), closures, pockets — max 8 short bullets, no marketing prose"],
  "sizeChart": {"headers": ["S","M","L", ...], "rows": [{"label": "Body Length", "values": ["28","29", ...]}]} — the garment MEASUREMENT table if one appears, with one value per header; null if the page has no measurement table,
  "fit": "one short sentence about the cut/fit if stated, else \\"\\""
}

Page text:
${text.slice(0, 16000)}`
      }
    ],
    max_tokens: 900
  });

  const parsed = parseJsonObject(response.choices[0]?.message?.content?.trim() || "{}") || {};
  const fabric = (Array.isArray(parsed.fabric) ? parsed.fabric : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 8);
  let sizeChart = null;
  const chart = parsed.sizeChart;
  if (chart && Array.isArray(chart.headers) && chart.headers.length && Array.isArray(chart.rows) && chart.rows.length) {
    const headers = chart.headers.map((h) => String(h ?? "").trim()).filter(Boolean);
    const rows = chart.rows
      .map((row) => ({
        label: String(row?.label ?? "").trim(),
        values: (Array.isArray(row?.values) ? row.values : []).map((v) => String(v ?? "").trim())
      }))
      .filter((row) => row.label && row.values.length);
    if (headers.length && rows.length) sizeChart = { headers, rows };
  }
  return { fabric, sizeChart, fit: String(parsed.fit || "").trim() };
}

async function extractReadableText(file) {
  // PDFs are compressed binary, so naive utf8 decoding yields garbage. Parse
  // them properly so the policy's garment list actually reaches the model.
  const isPdf =
    file.mimetype === "application/pdf" ||
    (file.originalname || "").toLowerCase().endsWith(".pdf");
  if (isPdf) {
    let parser;
    try {
      parser = new PDFParse({ data: file.buffer });
      const result = await parser.getText();
      return (result.text || "").replace(/\s+/g, " ").trim().slice(0, 12000);
    } catch (error) {
      return "";
    } finally {
      if (parser) await parser.destroy().catch(() => {});
    }
  }

  const textTypes = [
    "text/",
    "application/json",
    "application/xml",
    "application/msword",
    "application/vnd.openxmlformats-officedocument"
  ];
  const canRead = textTypes.some((type) => file.mimetype.startsWith(type) || file.mimetype.includes(type));
  const raw = file.buffer.toString("utf8");
  const cleaned = raw
    .replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (canRead || cleaned.length > 200) return cleaned.slice(0, 12000);
  return "";
}

// Build one combined text context from the policy documents, any follow-up
// documents (the department's answers to a gaps email), and pasted follow-up
// notes. Everything downstream — product extraction, gap analysis, manual —
// reads this same context, so supplying follow-up info closes gaps.
async function collectPolicyText(policies, followUps = [], followUpText = "") {
  const sections = [];
  for (const file of policies) {
    sections.push(`Policy file: ${file.originalname}\n${(await extractReadableText(file)) || "No readable text extracted from this file."}`);
  }
  for (const file of followUps) {
    sections.push(`Follow-up document from the department: ${file.originalname}\n${(await extractReadableText(file)) || "No readable text extracted from this file."}`);
  }
  if (followUpText.trim()) {
    sections.push(`Follow-up notes from the department (pasted):\n${followUpText.trim().slice(0, 8000)}`);
  }
  return sections.join("\n\n");
}

async function extractPolicyInstructions(departmentName, policyText, pages) {
  const productContext = pages
    .map((item) => `${item.title}: ${item.logoDescription}. Product: ${item.productLabel}. Notes: ${item.productionNotes}`)
    .join("\n\n");

  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: `You are preparing an internal production manual for ${departmentName} gear onboarding.

Use the policy document text when readable. If a detail is not stated in the policy text, say the instruction is based on available onboarding context and should be verified with the department.

For each product/logo below, write concise production instructions covering placement, approval considerations, restrictions, and any policy-specific notes. Return JSON only as an array of objects with keys "title" and "instructions".

Products:
${productContext}

Policy document text:
${policyText || "No policy files were uploaded."}`
      }
    ],
    max_tokens: 1600
  });
  const text = response.choices[0]?.message?.content?.trim() || "[]";
  try {
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return pages.map((item) => ({
      title: item.title,
      instructions: text
    }));
  }
}

function parseJsonObject(text) {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
  return JSON.parse(cleaned);
}

function defaultPolicyProducts() {
  return [
    {
      productType: "shirt",
      productLabel: "Cotton T-Shirt",
      productPrompt: "a heavyweight cotton t-shirt laid flat",
      garmentColor: "",
      brandStyle: "",
      fabricDetails: "",
      placement: "",
      decorationMethod: "",
      sizes: [],
      sizeChart: null,
      productionNotes: "Default onboarding product. The policy documents did not define products — verify with the department before production.",
      logoSlugs: ["all"],
      logoAssignmentStated: false,
      assignmentNotes: ""
    }
  ];
}

function normalizePolicyProducts(items) {
  return items
    .filter((item) => item.productLabel && item.productPrompt)
    // A "product" whose name carries no word (a bare list number like "5") is a
    // mis-parse of the policy's numbering, not a garment.
    .filter((item) => (String(item.productLabel).match(/[a-z]/gi) || []).length >= 3)
    .map((item) => {

      const sizeChart =
        item.sizeChart && Array.isArray(item.sizeChart.headers) && Array.isArray(item.sizeChart.rows)
          ? {
              headers: item.sizeChart.headers.map((h) => String(h).trim()).filter(Boolean),
              rows: item.sizeChart.rows
                .filter((row) => row && row.label && Array.isArray(row.values))
                .map((row) => ({ label: String(row.label).trim(), values: row.values.map((v) => String(v).trim()) }))
            }
          : null;

      // Keep the model's references verbatim; server.resolveProductLogos does
      // the tolerant match against the actual uploaded files, so a code written
      // as "DIX-F01" still finds "dix-f01.png".
      const requestedLogos = Array.isArray(item.logoSlugs)
        ? item.logoSlugs.map((value) => String(value).trim()).filter(Boolean)
        : [];
      const offerAllLogos = !requestedLogos.length || requestedLogos.some((value) => value.toLowerCase() === "all");

      return {
        productType: item.productType || "product",
        productLabel: item.productLabel,
        productPrompt: item.productPrompt,
        garmentColor: item.garmentColor || "",
        brandStyle: item.brandStyle || "",
        fabricDetails: item.fabricDetails || "",
        placement: item.placement || "",
        decorationMethod: item.decorationMethod || "",
        sizes: Array.isArray(item.sizes) ? item.sizes.map((s) => String(s).trim()).filter(Boolean) : [],
        sizeChart,
        productionNotes: item.productionNotes || "Verify exact garment requirements against the uploaded policy documents.",
        logoSlugs: offerAllLogos ? ["all"] : requestedLogos,
        logoAssignmentStated: !offerAllLogos,
        assignmentNotes: offerAllLogos
          ? "No logo assignment stated for this garment — every uploaded logo is offered as a Front Logo variant."
          : String(item.assignmentNotes || "").trim() || `Assigned by the department: ${requestedLogos.join(", ")}`
      };
    });
}

async function determinePolicyProducts(departmentName, policyText, logos = []) {
  if (!policyText.trim()) {
    return defaultPolicyProducts();
  }

  const logoCatalog = logos
    .map(
      (logo) => `- slug: ${logo.slug}
  filename: ${logo.originalName || logo.filenameBase}
  label: ${logo.filenameBase}
  visual description: ${logo.logoDescription || "No visual description available."}`
    )
    .join("\n");

  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: `Extract the exact apparel/products that should be created for ${departmentName} from these onboarding policy documents (including any follow-up answers from the department).

CRITICAL RULE — no invention: only use details explicitly stated in the documents. If a detail (color, brand, fabric, sizes, placement, decoration method, size chart) is NOT stated, return an empty string (or empty array / null) for that field. Never guess or fill in typical values.

LOGO ASSIGNMENT — the documents often state which uploaded logo belongs on which garment, usually by a short code that matches the logo's filename (e.g. "DIX-F01 on style NL3600", "F02 -> job shirt", a two-column list of style numbers and logo codes). Read those assignments carefully and honour them:
- If the documents state which logo(s) go on THIS garment, return logoSlugs as the exact slug values from the uploaded logo catalog below — only the logos assigned to this garment.
- Match a garment to an assignment by style number first (e.g. "3600" matches brandStyle "Next Level NL3600"), then by garment name.
- If the documents say nothing about which logo goes on this garment, return ["all"] so every uploaded logo is offered as a choice.
- Never invent an assignment that is not stated, and never drop one that is.

Look specifically for shirts, long sleeve shirts, hats, pants, hoodies, jackets, job shirts, polos, or other gear.

Return JSON only: {"products": [...]} where each product object has:
- productType: short lowercase type such as "shirt", "hat", "pants"
- productLabel: customer-facing product name; include the garment brand when stated (e.g. "Next Level Cotton T-Shirt"), never the department name
- productPrompt: visual phrase describing the blank garment for image generation (garment only — never mention the logo)
- garmentColor: garment color if stated, else ""
- brandStyle: garment brand and/or style number if stated (e.g. "Next Level NL3600"), else ""
- fabricDetails: fabric/material details if stated (e.g. "4.3-ounce, 100% combed ring spun cotton"), else ""
- placement: logo placement if stated (e.g. "left chest", "full front", "right chest", "center chest"), else ""
- decorationMethod: embroidery/screen print/heat transfer if stated, else ""
- sizes: array of size strings if the policy states the size range, else []
- sizeChart: only if the documents contain an explicit size chart: {"headers": ["S","M",...], "rows": [{"label": "Chest", "values": ["19","20 1/2",...]}]}. Otherwise null. Copy numbers exactly.
- productionNotes: concise instructions based only on stated policy details
- logoSlugs: slug values of the logos assigned to THIS garment, or ["all"] if the documents do not say (see LOGO ASSIGNMENT above)
- logoAssignmentStated: true only if the documents explicitly say which logo goes on this garment, else false
- assignmentNotes: the wording that states the assignment (e.g. "Follow-up list: style 3600 -> DIX-F01"), else ""

If the documents do not clearly define products, return {"products": []}.

Uploaded logo catalog (use these exact slug values in logoSlugs):
${logoCatalog || 'No logo catalog available. Use ["all"] for logoSlugs.'}

Policy text:
${policyText}`
      }
    ],
    max_tokens: 2000
  });

  const text = response.choices[0]?.message?.content?.trim() || "{}";
  try {
    const parsed = parseJsonObject(text);
    const items = normalizePolicyProducts(Array.isArray(parsed.products) ? parsed.products : []);
    return items.length ? items : defaultPolicyProducts();
  } catch (error) {
    return defaultPolicyProducts();
  }
}

// Compare the policy text against everything production actually needs and
// report what is missing. When gaps exist, draft a ready-to-send email asking
// the department for exactly those details.
async function analyzePolicyGaps(departmentName, policyText, products, logos = []) {
  const productSummary = products
    .map(
      (p) =>
        `- ${p.productLabel} (type: ${p.productType}; color: ${p.garmentColor || "NOT STATED"}; brand/style: ${p.brandStyle || "NOT STATED"}; fabric: ${p.fabricDetails || "NOT STATED"}; placement: ${p.placement || "NOT STATED"}; decoration: ${p.decorationMethod || "NOT STATED"}; sizes: ${p.sizes.length ? p.sizes.join(", ") : "NOT STATED"}; logo assignment: ${
          p.logoAssignmentStated ? p.logoSlugs.join(", ") : "NOT STATED"
        })`
    )
    .join("\n");
  const logoList = logos.map((logo) => `- ${logo.filenameBase} (${logo.originalName})`).join("\n");

  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: `You are onboarding ${departmentName} for a custom uniform/gear store. Audit their policy documents for completeness before anything goes into production.

A complete policy must answer, for every garment:
1. Which garments are offered (shirts, hats, hoodies, jackets, pants, ...)
2. Garment color for each item
3. Garment brand/style number (needed for accurate fabric specs and size charts)
4. Logo placement on each garment (left chest, full front, back, ...)
5. Which uploaded logo goes on which garment
6. Decoration method (embroidery, screen print, heat transfer)
7. Size range offered
8. Name/rank personalization rules, if any
9. Any restrictions or approval requirements

Products extracted so far (fields marked NOT STATED are missing from the policy):
${productSummary || "- none extracted"}

Uploaded logos:
${logoList || "- none"}

Policy text:
${policyText || "No policy documents were provided."}

Return JSON only:
{
  "confidence": "high" | "medium" | "low",  // how safe it is to produce from this policy as-is
  "missing": [{ "topic": "short label", "detail": "what exactly is missing and for which garment" }],
  "emailDraft": { "subject": "...", "body": "..." } | null
}

Rules:
- List only details that are genuinely missing or ambiguous. Do not pad the list.
- confidence "high" means everything needed for production is stated; use it only when "missing" is empty or trivial.
- If anything meaningful is missing, write emailDraft: a courteous, professional plain-text email to the ${departmentName} contact from the FN Simple Uniforms onboarding team. Briefly explain that the policy document is missing a few production details, list each question as a numbered item, and ask them to reply or send an updated document. No placeholders like [NAME] except a [Contact name] greeting. If nothing is missing, emailDraft is null.`
      }
    ],
    max_tokens: 1400
  });

  const text = response.choices[0]?.message?.content?.trim() || "{}";
  try {
    const parsed = parseJsonObject(text);
    return {
      confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low",
      missing: Array.isArray(parsed.missing)
        ? parsed.missing
            .filter((m) => m && (m.topic || m.detail))
            .map((m) => ({ topic: String(m.topic || "Missing detail"), detail: String(m.detail || "") }))
        : [],
      emailDraft:
        parsed.emailDraft && parsed.emailDraft.body
          ? { subject: String(parsed.emailDraft.subject || `${departmentName} uniform policy — missing details`), body: String(parsed.emailDraft.body) }
          : null
    };
  } catch (error) {
    return {
      confidence: "low",
      missing: [{ topic: "Gap analysis failed", detail: "The completeness check could not be parsed. Review the policy manually before publishing." }],
      emailDraft: null
    };
  }
}

module.exports = {
  analyzeLogo,
  analyzePolicyGaps,
  collectPolicyText,
  determinePolicyProducts,
  extractReadableText,
  extractPolicyInstructions,
  generateBlankGarment,
  analyzeGarmentGeometry,
  integrateArtworkPatch,
  extractSupplierFacts,
  generateProductDescription,
  renderDecoratedGarment,
  planCustomProduct
};

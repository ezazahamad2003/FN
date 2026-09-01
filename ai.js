const { PDFParse } = require("pdf-parse");
const { generateImage, reason } = require("./azureOpenai");

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
  extractSupplierFacts,
  generateProductDescription,
  planCustomProduct
};

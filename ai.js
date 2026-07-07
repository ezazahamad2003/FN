const OpenAI = require("openai");
const fetch = require("node-fetch");
const { PDFParse } = require("pdf-parse");

function client() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing. Add a fresh key to .env before running onboarding.");
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

// Generate a BLANK garment photo only. The department logo is composited onto
// this base afterwards (mockup.js) so the exact uploaded artwork is preserved —
// the image model never attempts to redraw logos or text.
async function generateBlankGarment({ productPrompt, garmentColor }) {
  const openai = client();
  const colorPhrase = garmentColor ? ` in ${garmentColor}` : "";
  const response = await openai.images.generate({
    model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
    size: "1024x1024",
    quality: "medium",
    n: 1,
    prompt: `A professional studio product photograph of ${productPrompt}${colorPhrase}. The garment is completely blank: no logo, no text, no lettering, no numbers, no graphics, no embroidery, no patches, no printed design of any kind. Photographed straight on from the front, laid perfectly flat and centered, filling about 80 percent of the frame. Clean pure white background, soft even studio lighting, sharp commercial product photography.`
  });
  const image = response.data?.[0];
  if (image?.b64_json) {
    return Buffer.from(image.b64_json, "base64");
  }
  const url = image?.url;
  if (!url) throw new Error("OpenAI image generation did not return image data.");

  const imageRes = await fetch(url);
  if (!imageRes.ok) throw new Error(`Could not download generated garment image: ${imageRes.status}`);
  return imageRes.buffer();
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
  const specs = [
    product.fabricDetails,
    product.garmentColor ? `Garment color: ${product.garmentColor}` : "",
    product.placement ? `Logo placement: ${product.placement}` : "",
    product.decorationMethod ? `Decoration: ${product.decorationMethod}` : ""
  ].filter(Boolean);

  const knownFacts = [
    ["Product", product.productLabel],
    ["Garment color", product.garmentColor],
    ["Garment brand/style", product.brandStyle],
    ["Fabric details", product.fabricDetails],
    ["Policy notes", product.productionNotes]
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
        content: `Write exactly 2 professional, proud sentences of Shopify product description prose for official ${departmentName} gear, using ONLY the facts below. Do not invent fabric weights, materials, brand names, colors, or any spec that is not listed. Return plain text only — no HTML, no quotes, no markdown.

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

  const parts = [
    "<p><em>Logo size &amp; placement are an approximation.</em></p>",
    prose ? `<p>${escapeHtml(prose)}</p>` : "",
    product.brandStyle ? `<p><b>${escapeHtml(product.brandStyle)}</b></p>` : "",
    specs.length ? `<ul>${specs.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : "",
    sizeChartHtml(product.sizeChart)
  ];
  return parts.filter(Boolean).join("\n");
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
      assignmentNotes: ""
    }
  ];
}

function normalizePolicyProducts(items) {
  return items
    .filter((item) => item.productLabel && item.productPrompt)
    .map((item) => {
      const logoSlugs = Array.isArray(item.logoSlugs)
        ? item.logoSlugs
        : item.logoSlug
          ? [item.logoSlug]
          : ["all"];

      const sizeChart =
        item.sizeChart && Array.isArray(item.sizeChart.headers) && Array.isArray(item.sizeChart.rows)
          ? {
              headers: item.sizeChart.headers.map((h) => String(h).trim()).filter(Boolean),
              rows: item.sizeChart.rows
                .filter((row) => row && row.label && Array.isArray(row.values))
                .map((row) => ({ label: String(row.label).trim(), values: row.values.map((v) => String(v).trim()) }))
            }
          : null;

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
        logoSlugs: logoSlugs.map((slug) => String(slug).trim()).filter(Boolean),
        assignmentNotes: item.assignmentNotes || ""
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

LOGO ASSIGNMENT — the store sells every garment with a "Front Logo" choice, so by default EVERY uploaded logo is offered on EVERY product: use ["all"]. Only restrict logoSlugs when the policy explicitly limits which logo may appear on a product (e.g. "hats shall carry only the Engine 1 logo").

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
- logoSlugs: ["all"] by default (see LOGO ASSIGNMENT above); an explicit list of logo slug values only when the policy restricts logos for this product
- assignmentNotes: concise reason for why those logoSlugs apply

If the documents do not clearly define products, return {"products": []}.

Uploaded logo catalog:
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
        `- ${p.productLabel} (type: ${p.productType}; color: ${p.garmentColor || "NOT STATED"}; brand/style: ${p.brandStyle || "NOT STATED"}; fabric: ${p.fabricDetails || "NOT STATED"}; placement: ${p.placement || "NOT STATED"}; decoration: ${p.decorationMethod || "NOT STATED"}; sizes: ${p.sizes.length ? p.sizes.join(", ") : "NOT STATED"})`
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
  extractPolicyInstructions,
  generateBlankGarment,
  generateProductDescription
};

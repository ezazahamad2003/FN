const OpenAI = require("openai");
const fetch = require("node-fetch");

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
            text: "Describe this fire department logo in detail: colors, shapes, text, symbols, and overall style. Be specific -- this description will be used to generate a product mockup."
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

async function generateMockup(description) {
  const openai = client();
  const response = await openai.images.generate({
    model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
    size: "1024x1024",
    quality: "medium",
    n: 1,
    prompt: `A professional product photo of ${description.productPrompt}. The item has a fire department logo applied according to these production details: ${description.logoDescription}. Product and policy notes: ${description.productionNotes}. Clean studio lighting, sharp detail, commercial product photography style, white background.`
  });
  const image = response.data?.[0];
  if (image?.b64_json) {
    return Buffer.from(image.b64_json, "base64");
  }
  const url = image?.url;
  if (!url) throw new Error("OpenAI image generation did not return image data.");

  const imageRes = await fetch(url);
  if (!imageRes.ok) throw new Error(`Could not download generated mockup: ${imageRes.status}`);
  return imageRes.buffer();
}

async function generateProductDescription(departmentName, product) {
  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: `Write a 2-sentence Shopify product description for official ${departmentName} gear. The item is ${product.productLabel}. Use this product context: ${product.productionNotes}. Professional, proud tone. Return only an HTML <p> tag.`
      }
    ],
    max_tokens: 180
  });
  const text = response.choices[0]?.message?.content?.trim() || "";
  return text.startsWith("<p>") ? text : `<p>${text.replace(/^"|"$/g, "")}</p>`;
}

function extractReadableText(file) {
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

async function extractPolicyInstructions(departmentName, policies, productItems) {
  const policyText = policies
    .map((file) => `File: ${file.originalname}\n${extractReadableText(file) || "No readable text extracted from this file."}`)
    .join("\n\n");
  const productContext = productItems
    .map((item) => `${item.title}: ${item.logoDescription}. Product: ${item.productLabel}. Notes: ${item.productionNotes}`)
    .join("\n\n");

  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: `You are preparing an internal production manual for ${departmentName} gear onboarding.

Use the policy document text when readable. If a file has no readable text, say the instruction is based on available onboarding context and should be verified against the uploaded policy file.

For each product/logo below, write concise production instructions covering placement, approval considerations, restrictions, and any policy-specific notes. Return JSON only as an array of objects with keys "title" and "instructions".

Products:
${productContext}

Policy document text:
${policyText || "No policy files were uploaded."}`
      }
    ],
    max_tokens: 1200
  });
  const text = response.choices[0]?.message?.content?.trim() || "[]";
  try {
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return productItems.map((item) => ({
      title: item.filenameBase,
      instructions: text
    }));
  }
}

function parseJsonArray(text) {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
  const parsed = JSON.parse(cleaned);
  return Array.isArray(parsed) ? parsed : [];
}

async function determinePolicyProducts(departmentName, policies) {
  const policyText = policies
    .map((file) => `File: ${file.originalname}\n${extractReadableText(file) || "No readable text extracted from this file."}`)
    .join("\n\n");

  if (!policyText.trim()) {
    return [
      {
        productType: "shirt",
        productLabel: "Black heavyweight t-shirt",
        productPrompt: "a black heavyweight t-shirt laid flat",
        productionNotes: "Default onboarding product. Verify exact garment requirements against the uploaded policy documents."
      }
    ];
  }

  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: `Extract the apparel/products that should be generated for ${departmentName} from these onboarding policy documents.

Look specifically for shirts, hats, pants, hoodies, jackets, or other gear. Include logo placement, garment color, allowed/required decoration notes, restrictions, and anything important for mockup generation.

Return JSON only as an array. Each object must have:
- productType: short lowercase type such as "shirt", "hat", "pants"
- productLabel: customer-facing product name
- productPrompt: visual prompt phrase for image generation
- productionNotes: concise instructions based on policy details

If the documents do not clearly define products, return one default black heavyweight t-shirt item and say the policy should be verified.

Policy text:
${policyText}`
      }
    ],
    max_tokens: 1000
  });

  const text = response.choices[0]?.message?.content?.trim() || "[]";
  try {
    const items = parseJsonArray(text).filter((item) => item.productLabel && item.productPrompt);
    return items.length
      ? items
      : [
          {
            productType: "shirt",
            productLabel: "Black heavyweight t-shirt",
            productPrompt: "a black heavyweight t-shirt laid flat",
            productionNotes: "Default onboarding product. Verify exact garment requirements against the uploaded policy documents."
          }
        ];
  } catch (error) {
    return [
      {
        productType: "shirt",
        productLabel: "Black heavyweight t-shirt",
        productPrompt: "a black heavyweight t-shirt laid flat",
        productionNotes: "Default onboarding product. Verify exact garment requirements against the uploaded policy documents."
      }
    ];
  }
}

module.exports = {
  analyzeLogo,
  determinePolicyProducts,
  extractPolicyInstructions,
  generateMockup,
  generateProductDescription
};

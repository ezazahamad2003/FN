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
    prompt: `A professional product photo of a black heavyweight t-shirt laid flat on a white background. The shirt has a fire department logo printed on the center chest. The logo is: ${description}. Clean studio lighting, sharp detail, no wrinkles, commercial product photography style.`
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

async function generateProductDescription(departmentName) {
  const openai = client();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: `Write a 2-sentence Shopify product description for official ${departmentName} gear. The item is a premium heavyweight t-shirt with the department logo printed on the chest. Professional, proud tone. Return only an HTML <p> tag.`
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
    .map((item) => `${item.filenameBase}: ${item.logoDescription}`)
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

module.exports = {
  analyzeLogo,
  extractPolicyInstructions,
  generateMockup,
  generateProductDescription
};

const fetch = require("node-fetch");
const OpenAI = require("openai");

function cleanEndpoint(value) {
  return String(value || "").replace(/\/+$/, "");
}

function azureOpenAIConfigured() {
  return Boolean(
    process.env.AZURE_OPENAI_ENDPOINT &&
      process.env.AZURE_OPENAI_API_KEY &&
      process.env.AZURE_OPENAI_CHAT_DEPLOYMENT
  );
}

function audioEndpoint() {
  return cleanEndpoint(process.env.AZURE_OPENAI_AUDIO_ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT);
}

function audioApiKey() {
  return process.env.AZURE_OPENAI_AUDIO_API_KEY || process.env.AZURE_OPENAI_API_KEY;
}

function azureAudioConfigured() {
  return Boolean(
    audioEndpoint() &&
      audioApiKey() &&
      (process.env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT || process.env.AZURE_OPENAI_VOICE_DEPLOYMENT)
  );
}

function speechEndpoint() {
  return cleanEndpoint(process.env.AZURE_OPENAI_SPEECH_ENDPOINT || process.env.AZURE_OPENAI_AUDIO_ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT);
}

function speechApiKey() {
  return process.env.AZURE_OPENAI_SPEECH_API_KEY || process.env.AZURE_OPENAI_AUDIO_API_KEY || process.env.AZURE_OPENAI_API_KEY;
}

function azureSpeechConfigured() {
  return Boolean(
    speechEndpoint() &&
      speechApiKey() &&
      process.env.AZURE_OPENAI_SPEECH_MODEL
  );
}

function openAIConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/* -----------------------------------------------------------------------------
   Image generation.

   gpt-image-1 is not offered in every Azure OpenAI region, so the image model
   commonly lives in a different resource from the chat model - exactly like
   audio already does here. IMAGE_* falls back to the primary resource when it
   is not set separately.
   -------------------------------------------------------------------------- */
function imageEndpoint() {
  return cleanEndpoint(process.env.AZURE_OPENAI_IMAGE_ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT);
}

function imageApiKey() {
  return process.env.AZURE_OPENAI_IMAGE_API_KEY || process.env.AZURE_OPENAI_API_KEY;
}

function imageDeployment() {
  return process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT || "";
}

// The image routes live on preview API versions; both generations and edits
// are pinned to the same one so a swap only has to change a single variable.
function imageApiVersion() {
  return process.env.AZURE_OPENAI_IMAGE_API_VERSION || "2025-04-01-preview";
}

function azureImageConfigured() {
  return Boolean(imageEndpoint() && imageApiKey() && imageDeployment());
}

function imageGenConfigured() {
  return azureImageConfigured() || openAIConfigured();
}

function genAIStatus() {
  if (azureOpenAIConfigured()) {
    const transcriptionDeployment = process.env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT || process.env.AZURE_OPENAI_VOICE_DEPLOYMENT || "";
    const speechDeployment = process.env.AZURE_OPENAI_SPEECH_MODEL || "";
    return {
      configured: true,
      provider: "azure-openai",
      chatDeployment: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || "",
      imageDeployment: imageDeployment(),
      imageProvider: azureImageConfigured() ? "azure-openai" : openAIConfigured() ? "openai" : "none",
      imageConfigured: imageGenConfigured(),
      voiceDeployment: process.env.AZURE_OPENAI_VOICE_DEPLOYMENT || "",
      transcriptionDeployment,
      speechDeployment,
      voiceInputConfigured: azureAudioConfigured(),
      audioEndpoint: audioEndpoint() ? "configured" : "",
      voiceOutputConfigured: azureSpeechConfigured(),
      speechEndpoint: speechEndpoint() ? "configured" : ""
    };
  }
  return {
    configured: false,
    provider: "none",
    chatDeployment: "",
    imageDeployment: imageDeployment(),
    imageProvider: azureImageConfigured() ? "azure-openai" : openAIConfigured() ? "openai" : "none",
    imageConfigured: imageGenConfigured(),
    voiceDeployment: "",
    transcriptionDeployment: "",
    speechDeployment: "",
    voiceInputConfigured: false,
    voiceOutputConfigured: false,
    openAIFallbackConfigured: openAIConfigured()
  };
}

async function azureChatCompletion({ messages, temperature = 0.2, maxTokens = 900, jsonObject = false }) {
  const endpoint = cleanEndpoint(process.env.AZURE_OPENAI_ENDPOINT);
  const deployment = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";
  const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  const body = { messages };
  if (/^gpt-5/i.test(deployment) || deployment === "fn-chat") {
    // Reasoning models spend completion tokens on hidden reasoning BEFORE the
    // answer. A caller asking for a 900-token answer got an empty response
    // whenever reasoning ate the whole budget, so the budget here covers
    // reasoning + answer, never just the answer.
    body.max_completion_tokens = Math.max(maxTokens + 2000, maxTokens * 3);
  } else {
    body.temperature = temperature;
    body.max_tokens = maxTokens;
  }
  if (jsonObject) body.response_format = { type: "json_object" };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": process.env.AZURE_OPENAI_API_KEY
    },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.error?.message || JSON.stringify(json).slice(0, 500) || "unknown error";
    throw new Error(`Azure OpenAI chat failed (${res.status}): ${detail}`);
  }
  return json.choices?.[0]?.message?.content?.trim() || "";
}

async function chatCompletion(options) {
  if (azureOpenAIConfigured()) return azureChatCompletion(options);
  throw new Error("Azure OpenAI chat is not configured. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_CHAT_DEPLOYMENT.");
}

/* -----------------------------------------------------------------------------
   Reasoning entry point used by the onboarding pipeline.

   Differs from chatCompletion in two ways that matter to callers in ai.js:
     • it falls back to direct OpenAI without needing an opt-in flag, because
       the onboarding run should not hard-fail when only one provider is set up;
     • it accepts multimodal `content` arrays (text + image_url parts) unchanged,
       which both providers accept in the same shape.
   -------------------------------------------------------------------------- */
async function reason({ messages, temperature = 0.2, maxTokens = 900, jsonObject = false }) {
  const payload = { messages, temperature, maxTokens };
  if (azureOpenAIConfigured()) {
    try {
      const content = await azureChatCompletion({ ...payload, jsonObject });
      // An empty completion is a provider failure in this pipeline (a
      // reasoning model that ran out of budget, a content filter, a hiccup) -
      // fall back rather than hand "" to a caller that will parse it.
      if (content) return content;
      throw new Error("Azure chat returned an empty completion.");
    } catch (error) {
      if (!openAIConfigured()) throw error;
      console.warn("Azure chat failed, falling back to OpenAI:", error.message);
    }
  }
  if (!openAIConfigured()) {
    throw new Error("No reasoning model is configured. Set AZURE_OPENAI_* (endpoint, key, chat deployment) or OPENAI_API_KEY.");
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4o",
    messages,
    temperature,
    max_tokens: maxTokens,
    ...(jsonObject ? { response_format: { type: "json_object" } } : {})
  });
  return response.choices[0]?.message?.content?.trim() || "";
}

async function azureGenerateImage({ prompt, size = "1024x1024", quality = "medium" }) {
  const url = `${imageEndpoint()}/openai/deployments/${encodeURIComponent(imageDeployment())}/images/generations?api-version=${encodeURIComponent(imageApiVersion())}`;

  let res;
  let json;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": imageApiKey() },
      body: JSON.stringify({ prompt, n: 1, size, quality, output_format: "png" })
    });
    json = await res.json().catch(() => ({}));
    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) break;
    const wait = retryAfterMs(res, attempt);
    console.warn(`Azure image generation rate-limited; retrying in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
  if (!res.ok) {
    const detail = json.error?.message || JSON.stringify(json).slice(0, 500) || "unknown error";
    throw new Error(`Azure OpenAI image generation failed (${res.status}): ${detail}`);
  }
  const image = json.data?.[0];
  if (image?.b64_json) return Buffer.from(image.b64_json, "base64");
  if (image?.url) {
    const download = await fetch(image.url);
    if (!download.ok) throw new Error(`Could not download generated image: ${download.status}`);
    return download.buffer();
  }
  throw new Error("Azure OpenAI image generation returned no image data.");
}

async function openAIGenerateImage({ prompt, size = "1024x1024", quality = "medium" }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.images.generate({
    model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
    size,
    quality,
    n: 1,
    prompt
  });
  const image = response.data?.[0];
  if (image?.b64_json) return Buffer.from(image.b64_json, "base64");
  if (!image?.url) throw new Error("OpenAI image generation did not return image data.");
  const download = await fetch(image.url);
  if (!download.ok) throw new Error(`Could not download generated garment image: ${download.status}`);
  return download.buffer();
}

// Azure first (same tenancy and billing as the rest of the deploy), OpenAI as a
// fallback so a missing image deployment does not take the whole run down.
async function generateImage(options) {
  if (azureImageConfigured()) {
    try {
      return await azureGenerateImage(options);
    } catch (error) {
      if (!openAIConfigured()) throw error;
      console.warn("Azure image generation failed, falling back to OpenAI:", error.message);
    }
  }
  if (!openAIConfigured()) {
    throw new Error(
      "No image model is configured. Set AZURE_OPENAI_IMAGE_DEPLOYMENT (plus AZURE_OPENAI_IMAGE_ENDPOINT / AZURE_OPENAI_IMAGE_API_KEY if the image model lives in another resource), or OPENAI_API_KEY."
    );
  }
  return openAIGenerateImage(options);
}

/* -----------------------------------------------------------------------------
   Rate limiting.

   A 429 is a "come back shortly", not a failure. Falling through to direct
   OpenAI on one - which is what used to happen - silently moves paid work off
   the Azure deployment the moment a batch gets busy, which is the opposite of
   what a bulk run wants. Azure states how long to wait; we wait and retry, and
   only give up (and let the caller fall back) after several attempts.
   -------------------------------------------------------------------------- */
const RATE_LIMIT_RETRIES = 5;
const TRANSPORT_RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(res, attempt) {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header, 90) * 1000;
  return Math.min(8000 * 2 ** attempt, 60000); // 8s, 16s, 32s, 60s, 60s
}

/* -----------------------------------------------------------------------------
   Image EDITS: the decorated-product renderer.

   Unlike generation, an edit takes the REAL inputs - the supplier's garment
   photo and the department's actual logo files - and returns the same photo
   with the artwork rendered as if genuinely printed/embroidered on the
   fabric. input_fidelity "high" is what keeps logo text and small marks
   faithful on the models that still take it.

   Azure first (same tenancy and billing as the rest of the deploy), direct
   OpenAI as a fallback so a missing image deployment does not take a run down.
   The two providers speak the same multipart dialect; only the URL, the auth
   header, and where the model name goes differ.
   -------------------------------------------------------------------------- */
// Parameters a model rejects are learned once per provider+model and skipped
// afterwards. Keyed per provider because the same model name can differ across
// them: direct-OpenAI gpt-image-2 refuses input_fidelity (high fidelity is
// native there) while Azure's gpt-image-2 still accepts it.
const unsupportedEditParams = new Map();

async function postImageEdit({ url, headers, model, cacheKey, images, prompt, size, quality }) {
  const skip = unsupportedEditParams.get(cacheKey) || new Set();
  // Counted separately from parameter learning: waiting out a rate limit must
  // not consume the attempts reserved for discovering a refused parameter.
  let rateLimited = 0;
  let transportRetries = 0;

  for (let attempt = 0; attempt < 4; attempt++) {
    const form = new FormData();
    // Azure carries the model in the deployment path, so it only goes in the
    // body when the caller supplies one.
    if (model) form.append("model", model);
    images.forEach((image, index) => {
      form.append("image[]", new Blob([image.buffer], { type: image.mimeType || "image/png" }), image.name || `image-${index}.png`);
    });
    form.append("prompt", prompt);
    form.append("n", "1");
    for (const [key, value] of [["size", size], ["quality", quality], ["input_fidelity", "high"]]) {
      if (!skip.has(key)) form.append(key, value);
    }

    /* A dropped socket is not a verdict. Long multipart uploads that run for
       two minutes get reset by networks and proxies, and undici surfaces every
       one of them as a bare "fetch failed" with no status. Treated as failure,
       a single blip ships an UNDECORATED garment to a customer, so transport
       errors are retried like rate limits are. */
    let res;
    try {
      res = await globalThis.fetch(url, { method: "POST", headers, body: form });
    } catch (transport) {
      if (transportRetries >= TRANSPORT_RETRIES) {
        const cause = transport.cause?.code || transport.cause?.message || "";
        throw new Error(`Image edit transport failure after ${TRANSPORT_RETRIES} retries: ${transport.message}${cause ? ` (${cause})` : ""}`);
      }
      const wait = Math.min(4000 * 2 ** transportRetries, 30000);
      transportRetries++;
      console.warn(`Image edit connection failed (${transport.message}); retrying in ${Math.round(wait / 1000)}s (${transportRetries}/${TRANSPORT_RETRIES})`);
      await sleep(wait);
      attempt--; // this round never reached the model
      continue;
    }
    const json = await res.json().catch(() => ({}));

    if (res.status === 429 && rateLimited < RATE_LIMIT_RETRIES) {
      const wait = retryAfterMs(res, rateLimited);
      rateLimited++;
      console.warn(`Image edit rate-limited; retrying in ${Math.round(wait / 1000)}s (${rateLimited}/${RATE_LIMIT_RETRIES})`);
      await sleep(wait);
      attempt--; // this round never tested the parameter set
      continue;
    }

    if (!res.ok) {
      const detail = json.error?.message || JSON.stringify(json).slice(0, 400) || "unknown error";
      const unsupported =
        detail.match(/does not support the '([a-z_]+)' parameter/i) ||
        detail.match(/[Uu]nknown parameter: '([a-z_]+)'/) ||
        detail.match(/[Uu]nsupported parameter: '([a-z_]+)'/) ||
        detail.match(/Invalid parameter: '([a-z_]+)'/);
      // Only retry on a parameter we were actually still sending, otherwise a
      // model that always names the same field would burn every attempt.
      if (unsupported && !skip.has(unsupported[1])) {
        skip.add(unsupported[1]);
        unsupportedEditParams.set(cacheKey, skip);
        continue;
      }
      throw new Error(`Image edit failed (${res.status}): ${detail}`);
    }
    const image = json.data?.[0];
    if (!image?.b64_json) throw new Error("Image edit returned no image data.");
    return Buffer.from(image.b64_json, "base64");
  }
  throw new Error("Image edit failed: could not find a parameter set the model accepts.");
}

async function azureEditImage(options) {
  const deployment = imageDeployment();
  return postImageEdit({
    ...options,
    url: `${imageEndpoint()}/openai/deployments/${encodeURIComponent(deployment)}/images/edits?api-version=${encodeURIComponent(imageApiVersion())}`,
    headers: { "api-key": imageApiKey() },
    model: "",
    cacheKey: `azure:${deployment}`
  });
}

async function openAIEditImage(options) {
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  return postImageEdit({
    ...options,
    url: "https://api.openai.com/v1/images/edits",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    model,
    cacheKey: `openai:${model}`
  });
}

async function editImage({ images, prompt, size = "1024x1024", quality = "high" }) {
  if (!globalThis.fetch || !globalThis.FormData || !globalThis.Blob) {
    throw new Error("Node 18 fetch, FormData, and Blob are required for image edits.");
  }
  const options = { images, prompt, size, quality };

  if (azureImageConfigured()) {
    try {
      return await azureEditImage(options);
    } catch (error) {
      if (!openAIConfigured()) throw error;
      console.warn("Azure image edit failed, falling back to OpenAI:", error.message);
    }
  }
  if (!openAIConfigured()) {
    throw new Error(
      "No image model is configured for edits. Set AZURE_OPENAI_IMAGE_DEPLOYMENT (plus AZURE_OPENAI_IMAGE_ENDPOINT / AZURE_OPENAI_IMAGE_API_KEY if the image model lives in another resource), or OPENAI_API_KEY."
    );
  }
  return openAIEditImage(options);
}

async function azureTranscribeAudio({ buffer, mimeType = "audio/webm", filename = "voice.webm", language = "en" }) {
  if (!azureAudioConfigured()) {
    throw new Error("Azure OpenAI voice input is not configured. Set AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT or AZURE_OPENAI_VOICE_DEPLOYMENT.");
  }
  if (!globalThis.fetch || !globalThis.FormData || !globalThis.Blob) {
    throw new Error("Node 18 fetch, FormData, and Blob are required for Azure OpenAI audio transcription.");
  }

  const endpoint = audioEndpoint();
  const deployment = process.env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT || process.env.AZURE_OPENAI_VOICE_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_AUDIO_API_VERSION || process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";
  const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/audio/transcriptions?api-version=${encodeURIComponent(apiVersion)}`;

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), filename);
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (language) form.append("language", language);

  const res = await globalThis.fetch(url, {
    method: "POST",
    headers: { "api-key": audioApiKey() },
    body: form
  });
  const contentType = res.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const detail = payload?.error?.message || (typeof payload === "string" ? payload.slice(0, 500) : JSON.stringify(payload).slice(0, 500)) || "unknown error";
    throw new Error(`Azure OpenAI transcription failed (${res.status}): ${detail}`);
  }
  return (typeof payload === "string" ? payload : payload.text || "").trim();
}

async function azureTextToSpeech({ text, voice, speed = 1.04, format = "mp3" }) {
  if (!azureSpeechConfigured()) return null;
  if (!globalThis.fetch) throw new Error("Node 18 fetch is required for Azure OpenAI speech synthesis.");

  const endpoint = speechEndpoint();
  const apiVersion = process.env.AZURE_OPENAI_SPEECH_API_VERSION || "preview";
  const model = process.env.AZURE_OPENAI_SPEECH_MODEL;
  const url = `${endpoint}/openai/v1/audio/speech?api-version=${encodeURIComponent(apiVersion)}`;
  const responseFormat = ["mp3", "opus", "aac", "flac", "wav", "pcm"].includes(format) ? format : "mp3";

  const res = await globalThis.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": speechApiKey()
    },
    body: JSON.stringify({
      model,
      input: String(text || "").slice(0, 4096),
      voice: voice || process.env.AZURE_OPENAI_SPEECH_VOICE || "alloy",
      response_format: responseFormat,
      speed
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Azure OpenAI speech failed (${res.status}): ${detail.slice(0, 500) || "unknown error"}`);
  }
  return {
    mimeType: `audio/${responseFormat === "mp3" ? "mpeg" : responseFormat}`,
    base64: Buffer.from(await res.arrayBuffer()).toString("base64")
  };
}

module.exports = {
  editImage,
  azureTextToSpeech,
  azureTranscribeAudio,
  chatCompletion,
  genAIStatus,
  generateImage,
  reason
};

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
      (process.env.AZURE_OPENAI_SPEECH_DEPLOYMENT ||
        process.env.AZURE_OPENAI_TTS_DEPLOYMENT ||
        process.env.AZURE_OPENAI_SPEECH_MODEL)
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

function azureImageConfigured() {
  return Boolean(imageEndpoint() && imageApiKey() && imageDeployment());
}

function imageGenConfigured() {
  return azureImageConfigured() || openAIConfigured();
}

function genAIStatus() {
  if (azureOpenAIConfigured()) {
    const transcriptionDeployment = process.env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT || process.env.AZURE_OPENAI_VOICE_DEPLOYMENT || "";
    const speechDeployment =
      process.env.AZURE_OPENAI_SPEECH_DEPLOYMENT ||
      process.env.AZURE_OPENAI_TTS_DEPLOYMENT ||
      process.env.AZURE_OPENAI_SPEECH_MODEL ||
      "";
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
    body.max_completion_tokens = maxTokens;
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

async function openAIChatCompletion({ messages, temperature = 0.2, maxTokens = 900 }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4o",
    messages,
    temperature,
    max_tokens: maxTokens
  });
  return response.choices[0]?.message?.content?.trim() || "";
}

async function chatCompletion(options) {
  if (azureOpenAIConfigured()) return azureChatCompletion(options);
  if (options?.allowOpenAIFallback && openAIConfigured()) return openAIChatCompletion(options);
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
      return await azureChatCompletion({ ...payload, jsonObject });
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
  const apiVersion = process.env.AZURE_OPENAI_IMAGE_API_VERSION || process.env.AZURE_OPENAI_API_VERSION || "2025-04-01-preview";
  const url = `${imageEndpoint()}/openai/deployments/${encodeURIComponent(imageDeployment())}/images/generations?api-version=${encodeURIComponent(apiVersion)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": imageApiKey() },
    body: JSON.stringify({ prompt, n: 1, size, quality, output_format: "png" })
  });
  const json = await res.json().catch(() => ({}));
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
  const model =
    process.env.AZURE_OPENAI_SPEECH_DEPLOYMENT ||
    process.env.AZURE_OPENAI_TTS_DEPLOYMENT ||
    process.env.AZURE_OPENAI_SPEECH_MODEL;
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
  azureAudioConfigured,
  azureImageConfigured,
  azureOpenAIConfigured,
  azureSpeechConfigured,
  azureTextToSpeech,
  azureTranscribeAudio,
  chatCompletion,
  genAIStatus,
  generateImage,
  imageGenConfigured,
  openAIConfigured,
  reason
};

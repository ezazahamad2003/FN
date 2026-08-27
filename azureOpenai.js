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
      imageDeployment: process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT || "",
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
    imageDeployment: "",
    voiceDeployment: "",
    transcriptionDeployment: "",
    speechDeployment: "",
    voiceInputConfigured: false,
    voiceOutputConfigured: false,
    openAIFallbackConfigured: openAIConfigured()
  };
}

async function azureChatCompletion({ messages, temperature = 0.2, maxTokens = 900 }) {
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
  azureOpenAIConfigured,
  azureSpeechConfigured,
  azureTextToSpeech,
  azureTranscribeAudio,
  chatCompletion,
  genAIStatus
};

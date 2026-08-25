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

function openAIConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function genAIStatus() {
  if (azureOpenAIConfigured()) {
    return {
      configured: true,
      provider: "azure-openai",
      chatDeployment: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || "",
      imageDeployment: process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT || "",
      voiceDeployment: process.env.AZURE_OPENAI_VOICE_DEPLOYMENT || ""
    };
  }
  return {
    configured: false,
    provider: "none",
    chatDeployment: "",
    imageDeployment: "",
    voiceDeployment: "",
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

module.exports = {
  azureOpenAIConfigured,
  chatCompletion,
  genAIStatus
};

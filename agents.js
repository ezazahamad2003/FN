const { chatCompletion, genAIStatus } = require("./azureOpenai");
const { googleAccounts, googleConnected } = require("./auth");
const { listCollections } = require("./catalog");
const { shopifyConnected } = require("./shopify");

function agentHarness() {
  const status = platformStatus();
  return {
    name: "Dashboard Voice Agent",
    purpose: "Answer operator questions about the FN onboarding platform from live app context.",
    canDoNow: [
      "Report Shopify, Google Drive, GenAI, Postgres, Storage, and Key Vault status.",
      "Summarize Shopify collection and product counts when Shopify is connected.",
      "Explain onboarding readiness, gaps, and next operational checks.",
      "Read answers aloud from the dashboard voice session when Azure speech is configured."
    ],
    cannotDoWithoutUserAction: [
      "Modify Shopify products or collections from the dashboard voice panel.",
      "Upload, delete, or edit Google Drive files from the dashboard voice panel.",
      "Change Azure deployments, environment variables, or production infrastructure.",
      "Know private data that is not exposed by the connected app APIs or current platform context."
    ],
    liveContext: {
      shopify: status.shopifyConnected ? "connected" : "not connected",
      googleDrive: status.googleDriveConnected ? "connected" : "not connected",
      googleAccounts: status.googleAccountCount,
      genAI: status.genAI,
      postgresConfigured: status.postgresConfigured,
      storageConfigured: status.storageConfigured,
      keyVaultConfigured: status.keyVaultConfigured
    },
    routes: [
      { label: "Dashboard", route: "#/dashboard", surface: "voice and platform status" },
      { label: "Departments", route: "#/departments", surface: "Shopify collection browser and product editor" },
      { label: "Onboarding Agent", route: "#/onboarding", surface: "review-gated new department onboarding" }
    ]
  };
}

function platformStatus() {
  return {
    shopifyConnected: shopifyConnected(),
    googleDriveConnected: googleConnected(),
    googleAccountCount: googleAccounts().length,
    genAI: genAIStatus(),
    postgresConfigured: Boolean(process.env.DATABASE_URL || process.env.POSTGRES_CONNECTION_STRING),
    storageConfigured: Boolean(process.env.AZURE_STORAGE_CONNECTION_STRING),
    keyVaultConfigured: Boolean(process.env.AZURE_KEY_VAULT_NAME)
  };
}

async function shopifyContext() {
  if (!shopifyConnected()) return { available: false, collections: [], totalProducts: 0 };
  try {
    const collections = await listCollections();
    const totalProducts = collections.reduce((sum, collection) => sum + Number(collection.productCount || 0), 0);
    return {
      available: true,
      collectionCount: collections.length,
      totalProducts,
      collections: collections.slice(0, 80).map((collection) => ({
        id: collection.id,
        title: collection.title,
        handle: collection.handle,
        productCount: collection.productCount,
        updatedAt: collection.updatedAt
      }))
    };
  } catch (error) {
    return {
      available: true,
      fetchError: error.message,
      collectionCount: 0,
      totalProducts: 0,
      collections: []
    };
  }
}

function recentMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && ["user", "assistant"].includes(message.role) && message.content)
    .slice(-10)
    .map((message) => ({
      role: message.role,
      content: String(message.content).slice(0, 5000)
    }));
}

async function answerDashboardAgent({ messages, message }) {
  const userMessages = recentMessages(messages);
  if (!userMessages.length && message) {
    userMessages.push({ role: "user", content: String(message).slice(0, 5000) });
  }
  if (!userMessages.length) throw new Error("Ask the dashboard agent a question first.");

  const context = {
    harness: agentHarness(),
    status: platformStatus(),
    shopify: await shopifyContext()
  };

  const system = `You are the FN internal dashboard voice agent.

You are attached to the dashboard agent harness. Use the harness and platform context below as current truth. Speak like a capable operations assistant that knows this app's connected services, dashboard surfaces, and limits.

When asked what you can do, answer from harness.canDoNow and harness.cannotDoWithoutUserAction. When asked about the platform, use live context first. If the context does not contain enough information, say exactly what is missing and suggest the next check in the app.

Do not claim to have modified Shopify, Drive, Azure, files, deployments, or environment variables unless the context or explicit tool result says so. Keep replies short, spoken-friendly, and actionable. Avoid dumping long lists unless the operator asks for detail.`;

  const reply = await chatCompletion({
    messages: [
      { role: "system", content: system },
      { role: "system", content: `Current dashboard agent harness and platform context:\n${JSON.stringify(context, null, 2)}` },
      ...userMessages
    ],
    temperature: 0.2,
    maxTokens: 650
  });

  return {
    reply,
    context: {
      harness: context.harness,
      status: context.status,
      shopify: {
        available: context.shopify.available,
        collectionCount: context.shopify.collectionCount || 0,
        totalProducts: context.shopify.totalProducts || 0
      }
    }
  };
}

module.exports = {
  agentHarness,
  answerDashboardAgent,
  platformStatus
};

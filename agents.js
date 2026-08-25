const { chatCompletion, genAIStatus } = require("./azureOpenai");
const { googleAccounts, googleConnected } = require("./auth");
const { listCollections } = require("./catalog");
const { shopifyConnected } = require("./shopify");

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
    status: platformStatus(),
    shopify: await shopifyContext()
  };

  const system = `You are the FN internal dashboard agent.

You help operators understand this internal platform, Shopify department collections, Google Drive onboarding assets, Azure migration status, and next operational steps.

Use the platform context below as current truth. If the context does not contain enough information, say what is missing and suggest the exact next check. Do not claim to have modified Shopify, Drive, Azure, or files unless the context says so.

Be concise, practical, and direct.`;

  const reply = await chatCompletion({
    messages: [
      { role: "system", content: system },
      { role: "system", content: `Current platform context:\n${JSON.stringify(context, null, 2)}` },
      ...userMessages
    ],
    temperature: 0.2,
    maxTokens: 900
  });

  return {
    reply,
    context: {
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
  answerDashboardAgent,
  platformStatus
};

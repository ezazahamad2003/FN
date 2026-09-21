const { chatCompletion, genAIStatus } = require("./azureOpenai");
const { googleAccounts, googleConnected } = require("./auth");
const { listCollections } = require("./catalog");
const { listCustomerIntakes } = require("./customerIntakes");
const { shopifyConnected } = require("./shopify");

/*
 * The company brain: the internal chat assistant on the console dashboard.
 * It answers from three layers, in order of authority:
 *   1. live platform context gathered per question (connections, store queue,
 *      Shopify catalog),
 *   2. the operations manual below (how the platform actually works),
 *   3. general knowledge, clearly framed as such.
 */

const OPERATIONS_MANUAL = `FN Simple Uniforms operations manual (current truth about how the platform works):

WHAT THE PLATFORM IS
- Internal automation that turns a fire department's uniform request into a ready-to-publish Shopify store section: products, mockup images with their logos placed to spec, collection, and a Drive folder of assets.

CUSTOMER FLOW
- Departments fill the customer intake link at /intake (no login): store details, logo uploads, and per-garment choices (vendor, colors, decoration method, artwork placement and size tier, sizes).
- On submit the request is saved to Azure Blob Storage (container "customer-intakes"), the matching Shopify collection is created immediately, and if the form is complete a build starts automatically. Customers never need Google or Shopify access and never see internal errors.

INTERNAL FLOW
- New Stores (#/new-stores): the queue of submitted intakes. Open one to review/edit the answers, watch build progress, open its Shopify collection, print the intake document, or delete the store completely (requires typing the department name).
- Builds create products as DRAFT in Shopify - nothing is customer-visible until an operator publishes it in Shopify admin. Re-running a build is additive and skips already-built products.
- Product images: the build first tries to find the supplier's own flat-front photo of the exact blank garment (searching the customer's named vendor first); a vision check verifies garment, colour, no decoration, flat front. If nothing usable is found it generates a lookalike image instead - each product shows "supplier photo" or "generated lookalike" plus an "order this blank" source link when one exists.
- Google Drive: needed only during builds. When connected, each department gets a Drive folder (Logos + Product Images) and the intake document is archived there. Submissions and the queue work fine without Drive.
- Department Onboarding Agent (#/onboarding): builds a NEW department's private store to the FN Simple build spec. Phases: packet upload -> setup (department code looked up on the Department ID Agency List or proposed for approval, both Drive folders created, uniform policy reviewed, rep email drafted for Dan to send) -> build inputs (product rows, blank photos, embroidery proofs, validated live: SKUs previewed, decoration codes matched to the files in the Omni Printer folder, unknown colours proposed) -> build (2000x2000 front and back mockups per colour and Style, collection with a 3584x2048 banner and the Non-Stock Item Notice, Locksmith lock, every product as DRAFT with SKUs STYLE-SIZE-COLOR-CODE-DECORATIONS) -> report.
- What that agent never does: touch production print files (it works on copies), invent a department code, colour code or placement, save a shared setting (Mega Menu, Shopify Flow, Helium Customer Fields) without Dan approving the exact change, or publish a product. Dan always keeps pricing, cost, Easify options, final review, setting products Active, and sending the store link.
- Shared settings today: the app's Shopify token has no navigation scope, so the Mega Menu position is computed and handed to Dan as a checklist; Shopify Flow has no API (checklist); Helium Customer Fields has no write API, so the agent reads the public registration form, reports whether the department tag is present and exactly where it belongs alphabetically, and Dan edits all three forms. With LOCKSMITH_ACCESS_TOKEN set the collection lock is created through the Locksmith Admin API, otherwise the agent hands over the lock checklist.
- Source-of-truth tables (#/onboarding/reference): department codes, colour codes, the blank library, and the standard text. New department and colour codes are proposals until Dan approves them; an unapproved code never reaches a SKU.
- Departments view (#/departments): browse Shopify collections and edit products.

CONNECTIONS AND OPERATIONS
- /setup connects Shopify (OAuth) and Google Drive (OAuth; the Google app may show an "unverified app" warning - continue past it).
- Runs on Azure Container Apps (app "fn-platform", resource group "FN", region westus3). Deploys: az acr build to registry fnacr0ded0e58, then az containerapp update with the new image tag.
- Chat, transcription and speech run on Azure OpenAI; images (mockups, banners, blanks) run on direct OpenAI GPT-Image-2.5; supplier search uses the OpenAI Responses API.
- Intake records live in Azure Blob Storage; legacy pre-migration records in Drive under "Customer Store Intakes" remain readable when Drive is connected.`;

function agentHarness() {
  const status = platformStatus();
  return {
    name: "FN Company Brain",
    purpose: "Answer operator questions about the FN store platform from live app context and the operations manual.",
    canDoNow: [
      "Report Shopify, Google Drive, GenAI, Storage, and Key Vault status.",
      "Summarize the New Stores queue: counts, statuses, and recent submissions.",
      "Summarize Shopify collection and product counts when Shopify is connected.",
      "Explain how any part of the platform works and what to check or do next.",
      "Explain the department onboarding rules: SKU format, colour and decoration codes, folder and collection naming, what needs Dan's approval."
    ],
    cannotDoWithoutUserAction: [
      "Modify Shopify products or collections from the chat.",
      "Upload, delete, or edit Google Drive files from the chat.",
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
      { label: "Dashboard", route: "#/dashboard", surface: "company brain chat and platform status" },
      { label: "New Stores", route: "#/new-stores", surface: "customer intake queue, builds, and store pages" },
      { label: "Departments", route: "#/departments", surface: "Shopify collection browser and product editor" },
      { label: "Onboarding Agent", route: "#/onboarding", surface: "department onboarding: code, Drive folders, policy review, mockups, collection, lock, draft products, report" }
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

/* The store queue is what operators ask about most, so the brain always sees
   a live snapshot: counts by status plus the most recent submissions. */
async function intakeQueueContext() {
  try {
    const intakes = await listCustomerIntakes();
    const byStatus = {};
    for (const record of intakes) {
      const status = record.status || "unknown";
      byStatus[status] = (byStatus[status] || 0) + 1;
    }
    return {
      available: true,
      total: intakes.length,
      byStatus,
      recent: intakes.slice(0, 12).map((record) => ({
        department: record.store?.departmentName || "(unnamed)",
        status: record.status,
        submitted: record.createdAt,
        products: record.summary?.productCount ?? null,
        formComplete: record.summary?.ready ?? null,
        buildState: record.build?.state || null,
        shopifyCollection: record.shopifyCollection?.title || null
      }))
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

function recentMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && ["user", "assistant"].includes(message.role) && message.content)
    .slice(-16)
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
  if (!userMessages.length) throw new Error("Ask the company brain a question first.");

  const [shopify, intakeQueue] = await Promise.all([shopifyContext(), intakeQueueContext()]);
  const context = {
    harness: agentHarness(),
    status: platformStatus(),
    shopify,
    intakeQueue
  };

  const system = `You are the FN company brain - the internal operations assistant for FN Simple Uniforms' store-building platform.

Answer from the operations manual and the live platform context below; they are current truth. When asked what you can do, answer from harness.canDoNow and harness.cannotDoWithoutUserAction. If the context does not contain enough information, say exactly what is missing and name the next check in the app.

Do not claim to have modified Shopify, Drive, Azure, files, deployments, or environment variables - you cannot; point the operator at the right surface instead. Reply in plain text (no markdown headers or tables; short paragraphs and simple "-" lists are fine). Be concise and actionable; expand into detail only when asked.

${OPERATIONS_MANUAL}`;

  const reply = await chatCompletion({
    messages: [
      { role: "system", content: system },
      { role: "system", content: `Live platform context right now:\n${JSON.stringify(context, null, 2)}` },
      ...userMessages
    ],
    temperature: 0.2,
    maxTokens: 900
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
      },
      intakeQueue: {
        available: context.intakeQueue.available,
        total: context.intakeQueue.total || 0
      }
    }
  };
}

module.exports = {
  answerDashboardAgent,
  platformStatus
};

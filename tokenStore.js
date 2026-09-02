const { BlobServiceClient } = require("@azure/storage-blob");

/*
 * Durable store for the platform's OAuth tokens (Google refresh tokens,
 * Shopify access token).
 *
 * The tokens used to live only in the container's .env file, which Azure
 * wipes on every deploy and restart - so production silently "forgot" its
 * Google account whenever a new revision rolled. They now persist in the same
 * storage account the intake records use: connect once, on any environment,
 * and every later boot restores the connection.
 *
 * Container App environment variables still win: a token set as an env var is
 * never overridden by this store (see hydrateTokensFromStore in auth.js).
 */

const CONTAINER_NAME = "platform-config";
const BLOB_NAME = "oauth-tokens.json";

let containerPromise = null;

function tokenStoreConfigured() {
  return Boolean(String(process.env.AZURE_STORAGE_CONNECTION_STRING || "").trim());
}

async function container() {
  if (!tokenStoreConfigured()) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set, so tokens cannot be persisted.");
  }
  if (!containerPromise) {
    containerPromise = (async () => {
      const service = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
      const client = service.getContainerClient(CONTAINER_NAME);
      await client.createIfNotExists();
      return client;
    })();
    // A transient failure (network, bad key) must not poison every later call.
    containerPromise.catch(() => {
      containerPromise = null;
    });
  }
  return containerPromise;
}

async function loadStoredTokens() {
  if (!tokenStoreConfigured()) return {};
  try {
    const client = await container();
    const buffer = await client.getBlockBlobClient(BLOB_NAME).downloadToBuffer();
    const parsed = JSON.parse(buffer.toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error?.statusCode === 404) return {}; // never connected yet
    throw error;
  }
}

/*
 * Merge-write: a truthy value sets the key, a falsy one deletes it (that is
 * what Disconnect means). Other keys are left untouched, so saving the Google
 * token never drops the Shopify one.
 */
async function persistStoredTokens(partial) {
  if (!tokenStoreConfigured()) return;
  const next = { ...(await loadStoredTokens()) };
  for (const [key, value] of Object.entries(partial)) {
    if (value) next[key] = value;
    else delete next[key];
  }
  const body = Buffer.from(JSON.stringify(next, null, 2), "utf8");
  const client = await container();
  await client.getBlockBlobClient(BLOB_NAME).upload(body, body.length, {
    blobHTTPHeaders: { blobContentType: "application/json" }
  });
}

module.exports = { loadStoredTokens, persistStoredTokens, tokenStoreConfigured };

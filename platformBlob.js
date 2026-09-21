const { BlobServiceClient } = require("@azure/storage-blob");

/*
 * Small JSON-document store on the platform's storage account. Every durable
 * platform setting (tokens, link book, reference tables, onboarding records)
 * lives in blob storage because the container filesystem is wiped on each
 * deploy (see README "Running on Azure").
 *
 * jsonBlob(container, name) returns { read, write, exists } for one document.
 * jsonCollection(container, prefix) lists/reads/writes documents under a prefix.
 */

const containerClients = new Map();

function blobConfigured() {
  return Boolean(String(process.env.AZURE_STORAGE_CONNECTION_STRING || "").trim());
}

async function containerClient(containerName) {
  if (!blobConfigured()) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set, so platform data cannot be persisted.");
  }
  if (!containerClients.has(containerName)) {
    const promise = (async () => {
      const service = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
      const client = service.getContainerClient(containerName);
      await client.createIfNotExists();
      return client;
    })();
    promise.catch(() => containerClients.delete(containerName));
    containerClients.set(containerName, promise);
  }
  return containerClients.get(containerName);
}

async function readJson(containerName, blobName, fallback = null) {
  try {
    const client = await containerClient(containerName);
    const buffer = await client.getBlockBlobClient(blobName).downloadToBuffer();
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    if (error?.statusCode === 404) return fallback;
    throw error;
  }
}

async function writeJson(containerName, blobName, value) {
  const client = await containerClient(containerName);
  const body = Buffer.from(JSON.stringify(value, null, 2), "utf8");
  await client.getBlockBlobClient(blobName).upload(body, body.length, {
    blobHTTPHeaders: { blobContentType: "application/json" }
  });
  return value;
}

async function writeBuffer(containerName, blobName, buffer, contentType) {
  const client = await containerClient(containerName);
  await client.getBlockBlobClient(blobName).upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: contentType || "application/octet-stream" }
  });
  return { container: containerName, blob: blobName, size: buffer.length };
}

async function readBuffer(containerName, blobName) {
  try {
    const client = await containerClient(containerName);
    return await client.getBlockBlobClient(blobName).downloadToBuffer();
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

async function deleteBlob(containerName, blobName) {
  const client = await containerClient(containerName);
  await client.getBlockBlobClient(blobName).deleteIfExists();
}

async function listBlobs(containerName, prefix = "") {
  const client = await containerClient(containerName);
  const names = [];
  for await (const item of client.listBlobsFlat({ prefix })) names.push(item.name);
  return names;
}

function jsonBlob(containerName, blobName) {
  return {
    read: (fallback = null) => readJson(containerName, blobName, fallback),
    write: (value) => writeJson(containerName, blobName, value),
    remove: () => deleteBlob(containerName, blobName)
  };
}

module.exports = {
  blobConfigured,
  containerClient,
  readJson,
  writeJson,
  readBuffer,
  writeBuffer,
  deleteBlob,
  listBlobs,
  jsonBlob
};

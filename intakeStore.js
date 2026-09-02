const { BlobServiceClient } = require("@azure/storage-blob");

/*
 * Azure Blob record store for customer intakes.
 *
 * Intake records used to live as JSON files in Google Drive, which meant a
 * customer clicking "Submit" depended on a Google OAuth token being healthy.
 * Records now land in the platform's own storage account, so submission never
 * touches Google; Drive only enters the picture later, when the internal
 * build creates the department's asset folders.
 *
 * Record ids are the blob names (e.g. "2026-09-01-station-7-1a2b3c4d.json").
 * Drive file ids never contain a dot, so the ".json" suffix doubles as the
 * discriminator that keeps pre-migration Drive records readable.
 */

const CONTAINER_NAME = "customer-intakes";

let containerPromise = null;

function blobStoreConfigured() {
  return Boolean(String(process.env.AZURE_STORAGE_CONNECTION_STRING || "").trim());
}

function isBlobRecordId(id) {
  return /\.json$/i.test(String(id || ""));
}

async function container() {
  if (!blobStoreConfigured()) {
    throw new Error("Set AZURE_STORAGE_CONNECTION_STRING before accepting customer intakes.");
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

/* Blob metadata values must be ASCII; anything else would fail the write of
   the whole record over a label. Non-ASCII bytes are dropped, not the field. */
function cleanMetadata(metadata = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    // eslint-disable-next-line no-control-regex
    clean[key] = String(value).replace(/[^\x20-\x7e]/g, "").slice(0, 256);
  }
  return clean;
}

/* Same shape drive.js file results have, so recordWithComputedFields and the
   console UI read blob-backed records without knowing the difference. */
function fileInfo(name, { createdOn, lastModified, metadata } = {}) {
  return {
    id: name,
    name,
    mimeType: "application/json",
    webViewLink: null,
    createdTime: createdOn ? new Date(createdOn).toISOString() : undefined,
    modifiedTime: lastModified ? new Date(lastModified).toISOString() : undefined,
    appProperties: metadata || {}
  };
}

async function writeRecordBlob(name, record, metadata = {}) {
  const client = await container();
  const blob = client.getBlockBlobClient(name);
  const body = Buffer.from(JSON.stringify(record, null, 2), "utf8");
  await blob.upload(body, body.length, {
    blobHTTPHeaders: { blobContentType: "application/json" },
    metadata: cleanMetadata(metadata)
  });
  const properties = await blob.getProperties();
  return fileInfo(name, properties);
}

async function readRecordBlobText(name) {
  const client = await container();
  const buffer = await client.getBlockBlobClient(name).downloadToBuffer();
  return buffer.toString("utf8");
}

async function listRecordBlobs() {
  const client = await container();
  const files = [];
  for await (const item of client.listBlobsFlat({ includeMetadata: true })) {
    if (!isBlobRecordId(item.name)) continue;
    files.push(
      fileInfo(item.name, {
        createdOn: item.properties.createdOn,
        lastModified: item.properties.lastModified,
        metadata: item.metadata
      })
    );
  }
  return files;
}

async function deleteRecordBlob(name) {
  const client = await container();
  await client.getBlockBlobClient(name).deleteIfExists();
}

module.exports = {
  blobStoreConfigured,
  deleteRecordBlob,
  isBlobRecordId,
  listRecordBlobs,
  readRecordBlobText,
  writeRecordBlob
};

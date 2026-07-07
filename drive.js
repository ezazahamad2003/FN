const { google } = require("googleapis");
const { Readable } = require("stream");
const { googleAccounts, googleDriveAuth } = require("./auth");

const FOLDER_MIME = "application/vnd.google-apps.folder";

// Cache one Drive client per account so the googleapis access-token cache is
// reused across calls (fewer token mints). Keyed by refresh token so rotating
// or reconnecting an account transparently builds a fresh client.
const clientCache = new Map();

function driveForAccount(account) {
  const key = `${account.id}:${account.refreshToken}`;
  let drive = clientCache.get(key);
  if (!drive) {
    drive = google.drive({ version: "v3", auth: googleDriveAuth(account) });
    clientCache.set(key, drive);
  }
  return drive;
}

function isAuthError(error) {
  const status = error?.code || error?.status || error?.response?.status;
  const message = String(error?.message || "").toLowerCase();
  return (
    status === 401 ||
    status === 403 ||
    message.includes("invalid_grant") ||
    message.includes("invalid credentials") ||
    message.includes("unauthorized") ||
    message.includes("insufficient permission") ||
    message.includes("expired or revoked")
  );
}

// Index of the account currently believed healthy. Sticky so we don't re-probe
// a dead token on every call once we've failed over.
let activeIndex = 0;

// Run a Drive operation against the active Google account, transparently
// failing over to the next configured account on an auth error. Both accounts
// share the same parent folder, so folder ids and links are identical no matter
// which account performs the write. The callback receives the Drive client and
// is re-invoked per attempt, so any upload stream it builds is recreated fresh.
async function withDrive(run) {
  const accounts = googleAccounts();
  if (!accounts.length) {
    throw new Error("No Google account is connected. Set GOOGLE_REFRESH_TOKEN (and optionally GOOGLE_REFRESH_TOKEN_2).");
  }
  let lastError;
  for (let attempt = 0; attempt < accounts.length; attempt++) {
    const index = (activeIndex + attempt) % accounts.length;
    const account = accounts[index];
    try {
      const result = await run(driveForAccount(account));
      activeIndex = index; // stick with whichever account just worked
      return result;
    } catch (error) {
      lastError = error;
      if (accounts.length === 1 || !isAuthError(error)) throw error;
      console.error(`Google account "${account.id}" failed (${error.message}); failing over to the next account.`);
    }
  }
  throw lastError;
}

function escapeDriveName(name) {
  return name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findFolder(name, parentId) {
  const q = [
    `name='${escapeDriveName(name)}'`,
    `mimeType='${FOLDER_MIME}'`,
    `'${parentId}' in parents`,
    "trashed=false"
  ].join(" and ");
  return withDrive(async (drive) => {
    const res = await drive.files.list({
      q,
      fields: "files(id,name,webViewLink)",
      spaces: "drive",
      pageSize: 10
    });
    return res.data.files?.[0] || null;
  });
}

async function createFolder(name, parentId) {
  return withDrive(async (drive) => {
    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType: FOLDER_MIME,
        parents: [parentId]
      },
      fields: "id,name,webViewLink"
    });
    return res.data;
  });
}

async function trashFile(fileId) {
  return withDrive((drive) => drive.files.update({ fileId, requestBody: { trashed: true } }));
}

async function ensureSubfolder(name, parentId) {
  return (await findFolder(name, parentId)) || createFolder(name, parentId);
}

async function createDepartmentFolders(departmentName, strategy = "fail") {
  const parentId = process.env.GDRIVE_PARENT_FOLDER_ID;
  const existing = await findFolder(departmentName, parentId);

  if (existing && strategy === "fail") {
    const err = new Error(`A Google Drive folder named "${departmentName}" already exists.`);
    err.code = "FOLDER_EXISTS";
    err.folder = existing;
    throw err;
  }

  if (existing && strategy === "overwrite") {
    await trashFile(existing.id);
  }

  const root =
    existing && strategy === "skip"
      ? existing
      : await createFolder(departmentName, parentId);
  const logos = await ensureSubfolder("Logos", root.id);
  const productImages = await ensureSubfolder("Product Images", root.id);

  return {
    root,
    logos,
    productImages,
    url: `https://drive.google.com/drive/folders/${root.id}`
  };
}

async function uploadBuffer(file, folderId) {
  return withDrive(async (drive) => {
    const res = await drive.files.create({
      requestBody: {
        name: file.originalname,
        parents: [folderId]
      },
      media: {
        mimeType: file.mimetype,
        body: Readable.from(file.buffer)
      },
      fields: "id,name,mimeType,webViewLink"
    });
    return res.data;
  });
}

async function uploadGeneratedImage(filename, buffer, folderId) {
  return uploadBuffer(
    {
      originalname: filename,
      mimetype: "image/png",
      buffer
    },
    folderId
  );
}

async function uploadHtmlDocument(name, html, folderId) {
  return withDrive(async (drive) => {
    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.document",
        parents: [folderId]
      },
      media: {
        mimeType: "text/html",
        body: Readable.from(Buffer.from(html, "utf8"))
      },
      fields: "id,name,mimeType,webViewLink"
    });
    return res.data;
  });
}

module.exports = {
  createDepartmentFolders,
  trashFile,
  uploadGeneratedImage,
  uploadHtmlDocument,
  uploadBuffer
};

const { google } = require("googleapis");
const { Readable } = require("stream");
const { googleClient } = require("./auth");

const FOLDER_MIME = "application/vnd.google-apps.folder";

function driveClient() {
  const auth = googleClient();
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: "v3", auth });
}

function escapeDriveName(name) {
  return name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findFolder(name, parentId) {
  const drive = driveClient();
  const q = [
    `name='${escapeDriveName(name)}'`,
    `mimeType='${FOLDER_MIME}'`,
    `'${parentId}' in parents`,
    "trashed=false"
  ].join(" and ");
  const res = await drive.files.list({
    q,
    fields: "files(id,name,webViewLink)",
    spaces: "drive",
    pageSize: 10
  });
  return res.data.files?.[0] || null;
}

async function createFolder(name, parentId) {
  const drive = driveClient();
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId]
    },
    fields: "id,name,webViewLink"
  });
  return res.data;
}

async function trashFile(fileId) {
  const drive = driveClient();
  await drive.files.update({ fileId, requestBody: { trashed: true } });
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
  const drive = driveClient();
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
  const drive = driveClient();
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
}

module.exports = {
  createDepartmentFolders,
  uploadGeneratedImage,
  uploadHtmlDocument,
  uploadBuffer
};

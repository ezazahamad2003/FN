const path = require("path");
const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const {
  ensureEnvDefaults,
  exchangeGoogleCode,
  exchangeShopifyCode,
  googleInstallUrl,
  hasRequiredTokens,
  openBrowser,
  shopifyInstallUrl
} = require("./auth");
const { createDepartmentFolders, uploadBuffer } = require("./drive");
const { analyzeLogo, generateMockup, generateProductDescription } = require("./ai");
const {
  addProductToCollection,
  adminCollectionUrl,
  adminProductUrl,
  createProduct,
  ensureManualCollection,
  uploadProductImage
} = require("./shopify");

ensureEnvDefaults();
dotenv.config();

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 30 }
});
const PORT = Number(process.env.PORT || 3456);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function titleCase(input) {
  return input
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function slug(input) {
  return input
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function sendEvent(res, type, payload) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function runStep(res, step, label, fn) {
  sendEvent(res, "status", { step, state: "running", message: `Step ${step} running: ${label}` });
  try {
    const result = await fn();
    sendEvent(res, "status", { step, state: "complete", message: `Step ${step} complete: ${label}` });
    return result;
  } catch (error) {
    error.step = step;
    throw error;
  }
}

function filesByField(files, field) {
  return (files || []).filter((file) => file.fieldname === field);
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    shopifyConnected: Boolean(process.env.SHOPIFY_ACCESS_TOKEN),
    googleConnected: Boolean(process.env.GOOGLE_REFRESH_TOKEN)
  });
});

app.get("/setup", (req, res) => {
  if (hasRequiredTokens()) return res.redirect("/");
  return res.sendFile(path.join(__dirname, "public", "setup.html"));
});

app.get("/auth/shopify", (req, res) => {
  res.redirect(shopifyInstallUrl());
});

app.get("/callback", async (req, res, next) => {
  try {
    if (!req.query.code) throw new Error("Missing Shopify OAuth code.");
    await exchangeShopifyCode(req.query.code);
    res.redirect(hasRequiredTokens() ? "/" : "/setup?shopify=connected");
  } catch (error) {
    next(error);
  }
});

app.get("/auth/google", (req, res) => {
  res.redirect(googleInstallUrl());
});

app.get("/google/callback", async (req, res, next) => {
  try {
    if (!req.query.code) throw new Error("Missing Google OAuth code.");
    await exchangeGoogleCode(req.query.code);
    res.redirect(hasRequiredTokens() ? "/" : "/setup?google=connected");
  } catch (error) {
    next(error);
  }
});

app.get("/", (req, res) => {
  if (!hasRequiredTokens()) return res.redirect("/setup");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post(
  "/onboard",
  upload.fields([
    { name: "logos", maxCount: 20 },
    { name: "policies", maxCount: 20 }
  ]),
  async (req, res) => {
    const departmentName = String(req.body.departmentName || "").trim();
    const conflictStrategy = req.body.conflictStrategy || "fail";
    const uploadedFiles = req.files || {};
    const logos = filesByField([...(uploadedFiles.logos || []), ...(uploadedFiles.policies || [])], "logos");
    const policies = filesByField([...(uploadedFiles.logos || []), ...(uploadedFiles.policies || [])], "policies");

    if (!departmentName) {
      return res.status(400).json({ step: 0, error: "Department Name is required." });
    }
    if (!logos.length) {
      return res.status(400).json({ step: 0, error: "Upload at least one logo image." });
    }
    if (!process.env.SHOPIFY_ACCESS_TOKEN || !process.env.GOOGLE_REFRESH_TOKEN) {
      return res.status(401).json({ step: 0, error: "Connect Shopify and Google Drive before onboarding." });
    }

    let folders;
    try {
      folders = await createDepartmentFolders(departmentName, conflictStrategy);
    } catch (error) {
      if (error.code === "FOLDER_EXISTS") {
        return res.status(409).json({
          step: 1,
          error: error.message,
          folder: error.folder,
          choices: ["overwrite", "skip"]
        });
      }
      return res.status(500).json({ step: 1, error: error.message });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    const logoRuns = logos.map((file) => ({
      file,
      filenameBase: titleCase(file.originalname),
      slug: slug(file.originalname)
    }));

    try {
      sendEvent(res, "status", { step: 1, state: "complete", message: "Step 1 complete: Google Drive folders ready" });

      await runStep(res, 2, "Upload files to Drive", async () => {
        for (const item of logoRuns) {
          item.driveFile = await uploadBuffer(item.file, folders.logos.id);
        }
        for (const file of policies) {
          await uploadBuffer(file, folders.policies.id);
        }
      });

      await runStep(res, 3, "Analyze logos with GPT-4o Vision", async () => {
        for (const item of logoRuns) {
          item.logoDescription = await analyzeLogo(item.file);
        }
      });

      await runStep(res, 4, "Generate shirt mockups with DALL-E 3", async () => {
        for (const item of logoRuns) {
          item.mockupBuffer = await generateMockup(item.logoDescription);
          item.mockupDataUrl = `data:image/png;base64,${item.mockupBuffer.toString("base64")}`;
        }
      });

      await runStep(res, 5, "Generate product descriptions with GPT-4o", async () => {
        for (const item of logoRuns) {
          item.descriptionHtml = await generateProductDescription(departmentName);
        }
      });

      const collection = await runStep(res, 6, "Create Shopify collection", async () => {
        return ensureManualCollection(departmentName);
      });

      await runStep(res, 7, "Create Shopify products", async () => {
        for (const item of logoRuns) {
          const product = await createProduct({
            title: `${departmentName} — ${item.filenameBase}`,
            bodyHtml: item.descriptionHtml,
            price: "60.00"
          });
          const image = await uploadProductImage(
            product.id,
            `${item.slug || "department-logo"}-mockup.png`,
            item.mockupBuffer
          );
          item.product = product;
          item.productImage = image;
        }
      });

      await runStep(res, 8, "Add products to collection", async () => {
        for (const item of logoRuns) {
          await addProductToCollection(item.product.id, collection.id);
        }
      });

      const summary = {
        driveFolderUrl: folders.url,
        shopifyCollectionUrl: adminCollectionUrl(collection.id),
        products: logoRuns.map((item) => ({
          title: item.product.title,
          id: String(item.product.id),
          url: adminProductUrl(item.product.id),
          mockupGenerated: true,
          thumbnail: item.mockupDataUrl
        }))
      };

      sendEvent(res, "summary", summary);
      sendEvent(res, "status", { step: 9, state: "complete", message: "Step 9 complete: final summary ready" });
      res.end();
    } catch (error) {
      sendEvent(res, "error", {
        step: error.step || 0,
        error: error.message
      });
      res.end();
    }
  }
);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(`<pre>${err.message}</pre>`);
});

app.listen(PORT, () => {
  const setupNeeded = !hasRequiredTokens();
  const url = setupNeeded ? `http://localhost:${PORT}/setup` : `http://localhost:${PORT}/`;
  console.log(`FN Onboarding running at ${url}`);
  if (setupNeeded) openBrowser(url);
});

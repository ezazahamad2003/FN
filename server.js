const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const {
  disconnectGoogle,
  disconnectShopify,
  ensureEnvDefaults,
  exchangeGoogleCode,
  exchangeShopifyCode,
  googleInstallUrl,
  hasRequiredTokens,
  openBrowser,
  shopifyInstallUrl
} = require("./auth");
const { createDepartmentFolders, uploadBuffer, uploadGeneratedImage, uploadHtmlDocument } = require("./drive");
const {
  analyzeLogo,
  determinePolicyProducts,
  extractPolicyInstructions,
  generateMockup,
  generateProductDescription
} = require("./ai");
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
const DATA_DIR = path.join(__dirname, "data");
const ISSUES_PATH = path.join(DATA_DIR, "issues.json");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 30 }
});
const PORT = Number(process.env.PORT || 3456);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function ensureDataStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ISSUES_PATH)) fs.writeFileSync(ISSUES_PATH, "[]", "utf8");
}

function readIssues() {
  ensureDataStore();
  return JSON.parse(fs.readFileSync(ISSUES_PATH, "utf8"));
}

function writeIssues(issues) {
  ensureDataStore();
  fs.writeFileSync(ISSUES_PATH, JSON.stringify(issues, null, 2), "utf8");
}

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

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildManualHtml(departmentName, items, instructions) {
  const instructionMap = new Map(instructions.map((entry) => [entry.title, entry.instructions]));
  const pages = items
    .map((item) => {
      const note = instructionMap.get(item.title) || item.productionNotes || "Review uploaded policy documents before production.";
      return `
        <section class="page">
          <h1>${escapeHtml(item.title)}</h1>
          <img src="${item.mockupDataUrl}" alt="${escapeHtml(item.title)} product image">
          <h2>Product</h2>
          <p>${escapeHtml(item.productLabel)}</p>
          <h2>Logo Description</h2>
          <p>${escapeHtml(item.logoDescription)}</p>
          <h2>Production Instructions</h2>
          <p>${escapeHtml(note)}</p>
        </section>
      `;
    })
    .join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      body { font-family: Arial, sans-serif; color: #111; }
      .page { page-break-after: always; padding: 24px; }
      h1 { font-size: 24px; margin: 0 0 16px; }
      h2 { font-size: 16px; margin: 18px 0 8px; }
      p { font-size: 12px; line-height: 1.45; }
      img { display: block; width: 520px; max-width: 100%; margin: 12px 0 18px; }
    </style>
  </head>
  <body>${pages}</body>
</html>`;
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

function resolveProductLogos(product, logoRuns) {
  const requestedSlugs = Array.isArray(product.logoSlugs)
    ? product.logoSlugs.map((value) => String(value).toLowerCase().trim()).filter(Boolean)
    : [];

  if (!requestedSlugs.length || requestedSlugs.includes("all")) return logoRuns;

  const logosBySlug = new Map(logoRuns.map((logo) => [logo.slug.toLowerCase(), logo]));
  const selected = requestedSlugs.map((logoSlug) => logosBySlug.get(logoSlug)).filter(Boolean);
  return selected.length ? selected : logoRuns;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    shopifyConnected: Boolean(process.env.SHOPIFY_ACCESS_TOKEN),
    googleConnected: Boolean(process.env.GOOGLE_REFRESH_TOKEN)
  });
});

app.get("/setup", (req, res) => {
  return res.sendFile(path.join(__dirname, "public", "setup.html"));
});

app.get("/auth/shopify", (req, res, next) => {
  try {
    res.redirect(shopifyInstallUrl());
  } catch (error) {
    next(error);
  }
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

app.post("/auth/shopify/disconnect", (req, res) => {
  disconnectShopify();
  res.json({ ok: true, service: "shopify", connected: false });
});

app.post("/auth/google/disconnect", (req, res) => {
  disconnectGoogle();
  res.json({ ok: true, service: "google", connected: false });
});

app.get("/auth/google", (req, res, next) => {
  try {
    res.redirect(googleInstallUrl());
  } catch (error) {
    next(error);
  }
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

app.get("/issues", (req, res) => {
  if (!hasRequiredTokens()) return res.redirect("/setup");
  res.sendFile(path.join(__dirname, "public", "issues.html"));
});

app.get("/api/issues", (req, res) => {
  res.json({ issues: readIssues() });
});

app.post("/api/issues", upload.array("images", 6), (req, res) => {
  const title = String(req.body.title || "").trim();
  const details = String(req.body.details || "").trim();
  if (!title) return res.status(400).json({ error: "Issue title is required." });

  const issues = readIssues();
  const issue = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    details,
    createdAt: new Date().toISOString(),
    images: (req.files || []).map((file) => ({
      name: file.originalname,
      mimeType: file.mimetype,
      dataUrl: `data:${file.mimetype};base64,${file.buffer.toString("base64")}`
    }))
  };
  issues.unshift(issue);
  writeIssues(issues);
  res.status(201).json({ issue });
});

app.delete("/api/issues/:id", (req, res) => {
  const issues = readIssues();
  const next = issues.filter((issue) => issue.id !== req.params.id);
  writeIssues(next);
  res.json({ ok: true });
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
      originalName: file.originalname,
      filenameBase: titleCase(file.originalname),
      slug: slug(file.originalname)
    }));
    let productRuns = [];

    try {
      sendEvent(res, "status", { step: 1, state: "complete", message: "Step 1 complete: Google Drive folders ready" });

      await runStep(res, 2, "Upload source files to Drive", async () => {
        for (const item of logoRuns) {
          item.driveFile = await uploadBuffer(item.file, folders.logos.id);
        }
        for (const file of policies) {
          await uploadBuffer(file, folders.root.id);
        }
      });

      await runStep(res, 3, "Analyze logos with GPT-4o Vision", async () => {
        for (const item of logoRuns) {
          item.logoDescription = await analyzeLogo(item.file);
        }
      });

      const policyProducts = await runStep(res, 4, "Extract products and logo assignments from policy documents", async () => {
        return determinePolicyProducts(departmentName, policies, logoRuns);
      });

      await runStep(res, 5, "Generate and save product images", async () => {
        productRuns = policyProducts.flatMap((product) =>
          resolveProductLogos(product, logoRuns).map((logo) => {
            const productionNotes = [
              product.productionNotes,
              product.assignmentNotes ? `Logo assignment: ${product.assignmentNotes}` : ""
            ]
              .filter(Boolean)
              .join(" ");

            return {
              ...product,
              productionNotes,
              logo,
              logoDescription: logo.logoDescription,
              logoFilenameBase: logo.filenameBase,
              slug: `${logo.slug || "department-logo"}-${slug(product.productLabel || product.productType || "product")}`,
              title: `${departmentName} - ${product.productLabel} - ${logo.filenameBase}`
            };
          })
        );

        for (const item of productRuns) {
          item.mockupBuffer = await generateMockup({
            productPrompt: item.productPrompt,
            logoDescription: item.logoDescription,
            productionNotes: item.productionNotes
          });
          item.mockupDataUrl = `data:image/png;base64,${item.mockupBuffer.toString("base64")}`;
          item.productImageDriveFile = await uploadGeneratedImage(
            `${item.slug || "department-product"}-product-image.png`,
            item.mockupBuffer,
            folders.productImages.id
          );
        }
      });

      await runStep(res, 6, "Generate product descriptions and manual", async () => {
        for (const item of productRuns) {
          item.descriptionHtml = await generateProductDescription(departmentName, item);
        }
        const instructions = await extractPolicyInstructions(departmentName, policies, productRuns);
        const manualHtml = buildManualHtml(departmentName, productRuns, instructions);
        const manual = await uploadHtmlDocument(`${departmentName} Manual`, manualHtml, folders.root.id);
        for (const item of productRuns) {
          item.manual = manual;
        }
      });

      const collection = await runStep(res, 7, "Create Shopify collection", async () => {
        return ensureManualCollection(departmentName);
      });

      await runStep(res, 8, "Create Shopify products", async () => {
        for (const item of productRuns) {
          const product = await createProduct({
            title: item.title,
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

      await runStep(res, 9, "Add products to collection", async () => {
        for (const item of productRuns) {
          await addProductToCollection(item.product.id, collection.id);
        }
      });

      const summary = {
        driveFolderUrl: folders.url,
        manualUrl: productRuns[0]?.manual?.webViewLink || null,
        shopifyCollectionUrl: adminCollectionUrl(collection.id),
        products: productRuns.map((item) => ({
          title: item.product.title,
          id: String(item.product.id),
          url: adminProductUrl(item.product.id),
          driveImageUrl: item.productImageDriveFile?.webViewLink || null,
          mockupGenerated: true,
          thumbnail: item.mockupDataUrl
        }))
      };

      sendEvent(res, "summary", summary);
      sendEvent(res, "status", { step: 10, state: "complete", message: "Step 10 complete: final summary ready" });
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

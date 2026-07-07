const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const {
  disconnectGoogle,
  disconnectShopify,
  ensureEnvDefaults,
  exchangeGoogleCode,
  exchangeShopifyCode,
  googleAccounts,
  googleConnected,
  googleInstallUrl,
  hasRequiredTokens,
  openBrowser,
  shopifyInstallUrl
} = require("./auth");
const { createDepartmentFolders, trashFile, uploadBuffer, uploadGeneratedImage, uploadHtmlDocument } = require("./drive");
const {
  analyzeLogo,
  analyzePolicyGaps,
  collectPolicyText,
  determinePolicyProducts,
  extractPolicyInstructions,
  generateBlankGarment,
  generateProductDescription
} = require("./ai");
const { compositeLogoOnGarment, resolvePlacement } = require("./mockup");
const {
  DEFAULT_SIZES,
  MAX_VARIANTS,
  addProductToCollection,
  adminCollectionUrl,
  adminProductUrl,
  countProductsInCollection,
  createProductWithVariants,
  deleteCollection,
  deleteProduct,
  ensureManualCollection,
  shopifyConnected,
  startTokenAutoRefresh,
  uploadProductImages,
  variantIdsByLogo
} = require("./shopify");

ensureEnvDefaults();
dotenv.config();
// Internal-app mode: auto-mint and refresh the Shopify token from client credentials.
startTokenAutoRefresh();

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 50 }
});
const PORT = Number(process.env.PORT || 3456);

app.set("trust proxy", true);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/*
 * Review gate: onboarding runs in two phases so nothing is published without
 * an explicit approval.
 *   Phase 1  POST /onboard  → Drive assets + AI analysis + generated images,
 *            ends with a `review` SSE event (nothing touches Shopify).
 *   Phase 2  POST /publish  → pushes the reviewed run to Shopify.
 * Pending runs are held in memory with a TTL. On Render the filesystem and
 * process are ephemeral — a restart drops pending runs, so approve promptly.
 *
 * After a publish the run stays behind (buffers dropped) as a cleanup
 * manifest, so POST /cleanup can undo the whole run — delete its Shopify
 * products, delete the collection if that leaves it empty, and move the Drive
 * folder to trash — for up to 24 hours.
 */
const pendingRuns = new Map();
const RUN_TTL_MS = 60 * 60 * 1000;
const CLEANUP_TTL_MS = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [runId, run] of pendingRuns) {
    if (run.expiresAt < now) pendingRuns.delete(runId);
  }
}, 10 * 60 * 1000).unref();

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

function buildManualHtml(departmentName, pages, instructions) {
  const instructionMap = new Map(instructions.map((entry) => [entry.title, entry.instructions]));
  const sections = pages
    .map((page) => {
      const note = instructionMap.get(page.title) || page.productionNotes || "Review uploaded policy documents before production.";
      return `
        <section class="page">
          <h1>${escapeHtml(page.title)}</h1>
          <img src="${page.mockupDataUrl}" alt="${escapeHtml(page.title)} product image">
          <h2>Product</h2>
          <p>${escapeHtml(page.productLabel)}</p>
          <h2>Logo Description</h2>
          <p>${escapeHtml(page.logoDescription)}</p>
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
  <body>${sections}</body>
</html>`;
}

function buildEmailDraftHtml(emailDraft) {
  const bodyHtml = escapeHtml(emailDraft.body).replace(/\r?\n/g, "<br>");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body style="font-family: Arial, sans-serif; color: #111;">
    <p><b>Subject:</b> ${escapeHtml(emailDraft.subject)}</p>
    <hr>
    <p>${bodyHtml}</p>
  </body>
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

function requestOrigin(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol;
  return proto + "://" + req.get("host");
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

// Front Logo option values must be unique per product, so duplicate display
// names (e.g. "station-1.png" and "Station_1.jpg") get a numeric suffix.
function dedupeLogoLabels(logoRuns) {
  const used = new Map();
  for (const logo of logoRuns) {
    const count = (used.get(logo.filenameBase) || 0) + 1;
    used.set(logo.filenameBase, count);
    if (count > 1) logo.filenameBase = `${logo.filenameBase} (${count})`;
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    shopifyConnected: shopifyConnected(),
    shopifyStore: process.env.SHOPIFY_STORE || "",
    googleConnected: googleConnected(),
    googleAccountCount: googleAccounts().length
  });
});

app.get("/setup", (req, res) => {
  return res.sendFile(path.join(__dirname, "public", "setup.html"));
});

app.get("/auth/shopify", (req, res, next) => {
  try {
    res.redirect(shopifyInstallUrl(req.query.shop, requestOrigin(req)));
  } catch (error) {
    next(error);
  }
});

app.get("/callback", async (req, res, next) => {
  try {
    if (!req.query.code) throw new Error("Missing Shopify OAuth code.");
    await exchangeShopifyCode(req.query.code, req.query.shop);
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

/* ---------------------------------------------------------------------------
   Phase 1 — analyze & generate (steps 1–7). Ends with a `review` event.
   Nothing is pushed to Shopify here.
   ------------------------------------------------------------------------- */
app.post(
  "/onboard",
  upload.fields([
    { name: "logos", maxCount: 20 },
    { name: "policies", maxCount: 20 },
    { name: "followUps", maxCount: 20 }
  ]),
  async (req, res) => {
    const departmentName = String(req.body.departmentName || "").trim();
    const followUpText = String(req.body.followUpText || "");
    const conflictStrategy = req.body.conflictStrategy || "fail";
    const uploadedFiles = req.files || {};
    const allFiles = [
      ...(uploadedFiles.logos || []),
      ...(uploadedFiles.policies || []),
      ...(uploadedFiles.followUps || [])
    ];
    const logos = filesByField(allFiles, "logos");
    const policies = filesByField(allFiles, "policies");
    const followUps = filesByField(allFiles, "followUps");

    if (!departmentName) {
      return res.status(400).json({ step: 0, error: "Department Name is required." });
    }
    if (!logos.length) {
      return res.status(400).json({ step: 0, error: "Upload at least one logo image." });
    }
    if (!shopifyConnected() || !googleConnected()) {
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
    dedupeLogoLabels(logoRuns);
    let productRuns = [];

    try {
      sendEvent(res, "status", { step: 1, state: "complete", message: "Step 1 complete: Google Drive folders ready" });

      await runStep(res, 2, "Upload source files to Drive", async () => {
        for (const item of logoRuns) {
          item.driveFile = await uploadBuffer(item.file, folders.logos.id);
        }
        for (const file of [...policies, ...followUps]) {
          await uploadBuffer(file, folders.root.id);
        }
      });

      await runStep(res, 3, "Analyze logos with GPT-4o Vision", async () => {
        for (const item of logoRuns) {
          item.logoDescription = await analyzeLogo(item.file);
        }
      });

      const policyText = await collectPolicyText(policies, followUps, followUpText);

      const policyProducts = await runStep(res, 4, "Extract products and logo assignments from policy documents", async () => {
        return determinePolicyProducts(departmentName, policyText, logoRuns);
      });

      const gaps = await runStep(res, 5, "Check policy completeness", async () => {
        return analyzePolicyGaps(departmentName, policyText, policyProducts, logoRuns);
      });

      await runStep(res, 6, "Generate product images (exact logo compositing)", async () => {
        // Product titles match the store's convention: garment name only
        // (brand included when the policy states it). The department lives in
        // the collection and tags, like the real listings.
        productRuns = policyProducts.map((product) => ({
          ...product,
          logos: resolveProductLogos(product, logoRuns),
          placementKey: resolvePlacement(product),
          slug: slug(product.productLabel || product.productType || "product"),
          title: product.productLabel,
          logoVariants: []
        }));

        for (const item of productRuns) {
          // One blank garment base per product; the exact uploaded logo file is
          // composited on top, so the artwork is never redrawn by the model.
          item.baseBuffer = await generateBlankGarment({
            productPrompt: item.productPrompt,
            garmentColor: item.garmentColor
          });

          for (const logo of item.logos) {
            let mockupBuffer;
            try {
              mockupBuffer = await compositeLogoOnGarment(item.baseBuffer, logo.file.buffer, item.placementKey);
            } catch (error) {
              throw new Error(`Could not place logo "${logo.originalName}" on ${item.productLabel}: ${error.message}`);
            }
            const driveFile = await uploadGeneratedImage(
              `${item.slug}-${logo.slug || "logo"}-product-image.png`,
              mockupBuffer,
              folders.productImages.id
            );
            item.logoVariants.push({
              logo,
              mockupBuffer,
              mockupDataUrl: `data:image/png;base64,${mockupBuffer.toString("base64")}`,
              driveFile
            });
          }
        }
      });

      let manual = null;
      let emailDraftDoc = null;
      await runStep(res, 7, "Write descriptions, manual, and gap email draft", async () => {
        for (const item of productRuns) {
          item.descriptionHtml = await generateProductDescription(departmentName, item);
        }

        const pages = productRuns.flatMap((item) =>
          item.logoVariants.map((lv) => ({
            title: `${item.title} - ${lv.logo.filenameBase}`,
            mockupDataUrl: lv.mockupDataUrl,
            productLabel: item.productLabel,
            logoDescription: lv.logo.logoDescription,
            productionNotes: [item.productionNotes, item.assignmentNotes ? `Logo assignment: ${item.assignmentNotes}` : ""]
              .filter(Boolean)
              .join(" ")
          }))
        );
        const instructions = await extractPolicyInstructions(departmentName, policyText, pages);
        const manualHtml = buildManualHtml(departmentName, pages, instructions);
        manual = await uploadHtmlDocument(`${departmentName} Manual`, manualHtml, folders.root.id);

        if (gaps.emailDraft) {
          emailDraftDoc = await uploadHtmlDocument(
            `${departmentName} - Policy Questions Email Draft`,
            buildEmailDraftHtml(gaps.emailDraft),
            folders.root.id
          );
        }
      });

      const runId = crypto.randomUUID();
      pendingRuns.set(runId, {
        departmentName,
        folders,
        manual,
        productRuns,
        expiresAt: Date.now() + RUN_TTL_MS
      });

      sendEvent(res, "review", {
        runId,
        departmentName,
        driveFolderUrl: folders.url,
        manualUrl: manual?.webViewLink || null,
        emailDraftDocUrl: emailDraftDoc?.webViewLink || null,
        gaps: { confidence: gaps.confidence, missing: gaps.missing },
        emailDraft: gaps.emailDraft,
        products: productRuns.map((item) => ({
          title: item.title,
          productLabel: item.productLabel,
          garmentColor: item.garmentColor,
          brandStyle: item.brandStyle,
          fabricDetails: item.fabricDetails,
          placement: item.placement || item.placementKey.replace(/-/g, " "),
          placementStated: Boolean(item.placement),
          decorationMethod: item.decorationMethod,
          sizes: item.sizes.length ? item.sizes : DEFAULT_SIZES,
          sizesStated: item.sizes.length > 0,
          productionNotes: item.productionNotes,
          images: item.logoVariants.map((lv) => ({
            logoLabel: lv.logo.filenameBase,
            thumbnail: lv.mockupDataUrl,
            driveUrl: lv.driveFile?.webViewLink || null
          }))
        }))
      });
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

/* ---------------------------------------------------------------------------
   Phase 2 — publish to Shopify (steps 8–10). Only runs after the user
   approves the review.
   ------------------------------------------------------------------------- */
app.post("/publish", async (req, res) => {
  const runId = String(req.body?.runId || "");
  const run = pendingRuns.get(runId);
  if (!run || run.published) {
    return res.status(410).json({
      step: 8,
      error: run?.published
        ? "This run was already published."
        : "This run has expired or the server restarted. Re-run onboarding — the Drive folder can be reused."
    });
  }
  if (!shopifyConnected()) {
    return res.status(401).json({ step: 8, error: "Shopify is not connected." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  const price = process.env.DEFAULT_PRODUCT_PRICE || "24.00";
  const vendor = process.env.DEFAULT_PRODUCT_VENDOR || "";
  const createdProducts = [];

  try {
    const collection = await runStep(res, 8, "Create Shopify collection", async () => {
      return ensureManualCollection(run.departmentName);
    });

    await runStep(res, 9, "Create Shopify products with variants", async () => {
      for (const item of run.productRuns) {
        const sizes = item.sizes.length ? item.sizes : DEFAULT_SIZES;

        // One product per garment with Front Logo × Size variants (GraphQL,
        // up to 2048 variants — covers 30+ logos × 7 sizes on one product,
        // matching the store's real listings). Splitting per logo only kicks
        // in past that hard limit.
        const plans =
          item.logoVariants.length > 1 && item.logoVariants.length * sizes.length <= MAX_VARIANTS
            ? [{ title: item.title, logoVariants: item.logoVariants }]
            : item.logoVariants.map((lv) => ({
                title: item.logoVariants.length > 1 ? `${item.title} - ${lv.logo.filenameBase}` : item.title,
                logoVariants: [lv]
              }));

        for (const plan of plans) {
          const product = await createProductWithVariants({
            title: plan.title,
            bodyHtml: item.descriptionHtml,
            price,
            productType: item.productType,
            vendor,
            tags: [run.departmentName],
            logoValues: plan.logoVariants.map((lv) => lv.logo.filenameBase),
            sizes
          });

          const idsByLogo = variantIdsByLogo(product.variants, product.useLogoOption);
          await uploadProductImages(
            product.productGid,
            plan.logoVariants.map((lv) => ({
              filename: `${item.slug}-${lv.logo.slug || "logo"}-mockup.png`,
              buffer: lv.mockupBuffer,
              alt: `${plan.title} — ${lv.logo.filenameBase}`,
              variantIds: idsByLogo.get(product.useLogoOption ? lv.logo.filenameBase : "__all__") || []
            }))
          );

          createdProducts.push({
            title: product.title,
            id: product.productId,
            url: adminProductUrl(product.productId),
            driveImageUrl: plan.logoVariants[0]?.driveFile?.webViewLink || null,
            thumbnail: plan.logoVariants[0]?.mockupDataUrl || null,
            variantCount: product.variantCount,
            logoCount: plan.logoVariants.length,
            productId: product.productId,
            productGid: product.productGid
          });
        }
      }
    });

    await runStep(res, 10, "Add products to collection", async () => {
      for (const created of createdProducts) {
        await addProductToCollection(created.productId, collection.id);
      }
    });

    // Convert the pending run into a light cleanup manifest so the whole run
    // can be undone from the UI. Buffers are dropped to free memory.
    pendingRuns.set(runId, {
      departmentName: run.departmentName,
      published: true,
      cleanup: {
        collectionId: collection.id,
        collectionTitle: collection.title,
        productGids: createdProducts.map((created) => created.productGid),
        driveFolderId: run.folders.root.id
      },
      expiresAt: Date.now() + CLEANUP_TTL_MS
    });

    sendEvent(res, "summary", {
      runId,
      departmentName: run.departmentName,
      driveFolderUrl: run.folders.url,
      manualUrl: run.manual?.webViewLink || null,
      shopifyCollectionUrl: adminCollectionUrl(collection.id),
      cleanup: {
        productCount: createdProducts.length,
        collectionTitle: collection.title
      },
      products: createdProducts.map(({ productId, productGid, ...rest }) => rest)
    });
    res.end();
  } catch (error) {
    sendEvent(res, "error", {
      step: error.step || 8,
      error: error.message
    });
    res.end();
  }
});

app.post("/discard", (req, res) => {
  const runId = String(req.body?.runId || "");
  pendingRuns.delete(runId);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------------
   Undo a published run: delete its Shopify products, delete the collection
   only if that leaves it empty (a reused collection with other products is
   kept), and move the Drive department folder to trash (recoverable from
   Drive's trash for ~30 days).
   ------------------------------------------------------------------------- */
app.post("/cleanup", async (req, res) => {
  const runId = String(req.body?.runId || "");
  const run = pendingRuns.get(runId);
  if (!run || !run.published || !run.cleanup) {
    return res.status(410).json({
      error:
        "Cleanup is no longer available for this run (expired or the server restarted). " +
        "Delete the products/collection in Shopify admin and the folder in Drive manually."
    });
  }

  const { collectionId, collectionTitle, productGids, driveFolderId } = run.cleanup;
  const result = {
    ok: true,
    deletedProducts: 0,
    collectionDeleted: false,
    collectionKept: null,
    driveTrashed: false,
    errors: []
  };

  for (const productGid of productGids) {
    try {
      await deleteProduct(productGid);
      result.deletedProducts += 1;
    } catch (error) {
      result.errors.push(`Product ${productGid}: ${error.message}`);
    }
  }

  try {
    const remaining = await countProductsInCollection(collectionId);
    if (remaining === 0) {
      await deleteCollection(collectionId);
      result.collectionDeleted = true;
    } else {
      result.collectionKept = `"${collectionTitle}" still contains ${remaining} other product${remaining === 1 ? "" : "s"}, so it was kept.`;
    }
  } catch (error) {
    result.errors.push(`Collection: ${error.message}`);
  }

  try {
    await trashFile(driveFolderId);
    result.driveTrashed = true;
  } catch (error) {
    result.errors.push(`Drive folder: ${error.message}`);
  }

  result.ok = result.errors.length === 0;
  if (result.ok) pendingRuns.delete(runId);
  res.json(result);
});

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

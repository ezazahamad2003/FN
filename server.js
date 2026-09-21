const path = require("path");
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
  hydrateTokensFromStore,
  openBrowser,
  shopifyInstallUrl
} = require("./auth");
const { findFolder, listFilesInFolder, trashFile } = require("./drive");
const { generateBlankGarment, generateProductDescription, planCustomProduct } = require("./ai");
const { getCollectionWithProducts, getProduct, listCollections, updateProduct } = require("./catalog");
const { compositeLogoOnGarment, resolvePlacement } = require("./mockup");
const { placementGuidance } = require("./placements");
const { blankCacheKey, clearCachedBlank, findSupplierBlank } = require("./blanks");
const { saveSupplierLink } = require("./linkBook");
const { answerDashboardAgent, platformStatus } = require("./agents");
const {
  createCustomerIntake,
  deleteCustomerIntakeRecord,
  getCustomerIntake,
  intakeDocumentHtml,
  intakeFromCustomerRecord,
  listCustomerIntakes,
  updateCustomerIntake
} = require("./customerIntakes");
const { generateImage } = require("./azureOpenai");
const { isBuildActive, markActiveBuildsInterrupted, resumeInterruptedBuilds, startIntakeBuild } = require("./intakeBuild");
const onboardingAgent = require("./onboardingAgent");
const createOnboardingRouter = require("./onboardingRoutes");
const {
  DEFAULT_SIZES,
  addProductToCollection,
  adminCollectionUrl,
  adminProductUrl,
  createProductWithVariants,
  deleteCollection,
  deleteProduct,
  ensureManualCollectionWithImage,
  gid,
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

/*
 * Internal pages sit on the same origin as the customer intake form, so with
 * the admin gate on, the console and setup screens themselves need the token
 * too - not just the APIs behind them. Registered BEFORE the static handler,
 * which would otherwise happily serve index.html to anyone.
 *
 * An operator opens /?admin=<FN_ADMIN_TOKEN> once; a cookie keeps later
 * visits (and the /auth/* setup links) working without the query string.
 * Everyone else is sent to the customer intake form.
 */
const INTERNAL_PAGES = new Set(["/", "/index.html", "/setup", "/setup.html"]);
app.use((req, res, next) => {
  if (!INTERNAL_PAGES.has(req.path) || !adminGateEnabled()) return next();
  if (tokenFromRequest(req) !== adminToken()) return res.redirect("/intake");
  if (String(req.query.admin || "").trim() === adminToken()) {
    res.setHeader(
      "Set-Cookie",
      `fn_admin=${encodeURIComponent(adminToken())}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`
    );
  }
  next();
});

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

function requestOrigin(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol;
  return proto + "://" + req.get("host");
}

function adminToken() {
  return String(process.env.FN_ADMIN_TOKEN || "").trim();
}

function tokenFromRequest(req) {
  const bearer = String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  const cookie = String(req.get("cookie") || "").match(/(?:^|;\s*)fn_admin=([^;]+)/)?.[1];
  return (
    bearer ||
    String(req.get("x-admin-token") || req.query.admin || "").trim() ||
    (cookie ? decodeURIComponent(cookie) : "")
  );
}

// Open by default so the internal queue can be exercised end to end without a
// token handshake during testing. Set FN_REQUIRE_ADMIN_TOKEN=1 (alongside
// FN_ADMIN_TOKEN) to put the gate back.
//
// Worth knowing before this points at real departments: the endpoints behind
// this gate return customer contact details (name, email, phone) and uploaded
// artwork, so an open gate means anyone who can reach the URL can read them.
function adminGateEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.FN_REQUIRE_ADMIN_TOKEN || "").trim()) && Boolean(adminToken());
}

function requireAdminToken(req, res, next) {
  if (!adminGateEnabled()) return next();
  if (tokenFromRequest(req) !== adminToken()) return res.status(401).json({ error: "Admin token required." });
  next();
}

function logoBufferFromRecord(record) {
  const logo = record.logos?.[0];
  const match = String(logo?.dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { buffer: Buffer.from(match[2], "base64"), alt: record.store.departmentName + " logo" };
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
    googleAccountCount: googleAccounts().length,
    genAI: platformStatus().genAI
  });
});

app.get("/api/platform/status", (req, res) => {
  res.json({ ...platformStatus(), adminGate: adminGateEnabled() });
});

/* -----------------------------------------------------------------------------
   Image generation self-test.

   Renders one small throwaway image and reports whether the configured provider
   actually answered. Everything else that generates images also creates Shopify
   products, so without this there is no way to tell a broken image key from a
   working one except by publishing a product to the live store.

   POST rather than GET so a crawler cannot spend image credits, and the bytes
   are discarded - only the size and provider come back.
   -------------------------------------------------------------------------- */
app.post("/api/diagnostics/image", requireAdminToken, async (req, res) => {
  const started = Date.now();
  const status = platformStatus().genAI;
  try {
    const buffer = await generateImage({
      prompt: "A plain light gray square on a white background. No text, no logos, no graphics.",
      size: "1024x1024",
      quality: "low"
    });
    res.json({
      ok: true,
      provider: status.imageProvider,
      deployment: status.imageDeployment || null,
      bytes: buffer.length,
      elapsedMs: Date.now() - started
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      provider: status.imageProvider,
      deployment: status.imageDeployment || null,
      error: error.message,
      elapsedMs: Date.now() - started
    });
  }
});

app.post("/api/agents/dashboard/chat", async (req, res) => {
  try {
    res.json(await answerDashboardAgent(req.body || {}));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.get("/intake", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "customer-intake.html"));
});

app.post(
  "/api/customer-intakes",
  upload.fields([{ name: "logos", maxCount: 20 }]),
  async (req, res) => {
    let record;
    try {
      record = await createCustomerIntake(req.body.payload || "{}", (req.files || {}).logos || []);
      let collection = null;
      try {
        if (!shopifyConnected()) throw new Error("Shopify is not connected.");
        let warning = "";
        let created;
        try {
          created = await ensureManualCollectionWithImage(record.store.departmentName, logoBufferFromRecord(record));
        } catch (imageError) {
          created = await ensureManualCollectionWithImage(record.store.departmentName, null);
          warning = "Collection image needs review: " + imageError.message;
        }
        collection = {
          id: created.id,
          title: created.title,
          url: adminCollectionUrl(created.id)
        };
        record = await updateCustomerIntake(record.id, {
          status: "collection-created",
          shopifyCollection: collection,
          internalNotes: warning || record.internalNotes || ""
        });
      } catch (collectionError) {
        // The record is already persisted; if even the status update fails the
        // response must still be a 201 — a 400 here would make the customer
        // resubmit a request that exists, creating a duplicate.
        try {
          record = await updateCustomerIntake(record.id, {
            status: "collection-error",
            internalNotes: "Collection was not created automatically: " + collectionError.message
          });
        } catch (statusError) {
          console.error("Could not record the collection error:", statusError.message);
        }
      }
      // Submit IS the handoff: the store starts building the moment the form
      // lands. Fire-and-forget - progress is written into the Drive record and
      // surfaced in the New Stores queue. Products are created as DRAFT, so
      // auto-building publishes nothing a customer can see.
      let buildStarted = false;
      if (record.summary?.ready) {
        try {
          const kicked = await startIntakeBuild(record.id);
          buildStarted = kicked.started;
        } catch (buildError) {
          console.error("Auto-build did not start:", buildError.message);
        }
      }

      res.status(201).json({
        id: record.id,
        requestId: record.requestId,
        departmentName: record.store.departmentName,
        status: record.status,
        collection: record.shopifyCollection || collection,
        buildStarted,
        summary: record.summary
      });
    } catch (error) {
      // Only validation problems are the customer's to fix. Anything else
      // (storage, config, auth) is internal - log the real cause and answer
      // with something a fire department can act on.
      if (error.code === "INTAKE_INVALID") {
        return res.status(400).json({ error: error.message });
      }
      console.error("Customer intake submission failed:", error);
      res.status(500).json({
        error: "We couldn't save your store request just now. Please try again in a few minutes, or email us and we'll set it up for you."
      });
    }
  }
);

/* -----------------------------------------------------------------------------
   Start (or restart) the store build for an intake from the New Stores queue.
   Safe to click twice: an already-running build refuses to double-start, and a
   finished build re-runs additively - existing products are skipped, nothing is
   ever deleted or overwritten.
   -------------------------------------------------------------------------- */
app.post("/api/customer-intakes/:id/build", requireAdminToken, async (req, res) => {
  try {
    const result = await startIntakeBuild(req.params.id, { force: Boolean(req.body?.force) });
    if (!result.started) return res.status(409).json({ error: result.reason });
    res.status(202).json({ started: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* -----------------------------------------------------------------------------
   Operator supplies the order link for a built product whose blank had no
   source page (vendor never stated → generated lookalike). Two writes: the
   intake record, so the store page and printable doc show the link at once,
   and the supplier link book keyed by this garment's vendor|style|color|type,
   so the NEXT build of the same combination carries the link automatically
   even when the form names no vendor.
   -------------------------------------------------------------------------- */
app.post("/api/customer-intakes/:id/blank-source", requireAdminToken, async (req, res) => {
  const url = String(req.body?.url || "").trim();
  const productId = String(req.body?.productId || "").trim();
  const title = String(req.body?.title || "").trim();
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("not http(s)");
  } catch {
    return res.status(400).json({ error: "Enter the full supplier product page URL, starting with https://." });
  }
  if (!productId && !title) return res.status(400).json({ error: "productId or title is required." });

  try {
    const record = await getCustomerIntake(req.params.id);
    const entry = (record.build?.products || []).find(
      (p) =>
        (productId && String(p.productId || "") === productId) ||
        (title && String(p.title || "").toLowerCase() === title.toLowerCase())
    );
    if (!entry) return res.status(404).json({ error: "No built product on this store matches that id or title." });
    entry.blankSourceUrl = url;

    // Book the link under the same key the next build computes for this
    // garment (split products "Title - logo" match their intake product by
    // prefix). No match just skips the book; the record still updates.
    const builtTitle = String(entry.title || "").toLowerCase();
    const intakeProduct = (intakeFromCustomerRecord(record).products || []).find((p) => {
      const t = String(p.productLabel || p.productType || "Product").toLowerCase();
      return builtTitle === t || builtTitle.startsWith(`${t} - `);
    });
    let linkBookKey = null;
    if (intakeProduct) {
      linkBookKey = blankCacheKey(intakeProduct);
      await saveSupplierLink(linkBookKey, {
        vendor: intakeProduct.vendor || "",
        brandStyle: intakeProduct.brandStyle || "",
        garmentColor: intakeProduct.garmentColor || "",
        productType: intakeProduct.productType || "",
        status: "operator",
        sourceUrl: url,
        source: "console",
        savedAt: new Date().toISOString()
      });
      clearCachedBlank(linkBookKey);
    }

    const intake = await updateCustomerIntake(req.params.id, { build: record.build });
    res.json({ intake, product: entry, linkBookKey });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/customer-intakes", requireAdminToken, async (req, res) => {
  try {
    res.json({ intakes: await listCustomerIntakes() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/customer-intakes/:id", requireAdminToken, async (req, res) => {
  try {
    res.json({ intake: await getCustomerIntake(req.params.id) });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

/* The intake as a document: single source of truth for the console's document
   panel, its print/PDF view, and the copy archived to Drive during builds. */
app.get("/api/customer-intakes/:id/document", requireAdminToken, async (req, res) => {
  try {
    const record = await getCustomerIntake(req.params.id);
    res.json({
      departmentName: record.store.departmentName,
      requestId: record.requestId,
      html: intakeDocumentHtml(record)
    });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

/* What lives in the store's Drive folder - the root files plus the Logos and
   Product Images subfolders. Read-only; the console's store page renders it. */
app.get("/api/customer-intakes/:id/drive", requireAdminToken, async (req, res) => {
  try {
    const record = await getCustomerIntake(req.params.id);
    if (!googleConnected()) return res.json({ connected: false, folder: null, groups: [] });
    const parentId = process.env.GDRIVE_PARENT_FOLDER_ID;
    if (!parentId) return res.json({ connected: true, folder: null, groups: [] });
    const root = await findFolder(record.store.departmentName, parentId);
    if (!root) return res.json({ connected: true, folder: null, groups: [] });

    const groups = [];
    const rootFiles = (await listFilesInFolder(root.id)).filter(
      (file) => file.mimeType !== "application/vnd.google-apps.folder"
    );
    groups.push({ name: "Store folder", files: rootFiles });
    for (const sub of ["Logos", "Product Images"]) {
      const folder = await findFolder(sub, root.id);
      if (folder) groups.push({ name: sub, folderUrl: folder.webViewLink || null, files: await listFilesInFolder(folder.id) });
    }
    res.json({
      connected: true,
      folder: { id: root.id, name: root.name, url: root.webViewLink || `https://drive.google.com/drive/folders/${root.id}` },
      groups
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* -----------------------------------------------------------------------------
   Delete a customer store COMPLETELY: every product, the Shopify collection,
   the department's Drive folder, and the intake record itself. This is the
   one deliberately destructive path in the intake pipeline, so it demands
   the exact department name typed back (the console asks twice before even
   sending the request) and refuses while a build is running.
   -------------------------------------------------------------------------- */
app.delete("/api/customer-intakes/:id", requireAdminToken, async (req, res) => {
  try {
    const record = await getCustomerIntake(req.params.id);
    const departmentName = record.store.departmentName || "";

    if (isBuildActive(req.params.id)) {
      return res.status(409).json({ error: "A build for this store is running right now. Wait for it to finish, then delete." });
    }
    const confirmName = String(req.body?.confirmName || "").trim();
    if (!confirmName || confirmName.toLowerCase() !== departmentName.toLowerCase()) {
      return res.status(400).json({ error: `Deletion not confirmed: send confirmName matching "${departmentName}".` });
    }

    const summary = { departmentName, deletedProducts: [], collectionDeleted: false, collectionSharedWith: [], driveFolderTrashed: false, recordTrashed: false, errors: [] };

    // Builds reuse a collection by department title, so a second request for
    // the same department shares this record's collection. Emptying and
    // deleting it would strand that other record with a pointer to nothing -
    // a "complete" build whose products and images are gone from Shopify.
    // When the collection is shared, or sharing cannot be proven because the
    // queue would not list in full, only this record's own products go and
    // the collection stays.
    const collectionId = record.shopifyCollection?.id ? String(record.shopifyCollection.id) : "";
    let collectionShared = false;
    if (collectionId) {
      try {
        const intakes = await listCustomerIntakes();
        const unreadable = intakes.filter((intake) => intake.status === "error");
        const sharers = intakes.filter(
          (intake) => intake.id !== record.id && String(intake.shopifyCollection?.id || "") === collectionId
        );
        summary.collectionSharedWith = sharers.map((intake) => intake.store?.departmentName || intake.id);
        collectionShared = sharers.length > 0 || unreadable.length > 0;
        if (unreadable.length && !sharers.length) {
          summary.errors.push(
            `${unreadable.length} store record(s) could not be read, so the collection might be shared; it and any products not recorded on this request were kept.`
          );
        }
      } catch (error) {
        collectionShared = true;
        summary.errors.push(
          `Could not check whether the collection is shared with another store request (${error.message}); it and any products not recorded on this request were kept.`
        );
      }
    }

    // Products: everything the build recorded (a product whose collection-add
    // failed is only in the record), plus everything in the collection when
    // the collection belongs to this record alone.
    const productIds = new Set();
    for (const product of record.build?.products || []) {
      if (product?.productId) productIds.add(String(product.productId));
    }
    if (collectionId && !collectionShared) {
      try {
        const collection = await getCollectionWithProducts(collectionId);
        for (const product of collection.products || []) {
          if (product?.id) productIds.add(String(product.id));
        }
      } catch (error) {
        summary.errors.push(`Could not list collection products: ${error.message}`);
      }
    }
    for (const productId of productIds) {
      try {
        await deleteProduct(gid("Product", productId));
        summary.deletedProducts.push(productId);
      } catch (error) {
        summary.errors.push(`Product ${productId}: ${error.message}`);
      }
    }

    if (collectionId && !collectionShared) {
      try {
        await deleteCollection(collectionId);
        summary.collectionDeleted = true;
      } catch (error) {
        summary.errors.push(`Collection: ${error.message}`);
      }
    }

    // Drive: the department's asset folder (trash, recoverable for 30 days),
    // then the intake record file itself.
    try {
      const folder = departmentName && process.env.GDRIVE_PARENT_FOLDER_ID
        ? await findFolder(departmentName, process.env.GDRIVE_PARENT_FOLDER_ID)
        : null;
      if (folder) {
        await trashFile(folder.id);
        summary.driveFolderTrashed = true;
      }
    } catch (error) {
      summary.errors.push(`Drive folder: ${error.message}`);
    }
    try {
      await deleteCustomerIntakeRecord(record.id);
      summary.recordTrashed = true;
    } catch (error) {
      summary.errors.push(`Intake record: ${error.message}`);
    }

    console.log(`[intake-delete] ${departmentName}: ${summary.deletedProducts.length} products, collection ${summary.collectionDeleted}, drive ${summary.driveFolderTrashed}, record ${summary.recordTrashed}${summary.errors.length ? `, errors: ${summary.errors.join(" | ")}` : ""}`);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/customer-intakes/:id", requireAdminToken, async (req, res) => {
  try {
    // Build state and the collection pointer are owned by the builder (which
    // writes the record directly), never by an HTTP client. A stale snapshot
    // PATCHed back from the review UI must not overwrite either - nulling the
    // collection pointer would un-protect the store from /cleanup.
    const { build, shopifyCollection, ...patch } = req.body || {};
    res.json({ intake: await updateCustomerIntake(req.params.id, patch) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/* ---------------------------------------------------------------------------
   Department Onboarding Agent — /api/onboardings/* and /api/reference/*.
   Everything an operator does from #/onboarding lives in onboardingRoutes.js;
   the router is admin-gated with the same middleware as the intake queue.
   ------------------------------------------------------------------------- */
app.use("/api", createOnboardingRouter({ requireAdminToken, upload }));

app.get("/setup", (req, res) => {
  return res.sendFile(path.join(__dirname, "public", "setup.html"));
});

// Starting an OAuth flow (or dropping a connection) rewires which accounts
// the platform runs on - operator actions, never public ones. The callbacks
// below stay open because Google and Shopify redirect to them tokenless.
app.get("/auth/shopify", requireAdminToken, (req, res, next) => {
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

app.post("/auth/shopify/disconnect", requireAdminToken, async (req, res) => {
  await disconnectShopify();
  res.json({ ok: true, service: "shopify", connected: false });
});

app.post("/auth/google/disconnect", requireAdminToken, async (req, res) => {
  await disconnectGoogle();
  res.json({ ok: true, service: "google", connected: false });
});

app.get("/auth/google", requireAdminToken, (req, res, next) => {
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
   Catalog API — browse and edit what is already live in Shopify.
   Onboarding creates a department; these routes are how the console then
   works with it. Every Shopify collection is treated as one department.
   ------------------------------------------------------------------------- */

function requireShopify(res) {
  if (shopifyConnected()) return true;
  res.status(401).json({ error: "Shopify is not connected. Open Connections to link the store." });
  return false;
}

// Shopify's own errors are the useful ones here (a frozen store answers 402
// "Unavailable Shop", a bad id answers 404), so they are passed through rather
// than flattened into a generic failure. A record that points at a collection
// or product Shopify no longer has is a 404 of its own, so the console can
// tell "deleted in admin" apart from "Shopify is down".
function catalogError(res, error) {
  const message = String(error?.message || "Shopify request failed.");
  const status = /^Shopify (4\d\d|5\d\d)/.test(message) ? 502 : / was not found in Shopify\.?$/.test(message) ? 404 : 500;
  console.error("Catalog API:", message);
  res.status(status).json({ error: message });
}

app.get("/api/collections", async (req, res) => {
  if (!requireShopify(res)) return;
  try {
    res.json({ collections: await listCollections() });
  } catch (error) {
    catalogError(res, error);
  }
});

app.get("/api/collections/:id", async (req, res) => {
  if (!requireShopify(res)) return;
  try {
    res.json(await getCollectionWithProducts(req.params.id));
  } catch (error) {
    catalogError(res, error);
  }
});

app.get("/api/products/:id", async (req, res) => {
  if (!requireShopify(res)) return;
  try {
    res.json({ product: await getProduct(req.params.id) });
  } catch (error) {
    catalogError(res, error);
  }
});

app.patch("/api/products/:id", async (req, res) => {
  if (!requireShopify(res)) return;
  const body = req.body || {};
  const fields = {};
  for (const key of ["title", "descriptionHtml", "productType", "vendor", "status", "tags", "price"]) {
    if (body[key] !== undefined) fields[key] = body[key];
  }

  if (fields.title !== undefined && !String(fields.title).trim()) {
    return res.status(400).json({ error: "Product title cannot be empty." });
  }
  if (fields.price !== undefined && String(fields.price).trim()) {
    const price = Number(fields.price);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: "Price must be a number of 0 or more." });
    }
  }
  if (fields.status !== undefined && !["ACTIVE", "DRAFT", "ARCHIVED"].includes(fields.status)) {
    return res.status(400).json({ error: "Status must be ACTIVE, DRAFT, or ARCHIVED." });
  }
  if (!Object.keys(fields).length) {
    return res.status(400).json({ error: "No editable fields were supplied." });
  }

  try {
    res.json({ product: await updateProduct(req.params.id, fields) });
  } catch (error) {
    catalogError(res, error);
  }
});

/* ---------------------------------------------------------------------------
   Create one product inside an existing department, from a description plus
   logos — the manual counterpart to policy-driven onboarding. Streams SSE
   because the image generation step takes tens of seconds.
   ------------------------------------------------------------------------- */
app.post(
  "/api/collections/:id/products",
  upload.fields([{ name: "logos", maxCount: 20 }]),
  async (req, res) => {
    if (!requireShopify(res)) return;

    const collectionId = req.params.id;
    const description = String(req.body.description || "").trim();
    const logos = req.files?.logos || [];
    const price = String(req.body.price || "").trim() || process.env.DEFAULT_PRODUCT_PRICE || "24.00";
    const sizes = String(req.body.sizes || "")
      .split(",")
      .map((size) => size.trim())
      .filter(Boolean);
    const hints = {
      productLabel: String(req.body.productLabel || "").trim(),
      productType: String(req.body.productType || "").trim(),
      garmentColor: String(req.body.garmentColor || "").trim()
    };
    const placementInput = String(req.body.placement || "").trim();
    const vendor = String(req.body.vendor || "").trim() || process.env.DEFAULT_PRODUCT_VENDOR || "";

    if (!description) {
      return res.status(400).json({ error: "Describe the product before creating it." });
    }
    if (!logos.length) {
      return res.status(400).json({ error: "Upload at least one logo image." });
    }
    if (!Number.isFinite(Number(price)) || Number(price) < 0) {
      return res.status(400).json({ error: "Price must be a number of 0 or more." });
    }

    let collection;
    try {
      collection = (await getCollectionWithProducts(collectionId)).collection;
    } catch (error) {
      return catalogError(res, error);
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

    try {
      const plan = await runStep(res, 1, "Read the description", async () =>
        planCustomProduct(description, hints)
      );

      const product = {
        ...plan,
        sizes: sizes.length ? sizes : DEFAULT_SIZES,
        placement: placementInput,
        productionNotes: description,
        sizeChart: null
      };
      // An explicit placement wins; otherwise fall back to the same garment-aware
      // default the onboarding pipeline uses (hats to the front panel, everything
      // else to the left chest).
      const placementKey = placementInput
        ? resolvePlacement({ placement: placementInput, productType: product.productType, productLabel: product.productLabel })
        : resolvePlacement(product);

      const baseBuffer = await runStep(res, 2, "Find or generate the blank garment photo", async () => {
        const supplier = await findSupplierBlank(product, {
          onLog: (message) => console.log(`[blanks] ${product.productLabel}: ${message}`)
        });
        return (
          supplier.imageBuffer ||
          generateBlankGarment({
            productPrompt: product.productPrompt,
            garmentColor: product.garmentColor,
            brandStyle: product.brandStyle,
            spec: supplier.spec,
            imageGuidance: placementGuidance(placementInput || placementKey, product.decorationSizeTier)
          })
        );
      });

      const logoVariants = await runStep(res, 3, "Composite the uploaded logos", async () => {
        const variants = [];
        for (const logo of logoRuns) {
          let mockupBuffer;
          try {
            mockupBuffer = await compositeLogoOnGarment(baseBuffer, logo.file.buffer, placementKey);
          } catch (error) {
            throw new Error(`Could not place logo "${logo.originalName}": ${error.message}`);
          }
          variants.push({ logo, mockupBuffer, mockupDataUrl: `data:image/png;base64,${mockupBuffer.toString("base64")}` });
        }
        return variants;
      });

      const descriptionHtml = await runStep(res, 4, "Write the product description", async () =>
        generateProductDescription(collection.title, {
          ...product,
          placement: placementInput || placementKey.replace(/-/g, " ")
        })
      );

      const created = await runStep(res, 5, "Create the Shopify product", async () => {
        const productSlug = slug(product.productLabel || product.productType || "product");
        const shopifyProduct = await createProductWithVariants({
          title: product.productLabel,
          bodyHtml: descriptionHtml,
          price,
          productType: product.productType,
          vendor,
          tags: [collection.title],
          logoValues: logoVariants.map((lv) => lv.logo.filenameBase),
          sizes: product.sizes
        });

        const idsByLogo = variantIdsByLogo(shopifyProduct.variants, shopifyProduct.useLogoOption);
        await uploadProductImages(
          shopifyProduct.productGid,
          logoVariants.map((lv) => ({
            filename: `${productSlug}-${lv.logo.slug || "logo"}-mockup.png`,
            buffer: lv.mockupBuffer,
            alt: `${product.productLabel} — ${lv.logo.filenameBase}`,
            variantIds: idsByLogo.get(shopifyProduct.useLogoOption ? lv.logo.filenameBase : "__all__") || []
          }))
        );
        return shopifyProduct;
      });

      await runStep(res, 6, "Add the product to the department", async () =>
        addProductToCollection(created.productId, collection.id)
      );

      sendEvent(res, "created", {
        product: {
          id: created.productId,
          title: created.title,
          url: adminProductUrl(created.productId),
          variantCount: created.variantCount,
          logoCount: logoVariants.length,
          thumbnail: logoVariants[0]?.mockupDataUrl || null
        },
        collection: { id: collection.id, title: collection.title }
      });
      res.end();
    } catch (error) {
      sendEvent(res, "error", { step: error.step || 0, error: error.message });
      res.end();
    }
  }
);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(`<pre>${err.message}</pre>`);
});

/* Tokens saved through the app (Google Connect, Shopify OAuth) persist in the
   platform's storage account; restore them before listening so the very first
   request already sees the connections. Env vars still win - hydration only
   fills keys that are empty. A storage hiccup degrades to env-only, it never
   stops the server. */
hydrateTokensFromStore()
  .then((restored) => {
    if (restored.length) console.log(`[auth] restored ${restored.join(", ")} from platform storage`);
  })
  .catch((error) => console.warn(`[auth] token restore failed (${error.message}); continuing with env-configured tokens only`))
  .then(() => startServer());

function startServer() {
app.listen(PORT, () => {
  const setupNeeded = !hasRequiredTokens();
  const url = setupNeeded ? `http://localhost:${PORT}/setup` : `http://localhost:${PORT}/`;
  console.log(`FN Onboarding running at ${url}`);
  if (setupNeeded) openBrowser(url);

  /* Builds run in-process, so a deploy or replica restart kills them mid-
     flight. This watchdog picks dead builds back up: once shortly after boot
     (a build the old replica was running resumes within a couple of minutes)
     and on a slow tick forever after. Jittered so two replicas never scan in
     lockstep. */
  const resumeTick = () => {
    Promise.allSettled([
      resumeInterruptedBuilds().catch((error) => console.warn(`[intake-build] resume scan failed: ${error.message}`)),
      onboardingAgent
        .resumeInterruptedBuilds()
        .catch((error) => console.warn(`[onboarding] resume scan failed: ${error.message}`))
    ]).finally(() => setTimeout(resumeTick, 2 * 60 * 1000 + Math.floor(Math.random() * 30 * 1000)));
  };
  setTimeout(resumeTick, 15 * 1000 + Math.floor(Math.random() * 15 * 1000));
});
}

/* Container Apps sends SIGTERM and allows a grace period before the kill.
   Marking in-flight builds "interrupted" costs one blob write per build and
   lets the next replica resume them immediately instead of waiting out the
   heartbeat staleness window. */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const marked = await markActiveBuildsInterrupted(signal);
    if (marked) console.log(`[intake-build] ${marked} build(s) marked interrupted on ${signal}`);
  } catch (error) {
    console.warn(`[intake-build] could not mark builds interrupted: ${error.message}`);
  }
  try {
    const marked = await onboardingAgent.markActiveBuildsInterrupted(signal);
    if (marked) console.log(`[onboarding] ${marked} build(s) marked interrupted on ${signal}`);
  } catch (error) {
    console.warn(`[onboarding] could not mark onboarding builds interrupted: ${error.message}`);
  }
  process.exit(0);
}
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});

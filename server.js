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
const { createDepartmentFolders, findFolder, listFilesInFolder, trashFile, uploadBuffer, uploadGeneratedImage, uploadHtmlDocument } = require("./drive");
const {
  analyzeLogo,
  analyzePolicyGaps,
  collectPolicyText,
  determinePolicyProducts,
  extractReadableText,
  extractPolicyInstructions,
  generateBlankGarment,
  generateProductDescription,
  planCustomProduct
} = require("./ai");
const {
  getCollectionWithProducts,
  getProduct,
  listCollections,
  updateProduct
} = require("./catalog");
const { compositeLogoOnGarment, resolvePlacement } = require("./mockup");
const { placementGuidance } = require("./placements");
const { findSupplierBlank } = require("./blanks");
const {
  combineIntakes,
  intakeContextText,
  intakeTags,
  mergeIntakeProducts,
  parseStructuredIntakeText
} = require("./intake");
const { answerDashboardAgent, platformStatus } = require("./agents");
const {
  createCustomerIntake,
  getCustomerIntake,
  intakeDocumentHtml,
  listCustomerIntakes,
  updateCustomerIntake
} = require("./customerIntakes");
const { azureTextToSpeech, azureTranscribeAudio, generateImage } = require("./azureOpenai");
const { startIntakeBuild } = require("./intakeBuild");
const {
  DEFAULT_SIZES,
  MAX_VARIANTS,
  addProductToCollection,
  adminCollectionUrl,
  adminProductUrl,
  createProductWithVariants,
  deleteCollection,
  deleteProduct,
  ensureManualCollectionWithImage,
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
 * Pending runs are held in memory with a TTL. In the Azure container the
 * filesystem and process are ephemeral — a restart drops pending runs, so
 * approve promptly.
 *
 * After a publish the run stays behind (buffers dropped) as a cleanup
 * manifest, so POST /cleanup can undo the whole run — delete its Shopify
 * products, delete the Shopify collection, and move the Drive folder to
 * trash for up to 24 hours.
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

async function collectStructuredIntake(files) {
  const parsed = [];
  for (const file of files || []) {
    parsed.push(parseStructuredIntakeText(await extractReadableText(file)));
  }
  return combineIntakes(parsed);
}

function combinedPolicyContext(policyText, intake) {
  return [policyText, intakeContextText(intake)].filter((part) => part && part.trim()).join("\n\n");
}

function uniqueTags(tags) {
  return [...new Set((tags || []).map((tag) => String(tag || "").trim()).filter(Boolean))];
}

function intakeResponse(intake) {
  if (!intake?.present) return null;
  return {
    present: true,
    ready: intake.ready,
    departmentName: intake.departmentName,
    departmentCode: intake.departmentCode,
    missing: intake.missing || [],
    summary: intake.summary
  };
}

function requestOrigin(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol;
  return proto + "://" + req.get("host");
}

// Collapse a logo reference to a comparison key. Departments write their codes
// as "DIX-F01" while the file arrives as "dix_f01.png", so punctuation, case,
// and the extension must not decide whether an assignment matches.
function logoKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function resolveProductLogos(product, logoRuns) {
  const requested = Array.isArray(product.logoSlugs)
    ? product.logoSlugs.map((value) => String(value).trim()).filter(Boolean)
    : [];

  // Nothing stated: offer the whole set, which is how a department that never
  // told us which logo goes where should be merchandised.
  if (!requested.length || requested.some((value) => value.toLowerCase() === "all")) return logoRuns;

  const byKey = new Map();
  for (const logo of logoRuns) {
    byKey.set(logoKey(logo.slug || logo.originalName), logo);
    byKey.set(logoKey(logo.originalName), logo);
  }

  const selected = [];
  for (const value of requested) {
    const match = byKey.get(logoKey(value));
    if (match && !selected.includes(match)) selected.push(match);
  }

  // An assignment that matches no uploaded file is a bad extraction, not an
  // instruction to publish a garment with no artwork on it.
  return selected.length ? selected : logoRuns;
}

function adminToken() {
  return String(process.env.FN_ADMIN_TOKEN || "").trim();
}

function tokenFromRequest(req) {
  const bearer = String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer || String(req.get("x-admin-token") || req.query.admin || "").trim();
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

app.post("/api/agents/dashboard/voice", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) throw new Error("Send an audio clip to transcribe.");
    const transcript = await azureTranscribeAudio({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype || "audio/webm",
      filename: req.file.originalname || "voice.webm",
      language: req.body.language || "en"
    });
    if (!transcript) throw new Error("I could not hear any words in that clip.");

    let messages = [];
    if (req.body.messages) {
      try {
        messages = JSON.parse(req.body.messages);
      } catch {
        messages = [];
      }
    }
    messages = Array.isArray(messages) ? messages : [];
    messages.push({ role: "user", content: transcript });

    const answer = await answerDashboardAgent({ messages });
    let audio = null;
    try {
      audio = await azureTextToSpeech({
        text: answer.reply,
        voice: req.body.voice,
        speed: Number(req.body.speed || 1.04),
        format: req.body.format || "mp3"
      });
    } catch (speechError) {
      console.warn("Azure speech synthesis unavailable:", speechError.message);
    }

    res.json({
      transcript,
      reply: answer.reply,
      context: answer.context,
      audio
    });
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
        record = await updateCustomerIntake(record.id, {
          status: "collection-error",
          internalNotes: "Collection was not created automatically: " + collectionError.message
        });
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
      res.status(400).json({ error: error.message });
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

/* ---------------------------------------------------------------------------
   Pre-flight — analyze the policy and draft the gaps email WITHOUT creating
   anything: no Drive folders, no images, no Shopify. Fast and side-effect
   free, so the user can get the email out to the department first and only run
   the full onboarding once the answers are in. Doesn't require Drive/Shopify
   to be connected — only OpenAI.
   ------------------------------------------------------------------------- */
app.post(
  "/analyze",
  upload.fields([
    { name: "logos", maxCount: 20 },
    { name: "policies", maxCount: 20 },
    { name: "followUps", maxCount: 20 },
    { name: "intakeForms", maxCount: 5 }
  ]),
  async (req, res) => {
    try {
      const departmentName = String(req.body.departmentName || "").trim();
      const followUpText = String(req.body.followUpText || "");
      const uploadedFiles = req.files || {};
      const allFiles = [
        ...(uploadedFiles.logos || []),
        ...(uploadedFiles.policies || []),
        ...(uploadedFiles.followUps || []),
        ...(uploadedFiles.intakeForms || [])
      ];
      const logos = filesByField(allFiles, "logos");
      const policies = filesByField(allFiles, "policies");
      const followUps = filesByField(allFiles, "followUps");
      const intakeForms = filesByField(allFiles, "intakeForms");

      const intake = await collectStructuredIntake(intakeForms);
      const policyText = combinedPolicyContext(await collectPolicyText(policies, followUps, followUpText), intake);
      if (!policyText.trim()) {
        return res.status(400).json({ error: "Add a policy document, store build form, or paste follow-up text to analyze." });
      }

      // Logo catalog by filename only — no Vision call in the pre-flight keeps
      // it fast; logo assignment still works from the names.
      const logoRuns = logos.map((file) => ({
        originalName: file.originalname,
        filenameBase: titleCase(file.originalname),
        slug: slug(file.originalname),
        logoDescription: ""
      }));
      dedupeLogoLabels(logoRuns);

      const deptForPrompt = departmentName || intake.departmentName || "the department";
      const products = mergeIntakeProducts(await determinePolicyProducts(deptForPrompt, policyText, logoRuns), intake);
      const gaps = await analyzePolicyGaps(deptForPrompt, policyText, products, logoRuns);

      res.json({
        departmentName: departmentName || intake.departmentName,
        gaps: { confidence: gaps.confidence, missing: gaps.missing },
        emailDraft: gaps.emailDraft,
        intake: intakeResponse(intake),
        products: products.map((product) => ({
          productLabel: product.productLabel,
          garmentColor: product.garmentColor,
          brandStyle: product.brandStyle,
          fabricDetails: product.fabricDetails,
          placement: product.placement || resolvePlacement(product).replace(/-/g, " "),
          placementStated: Boolean(product.placement),
          decorationMethod: product.decorationMethod,
          decorationSizeTier: product.decorationSizeTier || "",
          decorationFeeSku: product.decorationFeeSku || "",
          intakeSource: Boolean(product.intakeSource),
          sizes: product.sizes.length ? product.sizes : DEFAULT_SIZES,
          sizesStated: product.sizes.length > 0,
          logos: resolveProductLogos(product, logoRuns).map((logo) => logo.filenameBase),
          logoAssignmentStated: Boolean(product.logoAssignmentStated)
        }))
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.post(
  "/onboard",
  upload.fields([
    { name: "logos", maxCount: 20 },
    { name: "policies", maxCount: 20 },
    { name: "followUps", maxCount: 20 },
    { name: "intakeForms", maxCount: 5 }
  ]),
  async (req, res) => {
    let departmentName = String(req.body.departmentName || "").trim();
    const followUpText = String(req.body.followUpText || "");
    const conflictStrategy = req.body.conflictStrategy || "fail";
    const uploadedFiles = req.files || {};
    const allFiles = [
      ...(uploadedFiles.logos || []),
      ...(uploadedFiles.policies || []),
      ...(uploadedFiles.followUps || []),
      ...(uploadedFiles.intakeForms || [])
    ];
    const logos = filesByField(allFiles, "logos");
    const policies = filesByField(allFiles, "policies");
    const followUps = filesByField(allFiles, "followUps");
    const intakeForms = filesByField(allFiles, "intakeForms");
    let intake = { present: false, products: [], missing: [], ready: null };
    try {
      intake = await collectStructuredIntake(intakeForms);
      if (!departmentName && intake.departmentName) departmentName = intake.departmentName;
    } catch (error) {
      return res.status(400).json({ step: 0, error: `Could not read the store build form: ${error.message}` });
    }

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
        for (const file of [...policies, ...followUps, ...intakeForms]) {
          await uploadBuffer(file, folders.root.id);
        }
      });

      await runStep(res, 3, "Analyze logos with GPT-4o Vision", async () => {
        for (const item of logoRuns) {
          item.logoDescription = await analyzeLogo(item.file);
        }
      });

      const policyText = combinedPolicyContext(await collectPolicyText(policies, followUps, followUpText), intake);

      const policyProducts = await runStep(res, 4, "Extract products and logo assignments from policy documents and store build form", async () => {
        return mergeIntakeProducts(await determinePolicyProducts(departmentName, policyText, logoRuns), intake);
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
          //
          // Prefer the supplier's own photo of the style the department
          // actually ordered — a generated garment can only ever be a lookalike
          // of a style number. Generation is the fallback, and it uses the
          // specs the lookup fetched so the lookalike is at least close.
          const supplier = await findSupplierBlank(item, {
            onLog: (message) => console.log(`[blanks] ${item.productLabel}: ${message}`)
          });
          item.blankSource = supplier.imageBuffer ? "supplier" : "generated";
          item.blankNote = supplier.note;
          item.blankSourceUrl = supplier.sourceUrl;

          // Fold the production placement standard into the prompt. The base is
          // still blank — what this changes is which FACE gets photographed, so
          // a center-back print composites onto a back view instead of a chest.
          const placementNote = placementGuidance(item.placement || item.placementKey, item.decorationSizeTier);

          item.baseBuffer =
            supplier.imageBuffer ||
            (await generateBlankGarment({
              productPrompt: item.productPrompt,
              garmentColor: item.garmentColor,
              brandStyle: item.brandStyle,
              spec: supplier.spec,
              imageGuidance: [item.imageGuidance, placementNote].filter(Boolean).join(" ")
            }));

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
            productionNotes: [
              item.productionNotes,
              item.assignmentNotes ? `Logo assignment: ${item.assignmentNotes}` : "",
              item.decorationFeeSku ? `Decoration fee SKU hint: ${item.decorationFeeSku}` : ""
            ]
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
        intake,
        collectionImage: logoRuns[0]
          ? {
              buffer: logoRuns[0].file.buffer,
              alt: `${departmentName} logo`
            }
          : null,
        expiresAt: Date.now() + RUN_TTL_MS
      });

      sendEvent(res, "review", {
        runId,
        departmentName,
        driveFolderUrl: folders.url,
        manualUrl: manual?.webViewLink || null,
        emailDraftDocUrl: emailDraftDoc?.webViewLink || null,
        gaps: { confidence: gaps.confidence, missing: gaps.missing },
        intake: intakeResponse(intake),
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
          decorationSizeTier: item.decorationSizeTier || "",
          decorationFeeSku: item.decorationFeeSku || "",
          intakeSource: Boolean(item.intakeSource),
          sizes: item.sizes.length ? item.sizes : DEFAULT_SIZES,
          sizesStated: item.sizes.length > 0,
          productionNotes: item.productionNotes,
          logoAssignmentStated: Boolean(item.logoAssignmentStated),
          blankSource: item.blankSource || "generated",
          blankNote: item.blankNote || "",
          blankSourceUrl: item.blankSourceUrl || null,
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
      return ensureManualCollectionWithImage(run.departmentName, run.collectionImage);
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
            tags: uniqueTags([run.departmentName, ...intakeTags(run.intake), item.decorationFeeSku, item.decorationSizeTier ? `decoration-${item.decorationSizeTier}` : ""]),
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
   Undo a published run: delete its Shopify products, delete the Shopify
   collection for the run, and move the Drive department folder to trash
   (recoverable from Drive's trash for ~30 days).
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

  const { collectionId, productGids, driveFolderId } = run.cleanup;

  // HARD STOP: a collection that any customer intake points at is a store a
  // real department filled a form for and sent our way. The operator console's
  // cleanup must never be able to take it down - even when the operator also
  // ran a manual onboarding under the same department name (ensureManual-
  // Collection reuses collections by title, so the ids collide by design).
  try {
    const intakes = await listCustomerIntakes();
    // A record that failed to parse contributes no collection id, which would
    // quietly un-protect that customer's store. Unreadable record = no proof
    // of safety = no cleanup.
    const unreadable = intakes.filter((intake) => intake.status === "error");
    if (unreadable.length) {
      return res.status(503).json({
        error:
          `${unreadable.length} customer store record(s) could not be read, so this run cannot be proven safe to clean up. ` +
          "Fix or remove the unreadable record(s) in the Customer Store Intakes Drive folder first."
      });
    }
    const protectedIds = new Set(
      intakes
        .map((intake) => String(intake.shopifyCollection?.id || ""))
        .filter(Boolean)
    );
    if (protectedIds.has(String(collectionId))) {
      return res.status(403).json({
        error:
          "This collection belongs to a customer-submitted store request and cannot be deleted from here. " +
          "If it truly must go, do it manually in Shopify admin where the deletion is deliberate."
      });
    }
  } catch (guardError) {
    // The guard failing OPEN would let a customer store be deleted the one time
    // Drive hiccups. Fail CLOSED instead: no proof it's safe, no cleanup.
    return res.status(503).json({
      error: `Could not verify this run against customer store requests (${guardError.message}). Cleanup refused to be safe.`
    });
  }

  const result = {
    ok: true,
    deletedProducts: 0,
    collectionDeleted: false,
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
    await deleteCollection(collectionId);
    result.collectionDeleted = true;
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
// than flattened into a generic failure.
function catalogError(res, error) {
  const message = String(error?.message || "Shopify request failed.");
  const status = /^Shopify (4\d\d|5\d\d)/.test(message) ? 502 : 500;
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

app.listen(PORT, () => {
  const setupNeeded = !hasRequiredTokens();
  const url = setupNeeded ? `http://localhost:${PORT}/setup` : `http://localhost:${PORT}/`;
  console.log(`FN Onboarding running at ${url}`);
  if (setupNeeded) openBrowser(url);
});

/* -----------------------------------------------------------------------------
   Intake → store builder.

   Turns a submitted customer intake into a real store, end to end: collection,
   supplier-verified garment photos, composited logo mockups, Drive assets, and
   Shopify products. This is the same pipeline the operator-driven /onboard flow
   runs, fed from the fixed-field customer form instead of policy documents.

   Three properties this file exists to guarantee:

   1. ADDITIVE ONLY. Nothing in here deletes or overwrites anything - not a
      product, not a collection, not a Drive file. A re-run (double submit,
      operator clicking Build twice, a retry after a crash) SKIPS work that
      already exists instead of recreating it. There is deliberately no undo
      path for customer-submitted stores.

   2. REVIEW-GATED. Products are created as DRAFT. The store exists, images and
      variants and all, but a customer cannot see it until an operator flips
      products live in Shopify admin. Auto-building on submit is safe because
      building is not publishing.

   3. OBSERVABLE. Progress is written into the intake record step by step, so
      the New Stores queue can show exactly where a build is, survive a server
      restart mid-build, and show what failed without digging through logs.
   -------------------------------------------------------------------------- */

const { generateBlankGarment, generateProductDescription } = require("./ai");
const { findSupplierBlank } = require("./blanks");
const { compositeLogoOnGarment, resolvePlacement } = require("./mockup");
const { placementGuidance } = require("./placements");
const { parseStructuredIntakeText, combineIntakes, intakeTags } = require("./intake");
const {
  getCustomerIntake,
  structuredTextFromCustomerIntake,
  updateCustomerIntake
} = require("./customerIntakes");
const {
  DEFAULT_SIZES,
  MAX_VARIANTS,
  addProductToCollection,
  adminCollectionUrl,
  adminProductUrl,
  createProductWithVariants,
  ensureManualCollectionWithImage,
  shopifyConnected,
  uploadProductImages,
  variantIdsByLogo
} = require("./shopify");
const { getCollectionWithProducts } = require("./catalog");
const { createDepartmentFolders, uploadBuffer, uploadGeneratedImage } = require("./drive");
const { googleConnected } = require("./auth");

// One build per intake at a time. A Map because several DIFFERENT intakes may
// build concurrently; the guard is per record, not global.
const activeBuilds = new Map();

function slug(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function titleCase(input) {
  return String(input || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function logoKey(value) {
  return String(value || "").toLowerCase().replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]+/g, "");
}

function decodeLogos(record) {
  const runs = [];
  for (const logo of record.logos || []) {
    const match = String(logo.dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
    if (!match) continue;
    runs.push({
      originalName: logo.name || "logo",
      filenameBase: titleCase(logo.name || "Logo"),
      slug: slug(logo.name || "logo"),
      mimetype: match[1],
      buffer: Buffer.from(match[2], "base64")
    });
  }
  // Duplicate display names get a numeric suffix - Front Logo option values
  // must be unique per product.
  const used = new Map();
  for (const logo of runs) {
    const count = (used.get(logo.filenameBase) || 0) + 1;
    used.set(logo.filenameBase, count);
    if (count > 1) logo.filenameBase = `${logo.filenameBase} (${count})`;
  }
  return runs;
}

function resolveLogos(product, logoRuns) {
  const requested = (product.logoSlugs || []).map((value) => String(value).trim()).filter(Boolean);
  if (!requested.length || requested.some((value) => value.toLowerCase() === "all")) return logoRuns;
  const byKey = new Map();
  for (const logo of logoRuns) {
    byKey.set(logoKey(logo.slug), logo);
    byKey.set(logoKey(logo.originalName), logo);
  }
  const selected = [];
  for (const value of requested) {
    const match = byKey.get(logoKey(value));
    if (match && !selected.includes(match)) selected.push(match);
  }
  return selected.length ? selected : logoRuns;
}

/* ── Build-state bookkeeping ─────────────────────────────────────────────── */

function newBuildState(record) {
  return {
    state: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    requestId: record.requestId,
    steps: [],
    products: [],
    log: []
  };
}

async function saveBuild(intakeId, build, extra = {}) {
  // The record in Drive is the single source of truth the queue UI polls, so
  // every meaningful transition is flushed immediately.
  return updateCustomerIntake(intakeId, { build, ...extra });
}

function stepStart(build, key, label) {
  const step = { key, label, state: "running", startedAt: new Date().toISOString(), detail: "" };
  build.steps.push(step);
  return step;
}

function stepDone(step, detail = "") {
  step.state = "complete";
  step.detail = detail;
  step.finishedAt = new Date().toISOString();
}

function stepFail(step, error) {
  step.state = "failed";
  step.detail = String(error?.message || error);
  step.finishedAt = new Date().toISOString();
}

function log(build, message) {
  build.log.push(`${new Date().toISOString().slice(11, 19)} ${message}`);
  if (build.log.length > 300) build.log.splice(0, build.log.length - 300);
  console.log(`[intake-build] ${message}`);
}

/* ── The build itself ────────────────────────────────────────────────────── */

async function runBuild(intakeId, build, options) {
  let record = await getCustomerIntake(intakeId);
  const departmentName = record.store.departmentName;
  if (!departmentName) throw new Error("The intake has no department name.");
  if (!record.summary?.ready && !options.force) {
    throw new Error("The intake is missing required fields: " + (record.summary?.missing || []).join("; "));
  }
  if (!shopifyConnected()) throw new Error("Shopify is not connected.");

  /* Step 1 - products from the fixed fields. Deterministic: the form IS the
     spec, no model in the loop deciding what to build. */
  let step = stepStart(build, "plan", "Read the store request");
  const intake = combineIntakes([parseStructuredIntakeText(structuredTextFromCustomerIntake(record))]);
  const products = intake.products || [];
  if (!products.length) {
    stepFail(step, new Error("No included garment categories."));
    throw new Error("The intake has no included garment categories to build.");
  }
  const logoRuns = decodeLogos(record);
  if (!logoRuns.length) {
    stepFail(step, new Error("No usable logo files."));
    throw new Error("None of the uploaded logo files could be decoded.");
  }
  stepDone(step, `${products.length} garment${products.length === 1 ? "" : "s"}, ${logoRuns.length} logo file${logoRuns.length === 1 ? "" : "s"}`);
  await saveBuild(intakeId, build, { status: "building" });

  /* Step 2 - Shopify collection. ensureManualCollection* reuses an existing
     collection by title, so a resubmit lands in the same store. */
  step = stepStart(build, "collection", "Ensure the Shopify collection");
  const firstLogo = logoRuns[0];
  const collection = await ensureManualCollectionWithImage(
    departmentName,
    firstLogo ? { buffer: firstLogo.buffer, alt: `${departmentName} logo` } : null
  ).catch(async (error) => {
    log(build, `collection image failed (${error.message}); retrying without image`);
    return ensureManualCollectionWithImage(departmentName, null);
  });
  const collectionRef = { id: collection.id, title: collection.title, url: adminCollectionUrl(collection.id) };
  stepDone(step, collection.title);
  await saveBuild(intakeId, build, { shopifyCollection: collectionRef });

  /* Existing products in this collection, so a re-run skips instead of
     duplicating. Titles are the identity the pipeline itself uses. */
  const existingTitles = new Set();
  try {
    const current = await getCollectionWithProducts(collection.id);
    for (const product of current.products || []) existingTitles.add(String(product.title || "").toLowerCase());
  } catch (error) {
    log(build, `could not list existing products (${error.message}); building without skip-list`);
  }

  /* Step 3 - Drive folders. "skip" strategy: reuse the department folder if it
     exists. NEVER "overwrite", which would trash a folder. */
  step = stepStart(build, "drive", "Prepare the Drive folder");
  let folders = null;
  if (googleConnected()) {
    try {
      folders = await createDepartmentFolders(departmentName, "skip");
      for (const logo of logoRuns) {
        try {
          await uploadBuffer({ originalname: logo.originalName, mimetype: logo.mimetype, buffer: logo.buffer }, folders.logos.id);
        } catch (error) {
          log(build, `logo upload skipped (${logo.originalName}): ${error.message}`);
        }
      }
      stepDone(step, folders.root.name);
    } catch (error) {
      // Drive is asset archival, not the store. A Drive failure downgrades the
      // run instead of killing it.
      stepDone(step, `Drive unavailable (${error.message}) - continuing without Drive assets`);
      log(build, `drive failed: ${error.message}`);
    }
  } else {
    stepDone(step, "Google Drive not connected - skipping asset archival");
  }
  await saveBuild(intakeId, build);

  /* Step 4 - one product at a time: supplier photo (vendor-first web search),
     else generated base; composite every assigned logo; create as DRAFT. */
  const price = process.env.DEFAULT_PRODUCT_PRICE || "24.00";
  const defaultVendor = process.env.DEFAULT_PRODUCT_VENDOR || "";
  const built = [];
  const failures = [];

  for (const product of products) {
    const title = product.productLabel || product.productType || "Product";
    step = stepStart(build, `product:${slug(title)}`, title);

    if (existingTitles.has(title.toLowerCase())) {
      stepDone(step, "Already in the collection - skipped (never rebuilt, never deleted)");
      log(build, `skip existing product: ${title}`);
      await saveBuild(intakeId, build);
      continue;
    }

    try {
      const placement = product.placement || resolvePlacement(product).replace(/-/g, " ");
      const placementKey = resolvePlacement(product);

      // Vendor-first supplier lookup: the exact garment photo from the vendor
      // the customer named, verified by vision before it is trusted.
      const supplier = await findSupplierBlank(product, {
        onLog: (message) => log(build, `${title}: ${message}`)
      });

      const baseBuffer =
        supplier.imageBuffer ||
        (await generateBlankGarment({
          productPrompt: product.productPrompt || `a ${product.productType || "garment"}`,
          garmentColor: product.garmentColor,
          brandStyle: [product.vendor, product.brandStyle].filter(Boolean).join(" "),
          spec: supplier.spec,
          imageGuidance: [product.imageGuidance, placementGuidance(placement, product.decorationSizeTier)]
            .filter(Boolean)
            .join(" ")
        }));

      const logos = resolveLogos(product, logoRuns);
      const logoVariants = [];
      for (const logo of logos) {
        const mockupBuffer = await compositeLogoOnGarment(baseBuffer, logo.buffer, placementKey);
        let driveFile = null;
        if (folders) {
          try {
            driveFile = await uploadGeneratedImage(`${slug(title)}--${logo.slug}.png`, mockupBuffer, folders.productImages.id);
          } catch (error) {
            log(build, `drive upload skipped for ${title}/${logo.filenameBase}: ${error.message}`);
          }
        }
        logoVariants.push({ logo, mockupBuffer, driveFile });
      }

      const descriptionHtml = await generateProductDescription(departmentName, product).catch((error) => {
        log(build, `${title}: description generation failed (${error.message}); using fallback copy`);
        return `<p>${title} for ${departmentName}. Decoration: ${product.decorationMethod || "as specified"}, ${placement}.</p>`;
      });

      const sizes = product.sizes?.length ? product.sizes : DEFAULT_SIZES;
      const plans =
        logoVariants.length > 1 && logoVariants.length * sizes.length <= MAX_VARIANTS
          ? [{ title, logoVariants }]
          : logoVariants.map((lv) => ({
              title: logoVariants.length > 1 ? `${title} - ${lv.logo.filenameBase}` : title,
              logoVariants: [lv]
            }));

      for (const plan of plans) {
        if (existingTitles.has(plan.title.toLowerCase())) {
          log(build, `skip existing split product: ${plan.title}`);
          continue;
        }
        const created = await createProductWithVariants({
          title: plan.title,
          bodyHtml: descriptionHtml,
          price,
          productType: product.productType,
          vendor: product.vendor || defaultVendor,
          tags: [
            departmentName,
            ...intakeTags(intake),
            "customer-intake",
            product.decorationFeeSku || "",
            product.decorationSizeTier ? `decoration-${product.decorationSizeTier}` : ""
          ].filter(Boolean),
          logoValues: plan.logoVariants.map((lv) => lv.logo.filenameBase),
          sizes,
          status: "DRAFT"
        });

        const idsByLogo = variantIdsByLogo(created.variants, created.useLogoOption);
        await uploadProductImages(
          created.productGid,
          plan.logoVariants.map((lv) => ({
            filename: `${slug(plan.title)}-${lv.logo.slug}-mockup.png`,
            buffer: lv.mockupBuffer,
            alt: `${plan.title} — ${lv.logo.filenameBase}`,
            variantIds: idsByLogo.get(created.useLogoOption ? lv.logo.filenameBase : "__all__") || []
          }))
        );
        await addProductToCollection(created.productId, collection.id);

        existingTitles.add(plan.title.toLowerCase());
        built.push({
          title: created.title,
          productId: created.productId,
          url: adminProductUrl(created.productId),
          status: "DRAFT",
          variantCount: created.variantCount,
          logoCount: plan.logoVariants.length,
          blankSource: supplier.imageBuffer ? "supplier" : "generated",
          blankSourceUrl: supplier.sourceUrl || null,
          vendor: product.vendor || "",
          driveImageUrl: plan.logoVariants[0]?.driveFile?.webViewLink || null
        });
      }

      stepDone(step, `${supplier.imageBuffer ? "supplier photo" : "generated base"} · ${logos.length} logo${logos.length === 1 ? "" : "s"} · DRAFT`);
    } catch (error) {
      // One garment failing must not sink the other eleven. The step records
      // the failure; the summary marks the build partial.
      stepFail(step, error);
      failures.push(`${title}: ${error.message}`);
      log(build, `FAILED ${title}: ${error.message}`);
    }

    build.products = built;
    await saveBuild(intakeId, build);
  }

  build.state = failures.length ? (built.length ? "partial" : "failed") : "complete";
  build.error = failures.length ? failures.join(" | ") : null;
  build.finishedAt = new Date().toISOString();
  await saveBuild(intakeId, build, {
    status: failures.length ? (built.length ? "built-partial" : "build-error") : "built",
    internalNotes: failures.length
      ? `Build finished with failures: ${failures.join("; ")}`
      : `Store built: ${built.length} DRAFT product${built.length === 1 ? "" : "s"} awaiting review in Shopify admin.`
  });
  return { collection: collectionRef, products: built, failures };
}

/**
 * Start (or refuse to double-start) a build for an intake. Fire-and-forget
 * safe: all progress lands in the Drive record.
 */
async function startIntakeBuild(intakeId, options = {}) {
  if (activeBuilds.has(intakeId)) {
    return { started: false, reason: "A build for this store request is already running." };
  }
  const record = await getCustomerIntake(intakeId);
  if (record.build?.state === "running") {
    // A record can claim "running" after a server restart killed the build
    // mid-flight. Stale if untouched for 15+ minutes - allow a restart then.
    const started = Date.parse(record.build.startedAt || 0);
    const fresh = Date.now() - started < 15 * 60 * 1000;
    if (fresh && !options.force) {
      return { started: false, reason: "This store request is already building." };
    }
  }

  const build = newBuildState(record);
  activeBuilds.set(intakeId, build);
  const task = runBuild(intakeId, build, options)
    .catch(async (error) => {
      build.state = "failed";
      build.error = String(error.message || error);
      build.finishedAt = new Date().toISOString();
      await saveBuild(intakeId, build, { status: "build-error", internalNotes: `Build failed: ${build.error}` }).catch(() => {});
      console.error(`[intake-build] ${intakeId} failed:`, error);
    })
    .finally(() => activeBuilds.delete(intakeId));

  if (options.wait) await task;
  return { started: true, build };
}

function buildInProgress(intakeId) {
  return activeBuilds.has(intakeId);
}

module.exports = { buildInProgress, startIntakeBuild };

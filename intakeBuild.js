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

const sharp = require("sharp");
const { generateBlankGarment, generateProductDescription } = require("./ai");
const { findSupplierBlank } = require("./blanks");
const { resolvePlacement } = require("./mockup");
const { renderFaceImage } = require("./productImages");
const { placementFace, placementGuidance } = require("./placements");
const { intakeTags } = require("./intake");
const {
  getCustomerIntake,
  intakeDocumentHtml,
  intakeFromCustomerRecord,
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
const { createDepartmentFolders, listFilesInFolder, uploadBuffer, uploadGeneratedImage, uploadHtmlDocument } = require("./drive");
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
  if (!requested.length || requested.some((value) => value.toLowerCase() === "all")) {
    return { logos: logoRuns, missing: [] };
  }
  // Exact file names first (the picker stores them verbatim), the
  // extension-stripped fuzzy key only as a fallback for legacy free-text
  // entries - fuzzy-only keying let "station7.png" resolve to "station7.jpg".
  const byExact = new Map();
  const byFuzzy = new Map();
  for (const logo of logoRuns) {
    byExact.set(logo.originalName.toLowerCase().trim(), logo);
    if (!byFuzzy.has(logoKey(logo.slug))) byFuzzy.set(logoKey(logo.slug), logo);
    if (!byFuzzy.has(logoKey(logo.originalName))) byFuzzy.set(logoKey(logo.originalName), logo);
  }
  const selected = [];
  const missing = [];
  for (const value of requested) {
    const match = byExact.get(value.toLowerCase()) || byFuzzy.get(logoKey(value));
    if (match && !selected.includes(match)) selected.push(match);
    else if (!match) missing.push(value);
  }
  // An EXPLICIT assignment that matches nothing must not silently become "all
  // logos" - the customer specifically excluded the others. The caller fails
  // that product with a clear reason instead.
  return { logos: selected, missing };
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
     spec, no model in the loop deciding what to build. Built straight from the
     record, so every VARIANT of a category (different color, vendor, or logo
     assignment) becomes its own product - the old text round-trip could only
     see one version per category. */
  let step = stepStart(build, "plan", "Read the store request");
  const intake = intakeFromCustomerRecord(record);
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
  // Compositing runs through sharp, which cannot rasterize AI/EPS/PDF. Probe
  // now, before any paid generation, and drop what can't be placed - failing
  // per-product AFTER the base image was generated wastes credits, and a run
  // that dies on the first product for a file-format reason reads as broken.
  const compositable = [];
  for (const logo of logoRuns) {
    try {
      await sharp(logo.buffer).metadata();
      compositable.push(logo);
    } catch {
      log(build, `logo "${logo.originalName}" is not a raster format sharp can place (AI/EPS/PDF need conversion); archived to Drive but not composited`);
    }
  }
  if (!compositable.length) {
    stepFail(step, new Error("No logo file is in a format that can be placed on garments (upload a PNG/JPG version alongside vector files)."));
    throw new Error("None of the uploaded logos can be composited: upload a PNG or JPG version alongside vector artwork.");
  }
  stepDone(step, `${products.length} garment${products.length === 1 ? "" : "s"}, ${logoRuns.length} logo file${logoRuns.length === 1 ? "" : "s"}`);
  await saveBuild(intakeId, build, { status: "building" });

  /* Step 2 - Shopify collection. ensureManualCollection* reuses an existing
     collection by title, so a resubmit lands in the same store. */
  step = stepStart(build, "collection", "Ensure the Shopify collection");
  const firstLogo = compositable[0];
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
  // A product created on a previous run whose image upload or collection-add
  // failed is NOT in the collection, but it exists in Shopify and is recorded
  // in the prior build. Seed from that record too, or every re-run after such
  // a failure would create a duplicate.
  const priorProducts = new Map();
  for (const prior of record.build?.products || []) {
    if (!prior?.title) continue;
    existingTitles.add(String(prior.title).toLowerCase());
    priorProducts.set(String(prior.title).toLowerCase(), prior);
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
      // Archive what the customer filled as a Google Doc next to the assets.
      // Additive like everything else: an existing copy (same name) is kept,
      // never replaced - the intake record itself is the source of truth.
      try {
        const docName = `Store Intake — ${departmentName} (${record.requestId.slice(0, 8).toUpperCase()})`;
        const existingDocs = await listFilesInFolder(folders.root.id, { mimeType: "application/vnd.google-apps.document" });
        if (!existingDocs.some((file) => file.name === docName)) {
          await uploadHtmlDocument(docName, intakeDocumentHtml(record), folders.root.id);
          log(build, `intake document archived to Drive as "${docName}"`);
        }
      } catch (error) {
        log(build, `intake document upload skipped: ${error.message}`);
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
      // Keep the product's admin link visible in the panel across re-runs -
      // a skip must not make an already-built product disappear from view.
      const prior = priorProducts.get(title.toLowerCase());
      if (prior) {
        built.push({ ...prior, skipped: true });
        build.products = built;
      }
      await saveBuild(intakeId, build).catch((error) => log(build, `progress flush failed (${error.message}); continuing`));
      continue;
    }

    try {
      /* Every decorated spot on this garment. Pre-decoration products carry a
         single flat placement; synthesize it so both shapes build identically.
         "Both sleeves" is one decoration that composites twice, mirrored. */
      const rawDecorations = product.decorations?.length
        ? product.decorations
        : [{
            placement: product.placement,
            tier: product.decorationSizeTier,
            feeSku: product.decorationFeeSku,
            logoSlugs: product.logoSlugs?.length ? product.logoSlugs : ["all"]
          }];
      const decorations = rawDecorations.map((decoration) => {
        const label = decoration.placement || resolvePlacement({ ...product, placement: "", productionNotes: "" }).replace(/-/g, " ");
        // "Both sleeves" resolves each side separately so garment-specific
        // sleeve coordinates (short-sleeve vs arms-down cuts) apply to both.
        const keys = /both\s+sleeves/i.test(label)
          ? [
              resolvePlacement({ ...product, placement: "Left sleeve", productionNotes: "" }),
              resolvePlacement({ ...product, placement: "Right sleeve", productionNotes: "" })
            ]
          : [resolvePlacement({ ...product, placement: label, productionNotes: "" })];
        return {
          ...decoration,
          label,
          keys,
          face: placementFace(label) === "back" ? "back" : "front"
        };
      });
      const frontDecos = decorations.filter((decoration) => decoration.face === "front");
      const backDecos = decorations.filter((decoration) => decoration.face === "back");

      // Belts, Class B pants, and anything the department marked "None" ship
      // undecorated - no logo resolution applies to them.
      const shipsBlank =
        String(product.decorationMethod || "").toLowerCase() === "none" ||
        ["belt", "class b uniform pants"].includes(product.productType);

      // Resolve every decoration's logo set BEFORE any paid search or
      // generation: an explicit assignment that matches nothing fails the
      // product here, for free, instead of after a generated base. It must
      // never silently become "all".
      if (!shipsBlank) {
        const missingAll = [];
        for (const decoration of decorations) {
          const { logos, missing } = resolveLogos({ logoSlugs: decoration.logoSlugs }, compositable);
          decoration.logos = logos;
          missingAll.push(...missing);
        }
        if (missingAll.length) {
          log(build, `${title}: assigned logo${missingAll.length === 1 ? "" : "s"} not usable: ${missingAll.join(", ")} (not uploaded, or a vector format that needs a PNG/JPG version)`);
        }
        const emptyDecoration = decorations.find((decoration) => !decoration.logos.length);
        if (emptyDecoration) {
          throw new Error(
            `None of the logos assigned to ${emptyDecoration.label} (${emptyDecoration.logoSlugs.join(", ")}) can be composited - upload a PNG/JPG version of the artwork (or clear the assignment) and re-run.`
          );
        }
      }

      // Vendor-first supplier lookup: the exact garment photo from the vendor
      // the customer named, verified by vision before it is trusted. The page
      // it came from also supplies the listing's fabric bullets + size chart.
      const supplier = await findSupplierBlank(product, {
        onLog: (message) => log(build, `${title}: ${message}`)
      });
      if (supplier.facts) {
        const bullets = [...(supplier.facts.fabric || [])];
        if (supplier.facts.fit) bullets.push(supplier.facts.fit);
        if (bullets.length && !product.fabricBullets?.length) product.fabricBullets = bullets.slice(0, 8);
        if (supplier.facts.sizeChart && !product.sizeChart) product.sizeChart = supplier.facts.sizeChart;
      }

      // The product photo of an undecorated garment is the blank itself, and
      // no logo option exists. Compositing a crest onto a leather belt is
      // exactly the kind of wrong the fixed-field form exists to prevent.
      const undecorated = shipsBlank;

      /* Base photos, one per decorated face. Supplier photos are FRONT views
         (the search scores flat-front shots highest), so the front face uses
         the supplier's own photo when there is one; the back face is always
         generated - a back graphic composited onto a front photo would print
         the department's full-back artwork across the chest. */
      const guidanceFor = (faceDecos) =>
        [product.imageGuidance, ...faceDecos.map((decoration) => placementGuidance(decoration.label, decoration.tier))]
          .filter(Boolean)
          .join(" ");
      const generateBase = (faceDecos, face) =>
        generateBlankGarment({
          productPrompt: product.productPrompt || `a ${product.productType || "garment"}`,
          garmentColor: product.garmentColor,
          brandStyle: [product.vendor, product.brandStyle].filter(Boolean).join(" "),
          spec: supplier.spec,
          imageGuidance: guidanceFor(faceDecos),
          face
        });

      let frontBase = supplier.imageBuffer || null;
      if (!frontBase && (undecorated || frontDecos.length || !backDecos.length)) {
        frontBase = await generateBase(frontDecos, "front");
      }
      // The back view is no longer text-generated up front: the decorated
      // renderer turns the front photo around itself, so front and back
      // mockups show the same product. A generated back-view blank is only
      // created lazily - when there is no front base at all, or when the
      // renderer fails and the composite fallback needs a surface.
      let backBlank = null;
      const ensureBackBlank = async () => {
        if (!backBlank) {
          log(build, `${title}: generating a back-view blank for ${backDecos.map((decoration) => decoration.label).join(", ")}`);
          backBlank = await generateBase(backDecos, "back");
        }
        return backBlank;
      };

      const logoVariants = [];
      let logoOptionName = "Front Logo";
      if (undecorated) {
        let driveFile = null;
        if (folders) {
          try {
            driveFile = await uploadGeneratedImage(`${slug(title)}--blank.png`, frontBase, folders.productImages.id);
          } catch (error) {
            log(build, `drive upload skipped for ${title}: ${error.message}`);
          }
        }
        logoVariants.push({ logo: null, images: [{ face: "front", buffer: frontBase, driveFile }] });
      } else {
        // ONE decoration can offer a logo CHOICE (it becomes the product's
        // logo option in Shopify); every other spot is fixed to its first
        // logo, so two open-ended spots never explode combinatorially.
        const choiceIndex = decorations.findIndex((decoration) => decoration.logos.length > 1);
        decorations.forEach((decoration, index) => {
          if (index !== choiceIndex && decoration.logos.length > 1) {
            log(build, `${title}: ${decoration.label} lists ${decoration.logos.length} logos but ${decorations[choiceIndex].label} already carries the logo choice; using ${decoration.logos[0].filenameBase}`);
          }
        });
        if (choiceIndex >= 0 && decorations[choiceIndex].face === "back") logoOptionName = "Back Logo";
        const choiceLogos = choiceIndex >= 0 ? decorations[choiceIndex].logos : [null];
        for (const choice of choiceLogos) {
          const logoFor = (decoration) =>
            decorations.indexOf(decoration) === choiceIndex && choice ? choice : decoration.logos[0];
          const faceDecorations = (faceDecos) =>
            faceDecos.map((decoration) => ({
              logo: logoFor(decoration),
              label: decoration.label,
              tier: decoration.tier
            }));
          const renderLog = (message) => log(build, `${title}: ${message}`);

          /* Decorated views come from the shared producer (productImages.js):
             one model call per face, given the blank photo, the artwork files
             and where each mark goes. */
          const images = [];
          if (frontDecos.length && frontBase) {
            const produced = await renderFaceImage({
              baseBuffer: frontBase,
              sourceFace: "front",
              face: "front",
              decorations: faceDecorations(frontDecos),
              method: product.decorationMethod,
              productType: product.productType || "garment",
              onLog: renderLog
            });
            images.push({ face: "front", buffer: produced.buffer });
          }
          if (backDecos.length) {
            const produced = await renderFaceImage({
              baseBuffer: frontBase || (await ensureBackBlank()),
              sourceFace: frontBase ? "front" : "back",
              face: "back",
              decorations: faceDecorations(backDecos),
              method: product.decorationMethod,
              productType: product.productType || "garment",
              getBackBlank: ensureBackBlank,
              onLog: renderLog
            });
            images.push({ face: "back", buffer: produced.buffer });
          }
          // Back-only products with a supplier photo keep the blank front as
          // a free, real secondary view.
          if (!frontDecos.length && frontBase) {
            images.push({ face: "front", buffer: frontBase });
          }

          const named = choice || logoFor(decorations[0]);
          for (const image of images) {
            if (!folders) continue;
            try {
              image.driveFile = await uploadGeneratedImage(
                `${slug(title)}--${named.slug}--${image.face}.png`,
                image.buffer,
                folders.productImages.id
              );
            } catch (error) {
              log(build, `drive upload skipped for ${title}/${named.filenameBase} (${image.face}): ${error.message}`);
            }
          }
          logoVariants.push({ logo: choiceIndex >= 0 ? choice : named, images });
        }
      }

      const placementSummary = undecorated ? "" : decorations.map((decoration) => decoration.label).filter(Boolean).join(" + ");
      const descriptionHtml = await generateProductDescription(departmentName, product).catch((error) => {
        log(build, `${title}: description generation failed (${error.message}); using fallback copy`);
        return `<p>${title} for ${departmentName}. Decoration: ${product.decorationMethod || "as specified"}, ${placementSummary || "as specified"}.</p>`;
      });

      const sizes = product.sizes?.length ? product.sizes : DEFAULT_SIZES;
      const plans =
        logoVariants.length > 1 && logoVariants.length * sizes.length <= MAX_VARIANTS
          ? [{ title, logoVariants }]
          : logoVariants.map((lv) => ({
              title: logoVariants.length > 1 ? `${title} - ${lv.logo?.filenameBase}` : title,
              logoVariants: [lv]
            }));

      const hasBackView = !undecorated && backDecos.length > 0;
      const blankSource = supplier.imageBuffer
        ? hasBackView
          ? "supplier + rendered back"
          : "supplier"
        : "generated";

      for (const plan of plans) {
        if (existingTitles.has(plan.title.toLowerCase())) {
          log(build, `skip existing split product: ${plan.title}`);
          // Same carry-forward as the whole-product skip: a split product
          // built on a previous run must stay visible in the panel.
          const prior = priorProducts.get(plan.title.toLowerCase());
          if (prior) {
            built.push({ ...prior, skipped: true });
            build.products = built;
          }
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
            ...decorations.map((decoration) => decoration.feeSku || ""),
            ...decorations.map((decoration) => (decoration.tier ? `decoration-${decoration.tier}` : ""))
          ].filter((tag, index, list) => tag && list.indexOf(tag) === index),
          logoValues: plan.logoVariants.filter((lv) => lv.logo).map((lv) => lv.logo.filenameBase),
          sizes,
          status: "DRAFT",
          logoOptionName
        });

        // The product EXISTS in Shopify from this moment. Record it before the
        // image upload and collection-add so a failure in either cannot orphan
        // it: a re-run would otherwise not see it in the collection and create
        // a duplicate.
        existingTitles.add(plan.title.toLowerCase());
        const builtEntry = {
          title: created.title,
          productId: created.productId,
          url: adminProductUrl(created.productId),
          status: "DRAFT",
          variantCount: created.variantCount,
          logoCount: plan.logoVariants.filter((lv) => lv.logo).length,
          placements: placementSummary,
          blankSource,
          blankSourceUrl: supplier.sourceUrl || null,
          vendor: product.vendor || "",
          driveImageUrl: plan.logoVariants[0]?.images?.[0]?.driveFile?.webViewLink || null
        };
        built.push(builtEntry);
        build.products = built;
        await saveBuild(intakeId, build).catch((error) => log(build, `progress flush failed (${error.message}); continuing`));

        // Collection membership BEFORE images: a failed image upload then
        // leaves a visible product missing pictures (obvious, fixable in
        // admin) instead of a complete-looking product orphaned outside the
        // store's collection.
        await addProductToCollection(created.productId, collection.id);
        const idsByLogo = variantIdsByLogo(created.variants, created.useLogoOption, created.logoOptionName);
        await uploadProductImages(
          created.productGid,
          plan.logoVariants.flatMap((lv) =>
            lv.images.map((image) => ({
              filename: `${slug(plan.title)}-${lv.logo ? lv.logo.slug : "blank"}-${image.face}${lv.logo ? "-mockup" : ""}.png`,
              buffer: image.buffer,
              alt: lv.logo ? `${plan.title} — ${lv.logo.filenameBase} (${image.face} view)` : plan.title,
              variantIds: idsByLogo.get(created.useLogoOption && lv.logo ? lv.logo.filenameBase : "__all__") || []
            }))
          )
        );
      }

      const logoCount = logoVariants.filter((lv) => lv.logo).length;
      stepDone(
        step,
        `${blankSource === "generated" ? "generated base" : "supplier photo"}${hasBackView && frontDecos.length ? " · front + back views" : hasBackView ? " · back view" : ""} · ${
          undecorated ? "undecorated" : `${placementSummary || "default placement"} · ${logoCount} logo${logoCount === 1 ? "" : "s"}`
        } · DRAFT`
      );
    } catch (error) {
      // One garment failing must not sink the other eleven. The step records
      // the failure; the summary marks the build partial.
      stepFail(step, error);
      failures.push(`${title}: ${error.message}`);
      log(build, `FAILED ${title}: ${error.message}`);
    }

    build.products = built;
    // A transient Drive hiccup on a progress flush must not sink the remaining
    // products - the in-memory build object stays authoritative and the next
    // successful flush carries everything.
    await saveBuild(intakeId, build).catch((error) => log(build, `progress flush failed (${error.message}); continuing`));
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
  // Reserve the slot BEFORE any await: two concurrent starts (double submit,
  // operator click racing the auto-build) must not both pass the check.
  if (activeBuilds.has(intakeId)) {
    return { started: false, reason: "A build for this store request is already running." };
  }
  const placeholder = { state: "starting" };
  activeBuilds.set(intakeId, placeholder);

  let record;
  try {
    record = await getCustomerIntake(intakeId);
    if (record.build?.state === "running") {
      // A record can claim "running" after a server restart killed the build
      // mid-flight. Stale when nothing has been written for 15+ minutes -
      // judged by the freshest step timestamp, not the build's start time, so
      // a long legitimate build is not mistaken for a dead one.
      const timestamps = [record.build.startedAt, ...(record.build.steps || []).flatMap((step) => [step.startedAt, step.finishedAt])]
        .map((value) => Date.parse(value || ""))
        .filter(Number.isFinite);
      const lastActivity = timestamps.length ? Math.max(...timestamps) : 0;
      const fresh = Date.now() - lastActivity < 15 * 60 * 1000;
      if (fresh && !options.force) {
        activeBuilds.delete(intakeId);
        return { started: false, reason: "This store request is already building." };
      }
    }
  } catch (error) {
    activeBuilds.delete(intakeId);
    throw error;
  }
  if (activeBuilds.get(intakeId) !== placeholder) {
    return { started: false, reason: "A build for this store request is already running." };
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

/** Whether a build for this intake is running in THIS process right now. */
function isBuildActive(intakeId) {
  return activeBuilds.has(intakeId);
}

module.exports = { isBuildActive, startIntakeBuild };

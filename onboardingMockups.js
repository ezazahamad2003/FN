/*
 * Department Onboarding Agent — product mockups (Build Spec §5) and the
 * collection banner (§6.3).
 *
 *   §5  2000 × 2000, a FRONT and a BACK image for every product, every colour
 *       and every Style; front decoration on the left chest, back decoration
 *       on the back; print artwork from the Omni Printer copies, embroidery
 *       artwork from the Printed Image proof; pants ship a stock image with
 *       no decoration; file names like VAC_NL3600_NVY_Style1_FRONT.png.
 *   §6.3 banner 3584 × 2048 with the chosen logo (rules.chooseBannerLogo).
 *
 * Where the model is and is not used:
 *   • the decorated render is ONE model call per face (productImages.js);
 *   • an optional vision check reads the render back against the artwork;
 *   • everything else — base normalisation, sizing, file names, placement
 *     labels, the banner — is deterministic sharp work and rules.
 *
 * Every model call goes through `renderers`, which tests replace with fakes
 * (setRenderers). Nothing here throws on a missing integration: a face that
 * cannot be rendered ships the blank with a `path` and a warning, so one bad
 * image never sinks a product build.
 */

const sharp = require("sharp");
const rules = require("./onboardingRules");

const MOCKUP_SIZE = Number(process.env.ONBOARDING_MOCKUP_SIZE) || rules.MOCKUP_SIZE;
const BANNER = { width: rules.BANNER_WIDTH, height: rules.BANNER_HEIGHT };

// The renderer's placement wording and artwork preparation were tuned with
// 1024 px bases (blanks.CANVAS, ai.renderGarment), so the model always sees
// the garment at that scale; only the OUTPUT is asked for at MOCKUP_SIZE.
const MODEL_INPUT_SIZE = 1024;

// Vector inputs (SVG, PDF) are rasterised at this density so a small logo
// still has enough pixels to be resized down cleanly.
const VECTOR_DENSITY = 300;

// Banner layout: Dan's live banners are one logo centred on a plain ground.
// The logo fills at most this much of the canvas so it never touches an edge.
const BANNER_LOGO_MAX_HEIGHT = 0.62;
const BANNER_LOGO_MAX_WIDTH = 0.45;

const CLASS_B_WARNING = "Class B mockup must be checked against the policy (button swaps, patch shoulders)";
const UPSCALED_WARNING = "rendered at 1024 and upscaled";

/* ---------------------------------------------------------------------------
   Injectable model calls
   ------------------------------------------------------------------------- */

// Required lazily so loading this module never touches the OpenAI, Azure or
// blob clients — tests and the rules-only paths must run with no keys set.
function defaultRenderers() {
  return {
    renderFaceImage: (...args) => require("./productImages").renderFaceImage(...args),
    generateBlankGarment: (...args) => require("./ai").generateBlankGarment(...args),
    findSupplierBlank: (...args) => require("./blanks").findSupplierBlank(...args),
    reason: (...args) => require("./azureOpenai").reason(...args)
  };
}

let renderers = null;

/** Replace any of the model calls (tests). Missing keys keep the real module. */
function setRenderers(overrides) {
  renderers = { ...defaultRenderers(), ...(overrides || {}) };
  return renderers;
}

function getRenderers() {
  if (!renderers) renderers = defaultRenderers();
  return renderers;
}

/* ---------------------------------------------------------------------------
   Image plumbing
   ------------------------------------------------------------------------- */

function startsWithAscii(buffer, text, offset = 0) {
  return buffer.length >= offset + text.length && buffer.toString("ascii", offset, offset + text.length) === text;
}

// ISO base media brands that mean HEIC/HEIF (HEVC-coded). sharp's prebuilt
// libheif only decodes AVIF, so these have to be refused with a message Dan
// can act on rather than "unsupported image format".
const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"];

function sniffFormat(buffer, mimetype = "") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return "empty";
  if (startsWithAscii(buffer, "%PDF")) return "pdf";
  if (startsWithAscii(buffer, "ftyp", 4)) {
    const brand = buffer.toString("ascii", 8, 12).toLowerCase();
    if (HEIC_BRANDS.includes(brand)) return "heic";
  }
  const head = buffer.toString("utf8", 0, Math.min(buffer.length, 512)).trimStart();
  if (/^(<\?xml|<svg|<!doctype svg)/i.test(head) || /svg/i.test(mimetype)) return "svg";
  if (/heic|heif/i.test(mimetype)) return "heic";
  return "raster";
}

function describeUnsupported(kind) {
  if (kind === "heic") return "HEIC/HEIF photos are not supported — export the photo as JPEG or PNG and upload that.";
  if (kind === "empty") return "The image file is empty.";
  return "";
}

/*
 * Open any accepted input as a sharp pipeline. PDF goes through sharp's
 * density option (first page); when this sharp build has no PDF decoder the
 * error names the fix instead of "unsupported image format".
 */
function openImage(buffer, { mimetype = "" } = {}) {
  const kind = sniffFormat(buffer, mimetype);
  const unsupported = describeUnsupported(kind);
  if (unsupported) throw new Error(unsupported);
  const options = kind === "svg" || kind === "pdf" ? { density: VECTOR_DENSITY, pages: 1 } : {};
  return { kind, pipeline: sharp(buffer, options) };
}

function rethrowUnreadable(error, kind) {
  if (kind === "pdf") {
    throw new Error(`The PDF could not be rasterised (${error.message}). Export the first page as PNG or SVG and upload that.`);
  }
  throw new Error(`The image could not be read (${error.message}). Upload a JPEG, PNG, WEBP or SVG.`);
}

/**
 * A blank garment photo on a size × size white canvas: EXIF-rotated, resized
 * to fit, alpha flattened onto white, letterboxed with white. Same treatment
 * as blanks.normalizeBase but parametric, because the model input is 1024
 * while stock faces ship at MOCKUP_SIZE straight from the photo.
 */
async function normalizeBlank(buffer, { size = MODEL_INPUT_SIZE, mimetype = "" } = {}) {
  const { kind, pipeline } = openImage(buffer, { mimetype });
  let fitted;
  try {
    fitted = await pipeline
      .rotate()
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: false })
      .flatten({ background: "#ffffff" })
      .png()
      .toBuffer();
  } catch (error) {
    rethrowUnreadable(error, kind);
  }
  return toSquare(fitted, size);
}

/** Final output sizing: contain on a white size × size canvas, PNG. */
async function toSquare(buffer, size) {
  return sharp(buffer)
    .resize({ width: size, height: size, fit: "contain", background: "#ffffff", kernel: "lanczos3" })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}

/* ---------------------------------------------------------------------------
   Decoration plan — pure
   ------------------------------------------------------------------------- */

// Labels are the placement vocabulary productImages.js already speaks
// (placements.js labels, lowercased into the prompt); tiers are the size
// tiers of the decoration reference table.
const TIER_SMALL = "Small";
const TIER_STANDARD = "Standard";
const TIER_LARGE = "Large / Full Back";

function isHeadwear(product) {
  const text = `${product.type || ""} ${product.title || ""}`;
  return /\b(hat|cap|caps|beanie|beanies|visor|headwear|trucker|snapback)\b/i.test(text);
}

/*
 * Spec §5 lists "Class B" as a product type of its own, next to "pants", so a
 * row typed exactly "Class B" is the shirt; "Class B uniform pants" is not.
 */
function isClassBShirt(product) {
  if (!product || !product.classB) return false;
  const type = String(product.type || "").trim();
  return /shirt/i.test(type) || /^class\s*b$/i.test(type);
}

/*
 * Where one decoration code sits and how big it is.
 *
 *   F##  front print          → front left chest, chest-crest size (§5)
 *   B##  back print           → centre back, full back
 *   RS## / LS##  sleeve print → that sleeve, small
 *   E##  embroidery           → hats: front panel, cap scale
 *                               Class B shirts: E01 left sleeve, E02 right
 *                               sleeve (shoulder patches — an assumption the
 *                               policy review must confirm)
 *                               everything else: front left chest
 */
function placeDecoration(parsed, product) {
  const { code, prefix, number } = parsed;
  if (prefix === "F") return { code, label: "Front left chest", tier: TIER_SMALL, face: "front" };
  if (prefix === "B") return { code, label: "Center back", tier: TIER_LARGE, face: "back" };
  if (prefix === "RS") return { code, label: "Right sleeve", tier: TIER_SMALL, face: "front" };
  if (prefix === "LS") return { code, label: "Left sleeve", tier: TIER_SMALL, face: "front" };
  // E##
  if (isHeadwear(product)) return { code, label: "Front center", tier: TIER_STANDARD, face: "front" };
  if (isClassBShirt(product)) {
    if (number === 1) return { code, label: "Left sleeve", tier: TIER_SMALL, face: "front" };
    if (number === 2) return { code, label: "Right sleeve", tier: TIER_SMALL, face: "front" };
  }
  return { code, label: "Front left chest", tier: TIER_SMALL, face: "front" };
}

function planCodes(codes, product) {
  const front = [];
  const back = [];
  for (const raw of codes || []) {
    const parsed = rules.parseDecorationCode(raw);
    if (parsed.error) continue;
    const placed = placeDecoration(parsed, product);
    const bucket = placed.face === "back" ? back : front;
    if (bucket.some((d) => d.code === placed.code)) continue;
    bucket.push({ code: placed.code, label: placed.label, tier: placed.tier });
  }
  return { front, back };
}

/*
 * The product's Styles as the rules see them: expandProduct output
 * ({ name, decorationCodes: [] }) or a raw row ({ decorationCodes: "F01/B01" }).
 * A single set-up has style null (no Style option, no Style in the file name).
 */
function normalizedStyles(product) {
  const list = Array.isArray(product.styles) && product.styles.length
    ? product.styles
    : [{ decorationCodes: product.decorationCodes }];
  return list.map((style, index) => {
    const codes = rules.normalizeDecorations(style.decorationCodes).codes;
    const name = style.name || (list.length > 1 ? rules.styleName(index + 1) : null);
    return { style: name, codes };
  });
}

/** Per-Style plan: [{ style, codes, front: [...], back: [...] }]. */
function stylePlans(product) {
  return normalizedStyles(product).map(({ style, codes }) => ({ style, codes, ...planCodes(codes, product) }));
}

/**
 * The union of every decoration on the product, by face. Pass `codes` to
 * plan an arbitrary list against the product's type instead.
 */
function decorationPlan(product, codes = null) {
  if (Array.isArray(codes)) return planCodes(codes, product);
  const all = [];
  for (const { codes: styleCodes } of normalizedStyles(product)) {
    for (const code of styleCodes) if (!all.includes(code)) all.push(code);
  }
  return planCodes(all, product);
}

/* ---------------------------------------------------------------------------
   Product mockups
   ------------------------------------------------------------------------- */

function colorEntries(product) {
  return (product.colors || [])
    .map((c) => (typeof c === "string" ? { name: c } : c || {}))
    .filter((c) => c.name)
    .map((c) => {
      const resolved = c.code ? { code: String(c.code).toUpperCase() } : rules.resolveColorCode(c.name);
      return { name: String(c.name), code: resolved.code || null };
    });
}

// Blank photos are keyed by the colour name Dan typed; match the way the
// colour list does so "Midnight navy" still finds "Midnight Navy".
function photosFor(blankPhotos, colorName) {
  if (!blankPhotos) return {};
  if (blankPhotos[colorName]) return blankPhotos[colorName];
  const want = rules.normalizeColorName(colorName);
  for (const [key, value] of Object.entries(blankPhotos)) {
    if (rules.normalizeColorName(key) === want) return value || {};
  }
  return {};
}

function artworkFor(artwork, code) {
  if (!artwork) return null;
  if (artwork[code]) return artwork[code];
  const want = String(code).toUpperCase();
  for (const [key, value] of Object.entries(artwork)) {
    if (String(key).toUpperCase() === want) return value;
  }
  return null;
}

function defaultGenerateBlank(product) {
  return ({ face, color }) =>
    getRenderers().generateBlankGarment({
      productPrompt: `a ${product.type || "garment"}`,
      garmentColor: color,
      brandStyle: [product.brand, product.styleNumber].filter(Boolean).join(" "),
      spec: "",
      imageGuidance: "",
      face
    });
}

function defaultSupplierLookup(product, onLog) {
  return async (color) => {
    const found = await getRenderers().findSupplierBlank(
      {
        vendor: product.brand || "",
        brandStyle: product.styleNumber || "",
        garmentColor: color,
        productType: product.type || "",
        productLabel: product.title || ""
      },
      { onLog }
    );
    return (found && found.imageBuffer) || null;
  };
}

/*
 * The two bases for one colour, as raw uploads plus their normalised forms.
 * `model` is what the renderer sees (1024); `stock(size)` is the photo itself
 * at output size, so a stock face from a 12 MP photo is not a 1024 upscale.
 */
async function resolveBases({ product, color, photos, supplierLookup, generateBlank, needBack, log }) {
  const base = { front: null, back: null, frontSource: null, backSource: null, warnings: [] };

  const take = async (face, source, getter) => {
    let raw;
    try {
      raw = await getter();
    } catch (error) {
      base.warnings.push(`${face} blank from ${source} failed for ${color}: ${error.message}`);
      return false;
    }
    if (!raw) return false;
    try {
      base[face] = { raw, model: await normalizeBlank(raw, { size: MODEL_INPUT_SIZE, mimetype: raw.mimetype || "" }), stockCache: new Map() };
    } catch (error) {
      base.warnings.push(`${face} blank (${source}) for ${color} could not be read: ${error.message}`);
      return false;
    }
    base[`${face}Source`] = source;
    log(`${color}: ${face} blank from ${source}`);
    return true;
  };

  const asBuffer = (value) => (Buffer.isBuffer(value) ? value : value && Buffer.isBuffer(value.buffer) ? value.buffer : null);

  (await take("front", "photo", async () => asBuffer(photos.front))) ||
    (supplierLookup && (await take("front", "supplier", async () => asBuffer(await supplierLookup(color))))) ||
    (generateBlank && (await take("front", "generated", async () => asBuffer(await generateBlank({ face: "front", color, product })))));

  if (needBack) {
    (await take("back", "photo", async () => asBuffer(photos.back))) ||
      (generateBlank && (await take("back", "generated", async () => asBuffer(await generateBlank({ face: "back", color, product })))));
  } else if (photos.back) {
    // Undecorated items only get a back image when Dan supplied one.
    await take("back", "photo", async () => asBuffer(photos.back));
  }
  return base;
}

async function stockImage(faceBase, size) {
  if (!faceBase.stockCache.has(size)) {
    faceBase.stockCache.set(size, await normalizeBlank(faceBase.raw, { size, mimetype: faceBase.raw.mimetype || "" }));
  }
  return faceBase.stockCache.get(size);
}

/**
 * Render every mockup for one product: colours × Styles × {front, back}.
 *
 * Each result: { color, colorCode, style, face, buffer, fileName, path, base,
 * warnings, verified }.
 *   path      "render" | "render-failed" | "stock" | "missing-artwork"
 *   base      "photo" | "supplier" | "generated" | null (no base at all)
 *   buffer    a size × size PNG; null ONLY when a decorated face has no base
 *             at all (no photo, no supplier hit, generation failed) — the
 *             warning says why, and the caller must not upload it.
 *
 * A face with nothing on it ships the blank as "stock" (open item #3: hats
 * and left-chest-only items still get a back image of the blank). Missing
 * artwork for a code ships the blank as "missing-artwork" naming the code.
 * Products with no decoration at all (pants) ship the front stock photo, and
 * a back only when a back photo was supplied.
 */
async function renderProductMockups({
  product,
  departmentCode,
  artwork = {},
  blankPhotos = {},
  supplierLookup,
  generateBlank,
  onLog,
  verify = process.env.ONBOARDING_MOCKUP_VERIFY !== "off",
  size = MOCKUP_SIZE
} = {}) {
  const log = (message) => {
    if (onLog) onLog(message);
  };
  const results = [];
  if (!product) return results;

  const plans = stylePlans(product);
  const hasDecoration = plans.some((plan) => plan.codes.length > 0);
  const classBShirt = isClassBShirt(product);
  const method = classBShirt || product.decorationMethod === rules.DECORATION_EMBROIDERY ? "embroidery" : "print";
  const productType = product.type || "garment";
  const styleNumber = product.styleNumber || "";
  const lookup = supplierLookup === undefined ? defaultSupplierLookup(product, log) : supplierLookup;
  const generate = generateBlank === undefined ? defaultGenerateBlank(product) : generateBlank;

  for (const color of colorEntries(product)) {
    const colorCode = color.code || String(color.name).toUpperCase().replace(/[^A-Z0-9]+/g, "");
    const colorWarnings = [];
    if (!color.code) colorWarnings.push(`Color "${color.name}" has no approved color code; the file name uses "${colorCode}" until one is approved.`);
    const photos = photosFor(blankPhotos, color.name);
    // Every decorated product ships a back image (stock when nothing is on
    // the back), so a back base is needed whenever the product is decorated.
    const bases = await resolveBases({
      product,
      color: color.name,
      photos,
      supplierLookup: lookup,
      generateBlank: generate,
      needBack: hasDecoration,
      log
    });
    colorWarnings.push(...bases.warnings);

    for (const plan of plans) {
      const fileNameFor = (face) => rules.mockupFileName({ departmentCode, styleNumber, colorCode, style: plan.style, face });
      const tag = `${styleNumber} ${color.name}${plan.style ? ` ${plan.style}` : ""}`;

      for (const face of ["front", "back"]) {
        const decorations = plan[face];
        const faceBase = bases[face];
        const entry = {
          color: color.name,
          colorCode: color.code,
          style: plan.style,
          face,
          buffer: null,
          fileName: fileNameFor(face),
          path: "stock",
          base: bases[`${face}Source`],
          warnings: [...colorWarnings],
          verified: null
        };
        if (classBShirt) entry.warnings.push(CLASS_B_WARNING);

        if (!decorations.length) {
          // Nothing on this face: the blank itself is the image. A back face
          // with no base (undecorated item, no back photo) is simply absent.
          if (!faceBase) {
            if (face === "front") {
              entry.path = "render-failed";
              entry.warnings.push(`No front blank for ${color.name}: upload a front photo of the blank.`);
              results.push(entry);
            } else {
              log(`${tag}: no back photo supplied; back image skipped`);
            }
            continue;
          }
          entry.buffer = await stockImage(faceBase, size);
          results.push(entry);
          continue;
        }

        if (!faceBase) {
          entry.path = "render-failed";
          entry.warnings.push(`No ${face} blank for ${color.name}: the ${face} decoration (${decorations.map((d) => d.code).join(", ")}) could not be rendered.`);
          results.push(entry);
          continue;
        }

        const missing = decorations.filter((d) => !artworkFor(artwork, d.code)).map((d) => d.code);
        if (missing.length) {
          entry.path = "missing-artwork";
          entry.buffer = await stockImage(faceBase, size);
          entry.warnings.push(
            `No artwork for ${missing.map((c) => `${c} (${rules.decorationFileStem(departmentCode, c)})`).join(", ")}; the ${face} image is the blank.`
          );
          log(`${tag} ${face}: missing artwork for ${missing.join(", ")}`);
          results.push(entry);
          continue;
        }

        const rendered = await renderFace({
          bases,
          face,
          decorations: decorations.map((d) => {
            const art = artworkFor(artwork, d.code);
            return {
              logo: { buffer: art.buffer, mimetype: art.mimetype || "image/png", originalName: art.name || `${rules.decorationFileStem(departmentCode, d.code)}.png` },
              label: d.label,
              tier: d.tier
            };
          }),
          method,
          productType,
          size,
          log: (message) => log(`${tag} ${face}: ${message}`)
        });
        entry.path = rendered.path;
        entry.warnings.push(...rendered.warnings);
        entry.buffer = rendered.path === "render" ? await toSquare(rendered.buffer, size) : await stockImage(faceBase, size);

        if (verify && entry.path === "render") {
          entry.verified = await verifyMockup({
            buffer: entry.buffer,
            artwork: decorations.map((d) => {
              const art = artworkFor(artwork, d.code);
              return { buffer: art.buffer, name: art.name || d.code, mimetype: art.mimetype };
            }),
            expectation: { face, labels: decorations.map((d) => d.label), productType }
          });
          if (entry.verified.ok === false) entry.warnings.push(`Vision check flagged the ${face} image: ${entry.verified.notes}`);
        }
        results.push(entry);
      }
    }
  }
  return results;
}

/*
 * One face through the renderer: first at the requested output size, then —
 * on ANY failure — once more at the model's default so a model that rejects
 * the custom size still produces a decorated image (upscaled afterwards).
 */
async function renderFace({ bases, face, decorations, method, productType, size, log }) {
  const warnings = [];
  const call = (withSize) =>
    getRenderers().renderFaceImage({
      baseBuffer: bases.front ? bases.front.model : bases.back.model,
      sourceFace: bases.front ? "front" : "back",
      face,
      decorations,
      method,
      productType,
      getBackBlank: async () => (bases.back ? bases.back.model : null),
      onLog: log,
      ...(withSize ? { size: `${size}x${size}` } : {}),
      quality: "high",
      throwOnFailure: true
    });
  try {
    const first = await call(true);
    return { buffer: first.buffer, path: "render", warnings };
  } catch (error) {
    log(`render at ${size}x${size} failed (${error.message}); retrying at the model default`);
  }
  try {
    const second = await call(false);
    warnings.push(UPSCALED_WARNING);
    return { buffer: second.buffer, path: "render", warnings };
  } catch (error) {
    warnings.push(`Render failed twice (${error.message}); the ${face} image is the blank.`);
    log(`render failed again (${error.message}); shipping the blank`);
    return { buffer: null, path: "render-failed", warnings };
  }
}

/* ---------------------------------------------------------------------------
   Vision check
   ------------------------------------------------------------------------- */

function dataUrl(buffer, mimetype = "image/png") {
  return `data:${mimetype};base64,${buffer.toString("base64")}`;
}

/**
 * Read the render back: is the artwork there, where it was asked for, and
 * did the model invent any text? Never throws — an unavailable model is
 * { ok: null } so the build carries on and the report says it was not checked.
 */
async function verifyMockup({ buffer, artwork = [], expectation = {} } = {}) {
  try {
    if (!Buffer.isBuffer(buffer)) throw new Error("no image to check");
    // The check does not need 2000 px; a smaller copy keeps the call cheap.
    const preview = await sharp(buffer).resize({ width: 1024, height: 1024, fit: "inside" }).png().toBuffer();
    const content = [
      {
        type: "text",
        text:
          `Image 1 is a product mockup of a ${expectation.productType || "garment"} shown from the ${expectation.face || "front"}. ` +
          `The remaining ${artwork.length} image(s) are the artwork files that should appear on it, placed at: ${(expectation.labels || []).join(", ") || "as decorated"}. ` +
          "Check the mockup against the artwork and answer with a JSON object only: " +
          '{"artworkVisible": true|false, "placementMatches": true|false, "inventedText": true|false, "notes": "one or two short sentences"}. ' +
          "artworkVisible is true when the artwork is reproduced with the same text, colours and shapes as its file. " +
          "placementMatches is true when each mark sits on the named location. " +
          "inventedText is true when the garment carries any lettering, logo or graphic that is not in the artwork files."
      },
      { type: "image_url", image_url: { url: dataUrl(preview) } }
    ];
    for (const art of artwork) {
      if (Buffer.isBuffer(art && art.buffer)) content.push({ type: "image_url", image_url: { url: dataUrl(art.buffer, art.mimetype || "image/png") } });
    }
    const answer = await getRenderers().reason({ messages: [{ role: "user", content }], jsonObject: true, maxTokens: 300, temperature: 0 });
    const parsed = parseJsonObject(answer);
    const ok = parsed.artworkVisible === true && parsed.placementMatches === true && parsed.inventedText !== true;
    const notes = String(parsed.notes || "").trim() || (ok ? "artwork visible in the expected place" : "the check did not confirm the artwork");
    return { ok, notes, artworkVisible: parsed.artworkVisible === true, placementMatches: parsed.placementMatches === true, inventedText: parsed.inventedText === true };
  } catch (error) {
    return { ok: null, notes: `verification unavailable: ${error.message}` };
  }
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("the model did not answer with JSON");
    return JSON.parse(match[0]);
  }
}

/* ---------------------------------------------------------------------------
   Banner (§6.3)
   ------------------------------------------------------------------------- */

/*
 * Which ground the logo goes on. A logo delivered as a JPEG on white has an
 * opaque white margin baked in, so only a white banner hides it; anything
 * with transparency (or a non-white margin) goes on black, which is how Dan's
 * live banners look.
 */
async function pickBannerBackground(rasterPng) {
  const { data, info } = await sharp(rasterPng)
    .resize({ width: 64, height: 64, fit: "fill", kernel: "nearest" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
  };
  const corners = [px(0, 0), px(info.width - 1, 0), px(0, info.height - 1), px(info.width - 1, info.height - 1)];
  const opaqueWhite = corners.every((c) => c.a >= 250 && c.r >= 235 && c.g >= 235 && c.b >= 235);
  return opaqueWhite ? "#ffffff" : "#000000";
}

/**
 * The collection banner: the logo centred on a plain ground at 3584 × 2048.
 * Deterministic — no model call — so every re-run yields the same banner.
 */
async function renderBanner({ logoBuffer, logoMimetype = "" } = {}) {
  const { kind, pipeline } = openImage(logoBuffer, { mimetype: logoMimetype });
  let raster;
  try {
    raster = await pipeline.rotate().ensureAlpha().png().toBuffer();
  } catch (error) {
    rethrowUnreadable(error, kind);
  }
  const background = await pickBannerBackground(raster);

  // Trim the margin (transparent, or the uniform colour at the top-left) so
  // the logo, not its file's padding, is what gets centred. A logo that is
  // one flat colour trims to nothing; it is used as-is.
  let trimmed = raster;
  try {
    const result = await sharp(raster).trim({ threshold: 12 }).png().toBuffer({ resolveWithObject: true });
    if (result.info.width > 0 && result.info.height > 0) trimmed = result.data;
  } catch {
    trimmed = raster;
  }

  const maxWidth = Math.round(BANNER.width * BANNER_LOGO_MAX_WIDTH);
  const maxHeight = Math.round(BANNER.height * BANNER_LOGO_MAX_HEIGHT);
  const logo = await sharp(trimmed)
    .resize({ width: maxWidth, height: maxHeight, fit: "inside", withoutEnlargement: false, kernel: "lanczos3" })
    .png()
    .toBuffer({ resolveWithObject: true });

  const buffer = await sharp({
    create: { width: BANNER.width, height: BANNER.height, channels: 3, background }
  })
    .composite([
      {
        input: logo.data,
        left: Math.round((BANNER.width - logo.info.width) / 2),
        top: Math.round((BANNER.height - logo.info.height) / 2)
      }
    ])
    .png()
    .toBuffer();

  return { buffer, background, logo: { width: logo.info.width, height: logo.info.height } };
}

/**
 * Which packet file becomes the banner logo (§6.3 order: the department's
 * pick → scramble → chest → back). Files carry { assetId|id, name, kind,
 * role }; returns { id, assetId, name, role, reason } or null when no artwork
 * file has one of those roles.
 */
async function bannerLogoChoice(packetFiles = []) {
  const candidates = (packetFiles || [])
    .filter((f) => f && (f.kind === "artwork" || f.role))
    .map((f) => ({ id: f.assetId || f.id || "", assetId: f.assetId || f.id || "", name: f.name || "", role: f.role || "", kind: f.kind || "" }));
  const chosen = rules.chooseBannerLogo(candidates);
  if (!chosen) return null;
  return { id: chosen.id, assetId: chosen.assetId, name: chosen.name, role: chosen.role, reason: chosen.reason };
}

module.exports = {
  MOCKUP_SIZE,
  BANNER,
  MODEL_INPUT_SIZE,
  CLASS_B_WARNING,
  UPSCALED_WARNING,
  setRenderers,
  normalizeBlank,
  toSquare,
  decorationPlan,
  stylePlans,
  isClassBShirt,
  renderProductMockups,
  verifyMockup,
  renderBanner,
  bannerLogoChoice
};

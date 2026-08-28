/* -----------------------------------------------------------------------------
   Product image production — the ONE place a decorated garment photo is made.

   Used by the store builder (intakeBuild.js) and by the image lab
   (imageLab.js), so what the lab grades is exactly what stores ship.

   The pipeline per face — EVERY decorated image goes through the image
   model; the composite is a positioning draft and a last-resort fallback,
   never the intended product photo:

     1. MEASURE. Vision measures the base photo (garment box, physical width
        in inches, patch-ready rectangle per spot). Each measured spot is
        bounded by the production-standard prior for that location and
        validated against the pixels, then the artwork is placed at its true
        physical size and snapped fully onto fabric.

     2. DRAFT. The exact artwork is composited at the measured spot with the
        fabric's luminance folded into the ink — pixel-faithful lettering,
        correct position and scale. This is the model's reference, not the
        deliverable.

     3. RENDER. Large artwork is re-rendered in place over the whole photo.
        Small and medium artwork uses PATCH RENDERING: the placement region
        is cropped and upscaled to the model's full canvas (the crest's
        lettering becomes hundreds of pixels tall), rendered as genuine
        print/embroidery/patch, verified as a close-up against the original
        artwork file, then feathered back into the photo. Only artwork whose
        every render attempt fails verification ships as the draft.
   -------------------------------------------------------------------------- */

const sharp = require("sharp");
const { analyzeGarmentGeometry, integrateArtworkPatch, renderDecoratedGarment } = require("./ai");
const { STATIC_PLACEMENTS, compositeDecorationsAt, compositeDecorationsOnGarment } = require("./mockup");

const TIER_INCHES = { small: 4, standard: 6, large: 9 };
const DEFAULT_GARMENT_WIDTH_INCHES = 22;
// Boxes at least this fraction of the image width are rendered whole-image;
// below it, the zoom-patch path preserves lettering far better.
const WHOLE_IMAGE_FRACTION = 0.42;

function tierInches(tier) {
  const value = String(tier || "");
  if (value.startsWith("custom")) {
    const inches = parseFloat((value.match(/(\d+(?:\.\d+)?)/) || [])[1]);
    if (Number.isFinite(inches) && inches > 0.5 && inches < 30) return inches;
    return TIER_INCHES.small;
  }
  return TIER_INCHES[value] || TIER_INCHES.small;
}

function tierIsSmall(tier) {
  return tierInches(tier) <= 5;
}

function widthPercent(tier, garmentWidthInches) {
  const width = garmentWidthInches || DEFAULT_GARMENT_WIDTH_INCHES;
  return Math.max(5, Math.min(90, Math.round((tierInches(tier) / width) * 100)));
}

function widthPhraseFor(decoration, garmentWidthInches) {
  const inches = tierInches(decoration.tier);
  const pct = widthPercent(decoration.tier, garmentWidthInches);
  return `exactly about ${inches} inches (${Math.round(inches * 2.54)} cm) wide — approximately ${pct}% of the garment's full width, no wider, with clear blank fabric around it`;
}

/* ── Geometry ────────────────────────────────────────────────────────────── */

async function spotOnFabric(baseBuffer, spot) {
  const { data, info } = await sharp(baseBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sample = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const corners = [sample(2, 2), sample(info.width - 3, 2), sample(2, info.height - 3), sample(info.width - 3, info.height - 3)];
  const background = corners[0].map((_, channel) => corners.reduce((sum, corner) => sum + corner[channel], 0) / corners.length);

  const left = Math.max(0, Math.round(spot.x * info.width));
  const top = Math.max(0, Math.round(spot.y * info.height));
  const width = Math.min(info.width - left, Math.max(1, Math.round(spot.w * info.width)));
  const height = Math.min(info.height - top, Math.max(1, Math.round(spot.h * info.height)));

  let backdrop = 0;
  let total = 0;
  for (let y = top; y < top + height; y += 2) {
    for (let x = left; x < left + width; x += 2) {
      const i = (y * info.width + x) * info.channels;
      const distance =
        Math.abs(data[i] - background[0]) + Math.abs(data[i + 1] - background[1]) + Math.abs(data[i + 2] - background[2]);
      if (distance < 36) backdrop++;
      total++;
    }
  }
  return total === 0 || backdrop / total <= 0.25;
}

/* Vision refines position and scale, but the production-standard coordinate
   is the PRIOR: a measured chest spot may slide a little, never onto the
   sleeve seam. The measured center is clamped into a window around the
   static coordinate for that placement key. */
function boundSpot(geometry, key, spot) {
  const prior = STATIC_PLACEMENTS[key];
  if (!prior) return spot;
  const garment = geometry.garment;
  const centerX = (spot.x + spot.w / 2 - garment.x) / garment.w;
  const centerY = (spot.y + spot.h / 2 - garment.y) / garment.h;
  // Thigh spots get a tight window: the static prior IS the outer thigh,
  // and pants geometry (two legs, inseam) misleads vision more than tops.
  const tolX = /thigh/.test(key) ? 0.05 : 0.11;
  const tolY = /thigh/.test(key) ? 0.1 : 0.14;
  const boundedX = Math.min(prior.cx + tolX, Math.max(prior.cx - tolX, centerX));
  const boundedY = Math.min(prior.cy + tolY, Math.max(prior.cy - tolY, centerY));
  return {
    x: garment.x + boundedX * garment.w - spot.w / 2,
    y: garment.y + boundedY * garment.h - spot.h / 2,
    w: spot.w,
    h: spot.h
  };
}

async function measureGeometry(baseBuffer, decorations, onLog) {
  const log = (message) => onLog && onLog(message);
  const spotKeys = decorations.flatMap((decoration) => decoration.keys || []);
  try {
    const geometry = await analyzeGarmentGeometry(baseBuffer, spotKeys);
    if (!geometry) {
      log("garment geometry unavailable; using static placement coordinates");
      return null;
    }
    const missing = [];
    for (const key of spotKeys) {
      let spot = geometry.spots[key];
      if (spot) {
        spot = boundSpot(geometry, key, spot);
        geometry.spots[key] = spot;
      }
      if (!spot || !(await spotOnFabric(baseBuffer, spot))) missing.push(key);
    }
    if (missing.length) {
      log(`garment geometry missing or off-fabric spots (${missing.join(", ")}); using static placement coordinates`);
      return null;
    }
    return geometry;
  } catch (error) {
    log(`garment geometry failed (${error.message}); using static placement coordinates`);
    return null;
  }
}

/* ── The draft composite ─────────────────────────────────────────────────── */

/* Every decoration at its measured (or static) spot, at its true physical
   size, fabric-blended. Returns { buffer, placed } where each placed entry
   carries the decoration index it belongs to — the patch renderer works
   region by region from these. */
async function measuredComposite({ baseBuffer, decorations, geometry, onLog }) {
  if (!geometry) {
    const flat = [];
    decorations.forEach((decoration, index) => {
      for (const placementKey of decoration.keys || []) flat.push({ logoBuffer: decoration.logo.buffer, placementKey, decorationIndex: index });
    });
    const { buffer, placed } = await compositeDecorationsOnGarment(baseBuffer, flat);
    return { buffer, placed: placed.map((entry, i) => ({ ...entry, decorationIndex: flat[i].decorationIndex })) };
  }
  const meta = await sharp(baseBuffer).metadata();
  const garmentWidthPx = geometry.garment.w * meta.width;
  const widthInches = geometry.garmentWidthInches || DEFAULT_GARMENT_WIDTH_INCHES;

  const placements = [];
  decorations.forEach((decoration, index) => {
    for (const key of decoration.keys || []) {
      const spot = geometry.spots[key];
      const box = {
        left: spot.x * meta.width,
        top: spot.y * meta.height,
        width: spot.w * meta.width,
        height: spot.h * meta.height
      };
      // True physical width, floored so artwork never dwarfs its print area
      // and capped so it never touches the area's edges.
      const physical = (tierInches(decoration.tier) / widthInches) * garmentWidthPx;
      const artWidth = Math.min(Math.max(physical, box.width * 0.5), box.width * 0.82);
      placements.push({
        logoBuffer: decoration.logo.buffer,
        box,
        maxWidth: artWidth,
        maxHeight: box.height * 0.9,
        // Large graphics hang from the top of the print area (just below the
        // collar), the production standard; small crests center in theirs.
        anchorTop: !tierIsSmall(decoration.tier) && /back|full/.test(key),
        decorationIndex: index
      });
    }
  });
  const { buffer, placed } = await compositeDecorationsAt(baseBuffer, placements);
  return { buffer, placed: placed.map((entry, i) => ({ ...entry, decorationIndex: placements[i].decorationIndex })) };
}

/* ── Patch rendering ─────────────────────────────────────────────────────── */

/* Paste the integrated patch back — but only the ARTWORK'S NEIGHBORHOOD.
   The model may retone the crop's backdrop or distant fabric; pasting the
   whole square back printed those tone shifts as faint rectangles. The mask
   holds full opacity over the artwork plus a margin, fades to zero across a
   feather ring, and leaves everything beyond it exactly as it was. */
async function featherPaste(workingBuffer, patchBuffer, left, top, side, artRect) {
  const restored = await sharp(patchBuffer).resize(side, side, { kernel: "lanczos3" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = restored;
  const margin = Math.max(8, Math.round(Math.max(artRect.width, artRect.height) * 0.16));
  const inner = {
    left: artRect.left - margin * 0.2,
    top: artRect.top - margin * 0.2,
    right: artRect.left + artRect.width + margin * 0.2,
    bottom: artRect.top + artRect.height + margin * 0.2
  };
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const dx = Math.max(inner.left - x, 0, x - inner.right);
      const dy = Math.max(inner.top - y, 0, y - inner.bottom);
      const outside = Math.sqrt(dx * dx + dy * dy);
      if (outside <= 0) continue;
      const i = (y * info.width + x) * 4;
      data[i + 3] = outside >= margin ? 0 : Math.round(data[i + 3] * (1 - outside / margin));
    }
  }
  const masked = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return sharp(workingBuffer).composite([{ input: masked, left, top }]).png().toBuffer();
}

async function patchRender({ workingBuffer, placedBox, decoration, method, onLog }) {
  const meta = await sharp(workingBuffer).metadata();
  const side = Math.min(
    Math.min(meta.width, meta.height),
    Math.max(240, Math.round(Math.max(placedBox.width, placedBox.height) * 2.3))
  );
  const left = Math.min(Math.max(Math.round(placedBox.left + placedBox.width / 2 - side / 2), 0), meta.width - side);
  const top = Math.min(Math.max(Math.round(placedBox.top + placedBox.height / 2 - side / 2), 0), meta.height - side);

  const crop = await sharp(workingBuffer)
    .extract({ left, top, width: side, height: side })
    .resize(1024, 1024, { kernel: "lanczos3" })
    .png()
    .toBuffer();

  const integrated = await integrateArtworkPatch({
    patchBuffer: crop,
    logo: {
      logoBuffer: decoration.logo.buffer,
      logoMime: decoration.logo.mimetype,
      logoName: decoration.logo.originalName
    },
    decorationMethod: method,
    onLog
  });
  if (!integrated) return null;
  // The artwork's rectangle inside the crop, in crop pixels — the paste mask
  // hugs it so nothing the model touched beyond it survives.
  const artRect = {
    left: placedBox.left - left,
    top: placedBox.top - top,
    width: placedBox.width,
    height: placedBox.height
  };
  return featherPaste(workingBuffer, integrated, left, top, side, artRect);
}

function renderDecorationsFor(decorations, garmentWidthInches) {
  return decorations.map((decoration) => ({
    logoBuffer: decoration.logo.buffer,
    logoMime: decoration.logo.mimetype,
    logoName: decoration.logo.originalName,
    placementLabel: decoration.label,
    guidance: decoration.guidance,
    widthPhrase: widthPhraseFor(decoration, garmentWidthInches)
  }));
}

/* Render every placed artwork region on a drafted face. Whole-image when any
   artwork is large enough to survive full-canvas rendering; the zoom-patch
   pass otherwise (and as the large path's fallback). */
async function integrateFace({ baseBuffer, draft, placed, decorations, geometry, face, method, onLog }) {
  const log = (message) => onLog && onLog(message);
  const meta = await sharp(draft).metadata();
  const hasBig = placed.some((entry) => entry.width >= meta.width * WHOLE_IMAGE_FRACTION);

  if (hasBig) {
    const rendered = await renderDecoratedGarment({
      baseBuffer,
      draftBuffer: draft,
      decorations: renderDecorationsFor(decorations, geometry?.garmentWidthInches),
      face,
      sourceFace: face,
      decorationMethod: method,
      onLog
    });
    if (rendered) return { buffer: rendered, path: "render" };
    log(`${face} whole-image render did not verify; patch-rendering each artwork`);
  }

  let working = draft;
  let successes = 0;
  for (const entry of placed) {
    const result = await patchRender({
      workingBuffer: working,
      placedBox: entry,
      decoration: decorations[entry.decorationIndex],
      method,
      onLog
    });
    if (result) {
      working = result;
      successes++;
    }
  }
  const path = successes === placed.length ? "render" : successes > 0 ? "render-partial" : "render-fallback-composite";
  if (path !== "render") log(`${face}: ${successes}/${placed.length} artwork regions rendered; the rest ship as the measured composite`);
  return { buffer: working, path };
}

/**
 * Produce ONE face image for a product.
 *
 * decorations: [{ logo: {buffer, mimetype, originalName}, label, keys: [placementKey], tier, guidance }]
 * face / sourceFace: which face to produce, and which face baseBuffer shows.
 * getBackBlank: async () => buffer — lazily generates a blank back view
 *   (required when face is "back").
 *
 * Returns { buffer, path } — "render" | "render-partial" |
 * "render-fallback-composite" ("composite" never ships by design any more).
 */
async function renderFaceImage({ baseBuffer, sourceFace = "front", face = "front", decorations, method = "", getBackBlank, onLog }) {
  if (face === sourceFace) {
    const geometry = await measureGeometry(baseBuffer, decorations, onLog);
    const { buffer: draft, placed } = await measuredComposite({ baseBuffer, decorations, geometry, onLog });
    return integrateFace({ baseBuffer, draft, placed, decorations, geometry, face, method, onLog });
  }

  // Cross-face: back produced from a front photo. Large-only backs render
  // whole-image straight from the front (the model turns the garment
  // around); everything else drafts on a generated back blank first.
  const allLarge = decorations.every((decoration) => !tierIsSmall(decoration.tier));
  if (allLarge) {
    const frontGeometry = await analyzeGarmentGeometry(baseBuffer, []).catch(() => null);
    const rendered = await renderDecoratedGarment({
      baseBuffer,
      decorations: renderDecorationsFor(decorations, frontGeometry?.garmentWidthInches),
      face,
      sourceFace,
      decorationMethod: method,
      onLog
    });
    if (rendered) return { buffer: rendered, path: "render" };
  }

  const blank = await getBackBlank();
  const geometry = await measureGeometry(blank, decorations, onLog);
  const { buffer: draft, placed } = await measuredComposite({ baseBuffer: blank, decorations, geometry, onLog });
  return integrateFace({ baseBuffer: blank, draft, placed, decorations, geometry, face, method, onLog });
}

module.exports = { renderFaceImage, tierInches, tierIsSmall, widthPercent };

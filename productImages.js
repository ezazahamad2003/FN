/* -----------------------------------------------------------------------------
   Product image production — the ONE place a decorated garment photo is made.

   Used by the store builder (intakeBuild.js) and by the image lab
   (imageLab.js), so what the lab grades is exactly what stores ship.

   The pipeline per face:

     1. MEASURE. Vision measures the base photo: the garment's bounding box,
        its physical width in inches, and a patch-ready rectangle for every
        requested spot. Placement and sizing become arithmetic — a 4-inch
        crest on a 24-inch hoodie is 1/6 of its width, sitting inside the
        measured spot — instead of fixed fractions that miss on unusual cuts.

     2. COMPOSITE. The exact artwork is placed at the measured spot with the
        fabric's own luminance folded back into the ink (mockup.fabricBlend),
        so lettering is always pixel-faithful and the print follows the
        cloth. Small artwork (≤5in) SHIPS this way — image models garble the
        fine lettering they redraw.

     3. RENDER (standard/large artwork only). The image model re-renders the
        composite INTO the fabric (same-face), or turns the supplier's front
        photo around and applies the artwork (back placements). Every render
        is verified against the original photo + artwork with an explicit
        width target; a render that never verifies ships as the composite.
   -------------------------------------------------------------------------- */

const sharp = require("sharp");
const { analyzeGarmentGeometry, renderDecoratedGarment } = require("./ai");
const { compositeDecorationsAt, compositeDecorationsOnGarment } = require("./mockup");

const TIER_INCHES = { small: 4, standard: 6, large: 9 };
const DEFAULT_GARMENT_WIDTH_INCHES = 22;

function tierInches(tier) {
  const value = String(tier || "");
  if (value.startsWith("custom")) {
    const inches = parseFloat((value.match(/(\d+(?:\.\d+)?)/) || [])[1]);
    if (Number.isFinite(inches) && inches > 0.5 && inches < 30) return inches;
    return TIER_INCHES.small;
  }
  return TIER_INCHES[value] || TIER_INCHES.small;
}

/* Small artwork ships as the exact positioned composite: at that scale the
   pixel-faithful paste reads as a crisp printed crest, while an image model
   consistently garbles the fine lettering it has to redraw. */
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

/* A spot is only trusted when its PIXELS are fabric. Vision occasionally
   hallucinates a sleeve box out on the backdrop (and its own garment box can
   be loose enough to "contain" it), which is exactly the off-the-garment
   artwork this measuring exists to prevent — so the check is against the
   image itself: sample the backdrop color from the corners and reject any
   spot whose region is more than a quarter backdrop. */
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
      const spot = geometry.spots[key];
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

/* The measured composite: every decoration at its vision-measured spot, at
   its true physical size, fabric-blended. Falls back to the static
   coordinate table when measurement failed. */
async function measuredComposite({ baseBuffer, decorations, geometry, onLog }) {
  if (!geometry) {
    return compositeDecorationsOnGarment(
      baseBuffer,
      decorations.flatMap((decoration) =>
        (decoration.keys || []).map((placementKey) => ({ logoBuffer: decoration.logo.buffer, placementKey }))
      )
    );
  }
  const meta = await sharp(baseBuffer).metadata();
  const garmentWidthPx = geometry.garment.w * meta.width;
  const widthInches = geometry.garmentWidthInches || DEFAULT_GARMENT_WIDTH_INCHES;

  const placements = [];
  for (const decoration of decorations) {
    for (const key of decoration.keys || []) {
      const spot = geometry.spots[key];
      const box = {
        left: spot.x * meta.width,
        top: spot.y * meta.height,
        width: spot.w * meta.width,
        height: spot.h * meta.height
      };
      // True physical width, never exceeding the measured print area — and
      // never touching its edges: a crest that spans its whole spot (a
      // sleeve, a cap panel) reads oversized even at the right inch count.
      const artWidth = Math.min((tierInches(decoration.tier) / widthInches) * garmentWidthPx, box.width * 0.82);
      placements.push({
        logoBuffer: decoration.logo.buffer,
        box,
        maxWidth: artWidth,
        maxHeight: box.height * 0.9,
        // Large graphics hang from the top of the print area (just below the
        // collar), the production standard; small crests center in theirs.
        anchorTop: !tierIsSmall(decoration.tier) && /back|full/.test(key)
      });
    }
  }
  return compositeDecorationsAt(baseBuffer, placements);
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

/**
 * Produce ONE face image for a product.
 *
 * decorations: [{ logo: {buffer, mimetype, originalName}, label, keys: [placementKey], tier, guidance }]
 * face / sourceFace: which face to produce, and which face baseBuffer shows.
 * getBackBlank: async () => buffer — lazily generates a blank back view for
 *   fallbacks (required when face is "back").
 *
 * Returns { buffer, path } where path names how the image was produced:
 * "composite" | "render" | "render-fallback-composite".
 */
async function renderFaceImage({ baseBuffer, sourceFace = "front", face = "front", decorations, method = "", getBackBlank, onLog }) {
  const log = (message) => onLog && onLog(message);
  const smallOnly = decorations.every((decoration) => tierIsSmall(decoration.tier));

  if (face === sourceFace) {
    const geometry = await measureGeometry(baseBuffer, decorations, onLog);
    const draft = await measuredComposite({ baseBuffer, decorations, geometry, onLog });
    if (smallOnly) {
      log(`small ${face} artwork ships as the measured composite`);
      return { buffer: draft, path: "composite" };
    }
    const rendered = await renderDecoratedGarment({
      baseBuffer,
      draftBuffer: draft,
      decorations: renderDecorationsFor(decorations, geometry?.garmentWidthInches),
      face,
      sourceFace,
      decorationMethod: method,
      onLog
    });
    if (rendered) return { buffer: rendered, path: "render" };
    log(`${face} render did not verify; shipping the measured composite`);
    return { buffer: draft, path: "render-fallback-composite" };
  }

  // Cross-face: produce the back from a front photo.
  if (smallOnly) {
    const blank = await getBackBlank();
    const geometry = await measureGeometry(blank, decorations, onLog);
    log("small back artwork ships as the measured composite on the back blank");
    return { buffer: await measuredComposite({ baseBuffer: blank, decorations, geometry, onLog }), path: "composite" };
  }

  // The front photo still tells us how wide the garment is.
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

  const blank = await getBackBlank();
  const geometry = await measureGeometry(blank, decorations, onLog);
  const draft = await measuredComposite({ baseBuffer: blank, decorations, geometry, onLog });
  const integrated = await renderDecoratedGarment({
    baseBuffer: blank,
    draftBuffer: draft,
    decorations: renderDecorationsFor(decorations, geometry?.garmentWidthInches),
    face,
    sourceFace: face,
    decorationMethod: method,
    onLog
  });
  if (integrated) return { buffer: integrated, path: "render" };
  log(`${face} render did not verify; shipping the measured composite`);
  return { buffer: draft, path: "render-fallback-composite" };
}

module.exports = { renderFaceImage, tierInches, tierIsSmall, widthPercent };

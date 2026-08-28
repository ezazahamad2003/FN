const sharp = require("sharp");

/*
 * Product images are built in two deterministic steps so the department's logo
 * is never redrawn by an AI model:
 *   1. ai.generateBlankGarment() produces a BLANK garment photo (no logo, no
 *      text) with a fixed framing prompt: flat lay, front view, centered,
 *      garment filling ~80% of the frame.
 *   2. compositeLogoOnGarment() pastes the EXACT uploaded logo file onto that
 *      base with sharp. Pixel-for-pixel — no hallucinated text or artwork.
 *
 * Placement boxes are fractions of the GARMENT BOUNDING BOX, not of the raw
 * image. The image model does not honour "fills about 80 percent of the frame"
 * consistently, so anchoring to the image made one placement spec land
 * differently on every render — the same logo drifted and changed size run to
 * run. Measuring the garment first makes placement reproducible regardless of
 * how the model framed the shot.
 *
 * cx/cy locate the logo center inside that box. w caps the logo width as a
 * fraction of garment width and h caps its height as a fraction of garment
 * height; BOTH apply, so a tall crest is bounded by h instead of towering out
 * of its intended footprint the way a width-only cap allowed.
 *
 * "Left chest" is the wearer's left, which is the viewer's RIGHT on a
 * front-facing photo.
 */
const PLACEMENTS = {
  "left-chest": { cx: 0.635, cy: 0.3, w: 0.13, h: 0.12 },
  "right-chest": { cx: 0.365, cy: 0.3, w: 0.13, h: 0.12 },
  "center-chest": { cx: 0.5, cy: 0.34, w: 0.26, h: 0.2 },
  "full-front": { cx: 0.5, cy: 0.42, w: 0.4, h: 0.3 },
  // Back placements composite onto a BACK-view base — the build pipeline
  // requests the back face from the image model for these (a supplier photo,
  // which is a front view, is skipped for back placements). Centered across
  // the upper back per the FN placement standard (~25cm below the collar).
  "center-back": { cx: 0.5, cy: 0.34, w: 0.42, h: 0.32 },
  // Sleeves on a flat-lay front view: wearer's left is the viewer's right.
  "left-sleeve": { cx: 0.875, cy: 0.245, w: 0.085, h: 0.09 },
  "right-sleeve": { cx: 0.125, cy: 0.245, w: 0.085, h: 0.09 },
  // Long-sleeve garments lay their arms DOWN the sides, so the sleeve target
  // sits mid-forearm - the short-sleeve coordinates hit the shoulder seam or
  // the backdrop on these cuts.
  "left-sleeve-long": { cx: 0.885, cy: 0.44, w: 0.08, h: 0.09 },
  "right-sleeve-long": { cx: 0.115, cy: 0.44, w: 0.08, h: 0.09 },
  // Caps: centered on the front panel, above the brim. The reference stores
  // (Woodbridge, Alameda, MU caps) carry cap artwork BIG — spanning roughly
  // half to two-thirds of the cap's visible width — so the box budgets for
  // that; the tier arithmetic still sets the true physical size.
  "front-panel": { cx: 0.5, cy: 0.45, w: 0.56, h: 0.32 },
  // Cap side decoration sits over the wearer's left temple panel.
  "cap-side": { cx: 0.74, cy: 0.5, w: 0.16, h: 0.14 },
  // Beanies: decoration fills the front face of the turned-up cuff — about
  // half the beanie's width in the reference stores, not a small tag.
  "beanie-cuff": { cx: 0.5, cy: 0.74, w: 0.44, h: 0.17 },
  // Legwear: OUTER thigh, well clear of the crotch seam. On a flat lay the
  // outer face of each leg sits near the garment's edge, not at 0.3/0.7 —
  // those coordinates drifted the artwork toward the inseam.
  "left-thigh": { cx: 0.78, cy: 0.4, w: 0.15, h: 0.08 },
  "right-thigh": { cx: 0.22, cy: 0.4, w: 0.15, h: 0.08 },
  // Shorts wear their mark low, near the hem — the house convention on every
  // existing store (Champion / Sport-Tek shorts references).
  "left-leg-hem": { cx: 0.74, cy: 0.72, w: 0.13, h: 0.1 },
  "right-leg-hem": { cx: 0.26, cy: 0.72, w: 0.13, h: 0.1 }
};

// "knit hat" and "watch cap" contain hat/cap, so beanies must be tested first.
const BEANIE_TYPES = /\b(beanie|toque|knit\s*(hat|cap)|watch\s*cap|skull\s*cap)\b/i;
const CAP_TYPES = /\b(hat|cap|visor)\b/i;
const LEG_TYPES = /\b(pants?|trousers?|sweatpants?|joggers?|shorts?|bottoms?)\b/i;
// Cuts whose sleeves hang down the sides of a flat lay instead of out.
const LONG_SLEEVE_TYPES = /\b(long\s*sleeve|hoodie|hooded|sweatshirt|crewneck|jacket|job\s*shirt|coat)\b/i;

// Map free-text policy wording onto a placement key. Defaults to left chest,
// the industry-standard uniform placement, when the policy does not say.
function resolvePlacement(product) {
  const garment = `${product.productType || ""} ${product.productLabel || ""}`;
  const text = [product.placement, product.productionNotes]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (BEANIE_TYPES.test(garment)) return "beanie-cuff";
  if (CAP_TYPES.test(garment)) return /\bside\b/.test(text) ? "cap-side" : "front-panel";
  // Legwear has no chest, so chest wording can never apply to it. Shorts
  // take the mark near the hem (house convention); pants on the thigh.
  if (LEG_TYPES.test(garment)) {
    const right = /right[\s-]?(thigh|leg|hip)/.test(text);
    if (/\bshorts?\b/i.test(garment)) return right ? "right-leg-hem" : "left-leg-hem";
    return right ? "right-thigh" : "left-thigh";
  }

  // Back before chest: "center back" contains no chest wording, but the old
  // fall-through still landed it on the left chest — the single most common
  // fire-tee decoration, silently misplaced.
  if (/((center|centre|middle|full|upper|top)[\s-]?back|\bback\b)/.test(text)) return "center-back";
  const longSleeved = LONG_SLEEVE_TYPES.test(garment);
  if (/(left[\s-]?sleeve|both[\s-]?sleeves)/.test(text)) return longSleeved ? "left-sleeve-long" : "left-sleeve";
  if (/right[\s-]?sleeve/.test(text)) return longSleeved ? "right-sleeve-long" : "right-sleeve";

  if (/(full[\s-]?front|full[\s-]?chest|across the (front|chest)|large front)/.test(text)) return "full-front";
  if (/(center|centre|middle)[\s-]?(chest|front)/.test(text)) return "center-chest";
  if (/right[\s-]?chest/.test(text)) return "right-chest";
  return "left-chest";
}

// Remove the white artboard around logos that ship without transparency (JPEG
// or flattened PNG). Only white regions CONNECTED TO THE IMAGE BORDER are
// removed — interior white (lettering, highlights) is part of the artwork and
// must stay. Anti-aliased pixels on the artwork's rim fade out proportionally
// to their whiteness so no halo prints on the garment.
async function removeWhiteBackground(logoBuffer) {
  const { data, info } = await sharp(logoBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const isWhite = (i) => data[i] >= 242 && data[i + 1] >= 242 && data[i + 2] >= 242;
  // 0..1 whiteness used to fade the anti-aliased rim next to the background.
  const whiteness = (i) => {
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    return min >= 200 ? (min - 200) / 55 : 0;
  };

  const background = new Uint8Array(width * height);
  const stack = [];
  const visit = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (background[p] || !isWhite(p * channels)) return;
    background[p] = 1;
    stack.push(p);
  };
  for (let x = 0; x < width; x++) {
    visit(x, 0);
    visit(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    visit(0, y);
    visit(width - 1, y);
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % width;
    const y = (p / width) | 0;
    visit(x + 1, y);
    visit(x - 1, y);
    visit(x, y + 1);
    visit(x, y - 1);
  }

  for (let p = 0; p < width * height; p++) {
    const i = p * channels;
    if (background[p]) {
      data[i + 3] = 0;
      continue;
    }
    const x = p % width;
    const y = (p / width) | 0;
    const touchesBackground =
      (x > 0 && background[p - 1]) ||
      (x < width - 1 && background[p + 1]) ||
      (y > 0 && background[p - width]) ||
      (y < height - 1 && background[p + width]);
    if (touchesBackground) data[i + 3] = Math.round(data[i + 3] * (1 - whiteness(i)));
  }

  return { data, info };
}

// Prepare the uploaded logo for compositing: rasterize SVGs at high density,
// keep existing transparency untouched, and strip the white artboard from
// flattened files without harming interior white artwork.
//
// The box is maxWidth x maxHeight rather than a square, so a tall logo is
// limited by the placement's height budget. A square box let a portrait crest
// grow until its HEIGHT equalled the intended WIDTH, which is what made
// upright badges read as oversized.
// Whether the artwork sits on an opaque white artboard that must be stripped.
//
// Carrying an alpha CHANNEL is not the same as using transparency: exporting a
// logo as RGBA PNG over a white box is completely ordinary, and trusting
// `hasAlpha` meant those logos kept a white rectangle around them on the
// finished garment. Decide from the pixels instead — if the border is opaque
// white there is an artboard, whatever the file's channel layout claims. A
// logo on a deliberate coloured backdrop is left alone rather than guessed at.
async function hasOpaqueWhiteBorder(logoBuffer) {
  const { data, info } = await sharp(logoBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let opaqueWhite = 0;
  let total = 0;
  const sample = (x, y) => {
    const i = (y * width + x) * channels;
    total++;
    if (data[i + 3] > 200 && data[i] >= 242 && data[i + 1] >= 242 && data[i + 2] >= 242) opaqueWhite++;
  };
  for (let x = 0; x < width; x++) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    sample(0, y);
    sample(width - 1, y);
  }
  return total > 0 && opaqueWhite / total > 0.9;
}

async function prepareLogo(logoBuffer, maxWidth, maxHeight) {
  const meta = await sharp(logoBuffer).metadata();
  const resizeOptions = { width: maxWidth, height: maxHeight, fit: "inside" };

  // Rasterize SVGs first so the artboard test below has pixels to inspect.
  const raster =
    meta.format === "svg" ? await sharp(logoBuffer, { density: 300 }).png().toBuffer() : logoBuffer;

  if (!(await hasOpaqueWhiteBorder(raster))) {
    return sharp(raster).resize(resizeOptions).png().toBuffer({ resolveWithObject: true });
  }

  const { data, info } = await removeWhiteBackground(raster);
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .resize(resizeOptions)
    .png()
    .toBuffer({ resolveWithObject: true });
}

// Locate the garment within the render by trimming the studio backdrop.
// Placement is then expressed against this box, so a garment shot at 60% of the
// frame gets the same proportional logo as one shot at 90%.
//
// The backdrop is NOT always white - supplier photos ship on light greys and
// off-whites, and assuming #ffffff made the trim fail, the box fall back to
// the whole frame, and the artwork land beside the garment. Sample the
// actual corner color first and trim against that.
async function garmentBox(baseBuffer, baseMeta) {
  // When the trim can't find the garment (white on white), assume the studio
  // convention every base in this pipeline follows: garment centered,
  // filling ~80% of the frame. The raw full frame put "30% down the garment"
  // at collar height because of the backdrop margin above the shoulders.
  const fullFrame = {
    left: Math.round(baseMeta.width * 0.1),
    top: Math.round(baseMeta.height * 0.06),
    width: Math.round(baseMeta.width * 0.8),
    height: Math.round(baseMeta.height * 0.88)
  };
  try {
    const { data, info } = await sharp(baseBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const sample = (x, y) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const corners = [
      sample(2, 2),
      sample(info.width - 3, 2),
      sample(2, info.height - 3),
      sample(info.width - 3, info.height - 3)
    ];
    const background = corners[0].map((_, channel) =>
      Math.round(corners.reduce((sum, corner) => sum + corner[channel], 0) / corners.length)
    );
    const trimmed = await sharp(baseBuffer)
      .trim({ background: { r: background[0], g: background[1], b: background[2] }, threshold: 18 })
      .toBuffer({ resolveWithObject: true });
    // A trim that keeps almost nothing means the render is unusable; fall
    // back to the frame rather than placing the logo against a bogus box.
    if (trimmed.info.width >= baseMeta.width * 0.2 && trimmed.info.height >= baseMeta.height * 0.2) {
      return {
        left: Math.max(0, -(trimmed.info.trimOffsetLeft || 0)),
        top: Math.max(0, -(trimmed.info.trimOffsetTop || 0)),
        width: trimmed.info.width,
        height: trimmed.info.height
      };
    }
  } catch (error) {
    // Trim is an optimisation, never a hard requirement.
  }
  return fullFrame;
}

/* Fold the fabric's own light back into the artwork so a composite reads as
   printed rather than pasted: the region under the logo is sampled as a
   blurred luminance map and modulated onto the logo's colors, so garment
   folds, seams, and shading show through the print exactly where they run. */
async function fabricBlend(baseBuffer, logoPng, info, left, top) {
  try {
    // prepareLogo hands back PNG bytes; work on raw RGBA.
    const decoded = await sharp(logoPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const region = await sharp(baseBuffer)
      .extract({ left, top, width: decoded.info.width, height: decoded.info.height })
      .greyscale()
      .blur(1.4)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const lum = region.data;
    const lumChannels = region.info.channels; // greyscale → 1
    const count = decoded.info.width * decoded.info.height;
    let sum = 0;
    for (let p = 0; p < count; p++) sum += lum[p * lumChannels];
    const mean = Math.max(1, sum / count);

    const out = decoded.data;
    for (let p = 0; p < count; p++) {
      const i = p * 4;
      if (out[i + 3] === 0) continue;
      // Mostly flat ink with a gentle fabric response, clamped so folds shade
      // the print subtly without muddying the artwork's colors.
      const factor = Math.min(1.12, Math.max(0.72, 0.8 + 0.2 * (lum[p * lumChannels] / mean)));
      out[i] = Math.min(255, Math.round(out[i] * factor));
      out[i + 1] = Math.min(255, Math.round(out[i + 1] * factor));
      out[i + 2] = Math.min(255, Math.round(out[i + 2] * factor));
    }
    // A whisper of blur takes the razor edge off so the print sits IN the
    // fabric; small enough that lettering stays crisp.
    return sharp(out, { raw: { width: decoded.info.width, height: decoded.info.height, channels: 4 } })
      .blur(0.4)
      .png()
      .toBuffer();
  } catch {
    // Blending is polish, never a requirement.
    return logoPng;
  }
}

/* ── Fabric snap ─────────────────────────────────────────────────────────────
   No matter how a placement was computed — measured geometry, static
   coordinates, a leaning garment — the FINAL box must sit on cloth. Sample
   the backdrop color from the corners once, then slide any box that overlaps
   the backdrop toward the garment's center until it lands ≥90% on fabric. */

async function fabricMap(baseBuffer) {
  const { data, info } = await sharp(baseBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sample = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const corners = [sample(2, 2), sample(info.width - 3, 2), sample(2, info.height - 3), sample(info.width - 3, info.height - 3)];
  const background = corners[0].map((_, channel) => corners.reduce((sum, corner) => sum + corner[channel], 0) / corners.length);
  return { data, info, background };
}

function backdropFraction(map, left, top, width, height) {
  const { data, info, background } = map;
  let backdrop = 0;
  let total = 0;
  const x0 = Math.max(0, Math.round(left));
  const y0 = Math.max(0, Math.round(top));
  const x1 = Math.min(info.width, Math.round(left + width));
  const y1 = Math.min(info.height, Math.round(top + height));
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * info.width + x) * info.channels;
      const distance =
        Math.abs(data[i] - background[0]) + Math.abs(data[i + 1] - background[1]) + Math.abs(data[i + 2] - background[2]);
      if (distance < 36) backdrop++;
      total++;
    }
  }
  return total === 0 ? 1 : backdrop / total;
}

/* A white garment on a white backdrop defeats every backdrop-color test —
   the center of the frame (which the garment always occupies) reads as
   backdrop. When that happens the pixel heuristics must stand down: snapping
   or rejecting spots based on them moved artwork onto collars. */
function isLowContrast(map) {
  const { info } = map;
  return backdropFraction(map, info.width * 0.3, info.height * 0.3, info.width * 0.4, info.height * 0.4) > 0.5;
}

function snapToFabric(map, box, left, top, width, height) {
  if (isLowContrast(map)) return { left, top };
  if (backdropFraction(map, left, top, width, height) <= 0.1) return { left, top };
  // Search outward for the NEAREST clean position — dragging toward the
  // garment center pulled leg artwork to the inseam; the closest patch of
  // clean fabric in any direction keeps the intended spot's character.
  const step = Math.max(6, Math.round(box.width * 0.02));
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  let best = { left, top, fraction: backdropFraction(map, left, top, width, height) };
  for (let radius = 1; radius <= 12; radius++) {
    for (const [dx, dy] of directions) {
      const candidateLeft = Math.round(left + dx * radius * step);
      const candidateTop = Math.round(top + dy * radius * step * 0.7);
      const fraction = backdropFraction(map, candidateLeft, candidateTop, width, height);
      if (fraction <= 0.1) return { left: candidateLeft, top: candidateTop };
      if (fraction < best.fraction) best = { left: candidateLeft, top: candidateTop, fraction };
    }
  }
  return { left: best.left, top: best.top };
}

/**
 * Composite decorations at MEASURED positions. `placements` is
 * [{ logoBuffer, box: {left,top,width,height}, maxWidth, maxHeight, anchorTop }]
 * in absolute pixels — boxes come from vision-measured garment geometry
 * (productImages.js), so the artwork lands where a decorator would actually
 * put it, at its true physical size, centered in its spot (large graphics
 * hang from the top of theirs).
 */
async function compositeDecorationsAt(baseBuffer, placements) {
  const baseMeta = await sharp(baseBuffer).metadata();
  const map = await fabricMap(baseBuffer);
  const garment = await garmentBox(baseBuffer, baseMeta);
  const layers = [];
  const placed = [];
  for (const placement of placements) {
    const { data: logo, info } = await prepareLogo(
      placement.logoBuffer,
      Math.max(1, Math.round(placement.maxWidth)),
      Math.max(1, Math.round(placement.maxHeight))
    );
    const box = placement.box;
    let left = Math.min(
      Math.max(Math.round(box.left + (box.width - info.width) / 2), 0),
      baseMeta.width - info.width
    );
    const topRaw = placement.anchorTop ? box.top : box.top + (box.height - info.height) / 2;
    let top = Math.min(Math.max(Math.round(topRaw), 0), baseMeta.height - info.height);
    ({ left, top } = snapToFabric(map, garment, left, top, info.width, info.height));
    const blended = await fabricBlend(baseBuffer, logo, info, left, top);
    layers.push({ input: blended, left, top });
    placed.push({ left, top, width: info.width, height: info.height });
  }
  const buffer = layers.length ? await sharp(baseBuffer).composite(layers).png().toBuffer() : await sharp(baseBuffer).png().toBuffer();
  return { buffer, placed };
}

/**
 * Composite one or more decorations onto a single garment photo in one pass.
 * `decorations` is [{ logoBuffer, placementKey }] — the static-coordinate
 * fallback for when garment geometry could not be measured.
 */
async function compositeDecorationsOnGarment(baseBuffer, decorations) {
  const baseMeta = await sharp(baseBuffer).metadata();
  const box = await garmentBox(baseBuffer, baseMeta);
  const map = await fabricMap(baseBuffer);

  const layers = [];
  const placed = [];
  for (const decoration of decorations) {
    const spec = PLACEMENTS[decoration.placementKey] || PLACEMENTS["left-chest"];
    const { data: logo, info } = await prepareLogo(
      decoration.logoBuffer,
      Math.max(1, Math.round(spec.w * box.width)),
      Math.max(1, Math.round(spec.h * box.height))
    );

    // Clamp to the garment box so an extreme placement can never hang the
    // artwork off the garment and onto the backdrop.
    let left = Math.min(
      Math.max(Math.round(box.left + spec.cx * box.width - info.width / 2), box.left),
      box.left + box.width - info.width
    );
    let top = Math.min(
      Math.max(Math.round(box.top + spec.cy * box.height - info.height / 2), box.top),
      box.top + box.height - info.height
    );
    ({ left, top } = snapToFabric(map, box, left, top, info.width, info.height));
    const blended = await fabricBlend(baseBuffer, logo, info, left, top);
    layers.push({ input: blended, left, top });
    placed.push({ left, top, width: info.width, height: info.height });
  }

  const buffer = layers.length ? await sharp(baseBuffer).composite(layers).png().toBuffer() : await sharp(baseBuffer).png().toBuffer();
  return { buffer, placed };
}

async function compositeLogoOnGarment(baseBuffer, logoBuffer, placementKey) {
  const { buffer } = await compositeDecorationsOnGarment(baseBuffer, [{ logoBuffer, placementKey }]);
  return buffer;
}

module.exports = {
  STATIC_PLACEMENTS: PLACEMENTS,
  compositeDecorationsAt,
  compositeDecorationsOnGarment,
  compositeLogoOnGarment,
  garmentBox,
  resolvePlacement
};

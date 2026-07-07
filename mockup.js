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
 * Placement boxes are fractions of the base image, tuned for that framing.
 * cx/cy locate the logo center; w is the logo width relative to image width.
 * "Left chest" is the wearer's left, which is the viewer's RIGHT on a
 * front-facing photo.
 */
const PLACEMENTS = {
  "left-chest": { cx: 0.6, cy: 0.34, w: 0.14 },
  "right-chest": { cx: 0.4, cy: 0.34, w: 0.14 },
  "center-chest": { cx: 0.5, cy: 0.38, w: 0.3 },
  "full-front": { cx: 0.5, cy: 0.46, w: 0.44 },
  "front-panel": { cx: 0.5, cy: 0.45, w: 0.3 }
};

const HAT_TYPES = /\b(hat|cap|beanie|visor)\b/i;

// Map free-text policy wording onto a placement key. Defaults to left chest,
// the industry-standard uniform placement, when the policy does not say.
function resolvePlacement(product) {
  if (HAT_TYPES.test(product.productType || "") || HAT_TYPES.test(product.productLabel || "")) {
    return "front-panel";
  }
  const text = [product.placement, product.productionNotes]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
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
async function prepareLogo(logoBuffer, targetWidth) {
  const meta = await sharp(logoBuffer).metadata();
  const resizeOptions = { width: targetWidth, height: targetWidth, fit: "inside" };

  if (meta.format === "svg") {
    return sharp(logoBuffer, { density: 300 }).resize(resizeOptions).png().toBuffer({ resolveWithObject: true });
  }
  if (meta.hasAlpha) {
    return sharp(logoBuffer).resize(resizeOptions).png().toBuffer({ resolveWithObject: true });
  }
  const { data, info } = await removeWhiteBackground(logoBuffer);
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .resize(resizeOptions)
    .png()
    .toBuffer({ resolveWithObject: true });
}

async function compositeLogoOnGarment(baseBuffer, logoBuffer, placementKey) {
  const spec = PLACEMENTS[placementKey] || PLACEMENTS["left-chest"];
  const baseMeta = await sharp(baseBuffer).metadata();
  const { data: logo, info } = await prepareLogo(logoBuffer, Math.round(spec.w * baseMeta.width));
  const left = Math.round(spec.cx * baseMeta.width - info.width / 2);
  const top = Math.round(spec.cy * baseMeta.height - info.height / 2);
  return sharp(baseBuffer)
    .composite([{ input: logo, left, top }])
    .png()
    .toBuffer();
}

module.exports = {
  compositeLogoOnGarment,
  resolvePlacement
};

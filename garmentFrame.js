/*
 * One framing rule for every blank garment photo, in both pipelines (the
 * Onboarding Agent's mockups and the New Stores build).
 *
 * Supplier photos arrive framed every which way — a Richardson 112 is a
 * 1200 x 1800 portrait with the cap in the top third — and fitting them as-is
 * left a small cap stranded at the top of an otherwise empty square. So the
 * white margin is cropped off and the garment is centred at a fixed share of
 * the square, and every product image in a store lines up.
 */

const sharp = require("sharp");

// Share of the square the garment's longer side fills.
const GARMENT_FILL = 0.82;

/**
 * Crop the white margin off a flattened (opaque, white-backed) photo and
 * centre it on a white size x size PNG. A photo with no margin to crop, or one
 * trim cannot read, is just fitted.
 */
async function frameGarment(flatImage, size, { fill = GARMENT_FILL } = {}) {
  let trimmed = flatImage;
  try {
    trimmed = await sharp(flatImage).trim({ background: "#ffffff", threshold: 18 }).png().toBuffer();
  } catch {
    trimmed = flatImage;
  }
  const meta = await sharp(trimmed).metadata();
  const target = Math.round(size * fill);
  const scale = target / Math.max(meta.width || 1, meta.height || 1);
  const width = Math.max(1, Math.round((meta.width || 1) * scale));
  const height = Math.max(1, Math.round((meta.height || 1) * scale));
  const garment = await sharp(trimmed).resize({ width, height, fit: "fill", kernel: "lanczos3" }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: "#ffffff" } })
    .composite([{ input: garment, left: Math.floor((size - width) / 2), top: Math.floor((size - height) / 2) }])
    .png()
    .toBuffer();
}

module.exports = { frameGarment, GARMENT_FILL };

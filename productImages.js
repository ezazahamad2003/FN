/* -----------------------------------------------------------------------------
   Product image production — the ONE place a decorated garment photo is made.

   Used by the store builder (intakeBuild.js) — the single producer of every
   decorated product photo a store ships.

   ONE model call per face: the blank garment photo, the artwork files, and a
   plain instruction saying where each mark goes.

   This replaced a measure-then-composite pipeline that asked vision to return
   the garment's box, its width in inches, and a rectangle per spot, then
   placed artwork inside those numbers. The measurements were not reliable
   enough to build on — on one hoodie the garment was reported at 88% of the
   canvas against a true 64%, and spot boxes came back so tight that a 4-inch
   crest was rendered at 1.4 inches. Each estimate then fed the next, so the
   errors compounded into artwork that was the wrong size on a real order.

   Telling the model where the logo goes, in words, and letting it place the
   mark produces better images than measuring for it did.
   -------------------------------------------------------------------------- */

const sharp = require("sharp");
const { editImage } = require("./azureOpenai");

// The customer picks a size tier on the intake form. It is their instruction,
// not a measurement, so it travels as the words a decorator would use.
const TIER_PHRASE = {
  small: "small — about the size of a chest crest",
  standard: "a medium size",
  large: "large, filling most of the print area"
};

function tierPhrase(tier) {
  const value = String(tier || "").toLowerCase();
  if (value.startsWith("custom")) {
    const inches = (value.match(/(\d+(?:\.\d+)?)/) || [])[1];
    return inches ? "about " + inches + " inches wide" : TIER_PHRASE.small;
  }
  if (value.startsWith("large")) return TIER_PHRASE.large;
  if (value.startsWith("standard")) return TIER_PHRASE.standard;
  return TIER_PHRASE.small;
}

function finishPhrase(method) {
  if (/embroider/i.test(method)) return "embroidered";
  if (/patch/i.test(method)) return "a sewn-on patch";
  if (/heat\s*transfer/i.test(method)) return "heat pressed";
  return "screen printed";
}


/* -----------------------------------------------------------------------------
   Artwork preparation.

   The image model reads the logo file in order to reproduce it. When it cannot
   read the mark it does not fail - it INVENTS a plausible logo, a different
   one each time, so the failure is silent, unrepeatable, and ships a fake
   department badge to a customer. One 300x161 department logo came back across
   four runs as "DEUS", "ONE", "BANDIT OUTDOORS" and "Callaway Golf".

   Two things make a mark unreadable, and TRANSPARENCY is the bigger one. A
   logo on an alpha background failed even at 1024px; the identical file
   flattened onto white reproduced its script and strapline exactly. Low
   resolution compounds it, so small artwork is also upscaled - that adds no
   information, but it puts the detail that exists at a scale the model can
   resolve.

   Flattening has one inverse risk: a logo drawn in white disappears on a white
   ground. When almost nothing survives the flatten, it goes onto a dark ground
   instead.
   -------------------------------------------------------------------------- */
const MIN_ARTWORK_EDGE = 1024;

async function prepareArtwork(buffer, garmentColor) {
  try {
    const meta = await sharp(buffer).metadata();
    const longEdge = Math.max(meta.width || 0, meta.height || 0);
    const needsUpscale = Boolean(longEdge) && longEdge < MIN_ARTWORK_EDGE;
    if (!needsUpscale && !meta.hasAlpha) return buffer;

    const portrait = (meta.height || 0) > (meta.width || 0);
    const onBackground = (background) => {
      let pipe = sharp(buffer);
      if (needsUpscale) {
        pipe = pipe.resize({
          [portrait ? "height" : "width"]: MIN_ARTWORK_EDGE,
          fit: "inside",
          kernel: "lanczos3"
        });
      }
      if (meta.hasAlpha) pipe = pipe.flatten({ background });
      return pipe.png().toBuffer();
    };

    if (!meta.hasAlpha) return onBackground("#ffffff");
    // White ink is the only thing a white ground destroys, so only then is a
    // different ground worth the risk of it being drawn.
    return onBackground((await hasLightInk(buffer)) ? garmentColor || "#1f2430" : "#ffffff");
  } catch {
    // An unreadable file is the edit endpoint's problem to report, not ours.
    return buffer;
  }
}

/*
 * Does the artwork contain near-white ink? Such a mark flattened onto white
 * loses those strokes entirely - a logo whose lower half was white lettering
 * came back with those words simply gone.
 */
async function hasLightInk(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(160, 160, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let light = 0;
  let ink = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] < 128) continue;
    ink++;
    if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] > 200) light++;
  }
  return ink > 0 && light / ink > 0.45;
}

/*
 * The garment's own colour, sampled from the blank photo.
 *
 * It is the right ground for artwork carrying white ink: the strokes stay
 * visible the way they will once printed, and if the model draws the flattened
 * rectangle at all it is the same colour as the cloth and disappears. A neutral
 * grey does neither - it was rendered as a visible grey patch on the sleeve.
 */
async function garmentColorOf(baseBuffer) {
  try {
    const { data, info } = await sharp(baseBuffer)
      .resize(120, 120, { fit: "inside" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      // Skip the studio sweep; what remains is the garment.
      if (data[i] > 232 && data[i + 1] > 232 && data[i + 2] > 232) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
    if (!n) return null;
    const hex = (v) => Math.round(v / n).toString(16).padStart(2, "0");
    return "#" + hex(r) + hex(g) + hex(b);
  } catch {
    return null;
  }
}

/**
 * Produce ONE face image for a product.
 *
 * `decorations` are the marks for THIS face: { logo, label, tier }.
 * A face that is not the source face needs its own blank — back artwork
 * composited onto a front photo would print across the chest — so
 * `getBackBlank` supplies it.
 *
 * Returns { buffer, path }. `path` is "render" when the model produced the
 * image and "render-failed" when it did not and the blank is shipping
 * instead, so the caller can tell a real product photo from a bare garment.
 */
async function renderFaceImage({
  baseBuffer,
  sourceFace = "front",
  face = "front",
  decorations,
  method = "",
  productType = "garment",
  getBackBlank,
  onLog
}) {
  const log = (message) => onLog && onLog(message);
  const base = face === sourceFace ? baseBuffer : await getBackBlank();

  // Sampled once: artwork carrying white ink is flattened onto the cloth's own
  // colour so those strokes survive.
  const garmentColor = await garmentColorOf(base);

  // One image per distinct artwork file; two spots sharing a logo reference
  // the same image rather than sending it twice.
  const images = [{ buffer: base, mimeType: "image/png", name: "garment.png" }];
  const indexByName = new Map();
  for (const decoration of decorations) {
    const name = decoration.logo.originalName || "logo.png";
    if (indexByName.has(name)) continue;
    indexByName.set(name, images.length + 1);
    const artwork = await prepareArtwork(decoration.logo.buffer, garmentColor);
    images.push({
      buffer: artwork,
      // Preparation re-encodes as PNG, so the declared type has to follow it.
      mimeType: artwork === decoration.logo.buffer ? decoration.logo.mimetype || "image/png" : "image/png",
      name
    });
  }

  const instructions = decorations
    .map((decoration) => {
      const index = indexByName.get(decoration.logo.originalName || "logo.png");
      /* "as a badge" earned its place on chest crests - it puts the mark where
         a decorator would. But it is a literal instruction: on a screen-printed
         sleeve the model drew an actual badge, a bounded rectangle with a
         border, where the ink should sit straight on the cloth. So the word
         follows the decoration method: a patch and embroidery ARE badges, a
         print and a transfer are not. */
      const asBadge = /embroider|patch/i.test(method) ? " as a badge," : "";
      return (
        "Put the logo in image " + index + " on the " + String(decoration.label || "front left chest").toLowerCase() +
        asBadge + " " + tierPhrase(decoration.tier) + "."
      );
    })
    .join(" ");

  /* Wording matters more than any other lever here, and this sentence is the
     result of an A/B across six phrasings on the same garment.

     "as a badge" is what put the mark where a decorator would actually put it.
     But asking the model to follow "the fabric's folds and the photo's
     lighting" dulled the artwork - it shaded the ink into the cloth until the
     colours went muddy and small text stopped reading. Asking instead for the
     logo's own colours to stay bright and true keeps the crispness of the
     barest prompt while keeping the better placement. Every extra clause
     beyond this made the result worse, not better. */
  /* A sleeve print is barely visible on a flat front-facing photo: the sleeve
     is edge-on, so the artwork is squeezed into a sliver and reads as the
     wrong size no matter how it is described. Real sleeve decoration is
     photographed from the SIDE, with the decorated arm toward the camera.

     Only when every mark on this face is on a sleeve. A garment that also
     carries a chest crest or a back graphic has to stay front-on, or the
     turn hides the decoration the customer actually ordered. */
  const labels = decorations.map((decoration) => String(decoration.label || ""));
  const sleeveOnly = labels.length > 0 && labels.every((label) => /sleeve/i.test(label));
  const viewClause = sleeveOnly
    ? " Photograph the garment from the side, turned so the decorated sleeve faces the camera and the print on it is fully visible."
    : "";

  const prompt =
    "Image 1 is a " + productType + ", shown from the " + face + ". " + instructions +
    viewClause +
    " Make each one look really " + finishPhrase(method) + " on the fabric," +
    " keeping the logo's own colours bright, crisp and exactly as they are in its own image —" +
    " same colours, same text, spelled the same." +
    " Change nothing else about the photo.";

  try {
    const buffer = await editImage({ images, prompt });
    return { buffer, path: "render" };
  } catch (error) {
    // A build that ships a blank is recoverable; a build that throws loses the
    // whole product, so the failure is logged and the garment goes through.
    log(face + " render failed (" + error.message + "); shipping the blank garment");
    return { buffer: base, path: "render-failed" };
  }
}

module.exports = { renderFaceImage };

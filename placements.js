/* -----------------------------------------------------------------------------
   Decoration placement standards.

   Transcribed from the placement diagrams in the FN Simple Uniforms store build
   form (the three reference images now served from /reference). Those diagrams
   are the production standard, so encoding them here means one source of truth
   for three consumers:

     • the customer intake form, which shows the diagrams next to the picker;
     • the mockup/image agent, which needs to be told in words where artwork
       sits and how big it is - an image model cannot read a PNG diagram;
     • the review queue, which shows an operator what was actually specified.

   Measurements are given as the diagrams give them: metric for tops (measured
   to the CENTRE of the logo, left/right as worn), imperial for legwear.
   -------------------------------------------------------------------------- */

// Tops - from the FRONT / BACK measurement diagram.
const TOP_PLACEMENTS = {
  "front left chest": {
    label: "Front left chest",
    face: "front",
    guidance:
      "left chest as worn, centre of the logo roughly 20-21 cm down from the shoulder seam for men's cuts (16-17 cm women's, 15-16 cm youth), sitting about one third up from the bottom of the sleeve to the torso join"
  },
  "center back": {
    label: "Center back",
    face: "back",
    guidance: "centred across the upper back, centre of the artwork about 25 cm down from the back neck seam"
  },
  "center chest": {
    label: "Center chest",
    face: "front",
    guidance: "centred on the chest, about 10-11 cm down from the front neck seam on garments without a placket"
  },
  "back neck": {
    label: "Back neck / under collar",
    face: "back",
    guidance: "centred under the back collar, 6-8 cm down from the neck seam"
  },
  "top back": {
    label: "Through shoulders / top back",
    face: "back",
    guidance: "centred across the shoulder blades, about 15 cm down from the back neck seam"
  },
  "left sleeve": {
    label: "Left sleeve",
    face: "front",
    guidance:
      "on the wearer's left sleeve, 11 cm down from the shoulder seam on long sleeves, 2 cm up from the hem stitch on short sleeves, 22 cm from seam on raglan cuts"
  },
  "right sleeve": {
    label: "Right sleeve",
    face: "front",
    guidance:
      "on the wearer's right sleeve, 11 cm down from the shoulder seam on long sleeves, 2 cm up from the hem stitch on short sleeves, 22 cm from seam on raglan cuts"
  },
  "both sleeves": {
    label: "Both sleeves",
    face: "front",
    guidance: "mirrored on both sleeves, 11 cm down from each shoulder seam on long sleeves, 2 cm up from the hem stitch on short sleeves"
  },
  "front hip": {
    label: "Front hip",
    face: "front",
    guidance: "lower front hem, 2 cm up from the stitch and 2 cm in from the side seam"
  },
  "front center": {
    label: "Front center (cap)",
    face: "front",
    guidance: "centred on the cap front panel, sitting just above the brim seam"
  },
  side: {
    label: "Side (cap)",
    face: "front",
    guidance: "on the cap side panel, centred between the seams"
  }
};

// Legwear - from the pants / shorts diagram, which gives explicit print sizes.
const LEG_PLACEMENTS = {
  "left leg": {
    label: "Left leg",
    face: "front",
    guidance: "on the wearer's left outer thigh, print area about 5″ × 5″"
  },
  "right leg": {
    label: "Right leg",
    face: "front",
    guidance: "on the wearer's right outer thigh, print area about 5″ × 5″"
  },
  "outer thigh": { label: "Outer thigh", face: "front", guidance: "outer thigh, print area about 5″ × 5″" },
  "side hip": { label: "Side hip", face: "front", guidance: "side hip, print area about 3″ × 1.5″" },
  pocket: { label: "Pocket", face: "back", guidance: "on the back pocket, print area about 3″ × 3″" },
  "lower leg": { label: "Lower leg", face: "front", guidance: "lower leg above the cuff, print area about 3″ × 6″" },
  "full leg": { label: "Full leg", face: "front", guidance: "running down the full outer leg, print area about 4″ × 16″" },
  waistband: { label: "Waistband", face: "back", guidance: "on the rear waistband, print area about 6″ × 2″" }
};

const PLACEMENTS = { ...TOP_PLACEMENTS, ...LEG_PLACEMENTS };

// Size tiers, straight from the "Decoration Reference" table on page 1.
const SIZE_TIERS = {
  Small: { width: "~4 inches wide", use: "Left/right chest, sleeve" },
  Standard: { width: "~6 inches wide", use: "Center chest, cap front" },
  "Large / Full Back": { width: "~8-10 inches wide", use: "Center back, full front" }
};

// The reference diagrams themselves, served to the intake form and linked from
// the review queue so an operator can check a placement against the standard.
const REFERENCE_IMAGES = [
  {
    id: "garment-placements",
    src: "/reference/logo-placements-garments.png",
    title: "Placement by garment type",
    covers: ["t-shirt", "sweatshirt", "polo", "shirt", "trousers", "jacket", "shorts", "overalls"]
  },
  {
    id: "measurements",
    src: "/reference/placement-measurements-front-back.png",
    title: "Front and back placement measurements",
    covers: ["sleeve", "centre front", "chest", "front hip", "back neck", "top back", "centre back", "bottom back"]
  },
  {
    id: "legwear",
    src: "/reference/placement-pants-shorts.png",
    title: "Pants and shorts placement",
    covers: ["outer thigh", "side hip", "pocket", "lower leg", "full leg", "waistband"]
  }
];

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function lookupPlacement(placement) {
  const key = normalize(placement);
  if (PLACEMENTS[key]) return PLACEMENTS[key];
  // Tolerate the spelling drift between the form, the parser, and free text
  // ("Front Left Chest", "left-chest", "centre back").
  const relaxed = key.replace(/^front /, "").replace(/centre/g, "center");
  return (
    PLACEMENTS[relaxed] ||
    Object.values(PLACEMENTS).find((entry) => normalize(entry.label) === key) ||
    null
  );
}

/**
 * A sentence describing where decoration sits, for the image/mockup prompt.
 * Returns "" when the placement is unknown rather than guessing a position —
 * an invented placement is worse than an undecorated base, because the real
 * logo gets composited on top of it afterwards.
 */
// Tier labels arrive in two spellings: the form's ("Small", "Large / Full
// Back") and normalizeTierLabel's lowercase keys ("small", "large",
// "custom: …"). Accept both — a strict-case lookup silently dropped the
// artwork-width clause from every build-pipeline prompt.
function lookupTier(sizeTier) {
  if (SIZE_TIERS[sizeTier]) return SIZE_TIERS[sizeTier];
  const key = normalize(sizeTier);
  if (!key) return null;
  if (key.startsWith("custom")) {
    const detail = String(sizeTier).replace(/^custom:?\s*/i, "").trim();
    return detail ? { width: detail } : null;
  }
  return Object.entries(SIZE_TIERS).find(([label]) => normalize(label).startsWith(key))?.[1] || null;
}

function placementGuidance(placement, sizeTier) {
  const entry = lookupPlacement(placement);
  if (!entry) return "";
  const tier = lookupTier(sizeTier);
  const size = tier ? `, artwork approximately ${tier.width}` : "";
  return `Decoration position for this garment: ${entry.guidance}${size}. Show the ${entry.face} of the garment.`;
}

/** Which face of the garment to photograph for a given placement. */
function placementFace(placement) {
  return lookupPlacement(placement)?.face || "front";
}

module.exports = {
  REFERENCE_IMAGES,
  placementFace,
  placementGuidance
};

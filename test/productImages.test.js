const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

/* productImages takes editImage at load, so the fake goes into the require
   cache first. Each test file runs in its own process. */
const prompts = [];
const sent = [];
require.cache[require.resolve("../azureOpenai")] = {
  exports: {
    editImage: async ({ prompt, images }) => {
      prompts.push(prompt);
      sent.push(images);
      return Buffer.from("png");
    }
  }
};
const { renderFaceImage } = require("../productImages");

async function promptFor(label, tier, productType = "T-Shirt") {
  const base = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#1f2a44" } }).png().toBuffer();
  const logo = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#ffffff" } }).png().toBuffer();
  prompts.length = 0;
  await renderFaceImage({
    baseBuffer: base,
    decorations: [{ logo: { buffer: logo, mimetype: "image/png", originalName: "crest.png" }, label, tier }],
    method: "print",
    productType
  });
  return prompts[0];
}

test("each placement asks for the size the store signed off on", async () => {
  // Chest crest: the coin-sized wording (~18% under the old pocket-sized one).
  assert.match(await promptFor("Front left chest", "Small"), /about 1\.5 inches wide, no bigger than a coin/);
  // Shorts keep the pocket-sized leg mark — they were judged right as they were.
  const shorts = await promptFor("Lower left leg", "Small", "Shorts");
  assert.match(shorts, /pocket-sized crest about 2 inches wide/);
  assert.doesNotMatch(shorts, /coin/);
  assert.match(await promptFor("Left thigh", "Small", "Sweatpants"), /pocket-sized crest about 2 inches wide/);
  // Back graphic: a third of the torso (~20% under "half"), its top about
  // 4 inches under the collar.
  const back = await promptFor("Center back", "Large / Full Back");
  assert.match(back, /about a third as wide as the torso/);
  assert.match(back, /on the center back, high on the upper back, its top edge about a hand's width below the collar, about a third/);
  // Only the back is told where to sit; every other spot keeps its own words.
  assert.doesNotMatch(await promptFor("Front left chest", "Small"), /hand's width|upper back/);
  // A custom size is the customer's own number, whatever the placement.
  assert.match(await promptFor("Front left chest", "Custom: 4.5"), /about 4\.5 inches wide/);
});

test("a face carrying embroidery and print names the finish on each mark", async () => {
  const base = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#1f2a44" } }).png().toBuffer();
  const crest = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const sleeve = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#eeeeee" } }).png().toBuffer();
  prompts.length = 0;
  await renderFaceImage({
    baseBuffer: base,
    decorations: [
      { logo: { buffer: crest, mimetype: "image/png", originalName: "crest.png" }, label: "Front left chest", tier: "Small", method: "embroidery" },
      { logo: { buffer: sleeve, mimetype: "image/png", originalName: "sleeve.png" }, label: "Right sleeve", tier: "Small", method: "print" }
    ],
    method: "mixed",
    productType: "Job Shirt"
  });
  const prompt = prompts[0];
  assert.match(prompt, /on the front left chest as a badge, .*?, embroidered\./);
  assert.match(prompt, /on the right sleeve .*?, screen printed\./);
  assert.doesNotMatch(prompt, /on the right sleeve as a badge/);
  assert.match(prompt, /Make each one look really embroidered or screen printed on the fabric, as said for it,/);

  // A face of one finish keeps the sentence exactly as it was tested.
  const single = await promptFor("Front left chest", "Small");
  assert.match(single, /Make each one look really screen printed on the fabric, keeping/);
  assert.doesNotMatch(single, /as said for it/);
});

/* ---------------------------------------------------------------------------
   The ground a transparent logo is flattened onto before the model reads it.
   ------------------------------------------------------------------------- */

const GREEN = { r: 47, g: 74, b: 53 };

function svgLogo(body, size = 1200) {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${body}</svg>`)).png().toBuffer();
}

/* What the model is handed for a logo: its top-left pixel (the ground, since
   every logo here leaves its corner empty) and a pixel inside the artwork. */
async function sentFor(logo, { garment = GREEN, at = [0.5, 0.5] } = {}) {
  const base = await sharp({ create: { width: 64, height: 64, channels: 3, background: garment } }).png().toBuffer();
  sent.length = 0;
  await renderFaceImage({
    baseBuffer: base,
    decorations: [{ logo: { buffer: logo, mimetype: "image/png", originalName: "crest.png" }, label: "Front left chest", tier: "Small" }],
    method: "embroidery",
    productType: "Hoodie"
  });
  const artwork = sent[0][1].buffer;
  const { data, info } = await sharp(artwork).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => {
    const i = (Math.round(y * (info.height - 1)) * info.width + Math.round(x * (info.width - 1))) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  return { artwork, channels: info.channels, ground: px(0, 0), ink: px(at[0], at[1]) };
}

test("white ink in the minority still moves a transparent logo off the white ground", async () => {
  // Black artwork with a white ring round it: the white is about a fifth of the ink.
  const logo = await svgLogo(
    '<circle cx="600" cy="600" r="380" fill="#000000"/>' +
    '<circle cx="600" cy="600" r="520" fill="none" stroke="#ffffff" stroke-width="40"/>'
  );
  const out = await sentFor(logo, { at: [0.5, 80 / 1200] });
  assert.equal(out.channels, 3, "the model is sent an opaque image");
  assert.deepEqual(out.ground, [GREEN.r, GREEN.g, GREEN.b], "the ground is the garment's colour");
  assert.deepEqual(out.ink, [255, 255, 255], "the white ring is still white, and now visible");
});

test("hairline white strokes on a large file are counted", async () => {
  // 3000 px wide, 8 px white lines: a thumbnail thins these to nothing.
  let lines = "";
  for (let y = 300; y <= 2700; y += 100) lines += `<rect x="300" y="${y}" width="2400" height="8" fill="#ffffff"/>`;
  const logo = await svgLogo('<rect x="1300" y="1320" width="400" height="60" fill="#000000"/>' + lines, 3000);
  const out = await sentFor(logo);
  assert.deepEqual(out.ground, [GREEN.r, GREEN.g, GREEN.b]);
});

test("a transparent logo with no white ink keeps the white ground", async () => {
  const logo = await svgLogo('<circle cx="600" cy="600" r="400" fill="#c8102e"/><rect x="450" y="560" width="300" height="80" fill="#f2b134"/>');
  assert.deepEqual((await sentFor(logo)).ground, [255, 255, 255]);
  // A speck of white - a highlight - is not worth leaving white for.
  const glint = await svgLogo('<circle cx="600" cy="600" r="400" fill="#c8102e"/><circle cx="480" cy="470" r="18" fill="#ffffff"/>');
  assert.deepEqual((await sentFor(glint)).ground, [255, 255, 255]);
});

test("ink the colour of the cloth does not send a logo with white ink back to white", async () => {
  // Mostly black with a little white, on a black garment. The black is lost on
  // the cloth as it is on the real hoodie; the white is what will show.
  const logo = await svgLogo('<rect x="200" y="200" width="800" height="800" fill="#000000"/><rect x="500" y="560" width="200" height="80" fill="#ffffff"/>');
  const out = await sentFor(logo, { garment: { r: 12, g: 12, b: 14 } });
  assert.deepEqual(out.ground, [12, 12, 14]);
  assert.deepEqual(out.ink, [255, 255, 255]);
});

test("a logo drawn mostly in a light colour that is not white still leaves the white ground", async () => {
  const navy = { r: 28, g: 43, b: 74 };
  for (const colour of ["#ffff00", "#ffd700", "#bfe3ff"]) {
    const logo = await svgLogo(`<text x="600" y="700" text-anchor="middle" font-family="Arial, sans-serif" font-size="300" font-weight="700" fill="${colour}">E7</text>`);
    assert.deepEqual((await sentFor(logo, { garment: navy })).ground, [navy.r, navy.g, navy.b], colour);
  }
});

test("silver ink is not white ink", async () => {
  // Light grey lettering reads on white. Resizing sharpens its edges past its
  // own colour, which a looser idea of "white" counted as white ink.
  const logo = await svgLogo(
    '<circle cx="600" cy="420" r="300" fill="#12284c"/>' +
    '<text x="600" y="1000" text-anchor="middle" font-family="Arial, sans-serif" font-size="200" font-weight="700" fill="#c0c0c0">ENGINE 7</text>',
    2400
  );
  assert.deepEqual((await sentFor(logo)).ground, [255, 255, 255]);
});

test("a blank whose colour cannot be read gives white ink a dark ground", async () => {
  const logo = await svgLogo('<rect x="200" y="200" width="800" height="800" fill="#ffffff"/>');
  assert.deepEqual((await sentFor(logo, { garment: { r: 255, g: 255, b: 255 } })).ground, [0x1f, 0x24, 0x30]);
});

test("a grey-and-alpha logo is read like any other", async () => {
  const logo = await sharp(await svgLogo('<rect x="200" y="200" width="800" height="800" fill="#ffffff"/>'))
    .toColourspace("b-w")
    .png()
    .toBuffer();
  assert.equal((await sharp(logo).metadata()).channels, 2);
  assert.deepEqual((await sentFor(logo)).ground, [GREEN.r, GREEN.g, GREEN.b]);
});

test("an opaque logo big enough to read is sent exactly as uploaded", async () => {
  const logo = await sharp({ create: { width: 1200, height: 1200, channels: 3, background: "#14243d" } }).png().toBuffer();
  assert.equal((await sentFor(logo)).artwork, logo);
});

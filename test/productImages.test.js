const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

/* productImages takes editImage at load, so the fake goes into the require
   cache first. Each test file runs in its own process. */
const prompts = [];
require.cache[require.resolve("../azureOpenai")] = {
  exports: {
    editImage: async ({ prompt }) => {
      prompts.push(prompt);
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

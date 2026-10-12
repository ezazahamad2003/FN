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
  // Back graphic: a little under a third of the torso (~24% under "half").
  assert.match(await promptFor("Center back", "Large / Full Back"), /a little under a third as wide as the torso/);
  // A custom size is the customer's own number, whatever the placement.
  assert.match(await promptFor("Front left chest", "Custom: 4.5"), /about 4\.5 inches wide/);
});

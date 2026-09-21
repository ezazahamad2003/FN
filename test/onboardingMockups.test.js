const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const rules = require("../onboardingRules");
const mockups = require("../onboardingMockups");

// Every test here runs with no keys and no network: the model calls are
// replaced with recorders, and the images are tiny sharp-generated PNGs.
delete process.env.AZURE_STORAGE_CONNECTION_STRING;

const SIZE = 128; // output size for the render tests; 2000 would only be slow

async function solid(width, height, background, { format = "png", channels = 3 } = {}) {
  const image = sharp({ create: { width, height, channels, background } });
  return format === "jpeg" ? image.jpeg().toBuffer() : image.png().toBuffer();
}

async function pixel(buffer, x, y) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

async function dims(buffer) {
  const meta = await sharp(buffer).metadata();
  return { width: meta.width, height: meta.height, format: meta.format };
}

function fakeRenderers({ failFirstWithSize = false, failAlways = false, reasonAnswer = null } = {}) {
  const calls = { render: [], generate: [], supplier: [], reason: [] };
  let failed = false;
  mockups.setRenderers({
    renderFaceImage: async (options) => {
      calls.render.push(options);
      if (failAlways) throw new Error("model down");
      if (failFirstWithSize && options.size && !failed) {
        failed = true;
        throw new Error("size not supported");
      }
      const base = options.face === options.sourceFace ? options.baseBuffer : await options.getBackBlank();
      return { buffer: base, path: "render" };
    },
    generateBlankGarment: async (options) => {
      calls.generate.push(options);
      return solid(300, 300, "#404040");
    },
    findSupplierBlank: async (product) => {
      calls.supplier.push(product);
      return { imageBuffer: await solid(200, 200, "#808080") };
    },
    reason: async (options) => {
      calls.reason.push(options);
      if (reasonAnswer instanceof Error) throw reasonAnswer;
      return reasonAnswer || JSON.stringify({ artworkVisible: true, placementMatches: true, inventedText: false, notes: "looks right" });
    }
  });
  return calls;
}

function tee(overrides = {}) {
  return rules.expandProduct(
    {
      brand: "Next Level",
      styleNumber: "NL3600",
      type: "T-shirt",
      colors: ["Navy", "Midnight Navy"],
      sizes: ["S", "M"],
      decorationCodes: "F01/B01",
      fulfillment: "One Week Item",
      ...overrides
    },
    { departmentCode: "VAC" }
  ).product;
}

test("constants come from the rules", () => {
  assert.equal(mockups.MOCKUP_SIZE, Number(process.env.ONBOARDING_MOCKUP_SIZE) || 2000);
  assert.deepEqual(mockups.BANNER, { width: 3584, height: 2048 });
  assert.equal(mockups.MODEL_INPUT_SIZE, 1024);
});

test("normalizeBlank: square white canvas, letterboxed, alpha flattened", async () => {
  const wide = await solid(300, 150, "#ff0000", { format: "jpeg" });
  const out = await mockups.normalizeBlank(wide, { size: 200 });
  assert.deepEqual(await dims(out), { width: 200, height: 200, format: "png" });
  // Red fills the middle band; the letterbox above and below is white.
  const centre = await pixel(out, 100, 100);
  assert.ok(centre.r > 200 && centre.g < 60 && centre.b < 60, `centre ${JSON.stringify(centre)}`);
  const top = await pixel(out, 100, 10);
  assert.deepEqual([top.r, top.g, top.b], [255, 255, 255]);

  const transparent = await solid(50, 50, { r: 0, g: 0, b: 0, alpha: 0 }, { channels: 4 });
  const flat = await mockups.normalizeBlank(transparent, { size: 64 });
  const p = await pixel(flat, 32, 32);
  assert.deepEqual([p.r, p.g, p.b, p.a], [255, 255, 255, 255]);

  // Defaults to the model input size.
  assert.equal((await dims(await mockups.normalizeBlank(wide))).width, 1024);

  // SVG rasterises.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#0000ff"/></svg>');
  const fromSvg = await mockups.normalizeBlank(svg, { size: 100 });
  assert.equal((await dims(fromSvg)).width, 100);
  const blue = await pixel(fromSvg, 50, 50);
  assert.ok(blue.b > 200 && blue.r < 60, `svg centre ${JSON.stringify(blue)}`);
});

test("normalizeBlank: HEIC and unreadable PDFs are refused with a clear message", async () => {
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(32)]);
  await assert.rejects(() => mockups.normalizeBlank(heic), /HEIC/);
  await assert.rejects(() => mockups.normalizeBlank(Buffer.from("%PDF-1.4 not really a pdf")), /PDF/);
  await assert.rejects(() => mockups.normalizeBlank(Buffer.alloc(0)), /empty/i);
  await assert.rejects(() => mockups.normalizeBlank(Buffer.from("definitely not an image")), /could not be read/);
});

test("toSquare: contain on white at the requested size", async () => {
  const out = await mockups.toSquare(await solid(100, 50, "#00ff00"), 200);
  assert.deepEqual(await dims(out), { width: 200, height: 200, format: "png" });
  const edge = await pixel(out, 100, 5);
  assert.deepEqual([edge.r, edge.g, edge.b], [255, 255, 255]);
  const mid = await pixel(out, 100, 100);
  assert.ok(mid.g > 200 && mid.r < 60);
});

test("decorationPlan: tee F01/B01", () => {
  const plan = mockups.decorationPlan(tee());
  assert.deepEqual(plan.front, [{ code: "F01", label: "Front left chest", tier: "Small" }]);
  assert.deepEqual(plan.back, [{ code: "B01", label: "Center back", tier: "Large / Full Back" }]);
});

test("decorationPlan: hats put embroidery on the front panel, back is empty", () => {
  const hat = rules.expandProduct(
    { brand: "Richardson", styleNumber: "R112", type: "Hat", colors: ["Navy"], sizes: ["OSFA"], decorationCodes: "E01", fulfillment: "One Week Item" },
    { departmentCode: "VAC" }
  ).product;
  const plan = mockups.decorationPlan(hat);
  assert.deepEqual(plan.front, [{ code: "E01", label: "Front center", tier: "Standard" }]);
  assert.deepEqual(plan.back, []);
  // Beanies count as headwear too.
  assert.equal(mockups.decorationPlan({ type: "Knit beanie", decorationCodes: "E01" }).front[0].label, "Front center");
});

test("decorationPlan: Class B shirt embroidery goes on the shoulders (E01 left, E02 right)", () => {
  const classB = { type: "Class B", classB: true, decorationCodes: "E01/E02/E03" };
  assert.ok(mockups.isClassBShirt(classB));
  assert.ok(mockups.isClassBShirt({ type: "Class B shirt", classB: true }));
  assert.ok(!mockups.isClassBShirt({ type: "Class B uniform pants", classB: true }));
  assert.ok(!mockups.isClassBShirt({ type: "T-shirt", classB: false }));
  const plan = mockups.decorationPlan(classB);
  assert.deepEqual(plan.front.map((d) => [d.code, d.label, d.tier]), [
    ["E01", "Left sleeve", "Small"],
    ["E02", "Right sleeve", "Small"],
    ["E03", "Front left chest", "Small"]
  ]);
  assert.deepEqual(plan.back, []);
});

test("decorationPlan: pants have nothing; both sleeves land on the front", () => {
  const pants = { type: "Pants", decorationCodes: "" };
  assert.deepEqual(mockups.decorationPlan(pants), { front: [], back: [] });
  const sleeves = mockups.decorationPlan({ type: "Hoodie", decorationCodes: "LS01/RS01/F01" });
  assert.deepEqual(sleeves.front.map((d) => `${d.code}:${d.label}`), ["F01:Front left chest", "RS01:Right sleeve", "LS01:Left sleeve"]);
  assert.deepEqual(sleeves.back, []);
  // Other embroidered garments default to the left chest.
  assert.equal(mockups.decorationPlan({ type: "Polo", decorationCodes: "E01" }).front[0].label, "Front left chest");
  // Bad codes are ignored rather than thrown.
  assert.deepEqual(mockups.decorationPlan({ type: "Tee", decorationCodes: "X99" }), { front: [], back: [] });
});

test("stylePlans: one plan per Style, null style for a single set-up", () => {
  const single = mockups.stylePlans(tee());
  assert.equal(single.length, 1);
  assert.equal(single[0].style, null);
  assert.deepEqual(single[0].codes, ["F01", "B01"]);

  const multi = mockups.stylePlans(tee({ decorationCodes: "", styles: [{ decorationCodes: "F01/B01" }, { decorationCodes: "F02/B01" }] }));
  assert.deepEqual(multi.map((p) => p.style), ["Style 1", "Style 2"]);
  assert.deepEqual(multi[1].codes, ["F02", "B01"]);
  assert.equal(multi[1].front[0].code, "F02");

  // Raw rows (before expandProduct) work too.
  const raw = mockups.stylePlans({ type: "T-shirt", styles: [{ decorationCodes: "F01" }, { decorationCodes: "F02" }] });
  assert.deepEqual(raw.map((p) => p.style), ["Style 1", "Style 2"]);
});

test("renderProductMockups: one render per face per Style per colour, size first then fallback", async () => {
  const calls = fakeRenderers({ failFirstWithSize: true });
  const product = tee({ decorationCodes: "", styles: [{ decorationCodes: "F01/B01" }, { decorationCodes: "F02/B01" }] });
  const front = await solid(240, 320, "#1a2a5a", { format: "jpeg" });
  const back = await solid(240, 320, "#1a2a5a", { format: "jpeg" });
  const art = async (name) => ({ buffer: await solid(40, 40, "#ffcc00"), mimetype: "image/png", name });
  const artwork = { F01: await art("VAC-F01.png"), B01: await art("VAC-B01.png"), F02: await art("VAC-F02.png") };
  const log = [];

  const out = await mockups.renderProductMockups({
    product,
    departmentCode: "VAC",
    artwork,
    blankPhotos: { Navy: { front, back }, "midnight navy": { front, back: null } },
    supplierLookup: null,
    onLog: (m) => log.push(m),
    verify: false,
    size: SIZE
  });

  assert.equal(out.length, 8);
  assert.deepEqual(
    out.map((m) => m.fileName),
    [
      "VAC_NL3600_NVY_Style1_FRONT.png",
      "VAC_NL3600_NVY_Style1_BACK.png",
      "VAC_NL3600_NVY_Style2_FRONT.png",
      "VAC_NL3600_NVY_Style2_BACK.png",
      "VAC_NL3600_MN_Style1_FRONT.png",
      "VAC_NL3600_MN_Style1_BACK.png",
      "VAC_NL3600_MN_Style2_FRONT.png",
      "VAC_NL3600_MN_Style2_BACK.png"
    ]
  );
  assert.ok(out.every((m) => m.path === "render"), out.map((m) => m.path).join(","));
  for (const m of out) {
    assert.deepEqual(await dims(m.buffer), { width: SIZE, height: SIZE, format: "png" });
    assert.equal(m.verified, null);
  }
  // 8 faces + 1 retry after the first size-bearing call failed.
  assert.equal(calls.render.length, 9);
  assert.equal(calls.render[0].size, `${SIZE}x${SIZE}`);
  assert.equal(calls.render[0].quality, "high");
  assert.equal(calls.render[0].throwOnFailure, true);
  assert.equal(calls.render[1].size, undefined);
  assert.ok(calls.render.slice(2).every((c) => c.size === `${SIZE}x${SIZE}`));
  assert.deepEqual(out[0].warnings, [mockups.UPSCALED_WARNING]);
  assert.deepEqual(out[1].warnings, []);
  // The renderer sees 1024 px bases, tuned for its placement wording.
  assert.equal((await dims(calls.render[0].baseBuffer)).width, 1024);
  assert.equal((await dims(await calls.render[1].getBackBlank())).width, 1024);
  // Decorations carry the plan's labels/tiers and the real artwork file names.
  const frontCall = calls.render[0];
  assert.equal(frontCall.face, "front");
  assert.equal(frontCall.method, "print");
  assert.equal(frontCall.productType, "T-shirt");
  assert.deepEqual(frontCall.decorations.map((d) => [d.logo.originalName, d.label, d.tier]), [["VAC-F01.png", "Front left chest", "Small"]]);
  const backCall = calls.render[2];
  assert.equal(backCall.face, "back");
  assert.deepEqual(backCall.decorations.map((d) => d.logo.originalName), ["VAC-B01.png"]);
  // Navy had both photos; Midnight Navy (matched case-insensitively) had no
  // back photo, so exactly one back blank was generated for it.
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.generate[0].face, "back");
  assert.equal(calls.generate[0].garmentColor, "Midnight Navy");
  assert.deepEqual(out.slice(0, 4).map((m) => m.base), ["photo", "photo", "photo", "photo"]);
  assert.deepEqual(out.slice(4).map((m) => m.base), ["photo", "generated", "photo", "generated"]);
  assert.equal(calls.supplier.length, 0);
  assert.ok(log.some((m) => /retrying at the model default/.test(m)));
});

test("renderProductMockups: missing artwork ships the blank and names the code", async () => {
  fakeRenderers();
  const product = tee({ colors: ["Navy"] });
  const front = await solid(100, 100, "#123456");
  const out = await mockups.renderProductMockups({
    product,
    departmentCode: "VAC",
    artwork: { f01: { buffer: await solid(20, 20, "#fff"), mimetype: "image/png", name: "VAC-F01.png" } },
    blankPhotos: { Navy: { front, back: front } },
    supplierLookup: null,
    verify: false,
    size: SIZE
  });
  assert.deepEqual(out.map((m) => [m.face, m.path]), [["front", "render"], ["back", "missing-artwork"]]);
  assert.match(out[1].warnings.join(" "), /B01 \(VAC-B01\)/);
  assert.deepEqual(await dims(out[1].buffer), { width: SIZE, height: SIZE, format: "png" });
});

test("renderProductMockups: hats render the front and ship the blank back as stock", async () => {
  const calls = fakeRenderers();
  const hat = rules.expandProduct(
    { brand: "Richardson", styleNumber: "R112", type: "Hat", colors: ["Navy"], sizes: ["OSFA"], decorationCodes: "E01", fulfillment: "One Week Item" },
    { departmentCode: "VAC" }
  ).product;
  const out = await mockups.renderProductMockups({
    product: hat,
    departmentCode: "VAC",
    artwork: { E01: { buffer: await solid(30, 30, "#ff0000"), mimetype: "image/png", name: "proof.png" } },
    blankPhotos: { Navy: { front: await solid(100, 100, "#222266"), back: null } },
    supplierLookup: null,
    verify: false,
    size: SIZE
  });
  assert.deepEqual(out.map((m) => [m.fileName, m.path, m.base]), [
    ["VAC_R112_NVY_FRONT.png", "render", "photo"],
    ["VAC_R112_NVY_BACK.png", "stock", "generated"]
  ]);
  assert.equal(calls.render.length, 1);
  assert.equal(calls.render[0].method, "embroidery");
  assert.equal(calls.render[0].decorations[0].label, "Front center");
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.generate[0].face, "back");
});

test("renderProductMockups: pants are stock only, back only when a photo was supplied", async () => {
  const calls = fakeRenderers();
  const pants = rules.expandProduct(
    { brand: "Flying Cross", styleNumber: "FP52MN", type: "Pants", colors: ["Midnight Navy", "Khaki"], sizes: ["30x32"], decorationCodes: "", fulfillment: "Non Stock Item" },
    { departmentCode: "RIP" }
  ).product;
  const photo = await solid(100, 200, "#333333");
  const out = await mockups.renderProductMockups({
    product: pants,
    departmentCode: "RIP",
    blankPhotos: { "Midnight Navy": { front: photo, back: photo }, Khaki: { front: photo } },
    supplierLookup: null,
    verify: true,
    size: SIZE
  });
  assert.deepEqual(out.map((m) => [m.fileName, m.path]), [
    ["RIP_FP52MN_MN_FRONT.png", "stock"],
    ["RIP_FP52MN_MN_BACK.png", "stock"],
    ["RIP_FP52MN_KHA_FRONT.png", "stock"]
  ]);
  assert.equal(calls.render.length, 0);
  assert.equal(calls.generate.length, 0);
  assert.equal(calls.reason.length, 0);
  assert.ok(out.every((m) => m.verified === null));
});

test("renderProductMockups: Class B shirts render like embroidery on the shoulders and carry the policy warning", async () => {
  const calls = fakeRenderers();
  const shirt = rules.expandProduct(
    { brand: "Flying Cross", styleNumber: "95R78", type: "Class B", classB: true, colors: ["Dark Navy"], sizes: ["L"], decorationCodes: "E01/E02", fulfillment: "Non Stock Item" },
    { departmentCode: "VAC" }
  ).product;
  const patch = async () => ({ buffer: await solid(30, 30, "#ff0000"), mimetype: "image/png", name: "patch.png" });
  const out = await mockups.renderProductMockups({
    product: shirt,
    departmentCode: "VAC",
    artwork: { E01: await patch(), E02: await patch() },
    blankPhotos: { "Dark Navy": { front: await solid(100, 100, "#101040"), back: await solid(100, 100, "#101040") } },
    supplierLookup: null,
    verify: false,
    size: SIZE
  });
  assert.equal(calls.render.length, 1);
  assert.equal(calls.render[0].method, "embroidery");
  assert.deepEqual(calls.render[0].decorations.map((d) => d.label), ["Left sleeve", "Right sleeve"]);
  assert.deepEqual(out.map((m) => m.path), ["render", "stock"]);
  assert.ok(out.every((m) => m.warnings.includes(mockups.CLASS_B_WARNING)));
});

test("renderProductMockups: supplier photo fills in when no blank photo exists; render failures ship the blank", async () => {
  const calls = fakeRenderers({ failAlways: true });
  const product = tee({ colors: ["Navy"] });
  const supplierCalls = [];
  const out = await mockups.renderProductMockups({
    product,
    departmentCode: "VAC",
    artwork: {
      F01: { buffer: await solid(20, 20, "#fff"), mimetype: "image/png", name: "VAC-F01.png" },
      B01: { buffer: await solid(20, 20, "#fff"), mimetype: "image/png", name: "VAC-B01.png" }
    },
    blankPhotos: {},
    supplierLookup: async (color) => {
      supplierCalls.push(color);
      return solid(150, 150, "#556677", { format: "jpeg" });
    },
    verify: true,
    size: SIZE
  });
  assert.deepEqual(supplierCalls, ["Navy"]);
  assert.deepEqual(out.map((m) => [m.face, m.path, m.base]), [["front", "render-failed", "supplier"], ["back", "render-failed", "generated"]]);
  // Two attempts per face (with size, then without), all failing.
  assert.equal(calls.render.length, 4);
  assert.ok(out.every((m) => m.warnings.some((w) => /Render failed twice/.test(w))));
  for (const m of out) assert.deepEqual(await dims(m.buffer), { width: SIZE, height: SIZE, format: "png" });
  // Nothing rendered, so nothing was sent to the vision check.
  assert.equal(calls.reason.length, 0);
  assert.ok(out.every((m) => m.verified === null));
});

test("renderProductMockups: no base at all is a warning, never a throw", async () => {
  const calls = fakeRenderers();
  const product = tee({ colors: ["Navy"] });
  const out = await mockups.renderProductMockups({
    product,
    departmentCode: "VAC",
    artwork: {},
    blankPhotos: {},
    supplierLookup: null,
    generateBlank: async () => {
      throw new Error("no image model");
    },
    verify: false,
    size: SIZE
  });
  assert.deepEqual(out.map((m) => [m.face, m.path, m.buffer, m.base]), [["front", "render-failed", null, null], ["back", "render-failed", null, null]]);
  assert.ok(out[0].warnings.some((w) => /no image model/.test(w)));
  assert.ok(out[0].warnings.some((w) => /No front blank/.test(w)));
  assert.equal(calls.render.length, 0);
});

test("renderProductMockups: the default supplier lookup goes through the injected findSupplierBlank", async () => {
  const calls = fakeRenderers();
  const product = tee({ colors: ["Navy"] });
  const out = await mockups.renderProductMockups({
    product,
    departmentCode: "VAC",
    artwork: {
      F01: { buffer: await solid(20, 20, "#fff"), mimetype: "image/png", name: "VAC-F01.png" },
      B01: { buffer: await solid(20, 20, "#fff"), mimetype: "image/png", name: "VAC-B01.png" }
    },
    blankPhotos: {},
    verify: true,
    size: SIZE
  });
  assert.equal(calls.supplier.length, 1);
  assert.equal(calls.supplier[0].brandStyle, "NL3600");
  assert.equal(calls.supplier[0].vendor, "Next Level");
  assert.equal(calls.supplier[0].garmentColor, "Navy");
  assert.deepEqual(out.map((m) => m.base), ["supplier", "generated"]);
  assert.deepEqual(out.map((m) => m.path), ["render", "render"]);
  // The invented garment says so. Both faces carry it: the warnings are
  // per-colour, and an operator looking at either image needs to know.
  const invented = out.filter((m) => m.warnings.some((w) => /AI-generated/.test(w)));
  assert.equal(invented.length, 2, "a generated blank must be announced, not silently substituted");
  assert.match(
    out[1].warnings.find((w) => /AI-generated/.test(w)),
    /Navy back: no blank photo was supplied.*AI-generated.*Upload a back photo/s
  );
  // A real supplier photo is never described as invented.
  assert.equal(
    out.every((m) => !/Navy front: .*AI-generated/.test(m.warnings.join(" "))),
    true
  );
  // verify on: both rendered faces were checked through the injected reason().
  assert.equal(calls.reason.length, 2);
  assert.deepEqual(out.map((m) => m.verified.ok), [true, true]);
  assert.equal(calls.reason[0].jsonObject, true);
  const content = calls.reason[0].messages[0].content;
  assert.equal(content.filter((part) => part.type === "image_url").length, 2); // mockup + one artwork
});

test("verifyMockup: JSON verdicts and an unavailable model", async () => {
  const image = await solid(50, 50, "#000");
  fakeRenderers({ reasonAnswer: 'Sure: {"artworkVisible": true, "placementMatches": false, "inventedText": false, "notes": "crest on the wrong side"}' });
  const wrong = await mockups.verifyMockup({ buffer: image, artwork: [], expectation: { face: "front", labels: ["Front left chest"] } });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.notes, "crest on the wrong side");

  fakeRenderers({ reasonAnswer: new Error("no reasoning model") });
  const off = await mockups.verifyMockup({ buffer: image, artwork: [] });
  assert.equal(off.ok, null);
  assert.match(off.notes, /verification unavailable: no reasoning model/);

  const none = await mockups.verifyMockup({ buffer: null });
  assert.equal(none.ok, null);
});

async function nonBackgroundBox(buffer, background) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const bg = background === "#ffffff" ? 255 : 0;
  let left = info.width;
  let right = -1;
  let top = info.height;
  let bottom = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (Math.abs(data[i] - bg) > 40 || Math.abs(data[i + 1] - bg) > 40 || Math.abs(data[i + 2] - bg) > 40) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return { left, right, top, bottom, width: right - left + 1, height: bottom - top + 1 };
}

test("renderBanner: 3584x2048, black behind a transparent PNG, centred", async () => {
  // A red mark with a transparent margin, off-centre inside its own file.
  const logo = await sharp({ create: { width: 400, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await solid(120, 60, "#ff0000"), left: 20, top: 200 }])
    .png()
    .toBuffer();
  const banner = await mockups.renderBanner({ logoBuffer: logo, logoMimetype: "image/png" });
  assert.equal(banner.background, "#000000");
  assert.deepEqual(await dims(banner.buffer), { width: 3584, height: 2048, format: "png" });
  const box = await nonBackgroundBox(banner.buffer, banner.background);
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  assert.ok(Math.abs(cx - 3584 / 2) <= 2, `centre x ${cx}`);
  assert.ok(Math.abs(cy - 2048 / 2) <= 2, `centre y ${cy}`);
  // Scaled up to the width limit (45%) since the mark is wide.
  assert.ok(box.width <= Math.round(3584 * 0.45) && box.width >= Math.round(3584 * 0.45) - 3, `width ${box.width}`);
  assert.ok(box.height <= Math.round(2048 * 0.62));
  assert.equal(banner.logo.width, Math.round(3584 * 0.45));
});

test("renderBanner: white behind a JPEG on white; tall logos hit the height limit", async () => {
  const jpeg = await sharp({ create: { width: 200, height: 400, channels: 3, background: "#ffffff" } })
    .composite([{ input: await solid(60, 300, "#003366"), left: 70, top: 50 }])
    .jpeg({ quality: 95 })
    .toBuffer();
  const banner = await mockups.renderBanner({ logoBuffer: jpeg, logoMimetype: "image/jpeg" });
  assert.equal(banner.background, "#ffffff");
  assert.deepEqual(await dims(banner.buffer), { width: 3584, height: 2048, format: "png" });
  const box = await nonBackgroundBox(banner.buffer, banner.background);
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  assert.ok(Math.abs(cx - 1792) <= 3, `centre x ${cx}`);
  assert.ok(Math.abs(cy - 1024) <= 3, `centre y ${cy}`);
  assert.ok(box.height <= Math.round(2048 * 0.62) && box.height >= Math.round(2048 * 0.62) - 6, `height ${box.height}`);

  // An SVG logo works and lands on black (transparent ground).
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="#ff8800"/></svg>');
  const fromSvg = await mockups.renderBanner({ logoBuffer: svg, logoMimetype: "image/svg+xml" });
  assert.equal(fromSvg.background, "#000000");

  await assert.rejects(() => mockups.renderBanner({ logoBuffer: Buffer.from("nope") }), /could not be read/);
});

test("bannerLogoChoice follows the spec order and returns the chosen file", async () => {
  const files = [
    { assetId: "a1", name: "policy.pdf", kind: "policy", role: "" },
    { assetId: "a2", name: "back.png", kind: "artwork", role: "back" },
    { assetId: "a3", name: "chest.png", kind: "artwork", role: "chest" },
    { assetId: "a4", name: "scramble.png", kind: "artwork", role: "scramble" }
  ];
  const chosen = await mockups.bannerLogoChoice(files);
  assert.equal(chosen.assetId, "a4");
  assert.equal(chosen.id, "a4");
  assert.equal(chosen.reason, "the scramble logo");
  const pick = await mockups.bannerLogoChoice([...files, { id: "a5", name: "pick.png", kind: "artwork", role: "pick" }]);
  assert.equal(pick.id, "a5");
  assert.equal(pick.reason, "the department's pick");
  assert.equal(await mockups.bannerLogoChoice([{ assetId: "x", kind: "artwork", role: "" }]), null);
  assert.equal(await mockups.bannerLogoChoice([]), null);
});

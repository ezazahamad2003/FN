const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../onboardingPolicy");
const rules = require("../onboardingRules");

// No blob storage, no keys: every model call below is a fake injected with
// setModel(); a real provider call would throw before it reached the network.
delete process.env.AZURE_STORAGE_CONNECTION_STRING;
delete process.env.OPENAI_API_KEY;
delete process.env.AZURE_OPENAI_ENDPOINT;

const POLICY_TEXT = `Vacaville Fire Department Uniform Policy.
Station wear: Next Level NL3600 short sleeve tee in Navy and Midnight Navy, sizes S-3XL.
The department seal goes on the left chest; the back carries the VFD scramble.
Hats: Richardson 112 trucker in navy.`;

const CANNED = {
  confirmed: [
    { topic: "Garments, brands and style numbers", detail: "Next Level NL3600 tee and Richardson 112 hat.", source: "policy: Station wear" },
    { topic: "Colors", detail: "Navy and Midnight Navy for the tee; navy for the hat.", source: "policy" },
    { topic: "Decoration location", detail: "Seal on the left chest, scramble on the back.", source: "policy" }
  ],
  missing: [
    { topic: "Decoration method (print or embroidery)", detail: "The policy never says print or embroidery.", question: "Should the logos be printed or embroidered?" },
    { topic: "Logo size", detail: "No logo sizes given.", question: "" }
  ],
  questions: ["Do you want names on the shirts?"],
  suggestedProducts: [
    { brand: "Next Level", styleNumber: "NL3600", type: "T-shirt", colors: ["Navy", "Midnight Navy", "Heather Grey"], sizes: ["S", "M", "L", "XL", "2XL", "3XL"], decorationMethod: "", classB: false, confidence: "high", evidence: "Station wear: Next Level NL3600" },
    { brand: "Richardson", styleNumber: "R112", type: "hat", colors: ["Navy"], sizes: ["OSFA"], decorationMethod: "Embroidery", confidence: "high", evidence: "Hats: Richardson 112" },
    { brand: "Port & Company", styleNumber: "PC61", type: "T-shirt", colors: ["Red"], sizes: [], decorationMethod: "screen print", confidence: "medium", evidence: "" }
  ],
  emailIntro: "Thanks for sending the policy and the artwork — the store is almost ready to build.",
  notes: "The policy is a clean PDF."
};

function fakeReason(output, calls) {
  return async (args) => {
    if (calls) calls.push(args);
    return typeof output === "function" ? output(args) : output;
  };
}

test.afterEach(() => policy.setModel(null));

test("REVIEW_TOPICS are the seven §4.2 checks, verbatim", () => {
  assert.deepEqual(policy.REVIEW_TOPICS, [
    "Garments, brands and style numbers",
    "Colors",
    "Decoration method (print or embroidery)",
    "Decoration location",
    "Logo size",
    "Which logo goes on which garment",
    "Class B shirts: button and patch rules"
  ]);
});

test("reviewPolicy: canned model output is completed and sanitised in code", async () => {
  const calls = [];
  policy.setModel({ reason: fakeReason(JSON.stringify(CANNED), calls) });
  const review = await policy.reviewPolicy({
    departmentName: "Vacaville Fire Department",
    repName: "Chief Rivera",
    policyText: POLICY_TEXT,
    artwork: [{ name: "seal.png", description: "Round seal with a Maltese cross", role: "chest" }],
    knownProducts: [],
    notes: ""
  });

  // The model was called the way the contract says, with the no-invention rule.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].jsonObject, true);
  assert.equal(calls[0].maxTokens, 2500);
  assert.equal(calls[0].messages[0].role, "system");
  assert.match(calls[0].messages[0].content, /Policies usually do not say how logos are decorated/);
  assert.match(calls[0].messages[0].content, /Never invent brands, style numbers, colours/);
  assert.match(calls[0].messages[1].content, /Chief Rivera/);
  assert.match(calls[0].messages[1].content, /seal\.png \(chest logo\): Round seal/);

  // Every topic appears in confirmed or missing; unmentioned ones default to missing.
  const covered = new Set([...review.confirmed, ...review.missing].map((x) => x.topic));
  for (const topic of policy.REVIEW_TOPICS) assert.ok(covered.has(topic), `topic covered: ${topic}`);
  assert.equal(review.confirmed.length, 3);
  const defaulted = review.missing.filter((m) => m.detail === "Not stated in the policy.").map((m) => m.topic);
  assert.deepEqual(defaulted, ["Which logo goes on which garment", "Class B shirts: button and patch rules"]);
  assert.deepEqual(
    review.missing.map((m) => m.topic),
    ["Decoration method (print or embroidery)", "Logo size", "Which logo goes on which garment", "Class B shirts: button and patch rules"]
  );

  // Questions: one per missing topic (model's wording, else the default), then extras.
  assert.equal(review.questions[0], "Should the logos be printed or embroidered?");
  assert.equal(review.questions[1], policy.DEFAULT_QUESTIONS["Logo size"]);
  assert.equal(review.questions[2], policy.DEFAULT_QUESTIONS["Which logo goes on which garment"]);
  assert.equal(review.questions[3], policy.DEFAULT_QUESTIONS["Class B shirts: button and patch rules"]);
  assert.equal(review.questions[4], "Do you want names on the shirts?");
  assert.equal(review.questions.length, 5);

  // Email: subject, greeting, intro, numbered questions covering every missing topic, signature.
  assert.equal(review.emailDraft.subject, "Uniform store details we still need — Vacaville Fire Department");
  const body = review.emailDraft.body;
  assert.ok(body.startsWith("Hi Chief Rivera,\n\n"), "greets the rep by name");
  assert.match(body, /Thanks for sending the policy and the artwork/);
  review.questions.forEach((q, i) => assert.ok(body.includes(`\n${i + 1}. ${q}\n`), `question ${i + 1} numbered in the email`));
  assert.ok(body.endsWith("\n\nThanks,\nDan\nFN Simple Uniforms"), "signs off as Dan / FN Simple Uniforms");
  assert.doesNotMatch(body, /\[NAME\]|\[Contact/);

  // Suggested products: no invented style numbers / brands / colours; fixed fields.
  const [tee, hat, invented] = review.suggestedProducts;
  assert.equal(tee.styleNumber, "NL3600");
  assert.equal(tee.brand, "Next Level");
  assert.deepEqual(tee.colors, ["Navy", "Midnight Navy"], "Heather Grey is not in the policy and is dropped");
  assert.equal(tee.decorationCodes, "");
  assert.equal(tee.fulfillment, "");
  assert.equal(tee.source, "policy");
  assert.equal(tee.confidence, "high");
  assert.equal(tee.classB, false);
  assert.equal(hat.styleNumber, "", "R112 is never written in the policy (it says 112), so it is cleared");
  assert.equal(hat.brand, "Richardson");
  assert.equal(hat.decorationMethod, "embroidery");
  assert.equal(hat.confidence, "high", "brand + type still identify the row");
  assert.equal(invented.styleNumber, "");
  assert.equal(invented.brand, "");
  assert.deepEqual(invented.colors, []);
  assert.equal(invented.confidence, "low");
  assert.equal(invented.decorationMethod, "print");
  assert.match(review.notes, /The policy is a clean PDF/);
  assert.match(review.notes, /Style number "PC61".*cleared/);
});

test("reviewPolicy: garbage or a thrown model falls back to a code-built review", async () => {
  policy.setModel({ reason: fakeReason("Sure! Here is my analysis of the policy...") });
  const garbage = await policy.reviewPolicy({ departmentName: "Bahama Fire Department", repName: "", policyText: "Some policy text." });
  assert.deepEqual(garbage.confirmed, []);
  assert.deepEqual(
    garbage.missing,
    policy.REVIEW_TOPICS.map((topic) => ({ topic, detail: "Not stated in the policy." }))
  );
  assert.equal(garbage.questions.length, 7);
  assert.deepEqual(garbage.suggestedProducts, []);
  assert.match(garbage.notes, /nothing usable/);
  assert.ok(garbage.emailDraft.body.startsWith("Hello,\n\n"), "no rep name → plain greeting");
  assert.ok(garbage.emailDraft.body.includes("\n7. "));
  assert.ok(garbage.emailDraft.body.endsWith("Thanks,\nDan\nFN Simple Uniforms"));
  assert.equal(garbage.emailDraft.subject, "Uniform store details we still need — Bahama Fire Department");

  policy.setModel({
    reason: async () => {
      throw new Error("No reasoning model is configured.");
    }
  });
  const thrown = await policy.reviewPolicy({ departmentName: "Bahama Fire Department", policyText: "Some policy text." });
  assert.equal(thrown.missing.length, 7);
  assert.match(thrown.notes, /unavailable \(No reasoning model is configured\.\)/);
});

test("reviewPolicy: nothing to read skips the model entirely", async () => {
  let called = false;
  policy.setModel({
    reason: async () => {
      called = true;
      return "{}";
    }
  });
  const review = await policy.reviewPolicy({ departmentName: "Granville Township Fire Department", policyText: "", artwork: [{ name: "a.png", description: "" }] });
  assert.equal(called, false);
  assert.equal(review.missing.length, 7);
  assert.match(review.notes, /No readable policy text/);
});

test("reviewPolicy: partial topics and code-fenced JSON are handled; nothing missing → confirmation email", async () => {
  const output = {
    confirmed: policy.REVIEW_TOPICS.map((topic) => ({ topic: topic.toUpperCase(), detail: `Stated: ${topic}`, source: "policy" })),
    missing: [],
    questions: [],
    suggestedProducts: [],
    emailIntro: "Hi there, thanks!",
    notes: ""
  };
  policy.setModel({ reason: fakeReason("```json\n" + JSON.stringify(output) + "\n```") });
  const review = await policy.reviewPolicy({ departmentName: "Ripon Fire Department", repName: "Captain Lee", policyText: "complete policy" });
  assert.equal(review.missing.length, 0);
  assert.equal(review.confirmed.length, 7);
  assert.deepEqual(review.confirmed.map((c) => c.topic), policy.REVIEW_TOPICS);
  assert.deepEqual(review.questions, []);
  assert.doesNotMatch(review.emailDraft.body, /Hi there/, "a greeting-shaped intro is discarded");
  assert.match(review.emailDraft.body, /covers everything we need/);
  assert.match(review.emailDraft.body, /- Colors: Stated: Colors/);
  assert.ok(review.emailDraft.body.startsWith("Hi Captain Lee,"));
  assert.ok(review.emailDraft.body.endsWith("Thanks,\nDan\nFN Simple Uniforms"));
});

test("canonicalTopic maps loose model wording onto the seven topics", () => {
  assert.equal(policy.canonicalTopic("colours"), "Colors");
  assert.equal(policy.canonicalTopic("Logo placement"), "Decoration location");
  assert.equal(policy.canonicalTopic("Print vs embroidery"), "Decoration method (print or embroidery)");
  assert.equal(policy.canonicalTopic("Size of the logo"), "Logo size");
  assert.equal(policy.canonicalTopic("Logo assignment per garment"), "Which logo goes on which garment");
  assert.equal(policy.canonicalTopic("Class B buttons"), "Class B shirts: button and patch rules");
  assert.equal(policy.canonicalTopic("Garment brands"), "Garments, brands and style numbers");
  assert.equal(policy.canonicalTopic("Name personalization"), null);
});

test("parseJsonObject tolerates fences and prose around the object", () => {
  assert.deepEqual(policy.parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(policy.parseJsonObject('Here you go: {"a":{"b":[1,2]}} done.'), { a: { b: [1, 2] } });
  assert.equal(policy.parseJsonObject("[1,2]"), null);
  assert.equal(policy.parseJsonObject(""), null);
  assert.equal(policy.parseJsonObject("not json"), null);
});

test("emailDraftHtml escapes the subject and body and keeps paragraphs", () => {
  const html = policy.emailDraftHtml({
    subject: "Uniform store details we still need — Smith & Sons <FD>",
    body: "Hi Chief,\n\nTwo things:\n1. A <b>bold</b> question?\n2. Another & more?\n\nThanks,\nDan\nFN Simple Uniforms"
  });
  assert.match(html, /<h1>Uniform store details we still need — Smith &amp; Sons &lt;FD&gt;<\/h1>/);
  assert.match(html, /<p>Hi Chief,<\/p>/);
  assert.match(html, /<p>Two things:<br>1\. A &lt;b&gt;bold&lt;\/b&gt; question\?<br>2\. Another &amp; more\?<\/p>/);
  assert.match(html, /<p>Thanks,<br>Dan<br>FN Simple Uniforms<\/p>/);
  assert.doesNotMatch(html, /<b>bold<\/b>/);
  assert.match(html, /<title>Uniform store details we still need — Smith &amp; Sons &lt;FD&gt;<\/title>/);
});

test("reviewDocHtml renders the four sections with escaped content", () => {
  const review = {
    confirmed: [{ topic: "Colors", detail: "Navy <only>", source: "policy p.2" }],
    missing: [{ topic: "Logo size", detail: "Not stated in the policy." }],
    questions: ["How big & where?"],
    suggestedProducts: [{ brand: "Next Level", styleNumber: "NL3600", type: "T-shirt", colors: ["Navy"], sizes: ["S"], decorationMethod: "", classB: false, confidence: "high", evidence: "x" }],
    emailDraft: { subject: "Uniform store details we still need — Vacaville Fire Department", body: "Hello,\n\n1. How big & where?\n\nThanks,\nDan\nFN Simple Uniforms" },
    notes: ""
  };
  const html = policy.reviewDocHtml({ departmentName: "Vacaville Fire Department", review, artwork: [{ name: "seal.png", role: "chest", description: "A <seal>" }] });
  assert.match(html, /<title>Policy review — Vacaville Fire Department<\/title>/);
  assert.match(html, /<h1>Policy review — Vacaville Fire Department<\/h1>/);
  for (const heading of ["Confirmed", "Missing", "Questions", "Email draft"]) assert.match(html, new RegExp(`<h2>${heading}</h2>`));
  assert.match(html, /Navy &lt;only&gt;/);
  assert.match(html, /<li>How big &amp; where\?<\/li>/);
  assert.match(html, /<td>NL3600<\/td>/);
  assert.match(html, /A &lt;seal&gt;/);
  assert.match(html, /<h3>Uniform store details we still need — Vacaville Fire Department<\/h3>/);
  assert.doesNotMatch(html, /<seal>/);
});

test("describeArtwork and extractPacketText: images vs documents, failures give \"\"", async () => {
  const seen = [];
  policy.setModel({
    analyzeLogo: async (file) => {
      seen.push(["logo", file.originalname, file.mimetype]);
      return "  A red Maltese cross.  ";
    },
    extractReadableText: async (file) => {
      seen.push(["text", file.originalname, file.mimetype]);
      return " Policy text. ";
    }
  });
  const png = { buffer: Buffer.from("png"), mimetype: "image/png", originalName: "seal.png" };
  const pdf = { buffer: Buffer.from("pdf"), mimetype: "application/pdf", originalName: "policy.pdf" };
  assert.equal(await policy.describeArtwork(png), "A red Maltese cross.");
  assert.equal(await policy.describeArtwork(pdf), "", "a PDF is never sent to vision");
  assert.equal(await policy.extractPacketText(pdf), "Policy text.");
  assert.equal(await policy.extractPacketText(png), "", "an image has no text to extract");
  assert.deepEqual(seen, [
    ["logo", "seal.png", "image/png"],
    ["text", "policy.pdf", "application/pdf"]
  ]);

  const logs = [];
  policy.setModel({
    analyzeLogo: async () => {
      throw new Error("vision down");
    },
    extractReadableText: async () => {
      throw new Error("parser down");
    }
  });
  assert.equal(await policy.describeArtwork(png, { onLog: (m) => logs.push(m) }), "");
  assert.equal(await policy.extractPacketText(pdf, { onLog: (m) => logs.push(m) }), "");
  assert.equal(logs.length, 2);
  assert.match(logs[0], /vision down/);
  assert.equal(await policy.describeArtwork(null), "");
  assert.equal(await policy.extractPacketText(undefined), "");
});

const SOURCE_HTML = `<p>Logo size &amp; placement are an approximation</p>
<p>Next Level (NL3600)</p>
<ul><li>4.3 oz, 100% combed ring-spun cotton</li><li>Tear-away label</li></ul>
<table border="1"><tbody><tr><td>Chest</td><td>18</td></tr></tbody></table>`;

test("descriptionDataFor prefers the source product, then supplier facts, else flags for Dan", async () => {
  const calls = [];
  policy.setModel({
    findSupplierBlank: async (product, options) => {
      calls.push(product);
      if (options?.onLog) options.onLog("searching");
      return {
        facts: {
          fabric: ["5.3 oz, 100% cotton", "Side seamed"],
          sizeChart: { headers: ["S", "M"], rows: [{ label: "Body Length", values: ["28", "29"] }] },
          fit: "Regular fit."
        },
        sourceUrl: "https://example.com/nl3600",
        note: "Blank garment is the supplier's own photo of NL3600."
      };
    }
  });

  const fromSource = await policy.descriptionDataFor({ brand: "Next Level", styleNumber: "NL3600", type: "T-shirt", colors: ["Navy"], sourceDescriptionHtml: SOURCE_HTML, vendor: "One Week Item" });
  assert.equal(fromSource.source, "source-product");
  assert.deepEqual(fromSource.bullets, ["4.3 oz, 100% combed ring-spun cotton", "Tear-away label"]);
  assert.match(fromSource.measurementsHtml, /^<table/);
  assert.equal(fromSource.brandLine, "Next Level (NL3600)");
  assert.equal(fromSource.note, "");
  assert.equal(calls.length, 0, "no supplier search when the source product has bullets");

  const logs = [];
  const fromSupplier = await policy.descriptionDataFor(
    { brand: "Next Level", styleNumber: "NL3600", type: "T-shirt", colors: ["Navy", "Black"], sourceDescriptionHtml: "<p>No bullets here</p>" },
    { onLog: (m) => logs.push(m) }
  );
  assert.equal(fromSupplier.source, "supplier");
  assert.deepEqual(calls[0], { vendor: "Next Level", brandStyle: "NL3600", garmentColor: "Navy", productType: "T-shirt" });
  assert.deepEqual(fromSupplier.bullets, ["5.3 oz, 100% cotton", "Side seamed", "Regular fit."]);
  assert.deepEqual(fromSupplier.measurements, { title: "Product Measurements", sizes: ["S", "M"], rows: [{ label: "Body Length", values: ["28", "29"] }] });
  assert.equal(fromSupplier.measurementsHtml, "");
  assert.equal(fromSupplier.sourceUrl, "https://example.com/nl3600");
  assert.match(fromSupplier.note, /Manufacturer data from https:\/\/example\.com\/nl3600/);
  assert.deepEqual(logs, ["searching"]);

  policy.setModel({ findSupplierBlank: async () => ({ facts: null, sourceUrl: null, note: "No supplier photo found online for XYZ." }) });
  const none = await policy.descriptionDataFor({ brand: "Acme", styleNumber: "XYZ", type: "hat", colors: [] });
  assert.equal(none.source, "none");
  assert.deepEqual(none.bullets, []);
  assert.equal(none.measurements, null);
  assert.equal(none.note, "Manufacturer data not available — flag for Dan");
  assert.equal(none.brandLine, "Acme (XYZ)");

  policy.setModel({
    findSupplierBlank: async () => {
      throw new Error("network");
    }
  });
  const failed = await policy.descriptionDataFor({ brand: "Acme", styleNumber: "XYZ" });
  assert.equal(failed.source, "none");
  assert.equal(failed.note, policy.NO_MANUFACTURER_DATA);

  let searched = false;
  policy.setModel({
    findSupplierBlank: async () => {
      searched = true;
      return {};
    }
  });
  const blank = await policy.descriptionDataFor({ brand: "", styleNumber: "", type: "pants" });
  assert.equal(searched, false, "nothing to search for without a brand or style number");
  assert.equal(blank.source, "none");
});

test("buildDescription follows §11 through the rules module", () => {
  const html = policy.buildDescription({
    brand: "Next Level",
    styleNumber: "NL3600",
    descriptionData: {
      bullets: ["4.3 oz, 100% combed ring-spun cotton"],
      measurements: { sizes: ["S", "M"], rows: [{ label: "Body Length", values: ["28", "29"] }] },
      measurementsHtml: ""
    },
    hasMockup: true,
    vendor: "non-stock item"
  });
  assert.ok(html.startsWith(rules.LOGO_DISCLAIMER_HTML));
  assert.match(html, /<p>Next Level \(NL3600\)<\/p>/);
  assert.match(html, /<li>4\.3 oz, 100% combed ring-spun cotton<\/li>/);
  assert.match(html, /<td>Body Length<\/td><td>28<\/td><td>29<\/td>/);
  assert.ok(html.endsWith(rules.NON_STOCK_NOTICE_HTML), "vendor normalised to Non Stock Item adds the notice");

  const stock = policy.buildDescription({ brand: "Flying Cross", styleNumber: "FP52", descriptionData: { bullets: [], measurementsHtml: "" }, hasMockup: false, vendor: "One Week Item" });
  assert.doesNotMatch(stock, /approximation/);
  assert.doesNotMatch(stock, /Non-Stock Item Notice/);
  assert.equal(stock, "<p>Flying Cross (FP52)</p>");

  const passthrough = policy.buildDescription({ brand: "A", styleNumber: "B", descriptionData: { measurementsHtml: "<table><tr><td>x</td></tr></table>" }, hasMockup: true, vendor: "" });
  assert.match(passthrough, /<table><tr><td>x<\/td><\/tr><\/table>/);
  assert.doesNotMatch(passthrough, /Non-Stock/);
});

test("setModel merges overrides, returns the previous set, and null restores defaults", async () => {
  const first = policy.setModel({ reason: async () => "{}" });
  assert.deepEqual(first, {});
  const second = policy.setModel({ analyzeLogo: async () => "x" });
  assert.equal(typeof second.reason, "function");
  assert.equal(await policy.describeArtwork({ buffer: Buffer.from("a"), mimetype: "image/png" }), "x");
  policy.setModel(null);
  // Back on defaults: with no provider configured the real reason() throws and
  // reviewPolicy degrades to the code-built review instead of crashing.
  const review = await policy.reviewPolicy({ departmentName: "X", policyText: "text" });
  assert.equal(review.missing.length, 7);
  assert.match(review.notes, /unavailable/);
});

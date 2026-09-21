/*
 * Department Onboarding Agent — the model-facing steps.
 *
 *   §1  packet reading: artwork description (vision), policy text extraction
 *   §4  policy review: what is confirmed, what is missing, questions for the
 *       rep, an email draft from Dan (never sent from here)
 *   §11 product description data: manufacturer bullets and measurements,
 *       preferring the product we duplicated from, then the supplier page,
 *       and flagging for Dan when neither has them
 *
 * The model reads messy policies and drafts wording. Everything with a rule
 * behind it is decided in code afterwards: the seven review topics always
 * appear, style numbers the sources never mention are cleared rather than
 * kept, the email has a fixed shape and signature, and the description HTML
 * comes from onboardingRules.buildProductDescriptionHtml.
 *
 * Every model / network call goes through `model` so tests can inject fakes
 * with setModel(); nothing here throws on a model failure — a failed review
 * becomes a code-built one where every topic is missing.
 */

const rules = require("./onboardingRules");

/* ---------------------------------------------------------------------------
   Injectable model surface
   ------------------------------------------------------------------------- */

// Defaults are required lazily so loading this module (and its tests) never
// pulls in the OpenAI SDK, pdf-parse or sharp until a real call is made.
const defaults = {
  reason: (...args) => require("./azureOpenai").reason(...args),
  analyzeLogo: (...args) => require("./ai").analyzeLogo(...args),
  extractReadableText: (...args) => require("./ai").extractReadableText(...args),
  findSupplierBlank: (...args) => require("./blanks").findSupplierBlank(...args)
};

let overrides = {};

/*
 * setModel({ reason, analyzeLogo, extractReadableText, findSupplierBlank })
 * replaces any subset of the model calls; setModel(null) restores the
 * defaults. Returns the previous overrides so a test can put them back.
 */
function setModel(next) {
  const previous = overrides;
  if (!next) {
    overrides = {};
    return previous;
  }
  const merged = { ...overrides };
  for (const key of Object.keys(defaults)) {
    if (typeof next[key] === "function") merged[key] = next[key];
  }
  overrides = merged;
  return previous;
}

function model() {
  return { ...defaults, ...overrides };
}

/* ---------------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------------- */

function cleanText(value, max = 2000) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function logger(onLog) {
  return (message) => {
    if (typeof onLog === "function") onLog(message);
  };
}

// multer gives `originalname`; the onboarding record stores `originalName`.
// ai.js reads the multer spelling, so both are accepted here.
function fileForAi(file) {
  return {
    buffer: file.buffer,
    mimetype: String(file.mimetype || ""),
    originalname: String(file.originalname || file.originalName || file.name || "")
  };
}

function isImageFile(file) {
  return /^image\//i.test(String(file?.mimetype || ""));
}

/*
 * Tolerant JSON reader for model output: strips code fences and, failing a
 * clean parse, takes the outermost {...} block. Returns null when there is no
 * object to be had — the caller decides what "no answer" means.
 */
function parseJsonObject(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return null;
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const attempts = [unfenced];
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start !== -1 && end > start) attempts.push(unfenced.slice(start, end + 1));
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (error) {
      // try the next candidate
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
   §1 packet reading
   ------------------------------------------------------------------------- */

/*
 * Vision description of one artwork file. Non-images and failures give "" —
 * a missing description only means the review has less to go on.
 */
async function describeArtwork(file, { onLog } = {}) {
  const log = logger(onLog);
  if (!file || !file.buffer || !isImageFile(file)) return "";
  try {
    return cleanText(await model().analyzeLogo(fileForAi(file)), 4000);
  } catch (error) {
    log(`artwork description failed for ${fileForAi(file).originalname || "file"}: ${error.message}`);
    return "";
  }
}

/*
 * Readable text of a policy / contacts / other packet file (pdf, docx, txt).
 * Images have no text to extract and are never sent to the parser.
 */
async function extractPacketText(file, { onLog } = {}) {
  const log = logger(onLog);
  if (!file || !file.buffer || isImageFile(file)) return "";
  try {
    return String((await model().extractReadableText(fileForAi(file))) || "").trim();
  } catch (error) {
    log(`text extraction failed for ${fileForAi(file).originalname || "file"}: ${error.message}`);
    return "";
  }
}

/* ---------------------------------------------------------------------------
   §4 policy review
   ------------------------------------------------------------------------- */

// §4.2, verbatim: what the review must check for.
const REVIEW_TOPICS = [
  "Garments, brands and style numbers",
  "Colors",
  "Decoration method (print or embroidery)",
  "Decoration location",
  "Logo size",
  "Which logo goes on which garment",
  "Class B shirts: button and patch rules"
];

const NOT_STATED = "Not stated in the policy.";

// The question Dan's email asks when the model gave none for a missing topic.
const DEFAULT_QUESTIONS = {
  "Garments, brands and style numbers":
    "Which garments would you like in the store, and is there a brand and style number you want for each one (for example Next Level NL3600)?",
  Colors: "Which color or colors should each garment come in?",
  "Decoration method (print or embroidery)":
    "For each garment, should the logo be printed or embroidered? (Each item is one or the other, never both.)",
  "Decoration location": "Where should each logo go on each garment (for example left chest, full back, or sleeve)?",
  "Logo size": "How big should each logo be? An approximate width in inches for each placement is perfect.",
  "Which logo goes on which garment": "Which logo goes on which garment?",
  "Class B shirts: button and patch rules":
    "Will the store include Class B uniform shirts? If so, which button color should they have, and which patch goes on which shoulder?"
};

const SYSTEM_PROMPT = `You are the FN Simple Uniforms Department Onboarding Agent reviewing a fire department's uniform policy before its private online store is built.

Your only sources are the policy text, the artwork descriptions, the known product rows and the operator's notes in the user message. Report ONLY what those sources state.

Rules (no invention):
- Never invent brands, style numbers, colours, sizes, placements, logo sizes or decoration methods. If a detail is not stated in the sources, it is missing.
- Policies usually do not say how logos are decorated (print or embroidery). Unless the policy says so explicitly, the decoration method is missing.
- Quote or point to the wording you relied on for anything you confirm.
- A style number must be copied exactly as written in the sources. If the sources give none, leave styleNumber "".
- Never fill in typical values, industry defaults, or what similar departments use.

Check exactly these seven topics and use these exact topic strings:
${REVIEW_TOPICS.map((topic, index) => `${index + 1}. "${topic}"`).join("\n")}

Return JSON only, in this shape:
{
  "confirmed": [{ "topic": "<one of the seven>", "detail": "what the policy states, in plain language", "source": "short quote, or where it came from (policy, artwork: <file>, notes)" }],
  "missing": [{ "topic": "<one of the seven>", "detail": "what is not stated, and for which garments", "question": "one plain-language question for the department rep" }],
  "questions": ["any further plain-language question the rep must answer that does not fit the seven topics"],
  "suggestedProducts": [{ "brand": "", "styleNumber": "", "type": "T-shirt | hat | hoodie | Class B | pants | ...", "colors": [], "sizes": [], "decorationMethod": "print | embroidery | ", "classB": false, "confidence": "high | medium | low", "evidence": "the wording this row comes from" }],
  "emailIntro": "one or two friendly sentences from Dan to the department rep introducing the questions — no greeting, no sign-off, no list",
  "notes": "anything Dan should know about how readable or complete the policy was"
}

A topic may be partly confirmed and partly missing; list it under both with the specifics. Every one of the seven topics must appear at least once. Use plain language a department rep will understand — no jargon.`;

function summariseKnownProducts(rows) {
  return asArray(rows)
    .map((row) => {
      const parts = [
        [row.brand, row.styleNumber].filter(Boolean).join(" "),
        row.type,
        asArray(row.colors).length ? `colors: ${asArray(row.colors).join(", ")}` : "",
        asArray(row.sizes).length ? `sizes: ${asArray(row.sizes).join(", ")}` : "",
        row.decorationMethod ? `decoration: ${row.decorationMethod}` : "",
        row.classB ? "Class B" : ""
      ].filter(Boolean);
      return parts.length ? `- ${parts.join("; ")}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function summariseArtwork(artwork) {
  return asArray(artwork)
    .map((item) => {
      const name = cleanText(item.name, 200) || "artwork";
      const role = cleanText(item.role, 40);
      const description = cleanText(item.description, 1500) || "no description available";
      return `- ${name}${role ? ` (${role} logo)` : ""}: ${description}`;
    })
    .join("\n");
}

const POLICY_TEXT_LIMIT = 24000;

function buildReviewMessages({ departmentName, repName, policyText, artwork, knownProducts, notes }) {
  const department = cleanText(departmentName, 200) || "the department";
  const known = summariseKnownProducts(knownProducts);
  const art = summariseArtwork(artwork);
  const text = String(policyText || "").trim().slice(0, POLICY_TEXT_LIMIT);
  const user = [
    `Department: ${department}`,
    `Department rep: ${cleanText(repName, 200) || "not known"}`,
    "",
    `Operator notes from Dan:\n${cleanText(notes, 6000) || "none"}`,
    "",
    `Artwork files:\n${art || "- none"}`,
    "",
    `Known product rows (already entered by Dan — do not repeat them as suggestions):\n${known || "- none"}`,
    "",
    `Uniform policy text:\n${text || "No policy text could be read."}`
  ].join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user }
  ];
}

/*
 * Map whatever topic string the model used onto one of the seven. Returns
 * null for anything else (kept as an extra rather than dropped).
 */
function canonicalTopic(input) {
  const raw = cleanText(input, 200);
  if (!raw) return null;
  const exact = REVIEW_TOPICS.find((topic) => topic.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  const t = raw.toLowerCase();
  if (/class\s*b|button|patch/.test(t)) return REVIEW_TOPICS[6];
  if (/which logo|logo goes|logo assignment|logo .*garment|assign/.test(t)) return REVIEW_TOPICS[5];
  if (/logo size|size of (the )?logo|logo dimension|logo width|logo height/.test(t)) return REVIEW_TOPICS[4];
  if (/location|placement|position|where/.test(t)) return REVIEW_TOPICS[3];
  if (/method|print|embroider/.test(t)) return REVIEW_TOPICS[2];
  if (/colou?r/.test(t)) return REVIEW_TOPICS[1];
  if (/garment|brand|style/.test(t)) return REVIEW_TOPICS[0];
  return null;
}

function topicOrder(topic) {
  const index = REVIEW_TOPICS.indexOf(topic);
  return index === -1 ? REVIEW_TOPICS.length : index;
}

function cleanQuestion(value) {
  let q = cleanText(value, 600).replace(/^\d+[.)]\s*/, "").replace(/^[-•*]\s*/, "");
  if (!q) return "";
  if (!/[.?!]$/.test(q)) q += "?";
  return q;
}

// The model's intro is one or two sentences; a greeting, list or sign-off in
// it would double up with the fixed parts of the email, so those are dropped.
function cleanIntro(value) {
  const intro = cleanText(value, 600);
  if (!intro) return "";
  if (/^(hi|hello|dear|hey)\b/i.test(intro)) return "";
  if (/\b(thanks|regards|sincerely|best)\s*,?\s*$/i.test(intro)) return "";
  if (/\b1\.\s/.test(intro)) return "";
  return intro;
}

/*
 * Words of a source haystack for the "did the sources actually say this"
 * checks below. Compact form (letters+digits only) catches style numbers
 * written with spaces or dashes ("NL 3600", "NL-3600").
 */
function sourceIndex({ policyText, notes, artwork, knownProducts }) {
  const pieces = [
    String(policyText || ""),
    String(notes || ""),
    ...asArray(artwork).map((a) => `${a?.name || ""} ${a?.description || ""}`),
    ...asArray(knownProducts).map((r) => `${r?.brand || ""} ${r?.styleNumber || ""} ${asArray(r?.colors).join(" ")}`)
  ];
  const text = pieces.join(" ").toUpperCase();
  return {
    compact: text.replace(/[^A-Z0-9]/g, ""),
    words: new Set(text.replace(/[^A-Z0-9]+/g, " ").split(" ").filter(Boolean))
  };
}

function compactToken(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Every meaningful word of the phrase appears somewhere in the sources
// ("Port & Company" passes on PORT + COMPANY; "Heather Grey" needs both).
function phraseInSources(phrase, index) {
  const words = String(phrase || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 2 && w !== "AND");
  if (!words.length) return false;
  return words.every((w) => index.words.has(w));
}

function normaliseDecorationMethod(value) {
  const v = cleanText(value, 40).toLowerCase();
  if (/embroider/.test(v)) return rules.DECORATION_EMBROIDERY;
  if (/print|screen|heat|transfer|dtg/.test(v)) return rules.DECORATION_PRINT;
  return "";
}

/*
 * Product rows the model read out of the policy. They are suggestions only —
 * Dan confirms them in the build inputs — but the parts the store would be
 * built from must trace back to the sources. A style number, brand or colour
 * the sources never mention is cleared here, with a note, instead of kept.
 */
function sanitiseSuggestedProducts(items, index, clearedNotes) {
  const out = [];
  for (const item of asArray(items)) {
    if (!item || typeof item !== "object") continue;
    let brand = cleanText(item.brand, 80);
    let styleNumber = cleanText(item.styleNumber, 40);
    const type = cleanText(item.type, 60);
    const colors = asArray(item.colors).map((c) => cleanText(c, 60)).filter(Boolean);
    const sizes = asArray(item.sizes).map((s) => cleanText(s, 20)).filter(Boolean);
    if (!brand && !styleNumber && !type && !colors.length) continue;

    const label = [brand, styleNumber, type].filter(Boolean).join(" ") || "a suggested product";
    if (styleNumber && !index.compact.includes(compactToken(styleNumber))) {
      clearedNotes.push(`Style number "${styleNumber}" (${label}) is not in the policy, notes or artwork — cleared so nothing invented reaches the build.`);
      styleNumber = "";
    }
    if (brand && !phraseInSources(brand, index)) {
      clearedNotes.push(`Brand "${brand}" (${label}) is not in the policy, notes or artwork — cleared.`);
      brand = "";
    }
    const keptColors = colors.filter((c) => phraseInSources(c, index));
    for (const c of colors) {
      if (!keptColors.includes(c)) clearedNotes.push(`Color "${c}" (${label}) is not in the policy, notes or artwork — dropped.`);
    }
    const confidence = ["high", "medium", "low"].includes(String(item.confidence || "").toLowerCase())
      ? String(item.confidence).toLowerCase()
      : "low";
    out.push({
      brand,
      styleNumber,
      type,
      colors: keptColors,
      sizes,
      decorationMethod: normaliseDecorationMethod(item.decorationMethod),
      decorationCodes: "",
      fulfillment: "",
      classB: item.classB === true || /class\s*b/i.test(type),
      source: "policy",
      confidence: styleNumber || (brand && type) ? confidence : "low",
      evidence: cleanText(item.evidence, 600)
    });
  }
  return out;
}

/*
 * The email Dan reviews and sends. Fixed shape: greeting, intro, numbered
 * questions (one per missing topic at least), closing, signature.
 */
function buildEmailDraft({ departmentName, repName, questions, intro, confirmed }) {
  const department = cleanText(departmentName, 200) || "your department";
  const rep = cleanText(repName, 120);
  const subject = `Uniform store details we still need — ${department}`;
  const lines = [rep ? `Hi ${rep},` : "Hello,", ""];
  if (questions.length) {
    lines.push(
      intro ||
        `Thanks for sending over the ${department} uniform policy and artwork. We are setting up your online uniform store, and there are a few details the policy does not cover. Could you help us with the following?`
    );
    lines.push("");
    questions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
    lines.push("");
    lines.push("Once we have these answers we can finish the store and send you a link to review.");
  } else {
    // The model's intro was written to lead into questions; with none to ask
    // it would promise a list that never comes, so the code wording is used.
    lines.push(`Thanks for sending over the ${department} uniform policy and artwork. It covers everything we need to set up your online uniform store.`);
    if (confirmed.length) {
      lines.push("");
      lines.push("Here is what we will build from — please let us know if anything is off:");
      for (const c of confirmed) lines.push(`- ${c.topic}: ${c.detail}`);
    }
    lines.push("");
    lines.push("We will send you a link to review the store as soon as it is ready.");
  }
  lines.push("", "Thanks,", "Dan", "FN Simple Uniforms");
  return { subject, body: lines.join("\n") };
}

/*
 * Turn whatever the model returned (or nothing at all) into the review the
 * record stores. The invariants live here, not in the prompt.
 */
function finalizeReview(raw, ctx) {
  const parsed = raw && typeof raw === "object" ? raw : {};
  const notes = [];
  const index = sourceIndex(ctx);

  const confirmed = [];
  for (const item of asArray(parsed.confirmed)) {
    if (!item || typeof item !== "object") continue;
    const topic = canonicalTopic(item.topic) || cleanText(item.topic, 120);
    const detail = cleanText(item.detail, 1500);
    if (!topic || !detail) continue;
    confirmed.push({ topic, detail, source: cleanText(item.source, 400) || "policy" });
  }

  const missing = [];
  for (const item of asArray(parsed.missing)) {
    if (!item || typeof item !== "object") continue;
    const topic = canonicalTopic(item.topic) || cleanText(item.topic, 120);
    if (!topic) continue;
    missing.push({ topic, detail: cleanText(item.detail, 1500) || NOT_STATED, question: cleanText(item.question, 600) });
  }
  // Every one of the seven checks is answered one way or the other.
  for (const topic of REVIEW_TOPICS) {
    if (!confirmed.some((c) => c.topic === topic) && !missing.some((m) => m.topic === topic)) {
      missing.push({ topic, detail: NOT_STATED, question: "" });
    }
  }
  confirmed.sort((a, b) => topicOrder(a.topic) - topicOrder(b.topic));
  missing.sort((a, b) => topicOrder(a.topic) - topicOrder(b.topic));

  const questions = [];
  const addQuestion = (value) => {
    const q = cleanQuestion(value);
    if (q && !questions.some((x) => x.toLowerCase() === q.toLowerCase())) questions.push(q);
  };
  for (const m of missing) {
    addQuestion(m.question || DEFAULT_QUESTIONS[m.topic] || `Could you tell us about ${m.topic.toLowerCase()}?`);
  }
  for (const q of asArray(parsed.questions)) addQuestion(q);

  const suggestedProducts = sanitiseSuggestedProducts(parsed.suggestedProducts, index, notes);
  const emailDraft = buildEmailDraft({
    departmentName: ctx.departmentName,
    repName: ctx.repName,
    questions,
    intro: cleanIntro(parsed.emailIntro),
    confirmed
  });

  const modelNotes = cleanText(parsed.notes, 2000);
  if (modelNotes) notes.unshift(modelNotes);
  if (ctx.fallbackReason) notes.unshift(ctx.fallbackReason);

  return {
    confirmed,
    missing: missing.map(({ topic, detail }) => ({ topic, detail })),
    questions,
    suggestedProducts,
    emailDraft,
    notes: notes.join(" ")
  };
}

/*
 * §4: read the policy and artwork, list confirmed vs missing, draft the rep
 * email. Never throws; never sends anything.
 */
async function reviewPolicy(input = {}, { onLog } = {}) {
  const log = logger(onLog);
  const ctx = {
    departmentName: input.departmentName || "",
    repName: input.repName || "",
    policyText: String(input.policyText || ""),
    artwork: asArray(input.artwork),
    knownProducts: asArray(input.knownProducts),
    notes: String(input.notes || ""),
    fallbackReason: ""
  };

  const hasSources =
    ctx.policyText.trim() || ctx.notes.trim() || ctx.artwork.some((a) => cleanText(a?.description));
  if (!hasSources) {
    ctx.fallbackReason = "No readable policy text, artwork description or notes were provided, so every topic is listed as missing.";
    log("policy review: nothing to read; code-built review");
    return finalizeReview({}, ctx);
  }

  let parsed = null;
  try {
    const content = await model().reason({ messages: buildReviewMessages(ctx), jsonObject: true, maxTokens: 2500 });
    parsed = parseJsonObject(content);
    if (!parsed) {
      ctx.fallbackReason = "The policy review model returned nothing usable, so every topic is listed as missing — review the policy by hand.";
      log("policy review: unparseable model output; code-built review");
    }
  } catch (error) {
    ctx.fallbackReason = `The policy review model was unavailable (${cleanText(error.message, 300)}), so every topic is listed as missing — review the policy by hand.`;
    log(`policy review failed: ${error.message}`);
  }
  return finalizeReview(parsed || {}, ctx);
}

/* ---------------------------------------------------------------------------
   HTML for the Google Doc in the department folder
   ------------------------------------------------------------------------- */

const esc = rules.escapeHtml;

function paragraphsHtml(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function htmlDocument(title, bodyHtml) {
  return [
    "<!DOCTYPE html>",
    `<html><head><meta charset="utf-8"><title>${esc(title)}</title></head>`,
    "<body>",
    bodyHtml,
    "</body></html>"
  ].join("\n");
}

function emailDraftBodyHtml(draft) {
  const subject = cleanText(draft?.subject, 300);
  return [`<h1>${esc(subject)}</h1>`, paragraphsHtml(draft?.body)].filter(Boolean).join("\n");
}

// The rep email as a document Dan can copy from.
function emailDraftHtml(draft) {
  return htmlDocument(cleanText(draft?.subject, 300) || "Email draft", emailDraftBodyHtml(draft || {}));
}

// "Policy review — <Department>": Confirmed / Missing / Questions / Email draft.
function reviewDocHtml({ departmentName, review, artwork } = {}) {
  const r = review || {};
  const title = `Policy review — ${cleanText(departmentName, 200) || "department"}`;
  const confirmed = asArray(r.confirmed);
  const missing = asArray(r.missing);
  const questions = asArray(r.questions);
  const products = asArray(r.suggestedProducts);
  const art = asArray(artwork);

  const sections = [`<h1>${esc(title)}</h1>`];
  if (r.notes) sections.push(`<p>${esc(r.notes)}</p>`);

  sections.push("<h2>Confirmed</h2>");
  sections.push(
    confirmed.length
      ? `<ul>\n${confirmed
          .map((c) => `<li><strong>${esc(c.topic)}:</strong> ${esc(c.detail)}${c.source ? ` <em>(${esc(c.source)})</em>` : ""}</li>`)
          .join("\n")}\n</ul>`
      : "<p>Nothing in the policy could be confirmed.</p>"
  );

  sections.push("<h2>Missing</h2>");
  sections.push(
    missing.length
      ? `<ul>\n${missing.map((m) => `<li><strong>${esc(m.topic)}:</strong> ${esc(m.detail)}</li>`).join("\n")}\n</ul>`
      : "<p>Nothing is missing.</p>"
  );

  sections.push("<h2>Questions</h2>");
  sections.push(
    questions.length ? `<ol>\n${questions.map((q) => `<li>${esc(q)}</li>`).join("\n")}\n</ol>` : "<p>No questions for the rep.</p>"
  );

  if (products.length) {
    sections.push("<h2>Suggested products (unconfirmed — Dan decides)</h2>");
    sections.push(
      `<table border="1" cellpadding="4" cellspacing="0">\n<tr><th>Brand</th><th>Style number</th><th>Type</th><th>Colors</th><th>Sizes</th><th>Decoration</th><th>Class B</th><th>Confidence</th><th>Evidence</th></tr>\n${products
        .map(
          (p) =>
            `<tr><td>${esc(p.brand)}</td><td>${esc(p.styleNumber)}</td><td>${esc(p.type)}</td><td>${esc(asArray(p.colors).join(", "))}</td><td>${esc(
              asArray(p.sizes).join(", ")
            )}</td><td>${esc(p.decorationMethod)}</td><td>${p.classB ? "Yes" : "No"}</td><td>${esc(p.confidence)}</td><td>${esc(p.evidence)}</td></tr>`
        )
        .join("\n")}\n</table>`
    );
  }

  if (art.length) {
    sections.push("<h2>Artwork</h2>");
    sections.push(
      `<ul>\n${art
        .map((a) => `<li><strong>${esc(a.name || "artwork")}</strong>${a.role ? ` (${esc(a.role)} logo)` : ""}${a.description ? `: ${esc(a.description)}` : ""}</li>`)
        .join("\n")}\n</ul>`
    );
  }

  sections.push("<h2>Email draft</h2>");
  sections.push("<p><em>From Dan to the department rep. Dan reviews and sends it — the agent never sends email.</em></p>");
  sections.push(emailDraftBodyHtml(r.emailDraft || {}).replace(/^<h1>/, "<h3>").replace(/<\/h1>/, "</h3>"));

  return htmlDocument(title, sections.join("\n"));
}

/* ---------------------------------------------------------------------------
   §11 product description data
   ------------------------------------------------------------------------- */

const NO_MANUFACTURER_DATA = "Manufacturer data not available — flag for Dan";

function brandLineFor(brand, styleNumber) {
  return `${cleanText(brand, 80)} (${cleanText(styleNumber, 40)})`;
}

/*
 * Materials, details and measurements for the §11 description, in order of
 * preference:
 *   1. the product we duplicated from (its bullets and table are already the
 *      manufacturer's data, checked by Dan on an earlier store),
 *   2. the supplier page facts (blanks.findSupplierBlank → extractSupplierFacts),
 *   3. nothing — flagged for Dan rather than written by the model.
 */
async function descriptionDataFor({ brand, styleNumber, type, colors, sourceDescriptionHtml, vendor } = {}, { onLog } = {}) {
  const log = logger(onLog);
  const brandLine = brandLineFor(brand, styleNumber);
  const base = { bullets: [], measurements: null, measurementsHtml: "", brandLine, vendor: vendor || "", source: "none", note: NO_MANUFACTURER_DATA, sourceUrl: "" };

  if (sourceDescriptionHtml) {
    const parts = rules.extractDescriptionParts(sourceDescriptionHtml);
    if (parts.bullets.length) {
      return { ...base, bullets: parts.bullets, measurementsHtml: parts.measurementsHtml || "", source: "source-product", note: "" };
    }
  }

  const style = cleanText(styleNumber, 40);
  const brandName = cleanText(brand, 80);
  if (!style && !brandName) return base;

  try {
    const found = await model().findSupplierBlank(
      {
        vendor: brandName,
        brandStyle: style,
        garmentColor: cleanText(asArray(colors)[0], 60),
        productType: cleanText(type, 60)
      },
      { onLog }
    );
    const facts = found?.facts || null;
    const bullets = asArray(facts?.fabric).map((b) => cleanText(b, 300)).filter(Boolean);
    const fit = cleanText(facts?.fit, 300);
    if (fit && !bullets.includes(fit)) bullets.push(fit);
    const chart = facts?.sizeChart;
    const measurements =
      chart && asArray(chart.headers).length && asArray(chart.rows).length
        ? {
            title: "Product Measurements",
            sizes: chart.headers.map((h) => cleanText(h, 40)),
            rows: chart.rows.map((row) => ({ label: cleanText(row?.label, 80), values: asArray(row?.values).map((v) => cleanText(v, 40)) }))
          }
        : null;
    if (bullets.length || measurements) {
      const sourceUrl = cleanText(found?.sourceUrl, 500);
      return {
        ...base,
        bullets,
        measurements,
        source: "supplier",
        sourceUrl,
        note: sourceUrl ? `Manufacturer data from ${sourceUrl}` : "Manufacturer data from the supplier page"
      };
    }
    log(`no manufacturer data for ${[brandName, style].filter(Boolean).join(" ")}: ${cleanText(found?.note, 300) || "supplier page had no facts"}`);
  } catch (error) {
    log(`supplier lookup failed for ${[brandName, style].filter(Boolean).join(" ")}: ${error.message}`);
  }
  return base;
}

/*
 * §11 HTML: disclaimer (only with a decoration mockup), Brand (Style), the
 * bullets, the measurements, the Non-Stock notice when the vendor says so.
 */
function buildDescription({ brand, styleNumber, descriptionData, hasMockup = true, vendor } = {}) {
  const data = descriptionData || {};
  const v = rules.normalizeVendor(vendor);
  return rules.buildProductDescriptionHtml({
    brand: cleanText(brand, 80),
    styleNumber: cleanText(styleNumber, 40),
    bullets: asArray(data.bullets),
    measurements: data.measurements || null,
    measurementsHtml: data.measurementsHtml || "",
    hasMockup: Boolean(hasMockup),
    vendor: v.vendor || cleanText(vendor, 40)
  });
}

module.exports = {
  REVIEW_TOPICS,
  NOT_STATED,
  DEFAULT_QUESTIONS,
  NO_MANUFACTURER_DATA,
  setModel,
  describeArtwork,
  extractPacketText,
  reviewPolicy,
  emailDraftHtml,
  reviewDocHtml,
  descriptionDataFor,
  buildDescription,
  // exported for tests
  parseJsonObject,
  canonicalTopic,
  buildReviewMessages,
  buildEmailDraft
};

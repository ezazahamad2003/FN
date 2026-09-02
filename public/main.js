/* =============================================================================
   FN Onboarding — front-end controller
   -----------------------------------------------------------------------------
   Backend contract:
     • POST /onboard (multipart: departmentName, logos[], policies[],
       followUps[], followUpText, conflictStrategy)
       → 400/401 JSON error, 409 JSON folder-conflict, or an SSE stream of
         `status` / `error` events ending in a `review` event (steps 1–7).
       Nothing is published to Shopify in this phase.
     • POST /publish { runId } → SSE stream of `status` / `error` events
       ending in a `summary` event (steps 8–10). Runs only on user approval.
     • POST /discard { runId } → drops the pending run.
     • POST /cleanup { runId } → undoes a published run (delete its Shopify
       products, delete the Shopify collection, trash the Drive folder).
       Available for 24h after publish.
     • GET  /health → { shopifyConnected, shopifyStore, googleConnected }
     • POST /auth/{shopify|google}/disconnect

     • GET  /api/collections → { collections[] } — every department in the store
     • GET  /api/collections/:id → { collection, products[] }
     • GET  /api/products/:id → { product }
     • PATCH /api/products/:id → { product } (title/description/type/vendor/
       status/tags/price; price applies to every variant)
     • POST /api/collections/:id/products (multipart: description, logos[],
       price, sizes, productLabel, productType, garmentColor, placement)
       → SSE `status` / `error` events ending in `created`.

   This file only owns presentation: it maps SSE `step`/`state` onto a visual
   timeline + progress bar, renders file previews, renders the review gate,
   and handles the folder conflict with an accessible modal.

   Navigation is hash-routed across six views — #/dashboard (the default
   landing view), #/new-stores, #/new-stores/:id, #/departments,
   #/departments/:id, and #/onboarding. Onboarding is one option in the nav
   rather than the whole app, because day to day the store already exists and
   the common task is browsing and editing it.
   ========================================================================== */

const TOTAL_STEPS = 10; // 7 analyze/generate + 3 publish (review gate between)

const el = (id) => document.getElementById(id);

const form = el("onboardForm");
const runButton = el("runButton");
const conflictStrategy = el("conflictStrategy");
const summary = el("summary");

const departmentInput = el("departmentName");
const departmentError = el("departmentError");
const logoInput = el("logos");
const logoError = el("logoError");
const logoThumbs = el("logoThumbs");
const policyInput = el("policies");
const policyChips = el("policyChips");
const intakeInput = el("intakeForms");
const intakeChips = el("intakeChips");
const followUpInput = el("followUps");
const followUpChips = el("followUpChips");
const review = el("review");
const analysis = el("analysis");
const analyzeButton = el("analyzeButton");

const runStatus = el("runStatus");
const runLabel = el("runLabel");
const runSub = el("runSub");
const progressBar = el("progressBar");
const progressFill = el("progressFill");
const progressText = el("progressText");
const progressPct = el("progressPct");
const runError = el("runError");
const runErrorText = el("runErrorText");
const runNotices = el("runNotices");

const connectionPill = el("connectionPill");
const shopifyCard = el("shopifyCard");
const googleCard = el("googleCard");

const conflictModal = el("conflictModal");

const STATE_LABEL = { pending: "Pending", running: "Running…", complete: "Done", failed: "Failed" };

/* -----------------------------------------------------------------------------
   Small helpers
   -------------------------------------------------------------------------- */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]
  ));
}

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

const RUN_GLYPHS = {
  idle: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  running: '<span class="spinner" style="width:15px;height:15px"></span>',
  success: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

function setRunHeader(state, labelText, subText) {
  runStatus.dataset.state = state;
  runLabel.innerHTML = `<span class="run-glyph" aria-hidden="true">${RUN_GLYPHS[state] || ""}</span>${escapeHtml(labelText)}`;
  if (subText !== undefined) runSub.textContent = subText;
}

/* -----------------------------------------------------------------------------
   Timeline + progress
   -------------------------------------------------------------------------- */
function stepRow(step) {
  return document.querySelector(`.step[data-step="${step}"]`);
}

function setStep(step, state) {
  const row = stepRow(step);
  if (!row) return; // defensive: ignore step numbers with no timeline row
  row.dataset.state = state;
  const stateEl = row.querySelector(".step-state");
  if (stateEl) stateEl.textContent = STATE_LABEL[state] || "";
}

function updateProgress() {
  const done = document.querySelectorAll('.step[data-state="complete"]').length;
  const pct = Math.round((done / TOTAL_STEPS) * 100);
  progressFill.style.width = `${pct}%`;
  progressPct.textContent = `${pct}%`;
  progressText.textContent = `${done} of ${TOTAL_STEPS} steps`;
  progressBar.setAttribute("aria-valuenow", String(pct));
}

function resetTimeline() {
  document.querySelectorAll(".step").forEach((row) => setStep(Number(row.dataset.step), "pending"));
  runError.hidden = true;
  runErrorText.textContent = "";
  runNotices.innerHTML = "";
  progressFill.style.width = "0%";
  progressPct.textContent = "0%";
  progressText.textContent = `0 of ${TOTAL_STEPS} steps`;
  progressBar.setAttribute("aria-valuenow", "0");
}

function addNotice(message) {
  const item = document.createElement("div");
  item.className = "notice";
  item.innerHTML = `<span class="n-dot" aria-hidden="true"></span><span>${escapeHtml(message)}</span>`;
  runNotices.appendChild(item);
}

function showRunError(message) {
  runError.hidden = false;
  runErrorText.textContent = message;
}
function clearReviewError() {
  review.querySelector(".publish-error")?.remove();
}

function showReviewError(message) {
  if (!review || review.hidden) return;
  clearReviewError();
  const error = document.createElement("div");
  error.className = "publish-error gap-report";
  error.dataset.tone = "warn";
  error.innerHTML = `
    <p class="gap-title">Publish failed</p>
    <p class="gap-note">${escapeHtml(message || "Shopify publishing failed.")}</p>
  `;
  const actions = review.querySelector(".review-actions");
  if (actions) actions.before(error);
  else review.appendChild(error);
  error.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* -----------------------------------------------------------------------------
   Summary
   -------------------------------------------------------------------------- */
async function runCleanup(data) {
  const count = data.cleanup?.productCount ?? data.products.length;
  const collectionName = data.cleanup?.collectionTitle || data.departmentName || "the department collection";
  const confirmed = window.confirm(
    "Delete everything this run created?\n\n" +
      `- ${count} Shopify product${count === 1 ? "" : "s"}\n` +
      `- Collection "${collectionName}"\n` +
      "- Drive folder (moved to Drive trash, recoverable for ~30 days)\n\n" +
      "Products and the collection cannot be restored from here."
  );
  if (!confirmed) return;

  const zone = el("cleanupZone");
  const btn = el("cleanupBtn");
  btn.disabled = true;
  btn.textContent = "Deleting…";
  try {
    const res = await fetch("/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: data.runId })
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || "Cleanup failed.");

    const lines = [
      `${result.deletedProducts} product${result.deletedProducts === 1 ? "" : "s"} deleted`,
      result.collectionDeleted ? "collection deleted" : "collection could not be deleted",
      result.driveTrashed ? "Drive folder moved to trash" : "Drive folder could not be trashed"
    ];
    zone.dataset.state = result.ok ? "done" : "partial";
    zone.innerHTML = `
      <div class="cz-text">
        <p class="cz-title">${result.ok ? "Run assets deleted" : "Cleanup finished with issues"}</p>
        <p class="cz-sub">${escapeHtml(lines.join(" · "))}${
          result.errors?.length ? `<br>${escapeHtml(result.errors.join(" · "))}` : ""
        }</p>
      </div>`;
    addNotice(result.ok ? "Cleanup complete — this run's assets were removed." : "Cleanup finished with issues — see the summary panel.");
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Delete run assets…";
    window.alert(err.message || "Cleanup failed.");
  }
}

function renderSummary(data) {
  const count = data.products.length;
  const products = data.products
    .map((p) => `
      <article class="product-card">
        <img src="${escapeHtml(p.thumbnail)}" alt="${escapeHtml(p.title)}" loading="lazy">
        <div class="pc-body">
          <h3 class="pc-title">${escapeHtml(p.title)}</h3>
          <div class="pc-actions">
            <a class="btn btn-secondary btn-sm" href="${escapeHtml(p.url)}" target="_blank" rel="noreferrer">Open product</a>
            ${p.driveImageUrl ? `<a class="btn btn-ghost btn-sm" href="${escapeHtml(p.driveImageUrl)}" target="_blank" rel="noreferrer">Drive image</a>` : ""}
          </div>
        </div>
      </article>`)
    .join("");

  const cleanupHtml = data.runId
    ? `
    <div class="cleanup-zone" id="cleanupZone">
      <div class="cz-text">
        <p class="cz-title">Need to undo this run?</p>
        <p class="cz-sub">Deletes the ${count} Shopify product${count === 1 ? "" : "s"} created just now, deletes the Shopify collection, and moves the Drive folder to trash (recoverable for ~30 days). Available for 24 hours after publishing.</p>
      </div>
      <button class="btn btn-danger-ghost" type="button" id="cleanupBtn">Delete run assets…</button>
    </div>`
    : "";

  summary.hidden = false;
  summary.innerHTML = `
    <div class="summary-head">
      <div>
        <p class="eyebrow">Complete</p>
        <span class="count">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          ${count} ${count === 1 ? "product" : "products"} created
        </span>
      </div>
      <div class="summary-actions">
        <a class="btn btn-secondary" href="${escapeHtml(data.driveFolderUrl)}" target="_blank" rel="noreferrer">Drive folder</a>
        ${data.manualUrl ? `<a class="btn btn-secondary" href="${escapeHtml(data.manualUrl)}" target="_blank" rel="noreferrer">Manual doc</a>` : ""}
        <a class="btn btn-primary" href="${escapeHtml(data.shopifyCollectionUrl)}" target="_blank" rel="noreferrer">Shopify collection</a>
      </div>
    </div>
    <div class="product-grid">${products}</div>
    ${cleanupHtml}
  `;
  const cleanupBtn = el("cleanupBtn");
  if (cleanupBtn) cleanupBtn.addEventListener("click", () => runCleanup(data));
  summary.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* -----------------------------------------------------------------------------
   Review gate — everything is generated but NOTHING is on Shopify yet.
   The user sees the gap report, the email draft, and every product image,
   then explicitly approves (publish) or discards.
   -------------------------------------------------------------------------- */
let activeRunId = null;
let activeEmailDraft = null;

const CONFIDENCE_META = {
  high: { label: "High confidence", tone: "ok" },
  medium: { label: "Medium confidence — review carefully", tone: "warn" },
  low: { label: "Low confidence — policy has gaps", tone: "warn" }
};

function metaChip(label, value, stated) {
  return `<span class="m-chip" data-known="${stated ? "true" : "false"}"><b>${escapeHtml(label)}</b>${escapeHtml(value)}</span>`;
}

// Shared gap report + email draft markup, used by both the pre-flight analysis
// panel and the post-generation review panel.
function gapReportMarkup(gaps, note) {
  return gaps.missing.length
    ? `<div class="gap-report" data-tone="warn">
        <p class="gap-title">The policy document does not cover ${gaps.missing.length} production ${gaps.missing.length === 1 ? "detail" : "details"}:</p>
        <ul class="gap-list">
          ${gaps.missing.map((m) => `<li><b>${escapeHtml(m.topic)}</b>${m.detail ? ` — ${escapeHtml(m.detail)}` : ""}</li>`).join("")}
        </ul>
        <p class="gap-note">${escapeHtml(note)}</p>
      </div>`
    : `<div class="gap-report" data-tone="ok">
        <p class="gap-title">Policy covers everything needed for production.</p>
      </div>`;
}

function emailDraftMarkup(draft, { copyId, bodyId, driveUrl }) {
  if (!draft) return "";
  return `<div class="email-draft">
      <div class="email-head">
        <p class="eyebrow">Email draft — ask the department for the missing details</p>
        <div class="email-actions">
          <button class="btn btn-secondary btn-sm" type="button" id="${copyId}">Copy email</button>
          ${driveUrl ? `<a class="btn btn-ghost btn-sm" href="${escapeHtml(driveUrl)}" target="_blank" rel="noreferrer">Open in Drive</a>` : ""}
        </div>
      </div>
      <p class="email-subject"><b>Subject:</b> ${escapeHtml(draft.subject)}</p>
      <textarea class="email-body" id="${bodyId}" readonly rows="10" aria-label="Email draft body">${escapeHtml(draft.body)}</textarea>
    </div>`;
}

function intakeSummaryMarkup(intake) {
  if (!intake?.present) return "";
  const tone = intake.ready ? "ok" : "warn";
  const missing = intake.missing?.length
    ? `<ul class="intake-missing">${intake.missing.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";
  return `<div class="intake-summary" data-tone="${tone}">
    <div>
      <p class="eyebrow">Store build form</p>
      <p class="intake-title">${intake.ready ? "Ready for deterministic build" : "Form detected with open fields"}</p>
      <p class="intake-note">${escapeHtml(intake.summary || "")}</p>
    </div>
    ${intake.departmentCode ? `<span class="confidence" data-tone="ok">${escapeHtml(intake.departmentCode)}</span>` : ""}
    ${missing}
  </div>`;
}

async function copyEmail(draft, button, bodyId) {
  if (!draft) return;
  const text = `Subject: ${draft.subject}\n\n${draft.body}`;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const body = el(bodyId);
    if (body) {
      body.focus();
      body.select();
      document.execCommand("copy");
    }
  }

  const panel = button.closest(".email-draft");
  if (panel) {
    panel.remove();
    addNotice("Email draft copied and hidden.");
    return;
  }

  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = original;
  }, 1600);
}

/* -----------------------------------------------------------------------------
   Pre-flight analysis panel — policy gaps + email draft, created by the
   "Analyze policy & draft email" button. No Drive/Shopify side effects.
   -------------------------------------------------------------------------- */
let analysisEmailDraft = null;

function renderAnalysis(data) {
  analysisEmailDraft = data.emailDraft || null;
  const gaps = data.gaps || { missing: [], confidence: "low" };
  const conf = CONFIDENCE_META[gaps.confidence] || CONFIDENCE_META.low;

  const gapsHtml = gapReportMarkup(
    gaps,
    "Send the email draft below to the department. When they reply, paste it into “Department follow-up answers” (or attach it) and click Run onboarding — the gaps fill in. Nothing has been created yet."
  );
  const emailHtml = emailDraftMarkup(data.emailDraft, {
    copyId: "copyEmailBtnAnalysis",
    bodyId: "emailBodyAnalysis"
  });
  const intakeHtml = intakeSummaryMarkup(data.intake);

  const productsHtml = data.products
    .map((p) => {
      const chips = [
        metaChip("Color", p.garmentColor || "not stated", Boolean(p.garmentColor)),
        metaChip("Placement", p.placement + (p.placementStated ? "" : " (default)"), p.placementStated),
        metaChip("Sizes", p.sizes.join(", ") + (p.sizesStated ? "" : " (default)"), p.sizesStated),
        p.brandStyle ? metaChip("Style", p.brandStyle, true) : "",
        p.fabricDetails ? metaChip("Fabric", p.fabricDetails, true) : "",
        p.decorationMethod ? metaChip("Decoration", p.decorationMethod, true) : "",
        p.decorationSizeTier ? metaChip("Tier", p.decorationSizeTier, true) : "",
        p.decorationFeeSku ? metaChip("Fee SKU", p.decorationFeeSku, true) : "",
        p.intakeSource ? metaChip("Form", "fixed field", true) : ""
      ]
        .filter(Boolean)
        .join("");
      // Say plainly whether the department assigned these logos or whether we
      // fell back to offering all of them — a silent fallback is how wrong
      // logos reached finished product images before.
      const logoLine = p.logos && p.logos.length
        ? `<p class="rv-logos">Logos: ${escapeHtml(p.logos.join(", "))}${
            p.logoAssignmentStated ? " (assigned by the department)" : " (no assignment stated — all logos offered)"
          }</p>`
        : "";
      return `
        <article class="rv-product">
          <div class="rv-head"><h3>${escapeHtml(p.productLabel)}</h3></div>
          <div class="meta-chips">${chips}</div>
          ${logoLine}
        </article>`;
    })
    .join("");

  const count = data.products.length;
  analysis.hidden = false;
  analysis.innerHTML = `
    <div class="review-head">
      <div>
        <p class="eyebrow">Policy analysis · nothing created yet</p>
        <h2>${count} ${count === 1 ? "product" : "products"} detected from source material</h2>
      </div>
      <span class="confidence" data-tone="${conf.tone}">${conf.label}</span>
    </div>
    ${intakeHtml}
    ${gapsHtml}
    ${emailHtml}
    <div class="rv-products">${productsHtml}</div>
  `;
  analysis.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const copyBtn = el("copyEmailBtnAnalysis");
  if (copyBtn) copyBtn.addEventListener("click", () => copyEmail(analysisEmailDraft, copyBtn, "emailBodyAnalysis"));
}

async function runAnalyze() {
  const hasPolicy = policyInput.files.length > 0 || intakeInput.files.length > 0 || followUpInput.files.length > 0 || el("followUpText").value.trim();
  if (!hasPolicy) {
    setRunHeader("idle", "Add source material first", "Upload a policy document, store build form, or paste follow-up text to analyze.");
    addNotice("Add a policy document, store build form, or follow-up text before analyzing.");
    return;
  }

  const btn = el("analyzeButton");
  btn.disabled = true;
  runButton.disabled = true;
  btn.querySelector(".btn-label").textContent = "Analyzing…";
  btn.insertAdjacentHTML("afterbegin", '<span class="spinner" aria-hidden="true"></span>');
  setRunHeader("running", "Analyzing source material", "Reading the document or form and drafting the gaps email. Nothing is being created.");

  try {
    const res = await fetch("/analyze", { method: "POST", body: new FormData(form) });
    const payload = await res.json().catch(() => ({ error: "Analysis failed." }));
    if (!res.ok) throw new Error(payload.error || "Analysis failed.");
    renderAnalysis(payload);
    const gapCount = payload.gaps?.missing?.length || 0;
    setRunHeader(
      "idle",
      gapCount ? "Policy analyzed — email drafted" : "Policy analyzed — looks complete",
      gapCount ? "Send the drafted email, then add the reply and run onboarding." : "You can run onboarding whenever ready."
    );
  } catch (err) {
    setRunHeader("error", "Analysis failed", "The policy could not be analyzed.");
    showRunError(err.message || "Analysis failed.");
  } finally {
    btn.disabled = false;
    runButton.disabled = false;
    btn.querySelector(".spinner")?.remove();
    btn.querySelector(".btn-label").textContent = "Analyze source & draft email";
  }
}

function renderReview(data) {
  activeRunId = data.runId;
  activeEmailDraft = data.emailDraft || null;
  const gaps = data.gaps || { missing: [], confidence: "low" };
  const conf = CONFIDENCE_META[gaps.confidence] || CONFIDENCE_META.low;

  const gapsHtml = gapReportMarkup(
    gaps,
    "Send the email draft below, then paste the answers into “Department follow-up answers” and re-run to fill these in. Unstated details fall back to marked defaults — nothing was invented."
  );
  const emailHtml = emailDraftMarkup(data.emailDraft, {
    copyId: "copyEmailBtn",
    bodyId: "emailBody",
    driveUrl: data.emailDraftDocUrl
  });
  const intakeHtml = intakeSummaryMarkup(data.intake);

  const productsHtml = data.products
    .map((p) => {
      const chips = [
        metaChip("Color", p.garmentColor || "not stated", Boolean(p.garmentColor)),
        metaChip("Placement", p.placement + (p.placementStated ? "" : " (default)"), p.placementStated),
        metaChip("Sizes", p.sizes.join(", ") + (p.sizesStated ? "" : " (default)"), p.sizesStated),
        p.brandStyle ? metaChip("Style", p.brandStyle, true) : "",
        p.fabricDetails ? metaChip("Fabric", p.fabricDetails, true) : "",
        p.decorationMethod ? metaChip("Decoration", p.decorationMethod, true) : "",
        p.decorationSizeTier ? metaChip("Tier", p.decorationSizeTier, true) : "",
        p.decorationFeeSku ? metaChip("Fee SKU", p.decorationFeeSku, true) : "",
        p.intakeSource ? metaChip("Form", "fixed field", true) : "",
        // Whether the base photo is the real style or a lookalike decides how
        // much the operator should trust the garment in these images.
        metaChip(
          "Blank",
          p.blankSource === "supplier" ? "supplier photo of this style" : "generated lookalike",
          p.blankSource === "supplier"
        )
      ]
        .filter(Boolean)
        .join("");
      /* The source link is what the ordering team clicks to buy the blank, so
         it renders whenever there IS one. It used to hang off blankNote, which
         only the review gate sets - built stores stored the URL and then never
         showed it. */
      const blankLine =
        p.blankNote || p.blankSourceUrl
          ? `<p class="rv-logos">${escapeHtml(p.blankNote || "")}${
              p.blankSourceUrl
                ? `${p.blankNote ? " " : ""}<a href="${escapeHtml(p.blankSourceUrl)}" target="_blank" rel="noopener">order this blank ↗</a>`
                : ""
            }</p>`
          : "";
      const images = p.images
        .map(
          (img) => `
          <figure class="rv-img">
            <img src="${escapeHtml(img.thumbnail)}" alt="${escapeHtml(p.title)} — ${escapeHtml(img.logoLabel)}" loading="lazy">
            <figcaption>${escapeHtml(img.logoLabel)}</figcaption>
          </figure>`
        )
        .join("");
      return `
        <article class="rv-product">
          <div class="rv-head">
            <h3>${escapeHtml(p.title)}</h3>
            <span class="rv-count">${p.images.length} logo ${p.images.length === 1 ? "variant" : "variants"}</span>
          </div>
          <div class="meta-chips">${chips}</div>
          ${blankLine}
          <div class="rv-grid">${images}</div>
        </article>`;
    })
    .join("");

  const productCount = data.products.length;
  review.hidden = false;
  review.innerHTML = `
    <div class="review-head">
      <div>
        <p class="eyebrow">Review before publishing</p>
        <h2>${productCount} ${productCount === 1 ? "product" : "products"} generated — nothing is on Shopify yet</h2>
      </div>
      <span class="confidence" data-tone="${conf.tone}">${conf.label}</span>
    </div>
    ${intakeHtml}
    ${gapsHtml}
    ${emailHtml}
    <div class="rv-products">${productsHtml}</div>
    <div class="review-actions">
      <a class="btn btn-ghost" href="${escapeHtml(data.driveFolderUrl)}" target="_blank" rel="noreferrer">Drive folder</a>
      ${data.manualUrl ? `<a class="btn btn-ghost" href="${escapeHtml(data.manualUrl)}" target="_blank" rel="noreferrer">Manual doc</a>` : ""}
      <span class="rv-spacer" aria-hidden="true"></span>
      <button class="btn btn-danger-ghost" type="button" id="discardRunBtn">Discard run</button>
      <button class="btn btn-primary" type="button" id="publishRunBtn">
        <span class="btn-label">Approve &amp; publish to Shopify</span>
      </button>
    </div>
  `;
  review.scrollIntoView({ behavior: "smooth", block: "nearest" });

  el("publishRunBtn").addEventListener("click", startPublish);
  el("discardRunBtn").addEventListener("click", discardRun);
  const copyBtn = el("copyEmailBtn");
  if (copyBtn) copyBtn.addEventListener("click", () => copyEmail(activeEmailDraft, copyBtn, "emailBody"));
}

function setPublishBusy(busy) {
  const publishBtn = el("publishRunBtn");
  const discardBtn = el("discardRunBtn");
  if (publishBtn) {
    publishBtn.disabled = busy;
    publishBtn.querySelector(".btn-label").textContent = busy ? "Publishing…" : "Approve & publish to Shopify";
  }
  if (discardBtn) discardBtn.disabled = busy;
}

async function startPublish() {
  if (!activeRunId) return;
  setPublishBusy(true);
  clearReviewError();
  setRunHeader("running", "Publishing to Shopify", "Creating collection, products with variants, and images.");
  try {
    const res = await fetch("/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: activeRunId })
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({ error: "Publish failed." }));
      setRunHeader("error", "Publish failed", "The publish request could not start.");
      showRunError(payload.error || "Publish failed.");
      showReviewError(payload.error || "Publish failed.");
      setPublishBusy(false);
      return;
    }
    await readSseStream(res);
  } catch (err) {
    setRunHeader("error", "Publish failed", "An unexpected error interrupted publishing.");
    showRunError(err.message || "Unexpected error.");
    showReviewError(err.message || "Unexpected error.");
    setPublishBusy(false);
  }
}

async function discardRun() {
  if (!activeRunId) return;
  if (!window.confirm("Discard this run? Drive files are kept; nothing will be published to Shopify.")) return;
  try {
    await fetch("/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: activeRunId })
    });
  } catch {
    /* discard is best-effort; the run also expires server-side */
  }
  activeRunId = null;
  activeEmailDraft = null;
  review.hidden = true;
  review.innerHTML = "";
  setRunHeader("idle", "Run discarded", "Nothing was published. Adjust the inputs and run again.");
  addNotice("Run discarded — Drive assets were kept.");
}

/* -----------------------------------------------------------------------------
   File inputs — previews, drag & drop, remove
   -------------------------------------------------------------------------- */
const objectUrls = new Set();
function freshObjectUrl(file) {
  const url = URL.createObjectURL(file);
  objectUrls.add(url);
  return url;
}
function revokeObjectUrls() {
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls.clear();
}

function setInputFiles(input, files) {
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));
  input.files = dt.files;
}

function fileKey(f) {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

function mergeFiles(existing, incoming) {
  const seen = new Set(existing.map(fileKey));
  const merged = [...existing];
  incoming.forEach((f) => {
    if (!seen.has(fileKey(f))) {
      seen.add(fileKey(f));
      merged.push(f);
    }
  });
  return merged;
}

function renderLogoThumbs() {
  revokeObjectUrls();
  const files = [...logoInput.files];
  logoThumbs.innerHTML = files
    .map((file, i) => `
      <div class="thumb">
        <img src="${freshObjectUrl(file)}" alt="${escapeHtml(file.name)}">
        <button class="file-remove" type="button" data-remove-logo="${i}" aria-label="Remove ${escapeHtml(file.name)}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`)
    .join("");
  syncDropzone("logos", files.length);
  if (files.length) hideFieldError(logoInput, logoError);
}

function docChipHtml(file, removeAttr, index) {
  return `
    <div class="chip">
      <span class="chip-glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/></svg>
      </span>
      <span class="chip-name">${escapeHtml(file.name)}</span>
      <span class="chip-size">${formatBytes(file.size)}</span>
      <button class="file-remove" type="button" ${removeAttr}="${index}" aria-label="Remove ${escapeHtml(file.name)}">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
}

function renderPolicyChips() {
  const files = [...policyInput.files];
  policyChips.innerHTML = files.map((file, i) => docChipHtml(file, "data-remove-policy", i)).join("");
  syncDropzone("policies", files.length);
}

function renderIntakeChips() {
  const files = [...intakeInput.files];
  intakeChips.innerHTML = files.map((file, i) => docChipHtml(file, "data-remove-intake", i)).join("");
  syncDropzone("intakeForms", files.length);
}

function renderFollowUpChips() {
  const files = [...followUpInput.files];
  followUpChips.innerHTML = files.map((file, i) => docChipHtml(file, "data-remove-followup", i)).join("");
  syncDropzone("followUps", files.length);
}

function syncDropzone(name, count) {
  const zone = document.querySelector(`.dropzone[data-dropzone="${name}"]`);
  if (zone) zone.dataset.hasFiles = count > 0 ? "true" : "false";
}

function wireDropzone(name, input, onChange, accept) {
  const zone = document.querySelector(`.dropzone[data-dropzone="${name}"]`);
  if (!zone) return;

  ["dragenter", "dragover"].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.dataset.dragging = "true";
    })
  );
  ["dragleave", "dragend"].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      if (e.target === zone || !zone.contains(e.relatedTarget)) zone.dataset.dragging = "false";
    })
  );
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.dataset.dragging = "false";
    const dropped = [...e.dataTransfer.files].filter(accept);
    if (!dropped.length) return;
    setInputFiles(input, mergeFiles([...input.files], dropped));
    onChange();
  });

  input.addEventListener("change", onChange);
}

const isImage = (f) => f.type.startsWith("image/");
const isDoc = (f) => /\.(pdf|docx?|txt)$/i.test(f.name) || /(pdf|msword|officedocument|text\/plain)/.test(f.type);

/* -----------------------------------------------------------------------------
   Inline validation
   -------------------------------------------------------------------------- */
function showFieldError(input, errorEl, message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  input.setAttribute("aria-invalid", "true");
}
function hideFieldError(input, errorEl) {
  errorEl.hidden = true;
  errorEl.textContent = "";
  input.removeAttribute("aria-invalid");
}
function markDropzoneInvalid(name, invalid) {
  const zone = document.querySelector(`.dropzone[data-dropzone="${name}"]`);
  if (zone) zone.dataset.invalid = invalid ? "true" : "false";
}

function validate() {
  let ok = true;
  if (!departmentInput.value.trim() && intakeInput.files.length === 0) {
    showFieldError(departmentInput, departmentError, "Department name is required unless the store build form includes it.");
    ok = false;
  } else {
    hideFieldError(departmentInput, departmentError);
  }
  if (logoInput.files.length === 0) {
    showFieldError(logoInput, logoError, "Add at least one logo image.");
    markDropzoneInvalid("logos", true);
    ok = false;
  } else {
    hideFieldError(logoInput, logoError);
    markDropzoneInvalid("logos", false);
  }
  return ok;
}

/* -----------------------------------------------------------------------------
   Connection state
   -------------------------------------------------------------------------- */
function renderServiceCard(card, connected, stateText, actionsHtml) {
  card.dataset.state = connected ? "connected" : "missing";
  card.querySelector(".state-text").textContent = stateText;
  card.querySelector(".actions").innerHTML = actionsHtml;
}

async function refreshConnectionState() {
  try {
    const status = await (await fetch("/health")).json();
    const ready = status.shopifyConnected && status.googleConnected;

    connectionPill.dataset.state = ready ? "ready" : "attention";
    connectionPill.querySelector(".txt").textContent = ready ? "All services connected" : "Needs connection";

    renderServiceCard(
      shopifyCard,
      status.shopifyConnected,
      status.shopifyConnected ? (status.shopifyStore ? `Connected · ${status.shopifyStore}` : "Connected") : "Not connected",
      status.shopifyConnected
        ? '<button class="btn btn-danger-ghost btn-sm disconnect" type="button" data-service="shopify">Disconnect</button>'
        : '<a class="btn btn-secondary btn-sm" href="/setup">Connect</a>'
    );
    const googleAccounts = status.googleAccountCount || (status.googleConnected ? 1 : 0);
    const googleText = !status.googleConnected
      ? "Not connected"
      : googleAccounts > 1
        ? `Connected · ${googleAccounts} accounts (failover)`
        : "Connected";
    renderServiceCard(
      googleCard,
      status.googleConnected,
      googleText,
      status.googleConnected
        ? '<button class="btn btn-danger-ghost btn-sm disconnect" type="button" data-service="google">Disconnect</button>'
        : '<a class="btn btn-secondary btn-sm" href="/auth/google">Connect</a>'
    );
  } catch {
    connectionPill.dataset.state = "attention";
    connectionPill.querySelector(".txt").textContent = "Status unavailable";
    [shopifyCard, googleCard].forEach((card) => {
      card.dataset.state = "missing";
      card.querySelector(".state-text").textContent = "Status unavailable";
      card.querySelector(".actions").innerHTML = "";
    });
  }
}

/* -----------------------------------------------------------------------------
   Conflict modal (accessible: Escape, backdrop, focus)
   -------------------------------------------------------------------------- */
let conflictResolver = null;
let lastFocused = null;

function openConflictModal() {
  return new Promise((resolve) => {
    conflictResolver = resolve;
    lastFocused = document.activeElement;
    conflictModal.hidden = false;
    conflictModal.querySelector('[data-conflict="overwrite"]').focus();
    document.addEventListener("keydown", onConflictKeydown);
  });
}

function closeConflictModal(value) {
  conflictModal.hidden = true;
  document.removeEventListener("keydown", onConflictKeydown);
  if (lastFocused && lastFocused.focus) lastFocused.focus();
  const resolve = conflictResolver;
  conflictResolver = null;
  if (resolve) resolve(value);
}

function onConflictKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeConflictModal("cancel");
  }
  if (e.key === "Tab") {
    // simple focus trap across the modal's buttons
    const focusable = [...conflictModal.querySelectorAll("button")];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

conflictModal.addEventListener("click", (e) => {
  if (e.target === conflictModal) return closeConflictModal("cancel");
  const choice = e.target.closest("[data-conflict]")?.dataset.conflict;
  if (choice) closeConflictModal(choice);
});

/* -----------------------------------------------------------------------------
   SSE plumbing
   -------------------------------------------------------------------------- */
function parseSseChunk(buffer, onEvent) {
  const events = buffer.split("\n\n");
  const remainder = events.pop() || "";
  for (const raw of events) {
    const lines = raw.split("\n");
    const event = (lines.find((l) => l.startsWith("event:")) || "event: message").slice(6).trim();
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    onEvent(event, JSON.parse(dataLine.slice(5).trim()));
  }
  return remainder;
}

function handleEvent(event, payload) {
  if (event === "status") {
    if (payload.state === "running") {
      setStep(payload.step, "running");
      setRunHeader("running", `Step ${payload.step} of ${TOTAL_STEPS}`, payload.message.replace(/^Step \d+ \w+: /, ""));
    } else if (payload.state === "complete") {
      setStep(payload.step, "complete");
      updateProgress();
    }
  } else if (event === "error") {
    setStep(payload.step, "failed");
    updateProgress();
    setRunHeader("error", "Run failed", `Stopped at step ${payload.step || "?"}.`);
    showRunError(payload.error || "Onboarding failed.");
    showReviewError(payload.error || "Onboarding failed.");
    setPublishBusy(false);
  } else if (event === "review") {
    setRunHeader("idle", "Awaiting your review", "Assets are generated — approve to publish to Shopify, or discard.");
    renderReview(payload);
  } else if (event === "summary") {
    setRunHeader("success", "Onboarding complete", "All assets created and published.");
    progressFill.style.width = "100%";
    progressPct.textContent = "100%";
    progressText.textContent = `${TOTAL_STEPS} of ${TOTAL_STEPS} steps`;
    progressBar.setAttribute("aria-valuenow", "100");
    // Keep the review panel (gap report + email draft stay reachable) but
    // retire the action bar — this run is already published.
    clearReviewError();
    review.querySelector(".review-actions")?.remove();
    activeRunId = null;
    renderSummary(payload);
  }
}

// Defaults to the onboarding timeline handler; the catalog's create-product
// flow passes its own so it can drive the modal's progress bar instead.
async function readSseStream(res, onEvent = handleEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = parseSseChunk(buffer, onEvent);
  }
}

async function submitOnboarding() {
  const res = await fetch("/onboard", { method: "POST", body: new FormData(form) });

  if (res.status === 409) {
    const choice = await openConflictModal();
    if (choice === "cancel") {
      setRunHeader("idle", "Run canceled", "The existing Drive folder was left untouched.");
      addNotice("Run canceled — choose Overwrite or Use existing to continue.");
      return;
    }
    conflictStrategy.value = choice === "overwrite" ? "overwrite" : "skip";
    addNotice(choice === "overwrite" ? "Overwriting the existing Drive folder…" : "Reusing the existing Drive folder…");
    return submitOnboarding();
  }

  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: "Onboarding failed." }));
    setRunHeader("error", "Run failed", "The request could not be started.");
    showRunError(payload.error || "Onboarding failed.");
    if (payload.step) setStep(payload.step, "failed");
    return;
  }

  await readSseStream(res);
}

/* -----------------------------------------------------------------------------
   Events
   -------------------------------------------------------------------------- */
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!validate()) {
    setRunHeader("idle", "Check the form", "Fix the highlighted fields and run again.");
    return;
  }

  summary.hidden = true;
  summary.innerHTML = "";
  review.hidden = true;
  review.innerHTML = "";
  analysis.hidden = true;
  analysis.innerHTML = "";
  activeRunId = null;
  activeEmailDraft = null;
  conflictStrategy.value = "fail";
  resetTimeline();
  setRunHeader("running", "Starting…", "Uploading files and preparing the workspace.");

  analyzeButton.disabled = true;
  runButton.disabled = true;
  runButton.querySelector(".btn-label").textContent = "Running…";
  runButton.insertAdjacentHTML("afterbegin", '<span class="spinner" aria-hidden="true"></span>');

  try {
    await submitOnboarding();
  } catch (err) {
    setRunHeader("error", "Run failed", "An unexpected error interrupted the run.");
    showRunError(err.message || "Unexpected error.");
  } finally {
    analyzeButton.disabled = false;
    runButton.disabled = false;
    runButton.querySelector(".spinner")?.remove();
    runButton.querySelector(".btn-label").textContent = "Run onboarding";
  }
});

document.addEventListener("click", async (e) => {
  // remove a selected logo / policy
  const logoIdx = e.target.closest("[data-remove-logo]")?.dataset.removeLogo;
  if (logoIdx !== undefined) {
    setInputFiles(logoInput, [...logoInput.files].filter((_, i) => i !== Number(logoIdx)));
    renderLogoThumbs();
    return;
  }
  const policyIdx = e.target.closest("[data-remove-policy]")?.dataset.removePolicy;
  if (policyIdx !== undefined) {
    setInputFiles(policyInput, [...policyInput.files].filter((_, i) => i !== Number(policyIdx)));
    renderPolicyChips();
    return;
  }
  const followUpIdx = e.target.closest("[data-remove-followup]")?.dataset.removeFollowup;
  if (followUpIdx !== undefined) {
    setInputFiles(followUpInput, [...followUpInput.files].filter((_, i) => i !== Number(followUpIdx)));
    renderFollowUpChips();
    return;
  }

  // disconnect a service
  const disconnect = e.target.closest(".disconnect");
  if (disconnect) {
    const service = disconnect.dataset.service;
    const label = service === "shopify" ? "Shopify" : "Google Drive";
    if (!window.confirm(`Disconnect ${label}? You can connect a different account afterwards.`)) return;
    disconnect.disabled = true;
    try {
      const res = await fetch(`/auth/${service}/disconnect`, { method: "POST" });
      if (!res.ok) throw new Error("Disconnect failed");
      await refreshConnectionState();
    } catch {
      window.alert(`Could not disconnect ${label}. Please try again.`);
      disconnect.disabled = false;
    }
  }
});

departmentInput.addEventListener("input", () => {
  if (departmentInput.value.trim()) hideFieldError(departmentInput, departmentError);
});

analyzeButton.addEventListener("click", runAnalyze);

wireDropzone("logos", logoInput, renderLogoThumbs, isImage);
wireDropzone("policies", policyInput, renderPolicyChips, isDoc);
wireDropzone("intakeForms", intakeInput, renderIntakeChips, isDoc);
wireDropzone("followUps", followUpInput, renderFollowUpChips, isDoc);
refreshConnectionState();

/* =============================================================================
   DEPARTMENTS — browse and edit what is already live in Shopify.
   Each Shopify collection is one fire department.
   ========================================================================== */

const views = {
  dashboard: el("viewDashboard"),
  departments: el("viewDepartments"),
  department: el("viewDepartment"),
  onboarding: el("viewOnboarding"),
  newStores: el("viewNewStores"),
  storeDetail: el("viewStoreDetail")
};
const departmentsBody = el("departmentsBody");
const departmentDetailBody = el("departmentDetailBody");
const departmentSearch = el("departmentSearch");
const newStoresBody = el("newStoresBody");
const storeDetailBody = el("storeDetailBody");
const refreshNewStores = el("refreshNewStores");

// Collections are fetched once per visit and filtered client-side — the list is
// small (one entry per department) and filtering should feel instant.
let collectionsCache = null;
let currentCollection = null;

// Shopify is inconsistent about decimal places — priceRangeV2 returns "245.0"
// while a variant's own price field returns "27.00". Everything that displays
// or compares a price goes through these so the two forms never diverge.
function normalizePrice(amount) {
  const value = Number(amount);
  return Number.isFinite(value) ? value.toFixed(2) : "";
}

function samePrice(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) < 0.005;
}

function money(amount, currency) {
  if (amount === null || amount === undefined || amount === "") return "—";
  const value = normalizePrice(amount);
  if (!value) return "—";
  return `${value}${currency ? ` ${currency}` : ""}`;
}

function priceLabel(product) {
  const min = money(product.minPrice, "");
  if (product.maxPrice && product.maxPrice !== product.minPrice) {
    return `$${min} – $${money(product.maxPrice, "")}`;
  }
  return `$${min}`;
}

/* Shared empty / loading / error block so every async surface in this section
   renders its unhappy paths the same way. */
function stateBlock({ tone = "muted", title, sub = "", actionHtml = "", spinner = false }) {
  return `
    <div class="state-block" data-tone="${tone}">
      ${spinner ? '<span class="spinner state-spinner" aria-hidden="true"></span>' : ""}
      <p class="sb-title">${escapeHtml(title)}</p>
      ${sub ? `<p class="sb-sub">${escapeHtml(sub)}</p>` : ""}
      ${actionHtml}
    </div>`;
}

function statusChip(status) {
  const tone = { ACTIVE: "ok", DRAFT: "warn", ARCHIVED: "muted" }[status] || "muted";
  const label = { ACTIVE: "Active", DRAFT: "Draft", ARCHIVED: "Archived" }[status] || status;
  return `<span class="status-chip" data-tone="${tone}">${escapeHtml(label)}</span>`;
}
/* -----------------------------------------------------------------------------
   New Stores queue - customer intake review before running the store builder.
   -------------------------------------------------------------------------- */
// The queue is open unless the deploy turns the gate back on
// (FN_REQUIRE_ADMIN_TOKEN). Only prompt after the server has actually rejected
// a request, so the common case costs the operator nothing.
function adminTokenValue(force = false) {
  let token = sessionStorage.getItem("fnAdminToken") || "";
  if (!token && force) {
    token = window.prompt("This deploy requires an admin token for the New Stores queue:") || "";
    if (token) sessionStorage.setItem("fnAdminToken", token);
  }
  return token;
}

async function adminFetch(url, options = {}) {
  const token = adminTokenValue();
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", "Bearer " + token);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    // Gate is on for this deploy: ask once, then retry the same request.
    sessionStorage.removeItem("fnAdminToken");
    const retryToken = adminTokenValue(true);
    if (!retryToken) throw new Error("This deploy requires an admin token for the New Stores queue.");
    headers.set("Authorization", "Bearer " + retryToken);
    res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      sessionStorage.removeItem("fnAdminToken");
      throw new Error("Admin token was rejected. Open New Stores again and enter the current token.");
    }
  }
  return res;
}

function intakeStatusLabel(status) {
  return String(status || "new").replace(/-/g, " ");
}

/* Every intake status collapses onto the shared semantic palette, so a card,
   its chip, and its progress bar all read the same way. */
function intakeStatusTone(status) {
  const value = String(status || "new");
  if (/^built$/.test(value)) return "ok";
  if (/error|partial/.test(value)) return "warn";
  if (/building|planned|collection-created/.test(value)) return "info";
  return "muted";
}

function storeInitials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("") || "?";
}

function storeCardHtml(record) {
  const name = record.store?.departmentName || "Untitled department";
  const code = record.store?.departmentCode || "No code yet";
  const included = record.summary?.includedCount ?? 0;
  const products = record.summary?.productCount ?? included;
  const created = String(record.createdAt || "").slice(0, 10);
  const tone = intakeStatusTone(record.status);
  const build = record.build;
  const steps = build?.steps || [];
  const doneSteps = steps.filter((step) => step.state === "complete").length;
  const pct = steps.length ? Math.round((doneSteps / steps.length) * 100) : 0;
  const buildLine = build
    ? `<div class="store-card-progress" data-tone="${intakeStatusTone(build.state === "complete" ? "built" : build.state === "running" ? "building" : "build-error")}">
        <span class="scp-bar"><span style="width:${pct}%"></span></span>
        <small>${escapeHtml(build.state === "running" ? `Building — step ${Math.min(doneSteps + 1, steps.length)} of ${steps.length}` : `${build.products?.length || 0} product${(build.products?.length || 0) === 1 ? "" : "s"} · ${escapeHtml(build.state)}`)}</small>
      </div>`
    : `<div class="store-card-progress" data-tone="muted"><small>Not built yet</small></div>`;
  return `
    <a class="store-card" href="#/new-stores/${encodeURIComponent(record.id)}" data-tone="${tone}">
      <span class="store-card-badge" data-tone="${tone}" aria-hidden="true">${escapeHtml(storeInitials(name))}</span>
      <span class="store-card-body">
        <b>${escapeHtml(name)}</b>
        <small>${escapeHtml(code)} · ${included} categor${included === 1 ? "y" : "ies"} · ${products} garment${products === 1 ? "" : "s"}${created ? " · " + escapeHtml(created) : ""}</small>
        ${buildLine}
      </span>
      <em class="status-chip" data-tone="${tone}">${escapeHtml(intakeStatusLabel(record.status))}</em>
    </a>`;
}

function renderNewStoresShell(records) {
  if (!newStoresBody) return;
  if (!records.length) {
    newStoresBody.innerHTML = stateBlock({
      title: "No customer store requests yet",
      sub: "Share the customer intake link. Submissions will land here after they create the draft Shopify collection."
    });
    return;
  }
  newStoresBody.innerHTML = `<div class="store-card-grid">${records.map(storeCardHtml).join("")}</div>`;
}

/* The editor mirrors customerIntakes.js normalizeCategory EXACTLY. A field
   name that drifts from that schema is silently dropped by the server's
   normalize pass on save — which is how the previous version of this editor
   managed to discard every category edit an operator made. Categories carry a
   variants[] array: one entry per version of the garment (its own vendor,
   color, decoration, and logo assignment). */
const INTAKE_METHODS = ["Embroidery", "Screen Print", "Heat Transfer", "Patch", "None"];
const INTAKE_TIERS = ["Small", "Standard", "Large / Full Back", "Custom"];
const INTAKE_SIZE_RANGES = ["S-3XL", "S-5XL", "Youth sizes", "Women's cut", "Other"];

function intakeOption(items, selected) {
  const listed = items.includes(selected) || !selected
    ? ""
    : `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>`;
  return '<option value="">—</option>' + listed + items.map((item) =>
    `<option value="${escapeHtml(item)}" ${item === selected ? "selected" : ""}>${escapeHtml(item)}</option>`).join("");
}

/* Placement choices differ per category; offer what the customer form offers. */
const INTAKE_PLACEMENTS_BY_KEY = {
  "shorts": ["Left leg", "Right leg"],
  "sweatpants": ["Left leg", "Right leg"],
  "class-b-uniform-shirt": ["Left sleeve", "Right sleeve", "Both sleeves"],
  "class-b-uniform-pants": [],
  "belts": [],
  "hats": ["Front center", "Side"]
};

function intakePlacementsFor(key) {
  return INTAKE_PLACEMENTS_BY_KEY[key] ?? ["Front left chest", "Center back", "Left sleeve", "Right sleeve"];
}

function intakeLogoPicker(record, selectedSlugs) {
  const selected = new Set(selectedSlugs || []);
  const chips = (record.logos || []).map((logo) => {
    const thumb = String(logo.dataUrl || "").startsWith("data:image/")
      ? `<img src="${escapeHtml(logo.dataUrl)}" alt="">`
      : `<span class="logo-chip-doc" aria-hidden="true">${escapeHtml((String(logo.name || "file").split(".").pop() || "file").toUpperCase().slice(0, 4))}</span>`;
    return `<label class="logo-chip"><input type="checkbox" name="logoPick" value="${escapeHtml(logo.name)}" ${selected.has(logo.name) ? "checked" : ""}>${thumb}<span class="logo-chip-name">${escapeHtml(logo.name)}</span></label>`;
  }).join("");
  return `<div class="logo-pick">${chips || '<span class="logo-pick-empty">No logo files stored on this request.</span>'}</div>`;
}

/* One decorated spot of a variant: placement + artwork size + its logo set.
   Rendered as its own removable row so a garment can carry several. */
function intakeDecorationEditor(record, decoration, index, count, placements) {
  return `
    <div class="decoration-editor" data-decoration-index="${index}">
      <div class="decoration-head">
        <span>Decoration ${index + 1}${count > 1 ? ` of ${count}` : ""}</span>
        <button type="button" class="variant-remove" data-remove-intake-decoration ${count === 1 ? "hidden" : ""} aria-label="Remove decoration ${index + 1}">&times;</button>
      </div>
      <div class="category-edit-grid">
        <label><span>Placement</span><select name="decoPlacement">${intakeOption(placements, decoration.placement)}</select></label>
        <label><span>Size tier</span><select name="decoSizeTier">${intakeOption(INTAKE_TIERS, decoration.sizeTier)}</select></label>
        <label><span>Custom tier size</span><input name="decoCustomSizeTier" value="${escapeHtml(decoration.customSizeTier || "")}"></label>
      </div>
      <div class="ce-logos">
        <span class="ce-logos-label">Logos on this spot <small>none selected = every uploaded logo offered here</small></span>
        ${intakeLogoPicker(record, decoration.logoSlugs)}
      </div>
    </div>`;
}

function intakeVariantEditor(record, variant, index, count, placements) {
  // Records normalized before 2026-08-28 carry the flat placement fields only;
  // render them as decoration 1 exactly the way the server synthesizes them.
  const decorations = Array.isArray(variant.decorations) && variant.decorations.length
    ? variant.decorations
    : (variant.placement || variant.sizeTier || variant.customSizeTier || (variant.logoSlugs || []).length)
      ? [{ placement: variant.placement, sizeTier: variant.sizeTier, customSizeTier: variant.customSizeTier, logoSlugs: variant.logoSlugs }]
      : [{ placement: "", sizeTier: "", customSizeTier: "", logoSlugs: [] }];
  return `
    <fieldset class="variant-editor" data-variant-id="${escapeHtml(variant.id || "v" + (index + 1))}">
      <div class="variant-head">
        <span class="variant-title">Version ${index + 1}</span>
        <button type="button" class="variant-remove" data-remove-intake-variant ${count === 1 ? "hidden" : ""} aria-label="Remove version ${index + 1}">&times;</button>
      </div>
      <div class="category-edit-grid">
        <label><span>Vendor / brand</span><input name="vendor" value="${escapeHtml(variant.vendor || "")}" placeholder="Sourcing agent pulls this vendor's photo"></label>
        <label><span>Style number</span><input name="styleNumber" value="${escapeHtml(variant.styleNumber || "")}"></label>
        <label><span>Color(s)</span><input name="colors" value="${escapeHtml(variant.colors || "")}"></label>
        <label><span>Style notes</span><input name="style" value="${escapeHtml(variant.style || "")}"></label>
        <label><span>Decoration method</span><select name="decorationMethod">${intakeOption(INTAKE_METHODS, variant.decorationMethod)}</select></label>
        <label><span>Name/rank right chest</span><select name="nameRank">
          <option value="" ${!variant.nameRank ? "selected" : ""}>—</option>
          <option value="yes" ${variant.nameRank === "yes" ? "selected" : ""}>Yes</option>
          <option value="no" ${variant.nameRank === "no" ? "selected" : ""}>No</option>
        </select></label>
        <label><span>Size range</span><select name="sizeRange">${intakeOption(INTAKE_SIZE_RANGES, variant.sizeRange)}</select></label>
        <label><span>Other sizes</span><input name="otherSizes" value="${escapeHtml(variant.otherSizes || "")}"></label>
        <label><span>Version notes</span><input name="notes" value="${escapeHtml(variant.notes || "")}"></label>
        <label><span>Logo notes${variant.logoNotes ? "" : " (legacy)"}</span><input name="logoNotes" value="${escapeHtml(variant.logoNotes || "")}" placeholder="Free-text assignment from older intakes"></label>
      </div>
      <div class="decoration-editor-list" data-placements="${escapeHtml(JSON.stringify(placements))}">
        ${decorations.map((decoration, decorationIndex) => intakeDecorationEditor(record, decoration, decorationIndex, decorations.length, placements)).join("")}
      </div>
      <div class="variant-actions decoration-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-add-intake-decoration>+ Add decoration spot</button>
      </div>
    </fieldset>`;
}

function categoryEditor(record, category) {
  const isBelt = category.key === "belts";
  const variants = category.variants?.length ? category.variants : [category];
  const versionNote = !isBelt && variants.length > 1 ? ` · ${variants.length} versions` : "";
  const placements = intakePlacementsFor(category.key);

  const body = isBelt
    ? `<div class="category-edit-grid">
        <label><span>Belt style</span><input name="beltStyle" value="${escapeHtml(category.beltStyle || "")}"></label>
        <label><span>Notes</span><input name="categoryNotes" value="${escapeHtml(category.notes || "")}"></label>
      </div>`
    : `<div class="variant-editor-list">
        ${variants.map((variant, index) => intakeVariantEditor(record, variant, index, variants.length, placements)).join("")}
      </div>
      <div class="variant-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-add-intake-variant>+ Add version</button>
      </div>
      <div class="category-edit-grid">
        <label class="span-2"><span>Category notes</span><input name="categoryNotes" value="${escapeHtml(category.notes || "")}"></label>
      </div>`;

  return `
    <details class="intake-category-editor" data-category-key="${escapeHtml(category.key)}" ${category.include ? "open" : ""}>
      <summary>
        <span>${escapeHtml(category.title)}</span>
        <em>${category.include ? "Included" + versionNote : "Skipped"}</em>
      </summary>
      <div class="category-editor-body">
        <label class="ce-include"><input type="checkbox" name="include" ${category.include ? "checked" : ""}> <span>Include this category</span></label>
        ${body}
      </div>
    </details>`;
}

function collectEditedIntake(record) {
  const panel = el("storeReviewPanel");
  const next = structuredClone(record);
  next.store = {
    ...next.store,
    departmentName: panel.querySelector("[data-store-field='departmentName']")?.value.trim() || next.store.departmentName,
    departmentCode: panel.querySelector("[data-store-field='departmentCode']")?.value.trim() || next.store.departmentCode,
    contactName: panel.querySelector("[data-store-field='contactName']")?.value.trim() || next.store.contactName,
    contactEmail: panel.querySelector("[data-store-field='contactEmail']")?.value.trim() || next.store.contactEmail,
    contactPhone: panel.querySelector("[data-store-field='contactPhone']")?.value.trim() ?? next.store.contactPhone,
    notes: panel.querySelector("[data-store-field='notes']")?.value.trim() || ""
  };
  next.categories = next.categories.map((category) => {
    const node = panel.querySelector(`[data-category-key="${CSS.escape(category.key)}"]`);
    if (!node) return category;
    const include = Boolean(node.querySelector("[name='include']")?.checked);
    const notes = node.querySelector("[name='categoryNotes']")?.value.trim() ?? category.notes ?? "";
    const beltInput = node.querySelector("[name='beltStyle']");
    if (beltInput) {
      return { key: category.key, title: category.title, include, notes, beltStyle: beltInput.value.trim() };
    }
    const variants = [...node.querySelectorAll(".variant-editor")].map((block, index) => {
      const read = (name) => block.querySelector(`[name='${name}']`)?.value.trim() ?? "";
      const sizeRange = read("sizeRange");
      const decorations = [...block.querySelectorAll(".decoration-editor")].map((decorationNode) => {
        const readDecoration = (name) => decorationNode.querySelector(`[name='${name}']`)?.value.trim() ?? "";
        return {
          placement: readDecoration("decoPlacement"),
          sizeTier: readDecoration("decoSizeTier"),
          customSizeTier: readDecoration("decoCustomSizeTier"),
          logoSlugs: [...decorationNode.querySelectorAll("[name='logoPick']:checked")].map((input) => input.value)
        };
      });
      const first = decorations[0] || {};
      return {
        id: block.dataset.variantId || `v${index + 1}`,
        vendor: read("vendor"),
        styleNumber: read("styleNumber"),
        colors: read("colors"),
        style: read("style"),
        decorationMethod: read("decorationMethod"),
        decorations,
        // Flat mirrors of decoration 1, matching the server's normalization -
        // legacy consumers keep reading the same shape.
        sizeTier: first.sizeTier || "",
        customSizeTier: first.customSizeTier || "",
        placement: first.placement || "",
        logoSlugs: first.logoSlugs || [],
        // logoNotes carries legacy free-text assignments; dropping it here
        // silently destroyed them on the next save (the historic silent-drop
        // bug class this file warns about).
        logoNotes: read("logoNotes"),
        nameRank: read("nameRank"),
        sizeRange,
        // A stale custom-size value with a preset range must not ride along -
        // the builder gives custom sizes precedence.
        otherSizes: sizeRange === "Other" ? read("otherSizes") : "",
        notes: read("notes")
      };
    });
    // Fresh objects on purpose: carrying the old flat mirror fields alongside
    // edited variants would just be stale duplicates - the server recomputes
    // the mirror from variants[0]. logoChoice is the one exception: it is not
    // derivable from the fields this editor renders, and legacy free-text
    // assignments (logoChoice "additional" + logoNotes) die without it.
    return { key: category.key, title: category.title, include, notes, logoChoice: category.logoChoice, variants };
  });
  return next;
}

async function saveCustomerIntake(record, status = "in-review") {
  const edited = collectEditedIntake(record);
  // Never send derived or server-owned state back. `build` especially: the
  // snapshot in this editor goes stale the moment the builder writes a step,
  // and PATCHing it back would overwrite live build progress. Same for the
  // collection pointer - nulling it would un-protect the store from cleanup.
  delete edited.build;
  delete edited.shopifyCollection;
  delete edited.summary;
  delete edited.driveFile;
  const res = await adminFetch(`/api/customer-intakes/${encodeURIComponent(record.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ ...edited, status })
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || "Could not save the customer store request.");
  return payload.intake;
}

// The old "load into the onboarding form" handoff is gone on purpose: the
// build runs directly from the record now (Build store now / auto-build on
// submit), so there is no manual re-entry step for customer intakes.

/* -----------------------------------------------------------------------------
   Build progress. The intake record carries the build state (written step by
   step by the server), so this is a pure render of what Drive says - it
   survives page reloads and server restarts.
   -------------------------------------------------------------------------- */
function buildStateTone(state) {
  return { running: "info", interrupted: "warn", complete: "ok", partial: "warn", failed: "warn" }[state] || "muted";
}

function buildPanelHtml(record) {
  const build = record.build;
  if (!build) {
    return `<div class="build-panel" data-state="idle">
      <p class="muted">Not built yet. Submitting the form normally starts the build automatically; use the button if it needs a kick or a re-run.</p>
    </div>`;
  }
  const steps = (build.steps || []).map((step) => `
    <li data-state="${escapeHtml(step.state)}">
      <b>${escapeHtml(step.label)}</b>
      <span>${escapeHtml(step.detail || (step.state === "running" ? "Working…" : ""))}</span>
    </li>`).join("");
  const products = (build.products || []).map((product) => `
    <a class="build-product" href="${escapeHtml(product.url)}" target="_blank" rel="noreferrer">
      <b>${escapeHtml(product.title)}</b>
      <span>${escapeHtml(product.status)} · ${escapeHtml(String(product.variantCount))} variants · ${escapeHtml(product.blankSource)}${product.vendor ? " · " + escapeHtml(product.vendor) : ""}</span>
    </a>`).join("");
  return `<div class="build-panel" data-state="${escapeHtml(build.state)}">
    ${build.state === "interrupted" ? `<p class="muted">The server restarted mid-build. It resumes automatically within a couple of minutes — already-built products are kept, only the missing ones are built.</p>` : ""}
    <div class="build-head">
      <span class="status-chip" data-tone="${buildStateTone(build.state)}">${escapeHtml(build.state)}</span>
      ${build.error ? `<span class="build-error">${escapeHtml(build.error)}</span>` : ""}
    </div>
    <ul class="build-steps">${steps}</ul>
    ${products ? `<div class="build-products">${products}</div>` : ""}
  </div>`;
}

let buildPollTimer = null;
function pollBuild(id) {
  clearTimeout(buildPollTimer);
  const stillOpen = () => {
    const route = parseRoute();
    return route.name === "storeDetail" && route.id === id;
  };
  buildPollTimer = setTimeout(async () => {
    if (!stillOpen()) return;
    try {
      const res = await adminFetch(`/api/customer-intakes/${encodeURIComponent(id)}`);
      const payload = await res.json().catch(() => ({}));
      if (res.ok && payload.intake && stillOpen()) {
        const record = payload.intake;
        // Surgical repaint: only the build panel and the build button. A full
        // page repaint every 5s would wipe whatever the operator is typing.
        const panel = el("storeReviewPanel");
        const buildNode = panel?.querySelector(".build-panel");
        if (buildNode) buildNode.outerHTML = buildPanelHtml(record);
        const btn = panel?.querySelector("[data-build-intake]");
        if (btn) {
          const running = record.build?.state === "running";
          btn.disabled = running;
          btn.textContent = running ? "Building…" : record.build ? "Re-run build" : "Build store now";
        }
        // "interrupted" keeps polling too: the watchdog resumes it within a
        // couple of minutes and the panel must go live again on its own.
        if (record.build?.state === "running" || record.build?.state === "interrupted") pollBuild(id);
        else {
          // The build just finished: the showcase and Drive listing have new
          // product images and files to show.
          loadStoreProducts(record);
          loadStoreDrive(record);
        }
      } else if (!res.ok && stillOpen()) {
        // A transient 500/502 must not end polling for good - the panel would
        // freeze on "Building…" until a manual reload.
        pollBuild(id);
      }
    } catch (error) {
      // Transient network error: keep polling as long as the operator is
      // still looking at this record, or the panel freezes on stale state.
      // EXCEPT a cancelled admin-token prompt - re-arming would reopen the
      // blocking prompt every 5 seconds.
      if (stillOpen() && !/admin token/i.test(String(error?.message || ""))) pollBuild(id);
    }
  }, 5000);
}

/* -----------------------------------------------------------------------------
   Store detail page (#/new-stores/:id). One full page per customer store:
   the floating product showcase, live build progress, the intake rendered as
   a printable document, the Drive folder contents, and the editor whose
   vendor/color/logo fields feed the sourcing agent on the next build.
   -------------------------------------------------------------------------- */

let storeDocCache = null;

function shopifyProductUrl(record, productId) {
  const match = String(record.shopifyCollection?.url || "").match(/^(.*)\/collections\/\d+/);
  return match ? `${match[1]}/products/${productId}` : "";
}

async function loadStoreProducts(record) {
  const panel = el("storeProductsPanel");
  if (!panel) return;
  const collectionId = record.shopifyCollection?.id;
  if (!collectionId) {
    panel.hidden = true;
    return;
  }
  try {
    const res = await fetch(`/api/collections/${encodeURIComponent(collectionId)}`);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Could not load collection products.");
    const products = payload.products || [];
    if (!products.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    // The collection payload is pure Shopify data; the supplier source page
    // (order-this-blank URL) only exists on the build record. Joined by the
    // numeric product id, with a title fallback for records built before ids
    // were stored.
    const builtByProduct = new Map();
    for (const entry of record.build?.products || []) {
      if (entry.productId) builtByProduct.set(String(entry.productId), entry);
      if (entry.title) builtByProduct.set(String(entry.title).toLowerCase(), entry);
    }
    panel.innerHTML = `
      <div class="card-head">
        <div>
          <p class="eyebrow">The store so far</p>
          <h3>${products.length} product${products.length === 1 ? "" : "s"} in ${escapeHtml(payload.collection?.title || "the collection")}</h3>
        </div>
        <a class="btn btn-secondary btn-sm" href="#/departments/${encodeURIComponent(collectionId)}">Manage products</a>
      </div>
      <div class="float-shelf">
        ${products.map((product, index) => {
          const url = shopifyProductUrl(record, product.id);
          const media = product.imageUrl
            ? `<img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.imageAlt || product.title)}" loading="lazy">`
            : `<span class="pg-noimg" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></span>`;
          const inner = `
            <span class="float-media" style="--float-delay:${(index % 8) * 0.4}s">${media}</span>
            <span class="float-shadow" aria-hidden="true"></span>
            <b>${escapeHtml(product.title)}</b>
            <small>${escapeHtml(product.status)} · ${product.variantCount} variant${product.variantCount === 1 ? "" : "s"}</small>`;
          const card = url
            ? `<a class="float-card" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${inner}</a>`
            : `<span class="float-card">${inner}</span>`;
          // The card is itself an anchor, so the supplier link must live as a
          // sibling below it, never nested inside.
          const built = builtByProduct.get(String(product.id)) || builtByProduct.get(String(product.title || "").toLowerCase());
          const sourceLine = built?.blankSourceUrl
            ? `<a class="float-source" href="${escapeHtml(built.blankSourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(built.vendor || "supplier")} blank ↗</a>`
            : built && String(built.blankSource || "").startsWith("generated")
              ? `<span class="float-source is-muted">generated blank · no source page</span>`
              : "";
          return `<div class="float-item">${card}${sourceLine}</div>`;
        }).join("")}
      </div>`;
  } catch {
    panel.hidden = true;
  }
}

async function loadStoreDocument(record) {
  if (!el("storeDocBody")) return;
  // Re-queried after every await: a slow response for a record the operator
  // has already navigated away from must not overwrite the cache the Download
  // PDF button prints, or the popup would print the WRONG store's intake.
  const stillOpen = () => el("storeReviewPanel")?.dataset.intakeId === record.id;
  try {
    const res = await adminFetch(`/api/customer-intakes/${encodeURIComponent(record.id)}/document`);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Could not render the intake document.");
    if (!stillOpen()) return;
    storeDocCache = {
      html: payload.html,
      title: `Store Intake — ${payload.departmentName || record.store.departmentName || "Untitled"}`
    };
    // Server-generated and fully escaped in customerIntakes.intakeDocumentHtml.
    const body = el("storeDocBody");
    if (body) body.innerHTML = payload.html;
    const print = document.querySelector("[data-print-doc]");
    if (print) print.disabled = false;
  } catch (error) {
    if (!stillOpen()) return;
    const body = el("storeDocBody");
    if (body) body.innerHTML = stateBlock({ tone: "warn", title: "Document unavailable", sub: error.message });
  }
}

function printStoreDocument() {
  if (!storeDocCache) return;
  const win = window.open("", "_blank");
  if (!win) {
    window.alert("Allow pop-ups for this site to download the intake PDF.");
    return;
  }
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(storeDocCache.title)}</title>
    <style>
      body { font: 14px/1.55 "Segoe UI", system-ui, sans-serif; color: #16202b; margin: 40px auto; max-width: 760px; padding: 0 24px; }
      h1 { font-size: 24px; margin: 0 0 4px; }
      h1 + p { color: #4d5a6a; margin-top: 0; }
      h2 { font-size: 16px; margin: 28px 0 8px; border-bottom: 1px solid #ccd4dd; padding-bottom: 4px; }
      h3 { font-size: 12px; margin: 14px 0 6px; color: #4d5a6a; text-transform: uppercase; letter-spacing: .05em; }
      table { border-collapse: collapse; width: 100%; font-size: 13px; }
      td { border-bottom: 1px solid #e6ebf1; }
      @media print { body { margin: 0; } }
    </style></head><body>${storeDocCache.html}<script>window.onload = function () { window.print(); };<\/script></body></html>`);
  win.document.close();
}

async function loadStoreDrive(record) {
  const body = el("storeDriveBody");
  const open = el("storeDriveOpen");
  if (!body) return;
  const fileIcon = (mimeType) => {
    const mime = String(mimeType || "");
    if (mime.startsWith("image/")) {
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
    }
    if (mime.includes("google-apps.document") || mime.includes("pdf")) {
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  };
  try {
    const res = await adminFetch(`/api/customer-intakes/${encodeURIComponent(record.id)}/drive`);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Could not list the Drive folder.");
    if (!payload.connected) {
      body.innerHTML = stateBlock({ title: "Google Drive is not connected", sub: "Connect Drive on the Connections page to archive store assets." });
      return;
    }
    if (!payload.folder) {
      body.innerHTML = stateBlock({ title: "No Drive folder yet", sub: "The department folder is created on the first store build." });
      return;
    }
    if (open) {
      open.href = payload.folder.url;
      open.hidden = false;
    }
    const groups = (payload.groups || []).filter((group) => group.files?.length);
    body.innerHTML = groups.map((group) => `
      <div class="drive-group">
        <p class="drive-group-name">${escapeHtml(group.name)} <small>${group.files.length} file${group.files.length === 1 ? "" : "s"}</small></p>
        <ul class="drive-files">
          ${group.files.map((file) => `
            <li><a href="${escapeHtml(file.webViewLink || payload.folder.url)}" target="_blank" rel="noreferrer">
              ${fileIcon(file.mimeType)}<span>${escapeHtml(file.name)}</span>
              <small>${escapeHtml(String(file.modifiedTime || "").slice(0, 10))}</small>
            </a></li>`).join("")}
        </ul>
      </div>`).join("") || stateBlock({ title: "The folder is empty", sub: "Assets land here during the store build." });
  } catch (error) {
    body.innerHTML = stateBlock({ tone: "warn", title: "Drive listing unavailable", sub: error.message });
  }
}

function renumberIntakeVariants(list) {
  const blocks = [...list.querySelectorAll(".variant-editor")];
  blocks.forEach((block, index) => {
    block.querySelector(".variant-title").textContent = `Version ${index + 1}`;
    const remove = block.querySelector("[data-remove-intake-variant]");
    if (remove) {
      remove.hidden = blocks.length === 1;
      remove.setAttribute("aria-label", `Remove version ${index + 1}`);
    }
  });
}

function renumberIntakeDecorations(list) {
  const blocks = [...list.querySelectorAll(".decoration-editor")];
  blocks.forEach((block, index) => {
    block.dataset.decorationIndex = String(index);
    const title = block.querySelector(".decoration-head span");
    if (title) title.textContent = `Decoration ${index + 1}${blocks.length > 1 ? ` of ${blocks.length}` : ""}`;
    const remove = block.querySelector("[data-remove-intake-decoration]");
    if (remove) {
      remove.hidden = blocks.length === 1;
      remove.setAttribute("aria-label", `Remove decoration ${index + 1}`);
    }
  });
}

function renderStoreDetail(record) {
  if (!storeDetailBody) return;
  storeDocCache = null;
  const collectionUrl = record.shopifyCollection?.url || "";
  const building = record.build?.state === "running";
  const tone = intakeStatusTone(record.status);
  const created = String(record.createdAt || "").slice(0, 10);
  storeDetailBody.innerHTML = `
    <div class="store-detail" id="storeReviewPanel" data-intake-id="${escapeHtml(record.id)}">
      <nav class="crumbs" aria-label="Breadcrumb">
        <a href="#/new-stores">New Stores</a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">${escapeHtml(record.store.departmentName || "Store request")}</span>
      </nav>
      <header class="store-detail-head card card-pad">
        <div>
          <p class="eyebrow">Customer store</p>
          <h2>${escapeHtml(record.store.departmentName || "Customer store request")}</h2>
          <p class="sdh-meta">
            <span class="status-chip" data-tone="${tone}">${escapeHtml(intakeStatusLabel(record.status))}</span>
            <span>${escapeHtml(record.requestId.slice(0, 8).toUpperCase())}</span>
            ${created ? `<span>submitted ${escapeHtml(created)}</span>` : ""}
            ${record.store.contactName ? `<span>${escapeHtml(record.store.contactName)}${record.store.contactEmail ? " · " + escapeHtml(record.store.contactEmail) : ""}</span>` : ""}
          </p>
        </div>
        <div class="store-review-actions">
          ${collectionUrl ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(collectionUrl)}" target="_blank" rel="noreferrer">Open Shopify collection</a>` : ""}
          <a class="btn btn-secondary btn-sm" id="storeDriveOpen" href="#" target="_blank" rel="noreferrer" hidden>Open Drive folder</a>
          <button class="btn btn-secondary btn-sm" type="button" data-print-doc disabled>Download PDF</button>
          <button class="btn btn-secondary btn-sm" type="button" data-save-intake>Save edits</button>
          <button class="btn btn-primary btn-sm" type="button" data-build-intake ${building ? "disabled" : ""}>
            ${building ? "Building…" : record.build ? "Re-run build" : "Build store now"}
          </button>
          <button class="btn btn-danger btn-sm" type="button" data-delete-intake ${building ? "disabled" : ""}>Delete store</button>
        </div>
      </header>
      <section class="card card-pad store-products-panel" id="storeProductsPanel" hidden></section>
      ${buildPanelHtml(record)}
      <div class="store-detail-grid">
        <section class="card card-pad store-doc-panel">
          <div class="card-head">
            <div><p class="eyebrow">Intake document</p><h3>What the customer filled</h3></div>
          </div>
          <div class="store-doc" id="storeDocBody">${stateBlock({ title: "Rendering the intake document", spinner: true })}</div>
        </section>
        <section class="card card-pad store-drive-panel">
          <div class="card-head">
            <div><p class="eyebrow">Google Drive</p><h3>Folder contents</h3></div>
          </div>
          <div id="storeDriveBody">${stateBlock({ title: "Listing Drive files", spinner: true })}</div>
        </section>
      </div>
      <section class="card card-pad">
        <div class="card-head">
          <div>
            <p class="eyebrow">Edit request</p>
            <h3>Store &amp; garment details</h3>
            <p class="muted">Vendor, colors, and logo assignments here feed the sourcing agent on the next build.</p>
          </div>
        </div>
        <div class="store-edit-grid">
          <label><span>Department name</span><input data-store-field="departmentName" value="${escapeHtml(record.store.departmentName)}"></label>
          <label><span>Department code</span><input data-store-field="departmentCode" value="${escapeHtml(record.store.departmentCode)}"></label>
          <label><span>Contact name</span><input data-store-field="contactName" value="${escapeHtml(record.store.contactName)}"></label>
          <label><span>Contact email</span><input data-store-field="contactEmail" value="${escapeHtml(record.store.contactEmail)}"></label>
          <label><span>Contact phone</span><input data-store-field="contactPhone" value="${escapeHtml(record.store.contactPhone)}"></label>
          <label class="span-2"><span>Internal/customer notes</span><textarea data-store-field="notes" rows="3">${escapeHtml(record.store.notes)}</textarea></label>
        </div>
        <div class="logo-strip">
          ${(record.logos || []).map((logo) => logo.dataUrl?.startsWith("data:image/")
            ? `<img src="${escapeHtml(logo.dataUrl)}" alt="${escapeHtml(logo.name)}">`
            : `<span>${escapeHtml(logo.name)}</span>`).join("") || "<span>No logo file stored</span>"}
        </div>
        <div class="category-editor-stack">
          ${record.categories.map((category) => categoryEditor(record, category)).join("")}
        </div>
      </section>
    </div>`;

  const panel = el("storeReviewPanel");

  panel.querySelector("[data-print-doc]")?.addEventListener("click", printStoreDocument);

  panel.querySelector(".category-editor-stack")?.addEventListener("click", (event) => {
    const add = event.target.closest("[data-add-intake-variant]");
    if (add) {
      const details = add.closest(".intake-category-editor");
      const list = details.querySelector(".variant-editor-list");
      const count = list.querySelectorAll(".variant-editor").length;
      const placements = intakePlacementsFor(details.dataset.categoryKey);
      list.insertAdjacentHTML(
        "beforeend",
        intakeVariantEditor(record, { id: `v${Date.now().toString(36)}` }, count, count + 1, placements)
      );
      renumberIntakeVariants(list);
    }
    const remove = event.target.closest("[data-remove-intake-variant]");
    if (remove) {
      const details = remove.closest(".intake-category-editor");
      const list = remove.closest(".variant-editor-list");
      remove.closest(".variant-editor").remove();
      renumberIntakeVariants(list);
      // The focused button just left the DOM; without this, keyboard focus
      // falls to <body> and the operator re-tabs from the top of the page.
      details.querySelector("[data-add-intake-variant]")?.focus();
    }

    const addDecoration = event.target.closest("[data-add-intake-decoration]");
    if (addDecoration) {
      const variantEditor = addDecoration.closest(".variant-editor");
      const list = variantEditor.querySelector(".decoration-editor-list");
      let placements = [];
      try {
        placements = JSON.parse(list.dataset.placements || "[]");
      } catch {
        placements = [];
      }
      const count = list.querySelectorAll(".decoration-editor").length;
      list.insertAdjacentHTML(
        "beforeend",
        intakeDecorationEditor(record, { placement: "", sizeTier: "", customSizeTier: "", logoSlugs: [] }, count, count + 1, placements)
      );
      renumberIntakeDecorations(list);
    }
    const removeDecoration = event.target.closest("[data-remove-intake-decoration]");
    if (removeDecoration) {
      const variantEditor = removeDecoration.closest(".variant-editor");
      const list = removeDecoration.closest(".decoration-editor-list");
      removeDecoration.closest(".decoration-editor").remove();
      renumberIntakeDecorations(list);
      variantEditor.querySelector("[data-add-intake-decoration]")?.focus();
    }
  });

  panel.querySelector("[data-delete-intake]")?.addEventListener("click", async (event) => {
    const name = record.store.departmentName || "this store";
    const productCount = (record.build?.products || []).length;
    // Two explicit gates before anything leaves the browser: an itemized
    // confirm, then the department name typed back verbatim.
    const first = window.confirm(
      `Delete the "${name}" store COMPLETELY?\n\nThis permanently removes:\n` +
      `  • the Shopify collection and every product in it${productCount ? ` (${productCount} recorded)` : ""}\n` +
      `  • the Google Drive folder (moved to Drive trash)\n` +
      `  • this store request and its build history\n\nThere is no undo from this console.`
    );
    if (!first) return;
    const typed = window.prompt(`Final check — type the department name exactly to delete it:\n\n${name}`);
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== name.toLowerCase()) {
      window.alert("The name did not match. Nothing was deleted.");
      return;
    }

    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "Deleting…";
    try {
      const res = await adminFetch(`/api/customer-intakes/${encodeURIComponent(record.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmName: typed.trim() })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || "Could not delete the store.");
      const problems = (payload.errors || []).length ? `\n\nCompleted with warnings:\n${payload.errors.join("\n")}` : "";
      window.alert(
        `"${name}" deleted: ${payload.deletedProducts.length} product${payload.deletedProducts.length === 1 ? "" : "s"}, ` +
        `collection ${payload.collectionDeleted ? "removed" : "not found"}, Drive folder ${payload.driveFolderTrashed ? "trashed" : "not found"}.${problems}`
      );
      window.location.hash = "#/new-stores";
    } catch (error) {
      window.alert(error.message);
      btn.disabled = false;
      btn.textContent = "Delete store";
    }
  });

  panel.querySelector("[data-save-intake]")?.addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "Saving...";
    try {
      const saved = await saveCustomerIntake(record, "in-review");
      renderStoreDetail(saved);
      loadStoreProducts(saved);
      loadStoreDocument(saved);
      loadStoreDrive(saved);
    } catch (error) {
      window.alert(error.message);
      btn.disabled = false;
      btn.textContent = "Save edits";
    }
  });

  panel.querySelector("[data-build-intake]")?.addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "Starting…";
    try {
      const res = await adminFetch(`/api/customer-intakes/${encodeURIComponent(record.id)}/build`, {
        method: "POST",
        body: JSON.stringify({})
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || "Could not start the build.");
      btn.textContent = "Building…";
      pollBuild(record.id);
    } catch (error) {
      window.alert(error.message);
      btn.disabled = false;
      btn.textContent = record.build ? "Re-run build" : "Build store now";
    }
  });

  // Keep the panel live while the server is building, and while an
  // interrupted build waits for the watchdog to resume it.
  if (record.build?.state === "running" || record.build?.state === "interrupted") pollBuild(record.id);
}

async function loadStoreDetail(id) {
  if (!storeDetailBody) return;
  storeDetailBody.innerHTML = stateBlock({ title: "Loading store request", spinner: true });
  try {
    const res = await adminFetch(`/api/customer-intakes/${encodeURIComponent(id)}`);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Could not open that store request.");
    renderStoreDetail(payload.intake);
    loadStoreProducts(payload.intake);
    loadStoreDocument(payload.intake);
    loadStoreDrive(payload.intake);
  } catch (error) {
    storeDetailBody.innerHTML = stateBlock({
      tone: "warn",
      title: "Could not open store request",
      sub: error.message,
      actionHtml: '<a class="btn btn-secondary btn-sm" href="#/new-stores">Back to New Stores</a>'
    });
  }
}

async function loadNewStores() {
  if (!newStoresBody) return;
  newStoresBody.innerHTML = stateBlock({ title: "Loading customer store requests", spinner: true });
  try {
    const res = await adminFetch("/api/customer-intakes");
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Could not load customer store requests.");
    renderNewStoresShell(payload.intakes || []);
  } catch (error) {
    newStoresBody.innerHTML = stateBlock({
      tone: "warn",
      title: "New Stores queue needs the admin token",
      sub: error.message,
      actionHtml: '<button class="btn btn-secondary btn-sm" type="button" id="retryNewStores">Enter token</button>'
    });
    el("retryNewStores")?.addEventListener("click", () => {
      sessionStorage.removeItem("fnAdminToken");
      loadNewStores();
    });
  }
}
/* -----------------------------------------------------------------------------
   Company Brain (dashboard chat)
   -------------------------------------------------------------------------- */
const brainThread = el("brainThread");
const brainForm = el("brainForm");
const brainInput = el("brainInput");
const platformStatusList = el("platformStatusList");
const agentModelPill = el("agentModelPill");
let agentHistory = [];
let brainBusy = false;

function yesNo(value) {
  return value ? "Connected" : "Not connected";
}

function renderPlatformStatus(status) {
  if (!platformStatusList || !status) return;
  const genAI = status.genAI || {};
  const genAIText = genAI.configured
    ? genAI.provider === "azure-openai"
      ? "Azure OpenAI - " + (genAI.chatDeployment || "chat")
      : "OpenAI API fallback"
    : "Not configured";

  platformStatusList.innerHTML = [
    ["Shopify", yesNo(status.shopifyConnected)],
    ["Google Drive", status.googleDriveConnected ? yesNo(true) + (status.googleAccountCount > 1 ? " - " + status.googleAccountCount + " accounts" : "") : yesNo(false)],
    ["GenAI", genAIText],
    ["Postgres", status.postgresConfigured ? "Configured" : "Planned"],
    ["Key Vault", status.keyVaultConfigured ? "Configured" : "Planned"],
    ["Storage", status.storageConfigured ? "Configured" : "Planned"]
  ]
    .map(([label, value]) => '<div class="status-line"><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(value) + '</b></div>')
    .join("");

  if (agentModelPill) {
    agentModelPill.dataset.state = genAI.configured ? "ready" : "attention";
    agentModelPill.querySelector(".txt").textContent = genAI.configured ? genAIText : "GenAI not configured";
  }
}

async function loadPlatformStatus() {
  if (!platformStatusList) return;
  try {
    const res = await fetch("/api/platform/status");
    const status = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(status.error || "Could not load platform status.");
    renderPlatformStatus(status);
  } catch (error) {
    platformStatusList.innerHTML = '<div class="status-line"><span>Status</span><b>' + escapeHtml(error.message) + '</b></div>';
    if (agentModelPill) {
      agentModelPill.dataset.state = "attention";
      agentModelPill.querySelector(".txt").textContent = "Status unavailable";
    }
  }
}

function pushAgentHistory(role, content) {
  agentHistory.push({ role, content });
  agentHistory = agentHistory.slice(-16);
}

function appendBrainMessage(role, text) {
  if (!brainThread) return null;
  const node = document.createElement("div");
  node.className = "chat-msg";
  node.dataset.role = role;
  const body = document.createElement("p");
  body.textContent = text;
  node.appendChild(body);
  brainThread.appendChild(node);
  brainThread.scrollTop = brainThread.scrollHeight;
  return node;
}

async function askCompanyBrain(content) {
  const question = String(content || "").trim();
  if (!question || brainBusy) return;
  brainBusy = true;
  if (brainInput) brainInput.value = "";
  appendBrainMessage("user", question);
  pushAgentHistory("user", question);

  const pending = appendBrainMessage("assistant", "Thinking…");
  if (pending) pending.dataset.pending = "true";

  try {
    const res = await fetch("/api/agents/dashboard/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: agentHistory })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "The company brain could not answer.");
    const reply = payload.reply || "I do not have enough context to answer that yet.";
    if (pending) {
      delete pending.dataset.pending;
      pending.querySelector("p").textContent = reply;
    }
    pushAgentHistory("assistant", reply);
    if (payload.context?.status) renderPlatformStatus(payload.context.status);
  } catch (error) {
    if (pending) {
      delete pending.dataset.pending;
      pending.dataset.role = "error";
      pending.querySelector("p").textContent = "I could not answer that: " + error.message;
    }
  } finally {
    brainBusy = false;
    if (brainThread) brainThread.scrollTop = brainThread.scrollHeight;
    brainInput?.focus();
  }
}

/* -----------------------------------------------------------------------------
   Routing
   -------------------------------------------------------------------------- */
function parseRoute() {
  const path = (location.hash.replace(/^#/, "") || "/dashboard").split("?")[0];
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "dashboard") return { name: "dashboard" };
  if (parts[0] === "onboarding") return { name: "onboarding" };
  if (parts[0] === "new-stores" && parts[1]) return { name: "storeDetail", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "new-stores") return { name: "newStores" };
  if (parts[0] === "departments" && parts[1]) return { name: "department", id: decodeURIComponent(parts[1]) };
  return { name: "departments" };
}

function showView(name) {
  Object.entries(views).forEach(([key, node]) => {
    if (node) node.hidden = key !== name;
  });
  // Detail pages are children of their list views, so the nav keeps the
  // parent tab lit.
  const navKey = name === "department" ? "departments" : name === "storeDetail" ? "newStores" : name;
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const active = link.dataset.nav === navKey;
    link.dataset.active = active ? "true" : "false";
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

async function handleRoute() {
  const route = parseRoute();
  showView(route.name);
  closeDrawer();
  if (route.name === "dashboard") await loadPlatformStatus();
  else if (route.name === "departments") await loadDepartments();
  else if (route.name === "newStores") await loadNewStores();
  else if (route.name === "storeDetail") await loadStoreDetail(route.id);
  else if (route.name === "department") await loadDepartment(route.id);
  window.scrollTo({ top: 0, behavior: "auto" });
}

/* -----------------------------------------------------------------------------
   Departments list
   -------------------------------------------------------------------------- */
function departmentCard(collection) {
  const count = collection.productCount;
  const thumb = collection.imageUrl
    ? `<img src="${escapeHtml(collection.imageUrl)}" alt="" loading="lazy">`
    : `<span class="dept-initials" aria-hidden="true">${escapeHtml(
        collection.title.split(/\s+/).slice(0, 2).map((word) => word[0] || "").join("").toUpperCase() || "?"
      )}</span>`;

  return `
    <a class="dept-card" href="#/departments/${encodeURIComponent(collection.id)}">
      <span class="dept-thumb">${thumb}</span>
      <span class="dept-body">
        <span class="dept-name">${escapeHtml(collection.title)}</span>
        <span class="dept-meta">${count} ${count === 1 ? "product" : "products"}</span>
      </span>
      <span class="dept-arrow" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </span>
    </a>`;
}

function renderDepartments(collections) {
  const term = departmentSearch.value.trim().toLowerCase();
  const filtered = term
    ? collections.filter((collection) => collection.title.toLowerCase().includes(term))
    : collections;

  if (!collections.length) {
    departmentsBody.innerHTML = stateBlock({
      title: "No departments yet",
      sub: "Run an onboarding to create the first department collection in Shopify.",
      actionHtml: '<a class="btn btn-primary btn-sm" href="#/onboarding">Onboard a department</a>'
    });
    return;
  }
  if (!filtered.length) {
    departmentsBody.innerHTML = stateBlock({
      title: `No department matches “${term}”`,
      sub: "Clear the filter to see all departments."
    });
    return;
  }
  departmentsBody.innerHTML = `<div class="dept-grid">${filtered.map(departmentCard).join("")}</div>`;
}

async function loadDepartments({ force = false } = {}) {
  if (collectionsCache && !force) return renderDepartments(collectionsCache);

  departmentsBody.innerHTML = stateBlock({
    tone: "info",
    title: "Loading departments…",
    sub: "Reading collections from Shopify.",
    spinner: true
  });
  try {
    const res = await fetch("/api/collections");
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Could not load departments.");
    collectionsCache = payload.collections || [];
    renderDepartments(collectionsCache);
  } catch (err) {
    departmentsBody.innerHTML = stateBlock({
      tone: "danger",
      title: "Could not load departments",
      sub: err.message,
      actionHtml: '<button class="btn btn-secondary btn-sm" type="button" data-retry="departments">Try again</button>'
    });
  }
}

/* -----------------------------------------------------------------------------
   One department — its products
   -------------------------------------------------------------------------- */
function productCardHtml(product) {
  const media = product.imageUrl
    ? `<img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.imageAlt || product.title)}" loading="lazy">`
    : `<span class="pg-noimg" aria-hidden="true">
         <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
       </span>`;

  return `
    <article class="pg-card">
      <div class="pg-media">${media}</div>
      <div class="pg-body">
        <div class="pg-top">
          <h3 class="pg-title">${escapeHtml(product.title)}</h3>
          ${statusChip(product.status)}
        </div>
        <p class="pg-meta">
          <span class="pg-price">${escapeHtml(priceLabel(product))}</span>
          <span class="pg-dot" aria-hidden="true">·</span>
          <span>${product.variantCount} ${product.variantCount === 1 ? "variant" : "variants"}</span>
          ${product.productType ? `<span class="pg-dot" aria-hidden="true">·</span><span>${escapeHtml(product.productType)}</span>` : ""}
        </p>
        <div class="pg-actions">
          <button class="btn btn-secondary btn-sm" type="button" data-edit-product="${escapeHtml(product.id)}">Edit</button>
        </div>
      </div>
    </article>`;
}

function renderDepartment({ collection, products }) {
  currentCollection = collection;
  const count = products.length;
  const grid = count
    ? `<div class="pg-grid">${products.map(productCardHtml).join("")}</div>`
    : stateBlock({
        title: "No products in this department yet",
        sub: "Create the first one by describing the garment and adding its logos.",
        actionHtml: '<button class="btn btn-primary btn-sm" type="button" id="emptyNewProduct">New product</button>'
      });

  departmentDetailBody.innerHTML = `
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="#/departments">Departments</a>
      <span aria-hidden="true">/</span>
      <span aria-current="page">${escapeHtml(collection.title)}</span>
    </nav>

    <header class="dept-head">
      <div class="dh-id">
        ${collection.imageUrl ? `<img class="dh-thumb" src="${escapeHtml(collection.imageUrl)}" alt="">` : ""}
        <div>
          <p class="eyebrow">Department</p>
          <h2>${escapeHtml(collection.title)}</h2>
          <p class="dh-sub">${count} ${count === 1 ? "product" : "products"} in this collection</p>
        </div>
      </div>
      <div class="dh-actions">
        <button class="btn btn-ghost btn-sm" type="button" id="refreshDepartment">Refresh</button>
        <button class="btn btn-primary btn-sm" type="button" id="openNewProduct">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
          New product
        </button>
      </div>
    </header>

    ${grid}`;
}

async function loadDepartment(collectionId) {
  departmentDetailBody.innerHTML = stateBlock({
    tone: "info",
    title: "Loading department…",
    sub: "Reading its products from Shopify.",
    spinner: true
  });
  try {
    const res = await fetch(`/api/collections/${encodeURIComponent(collectionId)}`);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Could not load this department.");
    renderDepartment(payload);
  } catch (err) {
    currentCollection = null;
    departmentDetailBody.innerHTML = `
      <nav class="crumbs" aria-label="Breadcrumb"><a href="#/departments">Departments</a></nav>
      ${stateBlock({
        tone: "danger",
        title: "Could not load this department",
        sub: err.message,
        actionHtml: `<button class="btn btn-secondary btn-sm" type="button" data-retry="department" data-id="${escapeHtml(collectionId)}">Try again</button>`
      })}`;
  }
}

/* -----------------------------------------------------------------------------
   Product editor drawer
   -------------------------------------------------------------------------- */
const productDrawer = el("productDrawer");
const drawerBody = el("drawerBody");
const drawerTitle = el("drawerTitle");
let drawerLastFocus = null;
let editingProduct = null;

function openDrawer() {
  drawerLastFocus = document.activeElement;
  productDrawer.hidden = false;
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onDrawerKeydown);
}

function closeDrawer() {
  if (productDrawer.hidden) return;
  productDrawer.hidden = true;
  document.body.style.overflow = "";
  document.removeEventListener("keydown", onDrawerKeydown);
  editingProduct = null;
  drawerBody.innerHTML = "";
  if (drawerLastFocus?.focus) drawerLastFocus.focus();
}

function onDrawerKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeDrawer();
    return;
  }
  if (e.key !== "Tab") return;
  const focusable = [...productDrawer.querySelectorAll("button, input, textarea, select, a[href]")].filter(
    (node) => !node.disabled && node.offsetParent !== null
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// The description is stored as HTML by Shopify. Editing raw markup is the wrong
// job for this console, so the drawer shows the text and only rewraps it in
// paragraphs when the operator actually changes it.
//
// textContent alone would run block elements together ("…ring spun cottonLogo
// placement: left chest"), so block boundaries become newlines and list items
// keep their bullet — what the operator sees matches how it reads on the page.
// Two tiers: a paragraph, heading, list, or table ends a *block* and gets a
// blank line after it, so the next block parses back as its own element. Items
// inside one (list items, table rows) get a single newline so the list stays a
// single list on the round trip.
const BLOCK_TAGS = "P,DIV,SECTION,H1,H2,H3,H4,H5,H6,UL,OL,TABLE,BLOCKQUOTE";
const LINE_TAGS = "LI,TR";

// Whitespace-only text nodes sitting *between* structural elements are source
// formatting, not content — "<li>a</li>\n<li>b</li>" would otherwise gain a
// blank line per item and split one list into several. Only structural parents
// are stripped, so a real space in "<b>a</b> <i>b</i>" is left alone.
const STRUCTURAL_PARENTS = new Set(["UL", "OL", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "COLGROUP", "DIV", "SECTION"]);

function stripStructuralWhitespace(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const blanks = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim() && STRUCTURAL_PARENTS.has(node.parentNode?.nodeName)) blanks.push(node);
  }
  blanks.forEach((node) => node.remove());
}

function htmlToText(html) {
  const holder = document.createElement("div");
  holder.innerHTML = html || "";
  stripStructuralWhitespace(holder);

  holder.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  holder.querySelectorAll("li").forEach((node) => {
    node.prepend("• ");
  });
  holder.querySelectorAll("td, th").forEach((node) => {
    if (node.nextElementSibling) node.append("\t");
  });
  holder.querySelectorAll(LINE_TAGS).forEach((node) => {
    node.append("\n");
  });
  holder.querySelectorAll(BLOCK_TAGS).forEach((node) => {
    node.append("\n\n");
  });

  return holder.textContent
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Rich structures (size chart tables, spec bullets) survive an untouched save
// because the description is only sent when it changes — but if the operator
// does edit it, the round-trip through plain text flattens them. Say so.
function hasRichMarkup(html) {
  return /<(table|ul|ol)\b/i.test(html || "");
}

// Inverse of htmlToText for the shapes it produces: blank lines separate
// paragraphs, and runs of "• " lines come back as a real <ul> so edited spec
// bullets stay bullets on the storefront.
function textToHtml(text) {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length && lines.every((line) => line.startsWith("•"))) {
        const items = lines
          .map((line) => `<li>${escapeHtml(line.replace(/^•\s*/, ""))}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      }
      return `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
}

function renderDrawer(product) {
  editingProduct = product;
  drawerTitle.textContent = product.title;

  const optionRows = product.options
    .map(
      (option) => `
      <div class="opt-row">
        <span class="opt-name">${escapeHtml(option.name)}</span>
        <span class="opt-count">${option.values.length} ${option.values.length === 1 ? "value" : "values"}</span>
        <span class="opt-values">${escapeHtml(option.values.slice(0, 8).join(", "))}${
          option.values.length > 8 ? ` +${option.values.length - 8} more` : ""
        }</span>
      </div>`
    )
    .join("");

  const gallery = product.images.length
    ? `<div class="dw-gallery">${product.images
        .slice(0, 12)
        .map(
          (image) =>
            `<figure><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}" loading="lazy">${
              image.alt ? `<figcaption>${escapeHtml(image.alt)}</figcaption>` : ""
            }</figure>`
        )
        .join("")}</div>`
    : stateBlock({ title: "No images on this product" });

  drawerBody.innerHTML = `
    <form id="editProductForm" novalidate>
      <div class="dw-summary">
        ${statusChip(product.status)}
        <span>${product.variantCount} ${product.variantCount === 1 ? "variant" : "variants"}</span>
        ${product.onlineStoreUrl ? `<a href="${escapeHtml(product.onlineStoreUrl)}" target="_blank" rel="noreferrer">View in store</a>` : ""}
      </div>

      <div class="field">
        <label for="epTitle">Title</label>
        <input id="epTitle" name="title" type="text" value="${escapeHtml(product.title)}" aria-describedby="epTitleError">
        <p class="hint field-error" id="epTitleError" hidden></p>
      </div>

      <div class="field-row">
        <div class="field">
          <label for="epPrice">Price <span class="opt">(all variants)</span></label>
          <div class="input-prefix">
            <span aria-hidden="true">$</span>
            <input id="epPrice" name="price" type="number" min="0" step="0.01" value="${escapeHtml(normalizePrice(product.minPrice))}" aria-describedby="epPriceHint epPriceError">
          </div>
          <p class="hint" id="epPriceHint">Applies to all ${product.variantCount} variants.</p>
          <p class="hint field-error" id="epPriceError" hidden></p>
        </div>
        <div class="field">
          <label for="epStatus">Status</label>
          <select id="epStatus" name="status">
            <option value="ACTIVE"${product.status === "ACTIVE" ? " selected" : ""}>Active</option>
            <option value="DRAFT"${product.status === "DRAFT" ? " selected" : ""}>Draft</option>
            <option value="ARCHIVED"${product.status === "ARCHIVED" ? " selected" : ""}>Archived</option>
          </select>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label for="epType">Product type</label>
          <input id="epType" name="productType" type="text" value="${escapeHtml(product.productType)}">
        </div>
        <div class="field">
          <label for="epVendor">Vendor</label>
          <input id="epVendor" name="vendor" type="text" value="${escapeHtml(product.vendor)}">
        </div>
      </div>

      <div class="field">
        <label for="epTags">Tags</label>
        <input id="epTags" name="tags" type="text" value="${escapeHtml(product.tags.join(", "))}">
        <p class="hint">Comma separated.</p>
      </div>

      <div class="field">
        <label for="epDescription">Description</label>
        <textarea id="epDescription" name="descriptionHtml" rows="7">${escapeHtml(htmlToText(product.descriptionHtml))}</textarea>
        <p class="hint">Blank lines start a new paragraph, “•” lines become a bullet list. Left untouched, the description is not sent at all — its existing formatting is preserved exactly.</p>
        ${
          hasRichMarkup(product.descriptionHtml)
            ? `<p class="hint" data-tone="warn">This description contains a table or list. Editing it here rewrites it as paragraphs and bullets — a size chart table would not survive. Edit tables in Shopify admin instead.</p>`
            : ""
        }
      </div>

      <div class="banner" id="epError" hidden>
        <span class="b-glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </span>
        <span id="epErrorText"></span>
      </div>
      <div class="banner" id="epSaved" data-tone="ok" hidden>
        <span class="b-glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </span>
        <span id="epSavedText">Saved to Shopify.</span>
      </div>

      <div class="dw-actions">
        <button class="btn btn-ghost" type="button" id="epCancel">Close</button>
        <button class="btn btn-primary" type="submit" id="epSave"><span class="btn-label">Save changes</span></button>
      </div>

      <section class="dw-section">
        <h3>Variant options</h3>
        ${optionRows || stateBlock({ title: "This product has no options" })}
      </section>

      <section class="dw-section">
        <h3>Images</h3>
        ${gallery}
      </section>
    </form>`;

  el("editProductForm").addEventListener("submit", saveProduct);
  el("epCancel").addEventListener("click", closeDrawer);
  el("epTitle").focus();
}

async function openProductEditor(productId) {
  openDrawer();
  drawerTitle.textContent = "Loading…";
  drawerBody.innerHTML = stateBlock({ tone: "info", title: "Loading product…", spinner: true });
  try {
    const res = await fetch(`/api/products/${encodeURIComponent(productId)}`);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Could not load this product.");
    renderDrawer(payload.product);
  } catch (err) {
    drawerTitle.textContent = "Product";
    drawerBody.innerHTML = stateBlock({ tone: "danger", title: "Could not load this product", sub: err.message });
  }
}

async function saveProduct(e) {
  e.preventDefault();
  if (!editingProduct) return;

  const title = el("epTitle").value.trim();
  const price = el("epPrice").value.trim();
  const errorBanner = el("epError");
  const savedBanner = el("epSaved");
  errorBanner.hidden = true;
  savedBanner.hidden = true;

  let valid = true;
  if (!title) {
    showFieldError(el("epTitle"), el("epTitleError"), "Title is required.");
    valid = false;
  } else {
    hideFieldError(el("epTitle"), el("epTitleError"));
  }
  if (price && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
    showFieldError(el("epPrice"), el("epPriceError"), "Enter a price of 0 or more.");
    valid = false;
  } else {
    hideFieldError(el("epPrice"), el("epPriceError"));
  }
  if (!valid) return;

  const descriptionText = el("epDescription").value;
  const patch = {
    title,
    productType: el("epType").value.trim(),
    vendor: el("epVendor").value.trim(),
    status: el("epStatus").value,
    tags: el("epTags").value
  };
  // Only send the description when it actually changed, so untouched HTML
  // formatting (size chart tables, spec lists) survives an edit to other fields.
  if (descriptionText.trim() !== htmlToText(editingProduct.descriptionHtml)) {
    patch.descriptionHtml = textToHtml(descriptionText);
  }
  // Compared numerically, not as strings: repricing is a write across every
  // variant (200+ on a real product), so an unchanged price must never trigger
  // one just because Shopify echoed it back as "27.0" instead of "27.00".
  if (price && !samePrice(price, editingProduct.minPrice)) patch.price = normalizePrice(price);

  const saveBtn = el("epSave");
  saveBtn.disabled = true;
  saveBtn.querySelector(".btn-label").textContent = "Saving…";
  saveBtn.insertAdjacentHTML("afterbegin", '<span class="spinner" aria-hidden="true"></span>');

  try {
    const res = await fetch(`/api/products/${encodeURIComponent(editingProduct.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Save failed.");

    editingProduct = payload.product;
    drawerTitle.textContent = payload.product.title;
    el("epSavedText").textContent = patch.price
      ? `Saved. ${payload.product.repricedVariants ?? 0} variants repriced.`
      : "Saved to Shopify.";
    savedBanner.hidden = false;
    if (currentCollection) loadDepartment(currentCollection.id);
  } catch (err) {
    el("epErrorText").textContent = err.message || "Save failed.";
    errorBanner.hidden = false;
  } finally {
    saveBtn.disabled = false;
    saveBtn.querySelector(".spinner")?.remove();
    saveBtn.querySelector(".btn-label").textContent = "Save changes";
  }
}

/* -----------------------------------------------------------------------------
   New product — describe it, add logos, publish straight into the department
   -------------------------------------------------------------------------- */
const newProductModal = el("newProductModal");
const newProductForm = el("newProductForm");
const npLogoInput = el("npLogos");
const npLogoThumbs = el("npLogoThumbs");
let npLastFocus = null;
const npObjectUrls = new Set();

function renderNpThumbs() {
  npObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  npObjectUrls.clear();
  const files = [...npLogoInput.files];
  npLogoThumbs.innerHTML = files
    .map((file, i) => {
      const url = URL.createObjectURL(file);
      npObjectUrls.add(url);
      return `
        <div class="thumb">
          <img src="${url}" alt="${escapeHtml(file.name)}">
          <button class="file-remove" type="button" data-remove-nplogo="${i}" aria-label="Remove ${escapeHtml(file.name)}">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>`;
    })
    .join("");
  syncDropzone("npLogos", files.length);
  if (files.length) {
    hideFieldError(npLogoInput, el("npLogosError"));
    markDropzoneInvalid("npLogos", false);
  }
}

function openNewProductModal() {
  if (!currentCollection) return;
  npLastFocus = document.activeElement;
  el("newProductDept").textContent = `Creating in “${currentCollection.title}”. Describe the garment, add the logos, set a price.`;
  newProductModal.hidden = false;
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onNpKeydown);
  el("npDescription").focus();
}

function closeNewProductModal() {
  if (newProductModal.hidden) return;
  newProductModal.hidden = true;
  document.body.style.overflow = "";
  document.removeEventListener("keydown", onNpKeydown);
  if (npLastFocus?.focus) npLastFocus.focus();
}

function onNpKeydown(e) {
  // A create run is mid-flight once the submit button is disabled; Escape then
  // would abandon a Shopify write the operator can't see the result of.
  if (e.key === "Escape" && !el("npSubmit").disabled) {
    e.preventDefault();
    closeNewProductModal();
  }
}

function resetNewProductForm() {
  newProductForm.reset();
  setInputFiles(npLogoInput, []);
  renderNpThumbs();
  el("npSizes").value = "XS, S, M, L, XL, 2XL, 3XL";
  el("npProgress").hidden = true;
  el("npError").hidden = true;
  hideFieldError(el("npDescription"), el("npDescriptionError"));
  hideFieldError(el("npPrice"), el("npPriceError"));
  markDropzoneInvalid("npLogos", false);
}

const NP_TOTAL_STEPS = 6;
function setNpProgress(step, label) {
  const pct = Math.round(((step - 1) / NP_TOTAL_STEPS) * 100);
  el("npProgressFill").style.width = `${pct}%`;
  el("npProgressPct").textContent = `${pct}%`;
  el("npProgressText").textContent = label;
  el("npProgressBar").setAttribute("aria-valuenow", String(pct));
}

function validateNewProduct() {
  let ok = true;
  if (!el("npDescription").value.trim()) {
    showFieldError(el("npDescription"), el("npDescriptionError"), "Describe the product first.");
    ok = false;
  } else {
    hideFieldError(el("npDescription"), el("npDescriptionError"));
  }
  const price = el("npPrice").value.trim();
  if (price && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
    showFieldError(el("npPrice"), el("npPriceError"), "Enter a price of 0 or more.");
    ok = false;
  } else {
    hideFieldError(el("npPrice"), el("npPriceError"));
  }
  if (!npLogoInput.files.length) {
    showFieldError(npLogoInput, el("npLogosError"), "Add at least one logo image.");
    markDropzoneInvalid("npLogos", true);
    ok = false;
  } else {
    hideFieldError(npLogoInput, el("npLogosError"));
    markDropzoneInvalid("npLogos", false);
  }
  return ok;
}

async function submitNewProduct(e) {
  e.preventDefault();
  if (!currentCollection || !validateNewProduct()) return;

  const submitBtn = el("npSubmit");
  const cancelBtn = el("npCancel");
  submitBtn.disabled = true;
  cancelBtn.disabled = true;
  submitBtn.querySelector(".btn-label").textContent = "Creating…";
  submitBtn.insertAdjacentHTML("afterbegin", '<span class="spinner" aria-hidden="true"></span>');
  el("npError").hidden = true;
  el("npProgress").hidden = false;
  setNpProgress(1, "Starting…");

  let createdProduct = null;
  try {
    const res = await fetch(`/api/collections/${encodeURIComponent(currentCollection.id)}/products`, {
      method: "POST",
      body: new FormData(newProductForm)
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({ error: "Could not create the product." }));
      throw new Error(payload.error || "Could not create the product.");
    }

    let failure = null;
    await readSseStream(res, (event, payload) => {
      if (event === "status" && payload.state === "running") {
        setNpProgress(payload.step, payload.message.replace(/^Step \d+ \w+: /, ""));
      } else if (event === "status" && payload.state === "complete") {
        setNpProgress(payload.step + 1, "Working…");
      } else if (event === "created") {
        createdProduct = payload.product;
      } else if (event === "error") {
        failure = payload.error || "Could not create the product.";
      }
    });
    if (failure) throw new Error(failure);
    if (!createdProduct) throw new Error("The run ended before the product was created.");

    setNpProgress(NP_TOTAL_STEPS + 1, "Done");
    closeNewProductModal();
    resetNewProductForm();
    collectionsCache = null; // product counts changed
    await loadDepartment(currentCollection.id);
    openProductEditor(createdProduct.id);
  } catch (err) {
    el("npErrorText").textContent = err.message || "Could not create the product.";
    el("npError").hidden = false;
  } finally {
    submitBtn.disabled = false;
    cancelBtn.disabled = false;
    submitBtn.querySelector(".spinner")?.remove();
    submitBtn.querySelector(".btn-label").textContent = "Create product";
  }
}

/* -----------------------------------------------------------------------------
   Wiring
   -------------------------------------------------------------------------- */
departmentSearch.addEventListener("input", () => {
  if (collectionsCache) renderDepartments(collectionsCache);
});
el("refreshDepartments").addEventListener("click", () => loadDepartments({ force: true }));
if (refreshNewStores) refreshNewStores.addEventListener("click", () => loadNewStores());

document.addEventListener("click", (e) => {
  const editId = e.target.closest("[data-edit-product]")?.dataset.editProduct;
  if (editId) return openProductEditor(editId);

  if (e.target.closest("#openNewProduct") || e.target.closest("#emptyNewProduct")) {
    return openNewProductModal();
  }
  if (e.target.closest("#refreshDepartment") && currentCollection) {
    return loadDepartment(currentCollection.id);
  }

  const retry = e.target.closest("[data-retry]");
  if (retry) {
    if (retry.dataset.retry === "departments") return loadDepartments({ force: true });
    if (retry.dataset.retry === "department") return loadDepartment(retry.dataset.id);
  }

  const npIdx = e.target.closest("[data-remove-nplogo]")?.dataset.removeNplogo;
  if (npIdx !== undefined) {
    setInputFiles(npLogoInput, [...npLogoInput.files].filter((_, i) => i !== Number(npIdx)));
    renderNpThumbs();
  }
});

el("drawerClose").addEventListener("click", closeDrawer);
productDrawer.addEventListener("click", (e) => {
  if (e.target === productDrawer) closeDrawer();
});

el("npCancel").addEventListener("click", closeNewProductModal);
el("newProductClose").addEventListener("click", closeNewProductModal);
newProductModal.addEventListener("click", (e) => {
  if (e.target === newProductModal && !el("npSubmit").disabled) closeNewProductModal();
});
newProductForm.addEventListener("submit", submitNewProduct);
wireDropzone("npLogos", npLogoInput, renderNpThumbs, isImage);
if (brainForm) {
  brainForm.addEventListener("submit", (event) => {
    event.preventDefault();
    askCompanyBrain(brainInput?.value);
  });
}
document.querySelectorAll("[data-agent-prompt]").forEach((button) => {
  button.addEventListener("click", () => askCompanyBrain(button.dataset.agentPrompt));
});

window.addEventListener("hashchange", handleRoute);
handleRoute();

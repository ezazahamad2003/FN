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

   Navigation is hash-routed across three views — #/departments (the default
   landing view), #/departments/:id, and #/onboarding. Onboarding is one option
   in the nav rather than the whole app, because day to day the store already
   exists and the common task is browsing and editing it.
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
  if (!row) return; // step 10 (summary) has no row — handled by setComplete()
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
      const blankLine = p.blankNote
        ? `<p class="rv-logos">${escapeHtml(p.blankNote)}${
            p.blankSourceUrl ? ` <a href="${escapeHtml(p.blankSourceUrl)}" target="_blank" rel="noopener">source</a>` : ""
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
    const payload = await res.json();
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
  newStores: el("viewNewStores")
};
const departmentsBody = el("departmentsBody");
const departmentDetailBody = el("departmentDetailBody");
const departmentSearch = el("departmentSearch");
const newStoresBody = el("newStoresBody");
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

function renderNewStoresShell(records) {
  if (!newStoresBody) return;
  if (!records.length) {
    newStoresBody.innerHTML = stateBlock({
      title: "No customer store requests yet",
      sub: "Share the customer intake link. Submissions will land here after they create the draft Shopify collection."
    });
    return;
  }
  newStoresBody.innerHTML = `
    <div class="store-queue-grid">
      <aside class="store-request-list" aria-label="Customer store requests">
        ${records.map((record, index) => `
          <button class="store-request-card" type="button" data-intake-id="${escapeHtml(record.id)}" data-active="${index === 0 ? "true" : "false"}">
            <span>
              <b>${escapeHtml(record.departmentName || record.store?.departmentName || "Untitled department")}</b>
              <small>${escapeHtml(record.departmentCode || record.store?.departmentCode || "No code yet")} - ${escapeHtml(record.summary?.includedCategories || 0)} categories</small>
            </span>
            <em>${escapeHtml(intakeStatusLabel(record.status))}</em>
          </button>
        `).join("")}
      </aside>
      <section class="store-review-panel" id="storeReviewPanel">
        ${stateBlock({ title: "Loading store request", sub: "Opening the newest customer submission.", spinner: true })}
      </section>
    </div>`;
  openCustomerIntake(records[0].id);
}

function categoryEditor(category) {
  const enabled = category.include ? "checked" : "";
  return `
    <details class="intake-category-editor" data-category-id="${escapeHtml(category.id)}" ${category.include ? "open" : ""}>
      <summary>
        <span>${escapeHtml(category.label)}</span>
        <em>${category.include ? "Included" : "Skipped"}</em>
      </summary>
      <div class="category-edit-grid">
        <label><span>Include</span><input type="checkbox" name="include" ${enabled}></label>
        <label><span>Styles and colors</span><textarea name="stylesAndColors" rows="3">${escapeHtml(category.stylesAndColors)}</textarea></label>
        <label><span>Decoration method</span><select name="decorationMethod">
          ${["Embroidery", "Screen Print", "Patch", "Heat Press"].map((item) => `<option ${category.decorationMethod === item ? "selected" : ""}>${item}</option>`).join("")}
        </select></label>
        <label><span>Logo labels</span><input name="logoLabels" value="${escapeHtml(category.logoLabels)}"></label>
        <label><span>Size tier</span><select name="sizeTier">
          ${[
            ["small", "Small - about 4 in"],
            ["standard", "Standard - about 6 in"],
            ["large", "Large / full back - 8-10 in"]
          ].map(([value, label]) => `<option value="${value}" ${category.sizeTier === value ? "selected" : ""}>${label}</option>`).join("")}
        </select></label>
        <label><span>Placement</span><input name="placement" value="${escapeHtml(category.placement)}"></label>
        <label><span>Name/rank</span><select name="nameRank">
          ${["No", "Name only", "Rank only", "Name and rank"].map((item) => `<option ${category.nameRank === item ? "selected" : ""}>${item}</option>`).join("")}
        </select></label>
        <label><span>Size range</span><input name="sizeRange" value="${escapeHtml(category.sizeRange)}"></label>
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
    primaryContactName: panel.querySelector("[data-store-field='primaryContactName']")?.value.trim() || "",
    primaryContactEmail: panel.querySelector("[data-store-field='primaryContactEmail']")?.value.trim() || "",
    notes: panel.querySelector("[data-store-field='notes']")?.value.trim() || ""
  };
  next.categories = next.categories.map((category) => {
    const node = panel.querySelector(`[data-category-id="${CSS.escape(category.id)}"]`);
    if (!node) return category;
    return {
      ...category,
      include: Boolean(node.querySelector("[name='include']")?.checked),
      stylesAndColors: node.querySelector("[name='stylesAndColors']")?.value.trim() || "",
      decorationMethod: node.querySelector("[name='decorationMethod']")?.value || "",
      logoLabels: node.querySelector("[name='logoLabels']")?.value.trim() || "",
      sizeTier: node.querySelector("[name='sizeTier']")?.value || "",
      placement: node.querySelector("[name='placement']")?.value.trim() || "",
      nameRank: node.querySelector("[name='nameRank']")?.value || "",
      sizeRange: node.querySelector("[name='sizeRange']")?.value.trim() || ""
    };
  });
  return next;
}

function fileFromStoredLogo(logo, index) {
  const match = String(logo.dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], logo.name || `customer-logo-${index + 1}`, { type: logo.mimeType || match[1] });
}

function setFileInputFiles(input, files) {
  const transfer = new DataTransfer();
  files.filter(Boolean).forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
}

async function saveCustomerIntake(record, status = "in-review") {
  const edited = collectEditedIntake(record);
  const res = await adminFetch(`/api/customer-intakes/${encodeURIComponent(record.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ ...edited, status })
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || "Could not save the customer store request.");
  return payload.intake;
}

async function loadCustomerIntakeIntoOnboarding(record) {
  const saved = await saveCustomerIntake(record, "approved-for-build");
  departmentInput.value = saved.store.departmentName || "";
  if (logoInput) {
    setFileInputFiles(logoInput, (saved.logos || []).map(fileFromStoredLogo));
    renderLogoThumbs();
  }
  if (intakeInput) {
    const text = saved.structuredText || "";
    setFileInputFiles(intakeInput, [new File([text], `${saved.store.departmentCode || saved.requestId}-customer-intake.txt`, { type: "text/plain" })]);
    renderIntakeChips();
  }
  if (followUpInput) {
    setFileInputFiles(followUpInput, []);
    renderFollowUpChips();
  }
  const followText = el("followUpText");
  if (followText) followText.value = "";
  hideFieldError(departmentInput, departmentError);
  hideFieldError(logoInput, logoError);
  addNotice("Customer package loaded. Run onboarding to generate images, then approve products for Shopify.");
  location.hash = "#/onboarding";
}

/* -----------------------------------------------------------------------------
   Build progress. The intake record carries the build state (written step by
   step by the server), so this is a pure render of what Drive says - it
   survives page reloads and server restarts.
   -------------------------------------------------------------------------- */
function buildStateTone(state) {
  return { running: "info", complete: "ok", partial: "warn", failed: "warn" }[state] || "muted";
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
  buildPollTimer = setTimeout(async () => {
    try {
      const res = await adminFetch(`/api/customer-intakes/${encodeURIComponent(id)}`);
      const payload = await res.json().catch(() => ({}));
      if (res.ok && payload.intake) {
        const active = document.querySelector(`.store-request-card[data-active="true"]`);
        // Only repaint if the operator is still looking at this record.
        if (active?.dataset.intakeId === id) renderCustomerIntakeEditor(payload.intake);
      }
    } catch {
      /* transient - next poll retries */
    }
  }, 5000);
}

function renderCustomerIntakeEditor(record) {
  const panel = el("storeReviewPanel");
  if (!panel) return;
  const collectionUrl = record.shopifyCollection?.url || "";
  const building = record.build?.state === "running";
  panel.innerHTML = `
    <div class="store-review-head">
      <div>
        <p class="eyebrow">Review queue</p>
        <h2>${escapeHtml(record.store.departmentName || "Customer store request")}</h2>
        <p>${escapeHtml(record.requestId)} - ${escapeHtml(intakeStatusLabel(record.status))}</p>
      </div>
      <div class="store-review-actions">
        ${collectionUrl ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(collectionUrl)}" target="_blank" rel="noreferrer">Open Shopify collection</a>` : ""}
        <button class="btn btn-secondary btn-sm" type="button" data-save-intake>Save edits</button>
        <button class="btn btn-primary btn-sm" type="button" data-build-intake ${building ? "disabled" : ""}>
          ${building ? "Building…" : record.build ? "Re-run build" : "Build store now"}
        </button>
      </div>
    </div>
    ${buildPanelHtml(record)}
    <div class="store-edit-grid">
      <label><span>Department name</span><input data-store-field="departmentName" value="${escapeHtml(record.store.departmentName)}"></label>
      <label><span>Department code</span><input data-store-field="departmentCode" value="${escapeHtml(record.store.departmentCode)}"></label>
      <label><span>Contact name</span><input data-store-field="primaryContactName" value="${escapeHtml(record.store.primaryContactName)}"></label>
      <label><span>Contact email</span><input data-store-field="primaryContactEmail" value="${escapeHtml(record.store.primaryContactEmail)}"></label>
      <label class="span-2"><span>Internal/customer notes</span><textarea data-store-field="notes" rows="3">${escapeHtml(record.store.notes)}</textarea></label>
    </div>
    <div class="logo-strip">
      ${(record.logos || []).map((logo) => logo.dataUrl?.startsWith("data:image/")
        ? `<img src="${escapeHtml(logo.dataUrl)}" alt="${escapeHtml(logo.name)}">`
        : `<span>${escapeHtml(logo.name)}</span>`).join("") || "<span>No logo file stored</span>"}
    </div>
    <div class="category-editor-stack">
      ${record.categories.map(categoryEditor).join("")}
    </div>`;

  panel.querySelector("[data-save-intake]")?.addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "Saving...";
    try {
      const saved = await saveCustomerIntake(record, "in-review");
      renderCustomerIntakeEditor(saved);
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

  // Keep the panel live while the server is building.
  if (record.build?.state === "running") pollBuild(record.id);
}

async function openCustomerIntake(id) {
  const panel = el("storeReviewPanel");
  if (panel) panel.innerHTML = stateBlock({ title: "Loading store request", spinner: true });
  try {
    const res = await adminFetch(`/api/customer-intakes/${encodeURIComponent(id)}`);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Could not open that store request.");
    renderCustomerIntakeEditor(payload.intake);
    document.querySelectorAll(".store-request-card").forEach((card) => {
      card.dataset.active = card.dataset.intakeId === id ? "true" : "false";
    });
  } catch (error) {
    if (panel) panel.innerHTML = stateBlock({ tone: "warn", title: "Could not open store request", sub: error.message });
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
   Dashboard voice agent
   -------------------------------------------------------------------------- */
const voiceAgent = el("voiceAgent");
const agentVoiceButton = el("agentVoiceButton");
const voiceState = el("voiceState");
const voicePrompt = el("voicePrompt");
const voiceUserTranscript = el("voiceUserTranscript");
const voiceAssistantReply = el("voiceAssistantReply");
const voiceRepeat = el("voiceRepeat");
const voiceStop = el("voiceStop");
const voicePlayback = el("voicePlayback");
const platformStatusList = el("platformStatusList");
const agentModelPill = el("agentModelPill");
let agentHistory = [];
let micStream = null;
let audioContext = null;
let analyser = null;
let analyserBuffer = null;
let vadFrame = null;
let mediaRecorder = null;
let voiceChunks = [];
let voiceSessionActive = false;
let turnInFlight = false;
let speechStarted = false;
let quietSince = 0;
let recordStartedAt = 0;
let discardRecording = false;
let lastAssistantReply = "";
let lastAssistantAudio = null;

const VOICE_SILENCE_MS = 560;
const VOICE_MIN_TURN_MS = 420;
const VOICE_MAX_TURN_MS = 12000;
const VOICE_IDLE_THRESHOLD = 0.024;
const VOICE_BARGE_THRESHOLD = 0.054;

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
  const voiceText = genAI.voiceInputConfigured
    ? "Whisper" + (genAI.voiceOutputConfigured ? " + speech" : " + browser speech")
    : "Voice not configured";

  platformStatusList.innerHTML = [
    ["Shopify", yesNo(status.shopifyConnected)],
    ["Google Drive", status.googleDriveConnected ? yesNo(true) + (status.googleAccountCount > 1 ? " - " + status.googleAccountCount + " accounts" : "") : yesNo(false)],
    ["GenAI", genAIText],
    ["Voice", voiceText],
    ["Postgres", status.postgresConfigured ? "Configured" : "Planned"],
    ["Key Vault", status.keyVaultConfigured ? "Configured" : "Planned"],
    ["Storage", status.storageConfigured ? "Configured" : "Planned"]
  ]
    .map(([label, value]) => '<div class="status-line"><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(value) + '</b></div>')
    .join("");

  if (agentModelPill) {
    const ready = genAI.configured && genAI.voiceInputConfigured;
    agentModelPill.dataset.state = ready ? "ready" : "attention";
    agentModelPill.querySelector(".txt").textContent = ready ? voiceText : genAI.configured ? "Add Whisper deployment" : "GenAI not configured";
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

function setVoiceMode(mode, title, detail) {
  if (voiceAgent) voiceAgent.dataset.state = mode;
  if (agentVoiceButton) {
    const active = voiceSessionActive || mode === "speaking";
    agentVoiceButton.setAttribute("aria-pressed", active ? "true" : "false");
    agentVoiceButton.setAttribute("aria-label", active ? "Stop voice assistant" : "Start voice assistant");
    agentVoiceButton.disabled = false;
  }
  if (voiceState) voiceState.textContent = title;
  if (voicePrompt) voicePrompt.textContent = detail;
}

function mediaSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && window.AudioContext);
}

function bestAudioMimeType() {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function stopPlayback(resume = false) {
  if (voicePlayback) {
    voicePlayback.pause();
    voicePlayback.removeAttribute("src");
    voicePlayback.load();
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (resume && voiceSessionActive && !turnInFlight) setVoiceMode("listening", "Listening", "Mic is on. Pause after a question to send it.");
}

function resumeVoiceSession() {
  if (voiceSessionActive && !turnInFlight) {
    setVoiceMode("listening", "Listening", "Mic is on. Pause after a question to send it.");
  } else if (!turnInFlight) {
    setVoiceMode("idle", "Mic off", "Click once to keep the agent listening. Pause to send, talk over it to interrupt.");
  }
}

function speakAnswer(text) {
  lastAssistantReply = text || "";
  lastAssistantAudio = null;
  if (!lastAssistantReply) {
    resumeVoiceSession();
    return;
  }
  if (!window.speechSynthesis) {
    setVoiceMode(voiceSessionActive ? "listening" : "idle", voiceSessionActive ? "Listening" : "Mic off", "Speech playback is unavailable. The answer is shown below.");
    return;
  }
  stopPlayback(false);
  const utterance = new SpeechSynthesisUtterance(lastAssistantReply.replace(/\s+/g, " "));
  utterance.rate = 1.02;
  utterance.pitch = 1;
  utterance.onstart = () => setVoiceMode("speaking", "Speaking", "Talk over me to interrupt.");
  utterance.onend = resumeVoiceSession;
  utterance.onerror = resumeVoiceSession;
  window.speechSynthesis.speak(utterance);
}

function playAssistantReply(text, audio) {
  lastAssistantReply = text || "";
  lastAssistantAudio = audio || null;
  if (!lastAssistantReply) return resumeVoiceSession();
  stopPlayback(false);
  if (audio?.base64 && voicePlayback) {
    voicePlayback.src = "data:" + (audio.mimeType || "audio/mpeg") + ";base64," + audio.base64;
    voicePlayback.onended = resumeVoiceSession;
    voicePlayback.onerror = () => speakAnswer(lastAssistantReply);
    setVoiceMode("speaking", "Speaking", "Talk over me to interrupt.");
    voicePlayback.play().catch(() => speakAnswer(lastAssistantReply));
    return;
  }
  speakAnswer(lastAssistantReply);
}

function pushAgentHistory(role, content) {
  agentHistory.push({ role, content });
  agentHistory = agentHistory.slice(-10);
}

async function askDashboardAgent(content) {
  const question = String(content || "").trim();
  if (!question) return;
  stopPlayback(false);

  if (voiceUserTranscript) voiceUserTranscript.textContent = question;
  if (voiceAssistantReply) voiceAssistantReply.textContent = "Thinking...";
  setVoiceMode("thinking", "Thinking", "Checking live platform context.");
  pushAgentHistory("user", question);

  try {
    const res = await fetch("/api/agents/dashboard/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: agentHistory })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "The dashboard agent could not answer.");
    const reply = payload.reply || "I do not have enough context to answer that yet.";
    if (voiceAssistantReply) voiceAssistantReply.textContent = reply;
    pushAgentHistory("assistant", reply);
    if (payload.context?.status) renderPlatformStatus(payload.context.status);
    playAssistantReply(reply, null);
  } catch (error) {
    const reply = "I could not answer that: " + error.message;
    if (voiceAssistantReply) voiceAssistantReply.textContent = reply;
    setVoiceMode(voiceSessionActive ? "listening" : "idle", voiceSessionActive ? "Listening" : "Mic off", "Try again, or use a quick prompt.");
    speakAnswer(reply);
  }
}

async function sendVoiceTurn(blob) {
  if (!voiceSessionActive || !blob?.size) return resumeVoiceSession();
  turnInFlight = true;
  setVoiceMode("thinking", "Thinking", "Transcribing and checking live context.");
  if (voiceAssistantReply) voiceAssistantReply.textContent = "Thinking...";

  const form = new FormData();
  form.append("audio", blob, "voice." + (blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm"));
  form.append("messages", JSON.stringify(agentHistory));
  form.append("language", "en");
  form.append("format", "mp3");

  try {
    const res = await fetch("/api/agents/dashboard/voice", { method: "POST", body: form });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "The dashboard voice agent could not answer.");
    const transcript = payload.transcript || "";
    const reply = payload.reply || "I do not have enough context to answer that yet.";
    if (voiceUserTranscript) voiceUserTranscript.textContent = transcript || "I heard audio, but no words came through.";
    if (voiceAssistantReply) voiceAssistantReply.textContent = reply;
    if (transcript) pushAgentHistory("user", transcript);
    pushAgentHistory("assistant", reply);
    if (payload.context?.status) renderPlatformStatus(payload.context.status);
    turnInFlight = false;
    playAssistantReply(reply, payload.audio);
  } catch (error) {
    const reply = "Voice failed: " + error.message;
    if (voiceAssistantReply) voiceAssistantReply.textContent = reply;
    turnInFlight = false;
    setVoiceMode("listening", "Listening", "Voice hit an error. Try speaking again.");
    speakAnswer(reply);
  }
}

function beginRecording() {
  if (!voiceSessionActive || turnInFlight || mediaRecorder?.state === "recording") return;
  const mimeType = bestAudioMimeType();
  voiceChunks = [];
  discardRecording = false;
  speechStarted = true;
  quietSince = 0;
  recordStartedAt = performance.now();
  mediaRecorder = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);
  mediaRecorder.ondataavailable = (event) => {
    if (event.data?.size) voiceChunks.push(event.data);
  };
  mediaRecorder.onstop = () => {
    const blob = new Blob(voiceChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
    mediaRecorder = null;
    voiceChunks = [];
    speechStarted = false;
    quietSince = 0;
    if (discardRecording || !voiceSessionActive || blob.size < 900) {
      turnInFlight = false;
      return resumeVoiceSession();
    }
    sendVoiceTurn(blob);
  };
  setVoiceMode("recording", "Listening", "I will send this when you pause.");
  mediaRecorder.start(120);
}

function finishRecording(discard = false) {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  discardRecording = discard;
  if (!discard) setVoiceMode("thinking", "Thinking", "Sending that question.");
  mediaRecorder.stop();
}

function voiceLevel() {
  if (!analyser || !analyserBuffer) return 0;
  analyser.getByteTimeDomainData(analyserBuffer);
  let sum = 0;
  for (const value of analyserBuffer) {
    const centered = (value - 128) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / analyserBuffer.length);
}

function startVadLoop() {
  const tick = () => {
    if (!voiceSessionActive) return;
    const level = voiceLevel();
    const normalized = Math.min(1, level * 18);
    if (voiceAgent) voiceAgent.style.setProperty("--voice-level", normalized.toFixed(3));
    const state = voiceAgent?.dataset.state;
    const threshold = state === "speaking" ? VOICE_BARGE_THRESHOLD : VOICE_IDLE_THRESHOLD;
    const heardSpeech = level > threshold;
    const now = performance.now();

    if (heardSpeech && !turnInFlight) {
      if (state === "speaking") stopPlayback(false);
      beginRecording();
    }

    if (mediaRecorder?.state === "recording") {
      if (heardSpeech) {
        quietSince = 0;
      } else {
        if (!quietSince) quietSince = now;
        const longEnough = now - recordStartedAt > VOICE_MIN_TURN_MS;
        if (longEnough && now - quietSince > VOICE_SILENCE_MS) finishRecording(false);
      }
      if (now - recordStartedAt > VOICE_MAX_TURN_MS) finishRecording(false);
    }

    vadFrame = requestAnimationFrame(tick);
  };
  vadFrame = requestAnimationFrame(tick);
}

async function startVoiceSession() {
  if (!mediaSupported()) {
    setVoiceMode("idle", "Voice unavailable", "This browser cannot record microphone audio here. Use a quick prompt.");
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    audioContext = new AudioContext({ latencyHint: "interactive" });
    const source = audioContext.createMediaStreamSource(micStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.28;
    analyserBuffer = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
    voiceSessionActive = true;
    setVoiceMode("listening", "Listening", "Mic is on. Pause after a question to send it.");
    if (voiceUserTranscript) voiceUserTranscript.textContent = "Listening...";
    startVadLoop();
  } catch (error) {
    setVoiceMode("idle", "Mic blocked", error.name === "NotAllowedError" ? "Microphone permission is blocked." : "Could not start the microphone.");
  }
}

function stopVoiceAgent() {
  voiceSessionActive = false;
  turnInFlight = false;
  if (vadFrame) cancelAnimationFrame(vadFrame);
  vadFrame = null;
  finishRecording(true);
  stopPlayback(false);
  if (micStream) micStream.getTracks().forEach((track) => track.stop());
  micStream = null;
  analyser = null;
  analyserBuffer = null;
  if (audioContext) audioContext.close().catch(() => {});
  audioContext = null;
  if (voiceAgent) voiceAgent.style.setProperty("--voice-level", "0");
  setVoiceMode("idle", "Mic off", "Voice stopped. Click once when you want the live agent again.");
}

function startVoiceAgent() {
  if (voiceSessionActive) {
    stopVoiceAgent();
    return;
  }
  if (voiceAgent?.dataset.state === "speaking") {
    stopPlayback(false);
    setVoiceMode("idle", "Mic off", "Voice stopped. Click once when you want the live agent again.");
    return;
  }
  startVoiceSession();
}

function initializeVoiceAgent() {
  if (!voiceAgent) return;
  if (mediaSupported()) {
    setVoiceMode("idle", "Mic off", "Click once to keep the agent listening. Pause to send, talk over it to interrupt.");
  } else {
    setVoiceMode("idle", "Voice unavailable", "This browser cannot record microphone audio here. Use a quick prompt.");
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
  if (parts[0] === "new-stores") return { name: "newStores" };
  if (parts[0] === "departments" && parts[1]) return { name: "department", id: decodeURIComponent(parts[1]) };
  return { name: "departments" };
}

function showView(name) {
  Object.entries(views).forEach(([key, node]) => {
    if (node) node.hidden = key !== name;
  });
  // Department detail is a child of Departments, so the nav keeps that tab lit.
  const navKey = name === "department" ? "departments" : name;
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
            <input id="epPrice" name="price" type="number" min="0" step="0.01" value="${escapeHtml(normalizePrice(product.minPrice))}" aria-describedby="epPriceError">
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
  const intakeCard = e.target.closest(".store-request-card");
  if (intakeCard?.dataset.intakeId) return openCustomerIntake(intakeCard.dataset.intakeId);

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
if (agentVoiceButton) agentVoiceButton.addEventListener("click", startVoiceAgent);
if (voiceRepeat) voiceRepeat.addEventListener("click", () => speakAnswer(lastAssistantReply));
if (voiceStop) voiceStop.addEventListener("click", stopVoiceAgent);
document.querySelectorAll("[data-agent-prompt]").forEach((button) => {
  button.addEventListener("click", () => askDashboardAgent(button.dataset.agentPrompt));
});
initializeVoiceAgent();

window.addEventListener("hashchange", handleRoute);
handleRoute();

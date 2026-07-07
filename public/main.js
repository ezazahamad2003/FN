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

   This file only owns presentation: it maps SSE `step`/`state` onto a visual
   timeline + progress bar, renders file previews, renders the review gate,
   and handles the folder conflict with an accessible modal.
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

  const productsHtml = data.products
    .map((p) => {
      const chips = [
        metaChip("Color", p.garmentColor || "not stated", Boolean(p.garmentColor)),
        metaChip("Placement", p.placement + (p.placementStated ? "" : " (default)"), p.placementStated),
        metaChip("Sizes", p.sizes.join(", ") + (p.sizesStated ? "" : " (default)"), p.sizesStated),
        p.brandStyle ? metaChip("Style", p.brandStyle, true) : "",
        p.fabricDetails ? metaChip("Fabric", p.fabricDetails, true) : "",
        p.decorationMethod ? metaChip("Decoration", p.decorationMethod, true) : ""
      ]
        .filter(Boolean)
        .join("");
      const logoLine = p.logos && p.logos.length
        ? `<p class="rv-logos">Logos: ${escapeHtml(p.logos.join(", "))}</p>`
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
        <h2>${count} ${count === 1 ? "product" : "products"} detected from the policy</h2>
      </div>
      <span class="confidence" data-tone="${conf.tone}">${conf.label}</span>
    </div>
    ${gapsHtml}
    ${emailHtml}
    <div class="rv-products">${productsHtml}</div>
  `;
  analysis.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const copyBtn = el("copyEmailBtnAnalysis");
  if (copyBtn) copyBtn.addEventListener("click", () => copyEmail(analysisEmailDraft, copyBtn, "emailBodyAnalysis"));
}

async function runAnalyze() {
  const hasPolicy = policyInput.files.length > 0 || followUpInput.files.length > 0 || el("followUpText").value.trim();
  if (!hasPolicy) {
    setRunHeader("idle", "Add a policy first", "Upload a policy document (or paste follow-up text) to analyze.");
    addNotice("Add a policy document (or follow-up text) before analyzing.");
    return;
  }

  const btn = el("analyzeButton");
  btn.disabled = true;
  runButton.disabled = true;
  btn.querySelector(".btn-label").textContent = "Analyzing…";
  btn.insertAdjacentHTML("afterbegin", '<span class="spinner" aria-hidden="true"></span>');
  setRunHeader("running", "Analyzing policy", "Reading the document and drafting the gaps email. Nothing is being created.");

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
    btn.querySelector(".btn-label").textContent = "Analyze policy & draft email";
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

  const productsHtml = data.products
    .map((p) => {
      const chips = [
        metaChip("Color", p.garmentColor || "not stated", Boolean(p.garmentColor)),
        metaChip("Placement", p.placement + (p.placementStated ? "" : " (default)"), p.placementStated),
        metaChip("Sizes", p.sizes.join(", ") + (p.sizesStated ? "" : " (default)"), p.sizesStated),
        p.brandStyle ? metaChip("Style", p.brandStyle, true) : "",
        p.fabricDetails ? metaChip("Fabric", p.fabricDetails, true) : "",
        p.decorationMethod ? metaChip("Decoration", p.decorationMethod, true) : ""
      ]
        .filter(Boolean)
        .join("");
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
  if (!departmentInput.value.trim()) {
    showFieldError(departmentInput, departmentError, "Department name is required.");
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

async function readSseStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = parseSseChunk(buffer, handleEvent);
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
wireDropzone("followUps", followUpInput, renderFollowUpChips, isDoc);
refreshConnectionState();

/* =============================================================================
   FN Onboarding — front-end controller
   -----------------------------------------------------------------------------
   Backend contract is unchanged:
     • POST /onboard (multipart: departmentName, logos[], policies[], conflictStrategy)
       → 400/401 JSON error, 409 JSON folder-conflict, or an SSE stream of
         `status` / `error` / `summary` events (each with a `step` + `state`).
     • GET  /health → { shopifyConnected, shopifyStore, googleConnected }
     • POST /auth/{shopify|google}/disconnect

   This file only owns presentation: it maps SSE `step`/`state` onto a visual
   timeline + progress bar, renders file previews, and handles the folder
   conflict with an accessible modal instead of window.confirm.
   ========================================================================== */

const TOTAL_STEPS = 9; // steps rendered in the timeline (10 = summary event)

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

/* -----------------------------------------------------------------------------
   Summary
   -------------------------------------------------------------------------- */
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
  `;
  summary.scrollIntoView({ behavior: "smooth", block: "nearest" });
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

function renderPolicyChips() {
  const files = [...policyInput.files];
  policyChips.innerHTML = files
    .map((file, i) => `
      <div class="chip">
        <span class="chip-glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/></svg>
        </span>
        <span class="chip-name">${escapeHtml(file.name)}</span>
        <span class="chip-size">${formatBytes(file.size)}</span>
        <button class="file-remove" type="button" data-remove-policy="${i}" aria-label="Remove ${escapeHtml(file.name)}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`)
    .join("");
  syncDropzone("policies", files.length);
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
    renderServiceCard(
      googleCard,
      status.googleConnected,
      status.googleConnected ? "Connected" : "Not connected",
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
  } else if (event === "summary") {
    setRunHeader("success", "Onboarding complete", "All assets created and published.");
    progressFill.style.width = "100%";
    progressPct.textContent = "100%";
    progressText.textContent = `${TOTAL_STEPS} of ${TOTAL_STEPS} steps`;
    progressBar.setAttribute("aria-valuenow", "100");
    renderSummary(payload);
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
  conflictStrategy.value = "fail";
  resetTimeline();
  setRunHeader("running", "Starting…", "Uploading files and preparing the workspace.");

  runButton.disabled = true;
  runButton.querySelector(".btn-label").textContent = "Running…";
  runButton.insertAdjacentHTML("afterbegin", '<span class="spinner" aria-hidden="true"></span>');

  try {
    await submitOnboarding();
  } catch (err) {
    setRunHeader("error", "Run failed", "An unexpected error interrupted the run.");
    showRunError(err.message || "Unexpected error.");
  } finally {
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

wireDropzone("logos", logoInput, renderLogoThumbs, isImage);
wireDropzone("policies", policyInput, renderPolicyChips, isDoc);
refreshConnectionState();

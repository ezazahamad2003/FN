/* =============================================================================
   FN Operations console — Department Onboarding Agent
   -----------------------------------------------------------------------------
   Renders the three onboarding routes into #onboardingBody:

     #/onboarding            → mount("list")       the queue + capabilities
     #/onboarding/:id        → mount("detail", id) one department onboarding
     #/onboarding/reference  → mount("reference")  the source-of-truth tables

   Backend contract (docs/department-onboarding-agent.md §4, all admin-gated):
     GET    /api/onboardings                         → { onboardings: [summary] }
     POST   /api/onboardings                         → multipart, 201 { onboarding }
     GET    /api/onboardings/:id                     → { onboarding }
     PATCH  /api/onboardings/:id                     → { onboarding }
     DELETE /api/onboardings/:id                     → { confirmName }
     POST   /api/onboardings/:id/files               → multipart, { onboarding }
     DELETE /api/onboardings/:id/files/:assetId      → { onboarding }
     GET    /api/onboardings/:id/assets/:assetId     → binary
     POST   /api/onboardings/:id/setup|code|review   → { onboarding }
     PUT    /api/onboardings/:id/products            → { onboarding }
     POST   /api/onboardings/:id/production-files    → { onboarding }
     POST   /api/onboardings/:id/build               → 202 { started, build }
     POST   /api/onboardings/:id/shared-settings/*   → { onboarding }
     POST   /api/onboardings/:id/lock|final-check    → { onboarding }
     GET    /api/onboardings/capabilities            → { shopify, drive, … }
     GET    /api/reference/:table                    → { rows, proposals }
     POST   /api/reference/:table/rows|proposals/:id
     POST   /api/reference/department-codes/sync

   This file shares one global script scope with public/main.js (both are
   classic scripts, no modules), so everything lives inside an IIFE and the
   ONLY global it defines is window.FNOnboarding. main.js's helpers — el,
   escapeHtml, formatBytes, stateBlock, statusChip, adminFetch, setInputFiles,
   mergeFiles, wireDropzone, isImage, isDoc, showFieldError, hideFieldError,
   markDropzoneInvalid — are called by name, never redeclared: a duplicate
   top-level binding would be a SyntaxError that kills the whole console.
   ========================================================================== */
(function () {
  "use strict";

  const ROOT_ID = "onboardingBody";
  const API = "/api/onboardings";
  const REF_API = "/api/reference";
  const POLL_MS = 5000;
  const LOG_TAIL = 14;
  const OPERATOR_KEY = "fnOnboardingBy";

  /* ---------------------------------------------------------------------------
     Static vocabulary. Every rule (SKUs, tags, names, folder names, insert
     positions) belongs to onboardingRules.js on the server — the lists below
     are only what the operator picks FROM, and the server validates the pick.
     ------------------------------------------------------------------------ */
  const PHASES = [
    { key: "packet", label: "Packet", panel: "packet" },
    { key: "setup", label: "Setup", panel: "setup" },
    { key: "inputs", label: "Build inputs", panel: "inputs" },
    { key: "build", label: "Build", panel: "build" },
    { key: "report", label: "Report", panel: "report" }
  ];

  // Upload kinds accepted by POST …/files (record schema §2, packet.files.kind).
  const FILE_KINDS = [
    { key: "policy", label: "Uniform policy" },
    { key: "artwork", label: "Artwork" },
    { key: "contacts", label: "Contact list" },
    { key: "blank", label: "Blank garment photo" },
    { key: "proof", label: "Embroidery proof" },
    { key: "print", label: "Print file copy" },
    { key: "other", label: "Other" }
  ];

  // Banner-logo roles: the collection banner picks the department's own choice
  // first, then scramble, then chest, then back (spec §6).
  const ARTWORK_ROLES = [
    { key: "", label: "Unassigned" },
    { key: "pick", label: "Department's pick" },
    { key: "scramble", label: "Scramble logo" },
    { key: "chest", label: "Chest logo" },
    { key: "back", label: "Back logo" }
  ];

  const DECORATION_METHODS = [
    { key: "", label: "—" },
    { key: "print", label: "Print" },
    { key: "embroidery", label: "Embroidery" }
  ];

  const FULFILLMENTS = ["One Week Item", "Non Stock Item"];

  const SIZE_HINT = "Comma separated. XS–3XL · talls LT, XLT, 2XLT, 3XLT · numeric 28–56 · hats OSFA or S/M, L/XL.";
  const DECORATION_HINT = "Front, back, then sleeve, joined with “/” — F01/B01, E01, F01/B01/RS01. Print and embroidery never mix.";

  const SHARED_KINDS = [
    { key: "megaMenu", label: "Mega Menu", sub: "Link the collection under Store, oldest → newest, above the public stores." },
    { key: "flow", label: "Shopify Flow", sub: "Add the department tag to the condition before “Send transactional email”." },
    { key: "helium", label: "Helium Customer Fields", sub: "Add the tag to the Department field in every form, alphabetically." }
  ];

  const REFERENCE_TABS = [
    {
      key: "department-codes",
      label: "Department codes",
      keyField: "code",
      sync: true,
      columns: [
        { k: "code", label: "Code", mono: true, input: true, required: true },
        { k: "agency", label: "Agency", input: true, required: true },
        { k: "city", label: "City", input: true },
        { k: "state", label: "State", input: true },
        { k: "source", label: "Source" },
        { k: "status", label: "Status" }
      ]
    },
    {
      key: "color-codes",
      label: "Color codes",
      keyField: "code",
      columns: [
        { k: "code", label: "Code", mono: true, input: true, required: true },
        { k: "color", label: "Colour", input: true, required: true },
        { k: "note", label: "Note", input: true },
        { k: "status", label: "Status" }
      ]
    },
    {
      key: "blank-library",
      label: "Blank library",
      keyField: "styleNumber",
      columns: [
        { k: "styleNumber", label: "Style", mono: true, input: true, required: true },
        { k: "brand", label: "Brand", input: true, required: true },
        { k: "type", label: "Type", input: true },
        { k: "decoration", label: "Decoration", input: true },
        { k: "fulfillmentDefault", label: "Fulfillment", input: true },
        { k: "sizes", label: "Sizes" },
        { k: "colors", label: "Colours" }
      ]
    },
    {
      key: "standard-text",
      label: "Standard text",
      keyField: "id",
      columns: [
        { k: "id", label: "Id", mono: true, input: true, required: true },
        { k: "title", label: "Title", input: true, required: true },
        { k: "use", label: "Used on", input: true },
        { k: "text", label: "Text", wide: true, input: true, type: "textarea" }
      ]
    }
  ];

  /* ---- Icons (inline so the console needs no icon font or extra request) --- */
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const ICON_PLUS = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';
  const ICON_ALERT = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
  const ICON_BADGE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.4 9.1 8 11 4.6-1.9 8-6 8-11V5Z"/><polyline points="9 12 11 14 15 10"/></svg>';
  const ICON_FILE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

  /* ---------------------------------------------------------------------------
     Module state. `view`/`id` are the cancellation token for every async
     paint: a response that lands after the operator has navigated away must
     never overwrite the page they are now looking at.
     ------------------------------------------------------------------------ */
  const state = {
    view: null,
    id: null,
    record: null,
    refTab: REFERENCE_TABS[0].key,
    refFilter: "",
    refData: null,
    // Capabilities are read on the list view but needed on the detail view too
    // (the lock card offers to create a lock only when Locksmith is reachable).
    caps: null,
    pollTimer: null
  };
  const objectUrls = new Set();
  // asset URL -> object URL, so a repaint reuses what was already fetched.
  const assetObjectUrls = new Map();
  let modalState = null;

  /* =========================================================================
     Small helpers
     ====================================================================== */
  const esc = escapeHtml;

  function root() {
    return el(ROOT_ID);
  }

  function isCurrent(view, id) {
    return state.view === view && (id === undefined || String(state.id || "") === String(id || ""));
  }

  function list(value) {
    return Array.isArray(value) ? value : [];
  }

  function csv(value) {
    return list(value).join(", ");
  }

  function parseList(value) {
    return String(value || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function day(iso) {
    return String(iso || "").slice(0, 10);
  }

  function when(iso) {
    const text = String(iso || "");
    if (!text) return "";
    return `${text.slice(0, 10)} ${text.slice(11, 16)}`.trim();
  }

  function plural(count, one, many) {
    return count === 1 ? one : many;
  }

  /* sessionStorage can throw in a locked-down browser profile; a missing
     operator name is never a reason to break the page. */
  function operator() {
    try {
      return sessionStorage.getItem(OPERATOR_KEY) || "";
    } catch {
      return "";
    }
  }

  function setOperator(value) {
    try {
      sessionStorage.setItem(OPERATOR_KEY, String(value || ""));
    } catch {
      /* ignore — the name is a convenience, not state the agent depends on */
    }
  }

  function gatedDeploy() {
    try {
      return Boolean(sessionStorage.getItem("fnAdminToken"));
    } catch {
      return false;
    }
  }

  async function api(path, options) {
    const res = await adminFetch(path, options);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `Request failed (${res.status}).`);
    return payload;
  }

  function recordPath(id, suffix = "") {
    return `${API}/${encodeURIComponent(id)}${suffix}`;
  }

  function assetUrl(id, assetId) {
    return `${recordPath(id)}/assets/${encodeURIComponent(assetId)}`;
  }

  /* ---- Tones: colour is the signal, so one mapping drives chips, borders,
     and progress bars everywhere in this view. ------------------------------ */
  function statusTone(status) {
    const value = String(status || "");
    if (value === "complete") return "ok";
    if (value === "built") return "ok";
    if (value === "build-error") return "danger";
    if (value === "built-partial") return "warn";
    if (value === "building") return "info";
    return "muted";
  }

  function statusLabel(status) {
    return String(status || "packet").replace(/-/g, " ");
  }

  function buildTone(buildState) {
    const value = String(buildState || "");
    if (value === "complete") return "ok";
    if (value === "running") return "info";
    if (value === "failed" || value === "error") return "danger";
    if (value === "partial" || value === "interrupted") return "warn";
    return "muted";
  }

  function sharedTone(status) {
    const value = String(status || "");
    if (value === "verified" || value === "applied" || value === "confirmed" || value === "created") return "ok";
    if (value === "error") return "danger";
    if (value === "proposed" || value === "approved") return "info";
    if (value === "manual" || value === "partial") return "warn";
    return "muted";
  }

  function pathTone(path) {
    const value = String(path || "");
    if (value === "render") return "ok";
    if (value === "stock") return "info";
    if (value === "render-failed") return "warn";
    return "muted";
  }

  /* Where the GARMENT came from, which `path` does not say: a rendered logo on
     an invented blank and a rendered logo on Dan's photo both read "render".
     Only the invented case needs to catch the eye. */
  const BASE_BADGES = {
    photo: { label: "blank photo", tone: "ok" },
    supplier: { label: "supplier photo", tone: "info" },
    generated: { label: "AI blank", tone: "warn" }
  };

  function baseBadge(base) {
    const badge = BASE_BADGES[String(base || "")];
    if (!badge) return "";
    return `<span class="ob-badge" data-tone="${esc(badge.tone)}" title="${esc(
      base === "generated"
        ? "The garment in this image was generated, not photographed. Upload a blank photo and re-run to replace it."
        : "The garment in this image comes from a real photograph."
    )}">${esc(badge.label)}</span>`;
  }

  function chip(label, tone) {
    return `<span class="status-chip" data-tone="${esc(tone)}">${esc(label)}</span>`;
  }

  function codeChip(department) {
    const code = department?.code || {};
    const value = code.value || "no code";
    const tone = code.approved ? "ok" : code.value ? "warn" : "muted";
    const suffix = code.approved ? "approved" : code.value ? `${code.source || "proposed"} · needs approval` : "not looked up";
    return `<span class="ob-code-chip" data-tone="${esc(tone)}"><b>${esc(value)}</b><small>${esc(suffix)}</small></span>`;
  }

  function banner(id) {
    return `<div class="banner ob-banner" id="${esc(id)}" role="alert" hidden>
      <span class="b-glyph" aria-hidden="true">${ICON_ALERT}</span>
      <span data-ob-banner-text></span>
    </div>`;
  }

  function showBanner(scope, id, message, tone = "danger") {
    const node = scope?.querySelector(`#${id}`);
    if (!node) return;
    node.querySelector("[data-ob-banner-text]").textContent = message;
    // The banner is styled danger by default; an "ok" tone is how a finished
    // background job reports itself without looking like a failure.
    if (tone === "ok") node.dataset.tone = "ok";
    else delete node.dataset.tone;
    node.hidden = false;
    node.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }

  function hideBanner(scope, id) {
    const node = scope?.querySelector(`#${id}`);
    if (!node) return;
    node.hidden = true;
    delete node.dataset.tone;
  }

  function prefersReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /* Runs one button's async action: busy label, disabled control, inline
     error. Never window.alert — the operator must keep the page context. */
  async function runAction(button, busyLabel, fn, scope, bannerId) {
    if (!button) return;
    const original = button.innerHTML;
    button.disabled = true;
    button.dataset.obBusy = "true";
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(busyLabel)}`;
    if (scope && bannerId) hideBanner(scope, bannerId);
    try {
      await fn();
    } catch (error) {
      if (scope && bannerId) showBanner(scope, bannerId, error?.message || "That did not work.");
      button.disabled = false;
      delete button.dataset.obBusy;
      button.innerHTML = original;
    }
  }

  async function copyText(text, button) {
    const value = String(text || "");
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      // Clipboard API needs a secure context; the textarea route always works.
      const holder = document.createElement("textarea");
      holder.value = value;
      holder.setAttribute("readonly", "readonly");
      holder.className = "sr-only";
      document.body.appendChild(holder);
      holder.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      holder.remove();
    }
    if (!button) return ok;
    const label = button.dataset.obLabel || button.textContent;
    button.dataset.obLabel = label;
    button.textContent = ok ? "Copied" : "Copy failed";
    window.setTimeout(() => {
      button.textContent = label;
    }, 1600);
    return ok;
  }

  /* An <img> cannot carry the admin bearer header, so on a gated deploy the
     asset is fetched through adminFetch and shown from an object URL. On an
     open deploy the plain src is one request instead of two. */
  function hydrateAssetImages(scope) {
    if (!scope) return;
    const gated = gatedDeploy();
    scope.querySelectorAll("img[data-ob-src]").forEach((img) => {
      const url = img.dataset.obSrc;
      delete img.dataset.obSrc;
      img.addEventListener("error", () => markImageBroken(img), { once: true });
      if (!gated) {
        img.src = url;
        return;
      }
      /* The build panel repaints every 5 seconds, and each repaint re-emits
         every mockup. Fetching each one again would leak a blob URL per image
         per poll — a long build with a dozen mockups holds tens of megabytes
         by the end. One object URL per asset, reused, released on unmount. */
      const cached = assetObjectUrls.get(url);
      if (cached) {
        img.src = cached;
        return;
      }
      adminFetch(url)
        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error("asset unavailable"))))
        .then((blob) => {
          const objectUrl = URL.createObjectURL(blob);
          objectUrls.add(objectUrl);
          assetObjectUrls.set(url, objectUrl);
          img.src = objectUrl;
        })
        .catch(() => markImageBroken(img));
    });
  }

  function markImageBroken(img) {
    const holder = img.closest(".ob-thumb");
    if (holder) holder.dataset.broken = "true";
    img.remove();
  }

  function releaseObjectUrls() {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
    assetObjectUrls.clear();
  }

  /* =========================================================================
     Modal — created on demand (index.html carries no onboarding dialog),
     with Escape, a focus trap, a close affordance, and a backdrop click.
     ====================================================================== */
  function openModal({ id, title, sub, bodyHtml }) {
    closeModal();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay ob-modal-overlay";
    overlay.innerHTML = `
      <div class="modal modal-wide ob-modal" role="dialog" aria-modal="true" aria-labelledby="${esc(id)}Title">
        <div class="modal-head">
          <span class="m-glyph" data-tone="brand" aria-hidden="true">${ICON_BADGE}</span>
          <div>
            <h2 id="${esc(id)}Title">${esc(title)}</h2>
            ${sub ? `<p class="modal-sub">${esc(sub)}</p>` : ""}
          </div>
          <button class="icon-btn" type="button" data-ob-modal-close aria-label="Close ${esc(title)}">${ICON_CLOSE}</button>
        </div>
        ${bodyHtml}
      </div>`;
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
    modalState = { overlay, lastFocus: document.activeElement, busy: false };
    document.addEventListener("keydown", onModalKeydown);
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay && !modalState?.busy) closeModal();
    });
    overlay.querySelector("[data-ob-modal-close]")?.addEventListener("click", () => {
      if (!modalState?.busy) closeModal();
    });
    const first = overlay.querySelector("input, select, textarea, button:not([data-ob-modal-close])");
    if (first?.focus) first.focus();
    return overlay;
  }

  function closeModal() {
    if (!modalState) return;
    document.removeEventListener("keydown", onModalKeydown);
    modalState.overlay.remove();
    document.body.style.overflow = "";
    const back = modalState.lastFocus;
    modalState = null;
    if (back?.focus) back.focus();
  }

  function onModalKeydown(event) {
    if (!modalState) return;
    // A submit is in flight once the form marks itself busy: Escape would
    // abandon a multipart upload whose result the operator cannot see.
    if (event.key === "Escape" && !modalState.busy) {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...modalState.overlay.querySelectorAll("button, input, select, textarea, a[href]")].filter(
      (node) => !node.disabled && node.offsetParent !== null
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* =========================================================================
     LIST VIEW — the onboarding queue
     ====================================================================== */
  function renderList() {
    const node = root();
    if (!node) return;
    node.innerHTML = `
      <div class="ob-list" data-ob-page="list">
        <section class="hero">
          <p class="eyebrow">Department Onboarding Agent</p>
          <h2>Build a fire department's private store from the packet, by the rules.</h2>
          <p>Upload the packet and the agent confirms the department code, creates the Drive folders, reviews the policy, drafts the rep email, renders the mockups, and builds the collection, lock, and products — every product in Draft, every approval recorded.</p>
          <div class="hero-actions">
            <button class="btn btn-primary btn-sm" type="button" data-ob="new">${ICON_PLUS} New onboarding</button>
            <a class="btn btn-secondary btn-sm" href="#/onboarding/reference">Reference tables</a>
            <button class="btn btn-ghost btn-sm" type="button" data-ob="refresh-list">Refresh</button>
          </div>
        </section>
        <section class="ob-caps" id="obCaps" aria-label="What the agent can reach"></section>
        <div id="obListBody"></div>
      </div>`;
    // Listeners live on the page container, not on #onboardingBody: every
    // repaint replaces the container, so the old handlers die with it and can
    // never stack up across mounts.
    const listPage = node.querySelector("[data-ob-page='list']");
    listPage.addEventListener("click", onListClick);
    loadCapabilities();
    loadOnboardings();
  }

  function onListClick(event) {
    const action = event.target.closest("[data-ob]")?.dataset.ob;
    if (action === "new") openNewOnboarding();
    else if (action === "refresh-list") {
      loadCapabilities();
      loadOnboardings();
    } else if (action === "retry-caps") loadCapabilities();
  }

  async function loadCapabilities() {
    const holder = el("obCaps");
    if (!holder) return;
    holder.innerHTML = `<p class="ob-caps-loading muted">Checking what the agent can reach…</p>`;
    try {
      const payload = await api(`${API}/capabilities`);
      state.caps = payload;
      if (!isCurrent("list")) return;
      holder.innerHTML = capabilityCards(payload);
    } catch (error) {
      if (!isCurrent("list")) return;
      holder.innerHTML = `<p class="ob-caps-loading" data-tone="warn">Could not read the agent's capabilities: ${esc(error.message)}
        <button class="btn btn-ghost btn-sm" type="button" data-ob="retry-caps">Try again</button></p>`;
    }
  }

  /* The capabilities payload is deliberately read loosely: each service
     reports its own shape ({configured}, {connected}, {readable, writable}),
     and a missing key must read as "needs attention", never as a crash. */
  function capOk(node) {
    if (node == null) return false;
    if (typeof node === "boolean") return node;
    if (typeof node === "string") return Boolean(node);
    // capabilities() reports Helium as { forms: [...] } with no ok/configured
    // flag, so the ?? chain below would read the whole card as "not ready"
    // even with every form configured.
    if (Array.isArray(node.forms)) return node.forms.length > 0;
    const value = node.ok ?? node.connected ?? node.configured ?? node.available ?? node.readable ?? node.writable;
    return Boolean(value);
  }

  /*
   * A raw API error is not a status line. The Mega Menu capability, for
   * example, fails with a whole GraphQL ACCESS_DENIED payload, which read as
   * a wall of JSON in the strip; an operator needs "what does this mean for
   * me", so the known causes get plain wording and anything else is trimmed.
   */
  function capReason(text, fallback) {
    const raw = String(text || "").trim();
    if (!raw) return fallback;
    if (/ACCESS_DENIED|access denied|access scope/i.test(raw)) return "Scope not granted — Dan applies this from the checklist";
    if (/\bnot configured\b|no access token/i.test(raw)) return fallback;
    const clean = raw.replace(/\s+/g, " ");
    return clean.length > 90 ? `${clean.slice(0, 87)}…` : clean;
  }

  function capDetail(node, fallback) {
    if (node == null) return fallback;
    if (typeof node === "boolean") return node ? "Ready" : fallback;
    if (typeof node === "string") return node;
    if (node.detail || node.reason || node.error) return capReason(node.detail || node.reason || node.error, fallback);
    if (node.model) return String(node.model);
    if (node.store || node.shop) return String(node.store || node.shop);
    if (Array.isArray(node.forms)) {
      const publicForms = node.forms.filter((form) => form?.public !== false).length;
      return `${node.forms.length} form${plural(node.forms.length, "", "s")} · ${publicForms} readable`;
    }
    if (node.readable !== undefined || node.writable !== undefined) {
      return `${node.readable ? "readable" : "not readable"} · ${node.writable ? "writable" : "checklist only"}`;
    }
    return capOk(node) ? "Ready" : fallback;
  }

  function capabilityCards(caps) {
    const items = [
      { label: "Shopify", node: caps?.shopify, fallback: "Not connected" },
      { label: "Google Drive", node: caps?.drive, fallback: "Not connected" },
      { label: "Image model", node: caps?.imageModel, fallback: "Not configured" },
      { label: "Locksmith", node: caps?.locksmith, fallback: "Checklist only — no access token" },
      { label: "Helium forms", node: caps?.helium, fallback: "Checklist only" },
      { label: "Mega Menu scope", node: caps?.megaMenu, fallback: "Checklist only — no menu scope" }
    ];
    return items
      .map((item) => {
        const ok = capOk(item.node);
        return `
        <div class="ob-cap" data-tone="${ok ? "ok" : "warn"}">
          <span class="ob-cap-dot" aria-hidden="true"></span>
          <b>${esc(item.label)}</b>
          <small>${esc(capDetail(item.node, item.fallback))}</small>
        </div>`;
      })
      .join("");
  }

  async function loadOnboardings() {
    const body = el("obListBody");
    if (!body) return;
    body.innerHTML = stateBlock({ tone: "info", title: "Loading onboardings…", sub: "Reading the department onboarding records.", spinner: true });
    try {
      const payload = await api(API);
      if (!isCurrent("list")) return;
      const records = list(payload.onboardings);
      if (!records.length) {
        body.innerHTML = stateBlock({
          title: "No onboardings yet",
          sub: "Start one with the department name and the packet Dan received — policy, artwork, and the contact list.",
          // Secondary on purpose: the hero above already carries this screen's
          // single primary CTA.
          actionHtml: '<button class="btn btn-secondary btn-sm" type="button" data-ob="new">New onboarding</button>'
        });
        return;
      }
      body.innerHTML = `<div class="store-card-grid">${records.map(onboardingCard).join("")}</div>`;
    } catch (error) {
      if (!isCurrent("list")) return;
      body.innerHTML = stateBlock({
        tone: "danger",
        title: "Could not load the onboardings",
        sub: error.message,
        actionHtml: '<button class="btn btn-secondary btn-sm" type="button" data-ob="refresh-list">Try again</button>'
      });
    }
  }

  function initials(name) {
    return (
      String(name || "?")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word[0].toUpperCase())
        .join("") || "?"
    );
  }

  function onboardingCard(summary) {
    const department = summary?.department || {};
    const name = department.name || "Untitled department";
    const tone = statusTone(summary?.status);
    const counts = summary?.counts || {};
    const build = summary?.build || {};
    // The list payload carries counts, not the step array (a summary stays
    // small), so the bar reads those.
    const done = Number(build.stepsDone || 0);
    const total = Number(build.stepsTotal || 0);
    const pct = total ? Math.round((done / total) * 100) : build.state === "complete" ? 100 : 0;
    const progress = build.state
      ? `<span class="store-card-progress" data-tone="${esc(buildTone(build.state))}">
          <span class="scp-bar"><span style="width:${pct}%"></span></span>
          <small>${esc(build.state === "running" ? `Building — ${done} of ${total || "?"} steps` : `Build ${build.state}${build.finishedAt ? ` · ${day(build.finishedAt)}` : ""}`)}</small>
        </span>`
      : `<span class="store-card-progress" data-tone="muted"><small>Not built yet</small></span>`;
    const meta = [
      `${counts.products || 0} product${plural(counts.products || 0, "", "s")}`,
      `${counts.mockups || 0} mockup${plural(counts.mockups || 0, "", "s")}`,
      `${counts.packetFiles || 0} file${plural(counts.packetFiles || 0, "", "s")}`,
      summary?.updatedAt ? `updated ${day(summary.updatedAt)}` : ""
    ]
      .filter(Boolean)
      .join(" · ");
    return `
      <a class="store-card ob-card" href="#/onboarding/${encodeURIComponent(summary?.id || "")}" data-tone="${esc(tone)}">
        <span class="store-card-badge" data-tone="${esc(tone)}" aria-hidden="true">${esc(initials(name))}</span>
        <span class="store-card-body">
          <b>${esc(name)}</b>
          <span class="ob-card-chips">
            ${codeChip(department)}
            <em class="status-chip" data-tone="${esc(tone)}">${esc(statusLabel(summary?.status))}</em>
            <em class="ob-phase-chip">${esc(phaseLabel(summary?.phase))}</em>
          </span>
          <small>${esc(meta)}</small>
          ${progress}
        </span>
      </a>`;
  }

  function phaseLabel(phase) {
    return PHASES.find((entry) => entry.key === phase)?.label || "Packet";
  }

  /* ---------------------------------------------------------------------------
     New onboarding modal
     ------------------------------------------------------------------------ */
  function dropzoneField({ name, label, hint, accept, multiple = true }) {
    return `
      <div class="field">
        <label for="${esc(name)}">${esc(label)}</label>
        <div class="dropzone" data-dropzone="${esc(name)}">
          <input id="${esc(name)}" name="${esc(name)}" type="file" ${multiple ? "multiple" : ""} ${accept ? `accept="${esc(accept)}"` : ""} aria-describedby="${esc(name)}Hint">
          <span class="dz-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </span>
          <span class="dz-title"><b>Click to upload</b> or drag &amp; drop</span>
          <span class="dz-sub">${esc(hint)}</span>
        </div>
        <div class="ob-filelist" data-ob-filelist="${esc(name)}"></div>
        <p class="hint" id="${esc(name)}Hint">${esc(hint)}</p>
      </div>`;
  }

  function contactRowHtml(index) {
    return `
      <div class="ob-contact" data-ob-contact>
        <div class="category-edit-grid">
          <label><span>Name</span><input type="text" data-ob-contact-field="name" autocomplete="off"></label>
          <label><span>Role</span><input type="text" data-ob-contact-field="role" placeholder="Department rep" autocomplete="off"></label>
          <label><span>Email</span><input type="email" data-ob-contact-field="email" autocomplete="off"></label>
          <label><span>Phone</span><input type="tel" data-ob-contact-field="phone" autocomplete="off"></label>
        </div>
        <button class="variant-remove" type="button" data-ob="remove-contact" aria-label="Remove contact ${index + 1}" ${index === 0 ? "hidden" : ""}>&times;</button>
      </div>`;
  }

  function openNewOnboarding() {
    const overlay = openModal({
      id: "obNew",
      title: "New onboarding",
      sub: "The department name is the department tag — spelling and capitalisation are used everywhere else.",
      bodyHtml: `
        <form class="modal-body ob-form" id="obNewForm" novalidate>
          <div class="field">
            <label for="obNewName">Department name <span class="req" aria-hidden="true">*</span></label>
            <input id="obNewName" type="text" autocomplete="off" placeholder="Vacaville Fire Department" aria-describedby="obNewNameHint obNewNameError">
            <p class="hint" id="obNewNameHint">Exactly as it should appear in the collection title, the customer tag, and the Drive folders.</p>
            <p class="hint field-error" id="obNewNameError" hidden></p>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="obNewState">State</label>
              <input id="obNewState" type="text" value="CA" maxlength="2" class="code-input" autocomplete="off" aria-describedby="obNewStateHint">
              <p class="hint" id="obNewStateHint">Out-of-state departments are not on the MACS list, so the agent proposes a code.</p>
            </div>
            <div class="field">
              <label for="obNewOrdinal">Store</label>
              <select id="obNewOrdinal">
                <option value="1">1 — the department's main store</option>
                <option value="2">2 — a second store (union, auxiliary…)</option>
                <option value="3">3 — a third store</option>
                <option value="4">4 — a fourth store</option>
              </select>
              <p class="hint">The collection title is “1. Department Name”, “2. Store Name”, and so on.</p>
            </div>
          </div>
          <div class="field" id="obNewStoreNameField" hidden>
            <label for="obNewStoreName">Store name <span class="req" aria-hidden="true">*</span></label>
            <input id="obNewStoreName" type="text" autocomplete="off" placeholder="Vacaville Firefighters Association" aria-describedby="obNewStoreNameError">
            <p class="hint field-error" id="obNewStoreNameError" hidden></p>
          </div>
          <fieldset class="ob-fieldset">
            <legend>Department contacts</legend>
            <div class="ob-contacts" data-ob-contacts>${contactRowHtml(0)}</div>
            <button class="btn btn-ghost btn-sm" type="button" data-ob="add-contact">+ Add contact</button>
          </fieldset>
          <div class="field">
            <label for="obNewNotes">Notes</label>
            <textarea id="obNewNotes" rows="3" placeholder="Anything Dan already knows: preferred garments, deadlines, who to ask."></textarea>
          </div>
          <div class="ob-upload-grid">
            ${dropzoneField({ name: "policies", label: "Policy documents", hint: "PDF, Word, or text. The agent reads these for garments, colours, and placement.", accept: ".pdf,.doc,.docx,.txt" })}
            ${dropzoneField({ name: "artwork", label: "Artwork", hint: "Logos as images. Scramble, chest, and back art become mockups and the banner.", accept: "image/*" })}
            ${dropzoneField({ name: "contacts", label: "Contact list", hint: "The roster or contact sheet from the department.", accept: ".pdf,.doc,.docx,.txt,.csv,.xlsx" })}
            ${dropzoneField({ name: "other", label: "Other packet files", hint: "Anything else that arrived with the packet." })}
          </div>
          ${banner("obNewError")}
          <div class="modal-actions">
            <button class="btn btn-ghost" type="button" data-ob="cancel-new">Cancel</button>
            <button class="btn btn-primary" type="submit" data-ob-submit><span class="btn-label">Create onboarding</span></button>
          </div>
        </form>`
    });

    const form = overlay.querySelector("#obNewForm");
    const ordinal = overlay.querySelector("#obNewOrdinal");
    const storeNameField = overlay.querySelector("#obNewStoreNameField");

    ordinal.addEventListener("change", () => {
      storeNameField.hidden = Number(ordinal.value) <= 1;
    });

    ["policies", "artwork", "contacts", "other"].forEach((name) => {
      const input = overlay.querySelector(`#${name}`);
      const render = () => renderPickedFiles(overlay, name, input);
      wireDropzone(name, input, render, () => true);
      render();
    });

    overlay.addEventListener("click", (event) => {
      const action = event.target.closest("[data-ob]")?.dataset.ob;
      if (action === "cancel-new") {
        closeModal();
        return;
      }
      if (action === "add-contact") {
        const holder = overlay.querySelector("[data-ob-contacts]");
        const count = holder.querySelectorAll("[data-ob-contact]").length;
        holder.insertAdjacentHTML("beforeend", contactRowHtml(count));
        renumberContacts(holder);
        holder.lastElementChild?.querySelector("input")?.focus();
        return;
      }
      if (action === "remove-contact") {
        const holder = overlay.querySelector("[data-ob-contacts]");
        event.target.closest("[data-ob-contact]")?.remove();
        renumberContacts(holder);
        overlay.querySelector("[data-ob='add-contact']")?.focus();
        return;
      }
      const remove = event.target.closest("[data-ob-remove-picked]");
      if (remove) {
        const zone = remove.dataset.obRemovePicked;
        const input = overlay.querySelector(`#${zone}`);
        const index = Number(remove.dataset.obIndex);
        setInputFiles(input, [...input.files].filter((_, i) => i !== index));
        renderPickedFiles(overlay, zone, input);
      }
    });

    form.addEventListener("submit", (event) => submitNewOnboarding(event, overlay));
  }

  function renumberContacts(holder) {
    const rows = [...holder.querySelectorAll("[data-ob-contact]")];
    rows.forEach((row, index) => {
      const remove = row.querySelector("[data-ob='remove-contact']");
      if (remove) {
        remove.hidden = rows.length === 1;
        remove.setAttribute("aria-label", `Remove contact ${index + 1}`);
      }
    });
  }

  function renderPickedFiles(overlay, name, input) {
    const holder = overlay.querySelector(`[data-ob-filelist="${name}"]`);
    const zone = overlay.querySelector(`.dropzone[data-dropzone="${name}"]`);
    const files = [...input.files];
    if (zone) zone.dataset.hasFiles = files.length ? "true" : "false";
    if (!holder) return;
    // Previews are re-created on every change, so the previous batch's object
    // URLs are released here rather than leaking until the page unloads.
    holder.querySelectorAll("img[src^='blob:']").forEach((img) => {
      URL.revokeObjectURL(img.src);
      objectUrls.delete(img.src);
    });
    holder.innerHTML = files
      .map(
        (file, index) => `
          <span class="ob-picked">
            <span class="ob-picked-thumb" ${isImage(file) ? `data-ob-preview="${index}"` : ""}>${isImage(file) ? "" : `<span class="ob-file-glyph" aria-hidden="true">${ICON_FILE}</span>`}</span>
            <span class="ob-picked-name">${esc(file.name)}</span>
            <small>${esc(formatBytes(file.size))}</small>
            <button class="file-remove" type="button" data-ob-remove-picked="${esc(name)}" data-ob-index="${index}" aria-label="Remove ${esc(file.name)}">${ICON_CLOSE}</button>
          </span>`
      )
      .join("");
    // The src is assigned from the File rather than interpolated into the
    // markup: a blob: URL never goes through the HTML escaper by accident.
    holder.querySelectorAll("[data-ob-preview]").forEach((slot) => {
      const index = Number(slot.dataset.obPreview);
      const file = files[index];
      if (!file || !isImage(file)) return;
      const url = URL.createObjectURL(file);
      objectUrls.add(url);
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      slot.appendChild(img);
    });
  }

  async function submitNewOnboarding(event, overlay) {
    event.preventDefault();
    const nameInput = overlay.querySelector("#obNewName");
    const nameError = overlay.querySelector("#obNewNameError");
    const storeInput = overlay.querySelector("#obNewStoreName");
    const storeError = overlay.querySelector("#obNewStoreNameError");
    const ordinal = Number(overlay.querySelector("#obNewOrdinal").value) || 1;

    let valid = true;
    if (!nameInput.value.trim()) {
      showFieldError(nameInput, nameError, "The department name is required — it becomes the customer tag.");
      valid = false;
    } else {
      hideFieldError(nameInput, nameError);
    }
    if (ordinal > 1 && !storeInput.value.trim()) {
      showFieldError(storeInput, storeError, "A second store needs its own name for the collection title.");
      valid = false;
    } else {
      hideFieldError(storeInput, storeError);
    }
    if (!valid) {
      overlay.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }

    const contacts = [...overlay.querySelectorAll("[data-ob-contact]")]
      .map((row) => {
        const read = (field) => row.querySelector(`[data-ob-contact-field="${field}"]`)?.value.trim() || "";
        return { name: read("name"), role: read("role"), email: read("email"), phone: read("phone") };
      })
      .filter((contact) => contact.name || contact.email || contact.phone);

    const payload = {
      departmentName: nameInput.value.trim(),
      state: overlay.querySelector("#obNewState").value.trim().toUpperCase(),
      storeOrdinal: ordinal,
      storeName: ordinal > 1 ? storeInput.value.trim() : "",
      contacts,
      notes: overlay.querySelector("#obNewNotes").value.trim()
    };

    const body = new FormData();
    body.append("payload", JSON.stringify(payload));
    ["policies", "artwork", "contacts", "other"].forEach((name) => {
      const input = overlay.querySelector(`#${name}`);
      [...input.files].forEach((file) => body.append(name, file));
    });

    const submit = overlay.querySelector("[data-ob-submit]");
    const cancel = overlay.querySelector("[data-ob='cancel-new']");
    // Busy blocks Escape and the backdrop while the multipart upload is in
    // flight, so the operator cannot abandon a create they can't see the end of.
    if (modalState) modalState.busy = true;
    submit.disabled = true;
    cancel.disabled = true;
    submit.querySelector(".btn-label").textContent = "Creating…";
    submit.insertAdjacentHTML("afterbegin", '<span class="spinner" aria-hidden="true"></span>');
    hideBanner(overlay, "obNewError");
    try {
      const result = await api(API, { method: "POST", body });
      const id = result?.onboarding?.id;
      if (!id) throw new Error("The record was created without an id.");
      closeModal();
      window.location.hash = `#/onboarding/${encodeURIComponent(id)}`;
    } catch (error) {
      showBanner(overlay, "obNewError", error.message);
      if (modalState) modalState.busy = false;
      submit.disabled = false;
      cancel.disabled = false;
      submit.querySelector(".spinner")?.remove();
      submit.querySelector(".btn-label").textContent = "Create onboarding";
    }
  }

  /* =========================================================================
     DETAIL VIEW
     ====================================================================== */
  async function loadDetail(id) {
    const node = root();
    if (!node) return;
    if (!id) {
      node.innerHTML = stateBlock({ tone: "warn", title: "No onboarding selected", sub: "Open one from the queue.", actionHtml: '<a class="btn btn-secondary btn-sm" href="#/onboarding">Back to onboardings</a>' });
      return;
    }
    node.innerHTML = stateBlock({ tone: "info", title: "Loading onboarding…", sub: "Reading the department record.", spinner: true });
    try {
      const payload = await api(recordPath(id));
      if (!isCurrent("detail", id)) return;
      state.record = payload.onboarding || null;
      if (!state.record) throw new Error("That onboarding record is empty.");
      renderDetail();
    } catch (error) {
      if (!isCurrent("detail", id)) return;
      node.innerHTML = `
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/onboarding">Onboarding</a></nav>
        ${stateBlock({
          tone: "danger",
          title: "Could not open this onboarding",
          sub: error.message,
          actionHtml: `<button class="btn btn-secondary btn-sm" type="button" data-ob="retry-detail">Try again</button>`
        })}`;
      node.querySelector("[data-ob='retry-detail']")?.addEventListener("click", () => loadDetail(id));
    }
  }

  /* Which single control is THE primary action right now. One primary CTA per
     screen: the panel that owns the current blocker renders .btn-primary, and
     every other action on the page stays secondary. */
  function primaryKey(record) {
    if (!record?.department?.code?.approved) return "code";
    if (!record?.drive?.departmentFolderId) return "setup";
    if (buildBlockers(record).length) return "save-products";
    const buildState = record?.build?.state;
    if (!buildState || buildState === "failed" || buildState === "interrupted") return "build";
    if (buildState === "running") return "none";
    if (!record?.report?.generatedAt) return "final-check";
    return "none";
  }

  function btnClass(record, key) {
    return primaryKey(record) === key ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm";
  }

  function buildBlockers(record) {
    const out = [];
    if (!record?.department?.code?.approved) out.push("the department code is not approved");
    const products = list(record?.products);
    if (!products.length) out.push("no product rows are saved");
    else if (products.some((product) => product?.validation?.ok !== true)) out.push("some product rows do not validate");
    return out;
  }

  function renderDetail() {
    const node = root();
    const record = state.record;
    if (!node || !record) return;
    node.innerHTML = `
      <div class="ob-detail" data-ob-page="detail" data-ob-id="${esc(record.id || "")}">
        <nav class="crumbs" aria-label="Breadcrumb">
          <a href="#/onboarding">Onboarding</a>
          <span aria-hidden="true">/</span>
          <span aria-current="page">${esc(record.department?.name || "Department")}</span>
        </nav>
        ${banner("obDetailError")}
        ${detailHeader(record)}
        ${stepperHtml(record)}
        <div class="ob-layout">
          <div class="ob-main">
            ${packetPanel(record)}
            ${setupPanel(record)}
            ${inputsPanel(record)}
            ${buildPanel(record)}
            ${sharedPanel(record)}
            ${reportPanel(record)}
          </div>
          <aside class="ob-rail" aria-label="Approvals, log, and links">
            ${needsDanCard(record)}
            ${logCard(record)}
            ${linksCard(record)}
          </aside>
        </div>
      </div>`;

    const detailPage = node.querySelector("[data-ob-page='detail']");
    detailPage.addEventListener("click", onDetailClick);
    detailPage.addEventListener("change", onDetailChange);
    hydrateAssetImages(detailPage);
    maybePoll();
  }

  function detailHeader(record) {
    const department = record.department || {};
    const tone = statusTone(record.status);
    return `
      <header class="store-detail-head card card-pad ob-head">
        <div>
          <p class="eyebrow">Department onboarding</p>
          <h2>${esc(department.name || "Department")}</h2>
          <p class="sdh-meta">
            <span class="status-chip" data-tone="${esc(tone)}" data-ob-status>${esc(statusLabel(record.status))}</span>
            ${codeChip(department)}
            <span>tag “${esc(department.tag || department.name || "")}”</span>
            ${department.state ? `<span>${esc(department.state)}</span>` : ""}
            ${record.collection?.title ? `<span>${esc(record.collection.title)}</span>` : ""}
            ${record.updatedAt ? `<span>updated ${esc(when(record.updatedAt))}</span>` : ""}
          </p>
        </div>
        <div class="store-review-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-ob="reload">Refresh</button>
          <button class="btn btn-danger-ghost btn-sm" type="button" data-ob="delete">Delete record</button>
        </div>
      </header>
      ${codeCard(record)}`;
  }

  function codeCard(record) {
    const code = record.department?.code || {};
    if (code.approved) {
      return `
        <section class="card card-pad ob-panel ob-code-card" data-ob-panel="code" data-state="done">
          <div class="card-head">
            <div>
              <p class="eyebrow">Department code</p>
              <h3>${esc(code.value || "")} is approved</h3>
              <p class="muted">Source: ${esc(code.source || "list")}${code.approvedBy ? ` · approved by ${esc(code.approvedBy)}` : ""}${code.approvedAt ? ` · ${esc(when(code.approvedAt))}` : ""}. It is used in folder names, file names, SKUs, and product tags.</p>
            </div>
          </div>
        </section>`;
    }
    const candidates = list(code.candidates);
    const matches = list(code.matches);
    return `
      <section class="card card-pad ob-panel ob-code-card" data-ob-panel="code" data-state="attention">
        <div class="card-head">
          <div>
            <p class="eyebrow">Needs Dan · department code</p>
            <h3>Approve the department code</h3>
            <p class="muted">Nothing is named, tagged, or built until the code is approved. Codes are usually three letters and never reuse another department's.</p>
          </div>
        </div>
        ${matches.length
          ? `<div class="ob-subhead"><p class="field-label">On the Department Code List</p></div>
             <div class="ob-candidates">
               ${matches
                 .map(
                   (match) => `
                 <button class="ob-candidate" type="button" data-ob="pick-code" data-ob-code="${esc(match.code || "")}" data-tone="ok">
                   <b>${esc(match.code || "")}</b>
                   <small>${esc(match.agency || "")}${match.city ? ` · ${esc(match.city)}` : ""}</small>
                 </button>`
                 )
                 .join("")}
             </div>`
          : ""}
        ${candidates.length
          ? `<div class="ob-subhead"><p class="field-label">Proposed from the department name</p></div>
             <div class="ob-candidates">
               ${candidates
                 .map(
                   (candidate) => `
                 <button class="ob-candidate" type="button" data-ob="pick-code" data-ob-code="${esc(candidate.code || "")}" data-tone="${candidate.inUse ? "warn" : "info"}" ${candidate.inUse ? 'title="Already in use by another department"' : ""}>
                   <b>${esc(candidate.code || "")}</b>
                   <small>${esc(candidate.reason || "")}${candidate.inUse ? ` · in use${candidate.agency ? ` by ${esc(candidate.agency)}` : ""}` : " · free"}</small>
                 </button>`
                 )
                 .join("")}
             </div>`
          : ""}
        ${!matches.length && !candidates.length
          ? stateBlock({
              tone: "info",
              title: "No code looked up yet",
              sub: "Run setup to search the Department Code List and the codes already in use (Drive folders, Shopify tags, the Mega Menu)."
            })
          : ""}
        <div class="ob-code-form">
          <div class="field">
            <label for="obCodeValue">Code</label>
            <input id="obCodeValue" class="code-input" type="text" maxlength="4" value="${esc(code.value || "")}" autocomplete="off" aria-describedby="obCodeHint">
            <p class="hint" id="obCodeHint">Three letters, four when the acronym needs it (GTFD). Picking a candidate above fills this in.</p>
          </div>
          <div class="field">
            <label for="obApprovedBy">Approved by</label>
            <input id="obApprovedBy" type="text" value="${esc(operator())}" placeholder="Dan" autocomplete="off" data-ob-operator>
          </div>
          <button class="${btnClass(record, "code")}" type="button" data-ob="approve-code">Approve code</button>
          <button class="btn btn-secondary btn-sm" type="button" data-ob="run-setup">${record.drive?.departmentFolderId ? "Re-run lookup" : "Run code lookup"}</button>
        </div>
      </section>`;
  }

  function stepperHtml(record) {
    const current = PHASES.findIndex((phase) => phase.key === record.phase);
    const index = current === -1 ? 0 : current;
    return `
      <ol class="wizard-rail ob-stepper" data-ob-stepper aria-label="Onboarding phases">
        ${PHASES.map((phase, i) => {
          const phaseState = i < index ? "done" : i === index ? "current" : "todo";
          return `
          <li data-state="${phaseState}">
            <button type="button" data-ob="goto" data-ob-target="${esc(phase.panel)}" ${i === index ? 'aria-current="step"' : ""}>
              <span class="wr-num" aria-hidden="true">${phaseState === "done" ? "" : i + 1}</span>
              <span class="wr-label">${esc(phase.label)}</span>
            </button>
          </li>`;
        }).join("")}
      </ol>`;
  }

  /* ---- Packet -------------------------------------------------------------- */
  function packetPanel(record) {
    const files = list(record.packet?.files);
    const groups = FILE_KINDS.map((kind) => ({ kind, files: files.filter((file) => (file?.kind || "other") === kind.key) })).filter((group) => group.files.length);
    return `
      <section class="card card-pad ob-panel" id="obPanel-packet" data-ob-panel="packet">
        <div class="card-head">
          <div>
            <p class="eyebrow">Phase 1 · Packet</p>
            <h3>What arrived with the department</h3>
            <p class="muted">Policies are read for garments, colours, decoration method and placement. Artwork roles decide the collection banner.</p>
          </div>
          <button class="${btnClass(record, "setup")}" type="button" data-ob="run-setup">${record.drive?.departmentFolderId ? "Re-run setup" : "Run setup"}</button>
        </div>
        <div class="ob-addfiles">
          <label class="field-label" for="obAddKind">Add files as</label>
          <select id="obAddKind" data-ob-add-kind>
            ${FILE_KINDS.map((kind) => `<option value="${esc(kind.key)}">${esc(kind.label)}</option>`).join("")}
          </select>
          <label class="btn btn-secondary btn-sm ob-upload">
            <span>Choose files</span>
            <input type="file" multiple data-ob-upload="packet" aria-label="Add packet files">
          </label>
        </div>
        ${groups.length
          ? groups
              .map(
                (group) => `
          <div class="ob-kind-group">
            <p class="field-label">${esc(group.kind.label)} <small>${group.files.length} file${plural(group.files.length, "", "s")}</small></p>
            <div class="ob-files">${group.files.map((file) => packetFileHtml(record, file)).join("")}</div>
          </div>`
              )
              .join("")
          : stateBlock({ title: "No packet files yet", sub: "Add the uniform policy, the artwork, and the contact list — the agent reads them in setup." })}
        <div class="field ob-notes">
          <label for="obPacketNotes">Packet notes</label>
          <textarea id="obPacketNotes" rows="3" data-ob-field="packetNotes">${esc(record.packet?.notes || "")}</textarea>
          <p class="hint">Saved on the record, shown to the model when it reviews the policy.</p>
        </div>
        <div class="ob-panel-actions">
          <button class="btn btn-secondary btn-sm" type="button" data-ob="save-notes">Save notes</button>
        </div>
      </section>`;
  }

  function packetFileHtml(record, file) {
    const isArtwork = (file?.kind || "") === "artwork";
    const previewable = String(file?.contentType || "").startsWith("image/");
    return `
      <figure class="ob-file" data-ob-asset="${esc(file?.assetId || "")}">
        <span class="ob-thumb">
          ${previewable && file?.assetId
            ? `<img data-ob-src="${esc(assetUrl(record.id, file.assetId))}" alt="${esc(file?.name || "")}" loading="lazy">`
            : `<span class="ob-file-glyph" aria-hidden="true">${ICON_FILE}</span>`}
          <span class="ob-thumb-fallback">${esc((String(file?.name || "file").split(".").pop() || "file").toUpperCase().slice(0, 4))}</span>
        </span>
        <figcaption>
          <b>${esc(file?.name || "Unnamed file")}</b>
          <small>${esc(formatBytes(file?.size || 0))}${file?.text ? " · text extracted" : ""}${file?.description ? " · described" : ""}</small>
          ${file?.driveUrl ? `<a href="${esc(file.driveUrl)}" target="_blank" rel="noreferrer">Open in Drive</a>` : ""}
          ${isArtwork
            ? `<label class="ob-role"><span class="sr-only">Artwork role for ${esc(file?.name || "")}</span>
                <select data-ob-role="${esc(file?.assetId || "")}">
                  ${ARTWORK_ROLES.map((role) => `<option value="${esc(role.key)}" ${String(file?.role || "") === role.key ? "selected" : ""}>${esc(role.label)}</option>`).join("")}
                </select></label>`
            : ""}
        </figcaption>
        <button class="file-remove" type="button" data-ob="remove-file" data-ob-file="${esc(file?.assetId || "")}" aria-label="Remove ${esc(file?.name || "file")}">${ICON_CLOSE}</button>
      </figure>`;
  }

  /* ---- Setup / policy review ---------------------------------------------- */
  function setupPanel(record) {
    const review = record.policyReview || {};
    const reviewed = Boolean(review.reviewedAt);
    const drive = record.drive || {};
    return `
      <section class="card card-pad ob-panel" id="obPanel-setup" data-ob-panel="setup">
        <div class="card-head">
          <div>
            <p class="eyebrow">Phase 2 · Setup</p>
            <h3>Folders, policy review, and the rep email</h3>
            <p class="muted">The agent never sends the email — it drafts it into the department's Drive folder for Dan to send.</p>
          </div>
          <button class="btn btn-secondary btn-sm" type="button" data-ob="run-review">${reviewed ? "Re-run review" : "Run policy review"}</button>
        </div>
        <div class="status-list ob-folders">
          <div class="status-line"><span>Department folder</span><b>${drive.departmentFolderUrl ? `<a href="${esc(drive.departmentFolderUrl)}" target="_blank" rel="noreferrer">Open</a>` : drive.departmentFolderId ? "Created" : "Not created yet"}</b></div>
          <div class="status-line"><span>Production folder (Omni Printer)</span><b>${drive.productionFolderUrl ? `<a href="${esc(drive.productionFolderUrl)}" target="_blank" rel="noreferrer">Open</a>` : drive.productionFolderId ? "Created" : "Not created yet"}</b></div>
          <div class="status-line"><span>Product Images subfolder</span><b>${drive.productImagesFolderId ? "Created" : "Not created yet"}</b></div>
        </div>
        ${reviewed ? policyReviewHtml(review) : stateBlock({ title: "The policy has not been reviewed yet", sub: "Run setup once the code is approved: the agent reads the policy, lists what is confirmed and what is missing, and drafts the rep email." })}
      </section>`;
  }

  function policyReviewHtml(review) {
    const confirmed = list(review.confirmed);
    const missing = list(review.missing);
    const questions = list(review.questions);
    const draft = review.emailDraft || {};
    return `
      <div class="ob-review">
        <div class="gap-report" data-tone="ok">
          <p class="gap-title">Confirmed by the policy <span class="muted">${confirmed.length}</span></p>
          ${confirmed.length
            ? `<ul class="gap-list">${confirmed
                .map((item) => `<li><b>${esc(item?.topic || "")}</b> ${esc(item?.detail || "")}${item?.source ? ` <span class="gap-note">— ${esc(item.source)}</span>` : ""}</li>`)
                .join("")}</ul>`
            : `<p class="gap-note">Nothing was confirmed outright.</p>`}
        </div>
        <div class="gap-report" data-tone="warn">
          <p class="gap-title">Missing information <span class="muted">${missing.length}</span></p>
          ${missing.length
            ? `<ul class="gap-list">${missing.map((item) => `<li><b>${esc(item?.topic || "")}</b> ${esc(item?.detail || "")}</li>`).join("")}</ul>`
            : `<p class="gap-note">Nothing outstanding — the policy answered everything the build needs.</p>`}
        </div>
        ${questions.length
          ? `<div class="ob-questions">
              <p class="field-label">Questions for the rep</p>
              <ul class="gap-list">${questions.map((question) => `<li>${esc(question)}</li>`).join("")}</ul>
            </div>`
          : ""}
        ${draft.subject || draft.body
          ? `<div class="email-draft">
              <div class="email-head">
                <div>
                  <p class="eyebrow">Draft email to the department rep</p>
                  <p class="email-subject"><b>Subject:</b> ${esc(draft.subject || "")}</p>
                </div>
                <div class="email-actions">
                  <button class="btn btn-secondary btn-sm" type="button" data-ob="copy" data-ob-copy-target="obEmailBody">Copy</button>
                  ${review.driveDocUrl ? `<a class="btn btn-secondary btn-sm" href="${esc(review.driveDocUrl)}" target="_blank" rel="noreferrer">Open in Drive</a>` : ""}
                </div>
              </div>
              <textarea class="email-body" id="obEmailBody" rows="10" readonly aria-label="Draft email body">${esc(draft.body || "")}</textarea>
              <p class="hint">Dan sends it. The agent never emails the department.</p>
            </div>`
          : ""}
      </div>`;
  }

  /* ---- Build inputs -------------------------------------------------------- */
  function inputsPanel(record) {
    const products = list(record.products);
    const suggested = list(record.policyReview?.suggestedProducts);
    return `
      <section class="card card-pad ob-panel" id="obPanel-inputs" data-ob-panel="inputs">
        <div class="card-head">
          <div>
            <p class="eyebrow">Phase 3 · Build inputs</p>
            <h3>The product list</h3>
            <p class="muted">One row per product. Every size × colour × style gets its own SKU, and the decoration codes must match the file names in the Omni Printer folder.</p>
          </div>
          <div class="ob-head-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-ob="add-product">+ Add product</button>
            <button class="${btnClass(record, "save-products")}" type="button" data-ob="save-products">Save products</button>
          </div>
        </div>
        ${suggested.length && !products.length
          ? `<div class="gap-report" data-tone="ok">
              <p class="gap-title">${suggested.length} product${plural(suggested.length, "", "s")} suggested from the policy</p>
              <p class="gap-note">Unconfirmed — load them as rows, then check every field against what the rep confirmed.</p>
              <button class="btn btn-secondary btn-sm" type="button" data-ob="use-suggestions">Load suggestions</button>
            </div>`
          : ""}
        ${products.length
          ? `<div class="ob-products">${products.map((product, index) => productRowHtml(record, product, index)).join("")}</div>`
          : stateBlock({ title: "No products yet", sub: "Add a row per garment the department confirmed: brand, style number, colours, sizes, decoration method, and the decoration codes." })}
        ${productionFilesHtml(record)}
      </section>`;
  }

  function optionsHtml(values, selected) {
    return values
      .map((value) => {
        const key = typeof value === "string" ? value : value.key;
        const label = typeof value === "string" ? value : value.label;
        return `<option value="${esc(key)}" ${String(selected || "") === String(key) ? "selected" : ""}>${esc(label)}</option>`;
      })
      .join("");
  }

  function productRowHtml(record, product, index) {
    const id = product?.id || `p${index + 1}`;
    const validation = product?.validation || {};
    const styles = list(product?.styles);
    const saved = Boolean(list(record.products).find((row) => row?.id === id));
    const tone = validation.ok === true ? "ok" : validation.ok === false ? "danger" : "muted";
    return `
      <fieldset class="ob-product" data-ob-product="${esc(id)}" data-tone="${esc(tone)}">
        ${/* The legend has to be the fieldset's FIRST child or the browser
              parses it as a generic element and the group ends up with no
              accessible name. The visible heading stays in the head row; this
              one names the group for assistive tech. */""}
        <legend class="sr-only">${esc(product?.title || [product?.brand, product?.styleNumber].filter(Boolean).join(" ") || `Product ${index + 1}`)}</legend>
        <div class="ob-product-head">
          <p class="ob-product-title" aria-hidden="true">${esc(product?.title || [product?.brand, product?.styleNumber].filter(Boolean).join(" ") || `Product ${index + 1}`)}</p>
          <span class="ob-product-meta">
            ${chip(validation.ok === true ? "valid" : validation.ok === false ? "has errors" : "not validated", tone)}
            ${product?.buildState ? chip(product.buildState, product.buildState === "created" ? "ok" : product.buildState === "failed" ? "danger" : "muted") : ""}
            ${product?.shopify?.url ? `<a href="${esc(product.shopify.url)}" target="_blank" rel="noreferrer">Open in Shopify</a>` : ""}
          </span>
          <button class="variant-remove" type="button" data-ob="remove-product" aria-label="Remove product ${index + 1}">&times;</button>
        </div>
        <div class="category-edit-grid">
          <label><span>Brand</span><input type="text" data-ob-field="brand" value="${esc(product?.brand || "")}" placeholder="Next Level"></label>
          <label><span>Style number</span><input type="text" data-ob-field="styleNumber" class="code-input" value="${esc(product?.styleNumber || "")}" placeholder="NL3600"></label>
          <label><span>Product type</span><input type="text" data-ob-field="type" value="${esc(product?.type || "")}" placeholder="T-shirt, hat, Class B, pants"></label>
          <label><span>Product title <small class="muted-inline">(optional)</small></span><input type="text" data-ob-field="title" value="${esc(product?.title || "")}" placeholder="Leave blank to use the blank's title"></label>
          <label class="span-2"><span>Colours</span><input type="text" data-ob-field="colors" value="${esc(csv(product?.colors))}" placeholder="Navy, Midnight Navy"></label>
          <label class="span-2"><span>Sizes</span><input type="text" data-ob-field="sizes" value="${esc(csv(product?.sizes))}" placeholder="S, M, L, XL, 2XL, 3XL"></label>
          <label><span>Decoration method</span><select data-ob-field="decorationMethod">${optionsHtml(DECORATION_METHODS, product?.decorationMethod)}</select></label>
          <label><span>Decoration codes</span><input type="text" data-ob-field="decorationCodes" class="code-input" value="${esc(product?.decorationCodes || "")}" placeholder="F01/B01"></label>
          <label><span>Fulfillment (Vendor field)</span><select data-ob-field="fulfillment">${optionsHtml([{ key: "", label: "—" }, ...FULFILLMENTS.map((v) => ({ key: v, label: v }))], product?.fulfillment)}</select></label>
          <label class="toggle-field"><input type="checkbox" data-ob-field="classB" ${product?.classB ? "checked" : ""}> <span>Class B uniform item</span></label>
          <label class="span-2"><span>Notes</span><input type="text" data-ob-field="notes" value="${esc(product?.notes || "")}"></label>
        </div>
        <p class="hint">${esc(SIZE_HINT)}</p>
        <p class="hint">${esc(DECORATION_HINT)}</p>
        <div class="ob-styles">
          <p class="field-label">Styles <small>only when the same blank carries more than one logo setup</small></p>
          <div class="ob-style-list" data-ob-style-list>
            ${styles.map((style, styleIndex) => styleRowHtml(style, styleIndex)).join("")}
          </div>
          <button class="btn btn-ghost btn-sm" type="button" data-ob="add-style">+ Add style</button>
        </div>
        ${blankPhotoHtml(record, product, saved)}
        ${proofHtml(record, product, saved)}
        ${validationHtml(validation)}
      </fieldset>`;
  }

  function styleRowHtml(style, index) {
    return `
      <div class="ob-style" data-ob-style>
        <span class="ob-style-name">Style ${index + 1}</span>
        <input type="text" class="code-input" data-ob-field="styleCodes" value="${esc(style?.decorationCodes || "")}" placeholder="F02/B01" aria-label="Decoration codes for Style ${index + 1}">
        <button class="variant-remove" type="button" data-ob="remove-style" aria-label="Remove Style ${index + 1}">&times;</button>
      </div>`;
  }

  function blankPhotoHtml(record, product, saved) {
    const colors = list(product?.colors);
    if (!colors.length) {
      return `<div class="ob-slots"><p class="field-label">Blank garment photos</p><p class="hint">Add colours and save the row — a front and back photo per colour is what the mockups are built from.</p></div>`;
    }
    return `
      <div class="ob-slots">
        <p class="field-label">Blank garment photos <small>front and back, per colour</small></p>
        <div class="ob-slot-grid">
          ${colors
            .map((color) =>
              ["front", "back"]
                .map((face) => {
                  const assetId = product?.blankPhotos?.[color]?.[face] || "";
                  return slotHtml({
                    record,
                    productId: product?.id || "",
                    assetId,
                    label: `${color} · ${face}`,
                    kind: "blank",
                    saved,
                    extra: { color, face }
                  });
                })
                .join("")
            )
            .join("")}
        </div>
      </div>`;
  }

  function proofHtml(record, product, saved) {
    const codes = String(product?.decorationCodes || "")
      .split("/")
      .map((part) => part.trim().toUpperCase())
      .filter((part) => /^E\d{2}$/.test(part));
    const styleCodes = list(product?.styles).flatMap((style) =>
      String(style?.decorationCodes || "")
        .split("/")
        .map((part) => part.trim().toUpperCase())
        .filter((part) => /^E\d{2}$/.test(part))
    );
    const all = [...new Set([...codes, ...styleCodes])];
    if (!all.length) return "";
    return `
      <div class="ob-slots">
        <p class="field-label">Embroidery proofs <small>the Printed Image art proof per E code</small></p>
        <div class="ob-slot-grid">
          ${all
            .map((code) =>
              slotHtml({
                record,
                productId: product?.id || "",
                assetId: product?.proofs?.[code] || "",
                label: code,
                kind: "proof",
                saved,
                extra: { decorationCode: code }
              })
            )
            .join("")}
        </div>
      </div>`;
  }

  function slotHtml({ record, productId, assetId, label, kind, saved, extra }) {
    const dataAttrs = Object.entries(extra || {})
      .map(([key, value]) => `data-ob-${esc(key.toLowerCase())}="${esc(value)}"`)
      .join(" ");
    return `
      <div class="ob-slot" data-tone="${assetId ? "ok" : "muted"}">
        <span class="ob-thumb ob-slot-thumb">
          ${assetId
            ? `<img data-ob-src="${esc(assetUrl(record.id, assetId))}" alt="${esc(label)}" loading="lazy">`
            : `<span class="ob-file-glyph" aria-hidden="true">${ICON_FILE}</span>`}
          <span class="ob-thumb-fallback">${esc(label)}</span>
        </span>
        <span class="ob-slot-label">${esc(label)}</span>
        ${saved
          ? `<label class="ob-upload ob-upload-inline">
              <span>${assetId ? "Replace" : "Upload"}</span>
              <input type="file" accept="image/*" data-ob-upload="${esc(kind)}" data-ob-product-id="${esc(productId)}" ${dataAttrs} aria-label="${assetId ? "Replace" : "Upload"} ${esc(label)}">
            </label>`
          : `<span class="hint">Save the row first</span>`}
        ${assetId ? `<button class="file-remove" type="button" data-ob="remove-file" data-ob-file="${esc(assetId)}" aria-label="Remove ${esc(label)}">${ICON_CLOSE}</button>` : ""}
      </div>`;
  }

  function validationHtml(validation) {
    const errors = list(validation?.errors);
    const warnings = list(validation?.warnings);
    const assumptions = list(validation?.assumptions);
    const skus = list(validation?.skuPreview);
    if (validation?.ok == null && !errors.length && !warnings.length && !skus.length) {
      return `<div class="ob-validation" data-tone="muted"><p class="ob-validation-title">Not validated yet</p><p class="hint">Save the row — the rules check the SKUs, the colours, and the decoration files.</p></div>`;
    }
    return `
      <div class="ob-validation" data-tone="${validation?.ok === true ? "ok" : errors.length ? "danger" : "warn"}">
        <p class="ob-validation-title">${errors.length ? `${errors.length} error${plural(errors.length, "", "s")}` : "Validates"}${warnings.length ? ` · ${warnings.length} warning${plural(warnings.length, "", "s")}` : ""}</p>
        ${errors.length ? `<ul class="ob-issues" data-tone="danger">${errors.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}
        ${warnings.length ? `<ul class="ob-issues" data-tone="warn">${warnings.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}
        ${assumptions.length ? `<ul class="ob-issues" data-tone="muted">${assumptions.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}
        ${skus.length
          ? `<details class="ob-skus"><summary>${skus.length} SKU${plural(skus.length, "", "s")}</summary>
              <div class="ob-sku-list">${skus.map((sku) => `<code>${esc(sku)}</code>`).join("")}</div>
            </details>`
          : ""}
      </div>`;
  }

  /* Decoration codes are matched against the Omni Printer listing by file
     stem (CODE-F01). Production uses the SKU to know which logo goes where,
     so a missing file is a build blocker Dan has to fix in Drive. */
  function productionFilesHtml(record) {
    const files = list(record.drive?.productionFiles);
    const code = record.department?.code?.value || "";
    const stems = new Set(files.map((file) => String(file?.name || "").replace(/\.[^.]+$/, "").toUpperCase()));
    const wanted = new Set();
    list(record.products).forEach((product) => {
      const codes = [String(product?.decorationCodes || ""), ...list(product?.styles).map((style) => String(style?.decorationCodes || ""))];
      codes.forEach((group) =>
        group
          .split("/")
          .map((part) => part.trim().toUpperCase())
          .filter(Boolean)
          .forEach((part) => {
            if (/^E\d{2}$/.test(part)) return; // embroidery art comes from the proof, not the print folder
            wanted.add(part);
          })
      );
    });
    // Without an approved code there is no file stem to match on, so the codes
    // are listed without a verdict rather than all flagged missing.
    const rows = code
      ? [...wanted].sort().map((part) => ({ part, stem: `${code}-${part}`.toUpperCase(), matched: stems.has(`${code}-${part}`.toUpperCase()) }))
      : [...wanted].sort().map((part) => ({ part, stem: "", matched: true }));
    const missing = rows.filter((row) => !row.matched).length;
    return `
      <div class="ob-prodfiles" data-tone="${missing ? "warn" : rows.length ? "ok" : "muted"}">
        <div class="ob-prodfiles-head">
          <p class="field-label">Production files <small>${files.length} in the Omni Printer folder${record.drive?.productionFilesReadAt ? ` · read ${esc(when(record.drive.productionFilesReadAt))}` : ""}</small></p>
          <button class="btn btn-ghost btn-sm" type="button" data-ob="refresh-production">Refresh listing</button>
        </div>
        ${rows.length
          ? `<div class="ob-prodfile-codes">
              ${rows
                .map(
                  (row) =>
                    `<span class="m-chip" data-known="${row.matched ? "true" : "false"}"><b>${esc(row.part)}</b> ${esc(row.stem || "code not approved yet")}${row.matched || !row.stem ? "" : " missing"}</span>`
                )
                .join("")}
            </div>`
          : `<p class="hint">Decoration codes on the rows above are matched here once they are saved.</p>`}
        ${files.length
          ? `<ul class="drive-files">${files
              .slice(0, 24)
              .map(
                (file) => `<li><a href="https://drive.google.com/file/d/${encodeURIComponent(file?.id || "")}/view" target="_blank" rel="noreferrer">${ICON_FILE}<span>${esc(file?.name || "")}</span><small>${esc(day(file?.modifiedTime))}</small></a></li>`
              )
              .join("")}</ul>`
          : `<p class="hint">Nothing listed yet. Dan places the print-ready files in the department's Omni Printer folder — the agent only ever reads copies.</p>`}
      </div>`;
  }

  /* ---- Build --------------------------------------------------------------- */
  function buildPanel(record) {
    return `
      <section class="card card-pad ob-panel" id="obPanel-build" data-ob-panel="build">
        <div class="card-head">
          <div>
            <p class="eyebrow">Phase 4 · Build</p>
            <h3>Mockups, collection, lock, products</h3>
            <p class="muted">Persisted and resumable: a re-run skips every product that already exists and never deletes anything.</p>
          </div>
        </div>
        <div data-ob-build>${buildBodyHtml(record)}</div>
      </section>`;
  }

  function buildBodyHtml(record) {
    const build = record.build || {};
    const blockers = buildBlockers(record);
    const running = build.state === "running";
    const steps = list(build.steps);
    const done = steps.filter((step) => step?.state === "complete").length;
    const pct = steps.length ? Math.round((done / steps.length) * 100) : build.state === "complete" ? 100 : 0;
    /* "interrupted" is what a deploy or a restart leaves behind. Treating it
       as "still running" disabled the button and polled forever, so the only
       way out was to edit the record by hand. It is a resumable state, not a
       live one. */
    const interrupted = build.state === "interrupted";
    const label = running ? "Building…" : interrupted ? "Resume build" : build.state ? "Re-run build" : "Build store";
    return `
      <div class="ob-build-actions">
        <button class="${btnClass(record, "build")}" type="button" data-ob="build" ${blockers.length || running ? "disabled" : ""} ${blockers.length ? `title="${esc(`Blocked: ${blockers.join(", ")}`)}"` : ""}>${esc(label)}</button>
        ${interrupted ? `<span class="hint" data-tone="warn">The last run stopped before it finished — resuming picks up where it left off.</span>` : ""}
        ${build.state ? chip(build.state, buildTone(build.state)) : chip("not started", "muted")}
        ${build.startedAt ? `<span class="hint">started ${esc(when(build.startedAt))}</span>` : ""}
        ${build.finishedAt ? `<span class="hint">finished ${esc(when(build.finishedAt))}</span>` : ""}
      </div>
      ${blockers.length ? `<p class="hint" data-tone="warn">Blocked until ${esc(blockers.join(", "))}.</p>` : ""}
      ${build.error ? `<p class="build-error">${esc(build.error)}</p>` : ""}
      ${steps.length
        ? `<div class="progress">
            <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Build progress">
              <div class="progress-fill" style="width:${pct}%"></div>
            </div>
            <div class="progress-meta"><span>${esc(running ? `Step ${Math.min(done + 1, steps.length)} of ${steps.length}` : `${done} of ${steps.length} steps complete`)}</span><span>${pct}%</span></div>
          </div>
          <ul class="build-steps">
            ${steps
              .map(
                (step) => `<li data-state="${esc(step?.state || "pending")}">
                  <b>${esc(step?.label || step?.key || "")}</b>
                  <span>${esc(step?.detail || (step?.state === "running" ? "Working…" : ""))}</span>
                </li>`
              )
              .join("")}
          </ul>`
        : stateBlock({ title: "Not built yet", sub: "The build creates the collection first, then the lock, then every product as a Draft with its SKUs and images." })}
      ${collectionLinesHtml(record)}
      ${mockupGalleryHtml(record)}`;
  }

  /* The collection is built before any product, and the banner logo is a rule
     (the department's pick, else scramble, else chest, else back) — so the
     choice and the reason behind it belong next to the build. */
  function collectionLinesHtml(record) {
    const collection = record.collection || {};
    if (!collection.id && !collection.gid && !collection.bannerLogoReason) return "";
    return `
      <div class="status-list">
        <div class="status-line"><span>Collection</span><b>${collection.url ? `<a href="${esc(collection.url)}" target="_blank" rel="noreferrer">${esc(collection.title || "Open")}</a>` : esc(collection.title || "created")}</b></div>
        <div class="status-line"><span>Description</span><b>${collection.descriptionSet ? "Non-Stock Item Notice set" : "not set yet"}</b></div>
        <div class="status-line"><span>Banner logo</span><b>${esc(collection.bannerLogoReason || (collection.bannerAssetId ? "chosen" : "not chosen yet"))}</b></div>
      </div>`;
  }

  function mockupGalleryHtml(record) {
    const products = list(record.products).filter((product) => list(product?.mockups).length);
    if (!products.length) return "";
    return `
      <div class="ob-mockup-groups">
        ${products
          .map((product) => {
            const mockups = list(product.mockups);
            return `
          <div class="ob-mockup-group">
            <p class="field-label">${esc(product?.title || [product?.brand, product?.styleNumber].filter(Boolean).join(" ") || "Product")} <small>${mockups.length} image${plural(mockups.length, "", "s")}</small></p>
            <div class="ob-mockups">
              ${mockups.map((mockup) => mockupFigureHtml(record, mockup)).join("")}
            </div>
          </div>`;
          })
          .join("")}
      </div>`;
  }

  function mockupFigureHtml(record, mockup) {
    const caption = [mockup?.color, mockup?.style, mockup?.face].filter(Boolean).join(" · ");
    const verified = mockup?.verified;
    return `
      <figure class="ob-mockup">
        <span class="ob-thumb">
          ${mockup?.assetId
            ? `<img data-ob-src="${esc(assetUrl(record.id, mockup.assetId))}" alt="${esc(caption)}" loading="lazy">`
            : `<span class="ob-file-glyph" aria-hidden="true">${ICON_FILE}</span>`}
          <span class="ob-thumb-fallback">${esc(mockup?.fileName || caption)}</span>
        </span>
        <figcaption>
          <b>${esc(caption)}</b>
          <span class="ob-badges">
            <span class="ob-badge" data-tone="${esc(pathTone(mockup?.path))}">${esc(mockup?.path || "unknown")}</span>
            ${baseBadge(mockup?.base)}
            ${verified && verified.ok === false ? `<span class="ob-badge" data-tone="warn">check</span>` : ""}
          </span>
          ${verified && verified.ok === false && verified.notes ? `<small class="ob-mockup-note">${esc(verified.notes)}</small>` : ""}
          ${mockup?.driveUrl ? `<a href="${esc(mockup.driveUrl)}" target="_blank" rel="noreferrer">In Drive</a>` : ""}
        </figcaption>
      </figure>`;
  }

  /* ---- Shared settings + lock --------------------------------------------- */
  function sharedPanel(record) {
    const shared = record.sharedSettings || {};
    const anyProposed = SHARED_KINDS.some((kind) => (shared[kind.key]?.status || "pending") !== "pending");
    return `
      <section class="card card-pad ob-panel" id="obPanel-shared" data-ob-panel="shared">
        <div class="card-head">
          <div>
            <p class="eyebrow">Shared settings · approval required</p>
            <h3>Mega Menu, Flow, Helium, and the lock</h3>
            <p class="muted">Nothing shared is written without an approval on the record. Where the API cannot write, the agent hands over a checklist and Dan confirms.</p>
          </div>
          <div class="ob-head-actions">
            <button class="btn btn-secondary btn-sm" type="button" data-ob="propose-shared">${anyProposed ? "Re-compute proposals" : "Compute proposals"}</button>
            <button class="btn btn-ghost btn-sm" type="button" data-ob="verify-shared">Verify</button>
          </div>
        </div>
        <div class="ob-shared-grid">
          ${SHARED_KINDS.map((kind) => sharedCardHtml(record, kind)).join("")}
        </div>
        ${lockCardHtml(record)}
      </section>`;
  }

  function sharedCardHtml(record, kind) {
    const node = record.sharedSettings?.[kind.key] || {};
    const status = node.status || "pending";
    const checklist = list(node.checklist);
    const sentence = sharedSentence(record, kind.key, node);
    const forms = kind.key === "helium" ? list(node.forms) : [];
    return `
      <div class="ob-shared" data-ob-shared="${esc(kind.key)}" data-tone="${esc(sharedTone(status))}">
        <div class="ob-shared-head">
          <b>${esc(kind.label)}</b>
          ${chip(status, sharedTone(status))}
        </div>
        <p class="ob-shared-sub">${esc(kind.sub)}</p>
        ${sentence ? `<p class="ob-proposal">${esc(sentence)}</p>` : `<p class="hint">No proposal computed yet.</p>`}
        ${forms.length
          ? `<ul class="ob-form-list">${forms
              .map(
                (form) => `<li data-tone="${form?.present ? "ok" : form?.public === false ? "muted" : "warn"}">
                  <b>${esc(form?.label || form?.id || "")}</b>
                  <span>${esc(form?.public === false ? "not public — check by hand" : form?.error ? form.error : form?.present ? `present (${(form.index ?? 0) + 1} of ${form.total || 0})` : "tag missing")}</span>
                </li>`
              )
              .join("")}</ul>`
          : ""}
        ${checklist.length
          ? `<ol class="ob-checklist">${checklist.map((step) => `<li>${esc(step)}</li>`).join("")}</ol>`
          : ""}
        ${node.error ? `<p class="build-error">${esc(node.error)}</p>` : ""}
        <div class="ob-shared-actions">
          ${/* "Approve & apply" is only honest where the agent can actually
                write the change. Shopify Flow has no API at all and Helium has
                no write API, so for those two the only truthful button is the
                one that records what Dan did by hand; offering "apply" there
                marked the setting done with nothing applied. */
            kind.key === "megaMenu" && state.caps?.megaMenu?.writable
              ? `<button class="btn btn-secondary btn-sm" type="button" data-ob="approve-shared" data-ob-kind="${esc(kind.key)}">Approve &amp; apply</button>`
              : ""}
          <button class="btn btn-ghost btn-sm" type="button" data-ob="confirm-shared" data-ob-kind="${esc(kind.key)}">${esc(
            kind.key === "megaMenu" && state.caps?.megaMenu?.writable ? "I did this" : "I did this — confirm"
          )}</button>
          <button class="btn btn-ghost btn-sm" type="button" data-ob="copy" data-ob-copy-text="${esc(record.department?.tag || record.department?.name || "")}">Copy tag</button>
        </div>
        ${node.approvedBy || node.confirmedBy ? `<p class="hint">${esc(node.approvedBy ? `approved by ${node.approvedBy}` : `confirmed by ${node.confirmedBy}`)}${node.appliedAt ? ` · applied ${esc(when(node.appliedAt))}` : ""}${node.verifiedAt ? ` · verified ${esc(when(node.verifiedAt))}` : ""}</p>` : ""}
      </div>`;
  }

  function sharedSentence(record, key, node) {
    if (key === "megaMenu") {
      const proposal = node.proposal || {};
      if (!proposal.title && !proposal.insertAfter && !proposal.insertBefore) return "";
      const where = proposal.insertAfter && proposal.insertBefore
        ? `between “${proposal.insertAfter}” and “${proposal.insertBefore}”`
        : proposal.insertAfter
          ? `after “${proposal.insertAfter}”`
          : proposal.insertBefore
            ? `before “${proposal.insertBefore}”`
            : "at the end";
      return `Add “${proposal.title || record.collection?.title || ""}” ${where} (position ${(proposal.index ?? 0) + 1}), linked to ${proposal.url || record.collection?.storefrontUrl || "the new collection"}.`;
    }
    if (key === "flow") {
      const tag = record.department?.tag || record.department?.name || "";
      return `Add criteria → tags_item → “${tag}” to the condition step, keeping every existing entry.`;
    }
    if (key === "helium") {
      const forms = list(node.forms);
      const pending = forms.filter((form) => !form?.present).length;
      if (!forms.length) return "";
      return `${pending} of ${forms.length} form${plural(forms.length, "", "s")} still need the tag, inserted in alphabetical order.`;
    }
    return "";
  }

  function lockCardHtml(record) {
    const lock = record.lock || {};
    const status = lock.status || "pending";
    const checklist = list(lock.checklist);
    return `
      <div class="ob-shared ob-lock" data-tone="${esc(sharedTone(status))}">
        <div class="ob-shared-head">
          <b>Locksmith lock</b>
          ${chip(status, sharedTone(status))}
        </div>
        <p class="ob-shared-sub">Two keys unlock the store: the department tag on the customer, or the secret link.</p>
        ${lock.secretLink
          ? `<div class="ob-secret">
              <input type="text" readonly value="${esc(lock.secretLink)}" id="obSecretLink" aria-label="Secret link">
              <button class="btn btn-secondary btn-sm" type="button" data-ob="copy" data-ob-copy-target="obSecretLink">Copy</button>
            </div>`
          : `<p class="hint">No secret link recorded yet.</p>`}
        ${checklist.length ? `<ol class="ob-checklist">${checklist.map((step) => `<li>${esc(step)}</li>`).join("")}</ol>` : ""}
        ${lock.error ? `<p class="build-error">${esc(lock.error)}</p>` : ""}
        <div class="ob-lock-form">
          <div class="field">
            <label for="obLockLink">Secret link <small class="muted-inline">(after creating the lock by hand)</small></label>
            <input id="obLockLink" type="url" value="${esc(lock.secretLink || "")}" placeholder="https://fnsimple.com/…" autocomplete="off">
          </div>
          <div class="field">
            <label for="obLockId">Locksmith lock id</label>
            <input id="obLockId" type="text" value="${esc(lock.locksmithLockId || "")}" autocomplete="off">
          </div>
          <div class="ob-lock-actions">
            <button class="btn btn-secondary btn-sm" type="button" data-ob="save-lock">Record lock</button>
            ${state.caps?.locksmith?.configured
              ? `<button class="btn btn-ghost btn-sm" type="button" data-ob="create-lock">Create the lock via Locksmith</button>`
              : `<span class="hint">Locksmith has no access token here, so the lock is the checklist above.</span>`}
          </div>
        </div>
      </div>`;
  }

  /* ---- Report -------------------------------------------------------------- */
  function reportPanel(record) {
    const report = record.report || {};
    const sections = [
      { key: "completed", label: "Completed", tone: "ok" },
      { key: "needsDan", label: "Needs Dan", tone: "info" },
      { key: "missingInformation", label: "Missing information", tone: "warn" },
      { key: "warnings", label: "Warnings and errors", tone: "danger" }
    ];
    return `
      <section class="card card-pad ob-panel" id="obPanel-report" data-ob-panel="report">
        <div class="card-head">
          <div>
            <p class="eyebrow">Phase 5 · Report</p>
            <h3>What is done and what needs Dan</h3>
            <p class="muted">An onboarding is never complete while anything is unresolved.</p>
          </div>
          <div class="ob-head-actions">
            <button class="${btnClass(record, "final-check")}" type="button" data-ob="final-check">Run final check</button>
            ${report.driveDocUrl ? `<a class="btn btn-secondary btn-sm" href="${esc(report.driveDocUrl)}" target="_blank" rel="noreferrer">Open report doc</a>` : ""}
          </div>
        </div>
        ${report.generatedAt
          ? `<div class="ob-report-grid">
              ${sections
                .map((section) => {
                  const items = list(report[section.key]);
                  return `
                <div class="ob-report-block" data-tone="${esc(section.tone)}">
                  <p class="ob-report-title">${esc(section.label)} <span>${items.length}</span></p>
                  ${items.length ? `<ul class="gap-list">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : `<p class="hint">Nothing here.</p>`}
                </div>`;
                })
                .join("")}
            </div>
            <p class="hint">Generated ${esc(when(report.generatedAt))}.</p>`
          : stateBlock({ title: "No report yet", sub: "The final check confirms the code, the folders, the collection, the lock, the shared settings, and every product before it writes the report." })}
      </section>`;
  }

  /* ---- Right rail ---------------------------------------------------------- */
  function needsDanCard(record) {
    const items = [];
    const code = record.department?.code || {};
    if (!code.approved) {
      items.push({ label: "Approve the department code", detail: code.value ? `Proposed ${code.value}` : "No code looked up yet", target: "code" });
    }
    SHARED_KINDS.forEach((kind) => {
      const node = record.sharedSettings?.[kind.key] || {};
      const status = node.status || "pending";
      if (status !== "applied" && status !== "verified" && status !== "confirmed") {
        items.push({ label: `${kind.label}: ${status}`, detail: sharedSentence(record, kind.key, node) || kind.sub, target: "shared" });
      }
    });
    const lockStatus = record.lock?.status || "pending";
    if (lockStatus !== "verified" && lockStatus !== "created") {
      items.push({ label: `Lock: ${lockStatus}`, detail: "Create the lock with the four settings and both keys, then record the secret link.", target: "shared" });
    }
    list(record.report?.needsDan).forEach((item) => items.push({ label: item, detail: "", target: "report" }));

    return `
      <section class="rail-card ob-needs">
        <p class="rail-title">Needs Dan <span class="ob-needs-count" data-tone="${items.length ? "warn" : "ok"}">${items.length}</span></p>
        <div class="field ob-operator">
          <label for="obRailOperator">Approvals recorded as</label>
          <input id="obRailOperator" type="text" value="${esc(operator())}" placeholder="Dan" autocomplete="off" data-ob-operator>
        </div>
        ${items.length
          ? `<ul class="ob-needs-list">${items
              .map(
                (item) => `<li>
                  <b>${esc(item.label)}</b>
                  ${item.detail ? `<span>${esc(item.detail)}</span>` : ""}
                  <button class="btn btn-ghost btn-sm" type="button" data-ob="goto" data-ob-target="${esc(item.target)}">Go</button>
                </li>`
              )
              .join("")}</ul>`
          : `<p class="hint">Nothing waiting on an approval.</p>`}
      </section>`;
  }

  function logCard(record) {
    const log = list(record.build?.log).slice(-LOG_TAIL);
    return `
      <section class="rail-card ob-log-card">
        <p class="rail-title">Build log</p>
        <div class="ob-log" data-ob-log tabindex="0" role="group" aria-label="Build log">
          ${log.length ? log.map((line) => `<span>${esc(line)}</span>`).join("") : `<span class="hint">Nothing logged yet.</span>`}
        </div>
      </section>`;
  }

  function linksCard(record) {
    const links = [
      { label: "Department folder", url: record.drive?.departmentFolderUrl },
      { label: "Omni Printer folder", url: record.drive?.productionFolderUrl },
      { label: "Shopify collection", url: record.collection?.url },
      { label: "Storefront", url: record.collection?.storefrontUrl },
      { label: "Policy review doc", url: record.policyReview?.driveDocUrl },
      { label: "Report doc", url: record.report?.driveDocUrl }
    ].filter((link) => link.url);
    return `
      <section class="rail-card">
        <p class="rail-title">Links</p>
        ${links.length
          ? `<ul class="drive-files ob-links">${links
              .map((link) => `<li><a href="${esc(link.url)}" target="_blank" rel="noreferrer">${ICON_FILE}<span>${esc(link.label)}</span></a></li>`)
              .join("")}</ul>`
          : `<p class="hint">Folders and the collection appear here as the build creates them.</p>`}
      </section>`;
  }

  /* =========================================================================
     Detail interactions
     ====================================================================== */
  function page() {
    return root()?.querySelector("[data-ob-page='detail']") || null;
  }

  function fail(message) {
    showBanner(page(), "obDetailError", message);
  }

  function applyRecord(payload) {
    const next = payload?.onboarding;
    if (!next) throw new Error("The server answered without a record.");
    state.record = next;
    renderDetail();
  }

  function onDetailChange(event) {
    const upload = event.target.closest("input[data-ob-upload]");
    if (upload) {
      uploadFiles(upload);
      return;
    }
    const role = event.target.closest("[data-ob-role]");
    if (role) {
      setArtworkRole(role.dataset.obRole, role.value);
      return;
    }
    const operatorInput = event.target.closest("[data-ob-operator]");
    if (operatorInput) setOperator(operatorInput.value.trim());
  }

  function onDetailClick(event) {
    const trigger = event.target.closest("[data-ob]");
    if (!trigger) return;
    const action = trigger.dataset.ob;
    const record = state.record;
    if (!record) return;

    if (action === "goto") {
      const target = document.getElementById(`obPanel-${trigger.dataset.obTarget}`) || page()?.querySelector(`[data-ob-panel="${trigger.dataset.obTarget}"]`);
      target?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      target?.querySelector("button, input, select, textarea, a[href]")?.focus({ preventScroll: true });
      return;
    }
    if (action === "copy") {
      const targetId = trigger.dataset.obCopyTarget;
      const text = targetId ? document.getElementById(targetId)?.value || "" : trigger.dataset.obCopyText || "";
      copyText(text, trigger);
      return;
    }
    if (action === "reload") {
      loadDetail(record.id);
      return;
    }
    if (action === "pick-code") {
      const input = page()?.querySelector("#obCodeValue");
      if (input) {
        input.value = trigger.dataset.obCode || "";
        input.focus();
      }
      page()
        ?.querySelectorAll(".ob-candidate")
        .forEach((node) => {
          node.dataset.picked = node === trigger ? "true" : "false";
        });
      return;
    }
    if (action === "approve-code") return approveCode(trigger);
    if (action === "run-setup") return runSimple(trigger, "Running…", "/setup");
    if (action === "run-review") return runSimple(trigger, "Reviewing…", "/review");
    if (action === "refresh-production") return runSimple(trigger, "Reading…", "/production-files");
    if (action === "final-check") return runSimple(trigger, "Checking…", "/final-check");
    if (action === "propose-shared") return runSimple(trigger, "Computing…", "/shared-settings/propose");
    if (action === "verify-shared") return runSimple(trigger, "Verifying…", "/shared-settings/verify");
    if (action === "approve-shared") return approveShared(trigger, false);
    if (action === "confirm-shared") return approveShared(trigger, true);
    if (action === "save-lock") return saveLock(trigger);
    if (action === "create-lock") return createLock(trigger);
    if (action === "save-notes") return saveNotes(trigger);
    if (action === "save-products") return saveProducts(trigger);
    if (action === "build") return startBuild(trigger);
    if (action === "delete") return deleteRecord(trigger);
    if (action === "remove-file") return removeFile(trigger);
    if (action === "use-suggestions") return useSuggestions(trigger);

    // Row editing is local until "Save products" — nothing below touches the
    // server, so the operator can add and remove rows freely.
    if (action === "add-product") {
      const holder = page()?.querySelector(".ob-products");
      if (holder) {
        // Appended rather than re-rendered: a repaint here would throw away
        // every unsaved edit in the rows already on screen.
        holder.insertAdjacentHTML(
          "beforeend",
          productRowHtml(record, { id: nextProductId(), colors: [], sizes: [], styles: [] }, holder.querySelectorAll("[data-ob-product]").length)
        );
      } else {
        // No rows yet, so nothing can be lost by repainting the panel.
        record.products = [{ id: nextProductId(), colors: [], sizes: [], styles: [] }];
        renderDetail();
      }
      page()?.querySelector(".ob-products [data-ob-product]:last-child input")?.focus();
      return;
    }
    if (action === "remove-product") {
      trigger.closest("[data-ob-product]")?.remove();
      page()?.querySelector("[data-ob='save-products']")?.focus();
      return;
    }
    if (action === "add-style") {
      const holder = trigger.closest(".ob-styles")?.querySelector("[data-ob-style-list]");
      if (!holder) return;
      const index = holder.querySelectorAll("[data-ob-style]").length;
      holder.insertAdjacentHTML("beforeend", styleRowHtml({}, index));
      holder.lastElementChild?.querySelector("input")?.focus();
      return;
    }
    if (action === "remove-style") {
      const holder = trigger.closest("[data-ob-style-list]");
      trigger.closest("[data-ob-style]")?.remove();
      renumberStyles(holder);
    }
  }

  function renumberStyles(holder) {
    if (!holder) return;
    [...holder.querySelectorAll("[data-ob-style]")].forEach((node, index) => {
      const name = node.querySelector(".ob-style-name");
      if (name) name.textContent = `Style ${index + 1}`;
      node.querySelector("input")?.setAttribute("aria-label", `Decoration codes for Style ${index + 1}`);
      node.querySelector("[data-ob='remove-style']")?.setAttribute("aria-label", `Remove Style ${index + 1}`);
    });
  }

  function nextProductId() {
    const used = list(state.record?.products).map((product) => String(product?.id || ""));
    let n = used.length + 1;
    while (used.includes(`p${n}`)) n += 1;
    return `p${n}`;
  }

  function currentOperator() {
    const field = page()?.querySelector("#obRailOperator") || page()?.querySelector("#obApprovedBy");
    const value = field?.value.trim() || operator();
    if (value) setOperator(value);
    return value;
  }

  function runSimple(button, busyLabel, suffix, body) {
    const id = state.record?.id;
    if (!id) return;
    return runAction(
      button,
      busyLabel,
      async () => {
        const payload = await api(recordPath(id, suffix), { method: "POST", body: JSON.stringify(body || {}) });
        if (!isCurrent("detail", id)) return;
        applyRecord(payload);
      },
      page(),
      "obDetailError"
    );
  }

  function approveCode(button) {
    const id = state.record?.id;
    const value = (page()?.querySelector("#obCodeValue")?.value || "").trim().toUpperCase();
    if (!value) {
      fail("Pick a candidate or type the code before approving it.");
      page()?.querySelector("#obCodeValue")?.focus();
      return;
    }
    /* §2.3: a code another department already owns must never be reused — it
       would collide in every SKU, tag, folder and print-file name, and once
       products are built it cannot be undone. The agent already worked out
       which candidates are taken; an amber tint is not enough of a guard, so
       the owner has to be said out loud and confirmed. */
    const code = state.record?.department?.code || {};
    const taken =
      list(code.candidates).find((c) => c && c.code === value && c.inUse) ||
      list(code.matches).find((m) => m && m.code === value && m.agency);
    if (taken) {
      const owner = taken.agency || "another department";
      if (!window.confirm(`${value} is already used by ${owner}. Reusing a code collides in every SKU, tag and file name for both departments. Approve it anyway?`)) {
        page()?.querySelector("#obCodeValue")?.focus();
        return;
      }
    }
    return runSimple(button, "Approving…", "/code", { code: value, by: currentOperator() });
  }

  function approveShared(button, applied) {
    const kind = button.dataset.obKind;
    if (!kind) return;
    return runSimple(button, applied ? "Recording…" : "Applying…", `/shared-settings/${encodeURIComponent(kind)}/approve`, {
      by: currentOperator(),
      applied: Boolean(applied)
    });
  }

  function saveLock(button) {
    const secretLink = page()?.querySelector("#obLockLink")?.value.trim() || "";
    const locksmithLockId = page()?.querySelector("#obLockId")?.value.trim() || "";
    /* Posting an empty body takes the server's "create the lock" branch, which
       calls Locksmith for real and is not idempotent — a second click would
       make a second lock on the same collection. Recording what Dan already
       built is a different action from asking for a new one, so this button
       only ever records. */
    if (!secretLink && !locksmithLockId) {
      fail("Paste the secret link or the Locksmith lock id to record the lock, or use \u201cCreate the lock\u201d to have the agent make one.");
      page()?.querySelector("#obLockLink")?.focus();
      return;
    }
    return runSimple(button, "Saving…", "/lock", { secretLink, locksmithLockId });
  }

  // The explicit, deliberate path: ask Locksmith to create the lock.
  function createLock(button) {
    if (!window.confirm("Create the Locksmith lock for this collection now? This makes a real lock in Locksmith.")) return;
    return runSimple(button, "Creating…", "/lock", {});
  }

  function saveNotes(button) {
    const id = state.record?.id;
    if (!id) return;
    const notes = page()?.querySelector("[data-ob-field='packetNotes']")?.value ?? "";
    return runAction(
      button,
      "Saving…",
      async () => {
        const payload = await api(recordPath(id), { method: "PATCH", body: JSON.stringify({ packet: { notes } }) });
        if (!isCurrent("detail", id)) return;
        applyRecord(payload);
      },
      page(),
      "obDetailError"
    );
  }

  function useSuggestions(button) {
    const suggestions = list(state.record?.policyReview?.suggestedProducts);
    if (!suggestions.length) return;
    // Local only: the rows land in the editor for Dan to check against what the
    // rep confirmed, and reach the server on the next "Save products".
    state.record.products = suggestions.map((row, index) => ({ ...row, id: row?.id || `p${index + 1}` }));
    renderDetail();
    page()?.querySelector("[data-ob-panel='inputs']")?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    if (button) button.disabled = false;
  }

  /* The saved row is spread in first on purpose: blankPhotos, proofs, mockups,
     sourceProduct, and the Shopify ids are server-owned and are NOT rendered as
     inputs. Rebuilding the row from the visible fields alone would silently
     orphan every uploaded photo and re-create products that already exist. */
  function collectProducts() {
    const saved = list(state.record?.products);
    return [...(page()?.querySelectorAll("[data-ob-product]") || [])].map((node, index) => {
      const id = node.dataset.obProduct || `p${index + 1}`;
      const read = (name) => node.querySelector(`[data-ob-field="${name}"]`)?.value.trim() ?? "";
      const previous = saved.find((row) => row?.id === id) || {};
      const styles = [...node.querySelectorAll("[data-ob-style]")]
        .map((styleNode) => ({ decorationCodes: styleNode.querySelector("[data-ob-field='styleCodes']")?.value.trim() || "" }))
        .filter((style) => style.decorationCodes);
      return {
        ...previous,
        id,
        brand: read("brand"),
        styleNumber: read("styleNumber"),
        type: read("type"),
        title: read("title"),
        colors: parseList(read("colors")),
        sizes: parseList(read("sizes")),
        decorationMethod: read("decorationMethod"),
        decorationCodes: read("decorationCodes"),
        styles,
        fulfillment: read("fulfillment"),
        classB: node.querySelector("[data-ob-field='classB']")?.checked === true,
        notes: read("notes")
      };
    });
  }

  function saveProducts(button) {
    const id = state.record?.id;
    if (!id) return;
    const products = collectProducts();
    return runAction(
      button,
      "Saving…",
      async () => {
        const payload = await api(recordPath(id, "/products"), { method: "PUT", body: JSON.stringify({ products }) });
        if (!isCurrent("detail", id)) return;
        applyRecord(payload);
      },
      page(),
      "obDetailError"
    );
  }

  function startBuild(button) {
    const id = state.record?.id;
    if (!id) return;
    const rerun = Boolean(state.record?.build?.state && state.record.build.state !== "running");
    return runAction(
      button,
      "Starting…",
      async () => {
        await api(recordPath(id, "/build"), { method: "POST", body: JSON.stringify({ force: rerun }) });
        if (!isCurrent("detail", id)) return;
        await loadDetail(id);
      },
      page(),
      "obDetailError"
    );
  }

  function removeFile(button) {
    const id = state.record?.id;
    const assetId = button.dataset.obFile;
    if (!id || !assetId) return;
    return runAction(
      button,
      "",
      async () => {
        const payload = await api(`${recordPath(id)}/files/${encodeURIComponent(assetId)}`, { method: "DELETE" });
        if (!isCurrent("detail", id)) return;
        applyRecord(payload);
      },
      page(),
      "obDetailError"
    );
  }

  function setArtworkRole(assetId, role) {
    const id = state.record?.id;
    if (!id || !assetId) return;
    const files = list(state.record?.packet?.files).map((file) => (file?.assetId === assetId ? { ...file, role } : file));
    api(recordPath(id), { method: "PATCH", body: JSON.stringify({ packet: { files } }) })
      .then((payload) => {
        if (!isCurrent("detail", id)) return;
        applyRecord(payload);
      })
      .catch((error) => fail(error.message));
  }

  async function uploadFiles(input) {
    const id = state.record?.id;
    const files = [...input.files];
    if (!id || !files.length) return;
    const kind = input.dataset.obUpload === "packet" ? page()?.querySelector("[data-ob-add-kind]")?.value || "other" : input.dataset.obUpload;
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    body.append("kind", kind);
    if (input.dataset.obProductId) body.append("productId", input.dataset.obProductId);
    if (input.dataset.obColor) body.append("color", input.dataset.obColor);
    if (input.dataset.obFace) body.append("face", input.dataset.obFace);
    if (input.dataset.obDecorationcode) body.append("decorationCode", input.dataset.obDecorationcode);
    input.disabled = true;
    try {
      const payload = await api(recordPath(id, "/files"), { method: "POST", body });
      if (!isCurrent("detail", id)) return;
      applyRecord(payload);
    } catch (error) {
      input.disabled = false;
      input.value = "";
      fail(error.message);
    }
  }

  /* The only window.confirm in this view: deleting the record is destructive
     and irreversible, so it takes an itemized confirm AND the department name
     typed back. Shopify and Drive are never touched. */
  async function deleteRecord(button) {
    const record = state.record;
    if (!record) return;
    const name = record.department?.name || "this onboarding";
    const first = window.confirm(
      `Delete the "${name}" onboarding record?\n\nThis removes the record, its packet files, mockups, and build history from this console.\n` +
        `It does NOT touch Shopify, the Locksmith lock, or Google Drive.\n\nThere is no undo.`
    );
    if (!first) return;
    const typed = window.prompt(`Final check — type the department name exactly to delete it:\n\n${name}`);
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== name.toLowerCase()) {
      fail("The name did not match. Nothing was deleted.");
      return;
    }
    await runAction(
      button,
      "Deleting…",
      async () => {
        await api(recordPath(record.id), { method: "DELETE", body: JSON.stringify({ confirmName: typed.trim() }) });
        window.location.hash = "#/onboarding";
      },
      page(),
      "obDetailError"
    );
  }

  /* ---------------------------------------------------------------------------
     Polling. Surgical: a full repaint every 5s would wipe whatever the
     operator is typing into the product rows.
     ------------------------------------------------------------------------ */
  function stopPolling() {
    if (state.pollTimer) {
      window.clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function maybePoll() {
    stopPolling();
    const buildState = state.record?.build?.state;
    /* Only a live build is worth polling. An interrupted one is waiting for
       somebody to press Resume — polling it forever just repainted the same
       page every five seconds and re-announced it to a screen reader. */
    if (buildState !== "running") return;
    const id = state.record.id;
    state.pollTimer = window.setTimeout(async () => {
      if (!isCurrent("detail", id)) return;
      try {
        const payload = await api(recordPath(id));
        if (!isCurrent("detail", id)) return;
        const next = payload.onboarding;
        if (next) {
          const wasRunning = state.record?.build?.state;
          state.record = next;
          const nowRunning = next.build?.state === "running";
          if (nowRunning) {
            repaintBuild();
            maybePoll();
          } else if (wasRunning) {
            // The build just finished: mockups, links, and the report changed,
            // and nothing the operator typed survives a finished build anyway.
            renderDetail();
          }
          return;
        }
        maybePoll();
      } catch (error) {
        // A transient 500 or a dropped network must not freeze the panel on
        // "Building…" — keep polling unless the admin prompt was cancelled,
        // which would otherwise reopen it every five seconds.
        if (isCurrent("detail", id) && !/admin token/i.test(String(error?.message || ""))) maybePoll();
      }
    }, POLL_MS);
  }

  // The one place the view speaks to a screen reader: short, and only when the
  // step actually changes.
  let lastAnnounced = "";
  function announce(message) {
    const node = document.getElementById("onboardingStatus");
    if (!node || !message || message === lastAnnounced) return;
    lastAnnounced = message;
    node.textContent = message;
  }

  function repaintBuild() {
    const scope = page();
    const record = state.record;
    if (!scope || !record) return;
    const buildNode = scope.querySelector("[data-ob-build]");
    if (buildNode) {
      buildNode.innerHTML = buildBodyHtml(record);
      hydrateAssetImages(buildNode);
    }
    const logNode = scope.querySelector("[data-ob-log]");
    if (logNode) {
      const log = list(record.build?.log).slice(-LOG_TAIL);
      logNode.innerHTML = log.length ? log.map((line) => `<span>${esc(line)}</span>`).join("") : `<span class="hint">Nothing logged yet.</span>`;
      logNode.scrollTop = logNode.scrollHeight;
    }
    const statusNode = scope.querySelector("[data-ob-status]");
    if (statusNode) {
      statusNode.dataset.tone = statusTone(record.status);
      statusNode.textContent = statusLabel(record.status);
    }
    const stepper = scope.querySelector("[data-ob-stepper]");
    if (stepper) stepper.outerHTML = stepperHtml(record);
    const steps = list(record.build?.steps);
    const runningStep = steps.find((step) => step?.state === "running");
    const done = steps.filter((step) => step?.state === "complete").length;
    announce(
      record.build?.state === "running" && steps.length
        ? `${runningStep?.label || "Working"} — step ${Math.min(done + 1, steps.length)} of ${steps.length}`
        : record.build?.state
          ? `Build ${record.build.state}`
          : ""
    );
  }

  /* =========================================================================
     REFERENCE VIEW
     ====================================================================== */
  function renderReference() {
    const node = root();
    if (!node) return;
    node.innerHTML = `
      <div class="ob-reference" data-ob-page="reference">
        <nav class="crumbs" aria-label="Breadcrumb">
          <a href="#/onboarding">Onboarding</a>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Reference tables</span>
        </nav>
        <section class="hero">
          <p class="eyebrow">Source of truth</p>
          <h2>The tables the agent reads from — and only adds to with an approval.</h2>
          <p>Department codes, colour codes, the blank library, and the standard text. A code that is not on these tables is never used in a SKU, a folder name, or a tag.</p>
        </section>
        ${banner("obRefError")}
        <div class="ob-tabs" role="tablist" aria-label="Reference tables">
          ${REFERENCE_TABS.map(
            (tab) => `
            <button class="ob-tab" type="button" role="tab" id="obTab-${esc(tab.key)}" aria-controls="obTabPanel" aria-selected="${tab.key === state.refTab ? "true" : "false"}" data-ob="tab" data-ob-tab="${esc(tab.key)}">${esc(tab.label)}</button>`
          ).join("")}
        </div>
        <div id="obTabPanel" role="tabpanel" aria-labelledby="obTab-${esc(state.refTab)}"></div>
      </div>`;
    const scope = node.querySelector("[data-ob-page='reference']");
    scope.addEventListener("click", onReferenceClick);
    scope.addEventListener("input", (event) => {
      const search = event.target.closest("[data-ob-ref-search]");
      if (!search) return;
      const caret = search.selectionStart;
      state.refFilter = search.value.trim().toLowerCase();
      // The panel is re-rendered under the operator's cursor, so focus and the
      // caret are put back exactly where they were.
      renderReferenceTable({ focusSearch: true, caret, raw: search.value });
    });
    scope.addEventListener("keydown", onReferenceKeydown);
    scope.addEventListener("submit", onReferenceSubmit);
    loadReferenceTable(state.refTab);
  }

  /* Arrow keys move between tabs, as a tablist is expected to. */
  function onReferenceKeydown(event) {
    const tab = event.target.closest("[data-ob='tab']");
    if (!tab) return;
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const tabs = [...(root()?.querySelectorAll("[data-ob='tab']") || [])];
    const index = tabs.indexOf(tab);
    const next = tabs[(index + step + tabs.length) % tabs.length];
    next?.focus();
    next?.click();
  }

  function refTab() {
    return REFERENCE_TABS.find((tab) => tab.key === state.refTab) || REFERENCE_TABS[0];
  }

  async function loadReferenceTable(key) {
    state.refTab = key;
    state.refData = null;
    const panel = el("obTabPanel");
    if (!panel) return;
    panel.setAttribute("aria-labelledby", `obTab-${key}`);
    panel.innerHTML = stateBlock({ tone: "info", title: "Loading the table…", spinner: true });
    try {
      const payload = await api(`${REF_API}/${encodeURIComponent(key)}`);
      if (!isCurrent("reference") || state.refTab !== key) return;
      state.refData = { rows: list(payload.rows), proposals: list(payload.proposals) };
      renderReferenceTable();
    } catch (error) {
      if (!isCurrent("reference") || state.refTab !== key) return;
      panel.innerHTML = stateBlock({
        tone: "danger",
        title: "Could not load this table",
        sub: error.message,
        actionHtml: `<button class="btn btn-secondary btn-sm" type="button" data-ob="reload-table">Try again</button>`
      });
    }
  }

  function cellText(value) {
    if (value == null) return "";
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function renderReferenceTable({ focusSearch = false, caret = null, raw = null } = {}) {
    const panel = el("obTabPanel");
    const tab = refTab();
    const data = state.refData;
    if (!panel || !data) return;
    const term = state.refFilter;
    const rows = term
      ? data.rows.filter((row) => tab.columns.some((column) => cellText(row?.[column.k]).toLowerCase().includes(term)))
      : data.rows;
    panel.innerHTML = `
      <div class="ob-ref-toolbar">
        <div class="search-field">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <label class="sr-only" for="obRefSearch">Filter ${esc(tab.label)}</label>
          <input id="obRefSearch" type="search" placeholder="Filter ${esc(tab.label.toLowerCase())}…" autocomplete="off" value="${esc(raw ?? term)}" data-ob-ref-search>
        </div>
        <span class="hint">${rows.length} of ${data.rows.length} row${plural(data.rows.length, "", "s")}</span>
        ${tab.sync ? `<button class="btn btn-secondary btn-sm" type="button" data-ob="sync-codes">Sync from Drive</button>` : ""}
      </div>
      ${proposalsHtml(tab, data.proposals)}
      ${rows.length
        ? `<div class="ob-table-wrap">
            <table class="ob-table">
              <thead><tr>${tab.columns.map((column) => `<th scope="col">${esc(column.label)}</th>`).join("")}</tr></thead>
              <tbody>
                ${rows
                  .map(
                    (row) => `<tr>${tab.columns
                      .map((column) => `<td${column.mono ? ' class="ob-mono"' : ""}${column.wide ? ' class="ob-wide"' : ""}>${esc(cellText(row?.[column.k]))}</td>`)
                      .join("")}</tr>`
                  )
                  .join("")}
              </tbody>
            </table>
          </div>`
        : stateBlock({
            title: term ? `No row matches “${term}”` : "This table is empty",
            sub: term ? "Clear the filter to see every row." : "Add the first row below, or sync the list from Drive."
          })}
      ${addRowFormHtml(tab)}`;
    if (!focusSearch) return;
    const search = panel.querySelector("[data-ob-ref-search]");
    if (!search) return;
    search.focus({ preventScroll: true });
    if (caret != null) search.setSelectionRange(caret, caret);
  }

  function proposalsHtml(tab, proposals) {
    const pending = proposals.filter((proposal) => (proposal?.status || "pending") === "pending");
    if (!pending.length) return "";
    return `
      <div class="ob-proposals">
        <p class="field-label">Waiting for approval <small>${pending.length}</small></p>
        ${pending
          .map(
            (proposal) => `
          <div class="ob-proposal-row" data-ob-proposal="${esc(proposal.id || "")}">
            <div>
              <b>${esc(cellText(proposal?.row?.[tab.keyField]))}</b>
              <span>${esc(tab.columns
                .filter((column) => column.k !== tab.keyField)
                .map((column) => cellText(proposal?.row?.[column.k]))
                .filter(Boolean)
                .join(" · "))}</span>
              ${proposal?.reason ? `<small>${esc(proposal.reason)}</small>` : ""}
              ${proposal?.onboardingId ? `<a href="#/onboarding/${encodeURIComponent(proposal.onboardingId)}">Open the onboarding</a>` : ""}
            </div>
            <div class="ob-proposal-actions">
              <button class="btn btn-primary btn-sm" type="button" data-ob="decide-proposal" data-ob-proposal-id="${esc(proposal.id || "")}" data-ob-approve="true">Approve</button>
              <button class="btn btn-ghost btn-sm" type="button" data-ob="decide-proposal" data-ob-proposal-id="${esc(proposal.id || "")}" data-ob-approve="false">Reject</button>
            </div>
          </div>`
          )
          .join("")}
      </div>`;
  }

  function addRowFormHtml(tab) {
    const inputs = tab.columns.filter((column) => column.input);
    return `
      <form class="ob-addrow card card-pad" data-ob-addrow>
        <p class="field-label">Add a row to ${esc(tab.label.toLowerCase())}</p>
        <div class="category-edit-grid">
          ${inputs
            .map(
              (column) => `
            <label${column.wide ? ' class="span-2"' : ""}>
              <span>${esc(column.label)}${column.required ? " *" : ""}</span>
              ${column.type === "textarea"
                ? `<textarea data-ob-row-field="${esc(column.k)}" rows="3"></textarea>`
                : `<input type="text" data-ob-row-field="${esc(column.k)}"${column.mono ? ' class="code-input"' : ""} autocomplete="off">`}
            </label>`
            )
            .join("")}
        </div>
        <div class="ob-panel-actions">
          <button class="btn btn-secondary btn-sm" type="submit">Add row</button>
        </div>
      </form>`;
  }

  function onReferenceClick(event) {
    const trigger = event.target.closest("[data-ob]");
    if (!trigger) return;
    const action = trigger.dataset.ob;
    if (action === "tab") {
      const key = trigger.dataset.obTab;
      if (!key || key === state.refTab) return;
      state.refFilter = "";
      root()
        ?.querySelectorAll("[data-ob='tab']")
        .forEach((node) => node.setAttribute("aria-selected", node === trigger ? "true" : "false"));
      loadReferenceTable(key);
      return;
    }
    if (action === "reload-table") return loadReferenceTable(state.refTab);
    if (action === "sync-codes") {
      return runAction(
        trigger,
        "Syncing…",
        async () => {
          const payload = await api(`${REF_API}/department-codes/sync`, { method: "POST", body: JSON.stringify({}) });
          if (!isCurrent("reference")) return;
          await loadReferenceTable("department-codes");
          showBanner(
            root()?.querySelector("[data-ob-page='reference']"),
            "obRefError",
            `Imported ${payload?.imported ?? 0} row${plural(payload?.imported ?? 0, "", "s")} from the Drive doc.`,
            "ok"
          );
        },
        root()?.querySelector("[data-ob-page='reference']"),
        "obRefError"
      );
    }
    if (action === "decide-proposal") {
      const proposalId = trigger.dataset.obProposalId;
      const approve = trigger.dataset.obApprove === "true";
      if (!proposalId) return;
      return runAction(
        trigger,
        approve ? "Approving…" : "Rejecting…",
        async () => {
          await api(`${REF_API}/${encodeURIComponent(state.refTab)}/proposals/${encodeURIComponent(proposalId)}`, {
            method: "POST",
            body: JSON.stringify({ approve, by: operator() })
          });
          if (!isCurrent("reference")) return;
          await loadReferenceTable(state.refTab);
        },
        root()?.querySelector("[data-ob-page='reference']"),
        "obRefError"
      );
    }
  }

  function onReferenceSubmit(event) {
    const form = event.target.closest("[data-ob-addrow]");
    if (!form) return;
    event.preventDefault();
    const tab = refTab();
    const row = {};
    tab.columns
      .filter((column) => column.input)
      .forEach((column) => {
        const value = form.querySelector(`[data-ob-row-field="${column.k}"]`)?.value.trim() || "";
        if (value) row[column.k] = value;
      });
    const missing = tab.columns.filter((column) => column.required && !row[column.k]);
    if (missing.length) {
      showBanner(root()?.querySelector("[data-ob-page='reference']"), "obRefError", `${missing.map((column) => column.label).join(" and ")} ${missing.length === 1 ? "is" : "are"} required.`);
      return;
    }
    runAction(
      form.querySelector('[type="submit"]'),
      "Adding…",
      async () => {
        await api(`${REF_API}/${encodeURIComponent(tab.key)}/rows`, { method: "POST", body: JSON.stringify({ rows: [row] }) });
        if (!isCurrent("reference")) return;
        await loadReferenceTable(tab.key);
      },
      root()?.querySelector("[data-ob-page='reference']"),
      "obRefError"
    );
  }

  /* =========================================================================
     Mount / unmount — main.js's handleRoute owns both
     ====================================================================== */
  function mount(view, id) {
    const node = root();
    if (!node) return;
    stopPolling();
    closeModal();
    releaseObjectUrls();
    state.view = view;
    state.id = id || null;
    state.record = null;
    if (view === "detail") {
      // A deep link opens the detail view without the list ever rendering, so
      // the capabilities it reads (can Locksmith be called? is the menu
      // writable?) are fetched here too. Failure is not fatal: the card falls
      // back to the checklist wording.
      if (!state.caps) {
        api(`${API}/capabilities`)
          .then((payload) => {
            state.caps = payload;
            if (isCurrent("detail", id) && state.record) renderDetail();
          })
          .catch(() => {});
      }
      loadDetail(id);
    }
    else if (view === "reference") renderReference();
    else renderList();
  }

  function unmount() {
    stopPolling();
    closeModal();
    releaseObjectUrls();
    state.view = null;
    state.id = null;
    state.record = null;
    state.refData = null;
    const node = root();
    if (node) node.innerHTML = "";
  }

  window.FNOnboarding = { mount, unmount };

  /* main.js calls handleRoute() at the end of its own file — before this
     script has run — so a page opened directly on #/onboarding would show an
     empty section until the next hashchange. Mount it here instead. */
  const path = (window.location.hash.replace(/^#/, "") || "").split("?")[0];
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "onboarding") {
    if (parts[1] === "reference") mount("reference");
    else if (parts[1]) mount("detail", decodeURIComponent(parts[1]));
    else mount("list");
  }
})();

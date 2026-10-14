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
     POST   /api/onboardings/:id/build               → 202 { started, build }
     POST   /api/onboardings/:id/shared-settings/*   → { onboarding }
     POST   /api/onboardings/:id/lock|final-check    → { onboarding }
     GET    /api/onboardings/capabilities            → { shopify, drive, … }
     GET    /api/onboardings/menu-health[?fresh=1]   → MenuHealth
     POST   /api/onboardings/menu-health/accept      → MenuHealth
     POST   /api/onboardings/menu-health/restore     → { restored, skipped, health }
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
  /* The detail page is a wizard: one step on screen at a time, in the order
     the work has to happen. It used to be every panel stacked on one 17,000px
     page, and an operator who had just created a record landed on a "Ready to
     finish?" card with no idea the next thing was to upload the policy.

     `what` is the plain sentence at the top of each step: what happens on this
     page and what the agent does when you press the button. */
  const STEPS = [
    {
      key: "packet",
      label: "Packet",
      title: "Upload what the department sent",
      what: "Add the artwork, and the uniform policy if the department sent one. The agent reads the policy for garments, colours and placement, and the artwork becomes the mockups and the collection banner. Continuing looks the department up on the Department Code List."
    },
    {
      key: "code",
      label: "Code",
      title: "Approve the department code",
      what: "The code goes into every SKU, tag and folder name, so nothing is created until it is approved. Approving creates the Drive folders, uploads the packet, reviews the policy, and drafts the rep email. That takes about a minute."
    },
    {
      key: "review",
      label: "Policy review",
      title: "Check the policy review and the rep email",
      what: "What the policy confirmed, what is missing, and a draft email asking the rep for the rest. The agent never sends it."
    },
    {
      key: "products",
      label: "Products",
      title: "List the products",
      what: "One row per garment, filled from the policy and from how the store already sells each blank. The logos come from what you uploaded in step 1; blank photos and embroidery proofs are optional. Every row has to validate before the build can run."
    },
    {
      key: "build",
      label: "Build",
      title: "Build the store",
      what: "The agent makes the mockups, creates the collection with its banner, creates the Locksmith lock, then creates every product as a Draft with its SKUs and images. Nothing is published."
    },
    {
      key: "finish",
      label: "Finish",
      title: "Mega Menu, Shopify Flow and Helium",
      what: "Flow and Helium have no write API, so you add the department tag in each by hand, with the steps under each box below, and only then tick it. Finishing adds the store to the Mega Menu and runs the final check. Not done in Flow or Helium yet? Press “Not yet” instead of ticking: the onboarding stays open until you confirm them."
    },
    {
      key: "done",
      label: "Done",
      title: "Onboarding complete",
      what: "Everything the agent can do and check is done. What is left happens in Shopify: prices, cost, Easify options, and setting the products Active."
    }
  ];

  // Upload kinds accepted by POST …/files (record schema §2, packet.files.kind).
  const FILE_KINDS = [
    { key: "policy", label: "Uniform policy" },
    { key: "artwork", label: "Artwork" },
    { key: "contacts", label: "Contact list" },
    { key: "blank", label: "Blank garment photo" },
    { key: "proof", label: "Embroidery proof" },
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

  const SIZE_HINT = "Comma separated, or a range: S-3XL, XS-5XL, LT-4XLT, 28-44. Hats: OSFA or S/M, L/XL.";

  // One-click size runs for the product rows. "add" appends (talls go on top
  // of a regular run); everything else replaces the field.
  const SIZE_PRESETS = [
    { label: "S–XL", sizes: "S, M, L, XL" },
    { label: "S–3XL", sizes: "S, M, L, XL, 2XL, 3XL" },
    { label: "XS–5XL", sizes: "XS, S, M, L, XL, 2XL, 3XL, 4XL, 5XL" },
    { label: "+ Talls LT–4XLT", sizes: "LT, XLT, 2XLT, 3XLT, 4XLT", add: true },
    { label: "OSFA", sizes: "OSFA" },
    { label: "S/M, L/XL", sizes: "S/M, L/XL" },
    { label: "Waist 28–44", sizes: "28, 30, 32, 34, 36, 38, 40, 42, 44" }
  ];
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
    pollTimer: null,
    // The wizard step on screen; null means "wherever the work is".
    step: null,
    // Master Reference garments ({label, brand, styleNumber, type, group, sizes}).
    garments: null,
    /* The live Mega Menu compared with the agent's saved copy (MenuHealth from
       GET …/menu-health). It belongs to the store, not to one onboarding, so it
       survives navigation between the list and a record; null until the first
       answer. `menuHealthSeq` drops an answer that a newer read, a restore or
       an accept has already overtaken. */
    menuHealth: null,
    menuHealthLoading: false,
    menuHealthError: "",
    menuHealthSeq: 0,
    // "restore" | "accept" while one of the banner's two writes is running.
    menuBusy: "",
    menuError: "",
    // What the last restore/accept did, shown until dismissed or remounted.
    menuNotice: null,
    // The step the last fresh menu read was taken for (see renderDetail).
    healthStep: null,
    // id -> { updatedAt, todo } for the queue's "Flow & Helium to do" chip.
    todoCache: new Map()
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

  /* The status rides on the error because one answer is not a failure of the
     request but a refusal with a reason: Helium approve answers 409 when a
     form the agent can read does not carry the tag, and finish has to stop
     there rather than report "that did not work". */
  async function api(path, options) {
    const res = await adminFetch(path, options);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(payload.error || `Request failed (${res.status}).`);
      error.status = res.status;
      error.code = payload.code || "";
      throw error;
    }
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
    // "blocked": the agent refused to write the Mega Menu because it looks wiped.
    if (value === "error" || value === "blocked") return "danger";
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
    // The lookup leaves a recommendation, not a value, so "not looked up" was
    // shown beside the very recommendation it had produced.
    const proposed = code.value || code.recommendation?.code || "";
    const value = proposed || "no code";
    const tone = code.approved ? "ok" : proposed ? "warn" : "muted";
    const suffix = code.approved
      ? "approved"
      : proposed
        ? `${code.value ? code.source || "proposed" : "recommended"} · needs approval`
        : list(code.candidates).length || list(code.matches).length
          ? "pick a code"
          : "not looked up";
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
    // background job reports itself without looking like a failure, and "warn"
    // is a step that worked but left something for the operator to do.
    if (tone === "ok" || tone === "warn") node.dataset.tone = tone;
    else delete node.dataset.tone;
    node.hidden = false;
    // Instant: a smooth scroll did not move this page at all (see goToStep).
    node.scrollIntoView({ block: "nearest" });
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
     MEGA MENU HEALTH — the danger banner on the queue and on every record
     -------------------------------------------------------------------------
     Shopify's menuUpdate replaces the WHOLE menu: every item not sent is
     deleted. On 2026-10-13 something outside the agent (an edit in Shopify,
     Sidekick or another app) rewrote the Mega Menu keeping only its top-level
     items. The agent then read an empty "Store", wrote one new store into it,
     and reported the menu as done; Dan rebuilt about a hundred stores by hand.

     The server now keeps a copy of the last good menu and refuses to write
     into one that looks wiped. This banner is how the operator finds out, and
     it carries the only two ways out: put the missing links back from that
     copy, or say the menu is right as it is now.

     It shows only when the menu was READ and looks wiped. A menu that could
     not be read (no scope, Shopify down) is unknown, not an alarm.
     ====================================================================== */
  const MENU_PREVIEW = 12;

  function menuLooksWiped(health = state.menuHealth) {
    return Boolean(health && health.available && !health.healthy);
  }

  /* Store's own children are the store links everyone knows by name; anything
     under another item (Contact's links, the Station Stores) carries its
     parent, so "Email us" in a list of fire departments is not a mystery. */
  function menuItemLabel(item) {
    const title = String(item?.title || item?.url || "untitled link");
    const parent = String(item?.parentTitle || "");
    return parent && parent.toLowerCase() !== "store" ? `${parent} › ${title}` : title;
  }

  function titleRun(labels) {
    const shown = labels.slice(0, MENU_PREVIEW);
    const more = labels.length - shown.length;
    return `${shown.join(", ")}${more > 0 ? ` … and ${more} more` : ""}`;
  }

  // The full list, grouped under the item each link sat under, in menu order.
  function missingGroupsHtml(missing) {
    const groups = new Map();
    for (const item of missing) {
      const parent = String(item?.parentTitle || "");
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(item);
    }
    return [...groups]
      .map(
        ([parent, items]) => `
        <div class="ob-menu-group">
          <p class="ob-menu-group-title">${esc(parent ? `Under ${parent}` : "Top of the menu")} <span>${items.length}</span></p>
          <ul>${items.map((item) => `<li>${esc(item?.title || item?.url || "untitled link")}</li>`).join("")}</ul>
        </div>`
      )
      .join("");
  }

  /* Two slots, so the notice of what a write just did and the alert about the
     menu as it stands repaint independently: a re-read that only moves the
     "checked" time must not wipe the notice the operator is reading. */
  function menuHealthHtml() {
    return `
      <div class="ob-menu-health" data-ob-menu-health>
        <div class="ob-menu-slot" data-ob-menu-slot="notice">${menuSlotHtml("notice")}</div>
        <div class="ob-menu-slot" data-ob-menu-slot="alert">${menuSlotHtml("alert")}</div>
      </div>`;
  }

  function menuSlotHtml(slot) {
    if (slot === "notice") return state.menuNotice ? menuNoticeHtml(state.menuNotice) : "";
    return menuLooksWiped() ? menuAlertHtml(state.menuHealth) : "";
  }

  function menuAlertHtml(health) {
    const missing = list(health.missing);
    const count = missing.length;
    const busy = state.menuBusy;
    const baseline = health.baseline || null;
    const storeCount = Number(health.storeCount) || 0;
    /* The server's message is "The Mega Menu looks wiped: " + its first
       reason, lower-cased. The heading already says the first half, and the
       reason it quotes would otherwise be listed a second time below it. */
    const message = String(health.message || "");
    const said = capitalize(message.replace(/^The Mega Menu looks wiped:\s*/i, ""));
    const reasons = list(health.reasons).filter((reason) => reason && !message.toLowerCase().includes(String(reason).toLowerCase()));
    const meta = [
      // The server's message usually says this already.
      message ? "" : `Store has ${storeCount} ${plural(storeCount, "store", "stores")} in the live menu now`,
      baseline?.at ? `the agent's saved copy is from ${when(baseline.at)}${baseline.by ? `, kept by ${baseline.by}` : ""}` : "",
      health.checkedAt ? `checked ${when(health.checkedAt)}` : ""
    ].filter(Boolean);
    return `
      <section class="ob-menu-alert" role="alert" aria-labelledby="obMenuAlertTitle">
        <span class="ob-menu-glyph" aria-hidden="true">${ICON_ALERT}</span>
        <div class="ob-menu-body">
          <h2 id="obMenuAlertTitle">The Mega Menu looks wiped — the agent won't touch it until it's fixed.</h2>
          ${said ? `<p class="ob-menu-message">${esc(said)}</p>` : ""}
          ${reasons.length ? `<ul class="ob-menu-reasons">${reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul>` : ""}
          ${count
            ? `<p><b>Missing:</b> ${esc(titleRun(missing.map(menuItemLabel)))}</p>
               <details class="ob-menu-details">
                 <summary>Show all ${count} missing ${plural(count, "link", "links")}</summary>
                 ${missingGroupsHtml(missing)}
               </details>`
            : ""}
          <p>Something outside the agent — an edit in Shopify, Sidekick or another app — removed ${count ? "these links" : "links from the menu"}. Your collections and products are untouched; only the menu links are gone.</p>
          ${meta.length ? `<p class="ob-menu-meta">${esc(capitalize(meta.join(" · ")))}.</p>` : ""}
          <div class="ob-menu-controls">
            <div class="field ob-operator">
              <label for="obMenuOperator">Recorded as</label>
              <input id="obMenuOperator" type="text" value="${esc(operator())}" placeholder="Dan" autocomplete="off" data-ob-operator ${busy ? "disabled" : ""}>
            </div>
            <div class="ob-menu-actions">
              ${count
                ? `<button class="btn btn-primary btn-sm ob-btn-wrap" type="button" data-ob="menu-restore" ${busy ? "disabled" : ""}>${
                    busy === "restore" ? `<span class="spinner" aria-hidden="true"></span>Putting them back…` : `Put the ${count} missing ${plural(count, "item", "items")} back`
                  }</button>`
                : ""}
              <button class="btn btn-secondary btn-sm ob-btn-wrap" type="button" data-ob="menu-accept" ${busy ? "disabled" : ""}>${
                busy === "accept" ? `<span class="spinner" aria-hidden="true"></span>Saving…` : "It's intentional — keep the menu as it is"
              }</button>
            </div>
          </div>
          <p class="ob-menu-hint">${count ? "<b>Put back</b> writes the missing links into the live menu from the agent's saved copy. " : ""}<b>Keep the menu as it is</b> changes nothing in Shopify: the agent takes today's menu as the right one and checks against it from now on.</p>
          ${state.menuError ? `<p class="ob-menu-error">${esc(state.menuError)}</p>` : ""}
        </div>
      </section>`;
  }

  /* What a restore or an accept actually did, from the server's answer — not
     from what the button asked for. Anything skipped is listed with its
     reason, because a link that did not come back is one Dan adds by hand. */
  function menuNoticeHtml(notice) {
    const restored = list(notice.restored).map((item) => (typeof item === "string" ? item : menuItemLabel(item)));
    const skipped = list(notice.skipped);
    return `
      <div class="banner ob-banner ob-menu-notice" data-tone="${esc(notice.tone)}" role="status" tabindex="-1" data-ob-menu-notice>
        <span class="b-glyph" aria-hidden="true">${ICON_ALERT}</span>
        <div class="ob-menu-notice-body">
          <p><b>${esc(notice.title)}</b></p>
          ${notice.text ? `<p>${esc(notice.text)}</p>` : ""}
          ${restored.length
            ? `<p>Back in the menu: ${esc(titleRun(restored))}</p>
               ${restored.length > MENU_PREVIEW
                 ? `<details class="ob-menu-details"><summary>Show all ${restored.length}</summary><ul>${restored.map((title) => `<li>${esc(title)}</li>`).join("")}</ul></details>`
                 : ""}`
            : ""}
          ${skipped.length
            ? `<p>Not put back — add ${skipped.length === 1 ? "it" : "these"} by hand in Shopify:</p>
               <ul class="ob-menu-skipped">${skipped
                 .map((item) => `<li><b>${esc(item?.title || "untitled link")}</b>${item?.reason ? ` — ${esc(item.reason)}` : ""}</li>`)
                 .join("")}</ul>`
            : ""}
          <button class="btn btn-ghost btn-sm" type="button" data-ob="menu-dismiss">Dismiss</button>
        </div>
      </div>`;
  }

  /* Repaints everything that depends on the menu's health, in place. Never a
     full renderDetail: the read lands whenever Shopify answers, and a full
     repaint would throw away product rows or a lock link being typed. */
  function repaintMenuHealth() {
    const holder = root()?.querySelector("[data-ob-menu-health]");
    holder?.querySelectorAll("[data-ob-menu-slot]").forEach((slot) => swapHtml(slot, menuSlotHtml(slot.dataset.obMenuSlot)));
    if (state.view === "detail" && state.record) repaintMenuDependents();
  }

  /* Replace a slot's markup only when it changed, and carry over what the
     operator was in the middle of: focus, a name being typed, an expanded
     list. role="alert" also re-announces on every insert, so an unchanged
     alert must stay the same node. */
  const menuSlotWritten = new WeakMap();
  function swapHtml(node, html) {
    if (!node || menuSlotWritten.get(node) === html) return;
    const focusKey = node.contains(document.activeElement) ? focusSelector(document.activeElement) : "";
    const typed = node.querySelector("#obMenuOperator")?.value;
    const opened = [...node.querySelectorAll("details")].map((details) => details.open);
    node.innerHTML = html;
    menuSlotWritten.set(node, html);
    const input = node.querySelector("#obMenuOperator");
    if (input && typed !== undefined) input.value = typed;
    node.querySelectorAll("details").forEach((details, index) => {
      if (opened[index]) details.open = true;
    });
    if (focusKey) node.querySelector(focusKey)?.focus({ preventScroll: true });
  }

  // A page render writes the slots itself; remember what it wrote, so the
  // first re-read after it does not re-insert an identical alert.
  function seedMenuSlots() {
    root()
      ?.querySelectorAll("[data-ob-menu-slot]")
      .forEach((slot) => menuSlotWritten.set(slot, menuSlotHtml(slot.dataset.obMenuSlot)));
  }

  async function loadMenuHealth({ fresh = false } = {}) {
    const seq = ++state.menuHealthSeq;
    state.menuHealthLoading = true;
    state.menuHealthError = "";
    repaintMenuHealth();
    try {
      const payload = await api(`${API}/menu-health${fresh ? "?fresh=1" : ""}`);
      if (seq !== state.menuHealthSeq) return;
      state.menuHealth = payload && typeof payload === "object" ? payload : null;
    } catch (error) {
      if (seq !== state.menuHealthSeq) return;
      /* Unknown is not an alarm, and not a reason to forget a wiped menu
         either: the last answer stays on screen. The finish card is the one
         place that says the check failed, because it is about to write. */
      state.menuHealthError = error?.message || "The Mega Menu could not be checked.";
    }
    state.menuHealthLoading = false;
    repaintMenuHealth();
  }

  function menuOperator() {
    const field = root()?.querySelector("#obMenuOperator");
    const value = field?.value.trim() || operator();
    if (value) setOperator(value);
    return value;
  }

  function menuAction(action) {
    if (action === "menu-restore") return restoreMenu();
    if (action === "menu-accept") return acceptMenu();
    if (action === "menu-dismiss") {
      state.menuNotice = null;
      repaintMenuHealth();
    }
  }

  /* Both writes share the busy state, the "who" check and the error line.
     `apply` turns the server's answer into the new health and the notice. */
  async function runMenuWrite(kind, path, apply) {
    if (state.menuBusy) return;
    const by = menuOperator();
    if (!by) {
      state.menuError = "Type your name in “Recorded as” first — it goes on the record with this change.";
      repaintMenuHealth();
      root()?.querySelector("#obMenuOperator")?.focus();
      return;
    }
    state.menuBusy = kind;
    state.menuError = "";
    state.menuNotice = null;
    repaintMenuHealth();
    try {
      const payload = await api(path, { method: "POST", body: JSON.stringify({ by }) });
      // Overtakes any read still in flight: it was taken before this write.
      state.menuHealthSeq += 1;
      state.menuHealthLoading = false;
      apply(payload || {});
      state.menuBusy = "";
      repaintMenuHealth();
      root()?.querySelector("[data-ob-menu-notice]")?.focus({ preventScroll: true });
      // Read the live menu again, so what the banner says next is Shopify's
      // answer and not only the server's account of its own write.
      loadMenuHealth({ fresh: true });
    } catch (error) {
      state.menuBusy = "";
      state.menuError = `${kind === "restore" ? "Putting the links back" : "Keeping the menu"} did not go through: ${error?.message || "no answer from the server."}`;
      repaintMenuHealth();
      // The busy button was disabled, which drops keyboard focus; hand it back.
      root()?.querySelector(`[data-ob="menu-${kind}"]`)?.focus({ preventScroll: true });
      // Whatever did or did not land, the banner should show the menu as it is.
      if (kind === "restore") loadMenuHealth({ fresh: true });
    }
  }

  function restoreMenu() {
    const health = state.menuHealth;
    const count = list(health?.missing).length;
    if (!count) return;
    const from = health?.baseline?.at ? ` from ${when(health.baseline.at)}` : "";
    if (
      !window.confirm(
        `Put the ${count} missing ${plural(count, "link", "links")} back in the Mega Menu?\n\nThe agent writes ${count === 1 ? "it" : "them"} into the live menu from its saved copy${from}.`
      )
    )
      return;
    return runMenuWrite("restore", `${API}/menu-health/restore`, (payload) => {
      const restored = list(payload.restored);
      const skipped = list(payload.skipped);
      if (payload.health) state.menuHealth = payload.health;
      state.menuNotice = {
        tone: skipped.length || !restored.length ? "warn" : "ok",
        title: restored.length
          ? `Put ${restored.length} ${plural(restored.length, "link", "links")} back in the Mega Menu.`
          : "Nothing was put back in the Mega Menu.",
        text: skipped.length ? `${skipped.length} ${plural(skipped.length, "link was", "links were")} skipped.` : "",
        restored,
        skipped
      };
    });
  }

  function acceptMenu() {
    const health = state.menuHealth;
    const count = list(health?.missing).length;
    const stores = Number(health?.storeCount) || 0;
    if (
      !window.confirm(
        `Keep the Mega Menu exactly as it is now, with ${stores} ${plural(stores, "store", "stores")} under Store?\n\nNothing changes in Shopify.${
          count ? ` The ${count} missing ${plural(count, "link stays", "links stay")} gone, and the` : " The"
        } agent checks against this menu from now on.`
      )
    )
      return;
    return runMenuWrite("accept", `${API}/menu-health/accept`, (payload) => {
      state.menuHealth = payload;
      const now = Number(payload.storeCount) || 0;
      state.menuNotice = payload.healthy
        ? {
            tone: "ok",
            title: "Saved. The menu as it is now is the one the agent checks against.",
            text: `Store has ${now} ${plural(now, "store", "stores")}.`
          }
        : {
            tone: "warn",
            title: "Saved, but the menu still does not look right to the agent.",
            text: payload.message || ""
          };
    });
  }

  /* =========================================================================
     LIST VIEW — the onboarding queue
     ====================================================================== */
  function renderList() {
    const node = root();
    if (!node) return;
    node.innerHTML = `
      <div class="ob-list" data-ob-page="list">
        ${menuHealthHtml()}
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
    listPage.addEventListener("change", onListChange);
    seedMenuSlots();
    loadMenuHealth();
    loadCapabilities();
    loadOnboardings();
  }

  function onListClick(event) {
    const action = event.target.closest("[data-ob]")?.dataset.ob;
    if (action === "new") openNewOnboarding();
    else if (action === "refresh-list") {
      loadMenuHealth();
      loadCapabilities();
      loadOnboardings();
    } else if (action === "retry-caps") loadCapabilities();
    else if (String(action || "").startsWith("menu-")) menuAction(action);
  }

  // The menu banner's "Recorded as" is the only field on the queue.
  function onListChange(event) {
    const operatorInput = event.target.closest("[data-ob-operator]");
    if (operatorInput) setOperator(operatorInput.value.trim());
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
      fillTodoChips(records);
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
            ${todoSlotHtml(summary)}
            <em class="ob-phase-chip">${esc(phaseLabel(summary?.phase))}</em>
          </span>
          <small>${esc(meta)}</small>
          ${progress}
        </span>
      </a>`;
  }

  /* ---- "Flow & Helium to do" ----------------------------------------------
     Flow and Helium are the two steps the agent can neither do nor fully
     check, and on 2026-10-13 both were ticked "to do later" and forgotten. A
     built store with either still open says so in the queue, in red, so a
     green "built" chip cannot pass for finished.

     The list summary carries each shared setting's status, and that is used
     as it is. Only a summary without it (a server from before it did) makes
     the queue read a built record's own page — only built ones, three at a
     time, and not again until the record changes. */
  const BUILT_STATUSES = ["built", "built-partial"];

  function flowHeliumTodo(sharedSettings) {
    const open = [
      { key: "flow", label: "Flow" },
      { key: "helium", label: "Helium" }
    ].filter((item) => !["confirmed", "verified"].includes(sharedSettings?.[item.key]?.status));
    return open.length ? `${open.map((item) => item.label).join(" & ")} to do` : "";
  }

  function todoChipHtml(todo) {
    const what = todo.replace(/ to do$/, "").replace("Flow", "Shopify Flow");
    return `<em class="status-chip" data-tone="danger" title="${esc(
      `${what} ${what.includes("&") ? "are" : "is"} not confirmed yet. The onboarding stays open until ${what.includes("&") ? "they are" : "it is"} — see its Finish step.`
    )}">${esc(todo)}</em>`;
  }

  function todoSlotHtml(summary) {
    if (!BUILT_STATUSES.includes(summary?.status)) return "";
    if (summary.sharedSettings) {
      const todo = flowHeliumTodo(summary.sharedSettings);
      return todo ? todoChipHtml(todo) : "";
    }
    const cached = state.todoCache.get(summary.id);
    if (cached && cached.updatedAt === summary.updatedAt) return cached.todo ? todoChipHtml(cached.todo) : "";
    return `<span data-ob-todo="${esc(summary.id || "")}" hidden></span>`;
  }

  async function fillTodoChips(records) {
    const queue = records.filter((summary) => {
      if (!BUILT_STATUSES.includes(summary?.status) || summary.sharedSettings || !summary.id) return false;
      const cached = state.todoCache.get(summary.id);
      return !(cached && cached.updatedAt === summary.updatedAt);
    });
    const worker = async () => {
      while (queue.length) {
        const summary = queue.shift();
        try {
          const payload = await api(recordPath(summary.id));
          const todo = flowHeliumTodo(payload?.onboarding?.sharedSettings);
          state.todoCache.set(summary.id, { updatedAt: summary.updatedAt, todo });
          if (!isCurrent("list")) return;
          const slot = [...(el("obListBody")?.querySelectorAll("[data-ob-todo]") || [])].find((node) => node.dataset.obTodo === summary.id);
          if (slot) slot.outerHTML = todo ? todoChipHtml(todo) : "";
        } catch {
          /* Left without a chip: the record's own Finish step says the same,
             and a queue that fails to load one record must still load. */
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  function phaseLabel(phase) {
    // The record's own phase vocabulary (server-side), not the wizard steps.
    return { packet: "Packet", setup: "Setup", inputs: "Products", build: "Build", report: "Report" }[phase] || "Packet";
  }

  /* ---------------------------------------------------------------------------
     New onboarding modal
     ------------------------------------------------------------------------ */
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
          <p class="hint">The files come next: the first step after this asks for the artwork, and the uniform policy if there is one.</p>
          ${banner("obNewError")}
          <div class="modal-actions">
            <button class="btn btn-ghost" type="button" data-ob="cancel-new">Cancel</button>
            <button class="btn btn-primary" type="submit" data-ob-submit><span class="btn-label">Create and continue</span></button>
          </div>
        </form>`
    });

    const form = overlay.querySelector("#obNewForm");
    const ordinal = overlay.querySelector("#obNewOrdinal");
    const storeNameField = overlay.querySelector("#obNewStoreNameField");

    ordinal.addEventListener("change", () => {
      storeNameField.hidden = Number(ordinal.value) <= 1;
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

  /* ---- Wizard state ---------------------------------------------------------
     Each step is "done" from the record alone, so a reload, a second operator,
     or a deploy mid-onboarding all land on the same step. The only client-side
     state is which step is on screen (state.step), and it can never be past
     the first step that is not done. */
  function hasFileKind(record, kind) {
    return list(record?.packet?.files).some((file) => (file?.kind || "other") === kind);
  }

  function codeLookedUp(record) {
    const code = record?.department?.code || {};
    return Boolean(code.approved || code.recommendation || list(code.candidates).length || list(code.matches).length);
  }

  function collectionExists(record) {
    return Boolean(record?.collection?.gid || record?.collection?.id);
  }

  function stepDone(record, key) {
    const buildState = record?.build?.state;
    switch (key) {
      case "packet":
        // The policy is optional: a department may send only its logos.
        return hasFileKind(record, "artwork") && codeLookedUp(record);
      case "code":
        return Boolean(record?.department?.code?.approved && record?.drive?.departmentFolderId);
      case "review":
        return Boolean(record?.policyReview?.reviewedAt);
      case "products":
        return buildBlockers(record).length === 0;
      case "build":
        /* Only a complete build. "partial" means a product failed (Pine
           Hollow's hat never reached Shopify) and Next still led on to
           Finish, which would put a half-built store in the Mega Menu. */
        return buildState === "complete" && collectionExists(record);
      case "finish":
        return record?.status === "complete";
      default:
        return false;
    }
  }

  // The first step that is not done: where the work is, and the furthest the
  // operator can go.
  function currentStepKey(record) {
    return (STEPS.find((step) => !stepDone(record, step.key)) || STEPS[STEPS.length - 1]).key;
  }

  function stepIndex(key) {
    return STEPS.findIndex((step) => step.key === key);
  }

  function viewedStepKey(record) {
    const reachable = stepIndex(currentStepKey(record));
    const viewed = stepIndex(state.step);
    if (viewed === -1 || viewed > reachable) state.step = STEPS[reachable].key;
    return state.step;
  }

  function goToStep(key) {
    state.step = key;
    renderDetail();
    // Instant: a smooth scroll did not move this page at all (see goto).
    window.scrollTo(0, 0);
    page()?.querySelector("[data-ob-step-title]")?.focus({ preventScroll: true });
  }

  function renderDetail() {
    const node = root();
    const record = state.record;
    if (!node || !record) return;
    const key = viewedStepKey(record);
    const index = stepIndex(key);
    const step = STEPS[index];
    node.innerHTML = `
      <div class="ob-detail" data-ob-page="detail" data-ob-id="${esc(record.id || "")}">
        <nav class="crumbs" aria-label="Breadcrumb">
          <a href="#/onboarding">Onboarding</a>
          <span aria-hidden="true">/</span>
          <span aria-current="page">${esc(record.department?.name || "Department")}</span>
        </nav>
        ${menuHealthHtml()}
        ${detailHeader(record)}
        ${stepperHtml(record)}
        <div class="ob-layout">
          <div class="ob-main">
            <section class="card card-pad ob-step-intro" data-ob-step="${esc(key)}">
              <p class="eyebrow">Step ${index + 1} of ${STEPS.length}</p>
              <h2 tabindex="-1" data-ob-step-title>${esc(step.title)}</h2>
              <p class="muted">${esc(step.what)}</p>
            </section>
            ${banner("obDetailError")}
            ${stepBodyHtml(record, key)}
            ${stepNavHtml(record, key)}
          </div>
          <aside class="ob-rail" aria-label="Log and links">
            ${linksCard(record)}
            ${logCard(record)}
          </aside>
        </div>
      </div>`;

    const detailPage = node.querySelector("[data-ob-page='detail']");
    detailPage.addEventListener("click", onDetailClick);
    detailPage.addEventListener("change", onDetailChange);
    wirePacketDropzones(detailPage);
    hydrateAssetImages(detailPage);
    seedMenuSlots();
    /* Finish is the one step that writes the menu, so the menu is read fresh
       from Shopify every time that step comes on screen — not on every
       repaint of it, which would re-read Shopify after each button. */
    const enteringFinish = key === "finish" && state.healthStep !== "finish";
    state.healthStep = key;
    if (enteringFinish) loadMenuHealth({ fresh: true });
    maybePoll();
  }

  function stepBodyHtml(record, key) {
    switch (key) {
      case "packet":
        return packetStepHtml(record);
      case "code":
        return codeCard(record);
      case "review":
        return setupPanel(record);
      case "products":
        return inputsPanel(record);
      case "build":
        return buildPanel(record);
      case "finish":
        return `${finishCard(record)}${sharedPanel(record)}`;
      default:
        return `${finishCard(record)}${reportPanel(record)}`;
    }
  }

  /* Back, and the one button that moves this step forward. Where the step's
     own panel already holds the action (approve the code, build the store,
     finish), "Next" only unlocks once the record says the step is done, and
     the hint says what is still in the way. */
  function stepNavHtml(record, key) {
    const index = stepIndex(key);
    const prev = STEPS[index - 1];
    const next = STEPS[index + 1];
    const done = stepDone(record, key);
    let forward = "";
    let hint = "";
    if (key === "packet") {
      const ready = hasFileKind(record, "artwork");
      forward = codeLookedUp(record)
        ? `<button class="btn btn-primary" type="button" data-ob="step" data-ob-step="code">Next: the department code</button>`
        : `<button class="btn btn-primary" type="button" data-ob="wizard-lookup" ${ready ? "" : "disabled"}>Continue — look up the code</button>`;
      if (!ready) hint = "Still needed: at least one artwork file.";
      else if (!hasFileKind(record, "policy")) hint = "No uniform policy — fine. The review then works from your notes and the artwork, and the rep email asks for the rest.";
    } else if (key === "products") {
      forward = `<button class="btn btn-primary" type="button" data-ob="wizard-save-products">Save and continue</button>`;
      hint = "Saving validates every row. You move on once they all pass.";
    } else if (key === "review") {
      forward = `<button class="btn btn-primary" type="button" data-ob="step" data-ob-step="products">Next: the products</button>`;
    } else if (next && key !== "finish") {
      forward = `<button class="btn ${done ? "btn-primary" : "btn-secondary"}" type="button" data-ob="step" data-ob-step="${esc(next.key)}" ${done ? "" : "disabled"}>Next: ${esc(next.label.toLowerCase())}</button>`;
      if (!done) {
        hint =
          key === "code"
            ? record.department?.code?.approved
              ? "The code is approved but the folders were not created. Run setup again from the code card."
              : "Approve a code above to continue."
            : key === "build"
              ? record.build?.state === "running" || record.build?.state === "starting"
                ? "The build is running. Next unlocks when it finishes."
                : record.build?.state === "partial"
                  ? `${plural(list(record.products).filter((p) => p?.buildState === "failed").length, "A product", "Some products")} failed (see the red step above). Fix the row on Products, then re-run the build.`
                  : "Build the store above. Next unlocks once every product is built."
              : "";
      }
    }
    return `
      <nav class="ob-step-nav" aria-label="Step navigation">
        ${prev ? `<button class="btn btn-ghost" type="button" data-ob="step" data-ob-step="${esc(prev.key)}">← Back: ${esc(prev.label.toLowerCase())}</button>` : "<span></span>"}
        <div class="ob-step-forward">
          ${hint ? `<span class="hint">${esc(hint)}</span>` : ""}
          ${forward}
        </div>
      </nav>`;
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
      </header>`;
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
    const reco = code.recommendation || null;
    return `
      <section class="card card-pad ob-panel ob-code-card" data-ob-panel="code" data-state="attention">
        <div class="card-head">
          <div>
            <p class="eyebrow">Needs Dan · department code</p>
            <h3>Approve the department code</h3>
            <p class="muted">Nothing is named, tagged, or built until the code is approved. Codes are usually three letters and never reuse another department's.</p>
          </div>
        </div>
        ${reco
          ? `<div class="gap-report ob-reco" data-tone="${reco.code ? "ok" : "warn"}">
              <p class="gap-title">${reco.code ? "The agent recommends" : "The agent needs you to choose"}</p>
              ${reco.code
                ? `<p class="ob-reco-pick"><b class="code-input">${esc(reco.code)}</b>${reco.name ? ` <span>as <b>${esc(reco.name)}</b></span>` : ""}</p>`
                : ""}
              <p class="gap-note">${esc(reco.summary.charAt(0).toUpperCase() + reco.summary.slice(1))}</p>
              ${reco.code
                ? `<button class="btn btn-primary btn-sm" type="button" data-ob="use-recommendation">${reco.name ? `Rename and approve ${esc(reco.code)}` : `Approve ${esc(reco.code)}`}</button>`
                : ""}
            </div>`
          : ""}
        ${matches.length
          ? `<div class="ob-subhead"><p class="field-label">On the Department Code List</p></div>
             <div class="ob-candidates">
               ${matches
                 .map((match) => {
                   /* A same-named agency in another state is a namesake, not
                      this department — never shown as the safe pick. */
                   const ownState = String(record.department?.state || "").toUpperCase();
                   const otherState = Boolean(match.state && ownState && String(match.state).toUpperCase() !== ownState);
                   return `
                 <button class="ob-candidate" type="button" data-ob="pick-code" data-ob-code="${esc(match.code || "")}" data-tone="${otherState ? "warn" : "ok"}" ${otherState ? `title="A different department in ${esc(match.state)}"` : ""}>
                   <b>${esc(match.code || "")}</b>
                   <small>${esc(match.agency || "")}${match.city ? ` · ${esc(match.city)}` : ""}${match.state ? ` · ${esc(match.state)}` : ""}${otherState ? " · other state" : ""}</small>
                 </button>`;
                 })
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

  /* ---- Finish -------------------------------------------------------------
     One place, at the top, that answers "what is left and can I be done?".

     Everything below this card is detail: six panels, a dozen buttons, three
     approval cards. An operator finishing a department should not have to
     assemble that into a plan. This asks the two questions only a human can
     answer, does everything the agent can do itself, and runs the final check.

     The two ticks are the weak spot. Flow has no API at all and only one of
     the three Helium forms can be read, so a tick IS the record — and on
     2026-10-13 both were ticked "to do it later" because ticking was the only
     way past this card. So the card says what each tick costs when it is not
     true, puts the steps right under each box, and has an honest way past:
     "Not yet", which records nothing for either.
     ------------------------------------------------------------------------ */
  const FINISH_ASKS = [
    {
      key: "flow",
      label: "Shopify Flow",
      short: "Flow",
      tick: "I added it in Shopify Flow",
      consequence: "If the tag is not in the Flow condition, new customers from this department get the wrong email."
    },
    {
      key: "helium",
      label: "Helium",
      short: "Helium",
      tick: "I added it to all three Helium forms",
      consequence: "If the department is not in Helium, members cannot pick it when they register, so the store's lock never opens for them."
    }
  ];

  const COUNT_WORDS = ["none", "one", "two", "three"];

  function sharedDone(settings, key) {
    return ["applied", "verified", "confirmed"].includes(settings?.[key]?.status);
  }

  /* How many of the three Helium forms the agent can read: the record's last
     check first, the capabilities strip second. With neither, the setup the
     store has today — one form configured. */
  function heliumReadable(record) {
    const forms = list(record?.sharedSettings?.helium?.forms);
    const source = forms.length ? forms : list(state.caps?.helium?.forms);
    if (!source.length) return 1;
    return Math.min(3, source.filter((form) => form && form.public !== false).length);
  }

  function heliumReach(record) {
    const readable = heliumReadable(record);
    if (readable >= 3) return "it reads the three Helium forms only when you finish";
    if (!readable) return "it cannot read any of the three Helium forms";
    return `it can only read ${COUNT_WORDS[readable]} of the three Helium forms`;
  }

  function asksLead(asks, record) {
    const flow = asks.some((item) => item.key === "flow");
    const helium = asks.some((item) => item.key === "helium");
    if (flow && helium) {
      return `Do these two in Shopify Flow and Helium before you tick them. Ticking records them as done — the agent cannot read Flow at all, and ${heliumReach(record)}.`;
    }
    if (flow) return "Do this in Shopify Flow before you tick it. Ticking records it as done — the agent cannot read Flow at all.";
    return `Do this in Helium before you tick it. Ticking records it as done — ${heliumReach(record)}.`;
  }

  /* The Helium forms the agent DID read and found without the tag (or with
     it spelled differently). Finishing reads them again and refuses, so
     saying it here first saves a round trip to a red banner. */
  function heliumLastReadHtml(record) {
    const tag = record.department?.tag || record.department?.name || "";
    const wrong = list(record.sharedSettings?.helium?.forms).filter(
      (form) => form && form.public !== false && !form.error && (!form.present || form.exactCase === false)
    );
    return wrong
      .map((form) => {
        const what = form.present ? `the tag was there but not exactly “${tag}” — capitals and spaces count` : "the tag was not there";
        return `<p class="ob-finish-read">When the agent last read the ${esc(form.label || form.id || "Helium")} form, ${esc(what)}. Finishing reads it again and stops if it is still not right.</p>`;
      })
      .join("");
  }

  /* Whether the Mega Menu must not be written from this screen, and the words
     for why. Either source is enough:
       • a read of the live menu says it looks wiped (the banner is up);
       • the record says the agent already refused ("blocked") and no read
         since has shown the menu whole again.
     A completed read that shows the menu whole clears a stale "blocked":
     the server checks again before it writes, and without this the card
     would stay shut after Dan had put the menu right. */
  function menuStop(record) {
    const health = state.menuHealth;
    if (menuLooksWiped(health)) {
      return { title: "The Mega Menu looks wiped — fix it with the banner at the top first.", detail: health.message || "" };
    }
    const menu = record?.sharedSettings?.megaMenu || {};
    if (menu.status !== "blocked") return null;
    if (health?.available && health.healthy && !state.menuHealthLoading) return null;
    return {
      title: "The agent stopped before touching the Mega Menu because it looked wiped.",
      detail: [
        menu.error,
        state.menuHealthLoading
          ? "Reading the live menu again now…"
          : "Finishing unlocks once a fresh read shows the menu whole again — put it right in Shopify, then press Refresh at the top."
      ]
        .filter(Boolean)
        .join(" ")
    };
  }

  /* Exactly what each finish button sends, in the order it sends it. The card
     builds its sentences from this list and finishOnboarding sends this list,
     so what a button says it does and what it does cannot drift apart.

     Helium goes first: it is the one request that can refuse (a form the
     agent can read does not carry the tag), and a refusal must stop the
     finish before anything else is recorded or written. The Mega Menu is
     the only real write and goes last before the check, and only when the
     scope allows it and the menu does not look wiped. */
  function finishSends(record, { later = false, by = "" } = {}) {
    const settings = record.sharedSettings || {};
    const steps = [];
    if (!later) {
      if (!sharedDone(settings, "helium")) {
        steps.push({
          kind: "helium",
          name: "Helium",
          busy: "Checking Helium…",
          suffix: "/shared-settings/helium/approve",
          body: { by, applied: true },
          says: heliumReadable(record) ? "checks the Helium form the agent can read and records Helium as done" : "records Helium as done"
        });
      }
      if (!sharedDone(settings, "flow")) {
        steps.push({
          kind: "flow",
          name: "Shopify Flow",
          busy: "Recording Flow…",
          suffix: "/shared-settings/flow/approve",
          body: { by, applied: true },
          says: "records Shopify Flow as done"
        });
      }
    }
    /* applied:true means "a human already made this change" — the server
       stamps it done and calls nothing. That was right while the app had no
       navigation scope and the menu could only be edited by hand; with the
       scope granted it would record a menu item that was never created. The
       card promises "adds the store to the Mega Menu", so send applied:false
       and let the server actually insert it — or refuse, "blocked", when the
       menu looks wiped by the time it reads it. */
    if (!sharedDone(settings, "megaMenu") && state.caps?.megaMenu?.writable && !menuStop(record)) {
      steps.push({
        kind: "megaMenu",
        name: "the Mega Menu",
        busy: "Adding to the Mega Menu…",
        suffix: "/shared-settings/megaMenu/approve",
        body: { by, applied: false },
        says: "adds the store to the Mega Menu"
      });
    }
    steps.push({ kind: "check", name: "the final check", busy: "Checking everything…", suffix: "/final-check", body: { by }, says: "runs the final check" });
    return steps;
  }

  function sendsSentence(steps) {
    const says = steps.map((step) => step.says);
    return says.length > 1 ? `${says.slice(0, -1).join(", ")}, then ${says[says.length - 1]}` : says[0] || "";
  }

  function finishCard(record) {
    const settings = record.sharedSettings || {};
    const done = (key) => sharedDone(settings, key);
    const menuWritable = Boolean(state.caps?.megaMenu?.writable);
    const complete = record.status === "complete";

    if (complete) {
      return `
      <section class="card card-pad ob-finish" data-tone="ok">
        <p class="eyebrow">Finished</p>
        <h3>Everything the agent can check is done.</h3>
        <p class="muted">What is left is yours, in Shopify: set prices and cost, add Easify options, then set the products Active. Nothing is visible to a customer until you do.</p>
        ${record.collection?.url ? `<a class="btn btn-secondary btn-sm" href="${esc(record.collection.url)}" target="_blank" rel="noreferrer">Open the collection in Shopify</a>` : ""}
      </section>`;
    }

    // What only a person can do, because these have no write API at all.
    const asks = FINISH_ASKS.filter((item) => !done(item.key));
    const stop = menuStop(record);
    const yes = finishSends(record);
    const notYet = finishSends(record, { later: true });
    const tag = record.department?.tag || record.department?.name || "";

    /* report.unresolved is everything that kept the last final check from
       passing; missingInformation is only the part of it the classifier
       labelled "missing", so it is the fallback for reports written before
       unresolved was recorded. Menu/Flow/Helium are left out because pressing
       finish handles those itself. */
    const reported = Array.isArray(record.report?.unresolved) ? record.report.unresolved : list(record.report?.missingInformation);
    const blockers = reported.filter((m) => !/Mega Menu|Shopify Flow|Helium/i.test(m));
    const heading = asks.length
      ? `${asks.length === 1 ? "One thing" : "Two things"} only you can do`
      : blockers.length
        ? `${blockers.length === 1 ? "One thing is" : `${blockers.length} things are`} still open`
        : "Nothing left for you outside the console";

    /* The card's own word on the menu read it is about to rely on — only
       while finishing would write the menu. Once the item is in, or when the
       menu is a hand job anyway, the read is not this card's business. */
    const menuPending = !done("megaMenu") && menuWritable && !stop;
    const menuCheck = !menuPending
      ? ""
      : state.menuHealthLoading
        ? `<p class="hint ob-finish-why">Checking the live Mega Menu…</p>`
        : state.menuHealthError
          ? `<p class="hint ob-finish-why" data-tone="warn">Could not check the Mega Menu just now (${esc(state.menuHealthError.replace(/\.$/, ""))}). The agent reads it again before it writes, and does not write into a menu that looks wiped.</p>`
          : "";
    const why = stop ? stop.title : asks.length ? `“Yes — finish” unlocks once you tick ${asks.length === 2 ? "both boxes" : "the box"} above.` : "";
    const heliumStops = yes.some((step) => step.kind === "helium") && heliumReadable(record) > 0;

    return `
      <section class="card card-pad ob-finish" data-tone="${stop ? "danger" : asks.length || blockers.length ? "warn" : "ok"}" data-ob-finish-card>
        <p class="eyebrow">Ready to finish?</p>
        <h3>${esc(heading)}</h3>
        ${asks.length
          ? `<div class="ob-finish-danger">
               <p><b>${esc(asksLead(asks, record))}</b></p>
               <ul>${asks.map((item) => `<li><b>${esc(item.label)}:</b> ${esc(item.consequence)}</li>`).join("")}</ul>
               ${tag ? `<button class="btn btn-ghost btn-sm ob-btn-wrap" type="button" data-ob="copy" data-ob-copy-text="${esc(tag)}">Copy the tag “${esc(tag)}”</button>` : ""}
             </div>`
          : ""}
        ${stop
          ? `<div class="ob-finish-danger">
               <p><b>${esc(stop.title)}</b></p>
               ${stop.detail ? `<p>${esc(stop.detail)}</p>` : ""}
             </div>`
          : ""}
        ${asks.length
          ? `<ul class="ob-finish-asks">${asks
              .map((item) => {
                const steps = list(settings[item.key]?.checklist);
                return `<li>
                  <label>
                    <input type="checkbox" data-ob-finish-ask="${esc(item.key)}" aria-describedby="obFinishSteps-${esc(item.key)}">
                    <span><b>${esc(item.tick)}</b></span>
                  </label>
                  <div class="ob-finish-steps" id="obFinishSteps-${esc(item.key)}">
                    ${steps.length
                      ? `<ol class="ob-checklist">${steps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol>`
                      : `<p class="hint">No steps yet. Press “Compute proposals” in the shared settings below to get them.</p>`}
                    ${item.key === "helium" ? heliumLastReadHtml(record) : ""}
                  </div>
                </li>`;
              })
              .join("")}</ul>`
          : `<p class="muted">Flow and Helium are already recorded.</p>`}
        ${blockers.length
          ? `<div class="ob-finish-blockers"><p><b>The last final check found:</b></p><ul>${blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
              <p class="hint">Fix ${blockers.length === 1 ? "it" : "these"} in Shopify or on the earlier steps, then press finish again — it re-checks everything.</p></div>`
          : ""}
        ${menuCheck}
        <p class="muted"><b>Yes — finish</b> ${esc(sendsSentence(yes))}.${heliumStops ? " If that Helium form does not carry the tag, it stops there and sends nothing else." : ""}</p>
        ${asks.length
          ? `<p class="muted"><b>Not yet</b> ${esc(sendsSentence(notYet))}. Nothing is recorded for ${esc(asks.map((item) => item.label).join(" or "))}, so the onboarding stays open.</p>`
          : ""}
        <div class="field ob-operator">
          <label for="obRailOperator">Recorded as</label>
          <input id="obRailOperator" type="text" value="${esc(operator())}" placeholder="Dan" autocomplete="off" data-ob-operator>
        </div>
        <div class="ob-finish-actions">
          <button class="btn btn-primary ob-btn-wrap" type="button" data-ob="finish" ${asks.length || stop ? "disabled" : ""} ${why ? 'aria-describedby="obFinishWhy"' : ""}>Yes — finish this onboarding</button>
          ${asks.length
            ? `<button class="btn btn-secondary ob-btn-wrap" type="button" data-ob="finish-later" ${stop ? 'disabled aria-describedby="obFinishWhy"' : ""}>Not yet — ${
                notYet.some((step) => step.kind === "megaMenu") ? "save the menu" : "run the final check"
              } and finish ${esc(asks.map((item) => item.short).join(" & "))} later</button>`
            : ""}
        </div>
        ${why ? `<p class="hint ob-finish-why" id="obFinishWhy" ${stop ? 'data-tone="danger"' : ""}>${esc(why)}</p>` : ""}
        ${!menuWritable && !done("megaMenu") ? `<p class="hint ob-finish-why" data-tone="warn">The Mega Menu has to be edited by hand — no navigation scope.</p>` : ""}
      </section>`;
  }

  /* The finish buttons' enabled state, from the ticks and the menu. One
     function, called after a tick, after a menu read and after a finish, so
     no path can leave "Yes" clickable with a box unticked or the menu wiped. */
  function syncFinishControls(scope) {
    const card = scope?.querySelector("[data-ob-finish-card]");
    if (!card || !state.record || state.finishing) return;
    const stop = Boolean(menuStop(state.record));
    const boxes = [...card.querySelectorAll("[data-ob-finish-ask]")];
    boxes.forEach((box) => {
      box.disabled = false;
    });
    const ticked = boxes.every((box) => box.checked);
    const finish = card.querySelector("[data-ob='finish']");
    const later = card.querySelector("[data-ob='finish-later']");
    if (finish) finish.disabled = stop || !ticked;
    if (later) later.disabled = stop;
    // "Unlocks once you tick…" is done saying anything once both are ticked.
    const why = card.querySelector("#obFinishWhy");
    if (why) why.hidden = !stop && ticked;
  }

  // While a finish runs, nothing else in the card can be pressed or ticked.
  function lockFinishCard(scope) {
    scope
      ?.querySelector("[data-ob-finish-card]")
      ?.querySelectorAll("[data-ob='finish'], [data-ob='finish-later'], [data-ob-finish-ask]")
      .forEach((node) => {
        node.disabled = true;
      });
  }

  function focusSelector(node) {
    if (!node) return "";
    if (node.id) return `#${node.id}`;
    if (node.dataset?.obFinishAsk) return `[data-ob-finish-ask="${node.dataset.obFinishAsk}"]`;
    if (node.dataset?.ob) return `[data-ob="${node.dataset.ob}"]`;
    return "";
  }

  /* The finish card and the Mega Menu card both read the menu's health, so a
     read that lands swaps them in place, keeping the ticks, the name being
     typed and focus. Never while a finish runs: its busy button must not be
     replaced by a fresh, clickable one. */
  function repaintMenuDependents() {
    const scope = page();
    if (!scope || !state.record || state.finishing) return;
    const card = scope.querySelector("[data-ob-finish-card]");
    if (card) {
      const ticked = new Set([...card.querySelectorAll("[data-ob-finish-ask]:checked")].map((box) => box.dataset.obFinishAsk));
      const typed = card.querySelector("#obRailOperator")?.value;
      const focusKey = card.contains(document.activeElement) ? focusSelector(document.activeElement) : "";
      card.outerHTML = finishCard(state.record);
      const next = scope.querySelector("[data-ob-finish-card]");
      next?.querySelectorAll("[data-ob-finish-ask]").forEach((box) => {
        box.checked = ticked.has(box.dataset.obFinishAsk);
      });
      const input = next?.querySelector("#obRailOperator");
      if (input && typed !== undefined) input.value = typed;
      syncFinishControls(scope);
      if (focusKey) next?.querySelector(focusKey)?.focus({ preventScroll: true });
    }
    const menuCard = scope.querySelector("[data-ob-shared='megaMenu']");
    if (menuCard && !menuCard.querySelector("[data-ob-busy]")) {
      menuCard.outerHTML = sharedCardHtml(state.record, SHARED_KINDS.find((kind) => kind.key === "megaMenu"));
    }
  }

  /* Every step is a button. Steps up to the first unfinished one can be
     revisited; the ones after it are disabled, because there is nothing on
     them yet that can be done. */
  function stepperHtml(record) {
    const viewed = stepIndex(viewedStepKey(record));
    const reachable = stepIndex(currentStepKey(record));
    return `
      <ol class="wizard-rail ob-stepper" data-ob-stepper aria-label="Onboarding steps">
        ${STEPS.map((step, i) => {
          const done = step.key === "done" ? record.status === "complete" : stepDone(record, step.key);
          const stepState = i === viewed ? "current" : done ? "done" : "todo";
          return `
          <li data-state="${stepState}">
            <button type="button" data-ob="step" data-ob-step="${esc(step.key)}" ${i === viewed ? 'aria-current="step"' : ""} ${i > reachable ? "disabled" : ""}>
              <span class="wr-num" aria-hidden="true">${stepState === "done" ? "" : i + 1}</span>
              <span class="wr-label">${esc(step.label)}</span>
            </button>
          </li>`;
        }).join("")}
      </ol>`;
  }

  /* ---- Step 1: packet ------------------------------------------------------
     One drop zone per kind of file, so the policy and the artwork cannot be
     missed and never land under the wrong kind. Each upload is sent the
     moment it is picked or dropped. */
  const PACKET_SLOTS = [
    { kind: "policy", label: "Uniform policy", required: false, hint: "PDF, Word, or text, if the department sent one. Read for garments, colours, decoration and placement.", accept: ".pdf,.doc,.docx,.txt" },
    { kind: "artwork", label: "Artwork", required: true, hint: "Logos as images. They become the mockups and the collection banner.", accept: "image/*" },
    { kind: "contacts", label: "Contact list", required: false, hint: "The roster or contact sheet, if the department sent one.", accept: ".pdf,.doc,.docx,.txt,.csv,.xlsx" },
    { kind: "other", label: "Anything else", required: false, hint: "Other files that came with the packet." }
  ];

  function packetStepHtml(record) {
    const files = list(record.packet?.files);
    return `
      <section class="card card-pad ob-panel" id="obPanel-packet" data-ob-panel="packet">
        <div class="ob-packet-slots">
          ${PACKET_SLOTS.map((slot) => {
            const mine = files.filter((file) => (file?.kind || "other") === slot.kind);
            const zone = `obPacket-${slot.kind}`;
            return `
            <div class="ob-packet-slot" data-done="${mine.length ? "true" : "false"}">
              <div class="ob-packet-slot-head">
                <p class="field-label"><label for="${esc(zone)}">${esc(slot.label)}</label> ${slot.required ? `<span class="req" aria-hidden="true">*</span>` : `<small>optional</small>`}</p>
                ${mine.length ? chip(`${mine.length} uploaded`, "ok") : slot.required ? chip("required", "warn") : ""}
              </div>
              ${mine.length ? `<div class="ob-files">${mine.map((file) => packetFileHtml(record, file)).join("")}</div>` : ""}
              <div class="dropzone" data-dropzone="${esc(zone)}">
                <input id="${esc(zone)}" type="file" multiple ${slot.accept ? `accept="${esc(slot.accept)}"` : ""} data-ob-packet-kind="${esc(slot.kind)}" aria-describedby="${esc(zone)}Hint">
                <span class="dz-title"><b>${mine.length ? "Add more" : "Click to upload"}</b> or drag &amp; drop</span>
                <span class="dz-sub" id="${esc(zone)}Hint">${esc(slot.hint)}</span>
              </div>
            </div>`;
          }).join("")}
        </div>
        <div class="field ob-notes">
          <label for="obPacketNotes">Packet notes</label>
          <textarea id="obPacketNotes" rows="3" data-ob-field="packetNotes">${esc(record.packet?.notes || "")}</textarea>
          <p class="hint">Shown to the model when it reviews the policy.</p>
        </div>
        <div class="ob-panel-actions">
          <button class="btn btn-secondary btn-sm" type="button" data-ob="save-notes">Save notes</button>
        </div>
      </section>`;
  }

  // main.js's wireDropzone handles drag-and-drop and the picker alike; the
  // callback uploads straight away, so there is no separate "send" button.
  function wirePacketDropzones(scope) {
    scope.querySelectorAll("input[data-ob-packet-kind]").forEach((input) => {
      const zone = input.closest(".dropzone")?.dataset.dropzone;
      if (!zone) return;
      wireDropzone(zone, input, () => uploadFiles(input, input.dataset.obPacketKind), () => true);
    });
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
            <p class="eyebrow">Drive and policy review</p>
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
        ${reviewed ? policyReviewHtml(review, record) : stateBlock({ title: "The policy has not been reviewed yet", sub: "Run setup once the code is approved: the agent reads the policy, lists what is confirmed and what is missing, and drafts the rep email." })}
      </section>`;
  }

  function policyReviewHtml(review, record) {
    const confirmed = list(review.confirmed);
    const missing = list(review.missing);
    const questions = list(review.questions);
    const draft = review.emailDraft || {};
    /* Who the email goes to. The draft greets the first contact, so that is
       the recipient; when the first contact has no address, the first one
       that does. Without this Dan had to go find the address before he could
       send the draft. */
    const contacts = list(record?.department?.contacts);
    const to = contacts[0]?.email ? contacts[0] : contacts.find((c) => c?.email) || null;
    /* Gmail's compose window, filled in. Dan still reads it and presses Send
       himself — the agent never sends anything. */
    const gmailUrl = to?.email
      ? `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to.email)}&su=${encodeURIComponent(draft.subject || "")}&body=${encodeURIComponent(draft.body || "")}`
      : "";
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
                  <p class="email-subject"><b>To:</b> ${to?.email
                    ? `${to.name ? `${esc(to.name)} ` : ""}&lt;<a href="mailto:${esc(to.email)}">${esc(to.email)}</a>&gt;`
                    : `<span data-tone="warn">no email on file for the department contact</span>`}</p>
                  <p class="email-subject"><b>Subject:</b> ${esc(draft.subject || "")}</p>
                </div>
                <div class="email-actions">
                  ${gmailUrl ? `<a class="btn btn-secondary btn-sm" href="${esc(gmailUrl)}" target="_blank" rel="noreferrer">Open in Gmail</a>` : ""}
                  ${to?.email ? `<button class="btn btn-secondary btn-sm" type="button" data-ob="copy" data-ob-copy-text="${esc(to.email)}">Copy address</button>` : ""}
                  <button class="btn btn-secondary btn-sm" type="button" data-ob="copy" data-ob-copy-target="obEmailBody">Copy text</button>
                  ${review.driveDocUrl ? `<a class="btn btn-secondary btn-sm" href="${esc(review.driveDocUrl)}" target="_blank" rel="noreferrer">Open in Drive</a>` : ""}
                </div>
              </div>
              <textarea class="email-body" id="obEmailBody" rows="10" readonly aria-label="Draft email body">${esc(draft.body || "")}</textarea>
              <p class="hint">${gmailUrl ? "“Open in Gmail” fills in the address, subject and text — read it and press Send yourself. " : ""}The agent never emails the department.</p>
            </div>`
          : ""}
      </div>`;
  }

  /* ---- Build inputs -------------------------------------------------------- */
  // A suggestion is "already in the list" when a row has the same style
  // (the review may say "112 snapback" for the store's R112).
  function styleKey(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
  function suggestionInList(products, suggestion, index = -1) {
    const want = styleKey(suggestion?.styleNumber);
    // "112 snapback" is the store's R112; "K500" is never "L500".
    const digits = /^[0-9]/.test(want) ? want.match(/^[0-9]+/)[0] : "";
    return list(products).some((p) => {
      if (index >= 0 && p?.fromSuggestion === index) return true;
      const have = styleKey(p?.styleNumber);
      if (!have) return false;
      return (want && have === want) || (digits && have.replace(/^[A-Z]+/, "") === digits);
    });
  }

  function inputsPanel(record) {
    const products = list(record.products);
    const suggested = list(record.policyReview?.suggestedProducts);
    const missing = suggested.map((s, index) => ({ s, index })).filter(({ s, index }) => !suggestionInList(products, s, index));
    return `
      <section class="card card-pad ob-panel" id="obPanel-inputs" data-ob-panel="inputs">
        <div class="card-head">
          <div>
            <p class="eyebrow">Product list</p>
            <h3>The product list</h3>
            <p class="muted">One row per product. Pick the garment, tick where the logos go and which logo, then save. Remove a row with ×.</p>
          </div>
          <div class="ob-head-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-ob="add-product">+ Add product</button>
            <button class="btn btn-secondary btn-sm" type="button" data-ob="save-products">Save</button>
          </div>
        </div>
        ${missing.length
          ? `<div class="gap-report ob-suggestions" data-tone="ok">
              <p class="gap-title">${missing.length} product${plural(missing.length, "", "s")} suggested from the policy${products.length ? " and not in the list yet" : ""}</p>
              <p class="gap-note">Add the ones the department wants; check each against what the rep confirmed.</p>
              <ul class="ob-suggestion-list">
                ${missing
                  .map(
                    ({ s, index }) => `<li><span><b>${esc([s.brand, s.styleNumber].filter(Boolean).join(" ") || s.type || "Product")}</b> ${esc(s.type || "")}${list(s.colors).length ? ` · ${esc(list(s.colors).join(", "))}` : ""}${s.decorationCodes ? ` · ${esc(s.decorationCodes)}` : ""}</span>
                      <button class="btn btn-ghost btn-sm" type="button" data-ob="use-suggestions" data-ob-suggestion="${index}">Add</button></li>`
                  )
                  .join("")}
              </ul>
              ${missing.length > 1 ? `<button class="btn btn-secondary btn-sm" type="button" data-ob="use-suggestions">Add all ${missing.length}</button>` : ""}
            </div>`
          : ""}
        ${products.length
          ? `<div class="ob-products">${products.map((product, index) => productRowHtml(record, product, index)).join("")}</div>`
          : stateBlock({ title: "No products yet", sub: "Add the suggested products above, or press + Add product and pick a garment the store sells." })}
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
            ${redoButtonHtml(product)}
          </span>
          <button class="variant-remove" type="button" data-ob="remove-product" aria-label="Remove product ${index + 1}">&times;</button>
        </div>
        <div class="category-edit-grid">
          ${garmentPickerHtml(product)}
          <label><span>Brand</span><input type="text" data-ob-field="brand" value="${esc(product?.brand || "")}" placeholder="e.g. Next Level"></label>
          <label><span>Style number</span><input type="text" data-ob-field="styleNumber" class="code-input" value="${esc(product?.styleNumber || "")}" placeholder="e.g. NL3600"></label>
          <label><span>Product type</span><input type="text" data-ob-field="type" value="${esc(product?.type || "")}" placeholder="e.g. T-shirt, Hat, Hoodie"></label>
          <label><span>Product title <small class="muted-inline">(optional)</small></span><input type="text" data-ob-field="title" value="${esc(product?.title || "")}" placeholder="Filled on save from the store's name for this blank"></label>
          <label class="span-2"><span>Colours</span><input type="text" data-ob-field="colors" value="${esc(csv(product?.colors))}" placeholder="e.g. Navy"></label>
          <label class="span-2"><span>Sizes</span><input type="text" data-ob-field="sizes" value="${esc(csv(product?.sizes))}" placeholder="e.g. S, M, L, XL, 2XL"></label>
          <label><span>Decoration method</span><select data-ob-field="decorationMethod">${optionsHtml(DECORATION_METHODS, product?.decorationMethod)}</select></label>
          <label><span>Decoration codes <small class="muted-inline">(filled from the placements below)</small></span><input type="text" data-ob-field="decorationCodes" class="code-input" value="${esc(product?.decorationCodes || "")}" placeholder="e.g. F01/B01"></label>
          <label><span>Fulfillment (Vendor field)</span><select data-ob-field="fulfillment">${optionsHtml([{ key: "", label: "—" }, ...FULFILLMENTS.map((v) => ({ key: v, label: v }))], product?.fulfillment)}</select></label>
          <label class="toggle-field"><input type="checkbox" data-ob-field="classB" ${product?.classB ? "checked" : ""}> <span>Class B uniform item</span></label>
          <label class="span-2"><span>Notes</span><input type="text" data-ob-field="notes" value="${esc(product?.notes || "")}"></label>
        </div>
        ${storeProfileHtml(record, product)}
        ${placementsHtml(record, product)}
        <div class="ob-size-presets"><span class="hint">Sizes:</span>${SIZE_PRESETS.map((preset) => `<button type="button" class="ob-color-chip" data-ob="size-preset" data-ob-sizes="${esc(preset.sizes)}" ${preset.add ? "data-ob-add=\"true\"" : ""}>${esc(preset.label)}</button>`).join("")}<span class="hint">${esc(SIZE_HINT)}</span></div>
        ${logosHtml(record, product, saved)}
        ${otherLogosHtml(record, product)}
        ${blankPhotoHtml(record, product, saved)}
        ${colorIssuesHtml(product)}
        ${validationHtml(validation)}
      </fieldset>`;
  }

  /* ---- Another logo on this garment ------------------------------------------
     The same blank, the same spot, a different logo — sold as ONE product
     whose "Style" option picks the logo, not as a second product. Style 1 is
     the row as set up under "Where the logos go"; each other logo here is the
     next Style. The save works out the codes (F01 → F02), the SKUs and which
     logo each Style's mockups use (rules.logoStyles on the server). */
  const OTHER_LOGO_SOURCE = "other-logo";
  const OTHER_LOGO_FIRST_HTML = `<p class="ob-other-logo-first"><span class="ob-style-name">Style 1</span> <span>the logos ticked above</span></p>`;

  // Styles typed as codes by hand, before this existed. Kept as they are.
  function typedStyles(product) {
    return list(product?.styles).filter((st) => st?.source !== OTHER_LOGO_SOURCE && String(st?.decorationCodes || "").trim());
  }

  function otherLogosHtml(record, product) {
    const typed = typedStyles(product);
    if (typed.length) {
      return `
        <div class="ob-styles">
          <p class="field-label">Styles <small>typed as decoration codes, one row per Style</small></p>
          <div class="ob-style-list" data-ob-style-list>
            ${typed.map((style, styleIndex) => styleRowHtml(style, styleIndex)).join("")}
          </div>
          <button class="btn btn-ghost btn-sm" type="button" data-ob="add-style">+ Add a Style by codes</button>
          <p class="hint">Remove these Styles to use “+ Add another logo” instead.</p>
        </div>`;
    }
    const logos = packetLogos(record);
    const { on } = placementState(product);
    const spots = PLACEMENTS.filter((p) => on[p.key]);
    const others = list(product?.otherLogos);
    const why = otherLogoWhy(spots.length, logos.length, 0);
    return `
      <div class="ob-styles ob-other-logos" data-ob-other-logos>
        <p class="field-label">Another logo on this garment <small>optional · same garment, same spot, a different logo</small></p>
        <p class="hint">It stays one product in Shopify: shoppers pick the logo with a “Style” option. Style 1 is the logos ticked above; each logo added here is the next Style, in the same spot.</p>
        <div class="ob-other-logo-list" data-ob-other-logo-list>
          ${others.length ? OTHER_LOGO_FIRST_HTML : ""}
          ${others.map((other, index) => otherLogoRowHtml(logos, spots, other, index)).join("")}
        </div>
        <button class="btn btn-ghost btn-sm" type="button" data-ob="add-other-logo" ${!spots.length || logos.length < 2 ? "disabled" : ""}>+ Add another logo</button>
        <p class="hint" data-ob-other-logo-why ${why ? "" : "hidden"}>${esc(why)}</p>
      </div>`;
  }

  /* A spot that was picked and then unticked above stays picked, saying so,
     rather than the logo quietly moving to another spot; the save then says
     what to fix. */
  function spotOptionsHtml(spots, selected) {
    const ticked = spots.some((p) => p.key === selected);
    const lost = !ticked ? PLACEMENTS.find((p) => p.key === selected) : null;
    const pick = ticked || lost ? selected : (spots.find((p) => p.key === "F") || spots[0])?.key;
    return [
      lost ? `<option value="${esc(lost.key)}" selected>on the ${esc(lost.label.toLowerCase())}: tick it above</option>` : "",
      ...spots.map((p) => `<option value="${esc(p.key)}" ${p.key === pick ? "selected" : ""}>on the ${esc(p.label.toLowerCase())}</option>`)
    ].join("");
  }

  function otherLogoRowHtml(logos, spots, other, index) {
    const n = index + 2;
    return `
      <div class="ob-style ob-other-logo" data-ob-other-logo>
        <span class="ob-style-name">Style ${n}</span>
        <select data-ob-other-logo-file aria-label="Logo for Style ${n}">
          <option value="">Pick the other logo…</option>
          ${logos
            .map((f) => `<option value="${esc(f.assetId)}" ${other?.logo === f.assetId ? "selected" : ""}>${esc(f.name || "logo")}${f.role ? ` (${esc(f.role)} logo)` : ""}</option>`)
            .join("")}
        </select>
        <select data-ob-other-logo-spot aria-label="Where the Style ${n} logo goes">${spotOptionsHtml(spots, other?.spot || "")}</select>
        <button class="variant-remove" type="button" data-ob="remove-other-logo" aria-label="Remove Style ${n}">&times;</button>
      </div>`;
  }

  /* The spots offered follow the ticks above, and the button says why it is
     off instead of adding a Style that cannot be built. */
  function refreshOtherLogos(row) {
    const box = row?.querySelector("[data-ob-other-logos]");
    if (!box) return;
    const spots = PLACEMENTS.filter((p) => row.querySelector(`[data-ob-place='${p.key}'] [data-ob-place-on]`)?.checked);
    const logos = packetLogos(state.record);
    const rows = [...box.querySelectorAll("[data-ob-other-logo]")];
    rows.forEach((node, index) => {
      const n = index + 2;
      const name = node.querySelector(".ob-style-name");
      if (name) name.textContent = `Style ${n}`;
      node.querySelector("[data-ob-other-logo-file]")?.setAttribute("aria-label", `Logo for Style ${n}`);
      const spot = node.querySelector("[data-ob-other-logo-spot]");
      if (spot) {
        spot.setAttribute("aria-label", `Where the Style ${n} logo goes`);
        spot.innerHTML = spotOptionsHtml(spots, spot.value);
      }
      node.querySelector("[data-ob='remove-other-logo']")?.setAttribute("aria-label", `Remove Style ${n}`);
    });
    const holder = box.querySelector("[data-ob-other-logo-list]");
    const first = holder?.querySelector(".ob-other-logo-first");
    if (rows.length && !first) holder?.insertAdjacentHTML("afterbegin", OTHER_LOGO_FIRST_HTML);
    if (!rows.length && first) first.remove();
    const button = box.querySelector("[data-ob='add-other-logo']");
    if (button) button.disabled = !spots.length || logos.length < 2;
    const hint = box.querySelector("[data-ob-other-logo-why]");
    if (hint) {
      hint.textContent = otherLogoWhy(spots.length, logos.length, rows.length);
      hint.hidden = !hint.textContent;
    }
  }

  function otherLogoWhy(spots, logos, rows) {
    if (!spots) return "Tick where the logo goes above first. The other logo goes in the same spot.";
    if (logos < 2) return "Only one logo is uploaded. Add the department’s other logo in step 1 (Packet) first.";
    return rows ? "Press Save to update the SKUs and the Style option." : "";
  }

  function styleRowHtml(style, index) {
    return `
      <div class="ob-style" data-ob-style>
        <span class="ob-style-name">Style ${index + 1}</span>
        <input type="text" class="code-input" data-ob-field="styleCodes" value="${esc(style?.decorationCodes || "")}" placeholder="e.g. F02/B01" aria-label="Decoration codes for Style ${index + 1}">
        <button class="variant-remove" type="button" data-ob="remove-style" aria-label="Remove Style ${index + 1}">&times;</button>
      </div>`;
  }

  /* ---- Making a product the easy way ----------------------------------------
     Pick a garment the store already sells, tick where the logos go, and pick
     which uploaded logo goes there. The decoration codes and the logo for each
     code are worked out from that — nobody has to know that a full-back print
     is "B01" or which file name it needs. The raw fields stay underneath for
     the unusual cases. */
  const PLACEMENTS = [
    { key: "F", label: "Front", hint: "left chest or front panel" },
    { key: "B", label: "Back", hint: "full back" },
    { key: "RS", label: "Right sleeve", hint: "" },
    { key: "LS", label: "Left sleeve", hint: "" }
  ];

  function garmentPickerHtml(product) {
    const garments = list(state.garments);
    // Without the store's garment list (still loading, or it failed) the
    // lookup and "Create the master" must still be there.
    if (!garments.length) return lookupHtml(product, { open: true });
    const current = String(product?.styleNumber || "").toUpperCase();
    const known = garments.some((g) => g.styleNumber === current);
    const groups = [...new Set(garments.map((g) => g.group || "Other"))];
    return `
      <label class="span-2 ob-garment-pick"><span>Garment <small class="muted-inline">the store's own blanks — fills brand, style, type and sizes</small></span>
        <select data-ob-garment>
          <option value="">${current && !known ? `${esc(current)} — not one of the store's masters` : "Pick a garment the store sells…"}</option>
          <option value="__lookup">+ Look up another garment (any brand or style)…</option>
          ${groups
            .map(
              (group) => `<optgroup label="${esc(group)}">${garments
                .filter((g) => (g.group || "Other") === group)
                .map((g) => `<option value="${esc(g.styleNumber)}" ${g.styleNumber === current ? "selected" : ""}>${esc(g.label)} · ${esc(g.styleNumber)}</option>`)
                .join("")}</optgroup>`
            )
            .join("")}
        </select>
      </label>
      ${lookupHtml(product)}`;
  }

  /* Any garment, not only the store's masters: type what the department
     asked for, the agent looks it up on the manufacturer's or a
     distributor's site and fills the row. Colours come back as chips to
     click. A style the store has never sold gets "Create the master". */
  function lookupHtml(product, { open: forceOpen = false } = {}) {
    const style = String(product?.styleNumber || "").toUpperCase();
    const open = forceOpen || (Boolean(style) && !list(state.garments).some((g) => g.styleNumber === style));
    return `
      <div class="ob-lookup" data-ob-lookup ${open || product?.masterMissing ? "" : "hidden"}>
        <div class="ob-lookup-bar">
          <input type="text" data-ob-lookup-query placeholder="Type any brand and style — e.g. Independent SS4500, Carhartt K87 pocket tee" aria-label="Look up a garment">
          <button class="btn btn-secondary btn-sm" type="button" data-ob="lookup-garment">Look up</button>
        </div>
        <div data-ob-lookup-result>${product?.masterMissing ? masterMissingHtml(product.styleNumber) : ""}</div>
      </div>`;
  }

  function masterMissingHtml(styleNumber) {
    return `<div class="ob-master-missing">
        <span>The store has no master product for <b>${esc(styleNumber || "this style")}</b> yet — the build copies every product from one.</span>
        <button class="btn btn-secondary btn-sm" type="button" data-ob="create-master">Create the master</button>
      </div>`;
  }

  function packetLogos(record) {
    return list(record?.packet?.files).filter((f) => f?.kind === "artwork" && f.assetId && !/proof/i.test(f?.name || ""));
  }

  // Which placements a row's codes already describe, and the logo on each.
  // Codes as the server reads them: split on "/", commas or spaces.
  function codeList(value) {
    return [
      ...new Set(
        String(value || "")
          .split(/[\/,\s]+/)
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean)
      )
    ];
  }

  // Which placement each embroidery code sits on: the saved map, or — for a
  // row that has none (a policy suggestion) — E01 on the front.
  function embroideryKeys(codes, placements) {
    const map = {};
    const hasMap = Object.keys(placements || {}).length > 0;
    for (const code of codes) {
      if (!/^[EP]\d{2}$/.test(code)) continue;
      if (placements?.[code]) map[code] = placements[code];
      else if (!hasMap && code === "E01") map[code] = "F";
    }
    return map;
  }

  // Which placements a row's codes already describe, and the logo on each.
  function placementState(product) {
    const codes = codeList(product?.decorationCodes);
    const logoMap = product?.logoMap && typeof product.logoMap === "object" ? product.logoMap : {};
    const placements = product?.placements && typeof product.placements === "object" ? product.placements : {};
    const eKeys = embroideryKeys(codes, placements);
    const out = {};
    let custom = false;
    for (const code of codes) {
      const m = code.match(/^(F|B|RS|LS|E|P)(\d{2})$/);
      if (!m) continue;
      if (m[1] === "E" || m[1] === "P") {
        if (eKeys[code] && !out[eKeys[code]]) out[eKeys[code]] = { code, logo: logoMap[code] || "" };
        else custom = true;
      } else if (m[2] === "01") {
        out[m[1]] = { code, logo: logoMap[code] || "" };
      } else {
        custom = true;
      }
    }
    return { on: out, custom };
  }

  function placementsHtml(record, product) {
    const logos = packetLogos(record);
    const { on, custom } = placementState(product);
    /* A row sold in Styles typed as codes takes its codes from the style rows
       below, so the placements here would change nothing it builds — say so
       instead. Styles made by "Another logo on this garment" are built FROM
       these placements, so the grid stays. */
    if (typedStyles(product).length) {
      return `<div class="ob-placements" data-ob-placements><p class="field-label">Where the logos go</p><p class="hint">This row is sold in Styles, so each Style row below carries its own codes. Remove the Styles to use the placements here.</p></div>`;
    }
    const defaultFor = (key) => (key === "B" ? "back" : "chest");
    return `
      <div class="ob-placements" data-ob-placements data-ob-proof-codes="${esc(Object.keys(product?.proofs || {}).filter((k) => product.proofs[k]).join(","))}">
        <p class="field-label">Where the logos go <small>tick each placement and pick the logo for it</small></p>
        ${custom ? `<p class="hint" data-tone="warn">This row also has codes the four placements do not cover (e.g. F02, P01). Ticking placements keeps them; change them in "Decoration codes" above.</p>` : ""}
        <div class="ob-placement-grid">
          ${PLACEMENTS.map((p) => {
            const placed = on[p.key];
            return `
            <div class="ob-placement" data-ob-place="${esc(p.key)}" data-on="${placed ? "true" : "false"}">
              <label class="ob-place-toggle"><input type="checkbox" data-ob-place-on ${placed ? "checked" : ""}> <b>${esc(p.label)}</b>${p.hint ? ` <small>${esc(p.hint)}</small>` : ""}</label>
              <select data-ob-place-logo aria-label="Logo for the ${esc(p.label.toLowerCase())}">
                <option value="">${logos.length ? `Default (the ${defaultFor(p.key)} logo)` : "Upload logos in step 1"}</option>
                ${logos
                  .map((f) => `<option value="${esc(f.assetId)}" ${placed?.logo === f.assetId ? "selected" : ""}>${esc(f.name || "logo")}${f.role ? ` (${esc(f.role)} logo)` : ""}</option>`)
                  .join("")}
              </select>
            </div>`;
          }).join("")}
        </div>
        <input type="hidden" data-ob-field="logoMap" value="${esc(JSON.stringify(product?.logoMap || {}))}">
        <input type="hidden" data-ob-field="placements" value="${esc(JSON.stringify(product?.placements || {}))}">
      </div>`;
  }

  /* Placements → decoration codes, the logo per code and, for embroidery,
     where each E code sits. Only the codes the four placements own change:
     F01 / B01 / RS01 / LS01 for print, and the E codes mapped to a placement.
     Anything else on the row — F02, P01, an E02 from the policy, codes typed
     by hand — is kept exactly as it is. An embroidery placement keeps its E
     number when others are unticked, so proofs (filed by code) stay put. */
  function syncPlacements(row, { fromPlacement = true } = {}) {
    // A row sold in Styles shows no placements; its codes are left alone.
    if (!row.querySelector("[data-ob-place]")) return;
    const method = row.querySelector("[data-ob-field='decorationMethod']")?.value || "";
    const ticked = PLACEMENTS.map((p) => row.querySelector(`[data-ob-place='${p.key}']`)).filter(
      (node) => node && node.querySelector("[data-ob-place-on]")?.checked
    );
    // Codes typed by hand (no placement ticked) are left alone when only the
    // method changes.
    if (!ticked.length && !fromPlacement) return;
    row.querySelectorAll("[data-ob-place]").forEach((node) => {
      node.dataset.on = node.querySelector("[data-ob-place-on]")?.checked ? "true" : "false";
    });
    if (ticked.length && !method) {
      const select = row.querySelector("[data-ob-field='decorationMethod']");
      // Headwear is embroidered as a rule; everything else is printed.
      const type = `${row.querySelector("[data-ob-field='type']")?.value || ""}`.toLowerCase();
      if (select) select.value = /hat|cap|beanie|snapback/.test(type) ? "embroidery" : "print";
    }
    const embroidered = (row.querySelector("[data-ob-field='decorationMethod']")?.value || "") === "embroidery";
    const codesInput = row.querySelector("[data-ob-field='decorationCodes']");
    const mapInput = row.querySelector("[data-ob-field='logoMap']");
    const placeInput = row.querySelector("[data-ob-field='placements']");
    const readJson = (input) => {
      try {
        const value = JSON.parse(input?.value || "{}");
        return value && typeof value === "object" ? value : {};
      } catch {
        return {};
      }
    };
    const current = codeList(codesInput?.value);
    const oldLogos = readJson(mapInput);
    const oldPlacements = readJson(placeInput);
    const eKeys = embroideryKeys(current, oldPlacements);
    const owned = new Set(["F01", "B01", "RS01", "LS01", ...Object.keys(eKeys)]);
    const kept = current.filter((code) => !owned.has(code));

    const codes = [];
    const logoMap = {};
    const placements = {};
    const used = new Set(kept);
    const proofCodes = String(row.querySelector("[data-ob-placements]")?.dataset.obProofCodes || "")
      .split(",")
      .filter(Boolean);
    const eFor = {};
    for (const [code, key] of Object.entries(eKeys)) eFor[key] = code;
    const nextE = () => {
      for (let n = 1; n < 100; n += 1) {
        const code = `E${String(n).padStart(2, "0")}`;
        if (!used.has(code) && !Object.values(eFor).includes(code) && !proofCodes.includes(code)) return code;
      }
      return "E99";
    };
    for (const node of ticked) {
      const key = node.dataset.obPlace;
      let code;
      if (embroidered) {
        code = eFor[key] && !used.has(eFor[key]) ? eFor[key] : nextE();
        eFor[key] = code;
        placements[code] = key;
      } else {
        code = `${key}01`;
      }
      used.add(code);
      codes.push(code);
      const logo = node.querySelector("[data-ob-place-logo]")?.value || "";
      if (logo) logoMap[code] = logo;
    }
    // What the placements do not own keeps its logo and placement as saved.
    for (const code of kept) {
      if (oldLogos[code]) logoMap[code] = oldLogos[code];
      if (oldPlacements[code]) placements[code] = oldPlacements[code];
    }
    if (codesInput) codesInput.value = [...codes, ...kept].join("/");
    if (mapInput) mapInput.value = JSON.stringify(logoMap);
    if (placeInput) placeInput.value = JSON.stringify(placements);
  }

  // "112" and "R112", "3600" and "NL3600" are one garment, not a switch.
  function sameGarment(a, b) {
    const x = String(a || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const y = String(b || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!x || !y) return false;
    if (x === y) return true;
    return (/^[0-9]/.test(x) && y.replace(/^[A-Z]+/, "") === x) || (/^[0-9]/.test(y) && x.replace(/^[A-Z]+/, "") === y);
  }

  /* On a garment switch only what the agent filled in goes: the title it
     made from the store's name (or "<brand> <type>") and the Vendor it took
     from the store. A title or Vendor typed by hand stays. */
  function clearAutoFilled(row) {
    const saved = list(state.record?.products).find((p) => p?.id === row.dataset.obProduct) || {};
    const code = state.record?.department?.code?.value || "";
    const title = row.querySelector("[data-ob-field='title']");
    const value = (title?.value || "").trim();
    const autoTitles = [
      saved.storeProfile?.name ? `${saved.storeProfile.name} ${code}`.trim() : "",
      [saved.brand, saved.type].filter(Boolean).join(" ")
    ].filter(Boolean);
    if (title && (!value || autoTitles.includes(value))) title.value = "";
    const vendor = row.querySelector("[data-ob-field='fulfillment']");
    if (vendor && vendor.value && saved.storeProfile?.vendor && vendor.value === saved.storeProfile.vendor) vendor.value = "";
    row.querySelector(".ob-master-missing")?.remove();
  }

  // The ticks follow the codes field after a hand edit.
  function retickPlacements(row) {
    if (!row.querySelector("[data-ob-place]")) return;
    const read = (name) => {
      try {
        const v = JSON.parse(row.querySelector(`[data-ob-field='${name}']`)?.value || "{}");
        return v && typeof v === "object" ? v : {};
      } catch {
        return {};
      }
    };
    const { on } = placementState({
      decorationCodes: row.querySelector("[data-ob-field='decorationCodes']")?.value || "",
      placements: read("placements"),
      logoMap: read("logoMap")
    });
    row.querySelectorAll("[data-ob-place]").forEach((node) => {
      const box = node.querySelector("[data-ob-place-on]");
      if (box) box.checked = Boolean(on[node.dataset.obPlace]);
      node.dataset.on = box?.checked ? "true" : "false";
    });
  }

  // Picking a garment fills the row from the store's own master.
  function applyGarment(row, styleNumber) {
    if (styleNumber === "__lookup") {
      const box = row.querySelector("[data-ob-lookup]");
      if (box) {
        box.hidden = false;
        box.querySelector("[data-ob-lookup-query]")?.focus();
      }
      return;
    }
    const garment = list(state.garments).find((g) => g.styleNumber === styleNumber);
    if (!garment) return;
    const set = (field, value, onlyIfEmpty = false) => {
      const input = row.querySelector(`[data-ob-field='${field}']`);
      if (!input || (onlyIfEmpty && input.value.trim())) return;
      input.value = value;
    };
    /* A different garment on a row that already had one: its sizes, and the
       title and Vendor the save filled from the old garment, belong to that
       garment — they are replaced, not kept (the save fills them again). */
    const previous = (row.querySelector("[data-ob-field='styleNumber']")?.value || "").trim().toUpperCase();
    const switching = Boolean(previous) && !sameGarment(previous, garment.styleNumber);
    if (switching) clearAutoFilled(row);
    set("brand", garment.brand);
    set("styleNumber", garment.styleNumber);
    set("type", garment.type);
    set("sizes", list(garment.sizes).join(", "), !switching);
    // A new row with no codes yet starts with the front logo.
    if (!(row.querySelector("[data-ob-field='decorationCodes']")?.value || "").trim() && ![...row.querySelectorAll("[data-ob-place-on]")].some((box) => box.checked)) {
      const front = row.querySelector("[data-ob-place='F'] [data-ob-place-on]");
      if (front) front.checked = true;
    }
    const method = row.querySelector("[data-ob-field='decorationMethod']");
    if (method && !method.value) method.value = /hat|beanie/i.test(garment.type) ? "embroidery" : "print";
    syncPlacements(row);
  }

  /* What the store already does with this blank, read on save: the house
     name, the Vendor, and the colours other departments sell it in. */
  function storeProfileHtml(record, product) {
    const profile = product?.storeProfile;
    if (!profile?.name) return "";
    const code = record.department?.code?.value || "CODE";
    return `<p class="hint ob-store-hint">In the store, ${esc(String(profile.sampleSize || "other"))} department products use this blank as
      “${esc(profile.name)} ${esc(code)}”${profile.vendor ? `, ${esc(profile.vendor)}` : ""}${list(profile.colorCodes).length ? `, mostly in ${esc(list(profile.colorCodes).join(", "))}` : ""}.</p>`;
  }

  /* Where each logo on this garment comes from: the department's own logos
     from the packet (or the one picked for the code), and an embroidery proof
     when one is uploaded here. Without this the row had no "logo" anywhere,
     and an operator reasonably reached for "+ Add style" looking for one. */
  const DECORATION_FACES = { F: "front", B: "back", RS: "right sleeve", LS: "left sleeve", E: "embroidered", P: "patch" };

  function logosHtml(record, product, saved) {
    const codes = [
      ...new Set(
        [String(product?.decorationCodes || ""), ...list(product?.styles).map((style) => String(style?.decorationCodes || ""))]
          .flatMap((group) => group.split("/"))
          .map((part) => part.trim().toUpperCase())
          .filter(Boolean)
      )
    ];
    if (!codes.length) {
      return `
        <div class="ob-slots ob-logos">
          <p class="field-label">Logos</p>
          <p class="hint">Type the decoration codes above, then save: <b>F01</b> = front logo, <b>B01</b> = back logo, <b>RS01</b>/<b>LS01</b> = sleeves, <b>E01</b> = an embroidered logo. Each code is matched to its logo here.</p>
        </div>`;
    }
    /* Which logo the mockups use for each code — the same choice the build
       makes: the embroidery proof if one was uploaded, otherwise the
       department's own logo from the packet (the back logo for B, the chest
       logo, pick or scramble for everything else). */
    const art = list(record.packet?.files).filter((f) => f?.kind === "artwork" && !/proof/i.test(f?.name || ""));
    const byRole = (roles) => roles.map((role) => art.find((f) => (f?.role || "") === role)).find(Boolean) || null;
    const onBack = (c) => /^B\d{2}$/.test(c) || (product?.placements && product.placements[c] === "B");
    const logoFor = (c) =>
      onBack(c) ? byRole(["back", "scramble"]) : byRole(["chest", "pick", "scramble", ""]) || art.find((f) => (f?.role || "") !== "back") || null;
    const rows = codes
      .map((c) => {
        const print = /^(F|B|RS|LS)\d{2}$/.test(c);
        const proofed = !print && product?.proofs?.[c];
        const picked = product?.logoMap && product.logoMap[c] ? art.find((f) => f?.assetId === product.logoMap[c]) : null;
        const logo = picked || logoFor(c);
        const face = DECORATION_FACES[c.replace(/\d+$/, "")] || "";
        const source = proofed ? "the embroidery proof below" : logo ? `your uploaded logo <b>${esc(logo.name || "")}</b>` : "";
        return `<li data-tone="${source ? "ok" : "warn"}">
          <b class="code-input">${esc(c)}</b> <span>${esc(face)} — ${source ? `mockups use ${source}` : "no logo yet: upload the department's logo in step 1 (Packet)"}</span>
        </li>`;
      })
      .join("");
    return `
      <div class="ob-slots ob-logos">
        <p class="field-label">Logos <small>one per decoration code</small></p>
        ${rows ? `<ul class="ob-logo-list">${rows}</ul>` : ""}
        ${proofHtml(record, product, saved)}
      </div>`;
  }

  /* A colour FN's list does not have yet, with both ways out right here:
     add it under the proposed code (Dan's approval, one click), or switch
     the row to the closest colour already on the list. */
  function colorIssuesHtml(product) {
    const issues = list(product?.colorIssues);
    if (!issues.length) return "";
    return `
      <div class="ob-color-issues">
        ${issues
          .map(
            (issue) => `
          <div class="ob-color-issue">
            <span><b>${esc(issue.color)}</b> is not on FN's colour list yet.</span>
            <span class="ob-color-issue-actions">
              ${issue.code ? `<button class="btn btn-secondary btn-sm" type="button" data-ob="approve-color" data-ob-color="${esc(issue.color)}" data-ob-code="${esc(issue.code)}">Add as ${esc(issue.code)}</button>` : ""}
              <button class="btn btn-ghost btn-sm" type="button" data-ob="approve-color" data-ob-color="${esc(issue.color)}" data-ob-code="" >${issue.code ? "Different code…" : "Add with a code…"}</button>
              ${issue.nearest ? `<button class="btn btn-ghost btn-sm" type="button" data-ob="use-nearest" data-ob-color="${esc(issue.color)}" data-ob-nearest="${esc(issue.nearest.color)}">Use ${esc(issue.nearest.color)} (${esc(issue.nearest.code)}) instead</button>` : ""}
            </span>
          </div>`
          )
          .join("")}
      </div>`;
  }

  function blankPhotoHtml(record, product, saved) {
    const colors = list(product?.colors);
    if (!colors.length) {
      return `<div class="ob-slots"><p class="field-label">Blank garment photos <small>optional</small></p><p class="hint">Add colours and save the row to get a front and back slot per colour. Without photos the mockups use the supplier's picture of the blank.</p></div>`;
    }
    return `
      <div class="ob-slots">
        <p class="field-label">Blank garment photos <small>optional · front and back, per colour · without them the supplier's picture is used</small></p>
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
        <p class="field-label">Embroidery proofs <small>optional · the Printed Image art proof per E code · without one the uploaded logo is used</small></p>
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

  /* ---- Build --------------------------------------------------------------- */
  function buildPanel(record) {
    return `
      <section class="card card-pad ob-panel" id="obPanel-build" data-ob-panel="build">
        <div class="card-head">
          <div>
            <p class="eyebrow">Build</p>
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
    const running = build.state === "running" || build.state === "starting";
    const steps = list(build.steps);
    /* A re-run skips every product that already exists in Shopify. Those
       steps are finished, not outstanding — counting only "complete" showed a
       finished build stuck at 67%, which read as "it stopped". */
    const skipped = steps.filter((step) => step?.state === "skipped").length;
    const done = steps.filter((step) => step?.state === "complete").length + skipped;
    const pct = steps.length ? Math.round((done / steps.length) * 100) : build.state === "complete" ? 100 : 0;
    /* "interrupted" is what a deploy or a restart leaves behind. Treating it
       as "still running" disabled the button and polled forever, so the only
       way out was to edit the record by hand. It is a resumable state, not a
       live one. */
    const interrupted = build.state === "interrupted";
    const label = running ? "Building…" : interrupted ? "Resume build" : build.state ? "Re-run build" : "Build store";
    /* A build takes minutes (the mockups are most of it), and a chip that
       says "running" was easy to miss — an operator could not tell whether
       the click had done anything. While it runs, one unmissable panel says
       so: what it is doing now, how long it has been going, and that the
       page can be left. */
    const current = steps.find((step) => step?.state === "running");
    const startedMs = Date.parse(build.startedAt || "") || 0;
    const elapsedMin = startedMs ? Math.max(0, Math.floor((Date.now() - startedMs) / 60000)) : 0;
    const productCount = list(record.products).length;
    const nowDoing = current?.label || (steps.length ? "Finishing up" : "Starting");
    const liveHtml = running
      ? `<div class="ob-building" role="status" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <div>
            <p class="ob-building-title">Building now — ${esc(nowDoing)}</p>
            <p class="ob-building-sub">${steps.length ? `Step ${Math.min(done + 1, steps.length)} of ${steps.length}` : "Getting ready"}${startedMs ? ` · ${elapsedMin < 1 ? "under a minute" : `${elapsedMin} min`} so far` : ""} · usually ${Math.max(3, productCount * 2 + 1)}–${Math.max(5, productCount * 3 + 2)} minutes for ${productCount} product${plural(productCount, "", "s")}, mostly the mockups.
            This page updates by itself, and the build keeps going if you leave it.</p>
          </div>
        </div>`
      : "";
    return `
      ${liveHtml}
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
            <div class="progress-meta"><span>${esc(running ? `Step ${Math.min(done + 1, steps.length)} of ${steps.length}` : `${done} of ${steps.length} steps done${skipped ? ` (${skipped} skipped — already in Shopify)` : ""}`)}</span><span>${pct}%</span></div>
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
            <div class="ob-mockup-group-head">
              <p class="field-label">${esc(product?.title || [product?.brand, product?.styleNumber].filter(Boolean).join(" ") || "Product")} <small>${mockups.length} image${plural(mockups.length, "", "s")}</small></p>
              ${redoButtonHtml(product)}
            </div>
            <div class="ob-mockups">
              ${mockups.map((mockup) => mockupFigureHtml(record, mockup)).join("")}
            </div>
          </div>`;
          })
          .join("")}
      </div>`;
  }

  /* New artwork, a real blank photo, or a better supplier photo after the
     product was built: make its images again and swap them on the Shopify
     draft. Without this a re-run reused the old images and skipped the
     product, so nothing changed. */
  function redoButtonHtml(product) {
    if (!product?.id || !(list(product.mockups).length || product.shopify?.gid)) return "";
    const running = ["running", "starting"].includes(state.record?.build?.state);
    return `<button class="btn btn-ghost btn-sm" type="button" data-ob="redo-images" data-ob-product-id="${esc(product.id)}" ${running ? "disabled" : ""}>Redo images</button>`;
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
    const blocked = kind.key === "megaMenu" && status === "blocked";
    // The menu write is refused on screen for the same reasons finish is.
    const menuStopped = kind.key === "megaMenu" ? menuStop(record) : null;
    return `
      <div class="ob-shared" data-ob-shared="${esc(kind.key)}" data-tone="${esc(sharedTone(status))}">
        <div class="ob-shared-head">
          <b>${esc(kind.label)}</b>
          ${chip(status, sharedTone(status))}
        </div>
        <p class="ob-shared-sub">${esc(kind.sub)}</p>
        ${blocked
          ? menuBlockedHtml(node)
          : menuStopped
            ? `<p class="hint">While the menu looks wiped, no position for this store can be trusted. Once it is whole again, press “Re-compute proposals”.</p>`
            : sentence
              ? `<p class="ob-proposal">${esc(sentence)}</p>`
              : `<p class="hint">No proposal computed yet.</p>`}
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
        ${node.error && !blocked ? `<p class="build-error">${esc(node.error)}</p>` : ""}
        <div class="ob-shared-actions">
          ${/* "Approve & apply" is only honest where the agent can actually
                write the change. Shopify Flow has no API at all and Helium has
                no write API, so for those two the only truthful button is the
                one that records what Dan did by hand; offering "apply" there
                marked the setting done with nothing applied. With the menu
                looking wiped it stays visible but off, and says why; "I did
                this" stays on — it records Dan's hand edit and writes nothing. */
            kind.key === "megaMenu" && state.caps?.megaMenu?.writable
              ? `<button class="btn btn-secondary btn-sm" type="button" data-ob="approve-shared" data-ob-kind="${esc(kind.key)}" ${
                  menuStopped ? 'disabled aria-describedby="obMenuApplyWhy"' : ""
                }>Approve &amp; apply</button>`
              : ""}
          <button class="btn btn-ghost btn-sm" type="button" data-ob="confirm-shared" data-ob-kind="${esc(kind.key)}">${esc(
            kind.key === "megaMenu" && state.caps?.megaMenu?.writable ? "I did this" : "I did this — confirm"
          )}</button>
          <button class="btn btn-ghost btn-sm" type="button" data-ob="copy" data-ob-copy-text="${esc(record.department?.tag || record.department?.name || "")}">Copy tag</button>
        </div>
        ${menuStopped && state.caps?.megaMenu?.writable ? `<p class="hint ob-shared-why" id="obMenuApplyWhy">${esc(menuStopped.title)}</p>` : ""}
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

  /* "blocked": the agent refused to write the menu because it looked wiped.
     The proposal sentence is left out on purpose — a position worked out
     against an emptied "Store" is exactly the wrong one. The record keeps at
     most 50 missing titles, so the live read's count wins when there is one. */
  function menuBlockedHtml(node) {
    const health = node.health || {};
    const recorded = list(health.missing);
    const live = state.menuHealth?.available ? state.menuHealth : null;
    const count = live && !live.healthy ? list(live.missing).length : recorded.length;
    const atLeast = !(live && !live.healthy) && recorded.length >= 50;
    const stores = Number(health.storeCount);
    return `
      <div class="ob-shared-blocked">
        <p><b>${esc(node.error || "The agent did not touch the menu: it looks wiped.")}</b></p>
        ${count
          ? `<p>${atLeast ? "At least 50" : count} ${plural(count, "link", "links")} from the agent's saved copy${
              health.baselineAt ? ` of ${esc(when(health.baselineAt))}` : ""
            } ${count === 1 ? "is" : "are"} missing${
              Number.isFinite(stores) ? `; Store had ${stores} ${plural(stores, "store", "stores")} when the agent stopped` : ""
            }.</p>`
          : ""}
        ${live?.healthy
          ? `<p>A read since then shows the menu whole again${live.checkedAt ? ` (${esc(when(live.checkedAt))})` : ""}, so the agent can try again.</p>`
          : ""}
      </div>`;
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
            <p class="eyebrow">Final report</p>
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
    // The two "have you done this?" ticks arm the finish button.
    if (event.target.closest("[data-ob-finish-ask]")) {
      syncFinishControls(page());
      return;
    }
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
    // Making a product: the garment picker, the placements, the method.
    const row = event.target.closest("[data-ob-product]");
    if (row) {
      if (event.target.matches("[data-ob-garment]")) {
        applyGarment(row, event.target.value);
        return;
      }
      if (event.target.closest("[data-ob-place]") || event.target.matches("[data-ob-field='decorationMethod']")) {
        syncPlacements(row, { fromPlacement: Boolean(event.target.closest("[data-ob-place]")) });
        refreshOtherLogos(row);
        return;
      }
      if (event.target.matches("[data-ob-field='decorationCodes']")) {
        retickPlacements(row);
        refreshOtherLogos(row);
        return;
      }
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

    if (action === "copy") {
      const targetId = trigger.dataset.obCopyTarget;
      const text = targetId ? document.getElementById(targetId)?.value || "" : trigger.dataset.obCopyText || "";
      copyText(text, trigger);
      return;
    }
    if (action === "reload") {
      // Refresh re-reads the menu too, fresh from Shopify on the Finish step.
      state.healthStep = null;
      loadMenuHealth();
      loadDetail(record.id);
      return;
    }
    if (action.startsWith("menu-")) return menuAction(action);
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
    if (action === "use-recommendation") {
      const reco = record.department?.code?.recommendation;
      if (!reco?.code) return;
      return runSimple(trigger, "Approving — creating folders and reviewing the policy…", "/code", { code: reco.code, name: reco.name || "", by: currentOperator() }, afterCodeApproval);
    }
    if (action === "step") return goToStep(trigger.dataset.obStep);
    /* Step 1's continue: the code lookup. When the department is on the code
       list in its own state, setup approves the code and carries on with the
       folders and the review in the same call, so the next step may already
       be the review. */
    if (action === "wizard-lookup")
      return runSimple(trigger, "Looking up the department…", "/setup", {}, (record) => goToStep(stepDone(record, "code") ? "review" : "code"));
    if (action === "wizard-save-products") return saveProducts(trigger, true);
    if (action === "run-setup") return runSimple(trigger, "Running…", "/setup", {}, afterCodeApproval);
    if (action === "run-review") return runSimple(trigger, "Reviewing…", "/review");
    if (action === "final-check") return runSimple(trigger, "Checking…", "/final-check");
    if (action === "propose-shared") return runSimple(trigger, "Computing…", "/shared-settings/propose");
    if (action === "verify-shared") return runSimple(trigger, "Verifying…", "/shared-settings/verify");
    if (action === "finish") return finishOnboarding(trigger);
    if (action === "finish-later") return finishOnboarding(trigger, { later: true });
    if (action === "approve-shared") return approveShared(trigger, false);
    if (action === "confirm-shared") return approveShared(trigger, true);
    if (action === "save-lock") return saveLock(trigger);
    if (action === "create-lock") return createLock(trigger);
    if (action === "save-notes") return saveNotes(trigger);
    if (action === "save-products") return saveProducts(trigger);
    if (action === "build") return startBuild(trigger);
    if (action === "redo-images") return redoImages(trigger);
    if (action === "size-preset") {
      const input = trigger.closest("[data-ob-product]")?.querySelector("[data-ob-field='sizes']");
      if (!input) return;
      const add = trigger.dataset.obAdd === "true";
      const next = add ? [...new Set([...parseList(input.value), ...parseList(trigger.dataset.obSizes)])] : parseList(trigger.dataset.obSizes);
      input.value = next.join(", ");
      return;
    }
    if (action === "approve-color") return approveColor(trigger);
    if (action === "use-nearest") {
      const row = trigger.closest("[data-ob-product]");
      const input = row?.querySelector("[data-ob-field='colors']");
      if (!input) return;
      const from = trigger.dataset.obColor.toLowerCase();
      const to = trigger.dataset.obNearest;
      const next = [...new Set(parseList(input.value).map((c) => (c.toLowerCase() === from ? to : c)))];
      input.value = next.join(", ");
      const save = page()?.querySelector("[data-ob='save-products']");
      if (save) saveProducts(save);
      return;
    }
    if (action === "lookup-garment") return lookupGarment(trigger);
    if (action === "create-master") return createMaster(trigger);
    if (action === "add-color") {
      const row = trigger.closest("[data-ob-product]");
      const input = row?.querySelector("[data-ob-field='colors']");
      if (!input) return;
      const color = trigger.dataset.obColor;
      const have = parseList(input.value);
      const already = have.some((c) => c.toLowerCase() === color.toLowerCase());
      const next = already ? have.filter((c) => c.toLowerCase() !== color.toLowerCase()) : [...have, color];
      input.value = next.join(", ");
      trigger.dataset.picked = already ? "false" : "true";
      return;
    }
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
      /* Removing a row is saved straight away. It used to vanish from the
         screen and come back on the next refresh unless Save was pressed. */
      const row = trigger.closest("[data-ob-product]");
      if (!row) return;
      const saved = list(record.products).find((p) => p?.id === row.dataset.obProduct);
      const name = saved?.title || [saved?.brand, saved?.styleNumber].filter(Boolean).join(" ") || "this product";
      if (saved) {
        const built = Boolean(saved.shopify?.gid);
        if (!window.confirm(`Remove "${name}" from this store's product list?${built ? "\n\nIt was already built: its Draft stays in Shopify until you delete it there." : ""}`)) return;
      }
      if (!saved) {
        row.remove();
        return;
      }
      if (state.removing) return;
      state.removing = true;
      row.remove();
      const removedId = saved.id;
      const products = list(record.products).filter((p) => p?.id !== removedId);
      api(recordPath(record.id, "/products"), { method: "PUT", body: JSON.stringify({ products }) })
        .then((payload) => {
          // The record is updated without redrawing, so nothing typed in the
          // other rows is lost.
          if (payload?.onboarding && isCurrent("detail", record.id)) state.record = payload.onboarding;
        })
        .catch((error) => fail(`The row was removed on screen but not saved: ${error.message}. Press Save to try again.`))
        .finally(() => {
          state.removing = false;
        });
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
      return;
    }
    if (action === "add-other-logo") {
      const row = trigger.closest("[data-ob-product]");
      const holder = row?.querySelector("[data-ob-other-logo-list]");
      if (!holder) return;
      const spots = PLACEMENTS.filter((p) => row.querySelector(`[data-ob-place='${p.key}'] [data-ob-place-on]`)?.checked);
      const index = holder.querySelectorAll("[data-ob-other-logo]").length;
      holder.insertAdjacentHTML("beforeend", otherLogoRowHtml(packetLogos(record), spots, {}, index));
      refreshOtherLogos(row);
      holder.lastElementChild?.querySelector("[data-ob-other-logo-file]")?.focus();
      return;
    }
    if (action === "remove-other-logo") {
      const row = trigger.closest("[data-ob-product]");
      trigger.closest("[data-ob-other-logo]")?.remove();
      refreshOtherLogos(row);
      row?.querySelector("[data-ob='add-other-logo']")?.focus();
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
    const used = [
      ...list(state.record?.products).map((product) => String(product?.id || "")),
      ...[...(page()?.querySelectorAll("[data-ob-product]") || [])].map((node) => node.dataset.obProduct)
    ];
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

  function runSimple(button, busyLabel, suffix, body, after) {
    const id = state.record?.id;
    if (!id) return;
    return runAction(
      button,
      busyLabel,
      async () => {
        const payload = await api(recordPath(id, suffix), { method: "POST", body: JSON.stringify(body || {}) });
        if (!isCurrent("detail", id)) return;
        applyRecord(payload);
        if (after) after(state.record);
      },
      page(),
      "obDetailError"
    );
  }

  // After a code approval the agent has made the folders and reviewed the
  // policy, so the review is the next thing to look at.
  function afterCodeApproval(record) {
    if (stepDone(record, "code")) goToStep("review");
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
    return runSimple(button, "Approving — creating folders and reviewing the policy…", "/code", { code: value, by: currentOperator() }, afterCodeApproval);
  }

  // "Helium, Shopify Flow and the final check" — for sentences about steps.
  function namesList(names) {
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] || "";
  }

  function capitalize(text) {
    const value = String(text || "");
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  /*
   * The whole tail of an onboarding behind one button — or, with `later`,
   * everything except the two attestations.
   *
   * finishSends decides what goes and in what order, the same list the card
   * describes. Helium goes first because it is the one request that can
   * refuse: a form the agent can read does not carry the tag. That refusal
   * (409) stops everything — the record is untouched, the Helium box is
   * unticked, and the server's own sentence says which form. Any other
   * failure part-way shows the record as it now stands, because the steps
   * before it did land, and names what went through and what was not sent.
   *
   * Not runAction: a failure after the first step repaints the page, and
   * runAction would show its error in the page it started on, which is gone
   * by then.
   */
  async function finishOnboarding(button, { later = false } = {}) {
    const id = state.record?.id;
    if (!id || state.finishing) return;
    const record = state.record;
    const scope = page();
    // The buttons are already off in both cases; this is the backstop for a
    // screen that has not caught up with the record or the menu.
    const stop = menuStop(record);
    if (stop) {
      fail(stop.title);
      syncFinishControls(scope);
      return;
    }
    if (!later && [...(scope?.querySelectorAll("[data-ob-finish-ask]") || [])].some((box) => !box.checked)) {
      fail("Tick a box only once that part is done — or press “Not yet” to finish it later.");
      return;
    }
    const by = currentOperator();
    const steps = finishSends(record, { later, by });
    const menuStep = steps.some((step) => step.kind === "megaMenu");
    const original = button.innerHTML;
    const landed = [];
    let payload = null;
    let failed = null;

    state.finishing = true;
    lockFinishCard(scope);
    button.dataset.obBusy = "true";
    hideBanner(scope, "obDetailError");
    try {
      for (const step of steps) {
        button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(step.busy)}`;
        try {
          payload = await api(recordPath(id, step.suffix), { method: "POST", body: JSON.stringify(step.body) });
        } catch (error) {
          failed = { step, error };
          break;
        }
        if (!isCurrent("detail", id)) return;
        landed.push(step);
      }
    } finally {
      state.finishing = false;
    }
    if (!isCurrent("detail", id)) return;

    if (failed) {
      const { step, error } = failed;
      const rest = steps.slice(steps.indexOf(step) + 1).map((next) => next.name);
      const notSent = rest.length ? ` ${capitalize(namesList(rest))} ${rest.length === 1 ? "was" : "were"} not sent.` : "";
      if (step.kind === "helium" && (error.status === 409 || error.code === "HELIUM_TAG_MISSING")) {
        /* Nothing on the record changed (the server only notes the refusal),
           so the screen stays as it is: Helium unticked, the card re-armed,
           and the server's sentence saying which form is missing the tag. */
        button.innerHTML = original;
        delete button.dataset.obBusy;
        const box = scope?.querySelector("[data-ob-finish-ask='helium']");
        if (box) box.checked = false;
        syncFinishControls(scope);
        showBanner(scope, "obDetailError", `${error.message} The agent stopped there:${notSent || " nothing else was sent."}`);
        box?.focus({ preventScroll: true });
        return;
      }
      if (payload) {
        // Earlier steps landed: show the record as it now stands.
        applyRecord(payload);
      } else {
        button.innerHTML = original;
        delete button.dataset.obBusy;
        syncFinishControls(scope);
      }
      const went = landed.map((done) => done.name);
      fail(
        `${capitalize(step.name)} did not go through: ${error.message}${went.length ? ` ${capitalize(namesList(went))} went through before it.` : ""}${notSent}`
      );
      return;
    }

    applyRecord(payload);
    const after = state.record;
    const menu = after.sharedSettings?.megaMenu || {};
    const recorded = landed.filter((step) => step.kind === "helium" || step.kind === "flow").map((step) => step.name);
    const again = later ? "“Not yet”" : "finish";
    if (menu.status === "blocked") {
      /* The server refused to write a menu that looks wiped. Its own reason,
         not the generic "not saved": the fix is the banner, not the
         checklist, and adding the item by hand would build on the wreck. */
      fail(
        `${menu.error || "The agent did not touch the Mega Menu: it looks wiped."}${
          recorded.length ? ` ${capitalize(namesList(recorded))} ${recorded.length === 1 ? "is" : "are"} recorded.` : ""
        } Fix the menu with the banner at the top, then press ${again} again.`
      );
      loadMenuHealth({ fresh: true });
    } else if (menuStep && !["applied", "verified"].includes(menu.status)) {
      /* The insert can still fail on a live menu — a stale proposal, a
         neighbour renamed since the build. The server falls back to "manual"
         and keeps the checklist; saying nothing here would leave the operator
         believing the store is in the menu. */
      fail(
        `${recorded.length ? "Everything else is recorded, but the" : "The"} Mega Menu was not saved${menu.error ? ` (${menu.error})` : ""}. Add the item by hand with the checklist in the shared settings below, then press ${again} again.`
      );
    } else if (after.status === "complete") {
      goToStep("done");
    } else if (later) {
      const left = FINISH_ASKS.filter((item) => !sharedDone(after.sharedSettings, item.key)).map((item) => item.short);
      showBanner(
        page(),
        "obDetailError",
        `${menuStep ? "Saved" : "Checked"}. ${namesList(left) || "Flow and Helium"} ${left.length === 1 ? "is" : "are"} still to do — this onboarding stays open until you confirm ${
          left.length === 1 ? "it" : "them"
        }.`,
        "warn"
      );
    } else {
      /* Re-rendering the same card used to be the only response, so a final
         check that found something read as a dead button. */
      const open = Array.isArray(after.report?.unresolved) ? after.report.unresolved : list(after.report?.missingInformation);
      fail(
        open.length
          ? `Not finished — the final check found ${open.length === 1 ? "one thing" : `${open.length} things`} still open, listed in the card below. Fix ${open.length === 1 ? "it" : "them"}, then press finish again.`
          : "Not finished — the final check did not pass. Press finish again to re-check."
      );
    }
  }

  function approveShared(button, applied) {
    const kind = button.dataset.obKind;
    if (!kind) return;
    return runSimple(
      button,
      applied ? "Recording…" : "Applying…",
      `/shared-settings/${encodeURIComponent(kind)}/approve`,
      { by: currentOperator(), applied: Boolean(applied) },
      (record) => {
        // A refusal to write a wiped menu raises the banner at the top now,
        // not on the next visit.
        if (kind === "megaMenu" && record?.sharedSettings?.megaMenu?.status === "blocked") loadMenuHealth({ fresh: true });
      }
    );
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
    const all = list(state.record?.policyReview?.suggestedProducts).map((row, index) => ({ ...row, fromSuggestion: index }));
    const pick = button?.dataset?.obSuggestion;
    const suggestions = pick !== undefined && pick !== "" ? [all[Number(pick)]].filter(Boolean) : all;
    if (!suggestions.length) return;
    // Keep what is already on screen (unsaved edits included) and add only
    // the suggestions that are not in the list yet.
    const current = page()?.querySelector(".ob-products") ? collectProducts() : list(state.record?.products);
    const fresh = suggestions.filter((s) => !suggestionInList(current, s, s.fromSuggestion));
    if (!fresh.length) return;
    let n = current.length;
    const used = new Set(current.map((p) => p?.id));
    const nextId = () => {
      n += 1;
      while (used.has(`p${n}`)) n += 1;
      used.add(`p${n}`);
      return `p${n}`;
    };
    state.record.products = [...current, ...fresh.map((row) => ({ ...row, id: nextId() }))];
    renderDetail();
    /* Saved straight away: the save is what fills each row from the store
       (house name, the style as the store writes it, the Vendor) and what
       makes the photo and proof slots appear. Unsaved, the rows looked
       finished and had nowhere to put a logo. */
    const save = page()?.querySelector("[data-ob='save-products']");
    if (save) saveProducts(save);
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
      /* Every other logo is sent, a Style still without its logo too: the
         save says "pick which logo" instead of the row quietly losing it. */
      const otherLogos = node.querySelector("[data-ob-other-logos]")
        ? [...node.querySelectorAll("[data-ob-other-logo]")].map((other) => ({
            logo: other.querySelector("[data-ob-other-logo-file]")?.value || "",
            spot: other.querySelector("[data-ob-other-logo-spot]")?.value || ""
          }))
        : null;
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
        ...(otherLogos ? { otherLogos } : {}),
        fulfillment: read("fulfillment"),
        classB: node.querySelector("[data-ob-field='classB']")?.checked === true,
        notes: read("notes"),
        ...(node.querySelector('[data-ob-field="logoMap"]') ? { logoMap: parseJsonField(node, "logoMap") } : {}),
        ...(node.querySelector('[data-ob-field="placements"]') ? { placements: parseJsonField(node, "placements") } : {})
      };
    });
  }

  function parseJsonField(node, name) {
    try {
      const value = JSON.parse(node.querySelector(`[data-ob-field="${name}"]`)?.value || "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  function saveProducts(button, advance = false, { skipBlank = false } = {}) {
    const id = state.record?.id;
    if (!id) return;
    const savedIds = new Set(list(state.record?.products).map((p) => p?.id));
    const blank = (p) => !savedIds.has(p.id) && ![p.brand, p.styleNumber, p.type, p.title].some((v) => String(v || "").trim());
    const products = collectProducts().filter((p) => !(skipBlank && blank(p)));
    return runAction(
      button,
      "Saving…",
      async () => {
        const payload = await api(recordPath(id, "/products"), { method: "PUT", body: JSON.stringify({ products }) });
        if (!isCurrent("detail", id)) return;
        applyRecord(payload);
        if (!advance) return;
        if (stepDone(state.record, "products")) goToStep("build");
        else fail(products.length ? "Saved. Fix the rows marked “has errors” (and add any missing photos) before the build." : "Add at least one product row first.");
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
        const started = await api(recordPath(id, "/build"), { method: "POST", body: JSON.stringify({ force: rerun }) });
        if (!isCurrent("detail", id)) return;
        /* Use the build the server just started. Re-reading the record here
           raced the server writing it: the page came back "not started",
           and since only a running build is polled, it stayed that way while
           the build ran — the button looked like it only refreshed the page. */
        if (started?.build && state.record) {
          state.record.build = { ...(state.record.build || {}), ...started.build, state: started.build.state || "running" };
          renderDetail();
        } else {
          await loadDetail(id);
        }
      },
      page(),
      "obDetailError"
    );
  }

  function redoImages(button) {
    const id = state.record?.id;
    const productId = button.dataset.obProductId;
    const product = list(state.record?.products).find((p) => p?.id === productId);
    if (!id || !product) return;
    const name = product.title || product.styleNumber || "this product";
    const built = Boolean(product.shopify?.gid);
    if (!window.confirm(`Make the images for "${name}" again${built ? " and replace them on its Shopify draft" : ""}?

They are rebuilt from the current logos and blank photos. The product's title, SKUs and anything set in Shopify stay as they are.`)) return;
    return runAction(
      button,
      "Starting…",
      async () => {
        /* Edits on the Products step (a logo just picked for a placement) are
           saved first, so the new images are made from what is on screen. */
        const onScreen = page()?.querySelector(".ob-products") ? collectProducts().find((p) => p.id === productId) : null;
        if (onScreen) {
          const products = list(state.record?.products).map((p) => (p?.id === productId ? onScreen : p));
          await api(recordPath(id, "/products"), { method: "PUT", body: JSON.stringify({ products }) });
          if (!isCurrent("detail", id)) return;
        }
        const started = await api(`${recordPath(id)}/products/${encodeURIComponent(productId)}/redo-images`, { method: "POST", body: "{}" });
        if (!isCurrent("detail", id)) return;
        const fresh = await api(recordPath(id));
        if (!isCurrent("detail", id)) return;
        state.record = fresh.onboarding || state.record;
        if (started?.build) state.record.build = { ...(state.record.build || {}), ...started.build, state: started.build.state || "running" };
        goToStep("build");
      },
      page(),
      "obDetailError"
    );
  }

  async function lookupGarment(button) {
    const row = button.closest("[data-ob-product]");
    const box = row?.querySelector("[data-ob-lookup]");
    const query = box?.querySelector("[data-ob-lookup-query]")?.value.trim() || "";
    const out = box?.querySelector("[data-ob-lookup-result]");
    if (!row || !out) return;
    if (!query) {
      out.innerHTML = `<p class="hint" data-tone="warn">Type a brand and style first, e.g. Independent SS4500.</p>`;
      return;
    }
    button.disabled = true;
    const label = button.textContent;
    button.textContent = "Looking up…";
    out.innerHTML = `<p class="hint"><span class="spinner" aria-hidden="true"></span> Searching the manufacturer and distributors for “${esc(query)}” — about 5 seconds.</p>`;
    try {
      const rowId = row.dataset.obProduct;
      const answer = await api(`${API}/garments/lookup`, { method: "POST", body: JSON.stringify({ query }) });
      // The page may have been re-rendered during the search; find the row again.
      // Only when the row itself was replaced by a re-render is it looked up again.
      const target = row.isConnected ? row : page()?.querySelector(`[data-ob-product="${CSS.escape(rowId)}"]`);
      if (!target) return;
      return lookupInto(target, answer, query);
    } catch (error) {
      out.innerHTML = `<p class="hint" data-tone="danger">Could not look that up: ${esc(error.message)}</p>`;
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  function lookupInto(row, { garment, master }, query) {
    const out = row.querySelector("[data-ob-lookup-result]");
    if (!out) return;
    const box = row.querySelector("[data-ob-lookup]");
    if (box) box.hidden = false;
    {
      const set = (field, value) => {
        const input = row.querySelector(`[data-ob-field='${field}']`);
        if (input && value) input.value = value;
      };
      // A different garment: the old one's title and Vendor go (the save
      // fills them again for the new one).
      const previous = (row.querySelector("[data-ob-field='styleNumber']")?.value || "").trim().toUpperCase();
      const switching = Boolean(previous && garment.styleNumber) && !sameGarment(previous, garment.styleNumber);
      if (switching) clearAutoFilled(row);
      set("brand", garment.brand);
      set("styleNumber", garment.styleNumber);
      set("type", garment.type !== "Other" ? garment.type : "");
      if (list(garment.sizes).length) set("sizes", list(garment.sizes).join(", "));
      else if (switching) {
        const sizes = row.querySelector("[data-ob-field='sizes']");
        if (sizes) sizes.value = "";
      }
      const method = row.querySelector("[data-ob-field='decorationMethod']");
      if (method && !method.value) method.value = /hat|beanie/i.test(garment.type) ? "embroidery" : "print";
      if (!(row.querySelector("[data-ob-field='decorationCodes']")?.value || "").trim() && ![...row.querySelectorAll("[data-ob-place-on]")].some((b) => b.checked)) {
        const front = row.querySelector("[data-ob-place='F'] [data-ob-place-on]");
        if (front) front.checked = true;
      }
      syncPlacements(row);
      row.dataset.obLookupName = garment.name || "";
      const have = parseList(row.querySelector("[data-ob-field='colors']")?.value || "").map((c) => c.toLowerCase());
      const chips = list(garment.colors)
        .map((c) => `<button type="button" class="ob-color-chip" data-ob="add-color" data-ob-color="${esc(c)}" data-picked="${have.includes(c.toLowerCase()) ? "true" : "false"}">${esc(c)}</button>`)
        .join("");
      out.innerHTML = `
        <div class="ob-lookup-found" data-tone="${garment.found ? "ok" : "warn"}">
          <p><b>${esc([garment.brand, garment.name].filter(Boolean).join(" ") || query)}</b>${garment.styleNumber ? ` · <span class="code-input">${esc(garment.styleNumber)}</span>` : ""}${garment.type ? ` · ${esc(garment.type)}` : ""}${garment.productPage ? ` · <a href="${esc(garment.productPage)}" target="_blank" rel="noreferrer">product page</a>` : ""}</p>
          ${garment.found ? "" : `<p class="hint" data-tone="warn">Not sure this is the exact style — check the brand and style number above.</p>`}
          ${garment.note ? `<p class="hint">${esc(garment.note)}</p>` : ""}
          ${chips ? `<p class="field-label">Colours it comes in <small>click to add to the row</small></p><div class="ob-color-chips">${chips}</div>` : ""}
          ${master?.exists === false
            ? masterMissingHtml(garment.styleNumber)
            : master?.exists
              ? `<p class="hint">The store already has “${esc(master.title)}” to copy from.</p>`
              : master?.error
                ? `<p class="hint" data-tone="warn">Could not check the store for a master (${esc(master.error)}). Save the row — the check runs again then.</p>`
                : ""}
        </div>`;
    }
  }

  // One click: a Draft master in Shopify from what the row says, then re-save
  // so the row validates against it.
  function createMaster(button) {
    const row = button.closest("[data-ob-product]");
    if (!row) return;
    const read = (field) => row.querySelector(`[data-ob-field='${field}']`)?.value.trim() || "";
    const styleNumber = read("styleNumber");
    if (!styleNumber) {
      fail("Fill in the style number first.");
      return;
    }
    const name = row.dataset.obLookupName || read("type") || "Garment";
    if (!window.confirm(`Create a Draft master product "${read("brand")} ${name} (${styleNumber})" in Shopify?\n\nIt is tagged Master Reference and Needs Review, has one variant per size and a price of 0 for you to set. Department products are copied from it.`)) return;
    const id = state.record?.id;
    const rowId = row.dataset.obProduct;
    return runAction(
      button,
      "Creating…",
      async () => {
        const { master } = await api(`${API}/garments/master`, {
          method: "POST",
          body: JSON.stringify({ brand: read("brand"), styleNumber, name, type: read("type"), sizes: parseList(read("sizes")) })
        });
        /* The new master is put on the row directly. Re-checking by search
           right after creating it could miss it (Shopify search lags), leave
           the row saying "no master", and a second click made a duplicate. */
        const products = collectProducts().map((p) =>
          p.id === rowId ? { ...p, styleNumber: master.styleNumber || p.styleNumber, sourceProduct: { id: master.id, legacyId: master.legacyId || "", title: master.title, kind: "master", url: master.url || "" }, masterMissing: false } : p
        );
        const payload = await api(recordPath(id, "/products"), { method: "PUT", body: JSON.stringify({ products }) });
        if (!isCurrent("detail", id)) return;
        applyRecord(payload);
        if (!master.created) showBanner(page(), "obDetailError", `The store already had a master for this garment: ${master.title}. The row now copies from it.`, "ok");
        api(`${API}/garments`)
          .then((more) => {
            state.garments = list(more?.garments);
          })
          .catch(() => {});
      },
      page(),
      "obDetailError"
    );
  }

  // Add a colour to FN's list under a code (the proposed one, or one Dan
  // types), then every row is checked again.
  function approveColor(button) {
    const id = state.record?.id;
    const color = button.dataset.obColor;
    let code = button.dataset.obCode;
    if (!id || !color) return;
    if (!code) {
      const typed = window.prompt(`Colour code for "${color}" — 2 to 4 letters, like NVY for Navy or DKN for Dark Navy:`, "");
      if (typed === null) return;
      code = typed.trim().toUpperCase();
      if (!/^[A-Z0-9_]{2,4}$/.test(code)) {
        fail(`"${typed}" is not a colour code — use 2 to 4 letters or digits.`);
        return;
      }
    } else if (!window.confirm(`Add "${color}" to FN's Color Code List as ${code}?\n\nIt goes into every SKU for this colour, in every store.`)) {
      return;
    }
    return runSimple(button, "Adding…", "/colors/propose", { color, code, by: currentOperator() });
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

  async function uploadFiles(input, kindOverride) {
    const id = state.record?.id;
    const files = [...input.files];
    if (!id || !files.length) return;
    const kind = kindOverride || input.dataset.obUpload;
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    body.append("kind", kind);
    if (input.dataset.obProductId) body.append("productId", input.dataset.obProductId);
    if (input.dataset.obColor) body.append("color", input.dataset.obColor);
    if (input.dataset.obFace) body.append("face", input.dataset.obFace);
    if (input.dataset.obDecorationcode) body.append("decorationCode", input.dataset.obDecorationcode);
    input.disabled = true;
    // A policy PDF is read and artwork is described on upload, which takes a
    // few seconds; without this the zone looked like nothing had happened.
    const title = input.closest(".dropzone")?.querySelector(".dz-title");
    const before = title?.innerHTML;
    if (title) title.textContent = `Uploading ${files.length} file${plural(files.length, "", "s")}…`;
    try {
      const payload = await api(recordPath(id, "/files"), { method: "POST", body });
      if (!isCurrent("detail", id)) return;
      applyRecord(payload);
    } catch (error) {
      input.disabled = false;
      input.value = "";
      if (title && before !== undefined) title.innerHTML = before;
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
    if (buildState !== "running" && buildState !== "starting") return;
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
          const nowRunning = next.build?.state === "running" || next.build?.state === "starting";
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
    state.step = null;
    state.healthStep = null;
    // A notice belongs to the page it answered; the menu's health is kept.
    state.menuNotice = null;
    state.menuError = "";
    if (view === "detail") {
      // The banner sits on the record page too (renderList reads it itself).
      loadMenuHealth();
      // A deep link opens the detail view without the list ever rendering, so
      // the capabilities it reads (can Locksmith be called? is the menu
      // writable?) are fetched here too. Failure is not fatal: the card falls
      // back to the checklist wording.
      // The store's garments for "pick a garment" on the product rows.
      if (!state.garments) {
        api(`${API}/garments`)
          .then((payload) => {
            state.garments = list(payload?.garments);
            if (isCurrent("detail", id) && state.record && state.step === "products") renderDetail();
          })
          .catch(() => {
            // Left unset so the next visit tries again; the lookup still works.
            state.garments = null;
          });
      }
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

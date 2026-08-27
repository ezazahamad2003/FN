/* -----------------------------------------------------------------------------
   Customer store intake.

   A four-step wizard over the FN store build form. The schema is deliberately
   identical to customerIntakes.js on the server — every category carries the
   same fixed fields, so the build agent never has to special-case a category.

   Three things this does beyond rendering inputs:
     • validates per step, so a customer finds a problem on the step that caused
       it instead of at submit;
     • autosaves a draft to localStorage (files excluded — the browser will not
       let us re-populate a file input), so a half-finished form survives a
       closed tab;
     • shows the real placement diagrams next to the placement picker, because
       "Center back" means nothing to someone who hasn't seen the production
       standard.
   -------------------------------------------------------------------------- */

const CATEGORIES = [
  { key: "t-shirts", title: "T-Shirts", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "long-sleeve-shirts", title: "Long Sleeve Shirts", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "crewneck-sweatshirts", title: "Crewneck Sweatshirts", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "hooded-sweatshirts", title: "Hooded Sweatshirts", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "jackets-job-shirts", title: "Jackets / Job Shirts", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "polos", title: "Polos", placements: ["Front left chest", "Center back", "Left sleeve", "Right sleeve"], decorated: true },
  { key: "shorts", title: "Shorts", placements: ["Left leg", "Right leg"], decorated: true },
  { key: "sweatpants", title: "Sweatpants", placements: ["Left leg", "Right leg"], decorated: true },
  { key: "class-b-uniform-shirt", title: "Class B Uniform Shirt", placements: ["Left sleeve", "Right sleeve", "Both sleeves"], decorated: true },
  { key: "class-b-uniform-pants", title: "Class B Uniform Pants", placements: [], decorated: false },
  { key: "belts", title: "Belts", placements: [], decorated: false, belt: true },
  { key: "hats", title: "Hats", placements: ["Front center", "Side"], decorated: true }
];

const METHODS = ["Embroidery", "Screen Print", "Heat Transfer", "Patch", "None"];
const TIERS = ["Small", "Standard", "Large / Full Back", "Custom"];
const SIZES = ["S-3XL", "S-5XL", "Youth sizes", "Women's cut", "Other"];
const DRAFT_KEY = "fnIntakeDraft";

// Wholesale houses departments actually buy from. The field is a free-text
// input with these as suggestions - any vendor name works, and naming one
// sends our sourcing agent to that vendor's catalog for the exact product
// photo used in your store mockups.
const VENDORS = [
  "Next Level Apparel", "Bella+Canvas", "Gildan", "Comfort Colors",
  "Port & Company", "Sport-Tek", "District", "Carhartt", "Richardson",
  "Flexfit", "SanMar", "S&S Activewear", "alphabroder", "Augusta Sportswear",
  "5.11 Tactical", "Flying Cross", "Elbeco", "Game Sportswear", "Snap 'n' Wear"
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

function options(items, selected = "") {
  return '<option value="">Select…</option>' + items.map((item) =>
    '<option value="' + esc(item) + '"' + (item === selected ? " selected" : "") + ">" + esc(item) + "</option>").join("");
}

/* ── Category cards ──────────────────────────────────────────────────────── */

function categoryHtml(category) {
  const placement = category.placements?.length
    ? '<label class="field">Placement <em class="req">Required</em><select name="placement">' + options(category.placements) + "</select>" +
      '<small class="hint">See the diagrams above for exactly where this lands.</small></label>'
    : "";

  const decorated = category.decorated
    ? '<label class="field">Decoration method <em class="req">Required</em><select name="decorationMethod">' + options(METHODS) + "</select></label>" +
      '<label class="field">Decoration size tier<select name="sizeTier">' + options(TIERS) + "</select>" +
      '<small class="hint">Small ~4″ · Standard ~6″ · Large ~8–10″</small></label>' +
      '<label class="field custom-tier" hidden>Custom size / dimensions<input name="customSizeTier" placeholder="Example: 3.5 inch sleeve patch"></label>' +
      placement +
      '<label class="field">Which logo?<select name="logoChoice"><option value="department">Use our main department logo</option><option value="additional">Use a specific uploaded logo</option></select></label>' +
      '<label class="field">Logo notes<input name="logoNotes" placeholder="Example: use station-7.png for this garment"></label>' +
      '<label class="field">Name / rank on right chest?<select name="nameRank"><option value="">Select…</option><option value="yes">Yes</option><option value="no">No</option></select></label>'
    : "";

  const style = category.belt
    ? '<label class="field">Belt style <em class="req">Required</em><input name="beltStyle" placeholder="Basket weave leather, flat leather, or a style number"></label>'
    : '<div class="vendor-row">' +
      '<label class="field">Vendor / brand<input name="vendor" list="fnVendors" placeholder="Next Level, Carhartt, Richardson…">' +
      '<small class="hint">Name a vendor and we pull the exact product photo from their catalog for your mockups.</small></label>' +
      '<label class="field">Style number<input name="styleNumber" placeholder="NL3600, CTK121, 112…"></label>' +
      "</div>" +
      '<label class="field">Color(s) <em class="req">Required</em><input name="colors" placeholder="Navy, black, gray…"></label>' +
      '<label class="field">Other style notes<input name="style" placeholder="Anything else about the cut or style"></label>';

  const size = category.belt
    ? ""
    : '<label class="field">Size range <em class="req">Required</em><select name="sizeRange">' + options(SIZES) + "</select></label>" +
      '<label class="field other-sizes" hidden>Other sizes<input name="otherSizes" placeholder="Comma-separated sizes"></label>';

  return '<article class="customer-category" data-category="' + esc(category.key) + '">' +
    '<header><label class="toggle-line"><input type="checkbox" name="include"> <span>' + esc(category.title) + "</span></label>" +
    "<small>" + (category.decorated ? "Decoration and sizing options open when selected." : "Short form — no decoration fields.") + "</small></header>" +
    '<div class="category-fields" hidden>' + style + decorated + size +
    '<label class="field">Notes<input name="notes" placeholder="Optional details"></label></div></article>';
}

function renderCategories() {
  $("#customerCategories").innerHTML =
    '<datalist id="fnVendors">' + VENDORS.map((vendor) => '<option value="' + esc(vendor) + '">').join("") + "</datalist>" +
    CATEGORIES.map(categoryHtml).join("");
}

function updateCategoryState(card) {
  const active = $('[name="include"]', card).checked;
  $(".category-fields", card).hidden = !active;
  card.dataset.on = String(active);
}

function selectedCategories() {
  return $$(".customer-category").map((card) => {
    const value = {
      key: card.dataset.category,
      title: CATEGORIES.find((item) => item.key === card.dataset.category)?.title || card.dataset.category
    };
    $$("input, select", card).forEach((input) => {
      if (input.name === "include") value.include = input.checked;
      else value[input.name] = input.value.trim();
    });
    return value;
  });
}

function includedCategories() {
  return selectedCategories().filter((category) => category.include);
}

function updateCategoryCount() {
  const count = includedCategories().length;
  $("#categoryCount").textContent = count === 1 ? "1 selected" : count + " selected";
}

/* ── Logo files ──────────────────────────────────────────────────────────── */

// A DataTransfer is the only way to keep an accumulating file list on an
// <input type=file>: assigning .files replaces, so we rebuild it each time.
const logoBag = new DataTransfer();

function syncLogoInput() {
  $("#customerLogos").files = logoBag.files;
  renderLogoList();
}

function addLogoFiles(files) {
  const existing = new Set([...logoBag.files].map((file) => file.name + ":" + file.size));
  for (const file of files) {
    if (logoBag.files.length >= 20) break;
    const key = file.name + ":" + file.size;
    // Register as we add, so two identical files inside ONE drop/selection
    // don't both slip past a set built before the loop started.
    if (!existing.has(key)) {
      existing.add(key);
      logoBag.items.add(file);
    }
  }
  syncLogoInput();
  // The "upload at least one logo" error is an instruction; once followed it
  // must not keep scolding.
  if (logoBag.files.length) {
    const error = $("#logoError");
    error.hidden = true;
    error.textContent = "";
  }
}

function renderLogoList() {
  const files = [...logoBag.files];
  $("#logoDrop").dataset.hasFiles = String(files.length > 0);
  $("#customerLogoList").innerHTML = files.map((file, index) =>
    '<span class="chip"><span class="chip-name">' + esc(file.name) + "</span>" +
    '<span class="chip-size">' + Math.max(1, Math.ceil(file.size / 1024)) + " KB</span>" +
    '<button type="button" class="file-remove" data-remove="' + index + '" aria-label="Remove ' + esc(file.name) + '">&times;</button></span>').join("");
}

/* ── Draft autosave ──────────────────────────────────────────────────────── */

function storeFields() {
  const data = new FormData($("#customerIntakeForm"));
  return {
    departmentName: data.get("departmentName"),
    departmentCode: data.get("departmentCode"),
    contactName: data.get("contactName"),
    contactEmail: data.get("contactEmail"),
    contactPhone: data.get("contactPhone"),
    neededBy: data.get("neededBy"),
    notes: data.get("notes")
  };
}

let saveTimer = null;
function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ store: storeFields(), categories: selectedCategories() }));
      const note = $("#saveNote");
      note.textContent = "Draft saved";
      note.dataset.on = "true";
      setTimeout(() => { note.dataset.on = "false"; }, 1800);
    } catch {
      /* storage unavailable — the form still works, it just won't survive a reload */
    }
  }, 400);
}

function restoreDraft() {
  let draft;
  try {
    draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
  } catch {
    return;
  }
  if (!draft) return;

  for (const [name, value] of Object.entries(draft.store || {})) {
    const input = $('[name="' + name + '"]', $("#customerIntakeForm"));
    if (input && value) input.value = value;
  }
  for (const saved of draft.categories || []) {
    const card = $('.customer-category[data-category="' + saved.key + '"]');
    if (!card) continue;
    $$("input, select", card).forEach((input) => {
      if (input.name === "include") input.checked = Boolean(saved.include);
      else if (saved[input.name]) input.value = saved[input.name];
    });
    updateCategoryState(card);
    refreshConditionals(card);
  }
  updateCategoryCount();
}

function refreshConditionals(card) {
  const sizeRange = $('[name="sizeRange"]', card);
  const otherSizes = $(".other-sizes", card);
  if (sizeRange && otherSizes) otherSizes.hidden = sizeRange.value !== "Other";
  const sizeTier = $('[name="sizeTier"]', card);
  const customTier = $(".custom-tier", card);
  if (sizeTier && customTier) customTier.hidden = sizeTier.value !== "Custom";
}

/* ── Wizard ──────────────────────────────────────────────────────────────── */

let currentStep = 1;
let furthestStep = 1;
const TOTAL_STEPS = 4;

function showStep(step) {
  currentStep = step;
  furthestStep = Math.max(furthestStep, step);
  $$(".wizard-step").forEach((section) => {
    section.hidden = Number(section.dataset.step) !== step;
  });
  $$("#wizardRail li").forEach((item) => {
    const value = Number(item.dataset.step);
    item.dataset.state = value === step ? "current" : value < step ? "done" : "todo";
    $("button", item).disabled = value > furthestStep;
  });
  if (step === TOTAL_STEPS) renderReview();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function markInvalid(input, message) {
  input.setAttribute("aria-invalid", "true");
  const field = input.closest(".field");
  if (field && !$(".field-error", field)) {
    const node = document.createElement("small");
    node.className = "field-error";
    node.textContent = message;
    field.appendChild(node);
  }
}

function clearInvalid(scope) {
  $$("[aria-invalid]", scope).forEach((input) => input.removeAttribute("aria-invalid"));
  $$(".field .field-error", scope).forEach((node) => node.remove());
}

function validateStep(step) {
  const section = $('.wizard-step[data-step="' + step + '"]');
  clearInvalid(section);
  let firstBad = null;

  if (step === 1) {
    for (const input of $$("input[required]", section)) {
      if (!input.value.trim()) {
        markInvalid(input, "This field is required.");
        firstBad = firstBad || input;
      } else if (input.type === "email" && !input.checkValidity()) {
        markInvalid(input, "Enter a valid email address.");
        firstBad = firstBad || input;
      }
    }
  }

  if (step === 2) {
    const error = $("#logoError");
    const ok = logoBag.files.length > 0;
    error.hidden = ok;
    error.textContent = ok ? "" : "Upload at least one logo file so we can decorate your garments.";
    if (!ok) firstBad = $("#logoDrop");
  }

  if (step === 3) {
    const included = includedCategories();
    const error = $("#categoryError");
    if (!included.length) {
      error.hidden = false;
      error.textContent = "Select at least one garment category for the store.";
      firstBad = $("#customerCategories");
    } else {
      error.hidden = true;
      for (const category of included) {
        const definition = CATEGORIES.find((item) => item.key === category.key) || {};
        const card = $('.customer-category[data-category="' + category.key + '"]');
        const need = [];
        if (definition.belt) need.push("beltStyle");
        else {
          need.push("colors", "sizeRange");
          if (definition.decorated) {
            need.push("decorationMethod");
            if (definition.placements?.length) need.push("placement");
          }
        }
        for (const name of need) {
          const input = $('[name="' + name + '"]', card);
          if (input && !input.value.trim()) {
            markInvalid(input, "Required for " + definition.title + ".");
            firstBad = firstBad || input;
          }
        }
      }
    }
  }

  if (firstBad) {
    firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
    if (firstBad.focus) firstBad.focus({ preventScroll: true });
    return false;
  }
  return true;
}

/* ── Review ──────────────────────────────────────────────────────────────── */

function reviewRow(label, value) {
  return '<div class="rr"><span>' + esc(label) + "</span><b>" + (value ? esc(value) : '<i class="rr-empty">Not provided</i>') + "</b></div>";
}

function renderReview() {
  const store = storeFields();
  const included = includedCategories();

  const detail = (category) => {
    const definition = CATEGORIES.find((item) => item.key === category.key) || {};
    if (definition.belt) return [category.beltStyle].filter(Boolean).join(" · ");
    const vendorBit = [category.vendor, category.styleNumber].filter(Boolean).join(" ");
    const parts = [vendorBit, category.colors, category.style, category.decorationMethod, category.placement,
      category.sizeTier === "Custom" ? category.customSizeTier : category.sizeTier,
      category.sizeRange === "Other" ? category.otherSizes : category.sizeRange];
    return parts.filter(Boolean).join(" · ");
  };

  $("#reviewPanel").innerHTML =
    '<div class="review-block"><h3>Department</h3>' +
    reviewRow("Name", store.departmentName) +
    reviewRow("Code", store.departmentCode) +
    reviewRow("Contact", [store.contactName, store.contactEmail].filter(Boolean).join(" · ")) +
    reviewRow("Phone", store.contactPhone) +
    reviewRow("Needed by", store.neededBy) +
    reviewRow("Notes", store.notes) +
    '<button type="button" class="btn btn-ghost btn-sm" data-goto="1">Edit</button></div>' +

    '<div class="review-block"><h3>Artwork · ' + logoBag.files.length + " file" + (logoBag.files.length === 1 ? "" : "s") + "</h3>" +
    '<div class="chips">' + [...logoBag.files].map((file) => '<span class="chip"><span class="chip-name">' + esc(file.name) + "</span></span>").join("") + "</div>" +
    '<button type="button" class="btn btn-ghost btn-sm" data-goto="2">Edit</button></div>' +

    '<div class="review-block"><h3>Garments · ' + included.length + "</h3>" +
    included.map((category) => '<div class="rr"><span>' + esc(category.title) + "</span><b>" + esc(detail(category)) + "</b></div>").join("") +
    '<button type="button" class="btn btn-ghost btn-sm" data-goto="3">Edit</button></div>';
}

/* ── Submit ──────────────────────────────────────────────────────────────── */

function payloadFromForm() {
  const store = storeFields();
  return { store, customerNotes: store.notes, categories: selectedCategories() };
}

function setSubmitState(kind, message) {
  const panel = $("#customerSubmitPanel");
  panel.dataset.state = kind;
  let node = $("#customerResult");
  if (!node) {
    node = document.createElement("p");
    node.id = "customerResult";
    node.className = "customer-result";
    panel.appendChild(node);
  }
  node.textContent = message;
}

function renderSuccess(payload) {
  const building = payload.buildStarted
    ? "<p>Your store is <b>building right now</b> — our agent is sourcing each garment from your chosen vendors, placing your artwork, and assembling the products.</p>"
    : payload.collection
      ? "<p>Your store collection <b>" + esc(payload.collection.title || payload.departmentName) + "</b> has been created and is queued for build.</p>"
      : "<p>Our team will start your store build shortly.</p>";
  $("#main").innerHTML =
    '<section class="card card-pad intake-done">' +
    '<span class="done-mark" aria-hidden="true">' +
    '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>' +
    "<h1>Request received</h1>" +
    "<p>Thanks, " + esc(payload.contactName || "") + ". Reference <b>" + esc(String(payload.requestId || "").slice(0, 8).toUpperCase()) + "</b>.</p>" +
    building +
    "<p class='muted'>Nothing goes live without review: our team checks every product, image, price, and size before publishing. We'll email <b>" +
    esc(payload.contactEmail || "you") + "</b> when the store is ready to approve.</p>" +
    '<a class="btn btn-ghost" href="/intake">Submit another department</a></section>';
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── Wiring ──────────────────────────────────────────────────────────────── */

renderCategories();
restoreDraft();
showStep(1);

$("#logoDrop").addEventListener("click", () => $("#customerLogos").click());
$("#logoDrop").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    $("#customerLogos").click();
  }
});
$("#logoDrop").addEventListener("dragover", (event) => {
  event.preventDefault();
  $("#logoDrop").dataset.drag = "true";
});
$("#logoDrop").addEventListener("dragleave", () => { $("#logoDrop").dataset.drag = "false"; });
$("#logoDrop").addEventListener("drop", (event) => {
  event.preventDefault();
  $("#logoDrop").dataset.drag = "false";
  addLogoFiles(event.dataTransfer.files);
});
$("#customerLogos").addEventListener("change", (event) => {
  addLogoFiles(event.target.files);
});
$("#customerLogoList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  logoBag.items.remove(Number(button.dataset.remove));
  syncLogoInput();
});

document.addEventListener("change", (event) => {
  const card = event.target.closest(".customer-category");
  if (card) {
    if (event.target.name === "include") updateCategoryState(card);
    refreshConditionals(card);
    updateCategoryCount();
  }
  if (event.target.closest("#customerIntakeForm")) saveDraft();
});
document.addEventListener("input", (event) => {
  if (event.target.closest("#customerIntakeForm")) saveDraft();
});

document.addEventListener("click", (event) => {
  const next = event.target.closest("[data-next]");
  if (next && validateStep(currentStep)) showStep(Math.min(TOTAL_STEPS, currentStep + 1));

  const back = event.target.closest("[data-back]");
  if (back) showStep(Math.max(1, currentStep - 1));

  const goto = event.target.closest("[data-goto]");
  if (goto) showStep(Number(goto.dataset.goto));

  const rail = event.target.closest("#wizardRail button");
  if (rail) {
    const target = Number(rail.closest("li").dataset.step);
    if (target <= furthestStep) showStep(target);
  }

  const zoom = event.target.closest("[data-zoom]");
  if (zoom) {
    lightboxOpener = zoom;
    $("#refLightboxImg").src = zoom.dataset.zoom;
    $("#refLightboxImg").alt = $("img", zoom)?.alt || "";
    $("#refLightbox").hidden = false;
    $("#refLightboxClose").focus();
  }

  if (event.target.closest("#refLightboxClose") || event.target.id === "refLightbox") {
    closeLightbox();
  }
});

let lightboxOpener = null;
function closeLightbox() {
  $("#refLightbox").hidden = true;
  // Hand keyboard focus back to the diagram that opened the overlay instead of
  // dropping it at the top of the document.
  if (lightboxOpener) {
    lightboxOpener.focus();
    lightboxOpener = null;
  }
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#refLightbox").hidden) closeLightbox();
});

$("#customerIntakeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  // Enter inside a text field fires an implicit submit. Before the review
  // step that gesture means "next", never "send the whole request to FN".
  if (currentStep !== TOTAL_STEPS) {
    if (validateStep(currentStep)) showStep(Math.min(TOTAL_STEPS, currentStep + 1));
    return;
  }
  for (let step = 1; step <= 3; step++) {
    if (!validateStep(step)) {
      showStep(step);
      return;
    }
  }

  const button = $("#customerSubmitButton");
  const body = new FormData();
  body.append("payload", JSON.stringify(payloadFromForm()));
  [...logoBag.files].forEach((file) => body.append("logos", file));

  button.disabled = true;
  button.textContent = "Submitting…";
  setSubmitState("running", "Sending your store package to FN…");

  try {
    const res = await fetch("/api/customer-intakes", { method: "POST", body });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Submission failed.");
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* nothing to clear */
    }
    const store = storeFields();
    renderSuccess({ ...payload, contactName: store.contactName, contactEmail: store.contactEmail });
  } catch (error) {
    setSubmitState("error", error.message);
    button.disabled = false;
    button.textContent = "Submit store request";
  }
});

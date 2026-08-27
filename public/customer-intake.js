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
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}
function options(items, selected = "") {
  return '<option value="">Select</option>' + items.map((item) => '<option value="' + esc(item) + '"' + (item === selected ? ' selected' : '') + '>' + esc(item) + '</option>').join('');
}
function categoryHtml(category) {
  const placement = category.placements?.length ? '<label>Placement<select name="placement">' + options(category.placements) + '</select></label>' : '';
  const decorated = category.decorated ? '<label>Decoration method<select name="decorationMethod">' + options(METHODS) + '</select></label>' +
    '<label>Decoration size tier<select name="sizeTier">' + options(TIERS) + '</select></label>' +
    '<label class="custom-tier" hidden>Custom size / dimensions<input name="customSizeTier" placeholder="Example: 3.5 inch sleeve patch"></label>' +
    placement +
    '<label>Logo choice<select name="logoChoice"><option value="department">Use department logo</option><option value="additional">Use additional/specific logo</option></select></label>' +
    '<label>Logo notes<input name="logoNotes" placeholder="Example: station patch for this garment"></label>' +
    '<label>Name/rank on right chest?<select name="nameRank"><option value="">Select</option><option value="yes">Yes</option><option value="no">No</option></select></label>' : '';
  const style = category.belt
    ? '<label>Belt style<input name="beltStyle" placeholder="Basket weave leather, flat leather, or style number"></label>'
    : '<label>Style / catalog preference<input name="style" placeholder="FN approved catalog style or known style number"></label><label>Color(s)<input name="colors" placeholder="Navy, black, gray..."></label>';
  const size = category.belt ? '' : '<label>Size range<select name="sizeRange">' + options(SIZES) + '</select></label><label class="other-sizes" hidden>Other sizes<input name="otherSizes" placeholder="Comma-separated sizes"></label>';
  return '<article class="customer-category" data-category="' + esc(category.key) + '">' +
    '<header><label class="toggle-line"><input type="checkbox" name="include"> <span>' + esc(category.title) + '</span></label>' +
    '<small>' + (category.decorated ? 'Decoration and sizing fields appear when selected.' : 'Shortened fixed-field schema.') + '</small></header>' +
    '<div class="category-fields" hidden>' + style + decorated + size + '<label>Notes<input name="notes" placeholder="Optional details"></label></div></article>';
}
function renderCategories() {
  $('#customerCategories').innerHTML = CATEGORIES.map(categoryHtml).join('');
}
function updateCategoryState(card) {
  const active = $('[name="include"]', card).checked;
  $('.category-fields', card).hidden = !active;
}
function selectedCategories() {
  return $$('.customer-category').map((card) => {
    const value = { key: card.dataset.category, title: CATEGORIES.find((item) => item.key === card.dataset.category)?.title || card.dataset.category };
    $$('input, select', card).forEach((input) => {
      if (input.name === 'include') value.include = input.checked;
      else value[input.name] = input.value.trim();
    });
    return value;
  });
}
function updateLogoList() {
  const files = [...$('#customerLogos').files];
  $('#customerLogoList').innerHTML = files.map((file) => '<span class="chip"><span class="chip-name">' + esc(file.name) + '</span><span class="chip-size">' + Math.ceil(file.size / 1024) + ' KB</span></span>').join('');
}
function payloadFromForm(form) {
  const data = new FormData(form);
  return {
    store: {
      departmentName: data.get('departmentName'),
      departmentCode: data.get('departmentCode'),
      contactName: data.get('contactName'),
      contactEmail: data.get('contactEmail'),
      contactPhone: data.get('contactPhone'),
      neededBy: data.get('neededBy'),
      notes: data.get('notes')
    },
    customerNotes: data.get('notes'),
    categories: selectedCategories()
  };
}
function setSubmitState(kind, message) {
  const panel = $('#customerSubmitPanel');
  panel.dataset.state = kind;
  let node = $('#customerResult');
  if (!node) {
    node = document.createElement('p');
    node.id = 'customerResult';
    node.className = 'customer-result';
    panel.appendChild(node);
  }
  node.textContent = message;
}
renderCategories();
$('#customerLogos').addEventListener('change', updateLogoList);
document.addEventListener('change', (event) => {
  const card = event.target.closest('.customer-category');
  if (!card) return;
  if (event.target.name === 'include') updateCategoryState(card);
  if (event.target.name === 'sizeRange') $('.other-sizes', card).hidden = event.target.value !== 'Other';
  if (event.target.name === 'sizeTier') $('.custom-tier', card).hidden = event.target.value !== 'Custom';
});
$('#customerIntakeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#customerSubmitButton');
  if (!form.reportValidity()) return;
  if (![...$('#customerLogos').files].length) {
    setSubmitState('error', 'Upload at least one logo file.');
    return;
  }
  const included = selectedCategories().filter((category) => category.include);
  if (!included.length) {
    setSubmitState('error', 'Select at least one garment category for the store.');
    return;
  }
  const body = new FormData();
  body.append('payload', JSON.stringify(payloadFromForm(form)));
  [...$('#customerLogos').files].forEach((file) => body.append('logos', file));
  button.disabled = true;
  button.textContent = 'Submitting...';
  setSubmitState('running', 'Sending the store package to FN.');
  try {
    const res = await fetch('/api/customer-intakes', { method: 'POST', body });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || 'Submission failed.');
    const collectionText = payload.collection ? ' Shopify collection created for ' + payload.departmentName + '.' : ' FN will review the collection status.';
    setSubmitState('success', 'Submitted. Request ' + payload.requestId.slice(0, 8) + ' is in FN review.' + collectionText);
    form.reset();
    updateLogoList();
    $$('.customer-category').forEach(updateCategoryState);
  } catch (error) {
    setSubmitState('error', error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Submit store request';
  }
});

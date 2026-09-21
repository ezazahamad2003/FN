/*
 * Helium Customer Fields for the Department Onboarding Agent (Build Spec
 * §8c "Helium Customer Fields" and §8b "Shopify Flow").
 *
 * Helium has no API for editing forms, and Shopify Flow has none for editing
 * workflows, so both are checklists Dan works through. What the platform CAN
 * do is read Helium's public form JSON
 *   https://app.customerfields.com/embed_api/v4/forms/<id>.json?shop=<store>
 * and check whether the department tag is already an option on the
 * Department field, and exactly where (alphabetically) it must be inserted.
 * That turns "add the tag in alphabetical order" into a precise sentence:
 * insert exactly 'X' between 'A' and 'B'.
 *
 * Which forms to read comes from HELIUM_FORMS ("K7tlqn:Registration,…").
 * Forms whose JSON is not public simply report public:false — never a thrown
 * error out of a build step. Nothing here logs; callers pass onLog.
 */

const rules = require("./onboardingRules");

const BASE_URL = "https://app.customerfields.com/embed_api/v4/forms";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_ERROR_BODY = 500;

// §8c names the three forms that must all carry the tag.
const EXPECTED_FORM_LABELS = ["Edit Account", "Registration", "Registration backup copy"];
const DEFAULT_FORMS = [{ id: "K7tlqn", label: "Registration" }];

// The Department field: by label, or by the customer column Helium maps it to.
const DEPARTMENT_FIELD_LABEL = "Department";
const DEPARTMENT_FIELD_KEY = "default_address.company";

// §8b — the flow and the step names, verbatim.
const FLOW_NAME = "Email newly created shop customers without department tags";
const FLOW_LAST_STEP = "Send transactional email";

/* ---------------------------------------------------------------------------
   Configuration
   ------------------------------------------------------------------------- */

let fetchImpl = null;

// Tests inject a fake; production uses Node 22's global fetch.
function setFetch(fn) {
  fetchImpl = fn;
}

function getFetch() {
  const fn = fetchImpl || globalThis.fetch;
  if (!fn) throw new Error("Node 18+ fetch is required to read Helium forms.");
  return fn;
}

/*
 * HELIUM_FORMS = "K7tlqn:Registration,abc123:Edit Account" → [{ id, label }].
 * An entry without a label is labelled by its id. Empty → the registration
 * form the spec documents.
 */
function configuredForms(env = process.env.HELIUM_FORMS) {
  const out = [];
  for (const entry of String(env || "").split(",")) {
    const raw = entry.trim();
    if (!raw) continue;
    const at = raw.indexOf(":");
    const id = (at === -1 ? raw : raw.slice(0, at)).trim();
    const label = (at === -1 ? "" : raw.slice(at + 1)).trim() || id;
    if (!id || out.some((f) => f.id === id)) continue;
    out.push({ id, label });
  }
  return out.length ? out : DEFAULT_FORMS.map((f) => ({ ...f }));
}

/* ---------------------------------------------------------------------------
   Reading a form
   ------------------------------------------------------------------------- */

function timeoutSignal() {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
}

function formUrl(formId, shop) {
  return `${BASE_URL}/${encodeURIComponent(String(formId))}.json?shop=${encodeURIComponent(String(shop || ""))}`;
}

function normalizeOption(option) {
  if (option == null) return null;
  if (typeof option !== "object") {
    const s = String(option);
    return { label: s, value: s };
  }
  const value = option.value != null ? String(option.value) : option.label != null ? String(option.label) : option.name != null ? String(option.name) : "";
  const label = option.label != null ? String(option.label) : option.name != null ? String(option.name) : value;
  if (!value && !label) return null;
  return { label, value: value || label };
}

function fieldKey(field) {
  const column = field.dataColumn || field.data_column || null;
  if (column && column.key) return String(column.key);
  if (typeof field.key === "string") return field.key;
  return "";
}

function normalizeField(field) {
  return {
    id: field.id != null ? String(field.id) : fieldKey(field),
    label: String(field.label || field.name || "").trim(),
    key: fieldKey(field),
    type: String(field.type || field.field_type || "")
  };
}

function isDepartmentField(field) {
  const label = String(field.label || field.name || "").trim().toLowerCase();
  return label === DEPARTMENT_FIELD_LABEL.toLowerCase() || fieldKey(field) === DEPARTMENT_FIELD_KEY;
}

function departmentOptions(field) {
  const raw = Array.isArray(field.enum) && field.enum.length ? field.enum : field.settings && Array.isArray(field.settings.options) ? field.settings.options : [];
  return raw.map(normalizeOption).filter(Boolean);
}

/*
 * Shape a Helium form document into what the checker needs. Field lists live
 * at revision.fields in the v4 embed JSON; older/other shapes are tolerated.
 */
function parseForm(data, formId) {
  const form = data && data.form && typeof data.form === "object" ? data.form : data || {};
  // In the live v4 embed JSON `revision` is a SIBLING of `form`, not a child of
  // it ({ form: {...}, revision: { fields: [...] } }); older shapes nested it,
  // so both are accepted — reading only form.revision silently found no fields
  // and reported every department as missing.
  const revisionSource = [data && data.revision, form.revision].find((r) => r && typeof r === "object");
  const revision = revisionSource || null;
  const rawFields = (revision && Array.isArray(revision.fields) && revision.fields) || (Array.isArray(form.fields) && form.fields) || (data && Array.isArray(data.fields) && data.fields) || [];
  const fields = rawFields.filter((f) => f && typeof f === "object");
  const dept = fields.find(isDepartmentField) || null;
  return {
    id: form.id != null ? String(form.id) : String(formId),
    name: String(form.name || form.title || form.label || ""),
    updatedAt: String(form.updated_at || form.updatedAt || (revision && (revision.updated_at || revision.created_at)) || ""),
    departmentField: dept
      ? {
          ...normalizeField(dept),
          autotag: Boolean(dept.settings && dept.settings.autotag),
          options: departmentOptions(dept)
        }
      : null,
    fields: fields.map(normalizeField)
  };
}

async function readForm(formId, { shop = process.env.SHOPIFY_STORE } = {}) {
  const id = String(formId || "").trim();
  if (!id) throw new Error("A Helium form id is required.");
  const url = formUrl(id, shop);
  let res;
  try {
    res = await getFetch()(url, { method: "GET", headers: { accept: "application/json" }, signal: timeoutSignal() });
  } catch (error) {
    const wrapped = new Error(`Helium form ${id} could not be read: ${error.message}`);
    wrapped.cause = error;
    throw wrapped;
  }
  const text = await res.text();
  if (res.status !== 200) {
    const error = new Error(`Helium form ${id} returned ${res.status}: ${text.slice(0, MAX_ERROR_BODY)}`);
    error.status = res.status;
    error.body = text.slice(0, MAX_ERROR_BODY);
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const wrapped = new Error(`Helium form ${id} returned non-JSON: ${text.slice(0, MAX_ERROR_BODY)}`);
    wrapped.status = res.status;
    throw wrapped;
  }
  return parseForm(data, id);
}

/* ---------------------------------------------------------------------------
   Checking a tag against a form (pure)
   ------------------------------------------------------------------------- */

function collapse(s) {
  return String(s == null ? "" : s).trim().replace(/\s+/g, " ");
}

/*
 * Is the department tag an option on the form's Department field, and if not,
 * where does it go? Matching is on option VALUES because the value is what
 * Helium writes as the customer tag (autotag), and the tag is case-sensitive:
 * a case-insensitive hit is reported as present but exactCase:false so Dan
 * fixes the spelling instead of adding a near-duplicate.
 */
function checkDepartmentTag(form, tag) {
  const wanted = collapse(tag);
  const field = form && form.departmentField ? form.departmentField : form && Array.isArray(form.options) ? form : null;
  if (!wanted) {
    return { present: false, exactCase: false, index: -1, insertAfter: "", insertBefore: "", total: 0, similar: [], error: "Department tag is empty" };
  }
  if (!field) {
    return { present: false, exactCase: false, index: -1, insertAfter: "", insertBefore: "", total: 0, similar: [], error: "The form has no Department field" };
  }
  const options = (field.options || []).map(normalizeOption).filter(Boolean);
  const values = options.map((o) => o.value);
  const total = values.length;

  const firstWord = String((rules.significantWords(wanted)[0] || "")).toLowerCase();
  const similar = firstWord ? values.filter((v) => v !== wanted && v.toLowerCase().includes(firstWord)) : [];

  const exactIndex = values.indexOf(wanted);
  if (exactIndex !== -1) {
    return { present: true, exactCase: true, index: exactIndex, insertAfter: values[exactIndex - 1] || "", insertBefore: values[exactIndex + 1] || "", total, similar, matched: options[exactIndex] };
  }
  const looseIndex = values.findIndex((v) => collapse(v).toLowerCase() === wanted.toLowerCase());
  if (looseIndex !== -1) {
    return { present: true, exactCase: false, index: looseIndex, insertAfter: values[looseIndex - 1] || "", insertBefore: values[looseIndex + 1] || "", total, similar, matched: options[looseIndex] };
  }
  const index = rules.alphabeticalInsertIndex(values, wanted);
  return { present: false, exactCase: false, index, insertAfter: values[index - 1] || "", insertBefore: values[index] || "", total, similar };
}

/*
 * Read every configured form and check the tag. A form whose JSON is not
 * public (or is unreachable) becomes { public:false, error } — Dan still gets
 * the checklist, the platform just cannot verify that one.
 */
async function checkAllForms(tag, { forms = null, shop = process.env.SHOPIFY_STORE, onLog = null } = {}) {
  const log = typeof onLog === "function" ? onLog : () => {};
  const list = Array.isArray(forms) && forms.length ? forms : configuredForms();
  const out = [];
  for (const entry of list) {
    const checkedAt = new Date().toISOString();
    const id = String(entry.id || "").trim();
    const label = String(entry.label || id);
    try {
      const form = await readForm(id, { shop });
      const check = checkDepartmentTag(form, tag);
      out.push({ id, label, public: true, name: form.name, updatedAt: form.updatedAt, ...check, checkedAt });
      log(`Helium: ${label} (${id}) read — "${tag}" ${check.present ? (check.exactCase ? "is present" : "is present with different capitalisation") : `is missing; insert at position ${check.index + 1} of ${check.total + 1}`}.`);
    } catch (error) {
      out.push({ id, label, public: false, error: error.message, status: error.status || null, checkedAt });
      log(`Helium: ${label} (${id}) could not be read (${error.message}).`);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Checklists (§8c, §8b)
   ------------------------------------------------------------------------- */

function insertionSentence(tag, check) {
  if (!check || check.public === false) return "";
  if (check.error) return "";
  if (check.present && check.exactCase) {
    return `Already present as option ${check.index + 1} of ${check.total} — verify the spelling matches "${tag}" exactly and do not add it again.`;
  }
  if (check.present) {
    return `Present as "${check.matched ? check.matched.value : ""}" (option ${check.index + 1} of ${check.total}) but the capitalisation differs — correct it to exactly "${tag}" rather than adding a second option.`;
  }
  if (check.insertAfter && check.insertBefore) {
    return `Insert exactly '${tag}' between '${check.insertAfter}' and '${check.insertBefore}' (position ${check.index + 1} of ${check.total + 1}).`;
  }
  if (check.insertBefore) {
    return `Insert exactly '${tag}' at the top, before '${check.insertBefore}' (position 1 of ${check.total + 1}).`;
  }
  if (check.insertAfter) {
    return `Insert exactly '${tag}' at the end, after '${check.insertAfter}' (position ${check.index + 1} of ${check.total + 1}).`;
  }
  return `Insert exactly '${tag}' as the first option.`;
}

function sameForm(entry, label) {
  return String(entry.label || "").trim().toLowerCase() === label.toLowerCase();
}

/*
 * §8c steps for all three forms. `forms` is the checkAllForms() result; each
 * verified form gets its computed insertion sentence, forms the platform
 * could not read say so.
 */
function manualChecklist({ departmentTag, forms = [] }) {
  const tag = collapse(departmentTag);
  const checks = Array.isArray(forms) ? forms : [];
  const steps = [
    `Helium Customer Fields > Forms. Update all three forms: ${EXPECTED_FORM_LABELS[0]}, ${EXPECTED_FORM_LABELS[1]}, and the ${EXPECTED_FORM_LABELS[2]}.`
  ];
  const covered = new Set();
  for (const label of EXPECTED_FORM_LABELS) {
    const check = checks.find((c) => sameForm(c, label));
    if (check) covered.add(check);
    steps.push(formStep(label, tag, check));
  }
  for (const check of checks) {
    if (!covered.has(check)) steps.push(formStep(String(check.label || check.id), tag, check));
  }
  steps.push(
    "Why this matters: when a member registers and picks their department, Helium adds the tag to their account, and that tag unlocks the store in Locksmith. All three places must match exactly."
  );
  return steps;
}

function formStep(label, tag, check) {
  const base = `In ${label}: open the Department field, add the department tag exactly ("${tag}"), in alphabetical order. Save.`;
  if (!check) return `${base} (Not verified by the platform — this form's JSON is not configured; check the position by hand.)`;
  if (check.public === false) return `${base} (Not verified by the platform — the form could not be read: ${check.error || "not public"}.)`;
  const sentence = insertionSentence(tag, check);
  return sentence ? `${base} ${sentence}` : base;
}

// §8b verbatim, with the tag Dan must type.
function flowChecklist({ departmentTag }) {
  const tag = collapse(departmentTag);
  return [
    `Open the flow "${FLOW_NAME}" > Edit.`,
    `Open the Condition step (second-to-last, just before "${FLOW_LAST_STEP}").`,
    `At the bottom: Add criteria > tags_item > enter the department tag exactly ("${tag}") > Apply changes.`
  ];
}

module.exports = {
  BASE_URL,
  EXPECTED_FORM_LABELS,
  DEFAULT_FORMS,
  FLOW_NAME,
  FLOW_LAST_STEP,
  setFetch,
  configuredForms,
  formUrl,
  parseForm,
  readForm,
  checkDepartmentTag,
  checkAllForms,
  insertionSentence,
  manualChecklist,
  flowChecklist
};

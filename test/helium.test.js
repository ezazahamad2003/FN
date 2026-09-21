const test = require("node:test");
const assert = require("node:assert/strict");
const helium = require("../helium");

/* ---------------------------------------------------------------------------
   Fixture — the v4 embed JSON for a registration form: fields[1] is the
   Department field with six department names, already alphabetical.
   ------------------------------------------------------------------------- */

const DEPARTMENTS = [
  "Bishop Fire Department",
  "Cal Fire",
  "Hayward Fire Department",
  "Ripon Fire Department",
  "San Francisco Fire Department",
  "Vacaville Fire Department"
];

function registrationForm({ id = "K7tlqn", name = "Registration", departments = DEPARTMENTS } = {}) {
  return {
    form: {
      id,
      name,
      updated_at: "2026-09-10T18:22:11Z",
      revision: {
        id: 9876,
        fields: [
          { id: "f_email", type: "email", label: "Email", dataColumn: { key: "email" }, settings: { required: true } },
          {
            id: "f_department",
            type: "select",
            label: "Department",
            dataColumn: { key: "default_address.company" },
            settings: { autotag: true, required: true },
            enum: departments.map((d) => ({ label: d, value: d }))
          },
          { id: "f_first", type: "text", label: "First name", dataColumn: { key: "first_name" } }
        ]
      }
    }
  };
}

function jsonResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function fakeFetch(byId) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const m = String(url).match(/\/forms\/([^/?]+)\.json\?shop=([^&]*)/);
    const reply = m && byId[decodeURIComponent(m[1])];
    if (!reply) return jsonResponse(404, "Not Found");
    return typeof reply === "function" ? reply(decodeURIComponent(m[2])) : reply;
  };
  fn.calls = calls;
  return fn;
}

function withEnv(values, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(values)) {
    saved[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

test.afterEach(() => helium.setFetch(null));

/* ---------------------------------------------------------------------------
   Configuration
   ------------------------------------------------------------------------- */

test("configuredForms parses HELIUM_FORMS and falls back to the documented registration form", () => {
  assert.deepEqual(helium.configuredForms("K7tlqn:Registration,abc123:Edit Account"), [
    { id: "K7tlqn", label: "Registration" },
    { id: "abc123", label: "Edit Account" }
  ]);
  assert.deepEqual(helium.configuredForms(" K7tlqn : Registration , zz9 , , K7tlqn:Dup "), [
    { id: "K7tlqn", label: "Registration" },
    { id: "zz9", label: "zz9" }
  ]);
  assert.deepEqual(helium.configuredForms(""), [{ id: "K7tlqn", label: "Registration" }]);
  assert.deepEqual(helium.configuredForms(undefined), helium.DEFAULT_FORMS);
  assert.deepEqual(helium.EXPECTED_FORM_LABELS, ["Edit Account", "Registration", "Registration backup copy"]);
});

/* ---------------------------------------------------------------------------
   Reading
   ------------------------------------------------------------------------- */

test("readForm fetches the public form JSON and finds the Department field", async () => {
  const fetch = fakeFetch({ K7tlqn: jsonResponse(200, registrationForm()) });
  helium.setFetch(fetch);
  const form = await helium.readForm("K7tlqn", { shop: "fn-simple-uniforms.myshopify.com" });
  assert.equal(fetch.calls[0].url, "https://app.customerfields.com/embed_api/v4/forms/K7tlqn.json?shop=fn-simple-uniforms.myshopify.com");
  assert.equal(form.id, "K7tlqn");
  assert.equal(form.name, "Registration");
  assert.equal(form.updatedAt, "2026-09-10T18:22:11Z");
  assert.equal(form.fields.length, 3);
  assert.deepEqual(form.fields[0], { id: "f_email", label: "Email", key: "email", type: "email" });
  assert.equal(form.departmentField.id, "f_department");
  assert.equal(form.departmentField.label, "Department");
  assert.equal(form.departmentField.key, "default_address.company");
  assert.equal(form.departmentField.autotag, true);
  assert.deepEqual(form.departmentField.options.map((o) => o.value), DEPARTMENTS);
  assert.deepEqual(form.departmentField.options[0], { label: "Bishop Fire Department", value: "Bishop Fire Department" });
});

test("readForm uses SHOPIFY_STORE by default and tolerates other field shapes", async () => {
  await withEnv({ SHOPIFY_STORE: "fn-simple-uniforms.myshopify.com" }, async () => {
    const doc = {
      id: "abc123",
      title: "Edit Account",
      fields: [
        { key: "department", label: "department", settings: { options: ["Bishop Fire Department", { label: "Cal Fire", value: "Cal Fire" }] } }
      ]
    };
    const fetch = fakeFetch({ abc123: jsonResponse(200, doc) });
    helium.setFetch(fetch);
    const form = await helium.readForm("abc123");
    assert.match(fetch.calls[0].url, /shop=fn-simple-uniforms\.myshopify\.com$/);
    assert.equal(form.name, "Edit Account");
    assert.ok(form.departmentField, "label matches case-insensitively");
    assert.deepEqual(form.departmentField.options.map((o) => o.value), ["Bishop Fire Department", "Cal Fire"]);
    assert.equal(form.departmentField.autotag, false);
  });
});

test("readForm reports a form without a Department field as departmentField null", async () => {
  const doc = registrationForm();
  doc.form.revision.fields.splice(1, 1);
  helium.setFetch(fakeFetch({ K7tlqn: jsonResponse(200, doc) }));
  const form = await helium.readForm("K7tlqn", { shop: "s" });
  assert.equal(form.departmentField, null);
  assert.equal(form.fields.length, 2);
});

test("readForm throws with .status on non-200 and on unreadable bodies", async () => {
  helium.setFetch(fakeFetch({ priv: jsonResponse(403, "Forbidden") }));
  await assert.rejects(
    () => helium.readForm("priv", { shop: "s" }),
    (error) => error.status === 403 && /Helium form priv returned 403/.test(error.message) && error.body === "Forbidden"
  );
  await assert.rejects(() => helium.readForm("missing", { shop: "s" }), (error) => error.status === 404);
  helium.setFetch(fakeFetch({ html: jsonResponse(200, "<html>login</html>") }));
  await assert.rejects(() => helium.readForm("html", { shop: "s" }), /non-JSON/);
  helium.setFetch(async () => {
    throw new Error("ENOTFOUND");
  });
  await assert.rejects(() => helium.readForm("x", { shop: "s" }), /could not be read: ENOTFOUND/);
  await assert.rejects(() => helium.readForm("", { shop: "s" }), /form id is required/);
});

/* ---------------------------------------------------------------------------
   Checking (pure)
   ------------------------------------------------------------------------- */

const FORM = helium.parseForm(registrationForm(), "K7tlqn");

test("checkDepartmentTag finds an exact, case-sensitive match", () => {
  const r = helium.checkDepartmentTag(FORM, "Bishop Fire Department");
  assert.equal(r.present, true);
  assert.equal(r.exactCase, true);
  assert.equal(r.index, 0);
  assert.equal(r.total, 6);
  assert.equal(r.insertAfter, "");
  assert.equal(r.insertBefore, "Cal Fire");
  assert.deepEqual(r.matched, { label: "Bishop Fire Department", value: "Bishop Fire Department" });
  assert.deepEqual(r.similar, [], "the exact match itself is not 'similar'");
});

test("checkDepartmentTag flags a capitalisation mismatch as present but not exact", () => {
  const r = helium.checkDepartmentTag(FORM, "vacaville fire department");
  assert.equal(r.present, true);
  assert.equal(r.exactCase, false);
  assert.equal(r.index, 5);
  assert.equal(r.matched.value, "Vacaville Fire Department");
});

test("checkDepartmentTag computes the alphabetical insertion point", () => {
  const middle = helium.checkDepartmentTag(FORM, "Tracy Fire Department");
  assert.deepEqual(
    { present: middle.present, exactCase: middle.exactCase, index: middle.index, insertAfter: middle.insertAfter, insertBefore: middle.insertBefore, total: middle.total },
    { present: false, exactCase: false, index: 5, insertAfter: "San Francisco Fire Department", insertBefore: "Vacaville Fire Department", total: 6 }
  );
  const first = helium.checkDepartmentTag(FORM, "Alameda Fire Department");
  assert.deepEqual([first.index, first.insertAfter, first.insertBefore], [0, "", "Bishop Fire Department"]);
  const last = helium.checkDepartmentTag(FORM, "Woodland Fire Department");
  assert.deepEqual([last.index, last.insertAfter, last.insertBefore], [6, "Vacaville Fire Department", ""]);
  // Case-insensitive ordering, like the list Dan keeps.
  const lower = helium.checkDepartmentTag(FORM, "calistoga fire department");
  assert.deepEqual([lower.index, lower.insertAfter, lower.insertBefore], [2, "Cal Fire", "Hayward Fire Department"]);
});

test("checkDepartmentTag lists similar options by the first significant word", () => {
  const r = helium.checkDepartmentTag(FORM, "Bishop FD");
  assert.equal(r.present, false);
  assert.deepEqual(r.similar, ["Bishop Fire Department"]);
  const sf = helium.checkDepartmentTag(FORM, "San Francisco FD");
  assert.deepEqual(sf.similar, ["San Francisco Fire Department"]);
});

test("checkDepartmentTag degrades without a Department field or a tag", () => {
  const none = helium.checkDepartmentTag({ ...FORM, departmentField: null }, "X");
  assert.equal(none.present, false);
  assert.equal(none.index, -1);
  assert.equal(none.total, 0);
  assert.match(none.error, /no Department field/);
  const empty = helium.checkDepartmentTag(FORM, "  ");
  assert.match(empty.error, /empty/);
  // A bare field (with options) is accepted too.
  const bare = helium.checkDepartmentTag({ options: ["A", "C"] }, "B");
  assert.deepEqual([bare.index, bare.insertAfter, bare.insertBefore, bare.total], [1, "A", "C", 2]);
});

/* ---------------------------------------------------------------------------
   checkAllForms
   ------------------------------------------------------------------------- */

test("checkAllForms verifies public forms and marks unreadable ones public:false", async () => {
  await withEnv({ HELIUM_FORMS: "K7tlqn:Registration,abc123:Edit Account,zz9:Registration backup copy", SHOPIFY_STORE: "fn-simple-uniforms.myshopify.com" }, async () => {
    const fetch = fakeFetch({
      K7tlqn: jsonResponse(200, registrationForm()),
      abc123: jsonResponse(200, registrationForm({ id: "abc123", name: "Edit Account", departments: [...DEPARTMENTS, "Tracy Fire Department"] }))
    });
    helium.setFetch(fetch);
    const logs = [];
    const results = await helium.checkAllForms("Tracy Fire Department", { onLog: (m) => logs.push(m) });
    assert.equal(results.length, 3);
    const [reg, edit, backup] = results;
    assert.equal(reg.id, "K7tlqn");
    assert.equal(reg.label, "Registration");
    assert.equal(reg.public, true);
    assert.equal(reg.present, false);
    assert.equal(reg.index, 5);
    assert.equal(reg.insertAfter, "San Francisco Fire Department");
    assert.equal(reg.insertBefore, "Vacaville Fire Department");
    assert.equal(reg.total, 6);
    assert.match(reg.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(edit.public, true);
    assert.equal(edit.present, true);
    assert.equal(edit.exactCase, true);
    assert.equal(edit.index, 6);
    assert.equal(backup.public, false);
    assert.equal(backup.status, 404);
    assert.match(backup.error, /returned 404/);
    assert.match(backup.checkedAt, /^\d{4}-/);
    assert.equal(logs.length, 3);
    assert.ok(fetch.calls.every((c) => /shop=fn-simple-uniforms\.myshopify\.com$/.test(c.url)));
  });
});

test("checkAllForms accepts an explicit form list", async () => {
  helium.setFetch(fakeFetch({ one: jsonResponse(200, registrationForm({ id: "one" })) }));
  const results = await helium.checkAllForms("Cal Fire", { forms: [{ id: "one", label: "Registration" }], shop: "s" });
  assert.equal(results.length, 1);
  assert.equal(results[0].present, true);
  assert.equal(results[0].index, 1);
});

/* ---------------------------------------------------------------------------
   Checklists
   ------------------------------------------------------------------------- */

test("manualChecklist walks all three forms with the computed insertion sentence", () => {
  const tag = "Tracy Fire Department";
  const forms = [
    { id: "K7tlqn", label: "Registration", public: true, present: false, exactCase: false, index: 5, insertAfter: "San Francisco Fire Department", insertBefore: "Vacaville Fire Department", total: 6 },
    { id: "abc123", label: "Edit Account", public: true, present: true, exactCase: true, index: 6, insertAfter: "San Francisco Fire Department", insertBefore: "", total: 7 },
    { id: "zz9", label: "Registration backup copy", public: false, error: "Helium form zz9 returned 404: Not Found" }
  ];
  const steps = helium.manualChecklist({ departmentTag: tag, forms });
  assert.equal(steps.length, 5);
  assert.equal(steps[0], "Helium Customer Fields > Forms. Update all three forms: Edit Account, Registration, and the Registration backup copy.");
  assert.ok(steps[1].startsWith('In Edit Account: open the Department field, add the department tag exactly ("Tracy Fire Department"), in alphabetical order. Save.'));
  assert.match(steps[1], /Already present as option 7 of 7/);
  assert.ok(steps[2].startsWith('In Registration: open the Department field, add the department tag exactly ("Tracy Fire Department"), in alphabetical order. Save.'));
  assert.ok(steps[2].includes("insert exactly 'Tracy Fire Department' between 'San Francisco Fire Department' and 'Vacaville Fire Department'".replace("insert", "Insert")));
  assert.ok(steps[3].startsWith("In Registration backup copy:"));
  assert.match(steps[3], /Not verified by the platform — the form could not be read/);
  assert.match(steps[4], /^Why this matters: .*All three places must match exactly\.$/);
  for (const step of steps.slice(1, 4)) assert.ok(step.includes(`"${tag}"`), step);
});

test("manualChecklist without verification results still lists the three forms", () => {
  const steps = helium.manualChecklist({ departmentTag: "Vacaville Fire Department" });
  assert.equal(steps.length, 5);
  assert.match(steps[1], /^In Edit Account:/);
  assert.match(steps[1], /Not verified by the platform/);
  assert.match(steps[2], /^In Registration:/);
  assert.match(steps[3], /^In Registration backup copy:/);
  // A configured form under a different label is still listed.
  const extra = helium.manualChecklist({ departmentTag: "X", forms: [{ id: "q", label: "Wholesale", public: true, present: false, index: 0, insertAfter: "", insertBefore: "Alpha", total: 1 }] });
  assert.equal(extra.length, 6);
  assert.match(extra[4], /^In Wholesale: .*Insert exactly 'X' at the top, before 'Alpha' \(position 1 of 2\)\./);
});

test("insertionSentence covers top, bottom, empty and case-mismatch cases", () => {
  assert.equal(helium.insertionSentence("X", { public: true, present: false, index: 3, insertAfter: "W", insertBefore: "", total: 3 }), "Insert exactly 'X' at the end, after 'W' (position 4 of 4).");
  assert.equal(helium.insertionSentence("X", { public: true, present: false, index: 0, insertAfter: "", insertBefore: "", total: 0 }), "Insert exactly 'X' as the first option.");
  assert.match(helium.insertionSentence("X", { public: true, present: true, exactCase: false, index: 1, total: 2, matched: { value: "x" } }), /capitalisation differs — correct it to exactly "X"/);
  assert.equal(helium.insertionSentence("X", { public: false, error: "nope" }), "");
  assert.equal(helium.insertionSentence("X", null), "");
});

test("flowChecklist is the §8b procedure with the exact tag", () => {
  const steps = helium.flowChecklist({ departmentTag: "Vacaville Fire Department" });
  assert.deepEqual(steps, [
    'Open the flow "Email newly created shop customers without department tags" > Edit.',
    'Open the Condition step (second-to-last, just before "Send transactional email").',
    'At the bottom: Add criteria > tags_item > enter the department tag exactly ("Vacaville Fire Department") > Apply changes.'
  ]);
  assert.equal(helium.FLOW_NAME, "Email newly created shop customers without department tags");
});

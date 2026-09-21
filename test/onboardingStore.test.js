const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../onboardingStore");

const NAME = "Vacaville Fire Department";
const REQUIRED_TOP_LEVEL = [
  "schemaVersion", "id", "requestId", "createdAt", "updatedAt", "status", "phase", "department", "packet", "drive",
  "policyReview", "products", "collection", "lock", "sharedSettings", "approvals", "build", "report", "events"
];

/* Every storage test runs against the in-memory adapter and restores the
   real one afterwards, so no test ever needs a storage account. */
function withMemoryStore(fn) {
  return async (t) => {
    const memory = store.memoryBlobAdapter();
    const previous = store.setBlobAdapter(memory);
    try {
      await fn(t, memory);
    } finally {
      await store.flushWrites();
      store.setBlobAdapter(previous);
    }
  };
}

/* ── ids ─────────────────────────────────────────────────────────────────── */

test("newOnboardingId: date, slug and 8 hex, always .json", () => {
  const id = store.newOnboardingId(NAME, new Date("2026-09-21T15:04:05Z"));
  assert.match(id, /^2026-09-21-vacaville-fire-department-[0-9a-f]{8}\.json$/);
  assert.match(store.newOnboardingId("St. Helena F.D. (Union)  ", new Date("2026-01-02T00:00:00Z")), /^2026-01-02-st-helena-f-d-union-[0-9a-f]{8}\.json$/);
  assert.match(store.newOnboardingId("???", new Date("2026-01-02T00:00:00Z")), /^2026-01-02-department-[0-9a-f]{8}\.json$/);
  assert.equal(store.newOnboardingId(NAME, new Date("2026-09-21T00:00:00Z"), "1A2B3C4D"), "2026-09-21-vacaville-fire-department-1a2b3c4d.json");
  assert.notEqual(store.newOnboardingId(NAME), store.newOnboardingId(NAME));
  assert.ok(store.isRecordId(id));
  assert.ok(!store.isRecordId("../x.json"));
  assert.ok(!store.isRecordId("a/b.json"));
  assert.ok(!store.isRecordId("2026-09-21-x-1a2b3c4d"));
  assert.ok(!store.isRecordId("2026-09-21-x-1a2b3c4d/assets/abc.png"));
  assert.equal(store.recordBase(id), id.slice(0, -5));
  assert.equal(store.assetPrefix(id), `${id.slice(0, -5)}/assets/`);
});

/* ── emptyRecord ─────────────────────────────────────────────────────────── */

test("emptyRecord: full default shape from the design doc", () => {
  const record = store.emptyRecord({
    departmentName: `  ${NAME}  `,
    state: "ca",
    contacts: [{ name: "Chief Smith", email: "chief@vacaville.gov" }, { name: "", email: "" }, "junk"],
    notes: "rush"
  });
  for (const key of REQUIRED_TOP_LEVEL) assert.ok(key in record, `missing ${key}`);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.status, "packet");
  assert.equal(record.phase, "packet");
  assert.equal(record.id, null);
  assert.equal(record.requestId, null);
  assert.equal(record.department.name, NAME);
  assert.equal(record.department.tag, NAME);
  assert.equal(record.department.state, "CA");
  assert.equal(record.department.storeOrdinal, 1);
  assert.equal(record.department.storeName, "");
  assert.deepEqual(record.department.contacts, [{ name: "Chief Smith", role: "", email: "chief@vacaville.gov", phone: "" }]);
  assert.deepEqual(record.department.code, { value: null, source: null, approved: false, approvedAt: null, approvedBy: "", candidates: [], matches: [] });
  assert.deepEqual(record.packet, { files: [], notes: "rush" });
  assert.equal(record.collection.title, `1. ${NAME}`);
  assert.equal(record.collection.descriptionSet, false);
  assert.equal(record.lock.status, "pending");
  assert.deepEqual(record.lock.settings, { enabled: true, protectProducts: true, hideFromNavigation: true, hideFromLists: true });
  assert.equal(record.sharedSettings.megaMenu.status, "pending");
  assert.deepEqual(record.sharedSettings.megaMenu.proposal, { insertAfter: "", insertBefore: "", index: 0, title: "", url: "" });
  assert.equal(record.sharedSettings.flow.status, "pending");
  assert.deepEqual(record.sharedSettings.helium, { status: "pending", forms: [] });
  assert.deepEqual(record.build, { state: "", startedAt: "", heartbeatAt: "", finishedAt: null, error: null, steps: [], log: [] });
  assert.deepEqual(record.report, { generatedAt: "", completed: [], needsDan: [], missingInformation: [], warnings: [], driveDocUrl: "" });
  assert.deepEqual(record.policyReview.emailDraft, { subject: "", body: "" });
  assert.deepEqual(record.products, []);
  assert.deepEqual(record.events, []);
  assert.deepEqual(record.approvals, []);
});

test("emptyRecord: a second store titles the collection by store name and ordinal", () => {
  const union = store.emptyRecord({ departmentName: NAME, storeOrdinal: "2", storeName: "Vacaville Firefighters Union" });
  assert.equal(union.department.storeOrdinal, 2);
  assert.equal(union.collection.title, "2. Vacaville Firefighters Union");
  // Ordinal > 1 without a store name falls back to the department name.
  assert.equal(store.emptyRecord({ departmentName: NAME, storeOrdinal: 3 }).collection.title, `3. ${NAME}`);
  assert.equal(store.emptyRecord({ departmentName: NAME, storeOrdinal: 0 }).department.storeOrdinal, 1);
  assert.equal(store.emptyRecord({ departmentName: NAME, storeOrdinal: "abc" }).department.storeOrdinal, 1);
});

/* ── normalizeRecord ─────────────────────────────────────────────────────── */

test("normalizeRecord: fills missing sub-objects, keeps unknown keys, recomputes the tag, leaves updatedAt alone", () => {
  const input = {
    id: "x.json",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "building",
    department: { name: "  Bishop  Fire   Department ", tag: "stale", extra: { keep: true }, code: { value: "bsh", approved: true } },
    lock: { status: "created", secretLink: "https://fnsimple.com/x" },
    sharedSettings: { megaMenu: { status: "proposed", proposal: { index: 4 } } },
    custom: { anything: 1 }
  };
  const record = store.normalizeRecord(input);
  assert.notEqual(record, input, "returns a new object");
  assert.equal(input.department.tag, "stale", "input is not mutated");
  for (const key of REQUIRED_TOP_LEVEL) assert.ok(key in record, `missing ${key}`);
  assert.equal(record.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(record.status, "building");
  assert.equal(record.phase, "packet");
  assert.equal(record.department.name, "Bishop Fire Department");
  assert.equal(record.department.tag, "Bishop Fire Department");
  assert.deepEqual(record.department.extra, { keep: true });
  assert.deepEqual(record.custom, { anything: 1 });
  assert.equal(record.department.code.value, "BSH");
  assert.equal(record.department.code.approved, true);
  assert.equal(record.department.code.source, null);
  assert.deepEqual(record.department.code.candidates, []);
  assert.equal(record.lock.status, "created");
  assert.equal(record.lock.secretLink, "https://fnsimple.com/x");
  assert.deepEqual(record.lock.settings, { enabled: true, protectProducts: true, hideFromNavigation: true, hideFromLists: true });
  assert.equal(record.sharedSettings.megaMenu.status, "proposed");
  assert.deepEqual(record.sharedSettings.megaMenu.proposal, { insertAfter: "", insertBefore: "", index: 4, title: "", url: "" });
  assert.equal(record.sharedSettings.flow.status, "pending");
  assert.equal(record.collection.title, "1. Bishop Fire Department");
  assert.deepEqual(record.build.steps, []);
  assert.deepEqual(record.events, []);
  // Garbage in, defaults out.
  const empty = store.normalizeRecord(null);
  for (const key of REQUIRED_TOP_LEVEL) assert.ok(key in empty, `missing ${key}`);
  assert.equal(empty.department.tag, "");
  assert.equal(empty.updatedAt, null);
  const wrongTypes = store.normalizeRecord({ department: "nope", products: "nope", events: 5, build: { log: "x" } });
  assert.equal(wrongTypes.department.name, "");
  assert.deepEqual(wrongTypes.products, []);
  assert.deepEqual(wrongTypes.events, []);
  assert.deepEqual(wrongTypes.build.log, []);
});

test("normalizeRecord: products and packet files gain every sub-object, ids are seeded", () => {
  const record = store.normalizeRecord({
    department: { name: NAME },
    packet: { files: [{ name: "policy.pdf", kind: "policy", size: "1200" }] },
    products: [
      { brand: "Next Level", styleNumber: "NL3600", colors: ["Navy"], classB: "yes", mockups: [{ color: "Navy" }], custom: 1 },
      { id: "hat", brand: "Richardson", styleNumber: "R112", validation: { ok: true, errors: ["x"] } }
    ]
  });
  assert.deepEqual(record.packet.files[0], {
    assetId: "", name: "policy.pdf", kind: "policy", contentType: "", size: 1200, driveFileId: "", driveUrl: "", role: "", text: "", description: ""
  });
  const [tee, hat] = record.products;
  assert.equal(tee.id, "p1");
  assert.equal(hat.id, "hat");
  assert.equal(tee.classB, true);
  assert.equal(hat.classB, false);
  assert.equal(tee.custom, 1);
  assert.deepEqual(tee.validation, { ok: null, errors: [], warnings: [], assumptions: [], skuPreview: [] });
  assert.deepEqual(hat.validation, { ok: true, errors: ["x"], warnings: [], assumptions: [], skuPreview: [] });
  assert.deepEqual(tee.shopify, { productId: "", gid: "", url: "", variantCount: 0, createdAt: "" });
  assert.deepEqual(tee.sourceProduct, { id: "", title: "", kind: "", url: "" });
  assert.deepEqual(tee.mockups, [{ color: "Navy" }]);
  assert.deepEqual(tee.blankPhotos, {});
  assert.deepEqual(tee.proofs, {});
  assert.equal(tee.buildState, "pending");
  assert.equal(tee.buildError, "");
  assert.equal(tee.fulfillment, "");
  assert.deepEqual(tee.sizes, []);
  assert.deepEqual(store.normalizeProduct({ styleNumber: "X" }, 4).id, "p5");
});

test("normalizeRecord: the collection title follows the rules until the collection exists", () => {
  const before = store.normalizeRecord({ department: { name: NAME }, collection: { title: "old" } });
  assert.equal(before.collection.title, `1. ${NAME}`);
  const after = store.normalizeRecord({ department: { name: NAME }, collection: { title: "1. Old Name", id: "123" } });
  assert.equal(after.collection.title, "1. Old Name");
  const byGid = store.normalizeRecord({ department: { name: NAME }, collection: { title: "1. Old Name", gid: "gid://shopify/Collection/1" } });
  assert.equal(byGid.collection.title, "1. Old Name");
});

test("normalizeRecord: trims the event and build log rings", () => {
  const events = Array.from({ length: 250 }, (_, i) => ({ at: "", type: "t", message: String(i), by: "" }));
  const log = Array.from({ length: 350 }, (_, i) => `00:00:00 ${i}`);
  const record = store.normalizeRecord({ department: { name: NAME }, events: [...events, "junk"], build: { log } });
  assert.equal(record.events.length, store.EVENTS_RING);
  assert.equal(record.events[0].message, "50");
  assert.equal(record.events.at(-1).message, "249");
  assert.equal(record.build.log.length, store.BUILD_LOG_RING);
  assert.equal(record.build.log[0], "00:00:00 50");
});

/* ── appendEvent / buildLog / summarize ──────────────────────────────────── */

test("appendEvent: ring of 200, newest last, ISO timestamps", () => {
  const record = store.emptyRecord({ departmentName: NAME });
  assert.equal(store.appendEvent(record, { type: "created", message: "hello", by: " Dan " }), record);
  assert.equal(record.events.length, 1);
  assert.deepEqual(Object.keys(record.events[0]), ["at", "type", "message", "by"]);
  assert.match(record.events[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(record.events[0].by, "Dan");
  store.appendEvent(record, { message: "no type" });
  assert.equal(record.events[1].type, "note");
  for (let i = 0; i < 250; i++) store.appendEvent(record, { type: "tick", message: String(i) });
  assert.equal(record.events.length, store.EVENTS_RING);
  assert.equal(record.events.at(-1).message, "249");
  assert.equal(record.events[0].message, "50");
  // Works on a bare object that has no events array yet.
  const bare = {};
  store.appendEvent(bare, { type: "x" });
  assert.equal(bare.events.length, 1);
});

test("buildLog: 'HH:MM:SS message' lines, ring of 300", () => {
  const record = store.emptyRecord({ departmentName: NAME });
  assert.equal(store.buildLog(record, "mockups: Navy front rendered"), record);
  assert.match(record.build.log[0], /^\d{2}:\d{2}:\d{2} mockups: Navy front rendered$/);
  for (let i = 0; i < 350; i++) store.buildLog(record, `line ${i}`);
  assert.equal(record.build.log.length, store.BUILD_LOG_RING);
  assert.match(record.build.log.at(-1), / line 349$/);
  assert.match(record.build.log[0], / line 50$/);
  const bare = {};
  store.buildLog(bare, "first");
  assert.equal(bare.build.log.length, 1);
  assert.equal(bare.build.state, "");
});

test("summarize: the list-view shape with counts", () => {
  const record = store.emptyRecord({ departmentName: NAME });
  record.id = "2026-09-21-vacaville-fire-department-1a2b3c4d.json";
  record.requestId = "req";
  record.createdAt = "2026-09-21T00:00:00.000Z";
  record.updatedAt = "2026-09-21T01:00:00.000Z";
  record.status = "built";
  record.phase = "report";
  record.department.code = { ...record.department.code, value: "VAC", source: "list", approved: true };
  record.packet.files = [{ assetId: "a" }, { assetId: "b" }];
  record.products = [{ mockups: [{}, {}] }, { mockups: [{}] }, {}];
  record.collection.url = "https://admin.shopify.com/c/1";
  record.build = {
    ...record.build,
    state: "complete",
    startedAt: "2026-09-21T00:20:00.000Z",
    finishedAt: "2026-09-21T00:30:00.000Z",
    steps: [{ state: "complete" }, { state: "complete" }, { state: "failed" }]
  };
  record.report.generatedAt = "2026-09-21T00:31:00.000Z";
  assert.deepEqual(store.summarize(record), {
    id: record.id,
    requestId: "req",
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T01:00:00.000Z",
    status: "built",
    phase: "report",
    department: { name: NAME, tag: NAME, code: { value: "VAC", approved: true, source: "list" } },
    counts: { products: 3, mockups: 3, packetFiles: 2 },
    collection: { title: `1. ${NAME}`, url: "https://admin.shopify.com/c/1" },
    // The summary carries step COUNTS, not the step array: the queue card
    // draws its progress bar from them without downloading every record.
    build: {
      state: "complete",
      startedAt: "2026-09-21T00:20:00.000Z",
      finishedAt: "2026-09-21T00:30:00.000Z",
      error: null,
      stepsDone: 2,
      stepsTotal: 3
    },
    report: { generatedAt: "2026-09-21T00:31:00.000Z" }
  });
  assert.deepEqual(store.summarize(null).counts, { products: 0, mockups: 0, packetFiles: 0 });
});

test("cleanMetadata: ASCII only, 256 max, empties dropped", () => {
  assert.deepEqual(store.cleanMetadata({ department: "Café — Fire", empty: "", nil: null, undef: undefined, long: "x".repeat(300), n: 5 }), {
    department: "Caf  Fire",
    long: "x".repeat(256),
    n: "5"
  });
});

/* ── storage: unconfigured ───────────────────────────────────────────────── */

test("storage functions throw STORAGE_UNCONFIGURED without a connection string", async () => {
  const previousEnv = process.env.AZURE_STORAGE_CONNECTION_STRING;
  delete process.env.AZURE_STORAGE_CONNECTION_STRING;
  const previousAdapter = store.setBlobAdapter(null);
  try {
    assert.equal(store.storeConfigured(), false);
    const expect = { code: "STORAGE_UNCONFIGURED", message: /AZURE_STORAGE_CONNECTION_STRING/ };
    await assert.rejects(() => store.createOnboarding({ departmentName: NAME }), expect);
    await assert.rejects(() => store.getOnboarding("x.json"), expect);
    await assert.rejects(() => store.listOnboardings(), expect);
    await assert.rejects(() => store.updateOnboarding("x.json", {}), expect);
    await assert.rejects(() => store.deleteOnboarding("x.json"), expect);
    await assert.rejects(() => store.putAsset("x.json", { name: "a.png", buffer: Buffer.alloc(1) }), expect);
    await assert.rejects(() => store.getAsset("x.json", "a"), expect);
    await assert.rejects(() => store.deleteAsset("x.json", "a"), expect);
    await assert.rejects(() => store.listAssets("x.json"), expect);
    // Pure helpers keep working.
    assert.equal(store.emptyRecord({ departmentName: NAME }).department.tag, NAME);
  } finally {
    if (previousEnv !== undefined) process.env.AZURE_STORAGE_CONNECTION_STRING = previousEnv;
    store.setBlobAdapter(previousAdapter);
  }
});

/* ── storage: records (in-memory adapter) ────────────────────────────────── */

test("createOnboarding / getOnboarding: id, requestId, timestamps, metadata", withMemoryStore(async (t, memory) => {
  assert.equal(store.storeConfigured(), true);
  const created = await store.createOnboarding({ departmentName: NAME, state: "CA", contacts: [{ name: "Chief" }], notes: "n", by: "Dan" });
  assert.match(created.id, /^\d{4}-\d{2}-\d{2}-vacaville-fire-department-[0-9a-f]{8}\.json$/);
  assert.match(created.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(created.id.slice(-13, -5), created.requestId.slice(0, 8), "id hex correlates with the requestId");
  assert.equal(created.createdAt, created.updatedAt);
  assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(created.status, "packet");
  assert.equal(created.events.length, 1);
  assert.equal(created.events[0].type, "created");
  assert.equal(created.events[0].by, "Dan");
  const blob = memory.blobs.get(created.id);
  assert.ok(blob, "record blob written under its id");
  assert.equal(blob.contentType, "application/json");
  assert.deepEqual(blob.metadata, { kind: "department-onboarding", status: "packet", department: NAME, requestId: created.requestId });
  const fetched = await store.getOnboarding(created.id);
  assert.deepEqual(fetched, created);
  await assert.rejects(() => store.createOnboarding({ departmentName: "  " }), { code: "BAD_REQUEST" });
}));

test("getOnboarding: NOT_FOUND for missing and malformed ids", withMemoryStore(async () => {
  await assert.rejects(() => store.getOnboarding("2026-09-21-nope-1a2b3c4d.json"), { code: "NOT_FOUND" });
  for (const bad of ["../x.json", "a/b.json", "x", "", null, undefined, "x.json/../y.json", "2026-09-21-x-1a2b3c4d/assets/a.png"]) {
    await assert.rejects(() => store.getOnboarding(bad), { code: "NOT_FOUND" }, `expected NOT_FOUND for ${String(bad)}`);
  }
}));

test("listOnboardings: summaries newest first, assets ignored, corrupt blobs reported not fatal", withMemoryStore(async (t, memory) => {
  const older = await store.createOnboarding({ departmentName: "Bishop Fire Department" });
  await store.updateOnboarding(older.id, { createdAt: "2026-01-01T00:00:00.000Z" });
  const newer = await store.createOnboarding({ departmentName: NAME });
  await store.updateOnboarding(newer.id, { createdAt: "2026-02-01T00:00:00.000Z" });
  await store.putAsset(newer.id, { name: "logo.png", contentType: "image/png", buffer: Buffer.from("png"), kind: "artwork" });
  memory.blobs.set("2026-03-01-broken-deadbeef.json", { body: Buffer.from("{not json"), contentType: "application/json", metadata: {}, createdOn: "", lastModified: "" });
  const list = await store.listOnboardings();
  assert.deepEqual(list.map((s) => s.id), [newer.id, older.id, "2026-03-01-broken-deadbeef.json"]);
  assert.equal(list[0].department.name, NAME);
  assert.equal(list[0].department.tag, NAME);
  assert.deepEqual(list[0].counts, { products: 0, mockups: 0, packetFiles: 0 });
  assert.deepEqual(Object.keys(list[0]), ["id", "requestId", "createdAt", "updatedAt", "status", "phase", "department", "counts", "collection", "build", "report"]);
  assert.equal(list[2].status, "error");
  assert.match(list[2].error, /JSON/);
}));

test("updateOnboarding: object patch merges at the top level, stamps updatedAt, keeps identity", withMemoryStore(async (t, memory) => {
  const created = await store.createOnboarding({ departmentName: NAME });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const updated = await store.updateOnboarding(created.id, {
    status: "setup",
    phase: "setup",
    id: "hacked.json",
    requestId: "hacked",
    createdAt: undefined,
    department: { name: NAME, code: { value: "vac", source: "list", approved: true } }
  });
  assert.equal(updated.id, created.id);
  assert.equal(updated.requestId, created.requestId);
  assert.equal(updated.createdAt, created.createdAt);
  assert.ok(updated.updatedAt > created.updatedAt, "updatedAt stamped");
  assert.equal(updated.status, "setup");
  assert.equal(updated.department.code.value, "VAC");
  assert.equal(updated.department.code.approved, true);
  // A partial department object is filled back to the full shape.
  assert.equal(updated.department.tag, NAME);
  assert.deepEqual(updated.department.contacts, []);
  assert.deepEqual(updated.department.code.candidates, []);
  assert.equal(memory.blobs.get(created.id).metadata.status, "setup");
  assert.ok(!memory.blobs.has("hacked.json"));
  await assert.rejects(() => store.updateOnboarding(created.id, "nope"), { code: "BAD_REQUEST" });
  await assert.rejects(() => store.updateOnboarding("2026-09-21-nope-1a2b3c4d.json", {}), { code: "NOT_FOUND" });
}));

test("updateOnboarding: function mutators may mutate in place or return a record, sync or async", withMemoryStore(async () => {
  const created = await store.createOnboarding({ departmentName: NAME });
  const inPlace = await store.updateOnboarding(created.id, (record) => {
    record.products.push({ brand: "Next Level", styleNumber: "NL3600" });
    store.appendEvent(record, { type: "products", message: "row added" });
  });
  assert.equal(inPlace.products.length, 1);
  assert.equal(inPlace.products[0].id, "p1");
  assert.equal(inPlace.products[0].buildState, "pending");
  assert.equal(inPlace.events.at(-1).message, "row added");
  const returned = await store.updateOnboarding(created.id, async (record) => ({ ...record, status: "inputs", phase: "inputs" }));
  assert.equal(returned.status, "inputs");
  assert.equal(returned.products.length, 1, "returned record replaces the stored one");
  const stored = await store.getOnboarding(created.id);
  assert.equal(stored.status, "inputs");
  // A mutator that throws leaves the record untouched and surfaces the error.
  await assert.rejects(() => store.updateOnboarding(created.id, () => { throw new Error("boom"); }), /boom/);
  assert.equal((await store.getOnboarding(created.id)).status, "inputs");
}));

test("updateOnboarding: concurrent writers to one record are serialised and each sees fresh data", withMemoryStore(async () => {
  const created = await store.createOnboarding({ departmentName: NAME });
  const bump = (label) => store.updateOnboarding(created.id, async (record) => {
    const n = Number(record.counter || 0);
    await new Promise((resolve) => setTimeout(resolve, 3));
    record.counter = n + 1;
    store.buildLog(record, label);
  });
  await Promise.all([bump("build"), bump("patch"), bump("build2"), store.updateOnboarding(created.id, { status: "building" })]);
  const record = await store.getOnboarding(created.id);
  assert.equal(record.counter, 3, "no lost update");
  assert.equal(record.status, "building");
  assert.deepEqual(record.build.log.map((line) => line.slice(9)), ["build", "patch", "build2"]);
  // A failed step does not wedge the queue.
  await assert.rejects(() => store.updateOnboarding(created.id, () => { throw new Error("x"); }));
  assert.equal((await store.updateOnboarding(created.id, { status: "built" })).status, "built");
  // Different records never wait on each other.
  const other = await store.createOnboarding({ departmentName: "Other FD" });
  await Promise.all([bump("z"), store.updateOnboarding(other.id, { status: "setup" })]);
  assert.equal((await store.getOnboarding(other.id)).status, "setup");
}));

test("deleteOnboarding: removes the record and every asset under its prefix", withMemoryStore(async (t, memory) => {
  const a = await store.createOnboarding({ departmentName: NAME });
  const b = await store.createOnboarding({ departmentName: "Bishop Fire Department" });
  await store.putAsset(a.id, { name: "policy.pdf", contentType: "application/pdf", buffer: Buffer.from("pdf"), kind: "policy" });
  await store.putAsset(a.id, { name: "logo.png", contentType: "image/png", buffer: Buffer.from("png"), kind: "artwork" });
  const keep = await store.putAsset(b.id, { name: "logo.png", contentType: "image/png", buffer: Buffer.from("png"), kind: "artwork" });
  assert.deepEqual(await store.deleteOnboarding(a.id), { deletedAssets: 2 });
  assert.ok(!memory.blobs.has(a.id));
  assert.equal([...memory.blobs.keys()].filter((name) => name.startsWith(store.assetPrefix(a.id))).length, 0);
  assert.ok(memory.blobs.has(b.id));
  assert.ok(await store.getAsset(b.id, keep.assetId));
  await assert.rejects(() => store.getOnboarding(a.id), { code: "NOT_FOUND" });
  await assert.rejects(() => store.deleteOnboarding(a.id), { code: "NOT_FOUND" });
  await assert.rejects(() => store.deleteOnboarding("../x.json"), { code: "NOT_FOUND" });
}));

/* ── storage: assets ─────────────────────────────────────────────────────── */

test("assets: put, get, list, delete under the record prefix with ASCII-clean metadata", withMemoryStore(async (t, memory) => {
  const record = await store.createOnboarding({ departmentName: NAME });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const put = await store.putAsset(record.id, { name: "Café Logo.PNG", contentType: "image/png", buffer: png, kind: "artwork", meta: { role: "scramble", odd: "é" } });
  assert.match(put.assetId, /^[0-9a-z]+-[0-9a-z]{6}\.png$/);
  assert.ok(store.isAssetId(put.assetId));
  assert.equal(put.name, "Café Logo.PNG");
  assert.equal(put.contentType, "image/png");
  assert.equal(put.size, 4);
  assert.equal(put.kind, "artwork");
  assert.match(put.createdAt, /^\d{4}-/);
  const blobName = `${store.assetPrefix(record.id)}${put.assetId}`;
  assert.ok(memory.blobs.has(blobName), "asset blob path is <id minus .json>/assets/<assetId>");
  assert.deepEqual(memory.blobs.get(blobName).metadata, { role: "scramble", kind: "artwork", name: "Caf Logo.PNG", contentType: "image/png" });

  const got = await store.getAsset(record.id, put.assetId);
  assert.ok(Buffer.isBuffer(got.buffer));
  assert.deepEqual([...got.buffer], [...png]);
  assert.equal(got.contentType, "image/png");
  assert.equal(got.name, "Caf Logo.PNG");
  assert.equal(got.kind, "artwork");
  assert.equal(got.size, 4);

  const noExt = await store.putAsset(record.id, { buffer: new Uint8Array([1, 2, 3]) });
  assert.match(noExt.assetId, /^[0-9a-z]+-[0-9a-z]{6}$/);
  assert.equal(noExt.name, "asset");
  assert.equal(noExt.contentType, "application/octet-stream");
  assert.equal(noExt.kind, "other");

  const list = await store.listAssets(record.id);
  assert.deepEqual(list.map((a) => a.assetId), [put.assetId, noExt.assetId].sort());
  const listed = list.find((a) => a.assetId === put.assetId);
  assert.deepEqual(listed, { assetId: put.assetId, name: "Caf Logo.PNG", contentType: "image/png", size: 4, kind: "artwork" });

  await store.deleteAsset(record.id, put.assetId);
  assert.equal(await store.getAsset(record.id, put.assetId), null);
  assert.equal((await store.listAssets(record.id)).length, 1);
  await store.deleteAsset(record.id, put.assetId); // idempotent
  // Assets never leak into the record listing.
  assert.equal((await store.listOnboardings()).length, 1);
}));

test("assets: ids are validated, records must exist, buffers are required", withMemoryStore(async () => {
  const record = await store.createOnboarding({ departmentName: NAME });
  for (const bad of ["../x", "a/b.png", "", "x.png.", ".png", "a b.png", null]) {
    assert.equal(await store.getAsset(record.id, bad), null, `getAsset(${String(bad)})`);
    await assert.rejects(() => store.deleteAsset(record.id, bad), { code: "BAD_REQUEST" }, `deleteAsset(${String(bad)})`);
  }
  assert.equal(await store.getAsset(record.id, "missing-aaaaaa.png"), null);
  await assert.rejects(() => store.putAsset("2026-09-21-nope-1a2b3c4d.json", { name: "a.png", buffer: Buffer.alloc(1) }), { code: "NOT_FOUND" });
  await assert.rejects(() => store.putAsset("../x.json", { name: "a.png", buffer: Buffer.alloc(1) }), { code: "NOT_FOUND" });
  await assert.rejects(() => store.putAsset(record.id, { name: "a.png", buffer: "not a buffer" }), { code: "BAD_REQUEST" });
  await assert.rejects(() => store.listAssets("../x.json"), { code: "NOT_FOUND" });
  assert.deepEqual(await store.listAssets(record.id), []);
}));

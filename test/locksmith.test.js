const test = require("node:test");
const assert = require("node:assert/strict");
const locksmith = require("../locksmith");

/* ---------------------------------------------------------------------------
   Fixtures — what GET /locks.json looks like for a store with locks Dan built
   by hand (ids, "_private" keys and timestamps the API echoes back).
   ------------------------------------------------------------------------- */

const BISHOP_COLLECTION_ID = 288888888001;
const OLD_CODE = "OLDcode_1234567890-abc";

function bishopLock() {
  return {
    id: 101,
    _shop: "fn-simple-uniforms.myshopify.com",
    name: "1. Bishop Fire Department",
    created_at: "2026-03-01T10:00:00Z",
    updated_at: "2026-03-02T10:00:00Z",
    enabled: true,
    // "Protect products in this collection" — true on 171 of the store's 175
    // real collection locks.
    enabled_for_children: true,
    resource_type: "custom_collection",
    resources: [
      {
        _id: "r1",
        id: 501,
        lock_id: 101,
        resource_type: "custom_collection",
        resource_id: BISHOP_COLLECTION_ID,
        // Real locks carry {} here; an arbitrary key proves pass-through and stripping.
        resource_options: { _cache: 1, theme_scope: "dawn" }
      }
    ],
    options: { hide_links_to_resource: true, hide_resource: true, hide_resource_from_sitemaps: false, manual: false, noindex: true, _theme: "dawn" },
    keys: [
      {
        id: 900,
        _id: "k1",
        lock_id: 101,
        options: { customer_autotag: "", force_open: false, redirect_url: "", inverse: false, _v: 2 },
        conditions: [
          { id: 1, _id: "c1", key_id: 900, type: "customer_tag", inverse: false, options: { customer_tag: "Bishop Fire Department", _match: "exact" } }
        ]
      },
      {
        id: 901,
        _id: "k2",
        lock_id: 101,
        options: { customer_autotag: "Bishop Fire Department", force_open: false, redirect_url: "", inverse: false },
        conditions: [
          { id: 2, _id: "c2", key_id: 901, type: "secret_link", inverse: false, options: { secret_link_code: OLD_CODE, customer_remember: true, automatic_timeout: "", _compiled: `ls=${OLD_CODE}` } }
        ]
      }
    ]
  };
}

function riponLock() {
  const lock = bishopLock();
  lock.id = 55;
  lock.name = "1. Ripon Fire Department";
  lock.created_at = "2025-06-01T10:00:00Z";
  lock.updated_at = "2025-06-01T10:00:00Z";
  lock.resources[0].resource_id = 277777777001;
  lock.keys[0].conditions[0].options.customer_tag = "Ripon Fire Department";
  lock.keys[1].options.customer_autotag = "Ripon Fire Department";
  lock.keys[1].conditions[0].options.secret_link_code = "riponCODE";
  return lock;
}

// Newest lock of all, but a product lock — never a template for collections.
function productLock() {
  return {
    id: 300,
    name: "Some product",
    created_at: "2026-09-01T10:00:00Z",
    enabled: true,
    resources: [{ resource_type: "product", resource_id: 1 }],
    options: {},
    keys: [{ options: {}, conditions: [{ type: "customer_tag", inverse: false, options: { customer_tag: "Staff" } }] }]
  };
}

// Newer collection lock with only a tag key — cannot teach the secret shape.
function tagOnlyLock() {
  return {
    id: 250,
    name: "1. Tag Only Department",
    created_at: "2026-08-01T10:00:00Z",
    enabled: true,
    resources: [{ resource_type: "custom_collection", resource_id: 266666666001 }],
    options: {},
    keys: [{ options: {}, conditions: [{ type: "customer_tag", inverse: false, options: { customer_tag: "Tag Only Department" } }] }]
  };
}

function allLocks() {
  return [riponLock(), productLock(), bishopLock(), tagOnlyLock()];
}

/* ---------------------------------------------------------------------------
   Fake fetch
   ------------------------------------------------------------------------- */

function jsonResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = String(url).replace(locksmith.BASE_URL, "");
    const call = { method, path, headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const handler = handlers.find((h) => h.method === method && (h.path instanceof RegExp ? h.path.test(path) : h.path === path));
    if (!handler) return jsonResponse(404, { error: `no handler for ${method} ${path}` });
    return typeof handler.reply === "function" ? handler.reply(call) : handler.reply;
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

const ENV = { SHOPIFY_STORE: "fn-simple-uniforms.myshopify.com", LOCKSMITH_ACCESS_TOKEN: "lsk_test", SHOPIFY_STOREFRONT_DOMAIN: "fnsimple.com" };

test.afterEach(() => locksmith.setFetch(null));

/* ---------------------------------------------------------------------------
   Pure pieces
   ------------------------------------------------------------------------- */

test("configured() needs both the shop domain and the access token", async () => {
  await withEnv({ SHOPIFY_STORE: null, LOCKSMITH_ACCESS_TOKEN: null }, () => assert.equal(locksmith.configured(), false));
  await withEnv({ SHOPIFY_STORE: "x.myshopify.com", LOCKSMITH_ACCESS_TOKEN: null }, () => assert.equal(locksmith.configured(), false));
  await withEnv({ SHOPIFY_STORE: "x.myshopify.com", LOCKSMITH_ACCESS_TOKEN: "  " }, () => assert.equal(locksmith.configured(), false));
  await withEnv(ENV, () => assert.equal(locksmith.configured(), true));
});

test("learnKeyTemplates picks the newest collection lock with both keys and strips private keys and ids", () => {
  const t = locksmith.learnKeyTemplates(allLocks());
  assert.equal(t.fromLockId, 101, "Bishop (2026-03) beats Ripon (2025-06); product and tag-only locks are skipped");
  assert.deepEqual(t.customerTag, { type: "customer_tag", inverse: false, options: { customer_tag: "Bishop Fire Department" } });
  assert.deepEqual(t.secretLink, { type: "secret_link", inverse: false, options: { secret_link_code: OLD_CODE, customer_remember: true, automatic_timeout: "" } });
  assert.deepEqual(t.keyOptions, { customer_autotag: "", force_open: false, redirect_url: "", inverse: false });
  assert.deepEqual(t.secretKeyOptions, { customer_autotag: "Bishop Fire Department", force_open: false, redirect_url: "", inverse: false });
  assert.deepEqual(t.lockOptions, { hide_links_to_resource: true, hide_resource: true, hide_resource_from_sitemaps: false, manual: false, noindex: true });
  assert.deepEqual(t.resourceOptions, { theme_scope: "dawn" });
  const json = JSON.stringify(t);
  assert.ok(!/"_/.test(json), "no underscore keys survive");
  assert.ok(!/"(id|key_id|lock_id)"/.test(json), "no ids survive");
});

test("learnKeyTemplates returns empty templates when nothing qualifies", () => {
  assert.deepEqual(locksmith.learnKeyTemplates([productLock(), tagOnlyLock()]), {
    customerTag: null, secretLink: null, keyOptions: null, secretKeyOptions: null, lockOptions: null, resourceOptions: null, fromLockId: null
  });
  assert.equal(locksmith.learnKeyTemplates(null).fromLockId, null);
});

test("learnKeyTemplates orders by id when timestamps tie", () => {
  const a = bishopLock();
  const b = bishopLock();
  b.id = 102;
  b.keys[0].conditions[0].options.customer_tag = "Newer Department";
  assert.equal(locksmith.learnKeyTemplates([a, b]).customerTag.options.customer_tag, "Newer Department");
});

test("buildCollectionLock from a learned template swaps the other department's code and tag", () => {
  const templates = locksmith.learnKeyTemplates(allLocks());
  const { body, guessed } = locksmith.buildCollectionLock({
    collectionLegacyId: "299999999001",
    collectionTitle: "1. Vacaville Fire Department",
    departmentTag: "Vacaville Fire Department",
    secretCode: "NEWcode_ABCDEFGHIJKLMN",
    templates
  });
  assert.equal(guessed, false);
  assert.equal(body._guessedSecretShape, undefined);
  assert.equal(body.name, "1. Vacaville Fire Department");
  assert.equal(body.enabled, true);
  assert.equal(body.resource_type, "custom_collection");
  assert.deepEqual(body.resources, [{ resource_type: "custom_collection", resource_id: 299999999001, resource_options: { theme_scope: "dawn" } }]);
  // The spec's settings win over the template (Bishop had sitemaps unhidden).
  assert.deepEqual(body.options, { hide_links_to_resource: true, hide_resource: true, hide_resource_from_sitemaps: true, manual: false, noindex: true });
  assert.equal(body.keys.length, 2);
  const [tagKey, secretKey] = body.keys;
  assert.deepEqual(tagKey.conditions, [{ type: "customer_tag", inverse: false, options: { customer_tag: "Vacaville Fire Department" } }]);
  assert.deepEqual(tagKey.options, { customer_autotag: "", force_open: false, redirect_url: "", inverse: false });
  assert.deepEqual(secretKey.conditions, [{ type: "secret_link", inverse: false, options: { secret_link_code: "NEWcode_ABCDEFGHIJKLMN", customer_remember: true, automatic_timeout: "" } }]);
  // Bishop's autotag would have tagged Vacaville members as Bishop.
  assert.equal(secretKey.options.customer_autotag, "Vacaville Fire Department");
  assert.ok(!JSON.stringify(body).includes(OLD_CODE), "the template's code never leaks");
  assert.ok(!JSON.stringify(body).includes("Bishop"), "nothing from the template department leaks");
});

test("buildCollectionLock replaces any secret/code/link option even when the old code is unknown", () => {
  const templates = {
    secretLink: { type: "secret_url", inverse: false, options: { url_code: "", passcode_link: "zzz", keep_me: "yes" } }
  };
  const { body } = locksmith.buildCollectionLock({ collectionLegacyId: 1, collectionTitle: "1. X", departmentTag: "X", secretCode: "NEW", templates });
  assert.deepEqual(body.keys[1].conditions[0], { type: "secret_url", inverse: false, options: { url_code: "NEW", passcode_link: "NEW", keep_me: "yes" } });
});

test("buildCollectionLock without a template guesses the secret-link shape and flags it", () => {
  const { body, guessed } = locksmith.buildCollectionLock({
    collectionLegacyId: 42,
    collectionTitle: "1. Vacaville Fire Department",
    departmentTag: "Vacaville Fire Department",
    secretCode: "abc",
    templates: null
  });
  assert.equal(guessed, true);
  assert.equal(body._guessedSecretShape, true);
  assert.deepEqual(body.keys[1], {
    options: { customer_autotag: "", force_open: false, redirect_url: "", inverse: false },
    conditions: [{ type: "secret_link", inverse: false, options: { secret_link_code: "abc", customer_remember: true } }]
  });
  assert.deepEqual(body.keys[0].conditions[0].options, { customer_tag: "Vacaville Fire Department" });
  assert.deepEqual(body.options, locksmith.SPEC_LOCK_OPTIONS);
  assert.deepEqual(body.resources[0].resource_options, {});
  const sendable = locksmith.sendableBody(body);
  assert.equal(sendable._guessedSecretShape, undefined);
  assert.equal(sendable.name, body.name);
});

test("buildCollectionLock refuses missing inputs instead of inventing them", () => {
  assert.throws(() => locksmith.buildCollectionLock({ collectionLegacyId: "abc", collectionTitle: "1. X", departmentTag: "X", secretCode: "c" }), /numeric collection id/);
  assert.throws(() => locksmith.buildCollectionLock({ collectionLegacyId: 1, collectionTitle: "1. X", departmentTag: " ", secretCode: "c" }), /department tag/);
  assert.throws(() => locksmith.buildCollectionLock({ collectionLegacyId: 1, collectionTitle: "1. X", departmentTag: "X", secretCode: "" }), /secret code/);
});

test("generateSecretCode is 22 url-safe characters and unique", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const code = locksmith.generateSecretCode();
    assert.match(code, /^[A-Za-z0-9_-]{22}$/);
    seen.add(code);
  }
  assert.equal(seen.size, 50);
});

test("secretLinkFor builds the ?ls= link on the storefront domain", async () => {
  assert.equal(
    locksmith.secretLinkFor({ storefrontDomain: "https://fnsimple.com/", collectionHandle: "/1-vacaville-fire-department/", code: "abc_-123" }),
    "https://fnsimple.com/collections/1-vacaville-fire-department?ls=abc_-123"
  );
  await withEnv({ SHOPIFY_STOREFRONT_DOMAIN: "fnsimple.com" }, () => {
    assert.equal(locksmith.secretLinkFor({ collectionHandle: "h", code: "c" }), "https://fnsimple.com/collections/h?ls=c");
  });
  await withEnv({ SHOPIFY_STOREFRONT_DOMAIN: null, SHOPIFY_STORE: null }, () => {
    assert.throws(() => locksmith.secretLinkFor({ collectionHandle: "h", code: "c" }), /storefront domain/);
  });
  assert.throws(() => locksmith.secretLinkFor({ storefrontDomain: "fnsimple.com", collectionHandle: "", code: "c" }), /collection handle/);
});

test("inspectLock reports the §7 requirements", () => {
  const ok = locksmith.inspectLock(bishopLock(), { departmentTag: "Bishop Fire Department" });
  assert.equal(ok.ok, true);
  assert.deepEqual({ enabled: ok.enabled, hasTagKey: ok.hasTagKey, hasSecretKey: ok.hasSecretKey, tag: ok.tag, tagMatches: ok.tagMatches, id: ok.id }, {
    enabled: true, hasTagKey: true, hasSecretKey: true, tag: "Bishop Fire Department", tagMatches: true, id: 101
  });
  assert.equal(ok.options.hide_resource, true);
  const wrongTag = locksmith.inspectLock(bishopLock(), { departmentTag: "bishop fire department" });
  assert.equal(wrongTag.ok, false, "the tag is case-sensitive");
  assert.equal(wrongTag.tagMatches, false);
  const noSecret = locksmith.inspectLock(tagOnlyLock());
  assert.equal(noSecret.ok, false);
  assert.equal(noSecret.hasSecretKey, false);
  assert.equal(noSecret.tagMatches, null);
  const disabled = bishopLock();
  disabled.enabled = false;
  assert.equal(locksmith.inspectLock(disabled).ok, false);
  assert.equal(locksmith.inspectLock(null).ok, false);

  // All four of §7.2, each reported and each able to fail the lock on its own.
  assert.deepEqual(ok.settings, { enabled: true, protectProducts: true, hideFromNavigation: true, hideFromLists: true });
  assert.deepEqual(ok.unsetSettings, []);
});

test("a lock missing any one of the four settings is not ok, and says which", () => {
  const cases = [
    ["enabled_for_children", "Protect products in this collection", (l) => { l.enabled_for_children = false; }],
    ["hide_links_to_resource", "Hide from navigation menus", (l) => { l.options.hide_links_to_resource = false; }],
    ["hide_resource", "Hide from lists", (l) => { l.options.hide_resource = false; }]
  ];
  for (const [field, label, break_] of cases) {
    const lock = bishopLock();
    break_(lock);
    const verdict = locksmith.inspectLock(lock, { departmentTag: "Bishop Fire Department" });
    assert.equal(verdict.ok, false, `${field} off must fail the lock`);
    assert.deepEqual(verdict.unsetSettings, [label]);
  }

  // A missing enabled_for_children is as bad as an explicit false: the
  // products stay reachable either way.
  const absent = bishopLock();
  delete absent.enabled_for_children;
  assert.equal(locksmith.inspectLock(absent, { departmentTag: "Bishop Fire Department" }).ok, false);

  // It means nothing on a product lock, so it must not fail one.
  const onProduct = { id: 9, enabled: true, resources: [{ resource_type: "product", resource_id: 1 }], options: { hide_links_to_resource: true, hide_resource: true }, keys: [] };
  assert.equal(locksmith.inspectLock(onProduct).settings.protectProducts, null);
  assert.deepEqual(locksmith.inspectLock(onProduct).unsetSettings, []);
});

test("a new lock is built with all four settings on", () => {
  const { body } = locksmith.buildCollectionLock({
    collectionLegacyId: 265379381385,
    collectionTitle: "1. Zol Test Fire Department",
    departmentTag: "Zol Test Fire Department",
    secretCode: "abc123"
  });
  assert.equal(body.enabled, true);
  assert.equal(body.enabled_for_children, true, "without this the products stay reachable by direct URL");
  assert.equal(body.options.hide_links_to_resource, true);
  assert.equal(body.options.hide_resource, true);
  // And what we build passes our own inspection.
  const verdict = locksmith.inspectLock({ ...body, id: 1 }, { departmentTag: "Zol Test Fire Department" });
  assert.deepEqual(verdict.unsetSettings, []);
});

test("manualChecklist carries the §7 steps, the four settings and the exact tag", () => {
  const steps = locksmith.manualChecklist({ collectionTitle: "1. Vacaville Fire Department", departmentTag: "Vacaville Fire Department" });
  assert.equal(steps.length, 6);
  assert.match(steps[0], /^On the collection "1\. Vacaville Fire Department": More Actions > Locksmith > create a lock\.$/);
  for (const setting of locksmith.LOCK_SETTINGS) assert.ok(steps[1].includes(setting), setting);
  assert.deepEqual(locksmith.LOCK_SETTINGS, ["Enable this lock", "Protect products in this collection", "Hide from navigation menus", "Hide from lists"]);
  assert.equal(steps[2], "Add two keys (either one unlocks the store):");
  assert.ok(steps[3].includes('"Vacaville Fire Department"'));
  assert.ok(/case-sensitive/.test(steps[3]));
  assert.equal(steps[4], "Key 2 — Customer arrives via secret link.");
  assert.equal(steps[5], "Save the lock. Record the secret link in the report.");
});

/* ---------------------------------------------------------------------------
   HTTP (mocked fetch)
   ------------------------------------------------------------------------- */

test("listLocks / getLock / findLockForCollection send the Locksmith headers and unwrap responses", async () => {
  await withEnv(ENV, async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/locks.json", reply: jsonResponse(200, { locks: allLocks() }) },
      { method: "GET", path: "/locks/101.json", reply: jsonResponse(200, { lock: bishopLock() }) }
    ]);
    locksmith.setFetch(fetch);
    const locks = await locksmith.listLocks();
    assert.equal(locks.length, 4);
    assert.equal(fetch.calls[0].headers["x-shopify-shop-domain"], ENV.SHOPIFY_STORE);
    assert.equal(fetch.calls[0].headers["x-locksmith-access-token"], ENV.LOCKSMITH_ACCESS_TOKEN);
    const lock = await locksmith.getLock(101);
    assert.equal(lock.id, 101);
    const found = await locksmith.findLockForCollection(String(BISHOP_COLLECTION_ID));
    assert.equal(found && found.id, 101, "resource ids compare as strings");
    assert.equal(await locksmith.findLockForCollection(1), null, "the product lock's resource_id 1 is not a collection");
    assert.equal(await locksmith.findLockForCollection(""), null);
  });
});

test("listLocks accepts a bare array", async () => {
  await withEnv(ENV, async () => {
    locksmith.setFetch(fakeFetch([{ method: "GET", path: "/locks.json", reply: jsonResponse(200, [bishopLock()]) }]));
    assert.equal((await locksmith.listLocks()).length, 1);
  });
});

test("requests refuse to run unconfigured and surface non-2xx with status and body", async () => {
  await withEnv({ SHOPIFY_STORE: null, LOCKSMITH_ACCESS_TOKEN: null }, async () => {
    locksmith.setFetch(fakeFetch([]));
    await assert.rejects(() => locksmith.listLocks(), /LOCKSMITH_ACCESS_TOKEN/);
  });
  await withEnv(ENV, async () => {
    locksmith.setFetch(fakeFetch([{ method: "GET", path: "/locks.json", reply: jsonResponse(401, "x".repeat(900)) }]));
    await assert.rejects(
      () => locksmith.listLocks(),
      (error) => {
        assert.equal(error.status, 401);
        assert.equal(error.body.length, 500);
        assert.match(error.message, /Locksmith GET \/locks\.json returned 401/);
        return true;
      }
    );
    locksmith.setFetch(async () => {
      throw new Error("ECONNRESET");
    });
    await assert.rejects(() => locksmith.listLocks(), /Locksmith GET \/locks\.json failed: ECONNRESET/);
  });
});

test("createCollectionLock with a template creates directly (no dry run) and returns the secret link", async () => {
  await withEnv(ENV, async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/locks.json", reply: jsonResponse(200, { locks: allLocks() }) },
      { method: "POST", path: /^\/lock\?/, reply: (call) => jsonResponse(201, { lock: { id: 777, ...call.body } }) }
    ]);
    locksmith.setFetch(fetch);
    const logs = [];
    const result = await locksmith.createCollectionLock(
      { collectionLegacyId: 299999999001, collectionTitle: "1. Vacaville Fire Department", departmentTag: "Vacaville Fire Department", collectionHandle: "1-vacaville-fire-department" },
      { onLog: (m) => logs.push(m) }
    );
    assert.equal(fetch.calls.length, 2, "GET locks + one real POST");
    assert.equal(fetch.calls[1].method, "POST");
    assert.equal(fetch.calls[1].path, "/lock?install=true");
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, false);
    assert.equal(result.guessed, false);
    assert.equal(result.id, 777);
    assert.equal(result.templateLockId, 101);
    assert.match(result.secretCode, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(result.secretLink, `https://fnsimple.com/collections/1-vacaville-fire-department?ls=${result.secretCode}`);
    assert.equal(fetch.calls[1].body.keys[1].conditions[0].options.secret_link_code, result.secretCode);
    assert.equal(fetch.calls[1].body.keys[0].conditions[0].options.customer_tag, "Vacaville Fire Department");
    assert.equal(fetch.calls[1].body._guessedSecretShape, undefined);
    assert.ok(logs.some((m) => /learned from lock 101/.test(m)));
  });
});

test("createCollectionLock with a guessed shape dry-runs first, then creates", async () => {
  await withEnv(ENV, async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/locks.json", reply: jsonResponse(200, { locks: [productLock(), tagOnlyLock()] }) },
      { method: "POST", path: /^\/lock\?/, reply: (call) => jsonResponse(201, { lock: { id: /dryrun/.test(call.path) ? null : 778, ...call.body } }) }
    ]);
    locksmith.setFetch(fetch);
    const result = await locksmith.createCollectionLock({
      collectionLegacyId: 5,
      collectionTitle: "1. Guess Fire Department",
      departmentTag: "Guess Fire Department",
      collectionHandle: "1-guess-fire-department",
      secretCode: "fixedCODE_0123456789ab"
    });
    assert.deepEqual(fetch.calls.map((c) => `${c.method} ${c.path}`), ["GET /locks.json", "POST /lock?install=true&dryrun=true", "POST /lock?install=true"]);
    assert.equal(result.guessed, true);
    assert.equal(result.id, 778);
    assert.equal(result.secretCode, "fixedCODE_0123456789ab");
    assert.equal(result.templateLockId, null);
    for (const call of fetch.calls.slice(1)) assert.equal(call.body._guessedSecretShape, undefined, "bookkeeping key is stripped before sending");
  });
});

test("createCollectionLock { dryRun: true } never creates and still degrades when listing fails", async () => {
  await withEnv(ENV, async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/locks.json", reply: jsonResponse(500, "boom") },
      { method: "POST", path: "/lock?install=false&dryrun=true", reply: jsonResponse(200, { lock: { id: null, valid: true } }) }
    ]);
    locksmith.setFetch(fetch);
    const logs = [];
    const result = await locksmith.createCollectionLock(
      { collectionLegacyId: 9, collectionTitle: "1. Dry Fire Department", departmentTag: "Dry Fire Department", collectionHandle: "dry" },
      { dryRun: true, install: false, onLog: (m) => logs.push(m) }
    );
    assert.deepEqual(fetch.calls.map((c) => `${c.method} ${c.path}`), ["GET /locks.json", "POST /lock?install=false&dryrun=true"]);
    assert.equal(result.dryRun, true);
    assert.equal(result.id, null);
    assert.equal(result.guessed, true);
    assert.match(result.templateError, /returned 500/);
    assert.ok(logs.some((m) => /could not read existing locks/.test(m)));
  });
});

test("createCollectionLock propagates a failed create with status and body", async () => {
  await withEnv(ENV, async () => {
    locksmith.setFetch(
      fakeFetch([
        { method: "GET", path: "/locks.json", reply: jsonResponse(200, { locks: allLocks() }) },
        { method: "POST", path: "/lock?install=true", reply: jsonResponse(422, { errors: { name: ["has already been taken"] } }) }
      ])
    );
    await assert.rejects(
      () => locksmith.createCollectionLock({ collectionLegacyId: 1, collectionTitle: "1. Dup", departmentTag: "Dup", collectionHandle: "dup" }),
      (error) => error.status === 422 && /already been taken/.test(error.body)
    );
  });
});

test("verifyLock re-reads the lock and checks the tag", async () => {
  await withEnv(ENV, async () => {
    locksmith.setFetch(fakeFetch([{ method: "GET", path: "/locks/101.json", reply: jsonResponse(200, { lock: bishopLock() }) }]));
    const v = await locksmith.verifyLock(101, { departmentTag: "Bishop Fire Department" });
    assert.equal(v.ok, true);
    assert.equal(v.tag, "Bishop Fire Department");
    const bad = await locksmith.verifyLock(101, { departmentTag: "Vacaville Fire Department" });
    assert.equal(bad.ok, false);
    assert.equal(bad.tagMatches, false);
  });
});

/* ---------------------------------------------------------------------------
   §7 checked by behaviour: the lock's job is that the public cannot see the
   department's products, and that the secret link can.
   ------------------------------------------------------------------------- */

// A collection page as the storefront renders it, with N product cards.
function storefront(productCount) {
  const cards = Array.from({ length: productCount }, (_, i) => `<a href="/collections/vacaville/products/tee-${i + 1}">Tee ${i + 1}</a>`);
  // The chrome every page carries, locked or not: nav, search, footer.
  return `<html><head><title>Store</title></head><body><nav><a href="/account/login">Log in</a></nav>${cards.join("")}<footer>Password</footer></body></html>`;
}

function fakeStorefront(byUrl) {
  const seen = [];
  locksmith.setFetch(async (url) => {
    seen.push(String(url));
    const hit = Object.entries(byUrl).find(([fragment]) => String(url).includes(fragment));
    if (!hit) throw new Error(`unexpected fetch ${url}`);
    const [, value] = hit;
    if (value instanceof Error) throw value;
    return { status: 200, ok: true, text: async () => value };
  });
  return seen;
}

test("productLinkCount counts distinct products and ignores page chrome", () => {
  assert.equal(locksmith.productLinkCount(storefront(0)), 0);
  assert.equal(locksmith.productLinkCount(storefront(3)), 3);
  // The same product linked twice (card + quick-view) is still one product.
  assert.equal(locksmith.productLinkCount(`<a href="/products/tee">x</a><a href="/products/tee">y</a>`), 1);
  assert.equal(locksmith.productLinkCount(null), 0);
});

test("a locked collection shows the public nothing, and the secret link opens it", async () => {
  fakeStorefront({
    "?ls=": storefront(12),
    "/collections/1-vacaville": storefront(0)
  });
  const verdict = await locksmith.checkPublicAccess({
    storefrontDomain: "fnsimple.com",
    collectionHandle: "1-vacaville",
    productCount: 58,
    secretLink: "https://fnsimple.com/collections/1-vacaville?ls=abc123"
  });
  assert.equal(verdict.checked, true);
  assert.equal(verdict.closedToPublic, true);
  assert.equal(verdict.publicProductLinks, 0);
  assert.equal(verdict.opensWithSecretLink, true);
  assert.equal(verdict.reason, "");
  locksmith.setFetch(null);
});

test("a collection still visible to the public fails the check and says how many leaked", async () => {
  fakeStorefront({ "/collections/1-vacaville": storefront(16) });
  const verdict = await locksmith.checkPublicAccess({
    storefrontDomain: "fnsimple.com",
    collectionHandle: "1-vacaville",
    productCount: 58
  });
  assert.equal(verdict.closedToPublic, false);
  assert.equal(verdict.publicProductLinks, 16);
  assert.match(verdict.reason, /16 product link\(s\) to the public/);
  locksmith.setFetch(null);
});

test("a secret link that opens nothing is reported, not assumed to work", async () => {
  fakeStorefront({
    "?ls=": storefront(0),
    "/collections/1-vacaville": storefront(0)
  });
  const verdict = await locksmith.checkPublicAccess({
    storefrontDomain: "fnsimple.com",
    collectionHandle: "1-vacaville",
    productCount: 58,
    secretLink: "https://fnsimple.com/collections/1-vacaville?ls=wrong"
  });
  assert.equal(verdict.closedToPublic, true);
  assert.equal(verdict.opensWithSecretLink, false);
  assert.match(verdict.reason, /does not open the store/);
  locksmith.setFetch(null);
});

test("an empty collection proves nothing, so the verdict stays unknown", async () => {
  const seen = fakeStorefront({ "/collections/1-vacaville": storefront(0) });
  const verdict = await locksmith.checkPublicAccess({
    storefrontDomain: "fnsimple.com",
    collectionHandle: "1-vacaville",
    productCount: 0
  });
  assert.equal(verdict.checked, false);
  assert.equal(verdict.closedToPublic, null, "null is not a pass");
  assert.match(verdict.reason, /no products yet/);
  assert.deepEqual(seen, [], "and it does not waste a request finding out");
  locksmith.setFetch(null);
});

test("a storefront that will not answer leaves the verdict unknown rather than failed", async () => {
  fakeStorefront({ "/collections/1-vacaville": new Error("ECONNRESET") });
  const verdict = await locksmith.checkPublicAccess({
    storefrontDomain: "fnsimple.com",
    collectionHandle: "1-vacaville",
    productCount: 58
  });
  assert.equal(verdict.closedToPublic, null);
  assert.equal(verdict.checked, false);
  assert.match(verdict.reason, /Could not read .*ECONNRESET/);
  locksmith.setFetch(null);
});

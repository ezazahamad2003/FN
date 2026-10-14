const test = require("node:test");
const assert = require("node:assert/strict");

// The fallback store is memory, and the tests below inject their own anyway.
delete process.env.AZURE_STORAGE_CONNECTION_STRING;

const guard = require("../megaMenuGuard");

/*
 * The menus below are the verbatim live MegaMenu (108 stores under "Store",
 * four of them with children, "Contact" with three) plus four stores, so the
 * baseline is the 112-store menu Foresthill's final check read at 16:17 UTC
 * on 13 Oct 2026 — the last good read before the wipe.
 */
const LIVE_MENU = require("./fixtures/megamenu-live.json");
const BASELINE_AT = "2026-10-13T15:17:00.000Z";

let nextId = 990000;
function collectionItem(title, n) {
  return {
    id: `gid://shopify/MenuItem/${nextId++}`,
    title,
    type: "COLLECTION",
    url: `/collections/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    resourceId: `gid://shopify/Collection/${n}`,
    tags: [],
    items: []
  };
}

function storeOf(menu) {
  return menu.items.find((item) => item.title === "Store");
}

function fullMenu() {
  const menu = JSON.parse(JSON.stringify(LIVE_MENU));
  const store = storeOf(menu);
  // Foresthill sat between "Ripon Fire Department" and "FN Simple Merch".
  const at = store.items.findIndex((item) => item.title === "FN Simple Merch");
  store.items.splice(at, 0, collectionItem("Foresthill Fire Protection District", 777001), collectionItem("Tracy Fire Department", 777002), collectionItem("Lodi Fire Department", 777003), collectionItem("Galt Fire Department", 777004));
  return menu;
}

// What the outside rewrite left: every top-level item, nothing below.
function wiped(menu) {
  return { ...menu, items: menu.items.map((item) => ({ ...item, items: [] })) };
}

function baselineDoc(menu = fullMenu(), at = BASELINE_AT) {
  return { at, by: "", reason: "final-check", menu };
}

function withoutStores(menu, count) {
  const copy = JSON.parse(JSON.stringify(menu));
  const store = storeOf(copy);
  // Plain stores only, so a store with children does not drag nested items in.
  let removed = 0;
  store.items = store.items.filter((item) => {
    if (removed < count && item.type === "COLLECTION" && !(item.items || []).length) {
      removed += 1;
      return false;
    }
    return true;
  });
  return copy;
}

test.afterEach(() => guard.setStorage(null));

/* ---------------------------------------------------------------------------
   assessMenu
   ------------------------------------------------------------------------- */

test("the incident: an empty Store list is unhealthy, and says what the last good read had", () => {
  const baseline = baselineDoc();
  assert.equal(guard.summarizeMenu(baseline.menu).storeCount, 112);

  const verdict = guard.assessMenu(wiped(baseline.menu), baseline);
  assert.equal(verdict.healthy, false);
  assert.equal(verdict.storeCount, 0);
  assert.equal(verdict.baselineCount, 112);
  assert.equal(verdict.baselineAt, BASELINE_AT);
  assert.equal(verdict.reasons[0], "The Store list has 0 stores; the last good read (13 Oct 2026, 15:17 UTC) had 112.");
  assert.equal(verdict.message, "The Mega Menu looks wiped: the Store list has 0 stores; the last good read (13 Oct 2026, 15:17 UTC) had 112.");
  // Every store, Contact's three and the twenty stations are listed, in menu order.
  assert.equal(verdict.missing.length, guard.summarizeMenu(baseline.menu).items.length);
  assert.deepEqual(verdict.missing[0], { title: "Blank Uniforms", url: "/collections/fn-simple-blank-uniforms", parentTitle: "Store" });
  assert.ok(verdict.missing.some((m) => m.title === "Returns & Exchanges" && m.parentTitle === "Contact"));
  assert.equal(verdict.nestedMissing, 27, "the 20 stations, and the 2 + 3 + 2 under Sonoma Valley, Manteca and Santa Clara");
});

test("an empty Store list is refused even with no copy to compare against", () => {
  const verdict = guard.assessMenu(wiped(fullMenu()), null);
  assert.equal(verdict.healthy, false);
  assert.equal(verdict.reasons[0], "The Store list has 0 stores.");
  assert.equal(verdict.baselineCount, null);
  assert.deepEqual(verdict.missing, []);
});

test("a menu with no Store item at all is unhealthy", () => {
  const menu = fullMenu();
  menu.items = menu.items.filter((item) => item.title !== "Store");
  const verdict = guard.assessMenu(menu, baselineDoc());
  assert.equal(verdict.healthy, false);
  assert.match(verdict.reasons[0], /^The Mega Menu has no "Store" item; the last good read \(13 Oct 2026, 15:17 UTC\) had one with 112 stores\.$/);
});

test("a big drop in the Store list is unhealthy; one store under the line is not", () => {
  const baseline = baselineDoc();
  // max(3, ceil(10% of 112)) = 12
  const twelve = guard.assessMenu(withoutStores(baseline.menu, 12), baseline);
  assert.equal(twelve.healthy, false);
  assert.equal(twelve.reasons[0], "The Store list has 100 stores; the last good read (13 Oct 2026, 15:17 UTC) had 112, and 12 of those are gone.");

  const eleven = guard.assessMenu(withoutStores(baseline.menu, 11), baseline);
  assert.equal(eleven.healthy, true);
  assert.equal(eleven.missing.length, 11, "a small drop is still listed");
});

test("a small drop stays healthy and lists what went, in menu order", () => {
  const baseline = baselineDoc();
  const verdict = guard.assessMenu(withoutStores(baseline.menu, 2), baseline);
  assert.equal(verdict.healthy, true);
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.message, "");
  assert.deepEqual(verdict.missing.map((m) => m.title), ["Blank Uniforms", "Gear & Accessories"]);
  assert.equal(verdict.storeCount, 110);
});

test("with no baseline only the absolute rules apply", () => {
  const verdict = guard.assessMenu(withoutStores(fullMenu(), 60), null);
  assert.equal(verdict.healthy, true);
  assert.equal(verdict.baselineAt, null);
  assert.deepEqual(verdict.missing, []);
});

test("losing the stations nested under Station Stores is unhealthy, even with the Store list intact", () => {
  const baseline = baselineDoc();
  const menu = JSON.parse(JSON.stringify(baseline.menu));
  storeOf(menu).items.find((item) => item.title === "Station Stores").items = [];
  const verdict = guard.assessMenu(menu, baseline);
  assert.equal(verdict.healthy, false);
  assert.equal(verdict.storeCount, 112);
  assert.equal(verdict.nestedMissing, 20);
  assert.match(verdict.reasons[0], /^20 items inside other menu items \(for example under "Station Stores"\) are gone since the last good read/);

  // Two of them is somebody tidying.
  const tidy = JSON.parse(JSON.stringify(baseline.menu));
  const stations = storeOf(tidy).items.find((item) => item.title === "Station Stores");
  stations.items = stations.items.slice(2);
  assert.equal(guard.assessMenu(tidy, baseline).healthy, true);
});

test("a menu rebuilt by hand with new ids is not missing anything; a store moved into a group is not either", () => {
  const baseline = baselineDoc();
  const rebuilt = JSON.parse(JSON.stringify(baseline.menu));
  const renumber = (items) => items.forEach((item) => {
    item.id = `gid://shopify/MenuItem/${nextId++}`;
    renumber(item.items || []);
  });
  renumber(rebuilt.items);
  const verdict = guard.assessMenu(rebuilt, baseline);
  assert.equal(verdict.healthy, true);
  assert.deepEqual(verdict.missing, []);

  const moved = JSON.parse(JSON.stringify(baseline.menu));
  const store = storeOf(moved);
  const tracy = store.items.splice(store.items.findIndex((item) => item.title === "Tracy Fire Department"), 1)[0];
  store.items.find((item) => item.title === "Manteca Fire Department").items.push(tracy);
  assert.deepEqual(guard.assessMenu(moved, baseline).missing, []);
});

/* ---------------------------------------------------------------------------
   observe — the baseline and the history
   ------------------------------------------------------------------------- */

test("observe adopts a healthy first read, rewrites only on change, and never advances on a wiped menu", async () => {
  guard.setStorage(guard.memoryStorage());
  const menu = fullMenu();

  const first = await guard.observe(menu, { reason: "final-check" });
  assert.equal(first.healthy, true);
  assert.equal(first.advanced, true);
  assert.equal((await guard.loadBaseline()).reason, "final-check");
  assert.equal(first.baseline.storeCount, 112);
  assert.equal((await guard.listHistory()).length, 1);

  // Same tree: nothing written.
  const atBefore = (await guard.loadBaseline()).at;
  const again = await guard.observe(JSON.parse(JSON.stringify(menu)), { reason: "propose" });
  assert.equal(again.advanced, false);
  assert.equal((await guard.loadBaseline()).at, atBefore);
  assert.equal((await guard.listHistory()).length, 1);

  // The wipe: refused as a baseline, kept once as suspect.
  const broken = await guard.observe(wiped(menu), { reason: "propose" });
  assert.equal(broken.healthy, false);
  assert.equal(broken.advanced, false);
  assert.equal(broken.baseline.storeCount, 112, "the last good copy is still the baseline");
  assert.equal(guard.summarizeMenu((await guard.loadBaseline()).menu).storeCount, 112);
  await guard.observe(wiped(menu), { reason: "approve" });
  const history = await guard.listHistory();
  assert.equal(history.filter((name) => /-suspect-[0-9a-f]{8}\.json$/.test(name)).length, 1, "one suspect snapshot per distinct tree");
  const suspect = await guard.loadSnapshot(history.find((name) => /suspect/.test(name)));
  assert.equal(suspect.storeCount, 0);

  // Dan adds a store: healthy, so it becomes the new baseline.
  const grown = JSON.parse(JSON.stringify(menu));
  storeOf(grown).items.push(collectionItem("Dixon Fire Department", 777005));
  const next = await guard.observe(grown, { reason: "after-insert" });
  assert.equal(next.advanced, true);
  assert.equal(next.baseline.storeCount, 113);
});

test("a wiped first-ever read is never adopted as the baseline", async () => {
  guard.setStorage(guard.memoryStorage());
  const seen = await guard.observe(wiped(fullMenu()), { reason: "propose" });
  assert.equal(seen.healthy, false);
  assert.equal(await guard.loadBaseline(), null);
  assert.equal(seen.baseline, null);
});

test("storage trouble never breaks the read that observed the menu", async () => {
  guard.setStorage({
    read: async () => {
      throw new Error("blob storage is down");
    },
    write: async () => {
      throw new Error("blob storage is down");
    },
    list: async () => [],
    remove: async () => {}
  });
  const seen = await guard.observe(wiped(fullMenu()), { reason: "propose" });
  assert.equal(seen.healthy, false, "the absolute rules still apply");
  assert.match(seen.storageError, /blob storage is down/);
});

test("history keeps the newest 60 snapshots", async () => {
  guard.setStorage(guard.memoryStorage());
  const menu = fullMenu();
  for (let i = 0; i < 65; i++) await guard.saveSnapshot(menu, { reason: `snapshot ${String(i).padStart(2, "0")}` });
  const names = await guard.listHistory();
  assert.equal(names.length, guard.HISTORY_KEEP);
  assert.ok(names.every((name) => name.startsWith("megamenu/history/") && name.endsWith(".json")));
});

test("accepting the menu keeps the old copy in history, and an empty Store list cannot be accepted", async () => {
  guard.setStorage(guard.memoryStorage());
  await guard.observe(fullMenu(), { reason: "final-check" });
  const smaller = withoutStores(fullMenu(), 20);

  const accepted = await guard.acceptBaseline(smaller, { by: "Dan" });
  assert.equal(accepted.by, "Dan");
  assert.equal(guard.summarizeMenu((await guard.loadBaseline()).menu).storeCount, 92);
  const history = await guard.listHistory();
  const replaced = await guard.loadSnapshot(history.find((name) => /replaced-baseline/.test(name)));
  assert.equal(replaced.storeCount, 112, "the 112-store copy can still be restored from");

  await assert.rejects(() => guard.acceptBaseline(wiped(fullMenu()), { by: "Dan" }), (error) => {
    assert.equal(error.code, "BAD_REQUEST");
    assert.match(error.message, /0 stores/);
    return true;
  });
  assert.equal(guard.summarizeMenu((await guard.loadBaseline()).menu).storeCount, 92, "a refused accept changes nothing");
});

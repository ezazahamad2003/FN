const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ref = require("../referenceTables");

const FIXTURES = path.join(__dirname, "fixtures");

test("parses the Department-ID-Agency-List Google Doc export", () => {
  const text = fs.readFileSync(path.join(FIXTURES, "department-id-agency-list.txt"), "utf8");
  const rows = ref.parseDepartmentCodeListText(text);
  assert.ok(rows.length > 900, `expected ~1000 rows, got ${rows.length}`);
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  assert.equal(byCode.ABL.agency, "Arrowbear Lake FD");
  assert.equal(byCode.ABL.city, "Arrowbear Lake");
  assert.equal(byCode.WOO.agency, "Woodbridge FPD");
  assert.equal(byCode.WPL.agency, "West Plainfield FPD");
  assert.equal(byCode.WPL.city, "Davis");
  assert.equal(byCode.ZAM.agency, "Zamora FPD");
  // Page-break boundary: WPT follows a repeated page header.
  assert.equal(byCode.WPT.agency, "West Point FPD");
  // Out-of-state prefix codes keep their state.
  assert.equal(byCode["AZ-YMA"].agency, "Yuma FD");
  assert.equal(byCode["AZ-YMA"].state, "AZ");
  assert.ok(rows.every((r) => r.source === "macs"));
  assert.ok(!rows.some((r) => /MACS/i.test(r.code)));
});

test("parses the FN Simple Stores Menu doc into blank-library seed rows", () => {
  const text = fs.readFileSync(path.join(FIXTURES, "stores-menu-detailed.txt"), "utf8");
  const rows = ref.parseStoresMenuText(text);
  const by = Object.fromEntries(rows.map((r) => [r.styleNumber, r]));
  assert.ok(rows.length >= 30, `got ${rows.length}`);
  assert.deepEqual(
    { ...by.NL3600, approxPrice: by.NL3600.approxPrice },
    { styleNumber: "NL3600", brand: "Next Level", type: "Standard T-Shirts", decoration: "print", approxPrice: 24, fulfillmentDefault: "One Week Item", source: "stores-menu" }
  );
  assert.equal(by["72318"].approxPrice, 50);
  assert.equal(by.R112.decoration, "embroidery");
  assert.equal(by.ST349P.decoration, "print or embroidery");
  assert.equal(by["70R95"].decoration, "tailored");
  assert.equal(by["70R95"].fulfillmentDefault, "Non Stock Item");
  assert.equal(by.CS410.brand, "Corner Stone");
});

test("reads department codes already in use off Drive folder names", () => {
  const rows = ref.codesFromFolderNames(["Vacaville Fire Department (VAC)", "(BSH) Bishop FD", "Customer Store Intakes", "Sierra College EMS Academy (SCEA) ", "(EMSA) "]);
  assert.deepEqual(rows.map((r) => r.code), ["VAC", "BSH", "SCEA", "EMSA"]);
  assert.equal(rows[0].source, "drive-departments");
  assert.equal(rows[1].source, "drive-omni");
  assert.equal(rows[1].agency, "Bishop FD");
});

test("seeded tables work without blob storage (in-memory)", async () => {
  const prev = process.env.AZURE_STORAGE_CONNECTION_STRING;
  delete process.env.AZURE_STORAGE_CONNECTION_STRING;
  ref.invalidate();
  try {
    const colors = await ref.colorTable();
    assert.ok(colors.some((c) => c.code === "NVY"));
    const text = await ref.standardText("non-stock-notice");
    assert.match(text.html, /Non-Stock Item Notice/);
    const p = await ref.propose("color-codes", { code: "UR", color: "University Red" }, { onboardingId: "x", reason: "test" });
    assert.equal(p.status, "pending");
    assert.equal((await ref.pendingProposals("color-codes")).length, 1);
    await assert.rejects(() => ref.propose("color-codes", { code: "NVY", color: "Navy" }), /already on the/);
    const decided = await ref.decideProposal("color-codes", p.id, { approve: true, by: "Dan" });
    assert.equal(decided.status, "approved");
    assert.ok((await ref.colorTable()).some((c) => c.code === "UR" && c.status === "active" && c.approvedBy === "Dan"));
    await ref.rememberBlank({ styleNumber: "nl3600", brand: "Next Level", sizes: ["S", "M"] });
    await ref.rememberBlank({ styleNumber: "NL3600", sizes: ["L"], masterProductId: "gid://shopify/Product/1" });
    const blank = await ref.blankByStyleNumber("NL3600");
    assert.equal(blank.brand, "Next Level");
    assert.deepEqual(blank.sizes, ["S", "M", "L"]);
    assert.equal(blank.masterProductId, "gid://shopify/Product/1");
  } finally {
    if (prev) process.env.AZURE_STORAGE_CONNECTION_STRING = prev;
    ref.invalidate();
  }
});

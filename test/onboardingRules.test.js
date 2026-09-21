const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../onboardingRules");


test("the mega menu item is named without the collection's ordinal", () => {
  // Live megamenu: 108 department entries, none carrying an "N." prefix.
  assert.equal(rules.megaMenuItemTitle("1. Vacaville Fire Department"), "Vacaville Fire Department");
  assert.equal(rules.megaMenuItemTitle("2. Local 1171 Apparel"), "Local 1171 Apparel");
  assert.equal(rules.megaMenuItemTitle("10. Some Store"), "Some Store");
  // Already plain, or empty, is left alone.
  assert.equal(rules.megaMenuItemTitle("Bishop Fire Department"), "Bishop Fire Department");
  assert.equal(rules.megaMenuItemTitle(""), "");
  // A number that is part of the name is not an ordinal.
  assert.equal(rules.megaMenuItemTitle("Local 1243"), "Local 1243");
});

test("sizes: alpha, tall, hats, numeric, waist x inseam, fitted", () => {
  assert.deepEqual(rules.normalizeSize("s"), { size: "S", kind: "alpha" });
  assert.deepEqual(rules.normalizeSize("2xl"), { size: "2XL", kind: "alpha" });
  assert.deepEqual(rules.normalizeSize("XXL"), { size: "2XL", kind: "alpha" });
  assert.deepEqual(rules.normalizeSize("xlt"), { size: "XLT", kind: "tall" });
  assert.deepEqual(rules.normalizeSize("one size"), { size: "OSFA", kind: "hat" });
  assert.deepEqual(rules.normalizeSize("s/m"), { size: "S/M", kind: "hat" });
  assert.deepEqual(rules.normalizeSize("34"), { size: "34", kind: "numeric" });
  assert.deepEqual(rules.normalizeSize("30x32"), { size: "30x32", kind: "waistInseam" });
  assert.deepEqual(rules.normalizeSize("30 / 32"), { size: "30x32", kind: "waistInseam" });
  assert.deepEqual(rules.normalizeSize("7 1/8"), { size: "71/8", kind: "fitted" });
  assert.ok(rules.normalizeSize("27").error);
  assert.ok(rules.normalizeSize("giant").error);
  assert.ok(rules.normalizeSize("").error);
});

test("decoration codes: parse, order, two digits, never mixed", () => {
  const nd = rules.normalizeDecorations("B01/F01");
  assert.deepEqual(nd.codes, ["F01", "B01"]);
  assert.equal(nd.method, "print");
  assert.deepEqual(rules.normalizeDecorations(["ls01", "rs01", "b02", "f01"]).codes, ["F01", "B02", "RS01", "LS01"]);
  assert.deepEqual(rules.normalizeDecorations("E02, E01").codes, ["E01", "E02"]);
  const mixed = rules.normalizeDecorations("F01/E01");
  assert.ok(mixed.errors.some((e) => /all print or all embroidery/.test(e)));
  assert.ok(rules.normalizeDecorations("F1").errors.length);
  assert.ok(rules.normalizeDecorations("F001").errors.length);
  assert.ok(rules.normalizeDecorations("X01").errors.length);
  assert.deepEqual(rules.normalizeDecorations("").codes, []);
});

test("decoration files must match the Omni Printer file names", () => {
  const r = rules.matchDecorationFiles("VAC", ["F01", "B01", "RS01"], ["VAC-F01.png", "vac-b01.PNG", "other.png"]);
  assert.deepEqual(r.matched, { F01: "VAC-F01.png", B01: "vac-b01.PNG" });
  assert.deepEqual(r.missing, ["RS01"]);
  assert.equal(rules.decorationFileStem("VAC", "F01"), "VAC-F01");
});

test("colour codes: exact, duplicates resolved to preferred with warning, unknown proposes", () => {
  assert.equal(rules.resolveColorCode("Navy").code, "NVY");
  assert.equal(rules.resolveColorCode("midnight navy").code, "MN");
  assert.equal(rules.resolveColorCode("Charcoal / Neon Yellow").code, "CNY");
  const black = rules.resolveColorCode("Black");
  assert.equal(black.code, "BLK");
  assert.match(black.warning, /duplicate/i);
  const charcoal = rules.resolveColorCode("Charcoal");
  assert.equal(charcoal.code, "CHL");
  assert.equal(rules.resolveColorCode("MN").code, "MN");
  assert.equal(rules.resolveColorCode("OSFA").missing, true);
  const unknown = rules.resolveColorCode("University Red");
  assert.equal(unknown.missing, true);
  assert.ok(unknown.proposal);
  assert.ok(unknown.alternatives.includes("UR"));
  assert.match(unknown.error, /not on the Color Code List/);
  // An unknown colour never silently reuses an existing code.
  const takenAll = rules.COLOR_CODES_SEED.map((r) => r.code);
  assert.ok(unknown.alternatives.every((c) => !takenAll.includes(c)));
});

test("department codes: proposal examples from the spec and collision flags", () => {
  const bah = rules.proposeDepartmentCodes("Bahama Fire Department");
  assert.equal(bah[0].code, "BAH");
  const gt = rules.proposeDepartmentCodes("Granville Township Fire Department", { taken: new Set(["GRA"]) });
  assert.equal(gt[0].code, "GRA");
  assert.equal(gt[0].inUse, true);
  assert.ok(gt.some((c) => c.code === "GTFD" && !c.inUse));
  assert.ok(rules.validateDepartmentCode("vac").code === "VAC");
  assert.ok(rules.validateDepartmentCode("V4C").error);
  assert.ok(rules.validateDepartmentCode("VACAV").error);
});

test("department code lookup ranks exact agency matches first", () => {
  const list = [
    { code: "VAC", agency: "Vacaville FD", city: "Vacaville" },
    { code: "VCF", agency: "Vacaville FPD", city: "Vacaville" },
    { code: "WOO", agency: "Woodbridge FPD", city: "Woodbridge" }
  ];
  const r = rules.lookupDepartmentCode("Vacaville Fire Department", list);
  assert.equal(r[0].code, "VAC");
  assert.ok(r.every((row) => row.code !== "WOO"));
  assert.equal(rules.lookupDepartmentCode("Nowhere Fire", list).length, 0);
});

test("names: folders, collection title, department tag", () => {
  assert.equal(rules.departmentFolderName("Vacaville Fire Department", "VAC"), "Vacaville Fire Department (VAC)");
  assert.equal(rules.productionFolderName("Vacaville Fire Department", "VAC"), "(VAC) Vacaville Fire Department");
  assert.equal(rules.collectionTitle("Vacaville Fire Department"), "1. Vacaville Fire Department");
  assert.equal(rules.collectionTitle("Vacaville Local 3501", 2), "2. Vacaville Local 3501");
  assert.equal(rules.departmentTag("  Vacaville  Fire Department "), "Vacaville Fire Department");
});

test("vendor values are exact, no hyphens", () => {
  assert.equal(rules.normalizeVendor("one-week item").vendor, "One Week Item");
  assert.equal(rules.normalizeVendor("Non-Stock Item").vendor, "Non Stock Item");
  assert.ok(rules.normalizeVendor("Backorder").error);
  assert.ok(rules.normalizeVendor("").error);
});

test("SKU examples from the spec", () => {
  assert.equal(rules.buildSku({ styleNumber: "NL3600", size: "L", colorCode: "NVY", departmentCode: "VAC", decorationCodes: ["F01", "B01"] }), "NL3600-L-NVY-VAC-F01/B01");
  assert.equal(rules.buildSku({ styleNumber: "R112", size: "OSFA", colorCode: "NVY", departmentCode: "VAC", decorationCodes: ["E01"] }), "R112-OSFA-NVY-VAC-E01");
  assert.equal(rules.buildSku({ styleNumber: "NL3600", size: "L", colorCode: "NVY", departmentCode: "VAC", decorationCodes: ["F01", "B01", "RS01"] }), "NL3600-L-NVY-VAC-F01/B01/RS01");
  assert.equal(rules.buildSku({ styleNumber: "FP52", size: "34", colorCode: "MN", departmentCode: "RIP", decorationCodes: [] }), "FP52-34-MN-RIP");
});

test("expandProduct builds the full variant matrix with unique SKUs and the right tags/options", () => {
  const r = rules.expandProduct(
    {
      brand: "Next Level",
      styleNumber: "nl3600",
      type: "T-Shirt",
      colors: ["Navy", "Midnight Navy"],
      sizes: ["S", "M", "L", "XL", "2XL", "3XL"],
      styles: [{ decorationCodes: "F01/B01" }, { decorationCodes: "F02/B01" }],
      fulfillment: "One Week Item",
      classB: false
    },
    { departmentCode: "VAC", productionFiles: ["VAC-F01.png", "VAC-F02.png", "VAC-B01.png"] }
  );
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(r.variants.length, 2 * 6 * 2);
  assert.equal(new Set(r.variants.map((v) => v.sku)).size, r.variants.length);
  assert.deepEqual(r.options.map((o) => o.name), ["Color", "Size", "Style"]);
  assert.deepEqual(r.options[2].values, ["Style 1", "Style 2"]);
  assert.deepEqual(r.product.tags, ["VAC"]);
  assert.equal(r.product.fulfillment, "One Week Item");
  assert.equal(r.product.decorationMethod, "print");
  assert.equal(r.product.title, "Next Level T-Shirt");
  const first = r.variants[0];
  assert.equal(first.sku, "NL3600-S-NVY-VAC-F01/B01");
  assert.deepEqual(first.optionValues, [
    { optionName: "Color", name: "Navy" },
    { optionName: "Size", name: "S" },
    { optionName: "Style", name: "Style 1" }
  ]);
  const style2 = r.variants.find((v) => v.style === "Style 2" && v.color === "Midnight Navy" && v.size === "3XL");
  assert.equal(style2.sku, "NL3600-3XL-MN-VAC-F02/B01");
});

test("expandProduct: embroidered hat gets the Embroidered tag, Class B gets Uniform, single style has no Style option", () => {
  const hat = rules.expandProduct(
    { brand: "Richardson", styleNumber: "R112", type: "Snapback", colors: ["Navy"], sizes: ["OSFA"], decorationCodes: "E01", fulfillment: "Non Stock Item" },
    { departmentCode: "VAC" }
  );
  assert.equal(hat.ok, true, hat.errors.join("; "));
  assert.deepEqual(hat.product.tags, ["VAC", "Embroidered"]);
  assert.deepEqual(hat.options.map((o) => o.name), ["Color", "Size"]);
  assert.equal(hat.variants[0].sku, "R112-OSFA-NVY-VAC-E01");
  const classB = rules.expandProduct(
    { brand: "Flying Cross", styleNumber: "70R95", type: "Class B Shirt", colors: ["Navy"], sizes: ["S"], decorationCodes: "E01", fulfillment: "Non Stock Item", classB: true },
    { departmentCode: "VAC" }
  );
  assert.deepEqual(classB.product.tags, ["VAC", "Embroidered", "Uniform"]);
});

test("expandProduct: errors for mixed methods, missing print files, unknown colours, bad vendor", () => {
  const mixed = rules.expandProduct(
    { brand: "X", styleNumber: "X1", colors: ["Navy"], sizes: ["S"], decorationCodes: "F01/E01", fulfillment: "One Week Item" },
    { departmentCode: "VAC" }
  );
  assert.equal(mixed.ok, false);
  assert.ok(mixed.errors.some((e) => /all print or all embroidery/.test(e)));

  const missingFile = rules.expandProduct(
    { brand: "X", styleNumber: "X1", colors: ["Navy"], sizes: ["S"], decorationCodes: "F01/B01", fulfillment: "One Week Item" },
    { departmentCode: "VAC", productionFiles: ["VAC-F01.png"] }
  );
  assert.ok(missingFile.errors.some((e) => /VAC-B01/.test(e)));

  const unknownColor = rules.expandProduct(
    { brand: "X", styleNumber: "X1", colors: ["University Red"], sizes: ["S"], decorationCodes: "F01", fulfillment: "One Week Item" },
    { departmentCode: "VAC" }
  );
  assert.equal(unknownColor.ok, false);
  assert.equal(unknownColor.product.colors[0].missing, true);
  assert.equal(unknownColor.variants[0].sku, null);

  const badVendor = rules.expandProduct(
    { brand: "X", styleNumber: "X1", colors: ["Navy"], sizes: ["S"], decorationCodes: "F01", fulfillment: "one-week-item" },
    { departmentCode: "VAC" }
  );
  assert.equal(badVendor.ok, true);
  assert.equal(badVendor.product.fulfillment, "One Week Item");
  const wrongVendor = rules.expandProduct(
    { brand: "X", styleNumber: "X1", colors: ["Navy"], sizes: ["S"], decorationCodes: "F01", fulfillment: "Drop Ship" },
    { departmentCode: "VAC" }
  );
  assert.ok(wrongVendor.errors.some((e) => /Vendor must be exactly/.test(e)));
});

test("expandProduct: plain stock pants have no decoration segment and an assumption", () => {
  const pants = rules.expandProduct(
    { brand: "Workrite", styleNumber: "FP52", type: "Pants", colors: ["Midnight Navy"], sizes: ["30x30", "32", "34x32"], decorationCodes: "", fulfillment: "Non Stock Item", classB: true },
    { departmentCode: "RIP" }
  );
  assert.equal(pants.ok, true, pants.errors.join("; "));
  assert.equal(pants.product.hasDecoration, false);
  assert.deepEqual(pants.product.tags, ["RIP", "Uniform"]);
  assert.equal(pants.variants[0].sku, "FP52-30x30-MN-RIP");
  assert.ok(pants.assumptions.some((a) => /stock item/.test(a)));
  assert.ok(pants.assumptions.some((a) => /waist x inseam/.test(a)));
});

test("description follows Section 11 and Appendix B exactly", () => {
  const html = rules.buildProductDescriptionHtml({
    brand: "Next Level",
    styleNumber: "NL3600",
    bullets: ["4.3-ounce, 100% combed ring spun cotton", "Side seamed"],
    measurements: { sizes: ["S", "M"], rows: [{ label: "Chest", values: ["19", "20 1/2"] }] },
    hasMockup: true,
    vendor: "Non Stock Item"
  });
  const order = [
    html.indexOf("Logo size &amp; placement are an approximation"),
    html.indexOf("<p>Next Level (NL3600)</p>"),
    html.indexOf("<li>4.3-ounce, 100% combed ring spun cotton</li>"),
    html.indexOf("<table"),
    html.indexOf("<h3>Non-Stock Item Notice</h3>")
  ];
  assert.ok(order.every((i) => i >= 0), html);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(html.includes("<strong>Please Note:</strong> Items marked <strong>Non-Stock</strong> are not kept in our warehouse."));
  const oneWeek = rules.buildProductDescriptionHtml({ brand: "Sport-Tek", styleNumber: "ST349P", bullets: [], hasMockup: false, vendor: "One Week Item" });
  assert.ok(!oneWeek.includes("Non-Stock Item Notice"));
  assert.ok(!oneWeek.includes("approximation"));
  assert.equal(rules.collectionDescriptionHtml(), rules.NON_STOCK_NOTICE_HTML);
});

test("extractDescriptionParts pulls bullets and the measurement table from a live description", () => {
  const live =
    '<p>Logo size &amp; placement are an approximation.</p>\n<p>Next Level (NL3600)</p>\n<ul>\n<li>4.3-ounce, 100% combed ring spun cotton, 32 singles</li>\n<li>Side seamed</li>\n</ul>\n<table data-sheets-baot="1" border="1"><tbody><tr><td>Chest</td><td>19</td></tr></tbody></table>';
  const parts = rules.extractDescriptionParts(live);
  assert.deepEqual(parts.bullets, ["4.3-ounce, 100% combed ring spun cotton, 32 singles", "Side seamed"]);
  assert.ok(parts.measurementsHtml.startsWith("<table"));
  assert.ok(!parts.measurementsHtml.includes("data-sheets"));
  assert.equal(parts.brandLine, "Next Level (NL3600)");
});

test("mockup file names and banner logo choice", () => {
  assert.equal(rules.mockupFileName({ departmentCode: "VAC", styleNumber: "NL3600", colorCode: "NVY", style: "Style 1", face: "front" }), "VAC_NL3600_NVY_Style1_FRONT.png");
  assert.equal(rules.mockupFileName({ departmentCode: "VAC", styleNumber: "NL3600", colorCode: "NVY", face: "back" }), "VAC_NL3600_NVY_BACK.png");
  assert.equal(rules.chooseBannerLogo([{ id: "a", role: "back" }, { id: "b", role: "scramble" }]).id, "b");
  assert.equal(rules.chooseBannerLogo([{ id: "a", role: "chest" }, { id: "p", role: "pick" }]).id, "p");
  assert.equal(rules.chooseBannerLogo([]), null);
});

test("mega menu insertion goes directly above the first public store", () => {
  const items = [{ title: "Bishop Fire Department" }, { title: "Ripon Fire District" }, { title: "FN Simple Merch" }, { title: "SF City Gear" }];
  assert.equal(rules.megaMenuInsertIndex(items), 2);
  assert.equal(rules.megaMenuInsertIndex([{ title: "Only Dept" }]), 1);
});

test("alphabetical insertion for Helium department lists", () => {
  const list = ["Alameda City FD", "Bishop Fire Department", "Tracy Fire", "West Plainfield Fire"];
  assert.equal(rules.alphabeticalInsertIndex(list, "Vacaville Fire Department"), 3);
  assert.equal(rules.alphabeticalInsertIndex(list, "Aardvark FD"), 0);
  assert.equal(rules.alphabeticalInsertIndex(list, "Zzz"), 4);
});

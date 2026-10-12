const test = require("node:test");
const assert = require("node:assert/strict");
const blanks = require("../blanks");

test("familyKeys looks the style up under the supplier's spelling too (R112 → 112)", () => {
  const keys = blanks.familyKeys({ vendor: "Richardson", brandStyle: "R112", garmentColor: "Navy", productType: "Snapback hat" });
  // The verified navy cap is booked as richardson|112|navy|hat.
  assert.ok(keys.includes("richardson|112|navy|hat"), keys.join(", "));
  assert.ok(keys.includes("richardson|r112|navy|hat"));
  // A style without a letter prefix gains no invented one.
  const plain = blanks.familyKeys({ vendor: "Richardson", brandStyle: "112", garmentColor: "Navy", productType: "hat" });
  assert.deepEqual(plain, ["richardson|112|navy|hat"]);
});

/* Ripon, 2026-10-12: Next Level's own product page carries 3600-WEBSITE-SPEC.jpg
   (an outline tee beside a measurement table). It passed the vision gate, was
   booked as the Midnight Navy blank, and the tee went to Shopify as a spec
   sheet with the crest stamped on the line drawing. */
test("a spec sheet, size chart or drawing is never a blank candidate", () => {
  for (const url of [
    "https://www.nextlevelapparel.com/cdn/shop/files/3600-WEBSITE-SPEC.jpg?v=7453078176052879261",
    "https://www.nextlevelapparel.com/cdn/shop/files/3601-WEBSITE-SPEC_XS-3XL.jpg?v=864187572062272391",
    "https://cdn.example.com/NL3600_size-chart.png",
    "https://cdn.example.com/NL3600_measurements.jpg",
    "https://cdn.example.com/3600-tech-flat.png",
    "https://cdn.example.com/R112_line-art.png"
  ]) {
    assert.equal(blanks.isNonPhotoImageUrl(url), true, url);
    assert.ok(blanks.scoreImageUrl(url) < 0, url);
  }
});

/* Ripon, 2026-10-12: the CT100617 search found the real SanMar flat front
   on a distributor page, then spent four of its eight vision verdicts on the
   page's "_flat_back-" files and most of its downloads on 80-px and 273-px
   thumbnails whose sizes the URL pattern did not read. */
test("back views, size-capped thumbnails and payment badges are never blank candidates", () => {
  for (const url of [
    "https://www.rowapparel.com/image/cache/catalog/vendor/sanmar/ct100617/CT100617_newnavy_flat_back-1100x1100h.jpg",
    "https://cdn.blankstyle.com/files/p_images/1830/richardson_4332-navy-backFlat.jpg",
    "https://cdnp.sanmar.com/medias/1200W-46775-TrueNavy-5-ST349PTrueNavyFlatBack.jpg",
    "https://www.rowapparel.com/image/cache/catalog/vendor/sanmar/ct100617/CT100617_newnavy_flat_front-80x80h.jpg",
    "https://flare.fullsource.com/images/items/a/273/SM-CT100617-New-Navy-A1_273x0.jpg",
    "https://www.levinsonsuniforms.com/images/card_acceptance/visa.png",
    "https://www.levinsonsuniforms.com/images/card_acceptance/mastercard_transparent.png"
  ]) {
    assert.ok(blanks.scoreImageUrl(url) < 0, url);
  }
});

test("the real flat front of the same style stays a candidate; 'black' and 'backpack' are not back views", () => {
  for (const url of [
    "https://www.rowapparel.com/image/cache/catalog/vendor/sanmar/ct100617/CT100617_newnavy_flat_front-1100x1100h.jpg",
    "https://flare.fullsource.com/images/items/a/raw/SM-CT100617-New-Navy-A1.jpg",
    "https://cdn.blankstyle.com/files/p_images/1830/next-level-apparel_3214-black-frontFlat.jpg",
    "https://cdn.example.com/carhartt-backpack-navy-front.jpg"
  ]) {
    assert.ok(blanks.scoreImageUrl(url) >= 0, `${url} must stay a candidate`);
  }
  // The flat front outranks the model shot of the same colourway.
  assert.ok(
    blanks.scoreImageUrl("https://www.rowapparel.com/image/cache/catalog/vendor/sanmar/ct100617/CT100617_newnavy_flat_front-1100x1100h.jpg") >
      blanks.scoreImageUrl("https://flare.fullsource.com/images/items/a/raw/SM-CT100617-New-Navy-A1.jpg")
  );
});

test("real flat-front photos are not mistaken for spec sheets", () => {
  for (const url of [
    "https://sanmarsports.com/cdn/shop/files/NL3600_midnightnavy_flat_front.jpg?v=1750226539&width=1946",
    "https://cdn.blankstyle.com/files/p_images/1830/next-level-apparel_3214-black-frontFlat.jpg",
    "https://flare.fullsource.com/images/items/a/raw/SS-NEXT-3600-Midnight-Navy.jpg",
    // "spec" inside a longer word is not a spec sheet.
    "https://cdn.example.com/specialty-navy-flat-front.jpg",
    // The spec query string or folder is not the file.
    "https://cdn.example.com/specs/NL3600_navy_flat_front.jpg?spec=1"
  ]) {
    assert.equal(blanks.isNonPhotoImageUrl(url), false, url);
    assert.ok(blanks.scoreImageUrl(url) >= 0, `${url} must stay a candidate`);
  }
});

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

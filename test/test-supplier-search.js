require("dotenv").config({ path: "C:/Users/ezaza/OneDrive/Desktop/FN/.env" });
const { findSupplierBlank } = require("C:/Users/ezaza/OneDrive/Desktop/FN/blanks.js");

(async () => {
  const arg = (i, fallback) => {
    const value = process.argv[i];
    return value === undefined || value === "-" ? fallback : value;
  };
  const product = {
    vendor: arg(2, "SanMar"),
    brandStyle: arg(3, ""),
    garmentColor: arg(4, "navy"),
    productType: arg(5, "t-shirt"),
    productLabel: arg(5, "t-shirt")
  };
  console.log("Testing supplier search:", JSON.stringify(product));
  const started = Date.now();
  const result = await findSupplierBlank(product, { onLog: (m) => console.log("  [log]", m) });
  console.log("---");
  console.log("elapsed:", Math.round((Date.now() - started) / 1000) + "s");
  console.log("found photo:", Boolean(result.imageBuffer));
  console.log("imageUrl:", result.imageUrl);
  console.log("sourceUrl:", result.sourceUrl);
  console.log("note:", result.note);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });

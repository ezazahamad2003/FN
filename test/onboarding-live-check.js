/*
 * Live, READ-ONLY check of every integration the Department Onboarding Agent
 * depends on. Nothing is created, changed or deleted anywhere — it answers
 * "would a real run work against the real accounts right now?".
 *
 *   node test/onboarding-live-check.js
 *
 * It needs the local .env (Shopify client credentials, Google, Azure storage,
 * OPENAI_API_KEY). Each check reports ok / warn / fail with the reason, and
 * the process exits non-zero when any check FAILS. A "warn" is something the
 * agent degrades around by design (no Locksmith token, no menu scope).
 */

require("dotenv").config();

const drive = require("../drive");
const referenceTables = require("../referenceTables");
const rules = require("../onboardingRules");
const shopifyOnboarding = require("../shopifyOnboarding");
const locksmith = require("../locksmith");
const helium = require("../helium");
const { shopifyConnected } = require("../shopify");
const { googleConnected } = require("../auth");
const { blobConfigured, listBlobs } = require("../platformBlob");
const { loadStoredTokens } = require("../tokenStore");

const results = [];
function record(name, state, detail) {
  results.push({ name, state, detail });
  const glyph = state === "ok" ? "PASS" : state === "warn" ? "WARN" : "FAIL";
  console.log(`[${glyph}] ${name}${detail ? " — " + detail : ""}`);
}

async function check(name, fn, { optional = false } = {}) {
  try {
    const detail = await fn();
    record(name, "ok", detail);
  } catch (error) {
    record(name, optional ? "warn" : "fail", error.message);
  }
}

/*
 * The local .env may hold a revoked Google token while the live one lives in
 * the platform-config blob (that is how production is configured), so mirror
 * the server's own boot behaviour before touching Drive.
 */
async function hydrateGoogleToken() {
  if (process.env.GOOGLE_REFRESH_TOKEN || !blobConfigured()) return;
  const stored = await loadStoredTokens();
  if (stored.GOOGLE_REFRESH_TOKEN) process.env.GOOGLE_REFRESH_TOKEN = stored.GOOGLE_REFRESH_TOKEN;
  if (stored.GOOGLE_REFRESH_TOKEN_2) process.env.GOOGLE_REFRESH_TOKEN_2 = stored.GOOGLE_REFRESH_TOKEN_2;
  if (stored.SHOPIFY_ACCESS_TOKEN && !process.env.SHOPIFY_ACCESS_TOKEN) {
    process.env.SHOPIFY_ACCESS_TOKEN = stored.SHOPIFY_ACCESS_TOKEN;
  }
}

async function main() {
  console.log("Department Onboarding Agent — live integration check\n");
  await hydrateGoogleToken();

  await check("Azure Blob storage configured", async () => {
    if (!blobConfigured()) throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set");
    const names = await listBlobs("platform-config");
    return `platform-config holds ${names.length} blob(s)`;
  });

  await check("Shopify connected", async () => {
    if (!shopifyConnected()) throw new Error("no Shopify credentials");
    const tags = await shopifyOnboarding.allProductTags();
    const codes = tags.filter((tag) => /^[A-Z]{3,4}$/.test(tag));
    return `${tags.length} product tags, ${codes.length} look like department codes`;
  });

  await check("Shopify source-product lookup (NL3600)", async () => {
    const source = await shopifyOnboarding.findSourceProduct("NL3600");
    if (!source) throw new Error("no source product found for NL3600");
    return `${source.kind}: ${source.title}`;
  });

  await check("Google Drive connected", async () => {
    if (!googleConnected()) throw new Error("no Google refresh token");
    const folders = await drive.listFilesInFolder(process.env.GDRIVE_PARENT_FOLDER_ID, {
      mimeType: "application/vnd.google-apps.folder"
    });
    return `${folders.length} department folders`;
  });

  await check("Omni Printer folder readable", async () => {
    const id = process.env.GDRIVE_OMNI_PRINTER_FOLDER_ID;
    if (!id) throw new Error("GDRIVE_OMNI_PRINTER_FOLDER_ID is not set");
    const folders = await drive.listFilesInFolder(id, { mimeType: "application/vnd.google-apps.folder" });
    const codes = referenceTables.codesFromFolderNames(folders.map((f) => f.name));
    return `${folders.length} production folders, ${codes.length} carry a department code`;
  });

  await check("A department's print files are named by decoration code", async () => {
    const id = process.env.GDRIVE_OMNI_PRINTER_FOLDER_ID;
    const folders = await drive.listFilesInFolder(id, { mimeType: "application/vnd.google-apps.folder" });
    const bishop = folders.find((f) => /^\(BSH\)/.test(f.name)) || folders[0];
    if (!bishop) throw new Error("no production folder to sample");
    const files = await drive.listFilesInFolder(bishop.id);
    const code = (bishop.name.match(/^\(([A-Z]{2,5})\)/) || [])[1] || "BSH";
    const matched = rules.matchDecorationFiles(code, ["F01", "B01"], files.map((f) => f.name));
    return `${bishop.name}: ${files.length} files; F01/B01 matched ${Object.keys(matched.matched).join(", ") || "none"}`;
  });

  await check("Department Code List exports as text", async () => {
    const docId = process.env.DEPARTMENT_CODE_LIST_DOC_ID;
    if (!docId) throw new Error("DEPARTMENT_CODE_LIST_DOC_ID is not set");
    const text = await drive.exportFileText(docId);
    const rows = referenceTables.parseDepartmentCodeListText(text);
    const vac = rows.find((row) => row.code === "VAC");
    if (!rows.length) throw new Error("parsed 0 rows from the doc");
    return `${rows.length} agencies parsed (VAC = ${vac ? vac.agency : "not found"})`;
  });

  await check("Department code lookup finds a known department", async () => {
    const docId = process.env.DEPARTMENT_CODE_LIST_DOC_ID;
    const text = await drive.exportFileText(docId);
    const rows = referenceTables.parseDepartmentCodeListText(text);
    const matches = rules.lookupDepartmentCode("Woodbridge Fire District", rows);
    if (!matches.length) throw new Error("no match for Woodbridge Fire District");
    return `top match ${matches[0].code} (${matches[0].agency}), score ${matches[0].score.toFixed(2)}`;
  });

  await check("Helium registration form readable", async () => {
    const forms = helium.configuredForms();
    const checks = await helium.checkAllForms("Bishop Fire Department");
    const ok = checks.filter((c) => c.public !== false);
    if (!ok.length) throw new Error(`no form could be read (${checks.map((c) => c.error).join("; ")})`);
    const first = ok[0];
    return `${forms.length} configured; "${first.label}" has ${first.total} departments, Bishop present=${first.present}`;
  });

  await check("Helium insertion point for a NEW department", async () => {
    const checks = await helium.checkAllForms("Zzz Test Fire Department");
    const first = checks.find((c) => c.public !== false);
    if (!first) throw new Error("no readable form");
    if (first.present) throw new Error("the test tag unexpectedly exists");
    return `would insert after "${first.insertAfter || "(start)"}"`;
  });

  await check("Locksmith Admin API", async () => {
    if (!locksmith.configured()) throw new Error("LOCKSMITH_ACCESS_TOKEN is not set — the agent falls back to the lock checklist");
    const locks = await locksmith.listLocks();
    const templates = locksmith.learnKeyTemplates(locks);
    return `${locks.length} locks; secret-link template ${templates.secretLink ? "learned from lock " + templates.fromLockId : "NOT found (shape would be guessed + dry-run)"}`;
  }, { optional: true });

  await check("Mega Menu readable", async () => {
    const menu = await shopifyOnboarding.readMegaMenu();
    if (!menu.available) throw new Error(menu.reason || "menus are not readable with this token");
    const proposal = shopifyOnboarding.proposeMegaMenuInsert(menu.menu, {
      title: "Zzz Test Fire Department",
      collectionHandle: "1-zzz-test-fire-department",
      collectionGid: "gid://shopify/Collection/1"
    });
    return `would insert at index ${proposal.index}, after "${proposal.insertAfter}" and before "${proposal.insertBefore}"`;
  }, { optional: true });

  await check("Storefront reachable", async () => {
    const html = await shopifyOnboarding.fetchStorefrontHtml("/");
    const present = shopifyOnboarding.storefrontNavContains(html, "Bishop Fire Department");
    return `${html.length} bytes; nav mentions Bishop Fire Department: ${present}`;
  }, { optional: true });

  await check("Image model configured", async () => {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    return `OPENAI_IMAGE_MODEL = ${process.env.OPENAI_IMAGE_MODEL || require("../azureOpenai").DEFAULT_IMAGE_MODEL + " (default)"}`;
  });

  const failed = results.filter((r) => r.state === "fail");
  const warned = results.filter((r) => r.state === "warn");
  console.log(`\n${results.length - failed.length - warned.length} ok, ${warned.length} warn, ${failed.length} fail`);
  if (warned.length) {
    console.log("Warnings are integrations the agent degrades around by design:");
    for (const w of warned) console.log(`  - ${w.name}: ${w.detail}`);
  }
  if (failed.length) {
    console.log("Failures:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("live check crashed:", error);
  process.exitCode = 1;
});

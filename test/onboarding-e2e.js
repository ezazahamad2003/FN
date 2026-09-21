/*
 * End-to-end drive of the Department Onboarding Agent through its real HTTP
 * API, against a server started by this script.
 *
 *   node test/onboarding-e2e.js              # dry: no Shopify writes
 *   node test/onboarding-e2e.js --build      # runs the real build (writes!)
 *   node test/onboarding-e2e.js --build --keep   # leaves the record behind
 *
 * Without --build it exercises everything up to (not including) the build:
 * create, packet upload, setup, department-code lookup/approval, policy
 * review, product rows with live validation, production-file matching,
 * capabilities, shared-setting proposals and the report. That path touches
 * Drive (folders + docs) and blob storage but never Shopify.
 *
 * With --build it also runs the build, which creates a real Shopify
 * collection and DRAFT products for a throwaway department, then prints what
 * it made so it can be checked and removed. Products are always DRAFT.
 *
 * The record and its assets are deleted at the end unless --keep is passed.
 * Shopify and Drive artefacts are NEVER deleted by this script — the spec
 * forbids the agent destroying anything, so cleanup there is deliberate and
 * manual, and the script prints exactly what to remove.
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.E2E_PORT || 3477);
const BASE = `http://127.0.0.1:${PORT}`;
const DO_BUILD = process.argv.includes("--build");
const KEEP = process.argv.includes("--keep");
const DEPARTMENT = process.env.E2E_DEPARTMENT || "Zol Test Fire Department";

const steps = [];
function step(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
}

function assetPath(name) {
  return path.join(__dirname, "..", "public", "test-assets", name);
}

async function api(method, route, { json, form, expect = 200 } = {}) {
  const options = { method, headers: {} };
  if (json) {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(json);
  }
  if (form) options.body = form;
  const res = await fetch(`${BASE}${route}`, options);
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text.slice(0, 400) };
  }
  if (expect && res.status !== expect) {
    const error = new Error(`${method} ${route} -> ${res.status} (expected ${expect}): ${JSON.stringify(payload).slice(0, 400)}`);
    error.status = res.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function waitForServer(child) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not become healthy within 60s");
}

async function pollBuild(id, { timeoutMs = 25 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const { onboarding } = await api("GET", `/api/onboardings/${id}`);
    const build = onboarding.build || {};
    const log = build.log || [];
    for (const line of log.slice(lastLog)) console.log(`    ${line}`);
    lastLog = log.length;
    if (build.state && !["running", "starting"].includes(build.state)) return onboarding;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("build did not finish in time");
}

async function main() {
  console.log(`Department Onboarding Agent — end-to-end (${DO_BUILD ? "WITH a real Shopify build" : "dry: no Shopify writes"})`);
  console.log(`department: ${DEPARTMENT}\n`);

  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const serverLog = [];
  child.stdout.on("data", (b) => serverLog.push(String(b)));
  child.stderr.on("data", (b) => serverLog.push(String(b)));

  let id = null;
  let approvedCode = null;
  try {
    const health = await waitForServer(child);
    step("server boots", true, `shopify=${health.shopifyConnected} google=${health.googleConnected}`);

    const caps = await api("GET", "/api/onboardings/capabilities");
    step("capabilities", true, `image=${caps.imageModel} locksmith=${caps.locksmith?.configured} menuWritable=${caps.megaMenu?.writable}`);

    // --- create with a real packet -------------------------------------
    const form = new FormData();
    form.append(
      "payload",
      JSON.stringify({
        departmentName: DEPARTMENT,
        state: "CA",
        storeOrdinal: 1,
        contacts: [{ name: "Test Rep", role: "Captain", email: "rep@example.com", phone: "555-0100" }],
        notes: "End-to-end test packet."
      })
    );
    for (const name of ["Oakdale FD Main.png", "Engine 1.jpg"]) {
      const file = assetPath(name);
      if (fs.existsSync(file)) {
        form.append("artwork", new Blob([fs.readFileSync(file)], { type: name.endsWith(".png") ? "image/png" : "image/jpeg" }), name);
      }
    }
    const created = await api("POST", "/api/onboardings", { form, expect: 201 });
    id = created.onboarding.id;
    step("create onboarding", Boolean(id), `${id} (${created.onboarding.packet?.files?.length || 0} packet files)`);

    const listed = await api("GET", "/api/onboardings");
    step("list onboardings", listed.onboardings.some((o) => o.id === id), `${listed.onboardings.length} records`);

    // --- setup: department code ----------------------------------------
    const setup = await api("POST", `/api/onboardings/${id}/setup`, { json: { by: "e2e" } });
    const code = setup.onboarding.department.code;
    step(
      "setup proposes or finds a department code",
      Boolean(code.value || code.candidates.length),
      code.value ? `${code.value} (${code.source}, approved=${code.approved})` : `candidates: ${code.candidates.map((c) => c.code + (c.inUse ? "*taken*" : "")).join(", ")}`
    );

    if (!code.approved) {
      const pick = code.candidates.find((c) => !c.inUse);
      if (!pick) throw new Error("every proposed code is already taken");
      const approved = await api("POST", `/api/onboardings/${id}/code`, { json: { code: pick.code, by: "e2e" } });
      step("approve the proposed code", approved.onboarding.department.code.approved === true, approved.onboarding.department.code.value);
    }

    const afterSetup = await api("GET", `/api/onboardings/${id}`);
    const drive = afterSetup.onboarding.drive || {};
    step("Drive folders created", Boolean(drive.departmentFolderId && drive.productionFolderId), `dept=${drive.departmentFolderUrl || "-"} production=${drive.productionFolderUrl || "-"}`);
    const review = afterSetup.onboarding.policyReview || {};
    step("policy review + rep email drafted", Boolean(review.reviewedAt), `${(review.missing || []).length} missing topics, email="${review.emailDraft?.subject || "-"}"`);

    // --- build inputs ---------------------------------------------------
    const deptCode = afterSetup.onboarding.department.code.value;

    /* Print-ready files are placed in the Omni Printer folder by the print
       shop, never by the agent, and a row whose file is missing fails
       validation — so a real build stops at that gate until they exist. Stand
       in for the print shop here so --build exercises the build itself rather
       than the refusal. Dry runs deliberately skip this: seeing the missing
       file reported IS the thing a dry run checks. */
    if (DO_BUILD && drive.productionFolderId) {
      /* The SERVER restores the Google refresh token from platform storage at
         boot; this process never did, so calling Drive from here without
         hydrating first fails with "No Google account is connected" even
         though the server two feet away is happily talking to Drive. */
      await require("../auth").hydrateTokensFromStore();
      const { uploadBuffer } = require("../drive");
      const source = assetPath("Oakdale FD Main.png");
      const already = (drive.productionFiles || []).map((f) => f.name);
      const uploaded = [];
      for (const face of ["F01", "B01"]) {
        const name = `${deptCode}-${face}.png`;
        if (already.includes(name)) continue;
        await uploadBuffer({ originalname: name, mimetype: "image/png", buffer: fs.readFileSync(source) }, drive.productionFolderId);
        uploaded.push(name);
      }
      const refreshed = await api("POST", `/api/onboardings/${id}/production-files`, { json: {} });
      const names = (refreshed.onboarding.drive.productionFiles || []).map((f) => f.name);
      step(
        "print files staged in the Omni Printer folder",
        names.includes(`${deptCode}-F01.png`) && names.includes(`${deptCode}-B01.png`),
        uploaded.length ? `uploaded ${uploaded.join(", ")}` : "already present"
      );
    }

    const products = [
      {
        brand: "Next Level",
        styleNumber: "NL3600",
        type: "T-shirt",
        colors: ["Navy"],
        sizes: ["S", "M", "L", "XL", "2XL", "3XL"],
        decorationCodes: "F01/B01",
        fulfillment: "One Week Item",
        classB: false
      },
      {
        brand: "Richardson",
        styleNumber: "R112",
        type: "Snapback hat",
        colors: ["Navy"],
        sizes: ["OSFA"],
        decorationCodes: "E01",
        fulfillment: "Non Stock Item",
        classB: false
      }
    ];
    const saved = await api("PUT", `/api/onboardings/${id}/products`, { json: { products } });
    const rows = saved.onboarding.products;
    const allValid = rows.every((r) => r.validation && r.validation.ok);
    step(
      "product rows validate",
      rows.length === 2,
      rows.map((r) => `${r.styleNumber}: ${r.validation?.ok ? "ok" : "ERRORS " + (r.validation?.errors || []).join("; ")} [${(r.validation?.skuPreview || [])[0] || ""}]`).join(" | ")
    );
    const expectedSku = `NL3600-S-NVY-${deptCode}-F01/B01`;
    const tee = rows.find((r) => r.styleNumber === "NL3600");
    step("SKU matches the spec format", (tee.validation?.skuPreview || []).includes(expectedSku), `expected ${expectedSku}`);

    // --- shared settings --------------------------------------------------
    const proposed = await api("POST", `/api/onboardings/${id}/shared-settings/propose`, { json: {} });
    const shared = proposed.onboarding.sharedSettings;
    step(
      "shared settings proposed (never applied silently)",
      shared.megaMenu.status !== "applied" && shared.helium.status !== "applied",
      `menu=${shared.megaMenu.status} flow=${shared.flow.status} helium=${shared.helium.status} (${(shared.helium.forms || []).map((f) => f.label + ":" + (f.present ? "present" : "absent")).join(", ")})`
    );

    // --- build ------------------------------------------------------------
    if (DO_BUILD) {
      if (!allValid) throw new Error("refusing to build: some product rows are invalid");
      console.log("\n  building (real Shopify writes, DRAFT products)…");
      await api("POST", `/api/onboardings/${id}/build`, { json: { by: "e2e" }, expect: 202 });
      const built = await pollBuild(id);
      const build = built.build || {};
      step("build finished", ["complete", "partial"].includes(build.state), `state=${build.state} ${build.error || ""}`);
      step(
        "collection created",
        Boolean(built.collection?.id),
        `${built.collection?.title} ${built.collection?.url || ""}`
      );
      const madeProducts = (built.products || []).filter((p) => p.shopify?.productId);
      step("products created as DRAFT", madeProducts.length > 0, madeProducts.map((p) => `${p.title} -> ${p.shopify.url}`).join(" | "));
      const mockups = (built.products || []).flatMap((p) => p.mockups || []);
      const rendered = mockups.filter((m) => m.path === "render").length;
      step("mockups rendered", mockups.length > 0, `${mockups.length} images (${rendered} model-rendered), sizes checked in the report`);

      const checked = await api("POST", `/api/onboardings/${id}/final-check`, { json: {} });
      const report = checked.onboarding.report || {};
      step(
        "final check produces the four-section report",
        Array.isArray(report.completed) && Array.isArray(report.needsDan),
        `completed=${report.completed.length} needsDan=${report.needsDan.length} missing=${report.missingInformation.length} warnings=${report.warnings.length}`
      );
      step(
        "not reported complete while items are unresolved",
        checked.onboarding.status !== "complete" || (report.missingInformation.length === 0 && report.warnings.length === 0),
        `status=${checked.onboarding.status}`
      );

      console.log("\n  Shopify/Drive artefacts this run created (remove by hand if unwanted):");
      if (built.collection?.url) console.log(`    collection: ${built.collection.title} — ${built.collection.url}`);
      for (const p of madeProducts) console.log(`    product:    ${p.title} — ${p.shopify.url}`);
      if (drive.departmentFolderUrl) console.log(`    drive:      ${drive.departmentFolderUrl}`);
      if (drive.productionFolderUrl) console.log(`    drive:      ${drive.productionFolderUrl}`);
    } else {
      const report = await api("GET", `/api/onboardings/${id}/report`);
      step("report renders before a build", Boolean(report.report), `needsDan=${(report.report.needsDan || []).length}`);
    }

    // --- cleanup ----------------------------------------------------------
    if (!KEEP) {
      await api("DELETE", `/api/onboardings/${id}`, { json: { confirmName: DEPARTMENT } });
      const gone = await fetch(`${BASE}/api/onboardings/${id}`);
      step("record deleted", gone.status === 404, "Shopify and Drive artefacts are left alone by design");
      id = null;

      approvedCode = afterSetup.onboarding.department.code.value || null;
    }
  } catch (error) {
    step("run", false, error.message);
    console.error(error.stack ? error.stack.split("\n").slice(0, 4).join("\n") : error);
  } finally {
    if (id && !KEEP) {
      try {
        await api("DELETE", `/api/onboardings/${id}`, { json: { confirmName: DEPARTMENT } });
        console.log(`  cleaned up record ${id}`);
      } catch (e) {
        console.log(`  could not clean up ${id}: ${e.message}`);
      }
    }
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 800));
    if (child.exitCode === null) child.kill("SIGKILL");

    /* Approving a code for a throwaway department writes it onto the shared
       Department Code List, where the next run — and Dan — would read it as a
       real agency. Cleaned up here, AFTER the server is gone: reference tables
       are cached per process, so a write while it is still running would be
       overwritten by its copy. */
    if (approvedCode && !KEEP) {
      try {
        const referenceTables = require("../referenceTables");
        referenceTables.invalidate();
        const rows = await referenceTables.getRows("department-codes");
        const mine = rows.filter((r) => r.code === approvedCode && new RegExp(DEPARTMENT, "i").test(r.agency || ""));
        for (const row of mine) await referenceTables.removeRow("department-codes", row.code);
        if (mine.length) console.log(`  removed the test row ${approvedCode} from the Department Code List`);
      } catch (error) {
        console.log(`  could not clean the Department Code List: ${error.message}`);
      }
    }
  }

  const failed = steps.filter((s) => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length) {
    console.log("failed:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    console.log("\nserver output (tail):");
    console.log(serverLog.join("").split("\n").slice(-25).join("\n"));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("e2e crashed:", error);
  process.exitCode = 1;
});

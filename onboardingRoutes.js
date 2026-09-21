/*
 * Department Onboarding Agent — the HTTP surface (design doc §4).
 *
 * Mounted at /api by server.js: `app.use("/api", createOnboardingRouter({
 * requireAdminToken, upload }))`. Every route is admin-gated with the app's
 * own middleware and every handler answers JSON, including its failures — the
 * app's final error handler renders HTML, so nothing here may reach it via
 * next(error). Multer errors are converted the same way.
 *
 * The router holds no rules and no orchestration: it parses the request,
 * calls onboardingAgent / onboardingStore / referenceTables, and maps the
 * error codes those modules raise onto status codes.
 */

const express = require("express");
const agent = require("./onboardingAgent");
const store = require("./onboardingStore");
const referenceTables = require("./referenceTables");
const drive = require("./drive");

// upload.fields for the packet (design doc §4 POST /api/onboardings).
const PACKET_FIELDS = [
  { name: "policies", maxCount: 20 },
  { name: "artwork", maxCount: 20 },
  { name: "contacts", maxCount: 10 },
  { name: "other", maxCount: 20 }
];

const FILES_FIELD = "files";
const FILES_MAX = 40;

// Asset ids are generated as "<base36>-<base36>.<ext>"; anything else — a
// slash, a backslash, ".." — is refused before it reaches the blob layer.
const ASSET_ID_RE = /^[a-z0-9-]+(\.[a-z0-9]+)?$/i;

const ASSET_CACHE_CONTROL = "private, max-age=300";
/* Types that are safe to render inline on the console's own origin. Anything
   else (html, svg, javascript, and whatever else a packet might carry) is
   served as an attachment so the browser never executes it here. */
const INLINE_ASSET_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain"
]);

// A filename safe to put inside a Content-Disposition header.
function assetFilename(name) {
  const base = String(name || "file").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100);
  return base || "file";
}

function clean(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

/* The modules raise errors carrying a `code`; everything else is a 500. */
function fail(res, error) {
  const message = String(error?.message || error || "Something went wrong.");
  switch (error?.code) {
    case "NOT_FOUND":
      return res.status(404).json({ error: message });
    case "BAD_REQUEST":
      return res.status(400).json({ error: message });
    case "STORAGE_UNCONFIGURED":
      return res.status(503).json({ error: message });
    case "BUILD_RUNNING":
      return res.status(409).json({ error: message });
    default:
      return res.status(500).json({ error: message });
  }
}

/* Multer calls next(error) on a rejected upload, which would land in the
   app's HTML error handler; this keeps the answer JSON. */
function withUpload(middleware) {
  return (req, res, next) =>
    middleware(req, res, (error) => {
      if (!error) return next();
      res.status(400).json({ error: error.message || "The upload could not be read." });
    });
}

/* POST /api/onboardings sends its fields as a JSON string in `payload`
   because the rest of the body is multipart; a plain JSON body works too. */
function readPayload(req) {
  const raw = req.body?.payload;
  if (raw === undefined || raw === null || raw === "") return { ...(req.body || {}) };
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("payload must be a JSON object.");
    return parsed;
  } catch (error) {
    const bad = new Error(`payload is not valid JSON: ${error.message}`);
    bad.code = "BAD_REQUEST";
    throw bad;
  }
}

function byOf(req) {
  return clean(req.body?.by);
}

function knownTable(name) {
  return Object.prototype.hasOwnProperty.call(referenceTables.TABLES, name);
}

function createOnboardingRouter({ requireAdminToken, upload } = {}) {
  if (!upload || typeof upload.fields !== "function") {
    throw new Error("createOnboardingRouter needs the app's multer instance as `upload`.");
  }
  // Fail closed, exactly as the missing-multer check above does: a mistyped
  // or forgotten gate would otherwise make every onboarding route — packets,
  // contact details, artwork — public without a sound.
  if (typeof requireAdminToken !== "function") {
    throw new Error("createOnboardingRouter needs the app's requireAdminToken middleware.");
  }
  const gate = requireAdminToken;
  const router = express.Router();
  const packetUpload = withUpload(upload.fields(PACKET_FIELDS));
  const filesUpload = withUpload(upload.array(FILES_FIELD, FILES_MAX));

  /* ---- onboardings ------------------------------------------------------ */

  router.get("/onboardings", gate, async (req, res) => {
    try {
      res.json({ onboardings: await store.listOnboardings() });
    } catch (error) {
      fail(res, error);
    }
  });

  // Before "/onboardings/:id" — otherwise "capabilities" reads as a record id.
  router.get("/onboardings/capabilities", gate, async (req, res) => {
    try {
      res.json(await agent.capabilities());
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/onboardings", gate, packetUpload, async (req, res) => {
    try {
      const payload = readPayload(req);
      const onboarding = await agent.createOnboarding({ payload, files: req.files, by: clean(payload.by) });
      res.status(201).json({ onboarding });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/onboardings/:id", gate, async (req, res) => {
    try {
      res.json({ onboarding: await store.getOnboarding(req.params.id) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/onboardings/:id", gate, async (req, res) => {
    try {
      const { department, packet, products, by } = req.body || {};
      let onboarding = await store.updateOnboarding(req.params.id, (record) => {
        if (department && typeof department === "object") record.department = { ...record.department, ...department, code: record.department.code };
        if (packet && typeof packet === "object" && packet.notes !== undefined) record.packet.notes = String(packet.notes);
        /* Artwork roles decide which logo becomes the collection banner
           (§6.3: the department's pick, else the scramble, else the chest,
           else the back), so the console has to be able to set them. Only the
           role is taken, and only by assetId — the rest of a packet file is
           the server's record of what was uploaded, not the client's to
           rewrite. */
        if (packet && typeof packet === "object" && Array.isArray(packet.files)) {
          const roles = new Map(
            packet.files
              .filter((f) => f && typeof f === "object" && f.assetId)
              .map((f) => [String(f.assetId), clean(f.role).toLowerCase()])
          );
          for (const file of record.packet.files) {
            if (roles.has(String(file.assetId))) file.role = roles.get(String(file.assetId));
          }
        }
        store.appendEvent(record, { type: "edit", message: "Record edited from the console.", by: clean(by) });
        return record;
      });
      /* Product rows never go in raw. saveProducts is what runs §10 — SKU
         generation, colour resolution, print-file matching — and what keeps
         the server-owned parts of a row (mockups, Shopify ids). Writing the
         client's array straight in would drop those and let a hand-made
         `validation: {ok:true}` walk past preflight. */
      if (Array.isArray(products)) onboarding = await agent.saveProducts(req.params.id, products, { by: byOf(req) });
      res.json({ onboarding });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/onboardings/:id", gate, async (req, res) => {
    try {
      const record = await store.getOnboarding(req.params.id);
      const confirmName = clean(req.body?.confirmName);
      if (confirmName.toLowerCase() !== clean(record.department.name).toLowerCase()) {
        return res.status(400).json({ error: `Type the department name exactly ("${record.department.name}") to delete this onboarding.` });
      }
      if (agent.isBuildActive(record.id)) {
        return res.status(409).json({ error: "This onboarding is building. Wait for the build to finish before deleting it." });
      }
      // The record and its assets only. Shopify products, the collection and
      // the Drive folders are never touched.
      const result = await store.deleteOnboarding(record.id);
      res.json({ deleted: true, departmentName: record.department.name, ...result });
    } catch (error) {
      fail(res, error);
    }
  });

  /* ---- files and assets ------------------------------------------------- */

  router.post("/onboardings/:id/files", gate, filesUpload, async (req, res) => {
    try {
      const onboarding = await agent.addFiles(req.params.id, {
        files: req.files,
        kind: req.body?.kind,
        productId: clean(req.body?.productId),
        color: clean(req.body?.color),
        face: clean(req.body?.face),
        decorationCode: clean(req.body?.decorationCode),
        role: clean(req.body?.role),
        by: byOf(req)
      });
      res.json({ onboarding });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/onboardings/:id/files/:assetId", gate, async (req, res) => {
    try {
      if (!ASSET_ID_RE.test(req.params.assetId)) return res.status(404).json({ error: "That file is not on this onboarding." });
      res.json({ onboarding: await agent.removeFile(req.params.id, req.params.assetId, { by: byOf(req) }) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/onboardings/:id/assets/:assetId", gate, async (req, res) => {
    try {
      if (!ASSET_ID_RE.test(req.params.assetId)) return res.status(404).json({ error: "That file is not on this onboarding." });
      const asset = await store.getAsset(req.params.id, req.params.assetId);
      if (!asset) return res.status(404).json({ error: "That file is not on this onboarding." });
      /* The packet is whatever Dan was sent, so the stored mimetype is
         attacker-influenced: multer takes the browser's word for it and a
         "policy.html" or "logo.svg" would come back as active content on the
         console's own origin. Only inert types are echoed back, everything
         else downloads, and nosniff stops the browser second-guessing us. */
      const served = INLINE_ASSET_TYPES.has(String(asset.contentType || "").toLowerCase())
        ? asset.contentType
        : "application/octet-stream";
      const inline = served !== "application/octet-stream";
      res.set("Content-Type", served);
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${assetFilename(asset.name)}"`);
      res.set("Cache-Control", ASSET_CACHE_CONTROL);
      res.send(asset.buffer);
    } catch (error) {
      fail(res, error);
    }
  });

  /* ---- setup ------------------------------------------------------------ */

  router.post("/onboardings/:id/setup", gate, async (req, res) => {
    try {
      res.json({ onboarding: await agent.runSetup(req.params.id, { by: byOf(req) }) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/onboardings/:id/code", gate, async (req, res) => {
    try {
      res.json({ onboarding: await agent.approveCode(req.params.id, { code: req.body?.code, by: byOf(req) }) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/onboardings/:id/review", gate, async (req, res) => {
    try {
      res.json({ onboarding: await agent.reviewPolicy(req.params.id, { by: byOf(req) }) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/onboardings/:id/production-files", gate, async (req, res) => {
    try {
      res.json({ onboarding: await agent.refreshProductionFiles(req.params.id, { by: byOf(req) }) });
    } catch (error) {
      fail(res, error);
    }
  });

  /* ---- build inputs ----------------------------------------------------- */

  router.put("/onboardings/:id/products", gate, async (req, res) => {
    try {
      if (!Array.isArray(req.body?.products)) return res.status(400).json({ error: "products must be an array of rows." });
      res.json({ onboarding: await agent.saveProducts(req.params.id, req.body.products, { by: byOf(req) }) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/onboardings/:id/colors/propose", gate, async (req, res) => {
    try {
      res.json({ onboarding: await agent.proposeColor(req.params.id, { color: req.body?.color, code: req.body?.code, by: byOf(req) }) });
    } catch (error) {
      fail(res, error);
    }
  });

  /* ---- build ------------------------------------------------------------ */

  router.post("/onboardings/:id/build", gate, async (req, res) => {
    try {
      const result = await agent.startBuild(req.params.id, { force: req.body?.force === true, by: byOf(req) });
      if (!result.started) return res.status(409).json({ error: result.reason, build: result.build || null });
      res.status(202).json({ started: true, build: result.build });
    } catch (error) {
      fail(res, error);
    }
  });

  /* ---- shared settings, lock, report ------------------------------------ */

  router.post("/onboardings/:id/shared-settings/propose", gate, async (req, res) => {
    try {
      res.json({ onboarding: await agent.proposeSharedSettings(req.params.id, { by: byOf(req) }) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/onboardings/:id/shared-settings/verify", gate, async (req, res) => {
    try {
      res.json({ onboarding: await agent.verifySharedSettings(req.params.id, { by: byOf(req) }) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/onboardings/:id/shared-settings/:kind/approve", gate, async (req, res) => {
    try {
      const onboarding = await agent.approveSharedSetting(req.params.id, req.params.kind, { by: byOf(req), applied: req.body?.applied === true });
      res.json({ onboarding });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/onboardings/:id/lock", gate, async (req, res) => {
    try {
      const body = req.body || {};
      const manual = clean(body.secretLink) || clean(body.locksmithLockId) || clean(body.secretCode);
      const onboarding = manual
        ? await agent.recordLock(req.params.id, { secretLink: body.secretLink, secretCode: body.secretCode, locksmithLockId: body.locksmithLockId, by: byOf(req) })
        : await agent.createLock(req.params.id, { by: byOf(req) });
      res.json({ onboarding });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/onboardings/:id/final-check", gate, async (req, res) => {
    try {
      res.json({ onboarding: await agent.finalCheck(req.params.id, { by: byOf(req) }) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/onboardings/:id/report", gate, async (req, res) => {
    try {
      const record = await store.getOnboarding(req.params.id);
      res.json({ report: agent.reportFor(record), html: agent.reportHtml(record) });
    } catch (error) {
      fail(res, error);
    }
  });

  /* ---- reference tables -------------------------------------------------- */

  // Before "/reference/:table/..." so the sync verb is never read as a table.
  router.post("/reference/department-codes/sync", gate, async (req, res) => {
    try {
      const docId = clean(req.body?.docId) || clean(process.env.DEPARTMENT_CODE_LIST_DOC_ID);
      if (!docId) return res.status(400).json({ error: "DEPARTMENT_CODE_LIST_DOC_ID is not set, so the Department Code List cannot be imported." });
      const text = await drive.exportFileText(docId, "text/plain");
      const rows = referenceTables.parseDepartmentCodeListText(text);
      if (!rows.length) return res.status(400).json({ error: "No department codes were found in that document." });
      const changed = await referenceTables.upsertRows("department-codes", rows, { source: "Department-ID-Agency-List", by: byOf(req) });
      res.json({ imported: changed, read: rows.length });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/reference/:table", gate, async (req, res) => {
    try {
      if (!knownTable(req.params.table)) return res.status(404).json({ error: `There is no reference table "${req.params.table}".` });
      const doc = await referenceTables.loadTable(req.params.table);
      res.json({ rows: doc.rows, proposals: doc.proposals, updatedAt: doc.updatedAt || "", source: doc.source || "" });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/reference/:table/rows", gate, async (req, res) => {
    try {
      if (!knownTable(req.params.table)) return res.status(404).json({ error: `There is no reference table "${req.params.table}".` });
      if (!Array.isArray(req.body?.rows)) return res.status(400).json({ error: "rows must be an array." });
      const changed = await referenceTables.upsertRows(req.params.table, req.body.rows, { source: clean(req.body?.source), by: byOf(req) });
      res.json({ changed });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/reference/:table/proposals/:proposalId", gate, async (req, res) => {
    try {
      if (!knownTable(req.params.table)) return res.status(404).json({ error: `There is no reference table "${req.params.table}".` });
      if (typeof req.body?.approve !== "boolean") return res.status(400).json({ error: "approve must be true or false." });
      const proposal = await referenceTables.decideProposal(req.params.table, req.params.proposalId, {
        approve: req.body.approve,
        by: byOf(req),
        edits: req.body?.edits && typeof req.body.edits === "object" ? req.body.edits : null
      });
      res.json({ proposal });
    } catch (error) {
      // decideProposal throws a plain Error for an unknown proposal id.
      if (/not found/i.test(String(error?.message || ""))) return res.status(404).json({ error: error.message });
      fail(res, error);
    }
  });

  return router;
}

module.exports = createOnboardingRouter;

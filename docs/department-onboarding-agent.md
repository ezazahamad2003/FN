# Department Onboarding Agent — design and contracts

Implements "FN Simple Uniforms — Department Onboarding Agent, Build Spec (MVP)"
(September 17, 2026). This document is the contract every module in the feature
is built against. Rules live in code (`onboardingRules.js`); the model is used
only for reading messy policies, drafting the rep email, and rendering mockups.

## 0. Ground truth discovered before building

- Shopify store `fn-simple-uniforms.myshopify.com`. Department collections are
  manual collections titled `1. <Department Name>`; description is the
  Non-Stock Item Notice; banner image is 3584×2048.
- Live SKU convention (Bishop, Sept 2026): `NL3600-S-MN-BSH-F01/B01`,
  `ST349P-S-MN-BSH-F01`, hat `R112-OSFA-NVY-CON-E10`, pants `FP52MN-30-RIP`.
  Style option values are `Style 1`, `Style 2`… with per-Style variant images.
- Products tagged `Master Reference` exist for ~21 blanks (e.g.
  "Next Level Cotton Tee, Short Sleeve (NL3600)", SKU `NL3600-S-NVY`,
  vendor = brand, productType Headwear / Tees & Tanks). They are the "master
  draft product" of spec §9.1.
- The platform's Shopify token (client credentials, app `fn-onboarding`) carries
  `write_files, write_online_store_navigation, write_products,
  write_publications` (verified against a freshly minted token on 2026-09-21;
  `menus` returns `main-menu, footer, megamenu, customer-account-main-menu`).
  The navigation scope was added after the first build, so the Mega Menu is
  read AND written by the agent — it is no longer a checklist. The token still
  cannot read or write customers. The MegaMenu is Shopify menu `gid://shopify/Menu/191418204297`
  (handle `megamenu`); department stores are nested under its "Store" item,
  oldest→newest, followed by the public stores (FN Simple Merch, SF City Gear,
  Bay Area Firefighter, LOGIN…).
- Locksmith exposes an Admin API (`https://uselocksmith.com/api/unstable`,
  headers `x-shopify-shop-domain` + `x-locksmith-access-token`): `POST /lock`
  with `resource_type: "custom_collection"`, `resources[]`, `options`
  (`hide_links_to_resource`, `hide_resource`, …) and `keys[]` (each
  `{options, conditions:[{type, inverse, options}]}`; `customer_tag` condition
  documented; secret-link condition shape is learned from an existing lock).
- Helium Customer Fields has NO API to edit forms. The registration form is
  public JSON: `https://app.customerfields.com/embed_api/v4/forms/K7tlqn.json?shop=<store>`
  → `revision.fields[]`, the Department field (`label: "Department"`,
  `dataColumn.key: "default_address.company"`, `settings.autotag: true`) with
  `enum[]`/`settings.options[]` in alphabetical order. The platform verifies;
  Dan edits.
- Shopify Flow has no API for editing workflows → checklist only.
- Drive: `Departments` folder = `GDRIVE_PARENT_FOLDER_ID`
  (`1NotimWFnxitY67QLt20is3IwifNXfgnp`), `Omni Printer` folder =
  `GDRIVE_OMNI_PRINTER_FOLDER_ID` (`1ALf84uwPJ2wjfWsKyq_9Pfce8ibO8NbW`).
  Department folders are `Name (CODE)`, production folders `(CODE) Name`,
  print files `CODE-F01.png`.
- `Department-ID-Agency-List` Google Doc id `1XVhmHvuhI-MdimOO4uSn2W303GMBW5p3CyDixhP3reo`
  (California MACS ids; exported as text/plain it is one table cell per line).
- OpenAI images: `gpt-image-2.5-sunburst` (default; `-flare` is the faster, less faithful sibling);
  custom sizes WIDTHxHEIGHT, multiples of 16, 655,360–8,294,400 px, so
  2000×2000 and 3584×2048 are valid requests. Quality low/medium/high/xhigh/max/auto.

## 1. Modules

| File | Responsibility |
| --- | --- |
| `onboardingRules.js` | Pure rules: sizes, colour codes, decoration codes, department code lookup/proposal, names, SKUs, tags, vendor, description HTML, banner logo choice, menu/Helium insert positions, report skeleton. |
| `platformBlob.js` | Generic JSON/binary blob helpers on `AZURE_STORAGE_CONNECTION_STRING`. |
| `referenceTables.js` | Source-of-truth tables in container `platform-config`: department-codes, color-codes, blank-library, standard-text; proposals + approval. |
| `onboardingStore.js` | Onboarding records + binary assets in container `department-onboardings`. |
| `shopifyOnboarding.js` | Shopify Admin GraphQL for the agent: source product lookup, duplicate, productSet with SKUs/options/variants, media attach per variant, collection with banner + description, tags in use, menu read/update, verification reads. |
| `locksmith.js` | Locksmith Admin API client: list locks, learn key template, create collection lock, verify. |
| `helium.js` | Public Helium form reader + checker. |
| `onboardingMockups.js` | 2000×2000 front/back mockups per colour × style from blank photos + artwork; 3584×2048 banner. |
| `onboardingPolicy.js` | Model steps: artwork description, policy review (confirmed/missing), rep email draft, product row suggestions. |
| `onboardingAgent.js` | Orchestrator: phases, steps, approvals, build, final check, report. |
| `onboardingRoutes.js` | Express router `/api/onboardings/*` (admin-gated). |
| `public/onboarding.js`, `public/onboarding.css` | The console view `#/onboarding`, `#/onboarding/:id`, `#/onboarding/reference`. |

Existing modules reused: `drive.js` (+ new `exportFileText`, `downloadFileBuffer`,
`ensureFolderNamed`), `shopify.js` (`graphql`, `gid`, `legacyIdOf`,
`uploadProductImages`, `adminProductUrl`, `adminCollectionUrl`, `shopifyConnected`),
`catalog.js` (`getCollectionWithProducts`, `getProduct`), `productImages.js`
(`renderFaceImage`), `ai.js` (`analyzeLogo`, `extractReadableText`,
`generateBlankGarment`), `azureOpenai.js` (`reason`, `editImage`, `generateImage`),
`blanks.js` (`findSupplierBlank`), `auth.js` (`googleConnected`).

## 2. Onboarding record

Container `department-onboardings`, blob `<id>` where
`id = YYYY-MM-DD-<slug(department name)>-<8 hex>.json`. Binary assets live at
`<id-without-.json>/assets/<assetId>` in the same container with metadata
`{kind, name, contentType}`; the record references them by `assetId`.

```jsonc
{
  "schemaVersion": 1,
  "id": "2026-09-21-vacaville-fire-department-1a2b3c4d.json",
  "requestId": "uuid",
  "createdAt": "ISO", "updatedAt": "ISO",
  "status": "packet" | "setup" | "inputs" | "building" | "built" | "built-partial" | "build-error" | "complete",
  "phase": "packet" | "setup" | "inputs" | "build" | "report",
  "department": {
    "name": "Vacaville Fire Department",        // exact spelling = department tag
    "tag": "Vacaville Fire Department",
    "state": "CA",
    "storeOrdinal": 1,                          // "1." main store, "2." union store…
    "storeName": "",                            // only when ordinal > 1
    "contacts": [{ "name": "", "role": "", "email": "", "phone": "" }],
    "code": {
      "value": "VAC" | null,
      "source": "list" | "proposed" | "manual" | null,
      "approved": false,
      "approvedAt": null, "approvedBy": "",
      "candidates": [{ "code": "VAC", "reason": "", "inUse": false, "agency": "" }],
      "matches": [{ "code": "VAC", "agency": "Vacaville FD", "city": "", "score": 1 }]
    }
  },
  "packet": {
    "files": [{ "assetId": "", "name": "policy.pdf", "kind": "policy"|"artwork"|"contacts"|"blank"|"proof"|"print"|"other",
                "contentType": "", "size": 0, "driveFileId": "", "driveUrl": "",
                "role": "pick"|"scramble"|"chest"|"back"|"", "text": "" /* extracted, policies only, ≤ 20k chars */,
                "description": "" /* artwork vision description */ }],
    "notes": ""
  },
  "drive": { "departmentFolderId": "", "departmentFolderUrl": "", "productImagesFolderId": "",
             "productionFolderId": "", "productionFolderUrl": "", "productionFiles": [{ "id": "", "name": "VAC-F01.png", "modifiedTime": "" }],
             "productionFilesReadAt": "" },
  "policyReview": { "reviewedAt": "", "confirmed": [{"topic": "", "detail": "", "source": ""}],
                    "missing": [{"topic": "", "detail": ""}], "questions": [""],
                    "emailDraft": { "subject": "", "body": "" }, "driveDocId": "", "driveDocUrl": "",
                    "suggestedProducts": [ /* product rows, unconfirmed */ ] },
  "products": [ {
      "id": "p1", "brand": "Next Level", "styleNumber": "NL3600", "type": "T-shirt", "title": "",
      "colors": ["Navy"], "sizes": ["S","M"], "decorationMethod": "print"|"embroidery"|"",
      "decorationCodes": "F01/B01", "styles": [{ "decorationCodes": "F01/B01" }],
      "fulfillment": "One Week Item"|"Non Stock Item", "classB": false, "notes": "",
      "blankPhotos": { "<color>": { "front": "<assetId>", "back": "<assetId>" } },
      "proofs": { "E01": "<assetId>" },
      "sourceProduct": { "id": "gid://shopify/Product/…", "title": "", "kind": "master"|"latest", "url": "" },
      "validation": { "ok": true, "errors": [], "warnings": [], "assumptions": [], "skuPreview": ["…"] },
      "mockups": [{ "color": "Navy", "colorCode": "NVY", "style": "Style 1"|null, "face": "front"|"back",
                    "assetId": "", "driveFileId": "", "driveUrl": "", "fileName": "VAC_NL3600_NVY_Style1_FRONT.png",
                    "path": "render"|"render-failed"|"stock", "verified": null|{ "ok": true, "notes": "" } }],
      "shopify": { "productId": "", "gid": "", "url": "", "variantCount": 0, "createdAt": "" },
      "buildState": "pending"|"mockups"|"created"|"failed"|"skipped", "buildError": ""
  } ],
  "collection": { "title": "1. Vacaville Fire Department", "id": "", "gid": "", "handle": "", "url": "", "storefrontUrl": "",
                  "bannerAssetId": "", "bannerDriveUrl": "", "bannerLogoAssetId": "", "bannerLogoReason": "", "descriptionSet": false },
  "lock": { "status": "pending"|"created"|"manual"|"verified"|"error", "locksmithLockId": "", "secretCode": "", "secretLink": "",
            "tagKey": "", "settings": { "enabled": true, "protectProducts": true, "hideFromNavigation": true, "hideFromLists": true },
            "checklist": [""], "error": "", "verifiedAt": "" },
  "sharedSettings": {
    "megaMenu": { "status": "pending"|"proposed"|"approved"|"applied"|"manual"|"verified"|"error", "proposal": { "insertAfter": "", "insertBefore": "", "index": 0, "title": "", "url": "",
                                "newItem": { "title": "", "type": "COLLECTION", "url": "/collections/<handle>", "resourceId": "" },
                                "collectionHandle": "", "collectionGid": "" }  // newItem is required by applyMegaMenuInsert,
                  "checklist": [""], "approvedAt": "", "approvedBy": "", "appliedAt": "", "verifiedAt": "", "error": "" },
    "flow": { "status": "pending"|"proposed"|"confirmed", "checklist": [""], "confirmedAt": "", "confirmedBy": "" },
    "helium": { "status": "pending"|"proposed"|"verified"|"partial", "forms": [{ "id": "K7tlqn", "label": "Registration", "public": true,
                 "present": false, "insertAfter": "", "insertBefore": "", "index": 0, "total": 0, "checkedAt": "", "confirmedAt": "", "error": "" }] }
  },
  "approvals": [{ "kind": "code"|"color"|"menu"|"flow"|"helium", "subject": "", "decision": "approved"|"rejected", "by": "", "at": "" }],
  "build": { /* same shape as intakeBuild BuildState */ "state": "", "startedAt": "", "heartbeatAt": "", "finishedAt": null, "error": null,
             "steps": [{ "key": "", "label": "", "state": "running"|"complete"|"failed"|"skipped", "startedAt": "", "finishedAt": "", "detail": "" }],
             "log": ["HH:MM:SS message"] },
  "report": { "generatedAt": "", "completed": [""], "needsDan": [""], "missingInformation": [""], "warnings": [""], "driveDocUrl": "" },
  "events": [{ "at": "", "type": "", "message": "", "by": "" }]   // ring of 200
}
```

## 3. Phases and steps

1. **Packet** (`POST /api/onboardings`): department name, state, contacts, notes,
   files. Extract policy text, describe artwork (vision).
2. **Setup** (`POST /api/onboardings/:id/setup`): the department-codes table
   imports itself from `DEPARTMENT_CODE_LIST_DOC_ID` when it holds no rows
   sourced from the document (otherwise §2.1's search silently matches
   nothing). Then department code lookup on the Department Code List + codes in use (Drive folder names, Shopify product
   tags, MegaMenu titles when readable). Found on list → `source:"list"`,
   `approved:true`. Otherwise candidates → Dan approves (`POST …/code`).
   After approval: Drive folders (`Departments/<Name> (<CODE>)`, with `Product
   Images` subfolder; `Omni Printer/(<CODE>) <Name>`), packet uploaded to the
   department folder, policy review + rep email draft (Google Doc in the
   department folder). Never sends email.
3. **Build inputs** (`PUT /api/onboardings/:id/products`, uploads): product rows,
   blank photos per colour, embroidery proofs, banner logo choice. Validation
   (rules) on every save: SKU preview, decoration files matched against the
   production folder listing, colours resolved (unknown → proposal to the
   Color Code List with approval), vendor exact, print/embroidery never mixed.
4. **Build** (`POST /api/onboardings/:id/build`): persisted, resumable,
   additive. Steps: `mockups` (per product), `collection` (create before
   products, banner, description), `lock` (Locksmith API or checklist),
   `products` (source lookup → duplicate → productSet DRAFT → media attach →
   collection), `shared-settings` (proposals only; applying is a separate
   approval action), `final-check`, `report`.
5. **Shared settings** (`POST …/shared-settings/propose`, `…/approve`,
   `…/verify`): Mega Menu (applied through the API after approval — the scope
   is granted; the checklist survives only as the fallback for a failed or
   unreadable menu), Flow (checklist), Helium (checklist + public-form
   verification). `approve` with `applied: true` means a human already made
   the change and nothing is called, so the console sends it only for Flow and
   Helium.
6. **Report** (`GET …/report`): four sections; never "complete" while anything
   is unresolved.

## 4. HTTP API (all admin-gated, JSON unless noted)

| Method | Route | Body / result |
| --- | --- | --- |
| GET | `/api/onboardings` | `{ onboardings: [summary] }` |
| POST | `/api/onboardings` | multipart: `payload` JSON `{departmentName, state, storeOrdinal, storeName, contacts[], notes}` + files `policies[]`, `artwork[]`, `contacts[]`, `other[]` → `201 { onboarding }` |
| GET | `/api/onboardings/:id` | `{ onboarding }` |
| PATCH | `/api/onboardings/:id` | `{ department?, packet?: {notes}, products? }` → `{ onboarding }` |
| DELETE | `/api/onboardings/:id` | `{ confirmName }` → deletes the record (never Shopify/Drive) |
| POST | `/api/onboardings/:id/files` | multipart files `files[]` + fields `kind`, `productId?`, `color?`, `face?`, `decorationCode?`, `role?` → `{ onboarding }` |
| DELETE | `/api/onboardings/:id/files/:assetId` | → `{ onboarding }` |
| GET | `/api/onboardings/:id/assets/:assetId` | binary (image preview) |
| POST | `/api/onboardings/:id/setup` | runs code lookup (+ folders/review when code approved) → `{ onboarding }` |
| POST | `/api/onboardings/:id/code` | `{ code, by }` approve/set → `{ onboarding }` (continues setup) |
| POST | `/api/onboardings/:id/review` | re-run policy review → `{ onboarding }` |
| PUT | `/api/onboardings/:id/products` | `{ products: [row] }` → validates, `{ onboarding }` |
| POST | `/api/onboardings/:id/production-files` | refresh Omni Printer listing → `{ onboarding }` |
| POST | `/api/onboardings/:id/colors/propose` | `{ color, code }` → reference proposal |
| POST | `/api/onboardings/:id/build` | `{ force? }` → `202 { started, build }` |
| POST | `/api/onboardings/:id/shared-settings/propose` | → `{ onboarding }` |
| POST | `/api/onboardings/:id/shared-settings/:kind/approve` | `{ by, applied?: boolean }` (`kind` = megaMenu|flow|helium) → `{ onboarding }` |
| POST | `/api/onboardings/:id/shared-settings/verify` | → `{ onboarding }` |
| POST | `/api/onboardings/:id/lock` | `{ secretLink?, locksmithLockId? }` manual record / or create via API → `{ onboarding }` |
| POST | `/api/onboardings/:id/final-check` | → `{ onboarding }` (report regenerated) |
| GET | `/api/onboardings/:id/report` | `{ report, html }` |
| GET | `/api/reference/:table` | `{ rows, proposals }` |
| POST | `/api/reference/:table/rows` | `{ rows: [...] }` upsert → `{ changed }` |
| POST | `/api/reference/:table/proposals/:proposalId` | `{ approve: boolean, by, edits? }` |
| POST | `/api/reference/department-codes/sync` | re-import the Drive doc → `{ imported }` |
| GET | `/api/onboardings/capabilities` | `{ locksmith: {configured}, helium: {forms}, megaMenu: {readable, writable}, drive, shopify, imageModel }` |

Errors: `{ error }` with 400/401/404/409/500 like the rest of the app.

## 5. Environment

```
GDRIVE_OMNI_PRINTER_FOLDER_ID=1ALf84uwPJ2wjfWsKyq_9Pfce8ibO8NbW
DEPARTMENT_CODE_LIST_DOC_ID=1XVhmHvuhI-MdimOO4uSn2W303GMBW5p3CyDixhP3reo
LOCKSMITH_ACCESS_TOKEN=            # from Locksmith settings → access tokens (optional; checklist when unset)
HELIUM_FORMS=K7tlqn:Registration   # comma list of formId:Label; forms whose JSON is public are verified
SHOPIFY_STOREFRONT_DOMAIN=fnsimple.com
OPENAI_IMAGE_MODEL=gpt-image-2.5-sunburst
ONBOARDING_MOCKUP_SIZE=2000
ONBOARDING_MOCKUP_VERIFY=on
```

## 6. Invariants

- Everything Dan approves is recorded in `approvals[]` with who/when.
- Products are created `DRAFT`; price cleared (`0.00`); cost never set.
- The build never deletes; re-runs skip products already created (by `products[].shopify.productId` + `productExists`).
- The agent never edits files in the Omni Printer folder — it only downloads copies.
- Shared settings are never written without an approval record; if the API cannot write (scope missing), the item becomes a checklist and Dan confirms.
- The report is `complete` only when: code approved, both folders exist, collection ok, lock verified or confirmed, menu/flow/helium confirmed, every product created with unique SKUs and images, and no missing information.
- The final check reads the Mega Menu back and believes the live menu over the record: a stored `applied` passes only when the menu itself cannot be read.

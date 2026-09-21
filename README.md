# FN Onboarding

Node.js + Express internal tool for automating fire department onboarding for a custom gear store.

## Run Locally

```bash
npm install
npm start
```

The app runs on `http://localhost:3456`. On first run it creates `.env` with the configured Shopify, Google, Drive, and port values. If `SHOPIFY_ACCESS_TOKEN` or `GOOGLE_REFRESH_TOKEN` is missing, the server automatically opens `http://localhost:3456/setup`.

## First-Run Auth

Use `/setup` to connect:

- Shopify: starts OAuth and saves `SHOPIFY_ACCESS_TOKEN` to `.env`.
- Google Drive: starts OAuth with `https://www.googleapis.com/auth/drive` and saves `GOOGLE_REFRESH_TOKEN` to `.env`.

When both tokens exist, `/setup` redirects to the main onboarding UI.

## Azure OpenAI and Voice

Azure OpenAI is the preferred GenAI provider for Azure deploys. Configure chat first, then add the voice deployments used by the dashboard voice agent:

```env
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-azure-openai-key
AZURE_OPENAI_API_VERSION=2024-10-21
AZURE_OPENAI_CHAT_DEPLOYMENT=fn-chat
AZURE_OPENAI_AUDIO_ENDPOINT=https://your-voice-resource.openai.azure.com
AZURE_OPENAI_AUDIO_API_KEY=your-voice-resource-key
AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT=whisper
AZURE_OPENAI_AUDIO_API_VERSION=2024-10-21
AZURE_OPENAI_SPEECH_MODEL=fn-tts
AZURE_OPENAI_SPEECH_API_VERSION=preview
AZURE_OPENAI_SPEECH_VOICE=alloy
```

The dashboard voice agent records short browser mic turns, sends them to Azure OpenAI transcription, runs the dashboard agent harness with live Shopify/Drive/platform context, and returns synthesized speech when `AZURE_OPENAI_SPEECH_MODEL` is configured. `AZURE_OPENAI_AUDIO_ENDPOINT` and `AZURE_OPENAI_AUDIO_API_KEY` can point transcription at a separate Azure OpenAI resource while chat keeps using `AZURE_OPENAI_ENDPOINT`. `AZURE_OPENAI_SPEECH_ENDPOINT` and `AZURE_OPENAI_SPEECH_API_KEY` can override the speech resource separately, but by default speech reuses `AZURE_OPENAI_AUDIO_ENDPOINT` and `AZURE_OPENAI_AUDIO_API_KEY`. If speech output is not configured, the browser speech fallback is used for playback.

`AZURE_OPENAI_VOICE_DEPLOYMENT` still works as a legacy alias for the transcription deployment.

Image generation AND the decorated-product edit renderer run on **direct OpenAI** (`OPENAI_API_KEY`, model `OPENAI_IMAGE_MODEL`, default `gpt-image-2.5-flare`; `gpt-image-2.5-sunburst` is the slower, more precise edit model). There is deliberately no Azure image path any more: production always ran on the OpenAI fallback (the Azure image env vars were never set on the Container App), so the Azure-first code was removed on 2026-09-01 instead of being kept as an untraveled branch. Chat, transcription, and speech stay on Azure.

`OPENAI_API_KEY` is therefore required: images, the supplier blank web search (no Azure equivalent), and the chat-reasoning fallback.

Check which provider is actually live without publishing a product: `POST /api/diagnostics/image` returns `{ok, provider, deployment, bytes, elapsedMs}`.
## Re-Auth If Tokens Expire

Stop the server, remove the expired token from `.env`, then restart:

```env
SHOPIFY_ACCESS_TOKEN=
GOOGLE_REFRESH_TOKEN=
```

Run `npm start`, open `/setup`, and reconnect the missing service.

## Google Drive Failover (two accounts)

Drive supports an optional **second Google account** for automatic failover, so a
single revoked or expired token never takes Drive down.

- Set `GOOGLE_REFRESH_TOKEN` (primary) and `GOOGLE_REFRESH_TOKEN_2` (secondary).
- Both accounts must have **Editor access to `GDRIVE_PARENT_FOLDER_ID`** (the same
  shared folder). Because both write into that one folder, **every folder id and
  link is identical regardless of which account performs the write.**
- The app uses the primary account and transparently falls over to the secondary
  on an auth error, then sticks with whichever account is healthy.
- `GOOGLE_CLIENT_ID_2` / `GOOGLE_CLIENT_SECRET_2` are only needed if the second
  account authorized a *different* OAuth app; otherwise it reuses the primary app.

For durability in production, set these as **Container App environment variables**
(not via the in-app Connect buttons), since the container filesystem is ephemeral.

## The console

The app opens on **Dashboard** for live platform status and the voice-first operations agent. The nav bar has four entries:

| Nav item | Route | What it does |
| --- | --- | --- |
| **Dashboard** | `#/dashboard` | Live service status plus the voice operations agent |
| **New Stores** | `#/new-stores` | Internal review queue for customer-submitted store requests |
| **Departments** | `#/departments` | Browse all Shopify collections; click one to open it |
| **Onboarding Agent** | `#/onboarding` | The Department Onboarding Agent described below |

Onboarding is what you run *once* to stand up a new department. Browsing, reviewing customer submissions, and editing live Shopify collections are the everyday tasks.

### Departments → one department

Opening a department lists its products with status, price, and variant count.
From there:

- **Edit** opens a drawer for title, price, status, product type, vendor, tags,
  and description. Price applies to **every variant** on the product (the store
  prices products flat across logo × size), and the drawer reports how many
  variants were repriced.
  - The description is stored as HTML. It is only sent to Shopify **if you
    change it** — leave it alone and its existing formatting is preserved
    byte-for-byte. If you do edit a description containing a size-chart table,
    the drawer warns you that the round-trip through plain text will flatten it;
    edit those in Shopify admin.
- **New product** creates one product in that department from a description
  plus logos, without needing a policy document. You supply the description,
  logo files, price, sizes, and optionally a name, type, color, and placement;
  the app plans the garment, generates the photo, composites each logo, writes
  the description, creates the product with Front Logo × Size variants, and adds
  it to the collection. The same no-invention rule applies — anything you don't
  state is left blank rather than guessed.

### Catalog API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/collections` | All collections (departments) |
| `GET` | `/api/collections/:id` | One collection plus its products |
| `GET` | `/api/products/:id` | Full product detail |
| `PATCH` | `/api/products/:id` | Update supplied fields only; `price` repriced across all variants |
| `POST` | `/api/collections/:id/products` | Create a product (multipart; SSE progress) |

## Customer intake link (New Stores)

Send customers `/intake`. They fill a fixed-field store request based on the FNS form draft: store setup, logo upload, decoration size/placement, and repeated category choices for shirts, sweatshirts, jackets, polos, shorts, sweatpants, Class B items, belts, and hats.

On submit, the app saves the request JSON and logos to Azure Blob Storage (container `customer-intakes` on `AZURE_STORAGE_CONNECTION_STRING`), creates or reuses the matching Shopify collection immediately, and places the request in **New Stores**. Google Drive is not involved at submit time — department Drive folders and documents are created later, during the internal build, once Drive is connected. Intakes submitted before this migration still live in Drive under `Customer Store Intakes` and remain readable/editable as long as Drive is connected.

The internal queue is open by default while the platform is in testing; set `FN_REQUIRE_ADMIN_TOKEN=1` together with `FN_ADMIN_TOKEN` to require a token. With the gate on, the console (`/`) and `/setup` pages themselves also require the token — open `/?admin=<FN_ADMIN_TOKEN>` once and a cookie keeps you signed in for 30 days; everyone else is redirected to `/intake`. The customer link never needs a token, and customers never see internal errors — submit failures that aren't form-validation problems return a generic retry message and log the real cause server-side.

From **New Stores**, open a store request to review or edit the customer answers, open the Shopify collection, and watch build progress. Ready submissions start building automatically on submit — products are created as **DRAFT**, so nothing is customer-visible until an operator publishes them in Shopify admin. Use **Build store now** / **Re-run build** on the store page to kick or re-run a build; re-runs are additive: products Shopify still has are skipped, and any that were deleted in Shopify admin (or lost with their collection) are rebuilt. If a store's collection or products disappear from Shopify, the store page says so in **The store so far** instead of going quiet.

## Department Onboarding Agent

`#/onboarding` builds a new fire department's private store in Shopify by the
rules in **FN Simple Uniforms — Department Onboarding Agent, Build Spec (MVP)**.
The full contract — record schema, phases, HTTP API, invariants — is in
[docs/department-onboarding-agent.md](docs/department-onboarding-agent.md).

The agent does the repetitive, rules-based work. Dan keeps every judgement
call: pricing, cost per item, Easify options, final review, setting products
Active, and sending the store link to the department.

### Rules live in code, not in the model

`onboardingRules.js` owns everything where spelling, order and punctuation
matter — SKU format, size and colour codes, decoration codes, department-code
proposals, folder and collection names, tags, Vendor values, the description
structure, and Appendix B's standard text. It is pure and unit-tested. The
model is used only for reading messy policies, drafting the rep email, and
rendering mockups.

A SKU is `STYLE-SIZE-COLOR-CODE-DECORATIONS`, e.g. `NL3600-L-NVY-VAC-F01/B01`,
`R112-OSFA-NVY-VAC-E01`. An item is either **all print** (`F##`/`B##`/`RS##`/
`LS##`) or **all embroidery** (`E##`) — a mixed item is a custom order and is
rejected rather than built.

### Source-of-truth tables

Four reference tables live in the `platform-config` blob container and are
edited from `#/onboarding/reference`:

| Table | Seeded from | Used for |
| --- | --- | --- |
| Department codes | the `Department-ID-Agency-List` Google Doc (California MACS ids, ~1000 agencies) plus codes already in use | looking a department up, proposing a code for out-of-state departments, refusing a code another agency owns |
| Color codes | Appendix A | the COLOR segment of every SKU |
| Blank library | the `FN Simple Stores Menu_Detailed` doc, then remembered per style as it is used | brand, type, fulfilment and description data per style number |
| Standard text | Appendix B | the logo disclaimer and the Non-Stock Item Notice |

New department and colour codes are **proposals** until Dan approves them; an
unapproved code never reaches a SKU.

The department code list imports itself: the first setup that finds no
imported agencies reads `DEPARTMENT_CODE_LIST_DOC_ID` from Drive, so §2.1's
"search the Department ID Agency List" is never quietly skipped on a fresh
platform. `#/onboarding/reference` can re-import it at any time.

### How a run flows

1. **Packet** — Dan uploads the department name, contact list, uniform policy
   and artwork.
2. **Setup** — the agent looks the department code up, proposes one when the
   department is not on the list, and waits for approval. Then it creates both
   Drive folders (`Departments > Vacaville Fire Department (VAC)` and
   `Omni Printer > (VAC) Vacaville Fire Department`), reads the policy, and
   drafts the email to the department rep listing everything missing. **It
   never sends the email.**
3. **Build inputs** — Dan fills in the product list (brand, style number,
   colours, sizes, decoration method and codes, Styles, fulfilment, Class B),
   plus blank garment photos per colour and embroidery proofs. Every row is
   validated live: SKUs previewed, decoration codes matched against the file
   names in the Omni Printer folder, unknown colours turned into proposals.
4. **Build** — mockups (2000×2000, front and back, every colour and Style),
   the collection (title `1. <Department>`, 3584×2048 banner, the Non-Stock
   Item Notice as its description), the Locksmith lock, then every product as
   **Draft** with SKUs, variants, images bound to the matching Color/Style, and
   a Section 11 description.
5. **Shared settings** — Mega Menu, Shopify Flow and Helium Customer Fields are
   only ever *proposed*. Nothing is saved to a shared setting without Dan's
   explicit approval, and where the API cannot write it, the agent hands Dan
   the exact checklist instead.
6. **Report** — four sections: Completed (including the secret link), Needs
   Dan, Missing information, Warnings. A run is never reported complete while
   anything is unresolved.

### What the agent never does

- Touch production print files — it works only on copies.
- Invent a department code, colour code, product spec or logo placement.
- Save a shared setting (menu, Flow, Helium) without approval.
- Publish a product: everything stays **Draft** until Dan prices it.
- Change or remove another department's settings.

### Integrations and their limits

| Integration | How |
| --- | --- |
| Shopify products/collections | Admin GraphQL. The source product for a style is the `Master Reference` draft when one exists, else the most recently created product with that style number; it is duplicated and never edited. |
| Locksmith | Admin API (`LOCKSMITH_ACCESS_TOKEN`). The secret-link key shape is **learned** from an existing lock on the store rather than guessed, and a guessed shape is dry-run first. Without a token the agent produces the lock checklist. |
| Helium Customer Fields | No write API exists. The agent **reads** the public registration form JSON, reports whether the department tag is present and exactly where it belongs alphabetically, and Dan makes the edit in all three forms. |
| Shopify Flow | No API. Checklist only. |
| Mega Menu | `menuUpdate` needs `write_online_store_navigation`, which this app's token does not carry today, so the agent computes the exact position and hands Dan a checklist. Grant the scope and it applies the change itself after approval. |

## No gibberish on product images

Image models invent misspelled words and fake crests when asked to draw a logo.
Two layers stop that reaching a listing — both apply to onboarding runs and to
manually created products:

1. **The logo is never drawn by AI.** GPT Image renders only a *blank* garment.
   The exact uploaded logo file is then composited onto it with sharp at the
   stated placement (`mockup.js`), pixel for pixel. The artwork on the final
   image is always the department's real file.
2. **The blank garment is inspected before it is used.** The model still
   sometimes decorates a garment it was told to leave plain, so every render is
   checked by GPT-4o Vision for text, lettering, numbers, logos, emblems,
   patches, or printed graphics. A render that isn't clean is regenerated — up
   to 3 attempts, with the offending artwork named in the retry prompt so the
   model stops reproducing it. Seams, stitching, buttons, zippers, pockets, and
   collars are explicitly ignored.

If all 3 attempts still come back decorated, the last render is used rather than
failing the run (the real logo still lands on top) and the reason is logged to
the server console. Tune the attempt count with `BLANK_GARMENT_ATTEMPTS` in
`ai.js`.

## Logo placement and size

Placement boxes in `mockup.js` are fractions of the **garment's bounding box**,
which is measured per render by trimming the white backdrop — not fractions of
the image. The image model does not obey "fills about 80 percent of the frame"
consistently, so image-relative placement made the same spec land differently on
every run. Each placement caps the logo on **both** axes (`w` of garment width,
`h` of garment height), so an upright crest is bounded by its height budget
instead of scaling up until its height matches the intended width.

Garment type picks the default: beanies get the cuff, caps the front panel,
legwear the thigh (clear of the crotch seam), everything else the left chest.
Explicit policy wording still wins over the default.

## Where the blank garment comes from

An image model does not know what `NL3600` looks like — it draws a plausible
t-shirt. So the blank is **looked up from the supplier first** (`blanks.js`) and
only generated if that fails:

1. **The supplier's own photo.** A web search finds the style on the
   manufacturer's or an authorised distributor's site (SanMar, S&S, alphabroder,
   Next Level, Richardson…); the product page is fetched and its flat-front
   product shot downloaded. This is the actual garment the department ordered.
2. **Generated from fetched specs.** If no usable photo passes the checks below,
   the garment is generated — but guided by the specs the lookup fetched
   (silhouette, collar, sleeve, cuffs, placket, fabric), so it is a close
   lookalike rather than a generic garment.
3. **Generated from the policy wording alone**, the original behaviour, if the
   lookup finds nothing at all.

The review panel labels every product **"supplier photo of this style"** or
**"generated lookalike"**, so the operator always knows which they are approving.
Set `SUPPLIER_BLANKS=off` to skip the lookup entirely.

### Nothing found online is trusted on sight

A search result is a claim about a URL, not evidence. Every candidate is
downloaded and then gated:

- **Provenance.** The image's own filename must name the style. Vision cannot
  police this — NL3600 and NL3214 are both plain navy tees, and a lookup for
  NL3600 really did return a 3214 photo in testing. Trailing letters count as
  part of the style, so a `CS410` photo can never satisfy a `CS410LS` lookup.
- **Vision.** GPT-4o checks it is the right garment, the right colour, entirely
  undecorated, a flat front view (a photo containing a model is rejected —
  placement maths assumes a flat lay), on a clean background, showing one
  garment.
- **Resolution.** Anything under 500px on its short edge is rejected.

A failure at any gate falls back to generation; the lookup can never fail a run.

Search engines tend to land on whichever colourway ranks highest, so when the
right style is found in the wrong colour, the correct colourway's file is
addressed directly by substituting the colour token in the URL (`..._antiquegold_flat_front.jpg`
→ `..._midnightnavy_flat_front.jpg`). Those guesses face the same checks.

> Supplier product imagery is licensed to authorised dealers for reselling that
> product. That is the normal arrangement in this trade, but it is worth
> confirming for each brand carried.

## Drive Folder

Set `GDRIVE_PARENT_FOLDER_ID` to the parent Drive folder where department folders should be created. For the current production folder, use:

```env
GDRIVE_PARENT_FOLDER_ID=1NotimWFnxitY67QLt20is3IwifNXfgnp
GDRIVE_OMNI_PRINTER_FOLDER_ID=1ALf84uwPJ2wjfWsKyq_9Pfce8ibO8NbW
```

`GDRIVE_OMNI_PRINTER_FOLDER_ID` is `FN Simple Uniforms > Omni Printer`, where
Dan places print-ready files as `(CODE) Department Name > CODE-F01.png`. The
onboarding agent reads that folder to check every decoration code has its file
and downloads **copies** to build mockups; it never writes there.

> When changing this, remember to update it in **both** the local `.env` and the
> Container App's environment variables in Azure.

## Product Pricing & Vendor

Published variants use `DEFAULT_PRODUCT_PRICE` (default `24.00`) and products
get `DEFAULT_PRODUCT_VENDOR` as their vendor:

```env
DEFAULT_PRODUCT_PRICE=24.00
DEFAULT_PRODUCT_VENDOR=One Week Item
```

## Supplier blank lookup

```env
SUPPLIER_BLANKS=on          # "off" skips the lookup and always generates
OPENAI_SEARCH_MODEL=gpt-4o  # model used for the web search step
```

The lookup adds roughly 15–25 seconds and a few cents per distinct style on the
first run; results are cached per style+colour for the life of the process, so
re-running after a review-gate rejection costs nothing extra.

## Tests

```bash
npm test
```

`node --test` over `test/*.test.js`: the onboarding rules (SKUs, codes, names,
descriptions), the reference-table parsers, the blob-backed onboarding store,
the Shopify layer, Locksmith, Helium, mockups, the policy review, and the
agent orchestrator. They run offline — no API keys, no network, no blob
storage. The scripts that DO spend credits or touch production
(`test/submit-test-stores.js`, `test/sleeve-print-examples.js`,
`test/test-supplier-search.js`) are run by hand and are not part of `npm test`.

## Running on Azure (ephemeral filesystem)

Production runs as the **`fn-platform` Azure Container App** (resource group
`FN`, region westus3). Deploy by building the image into the registry and
pointing the app at it:

```bash
az acr build --registry fnacr0ded0e58 --image fn-platform:<git-sha> .
```

```bash
az containerapp update -n fn-platform -g FN --image fnacr0ded0e58.azurecr.io/fn-platform:<git-sha>
```

The container filesystem is wiped on every deploy and restart. That is why
things "disappear" in production:

- **Set every credential as a Container App environment variable** (`SHOPIFY_*`,
  `GOOGLE_*`, `GDRIVE_PARENT_FOLDER_ID`, `OPENAI_API_KEY`, `AZURE_OPENAI_*`).
  The in-app Connect buttons write to `.env`, which does not survive a restart
  in a container.
- **Long-running work survives a restart.** Onboarding records, their assets
  and their build progress live in Azure Blob Storage (`department-onboardings`),
  and a watchdog resumes builds a deploy interrupted — the same design the
  customer-intake queue uses.
- Generated images, manuals, and email drafts are always saved to Google Drive
  and Shopify, never to the server disk, so nothing durable lives in the
  container.

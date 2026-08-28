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

For local development without Azure, `OPENAI_API_KEY` remains available as a legacy fallback for text chat only.
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
| **Onboard new** | `#/onboarding` | The full policy-driven intake described below |

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

## Onboarding workflow

### Customer intake link

Send customers `/intake`. They fill a fixed-field store request based on the FNS form draft: store setup, logo upload, decoration size/placement, and repeated category choices for shirts, sweatshirts, jackets, polos, shorts, sweatpants, Class B items, belts, and hats.

On submit, the app saves the request JSON and logos to Google Drive under `Customer Store Intakes`, creates or reuses the matching Shopify collection immediately, and places the request in **New Stores**. The internal queue is protected with `FN_ADMIN_TOKEN`; the customer link does not need that token.

From **New Stores**, review or edit the customer answers, open the Shopify collection, then click **Approve to build store**. That loads the generated structured intake and logos into the existing onboarding workflow so the image/product generation can run with the normal approval gate.
The onboarding view accepts a department name, logo images, policy documents, and
optional follow-up answers from the department. Onboarding runs in **two phases
with a review gate in between — nothing is published to Shopify without explicit
approval.**

### Phase 1 — analyze & generate (steps 1–7)

1. Create or reuse the Google Drive department folder inside `GDRIVE_PARENT_FOLDER_ID`, with `Logos` and `Product Images` subfolders.
2. Upload logos, policy docs, and follow-up docs to Drive.
3. Analyze each logo with GPT-4o Vision.
4. Extract products, garment details, and logo assignments from the policy + follow-up text. **Strict no-invention rule:** details not stated in the documents stay empty instead of being guessed.
5. **Check policy completeness.** Anything a production run needs but the policy doesn't state (placement, garment color, brand/style, sizes, decoration method, logo assignments, personalization rules) is reported as a gap, and a ready-to-send **email draft** asking the department for those details is generated and saved to Drive.
6. Source each blank garment (supplier photo where possible — see [Where the blank garment comes from](#where-the-blank-garment-comes-from)) and composite the exact logo onto it — see [No gibberish on product images](#no-gibberish-on-product-images).
7. Write fact-only product descriptions, the production manual Google Doc, and the gap email draft doc.

### Review gate

The UI then shows everything for approval: every product image, a gap report
with confidence level, the email draft (copyable), and per-product detail chips
color-coded as **stated by policy (green)** vs **fallback default (amber)**.

- **Approve & publish** → phase 2 runs.
- **Discard run** → Drive assets are kept, nothing reaches Shopify.
- Got answers back from the department? Paste them into "Department follow-up
  answers" (or attach the reply doc) and re-run — the gaps close.

### Phase 2 — publish to Shopify (steps 8–10, after approval)

8. Create or reuse a Shopify manual collection and set its image from the first uploaded logo.
9. Create products via the **GraphQL Admin API**: one product per garment with
   **Front Logo × Size** options. **Logo assignments stated by the department
   are honoured** — if the policy or follow-up answers say which logo code goes
   on which style number, that garment gets only those logos. When nothing is
   stated, every uploaded logo is offered on that product, and the review panel
   labels it "no assignment stated" so the fallback is never silent.
   GraphQL supports up to 2048 variants per product, so 30+ logos × 7 sizes
   (default XS–3XL) fit on a single product like the store's real listings.
   Each logo's mockup image is uploaded through staged uploads and attached to
   exactly that logo's variants, so the product photo changes with the selected
   Front Logo. Titles follow the store convention (garment name with brand when
   known, e.g. "Next Level Cotton T-Shirt"); the department lives in the
   collection and tags. Descriptions include brand/style, spec bullets, and a
   size chart table whenever the policy or follow-ups provide one.
10. Add products to the collection and show Drive, manual, collection, and product links.

### Undo a published run (cleanup)

After publishing, the summary shows a **"Delete run assets…"** option (available
for 24 hours, while the server keeps the run manifest in memory). It:

- deletes the Shopify products created by that run,
- deletes the Shopify collection for that run,
- moves the department's Drive folder to trash (recoverable from Drive's trash
  for ~30 days).

If the option has expired (or the server restarted, e.g. an Azure deploy),
delete the products/collection in Shopify admin and the folder in Drive
manually.

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
```

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
- **Approve or discard a run promptly.** Pending review runs are held in server
  memory for 60 minutes; a deploy or restart drops them. Drive assets are never
  lost — re-running with "Use existing" reuses the folder.
- Generated images, manuals, and email drafts are always saved to Google Drive
  and Shopify, never to the server disk, so nothing durable lives in the
  container.

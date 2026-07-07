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

## OpenAI Key

Create a fresh OpenAI API key from the OpenAI dashboard, then paste it into `.env`:

```env
OPENAI_API_KEY=sk-your-fresh-key
```

The app uses the official `openai` npm package. GPT-4o handles logo vision analysis, policy/manual notes, and product description generation. GPT Image generates the product mockups.

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

For durability on Render, set these as **dashboard environment variables** (not via
the in-app Connect buttons), since Render's filesystem is ephemeral.

## Workflow

The main UI accepts a department name, logo images, policy documents, and optional
follow-up answers from the department. Onboarding runs in **two phases with a
review gate in between — nothing is published to Shopify without explicit
approval.**

### Phase 1 — analyze & generate (steps 1–7)

1. Create or reuse the Google Drive department folder inside `GDRIVE_PARENT_FOLDER_ID`, with `Logos` and `Product Images` subfolders.
2. Upload logos, policy docs, and follow-up docs to Drive.
3. Analyze each logo with GPT-4o Vision.
4. Extract products, garment details, and logo assignments from the policy + follow-up text. **Strict no-invention rule:** details not stated in the documents stay empty instead of being guessed.
5. **Check policy completeness.** Anything a production run needs but the policy doesn't state (placement, garment color, brand/style, sizes, decoration method, logo assignments, personalization rules) is reported as a gap, and a ready-to-send **email draft** asking the department for those details is generated and saved to Drive.
6. Generate product images with **exact logo compositing**: GPT Image renders a *blank* garment (no logo, no text), then the exact uploaded logo file is composited onto it with sharp at the policy-stated placement. The logo is never redrawn by the AI, so no hallucinated artwork or text.
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
   **Front Logo × Size** options. By default **every uploaded logo is offered on
   every product** (the policy can explicitly restrict logos per garment).
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

If the option has expired (or the server restarted, e.g. a Render deploy),
delete the products/collection in Shopify admin and the folder in Drive
manually.

## Drive Folder

Set `GDRIVE_PARENT_FOLDER_ID` to the parent Drive folder where department folders should be created. For the current production folder, use:

```env
GDRIVE_PARENT_FOLDER_ID=1NotimWFnxitY67QLt20is3IwifNXfgnp
```

> When changing this, remember to update it in **both** the local `.env` and the
> Render dashboard environment variables.

## Product Pricing & Vendor

Published variants use `DEFAULT_PRODUCT_PRICE` (default `24.00`) and products
get `DEFAULT_PRODUCT_VENDOR` as their vendor:

```env
DEFAULT_PRODUCT_PRICE=24.00
DEFAULT_PRODUCT_VENDOR=One Week Item
```

## Running on Render (ephemeral filesystem)

Render's filesystem is wiped on every deploy and restart, and free instances
spin down when idle. That is why things "disappear" on Render:

- **Set every credential as a dashboard environment variable** (`SHOPIFY_*`,
  `GOOGLE_*`, `GDRIVE_PARENT_FOLDER_ID`, `OPENAI_API_KEY`). The in-app Connect
  buttons write to `.env`, which does not survive a restart on Render.
- **Approve or discard a run promptly.** Pending review runs are held in server
  memory for 60 minutes; a deploy or restart drops them. Drive assets are never
  lost — re-running with "Use existing" reuses the folder.
- Generated images, manuals, and email drafts are always saved to Google Drive
  and Shopify, never to the server disk, so nothing durable lives on Render.

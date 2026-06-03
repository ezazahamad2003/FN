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

## Workflow

The main UI accepts a department name, logo images, and policy documents. Submitting runs a streamed onboarding workflow:

1. Create or reuse the Google Drive department folder inside `GDRIVE_PARENT_FOLDER_ID`.
2. Create `Logos` and `Product Images` subfolders.
3. Upload logo files into `Logos`.
4. Upload policy files into the department root folder.
5. Analyze each logo with GPT-4o Vision.
6. Extract product types and production details from the uploaded policy documents.
7. Generate product mockups with GPT Image for each logo/product combination and upload them into `Product Images`.
8. Generate a manual Google Doc in the department root folder. Each product image gets its own page with logo description and policy-based production notes.
9. Generate Shopify product descriptions with GPT-4o.
10. Create or reuse a Shopify manual collection.
11. Create active Shopify products from the generated product images.
12. Add products to the collection.
13. Display Drive, manual, collection, and product links.

## Drive Folder

Set `GDRIVE_PARENT_FOLDER_ID` to the parent Drive folder where department folders should be created. For the current production folder, use:

```env
GDRIVE_PARENT_FOLDER_ID=1a-ij6tDLgUUAi-mZdMPFM6qlsYzQ3_6z
```

## Issues

The app includes an `/issues` page for small-team feedback. Users can create issues with optional images, and mark an issue complete to remove it from the open list.

Issue storage is local JSON at `data/issues.json`. On Render's free/container filesystem this is lightweight but not permanent across rebuilds. For heavier use, move issues into a database.

## Policy-Driven Product Images

The current product mockup workflow reads the uploaded policy documents and asks GPT-4o to infer which products should be generated, such as shirts, hats, pants, hoodies, or jackets. It then generates product images for each product/logo combination and creates matching Shopify products.

The next planned step is to add an explicit inventory selector so users can choose from a controlled catalog before generation.

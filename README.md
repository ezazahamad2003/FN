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

The app uses the official `openai` npm package. GPT-4o handles logo vision analysis and product description generation. DALL-E 3 generates the shirt mockups.

## Re-Auth If Tokens Expire

Stop the server, remove the expired token from `.env`, then restart:

```env
SHOPIFY_ACCESS_TOKEN=
GOOGLE_REFRESH_TOKEN=
```

Run `npm start`, open `/setup`, and reconnect the missing service.

## Workflow

The main UI accepts a department name, logo images, and policy PDFs. Submitting runs a streamed onboarding workflow:

1. Create or reuse the Google Drive department folder.
2. Upload logo and policy files.
3. Analyze each logo with GPT-4o Vision.
4. Generate black heavyweight t-shirt mockups with DALL-E 3.
5. Generate Shopify product descriptions with GPT-4o.
6. Create or reuse a Shopify manual collection.
7. Create active Shopify products and upload generated mockup images.
8. Add products to the collection.
9. Display Drive, collection, and product links.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { google } = require("googleapis");
const fetch = require("node-fetch");

const ENV_PATH = path.join(__dirname, ".env");

const DEFAULT_ENV = {
  SHOPIFY_STORE: "",
  SHOPIFY_CLIENT_ID: "",
  SHOPIFY_CLIENT_SECRET: "",
  SHOPIFY_SCOPES: "write_products",
  SHOPIFY_REDIRECT: "",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  GOOGLE_REDIRECT: "",
  // Optional second Google account (failover). The refresh token lives in
  // GOOGLE_REFRESH_TOKEN_2; client id/secret default to the primary app if the
  // second account authorized the same OAuth client.
  GOOGLE_CLIENT_ID_2: "",
  GOOGLE_CLIENT_SECRET_2: "",
  GDRIVE_PARENT_FOLDER_ID: "",
  OPENAI_API_KEY: "",
  OPENAI_CHAT_MODEL: "",
  OPENAI_IMAGE_MODEL: "",
  AZURE_OPENAI_ENDPOINT: "",
  AZURE_OPENAI_API_KEY: "",
  AZURE_OPENAI_API_VERSION: "2024-10-21",
  AZURE_OPENAI_CHAT_DEPLOYMENT: "",
  AZURE_OPENAI_IMAGE_DEPLOYMENT: "",
  AZURE_OPENAI_VOICE_DEPLOYMENT: "",
  DATABASE_URL: "",
  POSTGRES_CONNECTION_STRING: "",
  AZURE_KEY_VAULT_NAME: "",
  AZURE_STORAGE_CONNECTION_STRING: "",
  DEFAULT_PRODUCT_PRICE: "",
  DEFAULT_PRODUCT_VENDOR: "",
  PORT: "3456"
};

function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const raw = fs.readFileSync(ENV_PATH, "utf8");
  return raw.split(/\r?\n/).reduce((acc, line) => {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) return acc;
    const idx = line.indexOf("=");
    acc[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    return acc;
  }, {});
}

const TOKEN_ENV_KEYS = ["SHOPIFY_ACCESS_TOKEN", "GOOGLE_REFRESH_TOKEN", "GOOGLE_REFRESH_TOKEN_2"];
const ENV_KEYS = [...Object.keys(DEFAULT_ENV), ...TOKEN_ENV_KEYS];

function valueFromEnvOrFile(key, fileEnv, updates = {}) {
  if (Object.prototype.hasOwnProperty.call(updates, key)) return updates[key] || "";
  return process.env[key] || fileEnv[key] || DEFAULT_ENV[key] || "";
}

function buildRuntimeEnv(fileEnv = readEnvFile(), updates = {}) {
  return ENV_KEYS.reduce((acc, key) => {
    acc[key] = valueFromEnvOrFile(key, fileEnv, updates);
    return acc;
  }, {});
}

function writeEnv(updates) {
  const next = buildRuntimeEnv(readEnvFile(), updates);
  const body = ENV_KEYS.map((key) => `${key}=${next[key] || ""}`).join("\n");
  fs.writeFileSync(ENV_PATH, `${body}\n`, "utf8");
  Object.assign(process.env, next);
}

function ensureEnvDefaults() {
  const existing = readEnvFile();
  const next = buildRuntimeEnv(existing);
  const missing = ENV_KEYS.filter((key) => !(key in existing));
  if (!fs.existsSync(ENV_PATH) || missing.length) {
    const body = ENV_KEYS.map((key) => `${key}=${next[key] || ""}`).join("\n");
    fs.writeFileSync(ENV_PATH, `${body}\n`, "utf8");
  }
  Object.assign(process.env, next);
}
function shopifyConfigured() {
  // Connected either via a static/OAuth token, or via client credentials that
  // the app can exchange for a fresh token on demand (internal-app mode).
  return Boolean(
    process.env.SHOPIFY_ACCESS_TOKEN ||
      (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET && process.env.SHOPIFY_STORE)
  );
}

// Ordered list of connected Google accounts. The app uses the first that has a
// working token and fails over to the next, so a single dead token never takes
// Drive down. Both accounts are expected to share GDRIVE_PARENT_FOLDER_ID, which
// keeps every folder id and link identical no matter which account writes.
function googleAccounts() {
  const accounts = [];
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    accounts.push({
      id: "primary",
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET
    });
  }
  if (process.env.GOOGLE_REFRESH_TOKEN_2) {
    accounts.push({
      id: "secondary",
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN_2,
      clientId: process.env.GOOGLE_CLIENT_ID_2 || process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET_2 || process.env.GOOGLE_CLIENT_SECRET
    });
  }
  return accounts;
}

function googleConnected() {
  return googleAccounts().length > 0;
}

// Build an OAuth2 client for Drive use from a single account's credentials.
// Redirect URI is not needed here — that only matters for the consent flow.
function googleDriveAuth(account) {
  if (!account || !account.clientId || !account.clientSecret) {
    throw new Error("Google is missing client credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
  }
  const client = new google.auth.OAuth2(account.clientId, account.clientSecret);
  client.setCredentials({ refresh_token: account.refreshToken });
  return client;
}

function hasRequiredTokens() {
  return Boolean(shopifyConfigured() && googleConnected());
}

function disconnectShopify() {
  writeEnv({ SHOPIFY_ACCESS_TOKEN: "" });
}

function disconnectGoogle() {
  writeEnv({ GOOGLE_REFRESH_TOKEN: "", GOOGLE_REFRESH_TOKEN_2: "" });
}

function requireEnv(keys, service) {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`${service} is missing required configuration: ${missing.join(", ")}. Check the Render environment variables or local .env file.`);
  }
}

function normalizeShopifyStore(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return "";
  const candidate = raw.includes("://") ? raw : `https://${raw}`;
  let host = "";
  let pathname = "";
  try {
    const parsed = new URL(candidate);
    host = parsed.hostname;
    pathname = parsed.pathname;
  } catch (error) {
    host = raw.split("/")[0];
  }
  let handle = host;
  if (host === "admin.shopify.com") {
    handle = pathname.split("/").filter(Boolean)[1] || "";
  }
  handle = handle.replace(/^admin\./, "").replace(/\.myshopify\.com$/, "");
  if (!handle) return "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) {
    throw new Error("Enter a valid Shopify store handle, like dmaidy-n1, or a myshopify.com domain.");
  }
  return `${handle}.myshopify.com`;
}
function shopifyScopes() {
  const scopes = String(process.env.SHOPIFY_SCOPES || DEFAULT_ENV.SHOPIFY_SCOPES)
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return scopes.includes("write_products") ? "write_products" : DEFAULT_ENV.SHOPIFY_SCOPES;
}

function shopifyRedirectUri(origin) {
  if (origin) return new URL("/callback", origin).toString();
  requireEnv(["SHOPIFY_REDIRECT"], "Shopify OAuth");
  return process.env.SHOPIFY_REDIRECT;
}

function shopifyInstallUrl(shop, origin) {
  requireEnv(["SHOPIFY_CLIENT_ID"], "Shopify OAuth");
  const store = normalizeShopifyStore(shop || process.env.SHOPIFY_STORE);
  if (!store) throw new Error("Enter a Shopify store before connecting.");
  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: process.env.SHOPIFY_CLIENT_ID,
    scope: shopifyScopes(),
    redirect_uri: shopifyRedirectUri(origin),
    state
  });
  return `https://${store}/admin/oauth/authorize?${params}`;
}

async function exchangeShopifyCode(code, shop) {
  requireEnv(["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"], "Shopify OAuth");
  const store = normalizeShopifyStore(shop || process.env.SHOPIFY_STORE);
  if (!store) throw new Error("Shopify did not return a store for this authorization.");
  const res = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      code
    })
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || "Shopify token exchange failed");
  }
  writeEnv({ SHOPIFY_STORE: store, SHOPIFY_ACCESS_TOKEN: json.access_token });
  return json.access_token;
}
function googleClient() {
  requireEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT"], "Google OAuth");
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT
  );
}

function googleInstallUrl() {
  const client = googleClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive"]
  });
}

async function exchangeGoogleCode(code) {
  const client = googleClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token. Reconnect with consent and try again.");
  }
  const refreshToken = tokens.refresh_token;
  // Fill the primary slot when it is empty or the same account re-consented;
  // otherwise a different account lands in the secondary (failover) slot.
  if (!process.env.GOOGLE_REFRESH_TOKEN || refreshToken === process.env.GOOGLE_REFRESH_TOKEN) {
    writeEnv({ GOOGLE_REFRESH_TOKEN: refreshToken });
  } else {
    writeEnv({ GOOGLE_REFRESH_TOKEN_2: refreshToken });
  }
  return refreshToken;
}

function openBrowser(url) {
  const command =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  require("child_process").exec(command, () => {});
}

module.exports = {
  disconnectGoogle,
  disconnectShopify,
  ensureEnvDefaults,
  exchangeGoogleCode,
  exchangeShopifyCode,
  googleAccounts,
  googleClient,
  googleConnected,
  googleDriveAuth,
  googleInstallUrl,
  hasRequiredTokens,
  openBrowser,
  readEnvFile,
  shopifyInstallUrl,
  writeEnv
};

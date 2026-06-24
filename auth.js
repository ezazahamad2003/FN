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
  GDRIVE_PARENT_FOLDER_ID: "",
  OPENAI_API_KEY: "",
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

const TOKEN_ENV_KEYS = ["SHOPIFY_ACCESS_TOKEN", "GOOGLE_REFRESH_TOKEN"];
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
function hasRequiredTokens() {
  return Boolean(process.env.SHOPIFY_ACCESS_TOKEN && process.env.GOOGLE_REFRESH_TOKEN);
}

function disconnectShopify() {
  writeEnv({ SHOPIFY_ACCESS_TOKEN: "" });
}

function disconnectGoogle() {
  writeEnv({ GOOGLE_REFRESH_TOKEN: "" });
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
  writeEnv({ GOOGLE_REFRESH_TOKEN: tokens.refresh_token });
  return tokens.refresh_token;
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
  googleClient,
  googleInstallUrl,
  hasRequiredTokens,
  openBrowser,
  readEnvFile,
  shopifyInstallUrl,
  writeEnv
};

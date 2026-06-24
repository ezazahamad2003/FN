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
  SHOPIFY_SCOPES: "read_products,write_products,read_files,write_files,read_publications,write_publications",
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

function writeEnv(updates) {
  const next = { ...DEFAULT_ENV, ...readEnvFile(), ...updates };
  const body = Object.entries(next)
    .map(([key, value]) => `${key}=${value || ""}`)
    .join("\n");
  fs.writeFileSync(ENV_PATH, `${body}\n`, "utf8");
  Object.assign(process.env, next);
}

function ensureEnvDefaults() {
  const existing = readEnvFile();
  const missing = Object.keys(DEFAULT_ENV).filter((key) => !(key in existing));
  if (!fs.existsSync(ENV_PATH) || missing.length) {
    writeEnv(existing);
  } else {
    Object.assign(process.env, existing);
  }
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

function shopifyInstallUrl() {
  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: process.env.SHOPIFY_CLIENT_ID,
    scope: process.env.SHOPIFY_SCOPES,
    redirect_uri: process.env.SHOPIFY_REDIRECT,
    state
  });
  return `https://${process.env.SHOPIFY_STORE}/admin/oauth/authorize?${params}`;
}

async function exchangeShopifyCode(code) {
  const res = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/oauth/access_token`, {
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
  writeEnv({ SHOPIFY_ACCESS_TOKEN: json.access_token });
  return json.access_token;
}

function googleClient() {
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

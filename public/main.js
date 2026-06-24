const form = document.getElementById("onboardForm");
const log = document.getElementById("log");
const clearLog = document.getElementById("clearLog");
const runButton = document.getElementById("runButton");
const summary = document.getElementById("summary");
const conflictStrategy = document.getElementById("conflictStrategy");
const connectionState = document.getElementById("connectionState");
const logoInput = document.getElementById("logos");
const policyInput = document.getElementById("policies");
const logoCount = document.getElementById("logoCount");
const policyCount = document.getElementById("policyCount");
const shopifyAuthCard = document.getElementById("shopifyAuthCard");
const googleAuthCard = document.getElementById("googleAuthCard");

function addLog(message, state = "") {
  const empty = log.querySelector(".empty-log");
  if (empty) empty.remove();
  const item = document.createElement("li");
  item.className = state;
  const firstSpace = message.indexOf(" ");
  const hasMarker = firstSpace > 0 && firstSpace <= 3;
  const marker = hasMarker ? message.slice(0, firstSpace) : "\u2022";
  const text = hasMarker ? message.slice(firstSpace + 1) : message;
  item.innerHTML = `<span>${marker}</span><strong>${text}</strong>`;
  log.appendChild(item);
  log.scrollTop = log.scrollHeight;
}

function iconFor(state) {
  if (state === "complete") return "\u2705";
  if (state === "running") return "\u23f3";
  if (state === "failed") return "\u274c";
  return "\u2022";
}

function renderSummary(data) {
  summary.hidden = false;
  summary.innerHTML = `
    <section class="panel form-panel summary-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Complete</p>
          <h2>Final Summary</h2>
        </div>
      </div>
      <div class="summary-actions">
        <a class="button" href="${data.driveFolderUrl}" target="_blank" rel="noreferrer">Drive Folder</a>
        ${data.manualUrl ? `<a class="button secondary" href="${data.manualUrl}" target="_blank" rel="noreferrer">Manual Doc</a>` : ""}
        <a class="button secondary" href="${data.shopifyCollectionUrl}" target="_blank" rel="noreferrer">Shopify Collection</a>
      </div>
      <div class="product-grid">
        ${data.products
          .map(
            (product) => `
              <article class="product-card">
                <img src="${product.thumbnail}" alt="${product.title}">
                <div>
                  <h3>${product.title}</h3>
                  <a class="button ghost" href="${product.url}" target="_blank" rel="noreferrer">Open Product</a>
                </div>
              </article>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function updateFileCount(input, output, singular, plural) {
  const count = input.files.length;
  output.textContent = count === 0 ? `No ${plural} selected` : `${count} ${count === 1 ? singular : plural} selected`;
}

async function refreshConnectionState() {
  if (!connectionState) return;
  try {
    const res = await fetch("/health");
    const status = await res.json();
    const ready = status.shopifyConnected && status.googleConnected;
    connectionState.className = `connection-card ${ready ? "ready" : "attention"}`;
    connectionState.innerHTML = `<span class="pulse"></span><span>${ready ? "Services connected" : "Auth needs attention"}</span>`;
    renderAuthCard(shopifyAuthCard, "Shopify", status.shopifyConnected);
    renderAuthCard(googleAuthCard, "Google Drive", status.googleConnected);
  } catch (error) {
    connectionState.className = "connection-card attention";
    connectionState.innerHTML = '<span class="pulse"></span><span>Status unavailable</span>';
    renderAuthCard(shopifyAuthCard, "Shopify", false, "Status unavailable");
    renderAuthCard(googleAuthCard, "Google Drive", false, "Status unavailable");
  }
}

function serviceKey(label) {
  return label.toLowerCase().startsWith("shopify") ? "shopify" : "google";
}

function renderAuthCard(card, label, connected, fallbackText) {
  if (!card) return;
  const service = serviceKey(label);
  card.className = `auth-card ${connected ? "connected" : "missing"}`;
  const statusText = fallbackText || (connected ? "Connected and ready" : "Not connected");
  const action = connected
    ? `<button class="button ghost compact disconnect-service" type="button" data-service="${service}">Disconnect</button>`
    : `<a class="button ghost compact" href="/auth/${service}">Connect</a>`;
  card.innerHTML = `
    <div>
      <p class="eyebrow">${label}</p>
      <h2><span class="auth-dot"></span>${statusText}</h2>
    </div>
    <div class="auth-actions">
      ${connected ? '<a class="button ghost compact" href="/setup">Review</a>' : ""}
      ${action}
    </div>
  `;
}
function parseSseChunk(buffer, onEvent) {
  const events = buffer.split("\n\n");
  const remainder = events.pop() || "";
  for (const raw of events) {
    const lines = raw.split("\n");
    const event = (lines.find((line) => line.startsWith("event:")) || "event: message").slice(6).trim();
    const dataLine = lines.find((line) => line.startsWith("data:"));
    if (!dataLine) continue;
    onEvent(event, JSON.parse(dataLine.slice(5).trim()));
  }
  return remainder;
}

async function submitOnboarding() {
  const data = new FormData(form);
  const res = await fetch("/onboard", { method: "POST", body: data });

  if (res.status === 409) {
    const payload = await res.json();
    addLog(`\u274c Step ${payload.step} failed: ${payload.error}`, "failed");
    const overwrite = window.confirm("A Drive folder for this department already exists. Press OK to overwrite it, or Cancel to skip folder creation and use it.");
    conflictStrategy.value = overwrite ? "overwrite" : "skip";
    addLog(`Retrying with ${conflictStrategy.value}.`, "running");
    return submitOnboarding();
  }

  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: "Onboarding failed." }));
    addLog(`\u274c Step ${payload.step || 0} failed: ${payload.error}`, "failed");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = parseSseChunk(buffer, (event, payload) => {
      if (event === "status") {
        addLog(`${iconFor(payload.state)} ${payload.message}`, payload.state);
      }
      if (event === "error") {
        addLog(`\u274c Step ${payload.step} failed: ${payload.error}`, "failed");
      }
      if (event === "summary") {
        renderSummary(payload);
      }
    });
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  summary.hidden = true;
  summary.innerHTML = "";
  log.innerHTML = "";
  conflictStrategy.value = "fail";
  runButton.disabled = true;
  runButton.textContent = "Running...";
  try {
    await submitOnboarding();
  } catch (error) {
    addLog(`\u274c ${error.message}`, "failed");
  } finally {
    runButton.disabled = false;
    runButton.textContent = "Run Onboarding";
  }
});

clearLog.addEventListener("click", () => {
  log.innerHTML = '<li class="empty-log">Waiting for an onboarding run.</li>';
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest(".disconnect-service");
  if (!button) return;
  const service = button.dataset.service;
  const label = service === "shopify" ? "Shopify" : "Google Drive";
  if (!window.confirm(`Disconnect ${label}? You can connect a different account after this.`)) return;

  button.disabled = true;
  try {
    const res = await fetch(`/auth/${service}/disconnect`, { method: "POST" });
    if (!res.ok) throw new Error("Disconnect failed");
    await refreshConnectionState();
  } catch (error) {
    alert(`Could not disconnect ${label}. Please try again.`);
  } finally {
    button.disabled = false;
  }
});

logoInput.addEventListener("change", () => updateFileCount(logoInput, logoCount, "logo", "logos"));
policyInput.addEventListener("change", () => updateFileCount(policyInput, policyCount, "policy", "policies"));
refreshConnectionState();

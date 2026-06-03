const form = document.getElementById("onboardForm");
const log = document.getElementById("log");
const clearLog = document.getElementById("clearLog");
const runButton = document.getElementById("runButton");
const summary = document.getElementById("summary");
const conflictStrategy = document.getElementById("conflictStrategy");

function addLog(message, state = "") {
  const item = document.createElement("li");
  item.textContent = message;
  item.className = state;
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
    <section class="panel form-panel">
      <div class="panel-heading">
        <h2>Final Summary</h2>
      </div>
      <div class="summary-actions">
        <a class="button" href="${data.driveFolderUrl}" target="_blank" rel="noreferrer">Drive Folder</a>
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
  log.innerHTML = "";
});

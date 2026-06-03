const issueForm = document.getElementById("issueForm");
const issuesList = document.getElementById("issuesList");
const issueImages = document.getElementById("issueImages");
const issueImageCount = document.getElementById("issueImageCount");
const confirmOverlay = document.getElementById("confirmOverlay");
const confirmMessage = document.getElementById("confirmMessage");
const confirmCancel = document.getElementById("confirmCancel");
const confirmDone = document.getElementById("confirmDone");

let pendingCheckbox = null;

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function updateIssueImageCount() {
  const count = issueImages.files.length;
  issueImageCount.textContent = count === 0 ? "No images selected" : `${count} ${count === 1 ? "image" : "images"} selected`;
}

async function loadIssues() {
  const res = await fetch("/api/issues");
  const data = await res.json();
  if (!data.issues.length) {
    issuesList.innerHTML = '<div class="empty-issues">No open issues.</div>';
    return;
  }
  issuesList.innerHTML = data.issues
    .map((issue) => {
      const images = issue.images
        .map((image) => `<img src="${image.dataUrl}" alt="${escapeHtml(image.name)}">`)
        .join("");
      return `
        <article class="issue-card" data-card="${issue.id}">
          <div class="issue-main">
            <label class="complete-checkbox" title="Mark complete">
              <input type="checkbox" data-id="${issue.id}" data-title="${escapeHtml(issue.title)}">
            </label>
            <div>
              <h3>${escapeHtml(issue.title)}</h3>
              <p>${escapeHtml(issue.details)}</p>
              <span>${new Date(issue.createdAt).toLocaleString()}</span>
            </div>
          </div>
          ${images ? `<div class="issue-images">${images}</div>` : ""}
        </article>
      `;
    })
    .join("");
}

issueForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(issueForm);
  const res = await fetch("/api/issues", { method: "POST", body: data });
  if (!res.ok) {
    alert((await res.json()).error || "Could not add issue.");
    return;
  }
  issueForm.reset();
  updateIssueImageCount();
  await loadIssues();
});

function closeConfirm() {
  confirmOverlay.hidden = true;
  if (pendingCheckbox) pendingCheckbox.checked = false;
  pendingCheckbox = null;
}

issuesList.addEventListener("change", (event) => {
  const checkbox = event.target.closest('.complete-checkbox input[type="checkbox"]');
  if (!checkbox || !checkbox.checked) return;
  pendingCheckbox = checkbox;
  confirmMessage.textContent = `"${checkbox.dataset.title}" will be removed from the list. This can't be undone.`;
  confirmOverlay.hidden = false;
});

confirmCancel.addEventListener("click", closeConfirm);

confirmOverlay.addEventListener("click", (event) => {
  if (event.target === confirmOverlay) closeConfirm();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !confirmOverlay.hidden) closeConfirm();
});

confirmDone.addEventListener("click", async () => {
  if (!pendingCheckbox) return;
  const id = pendingCheckbox.dataset.id;
  confirmDone.disabled = true;
  try {
    const res = await fetch(`/api/issues/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("delete failed");
    confirmOverlay.hidden = true;
    pendingCheckbox = null;
    const card = issuesList.querySelector(`[data-card="${id}"]`);
    if (card) card.classList.add("removing");
    setTimeout(loadIssues, 220);
  } catch (error) {
    alert("Could not mark the issue complete. Please try again.");
    closeConfirm();
  } finally {
    confirmDone.disabled = false;
  }
});

issueImages.addEventListener("change", updateIssueImageCount);
loadIssues();

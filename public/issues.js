const issueForm = document.getElementById("issueForm");
const issuesList = document.getElementById("issuesList");
const issueImages = document.getElementById("issueImages");
const issueImageCount = document.getElementById("issueImageCount");

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
        <article class="issue-card">
          <div class="issue-main">
            <button class="complete-button" data-id="${issue.id}" title="Mark complete">✓</button>
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

issuesList.addEventListener("click", async (event) => {
  const button = event.target.closest(".complete-button");
  if (!button) return;
  await fetch(`/api/issues/${button.dataset.id}`, { method: "DELETE" });
  await loadIssues();
});

issueImages.addEventListener("change", updateIssueImageCount);
loadIssues();

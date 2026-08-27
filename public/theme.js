/* -----------------------------------------------------------------------------
   Theme controller.

   Light is the default: :root carries the light palette, so a browser with JS
   disabled (or a failed script load) still renders a correct light UI. Dark is
   opt-in via [data-theme="dark"] on <html>.

   The *applying* half of this runs inline in each page's <head> (see the
   FN_THEME_BOOT snippet) so the class lands before first paint and there is no
   flash. This file only wires up the visible control.
   -------------------------------------------------------------------------- */
(function () {
  const KEY = "fnTheme";
  const root = document.documentElement;

  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  function current() {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function apply(theme, persist) {
    if (theme === "dark") root.setAttribute("data-theme", "dark");
    else root.setAttribute("data-theme", "light");
    if (persist) {
      try {
        localStorage.setItem(KEY, theme);
      } catch {
        /* private mode - the choice just won't survive a reload */
      }
    }
    document.querySelectorAll(".theme-toggle button").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.theme === theme));
    });
  }

  const SUN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function mount() {
    document.querySelectorAll("[data-theme-toggle]").forEach((host) => {
      if (host.dataset.mounted === "true") return;
      host.dataset.mounted = "true";
      host.classList.add("theme-toggle");
      host.setAttribute("role", "group");
      host.setAttribute("aria-label", "Color theme");
      host.innerHTML =
        '<button type="button" data-theme="light" aria-pressed="false">' +
        SUN +
        '<span class="tt-label">Light</span></button>' +
        '<button type="button" data-theme="dark" aria-pressed="false">' +
        MOON +
        '<span class="tt-label">Dark</span></button>';
      host.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-theme]");
        if (button) apply(button.dataset.theme, true);
      });
    });
    apply(current(), false);
  }

  // Only follow the OS while the user has made no explicit choice of their own.
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
      if (!stored()) apply(event.matches ? "dark" : "light", false);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();

  window.fnTheme = { apply, current };
})();

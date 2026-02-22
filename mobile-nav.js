(() => {
  const $ = (q, el = document) => el.querySelector(q);
  const $$ = (q, el = document) => Array.from(el.querySelectorAll(q));

  const stripEmoji = (s) => {
    const t = String(s || "");
    // remove leading emojis/symbols + whitespace
    return t.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, "").trim();
  };

  function openDrawer() {
    const drawer = $("#drawer");
    if (!drawer) return;
    drawer.classList.add("is-open");
    document.documentElement.classList.add("no-scroll");
    drawer.setAttribute("aria-hidden", "false");
  }

  function closeDrawer() {
    const drawer = $("#drawer");
    if (!drawer) return;
    drawer.classList.remove("is-open");
    document.documentElement.classList.remove("no-scroll");
    drawer.setAttribute("aria-hidden", "true");
  }

  function syncActive() {
    const tabs = $("#tabs");
    const title = $("#sectionTitle");
    const nav = $("#drawerNav");
    if (!tabs) return;

    const active =
      tabs.querySelector(".tab.is-active") ||
      tabs.querySelector(".tab[aria-current='page']") ||
      tabs.querySelector(".tab");

    const activeText = active ? stripEmoji(active.textContent) : "";

    if (title) title.textContent = activeText || "Sección";

    if (nav) {
      const items = $$(".drawer-item", nav);
      items.forEach((it) => it.classList.toggle("is-active", it.textContent.trim() === activeText));
    }
  }

  function buildDrawerNav() {
    const tabs = $("#tabs");
    const nav = $("#drawerNav");
    const btnMenu = $("#btnMenu");
    const title = $("#sectionTitle");
    if (!tabs || !nav || !btnMenu || !title) return;

    const tabButtons = $$(".tab", tabs);
    if (!tabButtons.length) return;

    if (!nav.dataset.built) {
      nav.innerHTML = "";
      tabButtons.forEach((b) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "drawer-item";
        item.textContent = stripEmoji(b.textContent);

        item.addEventListener("click", () => {
          // Trigger the existing navigation logic
          b.click();
          closeDrawer();
        });

        nav.appendChild(item);
      });
      nav.dataset.built = "1";
    }

    // Show mobile controls once tabs are available (logged in)
    btnMenu.hidden = false;
    title.hidden = false;

    // Keep title and drawer selection in sync
    syncActive();

    // Update on any tab click
    tabButtons.forEach((b) => b.addEventListener("click", () => setTimeout(syncActive, 0)));

    // Update if classes change programmatically
    const obs = new MutationObserver(() => syncActive());
    obs.observe(tabs, { subtree: true, attributes: true, attributeFilter: ["class"] });
  }

  function init() {
    const btnMenu = $("#btnMenu");
    if (btnMenu) btnMenu.addEventListener("click", openDrawer);

    document.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.closest("[data-drawer-close]")) closeDrawer();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDrawer();
    });

    // Try now and also when tabs become visible
    const tabs = $("#tabs");
    if (tabs) {
      const obs = new MutationObserver(() => buildDrawerNav());
      obs.observe(tabs, { attributes: true, attributeFilter: ["hidden"] });
    }

    // Try a few times (in case login unhides tabs later)
    let tries = 0;
    const t = setInterval(() => {
      buildDrawerNav();
      tries += 1;
      if ($("#drawerNav")?.dataset.built || tries > 30) clearInterval(t);
    }, 300);
  }

  document.addEventListener("DOMContentLoaded", init);
})();

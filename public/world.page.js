// world.page.js - world page bootstrap

(async function boot() {
  try {
    // statpanel html injection
    const stat = await fetch("/statpanel.html").then(r => r.text());
    const root = document.getElementById("statpanel-root");
    if (root) root.innerHTML = stat;
  } catch (e) {
    console.warn("statpanel load failed", e);
  }

  try {
    // combat modal html injection
    const combat = await fetch("/combat-modal.html").then(r => r.text());
    const root = document.getElementById("combat-root");
    if (root) root.innerHTML = combat;
  } catch (e) {
    console.warn("combat modal load failed", e);
  }
})();

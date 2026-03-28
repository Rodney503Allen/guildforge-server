// public/town.js

(function initTown() {
  const tiles = Array.from(document.querySelectorAll(".serviceTile"));
  if (!tiles.length) return;

  // Add focus-visible styling class on keyboard navigation
  tiles.forEach(t => {
    t.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") t.click();
    });
  });

  // Optional: once user clicks anything, remove featured intensity a bit
  const featured = document.querySelector(".serviceTile.featured");
  if (featured) {
    const calm = () => featured.classList.add("featured-calm");
    window.addEventListener("click", calm, { once: true });
  }
})();

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btn-journal");
  if (!btn) return;

  btn.addEventListener("click", () => {
    // remember where we came from so Journal can return here
    sessionStorage.setItem("gf_prev_screen", window.location.pathname + window.location.search);

    // go to journal with cache-bust so it always loads fresh
    window.location.href = "/journal?r=" + Date.now();
  });
});
document.addEventListener("DOMContentLoaded", async () => {
  const el = document.getElementById("town-gossip");
  const meta = document.getElementById("town-gossip-meta");
  if (!el) return;

  const townId = Number(window.GF_TOWN_ID || 0);
  if (!townId) return;

  try {
    const res = await fetch(`/api/town/${townId}/gossip`, { credentials: "include" });
    const data = await res.json();

    if (!data?.hasGossip) {
      el.textContent = data?.text || "No gossip right now.";
      if (meta) meta.textContent = "";
      return;
    }

    el.textContent = `"${data.text}"`;
    if (meta) meta.textContent = data.title ? `— About: ${data.title}` : "";
  } catch (e) {
    el.textContent = "The whispers fade. Try again.";
    if (meta) meta.textContent = "";
  }
});

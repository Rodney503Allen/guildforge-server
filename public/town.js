// public/town.js

(function initTown() {
  const tiles = Array.from(document.querySelectorAll(".service-tile"));
  if (!tiles.length) return;

  // Add focus-visible styling class on keyboard navigation
  tiles.forEach(t => {
    t.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") t.click();
    });
  });
})();

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

    const feed = document.getElementById("world-feed");
  if (!feed) return;

  const reports = [
    "The Iron Vow has pushed deeper into the western wilds.",
    "Scouts report tremors beneath the valley — something stirs below.",
    "A convergence is rumored to be forming beyond the outer ridge.",
    "Travelers speak of increased creature aggression near the pass."
  ];

  feed.value = reports.join("\n\n").trim();  

});

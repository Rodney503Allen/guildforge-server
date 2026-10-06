// public/world-quests.js
// TRACKED QUEST DISPLAY ONLY
// Requires:
// GET  /api/quests/tracked
// POST /api/quests/track { playerQuestId: number|null, mode?: "track"|"untrack" }

const questTracker = document.getElementById("questTracker");
const qtTitle = document.getElementById("qtTitle");
const qtBody = document.getElementById("qtBody");
const qtMinBtn = document.getElementById("qtMinBtn");

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function groupQuestLogRows(rows) {
  const byPQ = new Map();

  for (const r of rows || []) {
    const id = Number(r.playerQuestId);

    if (!byPQ.has(id)) {
      byPQ.set(id, {
        playerQuestId: id,
        status: r.status,
        title: r.title,
        description: r.description ?? "",
        objectives: []
      });
    }

    byPQ.get(id).objectives.push({
      type: r.objectiveType,
      required: Number(r.required_count || 1),
      progress: Number(r.progress_count || 0),
      isComplete: Number(r.is_complete || 0) === 1,
      region: r.region_name || r.world_object_region_name || null,
      objectiveText: r.objective_text || null,
      itemName: r.item_name || r.target_item_name || null,
      creatureName: r.creature_name || r.target_creature_name || null,
      worldObjectName: r.world_object_name || r.target_world_object_name || null
    });
  }

  return Array.from(byPQ.values());
}

function objectiveLine(o) {
  const cur = String(Math.min(o.progress, o.required));
  const req = String(o.required);
  const authored = String(o.objectiveText || "").trim();

  if (o.type === "INTERACT") {
    const name = o.worldObjectName || authored || "Required target";
    return name + " " + cur + "/" + req;
  }

  if (authored) {
    return authored + " " + cur + "/" + req;
  }

  if (o.type === "TURN_IN" || o.type === "COLLECT") {
    const name = o.itemName || "Item";
    return "Collect " + name + " " + cur + "/" + req;
  }

  if (o.type === "KILL") {
    const name = o.creatureName || "Creature";
    return "Kill " + name + " " + cur + "/" + req;
  }

  if (o.type === "ENTER_AREA") {
    return "Enter " + (o.region || "required area") + " " + cur + "/" + req;
  }

  if (o.type === "LOCATION" || o.type === "REACH_LOCATION") {
    return "Reach " + (o.region || "required location") + " " + cur + "/" + req;
  }

  const label = String(o.type || "Objective").replaceAll("_", " ").toLowerCase();
  return label.charAt(0).toUpperCase() + label.slice(1) + " " + cur + "/" + req;
}

async function untrackQuest(playerQuestId) {
  await fetch("/api/quests/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      playerQuestId,
      mode: "untrack"
    })
  });

  await refreshTrackedQuest();
}



async function refreshTrackedQuest() {
  if (!questTracker || !qtTitle || !qtBody) return;

  const data = await fetch("/api/quests/tracked")
    .then(r => r.json())
    .catch(() => null);

  const trackedIds = Array.isArray(data?.trackedIds)
    ? data.trackedIds.map(Number)
    : [];

  if (!data || !trackedIds.length || !Array.isArray(data.rows) || !data.rows.length) {
    questTracker.classList.add("hidden");
    return;
  }

  const grouped = groupQuestLogRows(data.rows);

  qtTitle.textContent = `Tracking ${grouped.length} Quest${grouped.length === 1 ? "" : "s"}`;

  qtBody.innerHTML = `
    ${grouped.map(q => {
      const lines = (q.objectives || []).map(o => {
        const done = o.isComplete ? "✅" : "⬜";
        const hint = o.region ? ` <span class="qtHint">— ${escapeHtml(o.region)}</span>` : "";

        return `
          <div class="qtObjective">
            ${done} ${escapeHtml(objectiveLine(o))}${hint}
          </div>
        `;
      }).join("");

      return `
        <div class="qtQuest">
          <div class="qtQuestTop">
            <div class="qtQuestTitle">${escapeHtml(q.title || "Quest")}</div>

            <button
              class="qtUntrackBtn"
              type="button"
              data-player-quest-id="${Number(q.playerQuestId)}"
            >
              Untrack
            </button>
          </div>

          <div class="qtObjectives">${lines}</div>
        </div>
      `;
    }).join("")}
  `;

  qtBody.querySelectorAll(".qtUntrackBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const playerQuestId = Number(btn.dataset.playerQuestId);
      if (!Number.isFinite(playerQuestId)) return;

      await untrackQuest(playerQuestId);
    });
  });

  questTracker.classList.remove("hidden");

  questTracker.classList.remove("ping");
  void questTracker.offsetWidth;
  questTracker.classList.add("ping");
}

if (qtMinBtn && questTracker) {
  qtMinBtn.addEventListener("click", () => {
    questTracker.classList.toggle("is-min");
    qtMinBtn.textContent = questTracker.classList.contains("is-min") ? "+" : "—";
  });
}

window.addEventListener("guildforge:player-updated", () => {
  refreshTrackedQuest().catch(err => {
    console.error("Failed to refresh quest tracker:", err);
  });
});

refreshTrackedQuest();

window.refreshTrackedQuest = refreshTrackedQuest;
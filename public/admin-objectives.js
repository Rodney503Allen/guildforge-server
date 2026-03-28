const form = document.getElementById("objectiveForm");
const typeSelect = document.getElementById("objectiveType");
const creatureRow = document.getElementById("creatureRow");
const itemRow = document.getElementById("itemRow");

function syncObjectiveType() {
  const isKill = typeSelect.value === "KILL";
  creatureRow.style.display = isKill ? "flex" : "none";
  itemRow.style.display = isKill ? "none" : "flex";
}

if (typeSelect) {
  typeSelect.addEventListener("change", syncObjectiveType);
  syncObjectiveType();
}

if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const data = Object.fromEntries(new FormData(form));
    const questId = data.quest_id;

    const res = await fetch("/admin/api/objectives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });

    const json = await res.json();

    if (json.ok) {
      window.location = `/admin/quests/${questId}/rewards`;
    } else {
      alert(json.error || "Failed to create objective");
    }
  });
}
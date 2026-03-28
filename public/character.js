async function addStat(stat) {
  const res = await fetch("/character/stat", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ stat })
  });
  const data = await res.json();
  if (data.error) return alert(data.error);

  const el = document.getElementById(stat);
  if (el) el.childNodes[0].nodeValue = data.value; // keep tooltip intact
  document.getElementById("statPoints").innerText = data.stat_points;

  if (data.stat_points <= 0) {
    document.querySelectorAll(".stat-row button").forEach(b => b.remove());
  }
}

function goBack() {
  history.length > 1 ? history.back() : location.href="/town";
}




let draggedId = null;

document.addEventListener("dragstart", e => {
  const el = e.target.closest("[data-id]");
  if (el) draggedId = el.dataset.id;
});

async function equipItem(id) {
  const res = await fetch("/character/equip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inventoryId: id })
  });

  const data = await res.json();
  if (data.error) return alert(data.error);

  location.reload();
}

async function unequipItem(id) {
  const res = await fetch("/character/unequip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inventoryId: id })
  });

  const data = await res.json();
  if (data.error) return alert(data.error);

  location.reload();
}
async function equipPotion(inventoryId, slot) {
  const res = await fetch("/character/equip-potion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inventoryId, slot })
  });

  const data = await res.json();
  if (data.error) return alert(data.error);

  location.reload();
}

async function unequipPotion(slot) {
  const res = await fetch("/character/unequip-potion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slot })
  });

  const data = await res.json();
  if (data.error) return alert(data.error);

  location.reload();
}

function dropEquip(e, expectedSlot) {
  e.preventDefault();
  if (!draggedId) return;

  fetch("/api/inventory/slot-check/" + draggedId)
    .then(res => res.json())
    .then(data => {
      if (data.slot !== expectedSlot) {
        alert("That item does not belong in this slot.");
        return;
      }
      equipItem(draggedId);
    });
}

function dropUnequip() {
  if (draggedId) unequipItem(draggedId);
}


  const searchEl = document.getElementById("invSearch");
  if (searchEl) {
    searchEl.addEventListener("input", () => {
      const q = searchEl.value.trim().toLowerCase();
      document.querySelectorAll(".inv-item").forEach(el => {
        const name = (el.getAttribute("data-search") || "");
        el.style.display = (!q || name.includes(q)) ? "" : "none";
      });
    });
  }

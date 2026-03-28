// public/sell.js
const TOAST_VISIBLE_MS = 3800;

let selectedInventoryId = null;
let selectedQty = 1;
let maxQty = 1;
let unitGold = 0;
let isSelling = false;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function qs(id) {
  return document.getElementById(id);
}

function getSelectedCard() {
  return document.querySelector(".item-card.selected");
}

function clearSelection() {
  document.querySelectorAll(".item-card").forEach(c => c.classList.remove("selected"));

  selectedInventoryId = null;
  selectedQty = 1;
  maxQty = 1;
  unitGold = 0;
  isSelling = false;

  const empty = qs("emptyState");
  const details = qs("details");
  const sellBtn = qs("sellBtn");
  const qtyRow = qs("qtyRow");
  const qtyInput = qs("qty");

  if (empty) empty.style.display = "block";
  if (details) details.style.display = "none";
  if (sellBtn) sellBtn.disabled = true;
  if (qtyRow) qtyRow.style.display = "none";
  if (qtyInput) {
    qtyInput.value = "1";
    qtyInput.max = "1";
  }
}

function updateGoldDisplay(goldGained) {
  const pillStrong = document.querySelector(".pill strong");
  if (!pillStrong) return;

  const currentText = (pillStrong.textContent || "").replace(/[^\d]/g, "");
  const currentGold = Number(currentText || 0);
  const nextGold = currentGold + Number(goldGained || 0);

  pillStrong.textContent = `${new Intl.NumberFormat("en-US").format(nextGold)}g`;
}

function updateCardAfterSale(card, removedQty) {
  if (!card) return;

  const currentQty = Number(card.dataset.qty || 1);
  const nextQty = Math.max(0, currentQty - removedQty);

  if (nextQty <= 0) {
    card.remove();

    const itemsWrap = qs("items");
    if (itemsWrap && !itemsWrap.querySelector(".item-card")) {
      itemsWrap.innerHTML = `<div class="empty">No sellable items.</div>`;
    }

    clearSelection();
    return;
  }

  card.dataset.qty = String(nextQty);

  const stack = card.querySelector(".stack-count");
  if (nextQty > 1) {
    if (stack) {
      stack.textContent = String(nextQty);
    } else {
      const iconWrap = card.querySelector(".icon-wrap");
      if (iconWrap) {
        const badge = document.createElement("div");
        badge.className = "stack-count";
        badge.textContent = String(nextQty);
        iconWrap.appendChild(badge);
      }
    }
  } else if (stack) {
    stack.remove();
  }

  maxQty = nextQty;
  selectedQty = 1;

  const qtyInput = qs("qty");
  const qtyRow = qs("qtyRow");
  if (qtyInput) {
    qtyInput.value = "1";
    qtyInput.max = String(nextQty);
  }
  if (qtyRow) {
    qtyRow.style.display = nextQty > 1 ? "flex" : "none";
  }

  updateTotal();
}

function setSelected(card) {
  if (isSelling) return;

  document.querySelectorAll(".item-card").forEach(c => c.classList.remove("selected"));
  card.classList.add("selected");

  selectedInventoryId = Number(card.dataset.id || 0);
  maxQty = Number(card.dataset.qty || 1);
  unitGold = Number(card.dataset.unit || 0);
  selectedQty = 1;

  qs("emptyState").style.display = "none";
  qs("details").style.display = "block";

  qs("dName").innerText = card.dataset.name || "—";
  qs("dValue").innerText = `${Number(card.dataset.value) || 0}g`;
  qs("dUnit").innerText = `${unitGold}g`;

  const qtyRow = qs("qtyRow");
  const qtyInput = qs("qty");
  qtyInput.value = "1";
  qtyInput.max = String(maxQty);

  qtyRow.style.display = maxQty > 1 ? "flex" : "none";

  updateTotal();
  qs("sellBtn").disabled = false;
}

function updateTotal() {
  const q = qs("qty");
  selectedQty = clamp(Number(q?.value || 1), 1, maxQty);
  if (q) q.value = String(selectedQty);
  qs("dTotal").innerText = `${unitGold * selectedQty}g`;
}

document.addEventListener("click", (e) => {
  const card = e.target.closest?.(".item-card");
  if (card) setSelected(card);
});

qs("minus")?.addEventListener("click", () => {
  if (isSelling) return;
  const q = qs("qty");
  q.value = String(Math.max(1, Number(q.value) - 1));
  updateTotal();
});

qs("plus")?.addEventListener("click", () => {
  if (isSelling) return;
  const q = qs("qty");
  q.value = String(Math.min(maxQty, Number(q.value) + 1));
  updateTotal();
});

qs("qty")?.addEventListener("input", () => {
  if (isSelling) return;
  updateTotal();
});

qs("sellBtn")?.addEventListener("click", async () => {
  if (!selectedInventoryId || isSelling) return;

  const sellBtn = qs("sellBtn");
  const selectedCard = getSelectedCard();

  isSelling = true;
  if (sellBtn) {
    sellBtn.disabled = true;
    sellBtn.textContent = "Selling...";
  }

  try {
    const res = await fetch("/api/sell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inventoryId: selectedInventoryId,
        qty: selectedQty
      })
    });

    const data = await res.json();

    if (data.error) {
      if (window.GFToast?.show) {
        GFToast.show("Sale Failed", data.error, {
          type: "error",
          durationMs: TOAST_VISIBLE_MS
        });
      }

      if (sellBtn) {
        sellBtn.disabled = false;
        sellBtn.textContent = "Sell";
      }
      isSelling = false;
      return;
    }

    updateGoldDisplay(data.goldGained || 0);
    updateCardAfterSale(selectedCard, Number(data.removed || selectedQty));

    if (window.GFToast?.show) {
      GFToast.show("Item Sold", `You gained ${data.goldGained}g.`, {
        type: "success",
        durationMs: TOAST_VISIBLE_MS
      });
    }

    if (sellBtn) {
      sellBtn.textContent = "Sell";
    }

    if (selectedInventoryId) {
      sellBtn.disabled = false;
    }
    isSelling = false;
  } catch (err) {
    console.error("Sell request failed:", err);

    if (window.GFToast?.show) {
      GFToast.show("Sale Failed", "Sell failed. Try again.", {
        type: "error",
        durationMs: TOAST_VISIBLE_MS
      });
    }

    if (sellBtn) {
      sellBtn.disabled = false;
      sellBtn.textContent = "Sell";
    }
    isSelling = false;
  }
});
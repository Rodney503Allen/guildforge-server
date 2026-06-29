// public/shop.js

const TOAST_VISIBLE_MS = 2200;

function updateGoldDisplay(gold) {
  const goldEl = document.querySelector(".pill strong");
  if (!goldEl || gold == null) return;

  goldEl.textContent = Number(gold).toLocaleString("en-US");
}

function setBuyingState(button, isBuying) {
  if (!button) return;

  button.disabled = isBuying;
  button.textContent = isBuying ? "Buying..." : "Buy";
}

// ========================
// BUY CONSUMABLE
// ========================
async function buy(id, button) {
  try {
    setBuyingState(button, true);

    const res = await fetch("/api/shop/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shopItemId: id })
    });

    const data = await res.json();

    if (data.error) {
      setBuyingState(button, false);

      if (window.GFToast?.show) {
        GFToast.show("Purchase Failed", data.error, {
          type: "error",
          durationMs: TOAST_VISIBLE_MS
        });
      }
      return;
    }

    updateGoldDisplay(data.gold);
    setBuyingState(button, false);

    if (window.GFToast?.show) {
      GFToast.show("Purchased", "Item added to your inventory.", {
        type: "success",
        durationMs: TOAST_VISIBLE_MS
      });
    }
  } catch (err) {
    console.error("buy failed:", err);
    setBuyingState(button, false);

    if (window.GFToast?.show) {
      GFToast.show("Purchase Failed", "Something went wrong.", {
        type: "error",
        durationMs: TOAST_VISIBLE_MS
      });
    }
  }
}

window.buy = buy;

// ========================
// BUY BASE ITEM
// ========================
async function buyBase(baseItemId, category, button) {
  try {
    setBuyingState(button, true);

    const res = await fetch("/api/shop/buy-base", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseItemId, category })
    });

    const data = await res.json();

    if (data.error) {
      setBuyingState(button, false);

      if (window.GFToast?.show) {
        GFToast.show("Purchase Failed", data.error, {
          type: "error",
          durationMs: TOAST_VISIBLE_MS
        });
      }
      return;
    }

    updateGoldDisplay(data.gold);
    setBuyingState(button, false);

    if (window.GFToast?.show) {
      GFToast.show("Purchased", `You received ${data.item?.name || "an item"}!`, {
        type: "success",
        durationMs: TOAST_VISIBLE_MS
      });
    }
  } catch (err) {
    console.error("buyBase failed:", err);
    setBuyingState(button, false);

    if (window.GFToast?.show) {
      GFToast.show("Purchase Failed", "Something went wrong.", {
        type: "error",
        durationMs: TOAST_VISIBLE_MS
      });
    }
  }
}

window.buyBase = buyBase;

// ========================
// MARKET TAB SYSTEM
// ========================
(function initMarketTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab[data-tab]"));
  const panels = Array.from(document.querySelectorAll(".marketPanel[data-panel]"));

  if (!tabs.length || !panels.length) return;

  function setActive(key) {
    tabs.forEach(t => {
      const isActive = t.dataset.tab === key;
      t.classList.toggle("isActive", isActive);
      t.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    panels.forEach(p => {
      p.classList.toggle("isActive", p.dataset.panel === key);
    });

    const url = new URL(location.href);
    url.searchParams.set("tab", key);
    history.replaceState({}, "", url);
  }

  const initial = new URLSearchParams(location.search).get("tab") || "consumable";

  if (["consumable", "weapon", "armor"].includes(initial)) {
    setActive(initial);
  }

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      setActive(tab.dataset.tab);
    });
  });
})();
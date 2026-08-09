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
  const validTabs = ["consumable", "weapon", "armor"];

  const tabs = Array.from(
    document.querySelectorAll(".marketTabs .tab[data-tab]")
  );

  const panels = Array.from(
    document.querySelectorAll(".marketPanel[data-panel]")
  );

  if (!tabs.length || !panels.length) return;

  function setActive(key, updateUrl = true) {
    const activeKey = validTabs.includes(key) ? key : "consumable";

    tabs.forEach((tab) => {
      const active = tab.dataset.tab === activeKey;

      tab.classList.toggle("isActive", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });

    panels.forEach((panel) => {
      const active = panel.dataset.panel === activeKey;

      panel.classList.toggle("isActive", active);
      panel.hidden = !active;
    });

    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", activeKey);
      history.replaceState({}, "", url);
    }
  }

  const requestedTab = new URLSearchParams(location.search).get("tab");
  const initialTab = validTabs.includes(requestedTab)
    ? requestedTab
    : "consumable";

  setActive(initialTab, false);

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      setActive(tab.dataset.tab);
    });

    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }

      event.preventDefault();

      let nextIndex = index;

      if (event.key === "ArrowRight") {
        nextIndex = (index + 1) % tabs.length;
      } else if (event.key === "ArrowLeft") {
        nextIndex = (index - 1 + tabs.length) % tabs.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = tabs.length - 1;
      }

      const nextTab = tabs[nextIndex];

      setActive(nextTab.dataset.tab);
      nextTab.focus();
    });
  });
})();
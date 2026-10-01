// tutorial.js
(() => {
  const TOTAL_STEPS = 12;
  const COMPLETION_CARD_KEY = "guildforgeTutorialCompletionShown";

  function routeTarget(route) {
    const clean = String(route || "").replace(/\.html$/i, "");
    const htmlRoute = `${clean}.html`;

    return (
      document.querySelector(`[data-tutorial-route="${clean}"]`) ||
      document.querySelector(`[data-tutorial-route="${htmlRoute}"]`) ||
      document.querySelector(`a[href="${clean}"]`) ||
      document.querySelector(`a[href="${htmlRoute}"]`) ||
      document.querySelector(`a[href^="${clean}?"]`) ||
      document.querySelector(`a[href^="${htmlRoute}?"]`)
    );
  }

  const STEPS = {
    0: {
      title: "Prepare for Adventure",
      text: "Start by opening your Character page. This is where you manage your equipment, potions, stats, and combat loadout.",
      target: () => routeTarget("/character")
    },
    1: {
      title: "Equip Your Weapon",
      text: "Double-click the Primitive Hatchet in your inventory, or click and drag it into the Weapon slot.",
      target: () =>
        document.querySelector('[data-tutorial-name="Primitive Hatchet"]') ||
        document.querySelector('[data-tutorial-slot="weapon"]')
    },
    2: {
      title: "Prepare a Health Potion",
      text: "Double-click the Small Health Potion in your inventory, or click and drag it into your Health potion slot.",
      target: () =>
        document.querySelector('[data-tutorial-name="Small Health Potion"]') ||
        document.querySelector('[data-tutorial-potion-slot="health"]')
    },
    3: {
      title: "Visit the Trainer",
      text: "Your equipment is ready. Return to Port Haven and visit the Trainer to learn your first spell.",
      target: () => routeTarget("/trainer")
    },
    4: {
      title: "Learn Your First Spell",
      text: "Spend a Skill Point to learn one of your available Rank 1 spells. Choose any available skill that fits how you want to play.",
      target: () =>
        document.querySelector('[data-tutorial-learn-spell="1"]') ||
        document.querySelector('[data-tutorial-spell-state="available"]')
    },
    5: {
      title: "Equip Your New Spell",
      text: "Open your Character page, then equip your learned spell to the combat hotbar. Click a learned spell and then click an open hotbar slot, or click and drag the spell directly onto a slot.",
      target: () =>
        document.querySelector(".learned-skill-card") ||
        document.querySelector(".skill-hotbar-slot") ||
        routeTarget("/character")
    },
    6: {
      title: () => document.querySelector('[data-accept-rumor]')
        ? "Accept Your First Quest"
        : document.getElementById("btnRumor")
          ? "Listen for a Rumor"
          : "Begin Your First Quest",
      text: () => document.querySelector('[data-accept-rumor]')
        ? "You found a quest. Click Accept Quest to add it to your quest log. It will be tracked automatically."
        : document.getElementById("btnRumor")
          ? "Click Listen to hear the quests and rumors currently available in this haven."
          : "Your combat loadout is ready. Visit the Tavern to find your first quest.",
      target: () =>
        document.querySelector('[data-accept-rumor]') ||
        document.getElementById("btnRumor") ||
        routeTarget("/tavern")
    },
    7: {
      title: "Venture Beyond the Haven",
      text: "You're prepared for the road ahead. Use Leave Haven to enter the world and begin exploring.",
      target: () => routeTarget("/world")
    },
    8: {
      title: "Find Your First Enemy",
      text: "Explore the world using WASD. As you travel, enemies can appear and pull you into combat.",
      target: () => document.getElementById("Grid")
    },
    9: {
      title: "Cast Your First Spell",
      text: "Wait until your action gauge is ready, then use one of the spells on your combat hotbar.",
      target: () =>
        document.querySelector("#combatModal .hotbar-spell:not(:disabled)") ||
        document.querySelector("#combatModal .hotbar-spell") ||
        document.getElementById("combatModal")
    },
    10: {
      title: "Use a Health Potion",
      text: "When you've taken damage, use the Health Potion on your combat hotbar. You can click it or press Q. If you defeat the enemy before needing it, we'll move you on automatically.",
      target: () =>
        document.getElementById("hpPotionBtn") ||
        document.getElementById("combatModal")
    },
    11: {
      title: "Win Your First Battle",
      text: "Finish the fight. Defeating this enemy will award EXP and may also grant gold, loot, or quest progress.",
      noHighlight: true,
      target: () => null
    }
  };

  let highlighted = null;
  let targetObserver = null;
  let lastKnownStep = null;

  function clearHighlight() {
    if (highlighted) {
      highlighted.classList.remove("tutorial-highlight");
      highlighted.style.removeProperty("outline");
      highlighted.style.removeProperty("outline-offset");
      highlighted.style.removeProperty("box-shadow");
      highlighted.style.removeProperty("position");
      highlighted.style.removeProperty("z-index");
    }
    highlighted = null;

    document.getElementById("tutorialGoHere")?.remove();

    if (targetObserver) {
      targetObserver.disconnect();
      targetObserver = null;
    }
  }

  function ensurePanel() {
    let panel = document.getElementById("guildforgeTutorial");
    if (panel) return panel;

    panel = document.createElement("aside");
    panel.id = "guildforgeTutorial";
    panel.className = "tutorial-panel";
    panel.innerHTML = `
      <div class="tutorial-kicker">FIRST STEPS</div>
      <button class="tutorial-skip" type="button" title="Skip tutorial">Skip</button>
      <h3 class="tutorial-title"></h3>
      <p class="tutorial-text"></p>
      <div class="tutorial-progress"></div>
    `;
    document.body.appendChild(panel);

    panel.querySelector(".tutorial-skip")?.addEventListener("click", async () => {
      if (!confirm("Skip the Guildforge tutorial? You can continue playing normally, but these guided steps will no longer appear.")) {
        return;
      }

      const res = await fetch("/api/tutorial/skip", { method: "POST" });
      const data = await res.json();

      if (data.success) {
        clearHighlight();
        panel.remove();
      }
    });

    return panel;
  }

  function highlightTarget(step) {
    if (step?.noHighlight) {
      clearHighlight();
      return;
    }

    const apply = () => {
      const target = step.target();
      if (!target) return false;

      if (highlighted !== target) {
        clearHighlight();
        highlighted = target;
        highlighted.classList.add("tutorial-highlight");

        // Inline treatment makes the tutorial target visible even if a page's
        // stylesheet overrides or fails to load tutorial.css.
        highlighted.style.setProperty("position", "relative", "important");
        highlighted.style.setProperty("z-index", "10001", "important");
        highlighted.style.setProperty("outline", "4px solid #ffd56a", "important");
        highlighted.style.setProperty("outline-offset", "5px", "important");
        highlighted.style.setProperty(
          "box-shadow",
          "0 0 0 3px rgba(0,0,0,.9), 0 0 24px rgba(255,213,106,.95), 0 0 55px rgba(255,213,106,.5)",
          "important"
        );

        const label = document.createElement("div");
        label.id = "tutorialGoHere";
        label.textContent = "GO HERE ↓";
        Object.assign(label.style, {
          position: "fixed",
          zIndex: "2147483647",
          padding: "8px 12px",
          border: "2px solid #ffd56a",
          borderRadius: "5px",
          background: "#171008",
          color: "#ffe5a0",
          boxShadow: "0 8px 24px rgba(0,0,0,.72)",
          fontFamily: "Cinzel, serif",
          fontSize: "12px",
          fontWeight: "800",
          letterSpacing: ".12em",
          pointerEvents: "none",
          whiteSpace: "nowrap"
        });
        document.body.appendChild(label);

        const positionLabel = () => {
          if (!highlighted || !label.isConnected) return;
          const rect = highlighted.getBoundingClientRect();
          const left = rect.left + rect.width / 2 - label.offsetWidth / 2;
          label.style.left = `${Math.max(10, Math.min(window.innerWidth - label.offsetWidth - 10, left))}px`;
          label.style.top = `${Math.max(10, rect.top - label.offsetHeight - 12)}px`;
        };

        positionLabel();
        requestAnimationFrame(positionLabel);

        setTimeout(() => {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          setTimeout(positionLabel, 350);
        }, 100);
      }

      return true;
    };

    if (apply()) return;

    targetObserver = new MutationObserver(() => {
      if (apply() && targetObserver) {
        targetObserver.disconnect();
        targetObserver = null;
      }
    });

    targetObserver.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      if (targetObserver) {
        targetObserver.disconnect();
        targetObserver = null;
      }
    }, 5000);
  }

  async function loadTutorial() {
    try {
      const res = await fetch("/api/tutorial", { cache: "no-store", credentials: "include" });
      if (!res.ok) return;

      const state = await res.json();

      if (state.completed) {
        clearHighlight();

        // A completed tutorial should show its ending exactly once in this
        // browser. Do not depend on lastKnownStep: victory can complete on the
        // server before this page gets another step-11 refresh.
        const completionAlreadyShown =
          window.sessionStorage.getItem(COMPLETION_CARD_KEY) === "1";

        if (!completionAlreadyShown) {
          const panel = ensurePanel();
          panel.querySelector(".tutorial-kicker").textContent = "FIRST STEPS COMPLETE";
          panel.querySelector(".tutorial-title").textContent = "Your Adventure Begins";
          panel.querySelector(".tutorial-text").textContent =
            "You have completed the Guildforge tutorial! You can now continue exploring the world, completing quests, and improving your character. Good luck!";
          panel.querySelector(".tutorial-progress").textContent = "Tutorial complete";

          const skip = panel.querySelector(".tutorial-skip");
          if (skip) {
            skip.textContent = "Close";
            skip.title = "Close tutorial";
            skip.onclick = (event) => {
              event.preventDefault();
              event.stopPropagation();
              window.sessionStorage.setItem(COMPLETION_CARD_KEY, "1");
              panel.remove();
            };
          }
        } else {
          document.getElementById("guildforgeTutorial")?.remove();
        }

        return;
      }

      // If this character is actively in the tutorial again (for example, a
      // developer reset during testing), allow the completion card to appear
      // again when they finish it.
      window.sessionStorage.removeItem(COMPLETION_CARD_KEY);

      const currentStep = Number(state.step);
      lastKnownStep = currentStep;
      const step = STEPS[currentStep];

      // Not every tutorial step belongs on every page.
      if (!step) {
        clearHighlight();
        document.getElementById("guildforgeTutorial")?.remove();
        return;
      }

      const panel = ensurePanel();
      panel.querySelector(".tutorial-title").textContent = typeof step.title === "function" ? step.title() : step.title;
      panel.querySelector(".tutorial-text").textContent = typeof step.text === "function" ? step.text() : step.text;
      panel.querySelector(".tutorial-progress").textContent =
        `Tutorial step ${currentStep + 1} of ${TOTAL_STEPS}`;

      clearHighlight();
      highlightTarget(step);
    } catch (err) {
      console.error("Tutorial UI failed to load:", err);
    }
  }

  // Other Guildforge UI modules can refresh the tutorial after
  // successful AJAX actions that do not navigate or reload the page.
  window.GFTutorial = {
    refresh: loadTutorial
  };

  window.addEventListener("DOMContentLoaded", loadTutorial);
  window.addEventListener("pageshow", loadTutorial);
  window.addEventListener("focus", loadTutorial);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadTutorial();
  });
})();
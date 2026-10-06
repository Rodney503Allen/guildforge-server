// =========================================================
// REUSABLE PLAYER CARD
// First surface: Tavern online-player roster.
// Future surfaces can call window.GFPlayerCard.open(playerId).
// =========================================================
(() => {
  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[char]));

  const resolveImage = (value, fallback = "") => {
    const raw = String(value || "").trim();
    if (!raw) return fallback;
    if (/^(https?:)?\/\//i.test(raw)) return raw;
    return `/${raw.replace(/^\/+/, "")}`;
  };

  let modal = null;
  let card = null;
  let lastTrigger = null;
  let requestToken = 0;

  function ensurePlayerCard() {
    if (modal) return;

    modal = document.createElement("div");
    modal.className = "gfPlayerCardModal";
    modal.hidden = true;

    modal.innerHTML = `
      <div class="gfPlayerCardModal__backdrop" data-player-card-close></div>

      <section
        class="gfPlayerCard"
        role="dialog"
        aria-modal="true"
        aria-label="Player Card"
      >
        <button
          class="gfPlayerCard__close"
          type="button"
          data-player-card-close
          aria-label="Close player card"
        >×</button>

        <div class="gfPlayerCard__loading">
          <span class="gfPlayerCard__loadingMark">◆</span>
          Loading adventurer…
        </div>
      </section>
    `;

    document.body.appendChild(modal);
    card = modal.querySelector(".gfPlayerCard");

    modal.addEventListener("click", event => {
      if (event.target.closest("[data-player-card-close]")) {
        close();
        return;
      }

      const action = event.target.closest("[data-player-card-action]");
      if (!action || action.disabled) return;

      const playerId = Number(action.dataset.playerId);
      const type = action.dataset.playerCardAction;

      if (type === "trade") {
        close();

        const tradeEvent = new CustomEvent(
          "gf:player-card:trade",
          {
            cancelable: true,
            detail: { playerId }
          }
        );

        window.dispatchEvent(tradeEvent);

        // Tavern currently owns the working trade-request flow.
        // Other screens can listen for the event above when they gain
        // their own trade entry point.
        if (
          !tradeEvent.defaultPrevented &&
          typeof window.GFTavernRequestTrade === "function"
        ) {
          void window.GFTavernRequestTrade(playerId);
        }
      }
    });
  }

  function fitPlayerName() {
    const name = card?.querySelector(".gfPlayerCard__name");
    if (!name) return;

    // Remove any previous inline fit so CSS supplies the intended
    // full-size value for the current breakpoint.
    name.style.removeProperty("font-size");

    const startingSize =
      parseFloat(window.getComputedStyle(name).fontSize) || 34;

    const minimumSize = 12;
    let size = startingSize;

    // clientWidth is the actual width available to the name.
    // scrollWidth is the width required by the complete rendered name.
    while (
      name.scrollWidth > name.clientWidth &&
      size > minimumSize
    ) {
      size = Math.max(minimumSize, size - 0.5);
      name.style.fontSize = `${size}px`;
    }
  }

  function schedulePlayerNameFit() {
    // Wait until the newly rendered card has completed browser layout.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitPlayerName();
      });
    });
  }

  function render(player) {
    const portrait = resolveImage(
      player.portraitUrl,
      "/images/avatars/default_adventurer.webp"
    );

    const background = resolveImage(player.cardBackgroundUrl);
    const backgroundStyle = background
      ? `style="--player-card-bg:url('${escapeHtml(background)}')"`
      : "";

    const guild = player.guildName
      ? `&lt;${escapeHtml(player.guildName)}&gt;`
      : "No Guild";

    card.innerHTML = `
      <button
        class="gfPlayerCard__close"
        type="button"
        data-player-card-close
        aria-label="Close player card"
      >×</button>

      <div class="gfPlayerCard__art" ${backgroundStyle}></div>
      <div class="gfPlayerCard__shade"></div>
      <div class="gfPlayerCard__texture"></div>

      <div class="gfPlayerCard__content">
        <div class="gfPlayerCard__portraitWrap">
          <div class="gfPlayerCard__portraitGlow"></div>
          <img
            class="gfPlayerCard__portrait"
            src="${escapeHtml(portrait)}"
            alt="${escapeHtml(player.name)}"
          >
        </div>

        <div class="gfPlayerCard__identity">
          <div class="gfPlayerCard__eyebrow">Player Card</div>
          <div class="gfPlayerCard__title">
            ${escapeHtml(player.title || "Adventurer")}
          </div>

          <h2 class="gfPlayerCard__name">
            ${escapeHtml(player.name)}
          </h2>

          <div class="gfPlayerCard__details">
            <span>Level ${Number(player.level || 1)}</span>
            <span class="gfPlayerCard__dot">◆</span>
            <span>${escapeHtml(player.pclass || "Adventurer")}</span>
          </div>

          <div class="gfPlayerCard__guild">
            ${guild}
          </div>
        </div>

        ${
          player.isSelf
            ? `
              <div class="gfPlayerCard__selfMark">
                Your Character
              </div>
            `
            : `
              <div class="gfPlayerCard__actions" aria-label="Player actions">
                <button
                  class="gfPlayerCardAction"
                  type="button"
                  disabled
                  title="Party invites will be connected here"
                  aria-label="Invite to party"
                >
                  <span class="gfPlayerCardAction__icon">⚔</span>
                  <span>Party</span>
                </button>

                <button
                  class="gfPlayerCardAction"
                  type="button"
                  disabled
                  title="Guild invites will be connected here"
                  aria-label="Invite to guild"
                >
                  <span class="gfPlayerCardAction__icon">⚑</span>
                  <span>Guild</span>
                </button>

                <button
                  class="gfPlayerCardAction"
                  type="button"
                  data-player-card-action="trade"
                  data-player-id="${Number(player.id)}"
                  title="Request trade"
                  aria-label="Request trade"
                >
                  <span class="gfPlayerCardAction__icon">⇄</span>
                  <span>Trade</span>
                </button>
              </div>
            `
        }
      </div>
    `;

    schedulePlayerNameFit();
  }

  function renderError(message) {
    card.innerHTML = `
      <button
        class="gfPlayerCard__close"
        type="button"
        data-player-card-close
        aria-label="Close player card"
      >×</button>

      <div class="gfPlayerCard__error">
        <strong>Could not open player card</strong>
        <span>${escapeHtml(message || "Please try again.")}</span>
      </div>
    `;
  }

  async function open(playerId, trigger = null) {
    const id = Number(playerId);
    if (!Number.isInteger(id) || id <= 0) return;

    ensurePlayerCard();

    lastTrigger = trigger || document.activeElement;
    const token = ++requestToken;

    card.innerHTML = `
      <button
        class="gfPlayerCard__close"
        type="button"
        data-player-card-close
        aria-label="Close player card"
      >×</button>

      <div class="gfPlayerCard__loading">
        <span class="gfPlayerCard__loadingMark">◆</span>
        Loading adventurer…
      </div>
    `;

    modal.hidden = false;
    document.body.classList.add("gf-player-card-open");

    try {
      const response = await fetch(
        `/api/players/${id}/card`,
        { credentials: "include" }
      );

      const data = await response.json().catch(() => ({}));

      if (token !== requestToken) return;

      if (!response.ok || !data.ok || !data.player) {
        throw new Error(data.error || "Player card unavailable.");
      }

      render(data.player);
      card.querySelector(".gfPlayerCard__close")?.focus();
    } catch (error) {
      if (token !== requestToken) return;
      renderError(error?.message);
    }
  }

  function close() {
    if (!modal || modal.hidden) return;

    requestToken += 1;
    modal.hidden = true;
    document.body.classList.remove("gf-player-card-open");

    if (
      lastTrigger &&
      typeof lastTrigger.focus === "function"
    ) {
      lastTrigger.focus();
    }
  }

  document.addEventListener("click", event => {
    const target = event.target.closest("[data-player-card-id]");
    if (!target) return;

    event.preventDefault();
    open(Number(target.dataset.playerCardId), target);
  });

  document.addEventListener("keydown", event => {
    if (
      (event.key === "Enter" || event.key === " ") &&
      event.target.closest("[data-player-card-id]")
    ) {
      event.preventDefault();
      const target = event.target.closest("[data-player-card-id]");
      open(Number(target.dataset.playerCardId), target);
      return;
    }

    if (event.key === "Escape" && modal && !modal.hidden) {
      close();
    }
  });

  let playerCardResizeTimer = null;

  window.addEventListener("resize", () => {
    clearTimeout(playerCardResizeTimer);

    playerCardResizeTimer = setTimeout(() => {
      if (modal && !modal.hidden) {
        schedulePlayerNameFit();
      }
    }, 80);
  });

  window.GFPlayerCard = {
    open,
    close
  };
})();

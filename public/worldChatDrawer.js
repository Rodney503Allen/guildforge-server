// =========================================================
// GUILDFORGE GLOBAL WORLD CHAT DRAWER
// Far-right statpanel chat tab + reusable world chat panel.
// =========================================================

(function () {
  "use strict";

  if (window.__GFWorldChatDrawerLoaded) return;
  window.__GFWorldChatDrawerLoaded = true;

  const DEFAULT_PORTRAIT =
    "/images/avatars/default_adventurer.webp";
  const MAX_LINKED_ITEMS = 4;
  const POLL_MS = 2000;

  let pendingItemLinks = [];
  let lastMessageSignature = "";
  let unreadCount = 0;
  let pollTimer = null;

  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      char =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#039;"
        }[char])
    );
  }

  function rarityClass(rarity) {
    return `gf-${String(rarity || "common")
      .toLowerCase()
      .trim()}`;
  }

  function formatRarityName(rarity) {
    const normalized =
      String(rarity || "").toLowerCase().trim();

    const names = {
      dormant: "Dormant",
      uncommon: "Dormant",
      awakened: "Awakened",
      rare: "Awakened",
      empowered: "Empowered",
      epic: "Empowered",
      transcendent: "Transcendent",
      legendary: "Transcendent"
    };

    return names[normalized] || "";
  }

  function getItemDisplayName(item) {
    const baseName =
      String(item?.name || "Unknown Item").trim();

    const isGenerated =
      item?.playerItemId != null ||
      item?.player_item_id != null;

    if (!isGenerated) return baseName;

    const rarityName =
      formatRarityName(item?.rarity);

    if (!rarityName) return baseName;

    if (
      baseName.toLowerCase().startsWith(
        `${rarityName.toLowerCase()} `
      )
    ) {
      return baseName;
    }

    return `${rarityName} ${baseName}`;
  }

  function toKebab(value) {
    return String(value)
      .replace(
        /([a-z0-9])([A-Z])/g,
        "$1-$2"
      )
      .toLowerCase();
  }

  function itemTooltipAttrs(item) {
    const attrs = {
      tooltip: "item",
      name: getItemDisplayName(item),
      rarity: item?.rarity || "common",
      category: item?.category || "",
      itemType:
        item?.itemType ||
        item?.item_type ||
        "",
      slot: item?.slot || "",
      weaponClass: item?.weaponClass || item?.weapon_class || "",
      armorWeight:
        item?.armorWeight ||
        item?.armor_weight ||
        "",
      value: item?.value ?? "",
      qty:
        item?.quantity ??
        item?.qty ??
        1,
      desc:
        item?.description ||
        item?.desc ||
        "",
      itemLevel:
        item?.itemLevel ??
        item?.item_level ??
        "",
      baseAttack:
        item?.baseAttack ??
        item?.base_attack ??
        "",
      baseDefense:
        item?.baseDefense ??
        item?.base_defense ??
        "",
      attackSpeedMs:
        item?.attackSpeedMs ??
        item?.attack_speed_ms ??
        "",
      rollJson: JSON.stringify(
        item?.rollJson ||
        item?.roll_json ||
        []
      )
    };

    return Object.entries(attrs)
      .map(
        ([key, value]) =>
          `data-${toKebab(key)}="${escapeHtml(value)}"`
      )
      .join(" ");
  }

  function renderItemLinks(links) {
    if (!Array.isArray(links) || !links.length) {
      return "";
    }

    return `
      <span class="gfWorldChatLinkedItems">
        ${links
          .map(link => {
            const item = link?.item;
            if (!item) return "";

            return `
              <button
                type="button"
                class="gfWorldChatLinkedItem ${rarityClass(item.rarity)}"
                ${itemTooltipAttrs(item)}
              >
                [${escapeHtml(getItemDisplayName(item))}]
              </button>
            `;
          })
          .join("")}
      </span>
    `;
  }

  function getElements() {
    return {
      toggle:
        document.getElementById(
          "world-chat-toggle"
        ),
      unread:
        document.getElementById(
          "world-chat-unread"
        ),
      drawer:
        document.getElementById(
          "world-chat-drawer"
        ),
      close:
        document.getElementById(
          "world-chat-close"
        ),
      log:
        document.getElementById(
          "world-chat-drawer-log"
        ),
      input:
        document.getElementById(
          "world-chat-drawer-input"
        ),
      send:
        document.getElementById(
          "world-chat-drawer-send"
        ),
      link:
        document.getElementById(
          "world-chat-drawer-link"
        ),
      pending:
        document.getElementById(
          "world-chat-drawer-pending"
        ),
      picker:
        document.getElementById(
          "world-chat-drawer-picker"
        ),
      pickerList:
        document.getElementById(
          "world-chat-drawer-picker-list"
        ),
      pickerClose:
        document.getElementById(
          "world-chat-drawer-picker-close"
        )
    };
  }

  function isOpen() {
    return getElements().drawer
      ?.classList.contains("is-open");
  }

  function updateUnread() {
    const { unread } = getElements();
    if (!unread) return;

    unread.textContent =
      unreadCount > 99
        ? "99+"
        : String(unreadCount);

    unread.hidden = unreadCount <= 0;
  }

  function setOpen(open) {
    const { toggle, drawer, input } =
      getElements();

    if (!toggle || !drawer) return;

    drawer.classList.toggle(
      "is-open",
      open
    );

    drawer.setAttribute(
      "aria-hidden",
      open ? "false" : "true"
    );

    toggle.setAttribute(
      "aria-expanded",
      open ? "true" : "false"
    );

    if (open) {
      unreadCount = 0;
      updateUnread();

      loadChat({
        countUnread: false,
        forceScroll: true
      });

      requestAnimationFrame(
        () => input?.focus()
      );
    }
  }

  function messageSignature(messages) {
    if (!Array.isArray(messages)) {
      return "";
    }

    return messages
      .map(msg =>
        [
          msg.id ?? "",
          msg.player_id ?? "",
          msg.message ?? "",
          msg.created_at ?? "",
          Array.isArray(msg.item_links)
            ? msg.item_links.length
            : 0
        ].join(":")
      )
      .join("|");
  }

  function countNewMessages(messages) {
    if (!Array.isArray(messages)) {
      return 0;
    }

    if (!lastMessageSignature) {
      return 0;
    }

    // World chat currently returns a compact recent history.
    // If the signature changed while the drawer is closed,
    // count the newest entry as an unread notification.
    const signature =
      messageSignature(messages);

    return signature !== lastMessageSignature
      ? 1
      : 0;
  }

  async function loadChat(options = {}) {
    const {
      countUnread = true,
      forceScroll = false
    } = options;

    const { log } = getElements();
    if (!log) return;

    try {
      const response =
        await fetch(
          "/api/chat/world",
          {
            credentials: "include",
            cache: "no-store"
          }
        );

      if (!response.ok) return;

      const data =
        await response.json();

      const messages =
        Array.isArray(data)
          ? data
          : [];

      const addedUnread =
        countUnread && !isOpen()
          ? countNewMessages(messages)
          : 0;

      const signature =
        messageSignature(messages);

      const wasNearBottom =
        log.scrollHeight -
          log.scrollTop -
          log.clientHeight <
        70;

      log.innerHTML = "";

      if (!messages.length) {
        log.innerHTML = `
          <div class="gfWorldChatEmpty">
            No messages yet. Be the first to speak.
          </div>
        `;
      } else {
        messages.forEach(msg => {
          const playerId =
            Number(msg.player_id);

          const hasPlayer =
            Number.isInteger(playerId) &&
            playerId > 0;

          const playerName =
            escapeHtml(
              msg.player_name ||
              "Adventurer"
            );

          const portraitUrl =
            escapeHtml(
              msg.portrait_url ||
              DEFAULT_PORTRAIT
            );

          const row =
            document.createElement("div");

          row.className =
            "gfWorldChatMessage";

          row.innerHTML = `
            <button
              type="button"
              class="gfWorldChatPortrait"
              ${
                hasPlayer
                  ? `data-player-card-id="${playerId}"`
                  : "disabled"
              }
              aria-label="${
                hasPlayer
                  ? `View ${playerName}'s player card`
                  : `${playerName} portrait`
              }"
            >
              <img
                src="${portraitUrl}"
                alt=""
                loading="lazy"
              >
            </button>

            <div class="gfWorldChatMessageBody">
              ${
                hasPlayer
                  ? `
                    <button
                      type="button"
                      class="gfWorldChatName"
                      data-player-card-id="${playerId}"
                    >
                      ${playerName}
                    </button>
                  `
                  : `
                    <span class="gfWorldChatName">
                      ${playerName}
                    </span>
                  `
              }

              ${
                msg.message
                  ? `
                    <span class="gfWorldChatText">
                      ${escapeHtml(msg.message)}
                    </span>
                  `
                  : ""
              }

              ${renderItemLinks(
                msg.item_links
              )}
            </div>
          `;

          const image =
            row.querySelector(
              ".gfWorldChatPortrait img"
            );

          image?.addEventListener(
            "error",
            () => {
              image.onerror = null;
              image.src =
                DEFAULT_PORTRAIT;
            },
            { once: true }
          );

          log.appendChild(row);
        });
      }

      if (
        forceScroll ||
        wasNearBottom ||
        !lastMessageSignature
      ) {
        log.scrollTop =
          log.scrollHeight;
      }

      if (addedUnread > 0) {
        unreadCount += addedUnread;
        updateUnread();
      }

      lastMessageSignature =
        signature;
    } catch (error) {
      console.warn(
        "Global world chat load failed:",
        error
      );
    }
  }

  function renderPendingLinks() {
    const { pending } = getElements();
    if (!pending) return;

    pending.innerHTML = "";

    if (!pendingItemLinks.length) {
      pending.hidden = true;
      return;
    }

    pending.hidden = false;

    pendingItemLinks.forEach(item => {
      const chip =
        document.createElement("span");

      chip.className =
        `gfWorldChatPendingItem ${rarityClass(
          item.rarity
        )}`;

      chip.innerHTML = `
        <span
          class="gfWorldChatPendingName"
          ${itemTooltipAttrs(item)}
          tabindex="0"
        >
          [${escapeHtml(
            getItemDisplayName(item)
          )}]
        </span>

        <button
          type="button"
          class="gfWorldChatPendingRemove"
          aria-label="Remove ${escapeHtml(
            getItemDisplayName(item)
          )}"
        >
          ×
        </button>
      `;

      chip
        .querySelector(
          ".gfWorldChatPendingRemove"
        )
        ?.addEventListener(
          "click",
          () => {
            pendingItemLinks =
              pendingItemLinks.filter(
                linked =>
                  Number(
                    linked.inventoryId
                  ) !==
                  Number(
                    item.inventoryId
                  )
              );

            renderPendingLinks();
          }
        );

      pending.appendChild(chip);
    });
  }

  async function openItemPicker() {
    if (
      pendingItemLinks.length >=
      MAX_LINKED_ITEMS
    ) {
      return;
    }

    const {
      picker,
      pickerList
    } = getElements();

    if (!picker || !pickerList) {
      return;
    }

    picker.hidden = false;
    pickerList.innerHTML = `
      <div class="gfWorldChatPickerEmpty">
        Loading inventory…
      </div>
    `;

    try {
      const response =
        await fetch(
          "/api/chat/linkable-items",
          {
            credentials: "include",
            cache: "no-store"
          }
        );

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}`
        );
      }

      const items =
        await response.json();

      renderItemPicker(
        Array.isArray(items)
          ? items
          : []
      );
    } catch (error) {
      console.error(
        "Could not load chat linkable items:",
        error
      );

      pickerList.innerHTML = `
        <div class="gfWorldChatPickerEmpty">
          Could not load your inventory.
        </div>
      `;
    }
  }

  function renderItemPicker(items) {
    const {
      picker,
      pickerList,
      input
    } = getElements();

    if (!picker || !pickerList) {
      return;
    }

    pickerList.innerHTML = "";

    if (!items.length) {
      pickerList.innerHTML = `
        <div class="gfWorldChatPickerEmpty">
          Your inventory is empty.
        </div>
      `;
      return;
    }

    const sortedItems = [...items].sort((a, b) => {
      const aEquipped =
        a?.equipped === true ||
        Number(a?.equipped) === 1;

      const bEquipped =
        b?.equipped === true ||
        Number(b?.equipped) === 1;

      if (aEquipped !== bEquipped) {
        return aEquipped ? -1 : 1;
      }

      return 0;
    });

    sortedItems.forEach(item => {
      const alreadyLinked =
        pendingItemLinks.some(
          linked =>
            Number(
              linked.inventoryId
            ) ===
            Number(
              item.inventoryId
            )
        );

      const isEquipped =
        item?.equipped === true ||
        Number(item?.equipped) === 1;

      const button =
        document.createElement(
          "button"
        );

      button.type = "button";
      button.className =
        `gfWorldChatPickerItem ${rarityClass(
          item.rarity
        )}${isEquipped ? " is-equipped" : ""}`;

      button.disabled =
        alreadyLinked;

      button.setAttribute(
        "aria-label",
        alreadyLinked
          ? `${getItemDisplayName(item)}${isEquipped ? ", equipped" : ""} already linked`
          : `Link ${getItemDisplayName(item)}${isEquipped ? ", equipped" : ""}`
      );

      const tooltipTemplate =
        document.createElement(
          "template"
        );

      tooltipTemplate.innerHTML =
        `<span ${itemTooltipAttrs(item)}></span>`;

      const tooltipSource =
        tooltipTemplate
          .content
          .firstElementChild;

      if (tooltipSource) {
        for (
          const [key, value]
          of Object.entries(
            tooltipSource.dataset
          )
        ) {
          button.dataset[key] =
            value;
        }
      }

      button.innerHTML = `
        <span class="gfWorldChatPickerIcon">
          ${
            isEquipped
              ? `
                <span
                  class="gfWorldChatPickerEquipped"
                  aria-hidden="true"
                  title="Equipped"
                >E</span>
              `
              : ""
          }

          ${
            item.icon
              ? `
                <img
                  src="${escapeHtml(item.icon)}"
                  alt=""
                  loading="lazy"
                >
              `
              : `
                <span
                  class="gfWorldChatPickerFallback"
                  aria-hidden="true"
                >◆</span>
              `
          }

          ${
            Number(item.quantity) > 1
              ? `
                <span class="gfWorldChatPickerQty">
                  ${escapeHtml(item.quantity)}
                </span>
              `
              : ""
          }

          ${
            alreadyLinked
              ? `
                <span
                  class="gfWorldChatPickerLinked"
                  aria-hidden="true"
                >✓</span>
              `
              : ""
          }
        </span>
      `;

      const image =
        button.querySelector("img");

      image?.addEventListener(
        "error",
        () => {
          image.remove();

          const fallback =
            document.createElement(
              "span"
            );

          fallback.className =
            "gfWorldChatPickerFallback";
          fallback.textContent = "◆";

          button
            .querySelector(
              ".gfWorldChatPickerIcon"
            )
            ?.prepend(fallback);
        },
        { once: true }
      );

      button.addEventListener(
        "click",
        () => {
          if (
            pendingItemLinks.length >=
            MAX_LINKED_ITEMS
          ) {
            return;
          }

          pendingItemLinks.push(item);

          if (
            window.GFTooltip &&
            typeof window.GFTooltip
              .hide === "function"
          ) {
            window.GFTooltip.hide();
          }

          renderPendingLinks();
          picker.hidden = true;
          input?.focus();
        }
      );

      pickerList.appendChild(
        button
      );
    });
  }

  async function sendChat() {
    const {
      input,
      send
    } = getElements();

    if (!input) return;

    const text =
      input.value.trim();

    if (
      !text &&
      !pendingItemLinks.length
    ) {
      return;
    }

    if (send) send.disabled = true;

    try {
      const response =
        await fetch(
          "/api/chat/world",
          {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type":
                "application/json"
            },
            body: JSON.stringify({
              message: text,
              linkedInventoryIds:
                pendingItemLinks.map(
                  item =>
                    Number(
                      item.inventoryId
                    )
                )
            })
          }
        );

      const result =
        await response.json()
          .catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          result?.error ||
          result?.message ||
          "Chat message was rejected."
        );
      }

      input.value = "";
      pendingItemLinks = [];
      renderPendingLinks();

      await loadChat({
        countUnread: false,
        forceScroll: true
      });

      input.focus();
    } catch (error) {
      console.error(
        "Global world chat send failed:",
        error
      );

      if (
        window.GFToast &&
        typeof window.GFToast.show ===
          "function"
      ) {
        window.GFToast.show(
          "World Chat",
          error?.message ||
            "Unable to send message.",
          { type: "error" }
        );
      }
    } finally {
      if (send) send.disabled = false;
    }
  }

  function bindPlayerCards() {
    document.addEventListener(
      "click",
      event => {
        const trigger =
          event.target.closest(
            "#world-chat-drawer [data-player-card-id]"
          );

        if (!trigger) return;

        const playerId =
          Number(
            trigger.dataset.playerCardId
          );

        if (
          !Number.isInteger(playerId) ||
          playerId <= 0
        ) {
          return;
        }

        if (
          window.GFPlayerCard &&
          typeof window.GFPlayerCard
            .open === "function"
        ) {
          window.GFPlayerCard.open(
            playerId
          );
        }
      }
    );
  }

  function bindUI() {
    const {
      toggle,
      close,
      drawer,
      input,
      send,
      link,
      picker,
      pickerClose
    } = getElements();

    if (!toggle || !drawer) return;

    toggle.addEventListener(
      "click",
      () => setOpen(!isOpen())
    );

    close?.addEventListener(
      "click",
      () => setOpen(false)
    );

    send?.addEventListener(
      "click",
      sendChat
    );

    link?.addEventListener(
      "click",
      openItemPicker
    );

    input?.addEventListener(
      "keydown",
      event => {
        if (
          event.key === "Enter" &&
          !event.shiftKey
        ) {
          event.preventDefault();
          sendChat();
        }
      }
    );

    pickerClose?.addEventListener(
      "click",
      () => {
        if (picker) {
          picker.hidden = true;
        }
      }
    );

    picker?.addEventListener(
      "click",
      event => {
        if (
          event.target === picker
        ) {
          picker.hidden = true;
        }
      }
    );

    document.addEventListener(
      "keydown",
      event => {
        if (event.key !== "Escape") {
          return;
        }

        if (
          picker &&
          !picker.hidden
        ) {
          picker.hidden = true;
          return;
        }

        if (isOpen()) {
          setOpen(false);
        }
      }
    );
  }

  function startPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
    }

    loadChat({
      countUnread: false
    });

    pollTimer =
      window.setInterval(
        () => {
          loadChat({
            countUnread: true
          });
        },
        POLL_MS
      );
  }

  function initialize() {
    if (
      !document.getElementById(
        "world-chat-drawer"
      )
    ) {
      return;
    }

    bindUI();
    bindPlayerCards();
    renderPendingLinks();
    updateUnread();
    startPolling();
  }

  if (
    document.readyState ===
    "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      initialize,
      { once: true }
    );
  } else {
    initialize();
  }

  window.GFWorldChatDrawer = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    refresh: () =>
      loadChat({
        countUnread: false
      })
  };
})();

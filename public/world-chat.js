console.log("✅ world-chat.js loaded");

const chatLog =
  document.getElementById("chatLog");

const chatInput =
  document.getElementById("chatInput");

const chatSend =
  document.getElementById("chatSend");

const DEFAULT_CHAT_PORTRAIT =
  "/images/avatars/default_adventurer.webp";

const MAX_LINKED_ITEMS = 4;

let pendingItemLinks = [];

if (!chatLog || !chatInput) {
  console.warn(
    "⚠️ world-chat.js: chat DOM not found, skipping init"
  );
} else {
  const composer =
    chatInput.closest(
      ".chatInputRow"
    ) || chatInput.parentElement;

  const linkItemButton =
    document.createElement(
      "button"
    );

  linkItemButton.type =
    "button";
  linkItemButton.className =
    "btn chatLinkItemBtn";
  linkItemButton.innerHTML =
    `<span aria-hidden="true">🔗</span>
     <span>Link Item</span>`;

  const pendingLinks =
    document.createElement(
      "div"
    );

  pendingLinks.className =
    "chatPendingLinks";
  pendingLinks.hidden = true;

  if (composer) {
    composer.insertBefore(
      linkItemButton,
      chatSend || null
    );

    composer.insertAdjacentElement(
      "afterend",
      pendingLinks
    );
  }

  const picker =
    createItemPicker();

  document.body.appendChild(
    picker.root
  );

  function createItemPicker() {
    const root =
      document.createElement(
        "div"
      );

    root.className =
      "chatItemPicker";
    root.hidden = true;

    root.innerHTML = `
      <div
        class="chatItemPicker__panel frame-host"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chatItemPickerTitle"
      >
        <div class="frame-border panel"></div>

        <div class="chatItemPicker__header">
          <div>
            <span class="chatItemPicker__eyebrow">
              Tavern Chat
            </span>
            <h2 id="chatItemPickerTitle">
              Link an Item
            </h2>
            <p>
              Choose an item to show other players.
            </p>
          </div>

          <button
            type="button"
            class="chatItemPicker__close"
            aria-label="Close item picker"
          >
            ×
          </button>
        </div>

        <div class="chatItemPicker__list"></div>
      </div>
    `;

    const panel =
      root.querySelector(
        ".chatItemPicker__panel"
      );

    const list =
      root.querySelector(
        ".chatItemPicker__list"
      );

    const close =
      root.querySelector(
        ".chatItemPicker__close"
      );

    close.addEventListener(
      "click",
      () => {
        root.hidden = true;
      }
    );

    root.addEventListener(
      "click",
      event => {
        if (
          event.target === root
        ) {
          root.hidden = true;
        }
      }
    );

    panel.addEventListener(
      "click",
      event => {
        event.stopPropagation();
      }
    );

    return {
      root,
      list
    };
  }

  function rarityClass(
    rarity
  ) {
    const normalized =
      String(
        rarity || "common"
      )
        .toLowerCase()
        .trim();

    return (
      `gf-${normalized}`
    );
  }

  function formatRarityName(
    rarity
  ) {
    const normalized =
      String(rarity || "")
        .toLowerCase()
        .trim();

    const names = {
      dormant: "Dormant",
      awakened: "Awakened",
      empowered: "Empowered",
      transcendent: "Transcendent"
    };

    return names[normalized] || "";
  }

  function getItemDisplayName(
    item
  ) {
    const baseName =
      String(
        item?.name ||
        "Unknown Item"
      ).trim();

    // Only generated equipment receives the rarity prefix.
    // Static items keep their normal database name.
    const isGenerated =
      item?.playerItemId != null;

    if (!isGenerated) {
      return baseName;
    }

    const rarityName =
      formatRarityName(
        item?.rarity
      );

    if (!rarityName) {
      return baseName;
    }

    // Avoid double-prefixing if a generated item's stored
    // name ever already includes its rarity.
    if (
      baseName
        .toLowerCase()
        .startsWith(
          `${rarityName.toLowerCase()} `
        )
    ) {
      return baseName;
    }

    return `${rarityName} ${baseName}`;
  }

  function itemTooltipAttrs(
    item
  ) {
    const attrs = {
      tooltip: "item",
      name:
        getItemDisplayName(
          item
        ),
      rarity:
        item.rarity ||
        "common",
      category:
        item.category || "",
      itemType:
        item.itemType || "",
      slot:
        item.slot || "",
      weaponClass:
        item.weaponClass || item.weapon_class || "",
      armorWeight:
        item.armorWeight || "",
      value:
        item.value ?? "",
      qty:
        item.quantity ?? 1,
      desc:
        item.description || "",
      itemLevel:
        item.itemLevel ?? "",
      baseAttack:
        item.baseAttack ?? "",
      baseDefense:
        item.baseDefense ?? "",
      attackSpeedMs:
        item.attackSpeedMs ??
        item.attack_speed_ms ?? "",
      relicAffixName: item.relicAffixName || item.relic_affix_name || "",
      relicAffixDescription: item.relicAffixDescription || item.relic_affix_description || "",
      rollJson:
        JSON.stringify(
          item.rollJson || []
        )
    };

    return Object.entries(attrs)
      .map(
        ([key, value]) =>
          `data-${toKebab(key)}="${escapeHtml(value)}"`
      )
      .join(" ");
  }

  function toKebab(value) {
    return String(value)
      .replace(
        /([a-z0-9])([A-Z])/g,
        "$1-$2"
      )
      .toLowerCase();
  }

  function renderPendingLinks() {
    pendingLinks.innerHTML = "";

    if (
      pendingItemLinks.length === 0
    ) {
      pendingLinks.hidden =
        true;
      return;
    }

    pendingLinks.hidden =
      false;

    pendingItemLinks.forEach(
      item => {
        const chip =
          document.createElement(
            "span"
          );

        chip.className =
          `chatPendingItem ${rarityClass(
            item.rarity
          )}`;

        chip.innerHTML = `
          <span
            class="chatPendingItem__name"
            ${itemTooltipAttrs(item)}
            tabindex="0"
          >
            [${escapeHtml(
              getItemDisplayName(item)
            )}]
          </span>

          <button
            type="button"
            class="chatPendingItem__remove"
            aria-label="Remove ${escapeHtml(
              getItemDisplayName(item)
            )}"
          >
            ×
          </button>
        `;

        chip
          .querySelector(
            ".chatPendingItem__remove"
          )
          .addEventListener(
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

        pendingLinks.appendChild(
          chip
        );
      }
    );
  }

  async function openItemPicker() {
    if (
      pendingItemLinks.length >=
      MAX_LINKED_ITEMS
    ) {
      return;
    }

    picker.root.hidden = false;
    picker.list.innerHTML =
      `<div class="chatItemPicker__empty">
        Loading inventory…
       </div>`;

    try {
      const response =
        await fetch(
          "/api/chat/linkable-items",
          {
            credentials:
              "include"
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
    } catch (err) {
      console.error(
        "Could not load linkable items:",
        err
      );

      picker.list.innerHTML =
        `<div class="chatItemPicker__empty">
          Could not load your inventory.
         </div>`;
    }
  }

  function renderItemPicker(
    items
  ) {
    picker.list.innerHTML = "";

    if (!items.length) {
      picker.list.innerHTML =
        `<div class="chatItemPicker__empty">
          Your inventory is empty.
         </div>`;
      return;
    }

    items.forEach(item => {
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

      const button =
        document.createElement(
          "button"
        );

      button.type = "button";
      button.className =
        `chatItemPicker__item ${rarityClass(
          item.rarity
        )}`;

      button.disabled =
        alreadyLinked;

      button.setAttribute(
        "aria-label",
        alreadyLinked
          ? `${getItemDisplayName(item)} already linked`
          : `Link ${getItemDisplayName(item)}`
      );

      // The picker uses the exact same global Guildforge tooltip
      // dataset as inventory/chat item links, including generated
      // equipment roll_json.
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
        <span class="chatItemPicker__icon">
          ${
            item.icon
              ? `<img
                   src="${escapeHtml(item.icon)}"
                   alt=""
                   loading="lazy"
                 >`
              : `<span
                   class="chatItemPicker__fallback"
                   aria-hidden="true"
                 >◆</span>`
          }

          ${
            Number(item.quantity) > 1
              ? `
                <span class="chatItemPicker__qty">
                  ${escapeHtml(item.quantity)}
                </span>
              `
              : ""
          }

          ${
            alreadyLinked
              ? `
                <span
                  class="chatItemPicker__linked"
                  aria-hidden="true"
                >✓</span>
              `
              : ""
          }
        </span>
      `;

      const image =
        button.querySelector("img");

      if (image) {
        image.addEventListener(
          "error",
          () => {
            image.remove();

            const fallback =
              document.createElement(
                "span"
              );

            fallback.className =
              "chatItemPicker__fallback";
            fallback.setAttribute(
              "aria-hidden",
              "true"
            );
            fallback.textContent =
              "◆";

            button
              .querySelector(
                ".chatItemPicker__icon"
              )
              ?.prepend(
                fallback
              );
          },
          { once: true }
        );
      }

      button.addEventListener(
        "click",
        () => {
          if (
            pendingItemLinks.length >=
            MAX_LINKED_ITEMS
          ) {
            return;
          }

          pendingItemLinks.push(
            item
          );

          if (
            window.GFTooltip &&
            typeof window.GFTooltip
              .hide === "function"
          ) {
            window.GFTooltip.hide();
          }

          renderPendingLinks();
          picker.root.hidden = true;
          chatInput.focus();
        }
      );

      picker.list.appendChild(
        button
      );
    });
  }

  function formatItemType(
    item
  ) {
    return String(
      item.itemType ||
      item.category ||
      item.slot ||
      "Item"
    )
      .replace(/_/g, " ")
      .replace(
        /\b\w/g,
        char =>
          char.toUpperCase()
      );
  }

  function renderItemLinks(
    links
  ) {
    if (
      !Array.isArray(links) ||
      links.length === 0
    ) {
      return "";
    }

    return `
      <span class="chatLinkedItems">
        ${links
          .map(link => {
            const item =
              link?.item;

            if (!item) return "";

            return `
              <button
                type="button"
                class="chatLinkedItem ${rarityClass(item.rarity)}"
                ${itemTooltipAttrs(item)}
              >
                [${escapeHtml(
                  getItemDisplayName(item)
                )}]
              </button>
            `;
          })
          .join("")}
      </span>
    `;
  }

  async function loadChat() {
    try {
      const r =
        await fetch(
          "/api/chat/world",
          {
            credentials:
              "include"
          }
        );

      if (!r.ok) return;

      const data =
        await r.json();

      chatLog.innerHTML = "";

      (data || []).forEach(
        msg => {
          const playerId =
            Number(
              msg.player_id
            );

          const hasPlayer =
            Number.isInteger(
              playerId
            ) &&
            playerId > 0;

          const playerCardAttr =
            hasPlayer
              ? `data-player-card-id="${playerId}"`
              : "";

          const portraitUrl =
            escapeHtml(
              msg.portrait_url ||
              DEFAULT_CHAT_PORTRAIT
            );

          const playerName =
            escapeHtml(
              msg.player_name ||
              "Adventurer"
            );

          const div =
            document.createElement(
              "div"
            );

          div.className =
            "chatLine";

          div.innerHTML = `
            <button
              type="button"
              class="chatPortrait${hasPlayer ? " chatPlayerCardTrigger" : ""}"
              ${playerCardAttr}
              ${hasPlayer ? "" : "disabled"}
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

            <div class="chatContent">
              ${
                hasPlayer
                  ? `
                    <button
                      type="button"
                      class="chatName chatPlayerCardTrigger"
                      ${playerCardAttr}
                      aria-label="View ${playerName}'s player card"
                    >
                      ${playerName}
                    </button>
                  `
                  : `
                    <span class="chatName">
                      ${playerName}
                    </span>
                  `
              }

              ${
                msg.message
                  ? `
                    <span class="chatMsg">
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

          const portrait =
            div.querySelector(
              ".chatPortrait img"
            );

          if (portrait) {
            portrait.addEventListener(
              "error",
              () => {
                portrait.onerror =
                  null;

                portrait.src =
                  DEFAULT_CHAT_PORTRAIT;
              },
              { once: true }
            );
          }

          chatLog.appendChild(
            div
          );
        }
      );

      chatLog.scrollTop =
        chatLog.scrollHeight;
    } catch (e) {
      console.error(
        "chat load failed",
        e
      );
    }
  }

  async function sendChat() {
    const text =
      chatInput.value.trim();

    if (
      !text &&
      pendingItemLinks.length === 0
    ) {
      return;
    }

    try {
      const r =
        await fetch(
          "/api/chat/world",
          {
            method: "POST",
            credentials:
              "include",
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
        await r.json()
          .catch(() => ({}));

      if (!r.ok) {
        console.error(
          "Chat send rejected:",
          result
        );
        return;
      }

      chatInput.value = "";
      pendingItemLinks = [];
      renderPendingLinks();

      chatInput.focus();
      loadChat();
    } catch (e) {
      console.error(
        "chat send failed",
        e
      );
    }
  }

  linkItemButton.addEventListener(
    "click",
    openItemPicker
  );

  chatInput.addEventListener(
    "keydown",
    e => {
      if (e.key === "Enter") {
        sendChat();
      }
    }
  );

  if (chatSend) {
    chatSend.addEventListener(
      "click",
      sendChat
    );
  }

  document.addEventListener(
    "keydown",
    event => {
      if (
        event.key ===
          "Escape" &&
        !picker.root.hidden
      ) {
        picker.root.hidden =
          true;
      }
    }
  );

  function escapeHtml(
    text
  ) {
    return String(text ?? "")
      .replace(
        /[&<>"']/g,
        m =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#039;"
          }[m])
      );
  }

  setInterval(
    loadChat,
    2000
  );

  loadChat();
}

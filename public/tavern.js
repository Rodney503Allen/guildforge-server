// public/tavern.js
(function () {
  // -------------------------
  // Globals / DOM
  // -------------------------
  const qs = (id) => document.getElementById(id);

  const btnReturnTown = qs("btnReturnTown");

  const btnRumor = qs("btnRumor");
  const btnAccept = qs("btnAcceptRumor");
  const rumorText = qs("rumorText");
  const rumorHint = qs("rumorHint");

  const turninList = qs("turninList");

  const turninBox = qs("turninBox");
  const turninToggle = qs("turninToggle");
  const turninSummary = qs("turninSummary");

  let currentRumorQuestId = null;

  // townId from querystring (fallback 1)
  window.TOWN_ID = null;

  if (turninToggle && turninBox) {
    turninToggle.addEventListener("click", () => {
      turninBox.classList.toggle("collapsed");
    });
  }
  // -------------------------
  // Simple nav
  // -------------------------
  if (btnReturnTown) {
    btnReturnTown.addEventListener("click", () => {
      location.href = "/town";
    });
  }

// -------------------------
// Rumors
// -------------------------
let availableRumors = [];

function objectivePreviewText(q) {
  const obj = q?.objectivePreview;
  if (!obj) return "";

  if (obj.type === "TURN_IN" && obj.item?.name) {
    return `Objective: Bring ${obj.required} × ${obj.item.name}`;
  }

  if (obj.type === "KILL" && obj.creature?.name) {
    return `Objective: Kill ${obj.required} × ${obj.creature.name}`;
  }

  return "";
}

function renderRumorStack(quests) {
  if (!rumorText || !btnAccept) return;

  currentRumorQuestId = null;
  availableRumors = quests || [];

  btnAccept.style.display = "none";
  btnAccept.disabled = true;

  if (!availableRumors.length) {
    rumorHint.textContent = "Nothing new. The tavern’s quiet… for now.";
    rumorText.innerHTML = `
      <div class="rumor-empty">
        No fresh rumors tonight. Check back after you’ve completed what’s available here.
      </div>
    `;
    return;
  }

  rumorHint.textContent = `${availableRumors.length} rumor${availableRumors.length === 1 ? "" : "s"} overheard`;

  rumorText.innerHTML = availableRumors.map((q) => {
    const objective = objectivePreviewText(q);

    const isMainStory = Number(q.chainId) === 1;

    return `
      <div class="rumor-card ${isMainStory ? "main-story" : ""}" data-rumor-id="${Number(q.questId)}">
        <div class="rumor-card-head">
          <strong>${q.title || "Untitled Rumor"}</strong>
          <span>${q.chainId ? `Chain ${q.chainOrder || "?"}` : "Local Work"}</span>
        </div>

        <p>${q.dialogIntro || q.description || "A rumor passes through the crowd…"}</p>

        ${objective ? `<div class="rumor-objective">${objective}</div>` : ""}

        <button class="btn primary rumor-accept-btn" type="button" data-accept-rumor="${Number(q.questId)}">
          Accept Quest
        </button>
      </div>
    `;
  }).join("");

  rumorText.querySelectorAll("[data-accept-rumor]").forEach(button => {
    button.addEventListener("click", () => {
      const questId = Number(button.getAttribute("data-accept-rumor"));
      acceptRumorQuest(questId, button);
    });
  });
}

async function listenForRumors() {
  if (!btnRumor) return;

  if (!window.TOWN_ID) {
    rumorHint.textContent = "Unknown town.";
    rumorText.textContent = "Could not determine your current tavern.";
    btnAccept.disabled = true;
    return;
  }

  btnRumor.disabled = true;
  btnRumor.textContent = "Listening…";

  try {
    const res = await fetch(`/api/tavern/${window.TOWN_ID}/rumor`, {
      credentials: "include",
    });

    const data = await res.json();

    if (!res.ok) throw new Error(data?.error || "rumor_error");

    renderRumorStack(data?.quests || []);
  } catch (e) {
    console.error("listenForRumors failed:", e);
    currentRumorQuestId = null;
    availableRumors = [];
    rumorHint.textContent = "The noise drowns you out.";
    rumorText.innerHTML = `<div class="rumor-empty">Something went wrong while listening for rumors.</div>`;
    btnAccept.disabled = true;
  } finally {
    btnRumor.disabled = false;
    btnRumor.textContent = "Listen";
  }
}

async function acceptRumorQuest(questId, button) {
  if (!questId) return;

  button.disabled = true;
  button.textContent = "Accepting…";

  try {
    const res = await fetch(`/api/quests/${questId}/accept`, {
      method: "POST",
      credentials: "include",
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "accept_error");

    button.textContent = "Accepted";
    button.classList.remove("primary");
    button.classList.add("disabled");

    const card = button.closest(".rumor-card");
    if (card) card.classList.add("accepted");

    await loadTurnins();
  } catch (e) {
    console.error("acceptRumorQuest failed:", e);
    button.disabled = false;
    button.textContent = "Accept Quest";

    rumorHint.textContent = "Couldn’t accept.";
  }
}

if (btnRumor) btnRumor.addEventListener("click", listenForRumors);
  // -------------------------
  // Turn-ins
  // -------------------------
function group(rows) {
  const map = new Map();

  for (const r of rows || []) {
    const pqid = Number(r.playerQuestId);

    if (!map.has(pqid)) {
      map.set(pqid, {
        playerQuestId: pqid,
        status: String(r.status || "").toLowerCase(),
        title: r.title,
        description: r.description || "",
        isComplete: true, // start true, AND down with each objective
        objectives: [],
      });
    }

    const entry = map.get(pqid);
    const obj = {
      type: r.objectiveType,
      required: Number(r.required_count || 1),
      progress: Number(r.progress_count || 0),
      done: Number(r.is_complete ?? 0) === 1,
      itemName: r.item_name || null,
      have: Number(r.have_qty || 0),
      targetName: r.target_name || r.creature_name || r.location_name || r.interact_name || null,
    };

    entry.objectives.push(obj);

    // For TURN_IN: check inventory quantity, not is_complete
    // For all others: use is_complete flag
    const objComplete = obj.type === "TURN_IN"
      ? obj.have >= obj.required
      : obj.done;

    entry.isComplete = entry.isComplete && objComplete;
  }

  return Array.from(map.values());
}

  function objLine(o) {
    if (o.type === "TURN_IN") {
      if (!o.itemName) return "Return to the tavern";
      return "Bring " + o.required + " × " + o.itemName;
    }

    if (o.type === "KILL") {
      return "Kill " + o.required + " × " + (o.targetName || "Target");
    }

    if (o.type === "INTERACT") {
      return "Interact with " + (o.targetName || "the target");
    }

    if (o.type === "LOCATION") {
      return "Travel to " + (o.targetName || "the target location");
    }

    if (o.type === "ENTER_AREA") {
      return "Enter " + (o.targetName || "the area");
    }

    return String(o.type);
  }

  function progressText(o) {
  if (o.type === "TURN_IN") {
    if (!o.itemName) return o.done ? "ready" : "0/1";
    const have = Math.min(o.have, o.required);
    return have + "/" + o.required; // already correct, no change needed
  }

    if (o.type === "KILL") {
      return Math.min(o.progress, o.required) + "/" + o.required;
    }

    if (o.type === "INTERACT" || o.type === "LOCATION" || o.type === "ENTER_AREA") {
      return o.done || o.progress >= o.required ? "complete" : "incomplete";
    }

    return o.done ? "complete" : Math.min(o.progress, o.required) + "/" + o.required;
  }

    async function loadTurnins() {
      if (!turninList) return;

      if (!window.TOWN_ID) {
        turninList.innerHTML =
          '<div class="empty"><i>Could not determine current town.</i></div>';
        return;
      }

      turninList.innerHTML = '<div class="empty"><i>Loading...</i></div>';

    const rows = await fetch("/api/quests/turnins/" + window.TOWN_ID, {
      credentials: "include",
    })
      .then((r) => r.json())
      .catch(() => []);

    const quests = group(rows);
    const totalQuests = quests.length;
    const readyQuests = quests.filter(q => q.isComplete).length;

    if (turninSummary) {
      if (totalQuests <= 0) {
        turninSummary.textContent = "No quests available for turn-in here.";
      } else {
        turninSummary.textContent = `${totalQuests} quest${totalQuests === 1 ? "" : "s"} here • ${readyQuests} ready`;
      }
    }


    if (!quests.length) {
      turninList.innerHTML =
        '<div class="empty"><i>No active quests can be turned in here.</i></div>';
      return;
    }

    turninList.innerHTML = "";

    for (const q of quests) {
      // IMPORTANT:
      // Turn-in state should come from the QUEST, not be recalculated in the UI.
      const canTurnIn = q.isComplete;

      const lines = q.objectives
        .map((o) => {
          return "• " + objLine(o) + " (" + progressText(o) + ")";
        })
        .join("\n");

      const el = document.createElement("div");
      el.className = "qrow";

      el.innerHTML =
        '<div>' +
        '<div class="qrowTitle">' +
        q.title +
        "</div>" +
        '<div class="qrowDesc">' +
        (q.description || "") +
        "</div>" +
        '<div class="qrowMeta" style="white-space:pre-wrap;">' +
        lines +
        "</div>" +
        "</div>" +
        '<div class="qrowBtns">' +
        '<button class="qbtn" ' +
        (canTurnIn ? "" : "disabled") +
        ' data-turnin="' +
        q.playerQuestId +
        '">' +
        (canTurnIn ? "Turn In" : "Incomplete") +
        "</button>" +
        "</div>";

      const btn = el.querySelector("button[data-turnin]");
      btn.addEventListener("click", async () => {
        const id = Number(btn.getAttribute("data-turnin"));
        if (!Number.isFinite(id)) return;

        btn.disabled = true;
        btn.textContent = "Turning In...";

        let resp = null;
        try {
          const r = await fetch("/api/quests/" + id + "/turn-in", {
            method: "POST",
            credentials: "include",
          });

          const ct = r.headers.get("content-type") || "";
          resp = ct.includes("application/json")
            ? await r.json()
            : { error: "non_json", status: r.status };

          if (!r.ok) resp.status = r.status;
        } catch (e) {
          resp = { error: "network_error" };
        }


        if (resp?.success) {
          await loadTurnins();
          return;
        }

        btn.disabled = false;
        btn.textContent = "Turn In";

        if (resp?.error === "not_enough") {
          alert("Not enough items to turn this in.");
        } else if (resp?.error === "not_completed") {
          alert("This quest is not complete yet.");
        } else if (resp?.error === "Not logged in" || resp?.status === 401) {
          alert("Session expired. Refresh and log in.");
        } else {
          alert("Could not turn in quest.\n\n" + JSON.stringify(resp, null, 2));
        }
      });

      turninList.appendChild(el);
    }
  }

  // -------------------------
  // Town name
  // -------------------------
  async function loadTownName() {
    try {
      const res = await fetch("/town/current", {
        credentials: "include",
      });
      const data = await res.json();

      if (data?.name) qs("townName").textContent = data.name;
      if (data?.id) window.TOWN_ID = Number(data.id);
    } catch (err) {
      console.error("Failed to load town name");
    }
  }

  // Boot
  (async function boot() {
    await loadTownName();
    await loadTurnins();
  })();
})();




(() => {
  const API = "/api/trade";
  const state = {
    trade: null,
    inventory: [],
    selected: new Map(),
    socket: null,
    offerRevision: 0,
    savedRevision: 0,
    saveInFlight: false,
    saveTimer: null,
    lastAcceptedTrade: null,
    lastCompletedTradeId: null,
    lastCancelledTradeId: null,
    unloadCancellationSent: false,
    cancellationInFlight: false,
  };

  const $ = (id) => document.getElementById(id);

  const el = {
    table: $("tradeTableBtn"),
    badge: $("tradeRequestBadge"),
    searchModal: $("tradeSearchModal"),
    windowModal: $("tradeWindowModal"),
    search: $("tradePlayerSearch"),
    searchBtn: $("tradeSearchBtn"),
    results: $("tradeSearchResults"),
    requests: $("tradeIncomingRequests"),
    searchNotice: $("tradeSearchNotice"),
    windowNotice: $("tradeWindowNotice"),
    title: $("tradeWindowTitle"),
    status: $("tradeWindowStatus"),
    pill: $("tradeStatusPill"),
    yourName: $("tradeYourName"),
    otherName: $("tradeOtherName"),
    yourState: $("tradeYourState"),
    otherState: $("tradeOtherState"),
    gold: $("tradeGoldInput"),
    inventory: $("tradeInventoryList"),
    yourItems: $("tradeYourItems"),
    offerCount: $("tradeOfferCount"),
    otherGold: $("tradeOtherGold"),
    otherItems: $("tradeOtherItems"),
    autosave: $("tradeAutosaveStatus"),
    confirm: $("tradeConfirmBtn"),
    accept: $("tradeAcceptBtn"),
    cancel: $("tradeCancelBtn"),
    onlineCount: $("onlineCount"),
    onlineBadge: $("onlinePlayersBadge"),
    onlineList: $("onlinePlayersList"),
  };

  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[char]));


  function renderOnlinePlayers(snapshot) {
    const players = Array.isArray(snapshot?.players)
      ? snapshot.players
      : [];

    const count = Number(
      snapshot?.count ?? players.length ?? 0,
    );

    if (el.onlineCount) {
      el.onlineCount.textContent = String(count);
    }

    if (el.onlineBadge) {
      el.onlineBadge.textContent = `${count} Online`;
    }

    if (!el.onlineList) return;

    if (!players.length) {
      el.onlineList.innerHTML = `
        <div class="empty">
          <i>No travelers are currently online.</i>
        </div>
      `;
      return;
    }

    el.onlineList.innerHTML = players
      .map(player => `
        <div class="onlinePlayerRow frame-host">
          <span class="frame-border sub" aria-hidden="true"></span>

          <div class="onlinePlayerInfo">
            <strong>${escapeHtml(player.name)}</strong>
            <span>
              Lv. ${Number(player.level || 1)}
              ${escapeHtml(player.pclass || "")}
              · ${escapeHtml(player.location || "Unknown location")}
            </span>
          </div>

          <span class="badge good onlinePlayerStatus">Online</span>
        </div>
      `)
      .join("");
  }

  function joinTavernPresence() {
    if (!state.socket?.connected) return;

    state.socket.emit(
      "presence:join-tavern",
      response => {
        if (!response?.ok) {
          console.error(
            "Could not load online players:",
            response?.error,
          );
          return;
        }

        renderOnlinePlayers(response);
      },
    );
  }

  const resolveItemIcon = (icon) => {
    const raw = String(icon ?? "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    return `/${raw.replace(/^\/+/, "")}`;
  };

  const itemIconHtml = (item) => {
    const icon = resolveItemIcon(item?.icon);
    const name = escapeHtml(item?.item_name || "Unknown item");

    if (!icon) {
      return `<span class="tradeItemIcon is-fallback" aria-hidden="true"><span>📦</span></span>`;
    }

    return `
      <span class="tradeItemIcon">
        <img src="${escapeHtml(icon)}" alt="${name}"
          onerror="this.parentElement.classList.add('is-fallback');this.remove()">
        <span aria-hidden="true">📦</span>
      </span>
    `;
  };

const tooltipAttrs = (item, quantity) => `
  data-tooltip="item"
  data-name="${escapeHtml(item.item_name || "Unknown item")}"
  data-qty="${Number(quantity || 1)}"
  data-durability="${
    item.durability == null ? "" : Number(item.durability)
  }"
  data-unique="${
    Number(item.is_unique ?? (item.player_item_id != null))
      ? "true"
      : "false"
  }"
  ${
    item.rarity
      ? `data-rarity="${escapeHtml(item.rarity)}"`
      : ""
  }
  ${
    item.description
      ? `data-desc="${escapeHtml(item.description)}"`
      : ""
  }
  ${
    item.value != null
      ? `data-value="${Number(item.value)}"`
      : ""
  }
  ${
    item.item_level
      ? `data-item-level="${Number(item.item_level)}"`
      : ""
  }
  ${
    item.slot
      ? `data-slot="${escapeHtml(item.slot)}"`
      : ""
  }
  ${
    item.item_type
      ? `data-item-type="${escapeHtml(item.item_type)}"`
      : ""
  }
  ${
    item.armor_weight
      ? `data-armor-weight="${escapeHtml(item.armor_weight)}"`
      : ""
  }
  ${
    item.base_attack
      ? `data-base-attack="${Number(item.base_attack)}"`
      : ""
  }
  ${
    item.base_defense
      ? `data-base-defense="${Number(item.base_defense)}"`
      : ""
  }
  ${
    item.agility
      ? `data-agility="${Number(item.agility)}"`
      : ""
  }
  ${
    item.vitality
      ? `data-vitality="${Number(item.vitality)}"`
      : ""
  }
  ${
    item.intellect
      ? `data-intellect="${Number(item.intellect)}"`
      : ""
  }
  ${
    item.crit
      ? `data-crit="${Number(item.crit)}"`
      : ""
  }
  ${
    item.roll_json
      ? `data-roll-json="${escapeHtml(
          typeof item.roll_json === "string"
            ? item.roll_json
            : JSON.stringify(item.roll_json)
        )}"`
      : ""
  }
`;

  function inventoryItem(inventoryId) {
    return state.inventory.find(item => Number(item.inventory_id) === Number(inventoryId));
  }

  function addToOffer(inventoryId) {
    const item = inventoryItem(inventoryId);
    const you = currentSide();
    if (!item || !state.trade || state.trade.status !== "active" || you?.confirmed) return;

    if (!state.selected.has(Number(inventoryId)) && state.selected.size >= 12) {
      setNotice(el.windowNotice, "You can offer up to 12 item stacks.");
      return;
    }

    state.selected.set(Number(inventoryId), 1);
    markOfferChanged(0);
    setNotice(el.windowNotice);
    renderTrade();
  }

  function removeFromOffer(inventoryId) {
    const you = currentSide();
    if (!state.trade || state.trade.status !== "active" || you?.confirmed) return;
    state.selected.delete(Number(inventoryId));
    markOfferChanged(0);
    renderTrade();
  }

  function renderEmptySlots(count, start = 0) {
    return Array.from({ length: Math.max(0, count) }, (_, index) => `
      <div class="tradeItemSlot tradeItemSlot--empty" aria-hidden="true"><span>${start + index + 1}</span></div>
    `).join("");
  }

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Trade request failed.");
    }

    return data;
  }

  function showModal(modal) {
    modal.hidden = false;
  }

  function closeModal(modal) {
    modal.hidden = true;
  }

  function finishTrade(tradeId) {
    if (Number(state.lastCompletedTradeId) === Number(tradeId)) return;
    if (state.trade && Number(tradeId) !== Number(state.trade.id)) return;

    state.lastCompletedTradeId = Number(tradeId);
    window.clearTimeout(state.saveTimer);
    state.trade = null;
    state.inventory = [];
    state.selected.clear();
    state.offerRevision = 0;
    state.savedRevision = 0;
    state.saveInFlight = false;
    state.lastAcceptedTrade = null;

    closeModal(el.windowModal);
    refreshRequests();

    if (window.GFToast && typeof window.GFToast.show === "function") {
      window.GFToast.show(
        "Trade Complete",
        "Your items and gold have been exchanged.",
        { type: "success", durationMs: 3800 },
      );
    }

    if (typeof window.loadStatPanel === "function") {
      void window.loadStatPanel();
    }
  }

  function finishCancelledTrade(tradeId) {
    if (Number(state.lastCancelledTradeId) === Number(tradeId)) return;
    if (state.trade && Number(tradeId) !== Number(state.trade.id)) return;

    state.lastCancelledTradeId = Number(tradeId);
    state.cancellationInFlight = false;
    window.clearTimeout(state.saveTimer);
    state.trade = null;
    state.inventory = [];
    state.selected.clear();
    state.offerRevision = 0;
    state.savedRevision = 0;
    state.saveInFlight = false;
    state.lastAcceptedTrade = null;

    closeModal(el.windowModal);
    refreshRequests();

    if (window.GFToast && typeof window.GFToast.show === "function") {
      window.GFToast.show(
        "Trade Canceled",
        "The trade has been canceled.",
        { type: "error", durationMs: 3800 },
      );
    }
  }

  function setNotice(target, message = "") {
    target.hidden = !message;
    target.textContent = message;
  }

  function currentSide() {
    if (!state.trade) return null;

    return Number(state.trade.initiator.playerId) === Number(state.trade.currentPlayerId)
      ? state.trade.initiator
      : state.trade.recipient;
  }

  function otherSide() {
    if (!state.trade) return null;

    return Number(state.trade.initiator.playerId) === Number(state.trade.currentPlayerId)
      ? state.trade.recipient
      : state.trade.initiator;
  }

  function setTrade(trade, syncOwnOffer = true) {
    state.trade = trade;

    const you = currentSide();
    if (syncOwnOffer) {
      state.selected.clear();
      (you?.items || []).forEach(item => {
        state.selected.set(Number(item.inventory_id), Number(item.quantity));
      });
      if (el.gold && you) el.gold.value = Number(you.gold || 0);
      state.lastAcceptedTrade = trade;
    }
  }

  function setAutosaveStatus(message, kind = "") {
    if (!el.autosave) return;
    el.autosave.textContent = message;
    el.autosave.dataset.state = kind;
  }

  function offerPayload() {
    return {
      tradeId: Number(state.trade?.id),
      items: [...state.selected.entries()].map(([inventoryId, quantity]) => ({ inventoryId, quantity })),
      gold: Number(el.gold?.value || 0),
    };
  }

  function markOfferChanged(delay = 300) {
    state.offerRevision += 1;
    window.clearTimeout(state.saveTimer);
    setAutosaveStatus("Unsaved changes…", "pending");
    state.saveTimer = window.setTimeout(saveLatestOffer, delay);
  }

  function emitOfferUpdate(payload) {
    return new Promise((resolve, reject) => {
      if (!state.socket?.connected) return reject(new Error("Trade connection is unavailable."));
      state.socket.timeout(8000).emit("trade:update-offer", payload, (error, response) => {
        if (error) return reject(new Error("Trade update timed out."));
        if (!response?.ok) return reject(new Error(response?.error || "Unable to update trade offer."));
        resolve(response.trade);
      });
    });
  }

  async function saveLatestOffer() {
    if (state.saveInFlight || state.savedRevision === state.offerRevision || !state.trade) return;
    state.saveInFlight = true;
    const sentRevision = state.offerRevision;
    const payload = offerPayload();
    setAutosaveStatus("Saving…", "saving");

    try {
      const trade = await emitOfferUpdate(payload);
      state.savedRevision = sentRevision;
      state.lastAcceptedTrade = trade;
      setTrade(trade, state.offerRevision === sentRevision);
      await refreshInventory();
      renderTrade();
      setNotice(el.windowNotice);
      setAutosaveStatus(state.offerRevision === sentRevision ? "Saved" : "Saving latest changes…", "saved");
    } catch (error) {
      state.offerRevision = state.savedRevision;
      if (state.lastAcceptedTrade) setTrade(state.lastAcceptedTrade, true);
      renderTrade();
      setNotice(el.windowNotice, error.message);
      setAutosaveStatus("Not saved", "error");
    } finally {
      state.saveInFlight = false;
      if (state.savedRevision !== state.offerRevision) void saveLatestOffer();
    }
  }

  async function flushOfferSave() {
    window.clearTimeout(state.saveTimer);
    while (state.saveInFlight) await new Promise(resolve => window.setTimeout(resolve, 30));
    if (state.savedRevision !== state.offerRevision) await saveLatestOffer();
    return state.savedRevision === state.offerRevision;
  }

  async function refreshRequests() {
    try {
      const data = await api("/requests");
      const requests = data.requests || [];

      el.badge.hidden = requests.length === 0;
      el.badge.textContent = `${requests.length} Request${requests.length === 1 ? "" : "s"}`;

      el.requests.innerHTML = requests.map(request => `
        <div class="tradeRequestCard">
          <div>
            <strong>${escapeHtml(request.initiator_name)}</strong>
            <span>Level ${Number(request.initiator_level)} ${escapeHtml(request.initiator_class || "")} wants to trade.</span>
          </div>
          <div class="actionBtns">
            <button class="btn primary" type="button" data-accept-request="${Number(request.id)}">Accept</button>
            <button class="btn danger" type="button" data-decline-request="${Number(request.id)}">Decline</button>
          </div>
        </div>
      `).join("");

      el.requests.querySelectorAll("[data-accept-request]").forEach(button => {
        button.addEventListener("click", async () => {
          try {
            button.disabled = true;
            const data = await api(`/requests/${Number(button.dataset.acceptRequest)}/accept`, {
              method: "POST",
              body: "{}",
            });

            setTrade(data.trade);
            closeModal(el.searchModal);
            showModal(el.windowModal);
            await refreshInventory();
            renderTrade();
            refreshRequests();
          } catch (error) {
            setNotice(el.searchNotice, error.message);
            button.disabled = false;
          }
        });
      });

      el.requests.querySelectorAll("[data-decline-request]").forEach(button => {
        button.addEventListener("click", async () => {
          try {
            button.disabled = true;
            await api(`/requests/${Number(button.dataset.declineRequest)}/decline`, {
              method: "POST",
              body: "{}",
            });
            refreshRequests();
          } catch (error) {
            setNotice(el.searchNotice, error.message);
            button.disabled = false;
          }
        });
      });
    } catch (error) {
      console.error("Could not load trade requests:", error);
    }
  }

  async function searchPlayers() {
    const query = el.search.value.trim();

    if (query.length < 2) {
      setNotice(el.searchNotice, "Enter at least two letters to search.");
      return;
    }

    el.searchBtn.disabled = true;
    el.searchBtn.textContent = "Searching…";

    try {
      const data = await api(`/player-search?q=${encodeURIComponent(query)}`);
      const players = data.players || [];

      el.results.innerHTML = players.length
        ? players.map(player => `
          <div class="tradePlayerResult">
            <div>
              <strong>${escapeHtml(player.name)}</strong>
              <span>Level ${Number(player.level)} ${escapeHtml(player.pclass || "")} · ${escapeHtml(player.location || "Unknown location")}</span>
            </div>
            <button class="btn primary" type="button" data-request-player="${Number(player.id)}">Request Trade</button>
          </div>
        `).join("")
        : `<div class="empty"><i>No travelers matched that name.</i></div>`;

      el.results.querySelectorAll("[data-request-player]").forEach(button => {
        button.addEventListener("click", () => sendTradeRequest(Number(button.dataset.requestPlayer), button));
      });

      setNotice(el.searchNotice);
    } catch (error) {
      setNotice(el.searchNotice, error.message);
    } finally {
      el.searchBtn.disabled = false;
      el.searchBtn.textContent = "Search";
    }
  }

  async function sendTradeRequest(playerId, button) {
    try {
      button.disabled = true;
      button.textContent = "Sending…";

      const data = await api("/request", {
        method: "POST",
        body: JSON.stringify({ playerId }),
      });

      setTrade(data.trade);
      closeModal(el.searchModal);
      showModal(el.windowModal);
      renderTrade();
    } catch (error) {
      setNotice(el.searchNotice, error.message);
      button.disabled = false;
      button.textContent = "Request Trade";
    }
  }

  async function refreshInventory() {
    if (!state.trade) return;

    const data = await api(`/${state.trade.id}/inventory`);
    state.inventory = data.items || [];
  }

  function renderTrade() {
    const trade = state.trade;
    if (!trade) return;

    const you = currentSide();
    const them = otherSide();
    const isActive = trade.status === "active";
    const bothConfirmed = Boolean(you.confirmed && them.confirmed);

    el.title.textContent = `${you.name} and ${them.name}`;
    el.status.textContent = trade.status === "requested"
      ? "Trade request sent. Waiting for the other traveler to accept."
      : trade.status === "active"
        ? "Any offer change resets both confirmations."
        : `This trade is ${trade.status}.`;

    el.pill.textContent = trade.status;
    el.pill.classList.toggle("is-active", isActive);

    el.yourName.textContent = `${you.name} — Your Offer`;
    el.otherName.textContent = `${them.name} — Their Offer`;

    el.yourState.textContent = you.accepted
      ? "Accepted"
      : you.confirmed
        ? "Confirmed"
        : "Editing";
    el.yourState.classList.toggle("is-confirmed", Boolean(you.confirmed));

    el.otherState.textContent = them.accepted
      ? "Accepted"
      : them.confirmed
        ? "Confirmed"
        : "Reviewing";
    el.otherState.classList.toggle("is-confirmed", Boolean(them.confirmed));

    el.otherGold.textContent = `${Number(them.gold || 0).toLocaleString()} gold`;

    const canEdit = isActive && !you.confirmed;
    el.gold.disabled = !canEdit;

    const selectedItems = [...state.selected.entries()]
      .map(([inventoryId, quantity]) => ({ item: inventoryItem(inventoryId), inventoryId, quantity }))
      .filter(entry => entry.item);

    el.offerCount.textContent = `${selectedItems.length} / 12`;
    el.yourItems.innerHTML = selectedItems.map(({ item, inventoryId, quantity }) => `
      <div class="tradeItemSlot tradeItemSlot--offered" ${tooltipAttrs(item, quantity)}
        data-offered-item="${Number(inventoryId)}" draggable="${canEdit}" tabindex="0" role="button"
        aria-label="${escapeHtml(item.item_name || "Item")}, ${Number(quantity)} offered. Double-click or press Delete to remove.">
        ${itemIconHtml(item)}
        <strong>${escapeHtml(item.item_name || "Unknown item")}</strong>
        <span class="tradeItemSlotQty">×${Number(quantity)}</span>
        ${canEdit ? `<button class="tradeSlotRemove" type="button" data-remove-offer="${Number(inventoryId)}" aria-label="Remove item">×</button>` : ""}
      </div>
    `).join("") + renderEmptySlots(12 - selectedItems.length, selectedItems.length);

    el.inventory.innerHTML = state.inventory.length ? state.inventory.map(item => {
      const id = Number(item.inventory_id);
      const selected = state.selected.has(id);
      const selectedQty = state.selected.get(id) || 1;
      const qty = Number(item.quantity || 1);
      return `
        <div class="tradeInventoryItem ${selected ? "is-in-offer" : ""}" ${tooltipAttrs(item, qty)}
          data-inventory-item="${id}" draggable="${canEdit && !selected}" tabindex="0" role="button"
          aria-label="${escapeHtml(item.item_name || "Item")}. ${selected ? "Currently offered." : "Double-click or press Enter to offer."}">
          ${itemIconHtml(item)}
          <div class="tradeInventoryItemText">
            <strong>${escapeHtml(item.item_name || "Unknown item")}</strong>
            <span>${qty} available${Number(item.is_unique) ? " · unique" : ""}${item.durability != null ? ` · durability ${Number(item.durability)}` : ""}</span>
          </div>
          ${selected ? `<div class="tradeItemControls"><input class="input tradeQtyInput" type="number" min="1" max="${qty}"
            value="${Math.min(selectedQty, qty)}" data-qty-input="${id}" ${!canEdit ? "disabled" : ""} /></div>`
            : `<span class="tradeInventoryHint">Offer item</span>`}
        </div>`;
    }).join("") : `<div class="empty"><i>No tradable items are currently available.</i></div>`;

    const theirItems = them.items || [];
    el.otherItems.innerHTML = theirItems.map(item => `
      <div class="tradeItemSlot tradeItemSlot--offered tradeItemSlot--readonly" ${tooltipAttrs(item, item.quantity)} tabindex="0">
        ${itemIconHtml(item)}
        <strong>${escapeHtml(item.item_name || "Unknown item")}</strong>
        <span class="tradeItemSlotQty">×${Number(item.quantity)}</span>
      </div>
    `).join("") + renderEmptySlots(12 - theirItems.length, theirItems.length);

    bindTradeItemInteractions(canEdit);

    el.inventory.querySelectorAll("[data-qty-input]").forEach(input => {
      input.addEventListener("input", () => {
        const inventoryId = Number(input.dataset.qtyInput);
        const max = Number(input.max);
        const quantity = Math.max(1, Math.min(max, Number(input.value) || 1));
        state.selected.set(inventoryId, quantity);
        const offered = el.yourItems.querySelector(`[data-offered-item="${inventoryId}"] .tradeItemSlotQty`);
        if (offered) offered.textContent = `×${quantity}`;
        markOfferChanged(300);
      });
    });

    el.confirm.disabled = !isActive || Boolean(you.confirmed);
    el.confirm.textContent = you.confirmed ? "Offer Confirmed" : "Confirm Offer";

    el.accept.disabled = !isActive || !bothConfirmed || Boolean(you.accepted);
    el.accept.textContent = you.accepted ? "Trade Accepted" : "Accept Trade";

    el.cancel.disabled = !["requested", "active"].includes(trade.status);
  }

  function bindTradeItemInteractions(canEdit) {
    el.inventory.querySelectorAll("[data-inventory-item]").forEach(card => {
      const id = Number(card.dataset.inventoryItem);
      card.addEventListener("dblclick", () => addToOffer(id));
      card.addEventListener("contextmenu", event => {
        event.preventDefault();
        state.selected.has(id) ? removeFromOffer(id) : addToOffer(id);
      });
      card.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          state.selected.has(id) ? removeFromOffer(id) : addToOffer(id);
        }
      });
      card.addEventListener("dragstart", event => {
        if (!canEdit || state.selected.has(id)) return event.preventDefault();
        event.dataTransfer.setData("application/x-guildforge-trade-item", JSON.stringify({ inventoryId: id }));
        event.dataTransfer.effectAllowed = "move";
      });
    });

    el.yourItems.querySelectorAll("[data-offered-item]").forEach(card => {
      const id = Number(card.dataset.offeredItem);
      card.addEventListener("dblclick", () => removeFromOffer(id));
      card.addEventListener("contextmenu", event => { event.preventDefault(); removeFromOffer(id); });
      card.addEventListener("keydown", event => {
        if (["Delete", "Backspace", "Enter", " "].includes(event.key)) {
          event.preventDefault();
          removeFromOffer(id);
        }
      });
      card.addEventListener("dragstart", event => {
        if (!canEdit) return event.preventDefault();
        event.dataTransfer.setData("application/x-guildforge-trade-item", JSON.stringify({ inventoryId: id }));
        event.dataTransfer.effectAllowed = "move";
      });
    });

    el.yourItems.querySelectorAll("[data-remove-offer]").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        removeFromOffer(Number(button.dataset.removeOffer));
      });
    });

    [el.yourItems, el.inventory].forEach(zone => {
      zone.ondragover = event => {
        if (!canEdit) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        zone.classList.add("is-drag-over");
      };
      zone.ondragleave = () => zone.classList.remove("is-drag-over");
      zone.ondrop = event => {
        event.preventDefault();
        zone.classList.remove("is-drag-over");
        try {
          const data = JSON.parse(event.dataTransfer.getData("application/x-guildforge-trade-item"));
          zone === el.yourItems ? addToOffer(data.inventoryId) : removeFromOffer(data.inventoryId);
        } catch (_) {}
      };
    });
  }

  async function tradeAction(action) {
    try {
      if (action === "confirm" && !(await flushOfferSave())) return;
      const data = await api(`/${state.trade.id}/${action}`, {
        method: "POST",
        body: "{}",
      });

      if (data.trade?.status === "completed") {
        finishTrade(data.trade.id);
        return;
      }

      setTrade(data.trade);
      await refreshInventory();
      renderTrade();
    } catch (error) {
      setNotice(el.windowNotice, error.message);
    }
  }

  async function cancelTrade() {
    if (!state.trade || state.cancellationInFlight) return;

    const tradeId = Number(state.trade.id);
    state.cancellationInFlight = true;

    try {
      await api(`/${tradeId}/cancel`, {
        method: "POST",
        body: "{}",
      });

      finishCancelledTrade(tradeId);
    } catch (error) {
      state.cancellationInFlight = false;

      // A socket notification may have already finalized this same trade.
      if (Number(state.lastCancelledTradeId) === tradeId || !state.trade) return;
      setNotice(el.windowNotice, error.message);
    }
  }

  async function refreshTrade() {
    if (!state.trade) return;

    try {
      const data = await api(`/${state.trade.id}`);
      setTrade(data.trade);
      await refreshInventory();
      renderTrade();

    } catch (error) {
      setNotice(el.windowNotice, error.message);
    }
  }

  function connectTradeSocket() {
    if (typeof window.io !== "function") {
      console.error("Trade socket client failed to load.");
      return;
    }

    state.socket = window.io();

    state.socket.on("connect", () => {
      // Reconcile anything that changed while this browser was disconnected.
      refreshRequests();
      if (state.trade) refreshTrade();

      // Subscribe this Tavern page to the live online-player roster.
      joinTavernPresence();
    });

    state.socket.on(
      "presence:changed",
      renderOnlinePlayers,
    );

    state.socket.on("trade:requests-changed", refreshRequests);
state.socket.on("trade:changed", event => {
  refreshRequests();

  // The completed trade row has already been deleted,
  // so close the window instead of trying to reload it.
  if (event?.status === "completed") {
    finishTrade(event.tradeId);
    return;
  }

  if (event?.status === "cancelled") {
    finishCancelledTrade(event.tradeId);
    return;
  }

  // The initiating browser already received the authoritative
  // result through its acknowledgement.
  if (event?.originSocketId === state.socket.id) {
    return;
  }

  if (
    state.trade &&
    Number(event?.tradeId) === Number(state.trade.id)
  ) {
    refreshTrade();
  }
});

    state.socket.on("trade:completed", event => {
      finishTrade(event?.tradeId);
    });

    state.socket.on("trade:cancelled", event => {
      finishCancelledTrade(event?.tradeId);
    });

    state.socket.on("connect_error", error => {
      console.error("Trade socket connection failed:", error.message);
    });
  }

  el.table?.addEventListener("click", () => {
    setNotice(el.searchNotice);
    showModal(el.searchModal);
    refreshRequests();
    el.search.focus();
  });

  el.searchBtn?.addEventListener("click", searchPlayers);
  el.search?.addEventListener("keydown", event => {
    if (event.key === "Enter") searchPlayers();
  });

  el.gold?.addEventListener("input", () => markOfferChanged(350));
  el.confirm?.addEventListener("click", () => tradeAction("confirm"));
  el.accept?.addEventListener("click", () => tradeAction("accept"));
  el.cancel?.addEventListener("click", cancelTrade);

  document.querySelectorAll("[data-close-trade-modal]").forEach(button => {
    button.addEventListener("click", () => {
      const modal = $(button.dataset.closeTradeModal);

      if (modal === el.windowModal && state.trade?.status === "active") {
        void cancelTrade();
        return;
      }

      closeModal(modal);
    });
  });

  window.addEventListener("pagehide", () => {
    if (
      state.unloadCancellationSent ||
      state.cancellationInFlight ||
      !state.trade ||
      !["requested", "active"].includes(String(state.trade.status))
    ) {
      return;
    }

    state.unloadCancellationSent = true;
    const tradeId = Number(state.trade.id);

    navigator.sendBeacon(
      `${API}/${tradeId}/cancel`,
      new Blob(["{}"], { type: "application/json" }),
    );
  });

  [el.searchModal, el.windowModal].forEach(modal => {
    modal?.addEventListener("click", event => {
      if (event.target === modal) closeModal(modal);
    });
  });

  refreshRequests();
  connectTradeSocket();
})();
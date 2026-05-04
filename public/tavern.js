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
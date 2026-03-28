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

  let currentRumorQuestId = null;

  // townId from querystring (fallback 1)
  window.TOWN_ID = null;


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
    });      const data = await res.json();

      if (!res.ok) throw new Error(data?.error || "rumor_error");

      // API shape: { ok: true, quest: null } or { ok: true, quest: {...} }
      const q = data?.quest ?? null;

      if (!q) {
        currentRumorQuestId = null;
        rumorHint.textContent = "Nothing new. The tavern’s quiet… for now.";
        rumorText.textContent =
          "No fresh rumors tonight. Check back after you’ve completed what’s available here.";
        btnAccept.disabled = true;
        return;
      }

      currentRumorQuestId = q.questId;

      rumorHint.textContent = q.title || "Rumor";
      rumorText.textContent =
        (q.dialogIntro || q.description || "A rumor passes through the crowd…") +
        (q.objectivePreview?.item?.name
          ? `\n\nObjective: Bring ${q.objectivePreview.required} × ${q.objectivePreview.item.name}`
          : "");

      btnAccept.disabled = false;
    } catch (e) {
      console.error("listenForRumors failed:", e);
      currentRumorQuestId = null;
      rumorHint.textContent = "The noise drowns you out.";
      rumorText.textContent = "Something went wrong while listening for rumors.";
      btnAccept.disabled = true;
    } finally {
      btnRumor.disabled = false;
      btnRumor.textContent = "Listen for Rumors";
    }
  }

  async function acceptRumorQuest() {
    if (!currentRumorQuestId) return;

    btnAccept.disabled = true;
    btnAccept.textContent = "Accepting…";

    try {
      const res = await fetch(`/api/quests/${currentRumorQuestId}/accept`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "accept_error");

      rumorHint.textContent = "Quest accepted.";
      rumorText.textContent = "It’s yours now. Check your Quest Log.";
    } catch (e) {
      console.error("acceptRumorQuest failed:", e);
      rumorHint.textContent = "Couldn’t accept.";
      rumorText.textContent = "That rumor slipped away. Try again.";
    } finally {
      btnAccept.textContent = "Accept Quest";
      // keep disabled until another rumor is rolled
    }
  }

  if (btnRumor) btnRumor.addEventListener("click", listenForRumors);
  if (btnAccept) btnAccept.addEventListener("click", acceptRumorQuest);

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
          isComplete: Number(r.quest_is_complete ?? r.is_complete ?? 0) === 1,
          objectives: [],
        });
      }

      map.get(pqid).objectives.push({
        type: r.objectiveType,
        required: Number(r.required_count || 1),
        progress: Number(r.progress_count || 0),
        done: Number(r.objective_is_complete ?? 0) === 1,
        itemName: r.item_name || null,
        have: Number(r.have_qty || 0),
        targetName:
          r.target_name ||
          r.creature_name ||
          r.location_name ||
          r.interact_name ||
          null,
      });
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
      return Math.min(o.have, o.required) + "/" + o.required;
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
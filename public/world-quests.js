    // QUEST LOG + TRACKER (WORLD)
  // Requires:
  // GET  /api/quests/log
  // GET  /api/quests/tracked
  // POST /api/quests/track { playerQuestId: number|null }

  const questModal = document.getElementById("questModal");
  const questList  = document.getElementById("questList");

  const btnQuestLog = document.getElementById("btnQuestLog");
  const btnQuestClose = document.getElementById("btnQuestClose");
  const btnQuestRefresh = document.getElementById("btnQuestRefresh");
  const btnQuestClearTrack = document.getElementById("btnQuestClearTrack");

  const questTracker = document.getElementById("questTracker");
  const qtTitle = document.getElementById("qtTitle");
  const qtBody  = document.getElementById("qtBody");

  function escapeHtml(s){
    return String(s ?? "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }
  // Tracker UX: minimize + ping
  const qtMinBtn = document.getElementById("qtMinBtn");
  if (qtMinBtn && questTracker) {
    qtMinBtn.addEventListener("click", () => {
      questTracker.classList.toggle("is-min");
      qtMinBtn.textContent = questTracker.classList.contains("is-min") ? "+" : "—";
    });
  }

  function openQuestModal(){
    questModal.classList.remove("hidden");
    refreshQuestLog();
  }
  function closeQuestModal(){
    questModal.classList.add("hidden");
  }

  if (btnQuestLog) btnQuestLog.addEventListener("click", openQuestModal);
  if (btnQuestClose) btnQuestClose.addEventListener("click", closeQuestModal);

  const backdrop = questModal ? questModal.querySelector(".qmodalBackdrop") : null;
  if (backdrop) backdrop.addEventListener("click", closeQuestModal);

  if (btnQuestRefresh) btnQuestRefresh.addEventListener("click", refreshQuestLog);

  if (btnQuestClearTrack) btnQuestClearTrack.addEventListener("click", async function(){
    await fetch("/api/quests/track", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ playerQuestId: null })
    });
    await refreshTrackedQuest();
    await refreshQuestLog();
  });

  function groupQuestLogRows(rows){
    const byPQ = new Map();
    for (const r of (rows || [])) {
      const id = Number(r.playerQuestId);
      if (!byPQ.has(id)) {
        byPQ.set(id, {
          playerQuestId: id,
          status: r.status,
          title: r.title,
          description: r.description ?? "",
          objectives: []
        });
      }
      byPQ.get(id).objectives.push({
        type: r.objectiveType,
        required: Number(r.required_count || 1),
        progress: Number(r.progress_count || 0),
        isComplete: Number(r.is_complete || 0) === 1,
        region: r.region_name || null,

        itemName: r.item_name || r.target_item_name || null,
        creatureName: r.creature_name || r.target_creature_name || null
      });

    }
    return Array.from(byPQ.values());
  }

  function objectiveLine(o){
    const cur = String(Math.min(o.progress, o.required));
    const req = String(o.required);

    if (o.type === "TURN_IN") {
      const name = o.itemName || "Item";
      return "Collect " + name + " " + cur + "/" + req;
    }

    if (o.type === "KILL") {
      const name = o.creatureName || "Creature";
      return "Kill " + name + " " + cur + "/" + req;
    }

    return String(o.type) + " " + cur + "/" + req;
  }


  async function refreshQuestLog(){
    let rows = [];
    try{
      const res = await fetch("/api/quests/log");
      rows = await res.json();
    } catch (e) {
      questList.innerHTML = '<div class="qrow"><div><div class="qrowTitle">Error</div><div class="qrowDesc">Could not load quest log.</div></div></div>';
      return;
    }

    const quests = groupQuestLogRows(rows);
    // Remove claimed quests from world modal
    const filtered = quests.filter(q => q.status !== "claimed");

    const tracked = await fetch("/api/quests/tracked")
      .then(r => r.json())
      .catch(() => ({}));

    const trackedId = tracked && tracked.trackedId ? Number(tracked.trackedId) : null;

    questList.innerHTML = "";

    // active first
    filtered.sort(function(a,b){
      const aa = a.status === "active" ? 0 : 1;
      const bb = b.status === "active" ? 0 : 1;
      return aa - bb;
    });

    if (filtered.length === 0) {
      questList.innerHTML = '<div class="qrow"><div><div class="qrowTitle">No Quests</div><div class="qrowDesc">You have no quests in your log yet.</div></div></div>';
      return;
    }

    for (const q of filtered) {
      const isActive = ["active","accepted","in_progress"].includes(String(q.status || "").toLowerCase());
      const isTracked = trackedId && q.playerQuestId === trackedId;

      const objText = (q.objectives || []).map(function(o){
        return "• " + objectiveLine(o);
      }).join("\n");


      const el = document.createElement("div");
      el.className = "qrow";

      // IMPORTANT: no backticks here
      el.innerHTML =
        '<div>' +
          '<div class="qrowTitle">' + escapeHtml(q.title || "Quest") + '</div>' +
          '<div class="qrowDesc">' + escapeHtml(q.description || "") + '</div>' +
          '<div class="qrowMeta">' + escapeHtml(objText) + '</div>' +
        '</div>' +
        '<div class="qrowBtns">' +
          '<span class="qtag ' + (isActive ? "active" : "") + '">' + escapeHtml(q.status) + '</span>' +
          '<button class="qbtn" ' + (!isActive ? "disabled" : "") + ' data-track="' + String(q.playerQuestId) + '">' +
            (isTracked ? "Tracking" : "Track") +
          '</button>' +
        '</div>';

      const btn = el.querySelector("button[data-track]");
      if (btn) {
        btn.addEventListener("click", async function(){
          if (!isActive) return;

          await fetch("/api/quests/track", {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ playerQuestId: q.playerQuestId })
          });

          await refreshTrackedQuest();
          await refreshQuestLog();
          closeQuestModal();
        });
      }

      questList.appendChild(el);
    }
  }

  async function refreshTrackedQuest(){
    const data = await fetch("/api/quests/tracked").then(r => r.json()).catch(() => null);

    if (!data || !data.trackedId) {
      questTracker.classList.add("hidden");
      return;
    }

    const grouped = groupQuestLogRows(data.rows || []);
    const q = grouped[0];

    qtTitle.textContent = q && q.title ? ("Tracking: " + q.title) : "Tracking";

    const lines = (q && q.objectives ? q.objectives : []).map(function(o){
      const done = o.isComplete ? "✅" : "⬜";
      const hint = o.region ? (" — Region: " + o.region) : "";
      return done + " " + objectiveLine(o) + hint;
    });

    qtBody.textContent = lines.join("\n");
    questTracker.classList.remove("hidden");
    // ping on update
    questTracker.classList.remove("ping");
    void questTracker.offsetWidth; // restart animation
    questTracker.classList.add("ping");

  }

  // Initial load
  refreshTrackedQuest();


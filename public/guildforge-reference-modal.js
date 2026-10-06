(() => {
  if (window.GFReferenceModal) return;

  const state = {
    type: null,
    root: null,
    creatures: [],
    codexFilter: "all",
    selectedCreatureId: null,
    journalGroups: null,
    journalFilter: "active",
    selectedQuestKey: null,
    professions: [],
    professionFilter: "all",
    selectedProfessionId: null
  };

  const esc = (v) => String(v ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");

  function ensureRoot() {
    let root = document.getElementById("gf-reference-modal-root");
    if (root) return root;
    root = document.createElement("div");
    root.id = "gf-reference-modal-root";
    root.className = "gf-reference-modal-root";
    root.innerHTML = `
      <div class="gf-reference-modal__backdrop" data-gf-reference-close></div>
      <div class="gf-reference-modal" role="dialog" aria-modal="true">
        <div id="gf-reference-modal-content"></div>
      </div>`;
    document.body.appendChild(root);
    root.addEventListener("click", e => {
      if (e.target.closest("[data-gf-reference-close]")) close();
    });
    state.root = root;
    return root;
  }

  function close() {
    const root = ensureRoot();
    root.classList.remove("is-open");
    document.body.classList.remove("gf-reference-modal-lock");
    state.type = null;
  }

  async function open(type) {
    if (!["codex","journal","professions"].includes(type)) return;
    const root = ensureRoot();
    const content = root.querySelector("#gf-reference-modal-content");
    state.type = type;
    content.innerHTML = `<div class="gf-reference-status" style="padding:32px">Opening records…</div>`;
    root.classList.add("is-open");
    document.body.classList.add("gf-reference-modal-lock");

    try {
      if (type === "professions") {
        content.innerHTML = professionsMarkup();
        await initProfessions();
      } else {
        const res = await fetch(
          type === "codex" ? "/ui/codex-modal" : "/ui/journal-modal",
          { credentials:"include" }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        content.innerHTML = await res.text();
        if (type === "codex") await initCodex();
        else await initJournal();
      }
    } catch (err) {
      console.error(err);
      content.innerHTML = `<div class="gf-reference-status" style="padding:32px">Unable to open these records.</div>`;
    }
  }

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && ensureRoot().classList.contains("is-open")) close();
  });

  // Turn existing /codex and /journal navigation into modal launchers.
  document.addEventListener("click", e => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    const url = new URL(a.href, window.location.origin);
    if (url.origin !== window.location.origin) return;
    if (url.pathname === "/codex") {
      e.preventDefault(); open("codex");
    } else if (url.pathname === "/journal") {
      e.preventDefault(); open("journal");
    } else if (url.pathname === "/professions" || url.pathname === "/professions.html") {
      e.preventDefault(); open("professions");
    }
  });

  function stateLabel(s) {
    return ({unknown:"Locked",seen:"Seen",killed:"Killed",studied:"Studied",mastered:"Mastered"})[s] || "Unknown";
  }

  async function initCodex() {
    state.codexFilter = "all";
    const status = document.getElementById("codex-status");
    const res = await fetch("/api/codex", {credentials:"include"});
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Codex failed");
    state.creatures = Array.isArray(data.creatures) ? data.creatures : [];
    if (status) status.hidden = true;

    document.querySelectorAll("#codex-filters [data-filter]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#codex-filters [data-filter]").forEach(x => x.classList.remove("is-active"));
        btn.classList.add("is-active");
        state.codexFilter = btn.dataset.filter || "all";
            renderCodexList();
      });
    });
    renderCodexList();
  }

  function filteredCreatures() {
    return state.creatures.filter(c => {
      const f = state.codexFilter;
      if (f === "all") return true;
      if (f === "unknown") return c.state === "unknown";
      if (f === "seen") return c.state === "seen";
      if (f === "killed") return Number(c.progress?.killCount || 0) > 0;
      if (f === "studied") return c.state === "studied" || c.state === "mastered";
      if (f === "mastered") return c.state === "mastered";
      return true;
    });
  }

  function renderCodexList() {
    const list = document.getElementById("codex-creature-list");
    if (!list) return;
    const items = filteredCreatures();

    list.innerHTML = items.length ? items.map(c => {
      const unknown = c.state === "unknown";
      return `<button class="gf-reference-row ${unknown ? "is-locked" : ""} ${Number(c.id)===Number(state.selectedCreatureId)?"is-active":""}" data-creature-id="${c.id}">
        <div class="gf-reference-thumb">${unknown ? "?" : `<img src="${esc(c.image || "/images/defaults/creature.webp")}" alt="">`}</div>
        <div class="gf-reference-row__content">
          <div class="gf-reference-row__top"><span class="gf-reference-row__title">${esc(c.name)}</span><span class="gf-reference-row__badge">${esc(stateLabel(c.state))}</span></div>
          <div class="gf-reference-row__sub">${esc(c.archetype?.name || "Unknown")} · ${Number(c.progress?.killCount || 0)} kills</div>
        </div>
      </button>`;
    }).join("") : `<div class="gf-reference-status">No creature records match this filter.</div>`;

    list.querySelectorAll("[data-creature-id]").forEach(btn => btn.addEventListener("click", () => {
      state.selectedCreatureId = Number(btn.dataset.creatureId);
      renderCodexList();
      renderCreatureDetail(state.creatures.find(c => Number(c.id) === state.selectedCreatureId));
    }));

    if (items.length && !items.some(c => Number(c.id) === Number(state.selectedCreatureId))) {
      state.selectedCreatureId = Number(items[0].id);
      renderCreatureDetail(items[0]);
      renderCodexListActiveOnly();
    } else if (!items.length) {
      renderCreatureDetail(null);
    }
  }

  function renderCodexListActiveOnly(){
    document.querySelectorAll("[data-creature-id]").forEach(btn => btn.classList.toggle("is-active",Number(btn.dataset.creatureId)===Number(state.selectedCreatureId)));
  }

  function facts(obj) {
    return Object.entries(obj).map(([k,v])=>`<div class="gf-reference-fact"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join("");
  }

  function renderCreatureDetail(c) {
    const el = document.getElementById("codex-detail");
    if (!el) return;
    if (!c) { el.innerHTML=`<div class="gf-reference-empty"><div class="gf-reference-empty__sigil">☉</div><div>No creature selected.</div></div>`; return; }
    const unknown = c.state === "unknown";
    const stats = c.stats ? facts({HP:c.stats.maxhp,Attack:c.stats.attack,Defense:c.stats.defense,Agility:c.stats.agility}) : `<p class="gf-reference-copy">Defeat this creature to unlock its combat records.</p>`;
    const milestones = (c.milestones||[]).map(m=>`<div class="gf-reference-milestone ${m.complete?"is-complete":""}">
      <div class="gf-reference-milestone__copy"><strong>${esc(m.label)}</strong><span>${esc(m.reward||"")}</span></div>
      <div class="gf-reference-milestone__right"><span>${Math.min(Number(m.current||0),Number(m.required||1))}/${Number(m.required||1)}</span>
      ${m.claimable?`<button class="gf-reference-btn gf-reference-btn--primary" data-claim="${esc(m.key)}">Claim</button>`:m.claimed?`<span>Claimed</span>`:""}</div>
    </div>`).join("");
    const variants = (c.variants||[]).length ? (c.variants||[]).map(v=>`<div class="gf-reference-variant"><strong>${esc(v.name)}</strong><small>${esc(v.rarity)} · ${Number(v.seenCount||0)} seen / ${Number(v.killCount||0)} killed</small></div>`).join("") : `<p class="gf-reference-copy">${unknown?"Variants remain unknown.":"No variants encountered yet."}</p>`;

    el.innerHTML=`<article class="gf-reference-card">
      <header class="gf-reference-card__head"><div><div class="gf-reference-card__kicker">${esc(c.archetype?.name||"Unknown Family")}</div><h3 class="gf-reference-card__title">${esc(c.name)}</h3></div><span class="gf-reference-pill">${esc(stateLabel(c.state))}</span></header>
      <section class="gf-reference-section gf-reference-creature-hero">
        <div class="gf-reference-portrait">${unknown?"?":`<img src="${esc(c.image||"/images/defaults/creature.webp")}" alt="">`}</div>
        <div class="gf-reference-facts">${facts({Level:c.level??"Unknown",Terrain:c.terrain||"Unknown",Seen:Number(c.progress?.seenCount||0),Kills:Number(c.progress?.killCount||0)})}</div>
      </section>
      <section class="gf-reference-section"><div class="gf-reference-section-title">Codex Entry</div><p class="gf-reference-copy">${esc(c.description)}</p></section>
      <section class="gf-reference-section"><div class="gf-reference-section-title">Combat Records</div><div class="gf-reference-facts">${stats}</div></section>
      <section class="gf-reference-section"><div class="gf-reference-section-title">Mastery</div>${milestones}</section>
      <section class="gf-reference-section"><div class="gf-reference-section-title">Variants Encountered</div><div class="gf-reference-grid">${variants}</div></section>
    </article>`;

    el.querySelectorAll("[data-claim]").forEach(btn=>btn.addEventListener("click",()=>claimCodex(c.id,btn.dataset.claim)));
  }

  async function claimCodex(creatureId,milestoneKey){
    const res=await fetch("/api/codex/claim",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({creatureId,milestoneKey})});
    const data=await res.json();
    if(!res.ok||data.error){ window.GFToast?.show?.("Claim Failed",data.error||"Unable to claim reward",{type:"error"}); return; }
    window.GFToast?.show?.("Bestiary Reward",`Claimed ${data.rewardExp} EXP!`,{type:"success"});
    await initCodex();
    state.selectedCreatureId=Number(creatureId);
    renderCodexList();
    renderCreatureDetail(state.creatures.find(c=>Number(c.id)===Number(creatureId)));
  }

  async function initJournal(){
    state.journalFilter="active";
    const res=await fetch("/api/journal/quests",{credentials:"include"});
    const data=await res.json();
    if(!res.ok||data.error) throw new Error(data.error||"Journal failed");
    state.journalGroups=normalizeJournal(data);
    document.getElementById("journal-status")?.setAttribute("hidden","true");
    document.querySelectorAll("#journal-filters [data-filter]").forEach(btn=>btn.addEventListener("click",()=>{
      document.querySelectorAll("#journal-filters [data-filter]").forEach(x=>x.classList.remove("is-active"));
      btn.classList.add("is-active"); state.journalFilter=btn.dataset.filter||"all"; renderJournalList();
    }));
    renderJournalList();
  }

  function groupAccepted(rows,status){
    const map=new Map();
    (rows||[]).forEach(r=>{
      const id=Number(r.playerQuestId);
      if(!map.has(id)) map.set(id,{key:`pq:${id}`,kind:"accepted",status,playerQuestId:id,questId:Number(r.questId),type:r.type,title:r.title,description:r.description,dialog_intro:r.dialog_intro,dialog_complete:r.dialog_complete,turn_in_location_name:r.turn_in_location_name,reward_gold:Number(r.reward_gold||0),reward_xp:Number(r.reward_xp||0),objectives:[]});
      map.get(id).objectives.push({objectiveType:r.objectiveType,required_count:Number(r.required_count||1),progress_count:Number(r.progress_count||0),is_complete:Number(r.is_complete||0),region_name:r.region_name});
    });
    return [...map.values()];
  }

  function normalizeJournal(p){
    return {
      active:groupAccepted(p.active,"active"),
      completed:groupAccepted(p.completed,"completed"),
      claimed:groupAccepted(p.claimed,"claimed"),
      rumors:(p.rumors||[]).map(r=>({key:`q:${Number(r.questId)}`,kind:"rumor",status:"rumor",questId:Number(r.questId),title:r.title,description:r.description,rumor_hint:r.rumor_hint,min_level:Number(r.min_level||1),is_locked:Number(r.is_locked||0),town_name:r.town_name,turn_in_location_name:r.turn_in_location_name}))
    };
  }

  function journalVisible(){
    if(!state.journalGroups) return [];
    if(state.journalFilter==="all") return [...state.journalGroups.active,...state.journalGroups.completed,...state.journalGroups.claimed,...state.journalGroups.rumors];
    return state.journalGroups[state.journalFilter]||[];
  }

  function renderJournalList(){
    const el=document.getElementById("quest-list"); if(!el)return;
    const items=journalVisible();
    if(!items.length){el.innerHTML=`<div class="gf-reference-status">No quest records in this category.</div>`;renderQuestDetail(null);return;}
    if(!items.some(x=>x.key===state.selectedQuestKey)) state.selectedQuestKey=items[0].key;
    el.innerHTML=items.map(q=>{
      const done=q.kind==="accepted"?(q.objectives||[]).filter(o=>Number(o.is_complete)===1).length:0;
      const badge=q.kind==="rumor"?(q.is_locked?"Locked":"Rumor"):q.status;
      return `<button class="gf-reference-row ${q.is_locked?"is-locked":""} ${q.key===state.selectedQuestKey?"is-active":""}" data-quest-key="${esc(q.key)}">
        <div class="gf-reference-row__content" style="grid-column:1/-1"><div class="gf-reference-row__top"><span class="gf-reference-row__title">${esc(q.title)}</span><span class="gf-reference-row__badge">${esc(badge)}</span></div>
        <div class="gf-reference-row__sub">${q.kind==="rumor"?(q.town_name?`Heard in ${esc(q.town_name)}`:"Origin unknown"):(q.type==="bounty"?"Bounty Contract":"Quest Contract")}</div>
        ${q.kind==="accepted"?`<div class="gf-reference-row__meta">${done}/${q.objectives.length} objectives</div>`:""}</div>
      </button>`;
    }).join("");
    el.querySelectorAll("[data-quest-key]").forEach(btn=>btn.addEventListener("click",()=>{state.selectedQuestKey=btn.dataset.questKey;renderJournalList();}));
    renderQuestDetail(items.find(x=>x.key===state.selectedQuestKey));
  }

  function objectiveLabel(o){
    if(o.objectiveType==="KILL") return `Defeat targets${o.region_name?` in ${o.region_name}`:""}`;
    if(o.objectiveType==="TURN_IN") return "Deliver required items";
    if(o.objectiveType==="INTERACT") return "Interact with the required target";
    if(o.objectiveType==="LOCATION"||o.objectiveType==="ENTER_AREA") return `Reach the required location${o.region_name?` in ${o.region_name}`:""}`;
    if(o.objectiveType==="DESTROY_OBJECT") return "Destroy the required object";
    return "Complete objective";
  }

  function renderQuestDetail(q){
    const el=document.getElementById("quest-detail"); if(!el)return;
    if(!q){el.innerHTML=`<div class="gf-reference-empty"><div class="gf-reference-empty__sigil">☉</div><div>No quest selected.</div></div>`;return;}
    if(q.kind==="rumor"){
      el.innerHTML=`<article class="gf-reference-card"><header class="gf-reference-card__head"><div><div class="gf-reference-card__kicker">${q.is_locked?"Locked Rumor":"Rumor"}</div><h3 class="gf-reference-card__title">${esc(q.title)}</h3></div><span class="gf-reference-pill">${q.is_locked?`Level ${q.min_level}`:"Unaccepted"}</span></header>
      ${q.description?`<section class="gf-reference-section"><div class="gf-reference-section-title">Summary</div><p class="gf-reference-copy">${esc(q.description)}</p></section>`:""}
      <section class="gf-reference-section"><div class="gf-reference-section-title">Lead</div><div class="gf-reference-quote">${esc(q.rumor_hint||"No hint has been recorded.")}</div></section>
      ${q.town_name?`<section class="gf-reference-section"><div class="gf-reference-two"><div class="gf-reference-info"><span>Origin</span><strong>${esc(q.town_name)}</strong></div><div class="gf-reference-info"><span>Likely Turn-In</span><strong>${esc(q.turn_in_location_name||"Unknown")}</strong></div></div></section>`:""}
      </article>`; return;
    }
    const objectives=(q.objectives||[]).map(o=>{
      const req=Math.max(1,Number(o.required_count||1)), prog=Number(o.progress_count||0), pct=Math.max(0,Math.min(100,Math.round(prog/req*100)));
      return `<div class="gf-reference-objective"><div class="gf-reference-objective__top"><span>${esc(objectiveLabel(o))}</span><span class="gf-reference-objective__count">${prog}/${req}</span></div><div class="gf-reference-progress"><div style="width:${pct}%"></div></div></div>`;
    }).join("");
    el.innerHTML=`<article class="gf-reference-card"><header class="gf-reference-card__head"><div><div class="gf-reference-card__kicker">${q.type==="bounty"?"Bounty Contract":"Quest Contract"}</div><h3 class="gf-reference-card__title">${esc(q.title)}</h3></div><span class="gf-reference-pill">${esc(q.status)}</span></header>
      ${q.description?`<section class="gf-reference-section"><div class="gf-reference-section-title">Summary</div><p class="gf-reference-copy">${esc(q.description)}</p></section>`:""}
      ${q.dialog_intro&&q.status==="active"?`<section class="gf-reference-section"><div class="gf-reference-section-title">Contract</div><div class="gf-reference-quote">${esc(q.dialog_intro)}</div></section>`:""}
      <section class="gf-reference-section"><div class="gf-reference-section-title">Objectives</div>${objectives||`<p class="gf-reference-copy">No objectives recorded.</p>`}</section>
      <section class="gf-reference-section"><div class="gf-reference-two"><div class="gf-reference-info"><span>Rewards</span><strong>${q.reward_gold}g · ${q.reward_xp} XP</strong></div><div class="gf-reference-info"><span>Turn In</span><strong>${esc(q.turn_in_location_name||"Unknown location")}</strong></div></div></section>
      ${q.dialog_complete&&q.status!=="active"?`<section class="gf-reference-section"><div class="gf-reference-section-title">Completion</div><div class="gf-reference-quote">${esc(q.dialog_complete)}</div></section>`:""}
      ${q.status==="active"?`<section class="gf-reference-section"><button class="gf-reference-btn gf-reference-btn--primary" id="gf-track-quest">Track Quest</button></section>`:""}
      ${q.status==="claimed"?`<section class="gf-reference-section"><p class="gf-reference-copy">Rewards claimed. This contract is complete.</p></section>`:""}
    </article>`;
    document.getElementById("gf-track-quest")?.addEventListener("click",()=>trackQuest(q));
  }

  async function trackQuest(q){
    const res=await fetch("/api/quests/track",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify({playerQuestId:q.playerQuestId,mode:"track"})});
    if(res.ok) window.GFToast?.show?.("Quest Tracked",`"${q.title}" is now being tracked.`,{type:"success",durationMs:2200});
    else window.GFToast?.show?.("Unable to Track","The quest could not be tracked.",{type:"error",durationMs:2200});
  }


  function professionsMarkup() {
    return `
      <header class="gf-reference-modal__header">
        <div>
          <div class="gf-reference-modal__kicker">Craft & Trade</div>
          <h2 class="gf-reference-modal__title">Professions</h2>
          <div class="gf-reference-modal__subtitle">Your gathering knowledge, tools, and mastery.</div>
        </div>
        <button class="gf-reference-modal__close" type="button" data-gf-reference-close aria-label="Close">×</button>
      </header>
      <div class="gf-professions-deprecation">
        <div class="gf-professions-deprecation__icon">⚠</div>
        <div>
          <div class="gf-professions-deprecation__title">Profession System Rework Coming Soon</div>
          <div class="gf-professions-deprecation__text">
            The current profession system will soon be deprecated and replaced by
            <strong>Professions 2.0</strong>. The new system is being designed to provide
            a deeper, more rewarding gathering and crafting experience with improved
            progression, specialization, and meaningful material choices.
          </div>
        </div>
      </div>

      <div class="gf-reference-layout">
        <aside class="gf-reference-sidebar">
          <div class="gf-reference-filters" id="professions-filters">
            <button class="gf-reference-chip is-active" type="button" data-filter="all">All</button>
            <button class="gf-reference-chip" type="button" data-filter="gathering">Gathering</button>
            <button class="gf-reference-chip" type="button" data-filter="crafting">Crafting</button>
          </div>
          <div class="gf-reference-status" id="professions-status">Loading…</div>
          <div class="gf-reference-list" id="profession-list"></div>
        </aside>
        <section class="gf-reference-detail">
          <div class="gf-reference-detail__inner" id="profession-detail">
            <div class="gf-reference-empty">
              <div class="gf-reference-empty__sigil">⚒</div>
              <div>Choose a profession from the left.</div>
            </div>
          </div>
        </section>
      </div>`;
  }

  function professionIcon(name) {
    const n=String(name||"").toLowerCase();
    if(n==="mining") return "⛏️";
    if(n==="herbalism") return "🌿";
    if(n==="woodcutting") return "🪓";
    return "⚒";
  }

  function professionIconPath(icon) {
    if(!icon) return "/images/default_item.png";
    if(String(icon).startsWith("/")) return icon;
    return `/images/items/${icon}`;
  }

  function professionXpNeeded(level) {
    level=Number(level||1);
    return Math.floor(50 + level*level*25);
  }

  function filteredProfessions() {
    if(state.professionFilter==="all") return state.professions;
    return state.professions.filter(p =>
      String(p.type||"").toLowerCase()===state.professionFilter
    );
  }

  async function initProfessions() {
    state.professionFilter="all";
    const res=await fetch("/api/professions/summary",{
      credentials:"include",
      cache:"no-store"
    });
    const text=await res.text();
    if(!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0,200)}`);
    const payload=JSON.parse(text);
    state.professions=Array.isArray(payload.professions)?payload.professions:[];

    if(!state.selectedProfessionId && state.professions.length) {
      state.selectedProfessionId=Number(state.professions[0].id);
    }

    const status=document.getElementById("professions-status");
    if(status) status.hidden=true;

    document.querySelectorAll("#professions-filters [data-filter]").forEach(btn=>{
      btn.addEventListener("click",()=>{
        document.querySelectorAll("#professions-filters [data-filter]").forEach(x=>x.classList.remove("is-active"));
        btn.classList.add("is-active");
        state.professionFilter=btn.dataset.filter||"all";
        const visible=filteredProfessions();
        if(!visible.some(p=>Number(p.id)===Number(state.selectedProfessionId))) {
          state.selectedProfessionId=visible.length?Number(visible[0].id):null;
        }
        renderProfessionList();
        renderProfessionDetail();
      });
    });

    renderProfessionList();
    renderProfessionDetail();
  }

  function renderProfessionList() {
    const list=document.getElementById("profession-list");
    if(!list) return;
    const items=filteredProfessions();

    if(!items.length) {
      list.innerHTML=`<div class="gf-reference-copy" style="padding:10px">No professions found.</div>`;
      return;
    }

    list.innerHTML=items.map(p=>{
      const active=Number(p.id)===Number(state.selectedProfessionId);
      const level=Number(p.level||1);
      const xp=Number(p.experience||0);
      const need=Number(p.xpNeeded||professionXpNeeded(level));
      const pct=Math.max(0,Math.min(100,Math.round(xp/Math.max(1,need)*100)));
      return `<button class="gf-reference-row ${active?"is-active":""}" type="button" data-profession-id="${Number(p.id)}">
        <div class="gf-profession-row-top">
          <div class="gf-reference-row__title"><span class="gf-profession-icon">${professionIcon(p.name)}</span>${esc(p.name)}</div>
          <span class="gf-profession-level">Lv ${level}</span>
        </div>
        <div class="gf-reference-row__sub"><span>${esc(p.type||"Profession")}</span><span>${p.isSpecialized?"Specialized":"Unspecialized"}</span></div>
        <div class="gf-reference-row__meta">${xp} / ${need} XP</div>
        <div class="gf-profession-xpbar"><div class="gf-profession-xpbar__fill" style="width:${pct}%"></div></div>
      </button>`;
    }).join("");

    list.querySelectorAll("[data-profession-id]").forEach(btn=>{
      btn.addEventListener("click",()=>{
        state.selectedProfessionId=Number(btn.dataset.professionId);
        renderProfessionList();
        renderProfessionDetail();
        const detail=document.querySelector(".gf-reference-detail");
        if(detail) detail.scrollTop=0;
      });
    });
  }

  function renderProfessionDetail() {
    const el=document.getElementById("profession-detail");
    if(!el) return;
    const selected=state.professions.find(p=>Number(p.id)===Number(state.selectedProfessionId))
      || filteredProfessions()[0];

    if(!selected) {
      el.innerHTML=`<div class="gf-reference-empty"><div class="gf-reference-empty__sigil">⚒</div><div>No profession matches this filter.</div></div>`;
      return;
    }

    state.selectedProfessionId=Number(selected.id);
    const level=Number(selected.level||1);
    const xp=Number(selected.experience||0);
    const need=Number(selected.xpNeeded||professionXpNeeded(level));
    const pct=Math.max(0,Math.min(100,Math.round(xp/Math.max(1,need)*100)));
    const tool=selected.tool||null;
    const nodes=Array.isArray(selected.nodes)?selected.nodes:[];

    el.innerHTML=`<article class="gf-reference-card">
      <header class="gf-reference-card__head">
        <div><div class="gf-reference-card__kicker">${esc(selected.type||"Profession")}</div><h3 class="gf-reference-card__title">${professionIcon(selected.name)} ${esc(selected.name)}</h3></div>
        <span class="gf-reference-pill">Level ${level}</span>
      </header>
      <section class="gf-reference-section">
        <div class="gf-reference-section-title">Progress</div>
        <div class="gf-reference-info">
          <div class="gf-profession-inline"><span>Experience</span><strong>${xp} / ${need}</strong></div>
          <div class="gf-profession-xpbar gf-profession-xpbar--large"><div class="gf-profession-xpbar__fill" style="width:${pct}%"></div></div>
        </div>
      </section>
      <section class="gf-reference-section">
        <div class="gf-reference-section-title">Equipped Tool</div>
        ${tool?`<div class="gf-reference-info gf-profession-tool"><img class="gf-profession-tool__icon" src="${esc(professionIconPath(tool.icon))}" alt=""><div><strong>${esc(tool.name)}</strong><div class="gf-reference-copy">${esc(tool.item_type||"Tool")}</div></div></div>`:`<div class="gf-reference-info gf-reference-copy">No tool equipped.</div>`}
      </section>
      <section class="gf-reference-section">
        <div class="gf-reference-section-title">Known Nodes</div>
        <div class="gf-profession-node-list">${nodes.length?nodes.map(n=>`<div class="gf-reference-info"><div class="gf-profession-node-top"><strong>${esc(n.name)}</strong><span class="gf-profession-level">${esc(n.rarity||"common")}</span></div><div class="gf-reference-copy">Required Level: ${esc(n.requiredLevel??n.required_level??1)}${n.baseXp||n.base_xp?` • ${esc(n.baseXp??n.base_xp)} XP`:""}</div></div>`).join(""):`<div class="gf-reference-info gf-reference-copy">No known nodes yet.</div>`}</div>
      </section>
      <section class="gf-reference-section">
        <div class="gf-reference-section-title">Specialization</div>
        <div class="gf-reference-info gf-reference-copy">${selected.isSpecialized?`You are specialized in ${esc(selected.name)}.`:"Specialization is not selected yet."}</div>
      </section>
    </article>`;
  }

  window.GFReferenceModal={open,close};
})();
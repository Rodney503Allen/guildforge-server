// public/hunt-combat.js

let huntCombatSocket = null;
let activeHuntEncounterId = null;

let huntCombatPlayerId = null;
let huntCombatSpells = [];
let huntCombatCasting = false;
let huntCombatPotions = { health: null, mana: null };
let huntPotionCooldownEnds = { health: 0, mana: 0 };
let huntPotionCooldownTimer = null;

let huntPendingSpellTarget = null;

let huntCombatState =
  null;


// =======================================
// SMOOTH HUNT COMBAT TIMERS
// =======================================
//
// Hunt combat remains server-authoritative.
// Socket snapshots provide timing anchors;
// requestAnimationFrame fills the bars
// smoothly between those snapshots.

let huntCombatTimingFrame =
  null;

let huntCombatTimingRunning =
  false;

const huntCombatTiming = {
  enemy: null,
  players: new Map()
};

let huntEnemyCastAnchor = null;
let lastHuntEnemyCastAlertToken = null;

function playHuntEnemyAlertSound() {
  const alertSound = new Audio(
    "/sounds/ui/enemy_alert.ogg"
  );
  alertSound.volume = 0.75;
  alertSound.play().catch(() => {});
}

function hideHuntEnemyCastWarning() {
  huntEnemyCastAnchor = null;
  document
    .getElementById("huntEnemyCastWarning")
    ?.classList.add("hidden");
}

function syncHuntEnemyCastWarning(encounter) {
  const mechanicState =
    encounter?.enemy?.mechanic;
  const cast = mechanicState?.activeCast;

  if (!cast) {
    hideHuntEnemyCastWarning();
    return;
  }

  const warning = document.getElementById(
    "huntEnemyCastWarning"
  );
  if (!warning) return;

  const sequence =
    Number(mechanicState.sequence ?? 0) || 0;
  const alertToken =
    `${encounter.encounterId}:${sequence}:` +
    `${cast.mechanicKey || cast.name}`;
  const totalMs = Math.max(
    1,
    Number(cast.totalMs) || 1
  );
  const remainingMs = Math.max(
    0,
    Math.min(
      totalMs,
      Number(cast.remainingMs) || 0
    )
  );

  huntEnemyCastAnchor = {
    token: alertToken,
    receivedAt: performance.now(),
    totalMs,
    remainingMs
  };

  setHuntText(
    "huntEnemyCastName",
    cast.name || "Incoming Attack"
  );

  const targetIds = Array.isArray(
    cast.targetPlayerIds
  )
    ? cast.targetPlayerIds.map(Number)
    : [];
  const targetNames = (encounter.players || [])
    .filter(player =>
      targetIds.includes(Number(player.playerId))
    )
    .map(player => player.name);

  setHuntText(
    "huntEnemyCastTargets",
    targetNames.length > 1
      ? `Targets: ${targetNames.join(", ")}`
      : targetNames.length === 1
        ? `Target: ${targetNames[0]}`
        : "Prepare to react"
  );

  const interruptLabel = document.getElementById(
    "huntEnemyCastInterrupt"
  );
  if (interruptLabel) {
    interruptLabel.textContent = cast.interruptible
      ? "Interruptible"
      : "Cannot Be Interrupted";
    interruptLabel.classList.toggle(
      "is-interruptible",
      Boolean(cast.interruptible)
    );
  }

  warning.classList.remove("hidden");

  if (lastHuntEnemyCastAlertToken !== alertToken) {
    lastHuntEnemyCastAlertToken = alertToken;
    warning.classList.remove("is-alerting");
    void warning.offsetWidth;
    warning.classList.add("is-alerting");
    playHuntEnemyAlertSound();
  }
}

function renderSmoothHuntEnemyCast(now) {
  if (!huntEnemyCastAnchor) return;

  const elapsedMs = Math.max(
    0,
    now - huntEnemyCastAnchor.receivedAt
  );
  const remainingMs = Math.max(
    0,
    huntEnemyCastAnchor.remainingMs - elapsedMs
  );
  const completedPercent =
    (1 - remainingMs / huntEnemyCastAnchor.totalMs) * 100;

  setHuntBarPercent(
    "huntEnemyCastBar",
    completedPercent
  );
  setHuntText(
    "huntEnemyCastTime",
    remainingMs > 0
      ? `${(remainingMs / 1000).toFixed(1)}s`
      : "IMPACT"
  );
}

function clampHuntPercent(
  value
) {
  return Math.max(
    0,
    Math.min(
      100,
      Number(value) || 0
    )
  );
}

function makeHuntATBAnchor(
  actor
) {
  if (!actor) {
    return null;
  }

  return {
    receivedAt:
      performance.now(),

    gauge:
      clampHuntPercent(
        actor.gauge
      ),

    ready:
      Boolean(
        actor.ready
      ),

    recoveryMs:
      Math.max(
        0,
        Number(
          actor.recoveryMs ?? 0
        ) || 0
      ),

    readyInMs:
      Math.max(
        0,
        Number(
          actor.readyInMs ?? 0
        ) || 0
      )
  };
}

function makeHuntAutoAttackAnchor(
  player
) {
  if (!player) {
    return null;
  }

  return {
    receivedAt:
      performance.now(),

    remainingMs:
      Math.max(
        0,
        Number(
          player.autoAttackMs ?? 0
        ) || 0
      ),

    totalMs:
      Math.max(
        1,
        Number(
          player.autoAttackTotalMs ??
          6000
        ) || 6000
      )
  };
}

function getSmoothHuntATB(
  anchor,
  now
) {
  if (!anchor) {
    return {
      percent: 0,
      ready: false
    };
  }

  if (anchor.ready) {
    return {
      percent: 100,
      ready: true
    };
  }

  const elapsedMs =
    Math.max(
      0,
      now -
        anchor.receivedAt
    );

  if (
    elapsedMs <=
    anchor.recoveryMs
  ) {
    return {
      percent:
        anchor.gauge,

      ready:
        false
    };
  }

  const fillElapsedMs =
    elapsedMs -
      anchor.recoveryMs;

  const fillDurationMs =
    Math.max(
      1,
      anchor.readyInMs -
        anchor.recoveryMs
    );

  const progress =
    Math.max(
      0,
      Math.min(
        1,
        fillElapsedMs /
          fillDurationMs
      )
    );

  return {
    percent:
      anchor.gauge +
      (
        100 -
          anchor.gauge
      ) *
      progress,

    /*
     * Visual prediction only. The server
     * still decides when abilities can fire.
     */
    ready:
      false
  };
}

function setHuntBarPercent(
  id,
  percent
) {
  const bar =
    document.getElementById(
      id
    );

  if (!bar) {
    return;
  }

  bar.style.width =
    `${clampHuntPercent(
      percent
    )}%`;
}

function syncHuntTimingAnchors(
  encounter
) {
  if (!encounter) {
    return;
  }

  if (encounter.enemy) {
    huntCombatTiming.enemy =
      makeHuntATBAnchor(
        encounter.enemy
      );
  }

  const players =
    Array.isArray(
      encounter.players
    )
      ? encounter.players
      : [];

  const activeIds =
    new Set();

  for (
    const player of
    players
  ) {
    const playerId =
      Number(
        player.playerId
      );

    if (
      !Number.isInteger(
        playerId
      ) ||
      playerId <= 0
    ) {
      continue;
    }

    activeIds.add(
      playerId
    );

    huntCombatTiming.players.set(
      playerId,
      {
        atb:
          makeHuntATBAnchor(
            player
          ),

        auto:
          makeHuntAutoAttackAnchor(
            player
          )
      }
    );
  }

  for (
    const playerId of
    huntCombatTiming.players.keys()
  ) {
    if (
      !activeIds.has(
        playerId
      )
    ) {
      huntCombatTiming.players.delete(
        playerId
      );
    }
  }

  startSmoothHuntTimers();
}

function renderSmoothHuntTimers() {
  if (
    !huntCombatTimingRunning
  ) {
    huntCombatTimingFrame =
      null;

    return;
  }

  const now =
    performance.now();

  renderSmoothHuntEnemyCast(now);

  // -----------------------
  // Boss ATB
  // -----------------------
  if (
    huntCombatTiming.enemy
  ) {
    const visual =
      getSmoothHuntATB(
        huntCombatTiming.enemy,
        now
      );

    setHuntBarPercent(
      "huntBossAtbBar",
      visual.percent
    );

    setHuntText(
      "huntBossAtbText",
      huntCombatTiming.enemy.ready
        ? "READY"
        : `${Math.round(
            visual.percent
          )}%`
    );
  }

  // -----------------------
  // Party ATB + Auto
  // -----------------------
  for (
    const [
      playerId,
      timing
    ] of
    huntCombatTiming.players
  ) {
    if (timing.atb) {
      const visual =
        getSmoothHuntATB(
          timing.atb,
          now
        );

      setHuntBarPercent(
        `huntPartyAtbBar-${playerId}`,
        visual.percent
      );

      setHuntText(
        `huntPartyAtbText-${playerId}`,
        timing.atb.ready
          ? "READY"
          : `${Math.round(
              visual.percent
            )}%`
      );

      /*
       * Keep this player's action status
       * moving smoothly too.
       */
      if (
        Number(
          playerId
        ) ===
          Number(
            huntCombatPlayerId
          ) &&
        huntCombatState ===
          "active" &&
        !timing.atb.ready &&
        !huntPendingSpellTarget
      ) {
        setHuntText(
          "huntActionStatus",
          `ATB ${Math.round(
            visual.percent
          )}%`
        );
      }
    }

    if (timing.auto) {
      const elapsedMs =
        Math.max(
          0,
          now -
            timing.auto.receivedAt
        );

      const remainingMs =
        Math.max(
          0,
          timing.auto.remainingMs -
            elapsedMs
        );

      const percent =
        (
          1 -
          remainingMs /
            timing.auto.totalMs
        ) *
        100;

      setHuntBarPercent(
        `huntPartyAutoBar-${playerId}`,
        percent
      );

      setHuntText(
        `huntPartyAutoText-${playerId}`,
        remainingMs <= 0
          ? "Swinging"
          : `${(
              remainingMs /
              1000
            ).toFixed(1)}s`
      );
    }
  }

  huntCombatTimingFrame =
    requestAnimationFrame(
      renderSmoothHuntTimers
    );
}

function startSmoothHuntTimers() {
  if (
    huntCombatTimingRunning
  ) {
    return;
  }

  huntCombatTimingRunning =
    true;

  huntCombatTimingFrame =
    requestAnimationFrame(
      renderSmoothHuntTimers
    );
}

function stopSmoothHuntTimers() {
  huntCombatTimingRunning =
    false;

  if (
    huntCombatTimingFrame
  ) {
    cancelAnimationFrame(
      huntCombatTimingFrame
    );

    huntCombatTimingFrame =
      null;
  }

  huntCombatTiming.enemy =
    null;

  hideHuntEnemyCastWarning();

  huntCombatTiming.players.clear();
}

/*
 * Reward chest created when a Hunt
 * is successfully completed.
 */
let huntRewardChestId =
  null;

function ensureHuntCombatModal() {
  if (document.getElementById("huntCombatModal")) {
    return;
  }

  const root =
    document.getElementById("hunt-combat-root");

  if (!root) {
    console.error(
      "Missing #hunt-combat-root"
    );
    return;
  }

  root.innerHTML = `
    <div
      id="huntCombatModal"
      class="hunt-combat-modal hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="huntCombatTitle"
    >
      <div class="hunt-combat-backdrop"></div>

      <section class="hunt-combat-card frame-host">
        <span
          class="frame-border panel"
          aria-hidden="true"
        ></span>

        <header class="hunt-combat-header">
          <div>
            <div class="hunt-combat-kicker">
              Party Hunt
            </div>

            <h2
              id="huntCombatTitle"
              class="hunt-combat-title"
            >
              Hunt Encounter
            </h2>
          </div>

          <div
            id="huntCombatStatus"
            class="hunt-combat-status"
          >
            Active
          </div>
        </header>

        <div class="hunt-combat-layout">

          <section
            id="huntEnemyCastWarning"
            class="hunt-enemy-cast-warning hidden"
            role="alert"
            aria-live="assertive"
          >
            <div class="hunt-enemy-cast-warning__icon">⚠</div>

            <div class="hunt-enemy-cast-warning__content">
              <div class="hunt-enemy-cast-warning__eyebrow">
                Enemy Ability Incoming
              </div>

              <div class="hunt-enemy-cast-warning__heading">
                <strong id="huntEnemyCastName">
                  Incoming Attack
                </strong>
                <span id="huntEnemyCastTime">0.0s</span>
              </div>

              <div class="hunt-enemy-cast-warning__track">
                <div
                  id="huntEnemyCastBar"
                  class="hunt-enemy-cast-warning__fill"
                ></div>
              </div>

              <div class="hunt-enemy-cast-warning__footer">
                <span id="huntEnemyCastTargets">
                  Prepare to react
                </span>
                <span
                  id="huntEnemyCastInterrupt"
                  class="hunt-enemy-cast-warning__interrupt"
                >
                  Interruptible
                </span>
              </div>
            </div>
          </section>

          <section class="hunt-boss-panel">

            <div class="hunt-boss-portrait-wrap">
              <img
                id="huntBossPortrait"
                class="hunt-boss-portrait"
                src="/images/default_creature.png"
                alt=""
              >
            </div>

            <div class="hunt-boss-copy">

              <div
                id="huntBossName"
                class="hunt-boss-name"
              >
                Unknown Quarry
              </div>

              <div
                id="huntBossMeta"
                class="hunt-boss-meta"
              >
                Level —
              </div>

              <div
                id="huntBossDescription"
                class="hunt-boss-description"
              >
              </div>

            </div>

            <div class="hunt-boss-health">

              <div class="hunt-boss-health__top">
                <span>Quarry Health</span>

                <span>
                  <span id="huntBossHp">0</span>
                  /
                  <span id="huntBossMaxHp">0</span>
                </span>
              </div>

              <div class="hunt-boss-health__track">
                <div
                  id="huntBossHpBar"
                  class="hunt-boss-health__fill"
                ></div>
              </div>

              <div class="hunt-boss-atb">

  <div class="hunt-boss-health__top">
    <span>Action Timer</span>

    <span id="huntBossAtbText">
      0%
    </span>
  </div>

  <div class="hunt-boss-health__track">
    <div
      id="huntBossAtbBar"
      class="hunt-boss-atb__fill"
    ></div>
  </div>

</div>

            </div>

          </section>

          <section class="hunt-party-panel">

            <div class="hunt-section-title">
              Adventuring Company
            </div>

            <div
              id="huntPartyList"
              class="hunt-party-list"
            >
              <div class="hunt-combat-loading">
                Gathering party...
              </div>
            </div>

          </section>

          <section class="hunt-log-panel">

            <div class="hunt-section-title">
              Encounter
            </div>

            <div
              id="huntCombatLog"
              class="hunt-combat-log"
            >
              <div>
                Your party approaches the quarry.
              </div>
            </div>

          </section>

<section class="hunt-actions-panel">

  <div class="hunt-action-header">

    <div>
      <div class="hunt-section-title">
        Your Actions
      </div>

      <div
        id="huntActionStatus"
        class="hunt-action-status"
      >
        Preparing...
      </div>
    </div>

  </div>

  <div
    id="huntSpellHotbar"
    class="hunt-spell-hotbar"
  >
    <div class="hunt-combat-loading">
      Loading abilities...
    </div>
  </div>

<div
  id="huntResultPanel"
  class="hunt-result-panel hidden"
>
</div>

  <button
    id="huntLeaveBtn"
    class="hunt-action-btn secondary"
    type="button"
    onclick="closeHuntCombatModal()"
  >
    Leave View
  </button>

</section>






        </div>
      </section>
    </div>
  `;
}

async function openHuntCombatModal() {
  ensureHuntCombatModal();

  const modal =
    document.getElementById(
      "huntCombatModal"
    );

  if (!modal) return;

  modal.classList.remove(
    "hidden"
  );

  startSmoothHuntTimers();

  /*
   * Identify this browser's player before
   * rendering personal ATB/hotbar state.
   */
  if (!huntCombatPlayerId) {
    await loadHuntCombatPlayer();
  }

  /*
   * Load the player's normal six-slot
   * combat loadout.
   */
  await loadHuntCombatSpells();
  await loadHuntCombatPotions();

  await loadHuntEncounterState();

  connectHuntCombatSocket();

  if (
    huntCombatState ===
    "active"
  ) {
    joinHuntCombatChannel();
  }
}

window.openHuntCombatModal =
  openHuntCombatModal;

  async function loadHuntCombatPlayer() {
  try {
    const res =
      await fetch(
        "/me",
        {
          credentials: "include",
          cache: "no-store"
        }
      );

    const player =
      await res.json();

    huntCombatPlayerId =
      Number(
        player.id
      ) || null;

  } catch (err) {
    console.error(
      "Failed to identify Hunt combat player:",
      err
    );
  }
}


async function loadHuntCombatSpells() {
  try {
    const res =
      await fetch(
        "/combat/spells",
        {
          credentials: "include",
          cache: "no-store"
        }
      );

    const data =
      await res.json();

    if (
      !res.ok ||
      data.error
    ) {
      throw new Error(
        data.error ||
        "Unable to load abilities."
      );
    }

    const slots =
      Array.isArray(data.slots)
        ? data.slots
        : [];

    huntCombatSpells =
      Array.from(
        { length: 6 },
        (_, index) => {

          const slotNumber =
            index + 1;

          const entry =
            slots.find(
              slot =>
                Number(slot.slot) ===
                slotNumber
            );

          return {
            slot:
              slotNumber,

            spell:
              entry?.spell ??
              null
          };
        }
      );

    renderHuntSpellHotbar();

  } catch (err) {
    console.error(
      "Failed to load Hunt abilities:",
      err
    );

    huntCombatSpells =
      Array.from(
        { length: 6 },
        (_, index) => ({
          slot: index + 1,
          spell: null
        })
      );

    renderHuntSpellHotbar();
  }
}

  async function loadHuntEncounterState() {
  try {
    const res =
      await fetch(
        "/hunts/encounter",
        {
          credentials: "include",
          cache: "no-store"
        }
      );

    const data =
      await res.json();

    if (
      !res.ok ||
      !data.ok ||
      !data.encounter
    ) {
      throw new Error(
        data.error ||
        "No active Hunt encounter."
      );
    }

    renderHuntEncounter(
      data.encounter
    );

  } catch (err) {
    console.error(
      "Failed to load Hunt encounter:",
      err
    );

    const log =
      document.getElementById(
        "huntCombatLog"
      );

    if (log) {
      log.innerHTML = `
        <div>
          Unable to load the Hunt encounter.
        </div>
      `;
    }
  }
}

function renderHuntEncounter(
  encounter
) {

  window.__lastHuntEncounter =
  encounter;

  syncHuntTimingAnchors(
    encounter
  );

  activeHuntEncounterId =
    Number(
      encounter.encounterId
    );

  const target =
    encounter.enemy || {};

  syncHuntEnemyCastWarning(encounter);

  setHuntText(
    "huntBossName",
    target.name ||
      "Unknown Quarry"
  );

  setHuntText(
    "huntBossMeta",
    `Level ${
      target.level ?? "—"
    }`
  );

  setHuntText(
    "huntBossDescription",
    target.description || ""
  );

    setHuntText(
    "huntBossHp",
    target.hp ?? 0
    );

    setHuntText(
    "huntBossMaxHp",
    target.maxHp ?? 0
    );

    updateHuntBar(
    "huntBossHpBar",
    target.hp,
    target.maxHp
    );

    /*
     * Boss ATB is rendered continuously by the
     * Hunt timing animation loop below.
     */

  const status =
    document.getElementById(
      "huntCombatStatus"
    );

  if (status) {
    status.textContent =
      String(
        encounter.state ||
        "active"
      );
  }

  const portrait =
    document.getElementById(
      "huntBossPortrait"
    );

  if (portrait) {
    let src =
      target.image ||
      target.icon ||
      target.creatureimage ||
      "/images/default_creature.png";

    if (
      src &&
      !src.startsWith("/") &&
      !src.startsWith("http")
    ) {
      src = "/" + src;
    }

    portrait.src = src;

    portrait.onerror = () => {
      portrait.onerror = null;
      portrait.src =
        "/images/default_creature.png";
    };
  }

  renderHuntParty(
    encounter.players || [],
    target.targetPlayerId
  );

  const combatLog =
  document.getElementById(
    "huntCombatLog"
  );

if (combatLog) {

  const entries =
    Array.isArray(
      encounter.log
    )
      ? encounter.log
      : [];

  if (entries.length === 0) {

    combatLog.innerHTML = `
      <div>
        Your party approaches the quarry.
      </div>
    `;

  } else {

    combatLog.innerHTML =
      entries
        .map(
          entry => `
            <div>
              ${escapeHuntHtml(entry)}
            </div>
          `
        )
        .join("");

    /*
     * Keep newest combat events visible.
     */
    combatLog.scrollTop =
      combatLog.scrollHeight;
  }
}

  syncHuntPlayerActions(
  encounter
);

const encounterStatus =
  String(
    encounter.state ||
    "active"
  ).toLowerCase();

  huntCombatState =
  encounterStatus;


renderHuntFinalState(
  encounter
);


if (
  encounterStatus !== "active"
) {
  huntPendingSpellTarget =
  null;

document
  .getElementById(
    "huntCombatModal"
  )
  ?.classList.remove(
    "selecting-ally"
  );
  leaveHuntCombatChannel();
  stopSmoothHuntTimers();

  huntCombatCasting =
    false;
}
}

function renderHuntParty(
  players,
  targetPlayerId =
    window.__lastHuntEncounter?.enemy?.targetPlayerId ?? null
) {
  const list =
    document.getElementById(
      "huntPartyList"
    );

  if (!list) return;

  if (
    !Array.isArray(players) ||
    players.length === 0
  ) {
    list.innerHTML = `
      <div class="hunt-combat-empty">
        No adventurers have joined.
      </div>
    `;

    return;
  }

  const highestThreat = Math.max(
    0,
    ...players
      .filter(player => Number(player.hp ?? player.hpoints ?? 0) > 0)
      .map(player => Math.max(0, Number(player.threat) || 0))
  );

  list.innerHTML =
    players
      .map(player => {

        const hp =
          Number(
            player.hp ??
            player.hpoints ??
            0
          );

        const maxHp =
          Number(
            player.maxHp ??
            player.maxhp ??
            1
          );

        const sp =
          Number(
            player.sp ??
            player.spoints ??
            0
          );

        const maxSp =
          Number(
            player.maxSp ??
            player.maxspoints ??
            1
          );

        const hpPct =
          maxHp > 0
            ? Math.max(
                0,
                Math.min(
                  100,
                  hp / maxHp * 100
                )
              )
            : 0;

        const spPct =
          maxSp > 0
            ? Math.max(
                0,
                Math.min(
                  100,
                  sp / maxSp * 100
                )
              )
            : 0;

        const gauge =
  Math.max(
    0,
    Math.min(
      100,
      Number(
        player.gauge ?? 0
      )
    )
  );

const ready =
  Boolean(
    player.ready
  );

const autoAttackMs =
  Math.max(
    0,
    Number(
      player.autoAttackMs ?? 0
    )
  );

const autoAttackTotalMs =
  Math.max(
    1,
    Number(
      player.autoAttackTotalMs ??
      6000
    )
  );

/*
 * ATB and auto-attack widths are rendered
 * continuously by requestAnimationFrame.
 */

const isSelf =
  Number(player.playerId) ===
  Number(huntCombatPlayerId);

const isAlive =
  hp > 0;

const threat = Math.max(
  0,
  Math.round(Number(player.threat) || 0)
);

const threatPct =
  highestThreat > 0
    ? Math.max(0, Math.min(100, threat / highestThreat * 100))
    : 0;

const isBossTarget =
  isAlive &&
  Number(player.playerId) === Number(targetPlayerId);

const selectingAlly =
  Boolean(
    huntPendingSpellTarget
  );

const canTarget =
  selectingAlly &&
  isAlive;

const targetClass =
  canTarget
    ? "is-targetable"
    : "";

const clickHandler =
  canTarget
    ? `onclick="selectHuntAllyTarget(${Number(
        player.playerId
      )})"`
    : "";

        return `
          <div
            class="hunt-party-member ${isSelf ? "is-self" : ""} ${isBossTarget ? "is-boss-target" : ""} ${targetClass}"
            ${clickHandler}
          >

            <div class="hunt-party-member__top">

              <div>
                <div class="hunt-party-member__name">
                  ${escapeHuntHtml(
                    player.name ||
                    "Adventurer"
                  )}
                </div>

                <div class="hunt-party-member__meta">
                  ${escapeHuntHtml(
                    player.className ||
                    player.pclass ||
                    ""
                  )}

                  ${
                    player.level
                      ? ` · Level ${Number(player.level)}`
                      : ""
                  }
                </div>
              </div>

            <div class="hunt-party-member__indicators">
            ${isBossTarget
              ? `<span class="hunt-party-threat-target">⚔ Boss Target</span>`
              : ""
            }
            ${
            hp <= 0
                ? `
                <span class="hunt-party-member__status">
                    Defeated
                </span>
                `
                : ready
                ? `
                    <span class="hunt-party-member__status active">
                    Ready
                    </span>
                `
                : `
                    <span class="hunt-party-member__status">
                    Acting
                    </span>
                `
            }
            </div>
            </div>

            <div class="hunt-party-stat hunt-party-stat--threat">

              <span>Threat</span>

              <div class="hunt-party-track">
                <div
                  class="hunt-party-fill threat ${isBossTarget ? "targeted" : ""}"
                  style="width:${threatPct}%"
                ></div>
              </div>

              <span>${threat.toLocaleString()}</span>

            </div>

            <div class="hunt-party-stat">

              <span>HP</span>

              <div class="hunt-party-track">
                <div
                  class="hunt-party-fill hp"
                  style="width:${hpPct}%"
                ></div>
              </div>

              <span>
                ${hp}/${maxHp}
              </span>

            </div>

            <div class="hunt-party-stat">

              <span>SP</span>

              <div class="hunt-party-track">
                <div
                  class="hunt-party-fill sp"
                  style="width:${spPct}%"
                ></div>
              </div>

              <span>
                ${sp}/${maxSp}
              </span>

            </div>

            <div class="hunt-party-stat">

            <span>ATB</span>

            <div class="hunt-party-track">
                <div
                id="huntPartyAtbBar-${Number(player.playerId)}"
                class="hunt-party-fill atb ${ready ? "ready" : ""}"
                style="width:${gauge}%"
                ></div>
            </div>

            <span
              id="huntPartyAtbText-${Number(player.playerId)}"
            >
                ${
                ready
                    ? "READY"
                    : `${Math.round(gauge)}%`
                }
            </span>

            </div>

            <div class="hunt-party-stat">

            <span>Auto</span>

            <div class="hunt-party-track">
                <div
                id="huntPartyAutoBar-${Number(player.playerId)}"
                class="hunt-party-fill auto"
                style="width:${
                  Math.max(
                    0,
                    Math.min(
                      100,
                      (
                        1 -
                        autoAttackMs /
                          autoAttackTotalMs
                      ) *
                        100
                    )
                  )
                }%"
                ></div>
            </div>

            <span
              id="huntPartyAutoText-${Number(player.playerId)}"
            >
                ${
                autoAttackMs <= 0
                    ? "Swinging"
                    : `${(autoAttackMs / 1000).toFixed(1)}s`
                }
            </span>

            </div>

          </div>
        `;
      })
      .join("");
}

function renderHuntSpellHotbar() {
  const bar =
    document.getElementById(
      "huntSpellHotbar"
    );

  if (!bar) return;

  const entries =
    Array.isArray(
      huntCombatSpells
    )
      ? huntCombatSpells
      : [];

  const spellHtml =
    entries
      .map(entry => {

        const slot =
          Number(
            entry.slot
          );

        const spell =
          entry.spell;

        if (!spell) {
          return `
            <button
              class="hunt-spell-slot empty"
              type="button"
              disabled
            >
              <span class="hunt-spell-empty">
                ✦
              </span>

              <span class="hunt-spell-key">
                ${slot}
              </span>
            </button>
          `;
        }

        const spellId =
          Number(
            spell.id
          );

        const name =
          escapeHuntHtml(
            spell.name ||
            "Ability"
          );

            const icon =
            resolveHuntSpellIcon(
                spell.icon
            );

        return `
          <button
            id="huntSpellBtn-${spellId}"
            class="hunt-spell-slot"
            type="button"
            onclick="activateHuntSpell(${spellId})"
            disabled
            title="${name}"
          >

            <img
              src="${escapeHuntHtml(icon)}"
              alt=""
              onerror="this.src='/icons/default.webp'"
            >

            <span class="hunt-spell-key">
              ${slot}
            </span>

            <div
              id="huntSpellCooldown-${spellId}"
              class="hunt-spell-cooldown hidden"
            ></div>

            <div class="hunt-spell-tooltip">
              <strong>
                ${name}
              </strong>

              <span>
                ${Number(
                  spell.manaCost ??
                  spell.mana_cost ??
                  0
                )} SP
              </span>

              ${
                Number(spell.cooldown) > 0
                  ? `
                    <span>
                      ${Number(spell.cooldown)}s cooldown
                    </span>
                  `
                  : ""
              }
            </div>

          </button>
        `;
      })
      .join("");

  bar.innerHTML =
    renderHuntPotionSlot("health") +
    spellHtml +
    renderHuntPotionSlot("mana");

  updateHuntPotionCooldownDisplay();
}

function resolveHuntItemIcon(rawIcon) {
  const raw = String(rawIcon || "").trim();
  if (!raw) return "/icons/default.webp";
  if (raw.startsWith("http") || raw.startsWith("/")) return raw;
  return raw.startsWith("icons/") ? `/${raw}` : `/icons/${raw}`;
}

function renderHuntPotionSlot(slot) {
  const potion = huntCombatPotions[slot];
  const health = slot === "health";
  const key = health ? "Q" : "E";
  const label = health ? "Health Potion" : "Mana Potion";
  const effectLabel = health ? "HP" : "SP";

  if (!potion) {
    return `
      <button class="hunt-spell-slot hunt-potion-slot empty" type="button" disabled>
        <span class="hunt-spell-empty">✦</span>
        <span class="hunt-spell-key">${key}</span>
        <div class="hunt-spell-tooltip">
          <strong>${label}</strong>
          <span>No potion equipped</span>
        </div>
      </button>
    `;
  }

  const amount = Math.max(0, Number(potion.effect_value) || 0);
  const quantity = Math.max(0, Number(potion.qty) || 0);

  return `
    <button
      id="huntPotionBtn-${slot}"
      class="hunt-spell-slot hunt-potion-slot"
      type="button"
      onclick="useHuntCombatPotion('${slot}')"
      ${huntCombatState === "active" && quantity > 0 ? "" : "disabled"}
    >
      <img
        src="${escapeHuntHtml(resolveHuntItemIcon(potion.icon))}"
        alt=""
        onerror="this.src='/icons/default.webp'"
      >
      <span class="hunt-spell-key">${key}</span>
      <span class="hunt-potion-quantity">${quantity}</span>
      <div id="huntPotionCooldown-${slot}" class="hunt-spell-cooldown hidden"></div>
      <div class="hunt-spell-tooltip">
        <strong>${escapeHuntHtml(potion.name || label)}</strong>
        <span>Restores ${amount} ${effectLabel}</span>
        <span>20s cooldown</span>
      </div>
    </button>
  `;
}

async function loadHuntCombatPotions() {
  try {
    const response = await fetch("/hunts/encounter/potions", {
      credentials: "include",
      cache: "no-store"
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Unable to load potions.");
    }

    huntCombatPotions = {
      health: data.health || null,
      mana: data.mana || null
    };

    const now = Date.now();
    huntPotionCooldownEnds.health =
      now + Math.max(0, Number(data.cooldowns?.health) || 0);
    huntPotionCooldownEnds.mana =
      now + Math.max(0, Number(data.cooldowns?.mana) || 0);

    renderHuntSpellHotbar();
    startHuntPotionCooldownTimer();
  } catch (error) {
    console.error("Failed to load Hunt potions:", error);
    huntCombatPotions = { health: null, mana: null };
    renderHuntSpellHotbar();
  }
}

function startHuntPotionCooldownTimer() {
  if (huntPotionCooldownTimer) return;
  huntPotionCooldownTimer = window.setInterval(
    updateHuntPotionCooldownDisplay,
    200
  );
}

function updateHuntPotionCooldownDisplay() {
  const now = Date.now();

  for (const slot of ["health", "mana"]) {
    const button = document.getElementById(`huntPotionBtn-${slot}`);
    const cooldown = document.getElementById(`huntPotionCooldown-${slot}`);
    if (!button || !cooldown) continue;

    const remainingMs = Math.max(0, huntPotionCooldownEnds[slot] - now);
    const coolingDown = remainingMs > 0;
    button.classList.toggle("is-cooldown", coolingDown);
    button.disabled =
      coolingDown ||
      huntCombatState !== "active" ||
      !huntCombatPotions[slot];

    cooldown.classList.toggle("hidden", !coolingDown);
    cooldown.textContent = coolingDown
      ? String(Math.ceil(remainingMs / 1000))
      : "";
  }
}

async function useHuntCombatPotion(slot) {
  if (slot !== "health" && slot !== "mana") return;
  if (huntCombatState !== "active") return;
  if (Date.now() < huntPotionCooldownEnds[slot]) return;

  huntPotionCooldownEnds[slot] = Date.now() + 20_000;
  updateHuntPotionCooldownDisplay();

  try {
    const response = await fetch("/hunts/encounter/potions/use", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot })
    });
    const data = await response.json();

    if (!response.ok || data.ok === false) {
      const remainingMs = Math.max(0, Number(data.remainingMs) || 0);
      huntPotionCooldownEnds[slot] = remainingMs > 0
        ? Date.now() + remainingMs
        : 0;
      updateHuntPotionCooldownDisplay();
      throw new Error(
        data.error === "cooldown"
          ? "That potion is still on cooldown."
          : data.error || "Unable to use potion."
      );
    }

    huntPotionCooldownEnds[slot] =
      Date.now() + Math.max(0, Number(data.cooldownMs) || 20_000);

    if (data.snapshot) renderHuntEncounter(data.snapshot);
    await loadHuntCombatPotions();
  } catch (error) {
    console.error("Hunt potion use failed:", error);
    setHuntText("huntActionStatus", error.message || "Unable to use potion.");
  }
}

window.useHuntCombatPotion = useHuntCombatPotion;

function resolveHuntSpellIcon(
  rawIcon
) {
  const raw =
    String(
      rawIcon ||
      ""
    ).trim();

  if (!raw) {
    return "/icons/default.webp";
  }

  if (
    raw.startsWith("http://") ||
    raw.startsWith("https://")
  ) {
    return raw;
  }

  if (
    raw.startsWith(
      "/icons/spells/"
    )
  ) {
    return raw;
  }

  if (
    raw.startsWith(
      "icons/spells/"
    )
  ) {
    return "/" + raw;
  }

  return (
    "/icons/spells/" +
    raw.replace(
      /^\/+/,
      ""
    )
  );
}

function syncHuntPlayerActions(
  encounter
) {
  if (
    !huntCombatPlayerId ||
    !Array.isArray(
      encounter.players
    )
  ) {
    return;
  }

  const player =
    encounter.players.find(
      member =>
        Number(member.playerId) ===
        Number(huntCombatPlayerId)
    );

  if (!player) {
    return;
  }

  const encounterActive =
    String(
      encounter.state ||
      ""
    ) === "active";

  const ready =
    Boolean(
      player.ready
    );

  const alive =
    Number(
      player.hp ?? 0
    ) > 0;

  const canAct =
    encounterActive &&
    alive &&
    ready &&
    !huntCombatCasting;

  const status =
    document.getElementById(
      "huntActionStatus"
    );

  if (status) {

  if (!encounterActive) {

    if (
      encounter.state ===
      "victory"
    ) {
      status.textContent =
        "Hunt complete";

    } else if (
      encounter.state ===
      "defeat"
    ) {
      status.textContent =
        "Your company was defeated";

    } else {
      status.textContent =
        "Encounter ended";
    }

    } else if (!alive) {
      status.textContent =
        "You are defeated";

    } else if (
      huntPendingSpellTarget
    ) {
      status.textContent =
        `Choose an ally for ${
          huntPendingSpellTarget.spellName
        }`;

    } else if (ready) {
      status.textContent =
        "Choose an ability";

    } else {
      status.textContent =
        `ATB ${Math.round(
          Number(
            player.gauge ?? 0
          )
        )}%`;
    }
  }

  for (
    const entry of
    huntCombatSpells
  ) {
    const spell =
      entry.spell;

    if (!spell) {
      continue;
    }

    const spellId =
      Number(
        spell.id
      );

    const button =
      document.getElementById(
        `huntSpellBtn-${spellId}`
      );

    const cooldownEl =
      document.getElementById(
        `huntSpellCooldown-${spellId}`
      );

    const cooldownUntil =
      Number(
        player.cooldowns?.[
          `spell:${spellId}`
        ] ?? 0
      );

    const remainingMs =
      Math.max(
        0,
        cooldownUntil -
        Date.now()
      );

    const onCooldown =
      remainingMs > 0;

    const manaCost =
      Number(
        spell.manaCost ??
        spell.mana_cost ??
        0
      );

    const enoughSP =
      Number(
        player.sp ?? 0
      ) >= manaCost;

    if (button) {
      button.disabled =
        !canAct ||
        onCooldown ||
        !enoughSP;

      button.classList.toggle(
        "is-ready",
        canAct &&
        !onCooldown &&
        enoughSP
      );

      button.classList.toggle(
        "is-cooldown",
        onCooldown
      );

      button.classList.toggle(
        "no-sp",
        !enoughSP
      );
    }

    if (cooldownEl) {

      if (onCooldown) {

        cooldownEl.textContent =
          String(
            Math.max(
              1,
              Math.ceil(
                remainingMs /
                1000
              )
            )
          );

        cooldownEl.classList.remove(
          "hidden"
        );

      } else {

        cooldownEl.textContent =
          "";

        cooldownEl.classList.add(
          "hidden"
        );
      }
    }
  }
}

function renderHuntFinalState(
  encounter
) {
  const state =
    String(
      encounter?.state ||
      ""
    ).toLowerCase();

  const panel =
    document.getElementById(
      "huntResultPanel"
    );

  const leaveBtn =
    document.getElementById(
      "huntLeaveBtn"
    );

  if (!panel) {
    return;
  }


  /*
   * Encounter is still running.
   */
  if (state === "active") {

    panel.classList.add(
      "hidden"
    );

    panel.innerHTML = "";

    if (leaveBtn) {
      leaveBtn.textContent =
        "Leave View";
    }

    return;
  }


  /*
   * VICTORY
   */
  if (state === "victory") {

    const rewards =
      Array.isArray(
        encounter.rewards
      )
        ? encounter.rewards
        : [];

    const myReward =
      rewards.find(
        reward =>
          Number(
            reward.playerId
          ) ===
          Number(
            huntCombatPlayerId
          )
      );

    /*
    * Preserve this player's reward chest.
    *
    * We wait until the Hunt result screen is
    * closed before showing the normal loot
    * chest modal.
    */
    huntRewardChestId =
      myReward?.chestId
        ? Number(
            myReward.chestId
          )
        : null;

    const rewardHtml =
      myReward
        ? `
          <div class="hunt-result-rewards">

            <div class="hunt-result-reward">
              <span class="hunt-result-reward__icon">
                ✨
              </span>

              <div>
                <strong>
                  ${Number(
                    myReward.exp || 0
                  ).toLocaleString()}
                  EXP
                </strong>

                <span>
                  Experience earned
                </span>
              </div>
            </div>


            <div class="hunt-result-reward">
              <span class="hunt-result-reward__icon">
                🪙
              </span>

              <div>
                <strong>
                  ${Number(
                    myReward.gold || 0
                  ).toLocaleString()}
                  Gold
                </strong>

                <span>
                  Hunt payment
                </span>
              </div>
            </div>

          </div>
        `
        : `
          <div class="hunt-result-message">
            The Hunt has been completed.
          </div>
        `;


    panel.innerHTML = `
      <div class="hunt-result-header">

        <div class="hunt-result-emblem">
          ⚔
        </div>

        <div>
          <div class="hunt-result-kicker">
            Hunt Complete
          </div>

          <div class="hunt-result-title">
            Quarry Defeated
          </div>

          <div class="hunt-result-subtitle">
            ${
              escapeHuntHtml(
                encounter.enemy?.name ||
                "The quarry"
              )
            }
            has fallen.
          </div>
        </div>

      </div>

      ${rewardHtml}
    `;

    panel.classList.remove(
      "hidden"
    );

    if (leaveBtn) {
      leaveBtn.textContent =
        "Return to World";
    }

    return;
  }


  /*
   * DEFEAT
   */
  if (state === "defeat") {

    panel.innerHTML = `
      <div class="hunt-result-header hunt-result-header--defeat">

        <div class="hunt-result-emblem">
          ☠
        </div>

        <div>
          <div class="hunt-result-kicker">
            Hunt Failed
          </div>

          <div class="hunt-result-title">
            Your Company Has Fallen
          </div>

          <div class="hunt-result-subtitle">
            ${
              escapeHuntHtml(
                encounter.enemy?.name ||
                "The quarry"
              )
            }
            proved too dangerous.
          </div>
        </div>

      </div>
    `;

    panel.classList.remove(
      "hidden"
    );

    if (leaveBtn) {
      leaveBtn.textContent =
        "Return to World";
    }
  }
}

function activateHuntSpell(
  spellId
) {
  if (
    huntCombatCasting ||
    !activeHuntEncounterId
  ) {
    return;
  }

  const entry =
    huntCombatSpells.find(
      item =>
        Number(
          item.spell?.id
        ) ===
        Number(
          spellId
        )
    );

  const spell =
    entry?.spell;

  if (!spell) {
    return;
  }

  const targetType =
    String(
      spell.target_type ||
      spell.targetType ||
      spell.target ||
      "enemy"
    )
      .trim()
      .toLowerCase();


  // ===================================================
  // ENEMY TARGET
  // ===================================================

  if (
    targetType === "enemy"
  ) {
    cancelHuntTargetSelection();

    castHuntCombatSpell(
      spellId,
      null
    );

    return;
  }


  // ===================================================
  // SELF TARGET
  // ===================================================

  if (
    targetType === "self"
  ) {
    cancelHuntTargetSelection();

    castHuntCombatSpell(
      spellId,
      huntCombatPlayerId
    );

    return;
  }


  // ===================================================
  // FRIENDLY TARGET
  // ===================================================

  if (
    targetType === "ally"
  ) {
    huntPendingSpellTarget = {
      spellId:
        Number(
          spellId
        ),

      spellName:
        String(
          spell.name ||
          "Ability"
        )
    };

    const modal =
      document.getElementById(
        "huntCombatModal"
      );

    modal?.classList.add(
      "selecting-ally"
    );

    setHuntText(
      "huntActionStatus",
      `Select a party member to cast ${spell.name}`
    );

    /*
     * Re-render so party members immediately
     * receive their selectable state.
     */
    if (
      window.__lastHuntEncounter
    ) {
      renderHuntParty(
        window.__lastHuntEncounter.players ||
        []
      );
    }

    return;
  }


  // ===================================================
  // PARTY-WIDE SPELL
  // ===================================================

  /*
   * We'll give all_allies true multi-target behavior
   * later. No manual target selection is necessary.
   */
  if (
    targetType === "all_allies"
  ) {
    cancelHuntTargetSelection();

    castHuntCombatSpell(
      spellId,
      null
    );

    return;
  }


  /*
   * Safe fallback for any future target type.
   */
  cancelHuntTargetSelection();

  castHuntCombatSpell(
    spellId,
    null
  );
}

window.activateHuntSpell =
  activateHuntSpell;


function selectHuntAllyTarget(
  targetPlayerId
) {
  if (
    !huntPendingSpellTarget
  ) {
    return;
  }

  const targetId =
    Number(
      targetPlayerId
    );

  if (
    !Number.isInteger(
      targetId
    ) ||
    targetId <= 0
  ) {
    return;
  }

  const spellId =
    huntPendingSpellTarget.spellId;

  cancelHuntTargetSelection();

  castHuntCombatSpell(
    spellId,
    targetId
  );
}

window.selectHuntAllyTarget =
  selectHuntAllyTarget;


function cancelHuntTargetSelection() {
  huntPendingSpellTarget =
    null;

  const modal =
    document.getElementById(
      "huntCombatModal"
    );

  modal?.classList.remove(
    "selecting-ally"
  );

  if (
    window.__lastHuntEncounter
  ) {
    renderHuntParty(
      window.__lastHuntEncounter.players ||
      []
    );
  }
}

window.cancelHuntTargetSelection =
  cancelHuntTargetSelection;


async function castHuntCombatSpell(
  spellId,
  targetPlayerId = null
) {
  if (
    huntCombatCasting ||
    !activeHuntEncounterId
  ) {
    return;
  }

  huntCombatCasting = true;

  try {

    const res =
      await fetch(
        "/hunts/encounter/spells/cast",
        {
          method: "POST",
          credentials: "include",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              spellId:
                Number(
                  spellId
                ),

              targetPlayerId:
                targetPlayerId != null
                  ? Number(
                      targetPlayerId
                    )
                  : null
            })
        }
      );

    const data =
      await res.json();

    /*
     * A stale poll may make the browser
     * think ATB is ready a fraction longer
     * than the server does.
     *
     * Don't throw intrusive alerts for
     * normal combat timing failures.
     */
    if (
      !res.ok ||
      !data.ok
    ) {

      const error =
        String(
          data.error ||
          "Unable to cast ability."
        );

      if (
        error !==
        "Your action gauge is not ready." &&
        error !==
        "That spell is still on cooldown."
      ) {
        console.warn(
          "Hunt spell rejected:",
          error
        );
      }

      /*
       * Render returned authoritative
       * snapshot if one exists.
       */
      if (data.snapshot) {
        renderHuntEncounter(
          data.snapshot
        );
      }

      return;
    }

    /*
     * The Hunt server accepted the cast.
     * Resolve the spell from the already-loaded six-slot
     * hotbar and emit the same global cast event used by
     * normal world combat.
     */
    const castSpellEntry =
      huntCombatSpells.find(
        entry =>
          Number(entry.spell?.id) ===
          Number(spellId)
      );

    const castSpellData =
      castSpellEntry?.spell ??
      null;

    if (
      castSpellData?.audio &&
      window.GFSpellEvents?.emitCast
    ) {
      window.GFSpellEvents.emitCast(
        castSpellData
      );
    }

    if (data.snapshot) {
      renderHuntEncounter(
        data.snapshot
      );
    }

  } catch (err) {
    console.error(
      "Hunt spell cast failed:",
      err
    );

  } finally {

    huntCombatCasting =
      false;
  }
}

window.castHuntCombatSpell =
  castHuntCombatSpell;

function getSharedHuntSocket() {
  if (window.GFSocket) {
    return window.GFSocket;
  }

  if (
    typeof window.io !==
    "function"
  ) {
    return null;
  }

  window.GFSocket =
    window.io();

  return window.GFSocket;
}

function connectHuntCombatSocket() {
  const socket =
    getSharedHuntSocket();

  if (!socket) {
    console.error(
      "Hunt combat socket client failed to load."
    );

    return;
  }

  if (
    huntCombatSocket ===
    socket
  ) {
    return;
  }

  huntCombatSocket =
    socket;

  huntCombatSocket.on(
    "hunt:combat-state",
    snapshot => {
      if (!snapshot) return;

      if (
        activeHuntEncounterId &&
        Number(
          snapshot.encounterId
        ) !==
          Number(
            activeHuntEncounterId
          )
      ) {
        return;
      }

      renderHuntEncounter(
        snapshot
      );
    }
  );

  huntCombatSocket.on(
    "connect",
    () => {
      if (
        activeHuntEncounterId
      ) {
        joinHuntCombatChannel();
      }
    }
  );
}

function joinHuntCombatChannel() {
  connectHuntCombatSocket();

  if (
    !huntCombatSocket
  ) {
    return;
  }

  huntCombatSocket.emit(
    "hunt:combat:join",
    response => {
      if (
        response?.ok &&
        response.snapshot
      ) {
        renderHuntEncounter(
          response.snapshot
        );
      }
    }
  );
}

function leaveHuntCombatChannel() {
  huntCombatSocket?.emit(
    "hunt:combat:leave"
  );
}

async function closeHuntCombatModal() {

  leaveHuntCombatChannel();
  stopSmoothHuntTimers();


  /*
   * Preserve the reward chest before
   * clearing Hunt-specific browser state.
   */
  const rewardChestId =
    huntRewardChestId;


  const modal =
    document.getElementById(
      "huntCombatModal"
    );

  modal?.classList.add(
    "hidden"
  );


  /*
   * Clear Hunt combat state.
   */
  activeHuntEncounterId =
    null;

  huntCombatCasting =
    false;

  huntCombatState =
    null;

  huntRewardChestId =
    null;
  
  huntPendingSpellTarget =
    null;


  /*
   * Refresh world state so completed Hunt
   * clues and the quarry disappear.
   */
  if (
    typeof refreshWorld ===
    "function"
  ) {
    try {

      await refreshWorld();

    } catch (err) {

      console.warn(
        "World refresh after Hunt failed:",
        err
      );

    }
  }


  /*
   * Refresh party quick-view state.
   */
  if (
    typeof loadWorldPartyStatus ===
    "function"
  ) {
    try {

      await loadWorldPartyStatus();

    } catch (err) {

      console.warn(
        "Party refresh after Hunt failed:",
        err
      );

    }
  }


  /*
   * Refresh player EXP, gold, level,
   * HP/SP, etc.
   */
  if (
    typeof loadStatPanel ===
    "function"
  ) {
    try {

      await loadStatPanel();

    } catch (err) {

      console.warn(
        "Stat panel refresh after Hunt failed:",
        err
      );

    }
  }


  /*
   * -------------------------------------------------
   * HUNT REWARD CHEST
   * -------------------------------------------------
   *
   * Hunt rewards use the exact same chest
   * system as normal Guildforge loot.
   *
   * We intentionally show it only after the
   * Hunt modal closes so the two overlays do
   * not compete with one another.
   */
  if (
    rewardChestId &&
    window.LootChestModal
  ) {

    try {

      /*
       * Mark it as the player's pending chest
       * first so the normal pending indicator
       * remains correct.
       */
      window.LootChestModal.setPending(
        rewardChestId
      );


      /*
       * Then immediately display the sealed
       * reward chest.
       */
      window.LootChestModal.show(
        rewardChestId
      );

    } catch (err) {

      console.warn(
        "Unable to show Hunt reward chest:",
        err
      );

    }
  }
}

window.closeHuntCombatModal =
  closeHuntCombatModal;

  function setHuntText(
  id,
  value
) {
  const el =
    document.getElementById(id);

  if (!el) return;

  el.textContent =
    value == null
      ? ""
      : String(value);
}


function updateHuntBar(
  id,
  current,
  max
) {
  const bar =
    document.getElementById(id);

  if (!bar) return;

  const currentValue =
    Math.max(
      0,
      Number(current) || 0
    );

  const maxValue =
    Math.max(
      1,
      Number(max) || 1
    );

  const percent =
    Math.max(
      0,
      Math.min(
        100,
        currentValue /
          maxValue *
          100
      )
    );

  bar.style.width =
    `${percent}%`;
}

document.addEventListener(
  "keydown",
  event => {

    const modal =
      document.getElementById(
        "huntCombatModal"
      );

    if (
      !modal ||
      modal.classList.contains(
        "hidden"
      )
    ) {
      return;
    }

    if (
      event.key === "Escape" &&
      huntPendingSpellTarget
    ) {
      event.preventDefault();

      cancelHuntTargetSelection();

      setHuntText(
        "huntActionStatus",
        "Choose an ability"
      );

      return;
    }

    if (
      event.repeat
    ) {
      return;
    }

    const pressedKey = String(event.key || "").toLowerCase();
    if (pressedKey === "q" || pressedKey === "e") {
      event.preventDefault();
      useHuntCombatPotion(pressedKey === "q" ? "health" : "mana");
      return;
    }

    // existing 1-6 handling...
    const slot =
      Number(
        event.key
      );

    if (
      !Number.isInteger(slot) ||
      slot < 1 ||
      slot > 6
    ) {
      return;
    }

    const entry =
      huntCombatSpells.find(
        item =>
          Number(item.slot) ===
          slot
      );

    if (
      !entry?.spell
    ) {
      return;
    }

    const button =
      document.getElementById(
        `huntSpellBtn-${entry.spell.id}`
      );

    if (
      !button ||
      button.disabled
    ) {
      return;
    }

    event.preventDefault();

    activateHuntSpell(
      Number(
        entry.spell.id
      )
    );
  }
);


function escapeHuntHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

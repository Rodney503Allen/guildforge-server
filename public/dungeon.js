// public/dungeon.js

let dungeonPlayerId =
  Number(
    window.__PLAYER_ID__
  ) || null;

let dungeonActive =
  null;

let dungeonEncounter =
  null;

let dungeonCombat =
  null;

let dungeonSpells =
  [];

let dungeonCombatPotions = {
  health:
    null,

  mana:
    null
};

let dungeonPotionCooldownEnds = {
  health:
    0,

  mana:
    0
};

let dungeonPotionCooldownTimer =
  null;

let dungeonPendingSpell =
  null;

let dungeonPollingTimer =
  null;

let dungeonBusy =
  false;

const DUNGEON_POLL_MS =
  650;


let dungeonInitialized =
  false;

let dungeonModalOpen =
  false;

/*
 * Client-side expedition log archive.
 *
 * Logs are grouped by dungeon room and persisted to sessionStorage
 * for the life of the browser tab. That means players can review
 * earlier rooms even after the backend combat session for that room
 * has been destroyed, and a page refresh will not immediately erase
 * the expedition history.
 */
let dungeonRoomLogs =
  {};

let dungeonRoomLastSnapshot =
  {};

let dungeonSelectedLogRoom =
  null;

let dungeonLogStorageKey =
  null;


/* =========================================================
   HELPERS
========================================================= */

function escapeDungeonHtml(
  value
) {
  return String(
    value ?? ""
  )
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}

function setDungeonText(
  id,
  value
) {
  const element =
    document.getElementById(
      id
    );

  if (element) {
    element.textContent =
      String(
        value ?? ""
      );
  }
}

function setDungeonPercent(
  id,
  percent
) {
  const element =
    document.getElementById(
      id
    );

  if (!element) {
    return;
  }

  const safe =
    Math.max(
      0,
      Math.min(
        100,
        Number(
          percent
        ) || 0
      )
    );

  element.style.width =
    `${safe}%`;
}

function ratioPercent(
  value,
  max
) {
  const maxValue =
    Math.max(
      1,
      Number(max) || 1
    );

  return (
    Math.max(
      0,
      Number(value) || 0
    ) /
    maxValue
  ) * 100;
}

function dungeonTooltipJson(
  value
) {
  if (value == null) {
    return "";
  }

  if (
    typeof value ===
    "string"
  ) {
    return value;
  }

  try {
    return JSON.stringify(
      value
    );
  } catch {
    return "";
  }
}


function resolveDungeonIcon(
  rawIcon
) {
  const raw =
    String(
      rawIcon || ""
    ).trim();

  if (!raw) {
    return "/icons/default.webp";
  }

  if (
    raw.startsWith(
      "http://"
    ) ||
    raw.startsWith(
      "https://"
    ) ||
    raw.startsWith("/")
  ) {
    return raw;
  }

  if (
    raw.startsWith(
      "icons/"
    )
  ) {
    return `/${raw}`;
  }

  return `/${raw}`;
}


function getDungeonEnemies() {
  if (
    Array.isArray(
      dungeonCombat?.enemies
    )
  ) {
    return dungeonCombat.enemies;
  }

  return dungeonCombat?.enemy
    ? [
        dungeonCombat.enemy
      ]
    : [];
}

function getSelectedDungeonEnemyId() {
  const selected =
    dungeonCombat?.selectedTargets?.[
      dungeonPlayerId
    ];

  if (
    Number.isFinite(
      Number(
        selected
      )
    )
  ) {
    return Number(
      selected
    );
  }

  const me =
    (
      dungeonCombat?.players ??
      []
    ).find(
      player =>
        Number(
          player.playerId
        ) ===
        Number(
          dungeonPlayerId
        )
    );

  if (
    Number.isFinite(
      Number(
        me?.selectedEnemyId
      )
    )
  ) {
    return Number(
      me.selectedEnemyId
    );
  }

  return Number(
    getDungeonEnemies()?.[0]
      ?.runtimeEnemyId ??
    0
  ) || null;
}

// =========================================================
// SMOOTH DUNGEON ATB TIMERS
// =========================================================
//
// Dungeon polling remains server-authoritative.
// Each snapshot gives us gauge + recoveryMs + readyInMs.
// requestAnimationFrame interpolates the visible bars between
// those snapshots so they move continuously like Hunt combat.

let dungeonTimingFrame =
  null;

let dungeonTimingRunning =
  false;

const dungeonCombatTiming = {
  enemies:
    new Map(),

  players:
    new Map()
};

function clampDungeonTimingPercent(
  value
) {
  return Math.max(
    0,
    Math.min(
      100,
      Number(
        value
      ) || 0
    )
  );
}

function makeDungeonATBAnchor(
  actor
) {
  if (!actor) {
    return null;
  }

  return {
    receivedAt:
      performance.now(),

    gauge:
      clampDungeonTimingPercent(
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
          actor.recoveryMs ??
          0
        ) || 0
      ),

    readyInMs:
      Math.max(
        0,
        Number(
          actor.readyInMs ??
          0
        ) || 0
      )
  };
}

function getSmoothDungeonATB(
  anchor,
  now
) {
  if (!anchor) {
    return {
      percent:
        0,

      ready:
        false
    };
  }

  if (
    anchor.ready
  ) {
    return {
      /*
       * The server owns the actual READY state.
       * Hold just under full so a consumed turn does not
       * visibly flash 100 -> 0 between snapshots.
       */
      percent:
        99,

      ready:
        true
    };
  }

  const elapsedMs =
    Math.max(
      0,
      now -
        anchor.receivedAt
    );

  /*
   * During recovery the gauge stays where the server
   * reported it. Once recovery ends, visually fill it
   * toward 100 using readyInMs as the timing anchor.
   */
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

  const predicted =
    anchor.gauge +
    (
      100 -
        anchor.gauge
    ) *
    progress;

  return {
    percent:
      Math.min(
        99,
        predicted
      ),

    ready:
      false
  };
}

function setDungeonTimingBar(
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
    `${clampDungeonTimingPercent(
      percent
    )}%`;
}

function syncDungeonTimingAnchors(
  combat
) {
  if (!combat) {
    return;
  }

  const activeEnemyIds =
    new Set();

  for (
    const enemy of
    (
      Array.isArray(
        combat.enemies
      )
        ? combat.enemies
        : []
    )
  ) {
    const enemyId =
      Number(
        enemy.runtimeEnemyId
      );

    if (
      !Number.isFinite(
        enemyId
      ) ||
      enemyId <= 0
    ) {
      continue;
    }

    activeEnemyIds.add(
      enemyId
    );

    dungeonCombatTiming
      .enemies
      .set(
        enemyId,
        makeDungeonATBAnchor(
          enemy
        )
      );
  }

  for (
    const enemyId of
    dungeonCombatTiming
      .enemies
      .keys()
  ) {
    if (
      !activeEnemyIds.has(
        enemyId
      )
    ) {
      dungeonCombatTiming
        .enemies
        .delete(
          enemyId
        );
    }
  }

  const activePlayerIds =
    new Set();

  for (
    const player of
    (
      Array.isArray(
        combat.players
      )
        ? combat.players
        : []
    )
  ) {
    const playerId =
      Number(
        player.playerId
      );

    if (
      !Number.isFinite(
        playerId
      ) ||
      playerId <= 0
    ) {
      continue;
    }

    activePlayerIds.add(
      playerId
    );

    dungeonCombatTiming
      .players
      .set(
        playerId,
        makeDungeonATBAnchor(
          player
        )
      );
  }

  for (
    const playerId of
    dungeonCombatTiming
      .players
      .keys()
  ) {
    if (
      !activePlayerIds.has(
        playerId
      )
    ) {
      dungeonCombatTiming
        .players
        .delete(
          playerId
        );
    }
  }

  startSmoothDungeonTimers();
}

function renderSmoothDungeonTimers() {
  if (
    !dungeonTimingRunning
  ) {
    dungeonTimingFrame =
      null;

    return;
  }

  const now =
    performance.now();

  // -----------------------
  // Enemy ATBs
  // -----------------------
  for (
    const [
      enemyId,
      anchor
    ] of
    dungeonCombatTiming
      .enemies
  ) {
    const visual =
      getSmoothDungeonATB(
        anchor,
        now
      );

    setDungeonTimingBar(
      `dungeonEnemyAtbBar-${enemyId}`,
      visual.percent
    );

    setDungeonText(
      `dungeonEnemyAtbText-${enemyId}`,
      anchor.ready
        ? "READY"
        : `${Math.round(
            visual.percent
          )}%`
    );
  }

  // -----------------------
  // Party ATBs
  // -----------------------
  for (
    const [
      playerId,
      anchor
    ] of
    dungeonCombatTiming
      .players
  ) {
    const visual =
      getSmoothDungeonATB(
        anchor,
        now
      );

    setDungeonTimingBar(
      `dungeonPartyAtbBar-${playerId}`,
      visual.percent
    );

    setDungeonText(
      `dungeonPartyAtbText-${playerId}`,
      anchor.ready
        ? "READY"
        : `${Math.round(
            visual.percent
          )}%`
    );

    /*
     * Keep the current player's action status smooth too.
     */
    if (
      Number(
        playerId
      ) ===
        Number(
          dungeonPlayerId
        ) &&
      dungeonEncounter &&
      (
        String(
          dungeonEncounter.phase
        ).toLowerCase() ===
          "trash" ||
        String(
          dungeonEncounter.phase
        ).toLowerCase() ===
          "boss"
      ) &&
      !dungeonPendingSpell
    ) {
      setDungeonText(
        "dungeonActionStatus",
        anchor.ready
          ? "Ready to act"
          : `ATB ${Math.round(
              visual.percent
            )}%`
      );
    }
  }

  dungeonTimingFrame =
    requestAnimationFrame(
      renderSmoothDungeonTimers
    );
}

function startSmoothDungeonTimers() {
  if (
    dungeonTimingRunning
  ) {
    return;
  }

  dungeonTimingRunning =
    true;

  dungeonTimingFrame =
    requestAnimationFrame(
      renderSmoothDungeonTimers
    );
}

function stopSmoothDungeonTimers() {
  dungeonTimingRunning =
    false;

  if (
    dungeonTimingFrame
  ) {
    cancelAnimationFrame(
      dungeonTimingFrame
    );

    dungeonTimingFrame =
      null;
  }

  dungeonCombatTiming
    .enemies
    .clear();

  dungeonCombatTiming
    .players
    .clear();
}


/* =========================================================
   INITIAL LOAD
========================================================= */

async function initializeDungeonPage() {
  if (
    dungeonInitialized
  ) {
    await refreshDungeonPage();
    startDungeonPolling();
    startSmoothDungeonTimers();
    return;
  }

  dungeonInitialized =
    true;

  try {
    await loadDungeonSpells();
    await loadDungeonCombatPotions();

    await refreshDungeonPage();

    startDungeonPolling();
  } catch (error) {
    dungeonInitialized =
      false;

    console.error(
      "Dungeon page initialization failed:",
      error
    );

    setDungeonText(
      "dungeonSubtitle",
      error?.message ||
      "Unable to load dungeon."
    );
  }
}

async function loadDungeonSpells() {
  const response =
    await fetch(
      "/combat/spells",
      {
        credentials:
          "include",
        cache:
          "no-store"
      }
    );

  const data =
    await response.json();

  if (
    !response.ok ||
    data.error
  ) {
    throw new Error(
      data.error ||
      "Unable to load abilities."
    );
  }

  const slots =
    Array.isArray(
      data.slots
    )
      ? data.slots
      : [];

  dungeonSpells =
    Array.from(
      {
        length: 6
      },
      (
        _,
        index
      ) => {
        const slotNumber =
          index + 1;

        const entry =
          slots.find(
            slot =>
              Number(
                slot.slot
              ) ===
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

  renderDungeonHotbar();
}


/* =========================================================
   ROOM COMBAT LOG ARCHIVE
========================================================= */

function getDungeonLogRoomOrder() {
  return Math.max(
    1,
    Number(
      dungeonEncounter?.roomOrder ??
      1
    ) || 1
  );
}

function getDungeonLogStorageKey() {
  const instanceId =
    Number(
      dungeonActive?.instanceId ??
      dungeonActive?.id ??
      dungeonCombat?.instanceId ??
      0
    );

  if (!instanceId) {
    return null;
  }

  return `guildforge:dungeon-room-logs:${instanceId}`;
}

function loadDungeonRoomLogs() {
  const nextKey =
    getDungeonLogStorageKey();

  if (!nextKey) {
    return;
  }

  if (
    dungeonLogStorageKey ===
      nextKey
  ) {
    return;
  }

  dungeonLogStorageKey =
    nextKey;

  dungeonRoomLogs =
    {};

  dungeonRoomLastSnapshot =
    {};

  dungeonSelectedLogRoom =
    null;

  try {
    const raw =
      sessionStorage.getItem(
        nextKey
      );

    if (raw) {
      const parsed =
        JSON.parse(
          raw
        );

      if (
        parsed &&
        typeof parsed ===
          "object"
      ) {
        dungeonRoomLogs =
          parsed;
      }
    }
  } catch (error) {
    console.warn(
      "Could not restore dungeon room logs:",
      error
    );
  }
}

function saveDungeonRoomLogs() {
  if (
    !dungeonLogStorageKey
  ) {
    return;
  }

  try {
    sessionStorage.setItem(
      dungeonLogStorageKey,
      JSON.stringify(
        dungeonRoomLogs
      )
    );
  } catch (error) {
    console.warn(
      "Could not save dungeon room logs:",
      error
    );
  }
}

function getDungeonLogOverlap(
  previous,
  current
) {
  const oldLines =
    Array.isArray(
      previous
    )
      ? previous
      : [];

  const newLines =
    Array.isArray(
      current
    )
      ? current
      : [];

  const maxOverlap =
    Math.min(
      oldLines.length,
      newLines.length
    );

  for (
    let size =
      maxOverlap;
    size > 0;
    size--
  ) {
    let matches =
      true;

    for (
      let i = 0;
      i < size;
      i++
    ) {
      if (
        oldLines[
          oldLines.length -
          size +
          i
        ] !==
        newLines[
          i
        ]
      ) {
        matches =
          false;

        break;
      }
    }

    if (matches) {
      return size;
    }
  }

  return 0;
}

function archiveDungeonCombatLog(
  lines
) {
  loadDungeonRoomLogs();

  const roomOrder =
    getDungeonLogRoomOrder();

  const normalized =
    Array.isArray(
      lines
    )
      ? lines.map(
          line =>
            String(
              line ??
              ""
            )
        )
      : [];

  if (
    !dungeonRoomLogs[
      roomOrder
    ]
  ) {
    dungeonRoomLogs[
      roomOrder
    ] =
      [];
  }

  const previousSnapshot =
    dungeonRoomLastSnapshot[
      roomOrder
    ] ??
    [];

  const overlap =
    getDungeonLogOverlap(
      previousSnapshot,
      normalized
    );

  const incoming =
    normalized.slice(
      overlap
    );

  if (
    incoming.length >
    0
  ) {
    dungeonRoomLogs[
      roomOrder
    ].push(
      ...incoming
    );

    /*
     * Keep a generous per-room cap so a long dungeon does not
     * grow sessionStorage forever.
     */
    if (
      dungeonRoomLogs[
        roomOrder
      ].length >
      300
    ) {
      dungeonRoomLogs[
        roomOrder
      ] =
        dungeonRoomLogs[
          roomOrder
        ].slice(
          -300
        );
    }

    saveDungeonRoomLogs();
  }

  dungeonRoomLastSnapshot[
    roomOrder
  ] =
    normalized.slice();

  if (
    dungeonSelectedLogRoom ==
    null
  ) {
    dungeonSelectedLogRoom =
      roomOrder;
  }

  /*
   * Automatically follow the newest room while the player
   * progresses. If they manually select an older tab, polling
   * leaves that selection alone.
   */
  if (
    !document
      .querySelector(
        ".dungeon-log-tab.is-manual"
      )
  ) {
    dungeonSelectedLogRoom =
      roomOrder;
  }
}

function ensureDungeonLogTabs() {
  const log =
    document.getElementById(
      "dungeonCombatLog"
    );

  if (!log) {
    return null;
  }

  const panel =
    log.closest(
      ".dungeon-log-panel"
    );

  if (!panel) {
    return null;
  }

  let tabs =
    panel.querySelector(
      "#dungeonLogTabs"
    );

  if (!tabs) {
    tabs =
      document.createElement(
        "div"
      );

    tabs.id =
      "dungeonLogTabs";

    tabs.className =
      "dungeon-log-tabs";

    panel.insertBefore(
      tabs,
      log
    );
  }

  return tabs;
}

function renderDungeonLogTabs() {
  const tabs =
    ensureDungeonLogTabs();

  if (!tabs) {
    return;
  }

  const currentRoom =
    getDungeonLogRoomOrder();

  const roomNumbers =
    Array.from(
      new Set([
        ...Object.keys(
          dungeonRoomLogs
        ).map(Number),
        currentRoom
      ])
    )
      .filter(
        room =>
          Number.isFinite(
            room
          ) &&
          room > 0
      )
      .sort(
        (a, b) =>
          a - b
      );

  tabs.innerHTML =
    roomNumbers.map(
      room => {
        const selected =
          Number(
            dungeonSelectedLogRoom ??
            currentRoom
          ) ===
          Number(
            room
          );

        const isCurrent =
          room ===
          currentRoom;

        return `
          <button
            type="button"
            class="dungeon-log-tab${
              selected
                ? " is-active"
                : ""
            }${
              isCurrent
                ? " is-current"
                : ""
            }"
            data-dungeon-log-room="${
              room
            }"
          >
            Room ${room}
            ${
              isCurrent
                ? `<span>Current</span>`
                : ""
            }
          </button>
        `;
      }
    ).join("");

  tabs
    .querySelectorAll(
      "[data-dungeon-log-room]"
    )
    .forEach(
      button => {
        button.addEventListener(
          "click",
          () => {
            dungeonSelectedLogRoom =
              Number(
                button.dataset
                  .dungeonLogRoom
              );

            /*
             * Mark the currently chosen button so automatic
             * polling does not force the player back to the
             * newest room while reviewing history.
             */
            tabs
              .querySelectorAll(
                ".dungeon-log-tab"
              )
              .forEach(
                tab =>
                  tab.classList.remove(
                    "is-manual"
                  )
              );

            button.classList.add(
              "is-manual"
            );

            renderDungeonLogTabs();
            renderSelectedDungeonRoomLog();
          }
        );
      }
    );
}

function renderSelectedDungeonRoomLog() {
  const root =
    document.getElementById(
      "dungeonCombatLog"
    );

  if (!root) {
    return;
  }

  const room =
    Number(
      dungeonSelectedLogRoom ??
      getDungeonLogRoomOrder()
    );

  const lines =
    dungeonRoomLogs[
      room
    ] ??
    [];

  root.innerHTML =
    lines.length
      ? lines.map(
          line =>
            `<div>${escapeDungeonHtml(
              line
            )}</div>`
        ).join("")
      : `
        <div class="dungeon-log-empty">
          No combat events recorded for Room ${room}.
        </div>
      `;

  root.scrollTop =
    root.scrollHeight;
}


/* =========================================================
   REFRESH
========================================================= */

async function refreshDungeonPage() {
  if (dungeonBusy) {
    return;
  }

  dungeonBusy =
    true;

  try {
    const [
      activeResponse,
      encounterResponse
    ] =
      await Promise.all([
        fetch(
          "/api/dungeons/active",
          {
            credentials:
              "include",
            cache:
              "no-store"
          }
        ),

        fetch(
          "/api/dungeons/active/encounter",
          {
            credentials:
              "include",
            cache:
              "no-store"
          }
        )
      ]);

    const activeData =
      await activeResponse.json();

    const encounterData =
      await encounterResponse.json();

    dungeonActive =
      activeData?.dungeon ??
      null;

    dungeonEncounter =
      encounterData?.encounter ??
      null;

    loadDungeonRoomLogs();

    if (!dungeonActive) {
      stopDungeonPolling();
      stopSmoothDungeonTimers();

      if (
        document.getElementById(
          "dungeonModal"
        )
      ) {
        closeDungeonModalView();

        if (
          typeof refreshWorld ===
          "function"
        ) {
          await refreshWorld();
        }
      } else {
        window.location.href =
          "/world";
      }

      return;
    }

    renderDungeonHeader();

    const phase =
      String(
        dungeonEncounter?.phase ??
        ""
      ).toLowerCase();

    if (
      phase === "trash" ||
      phase === "boss"
    ) {
      await refreshDungeonCombat();
    } else {
      dungeonCombat =
        null;

      stopSmoothDungeonTimers();

      renderDungeonCombatEmpty();

      await renderDungeonPhasePanel(
        phase
      );
    }
  } catch (error) {
    console.error(
      "Dungeon refresh failed:",
      error
    );

    setDungeonText(
      "dungeonActionStatus",
      error?.message ||
      "Unable to refresh dungeon."
    );
  } finally {
    dungeonBusy =
      false;
  }
}

async function refreshDungeonCombat() {
  const response =
    await fetch(
      "/api/dungeon-combat/state",
      {
        credentials:
          "include",
        cache:
          "no-store"
      }
    );

  const data =
    await response.json();

  if (
    !response.ok ||
    data.ok === false
  ) {
    throw new Error(
      data.error ||
      "Unable to load dungeon combat."
    );
  }

  dungeonCombat =
    data.combat ??
    null;

  if (dungeonCombat) {
    renderDungeonCombat(
      dungeonCombat
    );
  }

  await renderDungeonPhasePanel(
    String(
      dungeonEncounter?.phase ??
      ""
    ).toLowerCase()
  );
}


/* =========================================================
   HEADER / PROGRESS
========================================================= */

function renderDungeonHeader() {
  const dungeonName =
    dungeonActive?.dungeonName ??
    dungeonActive?.name ??
    "Dungeon";

  const roomOrder =
    Number(
      dungeonEncounter?.roomOrder ??
      1
    );

  const roomName =
    dungeonEncounter?.roomName ??
    `Room ${roomOrder}`;

  const wave =
    Number(
      dungeonEncounter?.wave ??
      1
    );

  const phase =
    String(
      dungeonEncounter?.phase ??
      "active"
    );

  setDungeonText(
    "dungeonTitle",
    dungeonName
  );

  setDungeonText(
    "dungeonSubtitle",
    roomName
  );

  setDungeonText(
    "dungeonRoomTitle",
    `Room ${roomOrder} — ${roomName}`
  );

  setDungeonText(
    "dungeonWaveText",
    phase === "trash"
      ? `Trash Wave ${wave} of 3`
      : phase === "boss"
        ? "Boss Encounter"
        : phase === "loot"
          ? "Boss Loot"
          : phase === "rest"
            ? "Rest & Prepare"
            : phase === "complete"
              ? "Dungeon Complete"
              : phase
  );

  setDungeonText(
    "dungeonPhaseBadge",
    phase
  );

  renderDungeonRoomSteps(
    roomOrder,
    phase
  );
}

function renderDungeonRoomSteps(
  currentRoom,
  phase
) {
  const root =
    document.getElementById(
      "dungeonRoomSteps"
    );

  if (!root) {
    return;
  }

  root.innerHTML =
    Array.from(
      {
        length: 4
      },
      (
        _,
        index
      ) => {
        const room =
          index + 1;

        let state =
          "";

        if (
          room <
          currentRoom
        ) {
          state =
            " is-complete";
        } else if (
          room ===
          currentRoom
        ) {
          state =
            " is-current";
        }

        return `
          <div
            class="dungeon-room-step${state}"
          >
            <span>
              ${room <
              currentRoom
                ? "✓"
                : room}
            </span>

            <small>
              Room ${room}
            </small>
          </div>
        `;
      }
    ).join("");
}


/* =========================================================
   DUNGEON STATUS / MECHANIC VISUALS
========================================================= */

let dungeonLastMechanicSequences =
  new Map();

function formatDungeonEffectSeconds(
  ms
) {
  const seconds =
    Math.max(
      0,
      Number(
        ms
      ) || 0
    ) /
    1000;

  if (
    seconds >= 10
  ) {
    return String(
      Math.ceil(
        seconds
      )
    );
  }

  return seconds
    .toFixed(1)
    .replace(
      /\.0$/,
      ""
    );
}

function dungeonStatusEmojiForStat(
  stat
) {
  const key =
    String(
      stat ||
      ""
    )
      .trim()
      .toLowerCase();

  const icons = {
    attack:
      "⚔️",

    defense:
      "🛡️",

    agility:
      "💨",

    vitality:
      "❤️",

    intellect:
      "✨",

    crit:
      "🎯",

    attack_speed_pct:
      "⏳",

    damage_dealt_pct:
      "⚔️",

    damage_taken_pct:
      "💥",

    spell_damage_taken_pct:
      "🔮",

    judgment:
      "⚖️",

    poisoned:
      "☠️",
  };

  return (
    icons[
      key
    ] ||
    "🕸️"
  );
}

function dungeonBuffEmoji(
  stat
) {
  const key =
    String(
      stat ||
      ""
    )
      .trim()
      .toLowerCase();

  const icons = {
    attack:
      "⚔️",

    defense:
      "🛡️",

    agility:
      "💨",

    vitality:
      "❤️",

    intellect:
      "✨",

    crit:
      "🎯",

    damage_reduction:
      "🛡️",

    damage_dealt_pct:
      "🔥",

    healing_received:
      "💚",

    maxhp:
      "❤️",

    maxspoints:
      "🔷",
  };

  return (
    icons[
      key
    ] ||
    "✨"
  );
}

function renderDungeonHoverTooltip(
  title,
  emoji,
  description,
  rows = []
) {
  return `
    <div class="dungeon-hover-tooltip">
      <div class="dungeon-hover-tooltip__title">
        <span>
          ${emoji}
        </span>

        ${escapeDungeonHtml(
          title
        )}
      </div>

      ${
        description
          ? `
            <div class="dungeon-hover-tooltip__description">
              ${escapeDungeonHtml(
                description
              )}
            </div>
          `
          : ""
      }

      ${
        rows.length
          ? `
            <div class="dungeon-hover-tooltip__rows">
              ${
                rows.map(
                  row => `
                    <div class="dungeon-hover-tooltip__row">
                      <span>
                        ${escapeDungeonHtml(
                          row.label
                        )}
                      </span>

                      <strong>
                        ${escapeDungeonHtml(
                          row.value
                        )}
                      </strong>
                    </div>
                  `
                ).join("")
              }
            </div>
          `
          : ""
      }
    </div>
  `;
}

function renderDungeonMechanicStrip(
  enemy
) {
  const abilities =
    Array.isArray(
      enemy?.mechanic
        ?.abilities
    )
      ? enemy.mechanic
          .abilities
      : [];

  if (
    abilities.length ===
    0
  ) {
    return "";
  }

  return `
    <div class="dungeon-status-group dungeon-mechanics">
      <div class="dungeon-status-label">
        Mechanics
      </div>

      <div class="dungeon-icon-strip">
        ${
          abilities.map(
            ability => {
              let stateClass =
                "is-ready";

              let badge =
                "READY";

              if (
                ability.casting
              ) {
                stateClass =
                  "is-casting";

                badge =
                  "CAST";
              } else if (
                ability.exhausted
              ) {
                stateClass =
                  "is-exhausted";

                badge =
                  "DONE";
              } else if (
                !ability.hpEligible
              ) {
                stateClass =
                  "is-locked";

                badge =
                  "HP";
              } else if (
                Number(
                  ability.availableInMs
                ) > 0
              ) {
                stateClass =
                  "is-cooldown";

                badge =
                  `${formatDungeonEffectSeconds(
                    ability.availableInMs
                  )}s`;
              } else if (
                Number(
                  ability.cooldownRemainingMs
                ) > 0
              ) {
                stateClass =
                  "is-cooldown";

                badge =
                  `${formatDungeonEffectSeconds(
                    ability.cooldownRemainingMs
                  )}s`;
              }

              return `
                <div
                  class="dungeon-status-icon dungeon-status-icon--mechanic ${stateClass}"
                  tabindex="0"
                >
                  <span class="dungeon-status-icon__emoji">
                    ⚠️
                  </span>

                  <span class="dungeon-status-icon__badge">
                    ${escapeDungeonHtml(
                      badge
                    )}
                  </span>

                  ${renderDungeonHoverTooltip(
                    ability.name ||
                    "Enemy Mechanic",
                    "⚠️",
                    ability.description ||
                    "",
                    [
                      {
                        label:
                          "Cast",
                        value:
                          `${(
                            Math.max(
                              0,
                              Number(
                                ability.castTimeMs
                              ) || 0
                            ) /
                            1000
                          ).toFixed(1)}s`,
                      },
                      {
                        label:
                          "Cooldown",
                        value:
                          `${(
                            Math.max(
                              0,
                              Number(
                                ability.cooldownMs
                              ) || 0
                            ) /
                            1000
                          ).toFixed(1)}s`,
                      },
                      {
                        label:
                          "Interrupt",
                        value:
                          ability.interruptible
                            ? "Yes"
                            : "No",
                      },
                    ]
                  )}
                </div>
              `;
            }
          ).join("")
        }
      </div>
    </div>
  `;
}

function renderDungeonEnemyEffects(
  enemy
) {
  const dots =
    Array.isArray(
      enemy?.effects?.dots
    )
      ? enemy.effects.dots
      : [];

  const debuffs =
    Array.isArray(
      enemy?.effects?.debuffs
    )
      ? enemy.effects.debuffs
      : [];

  if (
    dots.length === 0 &&
    debuffs.length === 0
  ) {
    return "";
  }

  const icons = [
    ...dots.map(
      dot => ({
        emoji:
          "🔥",

        title:
          dot.spellName ||
          "Damage Over Time",

        badge:
          `${formatDungeonEffectSeconds(
            dot.remainingMs
          )}s`,

        description:
          `Periodic damage (${dot.ticksApplied}/${dot.totalTicks} ticks).`,
      })
    ),

    ...debuffs.map(
      debuff => ({
        emoji:
          dungeonStatusEmojiForStat(
            debuff.stat
          ),

        title:
          debuff.spellName ||
          debuff.stat ||
          "Debuff",

        badge:
          `${formatDungeonEffectSeconds(
            debuff.remainingMs
          )}s`,

        description:
          `${String(
            debuff.stat ||
            "effect"
          ).replaceAll(
            "_",
            " "
          )}: ${Number(
            debuff.value ??
            0
          )}`,
      })
    ),
  ];

  return `
    <div class="dungeon-status-group dungeon-enemy-effects">
      <div class="dungeon-status-label">
        Effects
      </div>

      <div class="dungeon-icon-strip">
        ${
          icons.map(
            effect => `
              <div
                class="dungeon-status-icon dungeon-status-icon--debuff"
                tabindex="0"
              >
                <span class="dungeon-status-icon__emoji">
                  ${effect.emoji}
                </span>

                <span class="dungeon-status-icon__badge">
                  ${escapeDungeonHtml(
                    effect.badge
                  )}
                </span>

                ${renderDungeonHoverTooltip(
                  effect.title,
                  effect.emoji,
                  effect.description
                )}
              </div>
            `
          ).join("")
        }
      </div>
    </div>
  `;
}

function renderDungeonPlayerBuffs(
  player
) {
  const buffs =
    Array.isArray(
      player?.buffs
    )
      ? player.buffs
      : [];

  if (
    buffs.length ===
    0
  ) {
    return "";
  }

  return `
    <div class="dungeon-buffs">
      <div class="dungeon-buffs__label">
        Buffs
      </div>

      <div class="dungeon-icon-strip">
        ${
          buffs.map(
            buff => {
              const emoji =
                dungeonBuffEmoji(
                  buff.stat
                );

              const value =
                Number(
                  buff.value ??
                  0
                );

              return `
                <div
                  class="dungeon-status-icon dungeon-status-icon--buff"
                  tabindex="0"
                >
                  <span class="dungeon-status-icon__emoji">
                    ${emoji}
                  </span>

                  <span class="dungeon-status-icon__badge">
                    ${formatDungeonEffectSeconds(
                      buff.remainingMs
                    )}s
                  </span>

                  ${renderDungeonHoverTooltip(
                    String(
                      buff.stat ||
                      "Buff"
                    ).replaceAll(
                      "_",
                      " "
                    ),
                    emoji,
                    buff.source
                      ? `Source: ${buff.source}`
                      : "Active combat buff",
                    [
                      {
                        label:
                          "Value",
                        value:
                          value > 0
                            ? `+${value}`
                            : String(
                                value
                              ),
                      },
                    ]
                  )}
                </div>
              `;
            }
          ).join("")
        }
      </div>
    </div>
  `;
}


/* =========================================================
   COMBAT
========================================================= */

function renderDungeonCombat(
  combat
) {
  renderDungeonEnemies(
    combat
  );

  renderDungeonParty(
    combat.players ??
    []
  );

  syncDungeonTimingAnchors(
    combat
  );

  renderDungeonLog(
    combat.log ??
    []
  );

  const mechanicEnemy =
    (
      combat.enemies ??
      []
    ).find(
      enemy =>
        enemy?.mechanic
          ?.activeCast
    ) ??
    combat.enemy ??
    null;

  renderDungeonMechanic(
    mechanicEnemy?.mechanic ??
    null,
    mechanicEnemy?.runtimeEnemyId ??
    null
  );

  renderDungeonHotbar();

  const me =
    (
      combat.players ??
      []
    ).find(
      player =>
        Number(
          player.playerId
        ) ===
        Number(
          dungeonPlayerId
        )
    );

  if (me) {
    setDungeonText(
      "dungeonActionStatus",
      me.ready
        ? "Ready to act"
        : `ATB ${Math.round(
            Number(
              me.gauge
            ) || 0
          )}%`
    );
  }
}

function renderDungeonEnemies(
  combat
) {
  const panel =
    document.querySelector(
      ".dungeon-enemy-panel"
    );

  if (!panel) {
    return;
  }

  const enemies =
    Array.isArray(
      combat?.enemies
    )
      ? combat.enemies
      : (
          combat?.enemy
            ? [
                combat.enemy
              ]
            : []
        );

  const selectedEnemyId =
    getSelectedDungeonEnemyId();

  panel.innerHTML =
    `
      <div class="dungeon-panel-header">
        <div>
          <div class="dungeon-section-label">
            Active Enemies
          </div>

          <div class="dungeon-panel-meta">
            ${
              enemies.length
            } remaining
          </div>
        </div>

        <div class="dungeon-target-hint">
          Click an enemy to target it
        </div>
      </div>

      <div
        class="dungeon-enemy-grid"
        id="dungeonEnemyGrid"
      >
        ${
          enemies.length
            ? enemies.map(
                enemy =>
                  renderDungeonEnemyCard(
                    enemy,
                    Number(
                      enemy.runtimeEnemyId
                    ) ===
                    Number(
                      selectedEnemyId
                    )
                  )
              ).join("")
            : `
              <div class="dungeon-empty-state">
                No active enemies.
              </div>
            `
        }
      </div>
    `;

  panel
    .querySelectorAll(
      "[data-dungeon-enemy-id]"
    )
    .forEach(
      card => {
        card.addEventListener(
          "click",
          () => {
            selectDungeonEnemy(
              Number(
                card.dataset.dungeonEnemyId
              )
            );
          }
        );
      }
    );
}

function renderDungeonEnemyCard(
  enemy,
  selected
) {
  const hpPercent =
    ratioPercent(
      enemy.hp,
      enemy.maxHp
    );

  const gauge =
    Math.max(
      0,
      Math.min(
        100,
        Number(
          enemy.gauge
        ) || 0
      )
    );

  return `
    <button
      type="button"
      class="dungeon-enemy-card${
        selected
          ? " is-selected"
          : ""
      }"
      data-dungeon-enemy-id="${
        Number(
          enemy.runtimeEnemyId
        )
      }"
    >
      <div class="dungeon-enemy-card__target">
        ${
          selected
            ? "YOUR TARGET"
            : "SELECT TARGET"
        }
      </div>

      <div class="dungeon-enemy-card__visual">
        <img
          src="${escapeDungeonHtml(
            enemy.image ||
            "/images/default_creature.png"
          )}"
          alt=""
          onerror="this.src='/images/default_creature.png'"
        >
      </div>

      <div class="dungeon-enemy-card__content">
        <div class="dungeon-enemy-card__title">
          <strong>
            ${escapeDungeonHtml(
              enemy.name ||
              "Enemy"
            )}
          </strong>

          <span>
            Lv. ${
              Number(
                enemy.level
              ) || "—"
            }
          </span>
        </div>

        <div class="dungeon-enemy-card__description">
          ${escapeDungeonHtml(
            enemy.description ||
            ""
          )}
        </div>

        ${renderDungeonMechanicStrip(
          enemy
        )}

        ${renderDungeonEnemyEffects(
          enemy
        )}

        <div class="dungeon-meter-row">
          <div class="dungeon-meter-label">
            <span>
              Health
            </span>
            <span>
              ${
                enemy.hp ?? 0
              } / ${
                enemy.maxHp ?? 0
              }
            </span>
          </div>

          <div class="dungeon-meter">
            <div
              class="dungeon-meter-fill dungeon-meter-fill--hp"
              style="width:${hpPercent}%"
            ></div>
          </div>
        </div>

        <div class="dungeon-meter-row">
          <div class="dungeon-meter-label">
            <span>
              Action Timer
            </span>
            <span
              id="dungeonEnemyAtbText-${
                Number(
                  enemy.runtimeEnemyId
                )
              }"
            >
              ${
                enemy.ready
                  ? "READY"
                  : `${Math.round(
                      gauge
                    )}%`
              }
            </span>
          </div>

          <div class="dungeon-meter">
            <div
              id="dungeonEnemyAtbBar-${
                Number(
                  enemy.runtimeEnemyId
                )
              }"
              class="dungeon-meter-fill dungeon-meter-fill--atb"
              style="width:${gauge}%"
            ></div>
          </div>
        </div>

        ${
          enemy.mechanic
            ?.activeCast
            ? `
              <div class="dungeon-enemy-card__casting">
                ⚠ Casting ${
                  escapeDungeonHtml(
                    enemy.mechanic
                      .activeCast
                      .name ||
                    "Ability"
                  )
                }
              </div>
            `
            : ""
        }
      </div>
    </button>
  `;
}

async function selectDungeonEnemy(
  runtimeEnemyId
) {
  if (
    dungeonBusy ||
    !runtimeEnemyId
  ) {
    return;
  }

  dungeonBusy =
    true;

  try {
    const response =
      await fetch(
        "/api/dungeon-combat/target",
        {
          method:
            "POST",

          credentials:
            "include",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              targetEnemyId:
                runtimeEnemyId
            })
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      data.ok === false
    ) {
      throw new Error(
        data.error ||
        "Unable to select target."
      );
    }

    if (
      data.snapshot
    ) {
      dungeonCombat =
        data.snapshot;

      renderDungeonCombat(
        data.snapshot
      );
    }
  } catch (error) {
    console.error(
      "Dungeon target selection failed:",
      error
    );

    setDungeonText(
      "dungeonActionStatus",
      error?.message ||
      "Unable to select target."
    );
  } finally {
    dungeonBusy =
      false;
  }
}

function renderDungeonCombatEmpty() {
  const panel =
    document.querySelector(
      ".dungeon-enemy-panel"
    );

  if (panel) {
    panel.innerHTML =
      `
        <div class="dungeon-panel-header">
          <div class="dungeon-section-label">
            Active Enemies
          </div>
        </div>

        <div class="dungeon-empty-state">
          No active enemies.
        </div>
      `;
  }

  renderDungeonMechanic(
    null
  );
}

function renderDungeonParty(
  players
) {
  const root =
    document.getElementById(
      "dungeonPartyList"
    );

  if (!root) {
    return;
  }

  root.innerHTML =
    players.map(
      player => {
        const isMe =
          Number(
            player.playerId
          ) ===
          Number(
            dungeonPlayerId
          );

        const targetable =
          Boolean(
            dungeonPendingSpell
          ) &&
          player.hp > 0;

        return `
          <button
            class="dungeon-party-member${
              isMe
                ? " is-you"
                : ""
            }${
              targetable
                ? " is-targetable"
                : ""
            }"
            type="button"
            data-player-id="${
              Number(
                player.playerId
              )
            }"
            ${
              targetable
                ? ""
                : "disabled"
            }
          >
            <div class="dungeon-party-member__top">
              <strong>
                ${escapeDungeonHtml(
                  player.name
                )}
              </strong>

              <span>
                Threat ${
                  Math.round(
                    Number(
                      player.threat
                    ) || 0
                  )
                }
              </span>
            </div>

            <div class="dungeon-party-stat">
              <span>
                HP ${
                  player.hp
                } / ${
                  player.maxHp
                }
              </span>
              <div class="dungeon-mini-meter">
                <div
                  class="dungeon-mini-fill dungeon-mini-fill--hp"
                  style="width:${
                    ratioPercent(
                      player.hp,
                      player.maxHp
                    )
                  }%"
                ></div>
              </div>
            </div>

            <div class="dungeon-party-stat">
              <span>
                SP ${
                  player.sp
                } / ${
                  player.maxSp
                }
              </span>
              <div class="dungeon-mini-meter">
                <div
                  class="dungeon-mini-fill dungeon-mini-fill--sp"
                  style="width:${
                    ratioPercent(
                      player.sp,
                      player.maxSp
                    )
                  }%"
                ></div>
              </div>
            </div>

            <div class="dungeon-party-stat">
              <span>
                ATB
                <span
                  id="dungeonPartyAtbText-${
                    Number(
                      player.playerId
                    )
                  }"
                >
                  ${
                    player.ready
                      ? "READY"
                      : `${Math.round(
                          Number(
                            player.gauge
                          ) || 0
                        )}%`
                  }
                </span>
              </span>
              <div class="dungeon-mini-meter">
                <div
                  id="dungeonPartyAtbBar-${
                    Number(
                      player.playerId
                    )
                  }"
                  class="dungeon-mini-fill dungeon-mini-fill--atb"
                  style="width:${
                    Number(
                      player.gauge
                    ) || 0
                  }%"
                ></div>
              </div>
            </div>

            ${renderDungeonPlayerBuffs(
              player
            )}
          </button>
        `;
      }
    ).join("");

  root
    .querySelectorAll(
      ".dungeon-party-member.is-targetable"
    )
    .forEach(
      button => {
        button.addEventListener(
          "click",
          () => {
            const playerId =
              Number(
                button.dataset.playerId
              );

            if (
              playerId &&
              dungeonPendingSpell
            ) {
              castDungeonSpell(
                dungeonPendingSpell.id,
                playerId
              );
            }
          }
        );
      }
    );
}

function renderDungeonLog(
  lines
) {
  archiveDungeonCombatLog(
    lines
  );

  /*
   * If the player is watching the current room, keep following
   * the newest entries. Older room tabs remain frozen for review.
   */
  const currentRoom =
    getDungeonLogRoomOrder();

  const selectedRoom =
    Number(
      dungeonSelectedLogRoom ??
      currentRoom
    );

  if (
    selectedRoom ===
    currentRoom
  ) {
    dungeonSelectedLogRoom =
      currentRoom;
  }

  renderDungeonLogTabs();
  renderSelectedDungeonRoomLog();
}

function renderDungeonMechanic(
  mechanic,
  runtimeEnemyId =
    null
) {
  const warning =
    document.getElementById(
      "dungeonEnemyCast"
    );

  const cast =
    mechanic?.activeCast ??
    null;

  if (
    !warning ||
    !cast
  ) {
    warning?.classList.add(
      "hidden"
    );

    return;
  }

  warning.classList.remove(
    "hidden"
  );

  const mechanicSequence =
    Number(
      mechanic?.sequence ??
      0
    );

  const sequenceKey =
    String(
      runtimeEnemyId ??
      "enemy"
    );

  const previousSequence =
    Number(
      dungeonLastMechanicSequences.get(
        sequenceKey
      ) ??
      0
    );

  if (
    mechanicSequence >
    previousSequence
  ) {
    warning.classList.remove(
      "is-alerting"
    );

    void warning.offsetWidth;

    warning.classList.add(
      "is-alerting"
    );

    dungeonLastMechanicSequences.set(
      sequenceKey,
      mechanicSequence
    );
  }

  setDungeonText(
    "dungeonCastName",
    cast.name ??
    "Incoming Attack"
  );

  const totalMs =
    Math.max(
      1,
      Number(
        cast.totalMs
      ) || 1
    );

  const remainingMs =
    Math.max(
      0,
      Number(
        cast.remainingMs
      ) || 0
    );

  setDungeonText(
    "dungeonCastTime",
    `${(
      remainingMs /
      1000
    ).toFixed(1)}s`
  );

  setDungeonPercent(
    "dungeonCastBar",
    (
      1 -
      remainingMs /
      totalMs
    ) *
    100
  );

  const targets =
    Array.isArray(
      cast.targetPlayerIds
    )
      ? cast.targetPlayerIds
      : [];

  const targetNames =
    (
      dungeonCombat?.players ??
      []
    )
      .filter(
        player =>
          targets.includes(
            Number(
              player.playerId
            )
          )
      )
      .map(
        player =>
          player.name
      );

  setDungeonText(
    "dungeonCastTargets",
    targetNames.length
      ? `Target${
          targetNames.length >
          1
            ? "s"
            : ""
        }: ${
          targetNames.join(
            ", "
          )
        }`
      : "Prepare to react"
  );

  const interrupt =
    document.getElementById(
      "dungeonCastInterrupt"
    );

  if (interrupt) {
    interrupt.textContent =
      cast.interruptible
        ? "Interruptible"
        : "Cannot Be Interrupted";

    interrupt.classList.toggle(
      "is-interruptible",
      Boolean(
        cast.interruptible
      )
    );
  }
}


/* =========================================================
   POTIONS
========================================================= */

function resolveDungeonItemIcon(
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
    raw.startsWith(
      "http://"
    ) ||
    raw.startsWith(
      "https://"
    ) ||
    raw.startsWith("/")
  ) {
    return raw;
  }

  return raw.startsWith(
    "icons/"
  )
    ? `/${raw}`
    : `/icons/${raw}`;
}

function renderDungeonPotionSlot(
  slot
) {
  const potion =
    dungeonCombatPotions[
      slot
    ];

  const health =
    slot ===
    "health";

  const key =
    health
      ? "Q"
      : "E";

  const label =
    health
      ? "Health Potion"
      : "Mana Potion";

  const effectLabel =
    health
      ? "HP"
      : "SP";

  if (!potion) {
    return `
      <button
        class="dungeon-spell-slot dungeon-potion-slot empty"
        type="button"
        disabled
      >
        <span class="dungeon-spell-empty">
          ✦
        </span>

        <span class="dungeon-spell-key">
          ${key}
        </span>

        <div class="dungeon-spell-tooltip">
          <strong>
            ${label}
          </strong>

          <span>
            No potion equipped
          </span>
        </div>
      </button>
    `;
  }

  const amount =
    Math.max(
      0,
      Number(
        potion.effect_value
      ) || 0
    );

  const quantity =
    Math.max(
      0,
      Number(
        potion.qty
      ) || 0
    );

  return `
    <button
      id="dungeonPotionBtn-${slot}"
      class="dungeon-spell-slot dungeon-potion-slot"
      type="button"
      data-dungeon-potion-slot="${slot}"
      ${
        quantity > 0
          ? ""
          : "disabled"
      }
    >
      <img
        src="${escapeDungeonHtml(
          resolveDungeonItemIcon(
            potion.icon
          )
        )}"
        alt=""
        onerror="this.src='/icons/default.webp'"
      >

      <span class="dungeon-spell-key">
        ${key}
      </span>

      <span class="dungeon-potion-quantity">
        ${quantity}
      </span>

      <div
        id="dungeonPotionCooldown-${slot}"
        class="dungeon-spell-cooldown hidden"
      ></div>

      <div class="dungeon-spell-tooltip">
        <strong>
          ${escapeDungeonHtml(
            potion.name ||
            label
          )}
        </strong>

        <span>
          Restores ${amount} ${effectLabel}
        </span>

        <span>
          20s cooldown
        </span>
      </div>
    </button>
  `;
}

async function loadDungeonCombatPotions() {
  try {
    const response =
      await fetch(
        "/api/dungeon-combat/potions",
        {
          credentials:
            "include",
          cache:
            "no-store"
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      data.ok === false
    ) {
      throw new Error(
        data.error ||
        "Unable to load potions."
      );
    }

    dungeonCombatPotions = {
      health:
        data.health ||
        null,

      mana:
        data.mana ||
        null
    };

    const now =
      Date.now();

    dungeonPotionCooldownEnds.health =
      now +
      Math.max(
        0,
        Number(
          data.cooldowns
            ?.health
        ) || 0
      );

    dungeonPotionCooldownEnds.mana =
      now +
      Math.max(
        0,
        Number(
          data.cooldowns
            ?.mana
        ) || 0
      );

    renderDungeonHotbar();
    startDungeonPotionCooldownTimer();
  } catch (error) {
    console.error(
      "Failed to load Dungeon potions:",
      error
    );

    dungeonCombatPotions = {
      health:
        null,

      mana:
        null
    };

    renderDungeonHotbar();
  }
}

function startDungeonPotionCooldownTimer() {
  if (
    dungeonPotionCooldownTimer
  ) {
    return;
  }

  dungeonPotionCooldownTimer =
    window.setInterval(
      updateDungeonPotionCooldownDisplay,
      200
    );
}

function stopDungeonPotionCooldownTimer() {
  if (
    !dungeonPotionCooldownTimer
  ) {
    return;
  }

  clearInterval(
    dungeonPotionCooldownTimer
  );

  dungeonPotionCooldownTimer =
    null;
}

function updateDungeonPotionCooldownDisplay() {
  const now =
    Date.now();

  const phase =
    String(
      dungeonEncounter?.phase ??
      ""
    ).toLowerCase();

  const activeCombat =
    phase === "trash" ||
    phase === "boss";

  for (
    const slot of
    [
      "health",
      "mana"
    ]
  ) {
    const button =
      document.getElementById(
        `dungeonPotionBtn-${slot}`
      );

    const cooldown =
      document.getElementById(
        `dungeonPotionCooldown-${slot}`
      );

    if (
      !button ||
      !cooldown
    ) {
      continue;
    }

    const remainingMs =
      Math.max(
        0,
        dungeonPotionCooldownEnds[
          slot
        ] -
        now
      );

    const coolingDown =
      remainingMs >
      0;

    const potion =
      dungeonCombatPotions[
        slot
      ];

    button.classList.toggle(
      "is-cooldown",
      coolingDown
    );

    button.disabled =
      coolingDown ||
      !activeCombat ||
      !potion ||
      Number(
        potion.qty
      ) <= 0;

    cooldown.classList.toggle(
      "hidden",
      !coolingDown
    );

    cooldown.textContent =
      coolingDown
        ? String(
            Math.ceil(
              remainingMs /
              1000
            )
          )
        : "";
  }
}

async function useDungeonCombatPotion(
  slot
) {
  if (
    slot !== "health" &&
    slot !== "mana"
  ) {
    return;
  }

  if (
    Date.now() <
    dungeonPotionCooldownEnds[
      slot
    ]
  ) {
    return;
  }

  /*
   * Optimistic display. The server remains authoritative and
   * returns remainingMs if another surface already used the potion.
   */
  dungeonPotionCooldownEnds[
    slot
  ] =
    Date.now() +
    20_000;

  updateDungeonPotionCooldownDisplay();

  try {
    const response =
      await fetch(
        "/api/dungeon-combat/potions/use",
        {
          method:
            "POST",

          credentials:
            "include",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              slot
            })
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      data.ok === false
    ) {
      const remainingMs =
        Math.max(
          0,
          Number(
            data.remainingMs
          ) || 0
        );

      dungeonPotionCooldownEnds[
        slot
      ] =
        remainingMs > 0
          ? Date.now() +
            remainingMs
          : 0;

      updateDungeonPotionCooldownDisplay();

      throw new Error(
        data.error ===
          "cooldown"
          ? "That potion is still on cooldown."
          : data.error ||
            "Unable to use potion."
      );
    }

    dungeonPotionCooldownEnds[
      slot
    ] =
      Date.now() +
      Math.max(
        0,
        Number(
          data.cooldownMs
        ) ||
        20_000
      );

    if (
      data.snapshot
    ) {
      dungeonCombat =
        data.snapshot;

      renderDungeonCombat(
        data.snapshot
      );
    }

    await loadDungeonCombatPotions();

  } catch (error) {
    console.error(
      "Dungeon potion use failed:",
      error
    );

    setDungeonText(
      "dungeonActionStatus",
      error?.message ||
      "Unable to use potion."
    );
  }
}

window.useDungeonCombatPotion =
  useDungeonCombatPotion;


/* =========================================================
   SPELLS
========================================================= */

function renderDungeonHotbar() {
  const root =
    document.getElementById(
      "dungeonSpellHotbar"
    );

  if (!root) {
    return;
  }

  const phase =
    String(
      dungeonEncounter?.phase ??
      ""
    );

  const me =
    (
      dungeonCombat?.players ??
      []
    ).find(
      player =>
        Number(
          player.playerId
        ) ===
        Number(
          dungeonPlayerId
        )
    );

  const spellHtml =
    dungeonSpells.map(
      entry => {
        const spell =
          entry.spell;

        if (!spell) {
          return `
            <button
              class="dungeon-spell-slot empty"
              disabled
            >
              <span class="dungeon-spell-key">
                ${entry.slot}
              </span>
              <span class="dungeon-spell-empty">
                ✦
              </span>
            </button>
          `;
        }

        const cooldownKey =
          `spell:${
            spell.id
          }`;

        const cooldownUntil =
          Number(
            me?.cooldowns?.[
              cooldownKey
            ] ??
            0
          );

        const remainingMs =
          Math.max(
            0,
            cooldownUntil -
            Date.now()
          );

        const manaCost =
          Math.max(
            0,
            Number(
              spell.mana_cost ??
              0
            )
          );

        const disabled =
          phase !== "trash" &&
          phase !== "boss" ||
          !me ||
          !me.ready ||
          me.hp <= 0 ||
          me.sp <
            manaCost ||
          remainingMs >
            0;

        return `
          <button
            class="dungeon-spell-slot${
              me?.ready &&
              remainingMs <=
              0
                ? " is-ready"
                : ""
            }"
            type="button"
            data-spell-id="${
              Number(
                spell.id
              )
            }"
            ${
              disabled
                ? "disabled"
                : ""
            }
          >
            <img
              src="${escapeDungeonHtml(
                resolveDungeonIcon(
                  spell.icon
                )
              )}"
              alt=""
              onerror="this.src='/icons/default.webp'"
            >

            <span class="dungeon-spell-key">
              ${entry.slot}
            </span>

            ${
              remainingMs >
              0
                ? `
                  <span class="dungeon-spell-cooldown">
                    ${Math.ceil(
                      remainingMs /
                      1000
                    )}
                  </span>
                `
                : ""
            }

            <div class="dungeon-spell-tooltip">
              <strong>
                ${escapeDungeonHtml(
                  spell.name
                )}
              </strong>

              <span>
                ${escapeDungeonHtml(
                  spell.description ??
                  ""
                )}
              </span>

              <span>
                ${manaCost} SP
              </span>
            </div>
          </button>
        `;
      }
    ).join("");

  root.innerHTML =
    renderDungeonPotionSlot(
      "health"
    ) +
    spellHtml +
    renderDungeonPotionSlot(
      "mana"
    );

  root
    .querySelectorAll(
      "[data-dungeon-potion-slot]"
    )
    .forEach(
      button => {
        button.addEventListener(
          "click",
          () => {
            useDungeonCombatPotion(
              button.dataset
                .dungeonPotionSlot
            );
          }
        );
      }
    );

  updateDungeonPotionCooldownDisplay();

  root
    .querySelectorAll(
      "[data-spell-id]"
    )
    .forEach(
      button => {
        button.addEventListener(
          "click",
          () => {
            const spellId =
              Number(
                button.dataset.spellId
              );

            const spell =
              dungeonSpells
                .map(
                  entry =>
                    entry.spell
                )
                .find(
                  candidate =>
                    Number(
                      candidate?.id
                    ) ===
                    spellId
                );

            if (spell) {
              handleDungeonSpellClick(
                spell
              );
            }
          }
        );
      }
    );
}

function handleDungeonSpellClick(
  spell
) {
  const targetType =
    String(
      spell.target_type ??
      spell.target ??
      "enemy"
    )
      .trim()
      .toLowerCase();

  if (
    targetType ===
    "ally"
  ) {
    dungeonPendingSpell =
      spell;

    document
      .getElementById(
        "dungeonTargetPrompt"
      )
      ?.classList.remove(
        "hidden"
      );

    setDungeonText(
      "dungeonActionStatus",
      `Choose a target for ${
        spell.name
      }`
    );

    renderDungeonParty(
      dungeonCombat?.players ??
      []
    );

    return;
  }

  castDungeonSpell(
    Number(
      spell.id
    ),
    targetType ===
      "self"
      ? dungeonPlayerId
      : null
  );
}

async function castDungeonSpell(
  spellId,
  targetPlayerId =
    null
) {
  const targetEnemyId =
    getSelectedDungeonEnemyId();
  if (dungeonBusy) {
    return;
  }

  dungeonBusy =
    true;

  try {
    const response =
      await fetch(
        "/api/dungeon-combat/spell",
        {
          method:
            "POST",

          credentials:
            "include",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              spellId,
              targetPlayerId,
              targetEnemyId
            })
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      data.ok === false
    ) {
      throw new Error(
        data.error ||
        "Unable to cast ability."
      );
    }

    dungeonPendingSpell =
      null;

    document
      .getElementById(
        "dungeonTargetPrompt"
      )
      ?.classList.add(
        "hidden"
      );

    /*
     * Match normal combat / Hunt spell audio.
     *
     * Audio is emitted only after the Dungeon server accepts the cast,
     * so rejected casts never play their spell sound.
     */
    const castSpellEntry =
      dungeonSpells.find(
        entry =>
          Number(
            entry.spell?.id
          ) ===
          Number(
            spellId
          )
      );

    const castSpellData =
      castSpellEntry?.spell ??
      null;

    if (
      castSpellData?.audio &&
      window.GFSpellEvents
        ?.emitCast
    ) {
      window.GFSpellEvents.emitCast(
        castSpellData
      );
    }

    if (
      data.snapshot
    ) {
      dungeonCombat =
        data.snapshot;

      renderDungeonCombat(
        data.snapshot
      );
    }
  } catch (error) {
    console.error(
      "Dungeon spell failed:",
      error
    );

    setDungeonText(
      "dungeonActionStatus",
      error?.message ||
      "Unable to cast."
    );
  } finally {
    dungeonBusy =
      false;
  }
}


/* =========================================================
   PHASE PANELS
========================================================= */

async function renderDungeonPhasePanel(
  phase
) {
  const panel =
    document.getElementById(
      "dungeonPhasePanel"
    );

  if (!panel) {
    return;
  }

  if (
    phase === "trash" ||
    phase === "boss"
  ) {
    panel.classList.add(
      "hidden"
    );

    return;
  }

  panel.classList.remove(
    "hidden"
  );

  if (
    phase === "loot"
  ) {
    await renderDungeonLootPanel(
      panel
    );

    return;
  }

  if (
    phase === "rest"
  ) {
    await renderDungeonRestPanel(
      panel
    );

    return;
  }

  if (
    phase === "complete"
  ) {
    await renderDungeonCompletePanel(
      panel
    );

    return;
  }

  panel.innerHTML =
    `
      <div class="dungeon-phase-card">
        <div class="dungeon-section-label">
          Expedition
        </div>
        <h3>
          ${escapeDungeonHtml(
            phase ||
            "Waiting"
          )}
        </h3>
      </div>
    `;
}

async function renderDungeonLootPanel(
  panel
) {
  const response =
    await fetch(
      "/api/dungeons/active/loot",
      {
        credentials:
          "include",
        cache:
          "no-store"
      }
    );

  const data =
    await response.json();

  const rolls =
    data?.loot?.rolls ??
    [];

  panel.innerHTML =
    `
      <div class="dungeon-phase-card">
        <div class="dungeon-section-label">
          Boss Loot
        </div>

        <h3>
          Choose your claim
        </h3>

        <p>
          Need takes priority over Greed.
          Pass forfeits your roll.
        </p>

        <div class="dungeon-loot-list">
          ${
            rolls.length
              ? rolls.map(
                  renderDungeonLootRoll
                ).join("")
              : `
                <div class="dungeon-empty-state">
                  No boss loot remains.
                </div>
              `
          }
        </div>
      </div>
    `;

  panel
    .querySelectorAll(
      "[data-loot-choice]"
    )
    .forEach(
      button => {
        button.addEventListener(
          "click",
          async () => {
            await submitDungeonLootChoice(
              Number(
                button.dataset.rollId
              ),
              button.dataset.lootChoice
            );
          }
        );
      }
    );
}

function renderDungeonLootRoll(
  roll
) {
  const resolved =
    roll.status !==
    "open";

  const tooltipRollJson =
    dungeonTooltipJson(
      roll.rollJson
    );

  return `
    <article
      class="dungeon-loot-card"
      data-tooltip="item"
      tabindex="0"
      aria-label="${escapeDungeonHtml(
        roll.name
      )}"
      data-name="${escapeDungeonHtml(
        roll.name
      )}"
      data-rarity="${escapeDungeonHtml(
        roll.rarity ||
        "awakened"
      )}"
      data-qty="${Number(
        roll.quantity ||
        1
      )}"
      data-item-level="${Number(
        roll.itemLevel ||
        1
      )}"
      data-slot="${escapeDungeonHtml(
        roll.slot ||
        ""
      )}"
      data-item-type="${escapeDungeonHtml(
        roll.itemType ||
        ""
      )}"
      data-armor-weight="${escapeDungeonHtml(
        roll.armorWeight ||
        ""
      )}"
      data-base-attack="${Number(
        roll.baseAttack ||
        0
      )}"
      data-base-defense="${Number(
        roll.baseDefense ||
        0
      )}"
      data-roll-json="${escapeDungeonHtml(
        tooltipRollJson
      )}"
      data-desc="Dungeon boss reward"
    >
      <div class="dungeon-loot-icon">
        <img
          src="${escapeDungeonHtml(
            resolveDungeonIcon(
              roll.icon
            )
          )}"
          alt=""
          onerror="this.src='/icons/default.webp'"
        >
      </div>

      <div class="dungeon-loot-copy">
        <strong>
          ${escapeDungeonHtml(
            roll.name
          )}
        </strong>

        <span>
          ${
            roll.itemLevel
              ? `Item Level ${
                  roll.itemLevel
                }`
              : ""
          }
        </span>

        <small>
          ${
            resolved
              ? (
                  roll.winnerPlayerId
                    ? `Won by player #${
                        roll.winnerPlayerId
                      } — ${
                        roll.winningChoice
                      } ${
                        roll.winningRoll
                      }`
                    : "Everyone passed"
                )
              : `${
                  roll.choiceCount
                } / ${
                  roll.eligibleCount
                } choices submitted`
          }
        </small>
      </div>

      <div class="dungeon-loot-actions">
        ${
          roll.myChoice
            ? `
              <span class="dungeon-choice-made">
                ${
                  escapeDungeonHtml(
                    roll.myChoice
                  )
                } ${
                  roll.myRoll ??
                  ""
                }
              </span>
            `
            : resolved
              ? ""
              : `
                <button
                  class="dungeon-btn dungeon-btn--need"
                  data-roll-id="${
                    roll.id
                  }"
                  data-loot-choice="need"
                >
                  Need
                </button>

                <button
                  class="dungeon-btn dungeon-btn--greed"
                  data-roll-id="${
                    roll.id
                  }"
                  data-loot-choice="greed"
                >
                  Greed
                </button>

                <button
                  class="dungeon-btn dungeon-btn--ghost"
                  data-roll-id="${
                    roll.id
                  }"
                  data-loot-choice="pass"
                >
                  Pass
                </button>
              `
        }
      </div>
    </article>
  `;
}

async function submitDungeonLootChoice(
  rollId,
  choice
) {
  const response =
    await fetch(
      `/api/dungeons/active/loot/${
        rollId
      }/choice`,
      {
        method:
          "POST",

        credentials:
          "include",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            choice
          })
      }
    );

  const data =
    await response.json();

  if (
    !response.ok ||
    data.ok === false
  ) {
    throw new Error(
      data.error ||
      "Unable to submit loot choice."
    );
  }

  await refreshDungeonPage();
}

async function renderDungeonRestPanel(
  panel
) {
  const wipeResponse =
    await fetch(
      "/api/dungeons/active/wipe",
      {
        credentials:
          "include",
        cache:
          "no-store"
      }
    );

  const wipeData =
    await wipeResponse.json();

  const wipe =
    wipeData?.wipe ??
    null;

  if (wipe) {
    panel.innerHTML =
      `
        <div class="dungeon-phase-card dungeon-phase-card--danger">
          <div class="dungeon-section-label">
            Party Defeated
          </div>

          <h3>
            ${
              escapeDungeonHtml(
                wipe.roomName
              )
            } must be attempted again
          </h3>

          <p>
            Your party has recovered enough to regroup.
            Retrying resets this room to Wave 1.
          </p>

          ${
            wipe.canRetry
              ? `
                <button
                  id="dungeonRetryBtn"
                  class="dungeon-btn dungeon-btn--primary"
                  type="button"
                >
                  Retry Room
                </button>
              `
              : `
                <div class="dungeon-waiting">
                  Waiting for the dungeon leader...
                </div>
              `
          }
        </div>
      `;

    document
      .getElementById(
        "dungeonRetryBtn"
      )
      ?.addEventListener(
        "click",
        retryDungeonRoom
      );

    return;
  }

  panel.innerHTML =
    `
      <div class="dungeon-phase-card">
        <div class="dungeon-section-label">
          Rest & Prepare
        </div>

        <h3>
          The path ahead is quiet... for now.
        </h3>

        <p>
          Recover, adjust your loadout, and prepare for the next room.
        </p>

        <button
          id="dungeonAdvanceBtn"
          class="dungeon-btn dungeon-btn--primary"
          type="button"
        >
          Continue Expedition
        </button>
      </div>
    `;

  document
    .getElementById(
      "dungeonAdvanceBtn"
    )
    ?.addEventListener(
      "click",
      advanceDungeonRoom
    );
}

async function retryDungeonRoom() {
  const response =
    await fetch(
      "/api/dungeons/active/wipe/retry",
      {
        method:
          "POST",
        credentials:
          "include"
      }
    );

  const data =
    await response.json();

  if (
    !response.ok ||
    data.ok === false
  ) {
    throw new Error(
      data.error ||
      "Unable to retry room."
    );
  }

  await refreshDungeonPage();
}

async function advanceDungeonRoom() {
  const response =
    await fetch(
      "/api/dungeons/active/rest/advance",
      {
        method:
          "POST",
        credentials:
          "include"
      }
    );

  const data =
    await response.json();

  if (
    !response.ok ||
    data.ok === false
  ) {
    throw new Error(
      data.error ||
      "Unable to advance dungeon."
    );
  }

  if (
    data.transition ===
    "complete"
  ) {
    stopDungeonPolling();

    await renderDungeonCompletePanel(
      document.getElementById(
        "dungeonPhasePanel"
      )
    );

    return;
  }

  await refreshDungeonPage();
}

async function renderDungeonCompletePanel(
  panel
) {
  if (!panel) {
    return;
  }

  const response =
    await fetch(
      "/api/dungeons/completion-chest",
      {
        credentials:
          "include",
        cache:
          "no-store"
      }
    );

  const data =
    await response.json();

  const chest =
    data?.chest ??
    null;

  panel.classList.remove(
    "hidden"
  );

  panel.innerHTML =
    `
      <div class="dungeon-phase-card dungeon-phase-card--victory">
        <div class="dungeon-section-label">
          Dungeon Complete
        </div>

        <h3>
          The Stormvault Bastion has been conquered.
        </h3>

        <p>
          Your expedition survives the depths of the mountain.
        </p>

        ${
          chest
            ? `
              <div class="dungeon-chest">
                <div class="dungeon-chest-icon">
                  🎁
                </div>

                <div>
                  <strong>
                    Personal Dungeon Chest
                  </strong>

                  <span>
                    ${
                      chest.rewards?.length ??
                      0
                    } reward${
                      (
                        chest.rewards?.length ??
                        0
                      ) === 1
                        ? ""
                        : "s"
                    }
                  </span>
                </div>

                ${
                  chest.status ===
                  "claimed"
                    ? `
                      <span class="dungeon-choice-made">
                        Claimed
                      </span>
                    `
                    : `
                      <button
                        id="dungeonClaimChestBtn"
                        class="dungeon-btn dungeon-btn--primary"
                        type="button"
                      >
                        Claim Chest
                      </button>
                    `
                }
              </div>
            `
            : ""
        }

        <button
          id="dungeonReturnWorldBtn"
          class="dungeon-btn dungeon-btn--ghost"
          type="button"
        >
          Return to World
        </button>
      </div>
    `;

  document
    .getElementById(
      "dungeonClaimChestBtn"
    )
    ?.addEventListener(
      "click",
      async () => {
        await claimDungeonChest(
          chest.id
        );
      }
    );

  document
    .getElementById(
      "dungeonReturnWorldBtn"
    )
    ?.addEventListener(
      "click",
      async () => {
        if (
          document.getElementById(
            "dungeonModal"
          )
        ) {
          closeDungeonModalView();

          if (
            typeof refreshWorld ===
            "function"
          ) {
            await refreshWorld();
          }
        } else {
          window.location.href =
            "/world";
        }
      }
    );
}

async function claimDungeonChest(
  chestId
) {
  const response =
    await fetch(
      `/api/dungeons/completion-chest/${
        chestId
      }/claim`,
      {
        method:
          "POST",
        credentials:
          "include"
      }
    );

  const data =
    await response.json();

  if (
    !response.ok ||
    data.ok === false
  ) {
    throw new Error(
      data.error ||
      "Unable to claim chest."
    );
  }

  await renderDungeonCompletePanel(
    document.getElementById(
      "dungeonPhasePanel"
    )
  );
}


/* =========================================================
   MODAL LIFECYCLE
========================================================= */

async function openDungeonModal() {
  const modal =
    document.getElementById(
      "dungeonModal"
    );

  if (!modal) {
    /*
     * Standalone /dungeon fallback.
     */
    await initializeDungeonPage();
    return;
  }

  modal.classList.remove(
    "hidden"
  );

  document.body.classList.add(
    "dungeon-modal-open"
  );

  dungeonModalOpen =
    true;

  await initializeDungeonPage();
}

function closeDungeonModalView() {
  const modal =
    document.getElementById(
      "dungeonModal"
    );

  if (modal) {
    modal.classList.add(
      "hidden"
    );
  }

  document.body.classList.remove(
    "dungeon-modal-open"
  );

  dungeonModalOpen =
    false;

  stopDungeonPolling();
  stopSmoothDungeonTimers();
  stopDungeonPotionCooldownTimer();

  dungeonPendingSpell =
    null;

  document
    .getElementById(
      "dungeonTargetPrompt"
    )
    ?.classList.add(
      "hidden"
    );
}

window.openDungeonModal =
  openDungeonModal;

window.closeDungeonModalView =
  closeDungeonModalView;


/* =========================================================
   POLLING / EVENTS
========================================================= */

function startDungeonPolling() {
  if (
    dungeonPollingTimer
  ) {
    return;
  }

  dungeonPollingTimer =
    window.setInterval(
      refreshDungeonPage,
      DUNGEON_POLL_MS
    );
}

function stopDungeonPolling() {
  if (
    dungeonPollingTimer
  ) {
    clearInterval(
      dungeonPollingTimer
    );

    dungeonPollingTimer =
      null;
  }
}

async function abandonDungeonFromPage() {
  const confirmed =
    window.confirm(
      "Abandon this dungeon? Your current dungeon progress will be lost."
    );

  if (!confirmed) {
    return;
  }

  stopDungeonPolling();

  const button =
    document.getElementById(
      "dungeonLeaveBtn"
    );

  if (button) {
    button.disabled =
      true;

    button.textContent =
      "Abandoning...";
  }

  try {
    const response =
      await fetch(
        "/api/dungeons/abandon",
        {
          method:
            "POST",
          credentials:
            "include"
        }
      );

    const text =
      await response.text();

    let data =
      {};

    try {
      data =
        text
          ? JSON.parse(text)
          : {};
    } catch {
      data = {};
    }

    if (
      !response.ok ||
      data.ok === false
    ) {
      throw new Error(
        data.error ||
        "Unable to abandon dungeon."
      );
    }

    if (
      dungeonLogStorageKey
    ) {
      try {
        sessionStorage.removeItem(
          dungeonLogStorageKey
        );
      } catch {
        // Non-fatal.
      }
    }

    dungeonRoomLogs =
      {};

    dungeonRoomLastSnapshot =
      {};

    dungeonLogStorageKey =
      null;

    if (
      document.getElementById(
        "dungeonModal"
      )
    ) {
      closeDungeonModalView();

      if (
        typeof refreshWorld ===
        "function"
      ) {
        await refreshWorld();
      }
    } else {
      window.location.href =
        "/world";
    }

  } catch (error) {
    console.error(
      "Dungeon abandon failed:",
      error
    );

    if (button) {
      button.disabled =
        false;

      button.textContent =
        "Abandon Dungeon";
    }

    startDungeonPolling();

    window.alert(
      error?.message ||
      "Unable to abandon dungeon."
    );
  }
}

document
  .getElementById(
    "dungeonLeaveBtn"
  )
  ?.addEventListener(
    "click",
    abandonDungeonFromPage
  );

document
  .getElementById(
    "dungeonCancelTargetBtn"
  )
  ?.addEventListener(
    "click",
    () => {
      dungeonPendingSpell =
        null;

      document
        .getElementById(
          "dungeonTargetPrompt"
        )
        ?.classList.add(
          "hidden"
        );

      renderDungeonParty(
        dungeonCombat?.players ??
        []
      );
    }
  );

document.addEventListener(
  "keydown",
  event => {
    if (
      event.target instanceof
        HTMLInputElement ||
      event.target instanceof
        HTMLTextAreaElement
    ) {
      return;
    }

    const pressedKey =
      String(
        event.key ||
        ""
      ).toLowerCase();

    if (
      pressedKey ===
      "q"
    ) {
      useDungeonCombatPotion(
        "health"
      );

      return;
    }

    if (
      pressedKey ===
      "e"
    ) {
      useDungeonCombatPotion(
        "mana"
      );

      return;
    }

    const key =
      Number(
        event.key
      );

    if (
      Number.isInteger(
        key
      ) &&
      key >= 1 &&
      key <= 6
    ) {
      const entry =
        dungeonSpells[
          key - 1
        ];

      if (
        entry?.spell
      ) {
        handleDungeonSpellClick(
          entry.spell
        );
      }
    }

    if (
      event.key ===
      "Escape" &&
      dungeonPendingSpell
    ) {
      dungeonPendingSpell =
        null;

      document
        .getElementById(
          "dungeonTargetPrompt"
        )
        ?.classList.add(
          "hidden"
        );

      renderDungeonParty(
        dungeonCombat?.players ??
        []
      );
    }
  }
);

window.addEventListener(
  "beforeunload",
  () => {
    stopDungeonPolling();
    stopSmoothDungeonTimers();
    stopDungeonPotionCooldownTimer();
  }
);

/*
 * Standalone /dungeon still works as a fallback.
 * On /world, the dungeon opens only when openDungeonModal() is called.
 */
if (
  !document.getElementById(
    "dungeonModal"
  )
) {
  initializeDungeonPage();
}

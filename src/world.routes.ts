import path from "path";
import { readFile } from "fs/promises";
//world.routes.ts
import express from "express";
import { db } from "./db";
import { trySpawnEnemy, spawnSpecificWorldEventEnemy } from "./services/spawnService";
import {
  getWorldEventSpawnAtTile,
  recordPlayerWorldEventSpawnInteraction
} from "./services/worldEventSpawnService";
import { recordWorldEventProgress } from "./services/worldEventProgressService";
import { applyInteractProgress, applyDestroyObjectProgress, applyEnterAreaProgress, applyLocationProgress, acceptQuest, claimQuestRewards } from "./services/questService";
import { maybeSpawnResourceNodeForPlayer } from "./services/gatheringSpawnService";
import { advanceHuntObjective } from "./huntService";
import { publishHuntReadyCheck } from "./huntSocket";
import { getHuntReadyCheck } from "./services/huntReadyCheckService";
import { advanceTutorial, TutorialStep } from "./services/tutorialService";
import {
  getOnlinePlayerIds,
  publishWorldPlayerMoved,
} from "./socketServer";


const router = express.Router();

const directions: Record<string, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  west: [-1, 0],
  east: [1, 0]
};
const ENCOUNTER_CHANCE = 0.18;     // independent roll on every eligible step

// Active quest target metadata changes much less often than player movement.
// Keep a short-lived per-player cache so rapid movement does not repeat the
// same multi-join quest query on every tile.
const QUEST_TARGET_CACHE_TTL_MS = 5000;
const activeQuestWorldTargetCache = new Map<number, {
  expiresAt: number;
  rows: any[];
}>();

function invalidateActiveQuestWorldTargetCache(playerId: number) {
  activeQuestWorldTargetCache.delete(Number(playerId));
}

function normalizeSpritePath(src?: string | null) {
  if (!src) return null;
  return src.startsWith("/") ? src : `/${src}`;
}


const WORLD_PARTY_CACHE_TTL_MS = 10000;
const worldPartyMemberCache = new Map<number, { expiresAt: number; ids: number[] }>();

async function getWorldPartyMemberIds(
  playerId: number
) {
  const cached = worldPartyMemberCache.get(Number(playerId));
  if (cached && cached.expiresAt > Date.now()) return cached.ids;

  const [rows]: any =
    await db.query(
      `
        SELECT DISTINCT
          other_pm.player_id

        FROM party_members self_pm

        JOIN party_members other_pm
          ON other_pm.party_id =
             self_pm.party_id

        WHERE self_pm.player_id = ?
      `,
      [playerId]
    );

  const ids = (rows || [])
    .map((row: any) => Number(row.player_id))
    .filter((memberId: number) => Number.isInteger(memberId) && memberId > 0);

  worldPartyMemberCache.set(Number(playerId), {
    expiresAt: Date.now() + WORLD_PARTY_CACHE_TTL_MS,
    ids
  });

  return ids;
}


async function getNearbyWorldPlayers(
  viewerPlayerId: number,
  centerX: number,
  centerY: number,
  radius = 5
) {
  const [rows]: any =
    await db.query(
      `
        SELECT
          p.id,
          p.name,
          p.level,
          p.map_x,
          p.map_y,

          CASE
            WHEN viewer_pm.party_id IS NOT NULL
             AND other_pm.party_id = viewer_pm.party_id
            THEN 1
            ELSE 0
          END AS is_party_member

        FROM players p

        LEFT JOIN party_members viewer_pm
          ON viewer_pm.player_id = ?

        LEFT JOIN party_members other_pm
          ON other_pm.player_id = p.id

        WHERE p.id <> ?
          AND p.map_x BETWEEN ? AND ?
          AND p.map_y BETWEEN ? AND ?

        ORDER BY
          is_party_member DESC,
          p.name ASC
      `,
      [
        viewerPlayerId,
        viewerPlayerId,
        centerX - radius,
        centerX + radius,
        centerY - radius,
        centerY + radius
      ]
    );

  const onlinePlayerIds =
    getOnlinePlayerIds();

  /*
   * A player should only appear once even if old party membership rows exist.
   * Prefer the party-marked copy when duplicates are encountered.
   */
  const byPlayerId =
    new Map<number, any>();

  for (const row of rows || []) {
    const playerId =
      Number(row.id);

    if (
      !Number.isInteger(playerId) ||
      playerId <= 0 ||
      !onlinePlayerIds.has(
        playerId
      )
    ) {
      continue;
    }

    const candidate = {
      id: playerId,
      name: String(
        row.name ||
        "Adventurer"
      ),
      level: Math.max(
        1,
        Number(row.level) || 1
      ),
      map_x:
        Number(row.map_x),
      map_y:
        Number(row.map_y),
      isPartyMember:
        Number(
          row.is_party_member
        ) === 1
    };

    const existing =
      byPlayerId.get(
        playerId
      );

    if (
      !existing ||
      candidate.isPartyMember
    ) {
      byPlayerId.set(
        playerId,
        candidate
      );
    }
  }

  return Array.from(
    byPlayerId.values()
  );
}

function buildWorldObjectMap(rows: any[]) {
  const map = new Map<string, any[]>();

  for (const row of rows || []) {
    const key = `${Number(row.x)},${Number(row.y)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  }

  for (const [, list] of map) {
    list.sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0));
  }

  return map;
}

function getTileVisualData(
  tile: any,
  x: number,
  y: number,
  objectMap: Map<string, any[]>
) {
  const key = `${x},${y}`;
  const objects = objectMap.get(key) || [];

  let replaceSprite: string | null = null;
  const overlays: string[] = [];

  for (const obj of objects) {
    const sprite = normalizeSpritePath(obj.tile_sprite);
    const visualType = String(obj.tile_visual_type || "none");

    if (!sprite || visualType === "none") continue;

    if (visualType === "replace") {
      replaceSprite = sprite;
    } else if (visualType === "overlay") {
      overlays.push(sprite);
    }
  }

  return {
    replaceSprite,
    overlays
  };
}

async function getResourceNodesInRange(playerId: number, centerX: number, centerY: number, range = 5){
  const [rows]: any = await db.query(
    `
    SELECT
      srn.id AS spawnedNodeId,
      srn.map_x,
      srn.map_y,
      srn.remaining_uses,

      rn.name AS nodeName,
      rn.description,
      rn.image,
      rn.required_level,
      rn.rarity,
      rn.base_gather_time_ms,

      p.name AS professionName,

      a.name AS affixName
    FROM spawned_resource_nodes srn
    JOIN resource_nodes rn ON rn.id = srn.node_id
    JOIN professions p ON p.id = rn.profession_id
    LEFT JOIN resource_node_affixes a ON a.id = srn.affix_id
    WHERE srn.player_id = ?
      AND srn.remaining_uses > 0
      AND (srn.despawns_at IS NULL OR srn.despawns_at > NOW())
      AND srn.map_x BETWEEN ? AND ?
      AND srn.map_y BETWEEN ? AND ?
    ORDER BY srn.id ASC
    `,
    [
      playerId,
      centerX - range,
      centerX + range,
      centerY - range,
      centerY + range
    ]
  );

  return rows;
}

async function getHuntTargetsInRange(
  playerId: number,
  centerX: number,
  centerY: number,
  range = 5
) {
  const [rows]: any =
    await db.query(
      `
        SELECT
          ph.id AS party_hunt_id,
          ph.target_map_x,
          ph.target_map_y,
          ph.status,

          h.name AS hunt_name,

          ht.id AS hunt_target_id,
          ht.name AS target_name,
          ht.description,
          ht.image

          FROM party_members pm

          JOIN party_hunts ph
            ON ph.party_id =
              pm.party_id

          JOIN hunt_participants hp
            ON hp.party_hunt_id =
              ph.id
          AND hp.player_id =
              pm.player_id

          JOIN hunts h
            ON h.id =
              ph.hunt_id
        JOIN hunt_targets ht
          ON ht.hunt_id =
             h.id

        WHERE pm.player_id = ?

          AND ph.target_revealed = 1

          AND ph.status IN (
            'revealed',
            'engaged'
          )

          AND ph.target_map_x
            BETWEEN ? AND ?

          AND ph.target_map_y
            BETWEEN ? AND ?

        ORDER BY
          ph.accepted_at DESC

        LIMIT 1
      `,
      [
        playerId,

        centerX - range,
        centerX + range,

        centerY - range,
        centerY + range
      ]
    );

  return (rows || []).map(
    (row: any) => {

      const x =
        Number(
          row.target_map_x
        );

      const y =
        Number(
          row.target_map_y
        );

      const distance =
        Math.abs(
          centerX - x
        ) +
        Math.abs(
          centerY - y
        );

      return {
        id:
          Number(
            row.party_hunt_id
          ),

        partyHuntId:
          Number(
            row.party_hunt_id
          ),

        huntTargetId:
          Number(
            row.hunt_target_id
          ),

        name:
          String(
            row.target_name ||
            "Hunt Target"
          ),

        huntName:
          String(
            row.hunt_name ||
            "Hunt"
          ),

        description:
          row.description ?? null,

        image:
          row.image ?? null,

        object_type:
          "hunt_target",

        x,
        y,

        interaction_radius: 0,

        distance,

        inRange:
          distance === 0,

        status:
          String(
            row.status
          )
      };
    }
  );
}


async function getWorldEventInteractSpawnsInRange(
  playerId: number,
  centerX: number,
  centerY: number,
  range = 5
) {
  const [rows]: any = await db.query(
    `
      SELECT
        aws.id,
        aws.active_event_id,
        aws.spawn_definition_id,
        aws.x,
        aws.y,

        ws.spawn_key,
        ws.icon,
        ws.target_id,

        awe.region_id,

        we.name AS event_name,
        wep.name AS phase_name,

        weo.description AS objective_description

      FROM active_world_event_spawns aws

      JOIN active_world_events awe
        ON awe.id = aws.active_event_id

      JOIN world_event_spawns ws
        ON ws.id = aws.spawn_definition_id

      JOIN world_event_phases wep
        ON wep.id = awe.phase_id
       AND wep.id = ws.phase_id

      JOIN world_events we
        ON we.id = awe.event_id

      LEFT JOIN world_event_objectives weo
        ON weo.phase_id = wep.id
       AND UPPER(weo.objective_type) = 'INTERACT'
       AND weo.target_id = ws.id

      WHERE aws.spawn_type = 'INTERACT'
        AND aws.state = 'ACTIVE'
        AND aws.removed_at IS NULL
        AND awe.status = 'ACTIVE'
        AND awe.ends_at > NOW()

        /* This physical spawn is reusable globally, but only once per player. */
        AND NOT EXISTS (
          SELECT 1
          FROM player_world_event_spawn_interactions pwesi
          WHERE pwesi.active_event_id = aws.active_event_id
            AND pwesi.player_id = ?
            AND pwesi.spawn_id = aws.id
        )

        /*
         * Once the player commits to an outcome in THIS phase, all remaining
         * contribution interactables disappear for that player. A later phase
         * is unaffected because the chosen outcome belongs to the old phase.
         */
        AND NOT EXISTS (
          SELECT 1
          FROM player_world_event_state pwes
          JOIN world_event_outcomes chosen_outcome
            ON chosen_outcome.id = pwes.chosen_outcome_id
          WHERE pwes.active_event_id = aws.active_event_id
            AND pwes.player_id = ?
            AND pwes.chosen_outcome_id IS NOT NULL
            AND chosen_outcome.phase_id = awe.phase_id
        )

        AND aws.x BETWEEN ? AND ?
        AND aws.y BETWEEN ? AND ?

      ORDER BY aws.id ASC
    `,
    [
      playerId,
      playerId,
      centerX - range,
      centerX + range,
      centerY - range,
      centerY + range
    ]
  );

  return (rows || []).map((row: any) => {
    const x = Number(row.x);
    const y = Number(row.y);

    const distance =
      Math.abs(centerX - x) +
      Math.abs(centerY - y);

    const spawnKey =
      String(row.spawn_key || "");

    const name =
      spawnKey
        .split("_")
        .filter(Boolean)
        .map(
          (part: string) =>
            part.charAt(0).toUpperCase() +
            part.slice(1)
        )
        .join(" ") ||
      "World Event Discovery";

    return {
      id: Number(row.id),
      worldEventSpawnId: Number(row.id),
      spawnDefinitionId: Number(row.spawn_definition_id),
      activeEventId: Number(row.active_event_id),

      name,
      object_type: "world_event_interact",

      eventName: String(row.event_name || "World Event"),
      phaseName: String(row.phase_name || ""),
      description: row.objective_description ?? null,

      regionId: Number(row.region_id),

      x,
      y,

      interaction_radius: 0,
      distance,
      inRange: distance === 0,

      icon:
        String(
          row.icon ||
          (
            spawnKey === "unstable_sigil_fragment"
              ? "💠"
              : spawnKey === "resonance_trace"
                ? "🌀"
                : "❗"
          )
        ),

      spawnKey
    };
  });
}


/*
 * World-event MAP markers.
 *
 * This is intentionally separate from getWorldEventInteractSpawnsInRange().
 * The interact helper feeds the Nearby panel and must contain only things the
 * player can click. This helper feeds the tile renderer and includes event
 * creatures/bosses as well as interactables.
 */
async function getWorldEventMapSpawnsInRange(
  playerId: number,
  centerX: number,
  centerY: number,
  range = 5
) {
  const [rows]: any = await db.query(
    `
      SELECT
        aws.id,
        aws.active_event_id,
        aws.spawn_definition_id,
        aws.spawn_type,
        aws.x,
        aws.y,

        ws.spawn_key,
        ws.icon,
        ws.target_id,

        awe.region_id,

        we.name AS event_name,
        wep.name AS phase_name,

        c.name AS creature_name

      FROM active_world_event_spawns aws

      JOIN active_world_events awe
        ON awe.id = aws.active_event_id

      JOIN world_event_spawns ws
        ON ws.id = aws.spawn_definition_id

      JOIN world_event_phases wep
        ON wep.id = awe.phase_id
       AND wep.id = ws.phase_id

      JOIN world_events we
        ON we.id = awe.event_id

      LEFT JOIN creatures c
        ON c.id = ws.target_id
       AND UPPER(aws.spawn_type) IN ('CREATURE', 'BOSS')

      WHERE aws.state = 'ACTIVE'
        AND aws.removed_at IS NULL
        AND awe.status = 'ACTIVE'
        AND awe.ends_at > NOW()

        /*
         * INTERACT spawns disappear for this player after that exact physical
         * spawn has been used. Creature/Boss markers remain globally visible.
         */
        AND (
          UPPER(aws.spawn_type) <> 'INTERACT'
          OR NOT EXISTS (
            SELECT 1
            FROM player_world_event_spawn_interactions pwesi
            WHERE pwesi.active_event_id = aws.active_event_id
              AND pwesi.player_id = ?
              AND pwesi.spawn_id = aws.id
          )
        )

        /*
         * Once this player commits during the current phase, contribution
         * markers disappear for them. This does not affect later phases.
         */
        AND NOT EXISTS (
          SELECT 1
          FROM player_world_event_state pwes
          WHERE pwes.active_event_id = aws.active_event_id
            AND pwes.player_id = ?
            AND pwes.phase_id = awe.phase_id
            AND (
              pwes.chosen_outcome_id IS NOT NULL
              OR pwes.committed_at IS NOT NULL
            )
        )

        AND aws.x BETWEEN ? AND ?
        AND aws.y BETWEEN ? AND ?

      ORDER BY aws.id ASC
    `,
    [
      playerId,
      playerId,
      centerX - range,
      centerX + range,
      centerY - range,
      centerY + range
    ]
  );

  return (rows || []).map((row: any) => {
    const x = Number(row.x);
    const y = Number(row.y);

    const spawnType =
      String(row.spawn_type || "")
        .trim()
        .toUpperCase();

    const spawnKey =
      String(row.spawn_key || "");

    const fallbackName =
      spawnKey
        .split("_")
        .filter(Boolean)
        .map(
          (part: string) =>
            part.charAt(0).toUpperCase() +
            part.slice(1)
        )
        .join(" ") ||
      "World Event";

    const name =
      spawnType === "CREATURE" ||
      spawnType === "BOSS"
        ? String(
            row.creature_name ||
            fallbackName
          )
        : fallbackName;

    const fallbackIcon =
      spawnType === "BOSS"
        ? "👹"
        : spawnType === "CREATURE"
          ? "🐗"
          : spawnKey === "unstable_sigil_fragment"
            ? "💠"
            : spawnKey === "resonance_trace"
              ? "🌀"
              : "❗";

    return {
      id: Number(row.id),
      worldEventSpawnId: Number(row.id),
      spawnDefinitionId:
        Number(row.spawn_definition_id),
      activeEventId:
        Number(row.active_event_id),

      name,
      spawnKey,
      spawnType,

      object_type:
        spawnType === "CREATURE" ||
        spawnType === "BOSS"
          ? "world_event_creature"
          : "world_event_interact",

      icon:
        String(
          row.icon ||
          fallbackIcon
        ),

      eventName:
        String(
          row.event_name ||
          "World Event"
        ),

      phaseName:
        String(
          row.phase_name ||
          ""
        ),

      regionId:
        Number(row.region_id),

      x,
      y,

      distance:
        Math.abs(centerX - x) +
        Math.abs(centerY - y),

      inRange:
        x === centerX &&
        y === centerY
    };
  });
}


router.get("/world/current-region", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({ error: "Not logged in" });

  const [[player]]: any = await db.query(
    `SELECT map_x, map_y, level FROM players WHERE id = ? LIMIT 1`,
    [pid]
  );
  if (!player) return res.status(404).json({ error: "Player not found" });

  const [[row]]: any = await db.query(
    `
    SELECT
      wm.region_id,
      COALESCE(r.name, wm.region_name, 'Unknown Region') AS region_name,
      COALESCE(r.level_min, 1) AS level_min,
      COALESCE(r.level_max, 1) AS level_max,
      r.controlling_guild_id
    FROM world_map wm
    LEFT JOIN regions r ON r.id = wm.region_id
    WHERE wm.x = ? AND wm.y = ?
    LIMIT 1
    `,
    [player.map_x, player.map_y]
  );

  const levelMin = Number(row?.level_min ?? 1);
  const levelMax = Number(row?.level_max ?? levelMin);
  const playerLevel = Number(player.level ?? 1);

  // difficulty banding:
  // - hard = player below zone min
  // - easy = player above zone max
  // - even = in the band
  const difficulty =
    playerLevel < levelMin ? "hard" :
    playerLevel > levelMax ? "easy" :
    "even";

  if (!row) {
    return res.json({
      region_id: null,
      region_name: "Unknown Region",
      level_min: 1,
      level_max: 1,
      player_level: playerLevel,
      difficulty: "even",
      controlling_guild_id: null
    });
  }

  res.json({
    region_id: row.region_id ?? null,
    region_name: row.region_name,
    level_min: levelMin,
    level_max: levelMax,
    player_level: playerLevel,
    difficulty,
    controlling_guild_id: row.controlling_guild_id ?? null
  });
});


// =======================
// ACTIVE QUEST WORLD TARGETS
// =======================
async function markActiveQuestWorldObjects(
  playerId: number,
  worldObjects: any[]
) {
  if (!Array.isArray(worldObjects) || !worldObjects.length) {
    return worldObjects || [];
  }

  const cached =
    activeQuestWorldTargetCache.get(Number(playerId));

  let rows: any[];

  if (cached && cached.expiresAt > Date.now()) {
    rows = cached.rows;
  } else {
    const [freshRows]: any = await db.query(
    `
      SELECT
        o.target_world_object_id AS worldObjectId,
        o.objective_text AS objectiveText,
        q.title AS questTitle,
        o.step_order AS stepOrder
      FROM player_quests pq
      JOIN quests q
        ON q.id = pq.quest_id
      JOIN player_quest_objectives pqo
        ON pqo.player_quest_id = pq.id
      JOIN quest_objectives o
        ON o.id = pqo.objective_id
      WHERE pq.player_id = ?
        AND pq.status = 'active'
        AND pqo.is_complete = 0
        AND COALESCE(o.is_hidden, 0) = 0
        AND o.target_world_object_id IS NOT NULL
        AND o.step_order = COALESCE((
          SELECT MIN(o2.step_order)
          FROM player_quest_objectives pqo2
          JOIN quest_objectives o2
            ON o2.id = pqo2.objective_id
          WHERE pqo2.player_quest_id = pq.id
            AND pqo2.is_complete = 0
            AND COALESCE(o2.is_optional, 0) = 0
        ), o.step_order)
    `,
    [playerId]
    );

    rows = freshRows || [];

    activeQuestWorldTargetCache.set(Number(playerId), {
      expiresAt: Date.now() + QUEST_TARGET_CACHE_TTL_MS,
      rows
    });
  }

  const targetMap = new Map<number, any[]>();

  for (const row of rows || []) {
    const worldObjectId = Number(row.worldObjectId);
    if (!Number.isInteger(worldObjectId) || worldObjectId <= 0) continue;

    if (!targetMap.has(worldObjectId)) {
      targetMap.set(worldObjectId, []);
    }

    targetMap.get(worldObjectId)!.push({
      questTitle: String(row.questTitle || "Quest"),
      objectiveText: row.objectiveText ? String(row.objectiveText) : null,
      stepOrder: Math.max(1, Number(row.stepOrder) || 1)
    });
  }

  return worldObjects.map((obj: any) => {
    const questTargets = targetMap.get(Number(obj.id)) || [];

    return {
      ...obj,
      isQuestTarget: questTargets.length > 0,
      questTargets
    };
  });
}

// =======================
// HALLOWED QUEST PUMPKIN VISIBILITY
// =======================
async function filterHallowedPumpkinsForPlayer(
  playerId: number,
  worldObjects: any[]
) {
  if (!Array.isArray(worldObjects) || !worldObjects.length) return worldObjects || [];

  const hasPumpkins = worldObjects.some(
    (obj: any) => String(obj?.name || "") === "Halloween Pumpkin"
  );
  if (!hasPumpkins) return worldObjects;

  const [[activeQuest]]: any = await db.query(
    `SELECT pq.id
     FROM player_quests pq
     JOIN quests q ON q.id = pq.quest_id
     WHERE pq.player_id = ?
       AND q.title = ?
       AND q.is_active = 1
       AND pq.status = 'active'
     ORDER BY pq.id DESC
     LIMIT 1`,
    [playerId, HALLOWED_SMASH_QUEST_TITLE]
  );

  if (!activeQuest) {
    return worldObjects.filter(
      (obj: any) => String(obj?.name || "") !== "Halloween Pumpkin"
    );
  }

  const [smashedRows]: any = await db.query(
    `SELECT world_object_id
     FROM player_seasonal_object_interactions
     WHERE player_id = ?
       AND interaction_key = 'smash'`,
    [playerId]
  );

  const smashedIds = new Set<number>(
    (smashedRows || []).map((row: any) => Number(row.world_object_id))
  );

  return worldObjects.filter((obj: any) => {
    if (String(obj?.name || "") !== "Halloween Pumpkin") return true;
    return !smashedIds.has(Number(obj.id));
  });
}

// =======================
// WORLD VIEW
// =======================
router.get("/world", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");

  // Reaching the World page means the player has left the haven.
  await advanceTutorial(
    Number(pid),
    TutorialStep.LEAVE_PORT_HAVEN,
    TutorialStep.ENTER_FIRST_COMBAT
  );

  // Load player
  const [[player]]: any = await db.query(
    `
    SELECT id, map_x, map_y, level, location
    FROM players
    WHERE id=?
    LIMIT 1
    `,
    [pid]
  );

  // Keep players.location synchronized with the current tile.
  // Town tiles use their town name; all other tiles use the region name.
  const [[currentRegionTile]]: any = await db.query(
    `
      SELECT
        CASE
          WHEN wm.terrain IN ('town', 'dungeon')
            THEN COALESCE(
              l.name,
              wm.region_name,
              r.name,
              'Unknown Region'
            )
          ELSE COALESCE(
            r.name,
            wm.region_name,
            'Unknown Region'
          )
        END AS location_name
      FROM world_map wm
      LEFT JOIN regions r
        ON r.id = wm.region_id
      LEFT JOIN locations l
        ON l.map_x = wm.x
       AND l.map_y = wm.y
      WHERE wm.x = ?
        AND wm.y = ?
      LIMIT 1
    `,
    [
      Number(player.map_x),
      Number(player.map_y)
    ]
  );

  const currentLocationName =
    String(currentRegionTile?.location_name || "");

  if (
    currentLocationName &&
    currentLocationName !== "Unknown Region" &&
    String(player.location || "") !== currentLocationName
  ) {
    await db.query(
      `
        UPDATE players
        SET location = ?
        WHERE id = ?
      `,
      [
        currentLocationName,
        pid
      ]
    );

    player.location = currentLocationName;
  }

  const minX = player.map_x - 5;
  const maxX = player.map_x + 5;
  const minY = player.map_y - 5;
  const maxY = player.map_y + 5;
  let [worldObjects]: any = await db.query(`
    SELECT
      id,
      name,
      x,
      y,
      tile_sprite,
      tile_visual_type,
      z_index
    FROM world_objects
    WHERE is_active = 1
      AND x BETWEEN ? AND ?
      AND y BETWEEN ? AND ?
    ORDER BY z_index ASC, id ASC
  `, [minX, maxX, minY, maxY]);

  worldObjects = await filterHallowedPumpkinsForPlayer(Number(pid), worldObjects);
  worldObjects = await markActiveQuestWorldObjects(Number(pid), worldObjects);

  const objectMap = buildWorldObjectMap(worldObjects);
  // Load tiles
  const [tiles]: any = await db.query(`
    SELECT *
    FROM world_map
    WHERE x BETWEEN ? AND ?
      AND y BETWEEN ? AND ?
  `, [minX, maxX, minY, maxY]);

  const resourceNodes = await getResourceNodesInRange(Number(pid), player.map_x, player.map_y, 5);

  const huntTargets =
  await getHuntTargetsInRange(
    Number(pid),
    Number(player.map_x),
    Number(player.map_y),
    5
  );

  const worldEventInteractSpawns =
    await getWorldEventInteractSpawnsInRange(
      Number(pid),
      Number(player.map_x),
      Number(player.map_y),
      5
    );

  const worldEventMapSpawns =
    await getWorldEventMapSpawnsInRange(
      Number(pid),
      Number(player.map_x),
      Number(player.map_y),
      5
    );

  // Guild ownership
  const [guilds]: any = await db.query("SELECT id,name FROM guilds");
  const guildMap: any = {};
  guilds.forEach((g: any) => guildMap[g.id] = g.name);

  const tileMap: any = {};
  tiles.forEach((t: any) => tileMap[`${t.x},${t.y}`] = t);

  const currentTerrain =
    String(
      tileMap[
        `${Number(player.map_x)},${Number(player.map_y)}`
      ]?.terrain || ""
    );

const gridHtml = `              ${
                Array.from({ length: 11 }).map((_, r) => {
                  const y = minY + r;

                  return Array.from({ length: 11 }).map((_, c) => {
                    const x = minX + c;
                    const t = tileMap[x + "," + y];

                    if (!t) {
                      return `
                        <div
                          class="tile void"
                          data-x="${x}"
                          data-y="${y}"
                        ></div>
                      `;
                    }

                    const isPlayer =
                      x === player.map_x &&
                      y === player.map_y;

                    const {
                      replaceSprite,
                      overlays
                    } = getTileVisualData(t, x, y, objectMap);

                    const baseStyle = replaceSprite
                      ? `style="background-image: url('${replaceSprite}');"`
                      : "";

                    return `
                      <div
                        class="tile ${replaceSprite ? "" : t.terrain} ${
                          isPlayer ? "player" : ""
                        }"
                        data-x="${x}"
                        data-y="${y}"
                        ${baseStyle}
                      >
                        ${
                          overlays.map((src) => `
                            <img
                              class="tile-overlay"
                              src="${src}"
                              alt=""
                              aria-hidden="true"
                            />
                          `).join("")
                        }
                      </div>
                    `;
                  }).join("");
                }).join("")
              }`;

  const worldTemplate = await readFile(
    path.join(process.cwd(), "public", "world.html"),
    "utf8"
  );

  const substitutions: Record<string, string> = {
    GFPLACE_TERRAIN_END: currentTerrain,
    GFPLACE_X_END: String(player.map_x),
    GFPLACE_Y_END: String(player.map_y),
    GFPLACE_GRID_HTML_END: gridHtml,
    GFPLACE_PLAYER_ID_END: String(Number(player.id)),
    GFPLACE_RESOURCE_NODES_END: JSON.stringify(resourceNodes).replace(/</g, "\\u003c"),
    GFPLACE_HUNT_TARGETS_END: JSON.stringify(huntTargets).replace(/</g, "\\u003c"),
    GFPLACE_EVENT_INTERACTS_END: JSON.stringify(worldEventInteractSpawns).replace(/</g, "\\u003c"),
    GFPLACE_EVENT_MAP_SPAWNS_END: JSON.stringify(worldEventMapSpawns).replace(/</g, "\\u003c")
  };

  const renderedHtml = worldTemplate.replace(
    /GFPLACE_[A-Z_]+_END/g,
    (token) => substitutions[token] ?? token
  );

  res.type("html").send(renderedHtml);
});


/* ============================================================================
   FULL WORLD MAP — lightweight terrain + player/party positions
============================================================================ */
router.get("/api/world/map", async (req, res) => {
  try {
    const pid = Number((req.session as any)?.playerId);
    if (!pid) return res.status(401).json({ error: "not_logged_in" });

    const [[player]]: any = await db.query(
      `SELECT id, name, map_x, map_y FROM players WHERE id=? LIMIT 1`,
      [pid]
    );
    if (!player) return res.status(404).json({ error: "player_not_found" });

    const [tiles]: any = await db.query(`
      SELECT
        wm.x,
        wm.y,
        wm.terrain,
        wm.region_id,
        CASE
          WHEN LOWER(COALESCE(wm.terrain, '')) = 'town'
            THEN 'Haven'
          WHEN LOWER(COALESCE(wm.terrain, '')) = 'dungeon'
            THEN 'Dungeon'
          ELSE COALESCE(r.name, 'Unknown Region')
        END AS map_region_name
      FROM world_map wm
      LEFT JOIN regions r
        ON r.id = wm.region_id
      ORDER BY wm.y ASC, wm.x ASC
    `);

    const [locations]: any = await db.query(`
      SELECT
        l.id,
        l.name,
        l.map_x,
        l.map_y,
        COALESCE(wm.terrain, 'location') AS terrain
      FROM locations l
      LEFT JOIN world_map wm
        ON wm.x = l.map_x
       AND wm.y = l.map_y
      WHERE l.map_x IS NOT NULL
        AND l.map_y IS NOT NULL
      ORDER BY l.name ASC
    `);

    const [partyRows]: any = await db.query(`
      SELECT DISTINCT
        p.id,
        p.name,
        p.level,
        p.map_x,
        p.map_y
      FROM party_members me
      JOIN party_members pm
        ON pm.party_id = me.party_id
       AND pm.player_id <> me.player_id
      JOIN players p
        ON p.id = pm.player_id
      WHERE me.player_id = ?
      ORDER BY p.name ASC
    `, [pid]);

    res.json({
      player: {
        id: Number(player.id),
        name: String(player.name || "You"),
        x: Number(player.map_x),
        y: Number(player.map_y)
      },
      party: (partyRows || []).map((p: any) => ({
        id: Number(p.id),
        name: String(p.name || "Party Member"),
        level: Number(p.level || 1),
        x: Number(p.map_x),
        y: Number(p.map_y)
      })),
      tiles: (tiles || []).map((t: any) => ({
        x: Number(t.x),
        y: Number(t.y),
        terrain: String(t.terrain || "void"),
        regionId: t.region_id != null ? Number(t.region_id) : null,
        regionName: String(t.map_region_name || "Unknown Region")
      })),
      locations: (locations || []).map((l: any) => ({
        id: Number(l.id),
        name: String(l.name || "Location"),
        x: Number(l.map_x),
        y: Number(l.map_y),
        type: String(l.terrain || "location").toLowerCase()
      }))
    });
  } catch (err) {
    console.error("world map api failed:", err);
    res.status(500).json({ error: "server_error" });
  }
});

router.get("/town/enter", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");

  const [[player]]: any = await db.query(
    "SELECT map_x, map_y FROM players WHERE id=?",
    [pid]
  );

  const [[tile]]: any = await db.query(
    `
    SELECT terrain
    FROM world_map
    WHERE x=? AND y=?
    LIMIT 1
    `,
    [player.map_x, player.map_y]
  );

  if (!tile || tile.terrain !== "town") {
    return res.status(403).send("You are not in a town.");
  }


  // ✅ Valid town entry
  res.redirect("/town");
});

/*
 * Resolve the dungeon attached to the player's current
 * world-map tile.
 *
 * Dungeon locations mirror towns:
 *   world_map.terrain = 'dungeon'
 *   locations.map_x/map_y = same tile
 *   locations.name = dungeons.name
 */
router.get("/world/current-dungeon", async (req, res) => {
  try {
    const pid =
      (req.session as any)?.playerId;

    if (!pid) {
      return res
        .status(401)
        .json({
          ok: false,
          error: "not_logged_in"
        });
    }

    const [[player]]: any =
      await db.query(
        `
          SELECT
            map_x,
            map_y

          FROM players

          WHERE id = ?

          LIMIT 1
        `,
        [pid]
      );

    if (!player) {
      return res
        .status(404)
        .json({
          ok: false,
          error: "player_not_found"
        });
    }

    const [[row]]: any =
      await db.query(
        `
          SELECT
            wm.x,
            wm.y,
            wm.terrain,

            l.id AS location_id,
            l.name AS location_name,
            l.description AS location_description,
            l.image AS location_image,

            d.id AS dungeon_id,
            d.name AS dungeon_name,
            d.slug,
            d.min_level,
            d.max_level,
            d.recommended_level,
            d.min_party_size,
            d.max_party_size,
            d.image AS dungeon_image

          FROM world_map wm

          LEFT JOIN locations l
            ON l.map_x = wm.x
           AND l.map_y = wm.y

          LEFT JOIN dungeons d
            ON d.name COLLATE utf8mb4_unicode_ci =
              l.name COLLATE utf8mb4_unicode_ci
          AND d.is_active = 1

          WHERE wm.x = ?
            AND wm.y = ?

          LIMIT 1
        `,
        [
          Number(player.map_x),
          Number(player.map_y)
        ]
      );

    if (
      !row ||
      String(row.terrain || "")
        .toLowerCase() !== "dungeon"
    ) {
      return res
        .status(403)
        .json({
          ok: false,
          error: "not_on_dungeon_tile"
        });
    }

    if (!row.dungeon_id) {
      return res
        .status(404)
        .json({
          ok: false,
          error: "dungeon_not_configured"
        });
    }

    return res.json({
      ok: true,

      dungeon: {
        id:
          Number(row.dungeon_id),

        name:
          String(
            row.dungeon_name ||
            row.location_name ||
            "Dungeon"
          ),

        slug:
          row.slug ?? null,

        description:
          row.location_description ?? null,

        image:
          row.dungeon_image ??
          row.location_image ??
          null,

        minLevel:
          Number(
            row.min_level ?? 1
          ),

        maxLevel:
          row.max_level == null
            ? null
            : Number(row.max_level),

        recommendedLevel:
          row.recommended_level == null
            ? null
            : Number(
                row.recommended_level
              ),

        minPartySize:
          Number(
            row.min_party_size ?? 1
          ),

        maxPartySize:
          Number(
            row.max_party_size ?? 4
          ),

        x:
          Number(row.x),

        y:
          Number(row.y)
      }
    });

  } catch (err) {
    console.error(
      "GET /world/current-dungeon failed:",
      err
    );

    return res
      .status(500)
      .json({
        ok: false,
        error: "server_error"
      });
  }
});

// =======================
// MOVE PLAYER
// =======================
function dirArrow(dx: number, dy: number) {
  const h = dx === 0 ? "" : (dx > 0 ? "→" : "←");
  const v = dy === 0 ? "" : (dy > 0 ? "↓" : "↑");
  if (h && v) {
    if (v === "↑" && h === "→") return "↗";
    if (v === "↑" && h === "←") return "↖";
    if (v === "↓" && h === "→") return "↘";
    if (v === "↓" && h === "←") return "↙";
  }
  return v || h || "•";
}

function terrainFlavor(terrain: string) {
  const t = String(terrain || "").toLowerCase();
  const lines: Record<string, string[]> = {
plains: [
  "Tall grass brushes your boots.",
  "The air smells faintly of rain.",
  "Insects hum in the distance.",
  "Clouds drift lazily across the open sky."
],

forest: [
  "Branches creak overhead.",
  "You hear something moving between the trees.",
  "Sap and smoke linger in the air.",
  "Filtered sunlight dances across the forest floor."
],

desert: [
  "Heat shimmers across the ground.",
  "Dry wind bites at your eyes.",
  "Sand shifts underfoot.",
  "The horizon wavers like a mirage."
],

swamp: [
  "Mud pulls at your steps.",
  "Something bubbles below the surface.",
  "The stench of rot hangs heavy.",
  "Mosquitoes swarm in thick, whining clouds."
],

snow: [
  "Frost clings to your armor.",
  "Your breath fogs the air.",
  "Snow crunches underfoot.",
  "A bitter wind cuts through every gap in your gear."
],

road: [
  "The road feels safer than the wilds.",
  "Worn stones mark countless journeys.",
  "Wheel ruts cut through the dirt.",
  "Footprints come and go, but never linger long."
],

ruins: [
  "Broken stone juts like teeth.",
  "Ash drifts across the ground.",
  "Old magic prickles at your skin.",
  "Silence presses in where voices once echoed."
],

mountain: [
  "Cold air burns your lungs with every breath.",
  "Loose gravel skitters down the slope below you.",
  "The wind howls between jagged peaks.",
  "Far below, the world looks small and fragile."
],

dungeon: [
  "Ancient stone looms before you.",
  "Runes flicker across a sealed mountain entrance.",
  "A low rumble echoes from somewhere beyond the gate.",
  "The air crackles with old, unstable power."
]
  };

  const bucket = lines[t] || ["You press onward."];
  return bucket[Math.floor(Math.random() * bucket.length)];
}







// =======================
// MOVE ROUTE — bundles world/partial + nearby-objects + region into one response
// =======================
router.get("/world/move/:dir", async (req, res) => {

  const pid = (req.session as any).playerId;
  const dir = req.params.dir;
  if (!pid || !directions[dir]) {
    return res.json({ success: false });
  }
const [[player]]: any = await db.query(
  `
  SELECT
    p.name,
    p.map_x,
    p.map_y,
    p.level,
    wm.region_id AS current_region_id
  FROM players p
  LEFT JOIN world_map wm
    ON wm.x = p.map_x
   AND wm.y = p.map_y
  WHERE p.id=?
  LIMIT 1
  `,
  [pid]
);

const [dx, dy] = directions[dir];
const newX = Number(player.map_x) + dx;
const newY = Number(player.map_y) + dy;

const [huntClueRows]: any =
  await db.query(
    `
      SELECT
        phc.id,
        phc.map_x,
        phc.map_y,

        hc.name,
        hc.description,
        hc.icon,

        ph.id AS party_hunt_id,
        h.name AS hunt_name

      FROM party_members pm

      JOIN party_hunts ph
        ON ph.party_id =
           pm.party_id

      JOIN hunt_participants hp
        ON hp.party_hunt_id =
           ph.id
       AND hp.player_id =
           pm.player_id

      JOIN party_hunt_clues phc
        ON phc.party_hunt_id =
           ph.id

      JOIN hunt_clues hc
        ON hc.id =
           phc.hunt_clue_id

      JOIN hunts h
        ON h.id =
           ph.hunt_id

      WHERE pm.player_id = ?

        AND ph.status IN (
          'tracking',
          'revealed',
          'engaged'
        )

        AND phc.is_investigated = 0

        AND phc.map_x
          BETWEEN ? AND ?

        AND phc.map_y
          BETWEEN ? AND ?

      ORDER BY
        phc.id ASC
    `,
    [
      pid,
      newX - 5,
      newX + 5,
      newY - 5,
      newY + 5
    ]
  );

const [[tile]]: any = await db.query(
  `
  SELECT
    wm.terrain,
    wm.region_id,

    COALESCE(
      r.name,
      wm.region_name,
      'Unknown Region'
    ) AS region_name,

    CASE
      WHEN wm.terrain IN ('town', 'dungeon')
        THEN COALESCE(
          l.name,
          wm.region_name,
          r.name,
          'Unknown Region'
        )
      ELSE COALESCE(
        r.name,
        wm.region_name,
        'Unknown Region'
      )
    END AS location_name,

    l.name AS special_location_name,

    COALESCE(r.level_min, 1) AS level_min,
    COALESCE(r.level_max, 1) AS level_max,
    r.controlling_guild_id

  FROM world_map wm

  LEFT JOIN regions r
    ON r.id = wm.region_id

  LEFT JOIN locations l
    ON l.map_x = wm.x
   AND l.map_y = wm.y

  WHERE wm.x=? AND wm.y=?

  LIMIT 1
  `,
  [newX, newY]
);

if (!tile) {
  return res.json({ success: false });
}

// Water is a hard world boundary. Enforce this server-side before any
// movement state, Hunt ready state, encounter, gathering, or quest logic runs.
if (String(tile.terrain || "").trim().toLowerCase() === "water") {
  return res.json({
    success: false,
    blocked: true,
    reason: "impassable_terrain",
    terrain: "water",
    message: "The water is too deep to cross."
  });
}

const movementConnection =
  await db.getConnection();

try {
  await movementConnection.beginTransaction();

  const [moveResult]: any =
    await movementConnection.query(
      `
        UPDATE players

        SET
          map_x = ?,
          map_y = ?,
          location = ?

        WHERE id = ?
      `,
      [
        newX,
        newY,
        String(tile.location_name || "Unknown Region"),
        pid
      ]
    );

  if (
    Number(moveResult.affectedRows) !== 1
  ) {
    throw new Error(
      "Player could not be moved."
    );
  }

  /*
   * Moving away revokes Ready on any pending
   * Hunt ready check.
   */
  const [readyResetResult]: any =
    await movementConnection.query(
      `
        UPDATE hunt_ready_check_players hrcp

        JOIN hunt_ready_checks hrc
          ON hrc.id =
             hrcp.ready_check_id

        SET
          hrcp.is_ready = 0,
          hrcp.ready_at = NULL

        WHERE hrcp.player_id = ?
          AND hrc.status = 'pending'
          AND hrcp.is_ready = 1
      `,
      [pid]
    );

  await movementConnection.commit();

  const movingPlayerPartyMemberIds =
    await getWorldPartyMemberIds(
      Number(pid)
    );

  publishWorldPlayerMoved({
    playerId: Number(pid),
    name: String(
      player.name ||
      "Adventurer"
    ),
    level: Math.max(
      1,
      Number(player.level) || 1
    ),
    x: newX,
    y: newY,
    partyMemberIds:
      movingPlayerPartyMemberIds
  });

  if (
    Number(
      readyResetResult.affectedRows
    ) > 0
  ) {
    try {
      const readyCheck =
        await getHuntReadyCheck(
          Number(pid)
        );

      if (readyCheck) {
        publishHuntReadyCheck(
          readyCheck,
          null
        );
      }
    } catch (err) {
      console.warn(
        "Ready-check movement broadcast failed:",
        err
      );
    }
  }

} catch (err) {

  await movementConnection.rollback();

  console.error(
    "World movement transaction failed:",
    err
  );

  return res
    .status(500)
    .json({
      success: false,
      error: "movement_failed"
    });

} finally {

  movementConnection.release();
}

const spawnedResourceNode =
  await maybeSpawnResourceNodeForPlayer(pid);

const [
  resourceNodes,
  huntTargets,
  worldEventInteractSpawns,
  worldEventMapSpawns
] = await Promise.all([
  getResourceNodesInRange(
    pid,
    newX,
    newY,
    5
  ),

  getHuntTargetsInRange(
    Number(pid),
    newX,
    newY,
    5
  ),

  getWorldEventInteractSpawnsInRange(
    Number(pid),
    newX,
    newY,
    5
  ),

  getWorldEventMapSpawnsInRange(
    Number(pid),
    newX,
    newY,
    5
  )
]);

const previousRegionId =
  player.current_region_id !== null &&
  player.current_region_id !== undefined
    ? Number(player.current_region_id)
    : null;

const nextRegionId =
  tile.region_id !== null &&
  tile.region_id !== undefined
    ? Number(tile.region_id)
    : null;

const regionChanged =
  previousRegionId !== nextRegionId;

const enterAreaResult =
  regionChanged
    ? await applyEnterAreaProgress(
        pid,
        tile.region_id ?? null
      )
    : null;

// LOCATION objectives are coordinate-based, so they still need to evaluate
// after movement even when the player remains inside the same region.
const locationResult =
  await applyLocationProgress(
    pid,
    newX,
    newY,
    String(tile.region_name || "Unknown Region"),
    null
  );

const questProgressChanged =
  Boolean(
    (enterAreaResult?.updatedObjectives?.length || 0) ||
    (enterAreaResult?.completedPlayerQuestIds?.length || 0) ||
    (enterAreaResult?.stageTransitions?.length || 0) ||
    (locationResult?.updatedObjectives?.length || 0) ||
    (locationResult?.completedPlayerQuestIds?.length || 0) ||
    (locationResult?.stageTransitions?.length || 0)
  );

if (questProgressChanged) {
  invalidateActiveQuestWorldTargetCache(Number(pid));
}

let huntProgress = null;

if (regionChanged) {
  try {
    huntProgress =
      await advanceHuntObjective(
        Number(pid),
        {
          type: "ENTER_REGION",
          regionId:
            tile.region_id !== null &&
            tile.region_id !== undefined
              ? Number(tile.region_id)
              : undefined
        }
      );

  } catch (err) {
    console.warn(
      "Hunt ENTER_REGION progress failed",
      err
    );
  }
}
const playerLevel = Number(player.level ?? 1);
const levelMin = Number(tile.level_min ?? 1);
const levelMax = Number(tile.level_max ?? levelMin);



const difficulty =
  playerLevel < levelMin ? "hard" :
  playerLevel > levelMax ? "easy" :
  "even";

const regionName = String(tile.region_name || "Unknown Region");
const zoneLevel = levelMin;
const controllingGuildId = tile.controlling_guild_id ?? null;

let enemy: any = null;

/*
 * WORLD EVENT ENCOUNTERS
 *
 * Event creatures take priority over ordinary random encounters.
 * If the player steps directly onto an ACTIVE CREATURE/BOSS event
 * spawn, create an encounter using that spawn's exact target_id.
 *
 * INTERACT event spawns are intentionally ignored here; they will
 * be exposed through the nearby/interact flow separately.
 */
const eventSpawn =
  await getWorldEventSpawnAtTile(
    Number(pid),
    newX,
    newY
  );

if (
  eventSpawn &&
  (
    eventSpawn.spawnType === "CREATURE" ||
    eventSpawn.spawnType === "BOSS"
  ) &&
  eventSpawn.targetId != null
) {
  enemy =
    await spawnSpecificWorldEventEnemy(
      Number(pid),
      newX,
      newY,
      Number(eventSpawn.targetId),
      Number(eventSpawn.id)
    );

}

/*
 * Only roll a normal world encounter when there is no active
 * event combat spawn on this tile.
 */
if (
  !enemy &&
  !(
    eventSpawn &&
    (
      eventSpawn.spawnType === "CREATURE" ||
      eventSpawn.spawnType === "BOSS"
    )
  ) &&
  Math.random() < ENCOUNTER_CHANCE
) {
  enemy =
    await trySpawnEnemy(
      pid,
      newX,
      newY,
      tile.terrain
    );
}

// Only advance the combat tutorial when movement actually spawned an enemy.
if (enemy) {
  await advanceTutorial(
    Number(pid),
    TutorialStep.ENTER_FIRST_COMBAT,
    TutorialStep.CAST_FIRST_SPELL
  );
}

  // =======================
  // BUNDLE: world/partial data
  // =======================
  const minX = newX - 5;
  const maxX = newX + 5;
  const minY = newY - 5;
  const maxY = newY + 5;

// World objects use the same sliding-window strategy as terrain. Only the
// newly exposed row/column can contain objects the browser has not seen yet.
let objectStripSql = "";
let objectStripParams: any[] = [];

if (dir === "north") {
  objectStripSql = `SELECT id,name,object_type,region_name,x,y,interaction_radius,icon,tile_sprite,tile_visual_type,z_index FROM world_objects WHERE is_active=1 AND y=? AND x BETWEEN ? AND ? ORDER BY z_index ASC,id ASC`;
  objectStripParams = [minY, minX, maxX];
} else if (dir === "south") {
  objectStripSql = `SELECT id,name,object_type,region_name,x,y,interaction_radius,icon,tile_sprite,tile_visual_type,z_index FROM world_objects WHERE is_active=1 AND y=? AND x BETWEEN ? AND ? ORDER BY z_index ASC,id ASC`;
  objectStripParams = [maxY, minX, maxX];
} else if (dir === "west") {
  objectStripSql = `SELECT id,name,object_type,region_name,x,y,interaction_radius,icon,tile_sprite,tile_visual_type,z_index FROM world_objects WHERE is_active=1 AND x=? AND y BETWEEN ? AND ? ORDER BY z_index ASC,id ASC`;
  objectStripParams = [minX, minY, maxY];
} else {
  objectStripSql = `SELECT id,name,object_type,region_name,x,y,interaction_radius,icon,tile_sprite,tile_visual_type,z_index FROM world_objects WHERE is_active=1 AND x=? AND y BETWEEN ? AND ? ORDER BY z_index ASC,id ASC`;
  objectStripParams = [maxX, minY, maxY];
}

let worldObjects: any[] = [];

// If this move advanced a quest, existing objects already inside the buffer may
// have gained/lost quest-target markers. Refresh objects once on that state
// change; ordinary movement still uses only the entering strip.
if (questProgressChanged) {
  const [rows]: any = await db.query(`
    SELECT id,name,object_type,region_name,x,y,interaction_radius,icon,tile_sprite,tile_visual_type,z_index
    FROM world_objects
    WHERE is_active=1 AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?
    ORDER BY z_index ASC,id ASC
  `, [minX, maxX, minY, maxY]);
  worldObjects = rows;
} else {
  const [rows]: any = await db.query(objectStripSql, objectStripParams);
  worldObjects = rows;
}

worldObjects = await filterHallowedPumpkinsForPlayer(Number(pid), worldObjects);
worldObjects = await markActiveQuestWorldObjects(Number(pid), worldObjects);

  // The browser already owns the previous 11x11 tile buffer. After a
  // one-tile move only one entering row/column is new, so send that strip
  // instead of re-reading and returning all 121 tiles.
  let tileStripSql = "";
  let tileStripParams: any[] = [];

  if (dir === "north") {
    tileStripSql = `SELECT * FROM world_map WHERE y = ? AND x BETWEEN ? AND ?`;
    tileStripParams = [minY, minX, maxX];
  } else if (dir === "south") {
    tileStripSql = `SELECT * FROM world_map WHERE y = ? AND x BETWEEN ? AND ?`;
    tileStripParams = [maxY, minX, maxX];
  } else if (dir === "west") {
    tileStripSql = `SELECT * FROM world_map WHERE x = ? AND y BETWEEN ? AND ?`;
    tileStripParams = [minX, minY, maxY];
  } else {
    tileStripSql = `SELECT * FROM world_map WHERE x = ? AND y BETWEEN ? AND ?`;
    tileStripParams = [maxX, minY, maxY];
  }

  const [tiles]: any =
    await db.query(tileStripSql, tileStripParams);

  // =======================
  // BUNDLE: nearby-objects data
  // =======================

const nearbyObjects = worldObjects.map((r: any) => {
  const d = Math.abs(newX - Number(r.x)) + Math.abs(newY - Number(r.y));
  const radius = Math.max(0, Number(r.interaction_radius) || 1);

  return {
    id: Number(r.id),
    name: String(r.name || "Unknown Object"),
    object_type: String(r.object_type || "quest"),
    region_name: r.region_name ?? null,
    x: Number(r.x),
    y: Number(r.y),
    interaction_radius: radius,
    inRange: d <= radius,
    distance: d,
    icon: r.icon ?? null
  };
});

const nearbyHuntClues =
  (huntClueRows || []).map(
    (r: any) => {

      const distance =
        Math.abs(
          newX -
          Number(r.map_x)
        ) +
        Math.abs(
          newY -
          Number(r.map_y)
        );

      return {
        id:
          Number(r.id),

        name:
          String(
            r.name ||
            "Unknown Clue"
          ),

        object_type:
          "hunt_clue",

        region_name:
          null,

        x:
          Number(r.map_x),

        y:
          Number(r.map_y),

        interaction_radius:
          0,

        inRange:
          distance === 0,

        distance,

        icon:
          r.icon || "🐾",

        description:
          r.description ?? null,

        partyHuntId:
          Number(
            r.party_hunt_id
          ),

        huntName:
          String(
            r.hunt_name ||
            "Hunt"
          )
      };
    }
  );

  return res.json({
    success: true,
    pos: { x: newX, y: newY },
    terrain: tile.terrain,
    region: regionName,
    regionChanged,
    zoneLevel,
    spawnedResourceNode,
    flavor: terrainFlavor(tile.terrain),

    questProgress: {
      enterArea: enterAreaResult,
      location: locationResult
    },

    huntProgress,

    inCombat: !!enemy,
    enemy,

    // Bundled — replaces separate /world/partial fetch
world: {
  player: {
    map_x: newX,
    map_y: newY
  },

  tiles,
  partialTiles: true,
  partialWorldObjects: !questProgressChanged,
  worldObjects,
  resourceNodes,

  huntClues: nearbyHuntClues,
  huntTargets,
  worldEventInteractSpawns,
  worldEventMapSpawns
},

    // Bundled — replaces separate /api/world/nearby-objects fetch
nearbyObjects: [
  ...nearbyObjects,
  ...nearbyHuntClues,
  ...huntTargets,
  ...worldEventInteractSpawns
],

    // Bundled — replaces separate /world/current-region fetch
    regionData: tile.region_id ? {
      region_id: Number(tile.region_id),
      region_name: regionName ?? "Unknown Region",
      level_min: levelMin,
      level_max: levelMax,
      difficulty,
      controlling_guild_id: controllingGuildId
    } : null
  });
});






router.get("/api/world/nearby-objects", async (req, res) => {
  try {
    const pid =
      (req.session as any)?.playerId;

    if (!pid) {
      return res
        .status(401)
        .json({
          error: "not_logged_in"
        });
    }

    const [[player]]: any =
      await db.query(
        `
          SELECT
            map_x,
            map_y

          FROM players

          WHERE id = ?

          LIMIT 1
        `,
        [pid]
      );

    if (!player) {
      return res
        .status(404)
        .json({
          error: "player_not_found"
        });
    }

    const px =
      Number(player.map_x);

    const py =
      Number(player.map_y);


    /* =========================================
       NORMAL WORLD OBJECTS
    ========================================= */

    let [rows]: any =
      await db.query(
        `
          SELECT
            id,
            name,
            object_type,
            region_name,
            x,
            y,
            interaction_radius,
            is_active,
            icon,
            lore_title,
            lore_text

          FROM world_objects

          WHERE is_active = 1
            AND x BETWEEN ? AND ?
            AND y BETWEEN ? AND ?

          ORDER BY id ASC
        `,
        [
          px - 5,
          px + 5,
          py - 5,
          py + 5
        ]
      );

    rows = await filterHallowedPumpkinsForPlayer(Number(pid), rows || []);


    const objects =
      (rows || []).map(
        (r: any) => {

          const dist =
            Math.abs(
              px - Number(r.x)
            ) +
            Math.abs(
              py - Number(r.y)
            );

          const radius =
            Math.max(
              0,
              Number(
                r.interaction_radius
              ) || 1
            );

          return {
            id:
              Number(r.id),

            name:
              String(
                r.name ||
                "Unknown Object"
              ),

            object_type:
              String(
                r.object_type ||
                "quest"
              ),

            region_name:
              r.region_name ?? null,

            x:
              Number(r.x),

            y:
              Number(r.y),

            interaction_radius:
              radius,

            inRange:
              dist <= radius,

            distance:
              dist,

            icon:
              r.icon ?? null
          };
        }
      );


    /* =========================================
       ACTIVE HUNT CLUES
    ========================================= */

    const [huntClueRows]: any =
      await db.query(
        `
          SELECT
            phc.id,
            phc.map_x,
            phc.map_y,

            hc.name,
            hc.description,
            hc.icon,

            ph.id AS party_hunt_id,
            h.name AS hunt_name

          FROM party_members pm

          JOIN party_hunts ph
            ON ph.party_id =
               pm.party_id

          JOIN hunt_participants hp
            ON hp.party_hunt_id =
               ph.id
           AND hp.player_id =
               pm.player_id

          JOIN party_hunt_clues phc
            ON phc.party_hunt_id =
               ph.id

          JOIN hunt_clues hc
            ON hc.id =
               phc.hunt_clue_id

          JOIN hunts h
            ON h.id =
               ph.hunt_id

          WHERE pm.player_id = ?

            AND ph.status IN (
              'tracking',
              'revealed',
              'engaged'
            )

            AND phc.is_investigated = 0

            AND phc.map_x
              BETWEEN ? AND ?

            AND phc.map_y
              BETWEEN ? AND ?

          ORDER BY
            phc.id ASC
        `,
        [
          pid,
          px - 5,
          px + 5,
          py - 5,
          py + 5
        ]
      );


    const huntClues =
      (huntClueRows || []).map(
        (r: any) => {

          const dist =
            Math.abs(
              px -
              Number(r.map_x)
            ) +
            Math.abs(
              py -
              Number(r.map_y)
            );

          return {
            id:
              Number(r.id),

            name:
              String(
                r.name ||
                "Unknown Clue"
              ),

            object_type:
              "hunt_clue",

            region_name:
              null,

            x:
              Number(r.map_x),

            y:
              Number(r.map_y),

            /*
             * Player must stand directly
             * on the clue.
             */
            interaction_radius:
              0,

            inRange:
              dist === 0,

            distance:
              dist,

            icon:
              r.icon ?? "🐾",

            description:
              r.description ?? null,

            partyHuntId:
              Number(
                r.party_hunt_id
              ),

            huntName:
              String(
                r.hunt_name ||
                "Hunt"
              )
          };
        }
      );

      const huntTargets =
  await getHuntTargetsInRange(
    Number(pid),
    px,
    py,
    5
  );

    const worldEventInteractSpawns =
      await getWorldEventInteractSpawnsInRange(
        Number(pid),
        px,
        py,
        5
      );


    /* =========================================
       RESPONSE
    ========================================= */

    return res.json({
      success: true,

      player: {
        x: px,
        y: py
      },

      objects: [
      ...objects,
      ...huntClues,
      ...huntTargets,
      ...worldEventInteractSpawns
    ]
    });

  } catch (err) {

    console.error(
      "🔥 GET /api/world/nearby-objects ERROR:",
      err
    );

    return res
      .status(500)
      .json({
        error: "server_error"
      });
  }
});

// =======================
// WORLD PARTIAL
// =======================

router.get("/world/nearby-players", async (req, res) => {
  const pid = Number((req.session as any)?.playerId);

  if (!Number.isInteger(pid) || pid <= 0) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const [[player]]: any = await db.query(
    `SELECT map_x, map_y FROM players WHERE id = ? LIMIT 1`,
    [pid]
  );

  if (!player) {
    return res.status(404).json({ error: "Player not found" });
  }

  const players =
    await getNearbyWorldPlayers(
      pid,
      Number(player.map_x),
      Number(player.map_y),
      5
    );

  return res.json({ players });
});


router.get("/world/partial", async (req, res) => {
  const pid =
    (req.session as any).playerId;

  if (!pid) {
    return res.status(401).json({
      error: "Not logged in"
    });
  }

  const [[player]]: any =
    await db.query(
      `
        SELECT
          map_x,
          map_y

        FROM players

        WHERE id = ?

        LIMIT 1
      `,
      [pid]
    );

  if (!player) {
    return res.status(404).json({
      error: "Player not found"
    });
  }

  const px =
    Number(player.map_x);

  const py =
    Number(player.map_y);

  const minX = px - 5;
  const maxX = px + 5;
  const minY = py - 5;
  const maxY = py + 5;


  /* =========================================
     WORLD OBJECTS
  ========================================= */

  let [worldObjects]: any =
    await db.query(
      `
        SELECT
          id,
          name,
          x,
          y,
          tile_sprite,
          tile_visual_type,
          z_index

        FROM world_objects

        WHERE is_active = 1
          AND x BETWEEN ? AND ?
          AND y BETWEEN ? AND ?

        ORDER BY
          z_index ASC,
          id ASC
      `,
      [
        minX,
        maxX,
        minY,
        maxY
      ]
    );


  worldObjects = await filterHallowedPumpkinsForPlayer(Number(pid), worldObjects);
  worldObjects = await markActiveQuestWorldObjects(Number(pid), worldObjects);

  /* =========================================
     WORLD TILES
  ========================================= */

  const [tiles]: any =
    await db.query(
      `
        SELECT *

        FROM world_map

        WHERE x BETWEEN ? AND ?
          AND y BETWEEN ? AND ?
      `,
      [
        minX,
        maxX,
        minY,
        maxY
      ]
    );

  const nearbyPlayers =
    await getNearbyWorldPlayers(
      Number(pid),
      px,
      py,
      5
    );


  /* =========================================
     RESOURCE NODES
  ========================================= */

  const resourceNodes =
    await getResourceNodesInRange(
      Number(pid),
      px,
      py,
      5
    );

const huntTargets =
  await getHuntTargetsInRange(
    Number(pid),
    px,
    py,
    5
  );

const worldEventInteractSpawns =
  await getWorldEventInteractSpawnsInRange(
    Number(pid),
    px,
    py,
    5
  );

const worldEventMapSpawns =
  await getWorldEventMapSpawnsInRange(
    Number(pid),
    px,
    py,
    5
  );

  /* =========================================
     ACTIVE HUNT CLUES
  ========================================= */

  const [huntClueRows]: any =
    await db.query(
      `
        SELECT
          phc.id,
          phc.map_x,
          phc.map_y,

          hc.name,
          hc.description,
          hc.icon,

          ph.id AS party_hunt_id,
          h.name AS hunt_name

        FROM party_members pm

        JOIN party_hunts ph
          ON ph.party_id =
             pm.party_id

        JOIN hunt_participants hp
          ON hp.party_hunt_id =
             ph.id
         AND hp.player_id =
             pm.player_id

        JOIN party_hunt_clues phc
          ON phc.party_hunt_id =
             ph.id

        JOIN hunt_clues hc
          ON hc.id =
             phc.hunt_clue_id

        JOIN hunts h
          ON h.id =
             ph.hunt_id

        WHERE pm.player_id = ?

          AND ph.status IN (
            'tracking',
            'revealed',
            'engaged'
          )

          AND phc.is_investigated = 0

          AND phc.map_x
            BETWEEN ? AND ?

          AND phc.map_y
            BETWEEN ? AND ?

        ORDER BY
          phc.id ASC
      `,
      [
        pid,
        minX,
        maxX,
        minY,
        maxY
      ]
    );


  const huntClues =
    (huntClueRows || []).map(
      (row: any) => {

        const distance =
          Math.abs(
            px -
            Number(row.map_x)
          ) +
          Math.abs(
            py -
            Number(row.map_y)
          );

        return {
          id:
            Number(row.id),

          name:
            String(
              row.name ||
              "Unknown Clue"
            ),

          object_type:
            "hunt_clue",

          x:
            Number(row.map_x),

          y:
            Number(row.map_y),

          distance,

          inRange:
            distance === 0,

          interaction_radius:
            0,

          icon:
            row.icon || "🐾",

          description:
            row.description ?? null,

          partyHuntId:
            Number(
              row.party_hunt_id
            ),

          huntName:
            String(
              row.hunt_name ||
              "Hunt"
            )
        };
      }
    );


  /* =========================================
     RESPONSE
  ========================================= */

  return res.json({
    player,
    tiles,
    worldObjects,
    resourceNodes,
    nearbyPlayers,
    huntClues,
    huntTargets,
    worldEventInteractSpawns,
    worldEventMapSpawns
  });
});


router.post("/api/world-event/interact/:spawnId", async (req, res) => {
  try {
    const pid =
      (req.session as any)?.playerId;

    if (!pid) {
      return res.status(401).json({
        error: "not_logged_in"
      });
    }

    const spawnId =
      Number(req.params.spawnId);

    if (
      !Number.isInteger(spawnId) ||
      spawnId <= 0
    ) {
      return res.status(400).json({
        error: "invalid_spawn_id"
      });
    }

    const [[player]]: any =
      await db.query(
        `
          SELECT
            map_x,
            map_y
          FROM players
          WHERE id = ?
          LIMIT 1
        `,
        [pid]
      );

    if (!player) {
      return res.status(404).json({
        error: "player_not_found"
      });
    }

    const [[spawn]]: any =
      await db.query(
        `
          SELECT
            aws.id,
            aws.active_event_id,
            aws.spawn_definition_id,
            aws.x,
            aws.y,
            aws.spawn_type,

            awe.region_id,

            ws.spawn_key

          FROM active_world_event_spawns aws

          JOIN active_world_events awe
            ON awe.id = aws.active_event_id

          JOIN world_event_spawns ws
            ON ws.id = aws.spawn_definition_id

          WHERE aws.id = ?
            AND aws.spawn_type = 'INTERACT'
            AND aws.state = 'ACTIVE'
            AND aws.removed_at IS NULL

            AND awe.status = 'ACTIVE'
            AND awe.ends_at > NOW()

            AND NOT EXISTS (
              SELECT 1
              FROM player_world_event_spawn_interactions pwesi
              WHERE pwesi.active_event_id = aws.active_event_id
                AND pwesi.player_id = ?
                AND pwesi.spawn_id = aws.id
            )

            AND NOT EXISTS (
              SELECT 1
              FROM player_world_event_state pwes
              JOIN world_event_outcomes chosen_outcome
                ON chosen_outcome.id = pwes.chosen_outcome_id
              WHERE pwes.active_event_id = aws.active_event_id
                AND pwes.player_id = ?
                AND pwes.chosen_outcome_id IS NOT NULL
                AND chosen_outcome.phase_id = awe.phase_id
            )

          LIMIT 1
        `,
        [spawnId, Number(pid), Number(pid)]
      );

    if (!spawn) {
      return res.status(404).json({
        error: "world_event_interaction_not_found"
      });
    }

    const distance =
      Math.abs(
        Number(player.map_x) -
        Number(spawn.x)
      ) +
      Math.abs(
        Number(player.map_y) -
        Number(spawn.y)
      );

    if (distance !== 0) {
      return res.status(400).json({
        error: "too_far_away"
      });
    }

    /*
     * Each INTERACT spawn definition is used as the objective target_id.
     * This keeps Reinforce the Seal and Follow the Resonance independent
     * instead of allowing one interaction to advance both objectives.
     */
    const progress =
      await recordWorldEventProgress({
        playerId: Number(pid),
        regionId: Number(spawn.region_id),
        type: "INTERACT",
        targetId: Number(spawn.spawn_definition_id),
        amount: 1
      });

    if (!progress.matched) {
      return res.status(409).json({
        error: "world_event_objective_not_active"
      });
    }

    /*
     * Consume this spawn for THIS PLAYER only. The physical spawn remains
     * ACTIVE globally so other players can still use the same event object.
     */
    const completed =
      await recordPlayerWorldEventSpawnInteraction(
        Number(spawn.active_event_id),
        Number(pid),
        Number(spawn.id)
      );


    return res.json({
      success: true,

      interaction: {
        spawnId: Number(spawn.id),
        spawnKey: String(spawn.spawn_key),
        completed
      },

      worldEventProgress: progress
    });

  } catch (err) {
    console.error(
      "POST /api/world-event/interact/:spawnId ERROR:",
      err
    );

    return res.status(500).json({
      error: "server_error"
    });
  }
});


// =======================
// HALLOWED SEASONAL VENDOR
// =======================
const HALLOWED_VENDOR_OBJECT_TYPE = "seasonal_vendor";
const HALLOWED_VENDOR_KEY = "headless_horseman";
const HALLOWED_CANDY_CORN_ITEM_ID = 61;
const HALLOWED_PORTRAIT_AVATAR_ID = 12;
const HALLOWED_PORTRAIT_COST = 50;
const HALLOWED_TRICK_OR_TREAT_BAG_NAME = "Trick-or-Treat Bag";
const HALLOWED_TRICK_OR_TREAT_BAG_COST = 100;
const HALLOWED_SMASH_QUEST_TITLE = "Smashing Good Fun";
const HALLOWED_PUMPKIN_KEY = "hallowed_smashable_pumpkin";

async function getHallowedVendorForPlayer(playerId: number, objectId: number, executor: any = db) {
  const [[row]]: any = await executor.query(
    `
      SELECT
        wo.id,
        wo.name,
        wo.object_type,
        wo.x,
        wo.y,
        wo.interaction_radius,
        wo.params_json,
        p.map_x,
        p.map_y
      FROM world_objects wo
      JOIN players p ON p.id = ?
      WHERE wo.id = ?
        AND wo.is_active = 1
        AND wo.object_type = ?
      LIMIT 1
    `,
    [playerId, objectId, HALLOWED_VENDOR_OBJECT_TYPE]
  );

  if (!row) throw new Error("SEASONAL_VENDOR_NOT_FOUND");

  let params: any = row.params_json || {};
  if (typeof params === "string") {
    try { params = JSON.parse(params); } catch { params = {}; }
  }

  if (String(params?.vendor_key || "") !== HALLOWED_VENDOR_KEY) {
    throw new Error("SEASONAL_VENDOR_NOT_FOUND");
  }

  const distance =
    Math.abs(Number(row.map_x) - Number(row.x)) +
    Math.abs(Number(row.map_y) - Number(row.y));
  const radius = Math.max(0, Number(row.interaction_radius) || 1);

  if (distance > radius) throw new Error("TOO_FAR_AWAY");
  return row;
}

async function getHallowedSmashQuestState(playerId: number) {
  const [[quest]]: any = await db.query(
    `SELECT id, title, description, dialog_intro, dialog_complete FROM quests WHERE title=? AND is_active=1 LIMIT 1`,
    [HALLOWED_SMASH_QUEST_TITLE]
  );
  if (!quest) return null;

  const [[pq]]: any = await db.query(
    `SELECT id, status FROM player_quests WHERE player_id=? AND quest_id=? ORDER BY id DESC LIMIT 1`,
    [playerId, Number(quest.id)]
  );

  let progress = 0;
  let required = 10;
  if (pq?.id) {
    const [[obj]]: any = await db.query(
      `SELECT pqo.progress_count, qo.required_count
       FROM player_quest_objectives pqo
       JOIN quest_objectives qo ON qo.id=pqo.objective_id
       WHERE pqo.player_quest_id=? AND qo.type='DESTROY_OBJECT'
       ORDER BY qo.step_order ASC, qo.id ASC LIMIT 1`,
      [Number(pq.id)]
    );
    progress = Number(obj?.progress_count || 0);
    required = Math.max(1, Number(obj?.required_count || 10));
  }

  return {
    questId: Number(quest.id),
    playerQuestId: pq?.id ? Number(pq.id) : null,
    title: String(quest.title),
    description: quest.description || null,
    dialogIntro: quest.dialog_intro || null,
    dialogComplete: quest.dialog_complete || null,
    status: pq?.status || "available",
    progress,
    required,
    canAccept: !pq
  };
}

router.get("/api/seasonal-vendor/:objectId", async (req, res) => {
  try {
    const pid = Number((req.session as any)?.playerId);
    if (!pid) return res.status(401).json({ error: "not_logged_in" });

    const objectId = Number(req.params.objectId);
    if (!Number.isInteger(objectId) || objectId <= 0) {
      return res.status(400).json({ error: "invalid_object_id" });
    }

    const vendor = await getHallowedVendorForPlayer(pid, objectId);
    const quest = await getHallowedSmashQuestState(pid);

    const [[currency]]: any = await db.query(
      `SELECT COALESCE(SUM(quantity), 0) AS quantity FROM inventory WHERE player_id = ? AND item_id = ?`,
      [pid, HALLOWED_CANDY_CORN_ITEM_ID]
    );

    const [[owned]]: any = await db.query(
      `SELECT 1 AS owned FROM player_avatars WHERE player_id = ? AND avatar_id = ? LIMIT 1`,
      [pid, HALLOWED_PORTRAIT_AVATAR_ID]
    );

    const [[avatar]]: any = await db.query(
      `SELECT id, name, image_url, rarity, description FROM avatars WHERE id = ? AND is_active = 1 LIMIT 1`,
      [HALLOWED_PORTRAIT_AVATAR_ID]
    );

    if (!avatar) return res.status(404).json({ error: "seasonal_reward_not_found" });

    const [[bag]]: any = await db.query(
      `SELECT id, name, icon, rarity, description, inventory_slots FROM items WHERE name = ? AND slot = 'backpack' LIMIT 1`,
      [HALLOWED_TRICK_OR_TREAT_BAG_NAME]
    );

    const [[bagOwned]]: any = bag ? await db.query(
      `SELECT 1 AS owned FROM inventory WHERE player_id = ? AND item_id = ? LIMIT 1`,
      [pid, Number(bag.id)]
    ) : [[]];

    return res.json({
      success: true,
      vendor: {
        id: Number(vendor.id),
        name: String(vendor.name || "The Headless Horseman"),
        dialogue: "The silent rider extends a gloved hand toward your collection of Candy Corn..."
      },
      quest,
      currency: {
        itemId: HALLOWED_CANDY_CORN_ITEM_ID,
        name: "Candy Corn",
        quantity: Number(currency?.quantity || 0)
      },
      reward: {
        avatarId: Number(avatar.id),
        name: avatar.name || "Hallowed Alpha Portrait",
        imageUrl: avatar.image_url || null,
        rarity: avatar.rarity || "rare",
        description: avatar.description || "An exclusive portrait from the Guildforge Alpha Hallowed event.",
        cost: HALLOWED_PORTRAIT_COST,
        owned: !!owned
      },
      bag: bag ? {
        itemId: Number(bag.id),
        name: String(bag.name || HALLOWED_TRICK_OR_TREAT_BAG_NAME),
        icon: bag.icon || null,
        rarity: bag.rarity || "epic",
        description: bag.description || "A suspiciously spacious sack smelling faintly of caramel, candle wax, and poor decisions.",
        inventorySlots: Number(bag.inventory_slots || 10),
        cost: HALLOWED_TRICK_OR_TREAT_BAG_COST,
        owned: !!bagOwned,
        unlocked: String(quest?.status || "") === "claimed"
      } : null
    });
  } catch (err: any) {
    const msg = String(err?.message || "");
    if (msg === "SEASONAL_VENDOR_NOT_FOUND") return res.status(404).json({ error: "seasonal_vendor_not_found" });
    if (msg === "TOO_FAR_AWAY") return res.status(400).json({ error: "too_far_away" });
    console.error("GET /api/seasonal-vendor/:objectId ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

router.post("/api/seasonal-vendor/:objectId/purchase", async (req, res) => {
  const pid = Number((req.session as any)?.playerId);
  if (!pid) return res.status(401).json({ error: "not_logged_in" });

  const objectId = Number(req.params.objectId);
  if (!Number.isInteger(objectId) || objectId <= 0) {
    return res.status(400).json({ error: "invalid_object_id" });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await getHallowedVendorForPlayer(pid, objectId, conn);

    const [[owned]]: any = await conn.query(
      `SELECT 1 AS owned FROM player_avatars WHERE player_id = ? AND avatar_id = ? LIMIT 1 FOR UPDATE`,
      [pid, HALLOWED_PORTRAIT_AVATAR_ID]
    );
    if (owned) {
      await conn.rollback();
      return res.status(409).json({ error: "already_owned" });
    }

    const [stacks]: any = await conn.query(
      `
        SELECT inventory_id, quantity
        FROM inventory
        WHERE player_id = ? AND item_id = ? AND quantity > 0
        ORDER BY inventory_id ASC
        FOR UPDATE
      `,
      [pid, HALLOWED_CANDY_CORN_ITEM_ID]
    );

    const total = (stacks || []).reduce((sum: number, stack: any) => sum + Number(stack.quantity || 0), 0);
    if (total < HALLOWED_PORTRAIT_COST) {
      await conn.rollback();
      return res.status(400).json({
        error: "not_enough_candy_corn",
        required: HALLOWED_PORTRAIT_COST,
        current: total
      });
    }

    let remaining = HALLOWED_PORTRAIT_COST;
    for (const stack of stacks || []) {
      if (remaining <= 0) break;
      const qty = Number(stack.quantity || 0);
      const spend = Math.min(qty, remaining);
      const left = qty - spend;

      if (left <= 0) {
        await conn.query(`DELETE FROM inventory WHERE inventory_id = ? AND player_id = ?`, [stack.inventory_id, pid]);
      } else {
        await conn.query(`UPDATE inventory SET quantity = ? WHERE inventory_id = ? AND player_id = ?`, [left, stack.inventory_id, pid]);
      }
      remaining -= spend;
    }

    await conn.query(
      `INSERT INTO player_avatars (player_id, avatar_id) VALUES (?, ?)`,
      [pid, HALLOWED_PORTRAIT_AVATAR_ID]
    );

    await conn.commit();

    return res.json({
      success: true,
      message: "Hallowed Alpha Portrait unlocked!",
      avatarId: HALLOWED_PORTRAIT_AVATAR_ID,
      candyCornSpent: HALLOWED_PORTRAIT_COST,
      candyCornRemaining: total - HALLOWED_PORTRAIT_COST
    });
  } catch (err: any) {
    try { await conn.rollback(); } catch (_) {}
    const msg = String(err?.message || "");
    if (msg === "SEASONAL_VENDOR_NOT_FOUND") return res.status(404).json({ error: "seasonal_vendor_not_found" });
    if (msg === "TOO_FAR_AWAY") return res.status(400).json({ error: "too_far_away" });
    console.error("POST /api/seasonal-vendor/:objectId/purchase ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  } finally {
    conn.release();
  }
});

router.post("/api/seasonal-vendor/:objectId/purchase-bag", async (req, res) => {
  const pid = Number((req.session as any)?.playerId);
  if (!pid) return res.status(401).json({ error: "not_logged_in" });

  const objectId = Number(req.params.objectId);
  if (!Number.isInteger(objectId) || objectId <= 0) {
    return res.status(400).json({ error: "invalid_object_id" });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await getHallowedVendorForPlayer(pid, objectId, conn);

    const [[questRow]]: any = await conn.query(
      `SELECT pq.status
       FROM quests q
       JOIN player_quests pq ON pq.quest_id = q.id AND pq.player_id = ?
       WHERE q.title = ? AND q.is_active = 1
       ORDER BY pq.id DESC
       LIMIT 1
       FOR UPDATE`,
      [pid, HALLOWED_SMASH_QUEST_TITLE]
    );

    if (String(questRow?.status || "") !== "claimed") {
      await conn.rollback();
      return res.status(403).json({ error: "quest_required" });
    }

    const [[bag]]: any = await conn.query(
      `SELECT id, name, inventory_slots FROM items WHERE name = ? AND slot = 'backpack' LIMIT 1`,
      [HALLOWED_TRICK_OR_TREAT_BAG_NAME]
    );
    if (!bag) {
      await conn.rollback();
      return res.status(404).json({ error: "seasonal_bag_not_found" });
    }

    const [[owned]]: any = await conn.query(
      `SELECT 1 AS owned FROM inventory WHERE player_id = ? AND item_id = ? LIMIT 1 FOR UPDATE`,
      [pid, Number(bag.id)]
    );
    if (owned) {
      await conn.rollback();
      return res.status(409).json({ error: "already_owned" });
    }

    const [stacks]: any = await conn.query(
      `SELECT inventory_id, quantity
       FROM inventory
       WHERE player_id = ? AND item_id = ? AND quantity > 0
       ORDER BY inventory_id ASC
       FOR UPDATE`,
      [pid, HALLOWED_CANDY_CORN_ITEM_ID]
    );

    const total = (stacks || []).reduce((sum: number, stack: any) => sum + Number(stack.quantity || 0), 0);
    if (total < HALLOWED_TRICK_OR_TREAT_BAG_COST) {
      await conn.rollback();
      return res.status(400).json({
        error: "not_enough_candy_corn",
        required: HALLOWED_TRICK_OR_TREAT_BAG_COST,
        current: total
      });
    }

    let remaining = HALLOWED_TRICK_OR_TREAT_BAG_COST;
    for (const stack of stacks || []) {
      if (remaining <= 0) break;
      const qty = Number(stack.quantity || 0);
      const spend = Math.min(qty, remaining);
      const left = qty - spend;

      if (left <= 0) {
        await conn.query(`DELETE FROM inventory WHERE inventory_id = ? AND player_id = ?`, [stack.inventory_id, pid]);
      } else {
        await conn.query(`UPDATE inventory SET quantity = ? WHERE inventory_id = ? AND player_id = ?`, [left, stack.inventory_id, pid]);
      }
      remaining -= spend;
    }

    await conn.query(
      `INSERT INTO inventory (player_id, item_id, player_item_id, quantity, equipped, durability, randid)
       VALUES (?, ?, NULL, 1, 0, NULL, NULL)`,
      [pid, Number(bag.id)]
    );

    await conn.commit();
    return res.json({
      success: true,
      message: `${String(bag.name)} purchased!`,
      itemId: Number(bag.id),
      inventorySlots: Number(bag.inventory_slots || 10),
      candyCornSpent: HALLOWED_TRICK_OR_TREAT_BAG_COST,
      candyCornRemaining: total - HALLOWED_TRICK_OR_TREAT_BAG_COST
    });
  } catch (err: any) {
    try { await conn.rollback(); } catch (_) {}
    const msg = String(err?.message || "");
    if (msg === "SEASONAL_VENDOR_NOT_FOUND") return res.status(404).json({ error: "seasonal_vendor_not_found" });
    if (msg === "TOO_FAR_AWAY") return res.status(400).json({ error: "too_far_away" });
    console.error("POST /api/seasonal-vendor/:objectId/purchase-bag ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  } finally {
    conn.release();
  }
});

router.post("/api/seasonal-vendor/:objectId/quest/accept", async (req, res) => {
  try {
    const pid = Number((req.session as any)?.playerId);
    if (!pid) return res.status(401).json({ error: "not_logged_in" });
    const objectId = Number(req.params.objectId);
    if (!Number.isInteger(objectId) || objectId <= 0) return res.status(400).json({ error: "invalid_object_id" });

    await getHallowedVendorForPlayer(pid, objectId);
    const [[quest]]: any = await db.query(`SELECT id FROM quests WHERE title=? AND is_active=1 LIMIT 1`, [HALLOWED_SMASH_QUEST_TITLE]);
    if (!quest) return res.status(404).json({ error: "seasonal_quest_not_found" });

    const out = await acceptQuest(pid, Number(quest.id), "tavern");
    invalidateActiveQuestWorldTargetCache(Number(pid));
    return res.json({ success: true, ...out, quest: await getHallowedSmashQuestState(pid) });
  } catch (err: any) {
    const msg = String(err?.message || "");
    if (String(err?.code) === "ER_DUP_ENTRY") return res.status(409).json({ error: "quest_already_accepted" });
    if (msg === "SEASONAL_VENDOR_NOT_FOUND") return res.status(404).json({ error: "seasonal_vendor_not_found" });
    if (msg === "TOO_FAR_AWAY") return res.status(400).json({ error: "too_far_away" });
    console.error("POST seasonal Halloween quest accept ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

router.post("/api/seasonal-vendor/:objectId/quest/turn-in", async (req, res) => {
  try {
    const pid = Number((req.session as any)?.playerId);
    if (!pid) return res.status(401).json({ error: "not_logged_in" });

    const objectId = Number(req.params.objectId);
    if (!Number.isInteger(objectId) || objectId <= 0) {
      return res.status(400).json({ error: "invalid_object_id" });
    }

    // The seasonal quest can only be turned in while standing at the Headless Horseman.
    await getHallowedVendorForPlayer(pid, objectId);

    const [[quest]]: any = await db.query(
      `SELECT id FROM quests WHERE title=? AND is_active=1 LIMIT 1`,
      [HALLOWED_SMASH_QUEST_TITLE]
    );
    if (!quest) return res.status(404).json({ error: "seasonal_quest_not_found" });

    const [[pq]]: any = await db.query(
      `SELECT id, status
       FROM player_quests
       WHERE player_id=? AND quest_id=?
       ORDER BY id DESC
       LIMIT 1`,
      [pid, Number(quest.id)]
    );

    if (!pq) return res.status(404).json({ error: "seasonal_quest_not_accepted" });
    if (String(pq.status) === "claimed") {
      return res.status(409).json({ error: "quest_already_claimed" });
    }
    if (String(pq.status) !== "completed") {
      return res.status(400).json({ error: "quest_not_completed" });
    }

    const reward = await claimQuestRewards(pid, Number(pq.id));
    invalidateActiveQuestWorldTargetCache(Number(pid));

    // It no longer needs to occupy a tracked-quest slot after being handed in.
    await db.query(
      `DELETE FROM player_tracked_quests WHERE player_id=? AND player_quest_id=?`,
      [pid, Number(pq.id)]
    );

    return res.json({
      ...reward,
      message: "Smashing Good Fun turned in!",
      quest: await getHallowedSmashQuestState(pid)
    });
  } catch (err: any) {
    const msg = String(err?.message || "");
    if (msg === "SEASONAL_VENDOR_NOT_FOUND") return res.status(404).json({ error: "seasonal_vendor_not_found" });
    if (msg === "TOO_FAR_AWAY") return res.status(400).json({ error: "too_far_away" });
    if (msg === "PLAYER_QUEST_NOT_FOUND") return res.status(404).json({ error: "seasonal_quest_not_accepted" });
    if (msg === "QUEST_NOT_COMPLETED") return res.status(400).json({ error: "quest_not_completed" });
    if (msg === "ALREADY_CLAIMED") return res.status(409).json({ error: "quest_already_claimed" });
    console.error("POST seasonal Halloween quest turn-in ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

router.post("/api/world/destroy/:objectId", async (req, res) => {
  try {
    const pid = Number((req.session as any)?.playerId);
    if (!pid) return res.status(401).json({ error: "not_logged_in" });
    const objectId = Number(req.params.objectId);
    if (!Number.isInteger(objectId) || objectId <= 0) return res.status(400).json({ error: "invalid_object_id" });

    const [[row]]: any = await db.query(
      `SELECT wo.id, wo.params_json, wo.interaction_radius, wo.x, wo.y, p.map_x, p.map_y
       FROM world_objects wo JOIN players p ON p.id=?
       WHERE wo.id=? AND wo.is_active=1 LIMIT 1`,
      [pid, objectId]
    );
    if (!row) return res.status(404).json({ error: "world_object_not_found" });
    let params: any = row.params_json || {};
    if (typeof params === "string") { try { params = JSON.parse(params); } catch { params = {}; } }
    if (String(params?.seasonal_key || "") !== HALLOWED_PUMPKIN_KEY || params?.destroyable !== true) {
      return res.status(400).json({ error: "object_not_destroyable" });
    }

    const [[activeQuest]]: any = await db.query(
      `SELECT pq.id
       FROM player_quests pq
       JOIN quests q ON q.id = pq.quest_id
       WHERE pq.player_id = ?
         AND q.title = ?
         AND q.is_active = 1
         AND pq.status = 'active'
       ORDER BY pq.id DESC
       LIMIT 1`,
      [pid, HALLOWED_SMASH_QUEST_TITLE]
    );

    if (!activeQuest) {
      return res.status(400).json({ error: "no_active_destroy_objective" });
    }
    const distance = Math.abs(Number(row.map_x)-Number(row.x)) + Math.abs(Number(row.map_y)-Number(row.y));
    if (distance > Math.max(0, Number(row.interaction_radius)||1)) return res.status(400).json({ error: "too_far_away" });

    const [[alreadySmashed]]: any = await db.query(
      `SELECT 1 AS smashed FROM player_seasonal_object_interactions WHERE player_id=? AND world_object_id=? AND interaction_key='smash' LIMIT 1`,
      [pid, objectId]
    );
    if (alreadySmashed) return res.status(409).json({ error: "pumpkin_already_smashed" });

    const out = await applyDestroyObjectProgress(pid, objectId);
    invalidateActiveQuestWorldTargetCache(Number(pid));
    if (!out.updatedObjectives.length) return res.status(400).json({ error: "no_active_destroy_objective" });

    await db.query(
      `INSERT INTO player_seasonal_object_interactions (player_id, world_object_id, interaction_key) VALUES (?, ?, 'smash')`,
      [pid, objectId]
    );
    return res.json({ success: true, smashed: true, ...out });
  } catch (err: any) {
    const msg = String(err?.message || "");
    if (msg === "WORLD_OBJECT_NOT_FOUND") return res.status(404).json({ error: "world_object_not_found" });
    console.error("POST /api/world/destroy/:objectId ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

router.post("/api/world/interact/:objectId", async (req, res) => {
  try {
    const pid = (req.session as any)?.playerId;
    if (!pid) return res.status(401).json({ error: "not_logged_in" });

    const objectId = Number(req.params.objectId);
    if (!Number.isFinite(objectId)) {
      return res.status(400).json({ error: "invalid_object_id" });
    }

    const out = await applyInteractProgress(pid, objectId);
    invalidateActiveQuestWorldTargetCache(Number(pid));
    return res.json(out);
  } catch (err: any) {
    const msg = String(err?.message || "");
    console.error("🔥 POST /api/world/interact/:objectId ERROR:", err);

    if (msg === "PLAYER_NOT_FOUND") return res.status(404).json({ error: "player_not_found" });
    if (msg === "WORLD_OBJECT_NOT_FOUND") return res.status(404).json({ error: "world_object_not_found" });
    if (msg === "TOO_FAR_AWAY") return res.status(400).json({ error: "too_far_away" });

    return res.status(500).json({ error: "server_error" });
  }
});


export default router;


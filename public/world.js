// public/world.js

let pendingCombatEnemy = null;
let lastMoveDir = null;

// ✅ Movement cooldown
const MOVE_COOLDOWN_MS = 0;

// Visible world is 9x9. We render an extra hidden one-tile buffer on every
// side (11x11 total) so full-cell scrolling never reveals an empty edge.
const WORLD_VIEW_RADIUS = 4;
const WORLD_VIEW_SIZE = 9;
const WORLD_BUFFER_RADIUS = 5;
const WORLD_BUFFER_SIZE = 11;
const WORLD_SCROLL_MS = 420;
let lastMoveAt = 0;
let moveLock = false;

let currentResourceNode = null;

let dungeonReadyCheck = null;
let dungeonReadySelfId = null;
let dungeonReadyPollTimer = null;
let dungeonReadyCountdownTimer = null;
let dungeonReadyBusy = false;
let dungeonReadyTransitioning = false;

let dungeonSocket = null;
let dungeonSocketBound = false;

/*
 * Once a ready check resolves, never allow an older pending snapshot
 * for that same check to render again. This protects against an
 * in-flight REST poll finishing after the websocket completion event.
 */
const resolvedDungeonReadyCheckIds =
  new Set();

let dungeonReadyFetchGeneration =
  0;

// ==========================================
// PROCEDURAL WORLD VISUAL TEST
// ==========================================
// Enable only with /world?procedural=1. Normal /world rendering is untouched.
const PROCEDURAL_WORLD_TEST =
  new URLSearchParams(window.location.search).get("procedural") === "1";

// Lock this once we settle on Valewyn's permanent seed.
const VALEWYN_WORLD_SEED = 582941;

// One neutral road texture is shaped at render time from neighboring road tiles.
const PROCEDURAL_ROAD_ASSET =
  "/images/world/procedural/roads/road.webp";

const PROCEDURAL_BIOMES = {
  coastal: {
    terrains: new Set(["plains"]),
    ground: "/images/world/procedural/coastal-lowlands/ground.webp",
    decorations: [
      "/images/world/procedural/coastal-lowlands/grass-01.webp",
      "/images/world/procedural/coastal-lowlands/grass-02.webp",
      "/images/world/procedural/coastal-lowlands/rocks-01.webp",
      "/images/world/procedural/coastal-lowlands/rocks-02.webp",
      "/images/world/procedural/coastal-lowlands/flowers-01.webp",
      "/images/world/procedural/coastal-lowlands/shrub-01.webp",
      "/images/world/procedural/coastal-lowlands/driftwood-01.webp"
    ]
  },

  blackfen: {
    terrains: new Set(["swamp"]),
    ground: "/images/world/procedural/blackfen-marsh/ground.webp",
    decorations: [
      "/images/world/procedural/blackfen-marsh/reeds-01.webp",
      "/images/world/procedural/blackfen-marsh/mud-01.webp",
      "/images/world/procedural/blackfen-marsh/deadbranch-01.webp",
      "/images/world/procedural/blackfen-marsh/mushrooms-01.webp",
      "/images/world/procedural/blackfen-marsh/swamprock-01.webp",
      "/images/world/procedural/blackfen-marsh/deadshrub-01.webp"
    ]
  },

  greenreach: {
    terrains: new Set(["forest"]),
    ground: "/images/world/procedural/greenreach-wilds/ground.webp",
    decorations: [
      "/images/world/procedural/greenreach-wilds/fern-01.webp",
      "/images/world/procedural/greenreach-wilds/fern-02.webp",
      "/images/world/procedural/greenreach-wilds/mushrooms-01.webp",
      "/images/world/procedural/greenreach-wilds/leafpile-01.webp",
      "/images/world/procedural/greenreach-wilds/bush-01.webp",
      "/images/world/procedural/greenreach-wilds/sapling-01.webp",
      "/images/world/procedural/greenreach-wilds/stump-01.webp",
      "/images/world/procedural/greenreach-wilds/tree-01.webp"
    ]
  },

  water: {
    terrains: new Set(["void"]),
    ground: "/images/world/procedural/water/water.webp",
    decorations: []
  }
};

function hashWorldCoordinate(x, y, channel = 0) {
  let h = VALEWYN_WORLD_SEED | 0;

  h = Math.imul(h ^ Math.imul(Number(x) | 0, 374761393), 668265263);
  h = Math.imul(h ^ Math.imul(Number(y) | 0, 1274126177), 2246822519);
  h = Math.imul(h ^ Math.imul(Number(channel) | 0, 3266489917), 668265263);

  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  h ^= h >>> 16;

  return h >>> 0;
}

function seededWorldRandom(x, y, channel = 0) {
  return hashWorldCoordinate(x, y, channel) / 4294967296;
}

function getDirectProceduralBiomeKey(tile) {
  if (!tile) return null;

  const terrain = String(tile.terrain || "")
    .trim()
    .toLowerCase();

  for (const [key, config] of Object.entries(PROCEDURAL_BIOMES)) {
    if (config.terrains.has(terrain)) {
      return key;
    }
  }

  return null;
}

function getProceduralBiomeKey(tile, x = null, y = null, tileMap = null) {
  if (!tile) return null;

  const directBiome = getDirectProceduralBiomeKey(tile);
  if (directBiome) return directBiome;

  const terrain = String(tile.terrain || "")
    .trim()
    .toLowerCase();

  if (terrain !== "road") {
    return null;
  }

  // First try the road tile's own region metadata.
  const regionName = String(
    tile.region_name ??
    tile.region ??
    tile.regionName ??
    ""
  ).trim().toLowerCase();

  if (regionName.includes("blackfen")) return "blackfen";
  if (regionName.includes("greenreach") || regionName.includes("wilds")) {
    return "greenreach";
  }
  if (regionName.includes("coastal") || regionName.includes("lowlands")) {
    return "coastal";
  }

  // Some existing road rows do not carry a biome-style region name. In that
  // case, infer the road's underlying biome from the nearest non-road terrain
  // in the currently-rendered world buffer. This makes old road tiles work
  // without changing world_map data.
  if (tileMap && Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
    const cx = Number(x);
    const cy = Number(y);

    for (let radius = 1; radius <= 5; radius++) {
      const counts = new Map();

      for (let dx = -radius; dx <= radius; dx++) {
        const dy = radius - Math.abs(dx);
        const candidates = dy === 0
          ? [[cx + dx, cy]]
          : [[cx + dx, cy - dy], [cx + dx, cy + dy]];

        for (const [tx, ty] of candidates) {
          const candidate = tileMap[`${tx},${ty}`];
          const biomeKey = getDirectProceduralBiomeKey(candidate);
          if (!biomeKey) continue;
          counts.set(biomeKey, (counts.get(biomeKey) || 0) + 1);
        }
      }

      if (counts.size) {
        return [...counts.entries()]
          .sort((a, b) => b[1] - a[1])[0][0];
      }
    }
  }

  return null;
}

function isProceduralRoadTile(tile) {
  return String(tile?.terrain || "")
    .trim()
    .toLowerCase() === "road";
}

function getRoadConnections(x, y, tileMap) {
  const roadAt = (tx, ty) =>
    isProceduralRoadTile(tileMap?.[`${tx},${ty}`]);

  return {
    north: roadAt(x, y - 1),
    south: roadAt(x, y + 1),
    east: roadAt(x + 1, y),
    west: roadAt(x - 1, y)
  };
}

function shouldUseProceduralTile(tile, replaceSprite, x, y, tileMap) {
  return Boolean(
    PROCEDURAL_WORLD_TEST &&
    tile &&
    !replaceSprite &&
    getProceduralBiomeKey(tile, x, y, tileMap)
  );
}

function getProceduralAssetKind(src) {
  const file = String(src || "").split("/").pop()?.toLowerCase() || "";

  if (file.startsWith("grass-")) return "grass";
  if (file.startsWith("rocks-")) return "rocks";
  if (file.startsWith("flowers-")) return "flowers";
  if (file.startsWith("shrub-")) return "shrub";
  if (file.startsWith("driftwood-")) return "driftwood";
  if (file.startsWith("reeds-")) return "reeds";
  if (file.startsWith("mud-")) return "mud";
  if (file.startsWith("deadbranch-")) return "deadbranch";
  if (file.startsWith("mushrooms-")) return "mushrooms";
  if (file.startsWith("swamprock-")) return "swamprock";
  if (file.startsWith("deadshrub-")) return "deadshrub";
  if (file.startsWith("fern-")) return "fern";
  if (file.startsWith("leafpile-")) return "leafpile";
  if (file.startsWith("bush-")) return "bush";
  if (file.startsWith("sapling-")) return "sapling";
  if (file.startsWith("stump-")) return "stump";
  if (file.startsWith("tree-")) return "tree";

  return "default";
}

function getProceduralPropSize(x, y, src, channel) {
  const kind = getProceduralAssetKind(src);
  const roll = seededWorldRandom(x, y, channel);

  const ranges = {
    grass: [20, 30],
    flowers: [18, 27],
    rocks: [22, 34],
    shrub: [25, 36],
    driftwood: [27, 39],
    reeds: [22, 34],
    mud: [34, 52],
    deadbranch: [27, 41],
    mushrooms: [19, 29],
    swamprock: [23, 35],
    deadshrub: [27, 41],
    fern: [24, 36],
    leafpile: [25, 39],
    bush: [30, 44],
    sapling: [34, 49],
    stump: [27, 38],
    tree: [60, 84],
    default: [20, 32]
  };

  const [min, max] = ranges[kind] || ranges.default;
  return min + roll * (max - min);
}

function getSafeProceduralPosition(x, y, sizePercent, channelBase) {
  const padding = 5;
  const min = padding;
  const max = Math.max(min, 100 - sizePercent - padding);
  const span = Math.max(0, max - min);

  return {
    xPercent: min + seededWorldRandom(x, y, channelBase + 1) * span,
    yPercent: min + seededWorldRandom(x, y, channelBase + 2) * span
  };
}

function getTransitionBiomeKey(x, y, biomeKey, tileMap) {
  if (!tileMap || !biomeKey) return null;

  const counts = new Map();
  const distances = new Map();

  for (let oy = -BIOME_TRANSITION_RADIUS; oy <= BIOME_TRANSITION_RADIUS; oy++) {
    for (let ox = -BIOME_TRANSITION_RADIUS; ox <= BIOME_TRANSITION_RADIUS; ox++) {
      if (ox === 0 && oy === 0) continue;

      const tx = x + ox;
      const ty = y + oy;
      const candidate = tileMap[`${tx},${ty}`];
      const candidateBiome = getProceduralBiomeKey(candidate, tx, ty, tileMap);

      if (!candidateBiome || candidateBiome === biomeKey) continue;

      const distance = Math.hypot(ox, oy);
      counts.set(candidateBiome, (counts.get(candidateBiome) || 0) + 1);

      const currentBest = distances.get(candidateBiome) ?? Infinity;
      if (distance < currentBest) distances.set(candidateBiome, distance);
    }
  }

  if (!counts.size) return null;

  return [...counts.keys()].sort((a, b) => {
    const distanceDelta = (distances.get(a) ?? Infinity) - (distances.get(b) ?? Infinity);
    if (Math.abs(distanceDelta) > 0.001) return distanceDelta;
    return (counts.get(b) || 0) - (counts.get(a) || 0);
  })[0];
}

// Biome boundaries use a continuous world-space noise field. Because the
// sampled coordinates are global rather than tile-local, the mask continues
// cleanly from one tile into the next instead of restarting as a rectangle.
const BIOME_TRANSITION_RADIUS = 3;
const BIOME_TRANSITION_WIDTH = 1.65;
const BIOME_TRANSITION_MAX_MIX = 0.50;
const BIOME_TRANSITION_MASK_SIZE = 24;
const biomeTransitionMaskCache = new Map();

function smoothWorldNoiseStep(t) {
  const v = Math.max(0, Math.min(1, t));
  return v * v * (3 - 2 * v);
}

function lerpWorldNoise(a, b, t) {
  return a + (b - a) * t;
}

function valueWorldNoise2D(x, y, channel = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const sx = smoothWorldNoiseStep(x - x0);
  const sy = smoothWorldNoiseStep(y - y0);

  const n00 = seededWorldRandom(x0, y0, channel);
  const n10 = seededWorldRandom(x1, y0, channel);
  const n01 = seededWorldRandom(x0, y1, channel);
  const n11 = seededWorldRandom(x1, y1, channel);

  const north = lerpWorldNoise(n00, n10, sx);
  const south = lerpWorldNoise(n01, n11, sx);

  return lerpWorldNoise(north, south, sy);
}

function getWorldTransitionNoise(worldX, worldY) {
  const broad = valueWorldNoise2D(
    worldX * 0.72,
    worldY * 0.72,
    9011
  );

  const detail = valueWorldNoise2D(
    worldX * 1.85,
    worldY * 1.85,
    9012
  );

  return broad * 0.68 + detail * 0.32;
}

function getNearbyOppositeBiomeCells(x, y, biomeKey, tileMap, targetBiomeKey = null) {
  const oppositeBiomeKey = targetBiomeKey || getTransitionBiomeKey(x, y, biomeKey, tileMap);
  if (!oppositeBiomeKey || !tileMap) return [];

  const cells = [];

  for (let oy = -BIOME_TRANSITION_RADIUS; oy <= BIOME_TRANSITION_RADIUS; oy++) {
    for (let ox = -BIOME_TRANSITION_RADIUS; ox <= BIOME_TRANSITION_RADIUS; ox++) {
      const tx = x + ox;
      const ty = y + oy;
      const neighbor = tileMap[`${tx},${ty}`];

      if (getProceduralBiomeKey(neighbor) === oppositeBiomeKey) {
        cells.push({ x: tx, y: ty });
      }
    }
  }

  return cells;
}

function distancePointToWorldTile(worldX, worldY, tileX, tileY) {
  const nearestX = Math.max(tileX, Math.min(worldX, tileX + 1));
  const nearestY = Math.max(tileY, Math.min(worldY, tileY + 1));
  const dx = worldX - nearestX;
  const dy = worldY - nearestY;
  return Math.hypot(dx, dy);
}

function getDistanceToOppositeBiome(worldX, worldY, oppositeCells) {
  let best = Infinity;

  for (const cell of oppositeCells) {
    const distance = distancePointToWorldTile(
      worldX,
      worldY,
      cell.x,
      cell.y
    );

    if (distance < best) {
      best = distance;
    }
  }

  return best;
}

function getBiomeTransitionStrength(x, y, biomeKey, tileMap, targetBiomeKey = null) {
  const oppositeCells = getNearbyOppositeBiomeCells(
    x,
    y,
    biomeKey,
    tileMap,
    targetBiomeKey
  );

  if (!oppositeCells.length) return 0;

  const centerX = x + 0.5;
  const centerY = y + 0.5;
  const distance = getDistanceToOppositeBiome(
    centerX,
    centerY,
    oppositeCells
  );

  const normalized = 1 - Math.min(1, distance / BIOME_TRANSITION_WIDTH);
  return smoothWorldNoiseStep(normalized);
}

function createBiomeTransitionMask(x, y, biomeKey, tileMap, targetBiomeKey = null) {
  const oppositeCells = getNearbyOppositeBiomeCells(
    x,
    y,
    biomeKey,
    tileMap,
    targetBiomeKey
  );

  if (!oppositeCells.length) {
    return null;
  }

  // Include the nearby biome layout in the cache key so editing the world map
  // cannot leave a stale transition mask behind during development.
  const signature = oppositeCells
    .map(cell => `${cell.x}:${cell.y}`)
    .sort()
    .join("|");

  const cacheKey = `${x},${y},${biomeKey},${targetBiomeKey || "auto"},${signature}`;
  const cached = biomeTransitionMaskCache.get(cacheKey);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = BIOME_TRANSITION_MASK_SIZE;
  canvas.height = BIOME_TRANSITION_MASK_SIZE;

  const context = canvas.getContext("2d", {
    alpha: true,
    willReadFrequently: false
  });

  if (!context) {
    return null;
  }

  const image = context.createImageData(
    BIOME_TRANSITION_MASK_SIZE,
    BIOME_TRANSITION_MASK_SIZE
  );

  for (let py = 0; py < BIOME_TRANSITION_MASK_SIZE; py++) {
    for (let px = 0; px < BIOME_TRANSITION_MASK_SIZE; px++) {
      const localX = (px + 0.5) / BIOME_TRANSITION_MASK_SIZE;
      const localY = (py + 0.5) / BIOME_TRANSITION_MASK_SIZE;
      const worldX = x + localX;
      const worldY = y + localY;

      const distance = getDistanceToOppositeBiome(
        worldX,
        worldY,
        oppositeCells
      );

      // Push/pull the blend line with continuous noise. This produces marsh
      // fingers, damp pockets, and surviving grass without square gradients.
      const noise = getWorldTransitionNoise(worldX, worldY);
      const noiseOffset = (noise - 0.5) * 0.72;
      const effectiveDistance = Math.max(0, distance + noiseOffset);

      const normalized = 1 - Math.min(
        1,
        effectiveDistance / BIOME_TRANSITION_WIDTH
      );

      const blend =
        smoothWorldNoiseStep(normalized) *
        BIOME_TRANSITION_MAX_MIX;

      const alpha = Math.round(blend * 255);
      const index = (py * BIOME_TRANSITION_MASK_SIZE + px) * 4;

      image.data[index] = 0;
      image.data[index + 1] = 0;
      image.data[index + 2] = 0;
      image.data[index + 3] = alpha;
    }
  }

  context.putImageData(image, 0, 0);
  const dataUrl = canvas.toDataURL("image/png");
  biomeTransitionMaskCache.set(cacheKey, dataUrl);

  return dataUrl;
}

function getGreenreachDensity(x, y) {
  const broad = valueWorldNoise2D(
    x * 0.22,
    y * 0.22,
    7341
  );

  const detail = valueWorldNoise2D(
    x * 0.58,
    y * 0.58,
    7342
  );

  return Math.max(
    0,
    Math.min(1, broad * 0.78 + detail * 0.22)
  );
}

function chooseGreenreachDecorationAsset(x, y, channelBase, density) {
  const base = "/images/world/procedural/greenreach-wilds/";
  const roll = seededWorldRandom(x, y, channelBase);

  // Clearings favor low forest-floor detail. Dense cells increasingly favor
  // bushes, saplings and full tree canopies.
  let weighted;

  if (density < 0.28) {
    weighted = [
      ["fern-01.webp", 10],
      ["fern-02.webp", 9],
      ["mushrooms-01.webp", 16],
      ["leafpile-01.webp", 20],
      ["stump-01.webp", 12],
      ["sapling-01.webp", 16],
      ["bush-01.webp", 10],
      ["tree-01.webp", 7]
    ];
  } else if (density < 0.58) {
    weighted = [
      ["fern-01.webp", 9],
      ["fern-02.webp", 9],
      ["mushrooms-01.webp", 9],
      ["leafpile-01.webp", 10],
      ["bush-01.webp", 16],
      ["sapling-01.webp", 15],
      ["stump-01.webp", 6],
      ["tree-01.webp", 26]
    ];
  } else {
    weighted = [
      ["fern-01.webp", 6],
      ["fern-02.webp", 6],
      ["mushrooms-01.webp", 5],
      ["leafpile-01.webp", 6],
      ["bush-01.webp", 18],
      ["sapling-01.webp", 16],
      ["stump-01.webp", 4],
      ["tree-01.webp", 39]
    ];
  }

  const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = roll * total;

  for (const [file, weight] of weighted) {
    cursor -= weight;
    if (cursor <= 0) return base + file;
  }

  return base + weighted[weighted.length - 1][0];
}

function chooseProceduralDecorationAsset(
  x,
  y,
  biomeKey,
  transitionStrength,
  channelBase,
  transitionBiomeKey = null,
  forestDensity = null
) {
  const primary = PROCEDURAL_BIOMES[biomeKey];
  const oppositeKey = transitionBiomeKey;
  const opposite = oppositeKey ? PROCEDURAL_BIOMES[oppositeKey] : null;

  // Opposite-biome props gradually appear throughout the same transition band
  // used by the ground mask instead of only on the single touching edge tile.
  const blendChance = opposite
    ? Math.min(0.46, transitionStrength * 0.46)
    : 0;

  const useOpposite =
    opposite &&
    transitionStrength > 0 &&
    seededWorldRandom(x, y, channelBase + 7) < blendChance;

  const selectedBiomeKey = useOpposite ? oppositeKey : biomeKey;
  const pool = useOpposite ? opposite.decorations : primary.decorations;

  if (selectedBiomeKey === "greenreach") {
    return chooseGreenreachDecorationAsset(
      x,
      y,
      channelBase,
      forestDensity ?? getGreenreachDensity(x, y)
    );
  }

  const assetRoll = seededWorldRandom(x, y, channelBase);
  const assetIndex = Math.min(
    pool.length - 1,
    Math.floor(assetRoll * pool.length)
  );

  return pool[assetIndex];
}

function generateProceduralTileVisuals(x, y, tile, replaceSprite, tileMap) {
  if (!shouldUseProceduralTile(tile, replaceSprite, x, y, tileMap)) {
    return null;
  }

  const biomeKey = getProceduralBiomeKey(tile, x, y, tileMap);
  const biome = PROCEDURAL_BIOMES[biomeKey];

  // Procedural /world?procedural=1 should use the same water artwork for
  // void tiles as the regular world renderer, but without generating any
  // land-style decorations, biome transitions, or road overlays.
  if (biomeKey === "water") {
    return {
      biomeKey,
      ground: biome.ground,
      transitionGround: null,
      transitionMask: null,
      transitionStrength: 0,
      decorations: [],
      road: false,
      roadConnections: null
    };
  }

  const isRoad = isProceduralRoadTile(tile);
  const roadConnections = isRoad
    ? getRoadConnections(x, y, tileMap)
    : null;

  const transitionBiomeKey = getTransitionBiomeKey(
    x,
    y,
    biomeKey,
    tileMap
  );

  const transitionStrength = getBiomeTransitionStrength(
    x,
    y,
    biomeKey,
    tileMap,
    transitionBiomeKey
  );

  const decorations = [];
  const forestDensity = biomeKey === "greenreach"
    ? getGreenreachDensity(x, y)
    : null;

  const decorationCountRoll = seededWorldRandom(x, y, 10);
  let decorationCount = 0;

  if (!isRoad) {
    if (biomeKey === "blackfen") {
      decorationCount = decorationCountRoll < 0.20
        ? 0
        : decorationCountRoll < 0.67
          ? 1
          : 2;
    } else if (biomeKey === "greenreach") {
      if (forestDensity < 0.24) {
        decorationCount = decorationCountRoll < 0.58 ? 0 : 1;
      } else if (forestDensity < 0.48) {
        decorationCount = decorationCountRoll < 0.12 ? 0 : decorationCountRoll < 0.70 ? 1 : 2;
      } else if (forestDensity < 0.72) {
        decorationCount = decorationCountRoll < 0.10
          ? 1
          : decorationCountRoll < 0.60
            ? 2
            : 3;
      } else {
        decorationCount = decorationCountRoll < 0.10 ? 2 : 3;
      }
    } else {
      decorationCount = decorationCountRoll < 0.30
        ? 0
        : decorationCountRoll < 0.78
          ? 1
          : 2;
    }
  }

  for (let i = 0; i < decorationCount; i++) {
    const channelBase = 100 + i * 20;
    const src = chooseProceduralDecorationAsset(
      x,
      y,
      biomeKey,
      transitionStrength,
      channelBase,
      transitionBiomeKey,
      forestDensity
    );

    const sizePercent = getProceduralPropSize(
      x,
      y,
      src,
      channelBase + 3
    );

    const { xPercent, yPercent } = getSafeProceduralPosition(
      x,
      y,
      sizePercent,
      channelBase
    );

    const rotation = -6 + seededWorldRandom(x, y, channelBase + 4) * 12;
    const flipX = seededWorldRandom(x, y, channelBase + 5) >= 0.5;

    decorations.push({
      src,
      xPercent,
      yPercent,
      sizePercent,
      rotation,
      flipX
    });
  }

  const oppositeBiomeKey = transitionBiomeKey;
  const transitionMask = transitionStrength > 0 && oppositeBiomeKey
    ? createBiomeTransitionMask(
        x,
        y,
        biomeKey,
        tileMap,
        oppositeBiomeKey
      )
    : null;

  return {
    biomeKey,
    ground: biome.ground,
    transitionGround:
      transitionMask && oppositeBiomeKey
        ? PROCEDURAL_BIOMES[oppositeBiomeKey].ground
        : null,
    transitionMask,
    transitionStrength,
    decorations,
    road: isRoad
      ? {
          asset: PROCEDURAL_ROAD_ASSET,
          connections: roadConnections
        }
      : null
  };
}

let proceduralRoadImage = null;
let proceduralRoadImageReady = false;
let pendingRoadCanvasState = null;

function getProceduralRoadImage() {
  if (proceduralRoadImage) {
    return proceduralRoadImage;
  }

  proceduralRoadImage = new Image();
  proceduralRoadImage.decoding = "async";

  proceduralRoadImage.onload = () => {
    proceduralRoadImageReady = true;

    if (pendingRoadCanvasState) {
      drawProceduralRoadCanvas(
        pendingRoadCanvasState.grid,
        pendingRoadCanvasState.tileMap,
        pendingRoadCanvasState.minX,
        pendingRoadCanvasState.minY
      );
    }
  };

  proceduralRoadImage.onerror = () => {
    proceduralRoadImageReady = false;
    console.warn(
      "Guildforge procedural road texture failed to load:",
      PROCEDURAL_ROAD_ASSET
    );
  };

  proceduralRoadImage.src = PROCEDURAL_ROAD_ASSET;
  return proceduralRoadImage;
}

function ensureProceduralRoadCanvas(grid) {
  if (!grid) return null;

  let canvas = grid.querySelector(':scope > .procedural-road-canvas');

  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'procedural-road-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    grid.prepend(canvas);
  }

  return canvas;
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(
    0,
    Math.min(radius, width / 2, height / 2)
  );

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(
    x + width,
    y + height,
    x + width - r,
    y + height
  );
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawRoadMaskGeometry(ctx, tileMap, minX, minY, tileSize) {
  const roads = [];
  const roadSet = new Set();

  for (let r = 0; r < WORLD_BUFFER_SIZE; r++) {
    for (let c = 0; c < WORLD_BUFFER_SIZE; c++) {
      const x = minX + c;
      const y = minY + r;
      const tile = tileMap[`${x},${y}`];

      if (!tile || String(tile.terrain || '').toLowerCase() !== 'road') {
        continue;
      }

      roads.push({ x, y, c, r });
      roadSet.add(`${x},${y}`);
    }
  }

  if (!roads.length) {
    return false;
  }

  // The road texture no longer has a built-in black border, so the mask no
  // longer needs artificial overlap between neighboring cells. Each logical
  // road coordinate occupies its exact tile footprint.
  const inset = 0;
  const radius = tileSize * 0.14;

  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const road of roads) {
    const px = road.c * tileSize + inset;
    const py = road.r * tileSize + inset;
    const size = tileSize - inset * 2;

    roundedRectPath(ctx, px, py, size, size, radius);
    ctx.fill();
  }

  const hasRoadAt = (x, y) =>
    roadSet.has(`${x},${y}`);

  /*
   * Connect CARDINAL neighbors at exactly one tile of width.
   *
   * Diagonal bridges are deliberately much stricter than before. Previously
   * every diagonal road neighbor received a bridge, which produced little
   * triangular/spine-shaped protrusions around wide roads and junctions.
   *
   * A diagonal bridge is now created only when the pair is a genuine
   * stair-step connection: neither of the two orthogonal cells between them
   * is road. If east/south (or the equivalent pair) already contains road,
   * the normal filled cells/cardinal joins define the shape and no diagonal
   * connector is added.
   */
  for (const road of roads) {
    const cx = road.c * tileSize + tileSize / 2;
    const cy = road.r * tileSize + tileSize / 2;

    const cardinalNeighbors = [
      [1, 0],
      [0, 1]
    ];

    for (const [dx, dy] of cardinalNeighbors) {
      if (!hasRoadAt(road.x + dx, road.y + dy)) {
        continue;
      }

      ctx.lineWidth = tileSize;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(
        cx + dx * tileSize,
        cy + dy * tileSize
      );
      ctx.stroke();
    }

    const diagonalNeighbors = [
      [1, 1],
      [-1, 1]
    ];

    for (const [dx, dy] of diagonalNeighbors) {
      const diagonalX = road.x + dx;
      const diagonalY = road.y + dy;

      if (!hasRoadAt(diagonalX, diagonalY)) {
        continue;
      }

      // The two cardinal cells that could already bridge this diagonal pair.
      const horizontalExists =
        hasRoadAt(road.x + dx, road.y);

      const verticalExists =
        hasRoadAt(road.x, road.y + dy);

      // If either orthogonal route already exists, this is part of a broad
      // corner/junction rather than a true diagonal-only stair step.
      if (horizontalExists || verticalExists) {
        continue;
      }

      ctx.lineWidth = tileSize * 0.72;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(
        cx + dx * tileSize,
        cy + dy * tileSize
      );
      ctx.stroke();
    }
  }

  return true;
}

function drawProceduralRoadCanvas(grid, tileMap, minX, minY) {
  if (!grid || !PROCEDURAL_WORLD_TEST) {
    return;
  }

  pendingRoadCanvasState = {
    grid,
    tileMap,
    minX,
    minY
  };

  const canvas = ensureProceduralRoadCanvas(grid);
  if (!canvas) return;

  const tileSize = getWorldTileSize();
  const width = Math.round(tileSize * WORLD_BUFFER_SIZE);
  const height = Math.round(tileSize * WORLD_BUFFER_SIZE);
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const mask = document.createElement('canvas');
  mask.width = width;
  mask.height = height;

  const maskCtx = mask.getContext('2d');
  if (!maskCtx) return;

  const hasRoad = drawRoadMaskGeometry(
    maskCtx,
    tileMap,
    minX,
    minY,
    tileSize
  );

  if (!hasRoad) {
    canvas.hidden = true;
    return;
  }

  canvas.hidden = false;

  /*
   * Smooth the COMBINED road silhouette after all road cells and connectors
   * have been drawn.
   *
   * This is intentionally a world-shape operation rather than another
   * per-cell corner rule. The raw mask is blurred enough to soften stair-step
   * geometry, then thresholded back to an opaque binary mask so the road body
   * remains crisp. The later alpha-mask pass adds only a tiny edge feather.
   */
  const smoothedMask = document.createElement('canvas');
  smoothedMask.width = width;
  smoothedMask.height = height;

  const smoothedCtx = smoothedMask.getContext('2d');
  if (!smoothedCtx) return;

  const smoothingSource = document.createElement('canvas');
  smoothingSource.width = width;
  smoothingSource.height = height;

  const smoothingCtx = smoothingSource.getContext('2d');
  if (!smoothingCtx) return;

  smoothingCtx.save();
  smoothingCtx.filter =
    `blur(${Math.max(4, tileSize * 0.115)}px)`;
  smoothingCtx.drawImage(mask, 0, 0);
  smoothingCtx.restore();

  const smoothedPixels =
    smoothingCtx.getImageData(
      0,
      0,
      width,
      height
    );

  const pixelData =
    smoothedPixels.data;

  // Lower threshold slightly expands the blended silhouette and helps turn
  // stair-step diagonals into one continuous sloped ribbon without creating
  // the thin spines that the old diagonal-connector system produced.
  const silhouetteThreshold = 102;

  for (
    let i = 3;
    i < pixelData.length;
    i += 4
  ) {
    pixelData[i] =
      pixelData[i] >= silhouetteThreshold
        ? 255
        : 0;
  }

  smoothedCtx.putImageData(
    smoothedPixels,
    0,
    0
  );

  const roadImage = getProceduralRoadImage();
  if (!proceduralRoadImageReady || !roadImage.complete) {
    return;
  }

  // Build one continuous feathered alpha mask around the COMBINED road shape.
  // We deliberately avoid re-applying the hard mask afterward; the broad road
  // interior remains effectively opaque while the outer shoulder gets a much
  // softer transition into the biome beneath it.
  const alphaMask = document.createElement('canvas');
  alphaMask.width = width;
  alphaMask.height = height;

  const alphaCtx = alphaMask.getContext('2d');
  if (!alphaCtx) return;

  alphaCtx.save();

  /*
   * Give the road a controlled terrain-blend shoulder.
   *
   * The v22 road shape is already good, so we leave its geometry untouched.
   * This wider alpha feather only affects the OUTER perimeter of the combined
   * road silhouette. Because the road canvas sits over the procedural biome
   * ground, partially-transparent edge pixels naturally mix dirt with the
   * grass/swamp texture underneath instead of ending at a hard boundary.
   */
  alphaCtx.filter =
    `blur(${Math.max(2.4, tileSize * 0.055)}px)`;

  alphaCtx.globalAlpha = 1;
  alphaCtx.drawImage(
    smoothedMask,
    0,
    0
  );

  alphaCtx.restore();

  /*
   * Paint road.webp as a WORLD-ANCHORED mirrored texture.
   *
   * The earlier canvas versions anchored the texture to the current 11x11
   * buffer. Every time the server recenters that buffer after a logical step,
   * the road geometry stayed in the correct world location but the texture
   * phase restarted at canvas (0,0). That made the dirt appear to slide
   * underneath the player while walking.
   *
   * Here the texture phase is derived from absolute map coordinates
   * (minX/minY), so the same world coordinate always receives the same part
   * of road.webp. Adjacent large texture blocks are mirrored, which removes
   * hard repeat seams even when road.webp itself is not perfectly tileable.
   */
  ctx.save();
  ctx.globalAlpha = 0.97;

  const textureSize =
    Math.max(
      tileSize * 4,
      1
    );

  const worldPixelX =
    minX * tileSize;

  const worldPixelY =
    minY * tileSize;

  const firstPatternX =
    Math.floor(
      worldPixelX /
      textureSize
    ) - 1;

  const firstPatternY =
    Math.floor(
      worldPixelY /
      textureSize
    ) - 1;

  const lastPatternX =
    Math.ceil(
      (worldPixelX + width) /
      textureSize
    ) + 1;

  const lastPatternY =
    Math.ceil(
      (worldPixelY + height) /
      textureSize
    ) + 1;

  for (
    let patternY = firstPatternY;
    patternY <= lastPatternY;
    patternY++
  ) {
    for (
      let patternX = firstPatternX;
      patternX <= lastPatternX;
      patternX++
    ) {
      const localX =
        patternX * textureSize -
        worldPixelX;

      const localY =
        patternY * textureSize -
        worldPixelY;

      const flipX =
        Math.abs(patternX) % 2 === 1;

      const flipY =
        Math.abs(patternY) % 2 === 1;

      ctx.save();

      ctx.translate(
        localX + (flipX ? textureSize : 0),
        localY + (flipY ? textureSize : 0)
      );

      ctx.scale(
        flipX ? -1 : 1,
        flipY ? -1 : 1
      );

      ctx.drawImage(
        roadImage,
        0,
        0,
        textureSize,
        textureSize
      );

      ctx.restore();
    }
  }

  ctx.globalCompositeOperation =
    'destination-in';

  ctx.globalAlpha = 1;
  ctx.drawImage(alphaMask, 0, 0);

  ctx.restore();
}

// Roads are no longer rendered inside individual tile DOM nodes. They are
// painted once across the full 11x11 moving world buffer by the canvas above.
function renderProceduralRoad() {
  return "";
}

function renderProceduralTransitions(visuals) {
  if (
    !visuals?.transitionGround ||
    !visuals?.transitionMask
  ) {
    return "";
  }

  const mask = escapeHtml(visuals.transitionMask);

  return `
    <div
      class="procedural-biome-transition"
      aria-hidden="true"
      style="
        background-image:url('${escapeHtml(visuals.transitionGround)}');
        -webkit-mask-image:url('${mask}');
        mask-image:url('${mask}');
      "
    ></div>
  `;
}

function renderProceduralDecorations(visuals) {
  if (!visuals?.decorations?.length) {
    return "";
  }

  return visuals.decorations.map(decoration => {
    const scaleX = decoration.flipX ? -1 : 1;

    return `
      <img
        class="procedural-decoration"
        src="${escapeHtml(decoration.src)}"
        alt=""
        aria-hidden="true"
        style="
          left:${decoration.xPercent.toFixed(2)}%;
          top:${decoration.yPercent.toFixed(2)}%;
          width:${decoration.sizePercent.toFixed(2)}%;
          transform:rotate(${decoration.rotation.toFixed(2)}deg) scaleX(${scaleX});
        "
        onerror="this.style.display='none';"
      >
    `;
  }).join("");
}

// =======================
// INIT
// =======================
document.addEventListener("DOMContentLoaded", initWorldPage);

async function initWorldPage() {
  bindLoreModal();

  /*
   * Bind Dungeon websocket before checking REST state so incoming
   * party ready checks can appear as soon as possible.
   */
  void connectDungeonSocket();

  try {
    const res = await fetch("/combat/state", {
      credentials: "include"
    });
    const data = await res.json();

    if (data?.inCombat && data?.enemy) {
      openCombatModal(data.enemy);
      return;
    }

    const restoredDungeonReady =
      await fetchDungeonReadyCheck();

    if (
      restoredDungeonReady?.status ===
      "pending"
    ) {
      startDungeonReadyPolling();
    }

    const dungeonResponse =
      await fetch(
        "/api/dungeons/active",
        {
          credentials:
            "include",
          cache:
            "no-store"
        }
      );

    const dungeonData =
      await dungeonResponse.json();

    await refreshWorld();

    if (
      dungeonResponse.ok &&
      dungeonData?.dungeon &&
      typeof openDungeonModal ===
        "function"
    ) {
      await openDungeonModal();
      return;
    }
  } catch (err) {
    console.error("World init failed", err);
  }
}

function bindLoreModal() {
  const loreCloseBtn = document.getElementById("loreCloseBtn");
  const loreOkBtn = document.getElementById("loreOkBtn");
  const loreBackdrop = document.querySelector("#loreModal .lore-backdrop");

  loreCloseBtn?.addEventListener("click", closeLoreModal);
  loreOkBtn?.addEventListener("click", closeLoreModal);
  loreBackdrop?.addEventListener("click", closeLoreModal);
}

// =======================
// HUD / NAV
// =======================
function updateNavHUD(data) {
  const haven = data?.poi?.haven;
  const dungeon = data?.poi?.dungeon;

  // Haven
  const havenName = document.getElementById("nav-haven-name");
  const havenDist = document.getElementById("nav-haven-dist");
  const havenArrow = document.getElementById("nav-haven-arrow");

  if (havenName) havenName.textContent = haven?.name ?? "—";
  if (havenDist) havenDist.textContent = haven ? `${haven.distance} tiles` : "— tiles";
  if (havenArrow) havenArrow.textContent = haven?.arrow ?? "•";

  // Dungeon
  const dunName = document.getElementById("nav-dungeon-name");
  const dunDist = document.getElementById("nav-dungeon-dist");
  const dunArrow = document.getElementById("nav-dungeon-arrow");

  if (dungeon) {
    if (dunName) dunName.textContent = dungeon.name ?? "Unknown";
    if (dunDist) dunDist.textContent = `${dungeon.distance} tiles`;
    if (dunArrow) dunArrow.textContent = dungeon.arrow ?? "•";
  } else {
    if (dunName) dunName.textContent = "Coming Soon";
    if (dunDist) dunDist.textContent = "—";
    if (dunArrow) dunArrow.textContent = "•";
  }

  // Travel flavor
  const flavor = document.getElementById("movement-flavor");
  if (flavor) flavor.textContent = data?.flavor ?? "You press onward.";
}

function getWorldTileSize() {
  /*
   * Read the ACTUAL rendered tile width rather than the old root-level
   * --tile value. The redesigned map sizes --tile locally on .grid-viewport
   * so it can fill the center panel while still showing exactly 9 full cells.
   */
  const tile =
    document.querySelector(
      "#Grid .tile"
    );

  if (tile) {
    const width =
      tile.getBoundingClientRect()
        .width;

    if (
      Number.isFinite(width) &&
      width > 0
    ) {
      return width;
    }
  }

  const viewport =
    document.querySelector(
      ".grid-viewport"
    );

  if (viewport) {
    const width =
      viewport.clientWidth /
      WORLD_VIEW_SIZE;

    if (
      Number.isFinite(width) &&
      width > 0
    ) {
      return width;
    }
  }

  return (
    parseFloat(
      getComputedStyle(
        document.documentElement
      ).getPropertyValue(
        "--tile"
      )
    ) || 58
  );
}

function getWorldGridBaseTransform() {
  const tileSize = getWorldTileSize();
  return {
    tileSize,
    x: -tileSize,
    y: -tileSize
  };
}

function getWorldStepTarget(dir) {
  const base = getWorldGridBaseTransform();

  // Camera-follow movement: the player remains centered while the terrain
  // travels continuously beneath them one complete logical tile at a time.
  const offsets = {
    north: [0, base.tileSize],
    south: [0, -base.tileSize],
    west: [base.tileSize, 0],
    east: [-base.tileSize, 0]
  };

  const [dx, dy] = offsets[dir] || [0, 0];

  return {
    ...base,
    targetX: base.x + dx,
    targetY: base.y + dy
  };
}

function setWorldPlayerMotion(dir, moving) {
  const sprite = document.getElementById("worldPlayerSprite");
  if (!sprite) return;

  sprite.dataset.direction = dir || "south";
  sprite.classList.toggle("is-moving", Boolean(moving));
}

function positionWorldPlayerSprite() {
  const viewport =
    document.querySelector(
      ".grid-viewport"
    );

  const sprite =
    document.getElementById(
      "worldPlayerSprite"
    );

  const playerTile =
    document.querySelector(
      "#Grid .tile.player"
    );

  if (
    !viewport ||
    !sprite ||
    !playerTile
  ) {
    return;
  }

  /*
   * Anchor the visible player marker to the ACTUAL logical player tile,
   * not to an assumed percentage of the viewport.
   *
   * This remains correct even when responsive/container-query sizing,
   * browser zoom, borders, or fractional tile widths change the exact
   * geometry of the 9x9 camera.
   */
  const viewportRect =
    viewport.getBoundingClientRect();

  const tileRect =
    playerTile.getBoundingClientRect();

  const centerX =
    tileRect.left -
    viewportRect.left +
    tileRect.width / 2;

  const centerY =
    tileRect.top -
    viewportRect.top +
    tileRect.height / 2;

  sprite.style.position =
    "absolute";

  sprite.style.left =
    `${centerX}px`;

  sprite.style.top =
    `${centerY}px`;

  sprite.style.margin =
    "0";
}

function ensureWorldPlayerSprite() {
  const viewport = document.querySelector(".grid-viewport");
  if (!viewport) return null;

  let sprite = document.getElementById("worldPlayerSprite");

  if (!sprite) {
    sprite = document.createElement("div");
    sprite.id = "worldPlayerSprite";
    sprite.className = "world-player-sprite";
    sprite.dataset.direction = "south";
    sprite.setAttribute("aria-hidden", "true");
    sprite.innerHTML = `
      <span class="world-player-sprite__shadow"></span>
      <span class="world-player-sprite__body">◆</span>
    `;

    viewport.appendChild(sprite);
  } else if (sprite.parentElement !== viewport) {
    viewport.appendChild(sprite);
  }

  positionWorldPlayerSprite();
  ensureWorldPlayerResizeObserver();

  return sprite;
}

let worldPlayerResizeObserver = null;

function ensureWorldPlayerResizeObserver() {
  const viewport =
    document.querySelector(
      ".grid-viewport"
    );

  if (
    !viewport ||
    typeof ResizeObserver ===
      "undefined"
  ) {
    return;
  }

  if (worldPlayerResizeObserver) {
    worldPlayerResizeObserver.disconnect();
  }

  worldPlayerResizeObserver =
    new ResizeObserver(() => {
      /*
       * Container-query sizing can settle one paint after the browser
       * window changes. Re-center after layout has actually updated.
       */
      requestAnimationFrame(() => {
        positionWorldPlayerSprite();
      });
    });

  worldPlayerResizeObserver.observe(
    viewport
  );
}

window.addEventListener(
  "resize",
  () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        positionWorldPlayerSprite();
      });
    });
  }
);

function resetWorldGridToBase() {
  const grid = document.getElementById("Grid");
  if (!grid) return;

  grid.getAnimations?.().forEach(animation => animation.cancel());

  const base = getWorldGridBaseTransform();
  grid.style.transform = `translate3d(${base.x}px, ${base.y}px, 0)`;
}

function animateWorldTravelStep(dir) {
  const grid = document.getElementById("Grid");
  if (!grid || !dir) return Promise.resolve();

  ensureWorldPlayerSprite();
  setWorldPlayerMotion(dir, true);

  const step = getWorldStepTarget(dir);

  grid.getAnimations?.().forEach(animation => animation.cancel());
  grid.style.transform = `translate3d(${step.x}px, ${step.y}px, 0)`;

  const animation = grid.animate(
    [
      {
        transform: `translate3d(${step.x}px, ${step.y}px, 0)`
      },
      {
        transform: `translate3d(${step.targetX}px, ${step.targetY}px, 0)`
      }
    ],
    {
      duration: WORLD_SCROLL_MS,
      easing: "linear",
      fill: "forwards"
    }
  );

  return animation.finished
    .then(() => {
      grid.style.transform =
        `translate3d(${step.targetX}px, ${step.targetY}px, 0)`;
      animation.cancel();
    })
    .catch(() => {});
}

function animateWorldRollback(dir) {
  const grid = document.getElementById("Grid");
  if (!grid || !dir) return Promise.resolve();

  const step = getWorldStepTarget(dir);

  grid.getAnimations?.().forEach(animation => animation.cancel());

  const animation = grid.animate(
    [
      {
        transform: `translate3d(${step.targetX}px, ${step.targetY}px, 0)`
      },
      {
        transform: `translate3d(${step.x}px, ${step.y}px, 0)`
      }
    ],
    {
      duration: 110,
      easing: "ease-out",
      fill: "forwards"
    }
  );

  return animation.finished
    .then(() => {
      resetWorldGridToBase();
    })
    .catch(() => {
      resetWorldGridToBase();
    });
}

function normalizeMoveDir(dir) {
  return dir === "north" || dir === "south" || dir === "west" || dir === "east"
    ? dir
    : "";
}
function showHuntProgress(progress) {
  if (
    !progress ||
    !progress.advanced
  ) {
    return;
  }

  if (!window.GFToast?.show) {
    return;
  }

  const trackingText =
    `${progress.trackingProgress}/${progress.trackingRequired} Tracking`;

  if (progress.objectiveComplete) {
    GFToast.show(
      "Hunt Objective Complete",
      `+${progress.trackingGain} Tracking • ${trackingText}`,
      {
        type: "success",
        durationMs: 3000
      }
    );
  } else {
    GFToast.show(
      "Hunt Progress",
      `+${progress.trackingGain} Tracking • ${trackingText}`,
      {
        type: "success",
        durationMs: 2400
      }
    );
  }

  if (progress.targetRevealed) {
    setTimeout(() => {
      GFToast.show(
        "Quarry Located",
        "The trail is complete. Your party has discovered its target.",
        {
          type: "success",
          durationMs: 4500
        }
      );
    }, 650);
  }
}

window.showHuntProgress =
  showHuntProgress;
// =======================
// COMBAT HELPERS
// =======================
function isInCombat() {
  const combatModal =
    document.getElementById(
      "combatModal"
    );

  const huntCombatModal =
    document.getElementById(
      "huntCombatModal"
    );

  const normalCombatActive =
    Boolean(
      combatModal &&
      !combatModal.classList.contains(
        "hidden"
      )
    );

  const huntCombatActive =
    Boolean(
      huntCombatModal &&
      !huntCombatModal.classList.contains(
        "hidden"
      )
    );

  const dungeonModal =
    document.getElementById(
      "dungeonModal"
    );

  const dungeonActive =
    Boolean(
      dungeonModal &&
      !dungeonModal.classList.contains(
        "hidden"
      )
    );

  const dungeonReadyModal =
    document.getElementById(
      "dungeonReadyModal"
    );

  const dungeonReadyActive =
    Boolean(
      dungeonReadyModal &&
      !dungeonReadyModal.classList.contains(
        "hidden"
      )
    );

  return (
    normalCombatActive ||
    huntCombatActive ||
    dungeonActive ||
    dungeonReadyActive
  );
}

function queueCombatOpen() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (pendingCombatEnemy) {
        openCombatModal(pendingCombatEnemy);
        pendingCombatEnemy = null;
      }
    });
  });
}



function professionActionLabel(professionName) {
  switch (String(professionName || "").toLowerCase()) {
    case "mining":
      return "Mining...";
    case "herbalism":
      return "Harvesting...";
    case "woodcutting":
      return "Chopping...";
    default:
      return "Gathering...";
  }
}

function playGatheringSound(professionName) {
  let file;

  switch (String(professionName || "").toLowerCase()) {
    case "mining":
      file = "/sounds/gathering/mining2.ogg";
      break;

    case "herbalism":
      file = "/sounds/gathering/herbalism2.ogg";
      break;

    case "woodcutting":
      file = "/sounds/gathering/woodcutting2.ogg";
      break;

    default:
      return null;
  }



  const audio = new Audio(file);
  audio.volume = 0.5;
  audio.loop = true;

  audio.play().catch(() => {});

  return audio;
}

function playGatherCompleteSound() {
  const audio = new Audio("/sounds/gathering/collected.ogg");
  audio.volume = 0.6;
  audio.play().catch(() => {});
}

function playProfessionLevelSound() {
  const audio = new Audio("/sounds/profession-level.ogg");
  audio.volume = 0.65;
  audio.play().catch(() => {});
}
function showGatheringModal({ professionName, nodeName, durationMs }) {
  const modal = document.getElementById("gatheringModal");
  const icon = document.getElementById("gatheringModalIcon");
  const title = document.getElementById("gatheringModalTitle");
  const sub = document.getElementById("gatheringModalSub");
  const fill = document.getElementById("gatheringProgressFill");

  if (!modal || !icon || !title || !sub || !fill) return;



  icon.textContent = getResourceIcon(professionName);
  title.textContent = professionActionLabel(professionName);
  sub.textContent = nodeName || "Gathering resources";

  fill.style.transition = "none";
  fill.style.width = "0%";

  modal.classList.remove("hidden");

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.style.transition = `width ${durationMs}ms linear`;
      fill.style.width = "100%";
    });
  });
}

function hideGatheringModal() {
  const modal = document.getElementById("gatheringModal");
  if (modal) modal.classList.add("hidden");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}







// =======================
// ENEMY PORTRAIT
// =======================
function applyEnemyPortrait(enemy) {
  const img = document.getElementById("enemyPortrait");
  if (!img) return;

  let src = enemy?.img || "/images/default_creature.png";

  if (src && !src.startsWith("/") && !src.startsWith("http")) {
    src = "/" + src;
  }

  img.src = src;
  img.onerror = () => {
    img.onerror = null;
    img.src = "/images/default_creature.png";
  };
}

// =======================
// WORLD HEADER
// =======================
async function loadRegionName() {
  try {
    const res = await fetch("/world/current-region", {
      credentials: "include"
    });
    const data = await res.json();
    renderRegionHeader(data);
  } catch (err) {
    console.error("Failed to load region name", err);
  }
}

// Accepts either a /world/current-region response or a regionData block from /world/move
function renderRegionHeader(data) {
  const title =
    document.getElementById(
      "world-title"
    );

  if (!title || !data) {
    return;
  }

  /*
   * Normal regions/towns must NEVER retain
   * Dungeon-specific title styling.
   */
  title.classList.remove(
    "world-title--dungeon"
  );

  const min =
    Number(
      data.level_min ?? 1
    );

  const max =
    Number(
      data.level_max ?? min
    );

  const band =
    min === max
      ? `Lv ${min}`
      : `Lv ${min}–${max}`;

  const name =
    data.region_name ??
    "Unknown Region";

  title.textContent =
    `${name} (${band})`;

  title.classList.remove(
    "zone-easy",
    "zone-even",
    "zone-hard"
  );

  const diff =
    String(
      data.difficulty ||
      "even"
    ).toLowerCase();

  title.classList.add(
    diff === "easy"
      ? "zone-easy"
      : diff === "hard"
        ? "zone-hard"
        : "zone-even"
  );
}


async function renderDungeonWorldHeaderIfNeeded(
  terrain
) {
  if (
    String(
      terrain ||
      ""
    ).toLowerCase() !==
    "dungeon"
  ) {
    return false;
  }

  try {
    const response =
      await fetch(
        "/world/current-dungeon",
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
      data.ok === false ||
      !data.dungeon?.name
    ) {
      return false;
    }

    const dungeon =
      data.dungeon;

    const title =
      document.getElementById(
        "world-title"
      );

    if (!title) {
      return true;
    }

    title.classList.add(
  "world-title--dungeon"
);

    const minLevel =
      Math.max(
        1,
        Number(
          dungeon.min_level ??
          1
        ) || 1
      );

    const maxLevel =
      dungeon.max_level ==
        null
        ? null
        : Math.max(
            minLevel,
            Number(
              dungeon.max_level
            ) ||
            minLevel
          );

    const levelBand =
      maxLevel == null
        ? `Lv ${minLevel}+`
        : minLevel ===
          maxLevel
          ? `Lv ${minLevel}`
          : `Lv ${minLevel}–${maxLevel}`;

    title.textContent =
      `${dungeon.name} (${levelBand})`;

    title.classList.remove(
      "zone-easy",
      "zone-even",
      "zone-hard"
    );

    title.classList.add(
      "zone-even"
    );

    return true;
  } catch (error) {
    console.warn(
      "Unable to render Dungeon world header:",
      error
    );

    return false;
  }
}

// =======================
// SPRITE / OBJECT HELPERS
// =======================
function normalizeSpritePath(src) {
  if (!src) return null;
  return src.startsWith("/") ? src : `/${src}`;
}

function buildWorldObjectMap(worldObjects) {
  const map = new Map();

  for (const obj of worldObjects || []) {
    const key = `${Number(obj.x)},${Number(obj.y)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(obj);
  }

  for (const [, list] of map) {
    list.sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0));
  }

  return map;
}

function getTileVisualData(x, y, objectMap) {
  const key = `${x},${y}`;
  const objects = objectMap.get(key) || [];

  let replaceSprite = null;
  const overlays = [];

  for (const obj of objects) {
    const sprite = normalizeSpritePath(obj.tile_sprite);
    const visualType = String(obj.tile_visual_type || "none").toLowerCase();

    if (!sprite || visualType === "none") continue;

    if (visualType === "replace") {
      replaceSprite = sprite;
    } else if (visualType === "overlay") {
      overlays.push(sprite);
    }
  }

  return { replaceSprite, overlays };
}

// =======================
// WORLD RENDER
// =======================
function renderCurrentResourcePanel(player, resourceNodes) {
  const panel = document.getElementById("currentResourcePanel");
  if (!panel) return;

  const node = (resourceNodes || []).find(n =>
    Number(n.map_x) === Number(player.map_x) &&
    Number(n.map_y) === Number(player.map_y)
  );

  if (!node) {
    currentResourceNode = null;
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }

  currentResourceNode = node;
  panel.hidden = false;

  const displayName = node.affixName
    ? `${node.affixName} ${node.nodeName}`
    : node.nodeName;

  panel.innerHTML = `
    <div class="resource-panel__head">
      <div class="resource-panel__icon">${getResourceIcon(node.professionName)}</div>
      <div>
        <div class="resource-panel__name">${escapeHtml(displayName)}</div>
        <div class="resource-panel__sub">
          ${escapeHtml(node.professionName)} • ${escapeHtml(node.rarity || "common")} • Uses: ${Number(node.remaining_uses || 0)}
        </div>
      </div>
    </div>

    <div class="resource-panel__body">
      <div class="resource-panel__desc">
        ${escapeHtml(node.description || "A harvestable resource node.")}
      </div>

      <div class="resource-panel__meta">
        Required Level: ${Number(node.required_level || 1)}
      </div>

      <button class="resource-panel__btn" onclick="gatherResourceNode(${Number(node.spawnedNodeId)})">
        Gather
      </button>
    </div>
  `;
}


// Shared render logic — used by both refreshWorld() and moveWorld()
function renderWorldFromData({
  player,
  tiles,
  guildMap,
  worldObjects,
  resourceNodes,
  huntClues = [],
  huntTargets = [],
  worldEventMapSpawns = []
}) {
  const tileMap = {};

  for (const t of tiles || []) {
    tileMap[
      `${t.x},${t.y}`
    ] = t;
  }


  const objectMap =
    buildWorldObjectMap(
      worldObjects || []
    );


  const resourceMap =
    new Map();

  for (
    const node of
    resourceNodes || []
  ) {
    const key =
      `${Number(node.map_x)},${Number(node.map_y)}`;

    resourceMap.set(
      key,
      node
    );
  }


  const huntClueMap =
    new Map();

  for (
    const clue of
    huntClues || []
  ) {
    const key =
      `${Number(clue.x)},${Number(clue.y)}`;

    huntClueMap.set(
      key,
      clue
    );
  }


  const huntTargetMap =
    new Map();

  for (
    const target of
    huntTargets || []
  ) {
    const key =
      `${Number(target.x)},${Number(target.y)}`;

    huntTargetMap.set(
      key,
      target
    );
  }


  const worldEventMap =
    new Map();

  for (
    const spawn of
    worldEventMapSpawns || []
  ) {
    const key =
      `${Number(spawn.x)},${Number(spawn.y)}`;

    /*
     * Keep an array because multiple event objects are allowed to share a
     * world tile. It is uncommon, but the renderer should not silently drop
     * one if event seeding ever creates that situation.
     */
    if (!worldEventMap.has(key)) {
      worldEventMap.set(
        key,
        []
      );
    }

    worldEventMap
      .get(key)
      .push(spawn);
  }


  const grid =
    document.getElementById(
      "Grid"
    );

  if (!grid) return;

  const html = [];

  const minX =
    Number(player.map_x) - WORLD_BUFFER_RADIUS;

  const minY =
    Number(player.map_y) - WORLD_BUFFER_RADIUS;

  for (let r = 0; r < WORLD_BUFFER_SIZE; r++) {
    for (let c = 0; c < WORLD_BUFFER_SIZE; c++) {
      const x = minX + c;
      const y = minY + r;
      const t = tileMap[`${x},${y}`];

      if (!t) {
        html.push(`<div class="tile void" data-x="${x}" data-y="${y}"></div>`);
        continue;
      }

      const isPlayer = x === Number(player.map_x) && y === Number(player.map_y);
      const resourceNode =
        resourceMap.get(
          `${x},${y}`
        );

      const huntClue =
        huntClueMap.get(
          `${x},${y}`
        );

      const huntTarget =
        huntTargetMap.get(
          `${x},${y}`
        );

      const worldEventSpawns =
        worldEventMap.get(
          `${x},${y}`
        ) || [];

      const {
        replaceSprite,
        overlays
      } =
        getTileVisualData(
          x,
          y,
          objectMap
        );

      const proceduralVisuals =
        generateProceduralTileVisuals(
          x,
          y,
          t,
          replaceSprite,
          tileMap
        );

      const terrainClass =
        replaceSprite || proceduralVisuals
          ? ""
          : t.terrain;

      const baseStyle = replaceSprite
        ? ` style="background-image: url('${escapeHtml(replaceSprite)}');"`
        : proceduralVisuals
          ? ` style="background-image: url('${escapeHtml(proceduralVisuals.ground)}');"`
          : "";

      const proceduralTransitionHtml =
        renderProceduralTransitions(
          proceduralVisuals
        );

      const proceduralDecorationHtml =
        renderProceduralDecorations(
          proceduralVisuals
        );

      const proceduralRoadHtml =
        renderProceduralRoad(
          proceduralVisuals
        );

      const huntClueHtml =
  huntClue
    ? `
      <div
        class="hunt-clue-marker"
        title="${escapeHtml(huntClue.name)}"
      >
        ${
          huntClue.icon &&
          String(huntClue.icon).startsWith("/")
            ? `
              <img
                src="${escapeHtml(huntClue.icon)}"
                alt=""
              >
            `
            : `
              <span>
                ${escapeHtml(
                  huntClue.icon || "🐾"
                )}
              </span>
            `
        }
      </div>
    `
    : "";

    const huntTargetHtml =
  huntTarget
    ? `
      <div
        class="hunt-target-marker"
        title="${escapeHtml(
          huntTarget.name ||
          "Hunt Target"
        )}"
      >
        ${
          huntTarget.image
            ? `
              <img
                src="${escapeHtml(
                  huntTarget.image
                )}"
                alt=""
                onerror="
                  this.onerror=null;
                  this.src='/images/default_creature.png';
                "
              >
            `
            : `
              <span
                class="hunt-target-marker__symbol"
              >
                ☠
              </span>
            `
        }

        <span
          class="hunt-target-marker__badge"
        >
          HUNT
        </span>
      </div>
    `
    : "";

      const worldEventMapHtml =
        worldEventSpawns.length
          ? `
            <div
              class="world-event-map-markers"
              aria-hidden="true"
            >
              ${worldEventSpawns
                .map(
                  (spawn) => `
                    <span
                      class="world-event-map-marker world-event-map-marker--${escapeHtml(
                        String(
                          spawn.spawnType ||
                          "INTERACT"
                        ).toLowerCase()
                      )}"
                      title="${escapeHtml(
                        spawn.name ||
                        "World Event"
                      )}"
                    >
                      ${escapeHtml(
                        spawn.icon ||
                        "❗"
                      )}
                    </span>
                  `
                )
                .join("")}
            </div>
          `
          : "";

      const overlayHtml = overlays.map(src => `
        <img class="tile-overlay" src="${escapeHtml(src)}" alt="">
      `).join("");

      const resourceHtml = resourceNode ? `
        <div
          class="resource-node-marker"
          title="${escapeHtml(resourceNode.nodeName)}"
        >
          <img
            src="${escapeHtml(resourceNode.image)}"
            class="resource-node-image resource-${escapeHtml((resourceNode.affixName || "common").toLowerCase())}"
            alt="${escapeHtml(resourceNode.nodeName)}"
          >
        </div>
      ` : "";

      /*
       * Dungeon entrances use the terrain artwork itself:
       * /images/map_tiles/dungeon.webp
       */
      const dungeonHtml =
        "";

      html.push(`
        <div
          class="tile ${escapeHtml(terrainClass)} ${isPlayer ? "player" : ""} ${isPlayer && lastMoveDir ? `moving-${lastMoveDir}` : ""}"
          data-x="${x}"
          data-y="${y}"${baseStyle}
        >
          ${proceduralTransitionHtml}
          ${proceduralDecorationHtml}
          ${proceduralRoadHtml}
          ${overlayHtml}
          ${resourceHtml}
          ${dungeonHtml}
          ${huntClueHtml}
          ${huntTargetHtml}
          ${worldEventMapHtml}
        </div>
      `);
    }
  }

  grid.innerHTML = html.join("");

  // Draw every road cell as one continuous world-level layer. Because the
  // canvas lives inside #Grid it moves through the exact same camera transform
  // as the terrain during continuous WASD travel.
  drawProceduralRoadCanvas(
    grid,
    tileMap,
    minX,
    minY
  );

  // Every server-confirmed tile boundary recenters the hidden 11x11 buffer.
  // The visible world does not jump because the old end frame and new base
  // frame show the exact same world coordinates.
  resetWorldGridToBase();
  ensureWorldPlayerSprite();

  const currentTile = tileMap[`${player.map_x},${player.map_y}`];

  const enterTownBtn =
    document.getElementById(
      "enter-town-btn"
    );

  const enterDungeonBtn =
    document.getElementById(
      "enter-dungeon-btn"
    );

  const currentTerrain =
    String(
      currentTile?.terrain ||
      ""
    ).toLowerCase();

  if (enterTownBtn) {
    enterTownBtn.style.display =
      currentTerrain === "town"
        ? "inline-block"
        : "none";
  }

  if (enterDungeonBtn) {
    enterDungeonBtn.style.display =
      currentTerrain === "dungeon"
        ? "inline-block"
        : "none";
  }

  if (
    currentTerrain ===
    "dungeon"
  ) {
    void renderDungeonWorldHeaderIfNeeded(
      currentTerrain
    );
  }

  const coords = document.querySelector(".coords");
  if (coords) {
    coords.textContent = `Position: (${player.map_x}, ${player.map_y})`;
  }

  renderCurrentResourcePanel(player, resourceNodes || []);
}

// Initial page load — still fetches /world/partial directly
async function refreshWorld() {
  const res = await fetch("/world/partial", {
    credentials: "include"
  });

  const data = await res.json();

  renderWorldFromData(data);
  updateNavHUD(data);

  if (window.GFWorldEvents?.syncFromCurrentRegion) {
    await window.GFWorldEvents.syncFromCurrentRegion();
  }

  // NEW
  await loadNearbyObjects();
}

function enterTown() {
  window.location.href = "/town/enter";
}

let enteringDungeon =
  false;


async function connectDungeonSocket() {
  if (
    dungeonSocketBound &&
    dungeonSocket
  ) {
    return dungeonSocket;
  }

  try {
    let socket =
      window.GFSocket;

    if (
      !socket &&
      window.GFSocketReady
    ) {
      socket =
        await window.GFSocketReady;
    }

    if (
      !socket ||
      typeof socket.on !==
        "function"
    ) {
      console.warn(
        "Dungeon websocket is unavailable."
      );

      return null;
    }

    dungeonSocket =
      socket;

    if (
      !dungeonSocketBound
    ) {
      dungeonSocketBound =
        true;

      /*
       * Every ready-check mutation is pushed here immediately.
       * This is what makes the modal appear for party members
       * without them clicking Enter Dungeon themselves.
       */
      socket.on(
        "dungeon:ready-check",
        async (
          payload
        ) => {
          const check =
            payload?.readyCheck;

          if (
            !check
          ) {
            return;
          }

          const incomingReadyCheckId =
            Number(
              check.id
            );

          if (
            resolvedDungeonReadyCheckIds.has(
              incomingReadyCheckId
            )
          ) {
            return;
          }

          const me =
            (
              check.players ??
              []
            ).find(
              player =>
                Number(
                  player.playerId
                ) ===
                Number(
                  window.__PLAYER_ID__ ??
                  dungeonReadySelfId
                )
            );

          /*
           * Ignore malformed broadcasts not containing this player.
           * The server already targets frozen roster members directly,
           * but this protects us from stale party-room subscriptions.
           */
          const sameVisibleCheck =
            Number(
              dungeonReadyCheck?.id
            ) ===
            Number(
              check.id
            );

          if (
            !me &&
            !sameVisibleCheck
          ) {
            return;
          }

          if (
            me
          ) {
            dungeonReadySelfId =
              Number(
                me.playerId
              );
          }

          /*
           * A completed ready check must NEVER be rendered again.
           * Rendering first would remove .hidden and put the ready
           * modal back over the newly-opened Dungeon modal.
           */
          if (
            check.status ===
            "completed"
          ) {
            const resolvedId =
              Number(
                check.id
              );

            if (
              Number.isInteger(
                resolvedId
              ) &&
              resolvedId > 0
            ) {
              resolvedDungeonReadyCheckIds.add(
                resolvedId
              );
            }

            dungeonReadyFetchGeneration++;

            document
              .getElementById(
                "dungeonReadyModal"
              )
              ?.remove();

            await transitionDungeonReadyCheck(
              check
            );

            return;
          }

          renderDungeonReadyCheck(
            check
          );

          if (
            check.status ===
              "cancelled" ||
            check.status ===
              "expired"
          ) {
            setTimeout(
              closeDungeonReadyModal,
              900
            );
          }
        }
      );

      socket.on(
        "dungeon:ready-check-resolved",
        async (
          payload
        ) => {
          const check =
            payload?.readyCheck;

          if (
            !check
          ) {
            return;
          }

          /*
           * This event is emitted directly to every frozen ready-check
           * participant's private player socket room. Do not gate it on
           * dungeonReadySelfId: a non-initiating player may receive this
           * before their fallback REST poll ever learns their own ID.
           */
          if (
            check.status ===
            "completed"
          ) {
            const resolvedId =
              Number(
                check.id
              );

            if (
              Number.isInteger(
                resolvedId
              ) &&
              resolvedId > 0
            ) {
              resolvedDungeonReadyCheckIds.add(
                resolvedId
              );
            }

            dungeonReadyFetchGeneration++;

            document
              .getElementById(
                "dungeonReadyModal"
              )
              ?.remove();

            await transitionDungeonReadyCheck(
              check
            );

            return;
          }

          if (
            check.status ===
              "cancelled" ||
            check.status ===
              "expired"
          ) {
            renderDungeonReadyCheck(
              check
            );

            setTimeout(
              closeDungeonReadyModal,
              700
            );
          }
        }
      );


      socket.on(
        "dungeon:changed",
        async () => {
          /*
           * Reserved for broader Dungeon lifecycle updates.
           * Refresh active Dungeon state when we begin using this event.
           */
        }
      );

      socket.on(
        "connect",
        () => {
          socket.emit(
            "dungeon:subscribe"
          );
        }
      );
    }

    /*
     * Subscribe immediately if already connected. This joins the
     * current Dungeon party room for future party-wide updates.
     */
    if (
      socket.connected
    ) {
      socket.emit(
        "dungeon:subscribe"
      );
    }

    return socket;
  } catch (
    error
  ) {
    console.error(
      "Dungeon websocket setup failed:",
      error
    );

    return null;
  }
}


function ensureDungeonReadyModal() {
  let modal = document.getElementById("dungeonReadyModal");

  if (modal) return modal;

  document.body.insertAdjacentHTML("beforeend", `
    <div id="dungeonReadyModal" class="dungeon-ready-modal hidden" role="dialog" aria-modal="true">
      <div class="dungeon-ready-backdrop" aria-hidden="true"></div>

      <section class="dungeon-ready-card frame-host">
        <span class="frame-border panel" aria-hidden="true"></span>

        <header class="dungeon-ready-header">
          <div>
            <div class="dungeon-ready-kicker">Dungeon Expedition</div>
            <h2 id="dungeonReadyTitle">Ready Check</h2>
          </div>

          <div id="dungeonReadyCountdown" class="dungeon-ready-countdown">0:30</div>
        </header>

        <div class="dungeon-ready-content">
          <p id="dungeonReadyStatus" class="dungeon-ready-status">
            Waiting for the party...
          </p>

          <div id="dungeonReadyParticipants" class="dungeon-ready-participants"></div>
          <div id="dungeonReadyError" class="dungeon-ready-error" hidden></div>
        </div>

        <footer class="dungeon-ready-footer">
          <button id="dungeonReadyToggleBtn" class="dungeon-btn dungeon-btn--primary" type="button">
            Ready
          </button>

          <button id="dungeonReadyCancelBtn" class="dungeon-btn dungeon-btn--ghost" type="button">
            Cancel
          </button>
        </footer>
      </section>
    </div>
  `);

  modal = document.getElementById("dungeonReadyModal");

  document.getElementById("dungeonReadyToggleBtn")
    ?.addEventListener("click", toggleDungeonReadyState);

  document.getElementById("dungeonReadyCancelBtn")
    ?.addEventListener("click", cancelDungeonReadyCheck);

  return modal;
}

function showDungeonReadyError(message = "") {
  const root = document.getElementById("dungeonReadyError");
  if (!root) return;

  root.hidden = !message;
  root.textContent = message;
}

function stopDungeonReadyTimers() {
  if (dungeonReadyPollTimer) {
    clearInterval(dungeonReadyPollTimer);
    dungeonReadyPollTimer = null;
  }

  if (dungeonReadyCountdownTimer) {
    clearInterval(dungeonReadyCountdownTimer);
    dungeonReadyCountdownTimer = null;
  }
}

function closeDungeonReadyModal() {
  stopDungeonReadyTimers();

  dungeonReadyCheck =
    null;

  dungeonReadyBusy =
    false;

  enteringDungeon =
    false;

  document
    .getElementById(
      "dungeonReadyModal"
    )
    ?.remove();
}

function renderDungeonReadyCountdown() {
  const root = document.getElementById("dungeonReadyCountdown");
  if (!root || !dungeonReadyCheck) return;

  if (dungeonReadyCheck.status !== "pending") {
    root.textContent = "0:00";
    return;
  }

  const remaining = Math.max(
    0,
    new Date(dungeonReadyCheck.expiresAt).getTime() - Date.now()
  );

  const seconds = Math.ceil(remaining / 1000);

  root.textContent = `0:${String(seconds).padStart(2, "0")}`;
}

function renderDungeonReadyCheck(check) {
  if (!check) {
    return;
  }

  const readyCheckId =
    Number(
      check.id
    );

  const dungeonModal =
    document.getElementById(
      "dungeonModal"
    );

  const dungeonAlreadyOpen =
    Boolean(
      dungeonModal &&
      !dungeonModal.classList.contains(
        "hidden"
      )
    );

  /*
   * Never recreate the ready-check modal after this check has
   * completed, and never allow any ready-check UI to sit over
   * an already-open Dungeon session.
   */
  if (
    resolvedDungeonReadyCheckIds.has(
      readyCheckId
    ) ||
    dungeonAlreadyOpen
  ) {
    document
      .getElementById(
        "dungeonReadyModal"
      )
      ?.remove();

    return;
  }

  dungeonReadyCheck = check;

  const modal = ensureDungeonReadyModal();
  modal?.classList.remove("hidden");

  const title = document.getElementById("dungeonReadyTitle");
  if (title) title.textContent = check.dungeonName || "Dungeon Ready Check";

  const players = Array.isArray(check.players) ? check.players : [];
  const readyCount = players.filter(player => player.isReady).length;

  const status = document.getElementById("dungeonReadyStatus");

  if (status) {
    status.textContent =
      check.status === "pending"
        ? `${readyCount} of ${players.length} adventurers ready`
        : check.status === "completed"
          ? "The expedition is entering the dungeon..."
          : check.status === "expired"
            ? "The ready check expired."
            : "The ready check was cancelled.";
  }

  const list = document.getElementById("dungeonReadyParticipants");

  if (list) {
    list.innerHTML = players.map(player => `
      <div class="dungeon-ready-player ${player.isReady ? "is-ready" : ""}">
        <div>
          <strong>${escapeHtml(player.name)}</strong>
          <span>
            ${player.className ? `${escapeHtml(player.className)} • ` : ""}
            Lv. ${Number(player.level)}
          </span>
        </div>

        <div class="dungeon-ready-player__state">
          ${player.isReady ? "✓ Ready" : "… Waiting"}
        </div>
      </div>
    `).join("");
  }

  const me = players.find(
    player => Number(player.playerId) === Number(dungeonReadySelfId)
  );

  const toggle = document.getElementById("dungeonReadyToggleBtn");

  if (toggle) {
    toggle.disabled = dungeonReadyBusy || check.status !== "pending";
    toggle.textContent = me?.isReady ? "Unready" : "Ready";
  }

  const cancel = document.getElementById("dungeonReadyCancelBtn");

  if (cancel) {
    const canCancel =
      Number(check.createdByPlayerId) === Number(dungeonReadySelfId) ||
      Boolean(me?.isLeader);

    cancel.style.display = canCancel ? "inline-block" : "none";
    cancel.disabled = dungeonReadyBusy || check.status !== "pending";
  }

  renderDungeonReadyCountdown();
}

async function transitionDungeonReadyCheck(check) {
  if (
    check?.status !== "completed" ||
    !check.instanceId
  ) {
    return;
  }

  const readyCheckId =
    Number(
      check.id
    );

  /*
   * Mark this check resolved immediately. Any older pending snapshot
   * already in flight will be ignored when it eventually returns.
   */
  if (
    Number.isInteger(
      readyCheckId
    ) &&
    readyCheckId > 0
  ) {
    resolvedDungeonReadyCheckIds.add(
      readyCheckId
    );
  }

  dungeonReadyFetchGeneration++;

  if (
    dungeonReadyTransitioning
  ) {
    /*
     * Even if another completion handler is already opening the
     * Dungeon, make absolutely sure this overlay is gone.
     */
    document
      .getElementById(
        "dungeonReadyModal"
      )
      ?.remove();

    return;
  }

  dungeonReadyTransitioning =
    true;

  stopDungeonReadyTimers();

  dungeonReadyCheck =
    null;

  dungeonReadyBusy =
    false;

  enteringDungeon =
    false;

  document
    .getElementById(
      "dungeonReadyModal"
    )
    ?.remove();

  try {
    if (
      typeof openDungeonModal ===
      "function"
    ) {
      await openDungeonModal();
    } else {
      window.location.href =
        "/dungeon";

      return;
    }

    /*
     * Final DOM guarantee. If an old async render raced with the
     * Dungeon opening, remove the ready overlay again afterward.
     */
    document
      .getElementById(
        "dungeonReadyModal"
      )
      ?.remove();
  } catch (error) {
    console.error(
      "Failed to transition into Dungeon:",
      error
    );
  } finally {
    dungeonReadyTransitioning =
      false;
  }
}

async function fetchDungeonReadyCheck() {
  const fetchGeneration =
    dungeonReadyFetchGeneration;

  try {
    const response =
      await fetch(
        "/api/dungeons/ready-check",
        {
          credentials:
            "include",
          cache:
            "no-store"
        }
      );

    const data =
      await response.json();

    /*
     * A completion event happened while this request was in flight.
     * Its response is now stale and must not touch the ready UI.
     */
    if (
      fetchGeneration !==
      dungeonReadyFetchGeneration
    ) {
      return null;
    }

    if (
      !response.ok ||
      data.ok === false
    ) {
      throw new Error(
        data.error ||
        "Unable to load Dungeon ready check."
      );
    }

    dungeonReadySelfId =
      Number(
        data.playerId ||
        0
      ) ||
      dungeonReadySelfId;

    if (
      !data.readyCheck
    ) {
      if (
        dungeonReadyCheck
      ) {
        try {
          const activeResponse =
            await fetch(
              "/api/dungeons/active",
              {
                credentials:
                  "include",
                cache:
                  "no-store"
              }
            );

          const activeData =
            await activeResponse.json();

          if (
            fetchGeneration !==
            dungeonReadyFetchGeneration
          ) {
            return null;
          }

          if (
            activeResponse.ok &&
            activeData?.dungeon
          ) {
            stopDungeonReadyTimers();

            dungeonReadyCheck =
              null;

            dungeonReadyBusy =
              false;

            enteringDungeon =
              false;

            document
              .getElementById(
                "dungeonReadyModal"
              )
              ?.remove();

            if (
              typeof openDungeonModal ===
              "function"
            ) {
              await openDungeonModal();
            } else {
              window.location.href =
                "/dungeon";
            }

            document
              .getElementById(
                "dungeonReadyModal"
              )
              ?.remove();

            return null;
          }
        } catch (
          activeError
        ) {
          console.warn(
            "Could not verify Dungeon after ready-check cleanup:",
            activeError
          );
        }

        closeDungeonReadyModal();
      }

      return null;
    }

    const readyCheckId =
      Number(
        data.readyCheck.id
      );

    if (
      resolvedDungeonReadyCheckIds.has(
        readyCheckId
      )
    ) {
      return null;
    }

    if (
      data.readyCheck.status ===
      "completed"
    ) {
      await transitionDungeonReadyCheck(
        data.readyCheck
      );

      return data.readyCheck;
    }

    renderDungeonReadyCheck(
      data.readyCheck
    );

    if (
      data.readyCheck.status !==
      "pending"
    ) {
      setTimeout(
        closeDungeonReadyModal,
        900
      );
    }

    return data.readyCheck;
  } catch (error) {
    console.warn(
      "Dungeon ready-check refresh failed:",
      error
    );

    return null;
  }
}

function startDungeonReadyPolling() {
  stopDungeonReadyTimers();

  /*
   * WebSocket is authoritative for live updates.
   * This slow poll is only a reconnect/fallback safety net.
   */
  dungeonReadyPollTimer = window.setInterval(
    fetchDungeonReadyCheck,
    5000
  );

  dungeonReadyCountdownTimer = window.setInterval(
    renderDungeonReadyCountdown,
    200
  );
}

async function toggleDungeonReadyState() {
  if (
    dungeonReadyBusy ||
    !dungeonReadyCheck ||
    dungeonReadyCheck.status !== "pending"
  ) {
    return;
  }

  dungeonReadyBusy = true;
  showDungeonReadyError("");

  try {
    const me = dungeonReadyCheck.players?.find(
      player => Number(player.playerId) === Number(dungeonReadySelfId)
    );

    const response = await fetch("/api/dungeons/ready-check/ready", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ready: !Boolean(me?.isReady)
      })
    });

    const data = await response.json();

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Unable to update ready state.");
    }

    dungeonReadySelfId = Number(data.playerId || 0) || dungeonReadySelfId;
    renderDungeonReadyCheck(data.readyCheck);

    if (data.readyCheck?.status === "completed") {
      await transitionDungeonReadyCheck(data.readyCheck);
    }
  } catch (error) {
    showDungeonReadyError(error?.message || "Unable to update ready state.");
  } finally {
    dungeonReadyBusy = false;

    if (dungeonReadyCheck) {
      renderDungeonReadyCheck(dungeonReadyCheck);
    }
  }
}

async function cancelDungeonReadyCheck() {
  if (
    dungeonReadyBusy ||
    !dungeonReadyCheck ||
    dungeonReadyCheck.status !== "pending"
  ) {
    return;
  }

  dungeonReadyBusy = true;
  showDungeonReadyError("");

  try {
    const response = await fetch("/api/dungeons/ready-check/cancel", {
      method: "POST",
      credentials: "include"
    });

    const data = await response.json();

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Unable to cancel Dungeon ready check.");
    }

    renderDungeonReadyCheck(data.readyCheck);
    setTimeout(closeDungeonReadyModal, 700);
  } catch (error) {
    showDungeonReadyError(error?.message || "Unable to cancel Dungeon ready check.");
  } finally {
    dungeonReadyBusy = false;
  }
}


async function enterDungeonFromWorld() {
  if (
    isInCombat() ||
    enteringDungeon
  ) {
    return;
  }

  enteringDungeon =
    true;

  const button =
    document.getElementById(
      "enter-dungeon-btn"
    );

  if (button) {
    button.disabled =
      true;

    button.textContent =
      "Entering...";
  }

  try {
    /*
     * Ensure the current player is subscribed before the leader starts
     * the check. Other party members are still guaranteed delivery via
     * their private player socket rooms.
     */
    await connectDungeonSocket();

    /*
     * Resolve the dungeon from the player's current tile.
     * This keeps the world frontend generic; it does not
     * hard-code Stormvault's dungeon ID.
     */
    const resolveResponse =
      await fetch(
        "/world/current-dungeon",
        {
          credentials:
            "include",
          cache:
            "no-store"
        }
      );

    const resolved =
      await resolveResponse.json();

    if (
      !resolveResponse.ok ||
      resolved.ok === false ||
      !resolved.dungeon?.id
    ) {
      throw new Error(
        resolved.error ===
          "not_on_dungeon_tile"
          ? "You must stand on the dungeon entrance."
          : resolved.error ===
              "dungeon_not_configured"
            ? "This dungeon entrance is not configured yet."
            : resolved.error ||
              "Unable to identify this dungeon."
      );
    }

    const dungeonId =
      Number(
        resolved.dungeon.id
      );

    /*
     * If the player already has an active dungeon,
     * rejoin that run instead of treating it as an error.
     */
    const activeResponse =
      await fetch(
        "/api/dungeons/active",
        {
          credentials:
            "include",
          cache:
            "no-store"
        }
      );

    const activeData =
      await activeResponse.json();

    if (
      activeResponse.ok &&
      activeData?.dungeon
    ) {
      if (
        typeof openDungeonModal ===
        "function"
      ) {
        await openDungeonModal();
      } else {
        window.location.href =
          "/dungeon";
      }

      return;
    }

    const readyResponse =
      await fetch(
        `/api/dungeons/${dungeonId}/ready-check/start`,
        {
          method: "POST",
          credentials: "include"
        }
      );

    const readyData =
      await readyResponse.json();

    if (
      !readyResponse.ok ||
      readyData.ok === false
    ) {
      throw new Error(
        readyData.error ||
        "Unable to start Dungeon ready check."
      );
    }

    dungeonReadySelfId =
      Number(
        readyData.playerId ||
        0
      ) ||
      dungeonReadySelfId;

    if (readyData.readyCheck) {
      renderDungeonReadyCheck(
        readyData.readyCheck
      );
    }

    if (
      readyData.readyCheck?.status ===
      "completed"
    ) {
      await transitionDungeonReadyCheck(
        readyData.readyCheck
      );

      return;
    }

    startDungeonReadyPolling();
    enteringDungeon = false;

  } catch (err) {
    console.error(
      "Dungeon entry failed:",
      err
    );

    showErrorToast(
      err?.message ||
      "Unable to enter the dungeon.",
      "Dungeon Entry Failed"
    );

    if (button) {
      button.disabled =
        false;

      button.textContent =
        "Enter Dungeon";
    }

    enteringDungeon =
      false;
  }
}

window.enterDungeonFromWorld =
  enterDungeonFromWorld;

// =======================
// MOVEMENT
// =======================
// Classic tile-RPG movement: key state is continuous, but the authoritative
// server position remains integer-based. A released key finishes the current
// tile step, then stops cleanly on the next tile center.
const heldWorldDirections = new Set();
let mostRecentWorldDirection = null;

function directionFromWorldKey(key) {
  switch (String(key || "").toLowerCase()) {
    case "arrowup":
    case "w":
      return "north";
    case "arrowdown":
    case "s":
      return "south";
    case "arrowleft":
    case "a":
      return "west";
    case "arrowright":
    case "d":
      return "east";
    default:
      return null;
  }
}

function getHeldWorldDirection() {
  if (
    mostRecentWorldDirection &&
    heldWorldDirections.has(mostRecentWorldDirection)
  ) {
    return mostRecentWorldDirection;
  }

  return heldWorldDirections.values().next().value || null;
}

function isWorldTypingTarget(target) {
  const tag = String(target?.tagName || "").toLowerCase();

  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target?.isContentEditable
  );
}

function continueHeldWorldMovement() {
  if (moveLock || isInCombat()) return;

  const dir = getHeldWorldDirection();
  if (!dir) {
    setWorldPlayerMotion(lastMoveDir || "south", false);
    return;
  }

  void moveWorld(dir);
}

document.addEventListener("keydown", (e) => {
  const dir = directionFromWorldKey(e.key);
  if (!dir || isWorldTypingTarget(e.target)) return;

  e.preventDefault();

  if (isInCombat()) return;

  const wasHeld = heldWorldDirections.has(dir);
  heldWorldDirections.add(dir);
  mostRecentWorldDirection = dir;

  if (!wasHeld) {
    continueHeldWorldMovement();
  }
});

document.addEventListener("keyup", (e) => {
  const dir = directionFromWorldKey(e.key);
  if (!dir || isWorldTypingTarget(e.target)) return;

  e.preventDefault();
  heldWorldDirections.delete(dir);

  if (mostRecentWorldDirection === dir) {
    mostRecentWorldDirection = null;
  }
});

window.addEventListener("blur", () => {
  heldWorldDirections.clear();
  mostRecentWorldDirection = null;
});


async function syncWorldAudio(region, terrain) {
  let audio = window.GFAudio;

  if (
    !audio ||
    typeof audio.playRegionMusic !== "function" ||
    typeof audio.playTerrainAmbience !== "function"
  ) {
    try {
      audio = await window.GFAudioReady;
    } catch (err) {
      console.warn(
        "Unable to initialize Guildforge world audio:",
        err
      );
      return;
    }
  }

  if (!audio) return;

  const tasks = [];

  if (
    region &&
    typeof audio.playRegionMusic === "function"
  ) {
    tasks.push(
      audio.playRegionMusic(region)
    );
  }

  if (
    terrain &&
    typeof audio.playTerrainAmbience === "function"
  ) {
    tasks.push(
      audio.playTerrainAmbience(terrain)
    );
  }

  if (document.body && terrain) {
    document.body.dataset.gfTerrain =
      String(terrain);
  }

  if (!tasks.length) return;

  await Promise.allSettled(tasks);
}

async function moveWorld(dir) {
  dir = normalizeMoveDir(dir);

  if (!dir || isInCombat() || moveLock) return;

  moveLock = true;
  lastMoveDir = dir;
  lastMoveAt = Date.now();

  // Begin visual travel immediately. The network request runs in parallel,
  // so the character/world starts moving on the very frame the key is pressed.
  const visualStepPromise = animateWorldTravelStep(dir);

  try {
    const responsePromise = fetch(`/world/move/${dir}`, {
      credentials: "include",
      cache: "no-store"
    }).then(async res => ({
      res,
      data: await res.json()
    }));

    const [responseResult] = await Promise.all([
      responsePromise,
      visualStepPromise
    ]);

    const { res, data } = responseResult;

    if (!res.ok || !data?.success) {
      await animateWorldRollback(dir);
      return;
    }

    // Swapping to the newly-centered 11x11 buffer is visually seamless here:
    // the old grid's completed transform and the new grid's base transform
    // expose the same nine world rows/columns at this exact frame.
    if (data.world) {
      renderWorldFromData(data.world);
    } else {
      resetWorldGridToBase();
    }

    syncWorldAudio(
      data.region,
      data.terrain
    ).catch(err => {
      console.warn(
        "Unable to sync world audio after movement:",
        err
      );
    });

    if (data.nearbyObjects) {
      renderNearbyObjects(data.nearbyObjects);
    }

    if (data.regionData) {
      renderRegionHeader(data.regionData);

      if (
        window.GFWorldEvents?.setRegion &&
        data.regionData.region_id != null
      ) {
        await window.GFWorldEvents.setRegion(
          Number(data.regionData.region_id)
        );
      }
    }

    if (
      String(data.terrain || "").toLowerCase() === "dungeon"
    ) {
      await renderDungeonWorldHeaderIfNeeded(data.terrain);
    }

    updateNavHUD(data);

    if (data.huntProgress?.advanced) {
      showHuntProgress(data.huntProgress);
    }

    if (data.inCombat && data.enemy) {
      heldWorldDirections.clear();
      mostRecentWorldDirection = null;
      setWorldPlayerMotion(dir, false);

      pendingCombatEnemy = data.enemy;
      queueCombatOpen();
    }
  } catch (err) {
    console.error("World movement failed", err);
    await animateWorldRollback(dir);
  } finally {
    moveLock = false;

    if (!isInCombat() && heldWorldDirections.size) {
      // Start the next cell on the next paint frame. No artificial cooldown or
      // interval gap means held WASD reads as one continuous walk.
      requestAnimationFrame(() => {
        continueHeldWorldMovement();
      });
    } else {
      setWorldPlayerMotion(lastMoveDir || dir, false);
    }
  }
}

// =======================
// NEARBY OBJECTS / INTERACTIONS
// =======================

// Initial page load — still fetches directly
async function loadNearbyObjects() {
  try {
    const res = await fetch("/api/world/nearby-objects", {
      credentials: "include"
    });
    const data = await res.json();

    if (!data?.success) {
      renderNearbyObjects([]);
      return;
    }

    renderNearbyObjects(data.objects || []);
  } catch (err) {
    console.error("Failed to load nearby objects", err);
    renderNearbyObjects([]);
  }
}

function renderNearbyObjects(objects) {
  const list = document.getElementById("worldInteractList");
  if (!list) return;

  const badge = document.getElementById("nav-nearby-count");
  if (badge) {
    badge.textContent = String(
      objects?.length || 0
    );
  }

  if (!objects || objects.length === 0) {
    list.innerHTML = `
      <div class="world-interact__empty">
        Nothing to interact with nearby.
      </div>
    `;
    return;
  }

  const sorted = [...objects].sort((a, b) => {
    if (!!a.inRange !== !!b.inRange) {
      return a.inRange ? -1 : 1;
    }

    return (
      Number(a.distance || 0) -
      Number(b.distance || 0)
    );
  });

  list.innerHTML = sorted
    .map(obj => {

      const isHuntClue =
        obj.object_type ===
        "hunt_clue";

      const isHuntTarget =
        obj.object_type ===
        "hunt_target";

      const isWorldEventInteract =
        obj.object_type ===
        "world_event_interact";

      const rangeText =
        obj.inRange
          ? `
            <span class="world-interact__status in-range">
              In range
            </span>
          `
          : `
            <span class="world-interact__status out-of-range">
              ${Number(obj.distance)} tiles away
            </span>
          `;

      let btn = "";

      if (!obj.inRange) {

        btn = `
          <button
            class="world-interact__btn"
            disabled
          >
            Too Far
          </button>
        `;

        } else if (isHuntClue) {

          btn = `
            <button
              class="world-interact__btn"
              onclick="
                investigateHuntClue(
                  ${Number(obj.id)}
                )
              "
            >
              Investigate
            </button>
          `;

} else if (isHuntTarget) {

  const huntStatus =
    String(
      obj.status || ""
    ).toLowerCase();

  const encounterEngaged =
    huntStatus === "engaged";

  btn = `
    <button
      class="
        world-interact__btn
        world-interact__btn--hunt
      "
      onclick="
        ${
          encounterEngaged
            ? "rejoinHuntEncounter()"
            : `confrontHuntTarget(${Number(obj.partyHuntId)})`
        }
      "
    >
      ${
        encounterEngaged
          ? "Rejoin"
          : "Confront"
      }
    </button>
  `;

} else if (isWorldEventInteract) {

  btn = `
    <button
      class="
        world-interact__btn
        world-interact__btn--event
      "
      onclick="
        interactWithWorldEvent(
          ${Number(obj.id)}
        )
      "
    >
      Investigate
    </button>
  `;

} else {

        btn = `
          <button
            class="world-interact__btn"
            onclick="
              interactWithWorldObject(
                ${Number(obj.id)}
              )
            "
          >
            Interact
          </button>
        `;

      }

      const typeLabel =
        isHuntClue
          ? "Hunt Clue"
          : isHuntTarget
            ? "Hunt Quarry"
            : isWorldEventInteract
              ? "World Event"
              : String(
                  obj.object_type ||
                  "object"
                );

      return `
        <div
          class="
            world-interact__row
            ${isHuntClue
              ? "world-interact__row--hunt-clue"
              : ""}

            ${isHuntTarget
              ? "world-interact__row--hunt-target"
              : ""}

            ${isWorldEventInteract
              ? "world-interact__row--world-event"
              : ""}
          "
        >

          <div class="world-interact__meta">

            <div class="world-interact__name">
              ${
                obj.icon
                  ? `${escapeHtml(obj.icon)} `
                  : ""
              }
              ${escapeHtml(obj.name)}
            </div>

            <div class="world-interact__sub">
              (${Number(obj.x)}, ${Number(obj.y)})
              •
              ${escapeHtml(typeLabel)}
            </div>

          </div>

          <div class="world-interact__actions">
            ${rangeText}
            ${btn}
          </div>

        </div>
      `;
    })
    .join("");
}

async function interactWithWorldEvent(
  spawnId
) {
  if (isInCombat()) {
    return;
  }

  try {
    const res =
      await fetch(
        `/api/world-event/interact/${Number(spawnId)}`,
        {
          method: "POST",
          credentials: "include"
        }
      );

    const data =
      await res.json();

    if (
      !res.ok ||
      data.success === false
    ) {
      const error =
        String(
          data?.error ||
          "Unable to interact with the event."
        );

      if (error === "too_far_away") {
        showErrorToast(
          "Move directly onto the event location before interacting.",
          "World Event"
        );
        return;
      }

      if (
        error ===
        "world_event_interaction_not_found"
      ) {
        showErrorToast(
          "That event interaction is no longer available.",
          "World Event"
        );

        await loadNearbyObjects();
        return;
      }

      if (
        error ===
        "world_event_objective_not_active"
      ) {
        showErrorToast(
          "That objective is no longer active.",
          "World Event"
        );

        await refreshWorld();
        return;
      }

      throw new Error(error);
    }

    const updates =
      Array.isArray(
        data?.worldEventProgress?.updates
      )
        ? data.worldEventProgress.updates
        : [];

    const update =
      updates[0] || null;

    if (
      update &&
      window.GFToast?.show
    ) {
      GFToast.show(
        update.objectiveJustCompleted
          ? "World Event Objective Complete"
          : "World Event Progress",

        `${update.currentAmount}/${update.targetAmount} ${String(
          update.objectiveKey || "Objective"
        )
          .replaceAll("_", " ")
          .replace(/\b\w/g, c => c.toUpperCase())}`,

        {
          type: "success",
          durationMs:
            update.objectiveJustCompleted
              ? 3600
              : 2600
        }
      );
    }

    const resolution =
      data?.worldEventResolution;

    if (
      resolution?.resolved &&
      resolution?.outcome &&
      window.GFToast?.show
    ) {
      setTimeout(
        () => {
          GFToast.show(
            resolution.advancedPhase
              ? "World Event Escalated"
              : "World Event Resolved",

            resolution.outcome.name ||
              "The event has changed.",

            {
              type: "success",
              durationMs: 4200
            }
          );
        },
        500
      );
    }

    /*
     * Refresh both the world buffer and Nearby list. A consumed event
     * interaction should disappear immediately, and a resolved branch may
     * have changed the active event phase/spawns.
     */
    await refreshWorld();

  } catch (err) {
    console.error(
      "World Event interaction failed:",
      err
    );

    showErrorToast(
      err?.message ||
        "Unable to interact with the event.",
      "World Event"
    );
  }
}

window.interactWithWorldEvent =
  interactWithWorldEvent;


async function investigateHuntClue(
  clueId
) {
  if (isInCombat()) {
    return;
  }

  try {

    const res =
      await fetch(
        `/hunts/clues/${clueId}/investigate`,
        {
          method: "POST",
          credentials: "include"
        }
      );

    const data =
      await res.json();


    if (
      !res.ok ||
      data.ok === false
    ) {
      throw new Error(
        data.error ||
        "Unable to investigate clue."
      );
    }


    /*
     * Show the clue itself using the
     * existing discovery/lore modal.
     */
    if (data.clue) {
      openLoreModal(
        data.clue.name ||
          "Hunt Clue",

        data.clue.description ||
          "You examine the evidence."
      );
    }


    /*
     * Shared Hunt progress notification.
     */
    if (
      data.huntProgress?.advanced
    ) {
      showHuntProgress(
        data.huntProgress
      );
    }


    /*
     * Refresh Nearby so the clue
     * immediately disappears after
     * investigation.
     */
    await loadNearbyObjects();

  } catch (err) {

    console.error(
      "Hunt clue investigation failed:",
      err
    );

    showErrorToast(
      err.message ||
      "Unable to investigate clue."
    );

  }
}

let huntConfronting =
  false;

async function confrontHuntTarget(
  partyHuntId
) {
  if (
    isInCombat() ||
    huntConfronting
  ) {
    return;
  }

  huntConfronting = true;

  try {

    /*
     * Ask the server to create/start
     * the shared Hunt encounter.
     *
     * The server remains authoritative:
     * it should verify party membership,
     * Hunt state and player position.
     */
    const res =
      await fetch(
        "/hunts/active/confront",
        {
          method: "POST",
          credentials: "include",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              partyHuntId:
                Number(
                  partyHuntId
                )
            })
        }
      );

    const data =
      await res.json();

    if (
      !res.ok ||
      data.ok === false
    ) {
      throw new Error(
        data.error ||
        "Unable to confront the Hunt target."
      );
    }


    /*
     * Ensure this player is registered
     * as an active encounter participant.
     *
     * If createHuntEncounter() already
     * does this for the initiating player,
     * this route should simply return
     * the existing participation state.
     */



    /*
     * Open the shared combat UI.
     */
    if (
      typeof window
        .openHuntCombatModal ===
      "function"
    ) {

      await window
        .openHuntCombatModal();

    } else {

      throw new Error(
        "Hunt combat UI is unavailable."
      );
    }


    /*
     * Refresh world/Nearby state.
     * Hunt status should now be engaged.
     */
    await loadNearbyObjects();

  } catch (err) {

    console.error(
      "Hunt confrontation failed:",
      err
    );

    showErrorToast(
      err.message ||
      "Unable to confront the Hunt target.",
      "Hunt Failed"
    );

  } finally {

    huntConfronting =
      false;
  }
}

async function rejoinHuntEncounter() {
  if (
    isInCombat() ||
    huntConfronting
  ) {
    return;
  }

  huntConfronting = true;

  try {

    /*
     * Reattach this player to the
     * existing shared Hunt encounter.
     */
    const joinRes =
      await fetch(
        "/hunts/encounter/join",
        {
          method: "POST",
          credentials: "include"
        }
      );

    const joinData =
      await joinRes.json();

    if (
      !joinRes.ok ||
      joinData.ok === false
    ) {
      throw new Error(
        joinData.error ||
        "Unable to rejoin the Hunt encounter."
      );
    }


    /*
     * Now that the server has confirmed
     * participation, open the combat UI.
     */
    if (
      typeof window
        .openHuntCombatModal !==
      "function"
    ) {
      throw new Error(
        "Hunt combat UI is unavailable."
      );
    }

    await window
      .openHuntCombatModal();

  } catch (err) {

    console.error(
      "Hunt rejoin failed:",
      err
    );

    showErrorToast(
      err.message ||
      "Unable to rejoin the Hunt encounter.",
      "Hunt Failed"
    );

    /*
     * Refresh stale world state if the
     * encounter has actually ended.
     */
    try {
      await refreshWorld();
    } catch (_) {}

  } finally {

    huntConfronting =
      false;
  }
}

window.rejoinHuntEncounter =
  rejoinHuntEncounter;

window.rejoinHuntEncounter =
  rejoinHuntEncounter;

window.confrontHuntTarget =
  confrontHuntTarget;

async function interactWithWorldObject(objectId) {
  if (isInCombat()) return;

  try {
    const res = await fetch(`/api/world/interact/${objectId}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      }
    });

    const data = await res.json();

    if (!res.ok) {
      if (data?.error === "too_far_away") {
        alert("You are too far away to interact with that.");
        return;
      }

      if (data?.error === "world_object_not_found") {
        alert("That object is no longer available.");
        await loadNearbyObjects();
        return;
      }

      alert("Interaction failed.");
      return;
    }

    if (data?.lore) {
      openLoreModal(data.lore.title, data.lore.text);
    }

    await loadNearbyObjects();

    if (typeof refreshTrackedQuest === "function") {
      try {
        await refreshTrackedQuest();
      } catch (err) {
        console.warn("refreshTrackedQuest failed", err);
      }
    }

    if (typeof loadQuestList === "function") {
      try {
        await loadQuestList();
      } catch (err) {
        console.warn("loadQuestList failed", err);
      }
    }
  } catch (err) {
    console.error("Interaction failed", err);
    alert("Interaction failed.");
  }
}


function getResourceIcon(professionName) {
  switch (String(professionName || "").toLowerCase()) {
    case "mining":
      return "⛏️";
    case "herbalism":
      return "🌿";
    case "woodcutting":
      return "🪓";
    default:
      return "✨";
  }
}

function showErrorToast(message, title = "Action Failed") {
  if (window.GFToast?.show) {
    GFToast.show(title, message, {
      type: "error",
      durationMs: 2400
    });
    return;
  }

  console.warn(`${title}: ${message}`);
}

async function gatherResourceNode(spawnedNodeId) {
  if (isInCombat()) return;

  const panel = document.getElementById("currentResourcePanel");
  const btn = panel?.querySelector(".resource-panel__btn");

  let sound = null;

  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/gathering/gather/${spawnedNodeId}`, {
      method: "POST",
      credentials: "include"
    });

    const data = await res.json();

    if (!res.ok) {
      showErrorToast(
        formatGatheringError(data?.error || "Failed to gather resource.")
      );
      return;
    }

    const gatherTime = Number(data.gatherTimeMs || 1800);

    showGatheringModal({
      professionName: data.professionName,
      nodeName: data.nodeName,
      durationMs: gatherTime
    });

    sound = playGatheringSound(data.professionName);

    await sleep(gatherTime);

    playGatherCompleteSound();

    const itemsText = (data.gatheredItems || [])
      .map(item => `${item.quantity}x ${item.name}`)
      .join(", ");

    if (window.GFToast?.show) {
      GFToast.show(
        data.nodeName,
        `+${data.xpGained} ${data.professionName} XP${itemsText ? ` • ${itemsText}` : ""}`,
        {
          type: "success",
          durationMs: 2600
        }
      );
    }

    if (data.leveledUp && window.GFToast?.show) {
      playProfessionLevelSound();

      GFToast.show(
        "Profession Increased!",
        `${data.professionName} reached Level ${data.newLevel}!`,
        {
          type: "success",
          durationMs: 4500
        }
      );
    }

    await refreshWorld();

    if (typeof loadInventory === "function") {
      await loadInventory();
    }
  } catch (err) {
    console.error("Gathering failed", err);
    showErrorToast("Gathering failed.");
  } finally {
    if (sound) {
      sound.pause();
      sound.currentTime = 0;
      sound.loop = false;
    }

    hideGatheringModal();

    if (btn) btn.disabled = false;
  }
}
function formatGatheringError(error) {
  switch (String(error)) {
    case "inventory_full":
      return "Your inventory is full.";

    case "missing_gathering_tool":
      return "You don't have the required gathering tool equipped.";

    case "invalid_gathering_tool":
      return "The equipped tool is not valid for this resource.";

    case "profession_level_too_low":
      return "Your profession level is too low to gather this resource.";

    case "node_not_found_or_expired":
      return "That resource has already been depleted.";

    case "too_far_from_node":
      return "Move onto the resource before gathering.";

    default:
      return error || "Gathering failed.";
  }
}

// =======================
// REST MODAL
// =======================
async function openRest() {
  if (isInCombat()) return;

  const root = document.getElementById("rest-root");
  if (!root) {
    console.error("Missing #rest-root in world page.");
    return;
  }

  try {
    const res = await fetch("/rest/modal", {
      credentials: "include"
    });

    const html = await res.text();
    root.innerHTML = html;

    if (typeof window.initRestModal === "function") {
      window.initRestModal();
    }
  } catch (err) {
    console.error("Failed to open rest modal", err);
  }
}

function closeRestModal() {
  if (typeof window.clearRestIntervals === "function") {
    window.clearRestIntervals();
  }

  const root = document.getElementById("rest-root");
  if (root) root.innerHTML = "";
}

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    const modal = document.getElementById("rest-root");

    if (modal && modal.children.length) {
      closeRestModal();
    }
  }
});

window.openRest = openRest;
window.closeRestModal = closeRestModal;


// =======================
// LORE MODAL
// =======================
function openLoreModal(title, text) {
  const modal = document.getElementById("loreModal");
  const titleEl = document.getElementById("loreTitle");
  const bodyEl = document.getElementById("loreBody");

  if (!modal || !titleEl || !bodyEl) return;

  titleEl.textContent = title || "Discovery";
  bodyEl.textContent = text || "";
  modal.classList.remove("hidden");
}

function closeLoreModal() {
  const modal = document.getElementById("loreModal");
  if (!modal) return;
  modal.classList.add("hidden");
}

/* =========================================
   PARTY QUICK VIEW
========================================= */

function escapePartyHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


async function loadWorldPartyStatus() {
  const status =
    document.getElementById(
      "partyQuickStatus"
    );

  if (!status) return;

  try {

    const response =
      await fetch("/party");

    const data =
      await response.json();

    if (
      !response.ok ||
      !data.ok
    ) {
      throw new Error(
        data.error ||
        "Unable to load party."
      );
    }

    if (!data.party) {

      status.textContent =
        "No active party";

      return;
    }

    status.textContent =
      `${data.party.members.length} / ${data.party.maxMembers} adventurers`;

  } catch (err) {

    console.error(
      "Party status failed:",
      err
    );

    status.textContent =
      "Party unavailable";

  }
}


async function openPartyQuickView() {

  const modal =
    document.getElementById(
      "partyQuickModal"
    );

  const body =
    document.getElementById(
      "partyQuickBody"
    );

  if (!modal || !body) {
    return;
  }

  modal.classList.remove(
    "hidden"
  );

  body.innerHTML = `
    <div class="party-quick-loading">
      Gathering your company...
    </div>
  `;

  try {

    const response =
      await fetch("/party");

    const data =
      await response.json();

    if (
      !response.ok ||
      !data.ok
    ) {
      throw new Error(
        data.error ||
        "Unable to load party."
      );
    }

    const party =
      data.party;


    if (!party) {

      body.innerHTML = `
        <div class="party-quick-empty">
          You are not currently part of an
          adventuring company.
        </div>
      `;

      return;
    }


    body.innerHTML =
      party.members
        .map(renderPartyQuickMember)
        .join("");

  } catch (err) {

    console.error(
      "Party quick view failed:",
      err
    );

    body.innerHTML = `
      <div class="party-quick-empty">
        Unable to load your party.
      </div>
    `;

  }
}


function renderPartyQuickMember(
  member
) {

  const hpPercent =
    member.maxhp > 0
      ? Math.max(
          0,
          Math.min(
            100,
            (
              member.hpoints /
              member.maxhp
            ) * 100
          )
        )
      : 0;


  const spPercent =
    member.maxspoints > 0
      ? Math.max(
          0,
          Math.min(
            100,
            (
              member.spoints /
              member.maxspoints
            ) * 100
          )
        )
      : 0;


  return `
    <div class="party-quick-member">

      <div class="party-quick-member__top">

        <div>

          <div class="party-quick-member__name">
            ${escapePartyHtml(member.name)}
          </div>

          <div class="party-quick-member__meta">
            ${escapePartyHtml(member.className)}
            · Level ${member.level}
          </div>

        </div>

        ${
          member.isLeader
            ? `
              <span class="party-quick-leader">
                👑 Leader
              </span>
            `
            : ""
        }

      </div>


      <div class="party-quick-bars">

        <div class="party-quick-stat">

          <span>HP</span>

          <div class="party-quick-track">
            <div
              class="party-quick-fill hp"
              style="width:${hpPercent}%"
            ></div>
          </div>

          <span>
            ${member.hpoints}/${member.maxhp}
          </span>

        </div>


        <div class="party-quick-stat">

          <span>SP</span>

          <div class="party-quick-track">
            <div
              class="party-quick-fill sp"
              style="width:${spPercent}%"
            ></div>
          </div>

          <span>
            ${member.spoints}/${member.maxspoints}
          </span>

        </div>

      </div>

    </div>
  `;
}


function closePartyQuickView() {

  document
    .getElementById(
      "partyQuickModal"
    )
    ?.classList.add(
      "hidden"
    );
}
loadWorldPartyStatus();
// =======================
// UTILS
// =======================
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
/**
 * The world: a single deterministic height field plus the biome rules that
 * colour it and decide what grows where.
 *
 * Everything here is pure math on plain numbers (no three.js) so the same code
 * runs in the browser and under node in tools/preview.mjs.
 *
 * Layout, looking down (north = -Z). The valley is the original world and is
 * reproduced exactly inside its own 1024 m box; everything beyond it is new.
 *
 *        NW tundra          high peaks (N / NE)
 *                 \        /
 *      moor -----  pine forest  ----- rocky shoulders (E)
 *                 \   river   /
 *          marsh ---  LAKE  ---
 *                 (S shore, spawn)
 *   ─────────────── valley rim ────────────────
 *              \  the pass  /                     the highway climbs
 *   ══════════════════════════════════════════    through the rim here
 *                THE CITY (see citymap.js)
 *   ▓▓▓▓▓▓▓▓▓▓▓▓ the bay, open to the south ▓▓▓▓
 */

import { Noise2D, clamp, lerp, smoothstep, smin } from './noise.js';
import {
  plainHeightAt, plainWeight, gradeForHighway, zoneAt, ZONE,
} from './citymap.js';

/**
 * The valley's own domain. The original world was 1024 m square and its height
 * function is written in terms of that half-extent, so keeping it as a separate
 * constant means widening the world does not move a single stone in the valley.
 */
export const VALLEY_HALF = 512;

export const WORLD = {
  seed: 20260728,
  size: 2560,          // metres, square
  half: 1280,
  seaLevel: 0,         // lake and sea surface both sit at y = 0
  shoreLine: 1.6,      // sand/gravel band above the water line
  treeLine: 68,        // pines give up above this
  snowLine: 84,        // permanent snow (modulated by noise + slope)
  spawn: { x: 56, z: 138 },   // south shore rise, facing north over the lake
  /** Where the valley ends and the new terrain takes over. */
  valleyHalf: VALLEY_HALF,
  valleyFeather: 152,
};

const noiseBase = new Noise2D(WORLD.seed);
const noiseWarp = new Noise2D(WORLD.seed + 101);
const noiseRidge = new Noise2D(WORLD.seed + 202);
const noiseDetail = new Noise2D(WORLD.seed + 303);
const noiseMoisture = new Noise2D(WORLD.seed + 404);
const noiseColor = new Noise2D(WORLD.seed + 505);

// ---------------------------------------------------------------------------
// The lake
// ---------------------------------------------------------------------------

const LAKE = { x: 96, z: -36, radius: 165, depth: 13 };

// ---------------------------------------------------------------------------
// The river: a polyline from the northern peaks down into the lake. Terrain is
// carved to follow it; src/water.js builds a ribbon mesh over the same course.
// ---------------------------------------------------------------------------

const RIVER_CONTROL = [
  [-322, -452], [-286, -372], [-243, -300], [-214, -232],
  [-168, -186], [-118, -158], [-64, -132], [-6, -108], [52, -92],
];

/** Catmull-Rom through the control points, sampled into a dense polyline. */
function buildRiverPath(points, samplesPerSpan = 10) {
  const out = [];
  const p = (i) => points[clamp(i, 0, points.length - 1)];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = p(i - 1), p1 = p(i), p2 = p(i + 1), p3 = p(i + 2);
    for (let s = 0; s < samplesPerSpan; s++) {
      const t = s / samplesPerSpan;
      const t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(points[points.length - 1].slice());
  return out;
}

export const RIVER_PATH = buildRiverPath(RIVER_CONTROL);

// Cumulative length, used to give the river a monotonically descending surface.
const RIVER_LEN = [0];
for (let i = 1; i < RIVER_PATH.length; i++) {
  const dx = RIVER_PATH[i][0] - RIVER_PATH[i - 1][0];
  const dz = RIVER_PATH[i][1] - RIVER_PATH[i - 1][1];
  RIVER_LEN.push(RIVER_LEN[i - 1] + Math.hypot(dx, dz));
}
export const RIVER_TOTAL = RIVER_LEN[RIVER_LEN.length - 1];

export const RIVER_SOURCE_HEIGHT = 46;
export const RIVER_WIDTH = 6.0;   // half-width of open water
const RIVER_BANK = 34;            // half-width of the carved valley

/** Water surface height of the river at arc length s (metres from the source). */
export function riverSurfaceAt(s) {
  const t = clamp(s / RIVER_TOTAL, 0, 1);
  // ease-out: steep near the source, almost flat where it meets the lake
  const drop = 1 - Math.pow(1 - t, 2.2);
  return lerp(RIVER_SOURCE_HEIGHT, WORLD.seaLevel + 0.05, drop);
}

/**
 * Distance-to-river is needed at every terrain vertex, so the polyline is
 * rasterised once into a coarse field and bilinearly sampled afterwards.
 * Stores distance (metres, capped) and arc length at the closest point.
 */
const FIELD_RES = 320;
const FIELD_STEP = (VALLEY_HALF * 2) / (FIELD_RES - 1);
const riverDist = new Float32Array(FIELD_RES * FIELD_RES).fill(9999);
const riverArc = new Float32Array(FIELD_RES * FIELD_RES);

(function rasteriseRiverField() {
  const reach = RIVER_BANK + 26;
  const cells = Math.ceil(reach / FIELD_STEP);
  for (let i = 0; i < RIVER_PATH.length; i++) {
    const [px, pz] = RIVER_PATH[i];
    const gx = (px + VALLEY_HALF) / FIELD_STEP;
    const gz = (pz + VALLEY_HALF) / FIELD_STEP;
    const x0 = Math.max(0, Math.floor(gx - cells));
    const x1 = Math.min(FIELD_RES - 1, Math.ceil(gx + cells));
    const z0 = Math.max(0, Math.floor(gz - cells));
    const z1 = Math.min(FIELD_RES - 1, Math.ceil(gz + cells));
    for (let z = z0; z <= z1; z++) {
      const wz = z * FIELD_STEP - VALLEY_HALF;
      for (let x = x0; x <= x1; x++) {
        const wx = x * FIELD_STEP - VALLEY_HALF;
        const d = Math.hypot(wx - px, wz - pz);
        const idx = z * FIELD_RES + x;
        if (d < riverDist[idx]) {
          riverDist[idx] = d;
          riverArc[idx] = RIVER_LEN[i];
        }
      }
    }
  }
})();

function sampleField(field, x, z) {
  const gx = clamp((x + VALLEY_HALF) / FIELD_STEP, 0, FIELD_RES - 1.001);
  const gz = clamp((z + VALLEY_HALF) / FIELD_STEP, 0, FIELD_RES - 1.001);
  const x0 = gx | 0, z0 = gz | 0;
  const fx = gx - x0, fz = gz - z0;
  const i00 = z0 * FIELD_RES + x0;
  const a = field[i00], b = field[i00 + 1];
  const c = field[i00 + FIELD_RES], d = field[i00 + FIELD_RES + 1];
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
}

/** Distance in metres from (x,z) to the river centre line (capped near 9999). */
export function riverDistanceAt(x, z) {
  return sampleField(riverDist, x, z);
}

/** Arc length of the nearest point on the river course. */
export function riverArcAt(x, z) {
  return sampleField(riverArc, x, z);
}

// ---------------------------------------------------------------------------
// Height field
// ---------------------------------------------------------------------------

/**
 * The valley, exactly as it has always been. Written against VALLEY_HALF, not
 * WORLD.half, so it is unaffected by the world growing around it.
 */
export function valleyHeightAt(x, z) {
  // Domain warp keeps the big shapes from looking like plain noise.
  const wx = x + 74 * noiseWarp.noise(x * 0.0016, z * 0.0016);
  const wz = z + 74 * noiseWarp.noise(x * 0.0016 + 41.7, z * 0.0016 - 19.3);

  // Broad landform: a shallow bowl that drains toward the lake.
  let h = 5 + noiseBase.fbm(wx, wz, 4, 1 / 700, 0.5) * 26;

  // Where the mountains are allowed to grow, biased north and east so the
  // south shore stays open and walkable.
  const massif = smoothstep(-0.08, 0.30, noiseBase.fbm(x + 2000, z - 1400, 3, 1 / 620, 0.55));
  const northEast = smoothstep(0.0, 1.0, (-z / VALLEY_HALF) * 0.66 + (x / VALLEY_HALF) * 0.40 + 0.36);
  const ridge = Math.pow(noiseRidge.ridged(wx, wz, 6, 1 / 430, 0.5), 1.7);
  const peaks = ridge * 205 * massif * (0.14 + 0.86 * northEast);
  h += peaks;

  // Secondary spurs: smaller ridged crests that break up the slopes.
  h += Math.pow(noiseRidge.ridged(x - 3100, z + 2200, 4, 1 / 190, 0.5), 2.0) * 46
       * smoothstep(-0.1, 0.5, noiseBase.fbm(x - 700, z + 400, 2, 1 / 380, 0.5));

  // Mid-scale hills and hollows.
  h += noiseBase.fbm(wx, wz, 4, 1 / 155, 0.5) * 13;
  // Fine relief, damped down low so the shoreline stays readable.
  h += noiseDetail.fbm(x, z, 3, 1 / 33, 0.5) * 2.8 * smoothstep(-4, 12, h);

  // A ragged rim of peaks so the valley reads as enclosed instead of just
  // ending. The noise offset keeps it from looking like a square frame.
  const eBase = Math.max(Math.abs(x), Math.abs(z)) / VALLEY_HALF;
  const e = eBase + 0.13 * noiseBase.fbm(x, z, 3, 1 / 300, 0.5) - 0.03;
  const rim = smoothstep(0.62, 1.02, e);
  h += rim * rim * (150 + 60 * noiseRidge.ridged(x, z, 4, 1 / 240, 0.5));

  // Lake basin.
  const dLake = Math.hypot(x - LAKE.x, z - LAKE.z) - LAKE.radius * (0.82 + 0.18 * noiseBase.fbm(x, z, 2, 1 / 190, 0.5) * 2);
  const lakeBed = -LAKE.depth * smoothstep(30, -140, dLake) + noiseDetail.fbm(x, z, 2, 1 / 60, 0.5) * 1.4;
  const lakeMix = smoothstep(46, -16, dLake);
  if (lakeMix > 0) h = lerp(h, smin(h, lakeBed, 9), lakeMix);

  // River gorge.
  const dRiver = riverDistanceAt(x, z);
  if (dRiver < RIVER_BANK + 24) {
    const surf = riverSurfaceAt(riverArcAt(x, z));
    const valley = surf + 7.5 * smoothstep(RIVER_WIDTH, RIVER_BANK + 20, dRiver);
    const bed = surf - lerp(2.6, 0.7, smoothstep(0, RIVER_WIDTH, dRiver));
    const carve = Math.min(valley, Math.max(bed, valley));
    const w = smoothstep(RIVER_BANK + 22, RIVER_WIDTH * 0.5, dRiver);
    h = lerp(h, smin(h, carve, 5), w);
    if (dRiver < RIVER_WIDTH) h = Math.min(h, bed);
  }

  return h;
}

/**
 * Everything outside the valley: a mountain country of ridges and hollows,
 * closed off by a rim at the world's edge — except to the south, where the rim
 * is opened so the bay can run out to the horizon.
 */
function outerHeightAt(x, z) {
  const wx = x + 92 * noiseWarp.noise(x * 0.0012 + 5.3, z * 0.0012 - 2.1);
  const wz = z + 92 * noiseWarp.noise(x * 0.0012 - 11.7, z * 0.0012 + 8.9);

  // Biased upward on purpose: the only water outside the valley should be the
  // bay, so the mountain country never dips below the sea line by accident.
  let h = 22 + noiseBase.fbm(wx, wz, 4, 1 / 780, 0.5) * 24;

  const massif = smoothstep(-0.24, 0.30, noiseBase.fbm(x - 900, z + 1500, 3, 1 / 700, 0.55));
  const ridge = Math.pow(noiseRidge.ridged(wx, wz, 6, 1 / 470, 0.5), 1.62);
  h += ridge * 232 * (0.26 + 0.74 * massif);

  h += Math.pow(noiseRidge.ridged(x + 4400, z - 2600, 4, 1 / 205, 0.5), 2.0) * 54 * massif;
  h += noiseBase.fbm(wx, wz, 4, 1 / 165, 0.5) * 14;
  h += noiseDetail.fbm(x, z, 3, 1 / 34, 0.5) * 3.0 * smoothstep(-4, 14, h);

  // Rim at the edge of the map. Warped hard, because the valley already has a
  // squared-off rim of its own and two concentric boxes would look like a maze.
  const rx = x + 190 * noiseBase.fbm(x - 2400, z + 1900, 3, 1 / 640, 0.55);
  const rz = z + 190 * noiseBase.fbm(x + 3100, z - 1200, 3, 1 / 640, 0.55);
  const eBase = Math.max(Math.abs(rx), Math.abs(rz)) / WORLD.half;
  const e = eBase + 0.14 * noiseBase.fbm(x + 600, z - 300, 3, 1 / 300, 0.5) - 0.02;
  let rim = smoothstep(0.64, 1.06, e);

  // The sea gate: no rim across the mouth of the bay, so the water reaches the
  // horizon between two headlands instead of hitting a wall.
  const gate = smoothstep(640, 830, z) * (1 - smoothstep(770, 1000, Math.abs(x)));
  rim *= 1 - gate;
  h += rim * rim * (172 + 74 * noiseRidge.ridged(x, z, 4, 1 / 250, 0.5));

  return h;
}

/**
 * Terrain height in metres at world (x,z). This is the authoritative surface.
 *
 * Three surfaces, in order: the mountains, the city's plain lerped over them,
 * the valley lerped over that, and finally the highway graded into whatever
 * came out — which is what cuts the gorge through the valley rim.
 */
export function heightAt(x, z) {
  const maxAbs = Math.max(Math.abs(x), Math.abs(z));
  const wValley = maxAbs <= VALLEY_HALF
    ? 1
    : 1 - smoothstep(VALLEY_HALF, VALLEY_HALF + WORLD.valleyFeather, maxAbs);

  let h;
  if (wValley >= 1) {
    h = valleyHeightAt(x, z);
  } else {
    h = outerHeightAt(x, z);
    const wPlain = plainWeight(x, z);
    if (wPlain > 0.0005) h = lerp(h, plainHeightAt(x, z), wPlain);
    if (wValley > 0.0005) h = lerp(h, valleyHeightAt(x, z), wValley);
  }

  return gradeForHighway(h, x, z);
}

/**
 * Height sampled the way the terrain mesh actually renders it: bilinear over a
 * grid of `spacing` metres. The player walks on this so feet never sink into or
 * float above the visible triangles.
 */
export function gridHeightAt(x, z, spacing) {
  const gx = Math.floor(x / spacing) * spacing;
  const gz = Math.floor(z / spacing) * spacing;
  const fx = (x - gx) / spacing;
  const fz = (z - gz) / spacing;
  const h00 = heightAt(gx, gz);
  const h10 = heightAt(gx + spacing, gz);
  const h01 = heightAt(gx, gz + spacing);
  const h11 = heightAt(gx + spacing, gz + spacing);
  return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
}

/** Surface normal from central differences. Returns [nx, ny, nz], normalised. */
export function normalAt(x, z, eps = 1.0) {
  const hl = heightAt(x - eps, z), hr = heightAt(x + eps, z);
  const hd = heightAt(x, z - eps), hu = heightAt(x, z + eps);
  const nx = hl - hr, nz = hd - hu, ny = 2 * eps;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** 0 = flat, 1 = vertical. */
export function slopeAt(x, z, eps = 1.4) {
  return 1 - normalAt(x, z, eps)[1];
}

/**
 * Height of the water surface at (x,z) — the river where it runs, the lake
 * level everywhere else. Anything below this is underwater.
 */
export function waterSurfaceAt(x, z) {
  if (riverDistanceAt(x, z) < RIVER_WIDTH * 1.8) {
    const surface = riverSurfaceAt(riverArcAt(x, z));
    if (surface > WORLD.seaLevel) return surface;
  }
  return WORLD.seaLevel;
}

/** How deep the water is over the terrain at (x,z); 0 on dry land. */
export function waterDepthAt(x, z, h = heightAt(x, z)) {
  return Math.max(0, waterSurfaceAt(x, z) - h);
}

// ---------------------------------------------------------------------------
// Biome
// ---------------------------------------------------------------------------

/** Wetness in [0,1]: noise, plus a bonus near standing water, minus altitude. */
export function moistureAt(x, z, h = heightAt(x, z)) {
  let m = 0.5 + 0.5 * noiseMoisture.fbm(x, z, 3, 1 / 340, 0.55);
  const dLake = Math.hypot(x - LAKE.x, z - LAKE.z) - LAKE.radius;
  m += 0.34 * smoothstep(90, -10, dLake);
  m += 0.30 * smoothstep(60, 6, riverDistanceAt(x, z));
  m -= smoothstep(24, 96, h) * 0.45;
  return clamp(m, 0, 1);
}

export const BIOME = {
  WATERBED: 0,
  SHORE: 1,
  MARSH: 2,
  MEADOW: 3,
  FOREST: 4,
  MOOR: 5,
  ROCK: 6,
  ALPINE: 7,
  SNOW: 8,
};

/** Which biome governs (x,z). Drives both colour and what gets scattered. */
export function biomeAt(x, z, h = heightAt(x, z), slope = slopeAt(x, z), m = moistureAt(x, z, h)) {
  if (h < WORLD.seaLevel - 0.05) return BIOME.WATERBED;
  const snowNoise = noiseColor.fbm(x, z, 2, 1 / 120, 0.5) * 9;
  if (h > WORLD.snowLine + snowNoise && slope < 0.62) return BIOME.SNOW;
  if (slope > 0.52) return BIOME.ROCK;
  if (h < WORLD.shoreLine) return m > 0.72 ? BIOME.MARSH : BIOME.SHORE;
  if (h > WORLD.treeLine) return BIOME.ALPINE;
  if (m > 0.56) return BIOME.FOREST;
  if (m > 0.36) return BIOME.MEADOW;
  return BIOME.MOOR;
}

const PALETTE = {
  [BIOME.WATERBED]: [0.13, 0.15, 0.11],
  [BIOME.SHORE]: [0.34, 0.31, 0.24],
  [BIOME.MARSH]: [0.17, 0.24, 0.11],
  [BIOME.MEADOW]: [0.22, 0.33, 0.11],
  [BIOME.FOREST]: [0.13, 0.21, 0.08],
  [BIOME.MOOR]: [0.30, 0.29, 0.14],
  [BIOME.ROCK]: [0.22, 0.21, 0.20],
  [BIOME.ALPINE]: [0.25, 0.25, 0.21],
  [BIOME.SNOW]: [0.78, 0.83, 0.90],
};

const out3 = [0, 0, 0];

/**
 * Ground colour at (x,z), written into `target` as linear-ish RGB in [0,1].
 * Blends the biome palette by slope and altitude and breaks up flat areas with
 * a little low-frequency tint noise.
 */
export function surfaceColor(x, z, h = heightAt(x, z), slope = slopeAt(x, z), m = moistureAt(x, z, h), target = out3) {
  const b = biomeAt(x, z, h, slope, m);
  let [r, g, bl] = PALETTE[b];

  // Rock bleeds into everything as the ground steepens.
  const rocky = smoothstep(0.36, 0.66, slope);
  if (b !== BIOME.SNOW && b !== BIOME.ROCK) {
    const rock = PALETTE[BIOME.ROCK];
    r = lerp(r, rock[0], rocky); g = lerp(g, rock[1], rocky); bl = lerp(bl, rock[2], rocky);
  }

  // Bare stone is never one flat grey — lichen patches, mineral staining and
  // broad bands of strata break up the high ground.
  const stone = clamp(rocky + (b === BIOME.ROCK || b === BIOME.ALPINE ? 1 : 0), 0, 1);
  if (stone > 0.04) {
    const lichen = smoothstep(0.10, 0.55, noiseColor.fbm(x + 310, z + 720, 3, 1 / 30, 0.5)) * stone * 0.55;
    r = lerp(r, 0.23, lichen); g = lerp(g, 0.29, lichen); bl = lerp(bl, 0.15, lichen);
    const strata = noiseColor.fbm(x - 1200, z + 240, 2, 1 / 70, 0.5) * 0.15 * stone;
    r += strata * 1.15; g += strata; bl += strata * 0.8;
  }

  // Snow dusting starts a little below the true snow line.
  const dust = smoothstep(WORLD.snowLine - 16, WORLD.snowLine + 6, h) * (1 - smoothstep(0.45, 0.72, slope));
  if (dust > 0) {
    r = lerp(r, 0.86, dust); g = lerp(g, 0.89, dust); bl = lerp(bl, 0.94, dust);
  }

  // Damp ground darkens toward the water's edge.
  const wet = smoothstep(2.4, -0.4, h);
  if (wet > 0) {
    r = lerp(r, r * 0.62, wet); g = lerp(g, g * 0.66, wet); bl = lerp(bl, bl * 0.66, wet);
  }

  // Patchiness.
  const v1 = noiseColor.fbm(x, z, 3, 1 / 26, 0.5) * 0.085;
  const v2 = noiseColor.fbm(x + 900, z - 500, 2, 1 / 170, 0.5) * 0.07;
  const tint = 1 + v1 + v2;
  r = clamp(r * tint, 0, 1);
  g = clamp(g * (tint + v2 * 0.35), 0, 1);
  bl = clamp(bl * tint, 0, 1);

  // Made ground. Most of this is hidden under the paving meshes, but it keeps
  // meadow green from peeking out at every kerb, and it paints the parks.
  const zone = zoneAt(x, z).kind;
  if (zone !== ZONE.OUTSIDE) {
    const grade = zone === ZONE.PARK
      ? [0.19, 0.30, 0.10]
      : zone === ZONE.HIGHWAY
        ? [0.30, 0.27, 0.21]
        : [0.24, 0.24, 0.23];
    const w = zone === ZONE.PARK ? 0.85 : 0.9;
    r = lerp(r, grade[0] * tint, w);
    g = lerp(g, grade[1] * tint, w);
    bl = lerp(bl, grade[2] * tint, w);
  }

  target[0] = r;
  target[1] = g;
  target[2] = bl;
  return target;
}

/** True where the flat lake plane should be drawn (used to trim its geometry). */
export function isLakeArea(x, z) {
  return Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.radius * 1.35;
}

export { LAKE };

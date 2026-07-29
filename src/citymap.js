/**
 * The city, as pure math.
 *
 * Same rule as world.js: no three.js in here, so the layout can be evaluated by
 * the terrain generator, by the scatter placement code, and by tools/preview.mjs
 * running under node. src/city.js is the part that turns all of this into meshes.
 *
 * Everything is derived from a plan, not from noise:
 *
 *        ^ north (-Z)              the valley
 *        |                              |
 *        |                        mountain rim
 *        |                              |
 *        |                     the pass  \  (the highway climbs through)
 *        |                              |
 *   ┌────┴──────────────────────────────────────────────┐
 *   │  N  outskirts                                     │
 *   │     ┌───┬───┬───────────┬───┬───┐   avenues run N-S│
 *   │     │   │   │  midtown  │   │   │   streets run E-W│
 *   │     ├───┼───┴───────────┴───┼───┤                  │
 *   │     │   │  PARK  │ core │spire│  │                  │
 *   │     ├───┼───┬───────────┬───┼───┤                  │
 *   │     │   │   │  midtown  │   │   │                  │
 *   │     └───┴───┴───────────┴───┴───┘                  │
 *   │  waterfront ▓▓▓▓ piers ▓▓▓▓                        │
 *   └────────────────────────────────────────────────────┘
 *                        the bay (sea level)
 *
 * The whole layout is deterministic from CITY.seed, and every query
 * (`zoneAt`, `solidHeightAt`, …) is O(1): roads are analytic lines, blocks are
 * a lookup by index, and a block's buildings are generated once and cached.
 */

import { mulberry32, clamp, lerp, smoothstep, hash2 } from './noise.js';

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export const CITY = {
  seed: 77015,
  /** Centre of the grid, in world coordinates. */
  x: 0,
  z: 950,

  avenueSpacing: 104,   // N-S roads, indexed by k
  streetSpacing: 68,    // E-W roads, indexed by m
  avenueMax: 7,         // k in [-7, 7]  → 1456 m across
  streetMax: 3,         // m in [-3, 3]  →  408 m deep

  avenueHalf: 10,       // half road width
  avenueMainHalf: 14,   // every third avenue is a boulevard
  streetHalf: 7,
  streetMainHalf: 11,
  sidewalk: 5.0,        // width of the pavement flanking every road
  curb: 0.16,           // how far the pavement stands above the tarmac

  /** South edge of the promenade — past this the ground dives into the bay. */
  shore: 1186,
  seaFloor: -9.5,

  /** Plain height at the foot of the mountains and at the promenade. */
  northHeight: 15.6,
  shoreHeight: 3.2,
};

/** Half the built footprint, derived from the grid. */
CITY.halfX = CITY.avenueMax * CITY.avenueSpacing + 26;   // 754
// Reaches past the last street to take in the promenade and the foreshore, so
// nothing seeds itself between the sea wall and the tide line.
CITY.halfZ = CITY.streetMax * CITY.streetSpacing + 56;   // 260

/** North edge of the promenade: everything south of this is quayside. */
CITY.promenade = CITY.z + CITY.streetMax * CITY.streetSpacing + CITY.streetHalf + CITY.sidewalk;

export const CITY_BOUNDS = {
  minX: CITY.x - CITY.halfX,
  maxX: CITY.x + CITY.halfX,
  minZ: CITY.z - CITY.halfZ,
  maxZ: CITY.z + CITY.halfZ,
};

/**
 * The lowland the city sits on. It has to be completely flat under every paved
 * surface — roads and plazas are flat quads laid on `plainHeightAt`, so if the
 * terrain were still blending toward the mountains there, they would float.
 */
export const PLAIN = {
  northEdge: 512,   // the valley's own box: nothing north of here is touched
  northFull: 728,   // fully plain from here south — 216 m of escarpment
  sideFull: 748,    // |x| below this is all plain
  sideEdge: 1010,   // |x| above this rises into the headlands
};

const noiseSeed = mulberry32(CITY.seed);
const PLAIN_WOBBLE = [noiseSeed() * 6.28, noiseSeed() * 6.28, noiseSeed() * 6.28];

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

/**
 * The plain the city is built on: a gentle grade from the foot of the mountains
 * down to the promenade, then a dive into the bay. Deliberately smooth — the
 * roads and plazas are flat quads laid on exactly this surface, so anything
 * high-frequency here would show up as pavement floating over the ground.
 */
export function plainHeightAt(x, z) {
  const grade = smoothstep(700, CITY.shore, z);
  let h = lerp(CITY.northHeight, CITY.shoreHeight, grade);

  // A very long, very shallow swell so the grid does not read as a table top.
  h += Math.sin(x * 0.0031 + PLAIN_WOBBLE[0]) * 1.15;
  h += Math.sin(z * 0.0042 + PLAIN_WOBBLE[1]) * 0.85;
  h += Math.sin((x * 0.0017 - z * 0.0023) + PLAIN_WOBBLE[2]) * 0.75;

  // Into the bay: a short foreshore below the sea wall, then the bed.
  const dive = smoothstep(CITY.shore - 4, CITY.shore + 66, z);
  return lerp(h, CITY.seaFloor, dive);
}

/** 0..1 — how much of the terrain at (x,z) is the city plain rather than hills. */
export function plainWeight(x, z) {
  const northward = smoothstep(PLAIN.northEdge, PLAIN.northFull, z);
  const sideways = 1 - smoothstep(PLAIN.sideFull, PLAIN.sideEdge, Math.abs(x));
  return northward * sideways;
}

// ---------------------------------------------------------------------------
// The highway: valley → pass → city
// ---------------------------------------------------------------------------

/**
 * Control points for the road out of the valley, as [x, z, surfaceHeight].
 * The heights are the design profile of the road, not the natural ground — the
 * terrain is graded to meet them, which is what cuts the gorge through the rim.
 */
const ROAD_CONTROL = [
  // Across the valley floor the profile hugs the natural ground, so the road
  // reads as a track laid on the meadow rather than a trench cut through it.
  [96, 140, 11.8],
  [30, 182, 22.0],
  [-58, 226, 28.0],
  [-152, 258, 20.0],
  [-248, 296, 12.0],
  [-330, 344, 9.0],
  // From here it climbs the rim, and the cut becomes the gorge.
  [-386, 400, 22.0],
  [-414, 452, 33.0],
  [-424, 506, 41.0],
  [-434, 562, 41.5],
  [-436, 618, 35.0],
  [-430, 668, 25.0],
  [-422, 706, plainHeightAt(-422, 706)],
  [-416, 748, plainHeightAt(-416, 748)],
];

export const ROAD_SHELF = 7.0;    // half-width of the flat carriageway + verge
export const ROAD_GRADE = 44;     // half-width of the graded shoulder

function catmullRom(points, samplesPerSpan = 8) {
  const out = [];
  const p = (i) => points[clamp(i, 0, points.length - 1)];
  const dim = points[0].length;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = p(i - 1), p1 = p(i), p2 = p(i + 1), p3 = p(i + 2);
    for (let s = 0; s < samplesPerSpan; s++) {
      const t = s / samplesPerSpan;
      const t2 = t * t, t3 = t2 * t;
      const v = [];
      for (let d = 0; d < dim; d++) {
        v.push(0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * t
          + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2
          + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3));
      }
      out.push(v);
    }
  }
  out.push(points[points.length - 1].slice());
  return out;
}

export const ROAD_PATH = catmullRom(ROAD_CONTROL, 8);

/**
 * Nearest-point queries against a polyline, bucketed into a coarse grid so a
 * lookup only ever tests a handful of segments. The terrain generator calls
 * this for every vertex it builds, so it has to stay cheap.
 */
class PathIndex {
  constructor(path, reach) {
    this.path = path;
    this.reach = reach;
    this.cell = Math.max(32, reach);
    this.buckets = new Map();

    for (let i = 0; i < path.length - 1; i++) {
      const [x0, z0] = path[i];
      const [x1, z1] = path[i + 1];
      const minX = Math.min(x0, x1) - reach, maxX = Math.max(x0, x1) + reach;
      const minZ = Math.min(z0, z1) - reach, maxZ = Math.max(z0, z1) + reach;
      for (let cz = Math.floor(minZ / this.cell); cz <= Math.floor(maxZ / this.cell); cz++) {
        for (let cx = Math.floor(minX / this.cell); cx <= Math.floor(maxX / this.cell); cx++) {
          const key = cx * 65536 + cz;
          let list = this.buckets.get(key);
          if (!list) this.buckets.set(key, (list = []));
          list.push(i);
        }
      }
    }
  }

  /**
   * @returns {{dist:number, height:number, t:number, index:number}} distance to
   * the centre line, the interpolated third component (the road surface), and
   * where along the polyline the closest point fell.
   */
  query(x, z, out = { dist: Infinity, height: 0, t: 0, index: 0 }) {
    out.dist = Infinity;
    const list = this.buckets.get(Math.floor(x / this.cell) * 65536 + Math.floor(z / this.cell));
    if (!list) return out;

    for (let n = 0; n < list.length; n++) {
      const i = list[n];
      const a = this.path[i], b = this.path[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len2 = dx * dx + dz * dz || 1;
      let t = ((x - a[0]) * dx + (z - a[1]) * dz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a[0] + dx * t, pz = a[1] + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < out.dist) {
        out.dist = d;
        out.height = a[2] + (b[2] - a[2]) * t;
        out.t = t;
        out.index = i;
      }
    }
    return out;
  }
}

const roadIndex = new PathIndex(ROAD_PATH, ROAD_GRADE + 26);
const _roadHit = { dist: Infinity, height: 0, t: 0, index: 0 };

/**
 * Bounding box of everything the road can possibly touch. `heightAt` runs this
 * test millions of times during a load, so it comes before the bucket lookup.
 */
const ROAD_BOX = (() => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ROAD_PATH) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const pad = ROAD_GRADE + 26;
  return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
})();

/** Road query at (x,z), or null when nothing is near enough to matter. */
export function highwayAt(x, z) {
  if (x < ROAD_BOX.minX || x > ROAD_BOX.maxX || z < ROAD_BOX.minZ || z > ROAD_BOX.maxZ) return null;
  const hit = roadIndex.query(x, z, _roadHit);
  return hit.dist < ROAD_GRADE + 24 ? hit : null;
}

/**
 * Bend the natural terrain to meet the road: dead flat under the carriageway,
 * easing back out to whatever the mountain was doing within ROAD_GRADE metres.
 * Where the road crosses the valley rim this is what opens the gorge.
 */
export function gradeForHighway(h, x, z) {
  const hit = highwayAt(x, z);
  if (!hit) return h;

  // Once the road is out on the plain the ground is already flat, so the carve
  // fades out rather than leaving a ridge running through the city grid.
  const strength = 1 - smoothstep(690, 780, z);
  if (strength <= 0.001) return h;

  const d = hit.dist;
  let carved;
  if (d <= ROAD_SHELF) {
    carved = hit.height;
  } else {
    // Cut and fill fall off at different rates: a cut leaves a steep rock wall,
    // an embankment spreads out. Both ease into the natural surface.
    const cutting = h > hit.height;
    const reach = cutting ? ROAD_GRADE : ROAD_GRADE * 0.55;
    const t = smoothstep(ROAD_SHELF, ROAD_SHELF + reach, d);
    const eased = cutting ? t * t : Math.sqrt(t);
    carved = lerp(hit.height, h, eased);
  }
  return lerp(h, carved, strength);
}

// ---------------------------------------------------------------------------
// The road grid
// ---------------------------------------------------------------------------

/** True for every third avenue / street — those get built twice as wide. */
export const isMainAvenue = (k) => k % 3 === 0;
export const isMainStreet = (m) => m === 0;

export function avenueHalfWidth(k) {
  return isMainAvenue(k) ? CITY.avenueMainHalf : CITY.avenueHalf;
}

export function streetHalfWidth(m) {
  return isMainStreet(m) ? CITY.streetMainHalf : CITY.streetHalf;
}

/** World X of avenue k / world Z of street m. */
export const avenueX = (k) => CITY.x + k * CITY.avenueSpacing;
export const streetZ = (m) => CITY.z + m * CITY.streetSpacing;

/** Block (bi, bj) spans avenue bi..bi+1 and street bj..bj+1. */
export function blockRect(bi, bj) {
  const x0 = avenueX(bi) + avenueHalfWidth(bi) + CITY.sidewalk;
  const x1 = avenueX(bi + 1) - avenueHalfWidth(bi + 1) - CITY.sidewalk;
  const z0 = streetZ(bj) + streetHalfWidth(bj) + CITY.sidewalk;
  const z1 = streetZ(bj + 1) - streetHalfWidth(bj + 1) - CITY.sidewalk;
  return { x0, z0, x1, z1, w: x1 - x0, d: z1 - z0 };
}

export const BLOCK = {
  minI: -CITY.avenueMax,
  maxI: CITY.avenueMax - 1,
  minJ: -CITY.streetMax,
  maxJ: CITY.streetMax - 1,
};

export function blockIndexAt(x, z) {
  const bi = Math.floor((x - CITY.x) / CITY.avenueSpacing);
  const bj = Math.floor((z - CITY.z) / CITY.streetSpacing);
  if (bi < BLOCK.minI || bi > BLOCK.maxI || bj < BLOCK.minJ || bj > BLOCK.maxJ) return null;
  return { bi, bj };
}

// --- what a block is for ----------------------------------------------------

export const USE = {
  BUILT: 0,
  PARK: 1,
  PLAZA: 2,      // the landmark square
  WATERFRONT: 3, // low warehouses and sheds along the quay
};

/** The four blocks in the middle are one continuous park. */
const PARK_CORE = new Set(['-1,-1', '0,-1', '-1,0', '0,0']);
const PLAZA_BLOCK = '2,0';

export function blockUse(bi, bj) {
  const key = `${bi},${bj}`;
  if (PARK_CORE.has(key)) return USE.PARK;
  if (key === PLAZA_BLOCK) return USE.PLAZA;
  if (bj === BLOCK.maxJ) return USE.WATERFRONT;
  // A scatter of neighbourhood squares so the grid is not relentless.
  if (hash2(bi, bj, CITY.seed) > 0.90) return USE.PARK;
  return USE.BUILT;
}

/** How far the outermost roads run past the last junction. */
export const AVENUE_OVERRUN = 34;
export const STREET_OVERRUN = 30;

/** The z range an avenue is actually built over. */
export function avenueExtent() {
  return [streetZ(-CITY.streetMax) - AVENUE_OVERRUN, streetZ(CITY.streetMax) + AVENUE_OVERRUN];
}

export function streetExtent() {
  return [avenueX(-CITY.avenueMax) - STREET_OVERRUN, avenueX(CITY.avenueMax) + STREET_OVERRUN];
}

/**
 * The two roads that would otherwise cut the central park in half are not
 * built. Everything that needs to agree about this — the zone lookup, the road
 * meshes, the traffic lanes, the street lamps — goes through these.
 */
export function avenueSuppressed(k, z) {
  return k === 0 && z > streetZ(-1) && z < streetZ(1);
}

export function streetSuppressed(m, x) {
  return m === 0 && x > avenueX(-1) && x < avenueX(1);
}

// ---------------------------------------------------------------------------
// Zones — what is underfoot
// ---------------------------------------------------------------------------

export const ZONE = {
  OUTSIDE: 0,
  ROAD: 1,
  PAVEMENT: 2,
  LOT: 3,       // the paved ground inside a built block
  PARK: 4,
  PLAZA: 5,
  QUAY: 6,
  HIGHWAY: 7,
};

const _zone = { kind: ZONE.OUTSIDE, edge: 0 };

/**
 * What kind of surface (x,z) is. Called a great many times by the scatter
 * placement pass, so the early-out for "nowhere near the city" comes first.
 */
export function zoneAt(x, z) {
  _zone.kind = ZONE.OUTSIDE;
  _zone.edge = 0;

  if (x > CITY_BOUNDS.minX && x < CITY_BOUNDS.maxX && z > CITY_BOUNDS.minZ && z < CITY_BOUNDS.maxZ) {
    // Nearest avenue and street.
    const k = Math.round((x - CITY.x) / CITY.avenueSpacing);
    const m = Math.round((z - CITY.z) / CITY.streetSpacing);
    const inK = k >= -CITY.avenueMax && k <= CITY.avenueMax;
    const inM = m >= -CITY.streetMax && m <= CITY.streetMax;

    const [az0, az1] = avenueExtent();
    const [sx0, sx1] = streetExtent();
    const dk = inK ? Math.abs(x - avenueX(k)) : Infinity;
    const dm = inM ? Math.abs(z - streetZ(m)) : Infinity;
    const wk = inK && z >= az0 && z <= az1 && !avenueSuppressed(k, z) ? avenueHalfWidth(k) : -1;
    const wm = inM && x >= sx0 && x <= sx1 && !streetSuppressed(m, x) ? streetHalfWidth(m) : -1;

    if ((wk >= 0 && dk <= wk) || (wm >= 0 && dm <= wm)) {
      _zone.kind = ZONE.ROAD;
      return _zone;
    }
    if ((wk >= 0 && dk <= wk + CITY.sidewalk) || (wm >= 0 && dm <= wm + CITY.sidewalk)) {
      _zone.kind = ZONE.PAVEMENT;
      return _zone;
    }

    if (z > CITY.promenade) {
      _zone.kind = ZONE.QUAY;
      return _zone;
    }

    const block = blockIndexAt(x, z);
    if (block) {
      const use = blockUse(block.bi, block.bj);
      if (use === USE.PARK) _zone.kind = ZONE.PARK;
      else if (use === USE.PLAZA) _zone.kind = ZONE.PLAZA;
      else if (use === USE.WATERFRONT) _zone.kind = ZONE.QUAY;
      else _zone.kind = ZONE.LOT;
      return _zone;
    }
    // Inside the bounds but outside the grid: the ragged edge of town.
    _zone.kind = ZONE.OUTSIDE;
    return _zone;
  }

  const hit = highwayAt(x, z);
  // The flat shelf only — grass and trees come right up to the gravel verge,
  // which is what stops the road reading as a runway through the meadow.
  if (hit && hit.dist < ROAD_SHELF) _zone.kind = ZONE.HIGHWAY;
  return _zone;
}

/** Convenience: is anything man-made paved over this spot? */
export function isPaved(x, z) {
  const k = zoneAt(x, z).kind;
  return k === ZONE.ROAD || k === ZONE.PAVEMENT || k === ZONE.LOT
    || k === ZONE.PLAZA || k === ZONE.QUAY || k === ZONE.HIGHWAY;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export const STYLE = {
  GLASS: 0,      // curtain wall tower
  BRONZE: 1,     // dark glass tower
  OFFICE: 2,     // punched windows in pale concrete
  BRICK: 3,      // older brick block
  DECO: 4,       // stepped stone tower with vertical piers
  SHED: 5,       // warehouse / industrial
};

/**
 * Design height for a lot, in metres. An ellipse centred on downtown, squashed
 * along Z because the city is wider than it is deep, plus a district floor so
 * the outskirts never go completely flat.
 */
function districtHeight(x, z, rnd) {
  const u = x - CITY.x;
  const v = (z - CITY.z) * 1.5;
  const r = Math.hypot(u, v);

  const core = 1 - smoothstep(50, 430, r);
  const mid = 1 - smoothstep(260, 780, r);
  let h = lerp(7.5, 30, mid) + Math.pow(core, 1.5) * 132;

  // Waterfront is sheds and low blocks, whatever the district says.
  const quay = smoothstep(140, 200, z - CITY.z);
  h = lerp(h, 9 + rnd() * 7, quay);

  h *= 0.60 + rnd() * 0.80;
  // Every so often something goes up much taller than its neighbours.
  if (rnd() < 0.04 + core * 0.16) h *= 1.45 + rnd() * 0.9;
  return Math.max(5.5, h);
}

/** Lots are generous downtown and small out at the edges. */
function lotTarget(x, z) {
  const r = Math.hypot(x - CITY.x, (z - CITY.z) * 1.5);
  return lerp(23, 14, smoothstep(80, 620, r));
}

function styleFor(x, z, height, rnd) {
  if (z - CITY.z > 150) return rnd() < 0.7 ? STYLE.SHED : STYLE.BRICK;
  if (height > 84) return rnd() < 0.55 ? STYLE.GLASS : (rnd() < 0.5 ? STYLE.BRONZE : STYLE.DECO);
  if (height > 42) {
    const r = rnd();
    if (r < 0.34) return STYLE.GLASS;
    if (r < 0.52) return STYLE.BRONZE;
    if (r < 0.80) return STYLE.OFFICE;
    return STYLE.DECO;
  }
  const r = rnd();
  if (r < 0.42) return STYLE.BRICK;
  if (r < 0.78) return STYLE.OFFICE;
  return STYLE.GLASS;
}

/** Recursive binary subdivision of a block into lots. */
function subdivide(rect, rnd, target, out, depth = 0) {
  const { x0, z0, x1, z1 } = rect;
  const w = x1 - x0, d = z1 - z0;
  if (depth > 5 || (w < target * 1.6 && d < target * 1.6)) {
    out.push(rect);
    return;
  }
  const jitter = 0.38 + rnd() * 0.24;
  if (w > d) {
    const cut = x0 + w * jitter;
    subdivide({ x0, z0, x1: cut, z1 }, rnd, target, out, depth + 1);
    subdivide({ x0: cut, z0, x1, z1 }, rnd, target, out, depth + 1);
  } else {
    const cut = z0 + d * jitter;
    subdivide({ x0, z0, x1, z1: cut }, rnd, target, out, depth + 1);
    subdivide({ x0, z0: cut, x1, z1 }, rnd, target, out, depth + 1);
  }
}

/**
 * A building is a stack of axis-aligned tiers. Keeping them axis-aligned is
 * what makes `solidHeightAt` a couple of comparisons instead of a mesh query,
 * and the city rides on that: it is how you land a hoverboard on a roof.
 */
function makeBuilding(lot, rnd) {
  const inset = 0.8 + rnd() * 1.6;
  const x0 = lot.x0 + inset, x1 = lot.x1 - inset;
  const z0 = lot.z0 + inset, z1 = lot.z1 - inset;
  const w = x1 - x0, d = z1 - z0;
  if (w < 7 || d < 7) return null;

  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  let height = districtHeight(cx, cz, rnd);
  // Tall needs a base to stand on: skinny lots cap out as low-rise infill.
  const footprint = Math.min(w, d);
  height = Math.min(height, footprint < 11 ? 9 + footprint * 1.9 : 6 + footprint * 10.5);

  const style = styleFor(cx, cz, height, rnd);
  const floorHeight = style === STYLE.SHED ? 5.2 : style === STYLE.BRICK ? 3.5 : 3.85;
  const floors = Math.max(1, Math.round(height / floorHeight));
  height = floors * floorHeight;

  const tiers = [];
  let top = height;
  let hx0 = x0, hx1 = x1, hz0 = z0, hz1 = z1;
  tiers.push({ x0: hx0, z0: hz0, x1: hx1, z1: hz1, top: 0, height: 0 });
  tiers.length = 0;

  // Stepped setbacks for the taller stuff — one of the cheapest ways to stop a
  // skyline looking like a bar chart.
  const setbacks = height > 95 ? 2 + (rnd() < 0.5 ? 1 : 0) : height > 52 ? 1 : 0;
  let base = 0;
  for (let s = 0; s <= setbacks; s++) {
    const isLast = s === setbacks;
    const share = isLast ? 1 : (0.36 + rnd() * 0.24);
    const tierTop = isLast ? height : base + (height - base) * share;
    tiers.push({ x0: hx0, z0: hz0, x1: hx1, z1: hz1, base, top: tierTop });
    base = tierTop;
    const shrinkX = Math.min((hx1 - hx0) * (0.10 + rnd() * 0.12), 5.5);
    const shrinkZ = Math.min((hz1 - hz0) * (0.10 + rnd() * 0.12), 5.5);
    hx0 += shrinkX; hx1 -= shrinkX; hz0 += shrinkZ; hz1 -= shrinkZ;
  }
  top = height;

  return {
    x0, z0, x1, z1, cx, cz,
    top,
    tiers,
    style,
    floorHeight,
    floors,
    seed: (rnd() * 0xffffff) | 0,
    // Rooftop clutter: mechanical housings, tanks, an aerial on the tall ones.
    mast: rnd() < (height > 70 ? 0.55 : 0.12) ? 6 + rnd() * 22 : 0,
    plant: 1 + ((rnd() * 3) | 0),
  };
}

/** The landmark: a stepped spire on the plaza block, visible from the valley. */
export function landmark() {
  const rect = blockRect(2, 0);
  const cx = (rect.x0 + rect.x1) / 2;
  const cz = (rect.z0 + rect.z1) / 2;
  const half = 17;
  const tiers = [];
  const steps = 5;
  let base = 0;
  for (let s = 0; s < steps; s++) {
    const t = s / steps;
    const top = lerp(0, 196, Math.pow((s + 1) / steps, 0.86));
    const hw = lerp(half, half * 0.30, t);
    tiers.push({ x0: cx - hw, x1: cx + hw, z0: cz - hw, z1: cz + hw, base, top });
    base = top;
  }
  return {
    x0: cx - half, x1: cx + half, z0: cz - half, z1: cz + half, cx, cz,
    top: 196, tiers, style: STYLE.DECO, floorHeight: 4.0, floors: 49,
    seed: 0x5eed, mast: 46, plant: 0, landmark: true,
  };
}

const blockCache = new Map();

/** Every building in block (bi, bj). Generated once, then cached. */
export function buildingsInBlock(bi, bj) {
  const key = bi * 1024 + bj;
  let list = blockCache.get(key);
  if (list) return list;

  list = [];
  const use = blockUse(bi, bj);
  if (use === USE.BUILT || use === USE.WATERFRONT) {
    const rnd = mulberry32((CITY.seed ^ ((bi + 64) << 12) ^ (bj + 64)) >>> 0);
    const rect = blockRect(bi, bj);
    const lots = [];
    subdivide(rect, rnd, lotTarget((rect.x0 + rect.x1) / 2, (rect.z0 + rect.z1) / 2), lots);
    for (const lot of lots) {
      // Leave the odd lot empty: courtyards, yards, a car park.
      if (rnd() < (use === USE.WATERFRONT ? 0.34 : 0.14)) continue;
      const b = makeBuilding(lot, rnd);
      if (b) list.push(b);
    }
  } else if (use === USE.PLAZA) {
    list.push(landmark());
  }

  blockCache.set(key, list);
  return list;
}

/** Iterate every block in the city. */
export function forEachBlock(fn) {
  for (let bj = BLOCK.minJ; bj <= BLOCK.maxJ; bj++) {
    for (let bi = BLOCK.minI; bi <= BLOCK.maxI; bi++) fn(bi, bj);
  }
}

// ---------------------------------------------------------------------------
// Piers
// ---------------------------------------------------------------------------

/** Timber decks reaching out into the bay, walkable and lit at night. */
export const PIERS = [-520, -234, 96, 404].map((x, i) => ({
  x,
  z0: CITY.shore - 2,
  z1: CITY.shore + (i % 2 === 0 ? 76 : 50),
  half: i % 2 === 0 ? 11 : 8,
  /** Absolute deck height — the piers stand over the sea, not over the plain. */
  deck: 3.6,
}));

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

/**
 * Height of the top of whatever built structure covers (x,z), or -Infinity for
 * open ground. This is the surface the player walks on and the hoverboard
 * hovers over, so roofs, setbacks and piers are all real places to stand.
 */
export function solidHeightAt(x, z) {
  let best = -Infinity;

  for (const pier of PIERS) {
    if (z >= pier.z0 && z <= pier.z1 && Math.abs(x - pier.x) <= pier.half) {
      if (pier.deck > best) best = pier.deck;
    }
  }

  if (x <= CITY_BOUNDS.minX || x >= CITY_BOUNDS.maxX
    || z <= CITY_BOUNDS.minZ || z >= CITY_BOUNDS.maxZ) return best;

  const block = blockIndexAt(x, z);
  if (!block) return best;

  const ground = plainHeightAt(x, z);
  for (const b of buildingsInBlock(block.bi, block.bj)) {
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
    for (let i = b.tiers.length - 1; i >= 0; i--) {
      const t = b.tiers[i];
      if (x >= t.x0 && x <= t.x1 && z >= t.z0 && z <= t.z1) {
        const y = ground + t.top;
        if (y > best) best = y;
        break;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Named places, for the wrist panel
// ---------------------------------------------------------------------------

const PLACES = [
  { name: 'The Spire', x: avenueX(2) + 52, z: streetZ(0) + 34, r: 80, exact: true },
  { name: 'The Pass', x: -428, z: 540, r: 210, exact: true },
  { name: 'Downtown', x: CITY.x, z: CITY.z, r: 230 },
  { name: 'Waterfront' },
  { name: 'Midtown', x: CITY.x, z: CITY.z, r: 520 },
  { name: 'Outskirts', x: CITY.x, z: CITY.z, r: 620 },
];

/** Rough place name for a position — used by the wrist readout. */
export function placeAt(x, z) {
  // The valley names itself; only the pass and the city get labels.
  if (z < 420) return null;
  const zone = zoneAt(x, z);
  if (zone.kind === ZONE.PARK && Math.abs(x - CITY.x) < 130 && Math.abs(z - CITY.z) < 110) {
    return 'Central Park';
  }
  for (const p of PLACES) {
    if (p.exact && Math.hypot(x - p.x, z - p.z) < p.r) return p.name;
  }
  for (const p of PLACES) {
    if (p.exact) continue;
    if (p.name === 'Waterfront') {
      if (z > CITY.z + 130 && Math.abs(x - CITY.x) < 820) return p.name;
      continue;
    }
    if (Math.hypot((x - p.x) * 0.62, z - p.z) < p.r) return p.name;
  }
  return null;
}

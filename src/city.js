/**
 * The city, as geometry.
 *
 * src/citymap.js decides where everything goes; this turns that plan into
 * meshes. The guiding constraint is the Quest's draw call budget, so:
 *
 *   - every man-made surface shares one atlas material (see materials.js), and
 *     the buildings are merged into one mesh per 128 m cell — a couple of dozen
 *     draw calls for the whole downtown, and they frustum-cull properly;
 *   - roads, pavements, lots and the promenade merge into a second mesh;
 *   - street lamps, trees, cars and air traffic are instanced;
 *   - nothing here is lit by a real light. Windows, lamps and headlights are an
 *     emissive map and an additive overlay that fade up as the sun goes down,
 *     which is why a night skyline costs the same as a day one.
 *
 * The city is also solid: `solidHeightAt` is the top of whatever structure
 * covers a point, so roofs and piers are places you can stand, and the
 * hoverboard has something to bump into.
 */

import * as THREE from 'three';
import {
  CITY, ZONE, USE, STYLE, PIERS, ROAD_PATH, ROAD_SHELF,
  avenueX, streetZ, avenueHalfWidth, streetHalfWidth, isMainAvenue,
  blockRect, blockUse, buildingsInBlock, forEachBlock, plainHeightAt,
  avenueSuppressed, streetSuppressed, avenueExtent, streetExtent,
  zoneAt, solidHeightAt, placeAt,
} from './citymap.js';
import { heightAt } from './world.js';
import { TILE, TILE_WINDOWS, tileAtlas, makeCar, makeCarLights, makeStreetLamp, makeLampGlow, makeAirTaxi, makeBeacon } from './assets.js';
import { makeBirchTrunk, makeCanopy } from './assets.js';
import { mulberry32, clamp, lerp, smoothstep } from './noise.js';

const BAY = 3.6;                 // metres of facade per window bay
const CELL = 128;                // buildings are merged per cell, for culling
const LAMP_HEIGHT = 7.4;
const LAMP_REACH = 1.5;

/** World size of one repeat of each tile, in metres. */
const REPEAT = {
  [TILE.ROOF]: 12,
  [TILE.CONCRETE]: 6,
  [TILE.PAVEMENT]: 4,
  [TILE.PLAZA]: 8,
  [TILE.PATH]: 3.2,
  [TILE.DECK]: 3.2,
};

const STYLE_TILE = {
  [STYLE.GLASS]: TILE.GLASS,
  [STYLE.BRONZE]: TILE.BRONZE,
  [STYLE.OFFICE]: TILE.OFFICE,
  [STYLE.BRICK]: TILE.BRICK,
  [STYLE.DECO]: TILE.DECO,
  [STYLE.SHED]: TILE.SHED,
};

const STYLE_TINT = {
  [STYLE.GLASS]: [0.94, 1.00, 1.06],
  [STYLE.BRONZE]: [1.06, 0.98, 0.88],
  [STYLE.OFFICE]: [1.00, 0.99, 0.96],
  [STYLE.BRICK]: [1.02, 0.96, 0.92],
  [STYLE.DECO]: [1.03, 1.00, 0.94],
  [STYLE.SHED]: [0.96, 0.98, 1.00],
};

// ---------------------------------------------------------------------------
// Geometry accumulator
// ---------------------------------------------------------------------------

/**
 * Collects quads into flat arrays and hands back one BufferGeometry. Normals
 * are per-face (everything here is a flat panel), and every vertex carries the
 * atlas rectangle its tile lives in.
 */
class SurfaceBuilder {
  constructor() {
    this.p = [];
    this.n = [];
    this.c = [];
    this.uv = [];
    this.a = [];
    this.i = [];
  }

  get empty() {
    return this.p.length === 0;
  }

  /**
   * One quad. Corners run anticlockwise seen from the front face, starting at
   * the bottom-left. `uvs` is [u0,v0, u1,v1, u2,v2, u3,v3] in tile repeats.
   */
  quad(corners, uvs, tile, colors) {
    const [x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3] = corners;
    const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
    const bx = x3 - x0, by = y3 - y0, bz = z3 - z0;
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    const base = this.p.length / 3;
    const rect = tileAtlas(tile);
    for (let v = 0; v < 4; v++) {
      this.p.push(corners[v * 3], corners[v * 3 + 1], corners[v * 3 + 2]);
      this.n.push(nx, ny, nz);
      this.uv.push(uvs[v * 2], uvs[v * 2 + 1]);
      this.a.push(rect[0], rect[1], rect[2], rect[3]);
      const o = (colors.length === 3 ? 0 : v * 3);
      this.c.push(colors[o], colors[o + 1], colors[o + 2]);
    }
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Upward-facing rectangle at height y. */
  deck(x0, z0, x1, z1, y, tile, color, repeat = REPEAT[tile] || 4, heightFn = null) {
    const h = (x, z) => (heightFn ? heightFn(x, z) : y);
    this.quad([
      x0, h(x0, z1), z1,
      x1, h(x1, z1), z1,
      x1, h(x1, z0), z0,
      x0, h(x0, z0), z0,
    ], [
      x0 / repeat, z1 / repeat,
      x1 / repeat, z1 / repeat,
      x1 / repeat, z0 / repeat,
      x0 / repeat, z0 / repeat,
    ], tile, color);
  }

  /**
   * A vertical panel running from A to B, with its own height at each end so it
   * can follow sloping ground. The front face is on the left of A→B.
   */
  face(ax, az, bx, bz, yA0, yA1, yB0, yB1, tile, uOrigin, repeatU, repeatV, low, high, vBase = 0) {
    const length = Math.hypot(bx - ax, bz - az);
    const u0 = uOrigin;
    const u1 = uOrigin + length / repeatU;
    // v is measured from vBase, not from world zero, so a building's window
    // rows and its shopfront band line up with its own ground floor.
    const v = (y) => (y - vBase) / repeatV;

    this.quad([
      ax, yA0, az,
      bx, yB0, bz,
      bx, yB1, bz,
      ax, yA1, az,
    ], [
      u0, v(yA0), u1, v(yB0),
      u1, v(yB1), u0, v(yA1),
    ], tile, [
      low[0], low[1], low[2],
      low[0], low[1], low[2],
      high[0], high[1], high[2],
      high[0], high[1], high[2],
    ]);
  }

  /**
   * One side of an axis-aligned rectangle, facing outwards.
   * `side` is 0 north (-Z), 1 east, 2 south, 3 west; `inward` flips it so a
   * parapet can be seen from the roof as well as from the street.
   */
  wall(x0, z0, x1, z1, side, yBottom, yTop, tile, uOrigin, repeatU, repeatV, low, high, inward = false, vBase = 0) {
    let ax, az, bx, bz;
    if (side === 0) { ax = x1; az = z0; bx = x0; bz = z0; }
    else if (side === 1) { ax = x1; az = z1; bx = x1; bz = z0; }
    else if (side === 2) { ax = x0; az = z1; bx = x1; bz = z1; }
    else { ax = x0; az = z0; bx = x0; bz = z1; }
    if (inward) {
      const tx = ax, tz = az;
      ax = bx; az = bz; bx = tx; bz = tz;
    }
    this.face(ax, az, bx, bz, yBottom, yTop, yBottom, yTop, tile, uOrigin, repeatU, repeatV, low, high, vBase);
  }

  /** A closed box — used for plant rooms, parapets, pilings and masts. */
  box(x0, y0, z0, x1, y1, z1, tile, color, repeat = REPEAT[tile] || 4) {
    for (let side = 0; side < 4; side++) {
      this.wall(x0, z0, x1, z1, side, y0, y1, tile, 0, repeat, repeat, color, color);
    }
    this.deck(x0, z0, x1, z1, y1, tile, color, repeat);
  }

  build() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geometry.setAttribute('aAtlas', new THREE.Float32BufferAttribute(this.a, 4));
    geometry.setIndex(this.i);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

const _tint = [0, 0, 0];
const _low = [0, 0, 0];

function shade(tint, factor, out) {
  out[0] = tint[0] * factor;
  out[1] = tint[1] * factor;
  out[2] = tint[2] * factor;
  return out;
}

/**
 * One building: stacked tiers of walls with a glazed base, a roof and a
 * parapet, plus whatever machinery ended up on top.
 */
function addBuilding(B, b, beacons) {
  const rnd = mulberry32(b.seed);
  const ground = plainHeightAt(b.cx, b.cz);
  // Buildings are level, the plain is not — start the walls below grade so the
  // downhill corner never lifts off the pavement.
  const foot = ground - 1.6;

  const tile = STYLE_TILE[b.style];
  const base = STYLE_TINT[b.style];
  const variation = 0.90 + rnd() * 0.20;
  const tint = shade(base, variation, _tint);
  const repeatU = BAY * TILE_WINDOWS;
  const repeatV = b.floorHeight * TILE_WINDOWS;

  // Street canyons are dark at the bottom. Baking that into the vertex colours
  // is free and does more for the look of a street than any light could.
  const wallColor = (y) => shade(tint, lerp(0.62, 1.0, smoothstep(0, 16, y - ground)), _low);

  const podium = b.style === STYLE.SHED || b.top < 13 ? 0 : Math.min(5.4, b.top * 0.34);
  const uOrigin = ((rnd() * TILE_WINDOWS) | 0) / TILE_WINDOWS;

  for (let t = 0; t < b.tiers.length; t++) {
    const tier = b.tiers[t];
    const y0 = t === 0 ? foot : ground + tier.base;
    const y1 = ground + tier.top;

    for (let side = 0; side < 4; side++) {
      if (t === 0 && podium > 0) {
        const pTop = ground + podium;
        B.wall(tier.x0, tier.z0, tier.x1, tier.z1, side, foot, pTop, TILE.PODIUM,
          uOrigin, 21.6, podium, shade(tint, 0.9, _low), [tint[0], tint[1], tint[2]],
          false, ground);
        B.wall(tier.x0, tier.z0, tier.x1, tier.z1, side, pTop, y1, tile,
          uOrigin, repeatU, repeatV,
          [...wallColor(pTop)], [...wallColor(y1)], false, pTop);
      } else {
        B.wall(tier.x0, tier.z0, tier.x1, tier.z1, side, y0, y1, tile,
          uOrigin, repeatU, repeatV,
          [...wallColor(y0)], [...wallColor(y1)], false, ground + podium);
      }
    }

    B.deck(tier.x0, tier.z0, tier.x1, tier.z1, y1, TILE.ROOF, tint);
  }

  const top = b.tiers[b.tiers.length - 1];
  const roofY = ground + top.top;

  // Parapet, so a roof you can land on has an edge rather than a drop.
  if (b.top > 18) {
    const p = 0.9;
    const t = 0.34;
    const c = shade(tint, 0.86, _low).slice();
    const cap = roofY + p;
    for (let side = 0; side < 4; side++) {
      B.wall(top.x0, top.z0, top.x1, top.z1, side, roofY, cap, TILE.CONCRETE, 0, 6, 6, c, c);
      B.wall(top.x0 + t, top.z0 + t, top.x1 - t, top.z1 - t,
        side, roofY, cap, TILE.CONCRETE, 0, 6, 6, c, c, true);
    }
    B.deck(top.x0, top.z0, top.x1, top.z0 + t, cap, TILE.CONCRETE, c);
    B.deck(top.x0, top.z1 - t, top.x1, top.z1, cap, TILE.CONCRETE, c);
    B.deck(top.x0, top.z0 + t, top.x0 + t, top.z1 - t, cap, TILE.CONCRETE, c);
    B.deck(top.x1 - t, top.z0 + t, top.x1, top.z1 - t, cap, TILE.CONCRETE, c);
  }

  // Rooftop machinery.
  for (let i = 0; i < b.plant; i++) {
    const w = Math.min(6, (top.x1 - top.x0) * (0.16 + rnd() * 0.22));
    const d = Math.min(6, (top.z1 - top.z0) * (0.16 + rnd() * 0.22));
    if (w < 1.2 || d < 1.2) break;
    const cx = lerp(top.x0 + w, top.x1 - w, rnd());
    const cz = lerp(top.z0 + d, top.z1 - d, rnd());
    const h = 1.4 + rnd() * 2.6;
    B.box(cx - w / 2, roofY, cz - d / 2, cx + w / 2, roofY + h, cz + d / 2,
      TILE.CONCRETE, shade(tint, 0.8, _low).slice());
  }

  if (b.mast > 0) {
    const r = b.landmark ? 1.1 : 0.28;
    B.box(b.cx - r, roofY, b.cz - r, b.cx + r, roofY + b.mast, b.cz + r,
      TILE.CONCRETE, shade(tint, 0.7, _low).slice(), 3);
    beacons.push({ x: b.cx, y: roofY + b.mast + 1.0, z: b.cz, phase: rnd() * Math.PI * 2 });
  } else if (b.top > 70) {
    beacons.push({ x: b.cx, y: roofY + 1.4, z: b.cz, phase: rnd() * Math.PI * 2 });
  }
}

// ---------------------------------------------------------------------------
// Ground surfaces
// ---------------------------------------------------------------------------

const PAVE_COLOR = [1, 1, 1];
const ROAD_COLOR = [1, 1, 1];
const LOT_COLOR = [0.94, 0.93, 0.9];

/** Which spans of an avenue actually exist (the park swallows the middle). */
function avenueSpans(k) {
  const [z0, z1] = avenueExtent();
  if (!avenueSuppressed(k, CITY.z)) return [[z0, z1]];
  return [[z0, streetZ(-1)], [streetZ(1), z1]];
}

function streetSpans(m) {
  const [x0, x1] = streetExtent();
  if (!streetSuppressed(m, CITY.x)) return [[x0, x1]];
  return [[x0, avenueX(-1)], [avenueX(1), x1]];
}

function addRoads(B) {
  const ground = (x, z) => plainHeightAt(x, z) + 0.03;

  for (let k = -CITY.avenueMax; k <= CITY.avenueMax; k++) {
    const cx = avenueX(k);
    const hw = avenueHalfWidth(k);
    const tile = isMainAvenue(k) ? TILE.ROAD_AVENUE : TILE.ROAD_STREET;
    for (const [za, zb] of avenueSpans(k)) {
      const steps = Math.max(1, Math.round((zb - za) / 24));
      for (let s = 0; s < steps; s++) {
        const z0 = lerp(za, zb, s / steps);
        const z1 = lerp(za, zb, (s + 1) / steps);
        B.quad([
          cx - hw, ground(cx - hw, z1), z1,
          cx + hw, ground(cx + hw, z1), z1,
          cx + hw, ground(cx + hw, z0), z0,
          cx - hw, ground(cx - hw, z0), z0,
        ], [0, z1 / 14, 1, z1 / 14, 1, z0 / 14, 0, z0 / 14], tile, ROAD_COLOR);
      }
    }
  }

  for (let m = -CITY.streetMax; m <= CITY.streetMax; m++) {
    const cz = streetZ(m);
    const hw = streetHalfWidth(m);
    const tile = m === 0 ? TILE.ROAD_AVENUE : TILE.ROAD_STREET;
    for (const [xa, xb] of streetSpans(m)) {
      const steps = Math.max(1, Math.round((xb - xa) / 24));
      for (let s = 0; s < steps; s++) {
        const x0 = lerp(xa, xb, s / steps);
        const x1 = lerp(xa, xb, (s + 1) / steps);
        // Streets sit a hair lower so avenues win cleanly at the junctions.
        const y = (x, z) => plainHeightAt(x, z) + 0.015;
        B.quad([
          x0, y(x0, cz + hw), cz + hw,
          x1, y(x1, cz + hw), cz + hw,
          x1, y(x1, cz - hw), cz - hw,
          x0, y(x0, cz - hw), cz - hw,
        ], [1, x0 / 14, 1, x1 / 14, 0, x1 / 14, 0, x0 / 14], tile, ROAD_COLOR);
      }
    }
  }
}

function addBlockSurfaces(B, bi, bj) {
  const use = blockUse(bi, bj);
  // Park blocks reach right up to the grid line where the road was skipped.
  const rect = blockRect(bi, bj);
  const s = CITY.sidewalk;
  const kerb = CITY.curb;
  const ground = (x, z) => plainHeightAt(x, z);

  // Pavement ring — but only on the sides that face a road that was actually
  // built, so the central park does not end up with a paved cross through it.
  const midX = (rect.x0 + rect.x1) / 2;
  const midZ = (rect.z0 + rect.z1) / 2;
  const sides = [
    { on: !streetSuppressed(bj, midX), strip: [rect.x0 - s, rect.z0 - s, rect.x1 + s, rect.z0],
      edge: [rect.x1 + s, rect.z0 - s, rect.x0 - s, rect.z0 - s] },
    { on: !streetSuppressed(bj + 1, midX), strip: [rect.x0 - s, rect.z1, rect.x1 + s, rect.z1 + s],
      edge: [rect.x0 - s, rect.z1 + s, rect.x1 + s, rect.z1 + s] },
    { on: !avenueSuppressed(bi, midZ), strip: [rect.x0 - s, rect.z0, rect.x0, rect.z1],
      edge: [rect.x0 - s, rect.z0 - s, rect.x0 - s, rect.z1 + s] },
    { on: !avenueSuppressed(bi + 1, midZ), strip: [rect.x1, rect.z0, rect.x1 + s, rect.z1],
      edge: [rect.x1 + s, rect.z1 + s, rect.x1 + s, rect.z0 - s] },
  ];
  const kerbLow = [0.78, 0.78, 0.76];
  const kerbHigh = [0.96, 0.96, 0.93];
  for (const side of sides) {
    if (!side.on) continue;
    const [px0, pz0, px1, pz1] = side.strip;
    B.deck(px0, pz0, px1, pz1, 0, TILE.PAVEMENT, PAVE_COLOR, REPEAT[TILE.PAVEMENT],
      (x, z) => ground(x, z) + kerb);
    const [ax, az, bx, bz] = side.edge;
    const ya = ground(ax, az);
    const yb = ground(bx, bz);
    B.face(ax, az, bx, bz, ya - 0.3, ya + kerb, yb - 0.3, yb + kerb,
      TILE.CONCRETE, 0, 4, 1.2, kerbLow, kerbHigh);
  }

  if (use === USE.PARK) {
    // Two gravel walks crossing the green, and nothing else — the trees come
    // from the scatter system, same as the forest in the valley.
    const mx = (rect.x0 + rect.x1) / 2;
    const mz = (rect.z0 + rect.z1) / 2;
    B.deck(rect.x0, mz - 1.6, rect.x1, mz + 1.6, 0, TILE.PATH, PAVE_COLOR,
      REPEAT[TILE.PATH], (x, z) => ground(x, z) + 0.04);
    B.deck(mx - 1.6, rect.z0, mx + 1.6, rect.z1, 0, TILE.PATH, PAVE_COLOR,
      REPEAT[TILE.PATH], (x, z) => ground(x, z) + 0.04);
    return;
  }

  const tile = use === USE.PLAZA ? TILE.PLAZA : TILE.PAVEMENT;
  const color = use === USE.PLAZA ? PAVE_COLOR : LOT_COLOR;
  // Split the lot so it follows the grade instead of cutting through it.
  const nx = Math.max(1, Math.round(rect.w / 24));
  const nz = Math.max(1, Math.round(rect.d / 24));
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      B.deck(
        lerp(rect.x0, rect.x1, i / nx), lerp(rect.z0, rect.z1, j / nz),
        lerp(rect.x0, rect.x1, (i + 1) / nx), lerp(rect.z0, rect.z1, (j + 1) / nz),
        0, tile, color, REPEAT[tile], (x, z) => ground(x, z) + 0.05,
      );
    }
  }
}

/** The promenade along the head of the bay, and the piers off it. */
function addWaterfront(B) {
  const z0 = streetZ(CITY.streetMax) + streetHalfWidth(CITY.streetMax) + CITY.sidewalk;
  const z1 = CITY.shore;
  const [x0, x1] = streetExtent();
  const steps = Math.round((x1 - x0) / 26);
  for (let s = 0; s < steps; s++) {
    B.deck(
      lerp(x0, x1, s / steps), z0, lerp(x0, x1, (s + 1) / steps), z1,
      0, TILE.PLAZA, PAVE_COLOR, REPEAT[TILE.PLAZA],
      (x, z) => plainHeightAt(x, z) + 0.05,
    );
  }
  // Sea wall.
  for (let s = 0; s < steps; s++) {
    const a = lerp(x0, x1, s / steps);
    const b = lerp(x0, x1, (s + 1) / steps);
    const y = plainHeightAt((a + b) / 2, z1);
    B.wall(a, z1, b, z1 + 0.6, 2, y - 3.5, y + 0.55, TILE.CONCRETE, 0, 6, 6,
      [0.62, 0.62, 0.6], [0.92, 0.92, 0.9]);
  }

  for (const pier of PIERS) {
    const deckY = pier.deck;
    const segments = Math.round((pier.z1 - pier.z0) / 12);
    for (let s = 0; s < segments; s++) {
      B.deck(pier.x - pier.half, lerp(pier.z0, pier.z1, s / segments),
        pier.x + pier.half, lerp(pier.z0, pier.z1, (s + 1) / segments),
        deckY, TILE.DECK, PAVE_COLOR);
    }
    // Fascia and pilings.
    for (const side of [0, 1, 2, 3]) {
      B.wall(pier.x - pier.half, pier.z0, pier.x + pier.half, pier.z1, side,
        deckY - 0.55, deckY, TILE.DECK, 0, 3.2, 3.2, [0.7, 0.7, 0.7], [0.95, 0.95, 0.95]);
    }
    for (let s = 0; s <= segments; s++) {
      const z = lerp(pier.z0, pier.z1, s / segments);
      for (const x of [pier.x - pier.half + 0.7, pier.x + pier.half - 0.7]) {
        B.box(x - 0.24, deckY - 7, z - 0.24, x + 0.24, deckY - 0.5, z + 0.24,
          TILE.DECK, [0.66, 0.62, 0.6], 3.2);
      }
    }
  }
}

/**
 * The road out of the valley, laid on the terrain it was graded into.
 *
 * Each cross-section is offset along the *averaged* tangent at its own path
 * point rather than along the segment it starts. Per-segment normals leave a
 * wedge of bare ground showing through on the outside of every bend.
 */
function addHighway(B) {
  const half = ROAD_SHELF * 0.62;
  const rows = [];
  let arc = 0;

  for (let i = 0; i < ROAD_PATH.length; i++) {
    const p = ROAD_PATH[i];
    const prev = ROAD_PATH[Math.max(0, i - 1)];
    const next = ROAD_PATH[Math.min(ROAD_PATH.length - 1, i + 1)];
    let tx = next[0] - prev[0];
    let tz = next[1] - prev[1];
    const t = Math.hypot(tx, tz) || 1;
    tx /= t; tz /= t;
    const nx = -tz, nz = tx;

    if (i > 0) arc += Math.hypot(p[0] - prev[0], p[1] - prev[1]);

    const edge = (side) => {
      const x = p[0] + nx * half * side;
      const z = p[1] + nz * half * side;
      return [x, heightAt(x, z) + 0.04, z];
    };
    rows.push({ left: edge(-1), right: edge(1), v: arc / 14 });
  }

  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    B.quad([
      ...a.left, ...a.right, ...b.right, ...b.left,
    ], [0, a.v, 1, a.v, 1, b.v, 0, b.v], TILE.ROAD_STREET, ROAD_COLOR);
  }
}

// ---------------------------------------------------------------------------
// Street furniture
// ---------------------------------------------------------------------------

/** Every point on a pavement where a lamp or a tree should stand. */
function furniturePoints() {
  const lamps = [];
  const trees = [];
  const push = (x, z, yaw, index) => {
    if (zoneAt(x, z).kind !== ZONE.PAVEMENT) return;
    (index % 2 === 0 ? lamps : trees).push({ x, z, yaw });
  };

  for (let k = -CITY.avenueMax; k <= CITY.avenueMax; k++) {
    const cx = avenueX(k);
    const off = avenueHalfWidth(k) + CITY.sidewalk * 0.55;
    const [z0, z1] = avenueExtent();
    let index = 0;
    for (let z = z0; z <= z1; z += 17) {
      push(cx - off, z, 0, index);
      push(cx + off, z, Math.PI, index + 1);
      index++;
    }
  }

  for (let m = -CITY.streetMax; m <= CITY.streetMax; m++) {
    const cz = streetZ(m);
    const off = streetHalfWidth(m) + CITY.sidewalk * 0.55;
    const [x0, x1] = streetExtent();
    let index = 1;
    for (let x = x0; x <= x1; x += 19) {
      push(x, cz - off, Math.PI / 2, index);
      push(x, cz + off, -Math.PI / 2, index + 1);
      index++;
    }
  }

  // A run of lamps up the highway, so the way out of the valley is visible
  // from the south shore after dark.
  for (let i = 6; i < ROAD_PATH.length - 2; i += 5) {
    const p = ROAD_PATH[i];
    const q = ROAD_PATH[i + 1];
    const tx = q[0] - p[0], tz = q[1] - p[1];
    const len = Math.hypot(tx, tz) || 1;
    const nx = -tz / len, nz = tx / len;
    const d = ROAD_SHELF * 0.78;
    lamps.push({ x: p[0] + nx * d, z: p[1] + nz * d, yaw: Math.atan2(-nx, -nz) + Math.PI / 2, terrain: true });
  }

  return { lamps, trees };
}

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

/** One driving lane: a straight run with a direction and a speed limit. */
function buildLanes() {
  const lanes = [];
  const add = (x0, z0, x1, z1, limit) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 40) return;
    lanes.push({
      x0, z0, len, limit,
      dx: (x1 - x0) / len, dz: (z1 - z0) / len,
      yaw: Math.atan2(x0 - x1, z0 - z1),
    });
  };

  for (let k = -CITY.avenueMax; k <= CITY.avenueMax; k++) {
    const cx = avenueX(k);
    const off = avenueHalfWidth(k) * 0.5;
    const limit = isMainAvenue(k) ? 15 : 11;
    for (const [za, zb] of avenueSpans(k)) {
      add(cx - off, zb, cx - off, za, limit);
      add(cx + off, za, cx + off, zb, limit);
    }
  }
  for (let m = -CITY.streetMax; m <= CITY.streetMax; m++) {
    const cz = streetZ(m);
    const off = streetHalfWidth(m) * 0.5;
    for (const [xa, xb] of streetSpans(m)) {
      add(xa, cz + off, xb, cz + off, 12);
      add(xb, cz - off, xa, cz - off, 12);
    }
  }
  return lanes;
}

// ---------------------------------------------------------------------------

export class City {
  /**
   * @param {THREE.Scene} scene
   * @param {object} textures from createTextures()
   * @param {object} materials the world materials, reused for street trees
   * @param {object} cityMaterials from createCityMaterials()
   * @param {object} quality one of the QUALITY presets
   */
  constructor(scene, textures, materials, cityMaterials, quality) {
    this.scene = scene;
    this.textures = textures;
    this.materials = materials;
    this.mats = cityMaterials;
    this.quality = quality;

    this.group = new THREE.Group();
    this.group.name = 'city';
    scene.add(this.group);

    this.beacons = [];
    this.cars = [];
    this.lanes = buildLanes();
    this.taxis = [];
    this._night = 0;
    this.triangles = 0;
  }

  /** Everything from here on is on the loading screen's clock. */
  async build(onProgress, nextFrame) {
    await this.buildBuildings(onProgress, nextFrame);
    onProgress(0.45, 'Laying the streets…');
    await nextFrame();
    this.buildGround();
    onProgress(0.72, 'Putting the lights up…');
    await nextFrame();
    this.buildFurniture();
    onProgress(0.88, 'Letting the traffic out…');
    await nextFrame();
    this.buildTraffic();
    this.buildBeacons();
    onProgress(1, 'City ready');
  }

  async buildBuildings(onProgress, nextFrame) {
    const cells = new Map();
    const key = (cx, cz) => cx * 4096 + cz;

    forEachBlock((bi, bj) => {
      for (const b of buildingsInBlock(bi, bj)) {
        const cx = Math.floor(b.cx / CELL);
        const cz = Math.floor(b.cz / CELL);
        const k = key(cx, cz);
        let list = cells.get(k);
        if (!list) cells.set(k, (list = []));
        list.push(b);
      }
    });

    let done = 0;
    for (const list of cells.values()) {
      const B = new SurfaceBuilder();
      for (const b of list) addBuilding(B, b, this.beacons);
      const mesh = new THREE.Mesh(B.build(), this.mats.surface);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.triangles += B.i.length / 3;
      this.group.add(mesh);

      done++;
      if (done % 6 === 0) {
        onProgress(0.05 + 0.38 * (done / cells.size), `Raising the towers… ${done}/${cells.size}`);
        await nextFrame();
      }
    }
  }

  buildGround() {
    const B = new SurfaceBuilder();
    addRoads(B);
    forEachBlock((bi, bj) => addBlockSurfaces(B, bi, bj));
    addWaterfront(B);
    addHighway(B);

    const mesh = new THREE.Mesh(B.build(), this.mats.ground);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.renderOrder = 1;
    this.triangles += B.i.length / 3;
    this.ground = mesh;
    this.group.add(mesh);
  }

  buildFurniture() {
    const { lamps, trees } = furniturePoints();
    const density = this.quality.scatterDensity;
    const lampList = lamps;
    const treeList = trees.filter((_, i) => (i % 4) / 4 < density);

    const surfaceY = (p) => (p.terrain ? heightAt(p.x, p.z) : plainHeightAt(p.x, p.z) + CITY.curb);

    const lampGeo = makeStreetLamp(LAMP_HEIGHT, LAMP_REACH);
    const glowGeo = makeLampGlow(LAMP_HEIGHT, LAMP_REACH);
    this.lampMesh = new THREE.InstancedMesh(lampGeo, this.mats.prop, lampList.length);
    this.lampGlow = new THREE.InstancedMesh(glowGeo, this.mats.glow, lampList.length);
    this.lampGlow.renderOrder = 6;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    lampList.forEach((p, i) => {
      pos.set(p.x, surfaceY(p), p.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);
      m.compose(pos, q, one);
      this.lampMesh.setMatrixAt(i, m);
      this.lampGlow.setMatrixAt(i, m);
    });
    this.group.add(this.lampMesh, this.lampGlow);

    // Street trees reuse the valley's birches, so the city is planted with the
    // same species as the forest it sits below.
    const trunk = makeBirchTrunk(41);
    const canopy = makeCanopy(41, 5);
    this.treeTrunks = new THREE.InstancedMesh(trunk, this.materials.solid, Math.max(1, treeList.length));
    this.treeCanopy = new THREE.InstancedMesh(canopy, this.materials.foliage, Math.max(1, treeList.length));
    const rnd = mulberry32(9911);
    treeList.forEach((p, i) => {
      const scale = 6.5 + rnd() * 3.2;
      pos.set(p.x, surfaceY(p) - 0.1, p.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      m.compose(pos, q, new THREE.Vector3(scale, scale, scale));
      this.treeTrunks.setMatrixAt(i, m);
      this.treeCanopy.setMatrixAt(i, m);
    });
    this.treeTrunks.count = treeList.length;
    this.treeCanopy.count = treeList.length;
    this.group.add(this.treeTrunks, this.treeCanopy);
  }

  buildTraffic() {
    const count = Math.round(190 * this.quality.scatterDensity);
    const body = makeCar(7);
    const lights = makeCarLights();
    this.carMesh = new THREE.InstancedMesh(body, this.mats.prop, count);
    this.carLights = new THREE.InstancedMesh(lights, this.mats.glow, count);
    this.carLights.renderOrder = 6;
    this.carMesh.frustumCulled = false;
    this.carLights.frustumCulled = false;

    const rnd = mulberry32(3141);
    const palette = [
      0xd8dade, 0x2b3038, 0x8a929c, 0xa03028, 0x1f4a70, 0x25603f,
      0xd6b23a, 0xe8e4dc, 0x5a3f6a, 0x30363c,
    ];
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const lane = this.lanes[(rnd() * this.lanes.length) | 0];
      this.cars.push({
        lane,
        s: rnd() * lane.len,
        speed: lane.limit * (0.72 + rnd() * 0.5),
      });
      color.setHex(palette[(rnd() * palette.length) | 0]);
      this.carMesh.setColorAt(i, color);
    }
    if (this.carMesh.instanceColor) this.carMesh.instanceColor.needsUpdate = true;
    this.group.add(this.carMesh, this.carLights);

    // Air traffic: a handful of shuttles on long circuits over the grid.
    const taxiCount = Math.max(3, Math.round(9 * this.quality.particles));
    this.taxiMesh = new THREE.InstancedMesh(makeAirTaxi(4), this.mats.prop, taxiCount);
    this.taxiMesh.frustumCulled = false;
    for (let i = 0; i < taxiCount; i++) {
      this.taxis.push({
        cx: CITY.x + (rnd() - 0.5) * 900,
        cz: CITY.z + (rnd() - 0.5) * 320,
        rx: 180 + rnd() * 420,
        rz: 90 + rnd() * 190,
        y: 118 + rnd() * 96,
        speed: (rnd() < 0.5 ? -1 : 1) * (0.045 + rnd() * 0.05),
        phase: rnd() * Math.PI * 2,
      });
    }
    this.group.add(this.taxiMesh);
  }

  buildBeacons() {
    const count = this.beacons.length + this.taxis.length;
    this.beaconMesh = new THREE.InstancedMesh(makeBeacon(0.9), this.mats.glow, Math.max(1, count));
    this.beaconMesh.frustumCulled = false;
    this.beaconMesh.renderOrder = 6;
    this.group.add(this.beaconMesh);
    this._beaconMatrix = new THREE.Matrix4();
    this._beaconPos = new THREE.Vector3();
    this._beaconScale = new THREE.Vector3();
    this._identity = new THREE.Quaternion();
  }

  // --- runtime -------------------------------------------------------------

  /**
   * @param {number} dt seconds
   * @param {number} elapsed seconds since start
   * @param {THREE.Vector3} head viewer position
   * @param {number} daylight 0..1 from the sky
   */
  update(dt, elapsed, head, daylight, ambient) {
    const night = clamp(1 - daylight * 1.5, 0, 1);
    this._night = night;
    this.mats.setNight(night, ambient);

    this.updateCars(dt, head);
    this.updateTaxis(elapsed);
    this.updateBeacons(elapsed, night);

    if (this.lampGlow) this.lampGlow.visible = night > 0.02;
    if (this.carLights) this.carLights.visible = night > 0.02;
    if (this.beaconMesh) this.beaconMesh.visible = night > 0.02;
  }

  updateCars(dt, head) {
    if (!this.carMesh) return;
    const m = _m4;
    const q = _quat;
    const pos = _v3;
    const scale = _v3b.set(1, 1, 1);
    const far = 460;

    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      car.s += car.speed * dt;
      let x = car.lane.x0 + car.lane.dx * car.s;
      let z = car.lane.z0 + car.lane.dz * car.s;

      // Recycle anything that has run off the end of its lane, or that has
      // wandered a long way from the viewer, onto a lane nearby. It keeps the
      // traffic where it can be seen without simulating the whole grid.
      if (car.s > car.lane.len || Math.hypot(x - head.x, z - head.z) > far) {
        const lane = this.pickLane(head);
        car.lane = lane;
        car.s = Math.random() * lane.len;
        car.speed = lane.limit * (0.72 + Math.random() * 0.5);
        x = lane.x0 + lane.dx * car.s;
        z = lane.z0 + lane.dz * car.s;
      }

      pos.set(x, plainHeightAt(x, z) + 0.06, z);
      q.setFromAxisAngle(UP, car.lane.yaw);
      m.compose(pos, q, scale);
      this.carMesh.setMatrixAt(i, m);
      this.carLights.setMatrixAt(i, m);
    }
    this.carMesh.instanceMatrix.needsUpdate = true;
    this.carLights.instanceMatrix.needsUpdate = true;
  }

  pickLane(head) {
    let best = this.lanes[0];
    let bestScore = Infinity;
    for (let tries = 0; tries < 8; tries++) {
      const lane = this.lanes[(Math.random() * this.lanes.length) | 0];
      const mx = lane.x0 + lane.dx * lane.len * 0.5;
      const mz = lane.z0 + lane.dz * lane.len * 0.5;
      const d = Math.hypot(mx - head.x, mz - head.z);
      if (d < bestScore) { bestScore = d; best = lane; }
    }
    return best;
  }

  updateTaxis(elapsed) {
    if (!this.taxiMesh) return;
    const m = _m4;
    const q = _quat;
    const pos = _v3;
    const scale = _v3b.set(1, 1, 1);
    for (let i = 0; i < this.taxis.length; i++) {
      const t = this.taxis[i];
      const a = t.phase + elapsed * t.speed;
      const x = t.cx + Math.cos(a) * t.rx;
      const z = t.cz + Math.sin(a) * t.rz;
      const y = t.y + Math.sin(elapsed * 0.23 + t.phase) * 5;
      const dir = Math.sign(t.speed);
      const heading = Math.atan2(Math.sin(a) * t.rx * dir, -Math.cos(a) * t.rz * dir);
      pos.set(x, y, z);
      q.setFromAxisAngle(UP, heading);
      m.compose(pos, q, scale);
      this.taxiMesh.setMatrixAt(i, m);
      t._x = x; t._y = y; t._z = z;
    }
    this.taxiMesh.instanceMatrix.needsUpdate = true;
  }

  updateBeacons(elapsed, night) {
    if (!this.beaconMesh || night <= 0.02) return;
    const m = this._beaconMatrix;
    const pos = this._beaconPos;
    const scale = this._beaconScale;
    let n = 0;

    for (const b of this.beacons) {
      const pulse = 0.35 + 0.65 * Math.pow(Math.abs(Math.sin(elapsed * 1.1 + b.phase)), 6);
      pos.set(b.x, b.y, b.z);
      scale.setScalar(pulse * 1.15);
      m.compose(pos, this._identity, scale);
      this.beaconMesh.setMatrixAt(n++, m);
    }
    for (const t of this.taxis) {
      if (t._x === undefined) continue;
      const pulse = 0.4 + 0.6 * Math.pow(Math.abs(Math.sin(elapsed * 2.4 + t.phase)), 5);
      pos.set(t._x, t._y - 0.8, t._z);
      scale.setScalar(pulse * 0.85);
      m.compose(pos, this._identity, scale);
      this.beaconMesh.setMatrixAt(n++, m);
    }
    this.beaconMesh.count = n;
    this.beaconMesh.instanceMatrix.needsUpdate = true;
  }

  // --- queries -------------------------------------------------------------

  /** Top of any structure covering (x,z), or -Infinity over open ground. */
  solidHeightAt(x, z) {
    return solidHeightAt(x, z);
  }

  /** True if a point is inside a building rather than on top of it. */
  blocked(x, z, y, clearance = 0.4) {
    return solidHeightAt(x, z) > y + clearance;
  }

  placeName(x, z) {
    return placeAt(x, z);
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const _m4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();

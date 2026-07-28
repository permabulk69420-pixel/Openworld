/**
 * Vegetation and rock scattering.
 *
 * The world is divided into cells; each cell deterministically decides what
 * grows in it the first time it is needed, and the result is cached. Whatever
 * is currently in range is packed into a small number of InstancedMeshes, so
 * the entire forest costs a couple of dozen draw calls.
 *
 * Three fields run at once with different cell sizes and ranges: big trees,
 * mid-sized detail (rocks, bushes, reeds) and ground cover.
 */

import * as THREE from 'three';
import { mulberry32, clamp, lerp, smoothstep } from './noise.js';
import {
  WORLD, heightAt, gridHeightAt, moistureAt, biomeAt, BIOME, riverDistanceAt,
  waterSurfaceAt, RIVER_WIDTH,
} from './world.js';
import {
  makePine, makeBirchTrunk, makeCanopy, makeDeadTree, makeStump, makeRock,
  makeGrassClump, makeBush, makeReeds,
} from './assets.js';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Padded height grid over one cell, so placement queries can read heights and
 * slopes from neighbours instead of re-evaluating the height function.
 */
class CellSampler {
  constructor(x0, z0, size, divisions) {
    this.x0 = x0;
    this.z0 = z0;
    this.step = size / divisions;
    this.n = divisions;
    const pad = divisions + 3;
    this.pad = pad;
    this.h = new Float32Array(pad * pad);
    for (let j = -1; j <= divisions + 1; j++) {
      const z = z0 + j * this.step;
      for (let i = -1; i <= divisions + 1; i++) {
        this.h[(j + 1) * pad + (i + 1)] = heightAt(x0 + i * this.step, z);
      }
    }
  }

  raw(i, j) {
    const pad = this.pad;
    const ci = clamp(i + 1, 0, pad - 1);
    const cj = clamp(j + 1, 0, pad - 1);
    return this.h[cj * pad + ci];
  }

  /** Bilinear height at a world position inside (or just outside) the cell. */
  height(x, z) {
    const gx = (x - this.x0) / this.step;
    const gz = (z - this.z0) / this.step;
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    return lerp(
      lerp(this.raw(i, j), this.raw(i + 1, j), fx),
      lerp(this.raw(i, j + 1), this.raw(i + 1, j + 1), fx),
      fz,
    );
  }

  /** Surface normal from the cached grid. */
  normal(x, z, target) {
    const gx = Math.round((x - this.x0) / this.step);
    const gz = Math.round((z - this.z0) / this.step);
    const s = this.step;
    target.set(this.raw(gx - 1, gz) - this.raw(gx + 1, gz), 2 * s, this.raw(gx, gz - 1) - this.raw(gx, gz + 1));
    return target.normalize();
  }
}

/**
 * A set of instanced meshes fed from cached per-cell placements.
 */
class InstanceField {
  /**
   * @param {THREE.Group} parent
   * @param {object} opts { cellSize, radius, defs, generate, capacity }
   */
  constructor(parent, opts) {
    this.cellSize = opts.cellSize;
    this.radius = opts.radius;
    this.generate = opts.generate;
    this.defs = opts.defs;
    this.cache = new Map();
    this.cacheLimit = opts.cacheLimit || 320;
    this.pendingCells = [];
    this.dirty = true;
    this.lastCell = null;
    this.group = new THREE.Group();
    parent.add(this.group);

    const cellsAcross = Math.pow(2 * Math.ceil(this.radius / this.cellSize) + 1, 2);

    for (const def of this.defs) {
      def.meshes = def.parts.map((part) => {
        const capacity = Math.min(opts.capacity, Math.ceil(cellsAcross * (def.perCell || 40)));
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, Math.max(16, capacity));
        mesh.frustumCulled = false;
        mesh.count = 0;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(mesh);
        return mesh;
      });
    }

    if (opts.shadowMaterial) {
      const disc = new THREE.CircleGeometry(1, 10).rotateX(-Math.PI / 2);
      disc.setAttribute('aFlex', new THREE.BufferAttribute(new Float32Array(disc.attributes.position.count), 1));
      this.shadowMesh = new THREE.InstancedMesh(disc, opts.shadowMaterial, opts.shadowCapacity || 1200);
      this.shadowMesh.frustumCulled = false;
      this.shadowMesh.count = 0;
      this.shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.shadowMesh.renderOrder = 1;
      this.group.add(this.shadowMesh);
    }
  }

  cellKey(cx, cz) {
    return cx * 8192 + cz;
  }

  getCell(cx, cz) {
    const key = this.cellKey(cx, cz);
    let cell = this.cache.get(key);
    if (cell) return cell;
    cell = this.generate(cx, cz, this.cellSize);
    this.cache.set(key, cell);
    if (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    return cell;
  }

  /** Cells whose footprint intersects the view radius, nearest first. */
  neededCells(px, pz) {
    const r = Math.ceil(this.radius / this.cellSize);
    const cx0 = Math.floor(px / this.cellSize);
    const cz0 = Math.floor(pz / this.cellSize);
    const out = [];
    const limit = WORLD.half / this.cellSize;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = cx0 + dx, cz = cz0 + dz;
        if (cx < -limit || cz < -limit || cx >= limit || cz >= limit) continue;
        const nx = Math.max(cx * this.cellSize - px, 0, px - (cx + 1) * this.cellSize);
        const nz = Math.max(cz * this.cellSize - pz, 0, pz - (cz + 1) * this.cellSize);
        const d = Math.hypot(nx, nz);
        if (d > this.radius) continue;
        out.push({ cx, cz, d });
      }
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  update(px, pz, budgetMs = 3) {
    const cx = Math.floor(px / this.cellSize);
    const cz = Math.floor(pz / this.cellSize);
    if (!this.lastCell || this.lastCell.cx !== cx || this.lastCell.cz !== cz) {
      this.lastCell = { cx, cz };
      this.pendingCells = this.neededCells(px, pz);
      this.dirty = true;
    }

    // Warm up any cells that have not been generated yet, within budget.
    if (this.pendingCells.length) {
      const start = performance.now();
      while (this.pendingCells.length) {
        const c = this.pendingCells.shift();
        this.getCell(c.cx, c.cz);
        if (performance.now() - start > budgetMs) break;
      }
      if (this.pendingCells.length === 0) this.rebuild(px, pz);
      return;
    }

    if (this.dirty) this.rebuild(px, pz);
  }

  rebuild(px, pz) {
    this.dirty = false;
    const cells = this.neededCells(px, pz);
    const counts = new Array(this.defs.length).fill(0);
    let shadowCount = 0;
    const m = _matrix;

    for (const { cx, cz } of cells) {
      const placements = this.getCell(cx, cz);
      for (let i = 0; i < placements.length; i++) {
        const p = placements[i];
        const def = this.defs[p.def];
        const idx = counts[p.def];
        const capacity = def.meshes[0].instanceMatrix.count;
        if (idx >= capacity) continue;
        m.compose(p.position, p.quaternion, p.scale);
        for (const mesh of def.meshes) mesh.setMatrixAt(idx, m);
        counts[p.def]++;

        if (this.shadowMesh && def.shadow && shadowCount < this.shadowMesh.instanceMatrix.count) {
          const r = def.shadow * p.scale.x;
          _shadowScale.set(r, 1, r);
          _shadowPos.copy(p.position);
          _shadowPos.y += 0.07;
          m.compose(_shadowPos, p.groundQuaternion || p.quaternion, _shadowScale);
          this.shadowMesh.setMatrixAt(shadowCount++, m);
        }
      }
    }

    for (let d = 0; d < this.defs.length; d++) {
      for (const mesh of this.defs[d].meshes) {
        mesh.count = counts[d];
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    if (this.shadowMesh) {
      this.shadowMesh.count = shadowCount;
      this.shadowMesh.instanceMatrix.needsUpdate = true;
    }
  }

  get instanceCount() {
    let n = 0;
    for (const def of this.defs) n += def.meshes[0].count;
    return n;
  }
}

const _matrix = new THREE.Matrix4();
const _shadowScale = new THREE.Vector3();
const _shadowPos = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _blend = new THREE.Vector3();

/** Build a placement record aligned to the ground. */
function place(def, x, y, z, yaw, scale, normal, uprightness) {
  const position = new THREE.Vector3(x, y, z);
  const groundQuaternion = new THREE.Quaternion().setFromUnitVectors(UP, normal);
  _blend.copy(UP).lerp(normal, 1 - uprightness).normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, _blend);
  quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
  return {
    def,
    position,
    quaternion,
    groundQuaternion,
    scale: new THREE.Vector3(scale, scale, scale),
  };
}

// ---------------------------------------------------------------------------

export class Scatter {
  constructor(scene, materials, quality, sampleSpacing) {
    this.group = new THREE.Group();
    this.group.name = 'scatter';
    scene.add(this.group);
    this.quality = quality;
    this.spacing = sampleSpacing;
    const density = quality.scatterDensity;

    // --- definitions -------------------------------------------------------
    const pineGeos = [makePine(11), makePine(22), makePine(33)];
    const treeDefs = [
      ...pineGeos.map((g) => ({ parts: [{ geometry: g, material: materials.solid }], shadow: 0.30, perCell: 22 })),
      {
        parts: [
          { geometry: makeBirchTrunk(41), material: materials.solid },
          { geometry: makeCanopy(41, 5), material: materials.foliage },
        ],
        shadow: 0.32, perCell: 10,
      },
      {
        parts: [
          { geometry: makeBirchTrunk(42), material: materials.solid },
          { geometry: makeCanopy(42, 6), material: materials.foliageAutumn },
        ],
        shadow: 0.32, perCell: 6,
      },
      { parts: [{ geometry: makeDeadTree(51), material: materials.solid }], shadow: 0.16, perCell: 5 },
      { parts: [{ geometry: makeStump(61), material: materials.solid }], shadow: 0.22, perCell: 5 },
    ];
    this.TREE = { PINE_A: 0, PINE_B: 1, PINE_C: 2, BIRCH: 3, BIRCH_AUTUMN: 4, DEAD: 5, STUMP: 6 };

    const detailDefs = [
      { parts: [{ geometry: makeRock(71, 1, '#6f6c64'), material: materials.solid }], shadow: 0.55, perCell: 10 },
      { parts: [{ geometry: makeRock(72, 1, '#63625d'), material: materials.solid }], shadow: 0.55, perCell: 10 },
      { parts: [{ geometry: makeRock(73, 0, '#75726a'), material: materials.solid }], shadow: 0.5, perCell: 16 },
      { parts: [{ geometry: makeRock(74, 0, '#8e8f8c'), material: materials.solid }], shadow: 0.5, perCell: 12 },
      { parts: [{ geometry: makeBush(81), material: materials.bush }], shadow: 0.30, perCell: 14 },
      { parts: [{ geometry: makeBush(82), material: materials.bush }], shadow: 0.30, perCell: 14 },
      { parts: [{ geometry: makeReeds(91), material: materials.grass }], perCell: 18 },
    ];
    this.DETAIL = { BOULDER_A: 0, BOULDER_B: 1, STONE_A: 2, STONE_B: 3, BUSH_A: 4, BUSH_B: 5, REEDS: 6 };

    const grassDefs = [0, 1, 2, 3].map((tile) => ({
      parts: [{ geometry: makeGrassClump(100 + tile, tile, tile < 2 ? 3 : 2), material: materials.grass }],
      perCell: 90,
    }));

    // --- fields ------------------------------------------------------------
    this.trees = new InstanceField(this.group, {
      cellSize: 64,
      radius: quality.treeDistance,
      defs: treeDefs,
      capacity: 1400,
      shadowMaterial: quality.shadows ? materials.contactShadow : null,
      shadowCapacity: 900,
      generate: (cx, cz, size) => this.generateTrees(cx, cz, size, density),
    });

    this.details = new InstanceField(this.group, {
      cellSize: 32,
      radius: quality.detailDistance,
      defs: detailDefs,
      capacity: 900,
      shadowMaterial: quality.shadows ? materials.contactShadow : null,
      shadowCapacity: 600,
      generate: (cx, cz, size) => this.generateDetails(cx, cz, size, density),
    });

    this.grass = new InstanceField(this.group, {
      cellSize: 16,
      radius: quality.grassRadius,
      defs: grassDefs,
      capacity: 2600,
      cacheLimit: 200,
      generate: (cx, cz, size) => this.generateGrass(cx, cz, size, quality.grassDensity),
    });

    this.fields = [this.trees, this.details, this.grass];
  }

  update(px, pz, budgetMs = 4) {
    for (const field of this.fields) field.update(px, pz, budgetMs / this.fields.length);
  }

  get instanceCount() {
    return this.fields.reduce((n, f) => n + f.instanceCount, 0);
  }

  /** Ground height used for planting: matches the rendered terrain exactly. */
  plantHeight(sampler, x, z) {
    return gridHeightAt(x, z, this.spacing);
  }

  // --- generators ---------------------------------------------------------

  generateTrees(cx, cz, size, density) {
    const out = [];
    const x0 = cx * size, z0 = cz * size;
    const divisions = 12;
    const sampler = new CellSampler(x0, z0, size, divisions);
    const rnd = mulberry32(((cx & 0xffff) << 16) ^ (cz & 0xffff) ^ 0x51ed);
    const step = size / divisions;
    const T = this.TREE;

    for (let j = 0; j < divisions; j++) {
      for (let i = 0; i < divisions; i++) {
        const x = x0 + (i + 0.15 + rnd() * 0.7) * step;
        const z = z0 + (j + 0.15 + rnd() * 0.7) * step;
        const h = sampler.height(x, z);
        if (h > WORLD.treeLine + 12) continue;
        if (h < waterSurfaceAt(x, z) + 0.5) continue;
        sampler.normal(x, z, _normal);
        const slope = 1 - _normal.y;
        if (slope > 0.42) continue;
        // Keep the riverbanks clear enough to walk and see the water.
        if (riverDistanceAt(x, z) < RIVER_WIDTH + 3.5) continue;

        const m = moistureAt(x, z, h);
        const biome = biomeAt(x, z, h, slope, m);
        // Thin out toward the tree line.
        const alt = 1 - smoothstep(WORLD.treeLine - 14, WORLD.treeLine + 8, h);
        let chance = 0;
        if (biome === BIOME.FOREST) chance = 0.72;
        else if (biome === BIOME.MEADOW) chance = 0.30;
        else if (biome === BIOME.MOOR) chance = 0.13;
        else if (biome === BIOME.MARSH) chance = 0.16;
        else if (biome === BIOME.SHORE) chance = 0.05;
        else if (biome === BIOME.ALPINE) chance = 0.06;
        chance *= alt * density;
        // Fewer trees on the steeper ground, more in the hollows.
        chance *= 1 - smoothstep(0.18, 0.42, slope) * 0.7;
        if (rnd() > chance) continue;

        const r = rnd();
        let def, scale, upright;
        if (h > WORLD.treeLine - 6) {
          // Stunted, wind-bent conifers up high.
          def = T.PINE_C;
          scale = 4.2 + rnd() * 3.0;
          upright = 0.8;
        } else if (r < 0.06) {
          def = T.DEAD; scale = 6 + rnd() * 5; upright = 0.85;
        } else if (r < 0.12) {
          def = T.STUMP; scale = 1.1 + rnd() * 0.7; upright = 0.4;
        } else if (r < 0.12 + (m > 0.5 ? 0.20 : 0.32)) {
          def = rnd() < 0.7 ? T.BIRCH : T.BIRCH_AUTUMN;
          scale = 6.5 + rnd() * 5.5;
          upright = 0.85;
        } else {
          def = [T.PINE_A, T.PINE_B, T.PINE_C][(rnd() * 3) | 0];
          scale = 9 + rnd() * 10 - smoothstep(30, WORLD.treeLine, h) * 3.5;
          upright = 0.88;
        }
        const y = this.plantHeight(sampler, x, z) - 0.12;
        out.push(place(def, x, y, z, rnd() * Math.PI * 2, scale, _normal, upright));
      }
    }
    return out;
  }

  generateDetails(cx, cz, size, density) {
    const out = [];
    const x0 = cx * size, z0 = cz * size;
    const divisions = 11;
    const sampler = new CellSampler(x0, z0, size, divisions);
    const rnd = mulberry32(((cx & 0xffff) << 16) ^ (cz & 0xffff) ^ 0x9e37);
    const step = size / divisions;
    const D = this.DETAIL;

    for (let j = 0; j < divisions; j++) {
      for (let i = 0; i < divisions; i++) {
        const x = x0 + (i + rnd() * 0.9) * step;
        const z = z0 + (j + rnd() * 0.9) * step;
        const h = sampler.height(x, z);
        if (h < -1.2 || h > 200) continue;
        sampler.normal(x, z, _normal);
        const slope = 1 - _normal.y;
        const m = moistureAt(x, z, h);
        const biome = biomeAt(x, z, h, slope, m);

        // Reeds hug the waterline: standing in the shallows, never below them.
        const surface = waterSurfaceAt(x, z);
        const above = h - surface;
        if (above > -0.35 && above < 0.8 && slope < 0.25) {
          if (rnd() < 0.5 * density) {
            const y = this.plantHeight(sampler, x, z) - 0.25;
            out.push(place(D.REEDS, x, y, z, rnd() * Math.PI * 2, 0.7 + rnd() * 0.8, _normal, 0.75));
          }
          continue;
        }
        if (above < 0.12) continue;

        let r = rnd();
        // Rock density rises with steepness and altitude.
        const rockChance = (0.06 + smoothstep(0.16, 0.62, slope) * 0.42 + smoothstep(55, 105, h) * 0.40) * density;
        if (r < rockChance) {
          const big = rnd();
          const snowy = biome === BIOME.SNOW;
          let def, scale;
          if (big < 0.30) {
            def = rnd() < 0.5 ? D.BOULDER_A : D.BOULDER_B;
            scale = 1.6 + rnd() * 3.6;
          } else {
            def = snowy || rnd() < 0.4 ? D.STONE_B : D.STONE_A;
            scale = 0.35 + rnd() * 1.1;
          }
          // On a steep face a rock has to sit deeper or it hangs in mid-air.
          const bury = (0.14 + slope * 0.55) * scale;
          const y = this.plantHeight(sampler, x, z) - bury;
          out.push(place(def, x, y, z, rnd() * Math.PI * 2, scale, _normal, 0.25));
          continue;
        }

        if (slope > 0.45) continue;
        r = rnd();
        const bushChance = (biome === BIOME.FOREST ? 0.24 : biome === BIOME.MEADOW ? 0.16 : biome === BIOME.MOOR ? 0.10 : 0.04) * density;
        if (r < bushChance && h < WORLD.treeLine) {
          const y = this.plantHeight(sampler, x, z) - 0.06;
          out.push(place(rnd() < 0.5 ? D.BUSH_A : D.BUSH_B, x, y, z, rnd() * Math.PI * 2, 0.9 + rnd() * 1.5, _normal, 0.55));
        }
      }
    }
    return out;
  }

  generateGrass(cx, cz, size, density) {
    const out = [];
    const x0 = cx * size, z0 = cz * size;
    const divisions = 16;
    const sampler = new CellSampler(x0, z0, size, divisions);
    const rnd = mulberry32(((cx & 0xffff) << 16) ^ (cz & 0xffff) ^ 0x2f11);
    const step = size / divisions;

    for (let j = 0; j < divisions; j++) {
      for (let i = 0; i < divisions; i++) {
        for (let k = 0; k < 2; k++) {
          if (rnd() > density) continue;
          const x = x0 + (i + rnd()) * step;
          const z = z0 + (j + rnd()) * step;
          const h = sampler.height(x, z);
          if (h > WORLD.treeLine + 6) continue;
          if (h < waterSurfaceAt(x, z) + 0.2) continue;
          sampler.normal(x, z, _normal);
          const slope = 1 - _normal.y;
          if (slope > 0.40) continue;
          const m = moistureAt(x, z, h);
          const biome = biomeAt(x, z, h, slope, m);
          if (biome === BIOME.SNOW) continue;

          let cover = 0.85;
          if (biome === BIOME.MOOR) cover = 0.6;
          if (biome === BIOME.SHORE) cover = 0.25;
          if (biome === BIOME.MARSH) cover = 0.7;
          // Thin, wind-burnt tussocks cling on above the trees.
          if (biome === BIOME.ALPINE) cover = 0.22;
          if (biome === BIOME.ROCK) cover = 0.10;
          cover *= 1 - smoothstep(0.2, 0.4, slope);
          if (rnd() > cover) continue;

          // Dry tussocks on the drier ground, flowers in the good meadows.
          let tile;
          const r = rnd();
          if (h > WORLD.treeLine - 6) tile = 1;
          else if (m < 0.4) tile = r < 0.75 ? 1 : 0;
          else if (biome === BIOME.MEADOW && r < 0.22) tile = r < 0.11 ? 2 : 3;
          else tile = r < 0.85 ? 0 : 1;

          const y = this.plantHeight(sampler, x, z) - 0.08;
          const scale = 0.45 + rnd() * 0.75;
          out.push(place(tile, x, y, z, rnd() * Math.PI * 2, scale, _normal, 0.35));
        }
      }
    }
    return out;
  }
}

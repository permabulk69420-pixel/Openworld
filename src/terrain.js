/**
 * Chunked, level-of-detail terrain.
 *
 * The world is a fixed grid of 128 m chunks. Every chunk within the view
 * distance is always present (so the mountain silhouette on the horizon never
 * pops in) but its tessellation is chosen from the distance to the player, and
 * anything past the view distance — where the fog is already opaque — is hidden
 * rather than drawn. Chunk edges get a downward "skirt" so neighbouring chunks
 * at different detail levels can't show a crack of sky between them.
 *
 * Geometry building is time-budgeted: the manager keeps a priority queue and
 * builds only as much as fits in the frame's spare milliseconds.
 */

import * as THREE from 'three';
import { CHUNK_SIZE, CHUNK_GRID } from './config.js';
import { WORLD, heightAt, surfaceColor, moistureAt } from './world.js';

const GEOMETRY_CACHE_LIMIT = 96;

export class Terrain {
  /**
   * @param {THREE.Scene} scene
   * @param {object} quality one of the QUALITY presets
   * @param {THREE.Material} material shared terrain material
   */
  constructor(scene, quality, material) {
    this.scene = scene;
    this.quality = quality;
    this.material = material;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);

    this.chunks = [];
    this.queue = [];
    this.cache = new Map();
    this.built = 0;

    const half = WORLD.half;
    for (let cz = 0; cz < CHUNK_GRID; cz++) {
      for (let cx = 0; cx < CHUNK_GRID; cx++) {
        const x0 = -half + cx * CHUNK_SIZE;
        const z0 = -half + cz * CHUNK_SIZE;
        this.chunks.push({
          cx, cz, x0, z0,
          center: new THREE.Vector3(x0 + CHUNK_SIZE / 2, 0, z0 + CHUNK_SIZE / 2),
          mesh: null,
          lod: -1,
          pendingLod: -1,
        });
      }
    }
  }

  /** Grid spacing of the highest detail level — the player walks on this grid. */
  get sampleSpacing() {
    return CHUNK_SIZE / this.quality.lodSegments[0];
  }

  get totalChunks() {
    return this.chunks.length;
  }

  lodForDistance(d) {
    const dist = this.quality.lodDistances;
    for (let i = 0; i < dist.length; i++) if (d < dist[i]) return i;
    return dist.length - 1;
  }

  /** Distance from a point to the chunk's footprint (0 when inside it). */
  distanceToChunk(chunk, px, pz) {
    const dx = Math.max(chunk.x0 - px, 0, px - (chunk.x0 + CHUNK_SIZE));
    const dz = Math.max(chunk.z0 - pz, 0, pz - (chunk.z0 + CHUNK_SIZE));
    return Math.hypot(dx, dz);
  }

  /** Re-evaluate which detail level each chunk wants and queue the changes. */
  refresh(px, pz) {
    this.queue.length = 0;
    for (const chunk of this.chunks) {
      const d = this.distanceToChunk(chunk, px, pz);
      // Past the view distance the fog is already solid, so there is nothing to
      // see: skip the geometry and, more to the point, skip the draw call.
      const beyond = d > this.quality.viewDistance;
      if (chunk.mesh) chunk.mesh.visible = !beyond;
      if (beyond) {
        chunk.pendingLod = chunk.lod;
        continue;
      }
      const lod = this.lodForDistance(d);
      chunk.pendingLod = lod;
      if (chunk.lod !== lod) this.queue.push({ chunk, lod, d });
    }
    this.queue.sort((a, b) => a.d - b.d);
  }

  /** How many chunks are actually being submitted right now. */
  get visibleChunks() {
    let n = 0;
    for (const chunk of this.chunks) if (chunk.mesh && chunk.mesh.visible) n++;
    return n;
  }

  /** Build queued chunks until the time budget runs out. Returns work left. */
  processQueue(budgetMs = 6) {
    const start = performance.now();
    while (this.queue.length) {
      const job = this.queue.shift();
      // The desired level may have changed again while queued.
      if (job.chunk.pendingLod !== job.lod) continue;
      this.buildChunk(job.chunk, job.lod);
      if (performance.now() - start > budgetMs) break;
    }
    return this.queue.length;
  }

  buildChunk(chunk, lod) {
    const segments = this.quality.lodSegments[lod];
    const key = `${chunk.cx},${chunk.cz},${segments}`;
    let geometry = this.cache.get(key);
    if (geometry) {
      // Refresh LRU ordering.
      this.cache.delete(key);
      this.cache.set(key, geometry);
    } else {
      geometry = buildChunkGeometry(chunk.x0, chunk.z0, segments);
      this.cache.set(key, geometry);
      this.trimCache();
    }

    if (!chunk.mesh) {
      chunk.mesh = new THREE.Mesh(geometry, this.material);
      chunk.mesh.matrixAutoUpdate = false;
      chunk.mesh.castShadow = false;
      chunk.mesh.receiveShadow = this.quality.shadows;
      chunk.mesh.updateMatrix();
      this.group.add(chunk.mesh);
    } else {
      chunk.mesh.geometry = geometry;
    }
    chunk.lod = lod;
    this.built++;
  }

  trimCache() {
    while (this.cache.size > GEOMETRY_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      const geo = this.cache.get(oldest);
      const inUse = this.chunks.some((c) => c.mesh && c.mesh.geometry === geo);
      this.cache.delete(oldest);
      if (!inUse) geo.dispose();
      else this.cache.set(oldest, geo); // still on screen, keep it and try the next
      if (inUse && this.cache.size <= GEOMETRY_CACHE_LIMIT + 8) break;
    }
  }

  update(px, pz, budgetMs = 4) {
    // Only re-plan when the player has actually moved a meaningful distance.
    if (!this._lastPlan || Math.hypot(px - this._lastPlan.x, pz - this._lastPlan.z) > 24) {
      this._lastPlan = { x: px, z: pz };
      this.refresh(px, pz);
    }
    return this.processQueue(budgetMs);
  }

  dispose() {
    for (const geo of this.cache.values()) geo.dispose();
    this.cache.clear();
    this.group.clear();
  }
}

/**
 * Build one chunk's geometry.
 *
 * Heights are sampled once into a padded grid; normals and slopes are then
 * derived from the neighbours instead of re-evaluating the (fairly expensive)
 * height function four more times per vertex.
 */
export function buildChunkGeometry(x0, z0, segments) {
  const step = CHUNK_SIZE / segments;
  const n = segments + 1;
  const pad = n + 2;

  // Padded height samples: index (i+1, j+1) is grid vertex (i, j).
  const H = new Float32Array(pad * pad);
  for (let j = -1; j <= n; j++) {
    const z = z0 + j * step;
    for (let i = -1; i <= n; i++) {
      H[(j + 1) * pad + (i + 1)] = heightAt(x0 + i * step, z);
    }
  }
  const hAt = (i, j) => H[(j + 1) * pad + (i + 1)];

  const vertexCount = n * n + 4 * n;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  const rgb = [0, 0, 0];

  for (let j = 0; j < n; j++) {
    const z = z0 + j * step;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * step;
      const h = hAt(i, j);
      const v = j * n + i;

      const nx = hAt(i - 1, j) - hAt(i + 1, j);
      const nz = hAt(i, j - 1) - hAt(i, j + 1);
      const ny = 2 * step;
      const len = Math.hypot(nx, ny, nz) || 1;

      positions[v * 3] = x;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = z;
      normals[v * 3] = nx / len;
      normals[v * 3 + 1] = ny / len;
      normals[v * 3 + 2] = nz / len;

      const slope = 1 - ny / len;
      surfaceColor(x, z, h, slope, moistureAt(x, z, h), rgb);
      colors[v * 3] = rgb[0];
      colors[v * 3 + 1] = rgb[1];
      colors[v * 3 + 2] = rgb[2];

      uvs[v * 2] = x * 0.11;
      uvs[v * 2 + 1] = z * 0.11;
    }
  }

  const quadCount = segments * segments;
  const indices = new Uint32Array(quadCount * 6 + segments * 4 * 6);
  let t = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[t++] = a; indices[t++] = c; indices[t++] = b;
      indices[t++] = b; indices[t++] = c; indices[t++] = d;
    }
  }

  // Skirts. Each edge is walked in the direction that makes the quad face
  // outwards, so back-face culling keeps working.
  // Just deep enough to cover the gap between two detail levels. Any deeper
  // and the skirt shows up as a grey wall along distant ridge lines.
  const skirtDrop = Math.min(2.5, Math.max(1.0, step * 0.5));
  let sv = n * n;

  const addSkirt = (edgeIndices) => {
    const first = sv;
    for (let k = 0; k < edgeIndices.length; k++) {
      const src = edgeIndices[k];
      const v = sv++;
      positions[v * 3] = positions[src * 3];
      positions[v * 3 + 1] = positions[src * 3 + 1] - skirtDrop;
      positions[v * 3 + 2] = positions[src * 3 + 2];
      normals[v * 3] = normals[src * 3];
      normals[v * 3 + 1] = normals[src * 3 + 1];
      normals[v * 3 + 2] = normals[src * 3 + 2];
      colors[v * 3] = colors[src * 3] * 0.92;
      colors[v * 3 + 1] = colors[src * 3 + 1] * 0.92;
      colors[v * 3 + 2] = colors[src * 3 + 2] * 0.92;
      uvs[v * 2] = uvs[src * 2];
      uvs[v * 2 + 1] = uvs[src * 2 + 1];
    }
    for (let k = 0; k < edgeIndices.length - 1; k++) {
      const t0 = edgeIndices[k], t1 = edgeIndices[k + 1];
      const s0 = first + k, s1 = first + k + 1;
      indices[t++] = t0; indices[t++] = t1; indices[t++] = s0;
      indices[t++] = t1; indices[t++] = s1; indices[t++] = s0;
    }
  };

  const north = [], south = [], west = [], east = [];
  for (let i = 0; i < n; i++) north.push(i);                       // j = 0,   +X
  for (let i = n - 1; i >= 0; i--) south.push((n - 1) * n + i);    // j = n-1, -X
  for (let j = n - 1; j >= 0; j--) west.push(j * n);               // i = 0,   -Z
  for (let j = 0; j < n; j++) east.push(j * n + n - 1);            // i = n-1, +Z
  addSkirt(north); addSkirt(south); addSkirt(west); addSkirt(east);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices.subarray(0, t), 1));
  geometry.computeBoundingSphere();
  return geometry;
}

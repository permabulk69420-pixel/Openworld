/**
 * Everything the world is made of, generated at load time: a handful of canvas
 * textures and a set of low-poly geometries for trees, rocks and undergrowth.
 *
 * Nothing is downloaded — the whole thing is a few hundred lines of drawing
 * code, which keeps the repo tiny and makes the art directable from one place.
 */

import * as THREE from 'three';
import { Noise2D, mulberry32, clamp, lerp } from './noise.js';

const texNoise = new Noise2D(9001);

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

function canvas(size, height = size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = height;
  return c;
}

/** fBm that wraps seamlessly over a w x h tile. */
function tileableFbm(x, y, w, h, octaves, freq) {
  const n = (px, py) => texNoise.fbm(px, py, octaves, freq, 0.5);
  const fx = x / w, fy = y / h;
  return (
    n(x, y) * (1 - fx) * (1 - fy) +
    n(x - w, y) * fx * (1 - fy) +
    n(x, y - h) * (1 - fx) * fy +
    n(x - w, y - h) * fx * fy
  );
}

/** Mottled greyscale detail multiplied over the terrain's vertex colours. */
function makeGroundTexture(size = 256) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Deliberately gentle: this multiplies the terrain's vertex colours, and
      // anything punchier turns bright ground (snow, gravel) into static.
      const coarse = tileableFbm(x, y, size, size, 4, 0.022);
      const mid = tileableFbm(x + 500, y - 300, size, size, 3, 0.058);
      let v = clamp(0.94 + coarse * 0.075 + mid * 0.035, 0, 1);
      const o = (y * size + x) * 4;
      img.data[o] = v * 255;
      img.data[o + 1] = v * 253;
      img.data[o + 2] = v * 248;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function blade(ctx, x, yBase, height, width, curve, color) {
  ctx.beginPath();
  ctx.moveTo(x - width / 2, yBase);
  ctx.quadraticCurveTo(x - width / 2 + curve * 0.6, yBase - height * 0.55, x + curve, yBase - height);
  ctx.quadraticCurveTo(x + width / 2 + curve * 0.6, yBase - height * 0.5, x + width / 2, yBase);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * 2x2 atlas of ground cover, each tile 128 px:
 *   0 = green grass   1 = dry grass
 *   2 = white/yellow flowers   3 = purple flowers
 */
function makeGrassAtlas() {
  const T = 128;
  const c = canvas(T * 2);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, T * 2, T * 2);
  const rnd = mulberry32(4242);

  const drawTile = (ox, oy, greens, flowerColors) => {
    ctx.save();
    ctx.translate(ox, oy);
    ctx.beginPath();
    ctx.rect(2, 2, T - 4, T - 4);
    ctx.clip();
    for (let i = 0; i < 34; i++) {
      const x = 8 + rnd() * (T - 16);
      const h = T * (0.45 + rnd() * 0.53);
      const w = 3 + rnd() * 5;
      const curve = (rnd() - 0.5) * 26;
      const g = greens[(rnd() * greens.length) | 0];
      blade(ctx, x, T - 1, h, w, curve, g);
    }
    if (flowerColors) {
      for (let i = 0; i < 13; i++) {
        const x = 10 + rnd() * (T - 20);
        const y = 12 + rnd() * (T * 0.55);
        const r = 3 + rnd() * 3.5;
        ctx.fillStyle = flowerColors[(rnd() * flowerColors.length) | 0];
        for (let p = 0; p < 5; p++) {
          const a = (p / 5) * Math.PI * 2 + rnd();
          ctx.beginPath();
          ctx.ellipse(x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.72, r * 0.62, a, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#e8d27a';
        ctx.beginPath();
        ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  };

  drawTile(0, 0, ['#4e6b2c', '#5d7a33', '#3f5a24', '#6a8a3c'], null);
  drawTile(T, 0, ['#8a8b45', '#9c9450', '#77743a', '#a8a058'], null);
  drawTile(0, T, ['#4e6b2c', '#5d7a33', '#3f5a24'], ['#f2f0e2', '#f7e7a8']);
  drawTile(T, T, ['#4e6b2c', '#547030', '#415c25'], ['#9a7bc8', '#7f6bd6', '#c08ad8']);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  return tex;
}

/** Clumped foliage mass for broadleaf trees and bushes. */
function makeLeafTexture(size = 256, palette, density = 190, radius = 0.30) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const rnd = mulberry32(777);
  const cx = size / 2, cy = size / 2;
  for (let i = 0; i < density; i++) {
    // Cluster toward the middle so the quad silhouette looks like a canopy.
    const a = rnd() * Math.PI * 2;
    const r = Math.pow(rnd(), 0.62) * size * radius;
    const x = cx + Math.cos(a) * r * 1.15;
    const y = cy + Math.sin(a) * r;
    const s = size * (0.045 + rnd() * 0.075);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rnd() * Math.PI);
    ctx.fillStyle = palette[(rnd() * palette.length) | 0];
    ctx.beginPath();
    ctx.ellipse(0, 0, s, s * (0.5 + rnd() * 0.4), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  return tex;
}

/** Soft tileable cloud alpha. */
function makeCloudTexture(size = 256) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = tileableFbm(x + 1200, y + 400, size, size, 5, 0.022);
      const a = clamp((n * 0.5 + 0.5 - 0.44) * 2.6, 0, 1);
      const o = (y * size + x) * 4;
      img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255;
      img.data[o + 3] = Math.pow(a, 1.35) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Tileable RG noise used to perturb the water surface normal. */
function makeWaterNoiseTexture(size = 128) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = tileableFbm(x, y, size, size, 3, 0.05) * 0.5 + 0.5;
      const b = tileableFbm(x + 700, y + 300, size, size, 3, 0.09) * 0.5 + 0.5;
      const o = (y * size + x) * 4;
      img.data[o] = a * 255;
      img.data[o + 1] = b * 255;
      img.data[o + 2] = 128;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export function createTextures() {
  return {
    ground: makeGroundTexture(),
    grass: makeGrassAtlas(),
    leaf: makeLeafTexture(256, ['#5c7a30', '#4b682a', '#6b8a38', '#3f5a24', '#7a9440'], 200, 0.30),
    leafAutumn: makeLeafTexture(256, ['#9a7b2e', '#b08a33', '#8a6a26', '#c2a24a', '#6f5a22'], 200, 0.30),
    bush: makeLeafTexture(256, ['#3f5a24', '#4e6b2c', '#35501f', '#5a7630'], 240, 0.34),
    cloud: makeCloudTexture(),
    waterNoise: makeWaterNoiseTexture(),
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const _color = new THREE.Color();

/** Paint a whole geometry one colour (with optional per-vertex jitter). */
function paint(geometry, hex, jitter = 0.05, rnd = Math.random) {
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  _color.set(hex);
  for (let i = 0; i < pos.count; i++) {
    const v = 1 + (rnd() - 0.5) * 2 * jitter;
    colors[i * 3] = _color.r * v;
    colors[i * 3 + 1] = _color.g * v;
    colors[i * 3 + 2] = _color.b * v;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * How much a vertex bends in the wind, 0 at the base and 1 at the tip.
 * Stored per vertex so one shader can animate trunks, branches and grass.
 */
function setFlex(geometry, minY, maxY, power = 1.6, scale = 1) {
  const pos = geometry.attributes.position;
  const flex = new Float32Array(pos.count);
  const span = Math.max(0.0001, maxY - minY);
  for (let i = 0; i < pos.count; i++) {
    const t = clamp((pos.getY(i) - minY) / span, 0, 1);
    flex[i] = Math.pow(t, power) * scale;
  }
  geometry.setAttribute('aFlex', new THREE.BufferAttribute(flex, 1));
  return geometry;
}

/** Merge a list of geometries that all share the same attribute set. */
function merge(geometries) {
  let vertexCount = 0, indexCount = 0;
  const hasUv = geometries.every((g) => g.attributes.uv);
  for (const g of geometries) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  const uv = hasUv ? new Float32Array(vertexCount * 2) : null;
  const index = new Uint16Array(indexCount);

  let vo = 0, io = 0;
  for (const g of geometries) {
    const p = g.attributes.position, n = g.attributes.normal, c = g.attributes.color;
    position.set(p.array, vo * 3);
    if (n) normal.set(n.array, vo * 3);
    if (c) color.set(c.array, vo * 3);
    if (uv && g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2);
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) index[io++] = g.index.array[i] + vo;
    } else {
      for (let i = 0; i < p.count; i++) index[io++] = i + vo;
    }
    vo += p.count;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}

function transform(geometry, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
  const m = new THREE.Matrix4();
  m.compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
  geometry.applyMatrix4(m);
  return geometry;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

/**
 * Nordic spruce: a tapered trunk under a stack of drooping cone tiers.
 * `detail` trades triangles for silhouette quality (used for the distance LOD).
 */
export function makePine(seed = 1, detail = 1) {
  const rnd = mulberry32(seed);
  const height = 1;                       // unit height; instances scale it
  const radialTrunk = detail > 0.6 ? 6 : 4;
  const radialCone = detail > 0.6 ? 8 : 5;
  const tiers = detail > 0.6 ? 5 : 3;

  const parts = [];
  const trunkH = height * 0.34;
  const trunk = new THREE.CylinderGeometry(height * 0.016, height * 0.035, trunkH, radialTrunk, 1, true);
  transform(trunk, { y: trunkH / 2 });
  paint(trunk, '#4b3a2a', 0.10, rnd);
  parts.push(trunk);

  const needle = ['#2c3f24', '#33492a', '#26381f', '#3a5230'][(rnd() * 4) | 0];
  const topY = height * (0.96 + rnd() * 0.12);
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const base = lerp(height * 0.22, topY * 0.78, t);
    const coneH = lerp(height * 0.42, height * 0.26, t);
    const radius = lerp(height * 0.235, height * 0.075, t) * (0.9 + rnd() * 0.22);
    const cone = new THREE.ConeGeometry(radius, coneH, radialCone, 1, true);
    transform(cone, { y: base + coneH / 2, ry: rnd() * Math.PI });
    paint(cone, needle, 0.13, rnd);
    parts.push(cone);
  }
  // Crown spike.
  const tip = new THREE.ConeGeometry(height * 0.05, height * 0.22, radialCone, 1, true);
  transform(tip, { y: topY });
  paint(tip, needle, 0.10, rnd);
  parts.push(tip);

  const geo = merge(parts);
  return setFlex(geo, 0, topY, 1.9, 0.035);
}

/** Slim birch trunk. Leaves are a separate alpha-tested part. */
export function makeBirchTrunk(seed = 1) {
  const rnd = mulberry32(seed);
  const parts = [];
  const h = 0.70;   // stops short of the canopy so no bare tip pokes through
  const trunk = new THREE.CylinderGeometry(0.014, 0.028, h, 5, 1, true);
  transform(trunk, { y: h / 2, rz: (rnd() - 0.5) * 0.06 });
  paint(trunk, '#cfc9b4', 0.11, rnd);
  parts.push(trunk);
  for (let i = 0; i < 3; i++) {
    const a = rnd() * Math.PI * 2;
    const len = 0.11 + rnd() * 0.09;
    const branch = new THREE.CylinderGeometry(0.006, 0.012, len, 4, 1, true);
    transform(branch, {
      y: h * (0.55 + rnd() * 0.35), rz: 0.7 + rnd() * 0.4, ry: a,
    });
    transform(branch, { x: Math.cos(a) * len * 0.28, z: -Math.sin(a) * len * 0.28 });
    paint(branch, '#b8b09a', 0.10, rnd);
    parts.push(branch);
  }
  const geo = merge(parts);
  return setFlex(geo, 0, h, 2.0, 0.05);
}

/** Crossed alpha quads forming a birch canopy. Uses the leaf texture. */
export function makeCanopy(seed = 1, blobs = 5) {
  const rnd = mulberry32(seed + 31);
  const parts = [];
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * Math.PI * 2 + rnd() * 0.6;
    const r = 0.09 + rnd() * 0.13;
    const size = 0.46 + rnd() * 0.26;
    const q = new THREE.PlaneGeometry(size, size);
    transform(q, {
      x: Math.cos(a) * r,
      y: 0.66 + rnd() * 0.26,
      z: Math.sin(a) * r,
      ry: a + Math.PI / 2 + (rnd() - 0.5) * 0.5,
      rx: (rnd() - 0.5) * 0.4,
    });
    paint(q, '#ffffff', 0.10, rnd);
    parts.push(q);
    const q2 = q.clone();
    transform(q2, { ry: Math.PI / 2 });
    parts.push(q2);
  }
  const geo = merge(parts);
  return setFlex(geo, 0.4, 1.05, 1.2, 0.09);
}

/** Bare, weathered trunk — good for high slopes and burnt patches. */
export function makeDeadTree(seed = 1) {
  const rnd = mulberry32(seed + 77);
  const parts = [];
  const h = 0.7 + rnd() * 0.25;
  const trunk = new THREE.CylinderGeometry(0.02, 0.055, h, 5, 1, true);
  transform(trunk, { y: h / 2, rz: (rnd() - 0.5) * 0.18 });
  paint(trunk, '#6a6154', 0.13, rnd);
  parts.push(trunk);
  const n = 3 + ((rnd() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const len = 0.16 + rnd() * 0.3;
    const branch = new THREE.CylinderGeometry(0.006, 0.017, len, 4, 1, true);
    transform(branch, { y: len / 2 });
    transform(branch, { rz: 0.6 + rnd() * 0.7, ry: a });
    transform(branch, { y: h * (0.4 + rnd() * 0.5) });
    paint(branch, '#6f665a', 0.13, rnd);
    parts.push(branch);
  }
  const geo = merge(parts);
  return setFlex(geo, 0, h, 2.2, 0.02);
}

/** Weathered stump with a splintered top. */
export function makeStump(seed = 1) {
  const rnd = mulberry32(seed + 5);
  const g = new THREE.CylinderGeometry(0.13, 0.19, 0.30, 7, 1, false);
  transform(g, { y: 0.15 });
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0.28) pos.setY(i, pos.getY(i) - rnd() * 0.09);
  }
  g.computeVertexNormals();
  paint(g, '#4a3b2c', 0.14, rnd);
  return setFlex(g, 0, 0.3, 2, 0.004);
}

// ---------------------------------------------------------------------------
// Rocks
// ---------------------------------------------------------------------------

/** Irregular boulder: a subdivided icosahedron pushed around by noise. */
export function makeRock(seed = 1, detailLevel = 1, tint = '#6d6a63') {
  const rnd = mulberry32(seed + 991);
  const noise = new Noise2D(seed * 13 + 7);
  const g = new THREE.IcosahedronGeometry(0.5, detailLevel);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  const squash = 0.5 + rnd() * 0.4;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = noise.fbm(v.x * 3.1 + 10, v.z * 3.1 + v.y * 2.2, 3, 1, 0.55);
    const d = 1 + n * 0.42;
    v.multiplyScalar(d);
    v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  // Sit the rock on the ground rather than centred on it.
  g.computeBoundingBox();
  transform(g, { y: -g.boundingBox.min.y * 0.55 });
  g.computeVertexNormals();
  paint(g, tint, 0.11, rnd);
  const flex = new Float32Array(pos.count);
  g.setAttribute('aFlex', new THREE.BufferAttribute(flex, 1));
  return g;
}

// ---------------------------------------------------------------------------
// Undergrowth
// ---------------------------------------------------------------------------

/**
 * A clump of crossed quads for grass/flowers. `tile` picks a cell of the 2x2
 * grass atlas; the UVs are baked so no per-instance attribute is needed.
 */
export function makeGrassClump(seed = 1, tile = 0, quads = 3) {
  const rnd = mulberry32(seed + 313);
  const parts = [];
  const u0 = (tile % 2) * 0.5, v0 = (tile < 2 ? 0.5 : 0);
  for (let i = 0; i < quads; i++) {
    const q = new THREE.PlaneGeometry(1, 1);
    const uv = q.attributes.uv;
    for (let k = 0; k < uv.count; k++) {
      uv.setXY(k, u0 + uv.getX(k) * 0.5, v0 + uv.getY(k) * 0.5);
    }
    transform(q, {
      y: 0.5,
      ry: (i / quads) * Math.PI + rnd() * 0.5,
      x: (rnd() - 0.5) * 0.35,
      z: (rnd() - 0.5) * 0.35,
      sx: 0.8 + rnd() * 0.5,
      sy: 0.75 + rnd() * 0.5,
    });
    paint(q, '#ffffff', 0.14, rnd);
    parts.push(q);
  }
  const geo = merge(parts);
  return setFlex(geo, 0, 1, 1.4, 0.42);
}

/** Rounded shrub built from crossed textured quads. */
export function makeBush(seed = 1) {
  const rnd = mulberry32(seed + 55);
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const q = new THREE.PlaneGeometry(1, 0.85);
    transform(q, {
      y: 0.42 + (rnd() - 0.5) * 0.12,
      ry: (i / 4) * Math.PI + rnd() * 0.4,
      x: (rnd() - 0.5) * 0.22,
      z: (rnd() - 0.5) * 0.22,
      sx: 0.85 + rnd() * 0.3,
    });
    paint(q, '#ffffff', 0.12, rnd);
    parts.push(q);
  }
  const geo = merge(parts);
  return setFlex(geo, 0, 1, 1.3, 0.16);
}

/** Reeds for the water's edge: tall, narrow, heavily swaying. */
export function makeReeds(seed = 1) {
  const rnd = mulberry32(seed + 606);
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const q = new THREE.PlaneGeometry(0.55, 1.5);
    const uv = q.attributes.uv;
    // Dry-grass tile of the atlas.
    for (let k = 0; k < uv.count; k++) uv.setXY(k, 0.5 + uv.getX(k) * 0.5, 0.5 + uv.getY(k) * 0.5);
    transform(q, {
      y: 0.75,
      ry: (i / 3) * Math.PI + rnd() * 0.6,
      x: (rnd() - 0.5) * 0.4,
      z: (rnd() - 0.5) * 0.4,
      rz: (rnd() - 0.5) * 0.2,
    });
    paint(q, '#c8c49a', 0.12, rnd);
    parts.push(q);
  }
  const geo = merge(parts);
  return setFlex(geo, 0, 1.5, 1.5, 0.34);
}

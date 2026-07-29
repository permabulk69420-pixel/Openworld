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

// ---------------------------------------------------------------------------
// City surface atlas
// ---------------------------------------------------------------------------

/**
 * One 4x4 atlas covers every man-made surface in the city: facades, roofs,
 * tarmac, pavement, decking. Everything the city draws therefore shares a
 * single material, which is what keeps a whole downtown down to a couple of
 * dozen draw calls.
 *
 * The tiles are designed to repeat: `TILE_WINDOWS` bays across and the same
 * number of floors up, so a wall's UVs are just (metres / bay, metres / floor)
 * and the shader wraps them inside the tile. See `applyAtlas` in materials.js.
 */
export const TILE = {
  GLASS: 0, BRONZE: 1, OFFICE: 2, BRICK: 3,
  DECO: 4, SHED: 5, PODIUM: 6, CONCRETE: 7,
  ROOF: 8, ROAD_AVENUE: 9, ROAD_STREET: 10, PAVEMENT: 11,
  PLAZA: 12, PATH: 13, DECK: 14, GLASS_ALT: 15,
};

export const ATLAS_COLUMNS = 4;
export const TILE_WINDOWS = 8;   // windows per tile, in both axes

/** uv offset/scale for a tile, as the vec4 the shader wants. */
export function tileAtlas(index) {
  const col = index % ATLAS_COLUMNS;
  const row = (index / ATLAS_COLUMNS) | 0;
  const s = 1 / ATLAS_COLUMNS;
  // Canvas rows run top-down, UV rows run bottom-up.
  return [col * s, 1 - (row + 1) * s, s, s];
}

/** Slightly varied greys/browns so no two neighbouring panels match exactly. */
function jitterHex(rnd, base, amount) {
  const n = parseInt(base.slice(1), 16);
  const k = 1 + (rnd() - 0.5) * 2 * amount;
  const ch = (shift) => clamp(Math.round(((n >> shift) & 255) * k), 0, 255);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

/**
 * Draws one facade tile: a grid of windows in a wall, plus spandrels, mullions
 * and a little grime. `emissive` switches to drawing only the lit windows on
 * black, which is the same geometry sampled by the emissive map at night.
 */
function drawFacade(ctx, ox, oy, size, opts, emissive) {
  const n = TILE_WINDOWS;
  const cell = size / n;
  const rnd = mulberry32(opts.seed);

  if (!emissive) {
    ctx.fillStyle = opts.wall;
    ctx.fillRect(ox, oy, size, size);
    // Broad panel banding so the wall is not one flat colour.
    for (let j = 0; j < n; j++) {
      ctx.fillStyle = jitterHex(rnd, opts.wall, 0.055);
      ctx.fillRect(ox, oy + j * cell, size, cell);
    }
  } else {
    ctx.fillStyle = '#000000';
    ctx.fillRect(ox, oy, size, size);
  }

  const inset = cell * opts.inset;
  const wW = cell - inset * 2;
  const wH = (cell - inset * 2) * opts.aspect;
  const wY = inset + (cell - inset * 2 - wH) * (opts.sill ?? 0.35);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = ox + i * cell + inset;
      const y = oy + j * cell + wY;
      const lit = rnd() < opts.litChance;
      const bright = 0.55 + rnd() * 0.45;

      if (emissive) {
        if (!lit) continue;
        const c = opts.lightColors[(rnd() * opts.lightColors.length) | 0];
        ctx.fillStyle = c;
        ctx.globalAlpha = bright;
        ctx.fillRect(x, y, wW, wH);
        // A warmer core, so the window is not a flat rectangle of colour.
        ctx.globalAlpha = bright * 0.5;
        ctx.fillRect(x + wW * 0.14, y + wH * 0.12, wW * 0.72, wH * 0.5);
        ctx.globalAlpha = 1;
        continue;
      }

      ctx.fillStyle = opts.glassShades[(rnd() * opts.glassShades.length) | 0];
      ctx.fillRect(x, y, wW, wH);
      // Sky reflection across the top of the pane.
      ctx.fillStyle = opts.sheen;
      ctx.globalAlpha = 0.16 + rnd() * 0.26;
      ctx.fillRect(x, y, wW, wH * (0.22 + rnd() * 0.3));
      ctx.globalAlpha = 1;

      if (opts.mullion) {
        ctx.strokeStyle = opts.mullion;
        ctx.lineWidth = Math.max(1, cell * 0.045);
        ctx.strokeRect(x + 0.5, y + 0.5, wW - 1, wH - 1);
      }
    }
  }

  if (emissive) return;

  // Vertical piers, the thing that makes a deco tower read as one.
  if (opts.piers) {
    ctx.fillStyle = opts.piers;
    for (let i = 0; i <= n; i++) {
      ctx.fillRect(ox + i * cell - cell * 0.06, oy, cell * 0.12, size);
    }
  }
  // Floor slab shadow line.
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  for (let j = 0; j < n; j++) ctx.fillRect(ox, oy + j * cell + cell - 2, size, 2);
}

function drawShed(ctx, ox, oy, size, emissive) {
  const rnd = mulberry32(515);
  if (emissive) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(ox, oy, size, size);
    // A couple of high strip windows and a security lamp.
    for (let i = 0; i < 4; i++) {
      if (rnd() < 0.5) continue;
      ctx.fillStyle = 'rgba(210,225,255,0.55)';
      ctx.fillRect(ox + i * (size / 4) + 8, oy + size * 0.13, size / 4 - 16, size * 0.07);
    }
    ctx.fillStyle = 'rgba(255,214,150,0.85)';
    ctx.fillRect(ox + size * 0.46, oy + size * 0.52, size * 0.08, size * 0.05);
    return;
  }
  ctx.fillStyle = '#6d7076';
  ctx.fillRect(ox, oy, size, size);
  // Corrugation.
  for (let i = 0; i < 48; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.09)';
    ctx.fillRect(ox + i * (size / 48), oy, size / 48, size);
  }
  ctx.fillStyle = 'rgba(30,34,40,0.55)';
  ctx.fillRect(ox, oy + size * 0.10, size, size * 0.012);
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = '#2c3340';
    ctx.fillRect(ox + i * (size / 4) + 8, oy + size * 0.13, size / 4 - 16, size * 0.07);
  }
  // Rust streaks.
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(112,78,52,${0.05 + rnd() * 0.12})`;
    const x = ox + rnd() * size;
    ctx.fillRect(x, oy + rnd() * size * 0.5, 2 + rnd() * 4, size * (0.2 + rnd() * 0.5));
  }
}

/** Ground floors: glazed shopfronts, awnings and a neon sign or two. */
function drawPodium(ctx, ox, oy, size, emissive) {
  const rnd = mulberry32(2024);
  const bays = 6;
  const cell = size / bays;
  if (!emissive) {
    ctx.fillStyle = '#6d7079';
    ctx.fillRect(ox, oy, size, size);
    ctx.fillStyle = '#4a4e57';
    ctx.fillRect(ox, oy, size, size * 0.16);
  } else {
    ctx.fillStyle = '#000000';
    ctx.fillRect(ox, oy, size, size);
  }

  for (let i = 0; i < bays; i++) {
    const x = ox + i * cell + cell * 0.10;
    const w = cell * 0.80;
    const y = oy + size * 0.24;
    const h = size * 0.66;
    if (emissive) {
      const warm = rnd() < 0.72;
      ctx.fillStyle = warm ? 'rgba(255,206,140,0.9)' : 'rgba(180,225,255,0.75)';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = ['#ff5f7a', '#5fd0ff', '#c8ff6a', '#ffb03a'][(rnd() * 4) | 0];
      ctx.fillRect(x + w * 0.12, oy + size * 0.09, w * 0.76, size * 0.08);
    } else {
      ctx.fillStyle = '#2c3742';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(170,200,225,0.30)';
      ctx.fillRect(x, y, w, h * 0.35);
      ctx.fillStyle = ['#7a3040', '#2a5a70', '#5a7030', '#7a5520'][(rnd() * 4) | 0];
      ctx.fillRect(x + w * 0.12, oy + size * 0.09, w * 0.76, size * 0.08);
    }
  }
  if (!emissive) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(ox, oy + size * 0.92, size, size * 0.08);
  }
}

/** Flat surfaces: tarmac with lane markings, pavement, paving, decking. */
function drawSurface(ctx, ox, oy, size, kind) {
  const rnd = mulberry32(3300 + kind);
  const grain = (base, amount, count) => {
    for (let i = 0; i < count; i++) {
      ctx.fillStyle = `rgba(${base},${(rnd() * amount).toFixed(3)})`;
      ctx.fillRect(ox + rnd() * size, oy + rnd() * size, 1 + rnd() * 3, 1 + rnd() * 3);
    }
  };

  if (kind === TILE.ROAD_AVENUE || kind === TILE.ROAD_STREET) {
    ctx.fillStyle = '#33353a';
    ctx.fillRect(ox, oy, size, size);
    grain('255,255,255', 0.06, 1400);
    grain('0,0,0', 0.16, 900);
    const lanes = kind === TILE.ROAD_AVENUE ? [0.25, 0.5, 0.75] : [0.5];
    for (const u of lanes) {
      const solid = kind === TILE.ROAD_AVENUE && u === 0.5;
      ctx.fillStyle = solid ? 'rgba(228,206,120,0.85)' : 'rgba(226,228,232,0.75)';
      const w = size * 0.012;
      if (solid) {
        ctx.fillRect(ox + size * u - w * 1.6, oy, w, size);
        ctx.fillRect(ox + size * u + w * 0.6, oy, w, size);
      } else {
        for (let d = 0; d < 4; d++) ctx.fillRect(ox + size * u - w / 2, oy + d * (size / 4), w, size / 7);
      }
    }
    // Kerb edging.
    ctx.fillStyle = 'rgba(200,200,200,0.35)';
    ctx.fillRect(ox, oy, size * 0.01, size);
    ctx.fillRect(ox + size * 0.99, oy, size * 0.01, size);
    return;
  }

  if (kind === TILE.PAVEMENT) {
    ctx.fillStyle = '#8c8a85';
    ctx.fillRect(ox, oy, size, size);
    const n = 6;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = jitterHex(rnd, '#8c8a85', 0.06);
        ctx.fillRect(ox + i * (size / n) + 1, oy + j * (size / n) + 1, size / n - 2, size / n - 2);
      }
    }
    grain('0,0,0', 0.10, 700);
    return;
  }

  if (kind === TILE.PLAZA) {
    ctx.fillStyle = '#7b7770';
    ctx.fillRect(ox, oy, size, size);
    const n = 8;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const alt = (i + j) % 2 === 0;
        ctx.fillStyle = jitterHex(rnd, alt ? '#84806f' : '#6e6b66', 0.05);
        ctx.fillRect(ox + i * (size / n) + 1, oy + j * (size / n) + 1, size / n - 2, size / n - 2);
      }
    }
    return;
  }

  if (kind === TILE.PATH) {
    ctx.fillStyle = '#8a7f68';
    ctx.fillRect(ox, oy, size, size);
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = `rgba(${rnd() < 0.5 ? '120,110,92' : '160,150,126'},${0.2 + rnd() * 0.5})`;
      ctx.fillRect(ox + rnd() * size, oy + rnd() * size, 1 + rnd() * 3, 1 + rnd() * 3);
    }
    return;
  }

  if (kind === TILE.DECK) {
    ctx.fillStyle = '#6b573f';
    ctx.fillRect(ox, oy, size, size);
    const planks = 8;
    for (let i = 0; i < planks; i++) {
      ctx.fillStyle = jitterHex(rnd, '#6b573f', 0.13);
      ctx.fillRect(ox + i * (size / planks), oy, size / planks - 2, size);
      for (let g = 0; g < 30; g++) {
        ctx.fillStyle = `rgba(60,44,30,${0.06 + rnd() * 0.14})`;
        ctx.fillRect(ox + i * (size / planks), oy + rnd() * size, size / planks - 2, 1);
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let i = 0; i <= planks; i++) ctx.fillRect(ox + i * (size / planks) - 1, oy, 2, size);
    return;
  }

  if (kind === TILE.ROOF) {
    ctx.fillStyle = '#4c4e50';
    ctx.fillRect(ox, oy, size, size);
    grain('255,255,255', 0.09, 2200);
    grain('0,0,0', 0.20, 1600);
    ctx.strokeStyle = 'rgba(30,32,34,0.6)';
    ctx.lineWidth = 2;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(ox + i * (size / 4), oy);
      ctx.lineTo(ox + i * (size / 4), oy + size);
      ctx.stroke();
    }
    return;
  }

  // CONCRETE — plain precast panels for party walls and plant rooms.
  ctx.fillStyle = '#9a9791';
  ctx.fillRect(ox, oy, size, size);
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = jitterHex(rnd, '#9a9791', 0.05);
      ctx.fillRect(ox + i * (size / 4) + 2, oy + j * (size / 4) + 2, size / 4 - 4, size / 4 - 4);
    }
  }
  grain('0,0,0', 0.10, 900);
}

const FACADES = {
  [TILE.GLASS]: {
    seed: 11, wall: '#3b4a55', inset: 0.10, aspect: 0.78, litChance: 0.34,
    glassShades: ['#4d6f82', '#3f5f72', '#59808f', '#456876'],
    sheen: '#b8dcea', mullion: 'rgba(24,30,36,0.75)',
    lightColors: ['#ffe0ac', '#ffd28c', '#e8f0ff'],
  },
  [TILE.GLASS_ALT]: {
    seed: 12, wall: '#2f4450', inset: 0.06, aspect: 0.9, litChance: 0.28,
    glassShades: ['#3e6473', '#33545f', '#4a7280'],
    sheen: '#a6cfe0', mullion: 'rgba(20,26,32,0.65)',
    lightColors: ['#ffe6bc', '#dfeaff'],
  },
  [TILE.BRONZE]: {
    seed: 13, wall: '#3a3129', inset: 0.09, aspect: 0.85, litChance: 0.30,
    glassShades: ['#4e4032', '#5c4b3a', '#43372c'],
    sheen: '#c9a97e', mullion: 'rgba(28,22,16,0.8)',
    lightColors: ['#ffca7c', '#ffb95e'],
  },
  [TILE.OFFICE]: {
    seed: 14, wall: '#b3ada2', inset: 0.20, aspect: 0.72, litChance: 0.40,
    glassShades: ['#39454e', '#2f3a42', '#44505a'],
    sheen: '#9fbccb', mullion: 'rgba(240,238,232,0.5)',
    lightColors: ['#fff0cc', '#ffe4a8', '#dbe8ff'],
  },
  [TILE.BRICK]: {
    seed: 15, wall: '#7a4a3a', inset: 0.24, aspect: 0.86, litChance: 0.42,
    glassShades: ['#33383e', '#2a2f35', '#3c4249'],
    sheen: '#8fa6b6', mullion: 'rgba(225,218,205,0.55)',
    lightColors: ['#ffd89a', '#ffc47a'],
  },
  [TILE.DECO]: {
    seed: 16, wall: '#9d968a', inset: 0.22, aspect: 1.05, litChance: 0.33,
    glassShades: ['#2f3942', '#27303a', '#39434c'],
    sheen: '#a8c0d0', mullion: null, piers: 'rgba(178,170,158,0.85)',
    lightColors: ['#ffe3ae', '#ffd08a'],
  },
};

/** Brick needs its bond drawn under the windows, or it reads as flat plaster. */
function drawBrickBond(ctx, ox, oy, size) {
  const rnd = mulberry32(818);
  const rows = 40;
  const h = size / rows;
  for (let j = 0; j < rows; j++) {
    const offset = (j % 2) * h * 1.1;
    for (let x = -h * 2; x < size; x += h * 2.2) {
      ctx.fillStyle = jitterHex(rnd, '#7a4a3a', 0.14);
      ctx.fillRect(ox + x + offset, oy + j * h, h * 2.2 - 1.2, h - 1.2);
    }
  }
}

function makeCityAtlas(size = 1024, emissive = false) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const tile = size / ATLAS_COLUMNS;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);

  for (let index = 0; index < 16; index++) {
    const ox = (index % ATLAS_COLUMNS) * tile;
    const oy = ((index / ATLAS_COLUMNS) | 0) * tile;
    const facade = FACADES[index];
    if (facade) {
      if (index === TILE.BRICK && !emissive) drawBrickBond(ctx, ox, oy, tile);
      drawFacade(ctx, ox, oy, tile, facade, emissive);
    } else if (index === TILE.SHED) {
      drawShed(ctx, ox, oy, tile, emissive);
    } else if (index === TILE.PODIUM) {
      drawPodium(ctx, ox, oy, tile, emissive);
    } else if (!emissive) {
      drawSurface(ctx, ox, oy, tile, index);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Roads and pavements are almost always seen edge-on, which is exactly the
  // case anisotropic filtering exists for.
  tex.anisotropy = 8;
  // The shader wraps inside a tile itself, so the sampler must clamp.
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
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
    cityAtlas: makeCityAtlas(1024, false),
    cityLights: makeCityAtlas(1024, true),
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

// ---------------------------------------------------------------------------
// City props
// ---------------------------------------------------------------------------

/** A blunt little hatchback. Painted white so the instance colour decides. */
export function makeCar(seed = 1) {
  const rnd = mulberry32(seed + 4400);
  const parts = [];

  const body = new THREE.BoxGeometry(1.82, 0.66, 4.24);
  transform(body, { y: 0.72 });
  paint(body, '#ffffff', 0.02, rnd);
  parts.push(body);

  const cabin = new THREE.BoxGeometry(1.66, 0.62, 2.28);
  transform(cabin, { y: 1.34, z: -0.16 });
  paint(cabin, '#20262e', 0.05, rnd);
  parts.push(cabin);

  const skirt = new THREE.BoxGeometry(1.9, 0.30, 4.0);
  transform(skirt, { y: 0.40 });
  paint(skirt, '#15181c', 0.05, rnd);
  parts.push(skirt);

  for (const x of [-0.86, 0.86]) {
    for (const z of [-1.36, 1.42]) {
      const wheel = new THREE.BoxGeometry(0.18, 0.62, 0.62);
      transform(wheel, { x, y: 0.34, z });
      paint(wheel, '#0d0f12', 0.06, rnd);
      parts.push(wheel);
    }
  }
  return merge(parts);
}

/** Head and tail lights as their own geometry, driven by the same matrices. */
export function makeCarLights() {
  const rnd = mulberry32(9182);
  const parts = [];
  for (const x of [-0.62, 0.62]) {
    const head = new THREE.BoxGeometry(0.36, 0.20, 0.10);
    transform(head, { x, y: 0.80, z: -2.14 });
    paint(head, '#fff4d8', 0.0, rnd);
    parts.push(head);

    const tail = new THREE.BoxGeometry(0.34, 0.18, 0.10);
    transform(tail, { x, y: 0.86, z: 2.14 });
    paint(tail, '#ff3a24', 0.0, rnd);
    parts.push(tail);
  }
  return merge(parts);
}

/** Street lamp: a tapered column with a cranked arm. `reach` points +X. */
export function makeStreetLamp(height = 7.4, reach = 1.5) {
  const rnd = mulberry32(6161);
  const parts = [];

  const base = new THREE.CylinderGeometry(0.16, 0.22, 0.5, 6, 1, false);
  transform(base, { y: 0.25 });
  paint(base, '#3a3d42', 0.06, rnd);
  parts.push(base);

  const pole = new THREE.CylinderGeometry(0.075, 0.13, height, 6, 1, true);
  transform(pole, { y: height / 2 });
  paint(pole, '#4a4e55', 0.05, rnd);
  parts.push(pole);

  const arm = new THREE.BoxGeometry(reach, 0.10, 0.10);
  transform(arm, { x: reach / 2, y: height - 0.1 });
  paint(arm, '#4a4e55', 0.05, rnd);
  parts.push(arm);

  const hood = new THREE.BoxGeometry(0.52, 0.14, 0.26);
  transform(hood, { x: reach, y: height - 0.22 });
  paint(hood, '#2f3238', 0.05, rnd);
  parts.push(hood);

  return merge(parts);
}

/**
 * What a lamp contributes after dark: the glowing pane itself, and a pool of
 * light on the ground under it. The pool is what actually makes a night street
 * readable — it is an additive disc, which costs nothing next to a real light.
 */
export function makeLampGlow(height = 7.4, reach = 1.5) {
  const parts = [];
  const pane = new THREE.BoxGeometry(0.54, 0.10, 0.30);
  transform(pane, { x: reach, y: height - 0.32 });
  paint(pane, '#ffd9a0', 0.0, () => 0.5);
  parts.push(pane);

  const halo = new THREE.SphereGeometry(0.24, 6, 4);
  transform(halo, { x: reach, y: height - 0.32 });
  paint(halo, '#4a3416', 0.0, () => 0.5);
  parts.push(halo);

  const pool = new THREE.CircleGeometry(7.0, 14).rotateX(-Math.PI / 2);
  transform(pool, { x: reach, y: 0.14 });
  // Dim on its own: it is additive, and it stacks with its neighbours' pools.
  paint(pool, '#3a2812', 0.0, () => 0.5);
  parts.push(pool);

  return merge(parts);
}

/** A slab-sided air taxi: something to watch crossing the skyline at night. */
export function makeAirTaxi(seed = 3) {
  const rnd = mulberry32(seed + 771);
  const parts = [];

  const hull = new THREE.BoxGeometry(2.1, 1.0, 6.2);
  transform(hull, { y: 0.2 });
  paint(hull, '#2b3138', 0.06, rnd);
  parts.push(hull);

  const nose = new THREE.BoxGeometry(1.7, 0.7, 1.5);
  transform(nose, { y: 0.32, z: -3.3 });
  paint(nose, '#171b21', 0.06, rnd);
  parts.push(nose);

  for (const x of [-2.4, 2.4]) {
    const pod = new THREE.BoxGeometry(1.5, 0.42, 1.5);
    transform(pod, { x, y: 0.5, z: -0.6 });
    paint(pod, '#3a4149', 0.06, rnd);
    parts.push(pod);
    const strut = new THREE.BoxGeometry(Math.abs(x), 0.2, 0.42);
    transform(strut, { x: x / 2, y: 0.42, z: -0.6 });
    paint(strut, '#22272d', 0.06, rnd);
    parts.push(strut);
  }
  return merge(parts);
}

/** Navigation lights for the air taxis and the masts on the tall towers. */
export function makeBeacon(size = 0.5) {
  const g = new THREE.SphereGeometry(size, 6, 4);
  paint(g, '#ffffff', 0.0, () => 0.5);
  return g;
}

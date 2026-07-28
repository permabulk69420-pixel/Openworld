/**
 * Renders a top-down preview of the generated world to a PNG so the terrain can
 * be iterated on without opening a browser.
 *
 *   node tools/preview.mjs [size] [out.png]
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import { WORLD, heightAt, slopeAt, surfaceColor, moistureAt, biomeAt, riverDistanceAt, riverArcAt, riverSurfaceAt, RIVER_WIDTH } from '../src/world.js';
import { clamp } from '../src/noise.js';

const SIZE = parseInt(process.argv[2] || '512', 10);
const OUT = process.argv[3] || 'tools/preview.png';

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function writePNG(path, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

const px = Buffer.alloc(SIZE * SIZE * 3);
const step = WORLD.size / SIZE;
const col = [0, 0, 0];

// Sun for the hillshade.
const sun = [-0.55, 0.62, -0.56];
let minH = Infinity, maxH = -Infinity;
const heights = new Float32Array(SIZE * SIZE);

for (let j = 0; j < SIZE; j++) {
  const z = -WORLD.half + j * step;
  for (let i = 0; i < SIZE; i++) {
    const x = -WORLD.half + i * step;
    const h = heightAt(x, z);
    heights[j * SIZE + i] = h;
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
}

for (let j = 0; j < SIZE; j++) {
  const z = -WORLD.half + j * step;
  for (let i = 0; i < SIZE; i++) {
    const x = -WORLD.half + i * step;
    const h = heights[j * SIZE + i];
    const hl = heights[j * SIZE + Math.max(0, i - 1)];
    const hr = heights[j * SIZE + Math.min(SIZE - 1, i + 1)];
    const hd = heights[Math.max(0, j - 1) * SIZE + i];
    const hu = heights[Math.min(SIZE - 1, j + 1) * SIZE + i];
    const nx = hl - hr, nz = hd - hu, ny = 2 * step;
    const len = Math.hypot(nx, ny, nz) || 1;
    const light = clamp((nx / len) * sun[0] + (ny / len) * sun[1] + (nz / len) * sun[2], 0, 1);
    const shade = 0.45 + 0.75 * light;

    let r, g, b;
    const dRiver = riverDistanceAt(x, z);
    const riverSurf = riverSurfaceAt(riverArcAt(x, z));
    if (h < WORLD.seaLevel) {
      // Lake: depth-tinted blue.
      const t = clamp(-h / 12, 0, 1);
      r = 0.16 - 0.08 * t; g = 0.32 - 0.16 * t; b = 0.40 - 0.14 * t;
    } else if (dRiver < RIVER_WIDTH && h <= riverSurf + 0.4) {
      r = 0.20; g = 0.38; b = 0.44;
    } else {
      const slope = slopeAt(x, z, step);
      surfaceColor(x, z, h, slope, moistureAt(x, z, h), col);
      r = col[0] * shade; g = col[1] * shade; b = col[2] * shade;
    }
    const o = (j * SIZE + i) * 3;
    px[o] = clamp(Math.sqrt(r), 0, 1) * 255;
    px[o + 1] = clamp(Math.sqrt(g), 0, 1) * 255;
    px[o + 2] = clamp(Math.sqrt(b), 0, 1) * 255;
  }
}

// Mark the spawn point.
const sx = Math.round((WORLD.spawn.x + WORLD.half) / step);
const sz = Math.round((WORLD.spawn.z + WORLD.half) / step);
for (let dy = -3; dy <= 3; dy++) {
  for (let dx = -3; dx <= 3; dx++) {
    if (Math.abs(dx) + Math.abs(dy) > 4) continue;
    const i = sx + dx, j = sz + dy;
    if (i < 0 || j < 0 || i >= SIZE || j >= SIZE) continue;
    const o = (j * SIZE + i) * 3;
    px[o] = 255; px[o + 1] = 40; px[o + 2] = 60;
  }
}

writePNG(OUT, SIZE, SIZE, px);

// Quick statistics so bad parameter changes are obvious from the terminal.
let land = 0, water = 0, snow = 0, forest = 0;
for (let j = 0; j < SIZE; j += 2) {
  for (let i = 0; i < SIZE; i += 2) {
    const h = heights[j * SIZE + i];
    if (h < 0) water++; else land++;
    const x = -WORLD.half + i * step, z = -WORLD.half + j * step;
    const b = biomeAt(x, z, h);
    if (b === 8) snow++;
    if (b === 4) forest++;
  }
}
const total = land + water;
console.log(`wrote ${OUT} (${SIZE}x${SIZE})`);
console.log(`height range: ${minH.toFixed(1)}m .. ${maxH.toFixed(1)}m`);
console.log(`water ${(100 * water / total).toFixed(1)}%  forest ${(100 * forest / total).toFixed(1)}%  snow ${(100 * snow / total).toFixed(1)}%`);
console.log(`spawn height: ${heightAt(WORLD.spawn.x, WORLD.spawn.z).toFixed(2)}m`);

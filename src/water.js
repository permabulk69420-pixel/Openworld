/**
 * Water: the lake and its tarns, plus a ribbon that follows the river down
 * from the mountains.
 *
 * The still water is a mesh built only over the cells whose terrain sits below
 * the water line, so the shoreline is exact and nothing has to be clipped. The
 * river is a strip along the same spline the terrain was carved with, and its
 * surface steps down the valley.
 *
 * Depth is baked into a vertex attribute, which gives shallow/deep colouring
 * and shore foam for free.
 */

import * as THREE from 'three';
import {
  WORLD, VALLEY_HALF, heightAt, RIVER_PATH, RIVER_TOTAL, RIVER_WIDTH,
  riverSurfaceAt, waterSurfaceAt,
} from './world.js';
import { CITY } from './citymap.js';
import { clamp, smoothstep } from './noise.js';

/**
 * Where standing water is worth looking for. Scanning the whole 2.5 km world at
 * the resolution the shoreline needs would cost a second of load time for no
 * gain, so only the two basins that can actually hold water are searched.
 */
const BASINS = [
  { minX: -VALLEY_HALF, maxX: VALLEY_HALF, minZ: -VALLEY_HALF, maxZ: VALLEY_HALF },
  { minX: -WORLD.half, maxX: WORLD.half, minZ: CITY.shore - 60, maxZ: WORLD.half },
];

const VERT = /* glsl */`
  attribute float aDepth;
  attribute vec2 aFlow;
  varying float vDepth;
  varying vec2 vFlow;
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vDepth = aDepth;
    vFlow = aFlow;
    vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
    vWorld = worldPosition.xyz;
    vec4 mvPosition = viewMatrix * worldPosition;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform vec3 uFoamColor;
  uniform sampler2D uNoise;
  varying float vDepth;
  varying vec2 vFlow;
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_fragment>

  void main() {
    float flowLen = length( vFlow );
    vec2 flow = flowLen > 0.001 ? vFlow / flowLen : vec2( 0.32, 0.12 );
    float speed = 0.06 + flowLen * 0.75;

    // Three ripple layers, all small enough that the pattern reads as water
    // rather than as a texture.
    vec2 base = vWorld.xz * 0.22;
    vec2 uv1 = base + flow * uTime * speed;
    vec2 uv2 = base * 2.3 - flow * uTime * speed * 0.55 + vec2( 0.37, 0.11 );
    vec2 uv3 = base * 5.1 + flow * uTime * speed * 1.6 + vec2( 0.13, 0.71 );
    vec3 n1 = texture2D( uNoise, uv1 ).rgb;
    vec3 n2 = texture2D( uNoise, uv2 ).rgb;
    vec3 n3 = texture2D( uNoise, uv3 ).rgb;

    float rippleScale = 0.22 + flowLen * 0.55;
    vec3 nrm = normalize( vec3(
      ( n1.r + n2.g + n3.r - 1.5 ) * rippleScale,
      1.0,
      ( n1.g + n2.r + n3.g - 1.5 ) * rippleScale
    ) );

    vec3 viewDir = normalize( cameraPosition - vWorld );

    // Reflectivity comes from the flat surface, so it grades smoothly from
    // clear water at your feet to a mirror at the far shore. The ripples only
    // break up the highlight.
    float cosView = clamp( viewDir.y, 0.0, 1.0 );
    float fres = 0.02 + 0.98 * pow( 1.0 - cosView, 5.0 );

    vec3 halfVec = normalize( uSunDir + viewDir );
    float ndh = max( dot( nrm, halfVec ), 0.0 );
    float spec = pow( ndh, 220.0 );
    float glitter = pow( ndh, 40.0 ) * 0.10;

    float depthT = clamp( vDepth / 3.2, 0.0, 1.0 );
    vec3 col = mix( uShallowColor, uDeepColor, depthT );
    col = mix( col, uSkyColor, clamp( fres * 0.92, 0.0, 1.0 ) );
    col += uSunColor * ( spec * 1.1 + glitter );

    // Foam only right at the edge, and a little whitewater in the fast reaches.
    float shore = 1.0 - smoothstep( 0.0, 0.42, vDepth );
    float churn = texture2D( uNoise, base * 1.6 + flow * uTime * 0.8 ).r;
    float foam = smoothstep( 0.55, 1.0, shore * ( 0.5 + churn * 0.85 ) );
    foam += smoothstep( 0.75, 1.15, flowLen ) * smoothstep( 0.62, 0.95, churn ) * 0.35;
    col = mix( col, uFoamColor, clamp( foam, 0.0, 1.0 ) * 0.8 );

    float alpha = mix( 0.55, 0.94, depthT );
    alpha = clamp( max( alpha, foam ), 0.0, 1.0 );

    gl_FragColor = vec4( col, alpha );
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export class Water {
  constructor(scene, textures) {
    this.uniforms = {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.4) },
      uSunColor: { value: new THREE.Color(1, 0.96, 0.88) },
      uSkyColor: { value: new THREE.Color(0.45, 0.6, 0.8) },
      uDeepColor: { value: new THREE.Color(0.035, 0.085, 0.11) },
      uShallowColor: { value: new THREE.Color(0.12, 0.26, 0.26) },
      uFoamColor: { value: new THREE.Color(0.82, 0.88, 0.88) },
      uNoise: { value: textures.waterNoise },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
    });
    // merge() clones values, so wire our own (shared, live) uniforms back in.
    Object.assign(this.material.uniforms, this.uniforms);

    this.group = new THREE.Group();
    this.group.name = 'water';
    scene.add(this.group);

    this.still = new THREE.Mesh(buildStillWater(5), this.material);
    this.still.renderOrder = 2;
    this.group.add(this.still);

    this.river = new THREE.Mesh(buildRiver(), this.material);
    this.river.renderOrder = 2;
    this.group.add(this.river);

    // Open sea past the south edge of the map, so the bay runs out to the fog
    // instead of stopping at a cliff of nothing.
    this.ocean = new THREE.Mesh(buildOpenSea(), this.material);
    this.ocean.renderOrder = 2;
    this.group.add(this.ocean);
  }

  update(time) {
    this.uniforms.uTime.value = time;
  }

  /** Tie the water's palette to the current sky. */
  setSky(sunDir, sunColor, skyColor, ambient) {
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uSunColor.value.copy(sunColor);
    this.uniforms.uSkyColor.value.copy(skyColor);
    const dim = 0.35 + 0.65 * clamp(sunDir.y * 2 + 0.35, 0, 1);
    this.uniforms.uDeepColor.value.setRGB(0.028 * dim, 0.075 * dim, 0.10 * dim);
    this.uniforms.uShallowColor.value.setRGB(0.11 * dim, 0.24 * dim, 0.235 * dim);
    this.uniforms.uFoamColor.value.copy(ambient).lerp(new THREE.Color(0.85, 0.9, 0.9), 0.55);
  }
}

/**
 * Still water: a quad for every grid cell that has at least one corner below
 * the water line. Cells that stick out onto the bank are simply hidden by the
 * terrain drawn over them, which gives an exact shoreline for free.
 */
function buildStillWater(step = 5) {
  const n = Math.round(WORLD.size / step) + 1;
  const heights = new Float32Array(n * n).fill(9999);
  const cellRange = (basin) => ({
    i0: Math.max(0, Math.floor((basin.minX + WORLD.half) / step)),
    i1: Math.min(n - 1, Math.ceil((basin.maxX + WORLD.half) / step)),
    j0: Math.max(0, Math.floor((basin.minZ + WORLD.half) / step)),
    j1: Math.min(n - 1, Math.ceil((basin.maxZ + WORLD.half) / step)),
  });

  for (const basin of BASINS) {
    const { i0, i1, j0, j1 } = cellRange(basin);
    for (let j = j0; j <= j1; j++) {
      const z = -WORLD.half + j * step;
      for (let i = i0; i <= i1; i++) {
        heights[j * n + i] = heightAt(-WORLD.half + i * step, z);
      }
    }
  }

  const positions = [];
  const depths = [];
  const flows = [];
  const indices = [];
  const vertexIndex = new Int32Array(n * n).fill(-1);
  const level = WORLD.seaLevel;

  const addVertex = (i, j) => {
    const existing = vertexIndex[j * n + i];
    if (existing >= 0) return existing;
    const x = -WORLD.half + i * step;
    const z = -WORLD.half + j * step;
    const id = positions.length / 3;
    positions.push(x, level, z);
    depths.push(Math.max(0, level - heights[j * n + i]));
    flows.push(0, 0);
    vertexIndex[j * n + i] = id;
    return id;
  };

  for (const basin of BASINS) {
  const { i0, i1, j0, j1 } = cellRange(basin);
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      const h00 = heights[j * n + i];
      const h10 = heights[j * n + i + 1];
      const h01 = heights[(j + 1) * n + i];
      const h11 = heights[(j + 1) * n + i + 1];
      if (Math.min(h00, h10, h01, h11) >= level) continue;
      const a = addVertex(i, j);
      const b = addVertex(i + 1, j);
      const c = addVertex(i, j + 1);
      const d = addVertex(i + 1, j + 1);
      indices.push(a, c, b, b, c, d);
    }
  }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aDepth', new THREE.Float32BufferAttribute(depths, 1));
  geometry.setAttribute('aFlow', new THREE.Float32BufferAttribute(flows, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The sea beyond the map. A single coarse sheet at sea level, far enough out
 * that the fog swallows it long before its edge; the terrain occludes it
 * wherever the land is above the water line, so the shore stays exact.
 */
function buildOpenSea(reach = 8000, divisions = 28) {
  const z0 = WORLD.half - 6;
  const positions = [];
  const depths = [];
  const flows = [];
  const indices = [];
  const n = divisions + 1;

  for (let j = 0; j <= divisions; j++) {
    // Squared spacing: dense near the shore, enormous at the horizon.
    const t = j / divisions;
    const z = z0 + (reach - z0) * t * t;
    for (let i = 0; i <= divisions; i++) {
      const x = -reach + (2 * reach) * (i / divisions);
      positions.push(x, WORLD.seaLevel, z);
      depths.push(24);
      flows.push(0.10, 0.04);
    }
  }
  for (let j = 0; j < divisions; j++) {
    for (let i = 0; i < divisions; i++) {
      const a = j * n + i;
      indices.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aDepth', new THREE.Float32BufferAttribute(depths, 1));
  geometry.setAttribute('aFlow', new THREE.Float32BufferAttribute(flows, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/** A strip of water following the river spline, dropping as it descends. */
function buildRiver() {
  const positions = [];
  const depths = [];
  const flows = [];
  const indices = [];

  let arc = 0;
  const rows = [];
  for (let i = 0; i < RIVER_PATH.length; i++) {
    const p = RIVER_PATH[i];
    const prev = RIVER_PATH[Math.max(0, i - 1)];
    const next = RIVER_PATH[Math.min(RIVER_PATH.length - 1, i + 1)];
    if (i > 0) arc += Math.hypot(p[0] - prev[0], p[1] - prev[1]);

    let tx = next[0] - prev[0];
    let tz = next[1] - prev[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const nx = -tz, nz = tx;

    const t = arc / RIVER_TOTAL;
    const surface = riverSurfaceAt(arc);
    // Below this the lake mesh has it covered; stopping here avoids two water
    // surfaces fighting over the same stretch at the river mouth.
    if (surface < 0.4) break;
    const speed = (1 - smoothstep(0.1, 0.95, t)) * 0.9 + 0.25;

    // Find where the bed actually rises above the water on each side, so the
    // ribbon can never spill out over the grass on the bank.
    const edge = (side) => {
      let last = 0.8;
      for (let d = 0.8; d <= RIVER_WIDTH * 1.25; d += 0.5) {
        if (heightAt(p[0] + nx * d * side, p[1] + nz * d * side) >= surface - 0.03) break;
        last = d;
      }
      return last;
    };
    const left = edge(-1);
    const right = edge(1);

    // Left bank, middle, right bank — the centre row is what makes the channel
    // read as deep water instead of one flat shallow sheet.
    const row = [];
    for (const s of [-left, (right - left) * 0.5, right]) {
      const wx = p[0] + nx * s;
      const wz = p[1] + nz * s;
      positions.push(wx, surface, wz);
      depths.push(Math.max(0.02, surface - heightAt(wx, wz)));
      flows.push(tx * speed, tz * speed);
      row.push(positions.length / 3 - 1);
    }
    rows.push(row);
  }

  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    for (let s = 0; s < 2; s++) {
      indices.push(a[s], b[s], a[s + 1], a[s + 1], b[s], b[s + 1]);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aDepth', new THREE.Float32BufferAttribute(depths, 1));
  geometry.setAttribute('aFlow', new THREE.Float32BufferAttribute(flows, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Water surface height at a world position, or null on dry land. Used by the
 * player for wading and swimming.
 */
export function waterLevelAt(x, z, terrainHeight) {
  const surface = waterSurfaceAt(x, z);
  return terrainHeight < surface ? surface : null;
}

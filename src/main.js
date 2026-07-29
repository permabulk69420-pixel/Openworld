/**
 * Entry point: builds the world, then runs it.
 *
 * There are two places to be: the valley the project started as, and the city
 * on the plain south of it. They share one height field, one player, one
 * hoverboard and one sky — the road through the pass is the seam.
 *
 * Everything is generated while the start screen is still up, so pressing
 * "Enter VR" can go straight into an immersive session from the click — which
 * is what browsers require for XR.
 */

import * as THREE from 'three';
import { QUALITY } from './config.js';
import { WORLD, gridHeightAt, biomeAt, BIOME, riverDistanceAt, LAKE, RIVER_WIDTH } from './world.js';
import { CITY, CITY_BOUNDS, zoneAt, ZONE } from './citymap.js';
import { createTextures } from './assets.js';
import { createMaterials, createCityMaterials } from './materials.js';
import { City } from './city.js';
import { Terrain } from './terrain.js';
import { Scatter } from './scatter.js';
import { Water } from './water.js';
import { Sky } from './sky.js';
import { Atmosphere } from './particles.js';
import { Hoverboard } from './hoverboard.js';
import { Player } from './player.js';
import { Ambience } from './audio.js';
import { UI, WristPanel, resolveQuality, formatClock, formatCompass } from './ui.js';
import { clamp } from './noise.js';

const ui = new UI();
const qualityName = resolveQuality();
const quality = QUALITY[qualityName];

ui.bindQuality(qualityName, (value) => {
  localStorage.setItem('openworld.quality', value);
  const url = new URL(location.href);
  url.searchParams.set('q', value);
  location.href = url.toString();
});

// ---------------------------------------------------------------------------
// Renderer and scene
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({
  antialias: quality !== QUALITY.low,
  powerPreference: 'high-performance',
  stencil: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
// Far enough to reach the open sea, which has to run past the point where the
// fog is solid or the horizon shows a seam between water and sky.
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 9000);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

const state = {
  textures: null, materials: null, cityMaterials: null, terrain: null,
  scatter: null, water: null, sky: null, atmosphere: null, city: null,
  hoverboard: null, player: null, wrist: null,
};

const audio = new Ambience();

/** Per-frame CPU cost of everything except the draw call, in milliseconds. */
const perf = { update: 0, updateMax: 0 };

async function build() {
  ui.progress(0.02, 'Mixing pigments…');
  await nextFrame();
  state.textures = createTextures();
  state.materials = createMaterials(state.textures, quality);

  ui.progress(0.06, 'Raising the mountains…');
  await nextFrame();
  state.terrain = new Terrain(scene, quality, state.materials.terrain);
  state.terrain.refresh(WORLD.spawn.x, WORLD.spawn.z);

  // Build every chunk in view before the first frame so the horizon is complete.
  const total = Math.max(1, state.terrain.queue.length);
  while (state.terrain.processQueue(10) > 0) {
    const done = total - state.terrain.queue.length;
    ui.progress(0.06 + 0.26 * (done / total), `Raising the mountains… ${done}/${total}`);
    await nextFrame();
  }

  ui.progress(0.33, 'Filling the lake…');
  await nextFrame();
  state.water = new Water(scene, state.textures);

  ui.progress(0.40, 'Lighting the sky…');
  await nextFrame();
  state.sky = new Sky(scene, state.textures, 0.33);
  state.sky.setFogDensity(quality === QUALITY.low ? 0.0035 : quality === QUALITY.medium ? 0.0024 : 0.0017);

  state.cityMaterials = createCityMaterials(state.textures);
  state.city = new City(scene, state.textures, state.materials, state.cityMaterials, quality);
  await state.city.build(
    (fraction, text) => ui.progress(0.42 + 0.30 * fraction, text),
    nextFrame,
  );

  ui.progress(0.73, 'Planting the forest…');
  await nextFrame();
  state.scatter = new Scatter(scene, state.materials, quality, state.terrain.sampleSpacing);

  // Warm the fields around the spawn so nothing pops in on the first frame.
  for (let i = 0; i < 40; i++) {
    state.scatter.update(WORLD.spawn.x, WORLD.spawn.z, 12);
    const pending = state.scatter.fields.reduce((n, f) => n + f.pendingCells.length, 0);
    ui.progress(0.73 + 0.17 * clamp(1 - pending / 90, 0, 1), 'Planting the forest…');
    if (pending === 0) break;
    await nextFrame();
  }

  ui.progress(0.91, 'Charging the hoverboard…');
  await nextFrame();
  state.hoverboard = new Hoverboard(scene, state.terrain.sampleSpacing, {
    onNotice: (text) => ui.showNotice(text),
    city: state.city,
  });
  await state.hoverboard.load();

  ui.progress(0.97, 'Letting the wind in…');
  await nextFrame();
  state.atmosphere = new Atmosphere(scene, quality);
  state.player = new Player(renderer, camera, scene, {
    sampleSpacing: state.terrain.sampleSpacing,
    hoverboard: state.hoverboard,
    city: state.city,
    onNotice: (text) => ui.showNotice(text),
    onCycleTime: () => cycleTime(),
  });
  state.wrist = new WristPanel(state.player.grips[0]);

  ui.progress(1, 'Ready');
  ui.ready();
  renderer.setAnimationLoop(tick);
}

/**
 * Handle for poking at the world from the console or a test script:
 *   openworld.teleport(x, z, yaw)   openworld.downtown()   openworld.setTime(0.5)
 */
window.openworld = {
  THREE, scene, camera, renderer, state, quality, perf,
  teleport(x, z, yaw) {
    const ground = Math.max(
      gridHeightAt(x, z, state.terrain.sampleSpacing),
      state.city.solidHeightAt(x, z),
    );
    state.player.rig.position.set(x, ground, z);
    if (yaw !== undefined) state.player.yaw = yaw;
    state.terrain.refresh(x, z);
    while (state.terrain.processQueue(1000) > 0);
    for (let i = 0; i < 60; i++) state.scatter.update(x, z, 1000);
  },
  downtown() { this.teleport(CITY.x - 150, CITY.z + 30, Math.PI * 0.5); },
  pass() { this.teleport(-424, 506, Math.PI); },
  setTime(t) { state.sky.time = t; },
};

const TIME_PRESETS = ['dawn', 'morning', 'noon', 'afternoon', 'dusk', 'night'];
let timeIndex = 1;

function cycleTime() {
  timeIndex = (timeIndex + 1) % TIME_PRESETS.length;
  const name = TIME_PRESETS[timeIndex];
  state.sky.setPreset(name);
  ui.showNotice(name[0].toUpperCase() + name.slice(1));
}

// ---------------------------------------------------------------------------
// Session handling
// ---------------------------------------------------------------------------

async function checkXR() {
  if (!navigator.xr) {
    ui.enterVR.textContent = 'WebXR not available';
    ui.setNote('This browser has no WebXR support. The desktop view works everywhere; for the headset, open this page in the Quest browser over https.');
    return;
  }
  let supported = false;
  try {
    supported = await navigator.xr.isSessionSupported('immersive-vr');
  } catch (err) {
    supported = false;
  }
  if (supported) {
    ui.enterVR.disabled = false;
    ui.enterVR.textContent = 'Enter VR';
    ui.setNote('The hoverboard is waiting beside the spawn point. Press B to mount it, then follow the road south — the city is over the pass.');
  } else {
    ui.enterVR.textContent = 'No headset detected';
    ui.setNote('No immersive-vr device was reported. Open this page in the Quest browser over https, or use the desktop controls to test it.');
  }
}

ui.enterVR.addEventListener('click', async () => {
  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
    });
    await renderer.xr.setSession(session);
    if (renderer.xr.setFoveation) renderer.xr.setFoveation(quality === QUALITY.high ? 0.6 : 1.0);
    audio.start();
    ui.hideOverlay();
    session.addEventListener('end', () => ui.showOverlay());
  } catch (err) {
    ui.setNote(`Could not start the session: ${err.message}`);
  }
});

ui.enterDesktop.addEventListener('click', () => {
  audio.start();
  ui.hideOverlay();
  renderer.domElement.requestPointerLock?.();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM') {
    audio.setEnabled(!audio.enabled);
    ui.showNotice(`Sound ${audio.enabled ? 'on' : 'off'}`);
  }
});

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

const head = new THREE.Vector3();
const heading = new THREE.Vector3();
let elapsed = 0;
let fps = 0;
let fpsAccum = 0;
let fpsFrames = 0;

function surfaceUnder(x, z) {
  const zone = zoneAt(x, z).kind;
  if (zone !== ZONE.OUTSIDE && zone !== ZONE.PARK) return 'rock';
  // Standing on a roof or a pier counts as a hard surface too.
  if (state.city.solidHeightAt(x, z) > -Infinity) return 'rock';
  const h = gridHeightAt(x, z, state.terrain.sampleSpacing);
  const biome = biomeAt(x, z, h);
  if (biome === BIOME.SNOW) return 'snow';
  if (biome === BIOME.ROCK || biome === BIOME.ALPINE) return 'rock';
  if (biome === BIOME.SHORE) return 'rock';
  return 'grass';
}

/** 0 in open country, 1 deep in the city — drives ambience and particles. */
function urbanFactor(x, z) {
  const inside = x > CITY_BOUNDS.minX - 220 && x < CITY_BOUNDS.maxX + 220
    && z > CITY_BOUNDS.minZ - 220 && z < CITY_BOUNDS.maxZ + 220;
  if (!inside) return 0;
  const dx = Math.max(0, Math.abs(x - CITY.x) - CITY.halfX);
  const dz = Math.max(0, Math.abs(z - CITY.z) - CITY.halfZ);
  return clamp(1 - Math.hypot(dx, dz) / 220, 0, 1);
}

let lastFrameTime = 0;

function tick(timestamp) {
  // setAnimationLoop hands us the XR frame's timestamp while presenting.
  const now = timestamp === undefined ? performance.now() : timestamp;
  const dt = lastFrameTime ? Math.min((now - lastFrameTime) / 1000, 0.1) : 1 / 60;
  lastFrameTime = now;
  elapsed += dt;
  const frameStart = performance.now();

  state.player.update(dt, elapsed);
  state.hoverboard.update(dt, elapsed);
  state.player.headPosition(head);

  state.sky.update(dt, elapsed);
  state.sky.follow(head);
  state.materials.update(elapsed, 0.75 + 0.45 * Math.sin(elapsed * 0.19));
  state.materials.setSunColor(state.sky.sunColor, state.sky.ambientColor);

  state.water.update(elapsed);
  state.water.setSky(state.sky.sunDirection, state.sky.sunColor, state.sky.skyColor, state.sky.ambientColor);

  state.terrain.update(head.x, head.z, 3);
  state.scatter.update(head.x, head.z, 3);

  // Ambience needs to know how close the water is and what is underfoot.
  const px = state.player.rig.position.x;
  const pz = state.player.rig.position.z;
  const urban = urbanFactor(px, pz);

  state.atmosphere.update(elapsed, head, state.sky.daylight, 1 - urban);
  state.city.update(dt, elapsed, head, state.sky.daylight, state.sky.ambientColor);
  const lakeDistance = Math.max(0, Math.hypot(px - LAKE.x, pz - LAKE.z) - LAKE.radius * 0.92);
  const riverDistance = riverDistanceAt(px, pz) - RIVER_WIDTH;
  audio.update(dt, {
    time: elapsed,
    daylight: state.sky.daylight,
    altitude: state.player.rig.position.y,
    waterDistance: Math.min(lakeDistance, riverDistance),
    riverNear: riverDistance < 26,
    swimming: state.player.swimming,
    grounded: state.player.grounded,
    speed: state.player.speed,
    surface: state.player.swimming ? 'water' : surfaceUnder(px, pz),
    urban,
  });

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum > 0.5) {
    fps = Math.round(fpsFrames / fpsAccum);
    fpsAccum = 0;
    fpsFrames = 0;
    const place = state.city.placeName(px, pz);
    ui.setStats(
      `${fps} fps   ${qualityName}${state.hoverboard.mounted ? '   BOARD' : ''}\n` +
      `${formatClock(state.sky.time)}   ${Math.round(state.player.rig.position.y)} m` +
      `${place ? `   ${place}` : ''}\n` +
      `${state.scatter.instanceCount} instances   ${state.terrain.visibleChunks} chunks`,
    );
  }

  // Everything except the draw call itself — the budget that has to fit
  // inside a 90 Hz frame on the headset.
  perf.update = perf.update * 0.9 + (performance.now() - frameStart) * 0.1;
  perf.updateMax = Math.max(perf.updateMax, performance.now() - frameStart);

  state.player.headingVector(heading);
  state.wrist.update(dt, {
    clock: formatClock(state.sky.time),
    compass: formatCompass(heading),
    altitude: Math.round(state.player.rig.position.y),
    place: state.city.placeName(px, pz),
    fps: `${fps} fps`,
  });

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------

checkXR();
build().catch((err) => {
  console.error(err);
  ui.progress(1, `Something went wrong: ${err.message}`);
});

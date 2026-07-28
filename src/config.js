/**
 * Tunables. Quality presets scale terrain tessellation, foliage density and
 * view distance together; "medium" is what a Quest 3 wants.
 */

export const CHUNK_SIZE = 128;      // metres per terrain chunk
export const CHUNK_GRID = 8;        // 8 x 8 chunks = 1024 m world

export const QUALITY = {
  low: {
    name: 'Low',
    lodSegments: [32, 16, 8, 8],
    lodDistances: [200, 420, 720, Infinity],
    viewDistance: 700,
    fogNear: 40,
    fogFar: 420,
    treeDistance: 150,
    detailDistance: 60,
    grassRadius: 22,
    grassDensity: 0.35,
    scatterDensity: 0.55,
    shadows: false,
    pixelRatio: 1,
    particles: 0.4,
  },
  medium: {
    name: 'Medium',
    lodSegments: [64, 32, 16, 8],
    lodDistances: [210, 440, 760, Infinity],
    viewDistance: 900,
    fogNear: 60,
    fogFar: 620,
    treeDistance: 230,
    detailDistance: 90,
    grassRadius: 32,
    grassDensity: 0.7,
    scatterDensity: 0.85,
    shadows: true,
    pixelRatio: 1,
    particles: 0.75,
  },
  high: {
    name: 'High',
    lodSegments: [128, 64, 32, 16],
    lodDistances: [240, 500, 820, Infinity],
    viewDistance: 1400,
    fogNear: 80,
    fogFar: 820,
    treeDistance: 330,
    detailDistance: 130,
    grassRadius: 46,
    grassDensity: 1.0,
    scatterDensity: 1.0,
    shadows: true,
    pixelRatio: 1.5,
    particles: 1.0,
  },
};

export const PLAYER = {
  eyeHeight: 1.7,          // used for the desktop camera; in VR the headset supplies it
  walkSpeed: 3.4,
  sprintSpeed: 7.0,
  gravity: 22,
  jumpSpeed: 7.2,
  stepSmoothing: 12,       // how fast the rig eases onto the ground height
  maxSlope: 0.72,          // above this the ground is too steep to climb
  snapTurnDegrees: 45,
  smoothTurnSpeed: 100,    // degrees per second
  teleportRange: 22,
  deadZone: 0.18,
  waterDrag: 0.55,
  swimLevel: 1.25,         // rig height below the water line where you start swimming
};

/** Day length in seconds for a full 24 h cycle. */
export const DAY_LENGTH = 900;

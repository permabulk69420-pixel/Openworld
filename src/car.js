/**
 * The car: a ground vehicle for testing a model in the city.
 *
 * It drives on the terrain and the road, tilts to follow the ground under its
 * four wheels, and cannot drive through a building. It mounts and dismounts
 * through the same button as the hoverboard.
 *
 * The GLB is authored with the nose toward +Z; the rest of the game points
 * vehicles toward -Z, so the model is turned half a circle when it loads.
 */

import * as THREE from 'three';
import { CITY } from './citymap.js';
import { gridHeightAt } from './world.js';
import { waterLevelAt } from './water.js';
import { clamp, lerp } from './noise.js';

const MODEL_URL = './assets/models/car/midnight350.glb';
const LOADER_URL = 'https://cdn.jsdelivr.net/npm/three@0.185.0/examples/jsm/loaders/GLTFLoader.js';

const MOUNT_RANGE = 3.4;

// Measured from the model.
const WHEEL_RADIUS = 0.35;
const FRONT_AXLE = 1.31;     // metres ahead of the model origin
const REAR_AXLE = 1.34;      // metres behind it
const HALF_TRACK = 0.852;
const WHEELBASE = FRONT_AXLE + REAR_AXLE;
const HALF_LENGTH = 2.3;
const HALF_WIDTH = 1.2;
const STEP_HEIGHT = 0.55;    // a rise taller than this counts as a wall

const MAX_FORWARD = 36;
const MAX_REVERSE = -10;
const DRIVE = 13;
const REVERSE_DRIVE = 7;
const BRAKE = 28;

const _right = new THREE.Vector3();
const _eye = new THREE.Vector3();

export class Car {
  constructor(scene, sampleSpacing, options = {}) {
    this.scene = scene;
    this.sampleSpacing = sampleSpacing || 2;
    this.onNotice = options.onNotice || (() => {});
    this.city = options.city || null;

    this.group = new THREE.Group();
    this.group.name = 'carPhysicsRoot';
    this.visual = new THREE.Group();
    this.visual.name = 'carVisualRoot';
    this.group.add(this.visual);
    this.scene.add(this.group);

    this.loaded = false;
    this.mounted = false;
    this.forwardSpeed = 0;
    this.yaw = Math.PI;               // facing south, down the boulevard
    this.steerAngle = 0;
    this.wheelSpin = 0;
    this.wheels = {};
    this.steeringWheel = null;
    this.steeringWheelBase = new THREE.Quaternion();
    this.eyeOffset = new THREE.Vector3(0.427, 1.19, 0.365);
    this.rigOffset = new THREE.Vector3();
    this.bumped = 0;
  }

  async load() {
    try {
      const { GLTFLoader } = await import(/* @vite-ignore */ LOADER_URL);
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(MODEL_URL);
      const model = gltf.scene;
      model.rotation.y = Math.PI;

      model.traverse((node) => {
        if (node.isMesh) {
          node.castShadow = true;
          node.receiveShadow = true;
        }
        if (node.name === 'Front_Left_Wheel') this.wheels.fl = node;
        if (node.name === 'Front_Right_Wheel') this.wheels.fr = node;
        if (node.name === 'Rear_Left_Wheel') this.wheels.rl = node;
        if (node.name === 'Rear_Right_Wheel') this.wheels.rr = node;
        if (node.name === 'VR_SteeringWheel') this.steeringWheel = node;
      });

      for (const wheel of Object.values(this.wheels)) wheel.rotation.order = 'YXZ';
      if (this.steeringWheel) this.steeringWheelBase.copy(this.steeringWheel.quaternion);

      this.visual.add(model);
      this.group.updateMatrixWorld(true);
      const eye = model.getObjectByName('VR_DriverEye');
      if (eye) this.eyeOffset.copy(this.group.worldToLocal(eye.getWorldPosition(_eye)));

      this.loaded = true;
    } catch (error) {
      console.error('Car model failed to load:', error);
      this.onNotice('Car model failed to load');
      return;
    }

    // Park in the lane of the central boulevard, a block in from the north edge.
    const x = CITY.x - 5;
    const z = CITY.z - 102;
    this.group.position.set(x, this.surfaceY(x, z), z);
    this.group.rotation.y = this.yaw;
  }

  surfaceY(x, z) {
    const ground = gridHeightAt(x, z, this.sampleSpacing);
    const water = waterLevelAt(x, z, ground);
    const natural = water === null ? ground : Math.max(ground, water);
    if (!this.city) return natural;
    const built = this.city.solidHeightAt(x, z);
    return built > natural ? built : natural;
  }

  /** Offsets from the car's centre, in world space, for a point `ahead` and `side` of it. */
  point(x, z, yaw, ahead, side) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    return [x + fx * ahead + rx * side, z + fz * ahead + rz * side];
  }

  /** True if any corner of the car would be inside a wall at this spot. */
  blockedAt(x, z, yaw, y) {
    if (!this.city) return false;
    for (const ahead of [HALF_LENGTH, -HALF_LENGTH]) {
      for (const side of [HALF_WIDTH, -HALF_WIDTH]) {
        const [px, pz] = this.point(x, z, yaw, ahead, side);
        if (this.city.solidHeightAt(px, pz) > y + STEP_HEIGHT) return true;
      }
    }
    return false;
  }

  distanceTo(position) {
    const dx = position.x - this.group.position.x;
    const dy = position.y - this.group.position.y;
    const dz = position.z - this.group.position.z;
    return Math.hypot(dx, dy, dz);
  }

  canMount(position) {
    return this.loaded && !this.mounted && this.distanceTo(position) <= MOUNT_RANGE;
  }

  mount(player) {
    if (!this.canMount(player.rig.position)) return false;

    this.mounted = true;
    this.forwardSpeed = 0;
    this.steerAngle = 0;
    this.yaw = this.group.rotation.y;

    // Remember where the rig sits relative to the car so that the headset's own
    // movement is kept: the head starts at the driver's eye and can still lean.
    const cam = player.camera.position;
    player.rig.rotation.y = this.yaw;
    this.rigOffset.set(this.eyeOffset.x - cam.x, this.eyeOffset.y - cam.y, this.eyeOffset.z - cam.z);
    this.syncRider(player);
    this.onNotice('Car mounted');
    return true;
  }

  dismount(player) {
    if (!this.mounted) return;

    this.mounted = false;

    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const x = this.group.position.x + _right.x * 2.2;
    const z = this.group.position.z + _right.z * 2.2;

    player.rig.position.set(x, this.surfaceY(x, z), z);
    player.velocityY = 0;
    player.grounded = false;
    player.speed = 0;
    player.yaw = this.yaw;
    player.rig.rotation.y = this.yaw;
    this.onNotice('Car dismounted');
  }

  update(dt) {
    if (!this.loaded || this.mounted) return;
    // Nobody driving: stand on the handbrake and settle on the ground.
    this.step(dt, 0, 0, 3.5);
  }

  updateMounted(dt, controls, player) {
    if (!this.mounted) return;

    const throttle = clamp(controls.forward || 0, -1, 1);
    const steer = clamp((controls.steer || 0) + (controls.turn || 0), -1, 1);
    this.step(dt, throttle, steer, 0);

    this.syncRider(player);

    if (this.bumped) {
      this.bumped = 0;
      player.pulse('left', 0.5, 40);
      player.pulse('right', 0.5, 40);
    }

    player.speed = Math.abs(this.forwardSpeed);
    player.swimming = false;
    player.grounded = false;
    player.velocityY = 0;
  }

  step(dt, throttle, steer, handbrake) {
    // --- speed ---------------------------------------------------------
    if (throttle > 0.04) {
      const taper = 1 - Math.max(0, this.forwardSpeed) / MAX_FORWARD * 0.7;
      this.forwardSpeed += (this.forwardSpeed < 0 ? BRAKE : DRIVE * taper) * throttle * dt;
    } else if (throttle < -0.04) {
      this.forwardSpeed -= (this.forwardSpeed > 0 ? BRAKE : REVERSE_DRIVE) * -throttle * dt;
    }
    const drag = Math.abs(throttle) > 0.04 ? 0.08 : 0.5;
    this.forwardSpeed *= Math.exp(-(drag + handbrake) * dt);
    this.forwardSpeed = clamp(this.forwardSpeed, MAX_REVERSE, MAX_FORWARD);
    if (Math.abs(this.forwardSpeed) < 0.02 && Math.abs(throttle) < 0.04) this.forwardSpeed = 0;

    // --- steering: front wheels turn, the car pivots around the rear axle ---
    const speedRatio = clamp(Math.abs(this.forwardSpeed) / 30, 0, 1);
    const maxAngle = THREE.MathUtils.degToRad(lerp(32, 7, speedRatio));
    this.steerAngle = lerp(this.steerAngle, steer * maxAngle, 1 - Math.exp(-8 * dt));
    this.yaw -= (this.forwardSpeed / WHEELBASE) * Math.tan(this.steerAngle) * dt;

    // --- move, sliding along walls instead of stopping dead ------------
    const x0 = this.group.position.x;
    const z0 = this.group.position.z;
    const y = this.group.position.y;
    const step = this.forwardSpeed * dt;
    const nextX = x0 - Math.sin(this.yaw) * step;
    const nextZ = z0 - Math.cos(this.yaw) * step;

    if (!this.blockedAt(nextX, nextZ, this.yaw, y)) {
      this.group.position.x = nextX;
      this.group.position.z = nextZ;
    } else if (!this.blockedAt(nextX, z0, this.yaw, y)) {
      this.group.position.x = nextX;
      this.forwardSpeed *= 0.8;
      this.bumped = 1;
    } else if (!this.blockedAt(x0, nextZ, this.yaw, y)) {
      this.group.position.z = nextZ;
      this.forwardSpeed *= 0.8;
      this.bumped = 1;
    } else {
      this.forwardSpeed *= 0.2;
      this.bumped = 1;
    }

    // --- follow the ground under the four wheels ------------------------
    const { x, z } = this.group.position;
    const sample = (ahead, side) => {
      const [px, pz] = this.point(x, z, this.yaw, ahead, side);
      return this.surfaceY(px, pz);
    };
    const frontLeft = sample(FRONT_AXLE, -HALF_TRACK);
    const frontRight = sample(FRONT_AXLE, HALF_TRACK);
    const rearLeft = sample(-REAR_AXLE, -HALF_TRACK);
    const rearRight = sample(-REAR_AXLE, HALF_TRACK);
    const targetY = (frontLeft + frontRight + rearLeft + rearRight) / 4;
    const frontY = (frontLeft + frontRight) / 2;
    const rearY = (rearLeft + rearRight) / 2;
    const leftY = (frontLeft + rearLeft) / 2;
    const rightY = (frontRight + rearRight) / 2;

    this.group.position.y = lerp(this.group.position.y, targetY, 1 - Math.exp(-16 * dt));
    this.group.rotation.y = this.yaw;
    this.visual.rotation.x = lerp(this.visual.rotation.x, Math.atan2(frontY - rearY, WHEELBASE), 1 - Math.exp(-10 * dt));
    this.visual.rotation.z = lerp(this.visual.rotation.z, Math.atan2(rightY - leftY, HALF_TRACK * 2), 1 - Math.exp(-10 * dt));

    // --- wheels and steering wheel --------------------------------------
    this.wheelSpin += (this.forwardSpeed * dt) / WHEEL_RADIUS;
    for (const [key, wheel] of Object.entries(this.wheels)) {
      wheel.rotation.x = this.wheelSpin;
      wheel.rotation.y = key.startsWith('f') ? -this.steerAngle : 0;
    }
    if (this.steeringWheel) {
      this.steeringWheel.quaternion
        .copy(this.steeringWheelBase)
        .multiply(_spin.setFromAxisAngle(_zAxis, -this.steerAngle * 12));
    }
  }

  syncRider(player) {
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    const o = this.rigOffset;
    player.rig.position.set(
      this.group.position.x + o.x * c + o.z * s,
      this.group.position.y + o.y,
      this.group.position.z - o.x * s + o.z * c,
    );
    player.rig.rotation.y = this.yaw;
    player.yaw = this.yaw;
  }
}

const _zAxis = new THREE.Vector3(0, 0, 1);
const _spin = new THREE.Quaternion();

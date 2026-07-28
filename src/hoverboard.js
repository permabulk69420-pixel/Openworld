import * as THREE from 'three';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.185.0/examples/jsm/loaders/GLTFLoader.js';
import { WORLD, gridHeightAt } from './world.js';
import { waterLevelAt } from './water.js';
import { clamp, lerp } from './noise.js';

const MODEL_URL = './assets/models/hoverboard/Generic_Futuristic_Hoverboard.glb';
const HOVER_HEIGHT = 0.62;
const RIDER_FOOT_HEIGHT = 0.125;
const MOUNT_RANGE = 2.4;

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();

export class Hoverboard {
  constructor(scene, sampleSpacing, options = {}) {
    this.scene = scene;
    this.sampleSpacing = sampleSpacing || 2;
    this.onNotice = options.onNotice || (() => {});

    this.group = new THREE.Group();
    this.group.name = 'hoverboardPhysicsRoot';
    this.visual = new THREE.Group();
    this.visual.name = 'hoverboardVisualRoot';
    this.group.add(this.visual);
    this.scene.add(this.group);

    this.loaded = false;
    this.mounted = false;
    this.forwardSpeed = 0;
    this.verticalSpeed = 0;
    this.yaw = 0;
    this.glowMaterials = [];
    this._idlePhase = Math.random() * Math.PI * 2;
  }

  async load() {
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(MODEL_URL);
      const model = gltf.scene;
      model.name = model.name || 'Hoverboard';

      model.traverse((node) => {
        if (node.name.startsWith('COLLIDER_')) node.visible = false;
        if (!node.isMesh) return;

        node.castShadow = true;
        node.receiveShadow = true;

        if (node.name.startsWith('ThrusterGlow_')) {
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          node.material = materials.map((material) => {
            const clone = material.clone();
            if (clone.emissive) clone.emissive.setHex(0x54d8ff);
            clone.emissiveIntensity = 1.2;
            this.glowMaterials.push(clone);
            return clone;
          });
          if (node.material.length === 1) node.material = node.material[0];
        }
      });

      this.visual.add(model);
      this.loaded = true;
    } catch (error) {
      console.error('Hoverboard model failed to load:', error);
      this.visual.add(this.createFallbackModel());
      this.loaded = true;
      this.onNotice('Hoverboard model failed to load — using fallback');
    }

    const x = WORLD.spawn.x + 1.2;
    const z = WORLD.spawn.z - 1.5;
    this.group.position.set(x, this.surfaceY(x, z) + HOVER_HEIGHT, z);
    this.group.rotation.y = this.yaw;
  }

  createFallbackModel() {
    const root = new THREE.Group();
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(0.82, 0.10, 0.245),
      new THREE.MeshStandardMaterial({ color: 0x232832, roughness: 0.45, metalness: 0.55 }),
    );
    deck.position.y = 0.07;
    root.add(deck);

    const glowMaterial = new THREE.MeshStandardMaterial({
      color: 0x183040,
      emissive: 0x54d8ff,
      emissiveIntensity: 1.2,
      roughness: 0.25,
      metalness: 0.4,
    });
    this.glowMaterials.push(glowMaterial);

    for (const z of [-0.105, 0.105]) {
      const glow = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.025, 0.025), glowMaterial);
      glow.position.set(0, 0.02, z);
      root.add(glow);
    }

    return root;
  }

  surfaceY(x, z) {
    const ground = gridHeightAt(x, z, this.sampleSpacing);
    const water = waterLevelAt(x, z, ground);
    return water === null ? ground : Math.max(ground, water);
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
    this.verticalSpeed = 0;
    this.yaw = player.rig.rotation.y;
    this.group.rotation.y = this.yaw;
    this.syncRider(player);
    this.setGlow(2.2);
    this.onNotice('Hoverboard mounted');
    return true;
  }

  dismount(player) {
    if (!this.mounted) return;

    this.mounted = false;
    this.forwardSpeed *= 0.35;

    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const x = this.group.position.x + _right.x * 0.9;
    const z = this.group.position.z + _right.z * 0.9;
    const ground = gridHeightAt(x, z, this.sampleSpacing);

    player.rig.position.set(x, Math.max(ground, this.group.position.y), z);
    player.velocityY = Math.min(0, this.verticalSpeed);
    player.grounded = false;
    player.yaw = this.yaw;
    player.rig.rotation.y = this.yaw;
    this.onNotice('Hoverboard dismounted');
  }

  update(dt, elapsed) {
    if (!this.loaded || this.mounted) return;

    const surface = this.surfaceY(this.group.position.x, this.group.position.z);
    const targetY = surface + HOVER_HEIGHT + Math.sin(elapsed * 1.8 + this._idlePhase) * 0.035;
    this.group.position.y = lerp(this.group.position.y, targetY, 1 - Math.exp(-5 * dt));
    this.visual.rotation.x = lerp(this.visual.rotation.x, 0, 1 - Math.exp(-5 * dt));
    this.visual.rotation.z = lerp(this.visual.rotation.z, Math.sin(elapsed * 1.2) * 0.025, 1 - Math.exp(-4 * dt));
    this.setGlow(1.0 + Math.sin(elapsed * 3.0) * 0.15);
  }

  updateMounted(dt, controls, player) {
    if (!this.mounted) return;

    const throttle = clamp(controls.forward || 0, -1, 1);
    const steer = clamp((controls.steer || 0) + (controls.turn || 0), -1, 1);
    const lift = clamp(controls.lift || 0, 0, 1);
    const boost = !!controls.boost;

    const maxForward = boost ? 34 : 22;
    const maxReverse = -10;
    const acceleration = boost ? 26 : 17;
    const drag = Math.abs(throttle) > 0.04 ? 0.55 : 1.15;

    this.forwardSpeed += throttle * acceleration * dt;
    this.forwardSpeed *= Math.exp(-drag * dt);
    this.forwardSpeed = clamp(this.forwardSpeed, maxReverse, maxForward);

    const speedRatio = clamp(Math.abs(this.forwardSpeed) / 18, 0, 1);
    const turnRate = THREE.MathUtils.degToRad(95 - speedRatio * 28);
    this.yaw -= steer * turnRate * dt;

    _forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.group.position.addScaledVector(_forward, this.forwardSpeed * dt);
    this.group.position.x = clamp(this.group.position.x, -WORLD.half + 12, WORLD.half - 12);
    this.group.position.z = clamp(this.group.position.z, -WORLD.half + 12, WORLD.half - 12);

    const surface = this.surfaceY(this.group.position.x, this.group.position.z);
    const altitude = this.group.position.y - surface;
    let groundEffect = 0;

    if (altitude < 2.4) {
      const error = HOVER_HEIGHT - altitude;
      groundEffect = clamp(9.8 + error * 27 - this.verticalSpeed * 7.5, 0, 30);
    }

    const verticalAcceleration = -9.8 + groundEffect + lift * 18.5;
    this.verticalSpeed += verticalAcceleration * dt;
    this.verticalSpeed = clamp(this.verticalSpeed, -18, 15);
    this.group.position.y += this.verticalSpeed * dt;

    const minimumY = surface + 0.16;
    if (this.group.position.y < minimumY) {
      this.group.position.y = minimumY;
      this.verticalSpeed = Math.max(0, this.verticalSpeed);
    }

    this.group.rotation.y = this.yaw;
    const pitchTarget = THREE.MathUtils.degToRad(-throttle * 9 - clamp(this.forwardSpeed / maxForward, -1, 1) * 3);
    const rollTarget = THREE.MathUtils.degToRad(-steer * 14);
    this.visual.rotation.x = lerp(this.visual.rotation.x, pitchTarget, 1 - Math.exp(-6 * dt));
    this.visual.rotation.z = lerp(this.visual.rotation.z, rollTarget, 1 - Math.exp(-7 * dt));

    this.setGlow(1.3 + lift * 4.0 + speedRatio * 1.8 + (boost ? 1.4 : 0));
    this.syncRider(player);

    player.speed = Math.abs(this.forwardSpeed);
    player.swimming = false;
    player.grounded = false;
    player.velocityY = this.verticalSpeed;
  }

  syncRider(player) {
    player.rig.position.set(
      this.group.position.x,
      this.group.position.y + RIDER_FOOT_HEIGHT,
      this.group.position.z,
    );
    player.rig.rotation.y = this.yaw;
    player.yaw = this.yaw;
  }

  setGlow(intensity) {
    for (const material of this.glowMaterials) {
      if ('emissiveIntensity' in material) material.emissiveIntensity = intensity;
    }
  }
}

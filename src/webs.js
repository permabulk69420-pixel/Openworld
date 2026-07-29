/**
 * Dual trigger web shooters and a lightweight pendulum-style swing model.
 *
 * Each trigger fires from the matching controller. Hold to keep the tether,
 * release to detach. The player keeps their momentum after letting go, which is
 * the entire point of putting this system in the city rather than making it a
 * glorified grappling-hook teleport.
 */

import * as THREE from 'three';
import { PLAYER } from './config.js';
import { WORLD } from './world.js';
import { waterLevelAt } from './water.js';
import { clamp } from './noise.js';

const TRIGGER_THRESHOLD = 0.52;
const MAX_WEB_DISTANCE = 260;
const MIN_WEB_DISTANCE = 2.2;
const SPRING_STRENGTH = 25;
const RADIAL_DAMPING = 8.5;
const MAX_TETHER_ACCEL = 82;
const AIR_CONTROL = 9.5;
const COAST_CONTROL = 3.2;
const MAX_SWING_SPEED = 52;

const _origin = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _body = new THREE.Vector3();
const _toAnchor = new THREE.Vector3();
const _acceleration = new THREE.Vector3();
const _candidate = new THREE.Vector3();

export class WebShooter {
  constructor(scene, player) {
    this.scene = scene;
    this.player = player;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.near = 0.3;
    this.raycaster.far = MAX_WEB_DISTANCE;

    this.root = new THREE.Group();
    this.root.name = 'webSystem';
    scene.add(this.root);

    this.webs = {
      left: this.makeWeb(0xf2f5ff),
      right: this.makeWeb(0xffffff),
    };

    this.velocity = new THREE.Vector3();
    this.motionActive = false;
  }

  makeWeb(color) {
    const positions = new Float32Array(6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.name = 'webLine';
    line.visible = false;
    line.frustumCulled = false;
    line.renderOrder = 8;
    this.root.add(line);

    return {
      line,
      geometry,
      material,
      anchor: new THREE.Vector3(),
      ropeLength: 0,
      active: false,
      held: false,
      source: null,
      desktop: false,
    };
  }

  hasActiveWeb() {
    return this.webs.left.active || this.webs.right.active;
  }

  shouldSimulate() {
    return this.hasActiveWeb() || this.motionActive;
  }

  /** Update trigger edges and keep visible web lines attached to the hands. */
  updateInput(input, xr, mouseButtons) {
    const leftHeld = xr
      ? (input?.left?.values?.[0] || 0) >= TRIGGER_THRESHOLD
      : mouseButtons.has(0);
    const rightHeld = xr
      ? (input?.right?.values?.[0] || 0) >= TRIGGER_THRESHOLD
      : mouseButtons.has(2);

    this.updateHand('left', leftHeld, xr ? input?.left?.controller : this.player.camera, !xr);
    this.updateHand('right', rightHeld, xr ? input?.right?.controller : this.player.camera, !xr);
    this.updateLines();
  }

  updateHand(hand, held, source, desktop) {
    const web = this.webs[hand];
    web.source = source || web.source || this.player.camera;
    web.desktop = desktop;

    if (held && !web.held) this.fire(hand);
    if (!held && web.held) this.release(hand);
    web.held = held;
  }

  fire(hand) {
    const web = this.webs[hand];
    if (!web.source) return;

    this.rayFromSource(web.source, hand, web.desktop, _origin, _direction);
    this.raycaster.set(_origin, _direction);
    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    const hit = hits.find((candidate) => this.validHit(candidate));

    if (!hit) {
      this.player.pulse(hand, 0.12, 24);
      return;
    }

    web.anchor.copy(hit.point);
    web.ropeLength = Math.max(MIN_WEB_DISTANCE, hit.distance * 0.97);
    web.active = true;
    web.line.visible = true;
    this.player.pulse(hand, 0.48, 42);

    if (!this.motionActive) this.seedVelocity();
  }

  release(hand) {
    const web = this.webs[hand];
    if (!web.active) return;
    web.active = false;
    web.line.visible = false;
    this.player.pulse(hand, 0.16, 18);
  }

  releaseAll(cancelMomentum = false) {
    for (const hand of ['left', 'right']) {
      const web = this.webs[hand];
      web.active = false;
      web.held = false;
      web.line.visible = false;
    }
    if (cancelMomentum) this.cancelMotion();
  }

  cancelMotion() {
    this.motionActive = false;
    this.velocity.set(0, 0, 0);
  }

  seedVelocity() {
    const heading = this.player.headingVector(_direction);
    const horizontal = this.player.grounded ? this.player.speed : Math.max(this.player.speed, 2.5);
    this.velocity.set(heading.x * horizontal, this.player.velocityY, heading.z * horizontal);
    this.motionActive = true;
    this.player.grounded = false;
    this.player.swimming = false;
  }

  rayFromSource(source, hand, desktop, origin, direction) {
    source.getWorldPosition(origin);
    source.getWorldQuaternion(_quaternion);

    if (desktop) {
      _offset.set(hand === 'left' ? -0.18 : 0.18, -0.16, -0.26).applyQuaternion(_quaternion);
      origin.add(_offset);
      this.player.camera.getWorldDirection(direction);
    } else {
      direction.set(0, 0, -1).applyQuaternion(_quaternion);
    }
    direction.normalize();
  }

  validHit(hit) {
    const object = hit.object;
    if (!object || !object.visible || hit.distance < MIN_WEB_DISTANCE) return false;
    if (object.isLine || object.isPoints || object.isSprite || object.isInstancedMesh) return false;

    for (let node = object; node; node = node.parent) {
      if (node === this.root || node === this.player.rig || node === this.player.hoverboard?.group) return false;
      const name = (node.name || '').toLowerCase();
      if (/water|sky|atmosphere|particle|firefl|player|controller|hoverboard|websystem|webline/.test(name)) {
        return false;
      }
    }

    return true;
  }

  updateLines() {
    for (const hand of ['left', 'right']) {
      const web = this.webs[hand];
      if (!web.active || !web.source) continue;
      this.rayFromSource(web.source, hand, web.desktop, _origin, _direction);
      const positions = web.geometry.attributes.position.array;
      positions[0] = _origin.x;
      positions[1] = _origin.y;
      positions[2] = _origin.z;
      positions[3] = web.anchor.x;
      positions[4] = web.anchor.y;
      positions[5] = web.anchor.z;
      web.geometry.attributes.position.needsUpdate = true;
      web.geometry.computeBoundingSphere();
    }
  }

  /**
   * Advance the player's full 3D momentum while tethered or coasting after a
   * release. `moveIntent` is a world-space horizontal vector with length 0..1.
   */
  updatePhysics(dt, moveIntent, sprint) {
    const player = this.player;
    const active = this.hasActiveWeb();
    if (!this.motionActive) this.seedVelocity();

    dt = Math.min(dt, 0.05);
    const control = active ? AIR_CONTROL : COAST_CONTROL;
    _acceleration.set(moveIntent.x * control, -PLAYER.gravity, moveIntent.z * control);

    _body.copy(player.rig.position);
    _body.y += clamp(player.headHeight * 0.58, 0.82, 1.15);

    for (const web of Object.values(this.webs)) {
      if (!web.active) continue;
      _toAnchor.subVectors(web.anchor, _body);
      const distance = _toAnchor.length();
      if (distance < 1e-4) continue;
      _toAnchor.multiplyScalar(1 / distance);

      const stretch = Math.max(0, distance - web.ropeLength);
      const radialVelocity = this.velocity.dot(_toAnchor);
      const damping = Math.max(0, -radialVelocity) * RADIAL_DAMPING;
      const tension = clamp(stretch * SPRING_STRENGTH + damping, 0, MAX_TETHER_ACCEL);
      _acceleration.addScaledVector(_toAnchor, tension);
    }

    // Sprint gives slightly stronger directional control without secretly
    // changing rope length or turning the webs into winches.
    if (sprint) _acceleration.addScaledVector(moveIntent, 3.5);

    this.velocity.addScaledVector(_acceleration, dt);
    const drag = Math.exp(-(active ? 0.055 : 0.035) * dt);
    this.velocity.x *= drag;
    this.velocity.z *= drag;

    const speed = this.velocity.length();
    if (speed > MAX_SWING_SPEED) this.velocity.multiplyScalar(MAX_SWING_SPEED / speed);

    _candidate.copy(player.rig.position).addScaledVector(this.velocity, dt);
    _candidate.x = clamp(_candidate.x, -WORLD.half + 10, WORLD.half - 10);
    _candidate.z = clamp(_candidate.z, -WORLD.half + 10, WORLD.half - 10);

    // Buildings and steep terrain are solid. Try full horizontal movement, then
    // each axis separately so a glancing swing slides rather than stopping dead.
    const current = player.rig.position;
    const blocked = (x, z, y) => player.groundHeight(x, z) > y + 0.22;
    if (!blocked(_candidate.x, _candidate.z, _candidate.y)) {
      current.x = _candidate.x;
      current.z = _candidate.z;
    } else if (!blocked(_candidate.x, current.z, _candidate.y)) {
      current.x = _candidate.x;
      this.velocity.z *= 0.25;
    } else if (!blocked(current.x, _candidate.z, _candidate.y)) {
      current.z = _candidate.z;
      this.velocity.x *= 0.25;
    } else {
      this.velocity.x *= -0.12;
      this.velocity.z *= -0.12;
      player.pulse('left', 0.35, 34);
      player.pulse('right', 0.35, 34);
    }

    const ground = player.groundHeight(current.x, current.z);
    const water = waterLevelAt(current.x, current.z, ground);

    // Releasing over water drops back into the existing swimming controller.
    if (!active && water !== null && water > ground && _candidate.y <= water - PLAYER.swimLevel) {
      current.y = water - PLAYER.swimLevel;
      this.velocity.multiplyScalar(0.2);
      this.motionActive = false;
      player.velocityY = 0;
      player.speed = 0;
      player.swimming = true;
      player.grounded = false;
      return;
    }

    if (_candidate.y <= ground) {
      current.y = ground;
      if (this.velocity.y < 0) this.velocity.y = 0;
      player.grounded = true;
      player.swimming = false;

      if (!active) {
        this.cancelMotion();
        player.speed = 0;
        player.velocityY = 0;
        return;
      }
    } else {
      current.y = _candidate.y;
      player.grounded = false;
      player.swimming = false;
    }

    player.velocityY = this.velocity.y;
    player.speed = Math.hypot(this.velocity.x, this.velocity.z);
  }

  dispose() {
    this.releaseAll(true);
    for (const web of Object.values(this.webs)) {
      web.geometry.dispose();
      web.material.dispose();
    }
    this.root.removeFromParent();
  }
}

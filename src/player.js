/**
 * The player rig and everything that moves it.
 *
 * Quest 3 (or any WebXR controller with thumbsticks):
 *   left stick        walk, relative to where you are looking
 *   left grip         sprint
 *   left X            comfort vignette on/off
 *   left Y            cycle time of day
 *   right stick L/R   snap turn (or smooth turn, toggled with B)
 *   right trigger     hold for the teleport arc, release to jump there
 *   right A           jump
 *   right B           snap/smooth turn toggle
 *
 * Desktop (for anyone without a headset):
 *   W A S D + mouse, Shift sprint, Space jump, T time of day, V vignette
 *
 * The rig's origin is the player's feet; in VR the headset supplies the height
 * on top of that, so ducking and leaning are real.
 */

import * as THREE from 'three';
import { PLAYER } from './config.js';
import { WORLD, gridHeightAt, normalAt } from './world.js';
import { waterLevelAt } from './water.js';
import { clamp, lerp } from './noise.js';

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

const VIGNETTE_FRAG = /* glsl */`
  uniform float uStrength;
  uniform vec3 uColor;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize( vDir );
    // 0 straight ahead, 1 at the edge of vision.
    float edge = 1.0 - clamp( -d.z, 0.0, 1.0 );
    float a = smoothstep( 0.35, 0.95, edge ) * uStrength;
    if ( a < 0.003 ) discard;
    gl_FragColor = vec4( uColor, a );
  }
`;

const VIGNETTE_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

export class Player {
  constructor(renderer, camera, scene, options = {}) {
    this.renderer = renderer;
    this.camera = camera;
    this.scene = scene;
    this.onTimeCycle = options.onTimeCycle || (() => {});
    this.onNotice = options.onNotice || (() => {});
    this.sampleSpacing = options.sampleSpacing || 2;

    this.rig = new THREE.Group();
    this.rig.name = 'playerRig';
    this.rig.add(camera);
    scene.add(this.rig);

    this.velocityY = 0;
    this.grounded = true;
    this.swimming = false;
    this.turnMode = 'snap';
    this.vignetteEnabled = true;
    this.speed = 0;
    this.headHeight = PLAYER.eyeHeight;

    this._snapArmed = true;
    this._teleporting = false;
    this._teleportValid = false;
    this._teleportPoint = new THREE.Vector3();
    this._prevButtons = { left: [], right: [] };

    this.keys = new Set();
    this.yaw = options.yaw ?? 0;   // desktop look direction
    this.pitch = 0;
    this.pointerLocked = false;

    const spawnY = gridHeightAt(WORLD.spawn.x, WORLD.spawn.z, this.sampleSpacing);
    this.rig.position.set(WORLD.spawn.x, spawnY, WORLD.spawn.z);
    this.rig.rotation.y = this.yaw;
    camera.position.set(0, PLAYER.eyeHeight, 0);

    this.buildControllers();
    this.buildTeleportVisuals();
    this.buildVignette();
    this.bindDesktop();
  }

  // --- setup -------------------------------------------------------------

  buildControllers() {
    this.controllers = [];
    this.grips = [];
    const gripGeo = new THREE.CapsuleGeometry(0.022, 0.09, 4, 8);
    const ringGeo = new THREE.TorusGeometry(0.036, 0.008, 6, 16);
    const mat = new THREE.MeshLambertMaterial({ color: 0x2a2c33 });
    const accent = new THREE.MeshLambertMaterial({ color: 0x6f7a8a });

    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i);
      this.rig.add(controller);
      this.controllers.push(controller);

      const grip = this.renderer.xr.getControllerGrip(i);
      const body = new THREE.Mesh(gripGeo, mat);
      body.rotation.x = -Math.PI / 3;
      grip.add(body);
      const ring = new THREE.Mesh(ringGeo, accent);
      ring.position.set(0, 0.005, -0.03);
      ring.rotation.x = -Math.PI / 2.6;
      grip.add(ring);
      this.rig.add(grip);
      this.grips.push(grip);
    }
  }

  buildTeleportVisuals() {
    const points = new Float32Array(32 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(points, 3));
    this.arc = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0x9fd8ff, transparent: true, opacity: 0.85, depthTest: false,
    }));
    this.arc.frustumCulled = false;
    this.arc.renderOrder = 900;
    this.arc.visible = false;
    this.scene.add(this.arc);

    const marker = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.42, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false }),
    );
    const inner = new THREE.Mesh(
      new THREE.CircleGeometry(0.26, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x6fb8e8, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthTest: false }),
    );
    marker.add(ring, inner);
    marker.renderOrder = 901;
    marker.visible = false;
    this.marker = marker;
    this.scene.add(marker);
  }

  buildVignette() {
    this.vignetteUniforms = {
      uStrength: { value: 0 },
      uColor: { value: new THREE.Color(0x000000) },
    };
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 24, 16),
      new THREE.ShaderMaterial({
        vertexShader: VIGNETTE_VERT,
        fragmentShader: VIGNETTE_FRAG,
        uniforms: this.vignetteUniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.BackSide,
        fog: false,
      }),
    );
    mesh.renderOrder = 1000;
    mesh.frustumCulled = false;
    this.camera.add(mesh);
    this.vignette = mesh;
  }

  bindDesktop() {
    const canvas = this.renderer.domElement;
    this._onKeyDown = (e) => {
      this.keys.add(e.code);
      if (e.code === 'KeyT') this.onTimeCycle();
      if (e.code === 'KeyV') {
        this.vignetteEnabled = !this.vignetteEnabled;
        this.onNotice(`Comfort vignette ${this.vignetteEnabled ? 'on' : 'off'}`);
      }
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onMouseMove = (e) => {
      if (!this.pointerLocked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = clamp(this.pitch - e.movementY * 0.0022, -1.4, 1.4);
    };
    this._onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    };
    this._onCanvasClick = () => {
      if (!this.renderer.xr.isPresenting && !this.pointerLocked) canvas.requestPointerLock();
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    canvas.addEventListener('click', this._onCanvasClick);
  }

  // --- input -------------------------------------------------------------

  /** Collect thumbsticks and buttons from both hands, if a session is running. */
  readXRInput() {
    const session = this.renderer.xr.getSession();
    const state = { left: null, right: null };
    if (!session) return state;
    for (const source of session.inputSources) {
      const gp = source.gamepad;
      if (!gp || !source.handedness) continue;
      const axes = gp.axes.length >= 4 ? [gp.axes[2], gp.axes[3]] : [gp.axes[0] || 0, gp.axes[1] || 0];
      const buttons = gp.buttons.map((b) => b.pressed);
      const values = gp.buttons.map((b) => b.value);
      if (source.handedness === 'left') state.left = { axes, buttons, values, source, gamepad: gp };
      else if (source.handedness === 'right') state.right = { axes, buttons, values, source, gamepad: gp };
    }
    return state;
  }

  pressed(hand, index, state) {
    const h = state[hand];
    if (!h) return false;
    const now = !!h.buttons[index];
    const prev = this._prevButtons[hand][index];
    return now && !prev;
  }

  pulse(hand, intensity = 0.4, ms = 40) {
    const session = this.renderer.xr.getSession();
    if (!session) return;
    for (const source of session.inputSources) {
      if (source.handedness !== hand) continue;
      const act = source.gamepad && source.gamepad.hapticActuators && source.gamepad.hapticActuators[0];
      if (act && act.pulse) act.pulse(intensity, ms);
    }
  }

  // --- movement ----------------------------------------------------------

  /** World-space heading of the head, flattened to the ground plane. */
  headingVector(target) {
    this.camera.getWorldDirection(target);
    target.y = 0;
    if (target.lengthSq() < 1e-6) target.set(0, 0, -1);
    return target.normalize();
  }

  rotateAroundHead(angle) {
    this.camera.getWorldPosition(_v);
    _v2.subVectors(this.rig.position, _v);
    _v2.applyAxisAngle(UP, angle);
    this.rig.position.copy(_v).add(_v2);
    this.rig.rotation.y += angle;
  }

  groundHeight(x, z) {
    return gridHeightAt(x, z, this.sampleSpacing);
  }

  /** Can the player stand here? Blocks cliffs and deep water. */
  isWalkable(x, z) {
    if (Math.abs(x) > WORLD.half - 10 || Math.abs(z) > WORLD.half - 10) return false;
    const h = this.groundHeight(x, z);
    const water = waterLevelAt(x, z, h);
    if (water !== null && water - h > PLAYER.swimLevel * 0.8) return false;
    return 1 - normalAt(x, z, 1.5)[1] < PLAYER.maxSlope;
  }

  update(dt, elapsed) {
    const xr = this.renderer.xr.isPresenting;
    const input = xr ? this.readXRInput() : null;

    let moveX = 0, moveZ = 0, sprint = false, jump = false;

    if (xr && input) {
      if (input.left) {
        const [ax, ay] = input.left.axes;
        moveX = Math.abs(ax) > PLAYER.deadZone ? ax : 0;
        moveZ = Math.abs(ay) > PLAYER.deadZone ? ay : 0;
        sprint = !!input.left.buttons[1] || !!input.left.buttons[3];
        if (this.pressed('left', 4, input)) {
          this.vignetteEnabled = !this.vignetteEnabled;
          this.onNotice(`Comfort vignette ${this.vignetteEnabled ? 'on' : 'off'}`);
          this.pulse('left');
        }
        if (this.pressed('left', 5, input)) {
          this.onTimeCycle();
          this.pulse('left');
        }
      }
      if (input.right) {
        const [rx] = input.right.axes;
        if (this.turnMode === 'snap') {
          if (Math.abs(rx) > 0.7 && this._snapArmed) {
            this.rotateAroundHead(-Math.sign(rx) * THREE.MathUtils.degToRad(PLAYER.snapTurnDegrees));
            this._snapArmed = false;
            this.pulse('right', 0.3, 25);
          } else if (Math.abs(rx) < 0.35) {
            this._snapArmed = true;
          }
        } else if (Math.abs(rx) > PLAYER.deadZone) {
          this.rotateAroundHead(-rx * THREE.MathUtils.degToRad(PLAYER.smoothTurnSpeed) * dt);
        }
        if (this.pressed('right', 4, input)) jump = true;
        if (this.pressed('right', 5, input)) {
          this.turnMode = this.turnMode === 'snap' ? 'smooth' : 'snap';
          this.onNotice(`${this.turnMode === 'snap' ? 'Snap' : 'Smooth'} turning`);
          this.pulse('right');
        }
        this.updateTeleport(!!input.right.buttons[0]);
      } else {
        this.updateTeleport(false);
      }
      this._prevButtons.left = input.left ? input.left.buttons.slice() : [];
      this._prevButtons.right = input.right ? input.right.buttons.slice() : [];
    } else {
      // Desktop
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) moveZ -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) moveZ += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) moveX -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) moveX += 1;
      sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      jump = this.keys.has('Space');
      this.rig.rotation.y = this.yaw;
      this.camera.rotation.set(this.pitch, 0, 0);
      this.camera.position.y = this.headHeight;
      this.updateTeleport(false);
    }

    // Thumbstick forward is -1; screen forward is -Z.
    const forward = this.headingVector(_v);
    const right = _v2.copy(forward).cross(UP).normalize();

    let inputLen = Math.hypot(moveX, moveZ);
    if (inputLen > 1) { moveX /= inputLen; moveZ /= inputLen; inputLen = 1; }

    const base = sprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
    const speed = this.swimming ? base * 0.45 : base;
    const step = speed * dt * inputLen;

    if (step > 0) {
      const dirX = right.x * moveX - forward.x * moveZ;
      const dirZ = right.z * moveX - forward.z * moveZ;
      const len = Math.hypot(dirX, dirZ) || 1;
      const nx = this.rig.position.x + (dirX / len) * step;
      const nz = this.rig.position.z + (dirZ / len) * step;

      // Try the full step, then each axis on its own so walls don't stick.
      if (this.canStep(nx, nz)) {
        this.rig.position.x = nx;
        this.rig.position.z = nz;
      } else if (this.canStep(nx, this.rig.position.z)) {
        this.rig.position.x = nx;
      } else if (this.canStep(this.rig.position.x, nz)) {
        this.rig.position.z = nz;
      }
    }
    this.speed = step / Math.max(dt, 1e-4);

    // Vertical: gravity, ground following, water.
    const ground = this.groundHeight(this.rig.position.x, this.rig.position.z);
    const water = waterLevelAt(this.rig.position.x, this.rig.position.z, ground);
    const depth = water !== null ? water - ground : 0;
    this.swimming = depth > PLAYER.swimLevel;

    if (this.swimming) {
      const floatY = water - PLAYER.swimLevel;
      this.rig.position.y = lerp(this.rig.position.y, floatY, 1 - Math.exp(-4 * dt));
      this.velocityY = 0;
      this.grounded = false;
    } else {
      if (jump && this.grounded) {
        this.velocityY = PLAYER.jumpSpeed;
        this.grounded = false;
        this.pulse('right', 0.25, 20);
      }
      this.velocityY -= PLAYER.gravity * dt;
      let y = this.rig.position.y + this.velocityY * dt;
      if (y <= ground) {
        y = ground;
        this.velocityY = 0;
        this.grounded = true;
      } else if (y - ground < 0.02) {
        this.grounded = true;
      } else {
        this.grounded = false;
      }
      // Smooth out small rises so walking uphill is not a stair-step.
      if (this.grounded) {
        this.rig.position.y = lerp(this.rig.position.y, ground, 1 - Math.exp(-PLAYER.stepSmoothing * dt));
        if (Math.abs(this.rig.position.y - ground) < 0.01) this.rig.position.y = ground;
      } else {
        this.rig.position.y = y;
      }
    }

    this.updateVignette(dt, inputLen, sprint);
    this.headHeight = xr ? this.camera.position.y : PLAYER.eyeHeight;
  }

  /** Reject steps onto cliffs, but allow ordinary slopes and shallow water. */
  canStep(x, z) {
    if (Math.abs(x) > WORLD.half - 10 || Math.abs(z) > WORLD.half - 10) return false;
    if (this.swimming) return true;
    const here = this.rig.position.y;
    const there = this.groundHeight(x, z);
    if (there - here > 1.1) return false;         // too steep to climb
    return 1 - normalAt(x, z, 1.2)[1] < PLAYER.maxSlope || there < here;
  }

  // --- teleport ----------------------------------------------------------

  updateTeleport(active) {
    if (!active) {
      if (this._teleporting && this._teleportValid) {
        this.rig.position.x = this._teleportPoint.x;
        this.rig.position.z = this._teleportPoint.z;
        this.rig.position.y = this._teleportPoint.y;
        this.velocityY = 0;
        this.pulse('right', 0.6, 60);
      }
      this._teleporting = false;
      this.arc.visible = false;
      this.marker.visible = false;
      return;
    }

    this._teleporting = true;
    const controller = this.controllers[1] || this.controllers[0];
    if (!controller) return;

    controller.getWorldPosition(_v);
    controller.getWorldDirection(_v2).multiplyScalar(-1);   // -Z is forward

    const positions = this.arc.geometry.attributes.position;
    const steps = positions.count;
    const speed = 9.5;
    const gravity = 14;
    let hit = false;
    let px = _v.x, py = _v.y, pz = _v.z;
    const vx = _v2.x * speed, vy = _v2.y * speed, vz = _v2.z * speed;

    for (let i = 0; i < steps; i++) {
      const t = i * 0.055;
      const x = _v.x + vx * t;
      const y = _v.y + vy * t - 0.5 * gravity * t * t;
      const z = _v.z + vz * t;
      if (!hit) {
        const ground = this.groundHeight(x, z);
        if (y <= ground) {
          hit = true;
          px = x; py = ground; pz = z;
        } else {
          px = x; py = y; pz = z;
        }
      }
      positions.setXYZ(i, px, py, pz);
    }
    positions.needsUpdate = true;

    const range = Math.hypot(px - _v.x, pz - _v.z);
    const valid = hit && range < PLAYER.teleportRange && this.isWalkable(px, pz);
    this._teleportValid = valid;
    this._teleportPoint.set(px, py, pz);

    this.arc.visible = true;
    this.arc.material.color.setHex(valid ? 0x9fd8ff : 0xd86a6a);
    this.marker.visible = valid;
    if (valid) {
      const n = normalAt(px, pz, 1.2);
      this.marker.position.set(px, py + 0.06, pz);
      _q.setFromUnitVectors(UP, _v.set(n[0], n[1], n[2]));
      this.marker.quaternion.copy(_q);
    }
  }

  // --- comfort -----------------------------------------------------------

  updateVignette(dt, inputLen, sprint) {
    const target = this.vignetteEnabled
      ? clamp(inputLen * (sprint ? 0.62 : 0.42), 0, 1)
      : 0;
    const u = this.vignetteUniforms.uStrength;
    u.value = lerp(u.value, target, 1 - Math.exp(-9 * dt));
    this.vignette.visible = u.value > 0.004;
  }

  /** Head position in world space — used for the sky dome and audio. */
  headPosition(target) {
    return this.camera.getWorldPosition(target);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
  }
}

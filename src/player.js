/**
 * Player rig and deliberately minimal locomotion.
 *
 * Quest / WebXR on foot:
 *   left stick       move relative to head direction
 *   left grip        run
 *   right stick L/R  smooth turn
 *   A                jump
 *   B                mount nearby hoverboard
 *   Y                cycle time of day
 *
 * Quest / WebXR while mounted:
 *   left stick U/D   accelerate / reverse
 *   left stick L/R   steer
 *   right stick L/R  steer
 *   right trigger    upward thrust
 *   left grip        boost
 *   B                dismount
 *
 * Desktop:
 *   W A S D + mouse, Shift run/boost, Space jump/thrust, E mount/dismount
 *
 * The ground the player stands on is the terrain or the top of whatever the
 * city has built there, whichever is higher — so roofs, terraces and the piers
 * are all real floors, and a building wall is simply a step too tall to climb.
 */

import * as THREE from 'three';
import { PLAYER } from './config.js';
import { WORLD, gridHeightAt, normalAt } from './world.js';
import { waterLevelAt } from './water.js';
import { lerp } from './noise.js';

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class Player {
  constructor(renderer, camera, scene, options = {}) {
    this.renderer = renderer;
    this.camera = camera;
    this.scene = scene;
    this.sampleSpacing = options.sampleSpacing || 2;
    this.hoverboard = options.hoverboard || null;
    this.city = options.city || null;
    this.onNotice = options.onNotice || (() => {});
    this.onCycleTime = options.onCycleTime || (() => {});

    this.rig = new THREE.Group();
    this.rig.name = 'playerRig';
    this.rig.add(camera);
    scene.add(this.rig);

    this.velocityY = 0;
    this.grounded = true;
    this.swimming = false;
    this.speed = 0;
    this.headHeight = PLAYER.eyeHeight;
    this._prevButtons = { left: [], right: [] };

    this.keys = new Set();
    this.justPressedKeys = new Set();
    this.yaw = options.yaw ?? 0;
    this.pitch = 0;
    this.pointerLocked = false;

    const spawnY = gridHeightAt(WORLD.spawn.x, WORLD.spawn.z, this.sampleSpacing);
    this.rig.position.set(WORLD.spawn.x, spawnY, WORLD.spawn.z);
    this.rig.rotation.y = this.yaw;
    camera.position.set(0, PLAYER.eyeHeight, 0);

    this.buildControllers();
    this.bindDesktop();
  }

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

  bindDesktop() {
    const canvas = this.renderer.domElement;

    this._onKeyDown = (event) => {
      if (!event.repeat) this.justPressedKeys.add(event.code);
      this.keys.add(event.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
        event.preventDefault();
      }
    };

    this._onKeyUp = (event) => this.keys.delete(event.code);

    this._onMouseMove = (event) => {
      if (!this.pointerLocked) return;
      this.yaw -= event.movementX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - event.movementY * 0.0022, -1.4, 1.4);
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

  readXRInput() {
    const session = this.renderer.xr.getSession();
    const state = { left: null, right: null };
    if (!session) return state;

    for (const source of session.inputSources) {
      const gamepad = source.gamepad;
      if (!gamepad || !source.handedness) continue;

      const axes = gamepad.axes.length >= 4
        ? [gamepad.axes[2], gamepad.axes[3]]
        : [gamepad.axes[0] || 0, gamepad.axes[1] || 0];
      const buttons = gamepad.buttons.map((button) => button.pressed);
      const values = gamepad.buttons.map((button) => button.value);
      const handState = { axes, buttons, values };

      if (source.handedness === 'left') state.left = handState;
      if (source.handedness === 'right') state.right = handState;
    }

    return state;
  }

  pressed(hand, index, state) {
    const input = state[hand];
    if (!input) return false;
    return !!input.buttons[index] && !this._prevButtons[hand][index];
  }

  pulse(hand, intensity = 0.35, milliseconds = 35) {
    const session = this.renderer.xr.getSession();
    if (!session) return;

    for (const source of session.inputSources) {
      if (source.handedness !== hand) continue;
      const actuator = source.gamepad?.hapticActuators?.[0];
      actuator?.pulse?.(intensity, milliseconds);
    }
  }

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
    const terrain = gridHeightAt(x, z, this.sampleSpacing);
    if (!this.city) return terrain;
    const built = this.city.solidHeightAt(x, z);
    return built > terrain ? built : terrain;
  }

  toggleHoverboard() {
    if (!this.hoverboard) return;

    if (this.hoverboard.mounted) {
      this.hoverboard.dismount(this);
      return;
    }

    if (!this.hoverboard.mount(this)) {
      this.onNotice('Move closer to the hoverboard');
    }
  }

  finishInputFrame(input) {
    if (input) {
      this._prevButtons.left = input.left ? input.left.buttons.slice() : [];
      this._prevButtons.right = input.right ? input.right.buttons.slice() : [];
    }
    this.justPressedKeys.clear();
  }

  update(dt) {
    const xr = this.renderer.xr.isPresenting;
    const input = xr ? this.readXRInput() : null;

    const boardToggle = xr
      ? !!input?.right && this.pressed('right', 5, input)
      : this.justPressedKeys.has('KeyE');

    if (boardToggle) {
      this.toggleHoverboard();
      if (xr) this.pulse('right', 0.45, 45);
    }

    const timeToggle = xr
      ? !!input?.left && this.pressed('left', 5, input)
      : this.justPressedKeys.has('KeyT');
    if (timeToggle) this.onCycleTime();

    if (this.hoverboard?.mounted) {
      let forward = 0;
      let steer = 0;
      let turn = 0;
      let lift = 0;
      let boost = false;

      if (xr && input) {
        if (input.left) {
          const [x, y] = input.left.axes;
          steer = Math.abs(x) > PLAYER.deadZone ? x : 0;
          forward = Math.abs(y) > PLAYER.deadZone ? -y : 0;
          boost = !!input.left.buttons[1];
        }
        if (input.right) {
          const [x] = input.right.axes;
          turn = Math.abs(x) > PLAYER.deadZone ? x : 0;
          lift = input.right.values[0] || 0;
        }
      } else {
        if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) forward += 1;
        if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) forward -= 1;
        if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) steer -= 1;
        if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) steer += 1;
        lift = this.keys.has('Space') ? 1 : 0;
        boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
        this.camera.rotation.set(this.pitch, 0, 0);
        this.camera.position.y = this.headHeight;
      }

      this.hoverboard.updateMounted(dt, { forward, steer, turn, lift, boost }, this);
      this.headHeight = xr ? this.camera.position.y : PLAYER.eyeHeight;
      this.finishInputFrame(input);
      return;
    }

    let moveX = 0;
    let moveZ = 0;
    let sprint = false;
    let jump = false;

    if (xr && input) {
      if (input.left) {
        const [x, y] = input.left.axes;
        moveX = Math.abs(x) > PLAYER.deadZone ? x : 0;
        moveZ = Math.abs(y) > PLAYER.deadZone ? y : 0;
        sprint = !!input.left.buttons[1];
      }

      if (input.right) {
        const [turnX] = input.right.axes;
        if (Math.abs(turnX) > PLAYER.deadZone) {
          this.rotateAroundHead(-turnX * THREE.MathUtils.degToRad(PLAYER.smoothTurnSpeed) * dt);
        }
        jump = this.pressed('right', 4, input);
      }
    } else {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) moveZ -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) moveZ += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) moveX -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) moveX += 1;
      sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      jump = this.keys.has('Space');

      this.rig.rotation.y = this.yaw;
      this.camera.rotation.set(this.pitch, 0, 0);
      this.camera.position.y = this.headHeight;
    }

    const forward = this.headingVector(_v);
    const right = _v2.copy(forward).cross(UP).normalize();

    let inputLength = Math.hypot(moveX, moveZ);
    if (inputLength > 1) {
      moveX /= inputLength;
      moveZ /= inputLength;
      inputLength = 1;
    }

    const baseSpeed = sprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
    const moveSpeed = this.swimming ? baseSpeed * 0.45 : baseSpeed;
    const step = moveSpeed * dt * inputLength;

    if (step > 0) {
      const directionX = right.x * moveX - forward.x * moveZ;
      const directionZ = right.z * moveX - forward.z * moveZ;
      const length = Math.hypot(directionX, directionZ) || 1;
      const nextX = this.rig.position.x + (directionX / length) * step;
      const nextZ = this.rig.position.z + (directionZ / length) * step;

      if (this.canStep(nextX, nextZ)) {
        this.rig.position.x = nextX;
        this.rig.position.z = nextZ;
      } else if (this.canStep(nextX, this.rig.position.z)) {
        this.rig.position.x = nextX;
      } else if (this.canStep(this.rig.position.x, nextZ)) {
        this.rig.position.z = nextZ;
      }
    }

    this.speed = step / Math.max(dt, 1e-4);

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
      let nextY = this.rig.position.y + this.velocityY * dt;

      if (nextY <= ground) {
        nextY = ground;
        this.velocityY = 0;
        this.grounded = true;
      } else if (nextY - ground < 0.02) {
        this.grounded = true;
      } else {
        this.grounded = false;
      }

      if (this.grounded) {
        this.rig.position.y = lerp(
          this.rig.position.y,
          ground,
          1 - Math.exp(-PLAYER.stepSmoothing * dt),
        );
        if (Math.abs(this.rig.position.y - ground) < 0.01) this.rig.position.y = ground;
      } else {
        this.rig.position.y = nextY;
      }
    }

    this.headHeight = xr ? this.camera.position.y : PLAYER.eyeHeight;
    this.finishInputFrame(input);
  }

  canStep(x, z) {
    if (Math.abs(x) > WORLD.half - 10 || Math.abs(z) > WORLD.half - 10) return false;
    if (this.swimming) return true;

    const here = this.rig.position.y;
    const there = this.groundHeight(x, z);
    if (there - here > 1.1) return false;

    return 1 - normalAt(x, z, 1.2)[1] < PLAYER.maxSlope || there < here;
  }

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

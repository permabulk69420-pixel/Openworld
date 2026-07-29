/**
 * Small moving things: airborne motes (pollen by day, snow up high), fireflies
 * after dark, and birds circling over the valley.
 *
 * The motes live in a box that follows the player. All the motion — drift,
 * fall, turbulence and the wrap-around at the box edges — happens in the vertex
 * shader, so tens of thousands of particles cost nothing on the CPU.
 */

import * as THREE from 'three';
import { mulberry32, lerp, smoothstep } from './noise.js';
import { WORLD } from './world.js';

const MOTE_VERT = /* glsl */`
  uniform float uTime;
  uniform vec3 uOrigin;
  uniform vec3 uBox;
  uniform float uFall;
  uniform float uSize;
  uniform float uTurbulence;
  uniform vec2 uWind;
  attribute float aPhase;
  attribute float aScale;
  varying float vFade;
  varying float vPhase;

  void main() {
    vec3 p = position;
    float t = uTime + aPhase * 60.0;

    p.y -= uFall * t;
    p.x += uWind.x * t * 0.55 + sin( t * 0.6 + aPhase * 12.0 ) * uTurbulence;
    p.z += uWind.y * t * 0.55 + cos( t * 0.47 + aPhase * 9.0 ) * uTurbulence;
    p.y += sin( t * 0.9 + aPhase * 20.0 ) * uTurbulence * 0.4;

    // Keep the swarm centred on the viewer.
    p = mod( p - uOrigin + uBox * 0.5, uBox ) - uBox * 0.5 + uOrigin;

    vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
    float dist = -mvPosition.z;
    gl_PointSize = uSize * aScale * ( 260.0 / max( dist, 1.0 ) );
    gl_Position = projectionMatrix * mvPosition;

    // Fade out at the edge of the box so nothing pops in or out.
    vec3 d = abs( p - uOrigin ) / ( uBox * 0.5 );
    float edge = max( max( d.x, d.y ), d.z );
    vFade = 1.0 - smoothstep( 0.62, 1.0, edge );
    vPhase = aPhase;
  }
`;

const MOTE_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uPulse;
  varying float vFade;
  varying float vPhase;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = dot( c, c );
    if ( d > 0.25 ) discard;
    float a = ( 1.0 - smoothstep( 0.05, 0.25, d ) ) * vFade * uOpacity;
    float pulse = mix( 1.0, 0.35 + 0.65 * pow( abs( sin( uTime * 1.7 + vPhase * 30.0 ) ), 3.0 ), uPulse );
    if ( a * pulse < 0.01 ) discard;
    gl_FragColor = vec4( uColor, a * pulse );
  }
`;

export class Motes {
  constructor(scene, options = {}) {
    const count = Math.max(16, Math.round(options.count || 600));
    const box = options.box || new THREE.Vector3(70, 28, 70);
    const rnd = mulberry32(options.seed || 5);

    const positions = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const scales = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rnd() - 0.5) * box.x;
      positions[i * 3 + 1] = (rnd() - 0.5) * box.y;
      positions[i * 3 + 2] = (rnd() - 0.5) * box.z;
      phases[i] = rnd();
      scales[i] = 0.55 + rnd() * 0.85;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));

    this.uniforms = {
      uTime: { value: 0 },
      uOrigin: { value: new THREE.Vector3() },
      uBox: { value: box.clone() },
      uFall: { value: options.fall ?? 0.15 },
      uSize: { value: options.size ?? 0.06 },
      uTurbulence: { value: options.turbulence ?? 0.6 },
      uWind: { value: new THREE.Vector2(0.4, 0.2) },
      uColor: { value: new THREE.Color(options.color || 0xffffff) },
      uOpacity: { value: options.opacity ?? 0.5 },
      uPulse: { value: options.pulse ?? 0 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: options.blending ?? THREE.NormalBlending,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  update(time, origin, wind) {
    this.uniforms.uTime.value = time;
    this.uniforms.uOrigin.value.copy(origin);
    if (wind) this.uniforms.uWind.value.copy(wind);
  }

  set opacity(v) { this.uniforms.uOpacity.value = v; }
  get opacity() { return this.uniforms.uOpacity.value; }
}

/**
 * A handful of birds riding a thermal over the valley. All of them live in one
 * geometry that is rewritten each frame — a few hundred floats, one draw call.
 */
export class Birds {
  constructor(scene, count = 9, center = new THREE.Vector3(96, 0, -36)) {
    this.count = count;
    this.center = center.clone();
    this.birds = [];
    const rnd = mulberry32(4711);
    for (let i = 0; i < count; i++) {
      this.birds.push({
        radius: 45 + rnd() * 150,
        height: 42 + rnd() * 46,
        speed: 0.09 + rnd() * 0.10,
        phase: rnd() * Math.PI * 2,
        flap: 2.2 + rnd() * 2.4,
        size: 0.7 + rnd() * 0.8,
        bob: rnd() * Math.PI * 2,
      });
    }

    const positions = new Float32Array(count * 6 * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry = geometry;
    this.mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color: 0x2b2f33, side: THREE.DoubleSide, fog: true, transparent: true, opacity: 0.85,
    }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(time) {
    const pos = this.geometry.attributes.position;
    const arr = pos.array;
    let o = 0;
    for (const b of this.birds) {
      const a = b.phase + time * b.speed;
      const x = this.center.x + Math.cos(a) * b.radius;
      const z = this.center.z + Math.sin(a) * b.radius;
      const y = b.height + Math.sin(time * 0.3 + b.bob) * 4;
      // Heading along the circle.
      const hx = -Math.sin(a), hz = Math.cos(a);
      const wx = -hz, wz = hx;                     // wing axis
      const flap = Math.sin(time * b.flap + b.phase);
      const wingY = flap * 0.55 * b.size;
      const span = b.size * (1.6 - Math.abs(flap) * 0.35);

      // Two triangles meeting at the body, tips rising and falling.
      const bx = x + hx * b.size * 0.5, bz = z + hz * b.size * 0.5;
      const tx = x - hx * b.size * 0.9, tz = z - hz * b.size * 0.9;
      const lx = x + wx * span, lz = z + wz * span;
      const rx = x - wx * span, rz = z - wz * span;

      arr[o++] = bx; arr[o++] = y; arr[o++] = bz;
      arr[o++] = tx; arr[o++] = y; arr[o++] = tz;
      arr[o++] = lx; arr[o++] = y + wingY; arr[o++] = lz;

      arr[o++] = bx; arr[o++] = y; arr[o++] = bz;
      arr[o++] = rx; arr[o++] = y + wingY; arr[o++] = rz;
      arr[o++] = tx; arr[o++] = y; arr[o++] = tz;
    }
    pos.needsUpdate = true;
  }
}

/**
 * Owns the weather-ish particle mix and decides what should be in the air
 * based on where the player is standing and what time it is.
 */
export class Atmosphere {
  constructor(scene, quality) {
    const density = quality.particles;
    this.dust = new Motes(scene, {
      count: 520 * density,
      box: new THREE.Vector3(64, 26, 64),
      color: 0xf2e6c8,
      size: 0.055,
      fall: 0.10,
      turbulence: 0.9,
      opacity: 0.0,
      seed: 11,
    });
    this.snow = new Motes(scene, {
      count: 900 * density,
      box: new THREE.Vector3(80, 34, 80),
      color: 0xffffff,
      size: 0.10,
      fall: 1.5,
      turbulence: 1.6,
      opacity: 0.0,
      seed: 23,
    });
    this.fireflies = new Motes(scene, {
      count: 220 * density,
      box: new THREE.Vector3(52, 12, 52),
      color: 0xc8ff8a,
      size: 0.085,
      fall: -0.05,
      turbulence: 1.5,
      opacity: 0.0,
      pulse: 1,
      blending: THREE.AdditiveBlending,
      seed: 37,
    });
    this.birds = new Birds(scene, Math.max(4, Math.round(9 * density)));
    this._wind = new THREE.Vector2(0.86, 0.5);
  }

  /**
   * @param {number} time seconds
   * @param {THREE.Vector3} head world position of the viewer
   * @param {number} daylight 0..1
   * @param {number} wild 1 in open country, 0 in the middle of the city
   */
  update(time, head, daylight, wild = 1) {
    const altitude = head.y;
    const snowiness = smoothstep(WORLD.snowLine - 26, WORLD.snowLine + 4, altitude);
    const lowland = 1 - smoothstep(30, 62, altitude);

    this.dust.update(time, head, this._wind);
    this.snow.update(time, head, this._wind);
    this.fireflies.update(time, head, this._wind);
    this.birds.update(time);

    this.dust.opacity = lerp(this.dust.opacity, (1 - snowiness) * daylight * 0.34, 0.05);
    this.snow.opacity = lerp(this.snow.opacity, snowiness * 0.55, 0.05);
    this.fireflies.opacity = lerp(this.fireflies.opacity, (1 - daylight) * lowland * wild * 0.85, 0.03);
    this.birds.mesh.visible = daylight > 0.15;
  }
}

/**
 * Sky, weather-ish atmosphere and the lighting that follows from it.
 *
 * One inward-facing sphere runs a shader that draws the gradient, the sun, the
 * moon, drifting clouds, stars and — after dark — an aurora over the northern
 * peaks. The CPU side works out the palette for the current time of day and
 * drives the scene lights, fog colour and the water's tint from it.
 */

import * as THREE from 'three';
import { DAY_LENGTH } from './config.js';
import { clamp, lerp, smoothstep } from './noise.js';

const VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mvPosition;
    gl_Position.z = gl_Position.w;   // always at the far plane
  }
`;

const FRAG = /* glsl */`
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uMoonDir;
  uniform vec3 uCloudColor;
  uniform vec3 uCloudDark;
  uniform float uTime;
  uniform float uStars;
  uniform float uAurora;
  uniform float uCloudCover;
  uniform sampler2D uClouds;
  varying vec3 vDir;

  float hash21( vec2 p ) {
    p = fract( p * vec2( 233.34, 851.73 ) );
    p += dot( p, p + 23.45 );
    return fract( p.x * p.y );
  }

  void main() {
    vec3 dir = normalize( vDir );
    float up = dir.y;

    // Base gradient: haze at the horizon fading to deep sky overhead.
    float t = pow( clamp( up * 0.5 + 0.5, 0.0, 1.0 ), 0.62 );
    vec3 col = mix( uHorizon, uZenith, smoothstep( 0.5, 1.0, t ) );
    col = mix( uGround, col, smoothstep( -0.09, 0.05, up ) );

    // Glow around the sun, strongest near the horizon.
    float sunAngle = max( dot( dir, uSunDir ), 0.0 );
    col += uSunColor * pow( sunAngle, 6.0 ) * 0.28;
    col += uSunColor * pow( sunAngle, 220.0 ) * 1.4;
    float disc = smoothstep( 0.9985, 0.9992, sunAngle );
    col = mix( col, uSunColor * 2.4, disc * clamp( uSunDir.y * 6.0 + 0.6, 0.0, 1.0 ) );

    // Moon.
    float moonAngle = max( dot( dir, uMoonDir ), 0.0 );
    float moonDisc = smoothstep( 0.9990, 0.9995, moonAngle );
    col += vec3( 0.75, 0.80, 0.92 ) * moonDisc * uStars;
    col += vec3( 0.30, 0.36, 0.52 ) * pow( moonAngle, 320.0 ) * uStars * 0.7;

    // Stars: a sparse hash over the projected sky, twinkling slowly.
    if ( uStars > 0.01 && up > -0.02 ) {
      vec2 sp = dir.xz / max( 0.12, abs( dir.y ) + 0.35 ) * 34.0;
      vec2 cell = floor( sp );
      float h = hash21( cell );
      if ( h > 0.972 ) {
        vec2 f = fract( sp ) - 0.5 - ( vec2( hash21( cell + 3.1 ), hash21( cell + 7.7 ) ) - 0.5 ) * 0.6;
        float d = length( f );
        float twinkle = 0.55 + 0.45 * sin( uTime * 1.7 + h * 90.0 );
        float star = smoothstep( 0.16, 0.0, d ) * ( h - 0.972 ) * 34.0 * twinkle;
        col += vec3( 0.85, 0.88, 1.0 ) * star * uStars * smoothstep( -0.02, 0.18, up );
      }
    }

    // Aurora over the northern sky.
    if ( uAurora > 0.01 && up > 0.0 ) {
      float az = atan( dir.x, -dir.z );
      float northward = exp( -az * az / 1.25 );
      float band = smoothstep( 0.02, 0.30, up ) * ( 1.0 - smoothstep( 0.35, 0.85, up ) );
      float wobble = sin( az * 5.0 + uTime * 0.13 ) * 0.35 + sin( az * 11.0 - uTime * 0.08 ) * 0.18;
      float curtain = abs( sin( az * 7.5 + wobble * 2.0 + uTime * 0.05 ) );
      curtain = pow( curtain, 3.0 );
      float rays = 0.55 + 0.45 * sin( az * 90.0 + uTime * 0.4 + up * 40.0 );
      float a = northward * band * curtain * rays * uAurora;
      vec3 auroraCol = mix( vec3( 0.15, 0.85, 0.55 ), vec3( 0.45, 0.35, 0.9 ), smoothstep( 0.05, 0.55, up ) );
      col += auroraCol * a * 0.85;
    }

    // Clouds, projected onto a plane well above the valley.
    if ( up > 0.01 ) {
      vec2 cuv = dir.xz / up * 0.055;
      float drift = uTime * 0.0032;
      float c1 = texture2D( uClouds, cuv * 0.5 + vec2( drift, drift * 0.55 ) ).a;
      float c2 = texture2D( uClouds, cuv * 1.13 - vec2( drift * 1.7, drift * 0.4 ) ).a;
      float cloud = clamp( ( c1 * 0.65 + c2 * 0.55 ) * uCloudCover - 0.12, 0.0, 1.0 );
      cloud *= smoothstep( 0.01, 0.16, up );
      vec3 cc = mix( uCloudDark, uCloudColor, clamp( c1 * 1.4, 0.0, 1.0 ) );
      // Sunlit rim on the side facing the sun.
      cc += uSunColor * pow( sunAngle, 8.0 ) * 0.35;
      col = mix( col, cc, cloud );
    }

    gl_FragColor = vec4( col, 1.0 );
    #include <colorspace_fragment>
  }
`;

/** Palette keyframes for the day. Each entry is keyed by sun elevation. */
const c = (hex) => new THREE.Color(hex);
const MOONLIGHT = c('#8fa2c8');
const PALETTE = [
  { e: -1.00, zenith: c('#04060f'), horizon: c('#0a1020'), sun: c('#26304a'), amb: c('#12182c'), ground: c('#05070d'), cloud: c('#20283c'), cloudDark: c('#10141f'), intensity: 0.10 },
  { e: -0.18, zenith: c('#0b1330'), horizon: c('#243352'), sun: c('#4a5273'), amb: c('#1d2740'), ground: c('#0a0f1c'), cloud: c('#39435c'), cloudDark: c('#1c2233'), intensity: 0.18 },
  { e: -0.04, zenith: c('#1d2f5c'), horizon: c('#a86a52'), sun: c('#ff8a4a'), amb: c('#4a4257'), ground: c('#1a1a20'), cloud: c('#c78a6c'), cloudDark: c('#4a3a44'), intensity: 0.45 },
  { e: 0.08, zenith: c('#2f5a9c'), horizon: c('#e0a97a'), sun: c('#ffb066'), amb: c('#7a7c8a'), ground: c('#3a3630'), cloud: c('#f0cbaa'), cloudDark: c('#8a7a80'), intensity: 1.05 },
  { e: 0.35, zenith: c('#3a72c4'), horizon: c('#b9cede'), sun: c('#fff2dc'), amb: c('#9fb0c4'), ground: c('#6b6a60'), cloud: c('#ffffff'), cloudDark: c('#b8c0cc'), intensity: 1.45 },
  { e: 1.00, zenith: c('#2f66bd'), horizon: c('#c6d8e6'), sun: c('#fffaf0'), amb: c('#aebccc'), ground: c('#787468'), cloud: c('#ffffff'), cloudDark: c('#c4ccd6'), intensity: 1.6 },
];

function samplePalette(elevation, out) {
  let i = 0;
  while (i < PALETTE.length - 2 && elevation > PALETTE[i + 1].e) i++;
  const a = PALETTE[i], b = PALETTE[i + 1];
  const t = clamp((elevation - a.e) / (b.e - a.e), 0, 1);
  out.zenith.copy(a.zenith).lerp(b.zenith, t);
  out.horizon.copy(a.horizon).lerp(b.horizon, t);
  out.sun.copy(a.sun).lerp(b.sun, t);
  out.amb.copy(a.amb).lerp(b.amb, t);
  out.ground.copy(a.ground).lerp(b.ground, t);
  out.cloud.copy(a.cloud).lerp(b.cloud, t);
  out.cloudDark.copy(a.cloudDark).lerp(b.cloudDark, t);
  out.intensity = lerp(a.intensity, b.intensity, t);
  return out;
}

export class Sky {
  /**
   * @param {THREE.Scene} scene
   * @param {object} textures
   * @param {number} startTime 0..1 through the day (0.5 = noon)
   */
  constructor(scene, textures, startTime = 0.34) {
    this.scene = scene;
    this.time = startTime;
    this.timeScale = 1 / DAY_LENGTH;
    this.paused = false;

    this.uniforms = {
      uZenith: { value: new THREE.Color('#3a72c4') },
      uHorizon: { value: new THREE.Color('#b9cede') },
      uGround: { value: new THREE.Color('#6b6a60') },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color('#fff2dc') },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uCloudColor: { value: new THREE.Color('#ffffff') },
      uCloudDark: { value: new THREE.Color('#b8c0cc') },
      uTime: { value: 0 },
      uStars: { value: 0 },
      uAurora: { value: 0 },
      uCloudCover: { value: 0.85 },
      uClouds: { value: textures.cloud },
    };

    const geometry = new THREE.SphereGeometry(1, 32, 20);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.scale.setScalar(2000);
    scene.add(this.mesh);

    // Lights driven by the same palette.
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.position.set(1, 1, 1);
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xa9bccd, 0x54503f, 0.85);
    scene.add(this.hemi);

    this.fog = new THREE.FogExp2(0xb9cede, 0.0025);
    scene.fog = this.fog;

    this._pal = {
      zenith: new THREE.Color(), horizon: new THREE.Color(), sun: new THREE.Color(),
      amb: new THREE.Color(), ground: new THREE.Color(), cloud: new THREE.Color(),
      cloudDark: new THREE.Color(), intensity: 1,
    };
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.skyColor = new THREE.Color();
    this.ambientColor = new THREE.Color();
    this.sunColor = new THREE.Color();

    this.apply(0);
  }

  setFogDensity(density) {
    this.fog.density = density;
    this._baseFog = density;
  }

  /** Jump to a named time of day. */
  setPreset(name) {
    const presets = { dawn: 0.24, morning: 0.32, noon: 0.5, afternoon: 0.62, dusk: 0.76, night: 0.94 };
    if (presets[name] !== undefined) this.time = presets[name];
  }

  /** Advance the clock and refresh everything that depends on it. */
  update(dt, elapsed) {
    if (!this.paused) this.time = (this.time + dt * this.timeScale) % 1;
    this.apply(elapsed);
  }

  apply(elapsed) {
    // Sun rides a tilted circle so it does not pass straight overhead.
    const a = (this.time - 0.25) * Math.PI * 2;
    const elevation = Math.sin(a);
    const dir = this.sunDirection;
    dir.set(Math.cos(a) * 0.82, elevation, Math.cos(a) * 0.30 - 0.34).normalize();

    const pal = samplePalette(dir.y, this._pal);
    this.uniforms.uZenith.value.copy(pal.zenith);
    this.uniforms.uHorizon.value.copy(pal.horizon);
    this.uniforms.uGround.value.copy(pal.ground);
    this.uniforms.uSunColor.value.copy(pal.sun);
    this.uniforms.uCloudColor.value.copy(pal.cloud);
    this.uniforms.uCloudDark.value.copy(pal.cloudDark);
    this.uniforms.uSunDir.value.copy(dir);
    this.uniforms.uMoonDir.value.copy(dir).multiplyScalar(-1);
    this.uniforms.uTime.value = elapsed;

    const night = 1 - smoothstep(-0.16, 0.02, dir.y);
    this.uniforms.uStars.value = night;
    this.uniforms.uAurora.value = smoothstep(0.35, 0.95, night) * 0.9;

    // Below the horizon the "sun" light becomes moonlight from the opposite side.
    const moonlit = dir.y < -0.05;
    this.sun.position.copy(dir).multiplyScalar(moonlit ? -300 : 300);
    this.sun.intensity = moonlit ? 0.22 * night : pal.intensity;
    this.sun.color.copy(moonlit ? MOONLIGHT : pal.sun);

    this.hemi.intensity = lerp(0.42, 1.15, clamp(dir.y * 2.2 + 0.4, 0, 1));
    this.hemi.color.copy(pal.amb);
    this.hemi.groundColor.copy(pal.ground);

    // Fog takes the horizon colour so distant land dissolves into the sky.
    this.fog.color.copy(pal.horizon).lerp(pal.zenith, 0.18);
    this.scene.background = null;

    this.skyColor.copy(pal.horizon).lerp(pal.zenith, 0.5);
    this.ambientColor.copy(pal.amb);
    this.sunColor.copy(this.sun.color);
  }

  /** Keep the dome centred on the viewer. */
  follow(position) {
    this.mesh.position.copy(position);
  }

  /** Rough 0..1 daylight factor, handy for ambience and particles. */
  get daylight() {
    return clamp(this.sunDirection.y * 2.4 + 0.35, 0, 1);
  }
}

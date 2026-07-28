/**
 * Shared materials.
 *
 * Foliage is animated by patching the standard Lambert vertex shader: every
 * vegetation geometry carries an `aFlex` attribute (0 at the root, 1 at the
 * tip) and the injected code pushes those vertices along a world-space wind
 * vector. Doing it in the shader means 10,000 swaying plants cost nothing on
 * the CPU.
 */

import * as THREE from 'three';

const WIND_UNIFORMS = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(0.86, 0.5) },
  uWindStrength: { value: 1.0 },
  uGust: { value: 1.0 },
};

const WIND_PARS = /* glsl */`
  uniform float uTime;
  uniform vec2 uWindDir;
  uniform float uWindStrength;
  uniform float uGust;
  attribute float aFlex;
`;

const WIND_BODY = /* glsl */`
  #ifdef USE_INSTANCING
    vec3 instOrigin = vec3( instanceMatrix[3].x, instanceMatrix[3].y, instanceMatrix[3].z );
    mat3 instRot = mat3( instanceMatrix );
    float instScaleSq = max( 1e-4, dot( instRot[0], instRot[0] ) );
  #else
    vec3 instOrigin = vec3( 0.0 );
  #endif

  float phase = instOrigin.x * 0.42 + instOrigin.z * 0.31;
  float gust = sin( uTime * 0.85 + phase ) * 0.62
             + sin( uTime * 2.17 + phase * 1.63 ) * 0.27
             + sin( uTime * 4.30 + phase * 2.90 ) * 0.11;
  float sway = aFlex * uWindStrength * uGust * gust;

  vec3 windWorld = vec3( uWindDir.x, 0.0, uWindDir.y ) * sway;
  #ifdef USE_INSTANCING
    // Rotate the world-space gust back into the instance's local frame so all
    // the plants lean the same way regardless of their random yaw.
    vec3 windLocal = vec3(
      dot( instRot[0], windWorld ),
      dot( instRot[1], windWorld ),
      dot( instRot[2], windWorld )
    ) / instScaleSq;
  #else
    vec3 windLocal = windWorld;
  #endif

  transformed += windLocal;
  // Tips dip slightly as they are pushed, which reads as bending not sliding.
  transformed.y -= abs( sway ) * aFlex * 0.35;
`;

function applyWind(material) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, WIND_UNIFORMS);
    shader.vertexShader = WIND_PARS + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + WIND_BODY,
    );
  };
  // Materials that compile to different programs must not share a cache key.
  material.customProgramCacheKey = () => 'wind';
  return material;
}

export function createMaterials(textures, quality) {
  const ground = textures.ground.clone();
  ground.needsUpdate = true;
  ground.wrapS = ground.wrapT = THREE.RepeatWrapping;

  const terrain = new THREE.MeshLambertMaterial({
    vertexColors: true,
    map: ground,
    fog: true,
  });

  // Trunks, rocks, logs: opaque, vertex-coloured, wind-aware.
  const solid = applyWind(new THREE.MeshLambertMaterial({
    vertexColors: true,
    fog: true,
  }));

  // Alpha-tested vegetation cards. Alpha *test* rather than blending keeps
  // them sortable-free and cheap on mobile GPUs.
  const makeCard = (map) => applyWind(new THREE.MeshLambertMaterial({
    map,
    vertexColors: true,
    transparent: false,
    alphaTest: 0.42,
    side: THREE.DoubleSide,
    fog: true,
  }));

  const foliage = makeCard(textures.leaf);
  const foliageAutumn = makeCard(textures.leafAutumn);
  const bush = makeCard(textures.bush);
  const grass = makeCard(textures.grass);

  // Soft dark disc dropped under trees and boulders — a cheap stand-in for
  // contact shadows, which a 1 km shadow map could never resolve.
  const contactShadow = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  return {
    terrain, solid, foliage, foliageAutumn, bush, grass, contactShadow,
    wind: WIND_UNIFORMS,
    /** @param {number} time seconds @param {number} gust 0..2 */
    update(time, gust = 1) {
      WIND_UNIFORMS.uTime.value = time;
      WIND_UNIFORMS.uGust.value = gust;
    },
    setSunColor(color, ambient) {
      // Vegetation cards are unlit on their back faces; nudging the material
      // colour keeps them from going flat grey at dusk.
      const tint = color.clone().lerp(ambient, 0.5).multiplyScalar(1.15);
      foliage.color.copy(tint);
      foliageAutumn.color.copy(tint);
      bush.color.copy(tint);
      grass.color.copy(tint);
    },
    dispose() {
      [terrain, solid, foliage, foliageAutumn, bush, grass, contactShadow].forEach((m) => m.dispose());
    },
  };
}

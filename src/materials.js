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

// ---------------------------------------------------------------------------
// City surfaces
// ---------------------------------------------------------------------------

/**
 * The city puts every surface it owns — facades, roofs, tarmac, decking — in one
 * atlas, so the whole downtown can share a single material and a single texture
 * bind. The catch is that an atlas cannot use REPEAT wrapping, and a wall needs
 * its window pattern to repeat dozens of times.
 *
 * So the repeat happens in the shader instead. Geometry carries UVs measured in
 * tile repeats (bays across, floors up) and a per-vertex `aAtlas` giving the
 * tile's offset and size; the fragment shader wraps with fract() and samples
 * with explicit derivatives, which is what keeps the mip level correct across
 * the seam where fract() jumps.
 */
const ATLAS_PARS_VERTEX = /* glsl */`
  attribute vec4 aAtlas;
  varying vec4 vAtlas;
`;

const ATLAS_PARS_FRAGMENT = /* glsl */`
  varying vec4 vAtlas;
  vec4 sampleAtlas( sampler2D atlas, vec2 uv, vec4 rect ) {
    vec2 wrapped = fract( uv ) * rect.zw + rect.xy;
    vec2 ddx = dFdx( uv ) * rect.zw;
    vec2 ddy = dFdy( uv ) * rect.zw;
    // Cap the footprint at a fraction of the tile. Without this a road seen
    // edge-on picks a mip level coarser than the tile itself, and the whole
    // atlas averages together into one grey smear. Both derivatives are scaled
    // by the same factor so the anisotropy ratio survives.
    float widest = max( max( abs( ddx.x ), abs( ddx.y ) ), max( abs( ddy.x ), abs( ddy.y ) ) );
    float limit = min( rect.z, rect.w ) * 0.22;
    if ( widest > limit ) {
      float k = limit / widest;
      ddx *= k;
      ddy *= k;
    }
    return textureGrad( atlas, wrapped, ddx, ddy );
  }
`;

function applyAtlas(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = ATLAS_PARS_VERTEX + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vAtlas = aAtlas;',
    );
    shader.fragmentShader = ATLAS_PARS_FRAGMENT + shader.fragmentShader
      .replace('#include <map_fragment>', /* glsl */`
        #ifdef USE_MAP
          diffuseColor *= sampleAtlas( map, vMapUv, vAtlas );
        #endif
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #ifdef USE_EMISSIVEMAP
          totalEmissiveRadiance *= sampleAtlas( emissiveMap, vEmissiveMapUv, vAtlas ).rgb;
        #endif
      `);
  };
  material.customProgramCacheKey = () => 'cityAtlas';
  return material;
}

/**
 * Materials for everything the city is built from.
 *
 * `surface` is the atlas material above. `prop` is for street furniture and
 * vehicles, which are vertex-coloured solids. `glow` is unlit and additive —
 * lamp panes, headlights, mast beacons — and fades in as the sun goes down.
 */
export function createCityMaterials(textures) {
  const surface = applyAtlas(new THREE.MeshLambertMaterial({
    map: textures.cityAtlas,
    emissive: new THREE.Color(0xffffff),
    emissiveMap: textures.cityLights,
    emissiveIntensity: 0,
    vertexColors: true,
    fog: true,
  }));

  // The paving is a few centimetres above the terrain it was laid on. At a
  // grazing angle that is inside the depth buffer's resolution, so the ground
  // gets its own copy of the material with a polygon offset.
  const ground = applyAtlas(surface.clone());
  ground.polygonOffset = true;
  ground.polygonOffsetFactor = -4;
  ground.polygonOffsetUnits = -4;

  const prop = new THREE.MeshLambertMaterial({ vertexColors: true, fog: true });

  const glow = new THREE.MeshBasicMaterial({
    vertexColors: true,
    fog: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return {
    surface, ground, prop, glow,
    /**
     * @param {number} night 0 by day, 1 after dark
     * @param {THREE.Color} ambient sky ambient, so unlit props do not go black
     */
    setNight(night, ambient) {
      surface.emissiveIntensity = night * 1.35;
      ground.emissiveIntensity = night * 1.35;
      glow.opacity = night;
      if (ambient) prop.color.setRGB(
        0.72 + ambient.r * 0.4,
        0.72 + ambient.g * 0.4,
        0.72 + ambient.b * 0.4,
      );
    },
    dispose() {
      surface.dispose();
      ground.dispose();
      prop.dispose();
      glow.dispose();
    },
  };
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

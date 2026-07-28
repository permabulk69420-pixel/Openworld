# Openworld

A procedurally generated northern valley you can walk around in VR, in the browser.
No buildings, no roads, no quests — the whole thing is landscape: a lake, a river
coming down out of the mountains, pine forest, open moor, snow up high, and an
aurora if you stay out after dark.

Built with three.js and WebXR, aimed at the Quest 3 browser but playable on a
desktop too. There is no build step and nothing is downloaded at runtime — every
texture, tree, rock and blade of grass is generated from a seed when the page
loads.

![The lake, looking north toward the peaks](screenshots/valley.jpg)

| | |
|---|---|
| ![Pine forest at the south shore](screenshots/forest.jpg) | ![Aurora over the lake](screenshots/aurora.jpg) |

## Running it

WebXR needs a secure context, so it has to be `https://` or `localhost` — opening
`index.html` straight off the filesystem will not work.

```sh
git clone <this repo>
cd Openworld
python3 -m http.server 8000
```

Then open `http://localhost:8000`. On desktop, press **Explore on desktop**.

For the headset, publish it somewhere with https (GitHub Pages works — Settings →
Pages → deploy from branch, root folder) and open that URL in the Quest browser.
The **Enter VR** button lights up once a headset is detected.

Detail level is picked from the device and can be overridden with `?q=low`,
`?q=medium` or `?q=high`, or with the buttons on the start screen. Medium is what
a Quest 3 wants; high is for a desktop GPU.

## Controls

**Quest 3 / any WebXR controllers**

| Input | Action |
|---|---|
| Left stick | Walk, relative to where you are looking |
| Left grip | Sprint |
| Left **X** | Comfort vignette on/off |
| Left **Y** | Cycle time of day |
| Right stick ← → | Snap turn |
| Right trigger | Hold for the teleport arc, release to go |
| Right **A** | Jump |
| Right **B** | Toggle snap / smooth turning |

Room-scale is honoured: the rig's origin is your feet and the headset supplies the
height on top, so crouching and leaning are real. There is a small readout on your
left wrist with the clock, your heading and your altitude.

**Desktop**

`W A S D` to walk, mouse to look (click to capture, `Esc` to release), `Shift` to
sprint, `Space` to jump, `T` for time of day, `V` for the vignette, `M` to mute.

## What's in the world

<img src="screenshots/map.png" alt="Top-down map of the valley" width="330" align="right">

The valley is 1024 m square, bounded by a ragged rim of peaks so it feels enclosed
rather than simply cut off. You start at the red dot on the south shore, looking
north over the water. Ground is coloured and planted by biome, which follows
from altitude, slope and a moisture field that runs wetter near water and drier as
you climb:

- **Lake and tarns** at sea level, with reed beds along the shallows
- **A river** falling out of the northwest mountains — the terrain is carved along
  the spline and the water surface steps down it
- **Pine forest** through the damp middle ground, mixed with birch and the odd
  autumn-coloured tree, dead snags and stumps
- **Moor and meadow** where it is drier, with flowering patches
- **Scree and lichen-stained rock** on the steep ground
- **Snow** above ~84 m, where the air gets a drift of falling snow instead of pollen

A full day passes in fifteen minutes. Fireflies come out at dusk in the low ground,
crickets take over from the birdsong, and the aurora shows up over the northern
sky. Wind moves through the trees and grass on a slow gust cycle, and the ambience
— wind, water, birds, footsteps — is synthesised with WebAudio rather than sampled.

## How it fits together

```
index.html          import map + start screen
src/
  noise.js          seeded simplex, fBm, ridged noise
  world.js          the height field, river spline, biomes, ground colour
  config.js         quality presets and player tuning
  terrain.js        chunked LOD terrain with skirts
  scatter.js        instanced trees / rocks / undergrowth
  water.js          lake mesh + river ribbon and their shader
  sky.js            sky dome, day-night palette, sun/moon, aurora, lighting
  assets.js         procedural textures and geometry
  materials.js      shared materials + the wind vertex shader
  particles.js      motes, snow, fireflies, birds
  player.js         locomotion, physics, teleport, comfort vignette
  audio.js          synthesised ambience
  ui.js             overlay, HUD, wrist panel
  main.js           build sequence and frame loop
tools/preview.mjs   renders a top-down map of the world to a PNG
vendor/three/       three.js r185 (MIT), vendored so there is no build step
```

A few things worth knowing if you want to change it:

**`world.js` is the whole world.** It is pure math with no three.js import, which
means `tools/preview.mjs` can run it under node and render the map straight to a
PNG. If you are tuning the terrain, iterate there — it takes two seconds instead of
a page reload:

```sh
node tools/preview.mjs 512 tools/preview.png
```

**Terrain is a fixed 8×8 grid of 128 m chunks**, always all present so the mountain
silhouette never pops in, each tessellated according to its distance from you.
Chunk edges get a short downward skirt so two neighbouring detail levels can't show
a crack of sky between them. Geometry is built on a per-frame time budget and
cached.

**Scattering works in cells.** Each cell decides once, deterministically, what grows
in it, and the result is cached; whatever is in range gets packed into a handful of
`InstancedMesh`es. Three fields run at different cell sizes and radii — trees,
mid-sized detail, and ground cover. A typical frame is around 50 draw calls and
6,000 instances.

**Wind is one vertex shader.** Every plant carries an `aFlex` attribute that is 0 at
the root and 1 at the tip; `materials.js` patches the Lambert vertex shader to push
those vertices along a world-space gust vector, rotated back into each instance's
local frame so everything leans the same way. Ten thousand swaying plants cost
nothing on the CPU.

**The player walks on exactly what is drawn.** Ground height is sampled bilinearly
on the same grid the highest detail level uses, so feet never sink into or float
above the visible triangles.

There is a debug handle on `window.openworld` if you want to poke at it from the
console:

```js
openworld.teleport(96, -36)   // jump to the middle of the lake
openworld.setTime(0.95)       // 0 = midnight, 0.5 = noon
openworld.perf                // CPU cost per frame, excluding the draw call
```

## Performance notes

Everything is tuned around holding 90 Hz on a Quest 3 at the medium preset:
Lambert materials rather than PBR, alpha-tested cards rather than blended ones,
fake contact-shadow discs instead of a shadow map that could never resolve a
kilometre, fixed foveation on, and instancing everywhere. Terrain and scatter work
is spread across frames on a millisecond budget so streaming never stalls a frame.

## Credits

three.js r185, MIT licensed, vendored under `vendor/three/`. Everything else here
is generated at runtime.

# Generic_Futuristic_Hoverboard.glb

## Asset summary
- **Format:** binary glTF 2.0 / GLB
- **Style:** generic near-future hoverboard
- **Scale:** 1 unit = 1 metre
- **Approximate dimensions:** **0.820 m long × 0.245 m wide × 0.140 m high**
- **Triangle count:** **852**
- **Root:** `Hoverboard`
- **Root origin:** bottom-centre of the board footprint
- **Root rotation:** identity
- **Root scale:** `(1,1,1)`
- **Up:** local `+Y`
- **Forward:** local `-Z`
- **Animations:** none
- **Scripts/gameplay logic:** none

## Exact hierarchy
```text
Hoverboard
├─ Board_Deck
├─ FootPad_Left
├─ FootPad_Right
├─ EdgeRail_Left
├─ EdgeRail_Right
├─ Thruster_Front
├─ Thruster_Rear
├─ ThrusterGlow_Front
├─ ThrusterGlow_Rear
├─ Foot_Point_Left
├─ Foot_Point_Right
├─ Balance_Point
├─ Hover_Origin
├─ Forward_Point
└─ COLLIDER_BOX_Hoverboard
```

## Gameplay locators
- `Foot_Point_Left`: `(-0.200, 0.125, 0.000)` m
- `Foot_Point_Right`: `(0.200, 0.125, 0.000)` m
- `Balance_Point`: `(0.000, 0.110, 0.000)` m
- `Hover_Origin`: `(0.000, 0.020, 0.000)` m
- `Forward_Point`: `(0.000, 0.080, -0.500)` m
- `COLLIDER_BOX_Hoverboard`: invisible helper centred at `(0.000, 0.070, 0.000)` m, suggested size `(0.820, 0.140, 0.245)` m

## Thrusters
`ThrusterGlow_Front` and `ThrusterGlow_Rear` are separate emissive-capable meshes. Their emissive intensity can be driven directly in Three.js when the board powers on.

## Materials
- `Hoverboard_Deck_Charcoal`
- `Hoverboard_Edge_Dark`
- `Hoverboard_FootPad_Rubber`
- `Hoverboard_Thruster_Metal`
- `Hoverboard_Thruster_Glow`

All materials are opaque Three.js-compatible PBR materials with no external textures.

## Verification
- Root identity transform verified
- No negative scales
- Forward direction is local `-Z`
- Collider helper is non-rendering
- Thruster glow meshes are separate
- No baked animations or scripts
- Suitable for Three.js/WebXR and standalone Quest 3

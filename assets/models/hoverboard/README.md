# Hoverboard asset

Put the hoverboard model in this folder using this exact filename:

`hoverboard.glb`

Expected path:

`assets/models/hoverboard/hoverboard.glb`

Preferred model setup:

- Real-world scale in metres
- Local +Y is up
- Local -Z is forward
- Root rotation `0,0,0`
- Root scale `1,1,1`
- Origin near the board's centre of mass
- Keep the full board under one root node

Optional helper nodes, if the model already has them:

- `PlayerMount`
- `LeftFoot`
- `RightFoot`
- `Thruster_L`
- `Thruster_R`

The game code can still create these helper points later if they are not included in the GLB.

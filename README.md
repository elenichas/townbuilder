<img src="assets/icon.svg" width="64" height="64" alt="">

# Cloudhaven

A cozy town builder with no goals, set on floating sky islands. Click to raise islands and stack houses. The town works out the details itself: roofs join up, overhangs become arches and bridges, doors open onto plazas, and windows light up at night.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # grid, WFC and geometry tests
npm run build      # static build in dist/
```

## Play

| Do this | To |
| --- | --- |
| Click the clouds | raise an island |
| Click an island or roof | build a storey on top |
| **Land** tool + Meadow / Woods / Square / Water | paint the ground; click the same land again to raise a hill |
| Click a wall | build sideways (overhangs become arches and bridges) |
| **Restyle** tool or <kbd>Alt</kbd>/<kbd>⌥</kbd>-click | get a different version of that piece; the pieces around it adapt |
| **Paint** tool or <kbd>Shift</kbd>-click | recolour walls |
| **Erase** tool or right-click | remove a piece |
| Drag / right-drag / scroll | orbit / pan / zoom |
| <kbd>1</kbd>–<kbd>5</kbd>, <kbd>N</kbd>, <kbd>Ctrl/Cmd</kbd>+<kbd>Z</kbd> | tools, day/night, undo (<kbd>Shift</kbd> to redo) |

Your town saves automatically in the browser. **Share** copies a link that contains the whole town, and **Surprise me** grows a random one.

## How it works

1. **Irregular grid** (`src/grid.ts`). Start from a hexagon of triangles, randomly merge pairs into quads, split every shape into quads, then relax the points so each quad is as square as possible. The player builds on grid *vertices*. Each vertex owns a "dual cell" made of the quarter of every quad around it.
2. **Voxels**. A filled `(vertex, level)` is either land (meadow, woods, square or water) or a storey of a house. Land stacks in solid columns from level 0, so a tall column is a hill. The ground height at each corner of a cell is shared by every cell touching that corner: land averages its neighbours into smooth slopes, and water pulls the corners down into a basin (or up into a rim when the lake sits above lower ground). Neighbouring cells always meet without cracks, and lakes get natural shorelines.
3. **Wave Function Collapse** (`src/wfc.ts`, `src/tiles.ts`). Every filled voxel is a variable. Its context (what is filled around it, and the land type you painted) decides which tiles it may use: window style × facade feature × roof type for storeys; grass, flowers, tree, bush or rocks on meadow; pines, oaks, grove or clearing in woods; paving, lamp, fountain, bench, market stall or planter on squares; open water, lilies, reeds, a boat or a rock on water. Adjacency rules connect neighbours:
   - storeys on the same floor share a window style, so a building reads as one,
   - touching roofs share a type, so their ridges line up,
   - no two doors side by side,
   - lone meadow trees keep their distance; woods grow in pine or oak stands with mixed groves between them, and clearings never touch,
   - squares don't put two fountains, two lamps, or a fountain and a market stall side by side,
   - reeds grow only on a lake's shore, boats only in open water,
   - doors and shopfronts never open onto a tree, fountain, market stall or planter.

   The solver propagates the rules (arc consistency), collapses the variable with the fewest options, and repeats. After an edit only the area nearby is re-solved, and the rest stays fixed. Choices use a seeded "exponential race", so the same town always comes out the same and small edits don't reshuffle anything far away. **Restyle** gives the clicked piece a new seed, solves it first while ruling out its current tile, and lets the rest of its floor adapt to match.
4. **Procedural modules** (`src/builder.ts`). There are no hand-made models. Each voxel is built on its own irregular cell. Walls go wherever a neighbouring quarter is empty. Roofs are a height field that rises away from the eaves. An overhang gets a vaulted underside that dips onto nearby walls, which makes arches. On top of that come windows, shutters, flower boxes, doors, shopfronts, balconies, chimneys, flags, trees and lamps.
5. **Presentation** (`src/scene.ts`, `src/view.ts`). Low-poly flat shading with soft shadows, a sea of clouds, birds, pop-in animations, a day/night cycle with glowing windows, and sound effects generated in code (`src/audio.ts`).

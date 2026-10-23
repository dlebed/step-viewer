# STEP Viewer

A single-file, in-browser viewer for **STEP** (`.step`, `.stp`) CAD files, which also opens IGES and BREP, with measurement tools.
It runs the same way on Windows, macOS and Linux in any current Chromium-based browser or Firefox. Nothing needs to be installed, and files never leave your machine.

```
start step-viewer.html           # Windows (or just double-click it)
open step-viewer.html            # macOS
xdg-open step-viewer.html        # Linux
node serve.mjs                   # optional: http://localhost:8080/step-viewer.html
```

Drop a file on the window, or use **Open**. Everything runs offline from `vendor/`, which has to stay next to `step-viewer.html`. The page loads three bundles as plain `<script>` tags, because Chrome blocks ES-module imports, `fetch()` and WASM loading for pages opened from disk, but it allows classic scripts:
- `vendor/libs.js`: three.js 0.186.1 with its add-ons, plus three-mesh-bvh 0.9.16.
- `vendor/occt.js`: the occt-import-js 0.0.23 source plus its 7.6 MB WASM, base64-encoded. It is loaded on the first parse and handed to the Web Worker directly.
- `vendor/sample.js`: the sample model.

The remaining files in `vendor/` are the original library files the bundles are built from. To rebuild the bundles (for example after upgrading a library): `cd tests && npm install && cd .. && node build-vendor.mjs`.

You can also load a model from a URL: `step-viewer.html?model=https://…/part.step` (the server must allow CORS).

## Install as an app

Served over http(s), the viewer is a progressive web app. Chrome and Edge show an **Install** icon in the address bar; on Android use *Add to Home screen*. The installed app:

- opens in its own window and works offline. `sw.js` caches the page and the `vendor/` bundles (about 13 MB, including OpenCascade) and refreshes them in the background, so an update shows on the next start;
- is offered in the OS *Open with* menu for `.step`, `.stp`, `.iges`, `.igs`, `.brep` and `.brp` files.

Run `node serve.mjs` and open `http://localhost:8080/step-viewer.html`, or put the folder on any static HTTPS host. Browsers allow installing only from `localhost` or HTTPS. Opened from `file://`, the page stays a plain page.

## Tools

| Tool | Key | What it does |
|---|---|---|
| Inspect | `I` | Hover or click a face, edge or vertex to see its type and parameters: plane (area, normal), cylinder / cone / sphere (radius, axis, half-angle), line / circle / arc (length, radius, sweep). |
| Distance | `D` | Click two points to get the distance and ΔX/ΔY/ΔZ. Clicks snap to **vertices > circle/arc centers > edge midpoints > edges > surface**. A marker shows which snap is active. |
| Min distance | `M` | Click two entities (face, edge or vertex, in any combination, also across parts) to get the shortest distance between them, with witness points. When the entities have a direction, the angle between them is shown too. Parallel planes also show their perpendicular distance. |
| Radius | `R` | Click a circular edge or arc, or a cylindrical, spherical or conical face, to get R and Ø. Cones show the half-angle. |

Other controls:
- **Mouse:** left-drag rotates, right-drag pans, the wheel zooms toward the cursor, and double-click sets the rotation pivot.
- **Keys:** `F` fits the model, `1`–`7` select Iso/Front/Back/Left/Right/Top/Bottom, `O` toggles orthographic view, and `E` toggles edges.
- **Measurements:** `Esc` cancels the current pick, and `Del` deletes the selected measurement (click its label or its row in the list).
- **Toolbar:** Units (mm/cm/m/in) and precision apply to every label at once. The model tree toggles part visibility, and clicking a name zooms to that part.

## How it works and how accurate it is

- **Reading the file:** [occt-import-js](https://github.com/kovacsv/occt-import-js) 0.0.23 (OpenCascade compiled to WASM) reads and tessellates the file in a Web Worker. All units are converted to millimetres.
- **Rebuilding geometry:** occt-import-js only returns triangles grouped by B-rep face, so edges and surface types are reconstructed:
  - Edges are the boundaries of each face's triangulation. Faces are welded by shared nodes, and seams are dropped.
  - Faces are classified by fitting: plane (PCA), cylinder and cone (Levenberg–Marquardt on the points, started from the mesh normals), and sphere. Edges are classified as line, circle/arc or free curve.
- **Accuracy:**
  - OCCT places mesh nodes exactly on the true surface, so radii, axes, line lengths and plane-to-plane distances match the CAD model to float precision. The tests check about 1e-5 mm.
  - Minimum distance involving curved faces is measured on the triangles, so its error is bounded by the tessellation deflection. Use **Quality → Fine** to tighten it (this re-tessellates and clears existing measurements).
  - Toruses and freeform (NURBS) faces are reported as "Freeform face" with their area only.
- **Colors:** a pure-black file color is treated as "no color" because several exporters write it as a default. **Colors** switches file colors off entirely.
- **Libraries** (pinned, bundled into `vendor/libs.js`): three.js 0.186.1 (WebGL2) and three-mesh-bvh 0.9.16, which handles picking and the closest-point queries.

## Tests

```
cd tests
npm install            # occt-import-js, three, three-mesh-bvh, puppeteer-core (no browser download), esbuild
npm test               # unit tests: geometry core run against real OCCT output for the fixtures
npm run e2e            # headless Chrome drives the real UI; screenshots land in tests/out/
```

The unit tests pull the geometry core straight out of `step-viewer.html` (the `<script id="core-src">` block), so they exercise exactly the code the page runs.

The E2E run needs Chrome (set `$CHROME` if it isn't in a standard location). It opens the page from `file://`. Set `E2E_HTTP=1` to serve it through `serve.mjs` instead. It then serves the page over http and checks that Chrome reports it as installable and that it starts and parses a file offline. No network access is needed.

Fixtures in `tests/fixtures/`:
- A 10 mm cube.
- A hand-written R5 × H10 cylinder.
- A cube with an R5 fillet.
- An inch-unit part with a 45° cone.
- The CAx-IF `as1-oc-214` assembly.

All but the hand-written cylinder come from the occt-import-js test set.

## License

MIT, see [LICENSE](LICENSE). Bundled libraries keep their own licenses, see [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).

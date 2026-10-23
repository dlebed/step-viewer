// End-to-end check of step-viewer.html in headless Chrome: loads fixtures, drives the real UI with
// mouse clicks (snapping, tools) and checks the resulting measurements. Screenshots go to tests/out/.
//
//   cd tests && npm install && npm run e2e
// Opens the page from file:// (the double-click case); E2E_HTTP=1 serves it via ../serve.mjs instead.
// No network access needed: all libraries come from ../vendor.
// Chrome path: $CHROME, else the default Windows / macOS / Linux locations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { startServer } from '../serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });

const chrome = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].filter((v) => process.env[v])
    .map((v) => path.join(process.env[v], 'Google', 'Chrome', 'Application', 'chrome.exe')),
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p));
if (!chrome) throw new Error('Chrome not found; set $CHROME');

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? '✔' : '✖'} ${msg}`);
  if (!cond) failures++;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900'],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const server = process.env.E2E_HTTP ? await startServer(0) : null;
await page.goto(server ? `http://127.0.0.1:${server.address().port}/step-viewer.html`
  : pathToFileURL(path.join(here, '..', 'step-viewer.html')).href);
await page.waitForFunction(() => window.stepViewer, { timeout: 60000 });

async function loadFixture(name) {
  const b64 = fs.readFileSync(path.join(here, 'fixtures', name)).toString('base64');
  const t0 = Date.now();
  await page.evaluate(async (b64, name) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await window.stepViewer.load(bin.buffer, name);
  }, b64, name);
  await page.waitForFunction(() => window.stepViewer.model, { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 300));
  return Date.now() - t0;
}
async function clickAt(p) {
  const s = await page.evaluate((p) => window.stepViewer.screenOf(p), p);
  await page.mouse.move(s.x, s.y);
  await new Promise((r) => setTimeout(r, 60));
  await page.mouse.click(s.x, s.y);
  await new Promise((r) => setTimeout(r, 60));
}
const measurements = () => page.evaluate(() => window.stepViewer.measurements());

// ------------------------------------------------------------ cube: distance + min distance via UI
const ms = await loadFixture('cube-10x10.stp');
console.log(`  cube loaded in ${ms} ms (includes OpenCascade WASM download on first use)`);
const cube = await page.evaluate(() => {
  const sv = window.stepViewer, m = sv.model.meshes[0];
  const edges = [];
  for (let e = 0; e < m.topo.edgeClosed.length; e++) edges.push(sv.edgeInfo(0, e));
  const camDir = sv.camera.getWorldDirection(new sv.THREE.Vector3()).toArray();
  return { edges, camDir, verts: Array.from(m.topo.vertices) };
});
check(cube.edges.length === 12, 'cube has 12 edges in the browser build');

// Distance tool: click two vertices of one visible edge (snap must land exactly on the vertices).
await page.evaluate(() => window.stepViewer.setMode('distance'));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const center = [0, 1, 2].map((k) => cube.edges.reduce((s, e) => s + e.start[k] + e.end[k], 0) / 24);
// Vertex closest to the camera is surely visible; use an edge starting there.
const toCam = (p) => -dot(cube.camDir, p);
const nearest = cube.edges.flatMap((e) => [e.start, e.end]).sort((a, b) => toCam(b) - toCam(a))[0];
const edgeA = cube.edges.find((e) => e.start.every((v, k) => v === nearest[k]) || e.end.every((v, k) => v === nearest[k]));
const lerp = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
// click a little off the vertex towards the face interior so the ray hits the mesh; snapping does the rest
const nudge = (p) => lerp(p, center, 0.012);
await clickAt(nudge(edgeA.start));
await clickAt(nudge(edgeA.end));
let list = await measurements();
check(list.length === 1 && near(list[0].value, 10, 1e-4), `distance between snapped vertices = 10 (got ${list[0]?.value})`);
check(list[0]?.text === '10.000 mm', `label text "${list[0]?.text}"`);

// Min distance tool: two parallel edges of the face nearest the camera, clicked at 30% along each edge.
await page.evaluate(() => window.stepViewer.setMode('min'));
// The face most facing the camera: all four of its edges are visible.
const front = await page.evaluate(() => {
  const sv = window.stepViewer, m = sv.model.meshes[0];
  const dir = sv.camera.getWorldDirection(new sv.THREE.Vector3()).toArray();
  let best = -1, bestDot = 0;
  for (let f = 0; f < 6; f++) { const d = -sv.core.vDot(sv.faceInfo(0, f).normal, dir); if (d > bestDot) { bestDot = d; best = f; } }
  return m.faceEdges[best];
});
const e1 = cube.edges[front[0]];
const e2 = front.map((i) => cube.edges[i]).find((e) => e !== e1 && Math.abs(dot(e.dir, e1.dir)) > 0.999);
check(!!e2, 'found two visible parallel edges');
if (e2) {
  await clickAt(lerp(lerp(e1.start, e1.end, 0.3), center, 0.01));
  await clickAt(lerp(lerp(e2.start, e2.end, 0.3), center, 0.01));
  list = await measurements();
  const last = list[list.length - 1];
  check(list.length === 2 && last.type === 'min' && near(last.value, 10, 1e-4), `min distance edge↔edge = 10 (got ${last?.value})`);
  check(near(last.angle, 0, 1e-6), `edge↔edge angle = 0° (got ${last?.angle})`);
}
await page.screenshot({ path: path.join(outDir, 'cube.png') });

// ------------------------------------------------------------ cylinder: radius via UI + API checks
await loadFixture('cylinder-r5-h10.step');
const cyl = await page.evaluate(() => {
  const sv = window.stepViewer, m = sv.model.meshes[0];
  const faces = [];
  for (let f = 0; f < m.faceRanges.length / 2; f++) faces.push(sv.faceInfo(0, f));
  return { faces, camDir: sv.camera.getWorldDirection(new sv.THREE.Vector3()).toArray() };
});
const cf = cyl.faces.findIndex((f) => f.type === 'cylinder');
const caps = cyl.faces.map((f, i) => [f, i]).filter(([f]) => f.type === 'plane').map(([, i]) => i);
check(cf >= 0 && near(cyl.faces[cf].radius, 5, 1e-5), 'cylinder face R = 5 in the browser build');
const api = await page.evaluate((caps) => window.stepViewer.minDistance({ face: [0, caps[0]] }, { face: [0, caps[1]] }), caps);
check(near(api.distance, 10, 1e-5) && near(api.perpendicular, 10, 1e-5), `cap↔cap min distance = 10, ⊥ = 10 (got ${api.distance}, ${api.perpendicular})`);

// Click the cylinder wall facing the camera at mid height.
await page.evaluate(() => window.stepViewer.setMode('radius'));
const horiz = [-cyl.camDir[0], -cyl.camDir[1]];
const hl = Math.hypot(...horiz);
await clickAt([5 * 0.999 * horiz[0] / hl, 5 * 0.999 * horiz[1] / hl, 5]);
list = await measurements();
check(list.length === 1 && list[0].type === 'radius' && near(list[0].value, 5, 1e-5), `radius tool on cylinder wall = 5 (got ${list[0]?.value})`);
check(list[0]?.text === 'R 5.000 · Ø 10.000 mm', `label text "${list[0]?.text}"`);

// Radius tool on the top circular edge (click right next to it on the cap).
const topCap = caps.find((i) => cyl.faces[i].point[2] > 5);
await clickAt([4.97 * horiz[0] / hl, 4.97 * horiz[1] / hl, 10]);
list = await measurements();
check(list.length === 2 && near(list[1].value, 5, 1e-5), `radius tool on circle edge = 5 (got ${list[1]?.value})`);
check(topCap !== undefined, 'top cap found');

// Inspect tool: clicking the wall shows the cylinder in the Selection panel.
await page.evaluate(() => window.stepViewer.setMode('inspect'));
await clickAt([5 * 0.999 * horiz[0] / hl, 5 * 0.999 * horiz[1] / hl, 3]);
const infoText = await page.$eval('#info', (el) => el.innerText);
check(/Cylindrical face/.test(infoText) && /Radius\s+5\.000 mm/.test(infoText), `inspect panel shows the cylinder (${infoText.split('\n').slice(0, 3).join(' / ')})`);

// Units switch re-formats labels.
await page.select('#sel-units', 'in');
list = await measurements();
check(list[0].text === 'R 0.197 · Ø 0.394 in', `inch label "${list[0].text}"`);
await page.select('#sel-units', 'mm');
await page.screenshot({ path: path.join(outDir, 'cylinder.png') });

// Quality switch re-tessellates (more triangles) and clears measurements.
const trisBefore = await page.evaluate(() => window.stepViewer.model.meshes[0].index.length / 3);
await page.select('#sel-quality', 'fine');
await page.waitForFunction((n) => window.stepViewer.model && window.stepViewer.model.meshes[0].index.length / 3 > n, { timeout: 60000 }, trisBefore);
const trisAfter = await page.evaluate(() => window.stepViewer.model.meshes[0].index.length / 3);
check(trisAfter > trisBefore && (await measurements()).length === 0, `fine quality: ${trisBefore} → ${trisAfter} triangles, measurements cleared`);
const rFine = await page.evaluate(() => window.stepViewer.faceInfo(0, 0).radius ?? window.stepViewer.faceInfo(0, 1).radius ?? window.stepViewer.faceInfo(0, 2).radius);
check(near(rFine, 5, 1e-5), `radius still 5 at fine quality (got ${rFine})`);
await page.select('#sel-quality', 'normal');
await page.waitForFunction((n) => window.stepViewer.model.meshes[0].index.length / 3 === n, { timeout: 60000 }, trisBefore);

// ------------------------------------------------------------ assembly smoke test (+ ortho, views)
await loadFixture('as1-oc-214.stp');
const parts = await page.evaluate(() => window.stepViewer.model.meshes.length);
check(parts === 18, `assembly has 18 parts (got ${parts})`);
const treeRows = await page.$$eval('#tree .row', (r) => r.length);
check(treeRows > 5, `model tree populated (${treeRows} rows)`);
await page.keyboard.press('o');
await page.keyboard.press('1');
await new Promise((r) => setTimeout(r, 200));
const isOrtho = await page.evaluate(() => window.stepViewer.camera.isOrthographicCamera);
check(isOrtho, 'O toggles orthographic camera');
await page.screenshot({ path: path.join(outDir, 'assembly.png') });

check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
server?.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall E2E checks passed');
process.exit(failures ? 1 : 0);

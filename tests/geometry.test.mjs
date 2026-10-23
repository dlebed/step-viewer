// Unit tests for the geometry core embedded in ../step-viewer.html.
// The core is extracted from its <script type="text/plain" id="core-src"> block and run against
// real occt-import-js output (same library + version the page loads from the CDN).
//
//   cd tests && npm install && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const html = fs.readFileSync(new URL('../step-viewer.html', import.meta.url), 'utf8');
const src = /<script type="text\/plain" id="core-src">([\s\S]*?)<\/script>/.exec(html)[1];
const core = new Function(src + '\nreturn CORE;')();
const measure = core.createMeasure(THREE, MeshBVH);

const require = createRequire(import.meta.url);
const occt = await require('occt-import-js')();

const NORMAL = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.4 };
const FINE = { ...NORMAL, linearDeflection: 0.0002, angularDeflection: 0.15 };

function load(name, params = NORMAL) {
  const bytes = new Uint8Array(fs.readFileSync(new URL('./fixtures/' + name, import.meta.url)));
  const ext = name.split('.').pop().toLowerCase();
  return core.convertOcctResult(core.readCad(occt, bytes, ext, params));
}
const faces = (m) => Array.from({ length: m.faceRanges.length / 2 }, (_, f) => ({ f, info: core.classifyFace(m, f) }));
const edges = (m) => Array.from({ length: m.topo.edgeClosed.length }, (_, e) => ({ e, info: core.classifyEdge(m, e) }));
const close = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ± ${tol}, got ${actual}`);

// ---------------------------------------------------------------- math
test('symEigen3 recovers a known decomposition', () => {
  // diag(1, 4, 9) rotated 30° about z
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const R = [[c, -s, 0], [s, c, 0], [0, 0, 1]], D = [1, 4, 9];
  const M = [0, 1, 2].map((i) => [0, 1, 2].map((j) => R[i][0] * D[0] * R[j][0] + R[i][1] * D[1] * R[j][1] + R[i][2] * D[2] * R[j][2]));
  const { values, vectors } = core.symEigen3(M[0][0], M[0][1], M[0][2], M[1][1], M[1][2], M[2][2]);
  values.forEach((v, i) => close(v, D[i], 1e-12));
  close(Math.abs(core.vDot(vectors[0], [c, s, 0])), 1, 1e-12, 'first eigenvector');
  close(Math.abs(vectors[2][2]), 1, 1e-12, 'last eigenvector');
});

test('fitCircle2D on a 60° arc', () => {
  const pts = [];
  for (let i = 0; i <= 6; i++) { const a = 0.3 + i * Math.PI / 18; pts.push([3 + 7.5 * Math.cos(a), -2 + 7.5 * Math.sin(a)]); }
  const c = core.fitCircle2D(pts);
  close(c.cx, 3, 1e-9); close(c.cy, -2, 1e-9); close(c.r, 7.5, 1e-9);
});

test('closestSegSeg handles skew and parallel segments', () => {
  const r = core.closestSegSeg([0, 0, 0], [10, 0, 0], [5, -5, 3], [5, 5, 3]);
  close(r.distance, 3, 1e-12);
  assert.deepEqual(r.a.map((v) => +v.toFixed(9)), [5, 0, 0]);
  const p = core.closestSegSeg([0, 0, 0], [10, 0, 0], [2, 4, 0], [8, 4, 0]);
  close(p.distance, 4, 1e-12);
});

// ---------------------------------------------------------------- cube 10 mm
test('cube 10x10: topology', () => {
  const { meshes } = load('cube-10x10.stp');
  assert.equal(meshes.length, 1);
  const m = meshes[0];
  const fs_ = faces(m), es = edges(m);
  assert.equal(fs_.length, 6);
  assert.ok(fs_.every(({ info }) => info.type === 'plane'), 'all faces planar');
  fs_.forEach(({ info }) => close(info.area, 100, 1e-6, 'face area'));
  assert.equal(es.length, 12);
  assert.ok(es.every(({ info }) => info.type === 'line'), 'all edges straight');
  es.forEach(({ info }) => close(info.length, 10, 1e-5, 'edge length'));
  assert.equal(m.topo.vertices.length / 3, 8);
});

test('cube 10x10: min distances and angles', () => {
  const m = load('cube-10x10.stp').meshes[0];
  const fs_ = faces(m);
  const a = fs_[0];
  const opposite = fs_.find(({ info }) => core.vDot(info.normal, a.info.normal) < -0.999);
  const adjacent = fs_.find(({ info }) => Math.abs(core.vDot(info.normal, a.info.normal)) < 1e-6);
  const F = (x) => ({ kind: 'face', mesh: m, id: x.f });
  close(measure.minDistance(F(a), F(opposite)).distance, 10, 1e-5, 'opposite faces');
  close(measure.minDistance(F(a), F(adjacent)).distance, 0, 1e-6, 'adjacent faces');
  close(core.angleBetween(a.info, opposite.info), 0, 1e-6);
  close(core.angleBetween(a.info, adjacent.info), 90, 1e-6);

  // Edge of face a vs. opposite face; vertex vs face; edge vs edge.
  const e = m.topo.edgeFaces.findIndex((f, i) => i % 2 === 0 && (f === a.f || m.topo.edgeFaces[i + 1] === a.f)) / 2;
  close(measure.minDistance({ kind: 'edge', mesh: m, id: e }, F(opposite)).distance, 10, 1e-5, 'edge to opposite face');
  const v = Array.from(m.topo.vertices.subarray(0, 3));
  const far = fs_.filter(({ info }) => Math.abs(core.vDot(core.vSub(v, info.point), info.normal)) > 5);
  far.forEach((x) => close(measure.minDistance({ kind: 'point', point: v }, F(x)).distance, 10, 1e-5, 'vertex to far face'));
  const es = edges(m);
  const parallel = es.filter(({ info }) => Math.abs(core.vDot(info.dir, es[0].info.dir)) > 0.999 && info !== es[0].info)
    .map(({ e: id }) => measure.minDistance({ kind: 'edge', mesh: m, id: es[0].e }, { kind: 'edge', mesh: m, id }).distance)
    .sort((x, y) => x - y);
  assert.equal(parallel.length, 3);
  close(parallel[0], 10, 1e-5); close(parallel[1], 10, 1e-5); close(parallel[2], 10 * Math.SQRT2, 1e-5);
});

// ---------------------------------------------------------------- cylinder R5 H10
for (const [label, params] of [['normal', NORMAL], ['fine', FINE]]) {
  test(`cylinder R5 H10 (${label} quality): faces, edges, radius`, () => {
    const m = load('cylinder-r5-h10.step', params).meshes[0];
    const fs_ = faces(m), es = edges(m);
    const cyl = fs_.filter(({ info }) => info.type === 'cylinder');
    const planes = fs_.filter(({ info }) => info.type === 'plane');
    assert.equal(cyl.length, 1); assert.equal(planes.length, 2);
    close(cyl[0].info.radius, 5, 1e-5, 'cylinder radius');
    close(cyl[0].info.length, 10, 1e-5, 'cylinder height');
    close(Math.abs(cyl[0].info.axis[2]), 1, 1e-9, 'axis along Z');
    close(Math.hypot(cyl[0].info.center[0], cyl[0].info.center[1]), 0, 1e-5, 'axis through origin');

    assert.equal(es.length, 2, 'seam must not become an edge');
    for (const { info } of es) {
      assert.equal(info.type, 'circle');
      close(info.radius, 5, 1e-5, 'circle radius');
      close(Math.hypot(info.center[0], info.center[1]), 0, 1e-5);
    }
    assert.deepEqual(es.map(({ info }) => Math.round(info.center[2])).sort((a, b) => a - b), [0, 10]);
    assert.equal(m.topo.vertices.length, 0);

    const F = (x) => ({ kind: 'face', mesh: m, id: x.f });
    close(measure.minDistance(F(planes[0]), F(planes[1])).distance, 10, 1e-5, 'cap to cap');
    const bottomEdge = es.find(({ info }) => Math.round(info.center[2]) === 0).e;
    const topCap = planes.find(({ info }) => info.point[2] > 5);
    close(measure.minDistance({ kind: 'edge', mesh: m, id: bottomEdge }, F(topCap)).distance, 10, 1e-5, 'bottom circle to top cap');
    // point on the axis to the cylinder wall = radius (tessellation chord error allowed)
    const d = measure.minDistance({ kind: 'point', point: [0, 0, 5] }, F(cyl[0])).distance;
    assert.ok(d <= 5 + 1e-6 && d > 5 - 0.02, `axis point to wall ${d}`);
  });
}

// ---------------------------------------------------------------- rounded cube (R5 fillet)
test('rounded cube: fillet recognised as R5 cylinder', () => {
  const m = load('rounded-cube.step').meshes[0];
  const fs_ = faces(m);
  const cyl = fs_.filter(({ info }) => info.type === 'cylinder');
  assert.equal(cyl.length, 1);
  close(cyl[0].info.radius, 5, 1e-5, 'fillet radius');
  assert.equal(fs_.filter(({ info }) => info.type === 'plane').length, 6);
  const arcs = edges(m).filter(({ info }) => info.type === 'arc');
  assert.equal(arcs.length, 2, 'two quarter-circle fillet ends');
  arcs.forEach(({ info }) => { close(info.radius, 5, 1e-5); close(info.sweep * 180 / Math.PI, 90, 1e-3); });
});

// ---------------------------------------------------------------- inch part with a cone
test('conical-surface (inch file): cone 45°, cylinders in mm', () => {
  const m = load('conical-surface.step').meshes[0];
  const fs_ = faces(m);
  const cones = fs_.filter(({ info }) => info.type === 'cone');
  assert.equal(cones.length, 1);
  close(cones[0].info.halfAngle * 180 / Math.PI, 45, 1e-3, 'cone half angle');
  const radii = fs_.filter(({ info }) => info.type === 'cylinder').map(({ info }) => info.radius).sort((a, b) => a - b);
  assert.equal(radii.length, 2);
  close(radii[0], 0.216535433070866 * 25.4, 1e-4, 'small cylinder (mm)');
  close(radii[1], 0.532145256772786 * 25.4, 1e-4, 'large cylinder (mm)');
});

// ---------------------------------------------------------------- assembly smoke test
test('as1-oc-214 assembly: every face and edge classifies', () => {
  const { meshes, root } = load('as1-oc-214.stp');
  assert.equal(meshes.length, 18);
  assert.ok(root.children.length > 0);
  let nF = 0, nE = 0;
  const counts = {};
  for (const m of meshes) {
    for (const { info } of faces(m)) { nF++; counts[info.type] = (counts[info.type] || 0) + 1; }
    for (const { info } of edges(m)) { nE++; assert.ok(info.length > 0); }
    assert.ok(m.topo.edgeClosed.length > 0);
  }
  assert.ok(counts.plane > 0 && counts.cylinder > 0, JSON.stringify(counts));
  assert.ok(nF > 50 && nE > 100);
});

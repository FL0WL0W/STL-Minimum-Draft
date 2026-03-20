import * as THREE from 'three';
import { state } from './state.js';

const COLOR_GOOD = new THREE.Color(0x00cc44);
const COLOR_BAD  = new THREE.Color(0xff2233);

/**
 * Pure computation: per-triangle pass/fail + directed boundary edges.
 * Reads from state.currentMesh.geometry.
 *
 * @param   {number} minAngleDeg
 * @returns {{ triPasses: Uint8Array, boundaryEdges: Array<{v0,v1,outward}>,
 *             wallEdgePositions: number[], otherEdgePositions: number[] } | null}
 */
export function computeAnalysisData(minAngleDeg) {
  if (!state.currentMesh) return null;
  const geo        = state.currentMesh.geometry;
  const normalAttr = geo.getAttribute('normal');
  const posAttr    = geo.getAttribute('position');
  if (!normalAttr || !posAttr) return null;

  const count    = normalAttr.count;
  const triCount = count / 3;
  const up       = new THREE.Vector3(0, 1, 0);
  const n        = new THREE.Vector3();

  // Pass 1: per-triangle pass/fail
  const triPasses = new Uint8Array(triCount);
  for (let i = 0; i < count; i += 3) {
    n.set(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i)).normalize();
    const elevation = Math.asin(Math.min(1, Math.max(-1, n.dot(up)))) * (180 / Math.PI);
    triPasses[i / 3] = elevation >= minAngleDeg ? 1 : 0;
  }

  // Pass 2: directed boundary edge detection
  const PREC = 4;
  function vKey(idx) {
    return posAttr.getX(idx).toFixed(PREC) + ',' +
           posAttr.getY(idx).toFixed(PREC) + ',' +
           posAttr.getZ(idx).toFixed(PREC);
  }
  function dKey(a, b) { return vKey(a) + '>' + vKey(b); }
  function uKey(a, b) {
    const ka = vKey(a), kb = vKey(b);
    return ka < kb ? ka + '|' + kb : kb + '|' + ka;
  }

  // Step 1: collect downward edges from failing faces
  const downEdgeMap = new Map();
  const ex = new THREE.Vector3();
  for (let i = 0; i < count; i += 3) {
    if (triPasses[i / 3]) continue;
    const nx = normalAttr.getX(i);
    const nz = normalAttr.getZ(i);
    for (let e = 0; e < 3; e++) {
      const a = i + e, b = i + ((e + 1) % 3);
      ex.set(
        posAttr.getX(b) - posAttr.getX(a),
        posAttr.getY(b) - posAttr.getY(a),
        posAttr.getZ(b) - posAttr.getZ(a),
      ).normalize();
      if (nz * ex.x - nx * ex.z >= 0) continue;
      const key = dKey(a, b);
      let rec = downEdgeMap.get(key);
      if (!rec) { rec = { i0: a, i1: b, failNx: 0, failNz: 0 }; downEdgeMap.set(key, rec); }
      rec.failNx += nx;
      rec.failNz += nz;
    }
  }

  // Step 2: passing faces — reverse lookup for wall edges (Class A)
  const wallEdgePositions  = [];
  const boundaryEdges      = [];
  const seenDirected       = new Set();
  for (let i = 0; i < count; i += 3) {
    if (!triPasses[i / 3]) continue;
    for (let e = 0; e < 3; e++) {
      const a = i + e, b = i + ((e + 1) % 3);
      const revKey = dKey(b, a);
      if (downEdgeMap.has(revKey) && !seenDirected.has(revKey)) {
        seenDirected.add(revKey);
        const rec = downEdgeMap.get(revKey);
        wallEdgePositions.push(
          posAttr.getX(rec.i0), posAttr.getY(rec.i0), posAttr.getZ(rec.i0),
          posAttr.getX(rec.i1), posAttr.getY(rec.i1), posAttr.getZ(rec.i1),
        );
        const v0 = new THREE.Vector3(posAttr.getX(rec.i0), posAttr.getY(rec.i0), posAttr.getZ(rec.i0));
        const v1 = new THREE.Vector3(posAttr.getX(rec.i1), posAttr.getY(rec.i1), posAttr.getZ(rec.i1));
        const len = Math.sqrt(rec.failNx ** 2 + rec.failNz ** 2);
        const outward = len > 1e-9
          ? new THREE.Vector3(rec.failNx / len, 0, rec.failNz / len)
          : new THREE.Vector3(0, 0, 1);
        boundaryEdges.push({ v0, v1, outward });
      }
    }
  }

  // Class B: undirected boundary edges not in the wall set
  const otherEdgePositions = [];
  const undirectedBoundary = new Map();
  for (let i = 0; i < count; i += 3) {
    const pass = triPasses[i / 3] === 1;
    for (let e = 0; e < 3; e++) {
      const a = i + e, b = i + ((e + 1) % 3);
      const uk = uKey(a, b);
      let rec = undirectedBoundary.get(uk);
      if (!rec) { rec = { i0: a, i1: b, hasPass: false, hasFail: false }; undirectedBoundary.set(uk, rec); }
      if (pass) rec.hasPass = true; else rec.hasFail = true;
    }
  }
  for (const rec of undirectedBoundary.values()) {
    if (!rec.hasPass || !rec.hasFail) continue;
    const fwd = dKey(rec.i0, rec.i1), rev = dKey(rec.i1, rec.i0);
    if (seenDirected.has(fwd) || seenDirected.has(rev)) continue;
    otherEdgePositions.push(
      posAttr.getX(rec.i0), posAttr.getY(rec.i0), posAttr.getZ(rec.i0),
      posAttr.getX(rec.i1), posAttr.getY(rec.i1), posAttr.getZ(rec.i1),
    );
  }

  return { triPasses, boundaryEdges, wallEdgePositions, otherEdgePositions };
}

/**
 * Run automatic draft analysis on the current mesh.
 * Colors triangles green (passes) or red (fails), and draws boundary edge overlays.
 *
 * @param {HTMLInputElement}  draftAngleInput
 * @param {HTMLElement}       hud
 * @param {HTMLButtonElement} btnApply         - enabled when failing faces exist
 * @param {HTMLButtonElement} btnClearAnalysis
 */
export function runDraftAnalysis(draftAngleInput, hud, btnApply, btnClearAnalysis) {
  if (!state.currentMesh) return;

  // Remove previous edge overlay
  if (state.edgeOverlay) {
    state.edgeOverlay.removeFromParent();
    state.edgeOverlay.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
    state.edgeOverlay = null;
  }

  const minAngleDeg = Math.max(0, parseFloat(draftAngleInput.value) || 3);
  const result = computeAnalysisData(minAngleDeg);
  if (!result) return;

  const { triPasses, boundaryEdges, wallEdgePositions, otherEdgePositions } = result;
  state.analysisData = { triPasses, boundaryEdges };

  // Build per-vertex colour array
  const geo      = state.currentMesh.geometry;
  const triCount = triPasses.length;
  const count    = triCount * 3;
  const colors   = new Float32Array(count * 3);
  let badCount = 0;
  for (let i = 0; i < triCount; i++) {
    const passes = triPasses[i] === 1;
    if (!passes) badCount++;
    const c = passes ? COLOR_GOOD : COLOR_BAD;
    for (let v = 0; v < 3; v++) {
      colors[(i * 3 + v) * 3]     = c.r;
      colors[(i * 3 + v) * 3 + 1] = c.g;
      colors[(i * 3 + v) * 3 + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // Build overlay — two LineSegments parented to currentMesh
  const overlayGroup = new THREE.Group();

  if (wallEdgePositions.length > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wallEdgePositions), 3));
    overlayGroup.add(new THREE.LineSegments(
      geo, new THREE.LineBasicMaterial({ color: 0xffdd00, depthTest: false })
    ));
  }
  if (otherEdgePositions.length > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(otherEdgePositions), 3));
    overlayGroup.add(new THREE.LineSegments(
      geo, new THREE.LineBasicMaterial({ color: 0x336699, depthTest: false })
    ));
  }

  if (overlayGroup.children.length > 0) {
    overlayGroup.renderOrder = 1;
    state.edgeOverlay = overlayGroup;
    state.currentMesh.add(state.edgeOverlay);
  }

  const wallEdgeCount  = wallEdgePositions.length / 6;
  const otherEdgeCount = otherEdgePositions.length / 6;

  // ── Material ──────────────────────────────────────────────────────────────
  if (!state.analysisMaterial) {
    state.analysisMaterial = new THREE.MeshPhongMaterial({
      vertexColors: true,
      specular:  0x222222,
      shininess: 30,
      side: THREE.DoubleSide,
    });
  }
  state.currentMesh.material = state.analysisMaterial;
  btnApply.disabled         = (badCount === 0); // nothing to draft if all faces pass
  btnClearAnalysis.disabled = false;

  hud.innerHTML =
    `<span style="color:#ff2233">&#9632;</span> ${badCount} failing &nbsp;` +
    `<span style="color:#00cc44">&#9632;</span> ${triCount - badCount} passing &nbsp;` +
    `<span style="color:#ffdd00">&#9632;</span> ${wallEdgeCount} wall edges &nbsp;` +
    `<span style="color:#336699">&#9632;</span> ${otherEdgeCount} skipped &nbsp;` +
    `(min ${minAngleDeg}°)`;
}

/**
 * Remove the analysis overlay and restore the original material.
 *
 * @param {HTMLButtonElement} btnApply
 * @param {HTMLButtonElement} btnClearAnalysis
 */
export function clearAnalysisVisual(btnApply, btnClearAnalysis) {
  if (!state.currentMesh || !state.originalMaterial) return;

  if (state.analysisMaterial) {
    state.analysisMaterial.dispose();
    state.analysisMaterial = null;
  }
  state.currentMesh.material = state.originalMaterial;

  if (state.edgeOverlay) {
    state.edgeOverlay.removeFromParent();
    state.edgeOverlay.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
    state.edgeOverlay = null;
  }

  state.analysisData        = null;
  btnApply.disabled         = true;
  btnClearAnalysis.disabled = true;
}

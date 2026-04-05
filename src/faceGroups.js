import * as THREE from 'three';
import { state } from './state.js';

/**
 * 30 visually distinct colors for face group display, cycling if needed.
 */
const PALETTE = [
  0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231,
  0x911eb4, 0x42d4f4, 0xf032e6, 0xbfef45, 0xfabed4,
  0x469990, 0xdcbeff, 0x9a6324, 0xfffac8, 0x800000,
  0xaaffc3, 0x808000, 0xffd8b1, 0x000075, 0xa9a9a9,
  0xff6b6b, 0x6bcb77, 0x4d96ff, 0xffd93d, 0x845ec2,
  0xd65db1, 0xff9671, 0x00c9a7, 0x0089ba, 0xc34a36,
];

/**
 * Pure computation: group un-indexed STL triangles into planar face groups
 * using a flood-fill over shared edges with a pairwise normal-angle check.
 *
 * @param   {THREE.BufferGeometry} geo
 * @param   {number}               angleTolDeg  Max angle (deg) between adjacent
 *                                              face normals to merge into same group.
 * @returns {{ groupId: Int32Array, groupCount: number } | null}
 *          groupId[triIndex] = group index (0-based)
 */
export function computePlanarFaceGroups(geo, angleTolDeg = 1.0) {
  const posAttr    = geo.getAttribute('position');
  const normalAttr = geo.getAttribute('normal');
  if (!posAttr) return null;

  const PREC      = 4;
  const triCount  = Math.floor(posAttr.count / 3);
  const cosThresh = Math.cos((angleTolDeg * Math.PI) / 180);

  // ── Step 1: per-triangle face normals ───────────────────────────────────
  // Prefer the attribute normals (already computed by STLLoader, one per face).
  // Fall back to cross-product when the attribute is missing or degenerate.
  const triNormals = new Float32Array(triCount * 3);
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    if (normalAttr) {
      fn.set(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i));
    } else {
      fn.set(0, 0, 0); // force fallback below
    }
    if (fn.lengthSq() < 1e-10) {
      va.set(posAttr.getX(i),   posAttr.getY(i),   posAttr.getZ(i));
      vb.set(posAttr.getX(i+1), posAttr.getY(i+1), posAttr.getZ(i+1));
      vc.set(posAttr.getX(i+2), posAttr.getY(i+2), posAttr.getZ(i+2));
      e1.subVectors(vb, va); e2.subVectors(vc, va);
      fn.crossVectors(e1, e2);
    }
    fn.normalize();
    triNormals[t*3]   = fn.x;
    triNormals[t*3+1] = fn.y;
    triNormals[t*3+2] = fn.z;
  }

  // ── Step 2: edge → [triIndex] adjacency ─────────────────────────────────
  function vKey(idx) {
    return posAttr.getX(idx).toFixed(PREC) + ',' +
           posAttr.getY(idx).toFixed(PREC) + ',' +
           posAttr.getZ(idx).toFixed(PREC);
  }
  function edgeKey(a, b) {
    const ka = vKey(a), kb = vKey(b);
    return ka < kb ? ka + '|' + kb : kb + '|' + ka;
  }

  const edgeToTris = new Map();
  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    for (let e = 0; e < 3; e++) {
      const a = i + e, b = i + ((e + 1) % 3);
      const key = edgeKey(a, b);
      let arr = edgeToTris.get(key);
      if (!arr) { arr = []; edgeToTris.set(key, arr); }
      arr.push(t);
    }
  }

  // ── Step 3: flood-fill with pairwise normal check ───────────────────────
  const groupId  = new Int32Array(triCount).fill(-1);
  let   groupCount = 0;

  for (let start = 0; start < triCount; start++) {
    if (groupId[start] !== -1) continue;
    groupId[start] = groupCount;
    const stack = [start];

    while (stack.length > 0) {
      const t  = stack.pop();
      const i  = t * 3;
      const tnx = triNormals[t*3], tny = triNormals[t*3+1], tnz = triNormals[t*3+2];

      for (let e = 0; e < 3; e++) {
        const a = i + e, b = i + ((e + 1) % 3);
        const neighbors = edgeToTris.get(edgeKey(a, b));
        if (!neighbors) continue;
        for (const nt of neighbors) {
          if (groupId[nt] !== -1) continue;
          // Pairwise check: merge if this neighbor's normal is close enough
          // to the current triangle's normal (not the seed, so large flat faces
          // accumulate smoothly across slightly varying triangle normals).
          const dot = tnx*triNormals[nt*3] + tny*triNormals[nt*3+1] + tnz*triNormals[nt*3+2];
          if (dot >= cosThresh) {
            groupId[nt] = groupCount;
            stack.push(nt);
          }
        }
      }
    }
    groupCount++;
  }

  return { groupId, groupCount };
}

/**
 * Apply planar face-group coloring to the current mesh and update the HUD.
 * Uses the drafted geometry when a draft has been applied, otherwise the
 * original geometry (both are always in state.currentMesh.geometry).
 *
 * @param {HTMLInputElement} toleranceInput
 * @param {HTMLElement}      hud
 */
export function runFaceGroupAnalysis(toleranceInput, hud) {
  if (!state.currentMesh) return;

  const geo     = state.currentMesh.geometry;
  const posAttr = geo.getAttribute('position');
  if (!posAttr) return;

  const angleTol = Math.max(0, parseFloat(toleranceInput.value) || 1.0);
  const result   = computePlanarFaceGroups(geo, angleTol);
  if (!result) return;

  const { groupId, groupCount } = result;
  state.faceGroupData = { groupId, groupCount };

  // ── Build per-vertex colour attribute ──────────────────────────────────
  const triCount   = Math.floor(posAttr.count / 3);
  const colors     = new Float32Array(triCount * 3 * 3); // 3 verts × 3 channels
  const paletteObjs = Array.from({ length: Math.min(groupCount, PALETTE.length) },
    (_, g) => new THREE.Color(PALETTE[g % PALETTE.length]));

  for (let t = 0; t < triCount; t++) {
    const c  = paletteObjs[groupId[t] % PALETTE.length];
    for (let v = 0; v < 3; v++) {
      const vi = (t * 3 + v) * 3;
      colors[vi]   = c.r;
      colors[vi+1] = c.g;
      colors[vi+2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.attributes.color.needsUpdate = true;

  // ── Material (reuse if already created) ────────────────────────────────
  if (!state.faceGroupMaterial) {
    state.faceGroupMaterial = new THREE.MeshPhongMaterial({
      vertexColors: true,
      specular:     0x222222,
      shininess:    30,
      side:         THREE.DoubleSide,
    });
  }
  state.currentMesh.material = state.faceGroupMaterial;

  // ── HUD ─────────────────────────────────────────────────────────────────
  const geomLabel = (state.phase === 'applied') ? 'drafted geometry' : 'original geometry (pre-draft)';    // 'previewed' is reverted before we get here
  const triLabel  = triCount.toLocaleString();
  hud.innerHTML =
    `<div class="analysis-legend">
      <div class="legend-counts">
        <strong>${groupCount.toLocaleString()}</strong> planar face groups
        &nbsp;<span class="legend-dim">·&nbsp;${triLabel} triangles&nbsp;·&nbsp;tol&nbsp;${angleTol}°&nbsp;·&nbsp;${geomLabel}</span>
      </div>
    </div>`;
}

/**
 * Remove the face-group coloring and restore the original material.
 */
export function clearFaceGroupVisual() {
  if (!state.currentMesh) return;

  if (state.faceGroupMaterial) {
    state.faceGroupMaterial.dispose();
    state.faceGroupMaterial = null;
  }

  // Restore the correct material depending on pipeline phase
  if (state.phase === 'applied' && state.appliedMeshMaterial) {
    state.currentMesh.material = state.appliedMeshMaterial;
  } else if (state.originalMaterial) {
    state.currentMesh.material = state.originalMaterial;
  }

  // Remove the transient colour attribute (it may conflict with draft analysis)
  const geo = state.currentMesh.geometry;
  if (geo && geo.hasAttribute('color')) geo.deleteAttribute('color');

  state.faceGroupData = null;
}

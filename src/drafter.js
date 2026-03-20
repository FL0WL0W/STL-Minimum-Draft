import * as THREE from 'three';
import { state } from './state.js';
import { computeAnalysisData } from './analysis.js';
import { clipAndRetriangulate } from './clipFaces.js';

const ARC_SEGS = 8; // triangles per curved corner arc

/**
 * Build a new BufferGeometry containing only the triangles that pass the
 * draft test (triPasses[i] === 1).
 */
function buildPrunedGeometry(triPasses) {
  const geo        = state.currentMesh.geometry;
  const posAttr    = geo.getAttribute('position');
  const normalAttr = geo.getAttribute('normal');
  const count      = normalAttr.count;
  const passing    = triPasses.reduce((a, v) => a + v, 0);

  const newPos  = new Float32Array(passing * 9); // 3 verts × 3 coords
  const newNorm = new Float32Array(passing * 9);
  let out = 0;

  for (let i = 0; i < count; i += 3) {
    if (!triPasses[i / 3]) continue;
    for (let v = 0; v < 3; v++) {
      const s = i + v;
      newPos[out * 3]     = posAttr.getX(s);
      newPos[out * 3 + 1] = posAttr.getY(s);
      newPos[out * 3 + 2] = posAttr.getZ(s);
      newNorm[out * 3]     = normalAttr.getX(s);
      newNorm[out * 3 + 1] = normalAttr.getY(s);
      newNorm[out * 3 + 2] = normalAttr.getZ(s);
      out++;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
  g.setAttribute('normal',   new THREE.BufferAttribute(newNorm, 3));
  return g;
}

/**
 * Build the draft geometry (side-wall quads + curved corner arc fans) for all
 * boundary edges.  All coordinates are in mesh local space.
 *
 * @param {Array<{v0,v1,outward}>} boundaryEdges
 * @param {number}                 tanAngle  Math.tan(minDraftAngle in radians)
 * @param {number}                 floorY    Minimum y of the geometry (build plane in local space)
 * @returns {THREE.BufferGeometry}
 */
function buildDraftWalls(boundaryEdges, tanAngle, floorY) {
  const verts = [];  // flat float array: x,y,z ...

  /**
   * Project an edge vertex down to the build plane.
   * Height is always measured from floorY so the offset is always positive.
   */
  function baseOf(v, out) {
    const height = v.y - floorY;          // guaranteed >= 0
    const offset = height * tanAngle;
    return new THREE.Vector3(v.x + offset * out.x, floorY, v.z + offset * out.z);
  }

  function pushTri(a, b, c) {
    for (const p of [a, b, c]) verts.push(p.x, p.y, p.z);
  }

  // cornerMap: vKey → { v, entries: [{out, base}] }
  // Tracks every (outward direction, base point) pair at each vertex so we can
  // fill outside corners with arc fans after building the side walls.
  const PREC = 4;
  const vk = (v) => `${v.x.toFixed(PREC)},${v.y.toFixed(PREC)},${v.z.toFixed(PREC)}`;
  const cornerMap = new Map();

  // ── Side wall quads ──────────────────────────────────────────────────────
  const _edge  = new THREE.Vector3();
  const _slope = new THREE.Vector3();
  const _fn    = new THREE.Vector3();

  for (const { v0, v1, outward } of boundaryEdges) {
    const b0 = baseOf(v0, outward);
    const b1 = baseOf(v1, outward);

    // Determine which winding produces an outward-facing normal.
    // Cross product of (v1-v0) × (b0-v0) tells us which way the face points.
    _edge.subVectors(v1, v0);
    _slope.subVectors(b0, v0);
    _fn.crossVectors(_edge, _slope);

    const clockwise = _fn.dot(outward) >= 0;

    if (clockwise) {
      pushTri(v0, v1, b1);
      pushTri(v0, b1, b0);
    } else {
      pushTri(v1, v0, b0);
      pushTri(v1, b0, b1);
    }

    // Register base points for corner detection
    for (const [v, base, startPoint ] of [[v0, b0, !clockwise], [v1, b1, clockwise]]) {
      const k = vk(v);
      if (!cornerMap.has(k)) cornerMap.set(k, { v, entries: [] });
      cornerMap.get(k).entries.push({ out: outward.clone(), base: base.clone(), startPoint });
    }
  }

  // ── Curved corners ───────────────────────────────────────────────────────
  for (const { v, entries } of cornerMap.values()) {
    if (entries.length < 2) continue;

    const center = new THREE.Vector3(v.x, floorY, v.z);
    const radius = (v.y - floorY) * tanAngle;
    if (radius < 1e-6) continue; // flat vertex, no arc needed

    const startEntries = entries.filter(e => e.startPoint);
    const endEntries   = entries.filter(e => !e.startPoint);

    for(const startEntry of startEntries) {
        const angStart = Math.atan2(startEntry.out.z, startEntry.out.x);
        endEntries.sort((a, b) => {
            const angA = Math.atan2(a.out.z, a.out.x);
            const angB = Math.atan2(b.out.z, b.out.x);
            let spanA = angStart - angA;
            if (spanA <= 0) spanA += Math.PI * 2;
            let spanB = angStart - angB;
            if (spanB <= 0) spanB += Math.PI * 2;
            return spanA - spanB;
        });
        const endEntry = endEntries[0];

        if(!endEntry) continue;

        const angEnd = Math.atan2(endEntry.out.z, endEntry.out.x);
        let span = angEnd - angStart;
        if (span <= 0) span += Math.PI * 2;
        // If span ≥ π it's a concave/inside corner — skip (no convex fill needed)
        if (span >= Math.PI) continue;

        // Arc fan: triangles (v_top, prevBase, nextBase) sweeping from ang0 to ang1
        let prevBase = startEntry.base.clone();
        for (let s = 1; s <= ARC_SEGS; s++) {
            const t       = s / ARC_SEGS;
            const ang     = angStart + span * t;
            const nextBase = new THREE.Vector3(
                center.x + radius * Math.cos(ang),
                floorY,
                center.z + radius * Math.sin(ang),
            );
            // Correct CCW winding for outward-facing normal: (apex, next, prev)
            pushTri(v, nextBase, prevBase);
            prevBase = nextBase;
        }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.computeVertexNormals(); // derives correct slanted normals from actual geometry
  return g;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Apply draft to the current mesh:
 *   1. Back up the original geometry.
 *   2. Remove failing (red) triangles from the mesh geometry.
 *   3. Remove the blue boundary edge overlay.
 *   4. Generate side-wall quads + curved corner arcs; attach as a child mesh.
 *   5. Set state.phase = 'applied'.
 *
 * @param {number} minAngleDeg  The minimum draft angle (degrees).
 */
export function applyDraft(minAngleDeg) {
  if (!state.currentMesh) return;

  const tanAngle = Math.tan(minAngleDeg * Math.PI / 180);
  const data = state.analysisData || computeAnalysisData(minAngleDeg);
  if (!data) return;

  const { triPasses, boundaryEdges } = data;

  // 1. Backup original geometry so we can restore it on revert
  state.preApplyGeometry = state.currentMesh.geometry.clone();

  // 2. Swap in the pruned (passing-faces-only) geometry
  const prunedGeo = buildPrunedGeometry(triPasses);
  state.currentMesh.geometry.dispose();
  state.currentMesh.geometry = prunedGeo;

  // 3. Replace material: green for passing faces (front), red for back faces
  if (state.analysisMaterial) {
    state.analysisMaterial.dispose();
    state.analysisMaterial = null;
  }
  state.appliedMeshMaterial = new THREE.MeshPhongMaterial({
    color:     0x00cc44,
    specular:  0x222222,
    shininess: 30,
    side:      THREE.FrontSide,
  });
  state.currentMesh.material = state.appliedMeshMaterial;

  // Back-face overlay on original mesh: renders inside faces red
  const backMatBody = new THREE.MeshPhongMaterial({
    color:     0xff2233,
    specular:  0x111111,
    shininess: 10,
    side:      THREE.BackSide,
  });
  state.backFaceMesh = new THREE.Mesh(state.currentMesh.geometry, backMatBody);
  state.currentMesh.add(state.backFaceMesh);

  // 4. Remove edge overlay
  if (state.edgeOverlay) {
    state.edgeOverlay.removeFromParent();
    state.edgeOverlay.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
    state.edgeOverlay = null;
  }

  // 5. Build and attach draft walls as a child (inherits mesh transform)
  if (boundaryEdges.length > 0) {
    // Compute the build-plane Y in local geometry space
    state.currentMesh.geometry.computeBoundingBox();
    const floorY = state.currentMesh.geometry.boundingBox.min.y;

    const wallGeo = buildDraftWalls(boundaryEdges, tanAngle, floorY);
    const wallMat = new THREE.MeshPhongMaterial({
      color:     0x4499ff,
      specular:  0x333333,
      shininess: 50,
      side:      THREE.FrontSide,
    });
    state.draftMesh = new THREE.Mesh(wallGeo, wallMat);

    // Back-face overlay on draft walls: renders inside faces red
    const backMatWall = new THREE.MeshPhongMaterial({
      color:     0xff2233,
      specular:  0x111111,
      shininess: 10,
      side:      THREE.BackSide,
    });
    state.draftMesh.add(new THREE.Mesh(wallGeo, backMatWall));
    state.currentMesh.add(state.draftMesh);
  }

  // Clip merged geometry (pruned faces + draft walls) and replace scene meshes
  const clippedGeo = clipAndRetriangulate(
    state.currentMesh.geometry,
    state.draftMesh?.geometry ?? null,
  );

  // Remove the separate draft-wall mesh — it's now baked into clippedGeo
  if (state.draftMesh) {
    for (const child of state.draftMesh.children) {
      child.material.dispose();
    }
    state.draftMesh.removeFromParent();
    state.draftMesh.geometry.dispose();
    state.draftMesh.material.dispose();
    state.draftMesh = null;
  }

  // Remove old back-face overlay (shared the old pruned geometry)
  if (state.backFaceMesh) {
    state.backFaceMesh.removeFromParent();
    state.backFaceMesh.material.dispose();
    state.backFaceMesh = null;
  }

  // Swap currentMesh to the unified clipped geometry
  state.currentMesh.geometry.dispose();
  state.currentMesh.geometry = clippedGeo;

  // Re-attach back-face overlay on the new unified geometry
  const backMatUnified = new THREE.MeshPhongMaterial({
    color:     0xff2233,
    specular:  0x111111,
    shininess: 10,
    side:      THREE.BackSide,
  });
  state.backFaceMesh = new THREE.Mesh(clippedGeo, backMatUnified);
  state.currentMesh.add(state.backFaceMesh);

  state.phase = 'applied';
}

/**
 * Undo the last applyDraft():
 *   - Remove draft wall mesh.
 *   - Restore the backed-up pre-apply geometry.
 *   - Set state.phase = 'analyze'.
 *
 * No-op if already in analyze phase.
 */
export function revertApply() {
  if (state.phase !== 'applied') return;

  if (state.draftMesh) {
    // Dispose children (back-face meshes) before disposing the parent
    for (const child of state.draftMesh.children) {
      child.material.dispose();
      // geometry is shared with parent — don't dispose it here
    }
    state.draftMesh.removeFromParent();
    state.draftMesh.geometry.dispose();
    state.draftMesh.material.dispose();
    state.draftMesh = null;
  }

  if (state.backFaceMesh) {
    state.backFaceMesh.removeFromParent();
    state.backFaceMesh.material.dispose();
    // geometry is shared with currentMesh — don't dispose it here
    state.backFaceMesh = null;
  }

  if (state.appliedMeshMaterial) {
    state.appliedMeshMaterial.dispose();
    state.appliedMeshMaterial = null;
  }

  if (state.preApplyGeometry && state.currentMesh) {
    state.currentMesh.geometry.dispose();
    state.currentMesh.geometry = state.preApplyGeometry;
    state.preApplyGeometry = null;
  }

  // Restore a valid material so nothing renders with a disposed one
  if (state.currentMesh && state.originalMaterial) {
    state.currentMesh.material = state.originalMaterial;
  }

  state.phase = 'analyze';
}

import * as THREE from 'three';
import { state } from './state.js';
import { computeAnalysisData } from './analysis.js';
import { clipAndRetriangulate } from './clipFaces.js';
import { earcutToTriangles } from './earcutTriangulate.js';

const precision = 1; // 1mm

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
 * @param {Array<{v0,v1}>} boundaryEdges
 * @param {number}                 tanAngle  Math.tan(minDraftAngle in radians)
 * @param {number}                 floorY    Minimum y of the geometry (build plane in local space)
 * @returns {THREE.BufferGeometry}
 */
function buildDraftWalls(boundaryEdges, tanAngle, floorY) {
  // Polygon faces collected here; each is { normal, origin, loops } compatible
  // with earcutToTriangles.  Side walls become quads, arc segments become
  // triangles — all earcut in step 5 below.
  const polygonFaces = [];

  /**
   * Project an edge vertex down to the build plane.
   * Height is always measured from floorY so the offset is always positive.
   */
  function baseOf(v, out) {
    const height = v.y - floorY;          // guaranteed >= 0
    return new THREE.Vector3(v.x + height * out.x, floorY, v.z + height * out.z);
  }

  /** Convert a THREE.Vector3 to the [x,y,z] array form expected by earcutToTriangles. */
  function va(v) { return [v.x, v.y, v.z]; }

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

  for (const bedge of boundaryEdges) {
    const v0 = bedge.v0.clone();
    const v1 = bedge.v1.clone();
    if(bedge.v0.y > bedge.v1.y) {
      const prevEdge = boundaryEdges.find(e => e.v1.equals(bedge.v0))
      if(prevEdge)
        v0.add(prevEdge.v0.clone().sub(prevEdge.v1).cross(new THREE.Vector3(0,1,0)).normalize().multiplyScalar(tanAngle).multiplyScalar(bedge.v0.y - bedge.v1.y)).setY(bedge.v1.y)
    } else if (bedge.v1.y > bedge.v0.y) {
      const nextEdge = boundaryEdges.find(e => e.v0.equals(bedge.v1))
      if(nextEdge)
        v1.add(nextEdge.v0.clone().sub(nextEdge.v1).cross(new THREE.Vector3(0,1,0)).normalize().multiplyScalar(tanAngle).multiplyScalar(bedge.v1.y - bedge.v0.y)).setY(bedge.v0.y)
    }
    
    bedge.outward = v0.clone().sub(v1).cross(new THREE.Vector3(0,1,0)).normalize()
    bedge.b0 = baseOf(bedge.v0, bedge.outward.clone().multiplyScalar(tanAngle))
    bedge.b1 = baseOf(bedge.v1, bedge.outward.clone().multiplyScalar(tanAngle))
  }

  for (const { v0, v1, outward, b0, b1, highlight } of boundaryEdges) {


    // Determine which winding produces an outward-facing normal.
    // Cross product of (v1-v0) × (b0-v0) tells us which way the face points. 
    _edge.subVectors(v1, v0);
    _slope.subVectors(b0, v0);
    _fn.crossVectors(_edge, _slope);

    const clockwise = _fn.dot(outward) >= 0;
    const normal    = [_fn.x, _fn.y, _fn.z]; // earcut normalises internally

    // Build as a quad polygon face (CCW winding for outward-facing normal)
    const loop = clockwise
      ? [va(v0), va(v1), va(b1), va(b0)]
      : [va(v1), va(v0), va(b0), va(b1)];
    polygonFaces.push({ normal, origin: loop[0], loops: [loop] });

    // Register base points for corner detection
    for (const [v, base, startPoint] of [[v0, b0, !clockwise], [v1, b1, clockwise]]) {
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

    for (const startEntry of startEntries) {
      const angStart = Math.atan2(startEntry.out.z, startEntry.out.x);
      endEntries.sort((a, b) => {
        const angA = Math.atan2(a.out.z, a.out.x);
        const angB = Math.atan2(b.out.z, b.out.x);
        let spanA = angStart - angA; if (spanA <= 0) spanA += Math.PI * 2;
        let spanB = angStart - angB; if (spanB <= 0) spanB += Math.PI * 2;
        return spanA - spanB;
      });
      const endEntry = endEntries[0];
      if (!endEntry) continue;

      const angEnd = Math.atan2(endEntry.out.z, endEntry.out.x);
      let span = angEnd - angStart;
      if (span <= 0) span += Math.PI * 2;
      // If span ≥ π it's a concave/inside corner — skip (no convex fill needed)
      if (span >= Math.PI) continue;

      // Arc fan: one triangle polygon face per segment, sweeping from angStart to angEnd
      let prevBase = startEntry.base.clone();
      const segs = Math.max(1, Math.ceil(radius * span / precision));
      for (let s = 1; s <= segs; s++) {
        const t       = s / segs;
        const ang     = angStart + span * t;
        const nextBase = new THREE.Vector3(
          center.x + radius * Math.cos(ang),
          floorY,
          center.z + radius * Math.sin(ang),
        );
        // Winding: (apex, next, prev) for outward-facing normal
        const a = va(v), b = va(nextBase), c = va(prevBase);
        const ab = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
        const ac = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
        const triNormal = [
          ab[1]*ac[2] - ab[2]*ac[1],
          ab[2]*ac[0] - ab[0]*ac[2],
          ab[0]*ac[1] - ab[1]*ac[0],
        ];
        polygonFaces.push({ normal: triNormal, origin: a, loops: [[a, b, c]] });
        prevBase = nextBase;
      }
    }
  }

  // ── Step 5: Earcut draftwall polygon faces into triangles ─────────────────
  const triVerts = earcutToTriangles(polygonFaces);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(triVerts, 3));
  g.computeVertexNormals(); // derives correct slanted normals from actual geometry
  return g;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Preview draft — fast synchronous path:
 *   1. Back up original geometry.
 *   2. Swap in the pruned (passing-faces-only) geometry.
 *   3. Set materials (green passing faces, red back-faces).
 *   4. Build and attach draft walls.
 *   state.phase → 'previewed'
 *
 * @param {number} minAngleDeg
 */
export function previewDraft(minAngleDeg) {
  if (!state.currentMesh) return;

  const tanAngle = Math.tan(minAngleDeg * Math.PI / 180);
  const data = state.analysisData || computeAnalysisData(minAngleDeg);
  if (!data) return;

  const { triPasses, boundaryEdges } = data;

  // 1. Backup original geometry so we can restore it on revert
  state.preApplyGeometry = state.currentMesh.geometry.clone();

  // 2. Swap in the pruned geometry
  const prunedGeo = buildPrunedGeometry(triPasses);
  state.currentMesh.geometry.dispose();
  state.currentMesh.geometry = prunedGeo;

  // 3. Replace material: green passing faces (front), red back-faces
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

  // 5. Build and attach draft walls
  if (boundaryEdges.length > 0) {
    state.preApplyGeometry.computeBoundingBox();
    const floorY = state.preApplyGeometry.boundingBox.min.y;

    const wallGeo = buildDraftWalls(boundaryEdges, tanAngle, floorY);
    const wallMat = new THREE.MeshPhongMaterial({
      color:     0x4499ff,
      specular:  0x333333,
      shininess: 50,
      side:      THREE.FrontSide,
    });
    state.draftMesh = new THREE.Mesh(wallGeo, wallMat);

    const backMatWall = new THREE.MeshPhongMaterial({
      color:     0xff2233,
      specular:  0x111111,
      shininess: 10,
      side:      THREE.BackSide,
    });
    state.draftMesh.add(new THREE.Mesh(wallGeo, backMatWall));
    state.currentMesh.add(state.draftMesh);
  }

  state.phase = 'previewed';
}

/**
 * Apply draft — async expensive path.
 * Must be called after previewDraft() has run (state.phase === 'previewed').
 * Runs the clip-and-retriangulate pipeline on the previewed geometry.
 *
 * @param {(pct: number) => void} [onProgress]
 * @param {AbortSignal}            [signal]
 * @param {() => Promise<void>}    [waitIfPaused]
 */
export async function applyDraft(onProgress, signal, waitIfPaused) {
  if (!state.currentMesh || state.phase !== 'previewed') return;
  const clippedGeo = await clipAndRetriangulate(
    state.currentMesh.geometry,
    state.draftMesh?.geometry ?? null,
    onProgress,
    signal,
    waitIfPaused,
    state.currentFileName,
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
  // Handles previewed, applied, and mid-apply cancellation states.
  if (state.phase !== 'applied' && state.phase !== 'previewed' && !state.preApplyGeometry) return;

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

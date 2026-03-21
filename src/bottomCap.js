/**
 * bottomCap.js
 *
 * Synthesises a horizontal floor-cap polygon group from the boundary loops of
 * an existing set of polygon groups.
 *
 * In Three.js local space Y is the height axis, so "bottom" = globalMinY.
 *
 * Algorithm:
 *   1. Find globalMinY.
 *   2. Grid-snap all floor-level edge endpoints (reliable welding without O(n²)).
 *   3. Cancel anti-parallel duplicates: a→b and b→a cancel each other, leaving
 *      only the true outer-boundary half-edges.
 *   4. Build per-node adjacency sorted by angle.
 *   5. Walk half-edges using the planar-face "next CW half-edge" rule to extract
 *      correct closed loops even at T-junctions or coincident edges.
 *   6. Wrap results into a polygon group ready for earcutTriangulate.
 *
 * Export:
 *   addBottomCapGroup(polygonGroups) → polygonGroups + bottom cap appended
 */

/**
 * @param {Array<{ normal, origin, loops, bbox }>} polygonGroups
 * @returns {Array<{ normal, origin, loops, bbox }>}
 */
export function addBottomCapGroup(polygonGroups) {
  if (!polygonGroups.length) return polygonGroups;

  //compute globalMins and Maxs
  let globalMinY = Infinity, globalMaxY = -Infinity;
  let globalMinX = Infinity, globalMaxX = -Infinity;
  let globalMinZ = Infinity, globalMaxZ = -Infinity;
  for (const pg of polygonGroups) {
    if (!pg?.loops) continue;
    const { bbox } = pg;
    if (!bbox) continue;
    if (bbox.minY < globalMinY) globalMinY = bbox.minY;
    if (bbox.maxY > globalMaxY) globalMaxY = bbox.maxY;
    if (bbox.minX < globalMinX) globalMinX = bbox.minX;
    if (bbox.maxX > globalMaxX) globalMaxX = bbox.maxX;
    if (bbox.minZ < globalMinZ) globalMinZ = bbox.minZ;
    if (bbox.maxZ > globalMaxZ) globalMaxZ = bbox.maxZ;
  }
  const maxAbs = Math.max(
    Math.abs(globalMinX), Math.abs(globalMaxX),
    Math.abs(globalMinY), Math.abs(globalMaxY),
    Math.abs(globalMinZ), Math.abs(globalMaxZ),
  );
  
  const EPS_Y = Math.max(Math.abs(globalMinY), Math.abs(globalMaxY)) / (1 << 23);   // floor membership tolerance
  const EPS_G2 = Math.pow(maxAbs / (1 << 10), 2);   // weld loop tolerance, something is wrong about this calculation, i don't quite understand why it can't be a smaller value
  console.log(`globalMinY: ${globalMinY}, EPS_Y: ${EPS_Y}, EPS_G2: ${EPS_G2}`);

  const edges = []

  function addEdge(p0, p1) {
    if (Math.abs(p0[1] - globalMinY) > EPS_Y) return;
    if (Math.abs(p1[1] - globalMinY) > EPS_Y) return;

    edges.push({ a: p0, b: p1 });
  }

  for (const g of polygonGroups) {
    if (!g?.loops) continue;
    for (const loop of g.loops) {
      if (!loop || loop.length < 2) continue;
      const n = loop.length;
      for (let i = 0; i < n; i++)
        addEdge(loop[i], loop[(i + 1) % n]);
    }
  }
  
  const bottomLoops = [];

  while(edges.length) {
    const loop = [];
    let { a, b } = edges.pop();
    const first = a;
    while(true) {
      loop.push({ ...a, [1]: globalMinY });  // snap to globalMinY plane
      if(Math.pow(b[0] - first[0], 2) + Math.pow(b[2] - first[2], 2) < EPS_G2) break;
      let closestEdgeIndex = -1, closestDist = Infinity;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const dist = Math.pow(e.a[0] - b[0], 2) + Math.pow(e.a[2] - b[2], 2);
        if (dist < closestDist) {
          closestDist = dist;
          closestEdgeIndex = i;
        }
      }
      if (closestEdgeIndex === -1) break;
      if (closestDist > EPS_G2) break;
      const nextEdge = edges.splice(closestEdgeIndex, 1)[0];
      a = nextEdge.a;
      b = nextEdge.b;
    }
    bottomLoops.push(loop);
  }

  if (!bottomLoops.length) return polygonGroups;

  // ── 7) Build bbox ─────────────────────────────────────────────────────────
  let bminX= Infinity, bmaxX=-Infinity;
  let bminY= Infinity, bmaxY=-Infinity;
  let bminZ= Infinity, bmaxZ=-Infinity;
  for (const loop of bottomLoops)
    for (const p of loop) {
      if (p[0]<bminX) bminX=p[0]; if (p[0]>bmaxX) bmaxX=p[0];
      if (p[1]<bminY) bminY=p[1]; if (p[1]>bmaxY) bmaxY=p[1];
      if (p[2]<bminZ) bminZ=p[2]; if (p[2]>bmaxZ) bmaxZ=p[2];
    }

  return [...polygonGroups, {
    normal: [0, -1, 0],          // pointing downward in Y-up space
    origin: [0, globalMinY, 0],
    loops:  bottomLoops,
    bbox:   { minX:bminX, maxX:bmaxX, minY:bminY, maxY:bmaxY, minZ:bminZ, maxZ:bmaxZ },
  }];
}

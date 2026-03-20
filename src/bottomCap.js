/**
 * bottomCap.js
 *
 * Synthesises a horizontal floor-cap polygon group from the boundary loops of
 * an existing set of polygon groups.
 *
 * In Three.js local space Y is the height axis, so "bottom" = globalMinY.
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

  // 1) Find globalMinY via bbox when available
  let globalMinY = Infinity;
  for (const g of polygonGroups) {
    if (!g?.loops) continue;
    if (g.bbox && isFinite(g.bbox.minY)) {
      if (g.bbox.minY < globalMinY) globalMinY = g.bbox.minY;
    } else {
      for (const loop of g.loops)
        for (const p of loop)
          if (p[1] < globalMinY) globalMinY = p[1];
    }
  }
  if (!isFinite(globalMinY)) return polygonGroups;

  // 2) Diagonal of the XZ footprint drives tolerances
  let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
  for (const g of polygonGroups) {
    if (!g?.loops) continue;
    for (const loop of g.loops)
      for (const p of loop) {
        if (p[0]<minX) minX=p[0]; if (p[0]>maxX) maxX=p[0];
        if (p[2]<minZ) minZ=p[2]; if (p[2]>maxZ) maxZ=p[2];
      }
  }
  const diag      = Math.hypot(maxX-minX, maxZ-minZ) || 1;
  const EPS_Y     = diag * 1e-6;
  const EPS_MERGE = diag * 1e-4;
  const EPS_MERGE2 = EPS_MERGE * EPS_MERGE;

  // 3) Gather segments whose both endpoints lie on the floor plane
  const rawSegs = [];
  for (const g of polygonGroups) {
    if (!g?.loops) continue;
    for (const loop of g.loops) {
      if (!loop || loop.length < 2) continue;
      const n = loop.length;
      for (let i = 0; i < n; i++) {
        const p0 = loop[i];
        const p1 = loop[(i+1) % n];
        if (Math.abs(p0[1] - globalMinY) <= EPS_Y &&
            Math.abs(p1[1] - globalMinY) <= EPS_Y) {
          rawSegs.push({
            a: [p0[0], globalMinY, p0[2]],
            b: [p1[0], globalMinY, p1[2]],
          });
        }
      }
    }
  }
  if (!rawSegs.length) return polygonGroups;

  // 4) Cluster endpoints with EPS_MERGE tolerance into nodes
  const nodes    = [];  // { pt:[x,y,z], edges:[segIdx,...] }
  const segments = [];  // { aNode, bNode }

  function findOrCreate(p) {
    let bestIdx = -1, bestD2 = EPS_MERGE2;
    for (let i = 0; i < nodes.length; i++) {
      const q  = nodes[i].pt;
      const dx = p[0] - q[0], dz = p[2] - q[2];
      const d2 = dx*dx + dz*dz;
      if (d2 <= bestD2) { bestD2 = d2; bestIdx = i; }
    }
    if (bestIdx >= 0) return bestIdx;
    nodes.push({ pt: [p[0], globalMinY, p[2]], edges: [] });
    return nodes.length - 1;
  }

  rawSegs.forEach((seg, idx) => {
    const ai = findOrCreate(seg.a);
    const bi = findOrCreate(seg.b);
    segments[idx] = { aNode: ai, bNode: bi };
  });
  segments.forEach((s, idx) => {
    nodes[s.aNode].edges.push(idx);
    nodes[s.bNode].edges.push(idx);
  });

  // 5) Walk node graph into closed loops
  const usedSeg     = new Uint8Array(segments.length);
  const bottomLoops = [];

  for (let si = 0; si < segments.length; si++) {
    if (usedSeg[si]) continue;
    const s0        = segments[si];
    const startNode = s0.aNode;
    let curNode     = s0.bNode;
    usedSeg[si]     = 1;

    const idxs = [startNode, curNode];

    for (;;) {
      const v = nodes[curNode];
      if (!v) break;
      let nextSeg = -1;
      for (const ei of v.edges) {
        if (!usedSeg[ei]) { nextSeg = ei; break; }
      }
      if (nextSeg === -1) break;
      usedSeg[nextSeg] = 1;
      const s        = segments[nextSeg];
      const nextNode = s.aNode === curNode ? s.bNode : s.aNode;
      if (nextNode === startNode) { idxs.push(startNode); break; }
      curNode = nextNode;
      idxs.push(curNode);
    }

    if (idxs.length >= 3)
      bottomLoops.push(idxs.map(i => nodes[i].pt.slice()));
  }

  if (!bottomLoops.length) return polygonGroups;

  // 6) Build bbox for the new group
  let bminX=Infinity, bmaxX=-Infinity;
  let bminY=Infinity, bmaxY=-Infinity;
  let bminZ=Infinity, bmaxZ=-Infinity;
  for (const loop of bottomLoops)
    for (const p of loop) {
      if (p[0]<bminX) bminX=p[0]; if (p[0]>bmaxX) bmaxX=p[0];
      if (p[1]<bminY) bminY=p[1]; if (p[1]>bmaxY) bmaxY=p[1];
      if (p[2]<bminZ) bminZ=p[2]; if (p[2]>bmaxZ) bmaxZ=p[2];
    }

  const bottomGroup = {
    normal: [0, -1, 0],          // pointing downward in Y-up space
    origin: [0, globalMinY, 0],
    loops:  bottomLoops,
    bbox:   { minX:bminX, maxX:bmaxX, minY:bminY, maxY:bmaxY, minZ:bminZ, maxZ:bmaxZ },
  };

  return [...polygonGroups, bottomGroup];
}

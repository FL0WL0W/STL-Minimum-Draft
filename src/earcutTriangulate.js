/**
 * earcutTriangulate.js
 *
 * Re-triangulates an array of polygon groups (each with 3-D boundary loops) using
 * earcut, handling outer rings and holes via a signed-area containment tree.
 *
 * Export:
 *   earcutToTriangles(polygonGroups) → Float32Array  (flat x,y,z,...)
 */

import earcut from 'earcut';

// ── Vector helpers ────────────────────────────────────────────────────────────

function vsub(a, b)   { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function vscale(a, s) { return [a[0]*s, a[1]*s, a[2]*s]; }
function vdot(a, b)   { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function vlen(a)      { return Math.hypot(a[0], a[1], a[2]); }
function vcross(a, b) {
  return [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0],
  ];
}
function vnorm(a) {
  const l = vlen(a);
  return l < 1e-12 ? [0, 0, 0] : vscale(a, 1 / l);
}

// ── 2-D helpers ───────────────────────────────────────────────────────────────

function signedArea2D(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i+1) % n];
    a += x1*y2 - x2*y1;
  }
  return 0.5 * a;
}

function pointInPolygon2D(pt, poly) {
  let inside = false;
  const [px, py] = pt;
  const n = poly.length;
  for (let i = 0, j = n-1; i < n; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (((yi > py) !== (yj > py)) && (px < (xj-xi)*(py-yi)/(yj-yi)+xi))
      inside = !inside;
  }
  return inside;
}

function centroid2D(pts) {
  let a=0, cx=0, cy=0;
  const n = pts.length;
  for (let i=0; i<n; i++) {
    const [x1,y1] = pts[i], [x2,y2] = pts[(i+1)%n];
    const cross = x1*y2 - x2*y1;
    a += cross; cx += (x1+x2)*cross; cy += (y1+y2)*cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-12) {
    cx = cy = 0;
    for (const [x,y] of pts) { cx += x; cy += y; }
    return [cx/n, cy/n];
  }
  const f = 1 / (6*a);
  return [cx*f, cy*f];
}

// ── Public export ─────────────────────────────────────────────────────────────

/**
 * @param {Array<{ normal, origin, loops, bbox }>} polygonGroups
 * @returns {Float32Array}  flat [x,y,z, ...]
 */
export function earcutToTriangles(polygonGroups) {
  const result = [];

  for (const pg of polygonGroups) {
    if (!pg.loops?.length) continue;

    let { normal, origin } = pg;
    if (!origin) { if (pg.loops[0]?.[0]) origin = pg.loops[0][0]; else continue; }
    if (!normal) {
      let found = false;
      outer: for (const loop of pg.loops)
        for (let i=0; i+2<loop.length; i++) {
          const n = vnorm(vcross(vsub(loop[i+1], loop[i]), vsub(loop[i+2], loop[i])));
          if (vlen(n) < 1e-8) continue;
          normal = n; found = true; break outer;
        }
      if (!found) continue;
    }
    const nl = vlen(normal);
    if (nl < 1e-8) continue;
    if (Math.abs(nl - 1) > 1e-3) normal = vscale(normal, 1/nl);

    // Local 2-D basis on the plane
    let t     = Math.abs(normal[0]) < 0.9 ? [1,0,0] : [0,1,0];
    let xAxis = vnorm(vcross(t, normal));
    if (vlen(xAxis) < 1e-8) {
      t = [0,0,1]; xAxis = vnorm(vcross(t, normal));
      if (vlen(xAxis) < 1e-8) continue;
    }
    const yAxis = vcross(normal, xAxis);

    const proj2D = p => { const r = vsub(p, origin); return [vdot(r, xAxis), vdot(r, yAxis)]; };

    // Project + metadata per loop
    const meta = [];
    for (let i=0; i<pg.loops.length; i++) {
      const loop3D = pg.loops[i];
      if (!loop3D || loop3D.length < 3) continue;
      const loop2D = loop3D.map(proj2D);
      const area   = signedArea2D(loop2D);
      if (Math.abs(area) < 1e-12) continue;
      meta.push({ loop3D, loop2D, area, centroid: centroid2D(loop2D), parent: -1, depth: 0 });
    }
    if (!meta.length) continue;

    // Containment tree (sorted largest-first so parents always precede children)
    meta.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
    for (let i=0; i<meta.length; i++) {
      const child = meta[i];
      let bestParent = -1, bestArea = Infinity;
      for (let j=0; j<meta.length; j++) {
        if (i === j) continue;
        const cand = meta[j];
        if (Math.abs(cand.area) <= Math.abs(child.area)) continue;
        if (pointInPolygon2D(child.centroid, cand.loop2D)) {
          const a = Math.abs(cand.area);
          if (a < bestArea) { bestArea = a; bestParent = j; }
        }
      }
      child.parent = bestParent;
    }

    const computeDepth = (idx) => {
      const node = meta[idx];
      if (node.parent === -1) { node.depth = 0; return 0; }
      node.depth = computeDepth(node.parent) + 1;
      return node.depth;
    };
    for (let i=0; i<meta.length; i++) computeDepth(i);

    // Triangulate each outer ring (even depth) with its direct hole children (odd depth)
    for (let i=0; i<meta.length; i++) {
      const outer = meta[i];
      if (outer.depth % 2 !== 0) continue;

      const holes = meta.filter(m => m.parent === i && m.depth === outer.depth+1);

      const vertices = [];
      const verts3D  = [];
      const holeIdxs = [];

      function addRing(m, isHole) {
        let { loop3D, loop2D, area } = m;
        if (!isHole && area < 0) { loop3D = [...loop3D].reverse(); loop2D = [...loop2D].reverse(); }
        if ( isHole && area > 0) { loop3D = [...loop3D].reverse(); loop2D = [...loop2D].reverse(); }
        if (isHole) holeIdxs.push(vertices.length / 2);
        for (let k=0; k<loop2D.length; k++) {
          vertices.push(loop2D[k][0], loop2D[k][1]);
          verts3D.push(loop3D[k]);
        }
      }

      addRing(outer, false);
      for (const h of holes) addRing(h, true);

      if (vertices.length < 6) continue;

      const indices = earcut(vertices, holeIdxs, 2);
      for (let t=0; t<indices.length; t+=3) {
        const a = verts3D[indices[t]];
        const b = verts3D[indices[t+1]];
        const c = verts3D[indices[t+2]];
        result.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
      }
    }
  }

  return new Float32Array(result);
}

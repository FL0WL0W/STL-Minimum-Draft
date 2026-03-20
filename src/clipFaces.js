/**
 * clipFaces.js
 *
 * Steps 1–3 + 6 of the STL export pipeline, operating on merged geometry:
 *
 *   1. buildPlanarFacePolygons   – bucket triangles by coplanar plane key
 *   2. planarFacesToPolygonLoops – trace boundary loops for each planar group
 *   3. clipPolygonGroups         – subtract intersecting geometry (ClipperLib)
 *   6. earcutToTriangles         – re-triangulate clipped loops (earcut)
 *
 * Entry point:
 *   clipAndRetriangulate(prunedGeo, draftWallGeo) → Float32Array (flat xyz)
 */

import * as THREE from 'three';
import earcut     from 'earcut';
import ClipperLib from 'clipper-lib';

// ── Tiny plain-array vector helpers ──────────────────────────────────────────

function vadd(a, b)    { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function vsub(a, b)    { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function vscale(a, s)  { return [a[0]*s, a[1]*s, a[2]*s]; }
function vdot(a, b)    { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function vlen(a)       { return Math.hypot(a[0], a[1], a[2]); }
function vcross(a, b)  {
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

// ── Step 1: Group triangles by coplanar plane ─────────────────────────────────

/**
 * @param {Float32Array|number[]} triArray  flat [x0,y0,z0, x1,y1,z1, x2,y2,z2, ...]
 * @returns {{ tris: Array<{p0,p1,p2}>, groups: Array<{tris: number[]}> }}
 */
function buildPlanarFacePolygons(triArray) {
  const triCount   = triArray.length / 9;
  const tris       = new Array(triCount);
  const groupsMap  = new Map();

  const SCALE = 1e10;

  function planeKey(p0, p1, p2) {
    const e1 = vsub(p1, p0);
    const e2 = vsub(p2, p0);
    let n = vnorm(vcross(e1, e2));
    // Normalise sign so opposite-facing planes get distinct keys
    const d = vdot(n, p0);
    const kx = Math.round(n[0] * SCALE);
    const ky = Math.round(n[1] * SCALE);
    const kz = Math.round(n[2] * SCALE);
    const kd = Math.round(d    * SCALE);
    return `${kx},${ky},${kz},${kd}`;
  }

  for (let i = 0; i < triCount; i++) {
    const b  = i * 9;
    const p0 = [triArray[b],   triArray[b+1], triArray[b+2]];
    const p1 = [triArray[b+3], triArray[b+4], triArray[b+5]];
    const p2 = [triArray[b+6], triArray[b+7], triArray[b+8]];

    tris[i] = { p0, p1, p2 };

    const key = planeKey(p0, p1, p2);
    let g = groupsMap.get(key);
    if (!g) { g = { tris: [] }; groupsMap.set(key, g); }
    g.tris.push(i);
  }

  return { tris, groups: [...groupsMap.values()] };
}

// ── Step 2: Trace boundary loops per planar group ─────────────────────────────

/**
 * @param {{ tris, groups }} planar
 * @returns {Array<{ normal, origin, loops, bbox }>}
 */
function planarFacesToPolygonLoops(planar) {
  const { tris, groups } = planar;
  const result = [];

  function vkey(p) { return `${p[0]},${p[1]},${p[2]}`; }

  for (const group of groups) {
    if (!group.tris.length) continue;

    // --- plane normal + origin ---
    let normal = null, origin = null;
    for (const idx of group.tris) {
      const { p0, p1, p2 } = tris[idx];
      const n = vnorm(vcross(vsub(p1, p0), vsub(p2, p0)));
      if (vlen(n) < 1e-8) continue;
      normal = n;
      origin = p0;
      break;
    }
    if (!normal) continue;

    // --- boundary edges (count == 1) ---
    const edgeMap = new Map();
    for (const idx of group.tris) {
      const { p0, p1, p2 } = tris[idx];
      for (const [a, b] of [[p0, p1], [p1, p2], [p2, p0]]) {
        const ka = vkey(a), kb = vkey(b);
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        let rec = edgeMap.get(key);
        if (!rec) { rec = { a, b, count: 0 }; edgeMap.set(key, rec); }
        rec.count++;
      }
    }

    const boundaryEdges = [];
    for (const rec of edgeMap.values()) {
      if (rec.count === 1)
        boundaryEdges.push({ a: rec.a, b: rec.b, aKey: vkey(rec.a), bKey: vkey(rec.b) });
    }
    if (!boundaryEdges.length) continue;

    // --- vertex → incident edge adjacency ---
    const vertexMap = new Map();
    function ensureVert(p) {
      const k = vkey(p);
      let v = vertexMap.get(k);
      if (!v) { v = { p, edges: [] }; vertexMap.set(k, v); }
      return v;
    }
    boundaryEdges.forEach((e, i) => {
      ensureVert(e.a).edges.push(i);
      ensureVert(e.b).edges.push(i);
    });

    if (vertexMap.size < 3) continue;

    // --- walk loops ---
    const usedEdges = new Uint8Array(boundaryEdges.length);
    const loops = [];

    for (let si = 0; si < boundaryEdges.length; si++) {
      if (usedEdges[si]) continue;
      const se = boundaryEdges[si];
      let curKey  = se.aKey;
      let curEdge = si;
      const loop  = [];
      const maxSteps = boundaryEdges.length * 2 + 10;

      for (let step = 0; step < maxSteps; step++) {
        usedEdges[curEdge] = 1;
        const v = vertexMap.get(curKey);
        if (!v) break;
        loop.push(v.p);

        const e = boundaryEdges[curEdge];
        const nextKey = (e.aKey === curKey) ? e.bKey : e.aKey;

        if (nextKey === se.aKey && loop.length >= 3) break;

        const nextVert = vertexMap.get(nextKey);
        if (!nextVert) break;
        let nextEdge = -1;
        for (const ei of nextVert.edges) {
          if (!usedEdges[ei]) { nextEdge = ei; break; }
        }
        if (nextEdge === -1) break;

        curKey  = nextKey;
        curEdge = nextEdge;
      }

      if (loop.length >= 3) loops.push(loop);
    }

    if (!loops.length) continue;

    // --- 3-D bounding box ---
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
    for (const loop of loops)
      for (const p of loop) {
        if (p[0]<minX) minX=p[0]; if (p[0]>maxX) maxX=p[0];
        if (p[1]<minY) minY=p[1]; if (p[1]>maxY) maxY=p[1];
        if (p[2]<minZ) minZ=p[2]; if (p[2]>maxZ) maxZ=p[2];
      }

    result.push({ normal, origin, loops, bbox: { minX, maxX, minY, maxY, minZ, maxZ } });
  }

  return result;
}

// ── Step 3: Clip overlapping polygon groups ───────────────────────────────────

/**
 * @param {Array<{ normal, origin, loops, bbox }>} polygonGroups
 * @returns {Array<{ normal, origin, loops, bbox }>}
 */
function clipPolygonGroups(polygonGroups) {
  if (!polygonGroups.length) return [];

  const SCALE = 1e6;

  // In Three.js local space Y is the height (draft) axis; X and Z are lateral.
  function bboxOverlapXZ(b1, b2) {
    return !(b1.maxX < b2.minX || b2.maxX < b1.minX ||
             b1.maxZ < b2.minZ || b2.maxZ < b1.minZ);
  }

  // Returns y = f(x, z) for the plane defined by normal + origin.
  // Returns null when the plane is (nearly) horizontal — normal[1] ≈ 0 means
  // we cannot uniquely solve for y, so the group is passed through unclipped.
  function buildYPlane(normal, origin) {
    if (!normal || !origin || Math.abs(normal[1]) < 1e-9) return null;
    const d      = vdot(normal, origin);
    const invNy  = 1 / normal[1];
    return (x, z) => (d - normal[0]*x - normal[2]*z) * invNy;
  }

  // Intersect segment p0→p1 with the plane; return the intersection point
  // with its Y coordinate snapped to the plane equation y = yFn(x, z).
  function intersectSegPlane(p0, p1, normal, origin, yFn) {
    const v     = vsub(p1, p0);
    const denom = vdot(normal, v);
    if (Math.abs(denom) < 1e-9) return null;
    const t  = vdot(normal, vsub(origin, p0)) / denom;
    const tt = Math.max(0, Math.min(1, t));
    const x  = p0[0] + v[0]*tt;
    const z  = p0[2] + v[2]*tt;
    return [x, yFn(x, z), z];
  }

  function clipGroupWithCuts(gCur, cutLoops) {
    if (!cutLoops.length) return { ...gCur, loops: gCur.loops.map(l => l.slice()) };

    let { normal, origin } = gCur;
    if (!normal || !origin) return { ...gCur, loops: gCur.loops.map(l => l.slice()) };

    const nLen = vlen(normal);
    if (nLen < 1e-8) return { ...gCur, loops: gCur.loops.map(l => l.slice()) };
    normal = vscale(normal, 1 / nLen);

    // 2-D basis on this plane
    let t     = Math.abs(normal[0]) < 0.9 ? [1,0,0] : [0,1,0];
    let xAxis = vnorm(vcross(t, normal));
    if (vlen(xAxis) < 1e-8) { t = [0,0,1]; xAxis = vnorm(vcross(t, normal)); }
    const yAxis = vcross(normal, xAxis);

    const proj2D = p => {
      const r = vsub(p, origin);
      return [vdot(r, xAxis), vdot(r, yAxis)];
    };
    const lift3D = (x, y) => vadd(origin, vadd(vscale(xAxis, x), vscale(yAxis, y)));

    const toClipperPath = loop =>
      loop.length < 3
        ? null
        : loop.map(p => { const [x,y] = proj2D(p); return { X: Math.round(x*SCALE), Y: Math.round(y*SCALE) }; });

    const subjectPaths = gCur.loops.map(toClipperPath).filter(Boolean);
    const clipPaths    = cutLoops.map(toClipperPath).filter(Boolean);

    if (!subjectPaths.length) return null;
    if (!clipPaths.length)    return { ...gCur, loops: gCur.loops.map(l => l.slice()) };

    const c = new ClipperLib.Clipper();
    c.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true);
    c.AddPaths(clipPaths,    ClipperLib.PolyType.ptClip,    true);

    const solution = [];
    const ok = c.Execute(
      ClipperLib.ClipType.ctDifference,
      solution,
      ClipperLib.PolyFillType.pftNonZero,
      ClipperLib.PolyFillType.pftNonZero,
    );
    if (!ok || !solution.length) return null;

    const newLoops = [];
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
    for (const path of solution) {
      if (path.length < 3) continue;
      const loop3D = path.map(ip => {
        const ux = ip.X / SCALE, uy = ip.Y / SCALE;
        const p  = lift3D(ux, uy);
        if (p[0]<minX) minX=p[0]; if (p[0]>maxX) maxX=p[0];
        if (p[1]<minY) minY=p[1]; if (p[1]>maxY) maxY=p[1];
        if (p[2]<minZ) minZ=p[2]; if (p[2]>maxZ) maxZ=p[2];
        return p;
      });
      if (loop3D.length >= 3) newLoops.push(loop3D);
    }
    if (!newLoops.length) return null;

    return { normal, origin, loops: newLoops, bbox: { minX, maxX, minY, maxY, minZ, maxZ } };
  }

  const out = [];

  for (let i = 0; i < polygonGroups.length; i++) {
    const gCur = polygonGroups[i];
    if (!gCur.bbox || !gCur.loops?.length) {
      out.push({ ...gCur, loops: gCur.loops?.map(l => l.slice()) ?? [] });
      continue;
    }

    const zFn = buildYPlane(gCur.normal, gCur.origin);
    if (!zFn) {
      out.push({ ...gCur, loops: gCur.loops.map(l => l.slice()) });
      continue;
    }

    const cutLoops = [];

    for (let j = 0; j < polygonGroups.length; j++) {
      if (j === i) continue;
      const other = polygonGroups[j];
      if (!other?.bbox || !other.loops?.length) continue;
      if (!bboxOverlapXZ(gCur.bbox, other.bbox)) continue;
      // Height (Y) filter: skip groups entirely below gCur
      if (other.bbox.maxY < gCur.bbox.minY) continue;

      for (const loop of other.loops) {
        if (!loop || loop.length < 2) continue;
        const cutLoop = [];
        let prevP         = loop[loop.length - 1];
        let prevYp        = zFn(prevP[0], prevP[2]);
        let prevAbove     = prevP[1] > prevYp;

        for (const p of loop) {
          const yp    = zFn(p[0], p[2]);
          const above = p[1] > yp;

          if (above) {
            if (!prevAbove) {
              const inter = intersectSegPlane(prevP, p, gCur.normal, gCur.origin, zFn);
              if (inter) cutLoop.push(inter);
            }
            cutLoop.push([p[0], yp, p[2]]);
          } else if (prevAbove) {
            const inter = intersectSegPlane(prevP, p, gCur.normal, gCur.origin, zFn);
            if (inter) cutLoop.push(inter);
          }

          prevP     = p;
          prevYp    = yp;
          prevAbove = above;
        }

        if (cutLoop.length > 2) cutLoops.push(cutLoop);
      }
    }

    const clipped = clipGroupWithCuts(gCur, cutLoops);
    if (clipped !== null) out.push(clipped);
  }

  return out;
}

// ── Step 6: Re-triangulate clipped loops with earcut ─────────────────────────

/**
 * @param {Array<{ normal, origin, loops, bbox }>} polygonGroups
 * @returns {Float32Array}  flat [x,y,z, ...]
 */
function earcutToTriangles(polygonGroups) {
  const result = [];

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
      const [x1,y1]=pts[i], [x2,y2]=pts[(i+1)%n];
      const cross = x1*y2 - x2*y1;
      a += cross; cx += (x1+x2)*cross; cy += (y1+y2)*cross;
    }
    a *= 0.5;
    if (Math.abs(a) < 1e-12) {
      cx = cy = 0;
      for (const [x,y] of pts) { cx += x; cy += y; }
      return [cx/n, cy/n];
    }
    const f = 1/(6*a);
    return [cx*f, cy*f];
  }

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

    // Local 2-D basis
    let t     = Math.abs(normal[0]) < 0.9 ? [1,0,0] : [0,1,0];
    let xAxis = vnorm(vcross(t, normal));
    if (vlen(xAxis) < 1e-8) { t=[0,0,1]; xAxis=vnorm(vcross(t,normal)); if(vlen(xAxis)<1e-8) continue; }
    const yAxis = vcross(normal, xAxis);

    const proj2D = p => { const r=vsub(p,origin); return [vdot(r,xAxis), vdot(r,yAxis)]; };

    // Project + compute metadata per loop
    const meta = [];
    for (let i=0; i<pg.loops.length; i++) {
      const loop3D = pg.loops[i];
      if (!loop3D || loop3D.length < 3) continue;
      const loop2D = loop3D.map(proj2D);
      const area   = signedArea2D(loop2D);
      if (Math.abs(area) < 1e-12) continue;
      meta.push({ index: i, loop3D, loop2D, area, centroid: centroid2D(loop2D), parent: -1, depth: 0 });
    }
    if (!meta.length) continue;

    // Containment tree
    meta.sort((a,b) => Math.abs(b.area) - Math.abs(a.area));
    for (let i=0; i<meta.length; i++) {
      const child = meta[i];
      let bestParent = -1, bestArea = Infinity;
      for (let j=0; j<meta.length; j++) {
        if (i===j) continue;
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

    // Triangulate each outer ring (even depth) with its holes
    for (let i=0; i<meta.length; i++) {
      const outer = meta[i];
      if (outer.depth % 2 !== 0) continue;

      const holes = meta.filter(m => m.parent === i && m.depth === outer.depth+1);

      const vertices  = [];
      const verts3D   = [];
      const holeIdxs  = [];

      function addRing(m, isHole) {
        let { loop3D, loop2D, area } = m;
        // Outer: CCW (area>0); hole: CW (area<0)
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

// ── Geometry extraction helpers ───────────────────────────────────────────────

/**
 * Extract a flat [x,y,z,...] array from a THREE.BufferGeometry (non-indexed).
 */
function extractFlat(geo) {
  const pos   = geo.getAttribute('position');
  const count = pos.count;
  const out   = new Float32Array(count * 3);
  for (let i=0; i<count; i++) {
    out[i*3]   = pos.getX(i);
    out[i*3+1] = pos.getY(i);
    out[i*3+2] = pos.getZ(i);
  }
  return out;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Merge prunedGeo + draftWallGeo, run the clip-and-retriangulate pipeline,
 * and return a new THREE.BufferGeometry with computed normals.
 *
 * @param {THREE.BufferGeometry} prunedGeo
 * @param {THREE.BufferGeometry|null} draftWallGeo
 * @returns {THREE.BufferGeometry}
 */
export function clipAndRetriangulate(prunedGeo, draftWallGeo) {
  // Merge flat arrays
  const flatPruned = extractFlat(prunedGeo);
  const flatWall   = draftWallGeo ? extractFlat(draftWallGeo) : new Float32Array(0);

  const merged = new Float32Array(flatPruned.length + flatWall.length);
  merged.set(flatPruned, 0);
  merged.set(flatWall, flatPruned.length);

  // Step 1
  const planar = buildPlanarFacePolygons(merged);

  // Step 2
  const polygonGroups = planarFacesToPolygonLoops(planar);

  // Step 3
  const clippedGroups = clipPolygonGroups(polygonGroups);

//   // Step 6
  const flatOut = earcutToTriangles(clippedGroups);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(flatOut, 3));
  geo.computeVertexNormals();
  return geo;
}

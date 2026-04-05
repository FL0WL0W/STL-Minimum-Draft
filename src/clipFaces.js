/**
 * clipFaces.js
 *
 * Steps 1–3 + 6 of the STL export pipeline, operating on merged geometry:
 *
 *   1. buildPlanarFacePolygons   – bucket triangles by coplanar plane key
 *   2. planarFacesToPolygonLoops – trace boundary loops for each planar group
 *   3. clipPolygonGroups         – subtract intersecting geometry (ClipperLib)
 *   4. addBottomCapGroup         – synthesise a horizontal floor cap
 *   6. earcutToTriangles         – re-triangulate clipped loops (earcut)
 *
 * Entry point:
 *   clipAndRetriangulate(prunedGeo, draftWallGeo) → Float32Array (flat xyz)
 */

import * as THREE from 'three';
import ClipperLib from 'clipper-lib';
import { earcutToTriangles } from './earcutTriangulate.js';
import { addBottomCapGroup }  from './bottomCap.js';
import { weldVerticesAuto }   from './weldVertices.js';

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

  let maxAbs = 0;
  for (const pt of triArray) {
    if (!pt) continue;
    if (Math.abs(pt) > maxAbs) maxAbs = Math.abs(pt);
  }

  const SCALE = (1 << 29) / maxAbs;

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
      if (vlen(n) < 1e-12) continue;
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
 * @param {Array<{ normal, origin, loops, bbox }>} subjectGroups  groups to clip and output
 * @param {Array<{ normal, origin, loops, bbox }>} cutterGroups   groups used only as cutters (not output)
 * @param {(pct: number) => void} [onProgress]  called with 0-100 each 1 % step
 * @param {AbortSignal}             [signal]
 * @param {() => Promise<void>}     [waitIfPaused]
 * @returns {Promise<Array<{ normal, origin, loops, bbox }>>}
 */
async function clipPolygonGroups(subjectGroups, cutterGroups, onProgress, signal, waitIfPaused) {
  if (!subjectGroups.length) return [];

  // Combine all groups for overlap detection; subjects occupy indices 0..nSub-1
  const cutters_ = cutterGroups ?? [];
  const polygonGroups = [...subjectGroups, ...cutters_];
  const nSub = subjectGroups.length;
  const n    = polygonGroups.length;

  let maxAbs = 0;
  for (const pg of polygonGroups) {
    if (!pg?.loops) continue;
    const { bbox } = pg;
    if (!bbox) continue;
    if (Math.abs(bbox.minY) > maxAbs) maxAbs = Math.abs(bbox.minY);
    if (Math.abs(bbox.maxY) > maxAbs) maxAbs = Math.abs(bbox.maxY);
    if (Math.abs(bbox.minX) > maxAbs) maxAbs = Math.abs(bbox.minX);
    if (Math.abs(bbox.maxX) > maxAbs) maxAbs = Math.abs(bbox.maxX);
    if (Math.abs(bbox.minZ) > maxAbs) maxAbs = Math.abs(bbox.minZ);
    if (Math.abs(bbox.maxZ) > maxAbs) maxAbs = Math.abs(bbox.maxZ);
  }

  const SCALE = (1 << 29) / maxAbs;

  // Decimal places for 3-D vertex keys used in per-loop manifold adjacency checks
  const EDGE_PREC = 4;
  function vk3(p) {
    return `${p[0].toFixed(EDGE_PREC)},${p[1].toFixed(EDGE_PREC)},${p[2].toFixed(EDGE_PREC)}`;
  }


  let modelMinX = Infinity, modelMaxX = -Infinity;
  let modelMinZ = Infinity, modelMaxZ = -Infinity;
  for (const g of polygonGroups) {
    if (!g.bbox) continue;
    if (g.bbox.minX < modelMinX) modelMinX = g.bbox.minX;
    if (g.bbox.maxX > modelMaxX) modelMaxX = g.bbox.maxX;
    if (g.bbox.minZ < modelMinZ) modelMinZ = g.bbox.minZ;
    if (g.bbox.maxZ > modelMaxZ) modelMaxZ = g.bbox.maxZ;
  }
  const sweepOnX = (modelMaxX - modelMinX) >= (modelMaxZ - modelMinZ);

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const ba = polygonGroups[a].bbox, bb = polygonGroups[b].bbox;
    if (!ba) return  1;
    if (!bb) return -1;
    return sweepOnX ? ba.minX - bb.minX : ba.minZ - bb.minZ;
  });

  // cutters[i] is only meaningful (and only allocated) for subject indices (i < nSub).
  // Cutter-only groups are never themselves clipped so we skip them in the output loop.
  const cutters = Array.from({ length: nSub }, () => []);

  for (let ii = 0; ii < n; ii++) {
    const i  = order[ii];
    const gi = polygonGroups[i];
    if (!gi.bbox || !gi.loops?.length) continue;

    for (let jj = ii + 1; jj < n; jj++) {
      const j  = order[jj];
      const gj = polygonGroups[j];
      if (!gj.bbox || !gj.loops?.length) continue;

      // Early exit: sorted by min on sweep axis, so once gj's min exceeds
      // gi's max on that axis no later j can overlap gi.
      if (sweepOnX) {
        if (gj.bbox.minX > gi.bbox.maxX) break;
        // Check the other lateral axis
        if (gj.bbox.maxZ < gi.bbox.minZ || gi.bbox.maxZ < gj.bbox.minZ) continue;
      } else {
        if (gj.bbox.minZ > gi.bbox.maxZ) break;
        if (gj.bbox.maxX < gi.bbox.minX || gi.bbox.maxX < gj.bbox.minX) continue;
      }

      // Only record cutters for subject groups (i < nSub / j < nSub).
      // Directed Y filter: cutter must not be entirely below the subject.
      const iCutsJ = j < nSub && gi.bbox.maxY >= gj.bbox.minY;
      const jCutsI = i < nSub && gj.bbox.maxY >= gi.bbox.minY;
      if (!iCutsJ && !jCutsI) continue;

      // Adjacency check is deferred to the async processing loop below so it
      // doesn't block the main thread here in the synchronous sweep phase.
      if (jCutsI) cutters[i].push(j);
      if (iCutsJ) cutters[j].push(i);
    }
  }
  // ── End index ─────────────────────────────────────────────────────────────

  // In Three.js local space Y is the height (draft) axis; X and Z are lateral.

  // Returns y = f(x, z) for the plane defined by normal + origin.
  // Returns null when the plane is (nearly) horizontal — normal[1] ≈ 0 means
  // we cannot uniquely solve for y, so the group is passed through unclipped.
  function buildYPlane(normal, origin) {
    if (!normal || !origin || Math.abs(normal[1]) < 1e-12) return null;
    const d      = vdot(normal, origin);
    const invNy  = 1 / normal[1];
    return (x, z) => (d - normal[0]*x - normal[2]*z) * invNy;
  }

  // Intersect segment p0→p1 with the plane; return the intersection point
  // with its Y coordinate snapped to the plane equation y = yFn(x, z).
  function intersectSegPlane(p0, p1, normal, origin, yFn) {
    const v     = vsub(p1, p0);
    const denom = vdot(normal, v);
    if (Math.abs(denom) < 1e-12) return null;
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
    if (nLen < 1e-12) return { ...gCur, loops: gCur.loops.map(l => l.slice()) };
    normal = vscale(normal, 1 / nLen);

    // 2-D basis on this plane — pick a reference vector not parallel to the normal
    let t     = Math.abs(normal[0]) < 0.9 ? [1,0,0] : [0,1,0];
    let xAxis = vnorm(vcross(t, normal));
    if (vlen(xAxis) < 1e-8) {
      t = [0,0,1]; xAxis = vnorm(vcross(t, normal));
      if (vlen(xAxis) < 1e-8) return { ...gCur, loops: gCur.loops.map(l => l.slice()) };
    }
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
      if (loop3D.length < 3) continue;

      newLoops.push(loop3D);
    }
    if (!newLoops.length) return null;

    return { ...gCur, normal, origin, loops: newLoops, bbox: { minX, maxX, minY, maxY, minZ, maxZ } };
  }

  const out = [];
  let lastYield = performance.now();

  // Only iterate over subject groups — cutter-only groups are never output.
  for (let i = 0; i < nSub; i++) {
    // Yield to the event loop every 20 ms to keep the page responsive
    const now = performance.now();
    if (now - lastYield >= 20) {
      lastYield = now;
      if (onProgress) onProgress(Math.min(99, Math.round(i / nSub * 100)));
      await new Promise(r => setTimeout(r, 0));
      if (signal?.aborted) throw new DOMException('Apply cancelled', 'AbortError');
      if (waitIfPaused) await waitIfPaused();
    }

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

    // Build this subject's directed edge set for manifold adjacency checks.
    // Only needed for subject-vs-subject pairs (j < nSub); dedicated cutter
    // groups are external geometry and are never filtered by adjacency.
    let subjectEdgeSet = null;
    const getSubjectEdgeSet = () => {
      if (!subjectEdgeSet) {
        subjectEdgeSet = new Set();
        for (const sLoop of gCur.loops) {
          for (let k = 0; k < sLoop.length; k++) {
            const a = sLoop[k], b = sLoop[(k + 1) % sLoop.length];
            subjectEdgeSet.add(`${vk3(a)}>${vk3(b)}`);
          }
        }
      }
      return subjectEdgeSet;
    };

    for (const j of cutters[i]) {
      const other = polygonGroups[j];

      for (const loop of other.loops) {
        if (!loop || loop.length < 2) continue;
        // Only check adjacency for subject-vs-subject pairs.
        // Dedicated cutter groups (j >= nSub) are always applied.
        if (j < nSub) {
          const es = getSubjectEdgeSet();
          let adjacent = false;
          for (let k = 0; k < loop.length; k++) {
            const a = loop[k], b = loop[(k + 1) % loop.length];
            if (es.has(`${vk3(b)}>${vk3(a)}`)) { adjacent = true; break; }
          }
          if (adjacent) continue;
        }
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

  if (onProgress) onProgress(100);
  return out;
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

// ── Clip-result cache (localStorage) ────────────────────────────────────────

const CACHE_PREFIX = 'stl-clip::';

/**
 * Fast 32-bit FNV-1a hash over the raw bytes of a Float32Array.
 * Returns an 8-character hex string.
 */
function hashFloat32Array(arr) {
  let h = 0x811c9dc5;
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function cacheKey(fileName, hash) {
  return CACHE_PREFIX + (fileName || 'unknown') + '::' + hash;
}

function loadCachedClip(fileName, hash) {
  try {
    const raw = localStorage.getItem(cacheKey(fileName, hash));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveCachedClip(fileName, hash, clippedGroups) {
  try {
    localStorage.setItem(cacheKey(fileName, hash), JSON.stringify(clippedGroups));
  } catch (e) {
    // Quota exceeded or private browsing — silently skip
    console.warn('clipFaces: could not cache clipped groups:', e);
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Merge prunedGeo + draftWallGeo, run the clip-and-retriangulate pipeline,
 * and return a new THREE.BufferGeometry with computed normals.
 *
 * @param {THREE.BufferGeometry} prunedGeo
 * @param {THREE.BufferGeometry|null} draftWallGeo
 * @param {(pct: number) => void} [onProgress]
 * @param {AbortSignal}            [signal]
 * @param {() => Promise<void>}    [waitIfPaused]
 * @param {string}                 [fileName]  used as part of the cache key
 * @returns {Promise<THREE.BufferGeometry>}
 */
export async function clipAndRetriangulate(prunedGeo, draftWallGeo, onProgress, signal, waitIfPaused, fileName) {
  const flatPruned = extractFlat(prunedGeo);
  const flatWall   = draftWallGeo ? extractFlat(draftWallGeo) : new Float32Array(0);

  // Hash both inputs so the cache is invalidated when either changes
  const geoHash = hashFloat32Array(flatPruned) + '_' + hashFloat32Array(flatWall);

  // ── Cache check ───────────────────────────────────────────────────────────
  let clippedGroups = loadCachedClip(fileName, geoHash);
  if (clippedGroups) {
    console.log('clipFaces: cache hit for', fileName, geoHash);
    if (onProgress) onProgress(100);
  } else {
    // Step 1 — build polygon groups for originals and walls separately
    const planarOrig = buildPlanarFacePolygons(flatPruned);
    const origGroups  = planarFacesToPolygonLoops(planarOrig);

    let wallGroups = [];
    let cutWallGroups = [];
    if (flatWall.length > 0) {
      const planarWall = buildPlanarFacePolygons(flatWall);
      wallGroups = planarFacesToPolygonLoops(planarWall);
    }

    // Step 3 — clip originals by each other and by wall groups; only originals are output
    let cutOrigGroups = await clipPolygonGroups(origGroups, wallGroups, onProgress, signal, waitIfPaused);

    cutWallGroups = await clipPolygonGroups(wallGroups, origGroups, onProgress, signal, waitIfPaused);

    clippedGroups = [ ...cutOrigGroups, ...cutWallGroups ];

    // Persist for next run
    saveCachedClip(fileName, geoHash, clippedGroups);
  }

  // Step 4
  const groupsWithCap = addBottomCapGroup(clippedGroups);

  // Step 6
  const flatOut = earcutToTriangles(groupsWithCap);

  // Weld vertices that drifted apart due to the Clipper integer round-trip.
  // Each polygon group is projected into its own 2-D basis before clipping and
  // lifted back afterwards; the same nominal point on a shared edge can end up
  // with slightly different float values in the two groups, which would show as
  // naked edges.  Welding at ~1 ppm of model size fixes that without merging
  // any intentionally distinct vertices in normal CAD geometry.
  weldVerticesAuto(flatOut);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(flatOut, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * stepExport.js
 *
 * Writes a STEP AP214 GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION
 * directly from an array of planar polygon groups, with no triangulation.
 *
 * Each polygon group { normal, origin, loops } becomes one ADVANCED_FACE.
 * Multiple loops per group are supported: the largest-area loop is the
 * FACE_OUTER_BOUND, the rest are FACE_BOUNDs (inner holes).
 *
 * Export:
 *   polygonsToSTEP(polygonGroups, fileName, transformPt?) → string
 */

// ── Vector helpers ────────────────────────────────────────────────────────────

function vsub(a, b)   { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function vscale(a, s) { return [a[0]*s,    a[1]*s,    a[2]*s]; }
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

// ── 2-D signed area ───────────────────────────────────────────────────────────

function signedArea2D(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return 0.5 * a;
}

// ── STEP number formatting ────────────────────────────────────────────────────

function fmt(n) {
  // 10 significant figures; trim trailing zeros after decimal
  const s = n.toPrecision(10);
  // Keep at least one digit after the dot so STEP parsers are happy
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '.0') : s + '.0';
}

function fmtPt(p) {
  return `(${fmt(p[0])},${fmt(p[1])},${fmt(p[2])})`;
}

// ── Public export ─────────────────────────────────────────────────────────────

/**
 * @param {Array<{ normal, origin, loops, bbox }>} polygonGroups
 * @param {string}  [fileName]     used in the STEP header (no extension needed)
 * @param {(p: number[]) => number[]} [transformPt]  optional per-vertex transform
 * @returns {string}  complete STEP file text
 */
export function polygonsToSTEP(polygonGroups, fileName, transformPt) {
  const name    = (fileName || 'draft').replace(/\.stl$/i, '').replace(/'/g, '');
  const dateStr = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

  // ── Sequential ID allocator ───────────────────────────────────────────────
  let nextId = 0;
  const alloc = () => ++nextId;

  // IDs for fixed boilerplate entities (allocated first so they appear at the
  // top of the DATA section alongside the face geometry).
  const idAppCtx   = alloc(); //  1
  const idAppProto = alloc(); //  2
  const idProdCtx  = alloc(); //  3
  const idProduct  = alloc(); //  4
  const idPDF      = alloc(); //  5
  const idPDCtx    = alloc(); //  6
  const idPD       = alloc(); //  7
  const idPDS      = alloc(); //  8
  const idUncert   = alloc(); //  9
  const idLenUnit  = alloc(); // 10
  const idAngUnit  = alloc(); // 11
  const idSAUnit   = alloc(); // 12
  const idRepCtx   = alloc(); // 13
  const idSDR      = alloc(); // 14
  const idGBSSR    = alloc(); // 15  — back-reference filled after face loop

  // ── Build face entities ───────────────────────────────────────────────────
  const faceLines = [];   // STEP entity lines for all faces
  const faceIds   = [];   // ADVANCED_FACE #ids

  function emit(line) { faceLines.push(line); }

  for (const pg of polygonGroups) {
    if (!pg.loops?.length) continue;

    // ── Derive normal and origin ────────────────────────────────────────────
    let { normal, origin } = pg;

    if (!origin) {
      origin = pg.loops[0]?.[0];
      if (!origin) continue;
    }
    if (!normal) {
      let found = false;
      outer: for (const loop of pg.loops)
        for (let i = 0; i + 2 < loop.length; i++) {
          const n = vnorm(vcross(vsub(loop[i+1], loop[i]), vsub(loop[i+2], loop[i])));
          if (vlen(n) > 1e-8) { normal = n; found = true; break outer; }
        }
      if (!found) continue;
    }
    const nl = vlen(normal);
    if (nl < 1e-8) continue;
    if (Math.abs(nl - 1) > 1e-3) normal = vscale(normal, 1 / nl);

    // ── Build 2-D plane basis (reused for signed-area winding test) ─────────
    let t     = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let xAxis = vnorm(vcross(t, normal));
    if (vlen(xAxis) < 1e-8) {
      t = [0, 0, 1]; xAxis = vnorm(vcross(t, normal));
      if (vlen(xAxis) < 1e-8) continue;
    }
    const yAxis = vcross(normal, xAxis);

    const proj2D = p => {
      const r = vsub(p, origin);
      return [vdot(r, xAxis), vdot(r, yAxis)];
    };

    // ── Classify loops: outer (largest |area|) vs holes ─────────────────────
    const meta = pg.loops
      .map(loop3D => {
        if (!loop3D || loop3D.length < 3) return null;
        const loop2D = loop3D.map(proj2D);
        const area   = signedArea2D(loop2D);
        return { loop3D, area };
      })
      .filter(Boolean);

    if (!meta.length) continue;
    meta.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

    // ── PLANE entity for this face ──────────────────────────────────────────
    const originT = transformPt ? transformPt(origin) : origin;
    const normalT = transformPt
      ? (() => { const o2 = transformPt([0,0,0]); const n2 = transformPt(normal); return vsub(n2, o2); })()
      : normal;
    const xAxisT  = transformPt
      ? (() => { const o2 = transformPt([0,0,0]); const x2 = transformPt(xAxis); return vsub(x2, o2); })()
      : xAxis;

    const idOriPt   = alloc();
    const idNormDir = alloc();
    const idXDir    = alloc();
    const idAxis    = alloc();
    const idPlane   = alloc();

    emit(`#${idOriPt}   = CARTESIAN_POINT('',${fmtPt(originT)});`);
    emit(`#${idNormDir} = DIRECTION('',${fmtPt(vnorm(normalT))});`);
    emit(`#${idXDir}    = DIRECTION('',${fmtPt(vnorm(xAxisT))});`);
    emit(`#${idAxis}    = AXIS2_PLACEMENT_3D('',#${idOriPt},#${idNormDir},#${idXDir});`);
    emit(`#${idPlane}   = PLANE('',#${idAxis});`);

    // ── Loops → EDGE_LOOPs → FACE_OUTER_BOUND / FACE_BOUND ─────────────────
    const boundIds = [];

    for (let li = 0; li < meta.length; li++) {
      const { loop3D, area } = meta[li];
      const isOuter = li === 0;

      // STEP FACE_OUTER_BOUND expects the loop to be CCW when viewed from
      // outside (i.e. along the face normal, positive signed area in our 2D
      // projection).  FACE_BOUND (hole) expects CW (negative area).
      let finalLoop = loop3D;
      if (isOuter  && area < 0) finalLoop = [...loop3D].reverse();
      if (!isOuter && area > 0) finalLoop = [...loop3D].reverse();

      const n = finalLoop.length;

      // Allocate VERTEX_POINTs
      const vIds = finalLoop.map(p => {
        const pt = transformPt ? transformPt(p) : p;
        const idPt = alloc();
        const idV  = alloc();
        emit(`#${idPt} = CARTESIAN_POINT('',${fmtPt(pt)});`);
        emit(`#${idV}  = VERTEX_POINT('',#${idPt});`);
        return idV;
      });

      // Allocate EDGE_CURVEs + ORIENTED_EDGEs
      const oeIds = finalLoop.map((p, k) => {
        const pA = transformPt ? transformPt(p)                   : p;
        const pB = transformPt ? transformPt(finalLoop[(k+1) % n]) : finalLoop[(k+1) % n];
        const vA = vIds[k];
        const vB = vIds[(k + 1) % n];

        const edgeVec = vsub(pB, pA);
        const edgeLen = vlen(edgeVec);
        const edgeDir = edgeLen > 1e-12 ? vscale(edgeVec, 1 / edgeLen) : [1, 0, 0];

        const idEdgePt  = alloc();
        const idEdgeDir = alloc();
        const idEdgeVec = alloc();
        const idLine    = alloc();
        const idEC      = alloc();
        const idOE      = alloc();

        emit(`#${idEdgePt}  = CARTESIAN_POINT('',${fmtPt(pA)});`);
        emit(`#${idEdgeDir} = DIRECTION('',${fmtPt(edgeDir)});`);
        emit(`#${idEdgeVec} = VECTOR('',#${idEdgeDir},${fmt(edgeLen)});`);
        emit(`#${idLine}    = LINE('',#${idEdgePt},#${idEdgeVec});`);
        emit(`#${idEC}      = EDGE_CURVE('',#${vA},#${vB},#${idLine},.T.);`);
        emit(`#${idOE}      = ORIENTED_EDGE('',*,*,#${idEC},.T.);`);

        return idOE;
      });

      const idEL = alloc();
      const idFB = alloc();
      emit(`#${idEL} = EDGE_LOOP('',( ${oeIds.map(i => `#${i}`).join(',\n    ')} ));`);
      if (isOuter) {
        emit(`#${idFB} = FACE_OUTER_BOUND('',#${idEL},.T.);`);
      } else {
        emit(`#${idFB} = FACE_BOUND('',#${idEL},.T.);`);
      }
      boundIds.push(idFB);
    }

    const idAF = alloc();
    emit(`#${idAF} = ADVANCED_FACE('',( ${boundIds.map(i => `#${i}`).join(',')} ),#${idPlane},.T.);`);
    faceIds.push(idAF);
  }

  if (!faceIds.length) return null;

  // ── Assemble complete STEP text ───────────────────────────────────────────
  const faceList = faceIds.map(i => `#${i}`).join(',\n  ');

  const header = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('STEP AP214 exported by STL Minimum Drafter'),'2;1');`,
    `FILE_NAME('${name}.stp','${dateStr}',(''),(''),'STL Minimum Drafter','','');`,
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));`,
    'ENDSEC;',
    'DATA;',
    `#${idAppCtx}   = APPLICATION_CONTEXT('automotive design');`,
    `#${idAppProto} = APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${idAppCtx});`,
    `#${idProdCtx}  = PRODUCT_CONTEXT('',#${idAppCtx},'mechanical');`,
    `#${idProduct}  = PRODUCT('${name}','${name}','',(#${idProdCtx}));`,
    `#${idPDF}      = PRODUCT_DEFINITION_FORMATION('','',#${idProduct});`,
    `#${idPDCtx}    = PRODUCT_DEFINITION_CONTEXT('part definition',#${idAppCtx},'design');`,
    `#${idPD}       = PRODUCT_DEFINITION('design','',#${idPDF},#${idPDCtx});`,
    `#${idPDS}      = PRODUCT_DEFINITION_SHAPE('','',#${idPD});`,
    `#${idUncert}   = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${idLenUnit},'distance_accuracy_value','confusion accuracy');`,
    `#${idLenUnit}  = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );`,
    `#${idAngUnit}  = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );`,
    `#${idSAUnit}   = ( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );`,
    `#${idRepCtx}   = ( GEOMETRIC_REPRESENTATION_CONTEXT(3)`,
    `    GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${idUncert}))`,
    `    GLOBAL_UNIT_ASSIGNED_CONTEXT((#${idLenUnit},#${idAngUnit},#${idSAUnit}))`,
    `    REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY') );`,
    `#${idSDR}      = SHAPE_DEFINITION_REPRESENTATION(#${idPDS},#${idGBSSR});`,
    `#${idGBSSR}    = GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION('',(\n  ${faceList}\n  ),#${idRepCtx});`,
  ];

  const tail = ['ENDSEC;', 'END-ISO-10303-21;'];

  return [...header, ...faceLines, ...tail].join('\n');
}

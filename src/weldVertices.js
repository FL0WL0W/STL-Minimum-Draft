/**
 * weldVertices.js
 *
 * Snaps vertices in a flat Float32Array of triangles (x0,y0,z0, x1,y1,z1, ...)
 * that fall into the same grid cell of size `epsilon` to a single canonical
 * position (the first vertex encountered in that cell).
 *
 * This repairs the tiny positional drift introduced by the Clipper integer
 * round-trip: each polygon group is projected into its own 2-D basis, scaled
 * to integers, clipped, then lifted back to 3-D.  Two adjacent groups sharing
 * an edge may lift the same nominal point through different bases, producing
 * coordinates that differ by ~maxAbs / CLIPPER_SCALE (≈ 1 ppm of model size).
 * Without welding, those edges appear as naked (boundary) edges in the mesh.
 *
 * Algorithm: spatial grid hash — O(n) time and space.
 *
 * @param {Float32Array} flatXYZ  flat [x,y,z, x,y,z, ...] — modified in place
 * @param {number}       epsilon  grid cell size; vertices within one cell are
 *                                collapsed to the first vertex seen in that cell
 * @returns {Float32Array}        the same array, with welded coordinates
 */
export function weldVertices(flatXYZ, epsilon) {
  if (!flatXYZ || flatXYZ.length === 0) return flatXYZ;

  const vertCount = (flatXYZ.length / 3) | 0;
  const invEps    = 1 / epsilon;
  const canonical = new Map();   // grid-key  →  [cx, cy, cz]

  for (let i = 0; i < vertCount; i++) {
    const base = i * 3;
    const x = flatXYZ[base];
    const y = flatXYZ[base + 1];
    const z = flatXYZ[base + 2];

    // Quantise to nearest grid cell
    const gx  = Math.round(x * invEps);
    const gy  = Math.round(y * invEps);
    const gz  = Math.round(z * invEps);
    const key = `${gx},${gy},${gz}`;

    let canon = canonical.get(key);
    if (!canon) {
      canon = [x, y, z];
      canonical.set(key, canon);
    }

    flatXYZ[base]     = canon[0];
    flatXYZ[base + 1] = canon[1];
    flatXYZ[base + 2] = canon[2];
  }

  return flatXYZ;
}

/**
 * Convenience: auto-compute epsilon as a fraction of the model's bounding-box
 * diagonal, then weld.  Defaults to 1 part in 2^20 (≈ 1 ppm), which is large
 * enough to absorb Clipper round-trip drift (~1 part in 2^29) while being far
 * too small to merge intentionally distinct vertices in typical CAD geometry.
 *
 * @param {Float32Array} flatXYZ
 * @param {number}       [fraction=1/1048576]   epsilon = maxAbsCoord * fraction
 * @returns {Float32Array}
 */
export function weldVerticesAuto(flatXYZ, fraction = 1 / (1 << 20)) {
  if (!flatXYZ || flatXYZ.length === 0) return flatXYZ;

  let maxAbs = 0;
  for (let i = 0; i < flatXYZ.length; i++) {
    const v = Math.abs(flatXYZ[i]);
    if (v > maxAbs) maxAbs = v;
  }
  if (maxAbs === 0) return flatXYZ;

  const epsilon = maxAbs * fraction;
  return weldVertices(flatXYZ, epsilon);
}

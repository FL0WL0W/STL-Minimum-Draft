import * as THREE from 'three';
import { state } from './state.js';

// ── Math helpers ──────────────────────────────────────────────────────────────
export function toDeg(r) { return r * (180 / Math.PI); }
export function toRad(d) { return d * (Math.PI / 180); }

// ── Geometry helpers ──────────────────────────────────────────────────────────

/** Move the mesh up so its lowest point sits exactly on y = 0. */
export function reseatOnFloor() {
  if (!state.currentMesh) return;
  const bb = new THREE.Box3().setFromObject(state.currentMesh);
  state.currentMesh.position.y += -bb.min.y;
}

/**
 * Bake a delta rotation (in degrees) directly into the mesh geometry so that
 * mesh.rotation always stays at zero and local normals == world normals.
 */
export function bakeRotation(dx, dy, dz) {
  const m = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(toRad(dx), toRad(dy), toRad(dz), 'XYZ')
  );
  state.currentMesh.geometry.applyMatrix4(m);
  state.currentMesh.updateMatrixWorld(true);
  reseatOnFloor();
}

/** Push accumulated rotation values into the three number inputs. */
export function syncRotInputs(rotXInput, rotYInput, rotZInput) {
  rotXInput.value = state.accRotX.toFixed(1);
  rotYInput.value = state.accRotY.toFixed(1);
  rotZInput.value = state.accRotZ.toFixed(1);
}

/**
 * Read the three number inputs, compute the delta from accumulated values,
 * bake the delta, then call the provided onChange callback.
 */
export function applyRotInputs(rotXInput, rotYInput, rotZInput, onChange) {
  if (!state.currentMesh) return;
  const nx = parseFloat(rotXInput.value) || 0;
  const ny = parseFloat(rotYInput.value) || 0;
  const nz = parseFloat(rotZInput.value) || 0;
  const dx = nx - state.accRotX;
  const dy = ny - state.accRotY;
  const dz = nz - state.accRotZ;
  state.accRotX = nx;
  state.accRotY = ny;
  state.accRotZ = nz;
  bakeRotation(dx, dy, dz);
  if (onChange) onChange();
}

// ── Rotation panel wiring ─────────────────────────────────────────────────────

/**
 * Wire up all rotation-panel event handlers.
 *
 * @param {object} els  - DOM element references
 * @param {function} onChange - called after every rotation (runs analysis + saves)
 */
export function initRotationPanel(els, onChange) {
  const {
    rotXInput, rotYInput, rotZInput,
    stepperBtns, snapChips,
    btnResetRot, btnLayFlat, btnSelectFace,
  } = els;

  // Direct input edits
  rotXInput.addEventListener('change', () => applyRotInputs(rotXInput, rotYInput, rotZInput, onChange));
  rotYInput.addEventListener('change', () => applyRotInputs(rotXInput, rotYInput, rotZInput, onChange));
  rotZInput.addEventListener('change', () => applyRotInputs(rotXInput, rotYInput, rotZInput, onChange));

  // ± stepper buttons
  stepperBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.currentMesh) return;
      const axis  = btn.dataset.axis;
      const dir   = parseFloat(btn.dataset.dir);
      const map   = { x: rotXInput, y: rotYInput, z: rotZInput };
      const input = map[axis];
      input.value = (parseFloat(input.value || 0) + dir).toFixed(1);
      applyRotInputs(rotXInput, rotYInput, rotZInput, onChange);
    });
  });

  // Snap chips – snap Y to nearest multiple, then advance by that amount
  snapChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      if (!state.currentMesh) return;
      const deg = parseFloat(chip.dataset.snap);
      const cur = parseFloat(rotYInput.value || 0);
      rotYInput.value = (Math.round(cur / deg) * deg + deg).toFixed(1);
      applyRotInputs(rotXInput, rotYInput, rotZInput, onChange);
    });
  });

  // Reset – bake the inverse of the accumulated rotation back to origin
  btnResetRot.addEventListener('click', () => {
    if (!state.currentMesh) return;
    bakeRotation(-state.accRotX, -state.accRotY, -state.accRotZ);
    state.accRotX = 0;
    state.accRotY = 0;
    state.accRotZ = 0;
    syncRotInputs(rotXInput, rotYInput, rotZInput);
    if (onChange) onChange();
  });

  // Lay flat – find the face whose normal most aligns with -Y, rotate so it's flat
  btnLayFlat.addEventListener('click', () => {
    if (!state.currentMesh) return;
    const normalAttr = state.currentMesh.geometry.getAttribute('normal');
    if (!normalAttr) return;

    const down = new THREE.Vector3(0, -1, 0);
    let bestDot    = -Infinity;
    let bestNormal = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < normalAttr.count; i += 3) {
      const n = new THREE.Vector3(
        normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i)
      ).normalize();
      const dot = n.dot(down);
      if (dot > bestDot) { bestDot = dot; bestNormal = n.clone(); }
    }

    const q     = new THREE.Quaternion().setFromUnitVectors(bestNormal.normalize(), down);
    const euler = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    const dx = toDeg(euler.x), dy = toDeg(euler.y), dz = toDeg(euler.z);
    state.accRotX += dx;
    state.accRotY += dy;
    state.accRotZ += dz;
    bakeRotation(dx, dy, dz);
    syncRotInputs(rotXInput, rotYInput, rotZInput);
    if (onChange) onChange();
  });

  // Select Face to Align – placeholder
  btnSelectFace.addEventListener('click', () => {
    alert('Select Face to Align: click a face on the model to align it to the floor.\n\n(Coming soon)');
  });
}

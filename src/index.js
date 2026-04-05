import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

import {
  scene, camera, renderer, orbitControls, transformControls,
  bedMesh, bedGrid, bedEdges, BED_SIZE,
} from './scene.js';
import { state } from './state.js';
import { saveRotation, loadSavedRotation, saveSTLToStorage, tryRestoreSTLFromStorage } from './storage.js';
import {
  toDeg, toRad, reseatOnFloor, bakeRotation, syncRotInputs, initRotationPanel,
} from './rotation.js';
import { runDraftAnalysis, clearAnalysisVisual } from './analysis.js';
import { previewDraft, applyDraft, revertApply } from './drafter.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const container    = document.getElementById('canvas-container');
const dropOverlay  = document.getElementById('drop-overlay');
const fileInput    = document.getElementById('file-input');
const fileNameEl   = document.getElementById('file-name');
const hud          = document.getElementById('hud');

const btnRotateTool = document.getElementById('btn-rotate');
const btnDraftTool  = document.getElementById('btn-draft');
const leftPanel     = document.getElementById('left-panel');
const sectionRotate = document.getElementById('section-rotate');
const sectionDraft  = document.getElementById('section-draft');

const rotXInput     = document.getElementById('rot-x');
const rotYInput     = document.getElementById('rot-y');
const rotZInput     = document.getElementById('rot-z');
const btnResetRot   = document.getElementById('btn-reset-rot');
const btnLayFlat    = document.getElementById('btn-lay-flat');
const btnSelectFace = document.getElementById('btn-select-face');
const snapChips     = document.querySelectorAll('.snap-chip');
const stepperBtns   = document.querySelectorAll('.axis-stepper button');

const btnApply            = document.getElementById('btn-apply');
const btnConfirmApply     = document.getElementById('btn-confirm-apply');
const btnConfirmRow       = document.getElementById('btn-confirm-row');
const draftAngleInput     = document.getElementById('draft-angle');
const clipProgressWrap    = document.getElementById('clip-progress-wrap');
const clipProgressFill    = document.getElementById('clip-progress-bar-fill');
const clipProgressPct     = document.getElementById('clip-progress-pct');
const btnPauseApply       = document.getElementById('btn-pause-apply');
const iconPause           = document.getElementById('icon-pause');
const iconPlay            = document.getElementById('icon-play');
const pauseBtnLabel       = document.getElementById('pause-btn-label');

// Tracks an in-progress applyDraft so it can be cancelled.
let applyAbortController = null;
let applyPaused          = false;
let applyPauseResolve    = null;

function waitIfPaused() {
  if (!applyPaused) return Promise.resolve();
  return new Promise((resolve, reject) => {
    applyPauseResolve = resolve;
    // reject immediately if aborted while paused
    applyAbortController?.signal.addEventListener('abort',
      () => reject(new DOMException('Apply cancelled', 'AbortError')),
      { once: true });
  });
}

function setPaused(paused) {
  applyPaused = paused;
  iconPause.style.display = paused ? 'none' : '';
  iconPlay.style.display  = paused ? ''     : 'none';
  pauseBtnLabel.textContent = paused ? 'Resume' : 'Pause';
  clipProgressPct.textContent = paused
    ? `${clipProgressFill.style.width.replace('%','')}% — paused`
    : `${clipProgressFill.style.width}`;
}

function resetPauseState() {
  if (applyPauseResolve) { applyPauseResolve(); applyPauseResolve = null; }
  applyPaused = false;
  iconPause.style.display = '';
  iconPlay.style.display  = 'none';
  pauseBtnLabel.textContent = 'Pause';
}

function showClipProgress(pct) {
  clipProgressWrap.classList.add('visible');
  clipProgressFill.style.width = `${pct}%`;
  if (!applyPaused) clipProgressPct.textContent = `${pct}%`;
}
function hideClipProgress() {
  clipProgressWrap.classList.remove('visible');
  clipProgressFill.style.width = '0%';
  clipProgressPct.textContent  = '0%';
}

function hideConfirmApply() {
  btnConfirmRow.style.display = 'none';
}
function showConfirmApply() {
  btnConfirmRow.style.display = '';
}

// ── Convenience wrapper: run analysis with current DOM refs ──────────────────
// Also reverts any previous apply so the original geometry is always analysed.
// If an apply is currently in progress, cancel it — the abort handler will
// clean up geometry and then call doAnalysis() itself.
function doAnalysis() {
  hideConfirmApply();
  btnApply.textContent = 'Preview Draft';
  btnApply.disabled    = true;
  if (applyAbortController) {
    applyAbortController.abort();
    return; // abort handler re-calls doAnalysis() after cleanup
  }
  revertApply();
  runDraftAnalysis(draftAngleInput, hud, btnApply);
}

// ── TransformControls gizmo baking ───────────────────────────────────────────
// On mouseUp we compute the gizmo delta, undo it, bake into geometry, then save.
let tcDragging        = false;
let tcRotOnDragStart  = new THREE.Euler();

transformControls.addEventListener('mouseDown', () => {
  tcDragging = true;
  if (state.currentMesh) tcRotOnDragStart.copy(state.currentMesh.rotation);
});

transformControls.addEventListener('mouseUp', () => {
  tcDragging = false;
  if (!state.currentMesh) return;
  const delta = new THREE.Euler(
    state.currentMesh.rotation.x - tcRotOnDragStart.x,
    state.currentMesh.rotation.y - tcRotOnDragStart.y,
    state.currentMesh.rotation.z - tcRotOnDragStart.z,
  );
  state.currentMesh.rotation.copy(tcRotOnDragStart); // undo gizmo rotation
  state.currentMesh.updateMatrixWorld();
  state.accRotX += toDeg(delta.x);
  state.accRotY += toDeg(delta.y);
  state.accRotZ += toDeg(delta.z);
  bakeRotation(toDeg(delta.x), toDeg(delta.y), toDeg(delta.z));
  syncRotInputs(rotXInput, rotYInput, rotZInput);
  doAnalysis();
  saveRotation(state.currentFileName, state.accRotX, state.accRotY, state.accRotZ);
});

transformControls.addEventListener('objectChange', () => {
  if (state.currentMesh && tcDragging) reseatOnFloor();
});

// ── STL load ─────────────────────────────────────────────────────────────────
function loadSTLBuffer(buffer, fileName) {
  const loader   = new STLLoader();
  const geometry = loader.parse(buffer);

  geometry.computeBoundingBox();
  const box    = geometry.boundingBox;
  const center = new THREE.Vector3();
  box.getCenter(center);
  geometry.translate(-center.x, -center.y, -center.z);
  state.originalCenter = { x: center.x, y: center.y, z: center.z };

  const size   = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);

  // Tear down previous mesh/overlays
  if (state.currentMesh) {
    transformControls.detach();
    scene.remove(state.currentMesh);
    state.currentMesh.geometry.dispose();
    state.currentMesh.material.dispose();
  }
  // Tear down any draft-apply state from a previous model
  if (state.draftMesh) {
    for (const child of state.draftMesh.children) { child.material.dispose(); }
    state.draftMesh.removeFromParent();
    state.draftMesh.geometry.dispose();
    state.draftMesh.material.dispose();
    state.draftMesh = null;
  }
  if (state.backFaceMesh) {
    state.backFaceMesh.removeFromParent();
    state.backFaceMesh.material.dispose();
    state.backFaceMesh = null;
  }
  if (state.appliedMeshMaterial) {
    state.appliedMeshMaterial.dispose();
    state.appliedMeshMaterial = null;
  }
  if (state.preApplyGeometry) {
    state.preApplyGeometry.dispose();
    state.preApplyGeometry = null;
  }
  state.phase = 'analyze';

  if (state.edgeOverlay) {
    state.edgeOverlay.removeFromParent();
    state.edgeOverlay.geometry.dispose();
    state.edgeOverlay.material.dispose();
    state.edgeOverlay = null;
  }
  if (state.analysisMaterial) {
    state.analysisMaterial.dispose();
    state.analysisMaterial = null;
  }

  state.originalMaterial = new THREE.MeshPhongMaterial({
    color: 0xe94560, specular: 0x333333, shininess: 50, side: THREE.DoubleSide,
  });

  state.currentMesh = new THREE.Mesh(geometry, state.originalMaterial);
  state.currentMesh.castShadow    = true;
  state.currentMesh.receiveShadow = true;
  scene.add(state.currentMesh);
  state.currentFileName = fileName;

  // Restore saved rotation
  const saved = loadSavedRotation(fileName);
  state.accRotX = 0; state.accRotY = 0; state.accRotZ = 0;
  if (saved) {
    state.accRotX = saved.x; state.accRotY = saved.y; state.accRotZ = saved.z;
    bakeRotation(saved.x, saved.y, saved.z);
  } else {
    reseatOnFloor();
  }

  if (state.activeTool === 'rotate') transformControls.attach(state.currentMesh);

  // Scale bed to fit model
  const bedScale = Math.max(1, (maxDim / BED_SIZE) * 1.2);
  bedMesh.scale.set(bedScale, bedScale, bedScale);
  bedGrid.scale.set(bedScale, 1, bedScale);
  bedEdges.scale.set(bedScale, 1, bedScale);

  // Fit camera
  const dist = maxDim * 2.2;
  camera.position.set(dist * 0.8, dist * 0.6, dist);
  camera.near = maxDim * 0.001;
  camera.far  = maxDim * 100;
  camera.updateProjectionMatrix();
  orbitControls.target.set(0, size.y * 0.3, 0);
  orbitControls.update();

  syncRotInputs(rotXInput, rotYInput, rotZInput);
  fileNameEl.textContent = fileName;
  dropOverlay.classList.add('hidden');
  doAnalysis();
}

// Hide build plate until rotate tool is active
bedMesh.visible  = false;
bedGrid.visible  = false;
bedEdges.visible = false;

// ── Tool switching ────────────────────────────────────────────────────────────
function setTool(tool) {
  state.activeTool = (state.activeTool === tool) ? null : tool;

  btnRotateTool.classList.toggle('active', state.activeTool === 'rotate');
  btnDraftTool.classList.toggle('active',  state.activeTool === 'draft');

  sectionRotate.classList.toggle('visible', state.activeTool === 'rotate');
  sectionDraft.classList.toggle('visible',  state.activeTool === 'draft');
  leftPanel.classList.toggle('open', state.activeTool !== null);

  const showBed = state.activeTool === 'rotate';
  bedMesh.visible  = showBed;
  bedGrid.visible  = showBed;
  bedEdges.visible = showBed;

  if (state.activeTool === 'rotate' && state.currentMesh) {
    transformControls.attach(state.currentMesh);
  } else {
    transformControls.detach();
  }
}

btnRotateTool.addEventListener('click', () => setTool('rotate'));
btnDraftTool.addEventListener('click',  () => setTool('draft'));

// ── Rotation panel ────────────────────────────────────────────────────────────
initRotationPanel(
  { rotXInput, rotYInput, rotZInput, stepperBtns, snapChips, btnResetRot, btnLayFlat, btnSelectFace },
  () => {
    doAnalysis();
    saveRotation(state.currentFileName, state.accRotX, state.accRotY, state.accRotZ);
  }
);

// ── Draft analysis / apply buttons ───────────────────────────────────────────
btnApply.addEventListener('click', async () => {
  if (!state.currentMesh) return;
  const minAngle = Math.max(0, parseFloat(draftAngleInput.value) || 3);

  // ── Phase 1: Preview (sync, instant) ─────────────────────────────────────
  if (state.phase !== 'previewed') {
    previewDraft(minAngle);
    btnApply.textContent = 'Apply Draft';
    hud.innerHTML =
      `<span style="color:#4499ff">&#10003;</span> Preview ready &nbsp;` +
      `<span style="color:#aaaaaa">(click Apply Draft to run clipping, or change settings to re-analyse)</span>`;
    return;
  }

  // ── Phase 2: Apply (async, runs clip pipeline) ────────────────────────────
  applyAbortController = new AbortController();
  const { signal } = applyAbortController;

  btnApply.disabled = true;
  resetPauseState();
  showClipProgress(0);
  hud.textContent = 'Clipping faces…';

  try {
    await applyDraft(showClipProgress, signal, waitIfPaused);

    resetPauseState();
    hideClipProgress();
    showConfirmApply();
    btnApply.disabled = true;
    hud.innerHTML =
      `<span style="color:#e94560">&#10003;</span> Draft applied &nbsp;` +
      `<span style="color:#aaaaaa">(click Export STL to download, or change settings to re-analyse)</span>`;
  } catch (e) {
    resetPauseState();
    hideClipProgress();

    if (e.name === 'AbortError') {
      revertApply();
      applyAbortController = null;
      hideConfirmApply();
      btnApply.textContent = 'Preview Draft';
      doAnalysis();
    } else {
      applyAbortController = null;
      throw e;
    }
  } finally {
    applyAbortController = null;
  }
});

btnPauseApply.addEventListener('click', () => {
  if (!applyAbortController) return;
  if (applyPaused) {
    // Resume
    const res = applyPauseResolve;
    applyPauseResolve = null;
    setPaused(false);
    if (res) res();
  } else {
    setPaused(true);
  }
});


btnConfirmApply.addEventListener('click', () => {
  downloadDraftedSTL();
});

function downloadDraftedSTL() {
  const geo = state.currentMesh?.geometry;
  if (!geo) return;
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  if (!pos) return;

  // Build the inverse of the accumulated baked rotation so the downloaded STL
  // is in the original (pre-rotation) orientation.  All rotations are baked
  // directly into geo vertices, so we just un-rotate when writing.
  const invRot = new THREE.Matrix4()
    .makeRotationFromEuler(
      new THREE.Euler(toRad(state.accRotX), toRad(state.accRotY), toRad(state.accRotZ), 'XYZ')
    )
    .invert();
  const hasRot = (state.accRotX !== 0 || state.accRotY !== 0 || state.accRotZ !== 0);
  const tv = new THREE.Vector3();

  const oc = state.originalCenter ?? { x: 0, y: 0, z: 0 };

  function getPos(vi) {
    tv.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
    if (hasRot) tv.applyMatrix4(invRot);
    // Add back the centering offset that was subtracted when the STL was loaded
    return [tv.x + oc.x, tv.y + oc.y, tv.z + oc.z];
  }
  function getNrm(vi) {
    if (!nrm) return [0, 0, 0];
    tv.set(nrm.getX(vi), nrm.getY(vi), nrm.getZ(vi));
    if (hasRot) tv.applyMatrix4(invRot);
    return [tv.x, tv.y, tv.z];
  }

  const triCount = pos.count / 3;
  const buf = new ArrayBuffer(80 + 4 + triCount * 50);
  const view = new DataView(buf);
  // 80-byte header
  const fileName = (state.currentFileName || 'draft').replace(/\.stl$/i, '');
  const headerBytes = new TextEncoder().encode(fileName + ' - drafted STL');
  new Uint8Array(buf).set(headerBytes.subarray(0, 80), 0);
  view.setUint32(80, triCount, true);
  let offset = 84;
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2;
    // Face normal: average of the three (un-rotated) per-vertex normals
    const n0 = getNrm(i0), n1 = getNrm(i1), n2 = getNrm(i2);
    view.setFloat32(offset, (n0[0]+n1[0]+n2[0])/3, true); offset += 4;
    view.setFloat32(offset, (n0[1]+n1[1]+n2[1])/3, true); offset += 4;
    view.setFloat32(offset, (n0[2]+n1[2]+n2[2])/3, true); offset += 4;
    for (const vi of [i0, i1, i2]) {
      const p = getPos(vi);
      view.setFloat32(offset, p[0], true); offset += 4;
      view.setFloat32(offset, p[1], true); offset += 4;
      view.setFloat32(offset, p[2], true); offset += 4;
    }
    view.setUint16(offset, 0, true); offset += 2; // attribute byte count
  }
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName + '_drafted.stl';
  a.click();
  URL.revokeObjectURL(a.href);
}

draftAngleInput.addEventListener('input', () => { if (state.currentMesh) doAnalysis(); });

// ── File reading ──────────────────────────────────────────────────────────────
function readFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.stl')) {
    alert('Please select a valid .stl file.');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    saveSTLToStorage(e.target.result, file.name);
    loadSTLBuffer(e.target.result, file.name);
  };
  reader.readAsArrayBuffer(file);
}

fileInput.addEventListener('change', (e) => { if (e.target.files[0]) readFile(e.target.files[0]); });
container.addEventListener('dragover',  (e) => { e.preventDefault(); if (!state.currentMesh) dropOverlay.classList.remove('hidden'); });
container.addEventListener('dragleave', ()  => { if (state.currentMesh) dropOverlay.classList.add('hidden'); });
container.addEventListener('drop',      (e) => { e.preventDefault(); readFile(e.dataTransfer.files[0]); });

// ── Resize ────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  const w = container.clientWidth, h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

// ── HUD ───────────────────────────────────────────────────────────────────────
function updateHud() {
  if (!state.currentMesh) return;
  if (state.analysisMaterial && state.currentMesh.material === state.analysisMaterial) return;
  hud.textContent =
    `X: ${state.accRotX.toFixed(1)}°  Y: ${state.accRotY.toFixed(1)}°  Z: ${state.accRotZ.toFixed(1)}°`;
}

// ── Render loop ───────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  orbitControls.update();
  updateHud();
  renderer.render(scene, camera);
}
animate();

// ── Auto-restore STL from last session ───────────────────────────────────────
const restored = tryRestoreSTLFromStorage();
if (restored) loadSTLBuffer(restored.buffer, restored.name);

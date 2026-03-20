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
import { applyDraft, revertApply } from './drafter.js';

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

const btnApply         = document.getElementById('btn-apply');
const btnClearAnalysis = document.getElementById('btn-clear-analysis');
const draftAngleInput  = document.getElementById('draft-angle');

// ── Convenience wrapper: run analysis with current DOM refs ──────────────────
// Also reverts any previous apply so the original geometry is always analysed.
function doAnalysis() {
  revertApply();
  runDraftAnalysis(draftAngleInput, hud, btnApply, btnClearAnalysis);
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
btnApply.addEventListener('click', () => {
  if (!state.currentMesh) return;
  const minAngle = Math.max(0, parseFloat(draftAngleInput.value) || 3);
  applyDraft(minAngle);
  btnApply.disabled         = true;
  btnClearAnalysis.disabled = false;
  hud.innerHTML =
    `<span style="color:#e94560">&#10003;</span> Draft applied &nbsp;` +
    `<span style="color:#aaaaaa">(change rotation or angle to re-analyse)</span>`;
});

btnClearAnalysis.addEventListener('click', () => {
  revertApply(); // restore original geometry if we were in applied state
  clearAnalysisVisual(btnApply, btnClearAnalysis);
  hud.textContent = state.currentMesh
    ? `X: ${state.accRotX.toFixed(1)}°  Y: ${state.accRotY.toFixed(1)}°  Z: ${state.accRotZ.toFixed(1)}°`
    : '';
});

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

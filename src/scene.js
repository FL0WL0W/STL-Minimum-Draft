import * as THREE from 'three';
import { OrbitControls }    from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

// ── Print bed size (mm) ───────────────────────────────────────────────────────
export const BED_SIZE = 220;

// ── Renderer ──────────────────────────────────────────────────────────────────
const container = document.getElementById('canvas-container');

export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setSize(container.clientWidth, container.clientHeight);
container.appendChild(renderer.domElement);

// ── Scene / camera ────────────────────────────────────────────────────────────
export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e1e1e);

export const camera = new THREE.PerspectiveCamera(
  45, container.clientWidth / container.clientHeight, 0.01, 10000
);
camera.position.set(0, 150, 300);

// ── Lighting ──────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.6));

const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight1.position.set(200, 400, 250);
dirLight1.castShadow = true;
scene.add(dirLight1);

const dirLight2 = new THREE.DirectionalLight(0x8090ff, 0.35);
dirLight2.position.set(-200, -100, -200);
scene.add(dirLight2);

// ── Floor / print bed ─────────────────────────────────────────────────────────
const bedGeo = new THREE.PlaneGeometry(BED_SIZE, BED_SIZE);
const bedMat = new THREE.MeshStandardMaterial({
  color: 0x2a4a6e,
  roughness: 0.8,
  metalness: 0.1,
  transparent: true,
  opacity: 0.85,
  side: THREE.DoubleSide,
});
export const bedMesh = new THREE.Mesh(bedGeo, bedMat);
bedMesh.rotation.x = -Math.PI / 2;
bedMesh.receiveShadow = true;
scene.add(bedMesh);

export const bedGrid = new THREE.GridHelper(BED_SIZE, 22, 0x4a6a9e, 0x3a5a8e);
bedGrid.position.y = 0.1;
scene.add(bedGrid);

const bedEdgesGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(BED_SIZE, 0.4, BED_SIZE));
const bedEdgesMat = new THREE.LineBasicMaterial({ color: 0x5a7ab0 });
export const bedEdges = new THREE.LineSegments(bedEdgesGeo, bedEdgesMat);
bedEdges.position.y = 0.05;
scene.add(bedEdges);

// ── Orbit controls ────────────────────────────────────────────────────────────
export const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;
orbitControls.dampingFactor = 0.08;
orbitControls.screenSpacePanning = false;
orbitControls.minDistance = 1;
orbitControls.maxDistance = 5000;
orbitControls.target.set(0, 30, 0);
orbitControls.update();

// ── Transform (rotation gizmo) controls ──────────────────────────────────────
export const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.setMode('rotate');
transformControls.setSpace('world');
transformControls.addEventListener('dragging-changed', (e) => {
  orbitControls.enabled = !e.value;
});
scene.add(transformControls);

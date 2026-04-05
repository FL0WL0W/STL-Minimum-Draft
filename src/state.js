/**
 * Shared mutable application state.
 * All modules import this object and read/write its properties directly.
 */
export const state = {
  // Currently loaded mesh + associated materials
  currentMesh:      null,
  currentFileName:  null,
  originalMaterial: null,
  analysisMaterial: null,
  edgeOverlay:      null,

  // Original bounding-box center subtracted from geometry on load (used to
  // restore the original coordinate system when exporting the STL).
  originalCenter: null,    // { x, y, z }

  // Accumulated rotation applied to the geometry (degrees)
  accRotX: 0,
  accRotY: 0,
  accRotZ: 0,

  // Active tool: 'rotate' | 'draft' | null
  activeTool: null,

  // Edge overlay sub-meshes (children of edgeOverlay group)
  wallEdgeLines:    null, // yellow — wall boundary edges
  otherEdgeLines:   null, // blue — skipped/other boundary edges

  // Result of last runDraftAnalysis — consumed by applyDraft to avoid recompute
  // { triPasses: Uint8Array, boundaryEdges: Array<{v0,v1}> } | null
  analysisData: null,

  // Draft-apply state
  // phase: 'analyze' → red/green + blue edges shown
  //        'applied' → failing tris removed, draft walls generated
  phase:              'analyze',
  draftMesh:          null, // wall+corner mesh, child of currentMesh
  preApplyGeometry:   null, // geometry backup taken before pruning
  appliedMeshMaterial: null, // green front-face material used in applied state
  backFaceMesh:        null, // red back-face child of currentMesh in applied state
};

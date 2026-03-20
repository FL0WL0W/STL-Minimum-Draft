// ── localStorage key helpers ──────────────────────────────────────────────────
const LS_KEY      = (name) => `stl-rot::${name}`;
const LS_STL_BUF  = 'stl-buffer-b64';
const LS_STL_NAME = 'stl-filename';

// ── Rotation persistence ──────────────────────────────────────────────────────
export function saveRotation(fileName, x, y, z) {
  if (!fileName) return;
  localStorage.setItem(LS_KEY(fileName), JSON.stringify({ x, y, z }));
}

export function loadSavedRotation(fileName) {
  try {
    const raw = localStorage.getItem(LS_KEY(fileName));
    if (!raw) return null;
    return JSON.parse(raw); // { x, y, z } in degrees
  } catch { return null; }
}

// ── STL buffer persistence ────────────────────────────────────────────────────
export function saveSTLToStorage(buffer, fileName) {
  try {
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    localStorage.setItem(LS_STL_BUF, btoa(bin));
    localStorage.setItem(LS_STL_NAME, fileName);
  } catch (e) {
    console.warn('Could not save STL to localStorage (quota?):', e);
  }
}

/**
 * Reads the saved STL from localStorage.
 * @returns {{ buffer: ArrayBuffer, name: string } | null}
 */
export function tryRestoreSTLFromStorage() {
  try {
    const b64  = localStorage.getItem(LS_STL_BUF);
    const name = localStorage.getItem(LS_STL_NAME);
    if (!b64 || !name) return null;
    const bin   = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { buffer: bytes.buffer, name };
  } catch (e) {
    console.warn('Could not restore STL from localStorage:', e);
    return null;
  }
}

import { ObjLoader, type ObjData } from './ObjLoader';

// ---------------------------------------------------------------------------
// Canvas setup
// ---------------------------------------------------------------------------

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

function resizeCanvas(): void {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('Failed to get 2D rendering context.');

document.body.style.margin     = '0';
document.body.style.overflow   = 'hidden';
document.body.style.background = '#000';
canvas.style.cursor            = 'crosshair';

// ---------------------------------------------------------------------------
// Rendering constants
// ---------------------------------------------------------------------------

const FOCAL_LENGTH = 600;
const Z_OFFSET     = 500;
const MODEL_SCALE  = 80;
/** Snap granularity in real canvas pixels. Higher = chunkier PS1 wobble. */
const JITTER       = 3;

const LIGHT: [number, number, number] = normaliseV3(0.4, 0.7, -0.6);

// ---------------------------------------------------------------------------
// Interaction state
// ---------------------------------------------------------------------------

/** Current accumulated rotation angles (radians). */
let rotAngleY = 0.3;   // start with a slight yaw so the jet isn't edge-on
let rotAngleX = -0.15;

/** Current pan offset in view-space world units. */
let panX = 0;
let panY = 0;

let isDraggingRight  = false;
let isDraggingMiddle = false;
let lastMouseX       = 0;
let lastMouseY       = 0;

const ROT_SENSITIVITY = 0.005;   // radians per pixel of mouse movement
const PAN_SENSITIVITY = 0.015;   // world-units per pixel of mouse movement

// Right-click drag → rotate
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('mousedown', (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;

  if (e.button === 2) {
    isDraggingRight      = true;
    canvas.style.cursor  = 'grabbing';
  }
  if (e.button === 1) {
    e.preventDefault();          // stop browser auto-scroll
    isDraggingMiddle     = true;
    canvas.style.cursor  = 'move';
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 2) { isDraggingRight  = false; canvas.style.cursor = 'crosshair'; }
  if (e.button === 1) { isDraggingMiddle = false; canvas.style.cursor = 'crosshair'; }
});

window.addEventListener('mousemove', (e) => {
  const dx = e.clientX - lastMouseX;
  const dy = e.clientY - lastMouseY;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;

  if (isDraggingRight) {
    rotAngleY += dx * ROT_SENSITIVITY;   // horizontal drag → yaw
    rotAngleX += dy * ROT_SENSITIVITY;   // vertical drag   → pitch
  }

  if (isDraggingMiddle) {
    panX += dx * PAN_SENSITIVITY;   // horizontal drag → pan left/right
    panY -= dy * PAN_SENSITIVITY;   // vertical drag   → pan up/down (invert Y)
  }
});

// ---------------------------------------------------------------------------
// 3D math helpers
// ---------------------------------------------------------------------------

function normaliseV3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.sqrt(x * x + y * y + z * z);
  return [x / len, y / len, z / len];
}

function dotV3(ax: number, ay: number, az: number,
               bx: number, by: number, bz: number): number {
  return ax * bx + ay * by + az * bz;
}

function crossV3(ax: number, ay: number, az: number,
                 bx: number, by: number, bz: number): [number, number, number] {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function rotateY(x: number, y: number, z: number, a: number): [number, number, number] {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * x + s * z, y, -s * x + c * z];
}

function rotateX(x: number, y: number, z: number, a: number): [number, number, number] {
  const c = Math.cos(a), s = Math.sin(a);
  return [x, c * y - s * z, s * y + c * z];
}

/**
 * Projects a 3D point to 2D with PS1-style vertex snapping.
 *
 * Pipeline:
 *   1. Perspective divide — FOCAL_LENGTH / (z + Z_OFFSET)
 *   2. Centre onto canvas.width/2, canvas.height/2
 *   3. Snap to JITTER-pixel grid with Math.round(val/JITTER)*JITTER
 */
function projectSnapped(x: number, y: number, z: number): [number, number] {
  const depth = z + Z_OFFSET;
  const f     = depth > 0.001 ? FOCAL_LENGTH / depth : FOCAL_LENGTH / 0.001;

  // Exact, smooth canvas-space coordinates
  const rawX = canvas.width  / 2 + x * f * MODEL_SCALE;
  const rawY = canvas.height / 2 - y * f * MODEL_SCALE;

  // Snap to JITTER-pixel grid → the PS1 wobble
  return [
    Math.round(rawX / JITTER) * JITTER,
    Math.round(rawY / JITTER) * JITTER,
  ];
}

// ---------------------------------------------------------------------------
// Face sort buffer
// ---------------------------------------------------------------------------

interface FaceEntry {
  faceOffset: number;
  avgZ:       number;
  brightness: number;
}

let faceBuffer: FaceEntry[] = [];

// ---------------------------------------------------------------------------
// OBJ load
// ---------------------------------------------------------------------------

let objData: ObjData | null = null;

const loader = new ObjLoader();
loader
  .load('/su35.obj')
  .then((data) => {
    objData = data;
    const triCount = data.indices.length / 3;
    faceBuffer = Array.from({ length: triCount }, () => ({
      faceOffset: 0, avgZ: 0, brightness: 1,
    }));
    console.log(`su35.obj — ${data.vertices.length / 3} verts, ${triCount} tris`);
  })
  .catch((err: unknown) => console.error('Failed to load su35.obj:', err));

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function tick(_ts: DOMHighResTimeStamp): void {
  // Clear
  ctx!.fillStyle = '#000';
  ctx!.fillRect(0, 0, canvas.width, canvas.height);

  if (objData && faceBuffer.length > 0) {
    const { vertices, indices } = objData;

    // -----------------------------------------------------------------------
    // PASS 1 — rotate every face, cull backfaces, record depth + brightness
    //
    // Backface culling: the camera sits at the origin looking in +Z.
    // A face is front-facing when its normal points toward the camera, i.e.
    // dot(normal, (0, 0, -1)) > 0  ↔  nz < 0.
    // If nz >= 0 the face points away — skip it entirely.
    // -----------------------------------------------------------------------
    let visibleCount = 0;

    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i]     * 3;
      const i1 = indices[i + 1] * 3;
      const i2 = indices[i + 2] * 3;

      // Rotate vertices into view space
      let [x0, y0, z0] = rotateX(...rotateY(vertices[i0], vertices[i0+1], vertices[i0+2], rotAngleY), rotAngleX);
      let [x1, y1, z1] = rotateX(...rotateY(vertices[i1], vertices[i1+1], vertices[i1+2], rotAngleY), rotAngleX);
      let [x2, y2, z2] = rotateX(...rotateY(vertices[i2], vertices[i2+1], vertices[i2+2], rotAngleY), rotAngleX);

      // Apply pan (view-space translation, after rotation)
      x0 += panX; y0 += panY;
      x1 += panX; y1 += panY;
      x2 += panX; y2 += panY;

      // Face normal (not yet normalised — only direction matters for culling)
      const [cnx, cny, cnz] = crossV3(x1-x0, y1-y0, z1-z0, x2-x0, y2-y0, z2-z0);

      // Backface culling: camera view vector is (0, 0, -1)
      // dot(normal, viewVec) = -cnz  →  cull when -cnz <= 0, i.e. cnz >= 0
      if (cnz >= 0) continue;

      // Normalise for lighting
      const [nx, ny, nz] = normaliseV3(cnx, cny, cnz);
      const diffuse       = Math.max(0, dotV3(nx, ny, nz, LIGHT[0], LIGHT[1], LIGHT[2]));
      // Ambient floor of 0.45 — no face goes pitch-black
      const brightness    = 0.45 + 0.55 * diffuse;
      const avgZ          = (z0 + z1 + z2) / 3;

      const entry      = faceBuffer[visibleCount++];
      entry.faceOffset = i;
      entry.avgZ       = avgZ;
      entry.brightness = brightness;
    }

    // -----------------------------------------------------------------------
    // PASS 2 — Painter's sort on VISIBLE faces only, back (high Z) → front
    // Slice to visibleCount so culled entries never enter the sort.
    // -----------------------------------------------------------------------
    const visibleFaces = faceBuffer.slice(0, visibleCount);
    visibleFaces.sort((a, b) => b.avgZ - a.avgZ);

    // -----------------------------------------------------------------------
    // PASS 3 — draw sorted visible faces with PS1-snapped vertices
    // -----------------------------------------------------------------------
    for (let f = 0; f < visibleFaces.length; f++) {
      const { faceOffset, brightness } = visibleFaces[f];

      const i0 = indices[faceOffset]     * 3;
      const i1 = indices[faceOffset + 1] * 3;
      const i2 = indices[faceOffset + 2] * 3;

      // Re-rotate + pan (same transform as PASS 1)
      let [rx0, ry0, rz0] = rotateX(...rotateY(vertices[i0], vertices[i0+1], vertices[i0+2], rotAngleY), rotAngleX);
      let [rx1, ry1, rz1] = rotateX(...rotateY(vertices[i1], vertices[i1+1], vertices[i1+2], rotAngleY), rotAngleX);
      let [rx2, ry2, rz2] = rotateX(...rotateY(vertices[i2], vertices[i2+1], vertices[i2+2], rotAngleY), rotAngleX);

      rx0 += panX; ry0 += panY;
      rx1 += panX; ry1 += panY;
      rx2 += panX; ry2 += panY;

      // PS1-snapped perspective projection
      const [sx0, sy0] = projectSnapped(rx0, ry0, rz0);
      const [sx1, sy1] = projectSnapped(rx1, ry1, rz1);
      const [sx2, sy2] = projectSnapped(rx2, ry2, rz2);

      const v = Math.round(brightness * 255);
      ctx!.fillStyle   = `rgb(${v},${v},${v})`;
      ctx!.strokeStyle = `rgb(${v},${v},${v})`;
      ctx!.lineWidth   = 0.5;

      ctx!.beginPath();
      ctx!.moveTo(sx0, sy0);
      ctx!.lineTo(sx1, sy1);
      ctx!.lineTo(sx2, sy2);
      ctx!.closePath();
      ctx!.fill();
      ctx!.stroke();
    }
  }

  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

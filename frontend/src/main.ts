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

const VIRTUAL_W    = 320;
const VIRTUAL_H    = 240;
const FOCAL_LENGTH = 600;
const Z_OFFSET     = 5;
const MODEL_SCALE  = 80;

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
 *   1. Perspective divide into virtual 320×240 space
 *   2. Math.round() — snaps to low-res grid, causing PS1 jitter
 *   3. Scale up to real canvas pixels
 */
function projectSnapped(
  x: number, y: number, z: number,
  scaleX: number, scaleY: number
): [number, number] {
  const depth = z + Z_OFFSET;
  const f     = depth > 0.001 ? FOCAL_LENGTH / depth : FOCAL_LENGTH / 0.001;

  const vx = (VIRTUAL_W / 2) + x * f * MODEL_SCALE / (canvas.width  / VIRTUAL_W);
  const vy = (VIRTUAL_H / 2) - y * f * MODEL_SCALE / (canvas.height / VIRTUAL_H);

  // ← PS1 snap: quantise to the 320×240 grid
  return [Math.round(vx) * scaleX, Math.round(vy) * scaleY];
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
  const scaleX = canvas.width  / VIRTUAL_W;
  const scaleY = canvas.height / VIRTUAL_H;

  // Clear
  ctx!.fillStyle = '#000';
  ctx!.fillRect(0, 0, canvas.width, canvas.height);

  if (objData && faceBuffer.length > 0) {
    const { vertices, indices } = objData;

    // -----------------------------------------------------------------------
    // PASS 1 — rotate, compute depth + flat-shade brightness for each face
    // -----------------------------------------------------------------------
    let fi = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i]     * 3;
      const i1 = indices[i + 1] * 3;
      const i2 = indices[i + 2] * 3;

      // Rotate
      let [x0, y0, z0] = rotateX(...rotateY(vertices[i0], vertices[i0+1], vertices[i0+2], rotAngleY), rotAngleX);
      let [x1, y1, z1] = rotateX(...rotateY(vertices[i1], vertices[i1+1], vertices[i1+2], rotAngleY), rotAngleX);
      let [x2, y2, z2] = rotateX(...rotateY(vertices[i2], vertices[i2+1], vertices[i2+2], rotAngleY), rotAngleX);

      // Apply pan (in view space — after rotation, before projection)
      x0 += panX; y0 += panY;
      x1 += panX; y1 += panY;
      x2 += panX; y2 += panY;

      const avgZ = (z0 + z1 + z2) / 3;

      const [nx, ny, nz] = normaliseV3(
        ...crossV3(x1-x0, y1-y0, z1-z0, x2-x0, y2-y0, z2-z0)
      );
      const diffuse    = Math.max(0, dotV3(nx, ny, nz, LIGHT[0], LIGHT[1], LIGHT[2]));
      const brightness = 0.15 + 0.85 * diffuse;

      const entry      = faceBuffer[fi++];
      entry.faceOffset = i;
      entry.avgZ       = avgZ;
      entry.brightness = brightness;
    }

    // -----------------------------------------------------------------------
    // PASS 2 — Painter's sort: back (high Z) → front (low Z)
    // -----------------------------------------------------------------------
    faceBuffer.sort((a, b) => b.avgZ - a.avgZ);

    // -----------------------------------------------------------------------
    // PASS 3 — draw sorted faces with PS1-snapped vertices
    // -----------------------------------------------------------------------
    for (let f = 0; f < faceBuffer.length; f++) {
      const { faceOffset, brightness } = faceBuffer[f];

      const i0 = indices[faceOffset]     * 3;
      const i1 = indices[faceOffset + 1] * 3;
      const i2 = indices[faceOffset + 2] * 3;

      // Re-rotate + pan
      let [rx0, ry0, rz0] = rotateX(...rotateY(vertices[i0], vertices[i0+1], vertices[i0+2], rotAngleY), rotAngleX);
      let [rx1, ry1, rz1] = rotateX(...rotateY(vertices[i1], vertices[i1+1], vertices[i1+2], rotAngleY), rotAngleX);
      let [rx2, ry2, rz2] = rotateX(...rotateY(vertices[i2], vertices[i2+1], vertices[i2+2], rotAngleY), rotAngleX);

      rx0 += panX; ry0 += panY;
      rx1 += panX; ry1 += panY;
      rx2 += panX; ry2 += panY;

      // PS1-snapped projection
      const [sx0, sy0] = projectSnapped(rx0, ry0, rz0, scaleX, scaleY);
      const [sx1, sy1] = projectSnapped(rx1, ry1, rz1, scaleX, scaleY);
      const [sx2, sy2] = projectSnapped(rx2, ry2, rz2, scaleX, scaleY);

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

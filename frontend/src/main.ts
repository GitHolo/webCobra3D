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

// ---------------------------------------------------------------------------
// Rendering constants
// ---------------------------------------------------------------------------

/** Virtual low-res resolution used for PS1-style vertex snapping. */
const VIRTUAL_W     = 320;
const VIRTUAL_H     = 240;

const FOCAL_LENGTH  = 600;    // perspective strength
const Z_OFFSET      = 500;     // push model away from camera (world units)
const MODEL_SCALE   = 80;    // scale after perspective divide

// Rotation speeds (radians per millisecond)
const ROT_Y_SPEED   = 0.0007;  // yaw (spin)
const ROT_X_SPEED   = 0.0003;  // pitch (tilt)

/** Normalised directional light vector (pointing upper-left, toward viewer). */
const LIGHT: [number, number, number] = normaliseV3(0.4, 0.7, -0.6);

// ---------------------------------------------------------------------------
// 3D math helpers
// ---------------------------------------------------------------------------

function normaliseV3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.sqrt(x * x + y * y + z * z);
  return [x / len, y / len, z / len];
}

function dotV3(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number
): number {
  return ax * bx + ay * by + az * bz;
}

/** Cross product (a x b). */
function crossV3(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number
): [number, number, number] {
  return [
    ay * bz - az * by,
    az * bx - ax * bz,
    ax * by - ay * bx,
  ];
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
 * Projects a 3D point onto the virtual 320x240 screen, then snaps the result
 * to integer pixel positions on that grid (PS1-style affine jitter), and
 * finally scales up to actual canvas size.
 *
 * The rounding step is the core of the PS1 effect: because the low-res grid
 * has only 320x240 steps, nearby vertices that are slightly different in 3D
 * snap to the same 2D bucket, causing visible jitter as the model rotates.
 */
function projectSnapped(
  x: number, y: number, z: number,
  scaleX: number, scaleY: number   // canvas.width/VIRTUAL_W, canvas.height/VIRTUAL_H
): [number, number] {
  const depth = z + Z_OFFSET;
  const f     = depth > 0.001 ? FOCAL_LENGTH / depth : FOCAL_LENGTH / 0.001;

  // Step 1: project into virtual 320x240 space (centre = 160, 120)
  const vx = (VIRTUAL_W / 2) + x * f * MODEL_SCALE / (canvas.width  / VIRTUAL_W);
  const vy = (VIRTUAL_H / 2) - y * f * MODEL_SCALE / (canvas.height / VIRTUAL_H);

  // Step 2: SNAP to the low-res integer grid — this is the PS1 jitter
  const snappedX = Math.round(vx);
  const snappedY = Math.round(vy);

  // Step 3: scale back up to real canvas pixels
  return [snappedX * scaleX, snappedY * scaleY];
}

// ---------------------------------------------------------------------------
// Face sorting scratch buffer (reused each frame to avoid GC pressure)
// ---------------------------------------------------------------------------

/** One entry per triangle, populated and sorted every frame. */
interface FaceEntry {
  faceOffset: number;  // index into indices[] where this triangle starts (i.e. i)
  avgZ:       number;  // average rotated Z — used for depth sort
  brightness: number;  // 0-1 flat-shading intensity from face normal dot light
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
    // Pre-allocate the face buffer now that we know the triangle count.
    const triCount = data.indices.length / 3;
    faceBuffer = Array.from({ length: triCount }, () => ({
      faceOffset: 0,
      avgZ:       0,
      brightness: 1,
    }));
    console.log(`su35.obj loaded — ${data.vertices.length / 3} vertices, ${triCount} triangles`);
  })
  .catch((err: unknown) => {
    console.error('Failed to load su35.obj:', err);
  });

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function tick(_ts: DOMHighResTimeStamp): void {
  const now     = performance.now();
  const scaleX  = canvas.width  / VIRTUAL_W;
  const scaleY  = canvas.height / VIRTUAL_H;

  // --- Clear ---
  ctx!.fillStyle = '#000';
  ctx!.fillRect(0, 0, canvas.width, canvas.height);

  if (objData && faceBuffer.length > 0) {
    const { vertices, indices } = objData;
    const angleY = now * ROT_Y_SPEED;
    const angleX = now * ROT_X_SPEED;

    // -------------------------------------------------------------------------
    // Pass 1: rotate all vertices, compute per-face depth + lighting, populate
    //         faceBuffer.  We rotate each vertex individually here (no cache)
    //         which is simple and correct for the Painter's Algorithm approach.
    // -------------------------------------------------------------------------

    let faceIdx = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i]     * 3;
      const i1 = indices[i + 1] * 3;
      const i2 = indices[i + 2] * 3;

      // Rotate vertex 0
      let [x0, y0, z0] = rotateX(...rotateY(vertices[i0], vertices[i0+1], vertices[i0+2], angleY), angleX);
      // Rotate vertex 1
      let [x1, y1, z1] = rotateX(...rotateY(vertices[i1], vertices[i1+1], vertices[i1+2], angleY), angleX);
      // Rotate vertex 2
      let [x2, y2, z2] = rotateX(...rotateY(vertices[i2], vertices[i2+1], vertices[i2+2], angleY), angleX);

      // Average Z for Painter's sort (higher Z = further from camera)
      const avgZ = (z0 + z1 + z2) / 3;

      // Face normal via cross product of two edges
      const [nx, ny, nz] = normaliseV3(
        ...crossV3(x1 - x0, y1 - y0, z1 - z0,
                   x2 - x0, y2 - y0, z2 - z0)
      );

      // Flat shading: dot with light direction, clamp to [0, 1]
      const diffuse   = Math.max(0, dotV3(nx, ny, nz, LIGHT[0], LIGHT[1], LIGHT[2]));
      // Ambient + diffuse so no face goes fully black
      const brightness = 0.15 + 0.85 * diffuse;

      const entry      = faceBuffer[faceIdx++];
      entry.faceOffset = i;
      entry.avgZ       = avgZ;
      entry.brightness = brightness;
    }

    // -------------------------------------------------------------------------
    // Pass 2: sort back-to-front (Painter's Algorithm)
    //         Largest avgZ = furthest away = drawn first.
    // -------------------------------------------------------------------------
    faceBuffer.sort((a, b) => b.avgZ - a.avgZ);

    // -------------------------------------------------------------------------
    // Pass 3: draw sorted faces as filled polygons with PS1-snapped vertices
    // -------------------------------------------------------------------------
    for (let f = 0; f < faceBuffer.length; f++) {
      const { faceOffset, brightness } = faceBuffer[f];

      const i0 = indices[faceOffset]     * 3;
      const i1 = indices[faceOffset + 1] * 3;
      const i2 = indices[faceOffset + 2] * 3;

      // Re-rotate (we don't cache per-vertex transforms to keep memory flat)
      const [rx0, ry0, rz0] = rotateX(...rotateY(vertices[i0], vertices[i0+1], vertices[i0+2], angleY), angleX);
      const [rx1, ry1, rz1] = rotateX(...rotateY(vertices[i1], vertices[i1+1], vertices[i1+2], angleY), angleX);
      const [rx2, ry2, rz2] = rotateX(...rotateY(vertices[i2], vertices[i2+1], vertices[i2+2], angleY), angleX);

      // PS1-snapped projection
      const [sx0, sy0] = projectSnapped(rx0, ry0, rz0, scaleX, scaleY);
      const [sx1, sy1] = projectSnapped(rx1, ry1, rz1, scaleX, scaleY);
      const [sx2, sy2] = projectSnapped(rx2, ry2, rz2, scaleX, scaleY);

      // Flat-shaded grayscale fill
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
      ctx!.stroke();   // hair-line stroke eliminates seam gaps between faces
    }
  }

  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

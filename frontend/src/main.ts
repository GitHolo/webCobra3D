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
// Projection constants
// ---------------------------------------------------------------------------

const FOCAL_LENGTH  = 600;   // perspective strength � larger = less fisheye
const Z_OFFSET      = 400;     // pushes the model away from the camera (world units)
const MODEL_SCALE   = 80;    // multiplier applied after perspective divide

// Rotation speeds (radians per millisecond)
const ROT_X_SPEED   = 0.0003;
const ROT_Z_SPEED   = 0.0007;

// ---------------------------------------------------------------------------
// 3D math helpers
// ---------------------------------------------------------------------------

/** Rotate a point around the Y axis (spins the jet left/right). */
function rotateY(x: number, y: number, z: number, angle: number): [number, number, number] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    cos * x + sin * z,
    y,
    -sin * x + cos * z,
  ];
}

/** Rotate a point around the X axis (tilts the jet up/down). */
function rotateX(x: number, y: number, z: number, angle: number): [number, number, number] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    x,
    cos * y - sin * z,
    sin * y + cos * z,
  ];
}

/** Perspective-project a 3D point to 2D screen coordinates. */
function project(
  x: number, y: number, z: number,
  cx: number, cy: number            // canvas centre
): [number, number] {
  const depth = z + Z_OFFSET;
  // Guard against division by zero / points behind the camera.
  const scale = depth > 0.001 ? FOCAL_LENGTH / depth : FOCAL_LENGTH / 0.001;
  return [
    cx + x * scale * MODEL_SCALE,
    cy - y * scale * MODEL_SCALE,   // subtract: canvas Y grows downward
  ];
}

// ---------------------------------------------------------------------------
// OBJ load
// ---------------------------------------------------------------------------

let objData: ObjData | null = null;

const loader = new ObjLoader();
loader
  .load('/su35.obj')
  .then((data) => {
    objData = data;
    console.log(
      `su35.obj loaded � ${data.vertices.length / 3} vertices, ` +
      `${data.indices.length / 3} triangles`
    );
  })
  .catch((err: unknown) => {
    console.error('Failed to load su35.obj:', err);
  });

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function tick(_timestamp: DOMHighResTimeStamp): void {
  const now = performance.now();
  const cx  = canvas.width  / 2;
  const cy  = canvas.height / 2;

  // --- Clear to black ---
  ctx!.fillStyle = '#000000';
  ctx!.fillRect(0, 0, canvas.width, canvas.height);

  if (objData) {
    const { vertices, indices } = objData;

    // Continuous rotation angles driven by wall-clock time
    const angleX = now * ROT_X_SPEED;
    const angleY = now * ROT_Z_SPEED;  // "Z axis spin" in user-space = Y-axis rotation

    ctx!.beginPath();
    ctx!.strokeStyle = '#00ff41';   // classic phosphor green
    ctx!.lineWidth   = 0.4;

    // Iterate triangles (3 indices each)
    for (let i = 0; i < indices.length; i += 3) {
      // --- Fetch raw vertex coords ---
      const i0 = indices[i]     * 3;
      const i1 = indices[i + 1] * 3;
      const i2 = indices[i + 2] * 3;

      let [x0, y0, z0] = [vertices[i0], vertices[i0 + 1], vertices[i0 + 2]];
      let [x1, y1, z1] = [vertices[i1], vertices[i1 + 1], vertices[i1 + 2]];
      let [x2, y2, z2] = [vertices[i2], vertices[i2 + 1], vertices[i2 + 2]];

      // --- Apply rotations ---
      [x0, y0, z0] = rotateX(...rotateY(x0, y0, z0, angleY), angleX);
      [x1, y1, z1] = rotateX(...rotateY(x1, y1, z1, angleY), angleX);
      [x2, y2, z2] = rotateX(...rotateY(x2, y2, z2, angleY), angleX);

      // --- Project to screen ---
      const [sx0, sy0] = project(x0, y0, z0, cx, cy);
      const [sx1, sy1] = project(x1, y1, z1, cx, cy);
      const [sx2, sy2] = project(x2, y2, z2, cx, cy);

      // --- Draw triangle ---
      ctx!.moveTo(sx0, sy0);
      ctx!.lineTo(sx1, sy1);
      ctx!.lineTo(sx2, sy2);
      ctx!.lineTo(sx0, sy0);  // close the triangle
    }

    ctx!.stroke();
  }

  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

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

const FOCAL_LENGTH = 250;
let   Z_OFFSET     = 150;        // mutable — scrollwheel zooms this (tight = intense depth)
const MODEL_SCALE      = 80;
/** Scale applied to raw OBJ jet vertices so the jet stays proportional at low Z_OFFSET. */
const JET_VERTEX_SCALE = 0.05;
/** Snap granularity in real canvas pixels. Higher = chunkier PS1 wobble. */
const JITTER           = 5;

const LIGHT: [number, number, number] = normaliseV3(0.4, 0.7, -0.6);

// ---------------------------------------------------------------------------
// Interaction state — camera orbit + pan + zoom
// ---------------------------------------------------------------------------

let rotAngleY = 0.3;
let rotAngleX = -0.15;
let panX      = 0;
let panY      = 0;

let isDraggingRight  = false;
let isDraggingMiddle = false;
let lastMouseX       = 0;
let lastMouseY       = 0;

const ROT_SENSITIVITY  = 0.005;
const PAN_SENSITIVITY  = 0.015;
const ZOOM_SENSITIVITY = 50;    // Z_OFFSET units per normalised wheel delta (~100 per notch)

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('mousedown', (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;

  if (e.button === 2) {
    isDraggingRight     = true;
    canvas.style.cursor = 'grabbing';
  }
  if (e.button === 1) {
    e.preventDefault();
    isDraggingMiddle    = true;
    canvas.style.cursor = 'move';
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
    rotAngleY += dx * ROT_SENSITIVITY;
    rotAngleX += dy * ROT_SENSITIVITY;
  }
  if (isDraggingMiddle) {
    panX += dx * PAN_SENSITIVITY;
    panY -= dy * PAN_SENSITIVITY;
  }
});

// Scroll wheel → zoom in/out by shifting Z_OFFSET
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  // deltaY > 0 → scroll down → zoom out (object further away → increase Z_OFFSET)
  Z_OFFSET += e.deltaY * ZOOM_SENSITIVITY * 0.01;
  Z_OFFSET  = Math.max(10, Math.min(500_000, Z_OFFSET));
}, { passive: false });

// ---------------------------------------------------------------------------
// 3D math helpers
// ---------------------------------------------------------------------------

function normaliseV3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.sqrt(x * x + y * y + z * z);
  return len > 0 ? [x / len, y / len, z / len] : [0, 0, 0];
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

function rotateZ(x: number, y: number, z: number, a: number): [number, number, number] {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * x - s * y, s * x + c * y, z];
}

/** Full euler rotation: yaw (Y) → pitch (X) → roll (Z). */
function rotateEuler(
  x: number, y: number, z: number,
  yaw: number, pitch: number, roll: number,
): [number, number, number] {
  let v = rotateY(x, y, z, yaw);
  v     = rotateX(v[0], v[1], v[2], pitch);
  v     = rotateZ(v[0], v[1], v[2], roll);
  return v;
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

  const rawX = canvas.width  / 2 + x * f * MODEL_SCALE;
  const rawY = canvas.height / 2 - y * f * MODEL_SCALE;

  return [
    Math.round(rawX / JITTER) * JITTER,
    Math.round(rawY / JITTER) * JITTER,
  ];
}

// ---------------------------------------------------------------------------
// FlightDynamics
// ---------------------------------------------------------------------------

class FlightDynamics {
  // World-space position (model units)
  posX = 0; posY = 0; posZ = 0;

  // World-space velocity
  velX = 0; velY = 0; velZ = 0;

  // Euler angles (radians)
  yaw   = 0;   // heading
  pitch = 0;   // nose up / down
  roll  = 0;   // bank

  // Angular rates (radians / s)
  pitchRate = 0;
  yawRate   = 0;
  rollRate  = 0;

  /** Thrust magnitude (model units / s²). Independent of forward velocity. */
  thrust = 0;

  /** Angle of Attack — angle between velocity vector and body forward axis (rad). */
  get angleOfAttack(): number {
    const [fx, fy, fz] = rotateEuler(0, 0, 1, this.yaw, this.pitch, this.roll);
    const spd = Math.sqrt(this.velX ** 2 + this.velY ** 2 + this.velZ ** 2);
    if (spd < 0.0001) return 0;
    const dot = (this.velX * fx + this.velY * fy + this.velZ * fz) / spd;
    return Math.acos(Math.max(-1, Math.min(1, dot)));
  }

  /**
   * Step the simulation by dt seconds.
   *
   * Thrust vectoring: thrust always acts along the body forward axis, so
   * pitching the nose directly changes the thrust direction independent of
   * the current velocity vector.
   */
  update(dt: number): void {
    // Integrate angular rates into Euler angles
    this.pitch += this.pitchRate * dt;
    this.yaw   += this.yawRate   * dt;
    this.roll  += this.rollRate  * dt;
    // No pitch clamp — jet can loop freely through 360°

    // Thrust along current body forward axis (thrust vectoring)
    const [fx, fy, fz] = rotateEuler(0, 0, 1, this.yaw, this.pitch, this.roll);
    this.velX += fx * this.thrust * dt;
    this.velY += fy * this.thrust * dt;
    this.velZ += fz * this.thrust * dt;

    // Simple aerodynamic drag (loose — terminal velocity ∝ thrust / (1 - drag^60fps))
    const drag = 0.9995;
    this.velX *= drag;
    this.velY *= drag;
    this.velZ *= drag;

    // Integrate position
    this.posX += this.velX * dt;
    this.posY += this.velY * dt;
    this.posZ += this.velZ * dt;
  }
}

const flight = new FlightDynamics();
flight.thrust    = 100;   // ×20 — supersonic at new world scale
flight.pitchRate = 0.0;

// ---------------------------------------------------------------------------
// Keyboard input state
// ---------------------------------------------------------------------------

const keys: Record<string, boolean> = {};

window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  // Prevent arrow keys / space from scrolling the page
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) {
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

/**
 * Constants for how fast controls change angular rates and throttle.
 * PITCH/ROLL/YAW_ACCEL: how fast rates ramp up while a key is held (rad/s per s).
 * RATE_DECAY:           natural decay applied when no key is pressed (per frame factor).
 * THROTTLE_STEP:        thrust units added/removed per second of key hold.
 */
const PITCH_ACCEL   = 0.8;      // rad/s²
const ROLL_ACCEL    = 1.2;      // rad/s²
const YAW_ACCEL     = 0.5;      // rad/s²
const RATE_DECAY    = 0.88;     // bleed rate so releasing a key smoothly damps rotation
const THROTTLE_STEP = 10;      // thrust units / s  (×20)
const THROTTLE_MAX  = 100;    // ×20

/** Apply keyboard state to FlightDynamics rates and throttle before physics step. */
function applyKeyInputs(dt: number): void {
  // --- Pitch: S = nose up (negative pitch rate), W = nose down ---
  if (keys['KeyS']) {
    flight.pitchRate -= PITCH_ACCEL * dt;
  } else if (keys['KeyW']) {
    flight.pitchRate += PITCH_ACCEL * dt;
  } else {
    flight.pitchRate *= RATE_DECAY;
  }

  // --- Roll: A = roll left, D = roll right ---
  if (keys['KeyA']) {
    flight.rollRate -= ROLL_ACCEL * dt;
  } else if (keys['KeyD']) {
    flight.rollRate += ROLL_ACCEL * dt;
  } else {
    flight.rollRate *= RATE_DECAY;
  }

  // --- Yaw: Q = yaw left, E = yaw right ---
  if (keys['KeyQ']) {
    flight.yawRate -= YAW_ACCEL * dt;
  } else if (keys['KeyE']) {
    flight.yawRate += YAW_ACCEL * dt;
  } else {
    flight.yawRate *= RATE_DECAY;
  }

  // --- Throttle: Shift = increase, Ctrl = decrease ---
  if (keys['ShiftLeft'] || keys['ShiftRight']) {
    flight.thrust = Math.min(THROTTLE_MAX, flight.thrust + THROTTLE_STEP * dt);
  } else if (keys['ControlLeft'] || keys['ControlRight']) {
    flight.thrust = Math.max(0, flight.thrust - THROTTLE_STEP * dt);
  }
}

// ---------------------------------------------------------------------------

/**
 * The terrain is a scrolling local grid in world XZ centred on the camera.
 * Height is sampled from a multi-octave sine wave.
 *
 * FRUSTUM CULLING: before adding a terrain triangle to the face buffer, all
 * three vertices are projected to screen space.  If every vertex lies outside
 * the same screen edge the triangle is discarded (conservative, no clipping).
 */

const TERRAIN_GRID_HALF = 25;        // cells in each direction — fog hides the horizon cutoff
const TERRAIN_CELL_SIZE = 4500;      // world units per terrain cell

function terrainHeight(wx: number, wz: number): number {
  // Rolling hills — frequencies scaled to match new cell size, amplitudes ×20
  return (
    Math.sin(wx * 0.000090) * 5000 +
    Math.sin(wz * 0.000065) * 4000 +
    Math.sin((wx + wz) * 0.000045) * 2400 +
    Math.sin(wx * 0.000175 - wz * 0.000110) * 1200
  );
}

// ---------------------------------------------------------------------------
// Unified face buffer — holds both jet faces and terrain faces
// ---------------------------------------------------------------------------

interface FaceEntry {
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  x2: number; y2: number; z2: number;
  avgZ:       number;
  brightness: number;
  /** Base colour channels (0-255), multiplied by brightness at draw time. */
  baseR: number; baseG: number; baseB: number;
  /** 0 = jet (amber-gold), 1 = terrain (green), 2 = tree (dark green) */
  kind: 0 | 1 | 2;
}

const MAX_FACES = 20_000;   // 25×25×2 terrain + sparse trees + jet fits comfortably
const facePool: FaceEntry[] = [];
for (let i = 0; i < MAX_FACES; i++) {
  facePool.push({
    x0:0, y0:0, z0:0, x1:0, y1:0, z1:0, x2:0, y2:0, z2:0,
    avgZ: 0, brightness: 1,
    baseR: 255, baseG: 255, baseB: 255, kind: 0,
  });
}

/**
 * Screen-space frustum cull (no clipping — conservative).
 * Returns false when all 3 vertices lie outside the same canvas edge.
 */
function frustumCull(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): boolean {
  // Near-plane cull: everything entirely behind the camera
  const near = -Z_OFFSET + 1;
  if (az < near && bz < near && cz < near) return false;

  const hw = canvas.width  / 2;
  const hh = canvas.height / 2;

  function sx(x: number, z: number): number {
    const d = z + Z_OFFSET;
    return (d > 0.001 ? FOCAL_LENGTH / d : FOCAL_LENGTH / 0.001) * x * MODEL_SCALE;
  }
  function sy(y: number, z: number): number {
    const d = z + Z_OFFSET;
    return (d > 0.001 ? FOCAL_LENGTH / d : FOCAL_LENGTH / 0.001) * y * MODEL_SCALE;
  }

  const sxa = sx(ax, az), sxb = sx(bx, bz), sxc = sx(cx, cz);
  const sya = sy(ay, az), syb = sy(by, bz), syc = sy(cy, cz);

  if (sxa < -hw && sxb < -hw && sxc < -hw) return false;
  if (sxa >  hw && sxb >  hw && sxc >  hw) return false;
  if (sya < -hh && syb < -hh && syc < -hh) return false;
  if (sya >  hh && syb >  hh && syc >  hh) return false;

  return true;
}

/**
 * Generate terrain triangles for this frame.
 * Starts filling facePool at index `startIdx`.
 * Returns the new fill-index.
 */
function pushTerrainFaces(startIdx: number, camWX: number, camWZ: number): number {
  let idx = startIdx;
  const groundY = GROUND_Y;   // terrain floor — shared with tree scatter
  const camWY   = flight.posY;   // camera pivots around jet's world Y

  function toView(wx: number, wy: number, wz: number): [number, number, number] {
    // Translate relative to jet (camera pivot = jet position in all 3 axes)
    const lx = (wx - camWX) / MODEL_SCALE;
    const ly = (wy - camWY) / MODEL_SCALE;
    const lz = (wz - camWZ) / MODEL_SCALE;
    let v = rotateY(lx, ly, lz, rotAngleY);
    v     = rotateX(v[0], v[1], v[2], rotAngleX);
    return [v[0] + panX, v[1] + panY, v[2]];
  }

  // Terrain base colour (lit green)
  const TR = 40, TG = 110, TB = 40;

  for (let gz = -TERRAIN_GRID_HALF; gz < TERRAIN_GRID_HALF; gz++) {
    for (let gx = -TERRAIN_GRID_HALF; gx < TERRAIN_GRID_HALF; gx++) {
      const wx0 = camWX + gx       * TERRAIN_CELL_SIZE;
      const wz0 = camWZ + gz       * TERRAIN_CELL_SIZE;
      const wx1 = camWX + (gx + 1) * TERRAIN_CELL_SIZE;
      const wz1 = camWZ + (gz + 1) * TERRAIN_CELL_SIZE;

      const h00 = terrainHeight(wx0, wz0);
      const h10 = terrainHeight(wx1, wz0);
      const h01 = terrainHeight(wx0, wz1);
      const h11 = terrainHeight(wx1, wz1);

      //  A(wx0,wz0) --- B(wx1,wz0)
      //  |                        |
      //  C(wx0,wz1) --- D(wx1,wz1)
      const [ax, ay, az] = toView(wx0, groundY + h00, wz0);
      const [bx, by, bz] = toView(wx1, groundY + h10, wz0);
      const [cx, cy, cz] = toView(wx0, groundY + h01, wz1);
      const [dx, dy, dz] = toView(wx1, groundY + h11, wz1);

      // Triangle 1: A, B, C  (no backface cull — terrain is always visible from above)
      if (idx < MAX_FACES && frustumCull(ax, ay, az, bx, by, bz, cx, cy, cz)) {
        let [cnx, cny, cnz] = crossV3(bx-ax, by-ay, bz-az, cx-ax, cy-ay, cz-az);
        // Force normal to point upward in view space (ny > 0 after camera rot)
        if (cny < 0) { cnx = -cnx; cny = -cny; cnz = -cnz; }
        const [nx, ny, nz] = normaliseV3(cnx, cny, cnz);
        const br = 0.45 + 0.55 * Math.max(0, dotV3(nx, ny, nz, LIGHT[0], LIGHT[1], LIGHT[2]));
        const e  = facePool[idx++];
        e.x0=ax; e.y0=ay; e.z0=az; e.x1=bx; e.y1=by; e.z1=bz; e.x2=cx; e.y2=cy; e.z2=cz;
        e.avgZ = (az+bz+cz)/3; e.brightness = br;
        e.baseR = TR; e.baseG = TG; e.baseB = TB; e.kind = 1;
      }

      // Triangle 2: B, D, C
      if (idx < MAX_FACES && frustumCull(bx, by, bz, dx, dy, dz, cx, cy, cz)) {
        let [cnx, cny, cnz] = crossV3(dx-bx, dy-by, dz-bz, cx-bx, cy-by, cz-bz);
        if (cny < 0) { cnx = -cnx; cny = -cny; cnz = -cnz; }
        const [nx, ny, nz] = normaliseV3(cnx, cny, cnz);
        const br = 0.45 + 0.55 * Math.max(0, dotV3(nx, ny, nz, LIGHT[0], LIGHT[1], LIGHT[2]));
        const e  = facePool[idx++];
        e.x0=bx; e.y0=by; e.z0=bz; e.x1=dx; e.y1=dy; e.z1=dz; e.x2=cx; e.y2=cy; e.z2=cz;
        e.avgZ = (bz+dz+cz)/3; e.brightness = br;
        e.baseR = TR; e.baseG = TG; e.baseB = TB; e.kind = 1;
      }
    }
  }
  return idx;
}

// ---------------------------------------------------------------------------
// OBJ load — jet + tree in parallel
// ---------------------------------------------------------------------------

let jetData:  ObjData | null = null;
let treeData: ObjData | null = null;

const loader = new ObjLoader();
Promise.all([
  loader.load('/su35.obj'),
  loader.load('/tree.obj'),
]).then(([jet, tree]) => {
  jetData  = jet;
  treeData = tree;
  console.log(`su35.obj — ${jet.vertices.length  / 3} verts, ${jet.indices.length  / 3} tris`);
  console.log(`tree.obj  — ${tree.vertices.length / 3} verts, ${tree.indices.length / 3} tris`);
}).catch((err: unknown) => console.error('Asset load failed:', err));

// ---------------------------------------------------------------------------
// Procedural forest scatter
// ---------------------------------------------------------------------------

const GROUND_Y        = -100000;  // ×20 deeper — matches terrain scale
const TREE_GRID_HALF  = 8;        // matches reduced terrain draw distance
const TREE_CELL_SIZE  = TERRAIN_CELL_SIZE;   // exactly one cell = one terrain vertex spacing
const TREE_SCALE      = 160;      // ×20 larger — proportional to terrain

/**
 * Deterministic pseudo-random [0,1) from two integers.
 * Simple LCG hash — stable across frames for the same cell.
 */
function cellRand(ix: number, iz: number): number {
  let h = (ix * 1619 + iz * 31337) ^ (ix * iz);
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

/**
 * Push instanced tree faces into facePool for visible trees near the camera.
 *
 * Trees are placed exclusively on exact terrain grid vertex positions —
 * i.e. integer multiples of TERRAIN_CELL_SIZE — so their root XZ coordinates
 * are identical to the triangle corner vertices.  terrainHeight() evaluated at
 * those same integer coords gives the exact corner height, guaranteeing the
 * tree base perfectly anchors to the terrain surface with no floating error.
 */
function pushTreeFaces(startIdx: number, camWX: number, camWZ: number): number {
  if (!treeData) return startIdx;
  let idx = startIdx;
  const { vertices, indices } = treeData;
  const camWY = flight.posY;

  // Snap camera position to the nearest terrain vertex so the grid is stable
  const originX = Math.round(camWX / TREE_CELL_SIZE) * TREE_CELL_SIZE;
  const originZ = Math.round(camWZ / TREE_CELL_SIZE) * TREE_CELL_SIZE;

  for (let gz = -TREE_GRID_HALF; gz <= TREE_GRID_HALF; gz++) {
    for (let gx = -TREE_GRID_HALF; gx <= TREE_GRID_HALF; gx++) {
      // wx / wz are exact integer multiples of TERRAIN_CELL_SIZE — terrain vertex coords
      const wx = originX + gx * TREE_CELL_SIZE;
      const wz = originZ + gz * TREE_CELL_SIZE;

      // Skip ~70 % of vertices so the forest is naturally sparse
      if (cellRand(wx, wz) > 0.30) continue;

      // Height sampled at the exact vertex position — matches terrain triangle corner
      const wy = GROUND_Y + terrainHeight(wx, wz);

      // Transform a single tree vertex to view space
      function treeToView(vx: number, vy: number, vz: number): [number, number, number] {
        const wx2 = wx + vx * TREE_SCALE;
        const wy2 = wy + vy * TREE_SCALE;
        const wz2 = wz + vz * TREE_SCALE;
        const lx = (wx2 - camWX) / MODEL_SCALE;
        const ly = (wy2 - camWY) / MODEL_SCALE;
        const lz = (wz2 - camWZ) / MODEL_SCALE;
        let v = rotateY(lx, ly, lz, rotAngleY);
        v     = rotateX(v[0], v[1], v[2], rotAngleX);
        return [v[0] + panX, v[1] + panY, v[2]];
      }

      // Instance all faces of the tree model
      for (let i = 0; i < indices.length; i += 3) {
        if (idx >= MAX_FACES) break;
        const i0 = indices[i]     * 3;
        const i1 = indices[i + 1] * 3;
        const i2 = indices[i + 2] * 3;

        const [ax, ay, az] = treeToView(vertices[i0], vertices[i0+1], vertices[i0+2]);
        const [bx, by, bz] = treeToView(vertices[i1], vertices[i1+1], vertices[i1+2]);
        const [cx, cy, cz] = treeToView(vertices[i2], vertices[i2+1], vertices[i2+2]);

        if (!frustumCull(ax, ay, az, bx, by, bz, cx, cy, cz)) continue;

        const [cnx, cny, cnz] = crossV3(bx-ax, by-ay, bz-az, cx-ax, cy-ay, cz-az);
        if (cnz >= 0) continue;   // backface

        const [nx, ny, nz] = normaliseV3(cnx, cny, cnz);
        const br = 0.45 + 0.55 * Math.max(0, dotV3(nx, ny, nz, LIGHT[0], LIGHT[1], LIGHT[2]));
        const e  = facePool[idx++];
        e.x0=ax; e.y0=ay; e.z0=az; e.x1=bx; e.y1=by; e.z1=bz; e.x2=cx; e.y2=cy; e.z2=cz;
        e.avgZ = (az+bz+cz)/3; e.brightness = br;
        e.baseR = 25; e.baseG = 80; e.baseB = 25; e.kind = 2;
      }
    }
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Distance fog
// ---------------------------------------------------------------------------

/**
 * Fog is applied in PASS 3 by lerping each polygon's lit colour toward the
 * background sky colour based on the face's view-space avgZ depth.
 * FOG_START / FOG_END are in view-space Z units (same scale as avgZ).
 * The background colour rgb(5,5,16) must match the ctx.fillStyle clear colour.
 */
const FOG_START  = 10;   // view-Z at which fog begins (close — matches tight Z_OFFSET)
const FOG_END    = 120;  // view-Z at which fog reaches 100% — geometry fully hidden
const FOG_R      = 5;    // background sky colour R (matches '#050510')
const FOG_G      = 5;    // background sky colour G
const FOG_B      = 16;   // background sky colour B

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let lastTs = 0;

function tick(ts: DOMHighResTimeStamp): void {
  const dt = Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;

  // Apply keyboard controls, then update flight physics
  applyKeyInputs(dt);
  flight.update(dt);

  // Camera tracks jet world position so terrain scrolls beneath it
  const camWX = flight.posX;
  const camWZ = flight.posZ;

  // Clear
  ctx!.fillStyle = '#050510';
  ctx!.fillRect(0, 0, canvas.width, canvas.height);

  let visibleCount = 0;

  // -----------------------------------------------------------------------
  // Collect terrain faces (frustum-culled)
  // -----------------------------------------------------------------------
  visibleCount = pushTerrainFaces(visibleCount, camWX, camWZ);

  // -----------------------------------------------------------------------
  // Collect tree instance faces (frustum-culled, backface-culled)
  // -----------------------------------------------------------------------
  visibleCount = pushTreeFaces(visibleCount, camWX, camWZ);

  // -----------------------------------------------------------------------
  // Collect jet OBJ faces (backface-culled)
  // -----------------------------------------------------------------------
  if (jetData) {
    const { vertices, indices } = jetData;

    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i]     * 3;
      const i1 = indices[i + 1] * 3;
      const i2 = indices[i + 2] * 3;

      // Step 1 — scale jet vertices to keep proportions at low Z_OFFSET, then apply flight orientation
      let [bx0, by0, bz0] = rotateEuler(vertices[i0]*JET_VERTEX_SCALE, vertices[i0+1]*JET_VERTEX_SCALE, vertices[i0+2]*JET_VERTEX_SCALE, flight.yaw, flight.pitch, flight.roll);
      let [bx1, by1, bz1] = rotateEuler(vertices[i1]*JET_VERTEX_SCALE, vertices[i1+1]*JET_VERTEX_SCALE, vertices[i1+2]*JET_VERTEX_SCALE, flight.yaw, flight.pitch, flight.roll);
      let [bx2, by2, bz2] = rotateEuler(vertices[i2]*JET_VERTEX_SCALE, vertices[i2+1]*JET_VERTEX_SCALE, vertices[i2+2]*JET_VERTEX_SCALE, flight.yaw, flight.pitch, flight.roll);

      // Step 2 — apply camera orbit (mouse rotation) on top
      let [x0, y0, z0] = rotateX(...rotateY(bx0, by0, bz0, rotAngleY), rotAngleX);
      let [x1, y1, z1] = rotateX(...rotateY(bx1, by1, bz1, rotAngleY), rotAngleX);
      let [x2, y2, z2] = rotateX(...rotateY(bx2, by2, bz2, rotAngleY), rotAngleX);

      x0 += panX; y0 += panY;
      x1 += panX; y1 += panY;
      x2 += panX; y2 += panY;

      const [cnx, cny, cnz] = crossV3(x1-x0, y1-y0, z1-z0, x2-x0, y2-y0, z2-z0);
      if (cnz >= 0) continue;   // backface

      const [nx, ny, nz] = normaliseV3(cnx, cny, cnz);
      const diffuse       = Math.max(0, dotV3(nx, ny, nz, LIGHT[0], LIGHT[1], LIGHT[2]));
      const brightness    = 0.45 + 0.55 * diffuse;

      if (visibleCount < MAX_FACES) {
        const e = facePool[visibleCount++];
        e.x0=x0; e.y0=y0; e.z0=z0; e.x1=x1; e.y1=y1; e.z1=z1; e.x2=x2; e.y2=y2; e.z2=z2;
        e.avgZ = (z0+z1+z2)/3; e.brightness = brightness;
        e.baseR = 252; e.baseG = 186; e.baseB = 3; e.kind = 0;
      }
    }
  }

  // -----------------------------------------------------------------------
  // PASS 2 — unified Painter's sort across terrain + jet (back → front)
  // -----------------------------------------------------------------------
  const visibleFaces = facePool.slice(0, visibleCount);
  visibleFaces.sort((a, b) => b.avgZ - a.avgZ);

  // -----------------------------------------------------------------------
  // PASS 3 — draw with PS1-snapped vertices + distance fog
  // -----------------------------------------------------------------------
  for (let f = 0; f < visibleFaces.length; f++) {
    const face = visibleFaces[f];
    const { x0, y0, z0, x1, y1, z1, x2, y2, z2, brightness, baseR, baseG, baseB, avgZ, kind } = face;

    const [sx0, sy0] = projectSnapped(x0, y0, z0);
    const [sx1, sy1] = projectSnapped(x1, y1, z1);
    const [sx2, sy2] = projectSnapped(x2, y2, z2);

    // Lit colour before fog
    let lr = brightness * baseR;
    let lg = brightness * baseG;
    let lb = brightness * baseB;

    // Distance fog — lerp lit colour toward sky background based on view-Z depth.
    // Jet faces (kind 0) are always near z≈0 so skip fog for them.
    if (kind !== 0) {
      const fogT = Math.max(0, Math.min(1, (avgZ - FOG_START) / (FOG_END - FOG_START)));
      lr = lr + (FOG_R - lr) * fogT;
      lg = lg + (FOG_G - lg) * fogT;
      lb = lb + (FOG_B - lb) * fogT;
    }

    const r = Math.round(lr);
    const g = Math.round(lg);
    const b = Math.round(lb);

    ctx!.fillStyle   = `rgb(${r},${g},${b})`;
    ctx!.strokeStyle = `rgb(${r},${g},${b})`;
    ctx!.lineWidth    = 0.5;

    ctx!.beginPath();
    ctx!.moveTo(sx0, sy0);
    ctx!.lineTo(sx1, sy1);
    ctx!.lineTo(sx2, sy2);
    ctx!.closePath();
    ctx!.fill();
    ctx!.stroke();
  }

  // -----------------------------------------------------------------------
  // HUD overlay
  // -----------------------------------------------------------------------
  const spd  = Math.sqrt(flight.velX**2 + flight.velY**2 + flight.velZ**2).toFixed(1);
  const alt  = flight.posY.toFixed(0);
  const thr  = flight.thrust.toFixed(1);
  const aoa  = (flight.angleOfAttack * 180 / Math.PI).toFixed(1);

  /** Normalise any radian angle to a [0, 360) degree string. */
  function normDeg(rad: number): string {
    const deg = rad * 180 / Math.PI;
    return Math.round(((deg % 360) + 360) % 360).toString();
  }

  const pitD = normDeg(flight.pitch);
  const yawD = normDeg(flight.yaw);
  const rolD = normDeg(flight.roll);

  ctx!.fillStyle = 'rgba(0,255,100,0.85)';
  ctx!.font      = '13px monospace';
  ctx!.fillText(`SPD  ${spd}   ALT  ${alt}`, 14, 20);
  ctx!.fillText(`THR  ${thr}   AoA  ${aoa}°`, 14, 36);
  ctx!.fillText(`PIT  ${pitD}°  YAW  ${yawD}°  ROL  ${rolD}°`, 14, 52);
  ctx!.fillText(`Z_OFF ${Z_OFFSET.toFixed(0)}  [scroll=zoom  RMB=rot  MMB=pan]`, 14, 68);

  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

/**
 * The parsed result of a .obj file.
 */
export interface ObjData {
  /** Flat [x, y, z, x, y, z, ...] vertex positions. */
  vertices: Float32Array;
  /** Flat [i0, i1, i2, i0, i1, i2, ...] triangle indices (0-based). */
  indices: Uint16Array;
}

/**
 * Loads and parses Wavefront .obj files.
 *
 * Supports:
 *  - `v`  lines  - vertex positions (x y z [w])
 *  - `f`  lines  - triangulated faces (vertex-only OR v/vt/vn notation)
 *  - Negative face indices (resolved relative to the current vertex count)
 *  - Arbitrary whitespace (tabs, multiple spaces, leading/trailing)
 *
 * Does NOT require any external libraries.
 */
export class ObjLoader {
  /**
   * Fetches a .obj file from `url`, parses it, and returns the geometry data.
   *
   * @param url - URL of the .obj file to load.
   * @returns A promise that resolves with the parsed {@link ObjData}.
   * @throws {Error} If the fetch fails or the response is not OK.
   */
  async load(url: string): Promise<ObjData> {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `ObjLoader: failed to fetch "${url}" - ${response.status} ${response.statusText}`
      );
    }

    const text = await response.text();
    return ObjLoader.parse(text);
  }

  // ---------------------------------------------------------------------------
  // Static parsing helpers (exposed for unit-testing without a network call)
  // ---------------------------------------------------------------------------

  /**
   * Parses the raw text content of a .obj file.
   * Exposed as a static method so it can be tested without a network call.
   */
  static parse(objText: string): ObjData {
    const rawVertices: number[] = [];
    const rawIndices:  number[] = [];

    const lines = objText.split(/\r?\n/);

    for (const rawLine of lines) {
      // Strip leading/trailing whitespace; skip blank lines and comments.
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) continue;

      // Split on any run of whitespace so tabs / multiple spaces are handled.
      const parts   = line.split(/\s+/);
      const keyword = parts[0];

      if (keyword === 'v') {
        ObjLoader.parseVertex(parts, rawVertices);
      } else if (keyword === 'f') {
        ObjLoader.parseFace(parts, rawVertices.length / 3, rawIndices);
      }
      // vt, vn, vp, o, g, s, mtllib, usemtl, etc. are intentionally ignored.
    }

    return {
      vertices: new Float32Array(rawVertices),
      indices:  new Uint16Array(rawIndices),
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Parses a `v` directive and appends x, y, z to `out`.
   * The optional w component is discarded.
   */
  private static parseVertex(parts: string[], out: number[]): void {
    const x = parseFloat(parts[1] ?? 'NaN');
    const y = parseFloat(parts[2] ?? 'NaN');
    const z = parseFloat(parts[3] ?? 'NaN');

    if (isNaN(x) || isNaN(y) || isNaN(z)) {
      console.warn(`ObjLoader: skipping malformed vertex line: "${parts.join(' ')}"`);
      return;
    }

    out.push(x, y, z);
  }

  /**
   * Parses an `f` directive and appends fan-triangulated 0-based indices to `out`.
   *
   * Face vertex tokens can be any of:
   *   v      (vertex index only)
   *   v/vt   (vertex + texture)
   *   v/vt/vn (vertex + texture + normal)
   *   v//vn  (vertex + normal, no texture)
   *
   * Only the vertex position index (first component) is extracted.
   * Negative indices are resolved relative to `vertexCount`.
   *
   * @param parts       - Whitespace-split tokens of the face line.
   * @param vertexCount - Number of `v` positions parsed so far.
   * @param out         - Target index accumulator.
   */
  private static parseFace(
    parts: string[],
    vertexCount: number,
    out: number[]
  ): void {
    if (parts.length < 4) {
      // Need at least 3 face-vertices (parts[1..3]) to form a triangle.
      console.warn(`ObjLoader: skipping degenerate face (< 3 verts): "${parts.join(' ')}"`);
      return;
    }

    const resolved: number[] = [];

    for (let i = 1; i < parts.length; i++) {
      const token    = parts[i];
      const rawIndex = parseInt(token.split('/')[0], 10);

      if (isNaN(rawIndex) || rawIndex === 0) {
        console.warn(`ObjLoader: invalid face token "${token}" - skipping face.`);
        return;
      }

      // OBJ indices are 1-based. Negative values count back from vertexCount.
      const idx =
        rawIndex < 0
          ? vertexCount + rawIndex  // e.g. count=4, rawIndex=-1 ? 3
          : rawIndex - 1;           // e.g. rawIndex=1 ? 0

      if (idx < 0 || idx >= vertexCount) {
        console.warn(
          `ObjLoader: face index ${rawIndex} out of range ` +
          `(vertex count: ${vertexCount}) - skipping face.`
        );
        return;
      }

      if (idx > 65535) {
        console.warn(
          `ObjLoader: index ${idx} exceeds Uint16Array max (65535). ` +
          `Switch to Uint32Array for meshes with more than 65536 vertices.`
        );
        return;
      }

      resolved.push(idx);
    }

    // Fan triangulation: anchor=resolved[0], walk pairs (i, i+1) for i >= 1.
    for (let i = 1; i < resolved.length - 1; i++) {
      out.push(resolved[0], resolved[i], resolved[i + 1]);
    }
  }
}

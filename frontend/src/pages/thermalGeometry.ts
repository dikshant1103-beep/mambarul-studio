/**
 * 3D battery geometry for the Thermal Twin (Plotly Mesh3d).
 *
 * Builds cutaway cell shapes whose vertices carry a "core weight" w ∈ [0,1]:
 *   temperature(vertex) = surface + (core - surface) * w
 * so w=1 at the hidden core (hot), w=0 on the outer skin (surface temp).
 * Cutaway faces expose the core; the side/skin shows surface temperature.
 *
 * Pack: an array of small cell-cylinders; each vertex carries its CELL index so it
 * can be coloured by that cell's temperature.
 */
export interface Mesh {
  X: number[]; Y: number[]; Z: number[]
  W: number[]            // core-weight per vertex (cell shapes)
  CELL: number[]         // cell index per vertex (pack)
  I: number[]; J: number[]; K: number[]
}

const newMesh = (): Mesh => ({ X: [], Y: [], Z: [], W: [], CELL: [], I: [], J: [], K: [] })

/** Add a parametric (nu+1)x(nv+1) grid surface. fn(u,v)->[x,y,z,w], u,v in [0,1]. */
function addSurface(m: Mesh, fn: (u: number, v: number) => [number, number, number, number],
                    nu: number, nv: number, cell = -1) {
  const start = m.X.length
  const idx = (a: number, b: number) => start + a * (nv + 1) + b
  for (let a = 0; a <= nu; a++) for (let b = 0; b <= nv; b++) {
    const [x, y, z, w] = fn(a / nu, b / nv)
    m.X.push(x); m.Y.push(y); m.Z.push(z); m.W.push(w); m.CELL.push(cell)
  }
  for (let a = 0; a < nu; a++) for (let b = 0; b < nv; b++) {
    const i0 = idx(a, b), i1 = idx(a + 1, b), i2 = idx(a + 1, b + 1), i3 = idx(a, b + 1)
    m.I.push(i0, i0); m.J.push(i1, i2); m.K.push(i2, i3)
  }
}

const R = 1, H = 3.2          // cell radius / height (≈ 21700 proportions)
const CUT = 0.25              // fraction of the cylinder removed (90° wedge) → cutaway

/** Cylindrical cell, cut open so the hot core is visible. */
export function cylinderCutaway(seg = 56, nr = 8): Mesh {
  const m = newMesh()
  const tmax = 2 * Math.PI * (1 - CUT)
  const cs = (t: number) => [Math.cos(t), Math.sin(t)]
  // outer skin (w=0 = surface temp)
  addSurface(m, (u, v) => { const [c, s] = cs(u * tmax); return [R * c, R * s, -H / 2 + v * H, 0] }, seg, 1)
  // top + bottom caps (radial field: w = 1-(r/R)^2)
  addSurface(m, (u, v) => { const [c, s] = cs(u * tmax); const r = v * R; return [r * c, r * s, H / 2, 1 - v * v] }, seg, nr)
  addSurface(m, (u, v) => { const [c, s] = cs(u * tmax); const r = v * R; return [r * c, r * s, -H / 2, 1 - v * v] }, seg, nr)
  // two cut faces (expose the core gradient)
  addSurface(m, (u, v) => [u * R, 0, -H / 2 + v * H, 1 - u * u], nr, 1)
  const [cm, sm] = cs(tmax)
  addSurface(m, (u, v) => [u * R * cm, u * R * sm, -H / 2 + v * H, 1 - u * u], nr, 1)
  return m
}

/** Pouch cell: thin slab, broad front face shows the thermal field, + two tabs. */
export function slabCutaway(): Mesh {
  const m = newMesh()
  const a = 1.1, c = 1.5, t = 0.45   // half width, half height, half thickness
  const bowl = (x: number, z: number) => (1 - (x / a) ** 2) * (1 - (z / c) ** 2)
  // front broad face (field)
  addSurface(m, (u, v) => { const x = -a + u * 2 * a, z = -c + v * 2 * c; return [x, t, z, Math.max(0, bowl(x, z))] }, 14, 14)
  // back broad face (surface)
  addSurface(m, (u, v) => [-a + u * 2 * a, -t, -c + v * 2 * c, 0], 6, 6)
  // 4 edges (surface)
  addSurface(m, (u, v) => [-a + u * 2 * a, -t + v * 2 * t, c, 0], 6, 1)    // top
  addSurface(m, (u, v) => [-a + u * 2 * a, -t + v * 2 * t, -c, 0], 6, 1)   // bottom
  addSurface(m, (u, v) => [-a, -t + v * 2 * t, -c + u * 2 * c, 0], 6, 1)   // left
  addSurface(m, (u, v) => [a, -t + v * 2 * t, -c + u * 2 * c, 0], 6, 1)    // right
  return m
}

/** Grey terminal cap(s): a "+" button for cylindrical, two tabs for pouch. */
export function terminalNub(geometry: 'cylindrical' | 'pouch'): Mesh {
  const m = newMesh()
  if (geometry === 'cylindrical') {
    const rr = 0.4, h0 = H / 2, h1 = H / 2 + 0.28, tmax = 2 * Math.PI
    addSurface(m, (u, v) => { const t = u * tmax; return [rr * Math.cos(t), rr * Math.sin(t), h0 + v * (h1 - h0), 0] }, 24, 1)
    addSurface(m, (u, v) => { const t = u * tmax, r = v * rr; return [r * Math.cos(t), r * Math.sin(t), h1, 0] }, 24, 4)
  } else {
    const a = 1.1, c = 1.5, tw = 0.22, th = 0.28, dep = 0.12
    for (const cx of [-a * 0.45, a * 0.45]) {
      // each terminal tab is a small box on the top edge (x: cx±tw, y:±dep, z: c..c+th)
      const x0 = cx - tw, x1 = cx + tw, y0 = -dep, y1 = dep, z0 = c, z1 = c + th
      addSurface(m, (u, v) => [x0 + u * (x1 - x0), y0 + v * (y1 - y0), z1, 0], 2, 2) // top
      addSurface(m, (u, v) => [x0 + u * (x1 - x0), y0 + v * (y1 - y0), z0, 0], 2, 2) // bottom
      addSurface(m, (u, v) => [x0 + u * (x1 - x0), y0, z0 + v * (z1 - z0), 0], 2, 1)
      addSurface(m, (u, v) => [x0 + u * (x1 - x0), y1, z0 + v * (z1 - z0), 0], 2, 1)
      addSurface(m, (u, v) => [x0, y0 + u * (y1 - y0), z0 + v * (z1 - z0), 0], 1, 1)
      addSurface(m, (u, v) => [x1, y0 + u * (y1 - y0), z0 + v * (z1 - z0), 0], 1, 1)
    }
  }
  return m
}

/** Pack: a grid of small cell-cylinders; each vertex tagged with its cell index. */
export function packCylinders(rows: number, cols: number, seg = 14): Mesh {
  const m = newMesh()
  const rr = 0.4, hh = 1.0, pitch = 1.0, tmax = 2 * Math.PI
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const ci = r * cols + c
    const ox = c * pitch, oy = (rows - 1 - r) * pitch    // row 0 at top
    addSurface(m, (u, v) => { const t = u * tmax; return [ox + rr * Math.cos(t), oy + rr * Math.sin(t), v * hh, 0] }, seg, 1, ci)
    addSurface(m, (u, v) => { const t = u * tmax, rad = v * rr; return [ox + rad * Math.cos(t), oy + rad * Math.sin(t), hh, 0] }, seg, 2, ci)
  }
  return m
}

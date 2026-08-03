/**
 * Planar homography (projective transform) from 4 point correspondences.
 *
 * Used to map field-plane coordinates (GPS projected to local metres) onto the
 * pitch rectangle on screen. Four correspondences fix the 8 DOF of a 3x3
 * homography (h33 := 1); we solve the resulting 8x8 linear system directly.
 */

export type Pt = [number, number];

/** Solve A x = b for an n x n system via Gauss-Jordan with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];

    const pv = M[col][col];
    if (Math.abs(pv) < 1e-12) {
      throw new Error('degenerate homography (are 3 corners collinear?)');
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / pv;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

/** Build the 3x3 homography (row-major, length 9) mapping src[i] -> dst[i]. */
export function computeHomography(src: Pt[], dst: Pt[]): number[] {
  if (src.length !== 4 || dst.length !== 4) {
    throw new Error('computeHomography needs exactly 4 correspondences');
  }
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = src[i];
    const [dx, dy] = dst[i];
    A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]);
    b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]);
    b.push(dy);
  }
  const h = solve(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Apply a homography to a point. */
export function applyHomography(H: number[], [x, y]: Pt): Pt {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

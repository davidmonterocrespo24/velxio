// Gaussian elimination with partial pivoting for small dense systems.
// Ax = b where A is n×n and b is length n. Returns x (length n).
// Throws on singular matrices.
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-14) {
      throw new Error(`Singular matrix at column ${col}`);
    }
    if (pivot !== col) {
      [M[col], M[pivot]] = [M[pivot], M[col]];
    }

    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = M[r][n];
    for (let c = r + 1; c < n; c++) sum -= M[r][c] * x[c];
    x[r] = sum / M[r][r];
  }
  return x;
}

export function zeros(n, m) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = new Array(m).fill(0);
  return out;
}

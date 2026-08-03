import { expect, test } from 'bun:test';
import { applyHomography, computeHomography, type Pt } from './homography';

const SRC: Pt[] = [
  [0, 0],
  [100, 0],
  [100, 68],
  [0, 68],
];

test('maps the 4 corners exactly', () => {
  const dst: Pt[] = [
    [40, 40],
    [860, 40],
    [860, 580],
    [40, 580],
  ];
  const H = computeHomography(SRC, dst);
  for (let i = 0; i < 4; i++) {
    const [x, y] = applyHomography(H, SRC[i]);
    expect(x).toBeCloseTo(dst[i][0], 6);
    expect(y).toBeCloseTo(dst[i][1], 6);
  }
});

test('rectangle->rectangle is affine: centre maps to centre', () => {
  const dst: Pt[] = [
    [40, 40],
    [860, 40],
    [860, 580],
    [40, 580],
  ];
  const H = computeHomography(SRC, dst);
  const [x, y] = applyHomography(H, [50, 34]);
  expect(x).toBeCloseTo((40 + 860) / 2, 6);
  expect(y).toBeCloseTo((40 + 580) / 2, 6);
});

test('recovers a true projective (irregular quad) at its corners', () => {
  const dst: Pt[] = [
    [100, 50],
    [800, 80],
    [860, 560],
    [60, 520],
  ];
  const H = computeHomography(SRC, dst);
  for (let i = 0; i < 4; i++) {
    const [x, y] = applyHomography(H, SRC[i]);
    expect(x).toBeCloseTo(dst[i][0], 4);
    expect(y).toBeCloseTo(dst[i][1], 4);
  }
});

test('throws on collinear corners', () => {
  const bad: Pt[] = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ];
  expect(() => computeHomography(SRC, bad)).toThrow();
});

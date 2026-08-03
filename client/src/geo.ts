/**
 * Equirectangular projection of lat/lon onto a local metres plane around a
 * reference point. Over a ~100 m pitch the distortion is negligible, and small
 * metre-scale coordinates keep the homography solve well-conditioned (vs feeding
 * raw lat/lon ~20/45 with millidegree variation straight in).
 */
import type { Pt } from './homography';

export interface LatLon {
  lat: number;
  lon: number;
}

const M_PER_DEG_LAT = 111_320;

export function makeProjector(ref: LatLon): (p: LatLon) => Pt {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((ref.lat * Math.PI) / 180);
  return ({ lat, lon }) => [
    (lon - ref.lon) * mPerDegLon,
    (lat - ref.lat) * M_PER_DEG_LAT,
  ];
}

import { FormationId } from '../types/simulation';

/**
 * Generates deterministic 3D target coordinates (x, y, z) for up to maxCount particles.
 * Used as the GPU morphing target buffer so 65K fluid points can imitate geometric shapes
 * or interpolate custom 3D point clouds emitted by the MCP run_data_processor tool.
 */
export function buildFormationTargets(
  formation: FormationId,
  count: number,
  customAnchorTriplets?: number[]
): Float32Array {
  const targets = new Float32Array(count * 3);

  if (formation === 'custom' && customAnchorTriplets && customAnchorTriplets.length >= 3) {
    const anchorCount = Math.floor(customAnchorTriplets.length / 3);
    for (let i = 0; i < count; i++) {
      const aIdx = (i % anchorCount) * 3;
      // Micro-jitter keeps overlapping fluid points volumetric instead of collapsing to a single pixel
      const jitterPhase = (i * 0.61803398875) % 1;
      const angle = jitterPhase * Math.PI * 2;
      const spread = 0.018 * Math.sin(i * 1.732);
      targets[i * 3] = customAnchorTriplets[aIdx] + Math.cos(angle) * spread;
      targets[i * 3 + 1] = customAnchorTriplets[aIdx + 1] + Math.sin(angle) * spread;
      targets[i * 3 + 2] = customAnchorTriplets[aIdx + 2] + Math.cos(angle * 1.7) * spread;
    }
    return targets;
  }

  for (let i = 0; i < count; i++) {
    const t = i / count;
    const phi = t * Math.PI * 2 * 137.508;
    const u = ((i * 0.61803398875) % 1) * Math.PI * 2;
    const v = t * Math.PI * 2;

    let x = 0;
    let y = 0;
    let z = 0;

    switch (formation) {
      case 'torus': {
        // Trefoil Torus Knot (p=2, q=3)
        const major = 0.85;
        const tube = 0.24;
        const p = 2;
        const q = 3;
        const r = major + 0.32 * Math.cos(q * v);
        const cx = r * Math.cos(p * v);
        const cy = r * Math.sin(p * v);
        const cz = 0.36 * Math.sin(q * v);
        x = cx + tube * Math.cos(u) * Math.cos(p * v);
        y = cy + tube * Math.cos(u) * Math.sin(p * v);
        z = cz + tube * Math.sin(u);
        break;
      }

      case 'helix': {
        // Double Harmonic Helix with cross-rungs
        const strand = i % 2 === 0 ? 1 : -1;
        const h = (t - 0.5) * 2.2;
        const turns = t * Math.PI * 8;
        const radius = 0.62;
        if (i % 9 === 0) {
          const rungMix = ((i * 0.381966) % 1) * 2 - 1;
          x = Math.cos(turns) * radius * rungMix;
          y = h;
          z = Math.sin(turns) * radius * rungMix;
        } else {
          x = Math.cos(turns) * radius * strand + Math.cos(u) * 0.05;
          y = h;
          z = Math.sin(turns) * radius * strand + Math.sin(u) * 0.05;
        }
        break;
      }

      case 'mandala': {
        // Standing-wave cymatic mandala disk
        const radial = Math.sqrt(t) * 1.28;
        const petals = 8;
        const wave = Math.sin(radial * 10.0) * 0.12 + Math.cos(phi * petals) * 0.16;
        x = radial * Math.cos(phi);
        y = radial * Math.sin(phi);
        z = wave * (1.1 - radial * 0.5);
        break;
      }

      case 'lattice': {
        // 3D Resonant Wave Lattice
        const side = Math.ceil(Math.cbrt(count));
        const ix = i % side;
        const iy = Math.floor(i / side) % side;
        const iz = Math.floor(i / (side * side));
        const nx = (ix / (side - 1) - 0.5) * 2.0;
        const ny = (iy / (side - 1) - 0.5) * 2.0;
        const nz = (iz / (side - 1) - 0.5) * 2.0;
        x = nx;
        y = ny + Math.sin(nx * 3.1 + nz * 3.1) * 0.14;
        z = nz;
        break;
      }

      case 'fluid':
      default: {
        // Spherical volumetric nebula seed
        const r = 0.4 + Math.cbrt((i * 0.7548776662) % 1) * 0.85;
        const theta = Math.acos(1 - 2 * t);
        x = r * Math.sin(theta) * Math.cos(phi);
        y = r * Math.sin(theta) * Math.sin(phi);
        z = r * Math.cos(theta);
        break;
      }
    }

    targets[i * 3] = x;
    targets[i * 3 + 1] = y;
    targets[i * 3 + 2] = z;
  }

  return targets;
}

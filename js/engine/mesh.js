// EngineMesh — UV-mapped primitive builders. Same primitive vocabulary the
// game's procedural models are composed from today (box, cylinder, plane),
// but with texture coordinates so materials from TexGen actually land on them.
// Output: { positions:[x,y,z...], normals:[...], uvs:[u,v...], indices:[...] }.
(function () {
    const EngineMesh = {};

    // Flat ground grid on y=0, centred on the origin, UVs tiled `repeat` times.
    EngineMesh.gridPlane = (size, divisions, repeat) => {
        const positions = [], normals = [], uvs = [], indices = [];
        const step = size / divisions, half = size / 2;
        for (let z = 0; z <= divisions; z++) {
            for (let x = 0; x <= divisions; x++) {
                positions.push(x * step - half, 0, z * step - half);
                normals.push(0, 1, 0);
                uvs.push((x / divisions) * repeat, (z / divisions) * repeat);
            }
        }
        const row = divisions + 1;
        for (let z = 0; z < divisions; z++) {
            for (let x = 0; x < divisions; x++) {
                const a = z * row + x, b = a + 1, c = a + row, d = c + 1;
                indices.push(a, c, b, b, c, d);
            }
        }
        return { positions, normals, uvs, indices };
    };

    // Axis-aligned box centred at the origin; every face gets the full [0,1] UV
    // square (so a masonry course reads correctly on each wall).
    EngineMesh.box = (w, h, d) => {
        const x = w / 2, y = h / 2, z = d / 2;
        // face: 4 corners (CCW seen from outside), normal, uv corners
        const faces = [
            { n: [0, 0, 1],  v: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },     // +Z
            { n: [0, 0, -1], v: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] }, // -Z
            { n: [1, 0, 0],  v: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },     // +X
            { n: [-1, 0, 0], v: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] }, // -X
            { n: [0, 1, 0],  v: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },     // +Y
            { n: [0, -1, 0], v: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] }  // -Y
        ];
        const positions = [], normals = [], uvs = [], indices = [];
        const uvq = [[0, 1], [1, 1], [1, 0], [0, 0]];
        faces.forEach((f, fi) => {
            const base = fi * 4;
            f.v.forEach((p, i) => {
                positions.push(p[0], p[1], p[2]);
                normals.push(f.n[0], f.n[1], f.n[2]);
                uvs.push(uvq[i][0], uvq[i][1]);
            });
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        });
        return { positions, normals, uvs, indices };
    };

    // Y-axis cylinder (or cone when rTop = 0) with side + caps; side UVs wrap
    // around the circumference, caps get a radial square mapping. Emits explicit
    // per-segment triangles — the earlier shared-ring version produced a
    // degenerate strip at a cone's apex (the M0 "invisible pyramid" bug).
    EngineMesh.cylinder = (rTop, rBottom, h, segments) => {
        const positions = [], normals = [], uvs = [], indices = [];
        const half = h / 2;
        const slope = (rBottom - rTop) / h;
        const nl = Math.hypot(1, slope);
        const push = (p, n, uv) => {
            positions.push(p[0], p[1], p[2]);
            normals.push(n[0], n[1], n[2]);
            uvs.push(uv[0], uv[1]);
            return positions.length / 3 - 1;
        };
        for (let i = 0; i < segments; i++) {
            const t0 = (i / segments) * Math.PI * 2;
            const t1 = ((i + 1) / segments) * Math.PI * 2;
            const c0 = Math.cos(t0), s0 = Math.sin(t0);
            const c1 = Math.cos(t1), s1 = Math.sin(t1);
            const n0 = [c0 / nl, slope / nl, s0 / nl];
            const n1 = [c1 / nl, slope / nl, s1 / nl];
            const u0 = i / segments, u1 = (i + 1) / segments;
            const B0 = [c0 * rBottom, -half, s0 * rBottom];
            const B1 = [c1 * rBottom, -half, s1 * rBottom];
            if (rTop > 0) {
                const T0 = [c0 * rTop, half, s0 * rTop];
                const T1 = [c1 * rTop, half, s1 * rTop];
                const a = push(T0, n0, [u0, 0]), b = push(B0, n0, [u0, 1]);
                const c = push(T1, n1, [u1, 0]), d = push(B1, n1, [u1, 1]);
                indices.push(a, b, d, a, d, c);
            } else {
                // cone: one triangle per segment, apex normal at the mid-angle
                const tm = (t0 + t1) / 2;
                const nm = [Math.cos(tm) / nl, slope / nl, Math.sin(tm) / nl];
                const a = push([0, half, 0], nm, [(u0 + u1) / 2, 0]);
                const b = push(B0, n0, [u0, 1]);
                const d = push(B1, n1, [u1, 1]);
                indices.push(a, b, d);
            }
        }
        // caps (triangle fans around centre vertices)
        const cap = (r, y, ny) => {
            if (r <= 0) return;
            const centre = push([0, y, 0], [0, ny, 0], [0.5, 0.5]);
            for (let i = 0; i <= segments; i++) {
                const t = (i / segments) * Math.PI * 2;
                const c = Math.cos(t), s = Math.sin(t);
                push([c * r, y, s * r], [0, ny, 0], [0.5 + c * 0.5, 0.5 + s * 0.5]);
            }
            for (let i = 0; i < segments; i++) {
                const p1 = centre + 1 + i, p2 = centre + 2 + i;
                if (ny > 0) indices.push(centre, p2, p1);
                else indices.push(centre, p1, p2);
            }
        };
        cap(rTop, half, 1);
        cap(rBottom, -half, -1);
        return { positions, normals, uvs, indices };
    };

    // Lat-long sphere; opts.jitter (0..~0.5) displaces vertices radially with a
    // seeded rng — squash/stretch via model scale turns it into boulders,
    // canopies and bushes. Shared vertices keep the jitter watertight.
    EngineMesh.sphere = (r, wSeg = 10, hSeg = 7, opts = {}) => {
        const positions = [], normals = [], uvs = [], indices = [];
        const rand = (window.TexGen && opts.jitter) ? TexGen.rng(opts.seed || 1) : null;
        for (let y = 0; y <= hSeg; y++) {
            const phi = (y / hSeg) * Math.PI;
            const sp = Math.sin(phi), cp = Math.cos(phi);
            for (let x = 0; x <= wSeg; x++) {
                const theta = (x / wSeg) * Math.PI * 2;
                let rr = r;
                if (rand && y > 0 && y < hSeg) {
                    rr = r * (1 + (rand() - 0.5) * (opts.jitter || 0));
                }
                const px = Math.cos(theta) * sp * rr;
                const py = cp * rr;
                const pz = Math.sin(theta) * sp * rr;
                positions.push(px, py, pz);
                const nl = Math.hypot(px, py, pz) || 1;
                normals.push(px / nl, py / nl, pz / nl);
                uvs.push(x / wSeg, y / hSeg);
            }
        }
        // stitch the seam: copy the x=0 vertex of each ring onto x=wSeg so the
        // jittered silhouette stays closed
        const row = wSeg + 1;
        for (let y = 0; y <= hSeg; y++) {
            const a = (y * row) * 3, b = (y * row + wSeg) * 3;
            positions[b] = positions[a];
            positions[b + 1] = positions[a + 1];
            positions[b + 2] = positions[a + 2];
            normals[b] = normals[a];
            normals[b + 1] = normals[a + 1];
            normals[b + 2] = normals[a + 2];
        }
        for (let y = 0; y < hSeg; y++) {
            for (let x = 0; x < wSeg; x++) {
                const a = y * row + x, b = a + 1, c = a + row, d = c + 1;
                indices.push(a, c, b, b, c, d);
            }
        }
        return { positions, normals, uvs, indices };
    };

    window.EngineMesh = EngineMesh;
})();

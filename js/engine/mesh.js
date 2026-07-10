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
                // CCW seen from outside (winding audit: cross agrees with normals)
                indices.push(a, d, b, a, c, d);
            } else {
                // cone: one triangle per segment, apex normal at the mid-angle
                const tm = (t0 + t1) / 2;
                const nm = [Math.cos(tm) / nl, slope / nl, Math.sin(tm) / nl];
                const a = push([0, half, 0], nm, [(u0 + u1) / 2, 0]);
                const b = push(B0, n0, [u0, 1]);
                const d = push(B1, n1, [u1, 1]);
                indices.push(a, d, b);
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
                // CCW seen from outside (lat-long rings run north→south)
                indices.push(a, b, c, b, d, c);
            }
        }
        return { positions, normals, uvs, indices };
    };

    // Hip-point pyramid roof over a w×d rectangle: eaves at y=0, apex at (0,h,0).
    // Four sloped faces with per-face normals; a downward base quad closes it.
    EngineMesh.pyramid = (w, d, h) => {
        const positions = [], normals = [], uvs = [], indices = [];
        const x = w / 2, z = d / 2;
        const corners = [[-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z]]; // CCW from above
        const apex = [0, h, 0];
        const face = (a, b) => {
            // outward normal from cross(b−apex, a−apex)
            const u = [b[0] - apex[0], b[1] - apex[1], b[2] - apex[2]];
            const v = [a[0] - apex[0], a[1] - apex[1], a[2] - apex[2]];
            let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
            const nl = Math.hypot(nx, ny, nz) || 1;
            nx /= nl; ny /= nl; nz /= nl;
            const base = positions.length / 3;
            [[apex, [0.5, 0]], [b, [1, 1]], [a, [0, 1]]].forEach(([p, uv]) => {
                positions.push(p[0], p[1], p[2]);
                normals.push(nx, ny, nz);
                uvs.push(uv[0], uv[1]);
            });
            indices.push(base, base + 1, base + 2);
        };
        for (let i = 0; i < 4; i++) face(corners[i], corners[(i + 1) % 4]);
        // base (faces down)
        const b0 = positions.length / 3;
        const buv = [[0, 0], [1, 0], [1, 1], [0, 1]];
        corners.forEach((p, i) => {
            positions.push(p[0], p[1], p[2]);
            normals.push(0, -1, 0);
            uvs.push(buv[i][0], buv[i][1]);
        });
        indices.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
        return { positions, normals, uvs, indices };
    };

    // Gabled roof prism: ridge along the X axis at height h, eaves at y=0 over a
    // w×d rectangle. Two sloped quads, two triangular gables, downward base.
    EngineMesh.prism = (w, d, h) => {
        const positions = [], normals = [], uvs = [], indices = [];
        const x = w / 2, z = d / 2;
        const quad = (a, b, c, dd, n, reps) => {
            const base = positions.length / 3;
            const uvq = [[0, 1], [reps || 1, 1], [reps || 1, 0], [0, 0]];
            [a, b, c, dd].forEach((p, i) => {
                positions.push(p[0], p[1], p[2]);
                normals.push(n[0], n[1], n[2]);
                uvs.push(uvq[i][0], uvq[i][1]);
            });
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };
        const nl = Math.hypot(h, z);
        // front slope (+Z): eave edge → ridge, CCW from outside
        quad([-x, 0, z], [x, 0, z], [x, h, 0], [-x, h, 0], [0, z / nl, h / nl]);
        // back slope (−Z)
        quad([x, 0, -z], [-x, 0, -z], [-x, h, 0], [x, h, 0], [0, z / nl, -h / nl]);
        // gable triangles (±X)
        const tri = (a, b, c, n) => {
            const base = positions.length / 3;
            const uvt = [[0, 1], [1, 1], [0.5, 0]];
            [a, b, c].forEach((p, i) => {
                positions.push(p[0], p[1], p[2]);
                normals.push(n[0], n[1], n[2]);
                uvs.push(uvt[i][0], uvt[i][1]);
            });
            indices.push(base, base + 1, base + 2);
        };
        tri([x, 0, z], [x, 0, -z], [x, h, 0], [1, 0, 0]);
        tri([-x, 0, -z], [-x, 0, z], [-x, h, 0], [-1, 0, 0]);
        // base (faces down)
        quad([-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z], [0, -1, 0]);
        return { positions, normals, uvs, indices };
    };

    // Rectangular frustum (tapered box): bottom wB×dB at y=0, top wT×dT at y=h.
    // Ziggurat tiers, tapering towers, plinths.
    EngineMesh.frustum = (wB, dB, wT, dT, h) => {
        const positions = [], normals = [], uvs = [], indices = [];
        const bx = wB / 2, bz = dB / 2, tx = wT / 2, tz = dT / 2;
        // True CCW seen from above (+Y): walls built along B[i]→B[i+1] then face
        // OUTWARD (the first draft traversed clockwise — self-consistent normals,
        // but every wall pointed inward).
        const B = [[-bx, 0, -bz], [-bx, 0, bz], [bx, 0, bz], [bx, 0, -bz]];
        const T = [[-tx, h, -tz], [-tx, h, tz], [tx, h, tz], [tx, h, -tz]];
        const side = (b0, b1, t1, t0) => {
            // outward normal from the quad's edges
            const u = [b1[0] - b0[0], b1[1] - b0[1], b1[2] - b0[2]];
            const v = [t0[0] - b0[0], t0[1] - b0[1], t0[2] - b0[2]];
            let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
            const nl = Math.hypot(nx, ny, nz) || 1;
            nx /= nl; ny /= nl; nz /= nl;
            const base = positions.length / 3;
            const uvq = [[0, 1], [1, 1], [1, 0], [0, 0]];
            [b0, b1, t1, t0].forEach((p, i) => {
                positions.push(p[0], p[1], p[2]);
                normals.push(nx, ny, nz);
                uvs.push(uvq[i][0], uvq[i][1]);
            });
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };
        // walls: bottom edge i→i+1 runs CCW seen from above = CCW from outside
        for (let i = 0; i < 4; i++) {
            side(B[i], B[(i + 1) % 4], T[(i + 1) % 4], T[i]);
        }
        // top (up) and bottom (down)
        const capQuad = (pts, n) => {
            const base = positions.length / 3;
            const uvq = [[0, 0], [1, 0], [1, 1], [0, 1]];
            pts.forEach((p, i) => {
                positions.push(p[0], p[1], p[2]);
                normals.push(n[0], n[1], n[2]);
                uvs.push(uvq[i][0], uvq[i][1]);
            });
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };
        capQuad(T, [0, 1, 0]);                           // CCW from above → faces up
        capQuad([B[3], B[2], B[1], B[0]], [0, -1, 0]);   // reversed → faces down
        return { positions, normals, uvs, indices };
    };

    // Flat disc on y=0 facing up — blob shadows, floor decals. UVs map the
    // enclosing square so radial textures land centred.
    EngineMesh.disc = (r, segments) => {
        const positions = [0, 0, 0], normals = [0, 1, 0], uvs = [0.5, 0.5], indices = [];
        for (let i = 0; i <= segments; i++) {
            const t = (i / segments) * Math.PI * 2;
            const c = Math.cos(t), s = Math.sin(t);
            positions.push(c * r, 0, s * r);
            normals.push(0, 1, 0);
            uvs.push(0.5 + c * 0.5, 0.5 + s * 0.5);
        }
        for (let i = 0; i < segments; i++) {
            indices.push(0, i + 2, i + 1); // CCW seen from +Y
        }
        return { positions, normals, uvs, indices };
    };

    // Single quad centred at the origin facing +Z — health bars and other
    // billboarded rectangles (pair with M3D.billboard so it faces the camera).
    EngineMesh.quad = (w, h) => {
        const x = w / 2, y = h / 2;
        return {
            positions: [-x, -y, 0, x, -y, 0, x, y, 0, -x, y, 0],
            normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
            uvs: [0, 1, 1, 1, 1, 0, 0, 0],
            indices: [0, 1, 2, 0, 2, 3] // CCW seen from +Z
        };
    };

    // Winding audit: every triangle's geometric normal (cross product) must
    // agree with its averaged vertex normals — the precondition for enabling
    // back-face culling. Returns the number of disagreeing triangles.
    EngineMesh.auditWinding = (mesh) => {
        let bad = 0;
        const p = mesh.positions, n = mesh.normals, idx = mesh.indices;
        for (let i = 0; i < idx.length; i += 3) {
            const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
            const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
            const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
            const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
            const nx = n[a] + n[b] + n[c], ny = n[a + 1] + n[b + 1] + n[c + 1], nz = n[a + 2] + n[b + 2] + n[c + 2];
            if (cx * nx + cy * ny + cz * nz < 0) bad++;
        }
        return bad;
    };

    window.EngineMesh = EngineMesh;
})();

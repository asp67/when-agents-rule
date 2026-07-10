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

    // Y-axis cylinder (or cone when rTop=0) with side + caps; side UVs wrap
    // around the circumference, caps get a radial-ish square mapping.
    EngineMesh.cylinder = (rTop, rBottom, h, segments) => {
        const positions = [], normals = [], uvs = [], indices = [];
        const half = h / 2;
        const slope = (rBottom - rTop) / h;
        // side rings (duplicate seam vertex for clean UV wrap)
        for (let i = 0; i <= segments; i++) {
            const t = (i / segments) * Math.PI * 2;
            const c = Math.cos(t), s = Math.sin(t);
            const nl = Math.hypot(1, slope);
            const nx = c / nl, ny = slope / nl, nz = s / nl;
            positions.push(c * rTop, half, s * rTop);
            normals.push(nx, ny, nz);
            uvs.push(i / segments, 0);
            positions.push(c * rBottom, -half, s * rBottom);
            normals.push(nx, ny, nz);
            uvs.push(i / segments, 1);
        }
        for (let i = 0; i < segments; i++) {
            const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
            indices.push(a, b, c, c, b, d);
        }
        // caps (triangle fans around centre vertices)
        const cap = (r, y, ny) => {
            if (r <= 0) return;
            const centre = positions.length / 3;
            positions.push(0, y, 0);
            normals.push(0, ny, 0);
            uvs.push(0.5, 0.5);
            for (let i = 0; i <= segments; i++) {
                const t = (i / segments) * Math.PI * 2;
                const c = Math.cos(t), s = Math.sin(t);
                positions.push(c * r, y, s * r);
                normals.push(0, ny, 0);
                uvs.push(0.5 + c * 0.5, 0.5 + s * 0.5);
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

    window.EngineMesh = EngineMesh;
})();

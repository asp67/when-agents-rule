// M3D — minimal 3D math for the in-house engine.
// Vectors are plain [x, y, z] arrays; matrices are column-major Float32Array(16)
// (WebGL convention: element [col*4 + row]).
(function () {
    const M3D = {};

    // ---- vec3 -----------------------------------------------------------------
    M3D.sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    M3D.cross = (a, b) => [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
    ];
    M3D.dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    M3D.length = (a) => Math.hypot(a[0], a[1], a[2]);
    M3D.normalize = (a) => {
        const l = M3D.length(a) || 1;
        return [a[0] / l, a[1] / l, a[2] / l];
    };

    // ---- mat4 (column-major) ----------------------------------------------------
    M3D.identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

    // out = a * b  (apply b first, then a)
    M3D.multiply = (a, b) => {
        const o = new Float32Array(16);
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) {
                o[c * 4 + r] =
                    a[r] * b[c * 4] +
                    a[4 + r] * b[c * 4 + 1] +
                    a[8 + r] * b[c * 4 + 2] +
                    a[12 + r] * b[c * 4 + 3];
            }
        }
        return o;
    };

    M3D.translation = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

    M3D.scaling = (x, y, z) => new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);

    M3D.rotationY = (t) => {
        const c = Math.cos(t), s = Math.sin(t);
        return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
    };

    M3D.rotationX = (t) => {
        const c = Math.cos(t), s = Math.sin(t);
        return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
    };

    M3D.rotationZ = (t) => {
        const c = Math.cos(t), s = Math.sin(t);
        return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    };

    // Rotation about an arbitrary pivot point: T(p) * R * T(−p). The pose
    // system swings limbs around shoulders/hips with this.
    M3D.rotateAround = (R, px, py, pz) =>
        M3D.multiply(M3D.translation(px, py, pz), M3D.multiply(R, M3D.translation(-px, -py, -pz)));

    // Billboard basis for a fixed camera: the transpose of the view rotation —
    // a quad multiplied by this always faces the camera (health bars).
    M3D.billboard = (view) => new Float32Array([
        view[0], view[4], view[8], 0,
        view[1], view[5], view[9], 0,
        view[2], view[6], view[10], 0,
        0, 0, 0, 1
    ]);

    // Orthographic projection (engine-test's locked demo camera uses this).
    M3D.ortho = (l, r, b, t, n, f) => new Float32Array([
        2 / (r - l), 0, 0, 0,
        0, 2 / (t - b), 0, 0,
        0, 0, -2 / (f - n), 0,
        -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1
    ]);

    // Narrow-FOV perspective — the game camera. Pure ortho made the map read
    // REVERSE-perspective when zoomed out (equal near/far edges, and the eye
    // insists the far one is wider); a gentle real perspective kills the
    // illusion and adds depth without losing the classic look.
    M3D.perspective = (fovY, aspect, near, far) => {
        const f = 1 / Math.tan(fovY / 2);
        return new Float32Array([
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, (far + near) / (near - far), -1,
            0, 0, (2 * far * near) / (near - far), 0
        ]);
    };

    M3D.lookAt = (eye, target, up) => {
        const z = M3D.normalize(M3D.sub(eye, target));
        const x = M3D.normalize(M3D.cross(up, z));
        const y = M3D.cross(z, x);
        return new Float32Array([
            x[0], y[0], z[0], 0,
            x[1], y[1], z[1], 0,
            x[2], y[2], z[2], 0,
            -M3D.dot(x, eye), -M3D.dot(y, eye), -M3D.dot(z, eye), 1
        ]);
    };

    // Classic dimetric RTS camera. Defaults: yaw 45°, pitch atan(1/2) ≈ 26.57°
    // — both are parameters now: middle-drag turns (yaw) and tilts (pitch,
    // clamped by the caller; keep it under 90° or lookAt's up vector degenerates).
    // Returns { view, dir } — dir is the normalized eye→target direction
    // (handy for shading and for placing the eye far along the reverse ray).
    M3D.dimetricView = (targetX, targetZ, dist, yaw = Math.PI / 4, pitch = Math.atan(0.5)) => {
        const dx = Math.cos(pitch) * Math.sin(yaw);
        const dy = Math.sin(pitch);
        const dz = Math.cos(pitch) * Math.cos(yaw);
        const eye = [targetX + dx * dist, dy * dist, targetZ + dz * dist];
        return {
            view: M3D.lookAt(eye, [targetX, 0, targetZ], [0, 1, 0]),
            eye,
            dir: [-dx, -dy, -dz]
        };
    };

    window.M3D = M3D;
})();

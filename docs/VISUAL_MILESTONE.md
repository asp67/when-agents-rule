# Antiquity visual milestone

This branch introduces the first playable slice of the new direction: warm stone, restrained bronze UI accents, and a battlefield lit as a continuous scene. It is an incremental renderer upgrade, not an engine replacement.

## Open the scene

Serve the repository over HTTP and open `http://localhost:8080/?showcase=1`, or choose **Explore the Greek coast** on the local start page. The showcase is an explicitly advanced campaign start: a Greek Iron Age settlement, 11 buildings and 15 units, against one rule-based opponent. It uses the fixed resource seed `greek-coast-01`; no configured model endpoint is used. The advanced starting resources and settlement are specific to this demonstration, not a fair model comparison. Ordinary campaign and arena starts retain their existing rules.

## What changed

- A shared charcoal, limestone and bronze theme covers the start page, model library, live HUD and analyzer. The start title uses a system serif font; no fonts or other assets are downloaded.
- Camera controls belong to the minimap frame during play. In the analyzer they occupy the lower-right edge of the viewport. Overview, focus selected, and zoom are visible; the chevron opens reset, rotation and graphics settings.
- Directional cast shadows use a WebGL 1 colour/depth framebuffer and a nine-sample filter. Only opaque geometry already admitted to the visible scene is submitted as a caster. Remembered/translucent entities do not gain solid shadows.
- Lighting now accounts for nonuniform model scaling, adds cool sky fill against warm sunlight, and preserves bright stone with a mild tone curve. Metallic surfaces receive a restrained highlight.
- World-coordinate water normals animate reflected sky and sunlight. A separate mask follows the same coast sampler as the terrain and foam, joining the coastal and offshore water treatment. The playable square remains land.
- Greek Bronze/Iron buildings gain limestone courses, column capitals, cornices, terracotta roofs and window details. Decorative parts do not enlarge the measured structural footprint. Other civilizations retain their existing compositions in this milestone.
- Summer trees have uneven, branched crowns and the summer terrain uses a quieter olive palette. Resource locations, quantities, ownership and collision rules are unaffected.

## Compare and tune

Open the chevron beside the minimap:

| Setting | Behaviour |
| --- | --- |
| Low | Atmospheric lighting and water; no cast-shadow map. |
| Balanced | 1024 × 1024 shadow map. Default. |
| Cinematic | 2048 × 2048 shadow map. Higher GPU cost. |
| Atmospheric lighting | New light, shadows and water treatment. |
| Simple lighting | Diffuse-light comparison using the same geometry, textures and camera. This is not a complete reproduction of the previous version. |

Graphics quality is saved locally, separately from match/model exports. Shadow targets are released on quality changes, and allocation failure falls back to unshadowed rendering. Cast shadows fade out between camera half-heights 100 and 160; overview shots use the existing contact shading instead of stretching a low-resolution shadow across the whole map.

## Verification and limits

- `node --test tests/*.test.cjs` exercises camera/replay state, water-mask alignment, Greek geometry winding, shadow fallback and target disposal, and visibility-limited shadow submission.
- Both main and shadow shader pairs compile and link with glslangValidator, including the lower-precision fragment variant.
- An offline application startup check, with real procedural texture generation and mocked GPU calls, reaches the playable showcase and verifies moving the camera toolbar between game and analyzer docks.
- Browser visual verification and hardware frame-rate measurements remain pending: the available browser blocks the local preview. The checks above do not establish screenshot quality or browser GPU correctness.

The broader design programme still includes a rendered start-page backdrop, further civilization/unit artwork, richer combat animation, and a more substantial results/setup redesign. Those are not represented as complete by this milestone.

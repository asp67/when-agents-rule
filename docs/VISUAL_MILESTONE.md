# Antiquity visual milestone

This branch introduces the first playable slice of the new direction: warm stone, restrained bronze UI accents, and a battlefield lit as a continuous scene. It is an incremental renderer upgrade, not an engine replacement.

## Open the scene

Serve the repository over HTTP and choose **Explore the civilizations** on the local start page. Pick Greek, Egyptian, Yamato or Persian before launching, or use the civilization picker and **Load civilization** in the showcase. Loading starts a fresh demo on the same coast; it does not convert an existing settlement in place.

Direct links use `http://localhost:8080/?showcase=1&civ=greek` (also `egyptian`, `yamato`, `persian`). Omitting `civ` retains the Greek default. The showcase is an explicitly advanced Iron Age campaign start: 11 buildings and 15 units against one rule-based opponent. The lineup includes workers, three infantry tiers, three ranged tiers, three cavalry tiers and a priest. **Inspect workers** brings the camera to the starting workers at close zoom to check faces and headgear.

All four variants use the fixed resource seed `greek-coast-01` and the same settlement layout; the seed name is retained for comparison with earlier previews. No configured model endpoint is used. Advanced starting resources and the settlement are specific to this demonstration, not a fair model comparison. Ordinary campaign and arena starts retain their existing rules.

## What changed

- A shared charcoal, limestone and bronze theme covers the start page, Arena/campaign configuration, model library, live HUD and analyzer. Configuration and library now include nested controls, expanded model settings, authentication hints, model pickers, prompt editors, empty states and action buttons; team colors and connection-status colors remain distinct. The start title uses a system serif font; no fonts or other assets are downloaded.
- Camera controls belong to the minimap frame during play. In the analyzer they occupy the lower-right edge of the viewport. Overview, focus selected, and zoom are visible; the chevron opens reset, rotation and graphics settings. In campaign mode it also contains a pressed-state hand toggle for left-button map dragging. Spectators always use left-drag panning; campaign right-drag pans while right-click retains commands. Touch pans/zooms in either mode, with campaign taps selecting and stationary holds issuing commands on release. Gestures cancel on blur, screen changes or touch cancellation.
- Directional cast shadows use a WebGL 1 colour/depth framebuffer and a nine-sample filter. Only opaque geometry already admitted to the visible scene is submitted as a caster. Remembered/translucent entities do not gain solid shadows.
- Lighting now accounts for nonuniform model scaling, adds cool sky fill against warm sunlight, and preserves bright stone with a mild tone curve. Metallic surfaces receive a restrained highlight.
- World-coordinate water normals animate reflected sky and sunlight. The former crossing sine waves produced a repeating bright lattice; they have been replaced by two scales of advected gradient noise, softer sunlight reflections, distance-attenuated fine slopes, and much quieter baked water grain. A separate mask follows the same coast sampler as the terrain and foam, joining the coastal and offshore water treatment. The playable square remains land.
- Greek Bronze/Iron buildings gain limestone courses, column capitals, cornices, terracotta roofs and window details. Decorative parts do not enlarge the measured structural footprint. Other civilizations retain their existing compositions in this milestone.
- Units now use miniature-soldier proportions inspired by the supplied thumbnail: exposed faces, sculpted helmets, rounded armor, convex shields, flared capes and distinct weapons. Workers, ranged units, priests and cavalry riders share the revised faces and cultural headgear; infantry armor grows with tier. Civilian Yamato brims and Persian caps now sit just above the eyebrows instead of sharing the military helmet offset. The four civilization identities and per-seat badges are retained. This is procedural artwork, not an imported or exact recreation of the thumbnail.
- Handheld axes, clubs, swords, bows, crossbows, priest staffs and mounted/chariot spears tilt as complete assemblies around their palm grips and follow the corresponding arm animation. Horses have straight symmetric rest legs, connected hip pivots, a larger skull and muzzle, fitted bridles and quieter neck motion.
- Every human unit has a visible mouth and civilian-style facial hair: medium full Greek beards in black, brown or blond; fuller black Persian beards; Yamato moustache/chin beards in dark brown or white; short natural Egyptian chin beards. Color variants derive from the unit handle, remain stable through recomposition/replay and do not use simulation randomness.
- Unit parts are baked and grouped by material, bone, team mask and badge accent; cached GPU geometry is shared across seats within each appearance variant while team colors remain per instance. A Greek champion uses 21–22 batches for 52 visible/shadow parts (circle badge), depending on hair color. More triangles still cost GPU time; hardware performance has not been measured.
- Summer/desert trees use one continuous, asymmetrical, scalloped crown instead of overlapping spheres. Angled forks meet the trunk and terminate inside the canopy. Broad foliage color replaces the speckled highlight texture. Winter retains its conifer silhouette. The summer terrain uses a quieter olive palette. Resource locations, quantities, ownership and collision rules are unaffected.

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

- `node --test tests/*.test.cjs` exercises camera/replay state, water-mask alignment, Greek geometry winding, shadow fallback and target disposal, visibility-limited shadow submission, all unit/civilization tiers, baked geometry under limb poses, per-seat tint isolation, stable hair variants, animated weapon grips, symmetric horse stance and connected tree forks.
- Both main and shadow shader pairs compile and link with glslangValidator, including the lower-precision fragment variant.
- An offline application startup check, with real procedural texture generation and mocked GPU calls, reaches all four civilization showcases, checks that every unit/building belongs to the chosen civilization, verifies the five unit classes, worker close-up and civilization-switch URL, and checks moving the camera toolbar between game and analyzer docks.
- Offline mesh inspection checks unit proportions, weapon angles, facial hair, horse profiles and the tree silhouette using flat material swatches and CPU lighting. It does not render the game shaders or establish final image quality.
- Browser visual verification and hardware frame-rate measurements remain pending: the available browser blocks the local preview. The checks above do not establish screenshot quality or browser GPU correctness.

The broader design programme still includes a rendered start-page backdrop, further civilization architecture and unit refinements, richer combat animation, and a more substantial results redesign. Those are not represented as complete by this milestone.

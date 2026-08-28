# RUBRIC.3D — Interactive Scroll-Driven 3D Explosion Viewer

An interactive 3D presentation of a Rubik's cube built with **Three.js**. Drag to
rotate, scroll to explode the 27 cubelets — and scroll back up to watch them
reassemble along the exact same path. 100% static site, no backend, ready for
**GitHub Pages**.

---

## 1. What's inside

```
rubric-3d-website/
├── index.html                 the page
├── style.css                  all styling (dark, asymmetrical/bento layout)
├── script.js                  the whole 3D application (ES modules, no build step)
├── README.md                  this file
├── .nojekyll                  tells GitHub Pages not to run Jekyll on the folder
├── models/
│   ├── rubric3x3x3_red.glb          normal (assembled) cube — 346 KB
│   └── rubric3x3x3_red_explode.glb  exploded cube (source of target transforms) — 417 KB
└── vendor/three/                     Three.js, vendored locally (no CDN, no npm install needed)
    ├── three.module.min.js
    └── examples/jsm/
        ├── loaders/GLTFLoader.js
        ├── environments/RoomEnvironment.js
        └── controls/OrbitControls.js   (vendored for future use; not required by script.js today)
```

Because Three.js is vendored inside `vendor/`, this project needs **no npm
install, no bundler, and no CDN** — it runs from plain static files.

---

## 2. Publish it with GitHub Pages (beginner-friendly, step by step)

### STEP 1 — Create or log into a GitHub account
Go to [github.com](https://github.com) and sign in, or create a free account if you don't have one yet.

### STEP 2 — Create a new repository
1. Click the **+** icon (top right) → **New repository**.
2. Give it a name, e.g. `rubric-3d-website`.
3. Keep it **Public** (GitHub Pages on the free plan needs a public repo, unless you have GitHub Pro/Team).
4. Click **Create repository**.

### STEP 3 — Upload the complete project
On the new repository page, click **uploading an existing file** (or use
**Add file → Upload files**). Upload **all** of the following, keeping the
folder structure intact:

- `index.html`
- `style.css`
- `script.js`
- `README.md`
- `.nojekyll` *(this file has no name before the dot — some upload dialogs hide it; if it doesn't appear, drag the whole project folder instead, or create it manually in GitHub's web editor with empty content)*
- the whole `models/` folder with both `.glb` files inside
- the whole `vendor/` folder with the Three.js files inside

> Tip: the most reliable way is to drag the **entire `rubric-3d-website` folder
> contents** (not the folder itself, its contents) into the GitHub upload
> drop-zone in one go — GitHub preserves subfolders automatically.

Commit the upload (add a short commit message like "Initial upload" and click
**Commit changes**).

### STEP 4 — Verify the repository structure
Open the repository's **Code** tab and confirm you see, at the root:
`index.html`, `style.css`, `script.js`, `models/`, `vendor/`, `.nojekyll`.
Click into `models/` and confirm both `.glb` files are there and each shows a
file size close to what's listed above (if a `.glb` shows as a tiny few KB, the
upload likely failed — re-upload it).

### STEP 5 — Open Settings → Pages
In your repository, click **Settings** (top menu) → **Pages** (left sidebar).

### STEP 6 — Enable GitHub Pages
Under **Build and deployment → Source**, choose **Deploy from a branch**.
Under **Branch**, select `main` (or `master`, whichever your repo uses) and
folder `/ (root)`.

### STEP 7 — Save
Click **Save**.

### STEP 8 — Wait for deployment
GitHub Pages needs about 30 seconds to a couple of minutes to build. Refresh
the **Settings → Pages** screen until it shows *"Your site is live at…"*.

### STEP 9 — Open the published website
Click the URL shown (it looks like
`https://<your-username>.github.io/rubric-3d-website/`). Your interactive 3D
viewer should load.

---

## 3. Troubleshooting

**Model doesn't load / spinner never finishes / console shows a 404 for `.glb`**
- Open the browser DevTools console (F12) and check the exact failing URL.
- Confirm `models/rubric3x3x3_red.glb` and `models/rubric3x3x3_red_explode.glb`
  exist at that exact path in the repo (case-sensitive on GitHub Pages!).
- Re-upload the file if GitHub shows it as 0 bytes or a few KB — large binary
  files sometimes fail silently through the web upload UI; if that keeps
  happening, install [GitHub Desktop](https://desktop.github.com/) and push
  the folder via git instead of the browser uploader.

**Everything 404s / CSS and JS don't apply**
- Almost always a wrong Pages **source** setting (Step 6) or the files were
  uploaded into a subfolder by mistake. `index.html` must sit at the
  **repository root** (or at the root of the branch/folder you selected in
  Settings → Pages).

**JavaScript errors in the console**
- Make sure the whole `vendor/` folder was uploaded — `script.js` imports
  `three`, `GLTFLoader.js`, and `RoomEnvironment.js` from there via the
  `<script type="importmap">` block in `index.html`. If any of those 404, the
  module import fails and nothing renders.
- This project uses ES module `import`/`export` syntax; it must be served
  over `http://` or `https://` (which GitHub Pages does automatically) — it
  will **not** work if you double-click `index.html` and open it as a
  `file://` URL locally, because browsers block module imports and
  cross-origin GLB fetches from the local filesystem. To test locally, run a
  tiny local server, e.g. `python3 -m http.server 8000` inside the project
  folder, then open `http://localhost:8000`.

**GitHub Pages isn't updating after a new upload**
- Give it a minute or two, then hard-refresh (Ctrl/Cmd+Shift+R) to bypass the
  browser cache. GitHub's CDN cache can also take a short while to invalidate.

**Large GLB files / slow loading on mobile**
- Both provided files are small (346 KB and 417 KB — see §5), so this
  shouldn't be an issue here. If you swap in your own, larger models later,
  consider compressing meshes with Draco or `gltf-transform` and/or serving
  them from `models/` with basic gzip (GitHub Pages already gzips
  automatically).

**Model appears but with no rotation / scroll doesn't explode it**
- Make sure you're scrolling the actual page (not inside an iframe/preview
  pane that captures scroll separately) and that JavaScript isn't blocked.

---

## 4. Controls

| Input | Action |
|---|---|
| Desktop: left-click drag on the model | Rotate (orbit) |
| Desktop: normal mouse-wheel / trackpad scroll | Scrolls the page → drives the explosion timeline |
| Desktop: Ctrl/⌘/Shift + scroll, or trackpad pinch | Zoom |
| Mobile: single-finger drag, mostly horizontal | Rotate |
| Mobile: single-finger drag, mostly vertical | Scrolls the page → drives the explosion timeline |
| Mobile: two-finger pinch | Zoom |
| **RESET** button | Resets rotation, zoom, camera, explosion progress, and scroll position back to the initial state |

---

## 5. Technical report

**1–2. GLB inspection & structure.** Both files were parsed with `pygltflib`.
Each contains **27 nodes / 27 meshes / 1 shared material** (`Mat_Glossy_Red`,
base color ≈ RGB(0.62, 0.03, 0.03)), one node per cubelet, named
`Cubelet_<x>_<y>_<z>` (x,y,z ∈ {0,1,2}) — identical names, identical mesh
geometry, and identical starting transforms in both files. The **normal**
file has no animation data. The **exploded** file contains **27 baked
animation clips** (one per cubelet, ~205 keyframes each, ~8.5s duration) whose
translation keyframes move every cubelet from its assembled position to
`position × 2.6` (a pure radial scale from the cube's center) — the center
cubelet stays put.

**3–4. Object-by-object interpolation.** Fully possible — all 27 objects
matched 1:1 by name. **All 27 were successfully matched.**

**5. How the transition was implemented.** `ModelManager` loads the normal
GLB to display, and loads the exploded GLB solely to read its animation clips:
for every track named `"<CubeletName>.position"` it reads the **last
keyframe's value** and stores it as that cubelet's exploded target position.
`AnimationManager.setProgress(t)` then does a true per-object
`Vector3.lerpVectors(basePos, explodedPos, ease(t))` every frame — a real
transform interpolation, not a model swap or crossfade.

**6. Reverse animation.** Because position is a pure function of `t`
(`lerp(base, exploded, t)`), decreasing `t` retraces the exact same line
segment back toward the base position — there is no separate "reverse" code
path.

**7. Returning to the same scroll position.** `ScrollController` never stores
progress as free-running state; every frame it recomputes the target progress
directly from `window.scrollY` relative to the pinned section's geometry, then
damps toward it. Since it's a pure function of scroll position, returning to
the same `scrollY` always reproduces the same progress and therefore the same
pose — no drift accumulates.

**8. Scroll speed & feel.** The *target* progress jumps immediately with
scroll position, but the value actually applied to the model is
frame-rate-independent exponentially damped toward that target
(`Utils.damp`, λ≈9). Fast scrolling reaches the target sooner and looks
snappier; slow scrolling glides. Motion always settles to exactly the target
value and never continues after scrolling stops.

**9. Mouse drag rotation.** A pointer-events-based custom spherical
`CameraController` (θ azimuth / φ polar / radius) is updated by drag deltas
and damped toward the target each frame — free, unclamped horizontal
rotation, clamped vertical rotation to avoid flipping through the poles.

**10. Mobile touch controls.** Gesture direction is detected once movement
passes a small pixel threshold: a **horizontal-dominant** single-finger drag
is captured and rotates the model (page scroll is prevented for that
gesture only); a **vertical-dominant** drag is left completely alone (no
`preventDefault`) so the browser's native scroll fires normally and drives
the explosion timeline. Two-finger touches always pinch-zoom. This is the
documented resolution to the inherent conflict between "vertical drag
rotates" and "vertical scroll explodes" (see Limitations below).

**11. Metallic lighting.** PBR rendering via `ACESFilmicToneMapping`,
`SRGBColorSpace` output, a procedurally generated PMREM environment
(`RoomEnvironment`, no external HDRI file needed) for realistic reflections,
plus a 3-light rig (warm key light with soft shadows, red rim light, cool
fill light). Material `metalness`/`roughness`/`envMapIntensity` are boosted
slightly on load while keeping the GLB's original base color intact, so the
cube reads as glossy metal rather than matte plastic.

**12. Final GLB file sizes.**
- `rubric3x3x3_red.glb` — **345.8 KB**
- `rubric3x3x3_red_explode.glb` — **416.4 KB**

Both are small; no optimization was necessary for either GitHub or mobile
loading.

**13. Final folder structure.** See §1 above.

**14. Deployment instructions.** See §2 above.

**15. Limitations / things to know.**
- The inherent contradiction in "vertical drag = rotate" vs "vertical scroll
  = explode" on mobile is resolved by gesture-direction detection (see #10).
  A deliberate design trade-off, not a bug: vertical touch gestures always
  scroll first, to guarantee the page never feels "stuck."
- The exploded GLB's baked animation is only used as a **data source** for
  target positions (its own scene/geometry is loaded then disposed); only the
  normal GLB's meshes are ever displayed, per the requirement to always show
  smooth object interpolation rather than swapping models.
- `OrbitControls.js` is vendored under `vendor/` for future extension (e.g. a
  debug/free-fly camera mode) but is not imported by the current
  `script.js`, which uses a lighter custom orbit camera tuned specifically
  for this scroll-gated interaction model.
- The architecture (`SceneManager`, `ModelManager`, `AnimationManager`,
  `CameraController`, etc.) intentionally keeps each cubelet's `Object3D`
  reference and both transforms in a single `Map` (`ModelManager.parts`),
  making it straightforward to add future features — per-part click/hover
  selection, labels, isolate/hide, camera focus-on-object, or additional
  animation stages beyond the current normal↔exploded pair — without
  restructuring existing code.

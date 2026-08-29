/* ==========================================================================
   RUBRIC.3D — Interactive Scroll-Driven 3D Explosion Viewer
   ----------------------------------------------------------------------
   Architecture (modular, extensible):
     LoadingManager        shared loading UI + progress aggregation
     SceneManager           renderer / scene / render loop / resize
     LightingManager         lights + procedural PBR environment
     ModelManager             loads GLB(s), matches nodes, records A/B transforms
     CameraController          spherical orbit camera, zoom, framing, reset
     AnimationManager           progress -> per-cubelet transform interpolation
     ScrollController            per-section scroll -> deterministic progress
     InteractionController        drag rotate / pinch zoom / gesture gating
     PanelUIManager                per-panel HUD, reset button, progress bar
     ResponsiveManager             resize / orientation / DPR handling
     ThemeManager                  shared dark/light site theme toggle
     GlobalChrome                  shared menu, reveals, error overlay
     Experience                    one full 3D showcase (scene+model+scroll)
     App                           creates the Experiences, shared chrome
   ========================================================================== */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ==========================================================================
   Utils
   ========================================================================== */
const Utils = {
  clamp: (v, min, max) => Math.max(min, Math.min(max, v)),
  lerp: (a, b, t) => a + (b - a) * t,
  // damped interpolation independent of frame rate
  damp: (current, target, lambda, dt) => Utils.lerp(current, target, 1 - Math.exp(-lambda * dt)),
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  isTouchDevice: () => ('ontouchstart' in window) || navigator.maxTouchPoints > 0,
};

// Each entry describes one independent scroll-driven 3D showcase.
// mode:'dual'   — a normal.glb + a separately-exported exploded.glb, matched
//                 by node name (the exploded file's baked keyframes are only
//                 ever read for their final position, never displayed).
// mode:'single' — one glb whose pieces each carry their own animation clip,
//                 keyframed from the assembled pose to the exploded pose;
//                 the same file is displayed AND mined for explode targets.
const EXPERIENCE_CONFIGS = [
  {
    sectionId: 'ghost-showcase',
    rootName: 'GhostRoot',
    mode: 'single',
    paths: {
      single: './models/ghost_cube_steel_blue.glb',
    },
    loadingKeys: { single: 'ghost' },
  },
  {
    sectionId: 'rubik-showcase',
    rootName: 'RubikRoot',
    mode: 'dual',
    paths: {
      normal: './models/rubric3x3x3_red.glb',
      exploded: './models/rubric3x3x3_red_explode.glb',
    },
    loadingKeys: { normal: 'rubik-normal', exploded: 'rubik-exploded' },
  },
];

/* ==========================================================================
   LoadingManager
   Aggregates progress across an arbitrary set of named resources (spanning
   every Experience on the page) into one shared loading bar.
   ========================================================================== */
class LoadingManager {
  constructor(keys) {
    this.overlay = document.getElementById('loading-overlay');
    this.barFill = document.getElementById('loading-bar-fill');
    this.percentLabel = document.getElementById('loading-percent');
    this.progress = {};
    keys.forEach((key) => {
      this.progress[key] = 0;
    });
  }

  update(key, ratio) {
    this.progress[key] = Utils.clamp(ratio, 0, 1);
    const values = Object.values(this.progress);
    const total = values.reduce((sum, v) => sum + v, 0) / values.length;
    const pct = Math.round(total * 100);
    this.barFill.style.width = `${pct}%`;
    this.percentLabel.textContent = `${pct}%`;
  }

  complete() {
    for (const key of Object.keys(this.progress)) this.update(key, 1);
    requestAnimationFrame(() => {
      this.overlay.classList.add('hidden');
    });
  }
}

/* ==========================================================================
   SceneManager
   ========================================================================== */
class SceneManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    // Transparent clear color: the canvas is drawn wider than the viewer
    // panel (see --viewer-bleed in CSS) so the cube can visually spill past
    // the panel's left edge onto the content column. Only the cube/shadow
    // pixels should be opaque there — everywhere else must stay see-through
    // to the panel background (inside the panel) or the page (past its edge).
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this._renderCallbacks = [];
    this._resizeObserver = null;
    this._maxPixelRatio = 2;
  }

  addRenderCallback(fn) {
    this._renderCallbacks.push(fn);
  }

  setSize(width, height) {
    const dpr = Math.min(window.devicePixelRatio || 1, this._maxPixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  start() {
    let lastTime = performance.now();
    const loop = (now) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      for (const cb of this._renderCallbacks) cb(dt, now / 1000);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

/* ==========================================================================
   LightingManager
   ========================================================================== */
class LightingManager {
  constructor(sceneManager) {
    this.sceneManager = sceneManager;
    this.envEnabled = true;
    this._buildEnvironment();
    this._buildLights();
  }

  _buildEnvironment() {
    const renderer = this.sceneManager.renderer;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    const envScene = new RoomEnvironment();
    this.envTexture = this.pmrem.fromScene(envScene, 0.04).texture;
    this.sceneManager.scene.environment = this.envTexture;
    envScene.dispose?.();
  }

  _buildLights() {
    const scene = this.sceneManager.scene;

    this.ambient = new THREE.AmbientLight(0xffffff, 0.35);
    scene.add(this.ambient);

    this.keyLight = new THREE.DirectionalLight(0xfff2ea, 2.4);
    this.keyLight.position.set(4.2, 5.5, 4.5);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 20;
    this.keyLight.shadow.bias = -0.0025;
    scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight(0xff5a4a, 1.6);
    this.rimLight.position.set(-5, 2.5, -4);
    scene.add(this.rimLight);

    this.fillLight = new THREE.DirectionalLight(0xbfd9ff, 0.5);
    this.fillLight.position.set(-3, -2, 3);
    scene.add(this.fillLight);
  }

  toggleEnvironment() {
    this.envEnabled = !this.envEnabled;
    this.sceneManager.scene.environment = this.envEnabled ? this.envTexture : null;
    this.ambient.intensity = this.envEnabled ? 0.35 : 0.9;
    return this.envEnabled;
  }

}

/* ==========================================================================
   ModelManager
   Two loading modes (see EXPERIENCE_CONFIGS above):
     'dual'   — loads a normal GLB (displayed) and a separately-exported
                exploded GLB, matching cubelets by node NAME (identical
                across both files) and reading only the exploded file's
                baked keyframe animation, never its scene.
     'single' — loads one GLB whose scene IS the displayed model, and whose
                own animation clips (one per piece, assembled -> exploded)
                are mined for each piece's exploded target.
   Either way, the result is the same: a `parts` registry of
   { object3D, basePos, explodedPos } ready for AnimationManager to
   interpolate between.
   ========================================================================== */
class ModelManager {
  constructor(sceneManager, loadingManager, config) {
    this.sceneManager = sceneManager;
    this.loadingManager = loadingManager;
    this.config = config;
    this.loader = new GLTFLoader();
    this.root = new THREE.Group();
    this.root.name = config.rootName || 'ModelRoot';
    this.sceneManager.scene.add(this.root);

    // registry: name -> { object3D, basePos, explodedPos, baseQuat, index }
    this.parts = new Map();
    this.boundingBox = new THREE.Box3();
    this.boundingSphere = new THREE.Sphere();
  }

  async loadAll() {
    if (this.config.mode === 'dual') {
      const [normalGltf, explodedGltf] = await Promise.all([
        this._loadOne(this.config.paths.normal, this.config.loadingKeys.normal),
        this._loadOne(this.config.paths.exploded, this.config.loadingKeys.exploded),
      ]);
      this._buildDisplayModel(normalGltf);
      this._extractExplodedTargets(explodedGltf);
      this._disposeGltf(explodedGltf); // only needed its animation data
    } else {
      // 'single': the displayed scene and the animation data come from the
      // same already-loaded gltf, so it's never disposed.
      const gltf = await this._loadOne(this.config.paths.single, this.config.loadingKeys.single);
      this._buildDisplayModel(gltf);
      this._extractExplodedTargets(gltf);
    }

    this._computeBounds();
    return { partCount: this.parts.size };
  }

  _loadOne(path, key) {
    return new Promise((resolve, reject) => {
      this.loader.load(
        path,
        (gltf) => {
          this.loadingManager.update(key, 1);
          resolve(gltf);
        },
        (evt) => {
          if (evt.total) this.loadingManager.update(key, evt.loaded / evt.total);
        },
        (err) => reject(new Error(`โหลด ${path} ไม่สำเร็จ: ${err?.message || err}`))
      );
    });
  }

  _buildDisplayModel(gltf) {
    const scene = gltf.scene;

    scene.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        if (obj.material) {
          // Enhance toward a glossy metallic look while preserving the
          // original base color / texture data from the GLB material.
          obj.material.metalness = 0.85;
          obj.material.roughness = Utils.clamp(obj.material.roughness ?? 0.3, 0.15, 0.35);
          obj.material.envMapIntensity = 1.35;
          obj.material.needsUpdate = true;
        }
      }
    });

    this.root.add(scene);

    // Flat hierarchy: every piece is a direct child node (e.g. "Cubelet_x_y_z"
    // or "GhostPiece_x_y_z"), matched to its exploded target purely by name.
    scene.children.forEach((child, index) => {
      if (!child.name) return;
      this.parts.set(child.name, {
        object3D: child,
        index,
        basePos: child.position.clone(),
        baseQuat: child.quaternion.clone(),
        explodedPos: child.position.clone(), // fallback until overwritten below
      });
    });
  }

  _extractExplodedTargets(explodedGltf) {
    const clips = explodedGltf.animations || [];
    let matched = 0;

    for (const clip of clips) {
      for (const track of clip.tracks) {
        // track.name format: "<NodeName>.position"
        const dotIndex = track.name.lastIndexOf('.');
        const nodeName = track.name.slice(0, dotIndex);
        const property = track.name.slice(dotIndex + 1);
        if (property !== 'position') continue;

        const part = this.parts.get(nodeName);
        if (!part) continue;

        const values = track.values; // flattened [x0,y0,z0, x1,y1,z1, ...]
        const lastIdx = values.length - 3;
        part.explodedPos = new THREE.Vector3(values[lastIdx], values[lastIdx + 1], values[lastIdx + 2]);
        matched += 1;
      }
    }

    this.matchedCount = matched;
    this.usedFallback = matched < this.parts.size;
  }

  _disposeGltf(gltf) {
    gltf.scene.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material?.dispose();
      }
    });
  }

  _computeBounds() {
    this.boundingBox.setFromObject(this.root);
    this.boundingBox.getBoundingSphere(this.boundingSphere);

    // Kept separate from the assembled sphere (rather than merged into one
    // "covers everything" sphere) so CameraController can frame the resting
    // cube tight — reads bigger — while still zooming out enough to cover
    // the wider exploded spread as scroll progress increases.
    this.explodedBoundingSphere = this._computeExplodedBoundingSphere();
  }

  /** Measures the scene's bounding sphere with every cubelet moved to its
   *  exploded position, then restores the assembled layout. */
  _computeExplodedBoundingSphere() {
    for (const part of this.parts.values()) {
      part.object3D.position.copy(part.explodedPos);
    }
    this.root.updateMatrixWorld(true);

    const explodedBox = new THREE.Box3().setFromObject(this.root);
    const explodedSphere = new THREE.Sphere();
    explodedBox.getBoundingSphere(explodedSphere);

    for (const part of this.parts.values()) {
      part.object3D.position.copy(part.basePos);
    }
    this.root.updateMatrixWorld(true);

    return explodedSphere;
  }

  getParts() {
    return this.parts;
  }
}

/* ==========================================================================
   CameraController
   Custom spherical-orbit camera: damped rotation, clamped zoom, auto framing.
   Kept independent from scroll/explosion so future presets & focus-on-object
   features can be added without touching other modules.
   ========================================================================== */
class CameraController {
  constructor(sceneManager) {
    this.camera = sceneManager.camera;
    this.target = new THREE.Vector3(0, 0, 0);

    this.theta = Math.PI * 0.28;   // azimuth
    this.phi = Math.PI * 0.42;     // polar
    this.radius = 10;

    this.targetTheta = this.theta;
    this.targetPhi = this.phi;
    this.targetRadius = this.radius;

    this.minPhi = 0.18;
    this.maxPhi = Math.PI - 0.18;
    this.minRadius = 3;
    this.maxRadius = 22;

    // Spring-damper state for theta/phi: v = (v + force*k) * damping; pos += v
    // Gives the orbit real "weight" instead of a flat exponential ease.
    this.velTheta = 0;
    this.velPhi = 0;
    this.springK = 0.12;
    this.springDamping = 0.8;

    // Residual fling velocity applied after the user releases a fast drag
    // (momentum/inertia), independently decaying until it settles to zero.
    this.flingTheta = 0;
    this.flingPhi = 0;
    this.flingDamping = 0.94;

    this.zoomDamping = 8;

    this.autoRotate = false;
    this.autoRotateSpeed = 0.12;

    // Once the user manually zooms (pinch or ctrl/shift+wheel), the
    // scroll-linked auto zoom (see setExplodeRadius) stops touching
    // targetRadius, so it doesn't fight their input; reset() re-enables it.
    this._userZoomed = false;

    this._defaults = null;
  }

  /** Vertical FOV alone under-shoots the needed distance whenever the
   *  horizontal FOV is the tighter constraint (aspect < 1, as the viewer
   *  panel usually is) — fits to whichever of the two is more restrictive. */
  _fitDistance(sphereRadius, margin) {
    const vFovRad = (this.camera.fov * Math.PI) / 180;
    const aspect = this.camera.aspect || 1;
    const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);
    const limitingFovRad = Math.min(vFovRad, hFovRad);
    return (sphereRadius * margin) / Math.sin(limitingFovRad / 2);
  }

  /** Frames the camera using two spheres: the assembled cube (tight margin,
   *  so the resting view reads large) and the fully-exploded cube (a
   *  generous margin, so no cubelet clips at the widest spread). The actual
   *  distance is interpolated between the two every frame by
   *  setExplodeRadius() as scroll progress changes. */
  frameToRange(assembledSphere, explodedSphere) {
    // remembered so reframe() can redo this after a resize/orientation change
    this._framedAssembledSphere = assembledSphere;
    this._framedExplodedSphere = explodedSphere;

    this._assembledDist = this._fitDistance(assembledSphere.radius, 1.1);
    this._explodedDist = this._fitDistance(explodedSphere.radius, 1.4);

    this.minRadius = Math.max(2.5, assembledSphere.radius * 1.15);
    this.maxRadius = explodedSphere.radius * 6;
    this.radius = this.targetRadius = Utils.clamp(this._assembledDist, 4, this.maxRadius);
    this.target.copy(assembledSphere.center);

    this._defaults = {
      theta: this.theta,
      phi: this.phi,
      radius: this.radius,
      target: this.target.clone(),
    };
    this._updatePosition(true);
  }

  /** Re-applies the last framing at the camera's current aspect ratio.
   *  A sphere framed for one aspect can start clipping once the viewport's
   *  proportions change (window resize, or an iPad/phone rotating between
   *  portrait and landscape), since the required distance depends on it. */
  reframe() {
    if (this._framedAssembledSphere && this._framedExplodedSphere) {
      this.frameToRange(this._framedAssembledSphere, this._framedExplodedSphere);
    }
  }

  /** Ties the camera's zoom to the current explode progress, so the
   *  resting cube can be framed tight (large) while the fully-exploded
   *  state still gets the extra distance it needs to avoid clipping.
   *  No-ops once the user has taken manual control of zoom. */
  setExplodeRadius(progress) {
    if (this._userZoomed || this._assembledDist == null || this._explodedDist == null) return;
    const eased = Utils.easeInOutCubic(progress);
    this.targetRadius = Utils.lerp(this._assembledDist, this._explodedDist, eased);
  }

  markUserZoomed() {
    this._userZoomed = true;
  }

  rotateBy(deltaThetaPx, deltaPhiPx, sensitivity = 0.006) {
    this.targetTheta -= deltaThetaPx * sensitivity;
    this.targetPhi = Utils.clamp(this.targetPhi - deltaPhiPx * sensitivity, this.minPhi, this.maxPhi);
  }

  /** Called on drag release with the final pointer velocity (px/event) to
   *  keep the orbit spinning briefly, decaying naturally (flick-to-spin). */
  applyFling(deltaThetaPx, deltaPhiPx, sensitivity = 0.006) {
    this.flingTheta = -deltaThetaPx * sensitivity;
    this.flingPhi = -deltaPhiPx * sensitivity;
  }

  /** Called when a new drag starts, so a stale fling doesn't fight the grab. */
  cancelFling() {
    this.flingTheta = 0;
    this.flingPhi = 0;
  }

  zoomBy(factor) {
    this.targetRadius = Utils.clamp(this.targetRadius * factor, this.minRadius, this.maxRadius);
    this.markUserZoomed();
  }

  setAutoRotate(enabled) {
    this.autoRotate = enabled;
  }

  reset() {
    if (!this._defaults) return;
    this.targetTheta = this._defaults.theta;
    this.targetPhi = this._defaults.phi;
    this.targetRadius = this._defaults.radius;
    this.velTheta = 0;
    this.velPhi = 0;
    this.cancelFling();
    this._userZoomed = false; // resume scroll-linked auto zoom after a reset
  }

  update(dt) {
    if (this.autoRotate) this.targetTheta += this.autoRotateSpeed * dt;

    // Momentum: fling keeps nudging the target forward, decaying to zero.
    if (Math.abs(this.flingTheta) > 0.0001 || Math.abs(this.flingPhi) > 0.0001) {
      this.targetTheta += this.flingTheta;
      this.targetPhi = Utils.clamp(this.targetPhi + this.flingPhi, this.minPhi, this.maxPhi);
      this.flingTheta *= this.flingDamping;
      this.flingPhi *= this.flingDamping;
    } else {
      this.flingTheta = 0;
      this.flingPhi = 0;
    }

    // Spring-damper follow: gives the orbit real weight/inertia rather than
    // a flat ease, per v = (v + force*k) * damping; pos += v.
    const forceTheta = (this.targetTheta - this.theta) * this.springK;
    this.velTheta = (this.velTheta + forceTheta) * this.springDamping;
    this.theta += this.velTheta;

    const forcePhi = (this.targetPhi - this.phi) * this.springK;
    this.velPhi = (this.velPhi + forcePhi) * this.springDamping;
    this.phi = Utils.clamp(this.phi + this.velPhi, this.minPhi, this.maxPhi);

    this.radius = Utils.damp(this.radius, this.targetRadius, this.zoomDamping, dt);
    this._updatePosition(false);
  }

  _updatePosition() {
    const sinPhiRadius = Math.sin(this.phi) * this.radius;
    const x = sinPhiRadius * Math.sin(this.theta) + this.target.x;
    const y = Math.cos(this.phi) * this.radius + this.target.y;
    const z = sinPhiRadius * Math.cos(this.theta) + this.target.z;
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target);
  }
}

/* ==========================================================================
   AnimationManager
   Maps a single normalized progress value [0,1] to every cubelet's
   interpolated position between its recorded normal and exploded transform.
   Pure function of `progress` -> fully reversible, no drift, no hidden state.
   ========================================================================== */
class AnimationManager {
  constructor(modelManager) {
    this.modelManager = modelManager;
    this.progress = 0;
  }

  setProgress(progress) {
    this.progress = Utils.clamp(progress, 0, 1);
    const eased = Utils.easeInOutCubic(this.progress);

    for (const part of this.modelManager.getParts().values()) {
      part.object3D.position.lerpVectors(part.basePos, part.explodedPos, eased);
    }
  }

  resetAnimation() {
    this.setProgress(0);
  }
}

/* ==========================================================================
   ScrollController
   Converts scroll position into a deterministic target progress value,
   scoped to one .showcase section: 0 while that section's top edge is at
   (or below) the viewport top, 1 once its bottom edge has been scrolled up
   to the viewport bottom — exactly the range its sticky viewer-panel stays
   pinned for. The caller smooths toward this target. Progress is always
   re-derived from the section's live position -> no drift, exact restoration.
   ========================================================================== */
class ScrollController {
  constructor(sectionEl) {
    this.sectionEl = sectionEl;
    this.currentProgress = 0;
    this.targetProgress = 0;
    this.smoothing = 9; // higher = snappier response to scroll

    this._onScroll = this._onScroll.bind(this);
    window.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', this._onScroll);
    this._onScroll();
  }

  _onScroll() {
    const rect = this.sectionEl.getBoundingClientRect();
    const scrollableRange = Math.max(this.sectionEl.offsetHeight - window.innerHeight, 1);
    const scrolledIntoSection = -rect.top;
    this.targetProgress = Utils.clamp(scrolledIntoSection / scrollableRange, 0, 1);
  }

  update(dt) {
    this.currentProgress = Utils.damp(this.currentProgress, this.targetProgress, this.smoothing, dt);
    if (Math.abs(this.currentProgress - this.targetProgress) < 0.0004) {
      this.currentProgress = this.targetProgress; // settle exactly, no lingering drift
    }
    return this.currentProgress;
  }

  scrollToStart() {
    const top = window.scrollY + this.sectionEl.getBoundingClientRect().top;
    window.scrollTo({ top, behavior: 'smooth' });
  }
}

/* ==========================================================================
   InteractionController
   The 3D panel is a fixed side panel (not part of the scrollable flow), so
   rotation and page scroll never compete for the same gesture: dragging on
   the canvas always rotates, at any time, regardless of scroll position.
   Page scroll (which drives the explode/reassemble timeline) happens
   normally anywhere outside the panel. Two-finger pinch zooms.
   ========================================================================== */
class InteractionController {
  constructor(canvas, cameraController) {
    this.canvas = canvas;
    this.cameraController = cameraController;

    this.isDragging = false; // exposed for tactile "grab" scale feedback
    this._lastX = 0;
    this._lastY = 0;
    this._lastDx = 0; // smoothed latest delta, used as release velocity for fling
    this._lastDy = 0;

    this._pinchStartDist = 0;
    this._pinchStartRadius = 0;

    this._bind();
  }

  _bind() {
    // Pointer drag (mouse + touch alike) — always rotates, any time.
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && this._activeTouches() >= 2) return; // let pinch handle it
      this.isDragging = true;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      this._lastDx = 0;
      this._lastDy = 0;
      this.cameraController.cancelFling();
      this.canvas.setPointerCapture(e.pointerId);
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this._lastX;
      const dy = e.clientY - this._lastY;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      // Light smoothing so a single jittery final event doesn't dominate the fling.
      this._lastDx = Utils.lerp(this._lastDx, dx, 0.5);
      this._lastDy = Utils.lerp(this._lastDy, dy, 0.5);
      this.cameraController.rotateBy(dx, dy);
    });
    const endDrag = () => {
      if (!this.isDragging) return;
      this.isDragging = false;
      this.cameraController.applyFling(this._lastDx, this._lastDy);
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    // Trackpad pinch (wheel + ctrlKey) / ctrl|shift+wheel = zoom the model.
    // The panel is fixed, so normal wheel scroll here still bubbles to move
    // the page (and therefore the explode timeline) — only modified wheel
    // events are captured for zoom.
    this.canvas.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        e.preventDefault();
        const factor = 1 + e.deltaY * 0.0025;
        this.cameraController.zoomBy(factor);
      }
    }, { passive: false });

    // Touch: always rotate with one finger, pinch-zoom with two.
    this.canvas.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: true });
    this.canvas.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
    this.canvas.addEventListener('touchend', () => this._onTouchEnd());
    this.canvas.addEventListener('touchcancel', () => this._onTouchEnd());
  }

  _activeTouches() {
    return this._touchCount || 0;
  }

  _onTouchStart(e) {
    this._touchCount = e.touches.length;
    if (e.touches.length === 2) {
      this.isDragging = false;
      this._pinchStartDist = this._touchDistance(e.touches);
      this._pinchStartRadius = this.cameraController.targetRadius;
    }
  }

  _onTouchMove(e) {
    this._touchCount = e.touches.length;
    if (e.touches.length === 2) {
      e.preventDefault();
      const dist = this._touchDistance(e.touches);
      const factor = this._pinchStartDist / Math.max(dist, 1);
      this.cameraController.targetRadius = Utils.clamp(
        this._pinchStartRadius * factor,
        this.cameraController.minRadius,
        this.cameraController.maxRadius
      );
      this.cameraController.markUserZoomed();
    }
    // single-finger drag is already handled via pointermove above; the
    // panel is fixed so it never needs to release the gesture to the page.
  }

  _onTouchEnd() {
    this._touchCount = 0;
  }

  _touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }
}

/* ==========================================================================
   ThemeManager
   Toggles the site's tone between the default dark theme and a white/red
   light theme. The <html data-theme="light"> attribute (applied instantly
   by an inline script in <head> to avoid flash-of-wrong-theme) drives all
   the CSS custom properties; this class just wires up the button and keeps
   the meta theme-color in sync. The canvas itself stays transparent in both
   themes (see SceneManager), so it needs no per-theme clear color.
   ========================================================================== */
class ThemeManager {
  constructor() {
    this.storageKey = 'rubric3d-theme';
    this.metaColors = { dark: '#0a0a0c', light: '#ffffff' };

    this.btn = document.getElementById('theme-toggle-btn');
    this.icon = this.btn?.querySelector('.theme-toggle-icon');
    this.metaThemeColor = document.querySelector('meta[name="theme-color"]');

    this._render(this._currentTheme());
    this.btn?.addEventListener('click', () => this._toggle());
  }

  _currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  _toggle() {
    const next = this._currentTheme() === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(this.storageKey, next);
    } catch (e) {}
    this._render(next);
  }

  _render(theme) {
    this.btn?.setAttribute('aria-pressed', String(theme === 'light'));
    if (this.icon) this.icon.textContent = theme === 'light' ? '◑' : '◐';
    if (this.metaThemeColor) this.metaThemeColor.setAttribute('content', this.metaColors[theme]);
  }
}

/* ==========================================================================
   PanelUIManager
   HUD chrome for ONE viewer panel: progress bar, instructions fade, and its
   reset/env/fullscreen/autorotate/tools-tray buttons. Scoped to that panel's
   own DOM subtree (via class selectors, since a page can host several
   panels at once) rather than page-wide IDs.
   ========================================================================== */
class PanelUIManager {
  constructor(panelRoot, { cameraController, lightingManager }) {
    this.panelRoot = panelRoot;
    this.cameraController = cameraController;
    this.lightingManager = lightingManager;

    this.progressFill = panelRoot.querySelector('.progress-fill');
    this.progressDot = panelRoot.querySelector('.progress-dot');
    this.progressPercent = panelRoot.querySelector('.progress-percent');
    this.instructions = panelRoot.querySelector('.instructions');
    this.progressWrap = panelRoot.querySelector('.progress-wrap');

    this._bindButtons();
    this._instructionsFaded = false;
  }

  _bindButtons() {
    this.panelRoot.querySelector('.reset-btn').addEventListener('click', () => this.onResetRequested?.());

    const autoBtn = this.panelRoot.querySelector('.autorotate-btn');
    autoBtn.addEventListener('click', () => {
      const enabled = !this.cameraController.autoRotate;
      this.cameraController.setAutoRotate(enabled);
      autoBtn.setAttribute('aria-pressed', String(enabled));
    });

    const envBtn = this.panelRoot.querySelector('.env-btn');
    envBtn.addEventListener('click', () => {
      const enabled = this.lightingManager.toggleEnvironment();
      envBtn.setAttribute('aria-pressed', String(enabled));
    });

    const fsBtn = this.panelRoot.querySelector('.fullscreen-btn');
    fsBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
    });

    const toolsToggle = this.panelRoot.querySelector('.tools-toggle');
    const toolsTray = this.panelRoot.querySelector('.tools-tray');
    toolsToggle.addEventListener('click', () => {
      const open = !toolsTray.classList.contains('open');
      toolsTray.classList.toggle('open', open);
      toolsToggle.setAttribute('aria-expanded', String(open));
    });
  }

  updateProgressUI(progress) {
    const pct = Math.round(progress * 100);
    this.progressFill.style.width = `${pct}%`;
    this.progressDot.style.left = `${pct}%`;
    this.progressPercent.textContent = `${pct}%`;

    if (progress > 0.02 && !this._instructionsFaded) {
      this._instructionsFaded = true;
      this.instructions.classList.add('faded');
    } else if (progress <= 0.02 && this._instructionsFaded) {
      this._instructionsFaded = false;
      this.instructions.classList.remove('faded');
    }
  }
}

/* ==========================================================================
   GlobalChrome
   Page-wide UI that exists exactly once regardless of how many Experiences
   are on the page: the full-screen menu, scroll-reveal animations, and the
   shared error overlay.
   ========================================================================== */
class GlobalChrome {
  constructor() {
    this._renderMath();
    this._bindMenu();
    this._bindReveals();
    document.getElementById('error-retry-btn').addEventListener('click', () => window.location.reload());
  }

  /** Renders the $...$ / $$...$$ LaTeX in the physics copy via KaTeX
   *  (loaded from a CDN in index.html). Guarded so a blocked/slow CDN
   *  degrades to plain-text formulas instead of a hard failure. */
  _renderMath() {
    if (typeof window.renderMathInElement !== 'function') return;
    window.renderMathInElement(document.body, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
    });
  }

  _bindMenu() {
    const toggleBtn = document.getElementById('menu-toggle-btn');
    const menu = document.getElementById('site-menu');
    const label = toggleBtn.querySelector('.menu-toggle-label');

    const setOpen = (open) => {
      menu.classList.toggle('open', open);
      menu.setAttribute('aria-hidden', String(!open));
      toggleBtn.setAttribute('aria-expanded', String(open));
      label.textContent = open ? label.dataset.closeLabel : label.dataset.openLabel;
    };

    toggleBtn.addEventListener('click', () => setOpen(!menu.classList.contains('open')));
    menu.querySelectorAll('[data-menu-link]').forEach((link) => {
      link.addEventListener('click', () => setOpen(false));
    });

    const progressToggle = document.getElementById('progress-toggle-btn');
    progressToggle.addEventListener('click', () => {
      const nowVisible = progressToggle.getAttribute('aria-pressed') !== 'true';
      progressToggle.setAttribute('aria-pressed', String(nowVisible));
      document.querySelectorAll('.progress-wrap').forEach((el) => el.classList.toggle('is-hidden', !nowVisible));
    });
  }

  _bindReveals() {
    const items = document.querySelectorAll('.reveal');
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.classList.add('in-view');
        });
      },
      { threshold: 0.2 }
    );
    items.forEach((el) => io.observe(el));
  }

  showError(message) {
    document.getElementById('loading-overlay').classList.add('hidden');
    const overlay = document.getElementById('error-overlay');
    overlay.hidden = false;
    if (message) document.getElementById('error-message').textContent = message;
  }
}

/* ==========================================================================
   ResponsiveManager
   ========================================================================== */
class ResponsiveManager {
  constructor(canvas, sceneManager, onResize) {
    this.canvas = canvas;
    this.sceneManager = sceneManager;
    this.onResize = onResize;
    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    window.addEventListener('orientationchange', this._resize);
    this._resize();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.sceneManager.setSize(rect.width || window.innerWidth, rect.height || window.innerHeight);
    this.onResize?.();
  }
}

/* ==========================================================================
   Experience — orchestrates one independent scroll-driven 3D showcase
   (its own scene, model, camera, scroll range, and panel HUD). A page can
   host several of these side by side, each fully self-contained.
   ========================================================================== */
class Experience {
  constructor(sectionEl, config, loadingManager) {
    this.sectionEl = sectionEl;
    this.config = config;
    this.loadingManager = loadingManager;
    this.canvas = sectionEl.querySelector('.viewer-canvas');
    this.panelRoot = sectionEl.querySelector('.viewer-panel');
    this.sceneManager = new SceneManager(this.canvas);
  }

  async init() {
    this.responsiveManager = new ResponsiveManager(this.canvas, this.sceneManager, () =>
      this.cameraController?.reframe()
    );
    this.lightingManager = new LightingManager(this.sceneManager);
    this.modelManager = new ModelManager(this.sceneManager, this.loadingManager, this.config);
    this.cameraController = new CameraController(this.sceneManager);

    await this.modelManager.loadAll();

    this.cameraController.frameToRange(this.modelManager.boundingSphere, this.modelManager.explodedBoundingSphere);
    this.animationManager = new AnimationManager(this.modelManager);
    this.scrollController = new ScrollController(this.sectionEl);
    this.interactionController = new InteractionController(this.canvas, this.cameraController);

    this.panelUI = new PanelUIManager(this.panelRoot, {
      cameraController: this.cameraController,
      lightingManager: this.lightingManager,
    });
    this.panelUI.onResetRequested = () => this.reset();

    this.sceneManager.addRenderCallback((dt) => this._tick(dt));
    this.sceneManager.start();
  }

  _tick(dt) {
    const progress = this.scrollController.update(dt);
    this.animationManager.setProgress(progress);
    this.cameraController.setExplodeRadius(progress);
    this.cameraController.update(dt);
    this.panelUI.updateProgressUI(progress);

    // Tactile "grab" feedback: the model eases to a slightly smaller scale
    // while actively being dragged, and springs back to normal on release.
    const targetScale = this.interactionController.isDragging ? 0.965 : 1;
    const root = this.modelManager.root;
    const nextScale = Utils.damp(root.scale.x, targetScale, 10, dt);
    root.scale.setScalar(nextScale);
  }

  reset() {
    this.cameraController.reset();
    this.scrollController.scrollToStart();
    // targetProgress will re-derive to 0 once scroll settles at the section
    // start; force an immediate visual reset too so there is no lag.
    this.animationManager.resetAnimation();
    this.scrollController.currentProgress = 0;
    this.scrollController.targetProgress = 0;
  }
}

/* ==========================================================================
   App — creates one Experience per EXPERIENCE_CONFIGS entry, sharing a
   single loading bar, theme toggle, and page-wide chrome across all of them.
   ========================================================================== */
class App {
  constructor() {
    const loadingKeys = EXPERIENCE_CONFIGS.flatMap((c) => Object.values(c.loadingKeys));
    this.loadingManager = new LoadingManager(loadingKeys);
    this.themeManager = new ThemeManager();
    this.globalChrome = new GlobalChrome();
  }

  async init() {
    try {
      this.experiences = EXPERIENCE_CONFIGS.map((config) => {
        const sectionEl = document.getElementById(config.sectionId);
        return new Experience(sectionEl, config, this.loadingManager);
      });

      await Promise.all(this.experiences.map((exp) => exp.init()));

      this.loadingManager.complete();
    } catch (err) {
      console.error(err);
      const detail = `${err?.message || err}${err?.stack ? '\n\n' + err.stack : ''}`;
      this.globalChrome.showError(detail);
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});

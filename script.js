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
     MasterScrollController      one continuous scroll -> phase + progress
     InteractionController        drag rotate / pinch zoom / gesture gating
     PieceHoverLabel                raycasts on hover, labels the piece type
     PanelUIManager                per-panel HUD, reset button, progress bar
     ResponsiveManager             resize / orientation / DPR handling
     ThemeManager                  shared dark/light site theme toggle
     PhysicsBackground             2D-canvas particles + explosion shockwave
     GlobalChrome                  shared menu, reveals, error overlay
     MasterExperience               the whole journey: Ghost -> 3D transition
                                     -> Rubik's Cube -> explode, one scene
     App                           bootstraps the MasterExperience, chrome
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
  // Shifts `angle` by whole turns so it lands within one revolution of `ref`
  // (shortest angular path) — used when lerping camera azimuth toward a
  // fixed target so a wildly-spun starting angle doesn't produce a multi-turn
  // spin during the scripted transition pan.
  wrapAngleNear: (angle, ref) => {
    const twoPi = Math.PI * 2;
    let diff = (angle - ref) % twoPi;
    if (diff > Math.PI) diff -= twoPi;
    if (diff < -Math.PI) diff += twoPi;
    return ref + diff;
  },
  // #rrggbb (as read from a CSS custom property) -> "rgba(r,g,b,a)". Falls
  // back to a neutral gray if the value isn't a hex color for any reason,
  // so a missing/misnamed custom property degrades quietly rather than
  // breaking canvas drawing.
  hexToRgba: (hex, alpha) => {
    const match = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!match) return `rgba(128,128,128,${alpha})`;
    const int = parseInt(match[1], 16);
    const r = (int >> 16) & 255;
    const g = (int >> 8) & 255;
    const b = int & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  },
};

// Two independent GLB sources sharing one scene (see MasterExperience).
// mode:'dual'   — a normal.glb + a separately-exported exploded.glb, matched
//                 by node name (the exploded file's baked keyframes are only
//                 ever read for their final position, never displayed).
// mode:'single' — one glb whose pieces each carry their own animation clip,
//                 keyframed from the assembled pose to the exploded pose;
//                 the same file is displayed AND mined for explode targets.
const GHOST_CONFIG = {
  rootName: 'GhostRoot',
  mode: 'single',
  paths: {
    single: './models/ghost_cube_steel_blue.glb',
  },
  loadingKeys: { single: 'ghost' },
};

const RUBIK_CONFIG = {
  rootName: 'RubikRoot',
  mode: 'dual',
  paths: {
    normal: './models/rubric3x3x3_red.glb',
    exploded: './models/rubric3x3x3_red_explode.glb',
  },
  loadingKeys: { normal: 'rubik-normal', exploded: 'rubik-exploded' },
};

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
    // every mesh material in this model, so a whole model's opacity can be
    // faded as one (three.js has no group-level opacity) — see setOpacity()
    this.materials = [];
  }

  /** Fades this entire model's opacity (0-1). Materials are marked
   *  `transparent` once up front (see _buildDisplayModel) so this never
   *  needs a shader recompile mid-animation. */
  setOpacity(opacity) {
    for (const mat of this.materials) mat.opacity = opacity;
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
          // Always transparent (even at opacity 1, which renders identically
          // to opaque) so setOpacity() can fade the model later without a
          // shader recompile.
          obj.material.transparent = true;
          obj.material.needsUpdate = true;
          this.materials.push(obj.material);
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

    this.autoRotate = true;
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

  /** Hard-sets the camera pose immediately (no spring/damping) — used by the
   *  scripted 3D-transition pan, which drives theta/phi/radius/target itself
   *  as a pure function of scroll progress rather than easing toward a
   *  target frame-by-frame. */
  setPose(theta, phi, radius, target) {
    this.theta = this.targetTheta = theta;
    this.phi = this.targetPhi = phi;
    this.radius = this.targetRadius = radius;
    this.target.copy(target);
    this._updatePosition();
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
    // gated off during the scripted 3D transition, so drag/pinch don't fight
    // the automatic camera pan between the Ghost and Rubik phases
    this.enabled = true;
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
      if (!this.enabled) return;
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
      if (!this.enabled) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        e.preventDefault();
        const factor = 1 + e.deltaY * 0.0025;
        this.cameraController.zoomBy(factor);
      }
    }, { passive: false });

    // Touch: always rotate with one finger, pinch-zoom with two.
    this.canvas.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: true });
    this.canvas.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
    this.canvas.addEventListener('touchend', (e) => this._onTouchEnd(e));
    this.canvas.addEventListener('touchcancel', (e) => this._onTouchEnd(e));
  }

  _activeTouches() {
    return this._touchCount || 0;
  }

  _onTouchStart(e) {
    if (!this.enabled) return;
    this._touchCount = e.touches.length;
    if (e.touches.length === 2) {
      this.isDragging = false;
      this._pinchStartDist = this._touchDistance(e.touches);
      this._pinchStartRadius = this.cameraController.targetRadius;
    }
  }

  _onTouchMove(e) {
    if (!this.enabled) return;
    const prevCount = this._touchCount;
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
    } else if (e.touches.length === 1 && prevCount >= 2) {
      // A pinch just dropped to one remaining finger — resume single-finger
      // drag from here instead of requiring a full lift + fresh touch, and
      // re-anchor _lastX/Y so it doesn't jump using stale coordinates from
      // before the pinch started.
      this.isDragging = true;
      this._lastX = e.touches[0].clientX;
      this._lastY = e.touches[0].clientY;
      this._lastDx = 0;
      this._lastDy = 0;
    }
    // single-finger drag is already handled via pointermove above; the
    // panel is fixed so it never needs to release the gesture to the page.
  }

  _onTouchEnd(e) {
    // Track the touches actually still down (not hard-reset to 0), so
    // lifting one finger out of a two-finger pinch doesn't get mistaken for
    // every finger having lifted — that previously left single-finger drag
    // unable to resume until the whole gesture was released and restarted.
    this._touchCount = e.touches.length;
    if (this._touchCount === 0) this.isDragging = false;
  }

  _touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }
}

/* ==========================================================================
   PieceHoverLabel
   Hovering an individual cube piece raycasts against whichever model is
   currently on screen and shows a small floating label classifying it —
   Corner / Edge / Center / Core — derived purely from its GLB node name's
   "_x_y_z" coordinate suffix (shared by both the Ghost and Rubik models),
   ties the hover interaction back to the piece-geometry language already
   used in the physics text next to the viewer. Mouse/fine-pointer only
   (gated behind `(hover:hover) and (pointer:fine)`) — touch already uses
   the same gesture space for drag-to-rotate, so hovering is left alone
   there rather than fighting or duplicating it.
   ========================================================================== */
class PieceHoverLabel {
  constructor(sceneManager, panelRoot, { interactionController, getActiveModel }) {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    this.sceneManager = sceneManager;
    this.interactionController = interactionController;
    this.getActiveModel = getActiveModel;
    this.raycaster = new THREE.Raycaster();
    this.pointerNdc = new THREE.Vector2();
    this._hasPointer = false;

    this.label = document.createElement('div');
    this.label.className = 'piece-hover-label';
    panelRoot.appendChild(this.label);

    sceneManager.canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const canvasRect = sceneManager.canvas.getBoundingClientRect();
      this.pointerNdc.x = ((e.clientX - canvasRect.left) / canvasRect.width) * 2 - 1;
      this.pointerNdc.y = -((e.clientY - canvasRect.top) / canvasRect.height) * 2 + 1;
      this._hasPointer = true;
      this._clientX = e.clientX;
      this._clientY = e.clientY;
      this._panelRect = panelRoot.getBoundingClientRect();
    });
    sceneManager.canvas.addEventListener('pointerleave', () => {
      this._hasPointer = false;
      this._hide();
    });

    sceneManager.addRenderCallback(() => this._update());
  }

  _hide() {
    this.label.classList.remove('is-visible');
  }

  /** Coordinate range (min/max across every piece's xyz) differs between
   *  the two models — Ghost uses -1/0/1, Rubik uses 0/1/2 — but "the
   *  middle value" is always their arithmetic mean, so this stays generic
   *  instead of hardcoding either model's numbering. Cached on the model
   *  itself since it never changes after load. */
  _coordRangeFor(model) {
    if (model._pieceCoordRange) return model._pieceCoordRange;
    let min = Infinity;
    let max = -Infinity;
    for (const key of model.parts.keys()) {
      const match = /_(-?\d+)_(-?\d+)_(-?\d+)$/.exec(key);
      if (!match) continue;
      for (let i = 1; i <= 3; i++) {
        const v = Number(match[i]);
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    model._pieceCoordRange = { min, max };
    return model._pieceCoordRange;
  }

  _findPieceName(model, object3D) {
    let obj = object3D;
    while (obj) {
      if (model.parts.has(obj.name)) return obj.name;
      obj = obj.parent;
    }
    return null;
  }

  _classify(model, name) {
    const match = /_(-?\d+)_(-?\d+)_(-?\d+)$/.exec(name);
    if (!match) return null;
    const { min, max } = this._coordRangeFor(model);
    const mid = (min + max) / 2;
    const extremeCount = [1, 2, 3].filter((i) => Number(match[i]) !== mid).length;
    if (extremeCount === 3) return 'มุม · Corner';
    if (extremeCount === 2) return 'ขอบ · Edge';
    if (extremeCount === 1) return 'กลางหน้า · Center';
    return 'แกนกลาง · Core';
  }

  _update() {
    if (!this._hasPointer || this.interactionController.isDragging) {
      this._hide();
      return;
    }
    const model = this.getActiveModel();
    if (!model) {
      this._hide();
      return;
    }

    this.raycaster.setFromCamera(this.pointerNdc, this.sceneManager.camera);
    const hits = this.raycaster.intersectObject(model.root, true);
    const pieceName = hits.length ? this._findPieceName(model, hits[0].object) : null;
    const label = pieceName ? this._classify(model, pieceName) : null;
    if (!label) {
      this._hide();
      return;
    }

    this.label.textContent = label;
    this.label.style.left = `${this._clientX - this._panelRect.left + 14}px`;
    this.label.style.top = `${this._clientY - this._panelRect.top + 14}px`;
    this.label.classList.add('is-visible');
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
   PhysicsBackground
   A cheap 2D-canvas background effect (kept separate from the Three.js
   scene so it never competes for the WebGL context): drifting dust/glitter
   particles in the site's own accent-red and neutral-gray tones, plus a
   brief shockwave ring whenever the active cube starts exploding (progress
   rising from 0). Reads `window.__rubricExplode` — a plain 0..1 number
   MasterExperience updates every tick — to both drive that trigger and
   gently speed the particles up while a cube is mid-explosion, without any
   tighter coupling to the 3D scene itself.

   Runs across TWO canvases (see PhysicsLayer below), not one: .viewer-panel
   is deliberately opaque so it can mask .content-col text scrolling
   underneath it on mobile, which also means a single page-wide canvas
   would be fully hidden anywhere the panel sits. So the panel gets its own
   local canvas (.viewer-bg-canvas, inside .viewer-panel) drawing the same
   kind of particles independently, keeping the two backgrounds visually
   consistent instead of the panel reading as a flat, static patch. Skipped
   entirely for prefers-reduced-motion.
   ========================================================================== */
/** One independently-sized dust-particle field drawn into its own canvas.
 *  PhysicsBackground runs two of these — a page-wide one and a panel-local
 *  one — so the "same" background can render both behind the scrolling
 *  text (a fixed, viewport-sized canvas) and inside the always-opaque
 *  .viewer-panel (a small canvas scoped to the panel's own box), which
 *  .viewer-panel's opacity would otherwise fully hide (see .viewer-panel
 *  in style.css for why it has to stay opaque). */
class PhysicsLayer {
  constructor(canvas, { particleCount, boundsEl = null, withRipple = false }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.boundsEl = boundsEl; // null = size to the viewport; else size to this element's own box
    this.particleCount = particleCount;
    this.withRipple = withRipple;
    this.particles = [];
    this.ripples = [];
    this._lastExplode = 0;

    this.resize();
    this._spawnParticles();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.boundsEl ? this.boundsEl.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _spawnParticles() {
    this.particles = [];
    for (let i = 0; i < this.particleCount; i++) {
      this.particles.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        r: Utils.lerp(0.7, 2.1, Math.random()),
        vx: (Math.random() - 0.5) * 9.5,
        vy: (Math.random() - 0.5) * 9.5 - 2.8, // gentle upward drift, like dust
        alpha: Utils.lerp(0.1, 0.32, Math.random()),
        accent: Math.random() < 0.3, // a minority tinted with the site's accent red
      });
    }
  }

  /** Fires once at the exact moment a cube starts coming apart (explode
   *  progress rising off zero), centered on this layer's own box — for the
   *  panel layer that's simply its own center, since it's already scoped
   *  to the 3D viewer panel's box (no viewport rect math needed). */
  _maybeTriggerShockwave(explode) {
    if (this.withRipple && this._lastExplode <= 0.001 && explode > 0.001) {
      this.ripples.push({ x: this.width / 2, y: this.height / 2, radius: 0, alpha: 0.45 });
    }
    this._lastExplode = explode;
  }

  update(dt, explode) {
    this._maybeTriggerShockwave(explode);

    const energy = 1 + explode * 1.6; // particles drift a bit faster as pieces separate
    for (const p of this.particles) {
      p.x += p.vx * energy * dt;
      p.y += p.vy * energy * dt;
      if (p.x < -10) p.x = this.width + 10;
      if (p.x > this.width + 10) p.x = -10;
      if (p.y < -10) p.y = this.height + 10;
      if (p.y > this.height + 10) p.y = -10;
    }

    for (const r of this.ripples) {
      r.radius += 260 * dt;
      r.alpha -= dt * 0.6;
    }
    this.ripples = this.ripples.filter((r) => r.alpha > 0);
  }

  draw(accentColor, neutralColor) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    // Accent-tinted particles brighten as the cube explodes (same signal
    // driving --explode-intensity in style.css), so the particle field and
    // the studio backdrop warm up together rather than just the backdrop.
    const accentBoost = 1 + this._lastExplode * 0.7;
    for (const p of this.particles) {
      ctx.beginPath();
      ctx.fillStyle = Utils.hexToRgba(p.accent ? accentColor : neutralColor, p.accent ? Math.min(1, p.alpha * accentBoost) : p.alpha);
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const r of this.ripples) {
      ctx.beginPath();
      ctx.strokeStyle = Utils.hexToRgba(accentColor, Math.max(r.alpha, 0));
      ctx.lineWidth = 1.5;
      ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

class PhysicsBackground {
  constructor() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const pageCanvas = document.createElement('canvas');
    pageCanvas.id = 'physics-bg-canvas';
    document.body.prepend(pageCanvas);
    const pageWide = window.innerWidth >= 700;
    this.pageLayer = new PhysicsLayer(pageCanvas, { particleCount: pageWide ? 195 : 98 });
    this.layers = [this.pageLayer];

    // The panel's own canvas (see .viewer-bg-canvas in style.css) — gives
    // the always-opaque .viewer-panel the same drifting-dust look, and
    // hosts the shockwave ripple where it's actually visible.
    const panelCanvas = document.querySelector('.viewer-bg-canvas');
    const panelEl = document.querySelector('.viewer-panel');
    if (panelCanvas && panelEl) {
      const panelWide = panelEl.getBoundingClientRect().width >= 700;
      this.panelLayer = new PhysicsLayer(panelCanvas, {
        particleCount: panelWide ? 75 : 48,
        boundsEl: panelEl,
        withRipple: true,
      });
      this.layers.push(this.panelLayer);

      if (window.ResizeObserver) {
        this._panelObserver = new ResizeObserver(() => this.panelLayer.resize());
        this._panelObserver.observe(panelEl);
      }
    }

    window.addEventListener('resize', () => this.pageLayer.resize());

    let lastTime = performance.now();
    const tick = (now) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      const explode = window.__rubricExplode || 0;
      const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-glow').trim();
      const neutralColor = getComputedStyle(document.documentElement).getPropertyValue('--ink-faint').trim();
      for (const layer of this.layers) {
        layer.update(dt, explode);
        layer.draw(accentColor, neutralColor);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

/* ==========================================================================
   GlobalChrome
   Page-wide UI that exists exactly once regardless of how many Experiences
   are on the page: the full-screen menu, scroll-reveal animations, the
   physics-effect background, and the shared error overlay.
   ========================================================================== */
class GlobalChrome {
  constructor() {
    this._renderMath();
    this._bindMenu();
    this._bindReveals();
    this.physicsBackground = new PhysicsBackground();
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

  /** Continuous scroll-linked reveal: each element's own opacity/offset is a
   *  pure function of its own position in the viewport (not a threshold
   *  snap), so stacked physics blocks fade in and back out one at a time in
   *  step with scrolling — never several popping to visible together —
   *  fully reversible on scroll-up, and applies uniformly to every `.reveal`
   *  element on the page (both the Ghost and the Rubik's Cube content). */
  _bindReveals() {
    const items = Array.from(document.querySelectorAll('.reveal'));
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; // CSS keeps them fully visible

    const update = () => {
      const vh = window.innerHeight;
      const zoneStart = vh * 0.92; // element's top crossing here begins its fade-in
      const zoneEnd = vh * 0.55; // and it's fully revealed by the time it reaches here
      for (const el of items) {
        const top = el.getBoundingClientRect().top;
        const progress = Utils.clamp((zoneStart - top) / (zoneStart - zoneEnd), 0, 1);
        el.style.opacity = progress;
        el.style.transform = `translateY(${(1 - progress) * 26}px)`;
      }
    };
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
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
   MasterScrollController
   Converts ONE continuous page scroll into a phase + local progress, using
   two invisible marker elements to split the single #main-showcase section
   into three ranges: 'ghost' -> 'transition' -> 'rubik'. Each cube's own
   explode is driven directly by its own phase's local progress (scrolling
   through that cube's hero+physics content both reveals the text AND
   explodes the pieces, exactly like reading through it "breaks it apart").
   Marker-to-section distances are measured via getBoundingClientRect, which
   stays scroll-invariant (both move by the same amount), so no document-flow
   offset math is needed. Recomputed on every scroll/resize, so it stays
   correct if content reflows (e.g. KaTeX finishing render).
   ========================================================================== */
class MasterScrollController {
  constructor(sectionEl, markers) {
    this.sectionEl = sectionEl;
    this.markers = markers; // { ghostEnd, transitionEnd }
    this.smoothing = 9;
    this.smoothedGlobal = 0;
    this.targetGlobal = 0;
    this._bounds = { d1: 1, d2: 2, d3: 3 };
    this.current = { phase: 'ghost', t: 0, global: 0 };

    this._onScroll = this._onScroll.bind(this);
    window.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', this._onScroll);
    this._onScroll();
  }

  _onScroll() {
    const sectionRect = this.sectionEl.getBoundingClientRect();
    const d1 = this.markers.ghostEnd.getBoundingClientRect().top - sectionRect.top;
    const d2 = this.markers.transitionEnd.getBoundingClientRect().top - sectionRect.top;
    const d3 = Math.max(this.sectionEl.offsetHeight - window.innerHeight, d2 + 1);
    this._bounds = { d1, d2, d3 };
    this.targetGlobal = Utils.clamp(-sectionRect.top, 0, d3);
  }

  update(dt) {
    this.smoothedGlobal = Utils.damp(this.smoothedGlobal, this.targetGlobal, this.smoothing, dt);
    if (Math.abs(this.smoothedGlobal - this.targetGlobal) < 0.05) this.smoothedGlobal = this.targetGlobal;

    const { d1, d2, d3 } = this._bounds;
    const s = this.smoothedGlobal;
    let phase, t;
    if (s <= d1) {
      phase = 'ghost';
      t = d1 > 0 ? s / d1 : 1;
    } else if (s <= d2) {
      phase = 'transition';
      t = d2 > d1 ? (s - d1) / (d2 - d1) : 1;
    } else {
      phase = 'rubik';
      t = d3 > d2 ? (s - d2) / (d3 - d2) : 1;
    }
    this.current = { phase, t: Utils.clamp(t, 0, 1), global: s };
    return this.current;
  }
}

/* ==========================================================================
   MasterExperience — the entire scroll-driven journey as ONE shared Three.js
   scene/camera/canvas: the Ghost Cube orbits and explodes/reassembles as its
   own physics text scrolls by -> a literal 3D transition where both models
   coexist and the camera pans between them -> the Rubik's Cube orbits and
   explodes/reassembles the same way as its own physics text scrolls by.
   Everything is a pure function of one continuous scroll progress, so
   scrolling back up reverses the whole sequence exactly.
   ========================================================================== */
class MasterExperience {
  constructor(sectionEl, loadingManager) {
    this.sectionEl = sectionEl;
    this.loadingManager = loadingManager;
    this.canvas = sectionEl.querySelector('.viewer-canvas');
    this.panelRoot = sectionEl.querySelector('.viewer-panel');
    this.sceneManager = new SceneManager(this.canvas);
    this._phase = 'ghost';
    this._framedFor = null;
    this._grabScale = 1;
    this._transitionBase = null;
  }

  async init() {
    this.responsiveManager = new ResponsiveManager(this.canvas, this.sceneManager, () =>
      this.cameraController?.reframe()
    );
    this.lightingManager = new LightingManager(this.sceneManager);

    this.ghostModel = new ModelManager(this.sceneManager, this.loadingManager, GHOST_CONFIG);
    this.rubikModel = new ModelManager(this.sceneManager, this.loadingManager, RUBIK_CONFIG);
    await Promise.all([this.ghostModel.loadAll(), this.rubikModel.loadAll()]);

    this.ghostAnim = new AnimationManager(this.ghostModel);
    this.rubikAnim = new AnimationManager(this.rubikModel);

    // Red Cube starts hidden/collapsed inside the Ghost Cube until the
    // transition phase grows it out.
    this.rubikModel.root.visible = false;
    this.rubikModel.root.scale.setScalar(0.001);

    this.cameraController = new CameraController(this.sceneManager);

    // Frame both models once up front to capture each one's own "resting"
    // pose — the transition pans from the live Ghost pose toward the fixed
    // Rubik resting pose captured here.
    this.cameraController.frameToRange(this.ghostModel.boundingSphere, this.ghostModel.explodedBoundingSphere);
    this._ghostDefaultPose = this._capturePose();
    this.cameraController.frameToRange(this.rubikModel.boundingSphere, this.rubikModel.explodedBoundingSphere);
    this._rubikDefaultPose = this._capturePose();

    // Start the actual experience framed on the Ghost Cube.
    this.cameraController.frameToRange(this.ghostModel.boundingSphere, this.ghostModel.explodedBoundingSphere);
    this._framedFor = 'ghost';
    this._liveGhostPose = { ...this._ghostDefaultPose, target: this._ghostDefaultPose.target.clone() };

    this.interactionController = new InteractionController(this.canvas, this.cameraController);

    this.pieceHoverLabel = new PieceHoverLabel(this.sceneManager, this.panelRoot, {
      interactionController: this.interactionController,
      // Ambiguous mid-fade during the transition (both models visible at
      // once), so hover is simply off there rather than guessing which one
      // the cursor is "over".
      getActiveModel: () => {
        if (this._phase === 'ghost') return this.ghostModel;
        if (this._phase === 'rubik') return this.rubikModel;
        return null;
      },
    });

    this.scrollController = new MasterScrollController(this.sectionEl, {
      ghostEnd: document.getElementById('marker-ghost-end'),
      transitionEnd: document.getElementById('marker-transition-end'),
    });

    this.panelUI = new PanelUIManager(this.panelRoot, {
      cameraController: this.cameraController,
      lightingManager: this.lightingManager,
    });
    this.panelUI.onResetRequested = () => this.reset();

    this.sceneManager.addRenderCallback((dt) => this._tick(dt));
    this.sceneManager.start();
  }

  _capturePose() {
    return {
      theta: this.cameraController.theta,
      phi: this.cameraController.phi,
      radius: this.cameraController.targetRadius,
      target: this.cameraController.target.clone(),
    };
  }

  _tick(dt) {
    const { phase, t } = this.scrollController.update(dt);

    // Tactile "grab" feedback while actively dragging whichever model is
    // currently orbit-able; a no-op (settles to 1) during the transition,
    // since drag input is disabled there.
    this._grabScale = Utils.damp(this._grabScale, this.interactionController.isDragging ? 0.965 : 1, 10, dt);

    if (phase === 'ghost') {
      if (this._framedFor !== 'ghost') {
        this.cameraController.frameToRange(this.ghostModel.boundingSphere, this.ghostModel.explodedBoundingSphere);
        this.cameraController.setPose(
          this._liveGhostPose.theta,
          this._liveGhostPose.phi,
          this._liveGhostPose.radius,
          this._liveGhostPose.target
        );
        this._framedFor = 'ghost';
      }

      this.ghostModel.root.visible = true;
      this.rubikModel.root.visible = false;
      this.ghostModel.setOpacity(1);
      // Explode ties directly to scrolling through the Ghost Cube's own
      // hero+physics content — reading through it visibly breaks it apart.
      this.ghostAnim.setProgress(t);
      this.ghostModel.root.scale.setScalar(this._grabScale);

      this.interactionController.enabled = true;
      this.cameraController.setExplodeRadius(t);
      this.cameraController.update(dt);
      this._liveGhostPose = this._capturePose();
      this.panelUI.updateProgressUI(t);
    } else if (phase === 'transition') {
      // Orbit/zoom stay live through the transition too: rather than hard-
      // setting an absolute pose every frame (which would silently overwrite
      // any drag/zoom the instant the next frame's scripted value lands),
      // only the FRAME-TO-FRAME CHANGE in the scripted pan is applied as a
      // delta on top of the camera's existing target theta/phi/radius — so
      // the scroll-driven pan and live user input add together instead of
      // one discarding the other.
      this.interactionController.enabled = true;

      this.ghostModel.root.visible = true;
      this.rubikModel.root.visible = true;

      const eased = Utils.easeInOutCubic(t);
      // Ghost is already fully exploded (from the ghost phase above) — here
      // it just fades away as the red cube grows into view at the shared
      // center, instead of snapping to hidden the instant Rubik's Cube phase
      // begins.
      this.ghostAnim.setProgress(1);
      this.ghostModel.setOpacity(1 - eased);
      this.ghostModel.root.scale.setScalar(1);
      this.rubikModel.root.scale.setScalar(Utils.lerp(0.001, 1, eased));
      this.rubikAnim.setProgress(0);

      const from = this._liveGhostPose;
      const to = this._rubikDefaultPose;
      const scriptedTheta = Utils.lerp(Utils.wrapAngleNear(from.theta, to.theta), to.theta, eased);
      const scriptedPhi = Utils.lerp(from.phi, to.phi, eased);
      const scriptedRadius = Utils.lerp(from.radius, to.radius, eased);
      const scriptedTarget = from.target.clone().lerp(to.target, eased);
      const cam = this.cameraController;

      if (!this._transitionBase) {
        // first frame entering the transition (from either direction) —
        // anchor here so the pan starts exactly where the camera already
        // is, no snap.
        this._transitionBase = { theta: scriptedTheta, phi: scriptedPhi, radius: scriptedRadius };
      } else {
        cam.targetTheta += scriptedTheta - this._transitionBase.theta;
        cam.targetPhi = Utils.clamp(cam.targetPhi + (scriptedPhi - this._transitionBase.phi), cam.minPhi, cam.maxPhi);
        cam.targetRadius = Utils.clamp(
          cam.targetRadius + (scriptedRadius - this._transitionBase.radius),
          cam.minRadius,
          cam.maxRadius
        );
        this._transitionBase = { theta: scriptedTheta, phi: scriptedPhi, radius: scriptedRadius };
      }
      cam.target.copy(scriptedTarget);
      cam.update(dt);

      this._framedFor = null; // re-frame once we land on either side
      this.panelUI.updateProgressUI(0);
    } else {
      // 'rubik' — orbit-able, and its own explode ties to scrolling through
      // its own hero+physics content, same as the Ghost Cube above.
      if (this._framedFor !== 'rubik') {
        this.cameraController.frameToRange(this.rubikModel.boundingSphere, this.rubikModel.explodedBoundingSphere);
        this.cameraController.setPose(
          this._rubikDefaultPose.theta,
          this._rubikDefaultPose.phi,
          this._rubikDefaultPose.radius,
          this._rubikDefaultPose.target
        );
        this._framedFor = 'rubik';
      }

      this.ghostModel.root.visible = false;
      this.rubikModel.root.visible = true;
      this.rubikModel.root.scale.setScalar(this._grabScale);

      this.interactionController.enabled = true;
      this.rubikAnim.setProgress(t);
      this.cameraController.setExplodeRadius(t);
      this.cameraController.update(dt);
      this.panelUI.updateProgressUI(t);
    }

    if (phase !== 'transition') this._transitionBase = null;
    this._phase = phase;

    // A plain global rather than a tighter coupling: PhysicsBackground (a
    // page-wide 2D-canvas decoration, deliberately kept independent of the
    // Three.js scene) reads this each frame to time its shockwave trigger
    // and scale particle drift speed. Ghost/Rubik explode tie directly to
    // `t` in their own phases; Ghost is already fully exploded throughout
    // the transition.
    window.__rubricExplode = phase === 'transition' ? 1 : t;

    // Same value, mirrored onto a CSS custom property so the studio
    // backdrop's red glow (see --studio-glow-2 in style.css) can warm up
    // as a cube comes apart, instead of sitting at one fixed intensity
    // through the whole scroll journey.
    document.documentElement.style.setProperty('--explode-intensity', String(window.__rubricExplode));
  }

  reset() {
    this.cameraController.reset();
  }
}

/* ==========================================================================
   App — bootstraps the shared loading bar, theme toggle, page-wide chrome,
   and the single MasterExperience that drives the whole page.
   ========================================================================== */
class App {
  constructor() {
    const loadingKeys = [...Object.values(GHOST_CONFIG.loadingKeys), ...Object.values(RUBIK_CONFIG.loadingKeys)];
    this.loadingManager = new LoadingManager(loadingKeys);
    this.themeManager = new ThemeManager();
    this.globalChrome = new GlobalChrome();
  }

  async init() {
    try {
      const sectionEl = document.getElementById('main-showcase');
      this.experience = new MasterExperience(sectionEl, this.loadingManager);
      await this.experience.init();

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

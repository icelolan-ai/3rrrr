/* ==========================================================================
   RUBRIC.3D — Interactive Scroll-Driven 3D Explosion Viewer
   ----------------------------------------------------------------------
   Architecture (modular, extensible):
     LoadingManager        loading UI + progress aggregation
     SceneManager           renderer / scene / render loop / resize
     LightingManager         lights + procedural PBR environment
     ModelManager             loads GLBs, matches nodes, records A/B transforms
     CameraController          spherical orbit camera, zoom, framing, reset
     AnimationManager           progress -> per-cubelet transform interpolation
     ScrollController            scrollY -> deterministic target progress
     InteractionController        drag rotate / pinch zoom / gesture gating
     UIManager                    HUD, reset button, progress bar, reveals
     ResponsiveManager             resize / orientation / DPR handling
     App                           orchestrates everything
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

const MODEL_PATHS = {
  normal: './models/rubric3x3x3_red.glb',
  exploded: './models/rubric3x3x3_red_explode.glb',
};

/* ==========================================================================
   LoadingManager
   ========================================================================== */
class LoadingManager {
  constructor() {
    this.overlay = document.getElementById('loading-overlay');
    this.barFill = document.getElementById('loading-bar-fill');
    this.percentLabel = document.getElementById('loading-percent');
    this.progress = { normal: 0, exploded: 0 };
  }

  update(key, ratio) {
    this.progress[key] = Utils.clamp(ratio, 0, 1);
    const total = (this.progress.normal + this.progress.exploded) / 2;
    const pct = Math.round(total * 100);
    this.barFill.style.width = `${pct}%`;
    this.percentLabel.textContent = `${pct}%`;
  }

  complete() {
    this.update('normal', 1);
    this.update('exploded', 1);
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
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x0a0a0c, 1);
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
   Loads the normal GLB (displayed) and the exploded GLB (used only to read
   its baked keyframe animation and derive each cubelet's exploded transform).
   Objects are matched by node NAME, which is identical across both files.
   ========================================================================== */
class ModelManager {
  constructor(sceneManager, loadingManager) {
    this.sceneManager = sceneManager;
    this.loadingManager = loadingManager;
    this.loader = new GLTFLoader();
    this.root = new THREE.Group();
    this.root.name = 'RubikRoot';
    this.sceneManager.scene.add(this.root);

    // registry: name -> { object3D, basePos, explodedPos, baseQuat, index }
    this.parts = new Map();
    this.boundingBox = new THREE.Box3();
    this.boundingSphere = new THREE.Sphere();
  }

  async loadAll() {
    const [normalGltf, explodedGltf] = await Promise.all([
      this._loadOne(MODEL_PATHS.normal, 'normal'),
      this._loadOne(MODEL_PATHS.exploded, 'exploded'),
    ]);

    this._buildDisplayModel(normalGltf);
    this._extractExplodedTargets(explodedGltf);
    this._disposeGltf(explodedGltf); // only needed its animation data

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

    // Flat hierarchy: every cubelet is a direct child node named "Cubelet_x_y_z"
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

    this.rotateDamping = 10;
    this.zoomDamping = 8;

    this.autoRotate = false;
    this.autoRotateSpeed = 0.12;

    this._defaults = null;
  }

  frameToSphere(sphere) {
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const fitDist = (sphere.radius * 1.65) / Math.sin(fovRad / 2);
    this.radius = this.targetRadius = Utils.clamp(fitDist, 4, 18);
    this.minRadius = Math.max(2.5, sphere.radius * 1.15);
    this.maxRadius = sphere.radius * 6;
    this.target.copy(sphere.center);

    this._defaults = {
      theta: this.theta,
      phi: this.phi,
      radius: this.radius,
      target: this.target.clone(),
    };
    this._updatePosition(true);
  }

  rotateBy(deltaThetaPx, deltaPhiPx, sensitivity = 0.006) {
    this.targetTheta -= deltaThetaPx * sensitivity;
    this.targetPhi = Utils.clamp(this.targetPhi - deltaPhiPx * sensitivity, this.minPhi, this.maxPhi);
  }

  zoomBy(factor) {
    this.targetRadius = Utils.clamp(this.targetRadius * factor, this.minRadius, this.maxRadius);
  }

  setAutoRotate(enabled) {
    this.autoRotate = enabled;
  }

  reset() {
    if (!this._defaults) return;
    this.targetTheta = this._defaults.theta;
    this.targetPhi = this._defaults.phi;
    this.targetRadius = this._defaults.radius;
  }

  update(dt) {
    if (this.autoRotate) this.targetTheta += this.autoRotateSpeed * dt;

    this.theta = Utils.damp(this.theta, this.targetTheta, this.rotateDamping, dt);
    this.phi = Utils.damp(this.phi, this.targetPhi, this.rotateDamping, dt);
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
   Converts window scroll position within the pinned viewer section into a
   deterministic target progress value, then the caller smooths toward it.
   Progress is always derived from scrollY -> no drift, exact restoration.
   ========================================================================== */
class ScrollController {
  constructor(sectionEl) {
    this.sectionEl = sectionEl;
    this.currentProgress = 0;
    this.targetProgress = 0;
    this.smoothing = 9; // higher = snappier response to scroll
    this._lastScrollY = window.scrollY;
    this._velocity = 0;

    this._onScroll = this._onScroll.bind(this);
    window.addEventListener('scroll', this._onScroll, { passive: true });
    this._onScroll();
  }

  _onScroll() {
    const rect = this.sectionEl.getBoundingClientRect();
    const scrollableHeight = this.sectionEl.offsetHeight - window.innerHeight;
    const scrolled = -rect.top;
    const raw = scrollableHeight > 0 ? scrolled / scrollableHeight : 0;
    this.targetProgress = Utils.clamp(raw, 0, 1);

    const now = window.scrollY;
    this._velocity = now - this._lastScrollY;
    this._lastScrollY = now;
  }

  update(dt) {
    this.currentProgress = Utils.damp(this.currentProgress, this.targetProgress, this.smoothing, dt);
    if (Math.abs(this.currentProgress - this.targetProgress) < 0.0004) {
      this.currentProgress = this.targetProgress; // settle exactly, no lingering drift
    }
    return this.currentProgress;
  }

  isInSection() {
    const rect = this.sectionEl.getBoundingClientRect();
    return rect.top <= window.innerHeight * 0.6 && rect.bottom >= window.innerHeight * 0.4;
  }

  scrollToStart() {
    const top = this.sectionEl.offsetTop;
    window.scrollTo({ top, behavior: 'smooth' });
  }
}

/* ==========================================================================
   InteractionController
   Desktop: mouse-drag anywhere on the canvas free-orbits the camera; wheel
   scroll is left untouched so it drives normal page scroll (-> explosion).
   Mobile: gesture direction is detected on touchmove — a horizontal-dominant
   drag rotates the model (preventDefault, page does not scroll); a
   vertical-dominant drag is treated as a page scroll (never prevented, so
   native scrolling — and therefore the explosion timeline — is never
   blocked). Two-finger pinch always zooms.
   ========================================================================== */
class InteractionController {
  constructor(canvas, cameraController) {
    this.canvas = canvas;
    this.cameraController = cameraController;

    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;

    this._touchGesture = null; // 'rotate' | 'scroll' | null
    this._touchStartX = 0;
    this._touchStartY = 0;
    this._pinchStartDist = 0;
    this._pinchStartRadius = 0;

    this._bind();
  }

  _bind() {
    // Desktop mouse drag
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return; // touch handled separately below
      this._dragging = true;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    window.addEventListener('pointermove', (e) => {
      if (!this._dragging) return;
      const dx = e.clientX - this._lastX;
      const dy = e.clientY - this._lastY;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      this.cameraController.rotateBy(dx, dy);
    });
    window.addEventListener('pointerup', () => { this._dragging = false; });
    window.addEventListener('pointercancel', () => { this._dragging = false; });

    // Desktop trackpad pinch (reported as wheel + ctrlKey) / ctrl|shift+wheel = zoom
    this.canvas.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        e.preventDefault();
        const factor = 1 + e.deltaY * 0.0025;
        this.cameraController.zoomBy(factor);
      }
      // otherwise: do nothing special, let the event bubble as normal page scroll
    }, { passive: false });

    // Mobile touch: gesture-gated rotate vs scroll, plus pinch zoom
    this.canvas.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: true });
    this.canvas.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
    this.canvas.addEventListener('touchend', () => this._onTouchEnd());
    this.canvas.addEventListener('touchcancel', () => this._onTouchEnd());
  }

  _onTouchStart(e) {
    if (e.touches.length === 2) {
      this._touchGesture = 'pinch';
      this._pinchStartDist = this._touchDistance(e.touches);
      this._pinchStartRadius = this.cameraController.targetRadius;
      return;
    }
    if (e.touches.length === 1) {
      this._touchGesture = null; // undecided until movement crosses threshold
      this._touchStartX = e.touches[0].clientX;
      this._touchStartY = e.touches[0].clientY;
      this._lastX = e.touches[0].clientX;
      this._lastY = e.touches[0].clientY;
    }
  }

  _onTouchMove(e) {
    if (this._touchGesture === 'pinch' && e.touches.length === 2) {
      e.preventDefault();
      const dist = this._touchDistance(e.touches);
      const factor = this._pinchStartDist / Math.max(dist, 1);
      this.cameraController.targetRadius = Utils.clamp(
        this._pinchStartRadius * factor,
        this.cameraController.minRadius,
        this.cameraController.maxRadius
      );
      return;
    }

    if (e.touches.length !== 1) return;
    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;

    if (this._touchGesture === null) {
      const dx = x - this._touchStartX;
      const dy = y - this._touchStartY;
      if (Math.hypot(dx, dy) < 9) return; // below threshold, keep undecided
      this._touchGesture = Math.abs(dx) > Math.abs(dy) * 1.15 ? 'rotate' : 'scroll';
      this.canvas.classList.toggle('rotating', this._touchGesture === 'rotate');
    }

    if (this._touchGesture === 'rotate') {
      e.preventDefault(); // consume the gesture: rotate only, no page scroll
      const dx = x - this._lastX;
      const dy = y - this._lastY;
      this.cameraController.rotateBy(dx, dy, 0.009);
    }
    // gesture === 'scroll': do not preventDefault -> native page scroll proceeds
    // uninterrupted, which is what drives the explosion timeline.

    this._lastX = x;
    this._lastY = y;
  }

  _onTouchEnd() {
    this._touchGesture = null;
    this.canvas.classList.remove('rotating');
  }

  _touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }
}

/* ==========================================================================
   UIManager
   ========================================================================== */
class UIManager {
  constructor({ cameraController, animationManager, lightingManager, scrollController, sceneManager }) {
    this.cameraController = cameraController;
    this.animationManager = animationManager;
    this.lightingManager = lightingManager;
    this.scrollController = scrollController;
    this.sceneManager = sceneManager;

    this.progressFill = document.getElementById('progress-fill');
    this.progressDot = document.getElementById('progress-dot');
    this.progressPercent = document.getElementById('progress-percent');
    this.instructions = document.getElementById('instructions');
    this.scrollCue = document.getElementById('scroll-cue');

    this._bindButtons();
    this._bindReveals();
    this._instructionsFaded = false;
  }

  _bindButtons() {
    document.getElementById('reset-btn').addEventListener('click', () => this.onResetRequested?.());

    const autoBtn = document.getElementById('autorotate-btn');
    autoBtn.addEventListener('click', () => {
      const enabled = !this.cameraController.autoRotate;
      this.cameraController.setAutoRotate(enabled);
      autoBtn.setAttribute('aria-pressed', String(enabled));
    });

    const envBtn = document.getElementById('env-btn');
    envBtn.addEventListener('click', () => {
      const enabled = this.lightingManager.toggleEnvironment();
      envBtn.setAttribute('aria-pressed', String(enabled));
    });

    const fsBtn = document.getElementById('fullscreen-btn');
    fsBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
    });

    document.getElementById('error-retry-btn').addEventListener('click', () => window.location.reload());
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

    this.scrollCue.classList.toggle('hidden', progress > 0.03);
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
  constructor(canvas, sceneManager) {
    this.canvas = canvas;
    this.sceneManager = sceneManager;
    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    window.addEventListener('orientationchange', this._resize);
    this._resize();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.sceneManager.setSize(rect.width || window.innerWidth, rect.height || window.innerHeight);
  }
}

/* ==========================================================================
   App — orchestration
   ========================================================================== */
class App {
  constructor() {
    this.canvas = document.getElementById('viewer-canvas');
    this.viewerSection = document.getElementById('viewer-section');
    this.loadingManager = new LoadingManager();
    this.sceneManager = new SceneManager(this.canvas);
  }

  async init() {
    try {
      this.responsiveManager = new ResponsiveManager(this.canvas, this.sceneManager);
      this.lightingManager = new LightingManager(this.sceneManager);
      this.modelManager = new ModelManager(this.sceneManager, this.loadingManager);
      this.cameraController = new CameraController(this.sceneManager);

      await this.modelManager.loadAll();

      this.cameraController.frameToSphere(this.modelManager.boundingSphere);
      this.animationManager = new AnimationManager(this.modelManager);
      this.scrollController = new ScrollController(this.viewerSection);
      this.interactionController = new InteractionController(this.canvas, this.cameraController);

      this.uiManager = new UIManager({
        cameraController: this.cameraController,
        animationManager: this.animationManager,
        lightingManager: this.lightingManager,
        scrollController: this.scrollController,
        sceneManager: this.sceneManager,
      });
      this.uiManager.onResetRequested = () => this.reset();

      this.sceneManager.addRenderCallback((dt) => this._tick(dt));
      this.sceneManager.start();

      this.loadingManager.complete();
    } catch (err) {
      console.error(err);
      const detail = `${err?.message || err}${err?.stack ? '\n\n' + err.stack : ''}`;
      this.uiManager?.showError?.(detail) ?? this._showFallbackError(detail);
    }
  }

  _showFallbackError(message) {
    document.getElementById('loading-overlay').classList.add('hidden');
    const overlay = document.getElementById('error-overlay');
    overlay.hidden = false;
    if (message) document.getElementById('error-message').textContent = message;
  }

  _tick(dt) {
    const progress = this.scrollController.update(dt);
    this.animationManager.setProgress(progress);
    this.cameraController.update(dt);
    this.uiManager.updateProgressUI(progress);
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

window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});

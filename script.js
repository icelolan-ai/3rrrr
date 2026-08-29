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

  /** Adds a shadow-only ground plane beneath the model so the cube casts a
   *  soft contact shadow, sized/positioned from the model's bounding box and
   *  matched to the key light's shadow-camera frustum. */
  addGroundShadow(boundingBox) {
    const size = new THREE.Vector3();
    boundingBox.getSize(size);
    const center = new THREE.Vector3();
    boundingBox.getCenter(center);

    const footprint = Math.max(size.x, size.z, 0.001) * 0.5;
    const planeSize = footprint * 10;

    const shadowCam = this.keyLight.shadow.camera;
    shadowCam.left = -footprint * 3;
    shadowCam.right = footprint * 3;
    shadowCam.top = footprint * 3;
    shadowCam.bottom = -footprint * 3;
    shadowCam.near = 0.5;
    shadowCam.far = footprint * 12 + 10;
    shadowCam.updateProjectionMatrix();

    const geometry = new THREE.PlaneGeometry(planeSize, planeSize);
    const material = new THREE.ShadowMaterial({ opacity: 0.4 });
    const plane = new THREE.Mesh(geometry, material);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(center.x, boundingBox.min.y - size.y * 0.02, center.z);
    plane.receiveShadow = true;
    this.sceneManager.scene.add(plane);
    this.groundPlane = plane;
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
   Converts the whole page's scroll position into a deterministic target
   progress value (0 at the top of the page, 1 at the bottom), then the
   caller smooths toward it. The 3D panel itself is fixed and independent
   of scroll — only the explode/reassemble progress is driven by it.
   Progress is always derived from scrollY -> no drift, exact restoration.
   ========================================================================== */
class ScrollController {
  constructor() {
    this.currentProgress = 0;
    this.targetProgress = 0;
    this.smoothing = 9; // higher = snappier response to scroll

    this._onScroll = this._onScroll.bind(this);
    this._onResize = this._onScroll.bind(this);
    window.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', this._onResize);
    this._onScroll();
  }

  _onScroll() {
    const doc = document.documentElement;
    const scrollableHeight = doc.scrollHeight - window.innerHeight;
    const raw = scrollableHeight > 0 ? window.scrollY / scrollableHeight : 0;
    this.targetProgress = Utils.clamp(raw, 0, 1);
  }

  update(dt) {
    this.currentProgress = Utils.damp(this.currentProgress, this.targetProgress, this.smoothing, dt);
    if (Math.abs(this.currentProgress - this.targetProgress) < 0.0004) {
      this.currentProgress = this.targetProgress; // settle exactly, no lingering drift
    }
    return this.currentProgress;
  }

  scrollToStart() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
   the WebGL canvas clear color / meta theme-color in sync.
   ========================================================================== */
class ThemeManager {
  constructor(sceneManager) {
    this.sceneManager = sceneManager;
    this.storageKey = 'rubric3d-theme';
    this.clearColors = { dark: 0x0a0a0c, light: 0xffffff };
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
    this.sceneManager.renderer.setClearColor(this.clearColors[theme], 1);
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
    this.progressWrap = document.querySelector('.progress-wrap');

    this._bindButtons();
    this._bindMenu();
    this._bindReveals();
    this._instructionsFaded = false;
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
      this.progressWrap.classList.toggle('is-hidden', !nowVisible);
    });
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

    const toolsToggle = document.getElementById('tools-toggle-btn');
    const toolsTray = document.getElementById('tools-tray');
    toolsToggle.addEventListener('click', () => {
      const open = !toolsTray.classList.contains('open');
      toolsTray.classList.toggle('open', open);
      toolsToggle.setAttribute('aria-expanded', String(open));
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
    this.loadingManager = new LoadingManager();
    this.sceneManager = new SceneManager(this.canvas);
    this.themeManager = new ThemeManager(this.sceneManager);
  }

  async init() {
    try {
      this.responsiveManager = new ResponsiveManager(this.canvas, this.sceneManager);
      this.lightingManager = new LightingManager(this.sceneManager);
      this.modelManager = new ModelManager(this.sceneManager, this.loadingManager);
      this.cameraController = new CameraController(this.sceneManager);

      await this.modelManager.loadAll();
      this.lightingManager.addGroundShadow(this.modelManager.boundingBox);

      this.cameraController.frameToSphere(this.modelManager.boundingSphere);
      this.animationManager = new AnimationManager(this.modelManager);
      this.scrollController = new ScrollController();
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

window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});

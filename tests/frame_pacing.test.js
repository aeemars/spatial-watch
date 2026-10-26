/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — Cinema & WebXR Frame Pacing Unit Tests
   Validating:
   1. Single authoritative render loop (renderer.setAnimationLoop)
   2. Frame-driven video texture updates (requestVideoFrameCallback & fallback)
   3. Lightweight headset-safe rendering (DPR cap & zero per-frame allocs)
   4. Event-driven playback synchronization with drift tolerance & debouncing
   5. Diagnostics HUD & logging
   ═══════════════════════════════════════════════════════════ */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Helper to reliably override Node 22's read-only global.navigator
function setNavigator(navObj) {
  Object.defineProperty(global, 'navigator', {
    value: navObj,
    configurable: true,
    writable: true,
  });
}

// Mock Three.js with VideoTexture, WebGLRenderer, and scratch objects
function createMockThree() {
  let createdVideoTexture = null;

  class MockVideoTexture {
    constructor(video) {
      this.video = video;
      this.needsUpdate = false;
      this.minFilter = 0;
      this.magFilter = 0;
      this.generateMipmaps = true;
      this.disposed = false;
      createdVideoTexture = this;
    }
    dispose() {
      this.disposed = true;
    }
  }

  class MockWebGLRenderer {
    constructor(opts = {}) {
      this.canvas = opts.canvas;
      this.antialias = opts.antialias;
      this.pixelRatio = 1;
      this.width = 800;
      this.height = 600;
      this.animationLoop = null;
      this.disposed = false;
      this.xr = {
        enabled: false,
        isPresenting: false,
        setSession: () => {},
      };
    }
    setPixelRatio(dpr) {
      this.pixelRatio = dpr;
    }
    setSize(w, h) {
      this.width = w;
      this.height = h;
    }
    setAnimationLoop(fn) {
      this.animationLoop = fn;
    }
    render() {}
    dispose() {
      this.disposed = true;
    }
  }

  return {
    Scene: class {
      constructor() { this.children = []; }
      add(obj) { obj.parent = this; this.children.push(obj); }
      remove(obj) { this.children = this.children.filter(c => c !== obj); obj.parent = null; }
    },
    PerspectiveCamera: class {
      constructor() {
        this.aspect = 16 / 9;
        this.position = { set: () => {} };
        this.rotation = { set: () => {} };
        this.children = [];
      }
      updateProjectionMatrix() {}
      add(obj) { obj.parent = this; this.children.push(obj); }
      remove(obj) { this.children = this.children.filter(c => c !== obj); obj.parent = null; }
    },
    Color: class { constructor() {} },
    PlaneGeometry: class {
      constructor(w, h) { this.w = w; this.h = h; }
      dispose() { this.disposed = true; }
    },
    BoxGeometry: class { dispose() { this.disposed = true; } },
    SphereGeometry: class { dispose() { this.disposed = true; } },
    RingGeometry: class { dispose() { this.disposed = true; } },
    EdgesGeometry: class { dispose() { this.disposed = true; } },
    MeshStandardMaterial: class {
      clone() { return new this.constructor(); }
      dispose() { this.disposed = true; }
    },
    MeshBasicMaterial: class {
      constructor(opts = {}) {
        this.map = opts.map;
        this.color = { clone: () => this.color, set: () => {}, copy: () => {} };
      }
      dispose() { this.disposed = true; }
    },
    LineBasicMaterial: class { dispose() { this.disposed = true; } },
    Mesh: class {
      constructor(geometry, material) {
        this.geometry = geometry;
        this.material = material;
        this.position = { set: () => {} };
        this.rotation = { x: 0, y: 0, z: 0 };
        this.scale = { clone: () => ({ multiplyScalar: () => {} }), copy: () => {} };
        this.userData = {};
      }
    },
    Group: class {
      constructor() {
        this.children = [];
        this.position = { set: () => {} };
        this.rotation = {};
      }
      add(c) { c.parent = this; this.children.push(c); }
      remove(c) { this.children = this.children.filter(x => x !== c); c.parent = null; }
      traverse(fn) { fn(this); this.children.forEach(c => c.traverse ? c.traverse(fn) : fn(c)); }
    },
    LineSegments: class { constructor(g, m) { this.geometry = g; this.material = m; } },
    AmbientLight: class { constructor() {} },
    PointLight: class { constructor() { this.position = { set: () => {} }; } },
    CanvasTexture: class { dispose() { this.disposed = true; } },
    VideoTexture: MockVideoTexture,
    WebGLRenderer: MockWebGLRenderer,
    Vector2: class { constructor(x = 0, y = 0) { this.x = x; this.y = y; } },
    Raycaster: class {
      setFromCamera() {}
      intersectObjects() { return []; }
    },
    LinearFilter: 1006,
    FrontSide: 0,
    DoubleSide: 2,
    getCreatedVideoTexture: () => createdVideoTexture,
  };
}

// Mock Video Element with requestVideoFrameCallback support
function createMockVideo() {
  let vfcCounter = 0;
  const callbacks = new Map();

  return {
    crossOrigin: '',
    preload: '',
    playsInline: false,
    loop: true,
    src: '',
    currentTime: 0,
    duration: 184,
    paused: true,
    seeking: false,
    readyState: 4,
    videoWidth: 1920,
    videoHeight: 1080,
    onloadedmetadata: null,
    onerror: null,
    onended: null,
    onwaiting: null,
    oncanplay: null,
    onplaying: null,
    onpause: null,
    onseeking: null,
    onseeked: null,
    async play() {
      this.paused = false;
      if (this.onplaying) this.onplaying();
    },
    pause() {
      this.paused = true;
      if (this.onpause) this.onpause();
    },
    load() {},
    removeAttribute() {},
    requestVideoFrameCallback(fn) {
      vfcCounter++;
      const id = vfcCounter;
      callbacks.set(id, fn);
      return id;
    },
    cancelVideoFrameCallback(id) {
      callbacks.delete(id);
    },
    triggerVideoFrame(now = Date.now(), metadata = { presentedFrames: 1 }) {
      const entries = Array.from(callbacks.entries());
      callbacks.clear();
      entries.forEach(([_, fn]) => fn(now, metadata));
    },
    getVideoPlaybackQuality() {
      return { droppedVideoFrames: 0, totalVideoFrames: 100 };
    },
    getPendingCallbackCount: () => callbacks.size,
  };
}

describe('Spatial Watch — Frame Pacing & Rendering Tests', () => {
  let mockThree;
  let mockVideo;
  let mockCanvas;
  let Cinema;
  let Diagnostics;
  let App;

  beforeEach(() => {
    mockThree = createMockThree();
    mockVideo = createMockVideo();
    mockCanvas = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const elements = {
      'cinema-canvas': mockCanvas,
      'cinema-video': mockVideo,
      'cinema-controls': { hidden: false },
      'cinema-time-current': { textContent: '' },
      'cinema-time-duration': { textContent: '' },
      'cinema-progress': { value: 0 },
      'cinema-countdown-text': { textContent: '' },
      'cinema-countdown-chip': { classList: { add: () => {}, remove: () => {} } },
      'cinema-participant-badge': { textContent: '' },
      'cinema-buffering-overlay': { hidden: true },
      'cinema-error-overlay': { hidden: true },
      'btn-play-pause': { setAttribute: () => {} },
      'toast-container': { appendChild: () => {}, removeChild: () => {} },
    };

    global.window = {
      innerWidth: 1920,
      innerHeight: 1080,
      devicePixelRatio: 2.0, // High-DPI display
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { protocol: 'https:', hostname: 'spatial-watch.aeemarrs.workers.dev', search: '' },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
      caches: {
        open: async () => ({
          match: async () => null,
          put: async () => {},
        }),
      },
    };

    global.document = {
      getElementById: (id) => elements[id] || null,
      querySelector: () => ({ style: {} }),
      createElement: (tag) => ({
        tagName: tag ? tag.toUpperCase() : 'DIV',
        id: '',
        style: {},
        innerHTML: '',
        parentNode: {
          removeChild: () => {},
        },
        appendChild: () => {},
        removeChild: () => {},
        getContext: () => ({
          fillStyle: '',
          font: '',
          textAlign: '',
          textBaseline: '',
          fillText: () => {},
          roundRect: () => {},
          rect: () => {},
        }),
        width: 0,
        height: 0,
      }),
      body: {
        appendChild: (el) => {
          if (el && el.id) elements[el.id] = el;
        },
        removeChild: (el) => {
          if (el && el.id) delete elements[el.id];
        },
      },
      readyState: 'complete',
    };

    global.THREE = mockThree;

    setNavigator({
      userAgent: 'Mozilla/5.0 (Linux; Android 12; Quest 3) OculusBrowser/34.0',
      xr: { isSessionSupported: async () => true },
    });

    global.XR = {
      isSupported: () => true,
      isInVR: () => false,
      enterVR: () => {},
      checkSupport: async () => true,
      setMediaReady: () => {},
      onRenderTick: () => {},
    };

    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      blob: async () => new Blob(['dummy'], { type: 'video/mp4' }),
    });

    // Fresh require of modules
    delete require.cache[require.resolve('../frontend/js/diagnostics.js')];
    delete require.cache[require.resolve('../frontend/js/cinema.js')];
    delete require.cache[require.resolve('../frontend/js/app.js')];

    Diagnostics = require('../frontend/js/diagnostics.js');
    Cinema = require('../frontend/js/cinema.js');
    global.Diagnostics = Diagnostics;
    global.Cinema = Cinema;

    App = require('../frontend/js/app.js');
    global.App = App;
  });

  it('1. Authoritative render loop: uses renderer.setAnimationLoop and cleans up completely', () => {
    Cinema.init('https://example.com/screening.mp4', true);

    const renderer = Cinema.getRenderer();
    assert.ok(renderer, 'Renderer must be created');
    assert.equal(typeof renderer.animationLoop, 'function', 'Must register authoritative animation loop');

    // Video properties
    assert.equal(mockVideo.crossOrigin, 'anonymous', 'Video must have crossorigin="anonymous"');
    assert.equal(mockVideo.preload, 'auto', 'Video must have preload="auto"');
    assert.equal(mockVideo.playsInline, true, 'Video must have playsinline');

    // Destroy
    Cinema.destroy();
    assert.equal(renderer.animationLoop, null, 'setAnimationLoop must be null after destroy');
    assert.equal(renderer.disposed, true, 'Renderer must be disposed on destroy');
  });

  it('2. Frame-driven video texture: uses requestVideoFrameCallback when supported without redundant updates', () => {
    Cinema.init('https://example.com/screening.mp4', true);
    assert.equal(Cinema.hasVideoFrameCallback(), true, 'Should detect requestVideoFrameCallback support');

    const videoTexture = mockThree.getCreatedVideoTexture();
    assert.ok(videoTexture, 'VideoTexture should be initialized');

    const renderer = Cinema.getRenderer();
    const renderFrame = renderer.animationLoop;

    // Start playback
    Cinema.play();
    assert.ok(mockVideo.getPendingCallbackCount() > 0, 'Should register video frame callback on play');

    // Simulate render frames where no new decoded video frame arrived
    videoTexture.needsUpdate = false;
    renderFrame(100);
    assert.equal(videoTexture.needsUpdate, false, 'Texture must NOT be marked dirty if no new video frame was decoded');

    renderFrame(108);
    assert.equal(videoTexture.needsUpdate, false, 'Subsequent render frame must remain clean');

    // Now video presents a new decoded frame
    mockVideo.triggerVideoFrame(110, { presentedFrames: 1 });

    // Next render frame must upload the new texture
    renderFrame(116);
    assert.equal(videoTexture.needsUpdate, true, 'Texture must be flagged dirty exactly once for presented frame');

    // Render frame after that without new decoded frame must NOT re-upload
    videoTexture.needsUpdate = false;
    renderFrame(125);
    assert.equal(videoTexture.needsUpdate, false, 'Texture must NOT re-upload unchanged video frames');

    Cinema.destroy();
  });

  it('3. Fallback video texture dirtying: only marks dirty when currentTime changes if requestVideoFrameCallback unavailable', () => {
    // Remove requestVideoFrameCallback from mock video
    delete mockVideo.requestVideoFrameCallback;
    delete mockVideo.cancelVideoFrameCallback;

    Cinema.init('https://example.com/screening.mp4', true);
    assert.equal(Cinema.hasVideoFrameCallback(), false, 'Should detect lack of requestVideoFrameCallback');

    const videoTexture = mockThree.getCreatedVideoTexture();
    const renderer = Cinema.getRenderer();
    const renderFrame = renderer.animationLoop;

    Cinema.play();
    mockVideo.currentTime = 10.0;

    // Render tick 1: currentTime changed to 10.0
    videoTexture.needsUpdate = false;
    renderFrame(100);
    assert.equal(videoTexture.needsUpdate, true, 'First frame with new time should update');

    // Render tick 2 at 120Hz: video hasn't progressed yet (currentTime still 10.0)
    videoTexture.needsUpdate = false;
    renderFrame(108);
    assert.equal(videoTexture.needsUpdate, false, 'Must NOT force needsUpdate when currentTime has not progressed');

    // Render tick 3: currentTime progresses to 10.033
    mockVideo.currentTime = 10.033;
    videoTexture.needsUpdate = false;
    renderFrame(116);
    assert.equal(videoTexture.needsUpdate, true, 'Must update when currentTime progresses');

    Cinema.destroy();
  });

  it('4. Headset-safe rendering: caps pixel ratio to 1.0 in WebXR and 1.5 on desktop', () => {
    Cinema.init('https://example.com/screening.mp4', true);
    const renderer = Cinema.getRenderer();

    // Desktop devicePixelRatio is 2.0 in mock window, but capped at 1.5
    assert.equal(renderer.pixelRatio, 1.5, 'Desktop DPR must be capped at 1.5');

    // In VR mode, DPR should cap to 1.0
    renderer.xr.isPresenting = true;
    Cinema.onVREnd(); // When presenting, caps to 1.0
    assert.equal(renderer.pixelRatio, 1.0, 'VR DPR must be capped at 1.0');

    // When VR session ends, restores desktop DPR (1.5)
    renderer.xr.isPresenting = false;
    Cinema.onVREnd();
    assert.equal(renderer.pixelRatio, 1.5, 'Desktop DPR must be restored to 1.5 after VR');

    Cinema.destroy();
  });

  it('5. Synchronized playback: drift tolerance prevents corrective seeks on small timing differences', () => {
    let seeks = [];
    Cinema.init('https://example.com/screening.mp4', true);

    // Track calls to Cinema.seek
    const originalSeek = Cinema.seek;
    Cinema.seek = (t) => {
      seeks.push(t);
      originalSeek(t);
    };

    Cinema.play();
    mockVideo.currentTime = 20.0;

    // Scenario A: room_state arrives with 150ms drift (target: 20.15s, current: 20.0s)
    // 0.15s < DRIFT_TOLERANCE_SECONDS (0.45s) -> NO seek
    seeks = [];
    App.syncPlaybackState(20.15, false, 0, false);
    assert.equal(seeks.length, 0, 'Small drift (< 0.45s) must NOT trigger corrective seek');

    // Scenario B: room_state arrives with 600ms drift (target: 20.60s, current: 20.0s)
    // 0.60s > DRIFT_TOLERANCE_SECONDS (0.45s) -> Corrective seek triggered
    seeks = [];
    App.syncPlaybackState(20.60, false, 0, false);
    assert.equal(seeks.length, 1, 'Significant drift (> 0.45s) must trigger corrective seek');
    assert.equal(seeks[0], 20.60);

    // Scenario C: Debouncing - second state event arrives 200ms later with drift
    // Should be debounced (CORRECTION_DEBOUNCE_MS = 1200ms)
    seeks = [];
    App.syncPlaybackState(20.90, false, 0, false);
    assert.equal(seeks.length, 0, 'Back-to-back corrective seeks must be debounced');

    // Scenario D: User or Host explicitly commands a seek (forceSeek = true)
    seeks = [];
    App.syncPlaybackState(45.0, false, 0, true);
    assert.equal(seeks.length, 1, 'Explicit seek command must bypass tolerance and debounce');
    assert.equal(seeks[0], 45.0);

    Cinema.destroy();
  });

  it('6. Diagnostics module: tracks and updates performance metrics', () => {
    Diagnostics.enable();
    assert.equal(Diagnostics.isEnabled(), true);

    Diagnostics.updateMetrics({
      fps: 120,
      frameTimeMs: 8.3,
      presentedFrames: 557,
      droppedFrames: 0,
      videoTime: 14.5,
      drift: 0.02,
      isVR: true,
      hasVFC: true,
    });

    const metrics = Diagnostics.getMetrics();
    assert.equal(metrics.fps, 120);
    assert.equal(metrics.presentedFrames, 557);
    assert.equal(metrics.isVR, true);

    Diagnostics.disable();
    assert.equal(Diagnostics.isEnabled(), false);
  });
});

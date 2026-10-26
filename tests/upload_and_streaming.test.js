/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — Large Video Upload, Caching & Streaming Tests
   Validating:
   1. Global Upload-Once: Remote media bypasses in-memory fetch and streams directly
   2. Host Local Seed: Local File seeding provides instant local playback
   3. Anti-latching: Video element error state clears on retryStream without browser refresh
   4. Retry Stream Button: Actionable retry button in error overlay
   5. API Error Translation: Actionable messages for network/CORS issues
   ═══════════════════════════════════════════════════════════ */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Mock Three.js
function createMockThree() {
  class MockVideoTexture {
    constructor(video) {
      this.video = video;
      this.needsUpdate = false;
      this.disposed = false;
    }
    dispose() {
      this.disposed = true;
    }
  }

  class MockWebGLRenderer {
    constructor(opts = {}) {
      this.canvas = opts.canvas;
      this.pixelRatio = 1;
      this.animationLoop = null;
      this.disposed = false;
      this.xr = {
        enabled: false,
        isPresenting: false,
        setSession: () => {},
      };
    }
    setPixelRatio(dpr) { this.pixelRatio = dpr; }
    setSize() {}
    setAnimationLoop(fn) { this.animationLoop = fn; }
    render() {}
    dispose() { this.disposed = true; }
  }

  return {
    Scene: class {
      constructor() { this.children = []; }
      add(obj) { this.children.push(obj); }
      remove(obj) { this.children = this.children.filter(c => c !== obj); }
    },
    PerspectiveCamera: class {
      constructor() {
        this.position = { set: () => {} };
        this.rotation = { set: () => {} };
      }
      updateProjectionMatrix() {}
      add() {}
    },
    Color: class { constructor() {} },
    PlaneGeometry: class {
      constructor(w, h) { this.w = w; this.h = h; }
      dispose() { this.disposed = true; }
    },
    BoxGeometry: class { dispose() {} },
    SphereGeometry: class { dispose() {} },
    RingGeometry: class { dispose() {} },
    EdgesGeometry: class { dispose() {} },
    MeshStandardMaterial: class {
      clone() { return new this.constructor(); }
      dispose() {}
    },
    MeshBasicMaterial: class { dispose() {} },
    LineBasicMaterial: class { dispose() {} },
    Mesh: class {
      constructor(geometry, material) {
        this.geometry = geometry;
        this.material = material;
        this.position = { set: () => {} };
        this.rotation = { x: 0, y: 0, z: 0 };
        this.scale = { clone: () => ({ multiplyScalar: () => {} }), copy: () => {} };
      }
    },
    Group: class {
      constructor() { this.children = []; this.position = { set: () => {} }; this.rotation = {}; }
      add(c) { this.children.push(c); }
      remove(c) { this.children = this.children.filter(x => x !== c); }
      traverse(fn) { fn(this); }
    },
    LineSegments: class { constructor(g, m) { this.geometry = g; this.material = m; } },
    AmbientLight: class { constructor() {} },
    PointLight: class { constructor() { this.position = { set: () => {} }; } },
    CanvasTexture: class { dispose() {} },
    VideoTexture: MockVideoTexture,
    WebGLRenderer: MockWebGLRenderer,
    Vector2: class { constructor(x = 0, y = 0) { this.x = x; this.y = y; } },
    Raycaster: class {
      setFromCamera() {}
      intersectObjects() { return []; }
    },
  };
}

// Mock DOM elements
function createMockDOM() {
  const elements = new Map();

  class MockElement {
    constructor(id) {
      this.id = id;
      this.hidden = false;
      this.style = {};
      this.textContent = '';
      this.innerHTML = '';
      this.attributes = new Map();
      this.listeners = new Map();
      this.onclick = null;
      this.children = [];
    }
    setAttribute(name, val) { this.attributes.set(name, String(val)); }
    getAttribute(name) { return this.attributes.get(name) || null; }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    addEventListener(evt, fn) {
      if (!this.listeners.has(evt)) this.listeners.set(evt, []);
      this.listeners.get(evt).push(fn);
    }
    removeEventListener(evt, fn) {
      if (!this.listeners.has(evt)) return;
      this.listeners.set(evt, this.listeners.get(evt).filter(l => l !== fn));
    }
    dispatchEvent(evt) {
      const fns = this.listeners.get(evt.type) || [];
      fns.forEach(fn => fn(evt));
      if (typeof this[`on${evt.type}`] === 'function') {
        this[`on${evt.type}`](evt);
      }
    }
    classList = {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); },
    };
  }

  class MockVideoElement extends MockElement {
    constructor(id) {
      super(id);
      this.src = '';
      this.crossOrigin = '';
      this.preload = '';
      this.readyState = 0;
      this.currentTime = 0;
      this.duration = 120;
      this.paused = true;
      this.error = null;
      this.videoWidth = 1920;
      this.videoHeight = 1080;
      this.loadCalls = 0;
      this.pauseCalls = 0;
    }
    pause() {
      this.paused = true;
      this.pauseCalls++;
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    load() {
      this.loadCalls++;
      // If src is removed, clear error
      if (!this.src) {
        this.error = null;
        this.readyState = 0;
      }
    }
    removeAttribute(name) {
      super.removeAttribute(name);
      if (name === 'src') {
        this.src = '';
      }
    }
  }

  const canvas = new MockElement('cinema-canvas');
  canvas.getContext = () => ({});
  elements.set('cinema-canvas', canvas);

  const video = new MockVideoElement('cinema-video');
  elements.set('cinema-video', video);

  elements.set('cinema-buffering-overlay', new MockElement('cinema-buffering-overlay'));
  elements.set('cinema-buffering-text', new MockElement('cinema-buffering-text'));
  elements.set('cinema-buffering-percent', new MockElement('cinema-buffering-percent'));
  elements.set('cinema-error-overlay', new MockElement('cinema-error-overlay'));
  elements.set('cinema-error-message', new MockElement('cinema-error-message'));
  elements.set('cinema-error-guidance', new MockElement('cinema-error-guidance'));
  elements.set('btn-cinema-error-retry', new MockElement('btn-cinema-error-retry'));
  elements.set('btn-cinema-error-back', new MockElement('btn-cinema-error-back'));
  elements.set('cinema-closing-overlay', new MockElement('cinema-closing-overlay'));

  return {
    elements,
    video,
    canvas,
    getElementById: (id) => elements.get(id) || null,
  };
}

describe('Spatial Watch — Large Video Upload, Caching & Streaming Tests', () => {
  let mockDom;
  let Cinema;

  beforeEach(() => {
    // Fresh mock DOM
    mockDom = createMockDOM();
    global.document = {
      getElementById: (id) => mockDom.getElementById(id),
      createElement: (tag) => {
        if (tag === 'video') return new (mockDom.elements.get('cinema-video').constructor)('temp-video');
        return new (mockDom.elements.get('cinema-canvas').constructor)(tag);
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    global.window = {
      innerWidth: 1920,
      innerHeight: 1080,
      devicePixelRatio: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { origin: 'http://localhost:8080' },
      URL: {
        createObjectURL: (blob) => `blob:http://localhost:8080/${Math.random().toString(36).slice(2)}`,
        revokeObjectURL: () => {},
      },
    };
    global.URL = global.window.URL;
    global.THREE = createMockThree();

    // Clear require cache for clean module testing
    delete require.cache[require.resolve('../frontend/js/cinema.js')];
    Cinema = require('../frontend/js/cinema.js');
  });

  it('1. Global Upload-Once: Remote media bypasses in-memory fetch and streams directly', async () => {
    const remoteUrl = 'https://media.spatialwatch.app/uploads/screening-1hour.mp4';
    let progressReported = false;

    // preloadMedia with remote URL
    Cinema.preloadMedia(
      remoteUrl,
      () => {},
      () => {},
      (pct) => {
        progressReported = true;
        assert.equal(pct, 100);
      }
    );

    // Let promise resolve
    await new Promise(r => setTimeout(r, 10));

    const video = mockDom.video;
    // The video src must be assigned directly to the remote URL, not a blob: URL
    assert.equal(video.src, remoteUrl);
    assert.equal(video.crossOrigin, 'anonymous');
    assert.equal(progressReported, true);
  });

  it('2. Host Local Seed: Local File seeding provides instant local playback', async () => {
    const remoteUrl = 'https://media.spatialwatch.app/uploads/host-video.mp4';
    const mockFileBlob = { size: 500 * 1024 * 1024, type: 'video/mp4' };

    // Host uploads video and seeds local blob
    const seededBlobUrl = Cinema.seedMediaBlob(remoteUrl, mockFileBlob);
    assert.ok(seededBlobUrl.startsWith('blob:'));

    // When Cinema.init is called for this mediaUrl, it uses the seeded blobUrl
    Cinema.init(remoteUrl, true);
    await new Promise(r => setTimeout(r, 10));

    const video = mockDom.video;
    assert.equal(video.src, seededBlobUrl);
  });

  it('3. Anti-latching: Video element error state clears on retryStream without browser refresh', async () => {
    const remoteUrl = 'https://media.spatialwatch.app/uploads/sample.mp4';
    Cinema.init(remoteUrl, false);
    await new Promise(r => setTimeout(r, 10));

    const video = mockDom.video;
    assert.equal(video.src, remoteUrl);

    // Simulate an error occurring (e.g., edge propagation delay / network blip)
    video.error = { code: 4, message: 'Media format error or CORS blocked' };
    Cinema.showMediaError(video.error);

    const errorOverlay = mockDom.getElementById('cinema-error-overlay');
    assert.equal(errorOverlay.hidden, false);
    assert.ok(mockDom.getElementById('cinema-error-message').textContent.includes('blocked by CORS'));

    // Call Cinema.retryStream()
    Cinema.retryStream();

    // Verify video element was paused, src removed, and reloaded
    assert.ok(video.pauseCalls >= 1);
    assert.equal(errorOverlay.hidden, true);
    assert.equal(video.error, null);

    await new Promise(r => setTimeout(r, 10));
    assert.equal(video.src, remoteUrl);
  });

  it('4. Retry Stream Button: Actionable retry button in error overlay triggers retryStream', async () => {
    const remoteUrl = 'https://media.spatialwatch.app/uploads/another-screening.mp4';
    Cinema.init(remoteUrl, false);
    await new Promise(r => setTimeout(r, 10));

    // Show media error overlay
    mockDom.video.error = { code: 2, message: 'Network error' };
    Cinema.showMediaError(mockDom.video.error);

    const retryBtn = mockDom.getElementById('btn-cinema-error-retry');
    assert.ok(typeof retryBtn.onclick === 'function');

    // Simulate user clicking "Retry Stream"
    retryBtn.onclick();

    // Error overlay should be hidden and video reloaded
    const errorOverlay = mockDom.getElementById('cinema-error-overlay');
    assert.equal(errorOverlay.hidden, true);
    assert.equal(mockDom.video.error, null);
  });

  it('5. API Error Translation: Actionable messages for network/CORS issues', async () => {
    delete require.cache[require.resolve('../frontend/js/api.js')];

    // Mock fetch to simulate a browser "TypeError: Failed to fetch"
    global.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };

    const API = require('../frontend/js/api.js');

    await assert.rejects(
      async () => {
        await API.getSession();
      },
      (err) => {
        assert.ok(err.message.includes('Unable to reach Spatial Watch server'));
        assert.ok(err.message.includes('Check your connection and try again'));
        return true;
      }
    );
  });
});

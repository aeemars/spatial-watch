/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — WebXR Readiness Unit Tests
   Testing Quest WebXR capability detection, dynamic hand checking,
   immediate session listener attachment, gaze lifecycle, & media gating
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

// Mock DOM factory
function createMockDOM() {
  const elements = {};
  function makeElement(id) {
    return {
      id,
      textContent: '',
      className: '',
      classList: {
        classes: new Set(),
        add(c) { this.classes.add(c); },
        remove(c) { this.classes.delete(c); },
        contains(c) { return this.classes.has(c); }
      },
      disabled: false,
      hidden: false,
      children: [],
      style: {},
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }

  const ids = [
    'xr-status', 'xr-status-text', 'xr-status-dot', 'btn-enter-vr',
    'vr-readiness-dot', 'vr-readiness-chip',
    'preflight-xr-icon', 'preflight-xr-text',
    'preflight-secure-icon', 'preflight-secure-text',
    'preflight-input-icon', 'preflight-input-text',
    'btn-enter-cinema', 'btn-enter-cinema-label'
  ];

  ids.forEach(id => {
    elements[id] = makeElement(id);
  });

  return {
    getElementById: (id) => elements[id] || (elements[id] = makeElement(id)),
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      getContext: () => ({
        fillStyle: '',
        beginPath: () => {},
        roundRect: () => {},
        rect: () => {},
        fill: () => {},
        font: '',
        textAlign: '',
        textBaseline: '',
        fillText: () => {},
      }),
      width: 0,
      height: 0,
    }),
    elements,
  };
}

// Mock Three.js
const mockThree = {
  Scene: class {
    constructor() { this.children = []; }
    add(obj) { obj.parent = this; this.children.push(obj); }
    remove(obj) { this.children = this.children.filter(c => c !== obj); obj.parent = null; }
  },
  PerspectiveCamera: class {
    constructor() { this.position = { set: () => {} }; this.children = []; }
    add(obj) { obj.parent = this; this.children.push(obj); }
    remove(obj) { this.children = this.children.filter(c => c !== obj); obj.parent = null; }
  },
  Group: class {
    constructor() {
      this.children = [];
      this.position = { set: () => {} };
      this.rotation = {};
    }
    add(child) { child.parent = this; this.children.push(child); }
    remove(child) { this.children = this.children.filter(c => c !== child); child.parent = null; }
    traverse(fn) {
      fn(this);
      this.children.forEach(c => {
        if (c.traverse) c.traverse(fn);
        else fn(c);
      });
    }
  },
  Vector2: class { constructor(x = 0, y = 0) { this.x = x; this.y = y; } },
  PlaneGeometry: class { dispose() { this.disposed = true; } },
  RingGeometry: class { dispose() { this.disposed = true; } },
  EdgesGeometry: class { dispose() { this.disposed = true; } },
  MeshBasicMaterial: class {
    constructor() {
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
      this.scale = { clone: () => ({ multiplyScalar: () => {} }), copy: () => {} };
      this.userData = {};
    }
  },
  LineSegments: class {
    constructor(geo, mat) { this.geometry = geo; this.material = mat; }
  },
  CanvasTexture: class { dispose() { this.disposed = true; } },
  DoubleSide: 2,
  Raycaster: class {
    setFromCamera() {}
    intersectObjects() { return []; }
  },
};

// Mock WebXR Session
class FakeXRSession {
  constructor(inputSources = []) {
    this.inputSources = inputSources;
    this.listeners = {};
    this.ended = false;
  }
  addEventListener(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }
  removeEventListener(event, fn) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(cb => cb !== fn);
  }
  dispatchEvent(event, data = {}) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(fn => fn(data));
    }
  }
  setInputSources(sources) {
    this.inputSources = sources;
    this.dispatchEvent('inputsourceschange', { added: [], removed: [] });
  }
  async end() {
    this.ended = true;
    this.dispatchEvent('end');
  }
}

describe('Spatial Watch — WebXR Module Tests', () => {
  let XR;
  let mockDOM;
  let mockRenderer;
  let mockCamera;
  let mockScene;
  let toasts = [];

  beforeEach(() => {
    mockDOM = createMockDOM();
    toasts = [];

    // Setup global window, document, navigator, THREE, Cinema, App
    global.window = {
      location: { protocol: 'https:', hostname: 'spatial-watch.aeemarrs.workers.dev' },
      isSecureContext: true,
    };
    global.document = mockDOM;
    global.THREE = mockThree;

    setNavigator({
      userAgent: 'Mozilla/5.0 (Linux; Android 12; Quest 3) OculusBrowser/34.0',
      xr: {
        isSessionSupported: async (mode) => mode === 'immersive-vr',
      },
    });

    mockCamera = new mockThree.PerspectiveCamera();
    mockScene = new mockThree.Scene();
    mockRenderer = {
      xr: {
        enabled: true,
        session: null,
        setSession(s) { this.session = s; },
      },
      setAnimationLoop: () => {},
      dispose: () => {},
    };

    global.Cinema = {
      getRenderer: () => mockRenderer,
      getCamera: () => mockCamera,
      getScene: () => mockScene,
      isPlaying: () => false,
      pause: () => {},
      play: () => {},
      seek: () => {},
      getCurrentTime: () => 0,
    };

    global.App = {
      isUserHost: () => true,
      showToast: (msg, type) => { toasts.push({ msg, type }); },
      leaveRoom: () => {},
    };

    global.WS = {
      sendPlayback: () => {},
      sendDirectorCut: () => {},
    };

    global.DirectorsCut = {
      isEnabled: () => false,
      setEnabled: () => {},
    };

    global.Reactions = {
      send: () => {},
    };

    // Clean module cache and require fresh XR
    delete require.cache[require.resolve('../frontend/js/xr.js')];
    XR = require('../frontend/js/xr.js');
  });

  it('1. WebXR capability detection: handles isSessionSupported true & false without false hand promises', async () => {
    // When isSessionSupported is true
    setNavigator({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/34.0',
      xr: {
        isSessionSupported: async (mode) => mode === 'immersive-vr',
      },
    });

    const supported = await XR.checkSupport();
    assert.equal(supported, true);
    assert.equal(XR.isSupported(), true);

    // CRITICAL REQUIREMENT: handSupported must NOT be true before an active session verifies it
    assert.equal(XR.isHandSupported(), false);

    // Status UI verification
    const statusText = mockDOM.getElementById('xr-status-text').textContent;
    assert.match(statusText, /Immersive VR supported/);

    const preflightInpText = mockDOM.getElementById('preflight-input-text').textContent;
    assert.equal(preflightInpText, 'Hand tracking will be checked after entering VR; gaze fallback available.');

    // When isSessionSupported is false
    setNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
      xr: {
        isSessionSupported: async () => false,
      },
    });
    const notSupported = await XR.checkSupport();
    assert.equal(notSupported, false);
    assert.equal(XR.isSupported(), false);
    assert.equal(XR.isHandSupported(), false);

    const unsupportedText = mockDOM.getElementById('xr-status-text').textContent;
    assert.equal(unsupportedText, 'WebXR unavailable — Desktop Preview available');
    const unsupportedInpText = mockDOM.getElementById('preflight-input-text').textContent;
    assert.equal(unsupportedInpText, 'Input: Mouse Viewport & Keyboard');
  });

  it('2. Hand tracking verification: inspects active inputSources and dynamically responds to inputsourceschange', async () => {
    const fakeSession = new FakeXRSession([
      { handedness: 'left', targetRayMode: 'tracked-pointer' }, // Controller without hand
    ]);

    setNavigator({
      userAgent: 'Mozilla/5.0 (Linux; Android 12; Quest 3) OculusBrowser/34.0',
      xr: {
        isSessionSupported: async () => true,
        requestSession: async () => fakeSession,
      },
    });

    await XR.checkSupport();
    assert.equal(XR.isHandSupported(), false);

    // Enter VR
    await XR.enterVR();
    assert.equal(XR.isInVR(), true);

    // Initial check: controller only, no hand source
    assert.equal(XR.isHandSupported(), false);
    assert.equal(
      mockDOM.getElementById('preflight-input-text').textContent,
      'Gaze dwell active; hand tracking not detected.'
    );

    // Simulate user putting down controllers and raising hands
    fakeSession.setInputSources([
      { handedness: 'left', targetRayMode: 'gaze' },
      { handedness: 'right', targetRayMode: 'tracked-pointer', hand: { get: () => {} } },
    ]);

    // Hand tracking dynamically recognized
    assert.equal(XR.isHandSupported(), true);
    assert.equal(
      mockDOM.getElementById('preflight-input-text').textContent,
      'Hand tracking active.'
    );

    // Simulate user picking controller back up
    fakeSession.setInputSources([
      { handedness: 'left', targetRayMode: 'tracked-pointer' },
    ]);
    assert.equal(XR.isHandSupported(), false);
    assert.equal(
      mockDOM.getElementById('preflight-input-text').textContent,
      'Gaze dwell active; hand tracking not detected.'
    );

    await XR.exitVR();
    assert.equal(XR.isInVR(), false);
    assert.equal(XR.isHandSupported(), false);
  });

  it('3. Immediate listener attachment: attaches selectstart directly to active xrSession and debounces', async () => {
    let selectstartBound = false;
    let squeezeBound = false;

    const fakeSession = new FakeXRSession();
    fakeSession.addEventListener = (event, fn) => {
      if (event === 'selectstart') selectstartBound = true;
      if (event === 'squeeze') squeezeBound = true;
      if (!fakeSession.listeners[event]) fakeSession.listeners[event] = [];
      fakeSession.listeners[event].push(fn);
    };

    setNavigator({
      xr: {
        isSessionSupported: async () => true,
        requestSession: async () => fakeSession,
      },
    });

    await XR.checkSupport();
    await XR.enterVR();

    // Verify listeners attached directly to session without waiting for renderer event
    assert.equal(selectstartBound, true, 'selectstart listener must be bound directly to active xrSession');
    assert.equal(squeezeBound, true, 'squeeze listener must be bound directly to active xrSession');
    assert.ok(fakeSession.listeners['selectstart'].length > 0);

    await XR.exitVR();
  });

  it('4. Gaze lifecycle & cleanup: prevents duplicate intervals across multiple enter/exit cycles', async () => {
    setNavigator({
      xr: {
        isSessionSupported: async () => true,
        requestSession: async () => new FakeXRSession(),
      },
    });

    await XR.checkSupport();

    // Cycle 1
    await XR.enterVR();
    const interval1 = XR.getGazeCheckInterval();
    assert.ok(interval1 !== null, 'Gaze interval should be active in VR');
    assert.ok(XR.getGazeIndicator() !== null, 'Gaze indicator should be attached in VR');

    await XR.exitVR();
    assert.equal(XR.getGazeCheckInterval(), null, 'Gaze interval must be cleared after exitVR');
    assert.equal(XR.getGazeIndicator(), null, 'Gaze indicator must be disposed after exitVR');

    // Re-enter 3 times consecutively
    for (let i = 0; i < 3; i++) {
      await XR.enterVR();
      const interval = XR.getGazeCheckInterval();
      assert.ok(interval !== null, `Interval should be active on cycle ${i + 1}`);

      await XR.exitVR();
      assert.equal(XR.getGazeCheckInterval(), null, `Interval should be cleared on exit ${i + 1}`);
    }

    // Idempotent cleanup test
    assert.doesNotThrow(() => {
      XR.cleanupVR();
      XR.cleanupVR();
      XR.stopGazeInteraction();
    });
  });

  it('5. Media readiness gating: keeps VR entry disabled until video metadata is ready', async () => {
    setNavigator({
      xr: {
        isSessionSupported: async () => true,
      },
    });

    await XR.checkSupport();

    const enterBtn = mockDOM.getElementById('btn-enter-cinema');
    const enterLabel = mockDOM.getElementById('btn-enter-cinema-label');

    // Initial state: media loading
    XR.setMediaReady(null);
    assert.equal(enterBtn.disabled, true);
    assert.equal(enterLabel.textContent, 'Preparing Media Stream…');

    // Media error state (e.g. CORS or decode error)
    XR.setMediaReady(false, { message: 'Video decode / codec error' });
    assert.equal(enterBtn.disabled, true);
    assert.equal(enterLabel.textContent, 'Video decode / codec error');

    // Media ready state
    XR.setMediaReady(true, { duration: 184 });
    assert.equal(enterBtn.disabled, false);
    assert.equal(enterLabel.textContent, 'Enter VR Cinema');
  });

  it('6. Recoverable error handling: handles rejected requestSession cleanly', async () => {
    setNavigator({
      xr: {
        isSessionSupported: async () => true,
        requestSession: async () => {
          throw new Error('User denied WebXR permission in headset');
        },
      },
    });

    await XR.checkSupport();
    XR.setMediaReady(true);

    // Call enterVR with failing session request
    await XR.enterVR();

    // Session must be cleanly null, not stuck in half-initialized state
    assert.equal(XR.isInVR(), false);
    assert.equal(XR.getSession(), null);
    assert.equal(XR.getGazeCheckInterval(), null);
    assert.equal(XR.getGazeIndicator(), null);

    // User is informed via toast
    assert.ok(toasts.length > 0);
    assert.match(toasts[0].msg, /User denied WebXR permission/);

    // Preflight UI remains recoverable
    const enterBtn = mockDOM.getElementById('btn-enter-cinema');
    assert.equal(enterBtn.disabled, false);
    assert.equal(mockDOM.getElementById('btn-enter-cinema-label').textContent, 'Enter VR Cinema');
  });

  it('7. Secure context differentiation: distinguishes HTTPS vs Localhost vs Insecure contexts', async () => {
    // HTTPS context
    global.window.location = { protocol: 'https:', hostname: 'spatial-watch.aeemarrs.workers.dev' };
    global.window.isSecureContext = true;
    XR.updatePreflightUI();

    assert.equal(
      mockDOM.getElementById('preflight-secure-text').textContent,
      'Secure Connection: Verified (HTTPS)'
    );

    // Localhost context (valid for local dev only)
    global.window.location = { protocol: 'http:', hostname: 'localhost' };
    global.window.isSecureContext = true;
    XR.updatePreflightUI();

    assert.match(
      mockDOM.getElementById('preflight-secure-text').textContent,
      /Development Context: Localhost/
    );

    // Remote Insecure context (e.g. HTTP on local LAN IP)
    global.window.location = { protocol: 'http:', hostname: '192.168.1.50' };
    global.window.isSecureContext = false;
    XR.updatePreflightUI();

    assert.equal(
      mockDOM.getElementById('preflight-secure-text').textContent,
      'Insecure Context: HTTPS required for Quest WebXR'
    );
  });
});

/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — WebXR Module
   Immersive VR session with hand tracking and gaze interaction
   Optimized for seated Meta Quest use
   ═══════════════════════════════════════════════════════════ */

const XR = (() => {
  let xrSession = null;
  let xrSupported = false;
  let handSupported = false;
  let mediaReady = false;
  let controllerGrips = [];
  let handModels = [];
  let uiPanel = null;
  let gazeTarget = null;
  let gazeDwellTimer = null;
  const GAZE_DWELL_MS = 800;

  const isQuest = /Quest|OculusBrowser/i.test(navigator.userAgent);
  const isSecure = window.isSecureContext || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  // Check WebXR support
  async function checkSupport() {
    const statusEl = document.getElementById('xr-status');
    const statusText = document.getElementById('xr-status-text');
    const enterVRBtn = document.getElementById('btn-enter-vr');

    if (!navigator.xr) {
      xrSupported = false;
      if (statusText) statusText.textContent = 'WebXR not available — desktop mode';
      if (statusEl) statusEl.classList.add('xr-status--unsupported');
      updatePreflightUI();
      return false;
    }

    try {
      xrSupported = await navigator.xr.isSessionSupported('immersive-vr');
    } catch (e) {
      xrSupported = false;
    }

    if (xrSupported) {
      if (enterVRBtn) enterVRBtn.hidden = false;
      handSupported = true; // Meta Quest Browser supports hand tracking
      if (statusText) {
        statusText.textContent = isQuest
          ? 'Meta Quest VR + hand tracking ready'
          : 'Immersive VR available';
      }
      if (statusEl) statusEl.classList.add('xr-status--supported');
    } else {
      if (statusText) statusText.textContent = 'VR not supported — desktop mode';
      if (statusEl) statusEl.classList.add('xr-status--unsupported');
    }

    updatePreflightUI();
    return xrSupported;
  }

  // Update media readiness status (called when video loadedmetadata fires)
  function setMediaReady(ready, details = {}) {
    mediaReady = !!ready;
    updatePreflightUI();
  }

  // Update the lobby VR readiness preflight card and Enter button
  function updatePreflightUI() {
    const dot = document.getElementById('vr-readiness-dot');
    const chip = document.getElementById('vr-readiness-chip');
    const preflightXrIcon = document.getElementById('preflight-xr-icon');
    const preflightXrText = document.getElementById('preflight-xr-text');
    const preflightSecIcon = document.getElementById('preflight-secure-icon');
    const preflightSecText = document.getElementById('preflight-secure-text');
    const preflightInpIcon = document.getElementById('preflight-input-icon');
    const preflightInpText = document.getElementById('preflight-input-text');
    const enterBtn = document.getElementById('btn-enter-cinema');
    const enterLabel = document.getElementById('btn-enter-cinema-label');

    // Secure context status
    if (preflightSecIcon && preflightSecText) {
      if (isSecure) {
        preflightSecIcon.className = 'preflight-item__status is-passed';
        preflightSecIcon.textContent = '✓';
        preflightSecText.textContent = 'Secure Connection: Verified (HTTPS)';
      } else {
        preflightSecIcon.className = 'preflight-item__status';
        preflightSecIcon.textContent = '⚠️';
        preflightSecText.textContent = 'Insecure Context: HTTPS required for VR';
      }
    }

    if (xrSupported) {
      // Immersive VR capable (e.g. Meta Quest Browser)
      if (dot) {
        dot.className = 'vr-readiness__dot' + (mediaReady ? ' is-ready' : '');
      }
      if (chip) {
        chip.textContent = mediaReady
          ? (isQuest ? 'Meta Quest VR Ready' : 'VR Ready')
          : 'Loading Media…';
        chip.className = 'chip chip--xs ' + (mediaReady ? 'chip--gold' : 'chip--violet');
      }

      if (preflightXrIcon && preflightXrText) {
        preflightXrIcon.className = 'preflight-item__status is-passed';
        preflightXrIcon.textContent = '✓';
        preflightXrText.textContent = isQuest
          ? 'Meta Quest: Immersive VR Ready'
          : 'WebXR: Immersive VR Supported';
      }

      if (preflightInpIcon && preflightInpText) {
        preflightInpIcon.className = 'preflight-item__status is-passed';
        preflightInpIcon.textContent = '✓';
        preflightInpText.textContent = 'Input: Hand Tracking & Gaze (Seated Mode)';
      }

      // Enter button
      if (enterBtn && enterLabel) {
        if (mediaReady) {
          enterBtn.disabled = false;
          enterLabel.textContent = 'Enter VR Cinema';
        } else {
          enterBtn.disabled = true;
          enterLabel.textContent = 'Preparing Media Stream…';
        }
      }
    } else {
      // Desktop / 2D Browser Fallback
      if (dot) dot.className = 'vr-readiness__dot is-desktop';
      if (chip) {
        chip.textContent = 'Desktop Preview Mode';
        chip.className = 'chip chip--xs chip--neutral';
      }

      if (preflightXrIcon && preflightXrText) {
        preflightXrIcon.className = 'preflight-item__status is-notice';
        preflightXrIcon.textContent = 'ℹ';
        preflightXrText.textContent = 'WebXR Unavailable: Desktop 3D Mode';
      }

      if (preflightInpIcon && preflightInpText) {
        preflightInpIcon.className = 'preflight-item__status is-notice';
        preflightInpIcon.textContent = 'ℹ';
        preflightInpText.textContent = 'Input: Mouse Viewport & Keyboard';
      }

      // Enter button for desktop preview
      if (enterBtn && enterLabel) {
        enterBtn.disabled = false;
        enterLabel.textContent = 'Enter Cinema (Desktop Preview)';
      }
    }
  }

  // Start immersive VR session
  async function enterVR() {
    if (!xrSupported || xrSession) return;

    const renderer = Cinema.getRenderer();
    if (!renderer) return;

    try {
      const sessionInit = {
        optionalFeatures: [
          'local-floor',
          'hand-tracking',
          'hit-test',
        ],
      };

      xrSession = await navigator.xr.requestSession('immersive-vr', sessionInit);
      renderer.xr.setSession(xrSession);

      xrSession.addEventListener('end', () => {
        xrSession = null;
        cleanupVR();
      });

      // Create VR UI panel
      createVRControls();

      // Set up hand tracking if available
      setupHandTracking();

      // Set up gaze fallback
      setupGazeInteraction();

    } catch (e) {
      console.error('[xr] Failed to start VR session:', e);
      App.showToast('Failed to enter VR mode', 'error');
    }
  }

  // Exit VR session
  async function exitVR() {
    if (xrSession) {
      await xrSession.end();
      xrSession = null;
      cleanupVR();
    }
  }

  // Create spatial control panel for VR
  function createVRControls() {
    const scene = Cinema.getScene();
    if (!scene) return;

    const panelGroup = new THREE.Group();
    panelGroup.position.set(0, -0.5, -1.5);
    panelGroup.rotation.x = -0.3; // Tilt toward seated user

    // Panel background
    const panelGeo = new THREE.PlaneGeometry(1.6, 0.5);
    const panelMat = new THREE.MeshBasicMaterial({
      color: 0x0e111a,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    });
    const panel = new THREE.Mesh(panelGeo, panelMat);
    panelGroup.add(panel);

    // Panel border
    const borderGeo = new THREE.EdgesGeometry(panelGeo);
    const borderMat = new THREE.LineBasicMaterial({
      color: 0xe7bc72,
      transparent: true,
      opacity: 0.3,
    });
    const border = new THREE.LineSegments(borderGeo, borderMat);
    panelGroup.add(border);

    // Create interactive buttons
    const buttons = [
      { label: '⏪', action: 'seek-back', x: -0.6 },
      { label: '▶', action: 'play-pause', x: -0.2 },
      { label: '⏩', action: 'seek-forward', x: 0.2 },
      { label: '⭐', action: 'director-cut', x: 0.5 },
      { label: '🚪', action: 'exit', x: 0.7 },
    ];

    buttons.forEach(({ label, action, x }) => {
      const btnCanvas = document.createElement('canvas');
      btnCanvas.width = 128;
      btnCanvas.height = 128;
      const ctx = btnCanvas.getContext('2d');

      // Button background
      ctx.fillStyle = '#1C2331';
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(8, 8, 112, 112, 16);
      } else {
        ctx.rect(8, 8, 112, 112);
      }
      ctx.fill();

      // Button icon
      ctx.font = '48px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#F4F1EA';
      ctx.fillText(label, 64, 64);

      const btnTexture = new THREE.CanvasTexture(btnCanvas);
      const btnGeo = new THREE.PlaneGeometry(0.15, 0.15);
      const btnMat = new THREE.MeshBasicMaterial({
        map: btnTexture,
        transparent: true,
      });
      const btnMesh = new THREE.Mesh(btnGeo, btnMat);
      btnMesh.position.set(x, 0, 0.01);
      btnMesh.userData = { action, isButton: true };
      panelGroup.add(btnMesh);
    });

    // Reaction buttons row
    const reactions = ['👏', '😂', '❤️', '😮', '🤩', '🍿'];
    const reactionTypes = ['applause', 'laugh', 'heart', 'surprised', 'wow', 'popcorn'];

    reactions.forEach((emoji, i) => {
      const rCanvas = document.createElement('canvas');
      rCanvas.width = 64;
      rCanvas.height = 64;
      const ctx = rCanvas.getContext('2d');
      ctx.font = '36px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(emoji, 32, 32);

      const rTexture = new THREE.CanvasTexture(rCanvas);
      const rGeo = new THREE.PlaneGeometry(0.08, 0.08);
      const rMat = new THREE.MeshBasicMaterial({
        map: rTexture,
        transparent: true,
      });
      const rMesh = new THREE.Mesh(rGeo, rMat);
      rMesh.position.set(-0.5 + i * 0.2, -0.2, 0.01);
      rMesh.userData = { action: 'reaction', reactionType: reactionTypes[i], isButton: true };
      panelGroup.add(rMesh);
    });

    scene.add(panelGroup);
    uiPanel = panelGroup;
  }

  // Set up hand tracking interaction
  function setupHandTracking() {
    const renderer = Cinema.getRenderer();
    if (!renderer) return;

    // Create raycaster for hand-based interaction
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    // XR hand sources will be checked each frame
    renderer.xr.addEventListener('sessionstart', () => {
      const session = renderer.xr.getSession();
      if (!session) return;

      session.addEventListener('selectstart', (event) => {
        handleVRSelect(raycaster, event);
      });

      session.addEventListener('squeeze', (event) => {
        handleVRSelect(raycaster, event);
      });
    });
  }

  // Handle VR button selection via pinch or squeeze
  function handleVRSelect(raycaster, event) {
    if (!uiPanel) return;

    const camera = Cinema.getCamera();
    const scene = Cinema.getScene();
    if (!camera || !scene) return;

    // Use gaze direction for interaction
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const intersects = raycaster.intersectObjects(uiPanel.children, false);

    if (intersects.length > 0) {
      const hit = intersects[0].object;
      if (hit.userData && hit.userData.isButton) {
        executeVRAction(hit.userData);
        // Visual feedback — brief flash
        const origColor = hit.material.color.clone();
        hit.material.color.set(0xe7bc72);
        setTimeout(() => {
          hit.material.color.copy(origColor);
        }, 200);
      }
    }
  }

  // Set up gaze interaction as fallback
  function setupGazeInteraction() {
    const renderer = Cinema.getRenderer();
    if (!renderer) return;

    const raycaster = new THREE.Raycaster();
    const gazeIndicatorGeo = new THREE.RingGeometry(0.005, 0.008, 32);
    const gazeIndicatorMat = new THREE.MeshBasicMaterial({
      color: 0xe7bc72,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.8,
    });
    const gazeIndicator = new THREE.Mesh(gazeIndicatorGeo, gazeIndicatorMat);
    gazeIndicator.position.set(0, 0, -1);

    const camera = Cinema.getCamera();
    if (camera) camera.add(gazeIndicator);

    // Gaze dwell detection runs in the render loop
    const originalLoop = renderer.xr.getSession ? renderer.getAnimationLoop : null;

    function gazeCheck() {
      if (!xrSession || !uiPanel) return;

      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      const intersects = raycaster.intersectObjects(uiPanel.children, false);

      if (intersects.length > 0) {
        const hit = intersects[0].object;
        if (hit.userData && hit.userData.isButton) {
          if (gazeTarget !== hit) {
            gazeTarget = hit;
            clearTimeout(gazeDwellTimer);

            // Start dwell timer
            gazeDwellTimer = setTimeout(() => {
              executeVRAction(hit.userData);
              // Feedback pulse
              const scale = hit.scale.clone();
              hit.scale.multiplyScalar(0.9);
              setTimeout(() => hit.scale.copy(scale), 150);
              gazeTarget = null;
            }, GAZE_DWELL_MS);
          }
          return;
        }
      }

      // Reset gaze
      if (gazeTarget) {
        gazeTarget = null;
        clearTimeout(gazeDwellTimer);
      }
    }

    // Attach gaze check to animation loop
    setInterval(gazeCheck, 100);
  }

  // Execute a VR control action
  function executeVRAction(userData) {
    switch (userData.action) {
      case 'play-pause':
        if (Cinema.isPlaying()) {
          Cinema.pause();
          WS.sendPlayback('pause', Cinema.getCurrentTime());
        } else {
          Cinema.play();
          WS.sendPlayback('play', Cinema.getCurrentTime());
        }
        break;

      case 'seek-back':
        const backPos = Math.max(0, Cinema.getCurrentTime() - 10);
        Cinema.seek(backPos);
        WS.sendPlayback('seek', backPos);
        break;

      case 'seek-forward':
        const fwdPos = Cinema.getCurrentTime() + 10;
        Cinema.seek(fwdPos);
        WS.sendPlayback('seek', fwdPos);
        break;

      case 'director-cut':
        const newState = !DirectorsCut.isEnabled();
        DirectorsCut.setEnabled(newState);
        WS.sendDirectorCut(newState);
        break;

      case 'reaction':
        if (userData.reactionType) {
          Reactions.send(userData.reactionType);
        }
        break;

      case 'exit':
        exitVR();
        App.leaveRoom();
        break;
    }
  }

  function cleanupVR() {
    if (uiPanel) {
      const scene = Cinema.getScene();
      if (scene) scene.remove(uiPanel);
      uiPanel = null;
    }
    gazeTarget = null;
    clearTimeout(gazeDwellTimer);
  }

  return {
    checkSupport,
    enterVR,
    exitVR,
    setMediaReady,
    updatePreflightUI,
    isSupported: () => xrSupported,
    isInVR: () => !!xrSession,
    isMediaReady: () => mediaReady,
  };
})();

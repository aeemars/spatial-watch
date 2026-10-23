/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — WebXR Module
   Immersive VR session with verified hand tracking & gaze fallback
   Optimized for seated Meta Quest use
   ═══════════════════════════════════════════════════════════ */

const XR = (() => {
  let xrSession = null;
  let xrSupported = false;
  let handSupported = false;
  let mediaReady = null;
  let mediaErrorDetails = null;
  let uiPanel = null;
  let gazeTarget = null;
  let gazeDwellTimer = null;
  let gazeCheckInterval = null;
  let gazeIndicator = null;
  let lastActionTimestamp = 0;
  let sourcesChangeHandler = null;
  let sessionEndHandler = null;

  const GAZE_DWELL_MS = 800;

  function getNavigator() {
    return typeof navigator !== 'undefined' ? navigator : null;
  }

  function getWindow() {
    return typeof window !== 'undefined' ? window : null;
  }

  function getDocument() {
    return typeof document !== 'undefined' ? document : null;
  }

  function isQuestBrowser() {
    const nav = getNavigator();
    return Boolean(nav && /Quest|OculusBrowser/i.test(nav.userAgent || ''));
  }

  function checkSecureContext() {
    const win = getWindow();
    if (!win || !win.location) {
      return { isSecure: true, isHttps: true, isLocalhost: false };
    }
    const isHttps = win.location.protocol === 'https:';
    const isLocalhost = win.location.hostname === 'localhost' || win.location.hostname === '127.0.0.1';
    const isQuest = isQuestBrowser();
    // Quest production requires HTTPS; localhost is valid only for local development on the same device
    const isSecure = Boolean(win.isSecureContext || (isLocalhost && !isQuest));
    return { isSecure, isHttps, isLocalhost };
  }

  // Check WebXR immersive-vr capability (does not assume hands are available)
  async function checkSupport() {
    const doc = getDocument();
    const nav = getNavigator();

    const statusEl = doc ? doc.getElementById('xr-status') : null;
    const statusText = doc ? doc.getElementById('xr-status-text') : null;
    const enterVRBtn = doc ? doc.getElementById('btn-enter-vr') : null;
    const isQuest = isQuestBrowser();

    if (!nav || !nav.xr || typeof nav.xr.isSessionSupported !== 'function') {
      xrSupported = false;
      handSupported = false;
      if (statusText) statusText.textContent = 'WebXR unavailable — Desktop Preview available';
      if (statusEl) {
        statusEl.classList.remove('xr-status--supported');
        statusEl.classList.add('xr-status--unsupported');
      }
      updatePreflightUI();
      return false;
    }

    try {
      xrSupported = await nav.xr.isSessionSupported('immersive-vr');
    } catch (e) {
      xrSupported = false;
    }

    // Hand tracking availability must only be verified after the session is created
    handSupported = false;

    if (xrSupported) {
      if (enterVRBtn) enterVRBtn.hidden = false;
      if (statusText) {
        statusText.textContent = isQuest
          ? 'Immersive VR supported (Meta Quest detected)'
          : 'Immersive VR supported';
      }
      if (statusEl) {
        statusEl.classList.remove('xr-status--unsupported');
        statusEl.classList.add('xr-status--supported');
      }
    } else {
      if (statusText) statusText.textContent = 'WebXR unavailable — Desktop Preview available';
      if (statusEl) {
        statusEl.classList.remove('xr-status--supported');
        statusEl.classList.add('xr-status--unsupported');
      }
    }

    updatePreflightUI();
    return xrSupported;
  }

  // Refresh hand tracking capability by inspecting actual active input sources
  function refreshInputCapabilities() {
    if (xrSession && xrSession.inputSources) {
      const sources = Array.from(xrSession.inputSources);
      handSupported = sources.some(source => !!source && !!source.hand);
    } else {
      handSupported = false;
    }
    updatePreflightUI();
  }

  // Update media readiness status (called when video loadedmetadata fires or error occurs)
  function setMediaReady(ready, details = {}) {
    mediaReady = ready === true ? true : (ready === false ? false : null);
    mediaErrorDetails = details || null;
    updatePreflightUI();
  }

  // Update the lobby VR readiness preflight card and Enter button
  function updatePreflightUI() {
    const doc = getDocument();
    if (!doc) return;

    const dot = doc.getElementById('vr-readiness-dot');
    const chip = doc.getElementById('vr-readiness-chip');
    const preflightXrIcon = doc.getElementById('preflight-xr-icon');
    const preflightXrText = doc.getElementById('preflight-xr-text');
    const preflightSecIcon = doc.getElementById('preflight-secure-icon');
    const preflightSecText = doc.getElementById('preflight-secure-text');
    const preflightInpIcon = doc.getElementById('preflight-input-icon');
    const preflightInpText = doc.getElementById('preflight-input-text');
    const enterBtn = doc.getElementById('btn-enter-cinema');
    const enterLabel = doc.getElementById('btn-enter-cinema-label');

    const isQuest = isQuestBrowser();
    const { isSecure, isHttps, isLocalhost } = checkSecureContext();

    // 1. Secure context status
    if (preflightSecIcon && preflightSecText) {
      if (isHttps) {
        preflightSecIcon.className = 'preflight-item__status is-passed';
        preflightSecIcon.textContent = '✓';
        preflightSecText.textContent = 'Secure Connection: Verified (HTTPS)';
      } else if (isLocalhost) {
        preflightSecIcon.className = 'preflight-item__status is-notice';
        preflightSecIcon.textContent = 'ℹ';
        preflightSecText.textContent = 'Development Context: Localhost (Same-device only; Quest requires HTTPS or HTTPS tunnel)';
      } else {
        preflightSecIcon.className = 'preflight-item__status is-failed';
        preflightSecIcon.textContent = '⚠️';
        preflightSecText.textContent = 'Insecure Context: HTTPS required for Quest WebXR';
      }
    }

    // 2. WebXR support status
    if (preflightXrIcon && preflightXrText) {
      if (xrSupported) {
        preflightXrIcon.className = 'preflight-item__status is-passed';
        preflightXrIcon.textContent = '✓';
        preflightXrText.textContent = isQuest
          ? 'Immersive VR supported (Meta Quest detected)'
          : 'Immersive VR supported';
      } else {
        preflightXrIcon.className = 'preflight-item__status is-notice';
        preflightXrIcon.textContent = 'ℹ';
        preflightXrText.textContent = 'WebXR unavailable — Desktop Preview available';
      }
    }

    // 3. Input status (accurate lifecycle text)
    if (preflightInpIcon && preflightInpText) {
      if (xrSession) {
        if (handSupported) {
          preflightInpIcon.className = 'preflight-item__status is-passed';
          preflightInpIcon.textContent = '✓';
          preflightInpText.textContent = 'Hand tracking active.';
        } else {
          preflightInpIcon.className = 'preflight-item__status is-notice';
          preflightInpIcon.textContent = 'ℹ';
          preflightInpText.textContent = 'Gaze dwell active; hand tracking not detected.';
        }
      } else if (xrSupported) {
        preflightInpIcon.className = 'preflight-item__status is-passed';
        preflightInpIcon.textContent = '✓';
        preflightInpText.textContent = 'Hand tracking will be checked after entering VR; gaze fallback available.';
      } else {
        preflightInpIcon.className = 'preflight-item__status is-notice';
        preflightInpIcon.textContent = 'ℹ';
        preflightInpText.textContent = 'Input: Mouse Viewport & Keyboard';
      }
    }

    // 4. Dot indicator
    if (dot) {
      if (xrSupported) {
        dot.className = 'vr-readiness__dot' + (mediaReady === true ? ' is-ready' : '');
      } else {
        dot.className = 'vr-readiness__dot is-desktop' + (mediaReady === true ? ' is-ready' : '');
      }
    }

    // 5. Readiness Chip
    if (chip) {
      if (mediaReady === true) {
        if (xrSupported) {
          chip.textContent = isQuest ? 'VR Ready (Meta Quest)' : 'VR Ready';
          chip.className = 'chip chip--xs chip--gold';
        } else {
          chip.textContent = 'Desktop Preview Ready';
          chip.className = 'chip chip--xs chip--neutral';
        }
      } else if (mediaReady === false) {
        chip.textContent = 'Media Stream Error';
        chip.className = 'chip chip--xs chip--danger';
      } else {
        chip.textContent = 'Preparing Media Stream…';
        chip.className = 'chip chip--xs chip--violet';
      }
    }

    // 6. Enter Cinema / Enter VR Button
    if (enterBtn && enterLabel) {
      if (xrSupported) {
        if (mediaReady === true) {
          enterBtn.disabled = false;
          enterLabel.textContent = 'Enter VR Cinema';
        } else if (mediaReady === false) {
          enterBtn.disabled = true;
          const msg = (mediaErrorDetails && mediaErrorDetails.message)
            ? mediaErrorDetails.message
            : 'Media Stream Error — Check File / CORS';
          enterLabel.textContent = msg;
        } else {
          enterBtn.disabled = true;
          enterLabel.textContent = 'Preparing Media Stream…';
        }
      } else {
        // Desktop 2D mode
        if (mediaReady === true) {
          enterBtn.disabled = false;
          enterLabel.textContent = 'Enter Cinema (Desktop Preview)';
        } else if (mediaReady === false) {
          enterBtn.disabled = true;
          const msg = (mediaErrorDetails && mediaErrorDetails.message)
            ? mediaErrorDetails.message
            : 'Media Stream Error — Check File / CORS';
          enterLabel.textContent = msg;
        } else {
          enterBtn.disabled = true;
          enterLabel.textContent = 'Preparing Media Stream…';
        }
      }
    }
  }

  // Start immersive VR session
  async function enterVR() {
    if (!xrSupported || xrSession) return;

    const nav = getNavigator();
    if (!nav || !nav.xr) return;

    const renderer = (typeof Cinema !== 'undefined' && Cinema.getRenderer) ? Cinema.getRenderer() : null;
    if (!renderer) return;

    try {
      const sessionInit = {
        optionalFeatures: [
          'local-floor',
          'hand-tracking',
          'hit-test',
        ],
      };

      const session = await nav.xr.requestSession('immersive-vr', sessionInit);
      xrSession = session;

      if (renderer.xr && typeof renderer.xr.setSession === 'function') {
        renderer.xr.setSession(xrSession);
      }

      // Attach input listeners directly to the active session immediately
      setupXRInputHandlers(xrSession);
      refreshInputCapabilities();

      sourcesChangeHandler = () => refreshInputCapabilities();
      sessionEndHandler = () => {
        handleSessionEnd();
      };

      xrSession.addEventListener('inputsourceschange', sourcesChangeHandler);
      xrSession.addEventListener('end', sessionEndHandler);

      // Create VR UI panel
      createVRControls();

      // Set up gaze fallback
      setupGazeInteraction();

    } catch (e) {
      console.error('[xr] Failed to start VR session:', e);
      cleanupVR();
      xrSession = null;
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('Failed to enter VR mode: ' + (e.message || 'Session rejected or unavailable'), 'error');
      }
      updatePreflightUI();
    }
  }

  function handleSessionEnd() {
    xrSession = null;
    cleanupVR();
  }

  // Exit VR session
  async function exitVR() {
    if (xrSession) {
      const session = xrSession;
      xrSession = null;
      try {
        await session.end();
      } catch (e) {
        console.warn('[xr] Error ending XR session:', e);
      }
    }
    cleanupVR();
  }

  // Attach input handlers directly to newly created XR session
  function setupXRInputHandlers(session) {
    if (!session || typeof session.addEventListener !== 'function') return;

    const raycaster = (typeof THREE !== 'undefined' && THREE.Raycaster) ? new THREE.Raycaster() : null;

    const onSelectStart = (event) => {
      const now = Date.now();
      if (now - lastActionTimestamp < 350) return; // Debounce to prevent duplicate activations
      lastActionTimestamp = now;
      handleVRSelect(raycaster, event);
    };

    const onSqueeze = (event) => {
      const now = Date.now();
      if (now - lastActionTimestamp < 350) return; // Prevent duplicate triggers if both fire
      lastActionTimestamp = now;
      handleVRSelect(raycaster, event);
    };

    session.addEventListener('selectstart', onSelectStart);
    session.addEventListener('squeeze', onSqueeze);
  }

  // Create spatial control panel for VR
  function createVRControls() {
    if (typeof THREE === 'undefined') return;
    const scene = (typeof Cinema !== 'undefined' && Cinema.getScene) ? Cinema.getScene() : null;
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

    const doc = getDocument();

    buttons.forEach(({ label, action, x }) => {
      if (!doc) return;
      const btnCanvas = doc.createElement('canvas');
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
      if (!doc) return;
      const rCanvas = doc.createElement('canvas');
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

  // Handle VR button selection via pinch or squeeze
  function handleVRSelect(raycaster, event) {
    if (!uiPanel || !raycaster) return;

    const camera = (typeof Cinema !== 'undefined' && Cinema.getCamera) ? Cinema.getCamera() : null;
    const scene = (typeof Cinema !== 'undefined' && Cinema.getScene) ? Cinema.getScene() : null;
    if (!camera || !scene) return;

    // Standard Quest seated gaze-pinch interaction: raycast along camera forward vector (0, 0)
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const intersects = raycaster.intersectObjects(uiPanel.children, false);

    if (intersects.length > 0) {
      const hit = intersects[0].object;
      if (hit.userData && hit.userData.isButton) {
        executeVRAction(hit.userData);
        // Visual feedback — brief flash
        if (hit.material && hit.material.color) {
          const origColor = hit.material.color.clone();
          hit.material.color.set(0xe7bc72);
          setTimeout(() => {
            if (hit.material && hit.material.color) {
              hit.material.color.copy(origColor);
            }
          }, 200);
        }
      }
    }
  }

  // Stop gaze interaction loop and dispose of indicator objects
  function stopGazeInteraction() {
    if (gazeCheckInterval) {
      clearInterval(gazeCheckInterval);
      gazeCheckInterval = null;
    }

    if (gazeDwellTimer) {
      clearTimeout(gazeDwellTimer);
      gazeDwellTimer = null;
    }
    gazeTarget = null;

    if (gazeIndicator) {
      if (gazeIndicator.parent) {
        gazeIndicator.parent.remove(gazeIndicator);
      }
      if (gazeIndicator.geometry && typeof gazeIndicator.geometry.dispose === 'function') {
        gazeIndicator.geometry.dispose();
      }
      if (gazeIndicator.material && typeof gazeIndicator.material.dispose === 'function') {
        gazeIndicator.material.dispose();
      }
      gazeIndicator = null;
    }
  }

  // Set up gaze interaction as fallback
  function setupGazeInteraction() {
    // Clear any existing gaze interval, timer, and indicators first
    stopGazeInteraction();

    const renderer = (typeof Cinema !== 'undefined' && Cinema.getRenderer) ? Cinema.getRenderer() : null;
    if (!renderer || typeof THREE === 'undefined') return;

    const raycaster = new THREE.Raycaster();
    const gazeIndicatorGeo = new THREE.RingGeometry(0.005, 0.008, 32);
    const gazeIndicatorMat = new THREE.MeshBasicMaterial({
      color: 0xe7bc72,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.8,
    });
    gazeIndicator = new THREE.Mesh(gazeIndicatorGeo, gazeIndicatorMat);
    gazeIndicator.position.set(0, 0, -1);

    const camera = (typeof Cinema !== 'undefined' && Cinema.getCamera) ? Cinema.getCamera() : null;
    if (camera) camera.add(gazeIndicator);

    function gazeCheck() {
      if (!xrSession || !uiPanel) return;

      const currentCamera = (typeof Cinema !== 'undefined' && Cinema.getCamera) ? Cinema.getCamera() : null;
      if (!currentCamera) return;

      raycaster.setFromCamera(new THREE.Vector2(0, 0), currentCamera);
      const intersects = raycaster.intersectObjects(uiPanel.children, false);

      if (intersects.length > 0) {
        const hit = intersects[0].object;
        if (hit.userData && hit.userData.isButton) {
          if (gazeTarget !== hit) {
            gazeTarget = hit;
            if (gazeDwellTimer) clearTimeout(gazeDwellTimer);

            // Start dwell timer
            gazeDwellTimer = setTimeout(() => {
              executeVRAction(hit.userData);
              // Feedback pulse
              if (hit.scale) {
                const scale = hit.scale.clone();
                hit.scale.multiplyScalar(0.9);
                setTimeout(() => {
                  if (hit.scale) hit.scale.copy(scale);
                }, 150);
              }
              gazeTarget = null;
            }, GAZE_DWELL_MS);
          }
          return;
        }
      }

      // Reset gaze if looking away
      if (gazeTarget) {
        gazeTarget = null;
        if (gazeDwellTimer) {
          clearTimeout(gazeDwellTimer);
          gazeDwellTimer = null;
        }
      }
    }

    gazeCheckInterval = setInterval(gazeCheck, 100);
  }

  // Execute a VR control action with server-side host authorization preservation
  function executeVRAction(userData) {
    if (!userData || !userData.action) return;

    const isHost = typeof App !== 'undefined' && typeof App.isUserHost === 'function' ? App.isUserHost() : true;

    switch (userData.action) {
      case 'play-pause':
        if (!isHost) {
          if (typeof App !== 'undefined' && App.showToast) {
            App.showToast('Only the host can control screening playback', 'warning');
          }
          return;
        }
        if (typeof Cinema !== 'undefined') {
          if (Cinema.isPlaying()) {
            Cinema.pause();
            if (typeof WS !== 'undefined' && WS.sendPlayback) {
              WS.sendPlayback('pause', Cinema.getCurrentTime());
            }
          } else {
            Cinema.play();
            if (typeof WS !== 'undefined' && WS.sendPlayback) {
              WS.sendPlayback('play', Cinema.getCurrentTime());
            }
          }
        }
        break;

      case 'seek-back':
        if (!isHost) {
          if (typeof App !== 'undefined' && App.showToast) {
            App.showToast('Only the host can seek playback', 'warning');
          }
          return;
        }
        if (typeof Cinema !== 'undefined') {
          const backPos = Math.max(0, Cinema.getCurrentTime() - 10);
          Cinema.seek(backPos);
          if (typeof WS !== 'undefined' && WS.sendPlayback) {
            WS.sendPlayback('seek', backPos);
          }
        }
        break;

      case 'seek-forward':
        if (!isHost) {
          if (typeof App !== 'undefined' && App.showToast) {
            App.showToast('Only the host can seek playback', 'warning');
          }
          return;
        }
        if (typeof Cinema !== 'undefined') {
          const fwdPos = Cinema.getCurrentTime() + 10;
          Cinema.seek(fwdPos);
          if (typeof WS !== 'undefined' && WS.sendPlayback) {
            WS.sendPlayback('seek', fwdPos);
          }
        }
        break;

      case 'director-cut':
        if (!isHost) {
          if (typeof App !== 'undefined' && App.showToast) {
            App.showToast('Only the host can toggle Director’s Cut', 'warning');
          }
          return;
        }
        if (typeof DirectorsCut !== 'undefined') {
          const newState = !DirectorsCut.isEnabled();
          DirectorsCut.setEnabled(newState);
          if (typeof WS !== 'undefined' && WS.sendDirectorCut) {
            WS.sendDirectorCut(newState);
          }
        }
        break;

      case 'reaction':
        if (userData.reactionType && typeof Reactions !== 'undefined' && Reactions.send) {
          Reactions.send(userData.reactionType);
        }
        break;

      case 'exit':
        exitVR();
        if (typeof App !== 'undefined' && App.leaveRoom) {
          App.leaveRoom();
        }
        break;
    }
  }

  // Idempotent cleanup of VR session state, gaze loops, indicators, and UI panel
  function cleanupVR() {
    stopGazeInteraction();

    if (uiPanel) {
      if (uiPanel.parent) {
        uiPanel.parent.remove(uiPanel);
      }
      uiPanel.traverse(child => {
        if (child.geometry && typeof child.geometry.dispose === 'function') {
          child.geometry.dispose();
        }
        if (child.material) {
          if (child.material.map && typeof child.material.map.dispose === 'function') {
            child.material.map.dispose();
          }
          if (typeof child.material.dispose === 'function') {
            child.material.dispose();
          }
        }
      });
      uiPanel = null;
    }

    if (xrSession) {
      try {
        if (sourcesChangeHandler) {
          xrSession.removeEventListener('inputsourceschange', sourcesChangeHandler);
        }
        if (sessionEndHandler) {
          xrSession.removeEventListener('end', sessionEndHandler);
        }
      } catch (_) {}
    }
    sourcesChangeHandler = null;
    sessionEndHandler = null;
    handSupported = false;

    updatePreflightUI();
  }

  return {
    checkSupport,
    enterVR,
    exitVR,
    setMediaReady,
    updatePreflightUI,
    refreshInputCapabilities,
    setupXRInputHandlers,
    setupGazeInteraction,
    stopGazeInteraction,
    cleanupVR,
    isSupported: () => xrSupported,
    isInVR: () => !!xrSession,
    isHandSupported: () => handSupported,
    isMediaReady: () => mediaReady,
    getSession: () => xrSession,
    getGazeCheckInterval: () => gazeCheckInterval,
    getGazeIndicator: () => gazeIndicator,
    getUIPanel: () => uiPanel,
  };
})();

if (typeof window !== 'undefined') {
  window.XR = XR;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = XR;
}

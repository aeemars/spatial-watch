/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — Cinema Scene
   Three.js-based virtual cinema with desktop fallback
   Lightweight geometry for standalone VR hardware
   ═══════════════════════════════════════════════════════════ */

const Cinema = (() => {
  let scene, camera, renderer, videoTexture, videoMesh;
  let video = null;
  let canvas = null;
  let isPlaying = false;
  let isHost = false;
  let animFrameId = null;

  // Participant seat markers
  const seatMarkers = {};
  const SEAT_POSITIONS = [
    { x: -3, y: -1.5, z: -2 },
    { x: -1.5, y: -1.5, z: -2.5 },
    { x: 0, y: -1.5, z: -3 },
    { x: 1.5, y: -1.5, z: -2.5 },
    { x: 3, y: -1.5, z: -2 },
    { x: -2.2, y: -1.5, z: -1 },
    { x: 2.2, y: -1.5, z: -1 },
  ];

  let isMediaReadyState = false;

  function init(mediaUrl, hostStatus, onReadyCallback, onErrorCallback) {
    isHost = hostStatus;
    canvas = document.getElementById('cinema-canvas');
    video = document.getElementById('cinema-video');

    if (!canvas || !video) return;

    // Reset error overlay
    hideMediaError();

    // Set up video with CORS and lifecycle hooks
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      isMediaReadyState = true;
      updateScreenDimensions();
      if (typeof onReadyCallback === 'function') onReadyCallback(video);
      if (window.XR && typeof XR.setMediaReady === 'function') {
        XR.setMediaReady(true, { duration: video.duration });
      }
    };

    video.onerror = (e) => {
      isMediaReadyState = false;
      console.warn('[cinema] video load error:', video.error);
      showMediaError(video.error);
      if (typeof onErrorCallback === 'function') onErrorCallback(video.error);
      if (window.XR && typeof XR.setMediaReady === 'function') {
        XR.setMediaReady(false);
      }
    };

    // If source changed, load it
    if (video.src !== mediaUrl) {
      video.src = mediaUrl;
      video.load();
    } else if (video.readyState >= 1) {
      // Already has metadata
      isMediaReadyState = true;
      if (typeof onReadyCallback === 'function') onReadyCallback(video);
      if (window.XR && typeof XR.setMediaReady === 'function') {
        XR.setMediaReady(true, { duration: video.duration });
      }
    }

    // Initialize Three.js
    if (typeof THREE === 'undefined') {
      console.error('[cinema] Three.js is not loaded');
      throw new Error('3D Cinema engine (Three.js) is not available');
    }

    video.loop = true;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050710);

    // Camera — seated VR position
    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0, 2);

    // Renderer
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.xr.enabled = true;

    // Build the theater
    buildTheater();

    // Create video screen
    createVideoScreen();

    // Lighting
    addLighting();

    // Handle resize
    window.addEventListener('resize', onResize);

    // Start render loop
    renderer.setAnimationLoop(animate);

    // Desktop mouse look
    if (!renderer.xr.isPresenting) {
      initDesktopControls();
    }
  }

  function buildTheater() {
    // Floor
    const floorGeo = new THREE.PlaneGeometry(30, 30);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x0a0d16,
      roughness: 0.9,
      metalness: 0.1,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2;
    scene.add(floor);

    // Back wall
    const wallGeo = new THREE.PlaneGeometry(30, 12);
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x0e111a,
      roughness: 0.95,
      metalness: 0.05,
    });
    const backWall = new THREE.Mesh(wallGeo, wallMat);
    backWall.position.set(0, 3, -8);
    scene.add(backWall);

    // Side walls
    const sideWallGeo = new THREE.PlaneGeometry(16, 12);
    const leftWall = new THREE.Mesh(sideWallGeo, wallMat.clone());
    leftWall.position.set(-10, 3, 0);
    leftWall.rotation.y = Math.PI / 2;
    scene.add(leftWall);

    const rightWall = new THREE.Mesh(sideWallGeo, wallMat.clone());
    rightWall.position.set(10, 3, 0);
    rightWall.rotation.y = -Math.PI / 2;
    scene.add(rightWall);

    // Ceiling
    const ceilingGeo = new THREE.PlaneGeometry(30, 30);
    const ceilingMat = new THREE.MeshStandardMaterial({
      color: 0x080a10,
      roughness: 1.0,
    });
    const ceiling = new THREE.Mesh(ceilingGeo, ceilingMat);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = 8;
    scene.add(ceiling);

    // Screen frame (gold border around video)
    const frameGeo = new THREE.BoxGeometry(9.4, 5.4, 0.15);
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x3d3020,
      roughness: 0.6,
      metalness: 0.4,
    });
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.position.set(0, 1.5, -7.15);
    scene.add(frame);
  }

  function createVideoScreen() {
    // Video texture
    videoTexture = new THREE.VideoTexture(video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;

    // Screen mesh (dynamic aspect ratio based on video metadata)
    let aspect = 16 / 9;
    if (video.videoWidth && video.videoHeight) {
      aspect = video.videoWidth / video.videoHeight;
    }
    const width = 9;
    const height = width / aspect;
    const screenGeo = new THREE.PlaneGeometry(width, height);
    const screenMat = new THREE.MeshBasicMaterial({
      map: videoTexture,
      side: THREE.FrontSide,
    });
    videoMesh = new THREE.Mesh(screenGeo, screenMat);
    videoMesh.position.set(0, 1.5, -7.05);
    scene.add(videoMesh);
  }

  function updateScreenDimensions() {
    if (!videoMesh || !video || !video.videoWidth || !video.videoHeight) return;
    const aspect = video.videoWidth / video.videoHeight;
    const width = 9;
    const height = width / aspect;
    if (videoMesh.geometry) videoMesh.geometry.dispose();
    videoMesh.geometry = new THREE.PlaneGeometry(width, height);
  }

  function preloadMedia(mediaUrl, onReady, onError) {
    video = document.getElementById('cinema-video');
    if (!video) return;

    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';

    const handleLoadedMetadata = () => {
      isMediaReadyState = true;
      if (typeof onReady === 'function') onReady(video);
      if (window.XR && typeof XR.setMediaReady === 'function') {
        XR.setMediaReady(true, { duration: video.duration });
      }
    };

    const handleError = () => {
      isMediaReadyState = false;
      if (typeof onError === 'function') onError(video.error);
      if (window.XR && typeof XR.setMediaReady === 'function') {
        XR.setMediaReady(false);
      }
    };

    video.onloadedmetadata = handleLoadedMetadata;
    video.onerror = handleError;

    if (video.src !== mediaUrl) {
      isMediaReadyState = false;
      video.src = mediaUrl;
      video.load();
    } else if (video.readyState >= 1) {
      handleLoadedMetadata();
    }
  }

  function showMediaError(errorDetails) {
    const overlay = document.getElementById('cinema-error-overlay');
    const msgEl = document.getElementById('cinema-error-message');
    const guidanceEl = document.getElementById('cinema-error-guidance');
    const backBtn = document.getElementById('btn-cinema-error-back');
    if (!overlay) return;

    let reason = 'The media file could not be loaded into the WebGL cinema screen.';
    let guidance = 'Common causes: The remote server is blocking Cross-Origin requests (CORS), the URL has expired, or the codec is incompatible. Direct HTTPS MP4 streams are required.';

    if (errorDetails) {
      if (errorDetails.code === 2) {
        reason = 'A network error occurred while streaming the media file.';
      } else if (errorDetails.code === 4) {
        reason = 'Video stream unreachable or blocked by CORS security headers.';
        guidance = 'The remote host did not provide an "Access-Control-Allow-Origin: *" header, or the file is not a standard H.264/AAC MP4. YouTube/Vimeo links cannot be played as direct WebGL textures.';
      }
    }

    if (msgEl) msgEl.textContent = reason;
    if (guidanceEl) guidanceEl.textContent = guidance;
    overlay.hidden = false;

    if (backBtn) {
      backBtn.onclick = () => {
        overlay.hidden = true;
        if (window.App && typeof App.showScreen === 'function') {
          App.showScreen('lobby');
        }
      };
    }
  }

  function hideMediaError() {
    const overlay = document.getElementById('cinema-error-overlay');
    if (overlay) overlay.hidden = true;
  }

  function addLighting() {
    // Warm ambient
    const ambient = new THREE.AmbientLight(0x1a1520, 0.3);
    scene.add(ambient);

    // Screen glow light
    const screenLight = new THREE.PointLight(0x8fa5d0, 0.8, 15);
    screenLight.position.set(0, 1.5, -5);
    scene.add(screenLight);

    // Warm accent lights (theater sconces)
    const goldLight1 = new THREE.PointLight(0xe7bc72, 0.15, 8);
    goldLight1.position.set(-8, 3, -3);
    scene.add(goldLight1);

    const goldLight2 = new THREE.PointLight(0xe7bc72, 0.15, 8);
    goldLight2.position.set(8, 3, -3);
    scene.add(goldLight2);

    // Subtle violet accent
    const violetLight = new THREE.PointLight(0x8f85d7, 0.05, 12);
    violetLight.position.set(0, 6, -4);
    scene.add(violetLight);
  }

  function addSeatMarker(participantId, displayName, seatIndex) {
    if (seatMarkers[participantId] || seatIndex >= SEAT_POSITIONS.length) return;

    const pos = SEAT_POSITIONS[seatIndex];

    // Simple glowing sphere marker
    const markerGeo = new THREE.SphereGeometry(0.2, 12, 12);
    const markerMat = new THREE.MeshStandardMaterial({
      color: 0xe7bc72,
      emissive: 0xe7bc72,
      emissiveIntensity: 0.3,
      roughness: 0.4,
      metalness: 0.6,
    });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.set(pos.x, pos.y + 0.8, pos.z);
    scene.add(marker);

    // Name label using a canvas texture
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 256;
    labelCanvas.height = 64;
    const ctx = labelCanvas.getContext('2d');
    if (ctx.roundRect) {
      ctx.roundRect(0, 0, 256, 64, 10);
    } else {
      ctx.rect(0, 0, 256, 64);
    }
    ctx.fillStyle = '#F4F1EA';
    ctx.font = '500 24px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayName.substring(0, 14), 128, 32);

    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    const labelGeo = new THREE.PlaneGeometry(1.2, 0.3);
    const labelMat = new THREE.MeshBasicMaterial({
      map: labelTexture,
      transparent: true,
    });
    const label = new THREE.Mesh(labelGeo, labelMat);
    label.position.set(pos.x, pos.y + 1.3, pos.z);
    scene.add(label);

    seatMarkers[participantId] = { marker, label };
  }

  function removeSeatMarker(participantId) {
    const entry = seatMarkers[participantId];
    if (!entry) return;
    scene.remove(entry.marker);
    scene.remove(entry.label);
    entry.marker.geometry.dispose();
    entry.marker.material.dispose();
    entry.label.geometry.dispose();
    entry.label.material.dispose();
    delete seatMarkers[participantId];
  }

  function initDesktopControls() {
    let isDragging = false;
    let prevX = 0, prevY = 0;
    let rotX = 0, rotY = 0;

    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      prevX = e.clientX;
      prevY = e.clientY;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - prevX;
      const dy = e.clientY - prevY;
      rotY -= dx * 0.003;
      rotX -= dy * 0.003;
      rotX = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, rotX));
      camera.rotation.set(rotX, rotY, 0);
      prevX = e.clientX;
      prevY = e.clientY;
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  function animate() {
    if (videoTexture && video && !video.paused) {
      videoTexture.needsUpdate = true;
    }
    renderer.render(scene, camera);
  }

  function onResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // Playback controls
  function play() {
    if (!video) return;
    video.play().catch(e => console.warn('[cinema] play failed:', e));
    isPlaying = true;
    updatePlayPauseIcon(true);
  }

  function pause() {
    if (!video) return;
    video.pause();
    isPlaying = false;
    updatePlayPauseIcon(false);
  }

  function seek(time) {
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(time, video.duration || 0));
  }

  function getCurrentTime() {
    return video ? video.currentTime : 0;
  }

  function getDuration() {
    return video ? (video.duration || 0) : 0;
  }

  function setSource(url) {
    if (!video) return;
    video.src = url;
    video.load();
  }

  function updatePlayPauseIcon(playing) {
    const iconPlay = document.querySelector('.icon-play');
    const iconPause = document.querySelector('.icon-pause');
    if (iconPlay) iconPlay.style.display = playing ? 'none' : 'block';
    if (iconPause) iconPause.style.display = playing ? 'block' : 'none';

    const btn = document.getElementById('btn-play-pause');
    if (btn) btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function getRenderer() {
    return renderer;
  }

  function getScene() {
    return scene;
  }

  function getCamera() {
    return camera;
  }

  function destroy() {
    window.removeEventListener('resize', onResize);
    if (renderer) {
      renderer.setAnimationLoop(null);
      renderer.dispose();
    }
    if (videoTexture) videoTexture.dispose();
    // Clean up seat markers
    Object.keys(seatMarkers).forEach(removeSeatMarker);
  }

  return {
    init,
    play,
    pause,
    seek,
    getCurrentTime,
    getDuration,
    setSource,
    getRenderer,
    getScene,
    getCamera,
    addSeatMarker,
    removeSeatMarker,
    destroy,
    preloadMedia,
    showMediaError,
    hideMediaError,
    getVideo: () => video,
    isPlaying: () => isPlaying,
    isMediaReady: () => isMediaReadyState,
  };
})();

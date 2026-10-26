/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — Cinema Scene
   Three.js-based virtual cinema with desktop fallback
   Frame-paced, lightweight rendering for standalone VR hardware
   ═══════════════════════════════════════════════════════════ */

const Cinema = (() => {
  let scene, camera, renderer, videoTexture, videoMesh;
  let video = null;
  let canvas = null;
  let isPlaying = false;
  let isHost = false;
  let currentMediaUrl = null; // Track canonical media URL across preload/init

  // Frame pacing & video texture dirty tracking
  let isVideoTextureDirty = false;
  let hasVideoFrameCallbackSupport = false;
  let videoFrameCallbackId = null;
  let lastFallbackVideoTime = -1;
  let presentedFramesCount = 0;

  // Render loop diagnostics & timing
  let lastFrameTimestamp = 0;
  let frameCount = 0;
  let currentFPS = 0;
  let currentFrameTimeMs = 0;
  let lastFpsCalcTime = 0;

  // Blob & Cache Management for instant seeking and zero-buffering playback
  const blobUrlCache = new Map(); // canonicalUrl -> blobUrl
  const activeDownloads = new Map(); // canonicalUrl -> Promise<string>
  const downloadProgressMap = new Map(); // canonicalUrl -> { percent, loaded, total }
  const CACHE_NAME = 'spatialwatch-media-v1';

  function normalizeUrl(url) {
    if (!url) return '';
    return url.replace(/[?&]_cb=\d+/, '');
  }

  function getCachedBlobUrl(url) {
    const canonical = normalizeUrl(url);
    return blobUrlCache.get(canonical) || null;
  }

  async function getOrFetchMediaBlobUrl(mediaUrl, onProgress) {
    if (!mediaUrl) return mediaUrl;
    const canonical = normalizeUrl(mediaUrl);

    // 1. If already created in RAM this session
    if (blobUrlCache.has(canonical)) {
      const cached = blobUrlCache.get(canonical);
      if (typeof onProgress === 'function') onProgress(100, 1, 1);
      return cached;
    }

    // 2. If download is already in-flight, attach to shared promise
    if (activeDownloads.has(canonical)) {
      if (typeof onProgress === 'function') {
        const lastProg = downloadProgressMap.get(canonical);
        if (lastProg) onProgress(lastProg.percent, lastProg.loaded, lastProg.total);
      }
      return activeDownloads.get(canonical);
    }

    const downloadPromise = (async () => {
      try {
        // 3. Check persistent CacheStorage API
        if (typeof window !== 'undefined' && window.caches && typeof window.caches.open === 'function') {
          try {
            const cache = await window.caches.open(CACHE_NAME);
            const cachedResponse = await cache.match(canonical);
            if (cachedResponse) {
              const blob = await cachedResponse.blob();
              if (blob && blob.size > 0) {
                const blobUrl = URL.createObjectURL(blob);
                blobUrlCache.set(canonical, blobUrl);
                downloadProgressMap.set(canonical, { percent: 100, loaded: blob.size, total: blob.size });
                if (typeof onProgress === 'function') onProgress(100, blob.size, blob.size);
                return blobUrl;
              }
            }
          } catch (cacheErr) {
            console.warn('[cinema] Cache API read warning:', cacheErr);
          }
        }

        // 4. Stream-download via fetch with progress reporting
        const response = await fetch(mediaUrl, { mode: 'cors' });
        if (!response.ok) {
          throw new Error(`Media fetch returned status ${response.status}`);
        }

        const contentLengthHeader = response.headers.get('content-length');
        const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;
        const contentType = response.headers.get('content-type') || 'video/mp4';

        let blob;
        if (!response.body || totalBytes === 0) {
          blob = await response.blob();
          if (typeof onProgress === 'function') onProgress(100, blob.size, blob.size);
        } else {
          const reader = response.body.getReader();
          let loadedBytes = 0;
          const chunks = [];

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loadedBytes += value.length;
            if (totalBytes > 0) {
              const pct = Math.min(99, Math.round((loadedBytes / totalBytes) * 100));
              downloadProgressMap.set(canonical, { percent: pct, loaded: loadedBytes, total: totalBytes });
              if (typeof onProgress === 'function') {
                onProgress(pct, loadedBytes, totalBytes);
              }
            }
          }
          blob = new Blob(chunks, { type: contentType });
        }

        // 5. Store response in persistent CacheStorage
        if (typeof window !== 'undefined' && window.caches && typeof window.caches.open === 'function' && blob && blob.size > 0) {
          try {
            const cache = await window.caches.open(CACHE_NAME);
            const cacheResponse = new Response(blob, {
              headers: {
                'Content-Type': contentType,
                'Content-Length': String(blob.size),
              },
            });
            await cache.put(canonical, cacheResponse);
          } catch (cacheErr) {
            console.warn('[cinema] Cache API write warning:', cacheErr);
          }
        }

        const blobUrl = URL.createObjectURL(blob);
        blobUrlCache.set(canonical, blobUrl);
        downloadProgressMap.set(canonical, { percent: 100, loaded: blob.size, total: blob.size });
        if (typeof onProgress === 'function') onProgress(100, blob.size, blob.size);
        return blobUrl;
      } catch (err) {
        console.warn('[cinema] Blob prefetch error, falling back to direct stream:', err);
        return mediaUrl;
      } finally {
        activeDownloads.delete(canonical);
      }
    })();

    activeDownloads.set(canonical, downloadPromise);
    return downloadPromise;
  }

  function showBuffering(text, percent) {
    if (typeof document === 'undefined') return;
    const overlay = document.getElementById('cinema-buffering-overlay');
    const textEl = document.getElementById('cinema-buffering-text');
    const pctEl = document.getElementById('cinema-buffering-percent');
    if (!overlay) return;
    if (textEl && text) textEl.textContent = text;
    if (pctEl) {
      if (typeof percent === 'number' && percent > 0 && percent < 100) {
        pctEl.textContent = `${Math.round(percent)}%`;
      } else {
        pctEl.textContent = '';
      }
    }
    overlay.hidden = false;
  }

  function hideBuffering() {
    if (typeof document === 'undefined') return;
    const overlay = document.getElementById('cinema-buffering-overlay');
    if (overlay) overlay.hidden = true;
  }

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
  let onEndedCallback = null;

  function seedMediaBlob(mediaUrl, blob) {
    if (!mediaUrl || !blob) return null;
    const canonical = normalizeUrl(mediaUrl);
    try {
      const blobUrl = URL.createObjectURL(blob);
      blobUrlCache.set(canonical, blobUrl);
      downloadProgressMap.set(canonical, { percent: 100, loaded: blob.size, total: blob.size });
      return blobUrl;
    } catch (e) {
      console.warn('[cinema] failed to seed media blob:', e);
      return null;
    }
  }

  // Register frame-driven update via HTMLVideoElement.requestVideoFrameCallback
  function registerVideoFrameCallback() {
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
    if (videoFrameCallbackId !== null) return;

    function handleVideoFrame(now, metadata) {
      videoFrameCallbackId = null;
      isVideoTextureDirty = true;
      if (metadata && typeof metadata.presentedFrames === 'number') {
        presentedFramesCount = metadata.presentedFrames;
      } else {
        presentedFramesCount++;
      }

      // Re-schedule for next presented frame
      if (video && typeof video.requestVideoFrameCallback === 'function') {
        videoFrameCallbackId = video.requestVideoFrameCallback(handleVideoFrame);
      }
    }

    videoFrameCallbackId = video.requestVideoFrameCallback(handleVideoFrame);
  }

  function unregisterVideoFrameCallback() {
    if (video && videoFrameCallbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(videoFrameCallbackId);
      videoFrameCallbackId = null;
    }
  }

  function getDroppedFrames() {
    if (video && typeof video.getVideoPlaybackQuality === 'function') {
      const q = video.getVideoPlaybackQuality();
      return q ? (q.droppedVideoFrames || 0) : 0;
    }
    if (video && typeof video.webkitDroppedFrameCount === 'number') {
      return video.webkitDroppedFrameCount;
    }
    return 0;
  }

  function updateRendererPixelRatio() {
    if (!renderer || typeof window === 'undefined') return;
    const isVR = Boolean(renderer.xr && renderer.xr.isPresenting);
    // Headset display resolution is high; cap DPR to 1.0 in VR for rock-solid 72/90/120 Hz
    // Desktop is capped at 1.5 to prevent high-DPI GPU fill-rate stalls
    const targetDPR = isVR ? 1.0 : Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(targetDPR);
  }

  function init(mediaUrl, hostStatus, onReadyCallback, onErrorCallback) {
    isHost = hostStatus;
    if (typeof document !== 'undefined') {
      canvas = document.getElementById('cinema-canvas');
      video = document.getElementById('cinema-video');
    }

    if (!canvas || !video) return;

    // Reset error overlay and buffering
    hideMediaError();
    hideBuffering();

    // Set up video with CORS, inline playback, and auto preload
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.playsInline = true;
    video.loop = false;

    // Check requestVideoFrameCallback support
    hasVideoFrameCallbackSupport = typeof video.requestVideoFrameCallback === 'function';
    if (typeof Diagnostics !== 'undefined' && Diagnostics.isEnabled()) {
      Diagnostics.log(`[cinema] requestVideoFrameCallback support: ${hasVideoFrameCallbackSupport}`);
    }

    video.onloadedmetadata = () => {
      isMediaReadyState = true;
      updateScreenDimensions();
      hideBuffering();
      if (typeof onReadyCallback === 'function') onReadyCallback(video);
      if (window.XR && typeof XR.setMediaReady === 'function') {
        XR.setMediaReady(true, { duration: video.duration });
      }
      isVideoTextureDirty = true;
    };

    video.onended = () => {
      isPlaying = false;
      updatePlayPauseIcon(false);
      unregisterVideoFrameCallback();
      if (typeof onEndedCallback === 'function') onEndedCallback();
    };

    video.onerror = (e) => {
      isMediaReadyState = false;
      hideBuffering();
      unregisterVideoFrameCallback();
      console.warn('[cinema] video load error:', video.error);
      showMediaError(video.error);
      if (typeof onErrorCallback === 'function') onErrorCallback(video.error);
      if (window.XR && typeof XR.setMediaReady === 'function') {
        let msg = 'Media Stream Error — Check File / CORS';
        if (video.error) {
          if (video.error.code === 2) msg = 'Network Error loading video';
          else if (video.error.code === 3) msg = 'Video decode / codec error';
          else if (video.error.code === 4) msg = 'Media format not supported or CORS blocked';
        }
        XR.setMediaReady(false, { message: msg, error: video.error });
      }
    };

    // Buffer state events
    video.onwaiting = () => {
      showBuffering('Buffering video…');
    };
    video.oncanplay = () => {
      hideBuffering();
      isVideoTextureDirty = true;
    };
    video.onplaying = () => {
      hideBuffering();
      registerVideoFrameCallback();
    };
    video.onpause = () => {
      unregisterVideoFrameCallback();
      isVideoTextureDirty = true;
    };
    video.onseeking = () => {
      if (video.readyState < 3) {
        showBuffering('Seeking…');
      }
      isVideoTextureDirty = true;
    };
    video.onseeked = () => {
      hideBuffering();
      isVideoTextureDirty = true;
    };

    // Normalize URL for comparison
    const canonical = normalizeUrl(mediaUrl);

    // If cached in RAM or Cache API, use blob URL
    const cachedBlob = getCachedBlobUrl(canonical);

    if (cachedBlob && (currentMediaUrl !== canonical || video.error || video.readyState === 0)) {
      currentMediaUrl = canonical;
      isMediaReadyState = false;
      video.src = cachedBlob;
      video.load();
    } else if (currentMediaUrl === canonical && video.readyState >= 1) {
      isMediaReadyState = true;
      hideBuffering();
      updateScreenDimensions();
      if (typeof onReadyCallback === 'function') onReadyCallback(video);
      if (window.XR && typeof XR.setMediaReady === 'function') {
        XR.setMediaReady(true, { duration: video.duration });
      }
    } else {
      currentMediaUrl = canonical;
      isMediaReadyState = false;
      video.src = mediaUrl;
      video.load();
      showBuffering('Connecting screening stream…', 0);

      getOrFetchMediaBlobUrl(mediaUrl, (pct) => {
        if (!isMediaReadyState) {
          showBuffering('Buffering screening for zero-lag playback…', pct);
        }
      }).catch((err) => {
        console.warn('[cinema] background blob prefetch notice:', err);
      });
    }

    // Initialize Three.js
    if (typeof THREE === 'undefined') {
      console.error('[cinema] Three.js is not loaded');
      throw new Error('3D Cinema engine (Three.js) is not available');
    }

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050710);

    // Camera — seated VR position
    const aspect = typeof window !== 'undefined' ? (window.innerWidth / window.innerHeight) : (16 / 9);
    camera = new THREE.PerspectiveCamera(70, aspect, 0.1, 100);
    camera.position.set(0, 0, 2);

    // Renderer configured for Quest-friendly performance
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    if (typeof window !== 'undefined') {
      renderer.setSize(window.innerWidth, window.innerHeight);
    }
    updateRendererPixelRatio();
    renderer.xr.enabled = true;

    // Build the theater geometry and video screen
    buildTheater();
    createVideoScreen();
    addLighting();

    // Listen to resize
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', onResize);
    }

    // Start single authoritative render loop
    lastFrameTimestamp = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    lastFpsCalcTime = lastFrameTimestamp;
    renderer.setAnimationLoop(animate);

    if (typeof Diagnostics !== 'undefined' && Diagnostics.isEnabled()) {
      Diagnostics.log('[cinema] Authoritative render loop started');
    }

    // Desktop mouse look controls
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
    if (videoTexture) {
      videoTexture.dispose();
      videoTexture = null;
    }

    videoTexture = new THREE.VideoTexture(video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    videoTexture.generateMipmaps = false;

    let aspect = 16 / 9;
    if (video && video.videoWidth && video.videoHeight) {
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

    if (typeof Diagnostics !== 'undefined' && Diagnostics.isEnabled()) {
      Diagnostics.log('[cinema] VideoTexture and screen mesh initialized');
    }
  }

  function updateScreenDimensions() {
    if (!videoMesh || !video || !video.videoWidth || !video.videoHeight) return;
    const aspect = video.videoWidth / video.videoHeight;
    const width = 9;
    const height = width / aspect;
    if (videoMesh.geometry) videoMesh.geometry.dispose();
    videoMesh.geometry = new THREE.PlaneGeometry(width, height);
  }

  function preloadMedia(mediaUrl, onReady, onError, onProgress) {
    if (typeof document !== 'undefined') {
      video = document.getElementById('cinema-video');
    }
    if (!video || !mediaUrl) return;

    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.playsInline = true;

    const handleLoadedMetadata = () => {
      isMediaReadyState = true;
      if (typeof onReady === 'function') onReady(video);
      if (window.XR && typeof XR.setMediaReady === 'function') {
        XR.setMediaReady(true, { duration: video.duration });
      }
    };

    const handleError = () => {
      isMediaReadyState = false;
      if (typeof onError === 'function') onError(video ? video.error : null);
      if (window.XR && typeof XR.setMediaReady === 'function') {
        let msg = 'Media Stream Error — Check File / CORS';
        if (video && video.error) {
          if (video.error.code === 2) msg = 'Network Error loading video';
          else if (video.error.code === 3) msg = 'Video decode / codec error';
          else if (video.error.code === 4) msg = 'Media format not supported or CORS blocked';
        }
        XR.setMediaReady(false, { message: msg, error: video ? video.error : null });
      }
    };

    video.onloadedmetadata = handleLoadedMetadata;
    video.onerror = handleError;

    const canonical = normalizeUrl(mediaUrl);

    // If already loaded into video element with this media
    if (currentMediaUrl === canonical && video.readyState >= 1) {
      handleLoadedMetadata();
      if (typeof onProgress === 'function') onProgress(100, 1, 1);
      return;
    }

    // Start background blob prefetch
    getOrFetchMediaBlobUrl(mediaUrl, onProgress).then((resolvedUrl) => {
      if (!video) return;
      if (currentMediaUrl !== canonical || video.error || video.readyState === 0) {
        currentMediaUrl = canonical;
        isMediaReadyState = false;
        video.src = resolvedUrl;
        video.load();
      } else if (video.readyState >= 1) {
        handleLoadedMetadata();
      }
    }).catch((err) => {
      console.warn('[cinema] preload fallback:', err);
      if (currentMediaUrl !== canonical) {
        currentMediaUrl = canonical;
        isMediaReadyState = false;
        video.src = mediaUrl;
        video.load();
      }
    });
  }

  function showMediaError(errorDetails) {
    if (typeof document === 'undefined') return;
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
    if (typeof document === 'undefined') return;
    const overlay = document.getElementById('cinema-error-overlay');
    if (overlay) overlay.hidden = true;
  }

  function addLighting() {
    const ambient = new THREE.AmbientLight(0x1a1520, 0.3);
    scene.add(ambient);

    const screenLight = new THREE.PointLight(0x8fa5d0, 0.8, 15);
    screenLight.position.set(0, 1.5, -5);
    scene.add(screenLight);

    const goldLight1 = new THREE.PointLight(0xe7bc72, 0.15, 8);
    goldLight1.position.set(-8, 3, -3);
    scene.add(goldLight1);

    const goldLight2 = new THREE.PointLight(0xe7bc72, 0.15, 8);
    goldLight2.position.set(8, 3, -3);
    scene.add(goldLight2);

    const violetLight = new THREE.PointLight(0x8f85d7, 0.05, 12);
    violetLight.position.set(0, 6, -4);
    scene.add(violetLight);
  }

  function addSeatMarker(participantId, displayName, seatIndex) {
    if (seatMarkers[participantId] || seatIndex >= SEAT_POSITIONS.length) return;

    const pos = SEAT_POSITIONS[seatIndex];

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

    if (typeof document !== 'undefined') {
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
    } else {
      seatMarkers[participantId] = { marker, label: null };
    }
  }

  function removeSeatMarker(participantId) {
    const entry = seatMarkers[participantId];
    if (!entry) return;
    if (scene) {
      if (entry.marker) scene.remove(entry.marker);
      if (entry.label) scene.remove(entry.label);
    }
    if (entry.marker) {
      if (entry.marker.geometry) entry.marker.geometry.dispose();
      if (entry.marker.material) entry.marker.material.dispose();
    }
    if (entry.label) {
      if (entry.label.geometry) entry.label.geometry.dispose();
      if (entry.label.material) {
        if (entry.label.material.map) entry.label.material.map.dispose();
        entry.label.material.dispose();
      }
    }
    delete seatMarkers[participantId];
  }

  let desktopControlsActive = false;
  let isDragging = false;
  let prevX = 0, prevY = 0;
  let rotX = 0, rotY = 0;

  function initDesktopControls() {
    if (desktopControlsActive || !canvas || typeof window === 'undefined') return;
    desktopControlsActive = true;

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  function removeDesktopControls() {
    if (!desktopControlsActive || typeof window === 'undefined') return;
    desktopControlsActive = false;
    isDragging = false;
    if (canvas) canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }

  function onMouseDown(e) {
    isDragging = true;
    prevX = e.clientX;
    prevY = e.clientY;
  }

  function onMouseMove(e) {
    if (!isDragging || !camera) return;
    const dx = e.clientX - prevX;
    const dy = e.clientY - prevY;
    rotY -= dx * 0.003;
    rotX -= dy * 0.003;
    rotX = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, rotX));
    camera.rotation.set(rotX, rotY, 0);
    prevX = e.clientX;
    prevY = e.clientY;
  }

  function onMouseUp() {
    isDragging = false;
  }

  // Authoritative render loop (setAnimationLoop)
  // Zero allocations in the render path to maintain fixed frame rates without GC judder
  function animate(timestamp, frame) {
    if (!renderer || !scene || !camera) return;

    // 1. Frame-driven video texture dirty check
    if (hasVideoFrameCallbackSupport) {
      if (isVideoTextureDirty && videoTexture) {
        videoTexture.needsUpdate = true;
        isVideoTextureDirty = false;
      }
    } else {
      // Safe fallback when requestVideoFrameCallback is unsupported
      if (video && (!video.paused || video.seeking)) {
        const curTime = video.currentTime;
        if (curTime !== lastFallbackVideoTime || video.seeking) {
          lastFallbackVideoTime = curTime;
          if (videoTexture) videoTexture.needsUpdate = true;
          presentedFramesCount++;
        }
      }
    }

    // 2. Synchronous WebXR interaction tick (no detached setInterval)
    const isVR = Boolean(renderer.xr && renderer.xr.isPresenting);
    if (isVR && window.XR && typeof XR.onRenderTick === 'function') {
      XR.onRenderTick(timestamp, frame);
    }

    // 3. Render scene to canvas/headset display
    renderer.render(scene, camera);

    // 4. Lightweight Diagnostics Calculation (every 500ms)
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    frameCount++;
    const elapsedSinceLastCalc = now - lastFpsCalcTime;
    if (elapsedSinceLastCalc >= 500) {
      currentFPS = Math.round((frameCount * 1000) / elapsedSinceLastCalc);
      currentFrameTimeMs = (now - lastFrameTimestamp);
      frameCount = 0;
      lastFpsCalcTime = now;

      if (typeof Diagnostics !== 'undefined' && Diagnostics.isEnabled()) {
        Diagnostics.updateMetrics({
          fps: currentFPS,
          frameTimeMs: currentFrameTimeMs,
          presentedFrames: presentedFramesCount,
          droppedFrames: getDroppedFrames(),
          videoTime: video ? video.currentTime : 0,
          isVR,
          hasVFC: hasVideoFrameCallbackSupport,
        });
      }
    }
    lastFrameTimestamp = now;
  }

  function onResize() {
    if (!camera || !renderer || typeof window === 'undefined') return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    updateRendererPixelRatio();
  }

  function onVREnd() {
    updateRendererPixelRatio();
    if (!desktopControlsActive) {
      initDesktopControls();
    }
  }

  // Playback controls
  function play() {
    if (!video) return;
    video.play().catch(e => console.warn('[cinema] play failed:', e));
    isPlaying = true;
    updatePlayPauseIcon(true);
    registerVideoFrameCallback();
  }

  function pause() {
    if (!video) return;
    video.pause();
    isPlaying = false;
    updatePlayPauseIcon(false);
    unregisterVideoFrameCallback();
    isVideoTextureDirty = true;
  }

  function seek(time) {
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(time, video.duration || 0));
    isVideoTextureDirty = true;
    if (videoTexture) videoTexture.needsUpdate = true;
  }

  function getCurrentTime() {
    return video ? video.currentTime : 0;
  }

  function getDuration() {
    return video ? (video.duration || 0) : 0;
  }

  function setSource(url) {
    if (!video) return;
    unregisterVideoFrameCallback();
    video.src = url;
    video.load();
    isVideoTextureDirty = true;
  }

  function updatePlayPauseIcon(playing) {
    if (typeof document === 'undefined') return;
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
    if (typeof Diagnostics !== 'undefined' && Diagnostics.isEnabled()) {
      Diagnostics.log('[cinema] Cleaning up and disposing cinema scene');
    }

    if (typeof window !== 'undefined' && window.XR && typeof window.XR.cleanupVR === 'function') {
      window.XR.cleanupVR();
    }

    unregisterVideoFrameCallback();
    removeDesktopControls();

    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', onResize);
    }

    onEndedCallback = null;
    isMediaReadyState = false;
    currentMediaUrl = null;
    hideBuffering();
    hideMediaError();

    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.onloadedmetadata = null;
      video.onerror = null;
      video.onended = null;
      video.onwaiting = null;
      video.oncanplay = null;
      video.onplaying = null;
      video.onpause = null;
      video.onseeking = null;
      video.onseeked = null;
    }

    if (renderer) {
      renderer.setAnimationLoop(null);
      renderer.dispose();
      renderer = null;
    }

    if (videoTexture) {
      videoTexture.dispose();
      videoTexture = null;
    }

    if (videoMesh && videoMesh.geometry) {
      videoMesh.geometry.dispose();
      videoMesh = null;
    }

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
    showBuffering,
    hideBuffering,
    getCachedBlobUrl,
    seedMediaBlob,
    onEnded: (cb) => { onEndedCallback = cb; },
    onVREnd,
    getVideo: () => video,
    isPlaying: () => isPlaying,
    isMediaReady: () => isMediaReadyState,
    getPresentedFramesCount: () => presentedFramesCount,
    hasVideoFrameCallback: () => hasVideoFrameCallbackSupport,
    markTextureDirty: () => { isVideoTextureDirty = true; },
  };
})();

if (typeof window !== 'undefined') {
  window.Cinema = Cinema;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Cinema;
}

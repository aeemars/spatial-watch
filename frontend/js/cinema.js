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
  let currentMediaUrl = null; // Track canonical media URL across preload/init

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
        if ('caches' in window) {
          try {
            const cache = await caches.open(CACHE_NAME);
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
        if ('caches' in window && blob && blob.size > 0) {
          try {
            const cache = await caches.open(CACHE_NAME);
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
        // Fallback to original URL so playback is never blocked
        return mediaUrl;
      } finally {
        activeDownloads.delete(canonical);
      }
    })();

    activeDownloads.set(canonical, downloadPromise);
    return downloadPromise;
  }

  function showBuffering(text, percent) {
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

  function init(mediaUrl, hostStatus, onReadyCallback, onErrorCallback) {
    isHost = hostStatus;
    canvas = document.getElementById('cinema-canvas');
    video = document.getElementById('cinema-video');

    if (!canvas || !video) return;

    // Reset error overlay and buffering
    hideMediaError();
    hideBuffering();

    // Set up video with CORS and lifecycle hooks
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.loop = false;

    video.onloadedmetadata = () => {
      isMediaReadyState = true;
      updateScreenDimensions();
      hideBuffering();
      if (typeof onReadyCallback === 'function') onReadyCallback(video);
      if (window.XR && typeof XR.setMediaReady === 'function') {
        XR.setMediaReady(true, { duration: video.duration });
      }
    };

    video.onended = () => {
      isPlaying = false;
      updatePlayPauseIcon(false);
      if (typeof onEndedCallback === 'function') onEndedCallback();
    };

    video.onerror = (e) => {
      isMediaReadyState = false;
      hideBuffering();
      console.warn('[cinema] video load error:', video.error);
      showMediaError(video.error);
      if (typeof onErrorCallback === 'function') onErrorCallback(video.error);
      if (window.XR && typeof XR.setMediaReady === 'function') {
        XR.setMediaReady(false);
      }
    };

    // Buffer state events
    video.onwaiting = () => {
      showBuffering('Buffering video…');
    };
    video.oncanplay = () => {
      hideBuffering();
    };
    video.onplaying = () => {
      hideBuffering();
    };
    video.onseeking = () => {
      if (video.readyState < 3) {
        showBuffering('Seeking…');
      }
    };
    video.onseeked = () => {
      hideBuffering();
      if (videoTexture) videoTexture.needsUpdate = true;
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
      // Already has metadata from preload
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
      // Immediately bind the media URL so browser Range streaming starts with zero delay
      video.src = mediaUrl;
      video.load();
      showBuffering('Connecting screening stream…', 0);

      // In parallel, buffer into CacheStorage for smooth looping & instant seeking
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

    video.loop = false;

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

  function preloadMedia(mediaUrl, onReady, onError, onProgress) {
    video = document.getElementById('cinema-video');
    if (!video || !mediaUrl) return;

    video.crossOrigin = 'anonymous';
    video.preload = 'auto';

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
    if (videoTexture && video && (!video.paused || video.seeking)) {
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
      video.onseeking = null;
      video.onseeked = null;
    }
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
    showBuffering,
    hideBuffering,
    getCachedBlobUrl,
    seedMediaBlob,
    onEnded: (cb) => { onEndedCallback = cb; },
    getVideo: () => video,
    isPlaying: () => isPlaying,
    isMediaReady: () => isMediaReadyState,
  };
})();

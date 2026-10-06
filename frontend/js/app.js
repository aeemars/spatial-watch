/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — App Orchestration
   Screen management, modal logic, WS event handling,
   and desktop cinema controls
   ═══════════════════════════════════════════════════════════ */

const App = (() => {
  // State
  let currentScreen = 'landing';
  let roomCode = '';
  let roomName = '';
  let participantId = '';
  let displayName = '';
  let isHost = false;
  let participants = [];
  let controlHideTimer = null;
  let currentUser = null;
  let hostParticipantId = '';

  // Media Catalog Selection State
  let catalogAssets = [];
  let selectedAssetId = 'big-buck-bunny';
  let activeMediaSource = 'catalog'; // 'catalog' | 'custom'

  // ─── Initialization ───────────────────────────────
  function init() {
    // Check WebXR support
    XR.checkSupport();

    // Initialize authenticated guest session
    initSession();

    // Bind brand logo links to return to homepage from anywhere
    document.querySelectorAll('.brand-home-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        goHome();
      });
    });

    // Media source tabs in create room modal
    const tabCatalog = document.getElementById('tab-media-catalog');
    if (tabCatalog) tabCatalog.addEventListener('click', () => switchMediaSourceTab('catalog'));

    const tabUpload = document.getElementById('tab-media-upload');
    if (tabUpload) tabUpload.addEventListener('click', () => switchMediaSourceTab('upload'));

    const tabCustom = document.getElementById('tab-media-custom');
    if (tabCustom) tabCustom.addEventListener('click', () => switchMediaSourceTab('custom'));

    // Upload dropzone & file selection
    setupUploadControls();

    // Preload media catalog
    loadMediaCatalog();

    // Bind landing buttons
    document.getElementById('btn-create-room').addEventListener('click', () => openModal('modal-create'));
    document.getElementById('btn-join-room').addEventListener('click', () => openModal('modal-join'));

    // Records buttons (navbar and hero)
    const btnOpenRecords = document.getElementById('btn-open-records');
    if (btnOpenRecords) btnOpenRecords.addEventListener('click', openRecordsModal);

    const btnHeroRecords = document.getElementById('btn-hero-records');
    if (btnHeroRecords) btnHeroRecords.addEventListener('click', openRecordsModal);

    const btnRecordsClose = document.getElementById('modal-records-close');
    if (btnRecordsClose) btnRecordsClose.addEventListener('click', () => closeModal('modal-records'));

    const modalRecords = document.getElementById('modal-records');
    if (modalRecords) {
      modalRecords.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) closeModal('modal-records');
      });
    }

    const tabCreated = document.getElementById('tab-records-created');
    if (tabCreated) tabCreated.addEventListener('click', () => switchRecordsTab('created'));

    const tabJoined = document.getElementById('tab-records-joined');
    if (tabJoined) tabJoined.addEventListener('click', () => switchRecordsTab('joined'));

    const btnEmptyCreate = document.getElementById('btn-empty-create');
    if (btnEmptyCreate) btnEmptyCreate.addEventListener('click', () => {
      closeModal('modal-records');
      openModal('modal-create');
    });

    const btnEmptyJoin = document.getElementById('btn-empty-join');
    if (btnEmptyJoin) btnEmptyJoin.addEventListener('click', () => {
      closeModal('modal-records');
      openModal('modal-join');
    });

    // Bind modal close buttons
    document.getElementById('modal-create-close').addEventListener('click', () => closeModal('modal-create'));
    document.getElementById('modal-join-close').addEventListener('click', () => closeModal('modal-join'));

    // Profile modal bindings
    const btnOpenProfile = document.getElementById('btn-open-profile');
    if (btnOpenProfile) btnOpenProfile.addEventListener('click', () => openModal('modal-profile'));

    const btnProfileClose = document.getElementById('modal-profile-close');
    if (btnProfileClose) btnProfileClose.addEventListener('click', () => closeModal('modal-profile'));

    const modalProfile = document.getElementById('modal-profile');
    if (modalProfile) {
      modalProfile.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) closeModal('modal-profile');
      });
    }

    const btnProfileSave = document.getElementById('btn-profile-save');
    if (btnProfileSave) btnProfileSave.addEventListener('click', handleSaveProfile);

    const profileInput = document.getElementById('profile-name-input');
    if (profileInput) {
      profileInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleSaveProfile();
      });
    }

    const btnResetSession = document.getElementById('btn-reset-session');
    if (btnResetSession) btnResetSession.addEventListener('click', handleResetSession);

    // Click overlay to close modal
    document.getElementById('modal-create').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-overlay')) closeModal('modal-create');
    });
    document.getElementById('modal-join').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-overlay')) closeModal('modal-join');
    });

    // Confirmation dialog bindings
    const btnConfirmAction = document.getElementById('modal-confirm-btn-action');
    if (btnConfirmAction) btnConfirmAction.addEventListener('click', () => closeConfirmDialog(true));

    const btnConfirmCancel = document.getElementById('modal-confirm-btn-cancel');
    if (btnConfirmCancel) btnConfirmCancel.addEventListener('click', () => closeConfirmDialog(false));

    const btnConfirmClose = document.getElementById('modal-confirm-close');
    if (btnConfirmClose) btnConfirmClose.addEventListener('click', () => closeConfirmDialog(false));

    const modalConfirm = document.getElementById('modal-confirm');
    if (modalConfirm) {
      modalConfirm.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) closeConfirmDialog(false);
      });
    }

    // Escape key closes modals (confirm dialog takes priority)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const confirmModal = document.getElementById('modal-confirm');
        if (confirmModal && !confirmModal.hidden && confirmModal.classList.contains('is-visible')) {
          closeConfirmDialog(false);
          return;
        }
        closeModal('modal-create');
        closeModal('modal-join');
        closeModal('modal-profile');
        closeModal('modal-records');
      }
    });

    // Create room form
    document.getElementById('btn-create-submit').addEventListener('click', handleCreateRoom);
    const roomNameInput = document.getElementById('create-room-name');
    if (roomNameInput) {
      roomNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleCreateRoom();
      });
    }
    document.getElementById('create-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleCreateRoom();
    });

    // Join room form
    document.getElementById('btn-join-submit').addEventListener('click', handleJoinRoom);
    document.getElementById('join-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleJoinRoom();
    });

    // Room code auto-formatting
    document.getElementById('join-code').addEventListener('input', (e) => {
      let val = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
      // Auto-insert dash after SW
      if (val.length === 2 && !val.includes('-')) {
        val = val + '-';
      }
      e.target.value = val;
    });

    // Lobby buttons
    document.getElementById('btn-enter-cinema').addEventListener('click', handleEnterCinema);
    document.getElementById('btn-leave-lobby').addEventListener('click', leaveRoom);
    const btnShutdownLobby = document.getElementById('btn-shutdown-lobby');
    if (btnShutdownLobby) btnShutdownLobby.addEventListener('click', handleShutdownCurrentRoom);

    // Cinema controls
    document.getElementById('btn-play-pause').addEventListener('click', handlePlayPause);
    document.getElementById('btn-seek-back').addEventListener('click', () => handleSeek(-10));
    document.getElementById('btn-seek-forward').addEventListener('click', () => handleSeek(10));
    document.getElementById('btn-cinema-dc').addEventListener('click', handleToggleDirectorCut);
    document.getElementById('btn-cinema-exit').addEventListener('click', leaveRoom);
    document.getElementById('btn-enter-vr').addEventListener('click', () => XR.enterVR());
    const btnClosingExit = document.getElementById('btn-cinema-closing-exit');
    if (btnClosingExit) {
      btnClosingExit.addEventListener('click', () => finalizeScreeningShutdown());
    }

    // Progress bar
    const progressBar = document.getElementById('cinema-progress');
    progressBar.addEventListener('input', handleProgressSeek);

    // Reaction buttons
    document.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        Reactions.send(btn.dataset.reaction);
      });
    });

    // Cinema controls auto-hide
    setupControlsAutoHide();

    // WS event handlers
    setupWSHandlers();

    // Initialize sub-modules
    Reactions.init();
    DirectorsCut.init();
  }

  // ─── Guest Session & Identity ─────────────────────
  let sessionInitPromise = null;

  function ensureSession() {
    if (currentUser) return Promise.resolve(currentUser);
    if (!sessionInitPromise) {
      sessionInitPromise = initSession();
    }
    return sessionInitPromise;
  }

  async function initSession() {
    try {
      const data = await API.getSession();
      currentUser = data.user;
      applyCurrentUser();
      updateRecordsBadge();
      return currentUser;
    } catch (err) {
      console.warn('[auth] session initialization failed, retrying:', err);
      try {
        const retry = await API.getSession();
        currentUser = retry.user;
        applyCurrentUser();
        updateRecordsBadge();
        return currentUser;
      } catch (e) {
        console.error('[auth] could not initialize session:', e);
        const chipName = document.getElementById('profile-chip-name');
        if (chipName && chipName.textContent === 'Loading…') {
          chipName.textContent = 'Guest';
        }
        return null;
      }
    }
  }

  function applyCurrentUser() {
    if (!currentUser) return;
    displayName = currentUser.displayName;
    participantId = currentUser.id;

    // Update profile chip on landing screen
    const chipName = document.getElementById('profile-chip-name');
    if (chipName) chipName.textContent = currentUser.displayName;

    // Auto-reflect set display name in create/join modal inputs
    const createInput = document.getElementById('create-name');
    if (createInput) {
      createInput.value = currentUser.displayName;
    }

    const joinInput = document.getElementById('join-name');
    if (joinInput) {
      joinInput.value = currentUser.displayName;
    }

    // Update profile modal fields
    const profileInput = document.getElementById('profile-name-input');
    if (profileInput) profileInput.value = currentUser.displayName;

    const profileUserId = document.getElementById('profile-user-id');
    if (profileUserId) profileUserId.textContent = currentUser.id;
  }

  async function handleSaveProfile() {
    const input = document.getElementById('profile-name-input');
    const errorEl = document.getElementById('profile-name-error');
    const saveBtn = document.getElementById('btn-profile-save');
    const newName = input.value.trim();

    if (newName.length < 2 || newName.length > 32) {
      errorEl.textContent = 'Display name must be 2-32 characters';
      errorEl.hidden = false;
      input.classList.add('input--error');
      return;
    }
    errorEl.hidden = true;
    input.classList.remove('input--error');

    saveBtn.disabled = true;
    try {
      const res = await API.updateProfile(newName);
      currentUser = res.user;
      applyCurrentUser();
      closeModal('modal-profile');
      showToast('Profile updated', 'success');
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to update profile';
      errorEl.hidden = false;
      input.classList.add('input--error');
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function handleResetSession() {
    const confirmed = await showConfirmDialog({
      title: 'Reset Guest Identity?',
      primaryMessage: 'Generate a fresh guest identity?',
      secondaryMessage: 'Your current session will be reset and any temporary session preferences will be cleared.',
      confirmText: 'Reset Identity',
      cancelText: 'Cancel',
      isDanger: true,
    });
    if (!confirmed) return;

    try {
      await API.logout();
      const res = await API.getSession();
      currentUser = res.user;
      applyCurrentUser();
      closeModal('modal-profile');
      showToast('Guest identity reset', 'info');
    } catch (err) {
      showToast('Failed to reset identity', 'error');
    }
  }

  // ─── Confirmation Dialog (App-Level) ───────────────

  let confirmDialogResolve = null;

  function showConfirmDialog({
    title = 'Confirm Action',
    primaryMessage = 'Are you sure you want to proceed?',
    secondaryMessage = '',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    isDanger = true,
  } = {}) {
    return new Promise((resolve) => {
      if (confirmDialogResolve) {
        confirmDialogResolve(false);
        confirmDialogResolve = null;
      }
      confirmDialogResolve = resolve;

      const modal = document.getElementById('modal-confirm');
      if (!modal) {
        resolve(false);
        return;
      }

      const modalContainer = modal.querySelector('.modal--confirm');
      const titleEl = document.getElementById('modal-confirm-title');
      const primaryEl = document.getElementById('modal-confirm-primary');
      const secondaryEl = document.getElementById('modal-confirm-secondary');
      const btnAction = document.getElementById('modal-confirm-btn-action');
      const btnCancel = document.getElementById('modal-confirm-btn-cancel');

      if (titleEl) titleEl.textContent = title;
      if (primaryEl) primaryEl.textContent = primaryMessage;
      if (secondaryEl) {
        secondaryEl.textContent = secondaryMessage;
        secondaryEl.hidden = !secondaryMessage;
      }

      if (btnCancel) btnCancel.textContent = cancelText;

      if (btnAction) {
        btnAction.textContent = confirmText;
        if (isDanger) {
          btnAction.className = 'btn btn--danger-solid btn--md';
          if (modalContainer) modalContainer.classList.remove('modal--confirm-neutral');
        } else {
          btnAction.className = 'btn btn--primary btn--md';
          if (modalContainer) modalContainer.classList.add('modal--confirm-neutral');
        }
      }

      modal.hidden = false;
      modal.offsetHeight; // Force reflow for animation
      modal.classList.add('is-visible');

      if (btnAction) {
        setTimeout(() => btnAction.focus(), 80);
      }
    });
  }

  function closeConfirmDialog(result = false) {
    const modal = document.getElementById('modal-confirm');
    if (modal && !modal.hidden) {
      modal.classList.remove('is-visible');
      setTimeout(() => {
        modal.hidden = true;
      }, 300);
    }
    if (confirmDialogResolve) {
      const res = confirmDialogResolve;
      confirmDialogResolve = null;
      res(result);
    }
  }

  // ─── Modal Management ─────────────────────────────

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;

    // Ensure session is loaded and inputs pre-filled
    ensureSession().then((user) => {
      if (user) {
        applyCurrentUser();
      }
    });

    // Populate prefilled names and clear previous input errors when opening modals
    if (id === 'modal-create') {
      const input = document.getElementById('create-name');
      if (input && currentUser && currentUser.displayName) {
        input.value = currentUser.displayName;
      }
      const roomInput = document.getElementById('create-room-name');
      const roomErr = document.getElementById('create-room-name-error');
      if (roomErr) roomErr.hidden = true;
      if (roomInput) roomInput.classList.remove('input--error');
      const nameErr = document.getElementById('create-name-error');
      if (nameErr) nameErr.hidden = true;
      if (input) input.classList.remove('input--error');

      // Clear custom media errors
      const cTitleErr = document.getElementById('create-custom-title-error');
      if (cTitleErr) cTitleErr.hidden = true;
      const cUrlErr = document.getElementById('create-custom-url-error');
      if (cUrlErr) cUrlErr.hidden = true;

      // Ensure catalog is populated
      if (catalogAssets.length === 0) {
        loadMediaCatalog();
      }
      switchMediaSourceTab(activeMediaSource || 'catalog');
    } else if (id === 'modal-join') {
      const input = document.getElementById('join-name');
      if (input && currentUser && currentUser.displayName) {
        input.value = currentUser.displayName;
      }
      const codeErr = document.getElementById('join-code-error');
      if (codeErr) codeErr.hidden = true;
      const codeInput = document.getElementById('join-code');
      if (codeInput) codeInput.classList.remove('input--error');
      const nameErr = document.getElementById('join-name-error');
      if (nameErr) nameErr.hidden = true;
      if (input) input.classList.remove('input--error');
    } else if (id === 'modal-profile') {
      const input = document.getElementById('profile-name-input');
      if (input && currentUser) input.value = currentUser.displayName;
      const uid = document.getElementById('profile-user-id');
      if (uid && currentUser) uid.textContent = currentUser.id;
      const errEl = document.getElementById('profile-name-error');
      if (errEl) errEl.hidden = true;
      if (input) input.classList.remove('input--error');
    }

    modal.hidden = false;
    // Force reflow for transition
    modal.offsetHeight;
    modal.classList.add('is-visible');

    // Focus primary action input: Room Name for Create, Room Code for Join
    if (id === 'modal-create') {
      const roomInput = document.getElementById('create-room-name');
      if (roomInput) setTimeout(() => roomInput.focus(), 100);
    } else if (id === 'modal-join') {
      const codeInput = document.getElementById('join-code');
      if (codeInput) setTimeout(() => codeInput.focus(), 100);
    } else {
      const input = modal.querySelector('input');
      if (input) setTimeout(() => input.focus(), 100);
    }
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal || modal.hidden) return;
    modal.classList.remove('is-visible');
    setTimeout(() => {
      modal.hidden = true;
    }, 300);
  }

  // ─── Media Catalog & Source Tabs ──────────────────

  let uploadedFile = null;
  let uploadedFileDuration = 0;

  function switchMediaSourceTab(source) {
    activeMediaSource = source;
    const tabCat = document.getElementById('tab-media-catalog');
    const tabUpload = document.getElementById('tab-media-upload');
    const tabCust = document.getElementById('tab-media-custom');
    const paneCat = document.getElementById('pane-media-catalog');
    const paneUpload = document.getElementById('pane-media-upload');
    const paneCust = document.getElementById('pane-media-custom');

    const tabs = [
      { id: 'catalog', btn: tabCat, pane: paneCat },
      { id: 'upload', btn: tabUpload, pane: paneUpload },
      { id: 'custom', btn: tabCust, pane: paneCust },
    ];

    tabs.forEach(t => {
      const isMatch = t.id === source;
      if (t.btn) {
        if (isMatch) {
          t.btn.classList.add('is-active');
          t.btn.setAttribute('aria-selected', 'true');
        } else {
          t.btn.classList.remove('is-active');
          t.btn.setAttribute('aria-selected', 'false');
        }
      }
      if (t.pane) {
        if (isMatch) {
          t.pane.classList.remove('is-hidden');
        } else {
          t.pane.classList.add('is-hidden');
        }
      }
    });

    if (source === 'custom') {
      const titleInput = document.getElementById('create-custom-title');
      if (titleInput) setTimeout(() => titleInput.focus(), 100);
    } else if (source === 'upload') {
      const titleInput = document.getElementById('create-upload-title');
      if (titleInput && uploadedFile) setTimeout(() => titleInput.focus(), 100);
    }
  }

  function setupUploadControls() {
    const dropzone = document.getElementById('upload-dropzone');
    const fileInput = document.getElementById('create-upload-input');
    const btnRemove = document.getElementById('btn-upload-remove');
    const btnBrowse = document.getElementById('btn-upload-browse');

    if (!dropzone || !fileInput) return;

    dropzone.addEventListener('click', () => {
      fileInput.click();
    });

    if (btnBrowse) {
      btnBrowse.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
      });
    }

    dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });

    fileInput.addEventListener('change', (e) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        handleFileSelected(files[0]);
      }
    });

    // Drag and drop events
    ['dragenter', 'dragover'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('is-dragover');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('is-dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) {
        handleFileSelected(dt.files[0]);
      }
    });

    if (btnRemove) {
      btnRemove.addEventListener('click', (e) => {
        e.stopPropagation();
        clearUploadedFile();
      });
    }
  }

  async function handleFileSelected(file) {
    if (!file) return;

    // Validate video MIME / extension
    const isVideo = file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.mp4') || file.name.toLowerCase().endsWith('.webm');
    if (!isVideo) {
      showToast('Please select a valid MP4 or WebM video file', 'error');
      return;
    }

    // Validate size (max 500MB)
    const maxSize = 500 * 1024 * 1024;
    if (file.size > maxSize) {
      showToast('File size exceeds the 500MB limit', 'error');
      return;
    }

    uploadedFile = file;
    uploadedFileDuration = 0;

    const dropzone = document.getElementById('upload-dropzone');
    const selectedCard = document.getElementById('upload-selected-card');
    const fileNameEl = document.getElementById('upload-file-name');
    const fileMetaEl = document.getElementById('upload-file-meta');
    const titleInput = document.getElementById('create-upload-title');

    if (dropzone) dropzone.hidden = true;
    if (selectedCard) selectedCard.hidden = false;
    if (fileNameEl) fileNameEl.textContent = file.name;

    const formattedSize = (file.size / (1024 * 1024)).toFixed(1) + ' MB';
    if (fileMetaEl) fileMetaEl.textContent = `${formattedSize} · Calculating duration…`;

    // Suggest clean title from filename if not yet filled
    if (titleInput && !titleInput.value.trim()) {
      const cleanName = file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
      titleInput.value = cleanName;
    }

    // Extract video duration via local ObjectURL
    try {
      const dur = await extractVideoDuration(file);
      uploadedFileDuration = dur;
      if (fileMetaEl) {
        fileMetaEl.textContent = `${formattedSize} · Duration: ${formatTime(dur)}`;
      }
    } catch (e) {
      if (fileMetaEl) {
        fileMetaEl.textContent = formattedSize;
      }
    }
  }

  function clearUploadedFile() {
    uploadedFile = null;
    uploadedFileDuration = 0;

    const dropzone = document.getElementById('upload-dropzone');
    const selectedCard = document.getElementById('upload-selected-card');
    const fileInput = document.getElementById('create-upload-input');
    const progressWrap = document.getElementById('upload-progress-wrap');

    if (fileInput) fileInput.value = '';
    if (dropzone) dropzone.hidden = false;
    if (selectedCard) selectedCard.hidden = true;
    if (progressWrap) progressWrap.hidden = true;
  }

  function extractVideoDuration(file) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      const objUrl = URL.createObjectURL(file);
      video.src = objUrl;

      const cleanup = () => {
        URL.revokeObjectURL(objUrl);
      };

      video.onloadedmetadata = () => {
        const dur = video.duration || 0;
        cleanup();
        resolve(dur);
      };

      video.onerror = () => {
        cleanup();
        resolve(0);
      };

      setTimeout(() => {
        cleanup();
        resolve(0);
      }, 5000);
    });
  }

  async function loadMediaCatalog() {
    try {
      const assets = await API.getMediaAssets();
      if (Array.isArray(assets) && assets.length > 0) {
        catalogAssets = assets;
        renderCatalogCards(assets);
      }
    } catch (e) {
      console.warn('[app] failed to load media catalog:', e);
      const listEl = document.getElementById('catalog-card-list');
      if (listEl) {
        listEl.innerHTML = `
          <div class="catalog-loading">
            <span>Unable to load catalog. You can still use a custom hosted MP4 URL.</span>
          </div>
        `;
      }
    }
  }

  function renderCatalogCards(assets) {
    const listEl = document.getElementById('catalog-card-list');
    if (!listEl) return;

    listEl.innerHTML = '';
    assets.forEach((asset, idx) => {
      const isSelected = (selectedAssetId === asset.assetId) || (!selectedAssetId && idx === 0);
      if (isSelected && !selectedAssetId) selectedAssetId = asset.assetId;

      const card = document.createElement('div');
      card.className = 'catalog-card' + (isSelected ? ' is-selected' : '');
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', isSelected ? 'true' : 'false');
      card.setAttribute('tabindex', '0');
      card.dataset.assetId = asset.assetId;

      const gradient = asset.gradient || 'linear-gradient(135deg, #1c2331, #0e111a)';
      const durStr = formatTime(asset.durationSeconds);

      card.innerHTML = `
        <div class="catalog-card__thumb" style="background: ${gradient}">
          <span class="catalog-card__duration">${durStr}</span>
          ${asset.directorCutAvailable ? '<span class="catalog-card__dc-badge">DC</span>' : ''}
          <div class="catalog-card__check">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
        </div>
        <div class="catalog-card__body">
          <div class="catalog-card__title">${escapeHtml(asset.title)}</div>
          <div class="catalog-card__desc">${escapeHtml(asset.description || '')}</div>
        </div>
      `;

      card.addEventListener('click', () => {
        selectCatalogAsset(asset.assetId);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          selectCatalogAsset(asset.assetId);
        }
      });

      listEl.appendChild(card);
    });
  }

  function selectCatalogAsset(assetId) {
    selectedAssetId = assetId;
    const cards = document.querySelectorAll('.catalog-card');
    cards.forEach((c) => {
      const match = c.dataset.assetId === assetId;
      c.classList.toggle('is-selected', match);
      c.setAttribute('aria-checked', match ? 'true' : 'false');
    });
  }

  // ─── Room Creation ────────────────────────────────

  async function handleCreateRoom() {
    const roomNameInput = document.getElementById('create-room-name');
    const roomNameError = document.getElementById('create-room-name-error');
    const nameInput = document.getElementById('create-name');
    const nameError = document.getElementById('create-name-error');
    const submitBtn = document.getElementById('btn-create-submit');

    // Reset errors
    if (roomNameError) roomNameError.hidden = true;
    if (roomNameInput) roomNameInput.classList.remove('input--error');
    if (nameError) nameError.hidden = true;
    if (nameInput) nameInput.classList.remove('input--error');

    // Loading state
    submitBtn.classList.add('btn--loading');
    submitBtn.disabled = true;

    // Ensure session is ready before attempting room creation
    try {
      await ensureSession();
    } catch (e) {
      // Proceed; API client will attempt transparent retry
    }

    const rName = roomNameInput ? roomNameInput.value.trim() : '';
    let name = nameInput.value.trim();
    if (!name && currentUser) {
      name = currentUser.displayName;
    }

    // Validate Room Name: 2-50 chars, no HTML brackets, must contain letters or digits
    const hasAlphanumeric = /[a-zA-Z0-9]/.test(rName);
    if (!rName || rName.length < 2 || rName.length > 50 || /[<>]/.test(rName) || !hasAlphanumeric) {
      if (roomNameError) {
        roomNameError.textContent = 'Room name must be 2-50 characters with letters or numbers, and no < or >';
        roomNameError.hidden = false;
      }
      if (roomNameInput) roomNameInput.classList.add('input--error');
      submitBtn.classList.remove('btn--loading');
      submitBtn.disabled = false;
      return;
    }

    // Validate Display Name
    if (!name || name.length < 2 || name.length > 32 || /[<>]/.test(name)) {
      if (nameError) {
        nameError.textContent = 'Please enter a display name (2-32 characters)';
        nameError.hidden = false;
      }
      if (nameInput) nameInput.classList.add('input--error');
      submitBtn.classList.remove('btn--loading');
      submitBtn.disabled = false;
      return;
    }

    // Resolve media options
    const options = {};
    if (activeMediaSource === 'catalog') {
      options.mediaAssetId = selectedAssetId || 'big-buck-bunny';
    } else if (activeMediaSource === 'upload') {
      if (!uploadedFile) {
        showToast('Please select a video clip to upload', 'error');
        submitBtn.classList.remove('btn--loading');
        submitBtn.disabled = false;
        return;
      }

      const uploadTitleInput = document.getElementById('create-upload-title');
      const uploadTitleErr = document.getElementById('create-upload-title-error');
      if (uploadTitleErr) uploadTitleErr.hidden = true;
      if (uploadTitleInput) uploadTitleInput.classList.remove('input--error');

      let uTitle = uploadTitleInput ? uploadTitleInput.value.trim() : '';
      if (!uTitle) {
        uTitle = uploadedFile.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
      }

      if (uTitle.length < 2 || uTitle.length > 100 || /[<>]/.test(uTitle)) {
        if (uploadTitleErr) {
          uploadTitleErr.textContent = 'Please enter a valid title (2-100 characters)';
          uploadTitleErr.hidden = false;
        }
        if (uploadTitleInput) uploadTitleInput.classList.add('input--error');
        submitBtn.classList.remove('btn--loading');
        submitBtn.disabled = false;
        return;
      }

      // Step 1: Request presigned upload URL from backend
      const progressWrap = document.getElementById('upload-progress-wrap');
      const progressFill = document.getElementById('upload-progress-fill');
      const progressText = document.getElementById('upload-progress-percent');
      const progressLabel = document.getElementById('upload-progress-label');

      if (progressWrap) progressWrap.hidden = false;
      if (progressFill) progressFill.style.width = '0%';
      if (progressText) progressText.textContent = '0%';
      if (progressLabel) progressLabel.textContent = 'Preparing Cloudflare R2 Upload…';

      let presign;
      try {
        await ensureSession();
        presign = await API.presignUpload({
          fileName: uploadedFile.name,
          fileSize: uploadedFile.size,
          contentType: uploadedFile.type || 'video/mp4',
        });
      } catch (err) {
        if (progressWrap) progressWrap.hidden = true;
        showToast(err.message || 'Failed to prepare video upload', 'error');
        submitBtn.classList.remove('btn--loading');
        submitBtn.disabled = false;
        return;
      }

      // Step 2: Direct browser PUT to Cloudflare R2
      try {
        if (progressLabel) progressLabel.textContent = 'Direct Upload to Cloudflare R2…';
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', presign.uploadUrl, true);
          xhr.setRequestHeader('Content-Type', uploadedFile.type || 'video/mp4');

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const percent = Math.min(100, Math.round((e.loaded / e.total) * 100));
              if (progressFill) progressFill.style.width = `${percent}%`;
              if (progressText) progressText.textContent = `${percent}%`;
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else {
              reject(new Error(`Direct upload failed with status ${xhr.status}`));
            }
          };

          xhr.onerror = () => reject(new Error('Network error during video upload'));
          xhr.send(uploadedFile);
        });

        if (progressLabel) progressLabel.textContent = 'Upload complete! Creating room…';
      } catch (err) {
        if (progressWrap) progressWrap.hidden = true;
        showToast(err.message || 'Direct upload to R2 failed', 'error');
        submitBtn.classList.remove('btn--loading');
        submitBtn.disabled = false;
        return;
      }

      options.mediaUrl = presign.streamUrl;
      options.mediaTitle = uTitle;
      options.durationSeconds = uploadedFileDuration;
      options.mediaSourceType = 'upload';
    } else {
      const customTitleInput = document.getElementById('create-custom-title');
      const customUrlInput = document.getElementById('create-custom-url');
      const customTitleErr = document.getElementById('create-custom-title-error');
      const customUrlErr = document.getElementById('create-custom-url-error');

      if (customTitleErr) customTitleErr.hidden = true;
      if (customUrlErr) customUrlErr.hidden = true;
      if (customTitleInput) customTitleInput.classList.remove('input--error');
      if (customUrlInput) customUrlInput.classList.remove('input--error');

      const cTitle = customTitleInput ? customTitleInput.value.trim() : '';
      const cUrl = customUrlInput ? customUrlInput.value.trim() : '';

      if (!cTitle || cTitle.length < 2 || cTitle.length > 100 || /[<>]/.test(cTitle)) {
        if (customTitleErr) {
          customTitleErr.textContent = 'Please enter a title for this video (2-100 characters)';
          customTitleErr.hidden = false;
        }
        if (customTitleInput) customTitleInput.classList.add('input--error');
        submitBtn.classList.remove('btn--loading');
        submitBtn.disabled = false;
        return;
      }

      if (!cUrl || !cUrl.startsWith('https://') || !cUrl.toLowerCase().includes('.mp4')) {
        if (customUrlErr) {
          customUrlErr.textContent = 'Custom source must be a secure direct HTTPS URL pointing to an .mp4 file';
          customUrlErr.hidden = false;
        }
        if (customUrlInput) customUrlInput.classList.add('input--error');
        submitBtn.classList.remove('btn--loading');
        submitBtn.disabled = false;
        return;
      }

      options.mediaUrl = cUrl;
      options.mediaTitle = cTitle;
    }

    try {
      const data = await API.createRoom(rName, name, options);
      roomCode = data.roomCode;
      roomName = data.name || rName;
      participantId = data.participantId;
      displayName = name;
      isHost = data.isHost;

      // Keep guest profile display name synchronized if a new name was entered
      if (currentUser && name && name !== currentUser.displayName) {
        currentUser.displayName = name;
        applyCurrentUser();
      }

      closeModal('modal-create');
      clearUploadedFile();
      if (roomNameInput) roomNameInput.value = '';
      enterLobby();
      showToast(`Room "${roomName}" (${roomCode}) created`, 'success');
      updateRecordsBadge();
    } catch (e) {
      const msg = e.message || 'Failed to create room';
      if (msg.toLowerCase().includes('room name') || msg.toLowerCase().includes('already active')) {
        if (roomNameError) {
          roomNameError.textContent = msg;
          roomNameError.hidden = false;
        }
        if (roomNameInput) roomNameInput.classList.add('input--error');
      } else {
        if (nameError) {
          nameError.textContent = msg;
          nameError.hidden = false;
        }
        if (nameInput) nameInput.classList.add('input--error');
      }
    } finally {
      submitBtn.classList.remove('btn--loading');
      submitBtn.disabled = false;
    }
  }

  // ─── Room Joining ─────────────────────────────────

  async function handleJoinRoom() {
    const codeInput = document.getElementById('join-code');
    const nameInput = document.getElementById('join-name');
    const codeError = document.getElementById('join-code-error');
    const nameError = document.getElementById('join-name-error');
    const submitBtn = document.getElementById('btn-join-submit');

    submitBtn.classList.add('btn--loading');
    submitBtn.disabled = true;

    try {
      await ensureSession();
    } catch (e) {
      // Proceed; API client will attempt transparent retry
    }

    const code = codeInput.value.trim().toUpperCase();
    let name = nameInput.value.trim();
    if (!name && currentUser) {
      name = currentUser.displayName;
    }

    // Validate
    let valid = true;
    if (!code || code.length < 4) {
      codeError.textContent = 'Enter a valid room code';
      codeError.hidden = false;
      codeInput.classList.add('input--error');
      valid = false;
    } else {
      codeError.hidden = true;
      codeInput.classList.remove('input--error');
    }

    if (!name || name.length < 2) {
      nameError.textContent = 'Please enter a display name (2-32 characters)';
      nameError.hidden = false;
      nameInput.classList.add('input--error');
      valid = false;
    } else {
      nameError.hidden = true;
      nameInput.classList.remove('input--error');
    }

    if (!valid) {
      submitBtn.classList.remove('btn--loading');
      submitBtn.disabled = false;
      return;
    }

    try {
      const data = await API.joinRoom(code, name);
      roomCode = data.roomCode;
      roomName = data.name || '';
      participantId = data.participantId;
      displayName = name;
      isHost = data.isHost;

      // Keep guest profile display name synchronized if a new name was entered
      if (currentUser && name && name !== currentUser.displayName) {
        currentUser.displayName = name;
        applyCurrentUser();
      }

      closeModal('modal-join');
      enterLobby();
      showToast(`Joined room ${roomCode}`, 'success');
      updateRecordsBadge();
    } catch (e) {
      codeError.textContent = e.message || 'Room not found';
      codeError.hidden = false;
      codeInput.classList.add('input--error');
    } finally {
      submitBtn.classList.remove('btn--loading');
      submitBtn.disabled = false;
    }
  }

  // ─── Lobby ────────────────────────────────────────

  function enterLobby() {
    showScreen('lobby');

    // Update lobby UI
    document.getElementById('lobby-room-code').textContent = roomCode;
    const nameEl = document.getElementById('lobby-room-name');
    if (nameEl) nameEl.textContent = roomName || 'Screening Room';

    // Connect WebSocket
    WS.init(roomCode);

    // Load commentary cues
    DirectorsCut.loadCues(roomCode);

    // Poll room info
    refreshLobby();
  }

  async function refreshLobby() {
    try {
      const data = await API.getRoom(roomCode);
      const room = data.room;
      hostParticipantId = room.hostParticipantId;
      isHost = (room.hostParticipantId === participantId);
      participants = data.participants || [];
      if (room.name) {
        roomName = room.name;
        const nameEl = document.getElementById('lobby-room-name');
        if (nameEl) nameEl.textContent = room.name;
      }

      // Toggle host shutdown button in lobby
      const btnShutdown = document.getElementById('btn-shutdown-lobby');
      if (btnShutdown) btnShutdown.hidden = !isHost;

      // Update screening card
      const mediaTitle = room.mediaTitle || extractMediaTitle(room.mediaUrl);
      const mediaTitleEl = document.getElementById('lobby-media-title');
      if (mediaTitleEl) mediaTitleEl.textContent = mediaTitle;

      const sourceBadge = document.getElementById('lobby-source-badge');
      if (sourceBadge) {
        if (room.mediaSourceType === 'custom') {
          sourceBadge.textContent = 'Custom MP4';
          sourceBadge.className = 'badge badge--source badge--source-custom';
        } else {
          sourceBadge.textContent = 'Curated Film';
          sourceBadge.className = 'badge badge--source';
        }
      }

      const mediaMetaEl = document.getElementById('lobby-media-meta');
      if (mediaMetaEl) {
        const sourceType = room.mediaSourceType === 'custom' ? 'Custom Hosted MP4' : 'Curated Short Film';
        const durStr = room.durationSeconds ? formatTime(room.durationSeconds) : '';
        mediaMetaEl.textContent = durStr ? `${sourceType} · ${durStr}` : sourceType;
      }

      document.getElementById('lobby-dc-badge').hidden = !room.directorCutEnabled;

      // Preload media metadata for VR screen initialization and preflight check
      if (room.mediaUrl) {
        Cinema.preloadMedia(
          room.mediaUrl,
          () => {
            if (window.XR && typeof XR.setMediaReady === 'function') {
              XR.setMediaReady(true, { duration: room.durationSeconds });
            }
          },
          () => {
            if (window.XR && typeof XR.setMediaReady === 'function') {
              XR.setMediaReady(false);
            }
          }
        );
      }

      // Update participant list
      updateParticipantList(participants);
    } catch (e) {
      console.warn('[app] failed to refresh lobby:', e);
    }
  }

  function updateParticipantList(parts) {
    const listEl = document.getElementById('lobby-participant-list');
    const countEl = document.getElementById('lobby-participant-count');

    countEl.textContent = parts.length;
    listEl.innerHTML = '';

    parts.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'participant-item';
      li.innerHTML = `
        <div class="avatar">${p.displayName.charAt(0).toUpperCase()}</div>
        <span class="participant-item__name">${escapeHtml(p.displayName)}</span>
        <div class="participant-item__badges">
          ${p.participantId === participantId ? '<span class="chip chip--presence chip--sm">You</span>' : ''}
          ${isParticipantHost(p.participantId) ? '<span class="badge badge--host">Host</span>' : ''}
        </div>
      `;
      listEl.appendChild(li);
    });
  }

  function isParticipantHost(pid) {
    return pid === hostParticipantId;
  }

  // ─── Cinema ───────────────────────────────────────

  function handleEnterCinema() {
    showScreen('cinema');

    // Get current room state for media URL
    API.getRoom(roomCode).then(data => {
      const room = data.room;
      hostParticipantId = room.hostParticipantId;
      isHost = room.hostParticipantId === participantId;

      Cinema.init(room.mediaUrl, isHost, () => {
        // Direct Quest entry: if user clicked "Enter VR Cinema", trigger WebXR
        if (XR.isSupported() && !XR.isInVR()) {
          XR.enterVR();
        }
      });
      Cinema.onEnded(() => {
        handleScreeningEnded();
      });

      // Update cinema UI
      document.getElementById('cinema-room-code').textContent = roomCode;
      const cinemaNameEl = document.getElementById('cinema-room-name');
      if (cinemaNameEl) cinemaNameEl.textContent = room.name || roomName;
      document.getElementById('cinema-participant-badge').textContent = (data.participants || []).length;

      // Direct Quest entry: if WebXR supported, request session immediately on click
      if (XR.isSupported() && !XR.isInVR()) {
        XR.enterVR();
      }

      // Sync playback state
      if (!room.isPaused) {
        const elapsed = (Date.now() - new Date(room.updatedAt).getTime()) / 1000;
        Cinema.seek(room.playbackPositionSeconds + elapsed);
        Cinema.play();
      } else {
        Cinema.seek(room.playbackPositionSeconds);
      }

      // Director's Cut state
      DirectorsCut.setEnabled(room.directorCutEnabled);
      DirectorsCut.startChecking(() => Cinema.getCurrentTime());

      // Add seat markers for existing participants
      (data.participants || []).forEach((p, i) => {
        if (p.participantId !== participantId) {
          Cinema.addSeatMarker(p.participantId, p.displayName, i);
        }
      });

      // Update video time display
      startTimeUpdater();
    }).catch(e => {
      console.error('[cinema] Enter cinema failed:', e);
      showToast(e.message || 'Failed to load cinema', 'error');
      showScreen('lobby');
    });
  }

  // ─── Playback Controls ────────────────────────────

  function handlePlayPause() {
    if (Cinema.isPlaying()) {
      Cinema.pause();
      if (isHost) WS.sendPlayback('pause', Cinema.getCurrentTime());
    } else {
      Cinema.play();
      if (isHost) WS.sendPlayback('play', Cinema.getCurrentTime());
    }
  }

  function handleSeek(delta) {
    const newPos = Math.max(0, Cinema.getCurrentTime() + delta);
    Cinema.seek(newPos);
    if (isHost) WS.sendPlayback('seek', newPos);
  }

  function handleProgressSeek(e) {
    const duration = Cinema.getDuration();
    if (!duration) return;
    const newPos = (e.target.value / 100) * duration;
    Cinema.seek(newPos);
    if (isHost) WS.sendPlayback('seek', newPos);
  }

  function handleToggleDirectorCut() {
    if (!isHost) {
      showToast('Only the host can toggle Director\'s Cut', 'error');
      return;
    }
    const newState = !DirectorsCut.isEnabled();
    DirectorsCut.setEnabled(newState);
    WS.sendDirectorCut(newState);
    showToast(newState ? 'Director\'s Cut enabled' : 'Director\'s Cut disabled', 'success');
  }

  // ─── Time Display & Screening Countdown Updater ───

  let timeUpdaterInterval = null;

  function startTimeUpdater() {
    stopTimeUpdater();
    timeUpdaterInterval = setInterval(() => {
      const current = Cinema.getCurrentTime();
      const duration = Cinema.getDuration();

      const currentEl = document.getElementById('cinema-time-current');
      if (currentEl) currentEl.textContent = formatTime(current);
      const durationEl = document.getElementById('cinema-time-duration');
      if (durationEl) durationEl.textContent = formatTime(duration);

      const progressBar = document.getElementById('cinema-progress');
      if (duration > 0 && progressBar) {
        progressBar.value = (current / duration) * 100;
      }

      // Live screening countdown chip in top-bar HUD
      const remainingSeconds = Math.max(0, duration - current);
      const countdownTextEl = document.getElementById('cinema-countdown-text');
      const countdownChipEl = document.getElementById('cinema-countdown-chip');
      if (countdownTextEl) {
        countdownTextEl.textContent = duration > 0 ? formatTime(remainingSeconds) : '--:--';
      }
      if (countdownChipEl) {
        if (duration > 0 && remainingSeconds <= 30 && remainingSeconds > 0) {
          countdownChipEl.classList.add('is-expiring');
        } else {
          countdownChipEl.classList.remove('is-expiring');
        }
      }

      // Screening completion detection (graceful 5s countdown)
      const videoEl = Cinema.getVideo();
      const isEnded = videoEl && videoEl.ended;
      if (duration > 0 && (remainingSeconds <= 0.4 || isEnded) && !isClosingSequenceActive) {
        handleScreeningEnded();
      }
    }, 250);
  }

  function stopTimeUpdater() {
    if (timeUpdaterInterval) {
      clearInterval(timeUpdaterInterval);
      timeUpdaterInterval = null;
    }
  }

  // ─── Graceful Screening Auto-Shutdown ──────────────

  let isClosingSequenceActive = false;
  let closingCountdownTimer = null;

  function handleScreeningEnded() {
    if (isClosingSequenceActive) return;
    isClosingSequenceActive = true;

    // Pause playback & stop updates
    Cinema.pause();
    stopTimeUpdater();

    // Show Graceful Closing Overlay
    const overlay = document.getElementById('cinema-closing-overlay');
    const countdownNum = document.getElementById('cinema-closing-countdown');
    const countdownSecs = document.getElementById('cinema-closing-secs');
    const progressFill = document.getElementById('cinema-closing-progress-fill');

    let secondsLeft = 5;
    if (overlay) overlay.hidden = false;
    if (countdownNum) countdownNum.textContent = secondsLeft;
    if (countdownSecs) countdownSecs.textContent = secondsLeft;
    if (progressFill) progressFill.style.width = '100%';

    if (closingCountdownTimer) clearInterval(closingCountdownTimer);
    closingCountdownTimer = setInterval(() => {
      secondsLeft -= 1;
      if (countdownNum) countdownNum.textContent = Math.max(0, secondsLeft);
      if (countdownSecs) countdownSecs.textContent = Math.max(0, secondsLeft);
      if (progressFill) {
        progressFill.style.width = `${Math.max(0, (secondsLeft / 5) * 100)}%`;
      }

      if (secondsLeft <= 0) {
        clearInterval(closingCountdownTimer);
        closingCountdownTimer = null;
        finalizeScreeningShutdown();
      }
    }, 1000);
  }

  async function finalizeScreeningShutdown() {
    const targetRoomCode = roomCode;
    const isCurrentHost = isHost;

    cleanupClosingOverlay();

    if (isCurrentHost && targetRoomCode) {
      try {
        await API.shutdownRoom(targetRoomCode);
      } catch (err) {
        console.warn('[cinema] Auto-shutdown API call warning:', err);
      }
    }

    leaveRoom(true);
    showToast('🎬 Screening complete. Thank you for watching!', 'info');
  }

  function cleanupClosingOverlay() {
    if (closingCountdownTimer) {
      clearInterval(closingCountdownTimer);
      closingCountdownTimer = null;
    }
    isClosingSequenceActive = false;
    const overlay = document.getElementById('cinema-closing-overlay');
    if (overlay) overlay.hidden = true;
  }

  // ─── Controls Auto-Hide ───────────────────────────

  function setupControlsAutoHide() {
    const controls = document.getElementById('cinema-controls');
    if (!controls) return;

    function showControls() {
      controls.classList.remove('is-hidden');
      clearTimeout(controlHideTimer);
      controlHideTimer = setTimeout(() => {
        // Don't hide if controls have focus or modal is open
        if (controls.matches(':focus-within')) return;
        controls.classList.add('is-hidden');
      }, 4000);
    }

    // Show on mouse movement
    document.addEventListener('mousemove', () => {
      if (currentScreen === 'cinema') showControls();
    });

    // Show on keyboard
    document.addEventListener('keydown', (e) => {
      if (currentScreen !== 'cinema') return;
      showControls();

      // Keyboard shortcuts
      if (e.target.tagName === 'INPUT') return;
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          handlePlayPause();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          handleSeek(-10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          handleSeek(10);
          break;
      }
    });

    // Show on touch
    document.addEventListener('touchstart', () => {
      if (currentScreen === 'cinema') showControls();
    }, { passive: true });
  }

  // ─── WebSocket Event Handlers ─────────────────────

  function setupWSHandlers() {
    WS.on('status', (data) => {
      updateConnectionStatus(data.state);
    });

    WS.on('room_state', (data) => {
      const payload = data.payload || {};
      hostParticipantId = payload.hostParticipantId;
      isHost = payload.hostParticipantId === participantId;
      participants = payload.participants || [];

      if (currentScreen === 'lobby') {
        updateParticipantList(participants);
        document.getElementById('lobby-dc-badge').hidden = !payload.directorCutEnabled;
      }

      if (currentScreen === 'cinema') {
        document.getElementById('cinema-participant-badge').textContent = participants.length;

        // Sync playback
        if (payload.isPaused) {
          Cinema.pause();
          Cinema.seek(payload.position);
        } else {
          const drift = (Date.now() - payload.serverTime) / 1000;
          Cinema.seek(payload.position + drift);
          Cinema.play();
        }

        DirectorsCut.setEnabled(payload.directorCutEnabled);
      }
    });

    WS.on('playback', (data) => {
      if (data.participantId === participantId) return; // Don't re-apply own actions
      const payload = data.payload || {};
      const drift = (Date.now() - payload.serverTime) / 1000;

      switch (payload.action) {
        case 'play':
          Cinema.seek(payload.position + drift);
          Cinema.play();
          break;
        case 'pause':
          Cinema.pause();
          Cinema.seek(payload.position);
          break;
        case 'seek':
          Cinema.seek(payload.position);
          break;
      }
    });

    WS.on('participant_joined', (data) => {
      showToast(`${data.displayName} joined`, 'success');
      refreshLobby();
      if (currentScreen === 'cinema') {
        const idx = Object.keys(Cinema).length; // approximate seat index
        Cinema.addSeatMarker(data.participantId, data.displayName, participants.length);
      }
    });

    WS.on('participant_left', (data) => {
      showToast(`${data.displayName} left`);
      refreshLobby();
      Cinema.removeSeatMarker(data.participantId);
    });

    WS.on('director_cut', (data) => {
      const payload = data.payload || {};
      DirectorsCut.setEnabled(payload.enabled);
      showToast(payload.enabled ? 'Director\'s Cut enabled by host' : 'Director\'s Cut disabled', 'success');
    });

    WS.on('room_shutdown', (data) => {
      const payload = data.payload || {};
      const reason = payload.reason || 'Screening room was shut down by host';
      showToast(reason, 'error');
      leaveRoom(true);
      updateRecordsBadge();
    });

    WS.on('error', (data) => {
      const payload = data.payload || {};
      showToast(payload.message || 'An error occurred', 'error');
    });
  }

  // ─── Connection Status ────────────────────────────

  function updateConnectionStatus(state) {
    const statusEl = document.getElementById('lobby-connection-status');
    if (!statusEl) return;

    const dot = statusEl.querySelector('.connection-status__dot');
    const text = statusEl.querySelector('.connection-status__text');

    // Remove all state classes
    dot.className = 'connection-status__dot';

    switch (state) {
      case 'connected':
        dot.classList.add('connection-status__dot--connected');
        text.textContent = 'Connected';
        break;
      case 'connecting':
        dot.classList.add('connection-status__dot--connecting');
        text.textContent = 'Connecting…';
        break;
      case 'reconnecting':
        dot.classList.add('connection-status__dot--connecting');
        text.textContent = 'Reconnecting…';
        break;
      case 'disconnected':
      case 'failed':
        dot.classList.add('connection-status__dot--disconnected');
        text.textContent = 'Disconnected';
        break;
    }
  }

  // ─── Screen Management ────────────────────────────

  function showScreen(name) {
    currentScreen = name;
    document.querySelectorAll('.screen').forEach(s => {
      s.hidden = !s.id.endsWith(name);
    });
  }

  // ─── Leave Room & Navigation ─────────────────────

  function leaveRoom(silent = false) {
    cleanupClosingOverlay();
    if (window.XR && typeof XR.isInVR === 'function' && XR.isInVR()) {
      XR.exitVR();
    }
    WS.disconnect();
    stopTimeUpdater();
    DirectorsCut.stopChecking();
    Cinema.destroy();

    roomCode = '';
    roomName = '';
    participantId = '';
    isHost = false;
    participants = [];

    showScreen('landing');
    if (!silent) {
      showToast('Left room');
    }
    updateRecordsBadge();
  }

  function goHome() {
    // If in lobby or cinema, cleanly exit the room session
    if (currentScreen !== 'landing') {
      leaveRoom();
    }

    // Close any open modals
    closeModal('modal-create');
    closeModal('modal-join');
    closeModal('modal-profile');
    closeModal('modal-records');

    // Display landing screen
    showScreen('landing');

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Clean up URL search/hash if present
    if (window.location.search || window.location.hash) {
      window.history.pushState({}, '', window.location.pathname);
    }

    updateRecordsBadge();
  }

  // ─── Room Records & Continued Access ──────────────

  let activeRecordsTab = 'created';

  async function updateRecordsBadge() {
    try {
      await ensureSession();
      const data = await API.getUserRooms();
      const createdCount = (data.createdRooms || []).length;
      const joinedCount = (data.joinedRooms || []).length;
      const totalCount = createdCount + joinedCount;

      const badgeNav = document.getElementById('records-chip-count') || document.getElementById('records-badge');
      if (badgeNav) {
        badgeNav.textContent = totalCount;
        badgeNav.hidden = totalCount === 0;
      }

      const badgeHero = document.getElementById('hero-records-count');
      if (badgeHero) {
        badgeHero.textContent = totalCount;
        badgeHero.hidden = totalCount === 0;
      }

      const badgeCreated = document.getElementById('badge-created-count');
      if (badgeCreated) badgeCreated.textContent = createdCount;

      const badgeJoined = document.getElementById('badge-joined-count');
      if (badgeJoined) badgeJoined.textContent = joinedCount;
    } catch (e) {
      // Session might not be initialized yet or offline
    }
  }

  function openRecordsModal() {
    openModal('modal-records');
    loadUserRooms();
  }

  function switchRecordsTab(tab) {
    activeRecordsTab = tab;
    const tabCreated = document.getElementById('tab-records-created');
    const tabJoined = document.getElementById('tab-records-joined');
    const paneCreated = document.getElementById('pane-created-rooms');
    const paneJoined = document.getElementById('pane-joined-rooms');

    if (tab === 'created') {
      if (tabCreated) {
        tabCreated.classList.add('is-active');
        tabCreated.setAttribute('aria-selected', 'true');
      }
      if (tabJoined) {
        tabJoined.classList.remove('is-active');
        tabJoined.setAttribute('aria-selected', 'false');
      }
      if (paneCreated) paneCreated.hidden = false;
      if (paneJoined) paneJoined.hidden = true;
    } else {
      if (tabJoined) {
        tabJoined.classList.add('is-active');
        tabJoined.setAttribute('aria-selected', 'true');
      }
      if (tabCreated) {
        tabCreated.classList.remove('is-active');
        tabCreated.setAttribute('aria-selected', 'false');
      }
      if (paneJoined) paneJoined.hidden = false;
      if (paneCreated) paneCreated.hidden = true;
    }
  }

  async function loadUserRooms() {
    const loadingEl = document.getElementById('records-loading');
    const listCreated = document.getElementById('list-created-rooms');
    const listJoined = document.getElementById('list-joined-rooms');
    const emptyCreated = document.getElementById('empty-created-rooms');
    const emptyJoined = document.getElementById('empty-joined-rooms');

    if (loadingEl) loadingEl.hidden = false;

    try {
      await ensureSession();
      const data = await API.getUserRooms();
      const createdRooms = data.createdRooms || [];
      const joinedRooms = data.joinedRooms || [];

      // Update badge counters
      const badgeCreated = document.getElementById('badge-created-count');
      if (badgeCreated) badgeCreated.textContent = createdRooms.length;
      const badgeJoined = document.getElementById('badge-joined-count');
      if (badgeJoined) badgeJoined.textContent = joinedRooms.length;

      const badgeNav = document.getElementById('records-chip-count') || document.getElementById('records-badge');
      if (badgeNav) {
        const total = createdRooms.length + joinedRooms.length;
        badgeNav.textContent = total;
        badgeNav.hidden = total === 0;
      }
      const badgeHero = document.getElementById('hero-records-count');
      if (badgeHero) {
        const total = createdRooms.length + joinedRooms.length;
        badgeHero.textContent = total;
        badgeHero.hidden = total === 0;
      }

      // If user has no created rooms but has joined rooms, switch to joined tab automatically
      if (createdRooms.length === 0 && joinedRooms.length > 0 && activeRecordsTab === 'created') {
        switchRecordsTab('joined');
      } else {
        switchRecordsTab(activeRecordsTab || 'created');
      }

      // Render Created Rooms
      if (listCreated) {
        listCreated.innerHTML = '';
        if (createdRooms.length === 0) {
          if (emptyCreated) emptyCreated.hidden = false;
        } else {
          if (emptyCreated) emptyCreated.hidden = true;
          createdRooms.forEach(room => {
            const card = renderRecordCard(room, true);
            listCreated.appendChild(card);
          });
        }
      }

      // Render Joined Rooms
      if (listJoined) {
        listJoined.innerHTML = '';
        if (joinedRooms.length === 0) {
          if (emptyJoined) emptyJoined.hidden = false;
        } else {
          if (emptyJoined) emptyJoined.hidden = true;
          joinedRooms.forEach(room => {
            const card = renderRecordCard(room, false);
            listJoined.appendChild(card);
          });
        }
      }
    } catch (e) {
      console.error('[records] failed to load room records:', e);
      showToast('Failed to load room records', 'error');
    } finally {
      if (loadingEl) loadingEl.hidden = true;
    }
  }

  function renderRecordCard(room, isCardHost) {
    const card = document.createElement('div');
    card.className = 'record-card';

    const rawTime = isCardHost ? room.createdAt : (room.joinedAt && !room.joinedAt.startsWith('0001') ? room.joinedAt : room.createdAt);
    const timeStr = formatRelativeTime(rawTime);
    const mediaTitle = room.mediaTitle || extractMediaTitle(room.mediaUrl) || 'Spatial Screening';
    const rName = room.name || 'Screening Room';
    const rCode = room.roomCode || room.code || '';

    const isExpired = room.expiresAt && !room.expiresAt.startsWith('0001') && (new Date(room.expiresAt).getTime() < Date.now());
    const isConcluded = (room.isActive === false) || room.isCompleted || isExpired;

    card.innerHTML = `
      <div class="record-card__header">
        <div class="record-card__title-group">
          <div class="record-card__title">${escapeHtml(rName)}</div>
          <div class="record-card__sub">
            <span class="chip chip--sm chip--code">${escapeHtml(rCode)}</span>
            <span>•</span>
            <span>${isCardHost ? 'Created' : 'Joined'} ${escapeHtml(timeStr)}</span>
          </div>
        </div>
        <div class="record-card__badge-wrap">
          ${isConcluded ? '<span class="chip chip--xs chip--secondary">Concluded</span>' : ''}
          ${isCardHost ? '<span class="badge badge--host">Host</span>' : '<span class="chip chip--xs chip--presence">Guest</span>'}
        </div>
      </div>
      <div class="record-card__body">
        <div class="record-card__media" title="${escapeHtml(mediaTitle)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
          <span>${escapeHtml(mediaTitle)}</span>
        </div>
        <div class="record-card__actions">
          ${isConcluded ? (
            isCardHost ? `
              <button class="btn btn--danger-ghost btn--sm btn-card-shutdown" type="button" data-code="${escapeHtml(rCode)}" data-name="${escapeHtml(rName)}">
                Remove
              </button>
              <button class="btn btn--ghost btn--sm" type="button" disabled style="opacity:0.5;cursor:not-allowed">
                Concluded
              </button>
            ` : `
              <button class="btn btn--danger-ghost btn--sm btn-card-leave" type="button" data-code="${escapeHtml(rCode)}" data-name="${escapeHtml(rName)}">
                Remove
              </button>
              <button class="btn btn--ghost btn--sm" type="button" disabled style="opacity:0.5;cursor:not-allowed">
                Concluded
              </button>
            `
          ) : (
            isCardHost ? `
              <button class="btn btn--danger-ghost btn--sm btn-card-shutdown" type="button" data-code="${escapeHtml(rCode)}" data-name="${escapeHtml(rName)}">
                Shutdown
              </button>
              <button class="btn btn--primary btn--sm btn-card-reenter" type="button" data-code="${escapeHtml(rCode)}" data-host="true">
                Re-enter
              </button>
            ` : `
              <button class="btn btn--danger-ghost btn--sm btn-card-leave" type="button" data-code="${escapeHtml(rCode)}" data-name="${escapeHtml(rName)}">
                Leave
              </button>
              <button class="btn btn--primary btn--sm btn-card-reenter" type="button" data-code="${escapeHtml(rCode)}" data-host="false">
                Re-enter
              </button>
            `
          )}
        </div>
      </div>
    `;

    // Wire up buttons
    const btnShutdown = card.querySelector('.btn-card-shutdown');
    if (btnShutdown) {
      btnShutdown.addEventListener('click', () => handleShutdownRoom(rCode, rName));
    }
    const btnLeave = card.querySelector('.btn-card-leave');
    if (btnLeave) {
      btnLeave.addEventListener('click', () => handleLeaveJoinedRoom(rCode, rName));
    }
    const btnReenter = card.querySelector('.btn-card-reenter');
    if (btnReenter) {
      btnReenter.addEventListener('click', () => reenterRoom(rCode, isCardHost));
    }

    return card;
  }

  async function reenterRoom(code, asHostRole) {
    closeModal('modal-records');

    try {
      if (asHostRole) {
        // As host, verify room state and resume
        const data = await API.getRoom(code);
        const room = data.room;
        roomCode = room.code;
        roomName = room.name || '';
        hostParticipantId = room.hostParticipantId;
        isHost = true;
        participantId = currentUser ? currentUser.id : participantId;
        enterLobby();
        showToast(`Re-entered "${roomName || roomCode}" as Host`, 'success');
      } else {
        // As guest, re-join with existing display name
        const nameToUse = (currentUser && currentUser.displayName) ? currentUser.displayName : (displayName || 'Guest');
        const data = await API.joinRoom(code, nameToUse);
        roomCode = data.roomCode;
        roomName = data.name || '';
        participantId = data.participantId;
        isHost = false;
        enterLobby();
        showToast(`Re-entered "${roomName || roomCode}"`, 'success');
      }
      updateRecordsBadge();
    } catch (e) {
      showToast(e.message || 'Failed to re-enter room', 'error');
      loadUserRooms(); // Refresh in case room was shutdown/deleted
    }
  }

  async function handleShutdownRoom(code, name) {
    const displayName = name || code;
    const confirmed = await showConfirmDialog({
      title: 'Shut Down Room?',
      primaryMessage: `Are you sure you want to shut down "${displayName}"?`,
      secondaryMessage: 'This will permanently close the screening and disconnect all participants.',
      confirmText: 'Shut Down Room',
      cancelText: 'Cancel',
      isDanger: true,
    });
    if (!confirmed) {
      return;
    }

    try {
      await API.shutdownRoom(code);
      showToast(`Room "${displayName}" shut down`, 'success');

      // If currently inside this room, return cleanly to landing
      if (roomCode === code) {
        leaveRoom(true);
      }

      await loadUserRooms();
      await updateRecordsBadge();
    } catch (e) {
      showToast(e.message || 'Failed to shut down room', 'error');
    }
  }

  function handleShutdownCurrentRoom() {
    if (!roomCode) return;
    handleShutdownRoom(roomCode, roomName);
  }

  async function handleLeaveJoinedRoom(code, name) {
    const displayName = name || code;
    const confirmed = await showConfirmDialog({
      title: 'Leave Room?',
      primaryMessage: `Leave "${displayName}"?`,
      secondaryMessage: 'This room will be removed from your continued access list.',
      confirmText: 'Leave Room',
      cancelText: 'Cancel',
      isDanger: true,
    });
    if (!confirmed) {
      return;
    }

    try {
      await API.leaveRoomSession(code);
      showToast(`Left "${displayName}"`, 'info');

      // If currently inside this room, return cleanly to landing
      if (roomCode === code) {
        leaveRoom(true);
      }

      await loadUserRooms();
      await updateRecordsBadge();
    } catch (e) {
      showToast(e.message || 'Failed to leave room', 'error');
    }
  }

  function formatRelativeTime(dateInput) {
    if (!dateInput) return 'recently';
    const date = new Date(dateInput);
    if (isNaN(date.getTime()) || date.getFullYear() < 2020) return 'recently';

    const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}h ago`;
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay < 30) return `${diffDay}d ago`;
    return date.toLocaleDateString();
  }

  // ─── Toast Notifications ──────────────────────────

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'toast--error' : type === 'success' ? 'toast--success' : ''}`;
    toast.textContent = message;

    container.appendChild(toast);

    // Trigger transition
    requestAnimationFrame(() => {
      toast.classList.add('is-visible');
    });

    // Remove after 3.5 seconds
    setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => toast.remove(), 250);
    }, 3500);
  }

  // ─── Utilities ────────────────────────────────────

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function extractMediaTitle(url) {
    if (!url) return 'Unknown';
    try {
      const pathname = new URL(url).pathname;
      const filename = pathname.split('/').pop();
      return filename
        .replace(/\.[^/.]+$/, '')
        .replace(/([A-Z])/g, ' $1')
        .replace(/[_-]/g, ' ')
        .trim() || 'Demo Film';
    } catch {
      return 'Demo Film';
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ─── Public API ───────────────────────────────────

  return {
    init,
    showToast,
    leaveRoom,
    showScreen,
    goHome,
    openRecordsModal,
    updateRecordsBadge,
    handleShutdownCurrentRoom,
    showConfirmDialog,
    closeConfirmDialog,
  };
})();

// ─── Bootstrap ──────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    App.init();
  });
} else {
  App.init();
}

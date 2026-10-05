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

    // Escape key closes modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
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
    if (!confirm('Generate a fresh guest identity? Your current session will be reset.')) return;
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

    try {
      const data = await API.createRoom(rName, name);
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
      document.getElementById('lobby-media-title').textContent = extractMediaTitle(room.mediaUrl);
      document.getElementById('lobby-dc-badge').hidden = !room.directorCutEnabled;

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

      Cinema.init(room.mediaUrl, isHost);

      // Update cinema UI
      document.getElementById('cinema-room-code').textContent = roomCode;
      const cinemaNameEl = document.getElementById('cinema-room-name');
      if (cinemaNameEl) cinemaNameEl.textContent = room.name || roomName;
      document.getElementById('cinema-participant-badge').textContent = (data.participants || []).length;

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
      showToast('Failed to load cinema', 'error');
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

  // ─── Time Display Updater ─────────────────────────

  let timeUpdaterInterval = null;

  function startTimeUpdater() {
    stopTimeUpdater();
    timeUpdaterInterval = setInterval(() => {
      const current = Cinema.getCurrentTime();
      const duration = Cinema.getDuration();

      document.getElementById('cinema-time-current').textContent = formatTime(current);
      document.getElementById('cinema-time-duration').textContent = formatTime(duration);

      const progressBar = document.getElementById('cinema-progress');
      if (duration > 0) {
        progressBar.value = (current / duration) * 100;
      }
    }, 250);
  }

  function stopTimeUpdater() {
    if (timeUpdaterInterval) {
      clearInterval(timeUpdaterInterval);
      timeUpdaterInterval = null;
    }
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
      const data = await API.getUserRooms();
      const createdCount = (data.createdRooms || []).length;
      const joinedCount = (data.joinedRooms || []).length;
      const totalCount = createdCount + joinedCount;

      const badgeNav = document.getElementById('records-badge');
      if (badgeNav) {
        badgeNav.textContent = totalCount;
        badgeNav.hidden = totalCount === 0;
      }

      const badgeHero = document.getElementById('hero-records-count');
      if (badgeHero) {
        badgeHero.textContent = totalCount;
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
      const data = await API.getUserRooms();
      const createdRooms = data.createdRooms || [];
      const joinedRooms = data.joinedRooms || [];

      // Update badge counters
      const badgeCreated = document.getElementById('badge-created-count');
      if (badgeCreated) badgeCreated.textContent = createdRooms.length;
      const badgeJoined = document.getElementById('badge-joined-count');
      if (badgeJoined) badgeJoined.textContent = joinedRooms.length;
      const badgeNav = document.getElementById('records-badge');
      if (badgeNav) {
        const total = createdRooms.length + joinedRooms.length;
        badgeNav.textContent = total;
        badgeNav.hidden = total === 0;
      }
      const badgeHero = document.getElementById('hero-records-count');
      if (badgeHero) {
        badgeHero.textContent = createdRooms.length + joinedRooms.length;
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
      showToast('Failed to load room records', 'error');
    } finally {
      if (loadingEl) loadingEl.hidden = true;
    }
  }

  function renderRecordCard(room, isCardHost) {
    const card = document.createElement('div');
    card.className = 'record-card';

    const timeStr = formatRelativeTime(room.createdAt || room.joinedAt);
    const mediaTitle = room.mediaTitle || extractMediaTitle(room.mediaUrl) || 'Spatial Screening';
    const rName = room.name || 'Screening Room';
    const rCode = room.code;

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
          ${isCardHost ? '<span class="badge badge--host">Host</span>' : '<span class="chip chip--xs chip--presence">Guest</span>'}
        </div>
      </div>
      <div class="record-card__body">
        <div class="record-card__media" title="${escapeHtml(mediaTitle)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
          <span>${escapeHtml(mediaTitle)}</span>
        </div>
        <div class="record-card__actions">
          ${isCardHost ? `
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
          `}
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
    if (!confirm(`Are you sure you want to shut down "${displayName}"?\n\nThis will permanently close the screening and disconnect all participants.`)) {
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
    if (!confirm(`Leave "${displayName}"?\n\nThis room will be removed from your continued access list.`)) {
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
    if (isNaN(date.getTime())) return 'recently';

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

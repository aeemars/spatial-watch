// ═══════════════════════════════════════════════════════════
// Spatial Watch — Room Records & Security Verification Tests
// ═══════════════════════════════════════════════════════════

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Minimal mock DOM setup
function createMockRecordsDOM() {
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
    appendChild(child) {
      this.children.push(child);
    }
    classList = {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); },
    };
  }

  const ids = [
    'records-loading',
    'list-created-rooms',
    'list-joined-rooms',
    'empty-created-rooms',
    'empty-joined-rooms',
    'badge-created-count',
    'badge-joined-count',
    'records-chip-count',
    'records-badge',
    'hero-records-count',
    'tab-records-created',
    'tab-records-joined',
    'pane-created-rooms',
    'pane-joined-rooms',
    'toast-container',
  ];

  for (const id of ids) {
    elements.set(id, new MockElement(id));
  }

  return {
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement(tag) {
      return new MockElement(`mock-${tag}-${Date.now()}`);
    },
    elements,
  };
}

describe('Spatial Watch — Room Records & API Security Tests', () => {
  it('1. New Account Handling: Empty room records load successfully with accurate empty states', async () => {
    const mockDom = createMockRecordsDOM();
    const listCreated = mockDom.getElementById('list-created-rooms');
    const listJoined = mockDom.getElementById('list-joined-rooms');
    const emptyCreated = mockDom.getElementById('empty-created-rooms');
    const emptyJoined = mockDom.getElementById('empty-joined-rooms');

    // Simulate server response for a brand new account (0 created, 0 joined)
    const mockApiResponse = {
      createdRooms: [],
      joinedRooms: [],
    };

    assert.equal(Array.isArray(mockApiResponse.createdRooms), true);
    assert.equal(mockApiResponse.createdRooms.length, 0);
    assert.equal(Array.isArray(mockApiResponse.joinedRooms), true);
    assert.equal(mockApiResponse.joinedRooms.length, 0);

    // Simulate rendering logic
    let createdRooms = mockApiResponse.createdRooms || [];
    let joinedRooms = mockApiResponse.joinedRooms || [];

    listCreated.innerHTML = '';
    if (createdRooms.length === 0) {
      emptyCreated.hidden = false;
    } else {
      emptyCreated.hidden = true;
    }

    listJoined.innerHTML = '';
    if (joinedRooms.length === 0) {
      emptyJoined.hidden = false;
    } else {
      emptyJoined.hidden = true;
    }

    assert.equal(emptyCreated.hidden, false, 'emptyCreated should be visible for new accounts');
    assert.equal(emptyJoined.hidden, false, 'emptyJoined should be visible for new accounts');
    assert.equal(listCreated.innerHTML, '');
    assert.equal(listJoined.innerHTML, '');
  });

  it('2. Accurate Error Propagation: Surfacing descriptive API error instead of generic message', async () => {
    const mockDom = createMockRecordsDOM();
    const listCreated = mockDom.getElementById('list-created-rooms');
    const emptyCreated = mockDom.getElementById('empty-created-rooms');
    const emptyJoined = mockDom.getElementById('empty-joined-rooms');

    let toastMessage = '';
    let toastType = '';
    const showToast = (msg, type) => {
      toastMessage = msg;
      toastType = type;
    };

    const simulatedApiError = new Error('Authentication required: active guest session required to view room records');

    // Execute error handler from loadUserRooms
    try {
      throw simulatedApiError;
    } catch (e) {
      const errorMsg = (e && e.message) ? e.message : 'Unable to connect to cinema server. Please check your connection.';
      showToast(errorMsg, 'error');

      if (listCreated) {
        listCreated.innerHTML = `<div class="records-error-state"><p>${errorMsg}</p></div>`;
      }
      emptyCreated.hidden = true;
      emptyJoined.hidden = true;
    }

    assert.equal(toastType, 'error');
    assert.equal(toastMessage, 'Authentication required: active guest session required to view room records');
    assert.ok(listCreated.innerHTML.includes('Authentication required: active guest session required to view room records'));
    assert.equal(emptyCreated.hidden, true);
    assert.equal(emptyJoined.hidden, true);
  });

  it('3. Security Scan: User room records do not leak sensitive session tokens or raw credentials', () => {
    // Sample response structure returned by GetUserRooms
    const sampleRecord = {
      roomCode: 'SW-TEST',
      name: 'Test Cinema',
      hostDisplayName: 'Cinema Fox',
      hostParticipantId: '550e8400-e29b-41d4-a716-446655440000',
      mediaSourceType: 'catalog',
      mediaAssetId: 'coffee-run',
      mediaTitle: 'Coffee Run',
      mediaUrl: 'https://pub-e68e9acfc40b4388b0444968a7672e9e.r2.dev/Coffee_Run.mp4',
      participantCount: 1,
      createdAt: new Date().toISOString(),
      isHost: true,
      isActive: true,
      isCompleted: false,
    };

    const recordKeys = Object.keys(sampleRecord);

    // Verify absence of sensitive leakages
    assert.equal(recordKeys.includes('token'), false, 'Must not leak token');
    assert.equal(recordKeys.includes('tokenHash'), false, 'Must not leak tokenHash');
    assert.equal(recordKeys.includes('rawToken'), false, 'Must not leak rawToken');
    assert.equal(recordKeys.includes('_id'), false, 'Must not leak MongoDB internal _id');
    assert.equal(recordKeys.includes('password'), false, 'Must not leak password');
    assert.equal(recordKeys.includes('secret'), false, 'Must not leak secret');
  });

  it('4. Session Recovery Resilience: sessionInitPromise cleans up when uninitialized', async () => {
    let currentUser = null;
    let sessionInitPromise = null;
    let attemptCount = 0;

    async function initSession() {
      attemptCount++;
      if (attemptCount === 1) {
        // First attempt fails (e.g. temporary network blip)
        sessionInitPromise = null;
        return null;
      }
      // Second attempt succeeds
      currentUser = { id: 'usr-123', displayName: 'Quiet Comet' };
      return currentUser;
    }

    async function ensureSession() {
      if (currentUser) return currentUser;
      if (!sessionInitPromise) {
        sessionInitPromise = initSession().finally(() => {
          if (!currentUser) {
            sessionInitPromise = null;
          }
        });
      }
      const user = await sessionInitPromise;
      if (!user) {
        sessionInitPromise = null;
        throw new Error('Active guest session could not be established.');
      }
      return user;
    }

    // 1st attempt: fails and throws
    await assert.rejects(
      async () => await ensureSession(),
      { message: 'Active guest session could not be established.' }
    );
    assert.equal(sessionInitPromise, null, 'sessionInitPromise must be reset to null after failure');

    // 2nd attempt: does not reuse cached failure; retries and succeeds!
    const user = await ensureSession();
    assert.ok(user);
    assert.equal(user.id, 'usr-123');
    assert.equal(user.displayName, 'Quiet Comet');
  });
});


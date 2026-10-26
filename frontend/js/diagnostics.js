/* ═══════════════════════════════════════════════════════════
   SPATIAL WATCH — Real-Time Rendering & Video Diagnostics
   Lightweight performance monitor for WebXR & cinema frame pacing.
   Disabled and unobtrusive in production by default.
   Toggle via:
     • URL query: ?debug=1
     • localStorage.setItem('sw_debug', 'true')
     • Keyboard shortcut: Ctrl+Shift+D
   ═══════════════════════════════════════════════════════════ */

const Diagnostics = (() => {
  let isDebugActive = false;
  let hudContainer = null;
  let lastMetrics = {};

  function init() {
    if (typeof window === 'undefined') return;

    // Check query params, localStorage, or global config
    let hasQuery = false;
    try {
      if (window.location && window.location.search) {
        const urlParams = new URLSearchParams(window.location.search);
        hasQuery = urlParams.get('debug') === '1' || urlParams.get('debug') === 'true';
      }
    } catch (_) {}

    let hasStorage = false;
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem) {
        hasStorage = localStorage.getItem('sw_debug') === 'true';
      } else if (typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem) {
        hasStorage = window.localStorage.getItem('sw_debug') === 'true';
      }
    } catch (_) {}

    const hasEnv = Boolean(window.ENV_DEBUG);

    isDebugActive = hasQuery || hasStorage || hasEnv;

    if (isDebugActive) {
      createHUD();
      log('[diagnostics] Development diagnostics mode ACTIVE');
    }

    // Toggle via keyboard shortcut Ctrl+Shift+D (or Cmd+Shift+D)
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
          e.preventDefault();
          toggle();
        }
      });
    }
  }

  function isEnabled() {
    return isDebugActive;
  }

  function enable() {
    isDebugActive = true;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('sw_debug', 'true');
      else if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem('sw_debug', 'true');
    } catch (_) {}
    createHUD();
    log('[diagnostics] Development diagnostics mode ENABLED');
    if (typeof App !== 'undefined' && App.showToast) {
      App.showToast('Diagnostics HUD enabled (Ctrl+Shift+D to hide)', 'info');
    }
  }

  function disable() {
    isDebugActive = false;
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem('sw_debug');
      else if (typeof window !== 'undefined' && window.localStorage) window.localStorage.removeItem('sw_debug');
    } catch (_) {}
    destroyHUD();
    console.log('[Spatial Watch] Diagnostics mode DISABLED');
    if (typeof App !== 'undefined' && App.showToast) {
      App.showToast('Diagnostics HUD disabled', 'info');
    }
  }

  function toggle() {
    if (isDebugActive) {
      disable();
    } else {
      enable();
    }
  }

  function log(msg, ...args) {
    if (!isDebugActive) return;
    console.log(`%c[Spatial Watch] ${msg}`, 'color: #e7bc72; font-weight: bold;', ...args);
  }

  function warn(msg, ...args) {
    if (!isDebugActive) return;
    console.warn(`[Spatial Watch] ${msg}`, ...args);
  }

  function createHUD() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('cinema-diagnostics-hud')) return;

    hudContainer = document.createElement('div');
    hudContainer.id = 'cinema-diagnostics-hud';
    hudContainer.style.position = 'fixed';
    hudContainer.style.top = '12px';
    hudContainer.style.right = '12px';
    hudContainer.style.zIndex = '99999';
    hudContainer.style.background = 'rgba(8, 10, 16, 0.88)';
    hudContainer.style.border = '1px solid rgba(231, 188, 114, 0.4)';
    hudContainer.style.borderRadius = '8px';
    hudContainer.style.padding = '8px 12px';
    hudContainer.style.fontFamily = 'monospace';
    hudContainer.style.fontSize = '11px';
    hudContainer.style.lineHeight = '1.45';
    hudContainer.style.color = '#F4F1EA';
    hudContainer.style.pointerEvents = 'none';
    hudContainer.style.backdropFilter = 'blur(6px)';
    hudContainer.style.boxShadow = '0 4px 16px rgba(0,0,0,0.5)';
    hudContainer.innerHTML = '<div><strong>Spatial Watch Diagnostics</strong></div><div>Initializing…</div>';

    document.body.appendChild(hudContainer);
  }

  function destroyHUD() {
    if (hudContainer && hudContainer.parentNode) {
      hudContainer.parentNode.removeChild(hudContainer);
    }
    hudContainer = null;
  }

  function updateMetrics(metrics = {}) {
    if (!isDebugActive) return;
    lastMetrics = { ...lastMetrics, ...metrics };

    if (!hudContainer) {
      createHUD();
    }
    if (!hudContainer) return;

    const fpsColor = (lastMetrics.fps || 0) >= 58 ? '#10b981' : ((lastMetrics.fps || 0) >= 45 ? '#f59e0b' : '#ef4444');
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1).toFixed(2) : '1.0';

    hudContainer.innerHTML = `
      <div style="color: #e7bc72; font-weight: bold; margin-bottom: 2px;">SPATIAL WATCH DIAGNOSTICS</div>
      <div>Render FPS: <span style="color: ${fpsColor}; font-weight: bold;">${lastMetrics.fps || 0}</span> (${(lastMetrics.frameTimeMs || 0).toFixed(1)} ms)</div>
      <div>Presented Frames: <strong>${lastMetrics.presentedFrames || 0}</strong></div>
      <div>Dropped Frames: <span style="color: ${(lastMetrics.droppedFrames || 0) > 0 ? '#ef4444' : '#10b981'};">${lastMetrics.droppedFrames || 0}</span></div>
      <div>Video Time: ${(lastMetrics.videoTime || 0).toFixed(2)}s</div>
      <div>Sync Drift: ${typeof lastMetrics.drift === 'number' ? `${(lastMetrics.drift * 1000).toFixed(0)} ms` : '0 ms'}</div>
      <div>Mode: <span style="color: ${lastMetrics.isVR ? '#a78bfa' : '#38bdf8'}; font-weight: bold;">${lastMetrics.isVR ? 'WebXR Immersive-VR' : 'Desktop 3D'}</span> (DPR: ${dpr})</div>
      <div>vFC Active: ${lastMetrics.hasVFC ? '<span style="color:#10b981">true</span>' : '<span style="color:#f59e0b">false (fallback)</span>'}</div>
    `;
  }

  function getMetrics() {
    return { ...lastMetrics };
  }

  return {
    init,
    isEnabled,
    enable,
    disable,
    toggle,
    log,
    warn,
    updateMetrics,
    getMetrics,
  };
})();

if (typeof window !== 'undefined') {
  window.Diagnostics = Diagnostics;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Diagnostics.init());
  } else {
    Diagnostics.init();
  }
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Diagnostics;
}

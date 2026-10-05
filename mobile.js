/**
 * Smart Room Human Counter - Mobile Camera Transmitter
 */

(function () {
  'use strict';

  // --- STATE ---
  const state = {
    signaling: null,
    peerConnection: null,
    localStream: null,
    isStreaming: false,
    facingMode: 'environment', // Rear camera by default
    desktopConnected: false,
    activeResolution: '--',
    streamStartTime: null,
    uptimeTimer: null
  };

  // --- DOM ELEMENTS ---
  const els = {
    signalingDot: document.getElementById('signalingDot'),
    signalingStatusText: document.getElementById('signalingStatusText'),
    desktopDot: document.getElementById('desktopDot'),
    desktopStatusText: document.getElementById('desktopStatusText'),
    
    localVideo: document.getElementById('localVideo'),
    cameraStandbyMsg: document.getElementById('cameraStandbyMsg'),
    cameraBadge: document.getElementById('cameraBadge'),
    streamResolution: document.getElementById('streamResolution'),
    streamDuration: document.getElementById('streamDuration'),
    
    btnToggleCamera: document.getElementById('btnToggleCamera'),
    btnFlipCamera: document.getElementById('btnFlipCamera'),
    
    alertCard: document.getElementById('alertCard'),
    alertTitle: document.getElementById('alertTitle'),
    alertMessage: document.getElementById('alertMessage')
  };

  // --- INITIALIZATION ---
  function init() {
    setupEventListeners();
    initSignaling();
    checkSecureContext();
  }

  // --- CHECK SECURE CONTEXT ---
  function checkSecureContext() {
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!window.isSecureContext && !isLocalhost) {
      showAlert(
        'Browser Security Limitation Detected',
        'Mobile browsers (Chrome / Safari) strictly require HTTPS to access the camera over a local network IP address.<br><br>' +
        '<strong>Recommended Fix:</strong><br>' +
        '1. Restart the server with HTTPS: <code>npm run start:https</code><br>' +
        '2. Open <code>https://' + window.location.host + '/mobile</code><br>' +
        '3. Tap "Advanced" &rarr; "Proceed" to accept the local self-signed certificate.<br><br>' +
        '<strong>Alternative (Android Chrome):</strong><br>' +
        'Open <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>, add <code>' + window.location.origin + '</code>, enable it and relaunch Chrome.'
      );
    }
  }

  // --- WEBRTC SIGNALING ---
  function initSignaling() {
    state.signaling = new SignalingClient('mobile', 'default');

    state.signaling.on('connection-change', ({ status }) => {
      console.log('[Mobile] Signaling status:', status);
      if (status === 'connected') {
        els.signalingDot.className = 'status-dot connected';
        els.signalingStatusText.textContent = 'Server: Connected';
      } else if (status === 'connecting') {
        els.signalingDot.className = 'status-dot connecting';
        els.signalingStatusText.textContent = 'Server: Connecting...';
      } else {
        els.signalingDot.className = 'status-dot disconnected';
        els.signalingStatusText.textContent = 'Server: Offline';
      }
    });

    state.signaling.on('peer-status', ({ peer, connected }) => {
      if (peer === 'desktop') {
        state.desktopConnected = connected;
        if (connected) {
          els.desktopDot.className = 'status-dot connected';
          els.desktopStatusText.textContent = 'Desktop: Ready';
          
          // If camera is already streaming, re-negotiate WebRTC offer
          if (state.isStreaming && state.localStream) {
            startWebRTCStreaming();
          }
        } else {
          els.desktopDot.className = 'status-dot disconnected';
          els.desktopStatusText.textContent = 'Desktop: Waiting';
        }
      }
    });

    state.signaling.on('signal', async ({ sender, payload }) => {
      if (sender === 'desktop') {
        await handleDesktopSignal(payload);
      }
    });

    state.signaling.connect();
  }

  // --- WEBRTC PEER CONNECTION ---
  async function startWebRTCStreaming() {
    if (!state.localStream) {
      console.warn('[WebRTC] Cannot start stream: No local video stream available.');
      return;
    }

    if (state.peerConnection) {
      state.peerConnection.close();
      state.peerConnection = null;
    }

    console.log('[WebRTC] Creating RTCPeerConnection...');
    const pc = new RTCPeerConnection(window.RTC_CONFIG);
    state.peerConnection = pc;

    // Add local tracks to WebRTC
    state.localStream.getTracks().forEach((track) => {
      console.log('[WebRTC] Adding local track:', track.kind, track.label);
      pc.addTrack(track, state.localStream);
    });

    // Handle ICE Candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        state.signaling.sendSignal('desktop', {
          type: 'candidate',
          candidate: event.candidate
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        els.desktopDot.className = 'status-dot connected';
        els.desktopStatusText.textContent = 'Desktop: Streaming';
        state.signaling.sendCameraStatus('streaming', {
          resolution: state.activeResolution,
          facingMode: state.facingMode
        });
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        els.desktopDot.className = 'status-dot disconnected';
        els.desktopStatusText.textContent = 'Desktop: Disconnected';
      }
    };

    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false
      });
      await pc.setLocalDescription(offer);
      console.log('[WebRTC] Offer created, sending to desktop...');
      state.signaling.sendSignal('desktop', offer);
    } catch (err) {
      console.error('[WebRTC] Failed to create offer:', err);
    }
  }

  async function handleDesktopSignal(data) {
    try {
      if (data.type === 'answer' && state.peerConnection) {
        console.log('[WebRTC] Received answer from desktop, setting remote description...');
        await state.peerConnection.setRemoteDescription(new RTCSessionDescription(data));
      } else if (data.type === 'candidate' && state.peerConnection) {
        try {
          await state.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.warn('[WebRTC] Error adding ICE candidate:', e);
        }
      }
    } catch (err) {
      console.error('[WebRTC] Error handling signal:', err);
    }
  }

  // --- CAMERA CONTROLS ---
  async function startCamera() {
    hideAlert();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showAlert(
        'Camera API Not Available',
        'Your browser blocked access to the camera API. On mobile devices, browsers strictly require a secure context (HTTPS).<br><br>' +
        'Please restart the server with <code>npm run start:https</code> and reload over HTTPS.'
      );
      return;
    }

    try {
      const constraints = {
        audio: false,
        video: {
          facingMode: { ideal: state.facingMode },
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 }
        }
      };

      console.log('[Camera] Requesting camera permission with constraints:', constraints);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      state.localStream = stream;
      els.localVideo.srcObject = stream;
      state.isStreaming = true;

      // Handle video load metadata
      els.localVideo.onloadedmetadata = () => {
        state.activeResolution = `${els.localVideo.videoWidth}x${els.localVideo.videoHeight}`;
        els.streamResolution.textContent = state.activeResolution;
        console.log(`[Camera] Started successfully at ${state.activeResolution}`);
      };

      await els.localVideo.play();

      // Update UI
      els.cameraStandbyMsg.style.display = 'none';
      els.cameraBadge.classList.add('live');
      els.cameraBadge.textContent = '● LIVE BROADCAST';
      els.btnToggleCamera.textContent = '⏹ Stop Camera';
      els.btnToggleCamera.className = 'btn-large btn-stop';
      els.btnFlipCamera.disabled = false;

      // Start stream duration counter
      state.streamStartTime = Date.now();
      startDurationTimer();

      // Start WebRTC streaming to desktop
      startWebRTCStreaming();

    } catch (err) {
      console.error('[Camera] Error starting camera:', err);
      handleCameraError(err);
    }
  }

  function stopCamera() {
    if (state.localStream) {
      state.localStream.getTracks().forEach((track) => track.stop());
      state.localStream = null;
    }

    if (state.peerConnection) {
      state.peerConnection.close();
      state.peerConnection = null;
    }

    state.isStreaming = false;
    els.localVideo.srcObject = null;
    els.cameraStandbyMsg.style.display = 'flex';
    els.cameraBadge.classList.remove('live');
    els.cameraBadge.textContent = 'STANDBY';
    els.streamResolution.textContent = '--';
    els.btnToggleCamera.textContent = '📷 Start Camera';
    els.btnToggleCamera.className = 'btn-large btn-start';
    els.btnFlipCamera.disabled = true;

    stopDurationTimer();
    els.streamDuration.textContent = '00:00';

    if (state.signaling) {
      state.signaling.sendCameraStatus('stopped');
    }
  }

  async function flipCamera() {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    console.log('[Camera] Flipping camera to:', state.facingMode);
    
    // Restart camera with new facing mode
    if (state.isStreaming) {
      if (state.localStream) {
        state.localStream.getTracks().forEach(t => t.stop());
      }
      await startCamera();
    }
  }

  // --- ERROR HANDLING ---
  function handleCameraError(err) {
    let title = 'Camera Access Error';
    let message = err.message || 'An unknown error occurred.';

    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      title = 'Camera Permission Denied';
      message = 'Camera permission is required.<br><br>' +
        'Please tap the lock or settings icon in your browser URL bar, grant Camera permission, and try again.';
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      title = 'Camera Not Found';
      message = 'No camera hardware was detected on this device.';
    } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      title = 'Camera Already In Use';
      message = 'The camera is currently being used by another application or tab. Please close other camera apps and retry.';
    } else if (err.name === 'OverconstrainedError') {
      title = 'Camera Constraint Error';
      message = 'The requested camera mode is not supported by your hardware.';
      // Try again with basic fallback constraints
      state.facingMode = 'user';
    }

    showAlert(title, message);
    stopCamera();
  }

  function showAlert(title, message) {
    els.alertTitle.innerHTML = title;
    els.alertMessage.innerHTML = message;
    els.alertCard.classList.add('show');
  }

  function hideAlert() {
    els.alertCard.classList.remove('show');
  }

  // --- TIMERS ---
  function startDurationTimer() {
    stopDurationTimer();
    state.uptimeTimer = setInterval(() => {
      if (!state.streamStartTime) return;
      const elapsed = Math.floor((Date.now() - state.streamStartTime) / 1000);
      const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const secs = String(elapsed % 60).padStart(2, '0');
      els.streamDuration.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  function stopDurationTimer() {
    if (state.uptimeTimer) {
      clearInterval(state.uptimeTimer);
      state.uptimeTimer = null;
    }
  }

  // --- EVENT LISTENERS ---
  function setupEventListeners() {
    els.btnToggleCamera.addEventListener('click', () => {
      if (state.isStreaming) {
        stopCamera();
      } else {
        startCamera();
      }
    });

    els.btnFlipCamera.addEventListener('click', flipCamera);
  }

  // Auto boot
  window.addEventListener('DOMContentLoaded', init);
})();

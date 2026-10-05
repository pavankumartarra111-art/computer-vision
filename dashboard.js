/**
 * Smart Room Human Counter - Desktop Dashboard Controller
 */

(function () {
  'use strict';

  // --- APPLICATION STATE ---
  const state = {
    model: null,
    isModelLoading: true,
    isMonitoring: true,
    peerConnection: null,
    signaling: null,
    videoSource: 'none', // 'mobile', 'webcam', 'none'
    localWebcamStream: null,
    
    // Detection & Thresholds
    confidenceThreshold: 0.5,
    smoothingWindowSize: 7,
    recentCounts: [],
    currentHumanCount: 0,
    crowdThresholds: {
      lowMax: 3,     // 0 - 3: LOW
      mediumMax: 8,  // 4 - 8: MEDIUM
      highMax: 15    // 9 - 15: HIGH, 16+: VERY HIGH
    },
    
    // Analytics
    sessionCounts: [],
    maxCount: 0,
    totalDetectionsCount: 0,
    confidenceSum: 0,
    detectionRuns: 0,
    lastFrameTime: performance.now(),
    fps: 0,
    fpsHistory: [],
    
    // Visual toggles
    showBoxes: true,
    showLabels: true,
    audioAlerts: false,
    
    // Sparkline history (last 30 points)
    sparklineData: Array(30).fill(0),
    sparklineTimer: null,
    
    // Uptime
    startTime: Date.now()
  };

  // --- DOM ELEMENTS ---
  const els = {
    // Header
    sessionUptime: document.getElementById('sessionUptime'),
    engineStatus: document.getElementById('engineStatus'),
    btnStartStop: document.getElementById('btnStartStop'),
    btnReconnect: document.getElementById('btnReconnect'),
    btnTestWebcam: document.getElementById('btnTestWebcam'),
    
    // Connection Card
    qrImage: document.getElementById('qrImage'),
    mobileUrlDisplay: document.getElementById('mobileUrlDisplay'),
    btnCopyUrl: document.getElementById('btnCopyUrl'),
    mobileStatusPill: document.getElementById('mobileStatusPill'),
    ipSelect: document.getElementById('ipSelect'),
    
    // Network Info
    infoHost: document.getElementById('infoHost'),
    infoPort: document.getElementById('infoPort'),
    infoLanIp: document.getElementById('infoLanIp'),
    infoProtocol: document.getElementById('infoProtocol'),
    
    // Video & Viewfinder
    viewfinderWrapper: document.getElementById('viewfinderWrapper'),
    remoteVideo: document.getElementById('remoteVideo'),
    detectionCanvas: document.getElementById('detectionCanvas'),
    emptyState: document.getElementById('emptyState'),
    hudResolution: document.getElementById('hudResolution'),
    hudFps: document.getElementById('hudFps'),
    hudSource: document.getElementById('hudSource'),
    toggleBoxes: document.getElementById('toggleBoxes'),
    toggleLabels: document.getElementById('toggleLabels'),
    btnFullscreen: document.getElementById('btnFullscreen'),
    
    // Metrics
    heroCount: document.getElementById('heroCount'),
    heroCountSub: document.getElementById('heroCountSub'),
    crowdBadge: document.getElementById('crowdBadge'),
    trendCanvas: document.getElementById('trendCanvas'),
    
    // Stats Matrix
    statAvgCount: document.getElementById('statAvgCount'),
    statMaxCount: document.getElementById('statMaxCount'),
    statConfidence: document.getElementById('statConfidence'),
    statInferenceFps: document.getElementById('statInferenceFps'),
    
    // Controls
    confidenceSlider: document.getElementById('confidenceSlider'),
    confidenceValDisplay: document.getElementById('confidenceValDisplay'),
    smoothingSelect: document.getElementById('smoothingSelect'),
    soundAlertToggle: document.getElementById('soundAlertToggle')
  };

  const canvasCtx = els.detectionCanvas.getContext('2d');
  const trendCtx = els.trendCanvas.getContext('2d');

  // --- INITIALIZATION ---
  async function init() {
    setupEventListeners();
    startSessionTimer();
    startSparklineUpdater();
    
    // Fetch network config & QR
    await loadNetworkConfig();
    
    // Initialize WebRTC signaling
    initSignaling();
    
    // Load TensorFlow.js Object Detection Model
    await loadDetectionModel();
    
    // Start continuous detection animation loop
    requestAnimationFrame(detectionLoop);
  }

  // --- NETWORK CONFIG & QR ---
  async function loadNetworkConfig(selectedIp = null) {
    try {
      const url = selectedIp ? `/api/config?ip=${encodeURIComponent(selectedIp)}` : '/api/config';
      const res = await fetch(url);
      const data = await res.json();

      els.qrImage.src = data.qrCode;
      els.mobileUrlDisplay.textContent = data.mobileUrl;
      els.mobileUrlDisplay.dataset.url = data.mobileUrl;
      
      els.infoHost.textContent = data.host;
      els.infoPort.textContent = data.port;
      els.infoLanIp.textContent = data.selectedIp || data.lanIp;
      els.infoProtocol.textContent = data.protocol.toUpperCase();

      // Populate IP select dropdown if empty
      if (els.ipSelect && els.ipSelect.children.length === 0 && data.allIps) {
        data.allIps.forEach(item => {
          const opt = document.createElement('option');
          opt.value = item.address;
          opt.textContent = `${item.name} (${item.address})`;
          if (item.address === (data.selectedIp || data.lanIp)) {
            opt.selected = true;
          }
          els.ipSelect.appendChild(opt);
        });
      }
    } catch (err) {
      console.error('Failed to load network config:', err);
    }
  }

  // --- MODEL LOADING ---
  async function loadDetectionModel() {
    updateEngineStatus('Loading AI Model...', 'amber');
    try {
      // Use COCO-SSD with lite_mobilenet_v2 for max frame rate & low latency
      state.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      state.isModelLoading = false;
      updateEngineStatus('Model Ready (COCO-SSD)', 'emerald');
      console.log('[Vision] TensorFlow.js COCO-SSD model loaded successfully.');
    } catch (err) {
      console.error('[Vision] Failed to load model:', err);
      // Fallback to default base
      try {
        state.model = await cocoSsd.load();
        state.isModelLoading = false;
        updateEngineStatus('Model Ready (Default)', 'emerald');
      } catch (err2) {
        updateEngineStatus('Model Error', 'rose');
        console.error('[Vision] Critical: Model failed to load completely:', err2);
      }
    }
  }

  // --- WEBRTC SIGNALING ---
  function initSignaling() {
    state.signaling = new SignalingClient('desktop', 'default');

    state.signaling.on('connection-change', ({ status }) => {
      console.log('[Dashboard] Signaling connection status:', status);
    });

    state.signaling.on('peer-status', ({ peer, connected }) => {
      if (peer === 'mobile') {
        if (connected) {
          updateMobileStatus('connected', 'Mobile: Connected');
        } else {
          updateMobileStatus('waiting', 'Waiting for mobile camera');
          if (state.videoSource === 'mobile') {
            stopVideoFeed();
          }
        }
      }
    });

    state.signaling.on('signal', async ({ sender, payload }) => {
      if (sender === 'mobile') {
        await handleMobileSignal(payload);
      }
    });

    state.signaling.on('camera-status', (payload) => {
      console.log('[Dashboard] Mobile camera status update:', payload);
      if (payload.status === 'stopped' && state.videoSource === 'mobile') {
        stopVideoFeed();
      }
    });

    state.signaling.connect();
  }

  // --- WEBRTC PEER CONNECTION ---
  async function setupPeerConnection() {
    if (state.peerConnection) {
      state.peerConnection.close();
      state.peerConnection = null;
    }

    const pc = new RTCPeerConnection(window.RTC_CONFIG);
    state.peerConnection = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        state.signaling.sendSignal('mobile', {
          type: 'candidate',
          candidate: event.candidate
        });
      }
    };

    pc.ontrack = (event) => {
      console.log('[WebRTC] Received remote stream track:', event.track.kind);
      if (event.streams && event.streams[0]) {
        els.remoteVideo.srcObject = event.streams[0];
        state.videoSource = 'mobile';
        els.hudSource.textContent = 'Mobile Camera (WebRTC)';
        hideEmptyState();
        
        els.remoteVideo.play().catch(e => console.warn('Autoplay error:', e));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state changed:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        updateMobileStatus('connected', 'Mobile: Streaming Live');
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        updateMobileStatus('disconnected', 'Mobile: Disconnected');
        if (state.videoSource === 'mobile') {
          stopVideoFeed();
        }
      }
    };

    return pc;
  }

  async function handleMobileSignal(data) {
    try {
      if (data.type === 'offer') {
        console.log('[WebRTC] Handling offer from mobile...');
        const pc = await setupPeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        state.signaling.sendSignal('mobile', answer);
      } else if (data.type === 'candidate' && state.peerConnection) {
        try {
          await state.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.warn('[WebRTC] Error adding ICE candidate:', e);
        }
      }
    } catch (err) {
      console.error('[WebRTC] Error handling mobile signal:', err);
    }
  }

  // --- LAPTOP WEBCAM TEST MODE ---
  async function toggleLaptopWebcam() {
    if (state.videoSource === 'webcam') {
      // Turn off webcam
      if (state.localWebcamStream) {
        state.localWebcamStream.getTracks().forEach(t => t.stop());
        state.localWebcamStream = null;
      }
      stopVideoFeed();
      els.btnTestWebcam.textContent = '🧪 Test with Laptop Webcam';
      els.btnTestWebcam.classList.remove('btn-danger');
      els.btnTestWebcam.classList.add('btn-secondary');
    } else {
      // Turn on webcam
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });
        state.localWebcamStream = stream;
        els.remoteVideo.srcObject = stream;
        state.videoSource = 'webcam';
        els.hudSource.textContent = 'Laptop Webcam (Local Test)';
        hideEmptyState();
        els.remoteVideo.play();
        
        els.btnTestWebcam.textContent = '⏹ Stop Laptop Webcam';
        els.btnTestWebcam.classList.remove('btn-secondary');
        els.btnTestWebcam.classList.add('btn-danger');
      } catch (err) {
        alert('Could not access laptop webcam: ' + err.message);
      }
    }
  }

  function hideEmptyState() {
    els.emptyState.style.opacity = '0';
    els.emptyState.style.pointerEvents = 'none';
  }

  function showEmptyState() {
    els.emptyState.style.opacity = '1';
    els.emptyState.style.pointerEvents = 'auto';
    canvasCtx.clearRect(0, 0, els.detectionCanvas.width, els.detectionCanvas.height);
  }

  function stopVideoFeed() {
    state.videoSource = 'none';
    els.remoteVideo.srcObject = null;
    els.hudSource.textContent = 'No Signal';
    els.hudResolution.textContent = '--';
    els.hudFps.textContent = '-- FPS';
    showEmptyState();
    updateHumanCount(0, 0);
  }

  // --- DETECTION LOOP ---
  async function detectionLoop() {
    if (state.isMonitoring && !state.isModelLoading && state.model && state.videoSource !== 'none') {
      const video = els.remoteVideo;

      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused) {
        // Sync canvas dimensions with actual video resolution
        if (els.detectionCanvas.width !== video.videoWidth || els.detectionCanvas.height !== video.videoHeight) {
          els.detectionCanvas.width = video.videoWidth;
          els.detectionCanvas.height = video.videoHeight;
          els.hudResolution.textContent = `${video.videoWidth}x${video.videoHeight}`;
        }

        const now = performance.now();
        const delta = now - state.lastFrameTime;
        state.lastFrameTime = now;
        if (delta > 0) {
          const instantFps = 1000 / delta;
          state.fpsHistory.push(instantFps);
          if (state.fpsHistory.length > 10) state.fpsHistory.shift();
          state.fps = Math.round(state.fpsHistory.reduce((a, b) => a + b, 0) / state.fpsHistory.length);
          els.hudFps.textContent = `${state.fps} FPS`;
          els.statInferenceFps.textContent = `${state.fps}`;
        }

        try {
          // Detect objects in current frame
          const predictions = await state.model.detect(video);
          
          // STRICT FILTER: Humans/Persons ONLY with score >= confidenceThreshold
          const persons = predictions.filter(
            p => p.class === 'person' && p.score >= state.confidenceThreshold
          );

          // Render visual bounding boxes
          renderBoundingBoxes(persons, video.videoWidth, video.videoHeight);

          // Update smoothed count & statistics
          processDetections(persons);

        } catch (e) {
          console.warn('[Detection] Inference error:', e);
        }
      }
    }

    requestAnimationFrame(detectionLoop);
  }

  // --- RENDER BOUNDING BOXES ---
  function renderBoundingBoxes(persons, width, height) {
    canvasCtx.clearRect(0, 0, width, height);

    if (!state.showBoxes && !state.showLabels) return;

    persons.forEach(person => {
      const [x, y, w, h] = person.bbox;
      const score = Math.round(person.score * 100);

      if (state.showBoxes) {
        // Futuristic Cyberpunk/Industrial Bounding Box
        // Soft neon fill
        canvasCtx.fillStyle = 'rgba(16, 185, 129, 0.08)';
        canvasCtx.fillRect(x, y, w, h);

        // Thin main border
        canvasCtx.strokeStyle = '#10b981';
        canvasCtx.lineWidth = 2;
        canvasCtx.strokeRect(x, y, w, h);

        // Corner accent brackets
        const cornerLen = Math.min(w * 0.2, h * 0.2, 20);
        canvasCtx.lineWidth = 4;
        canvasCtx.strokeStyle = '#38bdf8';

        // Top-Left
        canvasCtx.beginPath();
        canvasCtx.moveTo(x, y + cornerLen);
        canvasCtx.lineTo(x, y);
        canvasCtx.lineTo(x + cornerLen, y);
        canvasCtx.stroke();

        // Top-Right
        canvasCtx.beginPath();
        canvasCtx.moveTo(x + w - cornerLen, y);
        canvasCtx.lineTo(x + w, y);
        canvasCtx.lineTo(x + w, y + cornerLen);
        canvasCtx.stroke();

        // Bottom-Left
        canvasCtx.beginPath();
        canvasCtx.moveTo(x, y + h - cornerLen);
        canvasCtx.lineTo(x, y + h);
        canvasCtx.lineTo(x + cornerLen, y + h);
        canvasCtx.stroke();

        // Bottom-Right
        canvasCtx.beginPath();
        canvasCtx.moveTo(x + w - cornerLen, y + h);
        canvasCtx.lineTo(x + w, y + h);
        canvasCtx.lineTo(x + w, y + h - cornerLen);
        canvasCtx.stroke();
      }

      if (state.showLabels) {
        // Tag label pill: "👤 Person 94%"
        const labelText = `Person ${score}%`;
        canvasCtx.font = 'bold 14px "SF Mono", monospace';
        const textMetrics = canvasCtx.measureText(labelText);
        const tagWidth = textMetrics.width + 16;
        const tagHeight = 22;

        const tagY = y > tagHeight + 5 ? y - tagHeight - 2 : y + 2;

        // Label background pill
        canvasCtx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        canvasCtx.fillRect(x, tagY, tagWidth, tagHeight);
        canvasCtx.strokeStyle = '#38bdf8';
        canvasCtx.lineWidth = 1;
        canvasCtx.strokeRect(x, tagY, tagWidth, tagHeight);

        // Label text
        canvasCtx.fillStyle = '#38bdf8';
        canvasCtx.fillText(labelText, x + 8, tagY + 16);

        // Center "HUMAN" watermark inside bounding box
        if (w > 80 && h > 80) {
          canvasCtx.save();
          canvasCtx.font = 'bold 11px sans-serif';
          canvasCtx.fillStyle = 'rgba(16, 185, 129, 0.55)';
          const watermark = 'HUMAN';
          const wm = canvasCtx.measureText(watermark);
          canvasCtx.fillText(watermark, x + (w - wm.width) / 2, y + h / 2);
          canvasCtx.restore();
        }
      }
    });
  }

  // --- STATS & TEMPORAL SMOOTHING ---
  function processDetections(persons) {
    const rawCount = persons.length;

    // Temporal smoothing mechanism:
    // Rolling buffer of the last N frames to avoid jitter
    if (state.smoothingWindowSize > 1) {
      state.recentCounts.push(rawCount);
      if (state.recentCounts.length > state.smoothingWindowSize) {
        state.recentCounts.shift();
      }
      // Calculate median or sorted middle value
      const sorted = [...state.recentCounts].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      state.currentHumanCount = sorted[mid];
    } else {
      state.currentHumanCount = rawCount;
    }

    // Cumulative stats
    state.detectionRuns++;
    state.sessionCounts.push(state.currentHumanCount);
    if (state.currentHumanCount > state.maxCount) {
      state.maxCount = state.currentHumanCount;
    }

    if (persons.length > 0) {
      const avgConfCurrent = persons.reduce((acc, p) => acc + p.score, 0) / persons.length;
      state.confidenceSum += avgConfCurrent;
      state.totalDetectionsCount++;
    }

    updateHumanCount(state.currentHumanCount, rawCount);
    updateStatisticsUI();
  }

  function updateHumanCount(count, rawCount = count) {
    els.heroCount.textContent = count;
    els.heroCountSub.textContent = `Raw Detection: ${rawCount} | Smoothed Window: ${state.smoothingWindowSize}f`;

    // Calculate Crowd Strength
    // 0–3 people: LOW
    // 4–8 people: MEDIUM
    // 9–15 people: HIGH
    // 16+ people: VERY HIGH
    const { lowMax, mediumMax, highMax } = state.crowdThresholds;
    let tier = 'LOW';
    let tierClass = 'tier-low';

    if (count <= lowMax) {
      tier = 'LOW';
      tierClass = 'tier-low';
    } else if (count <= mediumMax) {
      tier = 'MEDIUM';
      tierClass = 'tier-medium';
    } else if (count <= highMax) {
      tier = 'HIGH';
      tierClass = 'tier-high';
      triggerCrowdAlert('HIGH');
    } else {
      tier = 'VERY HIGH';
      tierClass = 'tier-vhigh';
      triggerCrowdAlert('VERY HIGH');
    }

    els.crowdBadge.textContent = `Crowd Level: ${tier}`;
    els.crowdBadge.className = `crowd-tier-badge ${tierClass}`;
  }

  function updateStatisticsUI() {
    // Average Count
    if (state.sessionCounts.length > 0) {
      const avg = (state.sessionCounts.reduce((a, b) => a + b, 0) / state.sessionCounts.length).toFixed(1);
      els.statAvgCount.textContent = avg;
    }

    // Max Count
    els.statMaxCount.textContent = state.maxCount;

    // Average Confidence %
    if (state.totalDetectionsCount > 0) {
      const avgConf = Math.round((state.confidenceSum / state.totalDetectionsCount) * 100);
      els.statConfidence.textContent = `${avgConf}%`;
    } else {
      els.statConfidence.textContent = '--';
    }
  }

  // --- AUDIO ALERT (Synthesised) ---
  let lastAlertTime = 0;
  function triggerCrowdAlert(level) {
    if (!state.audioAlerts) return;
    const now = Date.now();
    if (now - lastAlertTime < 8000) return; // limit alerts to once every 8 seconds
    lastAlertTime = now;

    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = level === 'VERY HIGH' ? 'sawtooth' : 'sine';
      osc.frequency.setValueAtTime(level === 'VERY HIGH' ? 880 : 587.33, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.6);

      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.6);
    } catch (e) {
      // AudioContext could be blocked by autoplay policies
    }
  }

  // --- SPARKLINE TIMELINE CHART ---
  function startSparklineUpdater() {
    renderSparkline();
    setInterval(() => {
      // Push current count
      state.sparklineData.push(state.currentHumanCount);
      if (state.sparklineData.length > 30) state.sparklineData.shift();
      renderSparkline();
    }, 1000);
  }

  function renderSparkline() {
    const cvs = els.trendCanvas;
    const ctx = trendCtx;
    const w = cvs.width = cvs.offsetWidth || 300;
    const h = cvs.height = cvs.offsetHeight || 50;

    ctx.clearRect(0, 0, w, h);

    const data = state.sparklineData;
    const maxVal = Math.max(...data, 10);
    const stepX = w / (data.length - 1);

    // Gradient fill under trend
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, 'rgba(16, 185, 129, 0.4)');
    gradient.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

    ctx.beginPath();
    ctx.moveTo(0, h);
    data.forEach((val, i) => {
      const x = i * stepX;
      const y = h - (val / maxVal) * (h - 10) - 5;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Trend stroke line
    ctx.beginPath();
    data.forEach((val, i) => {
      const x = i * stepX;
      const y = h - (val / maxVal) * (h - 10) - 5;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw last point dot
    const lastX = (data.length - 1) * stepX;
    const lastY = h - (data[data.length - 1] / maxVal) * (h - 10) - 5;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#38bdf8';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // --- UI EVENT LISTENERS ---
  function setupEventListeners() {
    // Start / Stop Monitoring
    els.btnStartStop.addEventListener('click', () => {
      state.isMonitoring = !state.isMonitoring;
      if (state.isMonitoring) {
        els.btnStartStop.innerHTML = '⏸ Stop Monitoring';
        els.btnStartStop.classList.remove('btn-success');
        els.btnStartStop.classList.add('btn-secondary');
        updateEngineStatus('Monitoring Active', 'emerald');
      } else {
        els.btnStartStop.innerHTML = '▶ Resume Monitoring';
        els.btnStartStop.classList.remove('btn-secondary');
        els.btnStartStop.classList.add('btn-success');
        updateEngineStatus('Monitoring Paused', 'amber');
        canvasCtx.clearRect(0, 0, els.detectionCanvas.width, els.detectionCanvas.height);
      }
    });

    // Reconnect Button
    els.btnReconnect.addEventListener('click', () => {
      console.log('[Dashboard] User clicked Reconnect');
      if (state.signaling) {
        state.signaling.disconnect();
        initSignaling();
      }
      updateMobileStatus('waiting', 'Reconnecting...');
    });

    // Laptop Webcam Test Button
    els.btnTestWebcam.addEventListener('click', toggleLaptopWebcam);

    // Copy Mobile URL Button
    els.btnCopyUrl.addEventListener('click', () => {
      const url = els.mobileUrlDisplay.dataset.url || els.mobileUrlDisplay.textContent;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => {
          const original = els.btnCopyUrl.textContent;
          els.btnCopyUrl.textContent = 'Copied!';
          setTimeout(() => { els.btnCopyUrl.textContent = original; }, 2000);
        });
      }
    });

    // IP Interface Switcher
    if (els.ipSelect) {
      els.ipSelect.addEventListener('change', (e) => {
        const chosenIp = e.target.value;
        loadNetworkConfig(chosenIp);
      });
    }

    // Confidence Slider
    els.confidenceSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      state.confidenceThreshold = val;
      els.confidenceValDisplay.textContent = `${Math.round(val * 100)}%`;
    });

    // Temporal Smoothing Window
    els.smoothingSelect.addEventListener('change', (e) => {
      state.smoothingWindowSize = parseInt(e.target.value, 10);
      state.recentCounts = [];
    });

    // Audio Alert Toggle
    els.soundAlertToggle.addEventListener('change', (e) => {
      state.audioAlerts = e.target.checked;
    });

    // Box & Label Toggles
    els.toggleBoxes.addEventListener('change', (e) => {
      state.showBoxes = e.target.checked;
    });

    els.toggleLabels.addEventListener('change', (e) => {
      state.showLabels = e.target.checked;
    });

    // Fullscreen Viewfinder
    els.btnFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        els.viewfinderWrapper.requestFullscreen().catch(err => {
          console.warn('Fullscreen error:', err);
        });
      } else {
        document.exitFullscreen();
      }
    });
  }

  // --- HELPERS ---
  function updateMobileStatus(type, text) {
    els.mobileStatusPill.className = `status-pill status-${type}`;
    els.mobileStatusPill.innerHTML = `
      <span class="status-dot ${type === 'waiting' ? 'pulse' : ''}"></span>
      <span>${text}</span>
    `;
  }

  function updateEngineStatus(text, color = 'emerald') {
    els.engineStatus.textContent = text;
    if (color === 'emerald') els.engineStatus.style.color = '#34d399';
    else if (color === 'amber') els.engineStatus.style.color = '#fbbf24';
    else if (color === 'rose') els.engineStatus.style.color = '#f87171';
  }

  function startSessionTimer() {
    setInterval(() => {
      const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
      const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const secs = String(elapsed % 60).padStart(2, '0');
      els.sessionUptime.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  // Auto-boot
  window.addEventListener('DOMContentLoaded', init);
})();

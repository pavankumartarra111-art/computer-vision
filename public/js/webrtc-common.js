/**
 * WebRTC and Signaling Helper for Smart Room Human Counter
 */

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10
};

class SignalingClient {
  constructor(role, roomId = 'default') {
    this.role = role; // 'desktop' or 'mobile'
    this.roomId = roomId;
    this.ws = null;
    this.listeners = new Map();
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.isManualClose = false;
  }

  connect() {
    this.isManualClose = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws`;

    console.log(`[Signaling] Connecting to ${wsUrl} as role: ${this.role}...`);
    this.emit('connection-change', { status: 'connecting' });

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log(`[Signaling] Connected to server as ${this.role}`);
        this.emit('connection-change', { status: 'connected' });

        // Register client
        this.send({
          type: 'register',
          role: this.role,
          roomId: this.roomId
        });

        // Setup ping interval
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.send({ type: 'ping' });
          }
        }, 10000);
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (e) {
          console.error('[Signaling] Parse error:', e);
        }
      };

      this.ws.onclose = () => {
        console.log('[Signaling] Disconnected from server');
        this.emit('connection-change', { status: 'disconnected' });
        if (this.pingTimer) clearInterval(this.pingTimer);

        if (!this.isManualClose) {
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            console.log('[Signaling] Attempting reconnection...');
            this.connect();
          }, 3000);
        }
      };

      this.ws.onerror = (err) => {
        console.error('[Signaling] WebSocket error:', err);
        this.emit('connection-change', { status: 'error', error: err });
      };
    } catch (err) {
      console.error('[Signaling] Connection failed:', err);
      this.emit('connection-change', { status: 'error', error: err });
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.warn('[Signaling] Cannot send message, socket not open:', data.type);
    }
  }

  sendSignal(target, payload) {
    this.send({
      type: 'signal',
      target: target,
      roomId: this.roomId,
      payload: payload
    });
  }

  sendCameraStatus(status, details = {}) {
    this.send({
      type: 'camera-status',
      roomId: this.roomId,
      payload: { status, ...details }
    });
  }

  handleMessage(data) {
    const { type, payload, peer, connected, sender } = data;
    switch (type) {
      case 'peer-status':
        this.emit('peer-status', { peer, connected });
        break;
      case 'signal':
        this.emit('signal', { sender, payload });
        break;
      case 'camera-status':
        this.emit('camera-status', payload);
        break;
      case 'pong':
        // Keep-alive acknowledged
        break;
      default:
        this.emit(type, payload);
    }
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      for (const cb of this.listeners.get(event)) {
        try {
          cb(data);
        } catch (e) {
          console.error(`[Signaling] Listener error in "${event}":`, e);
        }
      }
    }
  }

  disconnect() {
    this.isManualClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Make accessible to browser windows
window.RTC_CONFIG = RTC_CONFIG;
window.SignalingClient = SignalingClient;

const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode = require('qrcode');

const PORT = parseInt(process.env.PORT || '5173', 10);
const HOST = process.env.HOST || '0.0.0.0';
const USE_HTTPS = process.env.HTTPS === 'true' || process.argv.includes('--https');

/**
 * Scan network interfaces and return all IPv4 private LAN addresses,
 * prioritizing active Wi-Fi and Ethernet adapters.
 */
function getNetworkInterfacesInfo() {
  const interfaces = os.networkInterfaces();
  const allIps = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const iface of addrs) {
      // Look for non-internal IPv4
      if (iface.family === 'IPv4' && !iface.internal) {
        let score = 5;
        const lowerName = name.toLowerCase();

        // Higher priority for physical Wi-Fi or Ethernet
        if (lowerName.includes('wi-fi') || lowerName.includes('wlan') || lowerName.includes('wireless')) {
          score += 20;
        } else if (lowerName.includes('ethernet') || lowerName.includes('eth') || lowerName.includes('en0')) {
          score += 15;
        }

        // De-prioritize virtual adapters (Hyper-V, WSL, VirtualBox, VMware)
        if (lowerName.includes('vethernet') || lowerName.includes('virtual') || lowerName.includes('vmware') || lowerName.includes('wsl') || lowerName.includes('pseudo')) {
          score -= 10;
        }

        const addr = iface.address;
        const isPrivate = addr.startsWith('192.168.') ||
                          addr.startsWith('10.') ||
                          (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(addr));

        if (isPrivate) {
          score += 10;
        }

        allIps.push({
          name,
          address: addr,
          isPrivate,
          score
        });
      }
    }
  }

  // Sort by highest score first
  allIps.sort((a, b) => b.score - a.score);

  const primaryIp = allIps.length > 0 ? allIps[0].address : '127.0.0.1';

  return {
    primaryIp,
    allIps
  };
}

const app = express();
app.use(express.json());

// Serve static frontend files
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Explicit routes for views
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/mobile', (req, res) => {
  res.sendFile(path.join(publicDir, 'mobile.html'));
});

// API: System & Network Configuration
app.get('/api/config', async (req, res) => {
  const { primaryIp, allIps } = getNetworkInterfacesInfo();
  const protocol = USE_HTTPS ? 'https' : 'http';
  const customIp = req.query.ip || primaryIp;
  const mobileUrl = `${protocol}://${customIp}:${PORT}/mobile`;

  try {
    const qrDataUrl = await QRCode.toDataURL(mobileUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      scale: 8,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });

    res.json({
      lanIp: primaryIp,
      selectedIp: customIp,
      allIps,
      port: PORT,
      host: HOST,
      protocol,
      isHttps: USE_HTTPS,
      mobileUrl,
      qrCode: qrDataUrl
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code', message: err.message });
  }
});

// API: Generate QR code for a specific custom URL
app.get('/api/qr', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  try {
    const qrDataUrl = await QRCode.toDataURL(targetUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      scale: 8,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });
    res.json({ url: targetUrl, qrCode: qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code', message: err.message });
  }
});

// Create HTTP or HTTPS server
let server;
if (USE_HTTPS) {
  try {
    const selfsigned = require('selfsigned');
    const { primaryIp } = getNetworkInterfacesInfo();
    const attrs = [{ name: 'commonName', value: primaryIp }];
    const pems = selfsigned.generate(attrs, {
      days: 365,
      algorithm: 'sha256',
      keySize: 2048,
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: primaryIp }
          ]
        }
      ]
    });

    server = https.createServer({ key: pems.private, cert: pems.cert }, app);
    console.log('[Server] Running in HTTPS mode with auto-generated certificate.');
  } catch (err) {
    console.error('[Server] Failed to initialize HTTPS, falling back to HTTP:', err);
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

// WebSocket Signaling Server attached to HTTP/HTTPS server
const wss = new WebSocketServer({ server, path: '/ws' });

// Store active connections by role and room
// Rooms structure: roomId -> { desktop: WebSocket, mobile: WebSocket }
const rooms = new Map();

function getOrCreateRoom(roomId = 'default') {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { desktop: null, mobile: null });
  }
  return rooms.get(roomId);
}

wss.on('connection', (ws, req) => {
  let clientRole = null;
  let clientRoomId = 'default';

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      const { type, role, roomId = 'default', payload } = data;

      switch (type) {
        case 'register': {
          clientRole = role;
          clientRoomId = roomId;
          const room = getOrCreateRoom(roomId);

          if (role === 'desktop') {
            room.desktop = ws;
            console.log(`[WS] Desktop registered in room: ${roomId}`);
            // Inform desktop about current mobile connection status
            ws.send(JSON.stringify({
              type: 'peer-status',
              peer: 'mobile',
              connected: room.mobile !== null && room.mobile.readyState === WebSocket.OPEN
            }));
          } else if (role === 'mobile') {
            room.mobile = ws;
            console.log(`[WS] Mobile registered in room: ${roomId}`);
            // Notify desktop that mobile has connected!
            if (room.desktop && room.desktop.readyState === WebSocket.OPEN) {
              room.desktop.send(JSON.stringify({
                type: 'peer-status',
                peer: 'mobile',
                connected: true
              }));
            }
            // Inform mobile that desktop is present
            ws.send(JSON.stringify({
              type: 'peer-status',
              peer: 'desktop',
              connected: room.desktop !== null && room.desktop.readyState === WebSocket.OPEN
            }));
          }
          break;
        }

        case 'signal': {
          // Relay WebRTC offer / answer / ice-candidate to peer
          const room = getOrCreateRoom(clientRoomId);
          const target = data.target;

          if (target === 'desktop' && room.desktop && room.desktop.readyState === WebSocket.OPEN) {
            room.desktop.send(JSON.stringify({
              type: 'signal',
              sender: 'mobile',
              payload: payload
            }));
          } else if (target === 'mobile' && room.mobile && room.mobile.readyState === WebSocket.OPEN) {
            room.mobile.send(JSON.stringify({
              type: 'signal',
              sender: 'desktop',
              payload: payload
            }));
          } else {
            console.log(`[WS] Signal dropped, target ${target} not available in room ${clientRoomId}`);
          }
          break;
        }

        case 'camera-status': {
          // Relay mobile camera status (e.g. streaming, stopped, error) to desktop
          const room = getOrCreateRoom(clientRoomId);
          if (room.desktop && room.desktop.readyState === WebSocket.OPEN) {
            room.desktop.send(JSON.stringify({
              type: 'camera-status',
              payload: payload
            }));
          }
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        }

        default:
          console.warn(`[WS] Unknown message type: ${type}`);
      }
    } catch (err) {
      console.error('[WS] Error processing message:', err.message);
    }
  });

  ws.on('close', () => {
    const room = rooms.get(clientRoomId);
    if (!room) return;

    if (clientRole === 'desktop' && room.desktop === ws) {
      room.desktop = null;
      console.log(`[WS] Desktop disconnected from room: ${clientRoomId}`);
      if (room.mobile && room.mobile.readyState === WebSocket.OPEN) {
        room.mobile.send(JSON.stringify({
          type: 'peer-status',
          peer: 'desktop',
          connected: false
        }));
      }
    } else if (clientRole === 'mobile' && room.mobile === ws) {
      room.mobile = null;
      console.log(`[WS] Mobile disconnected from room: ${clientRoomId}`);
      if (room.desktop && room.desktop.readyState === WebSocket.OPEN) {
        room.desktop.send(JSON.stringify({
          type: 'peer-status',
          peer: 'mobile',
          connected: false
        }));
      }
    }

    if (!room.desktop && !room.mobile) {
      rooms.delete(clientRoomId);
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Connection error for ${clientRole}:`, err.message);
  });
});

// Periodic heartbeat to prevent mobile socket drops
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Start listening on 0.0.0.0
server.listen(PORT, HOST, () => {
  const { primaryIp, allIps } = getNetworkInterfacesInfo();
  const protocol = USE_HTTPS ? 'https' : 'http';

  console.log('\n============================================================');
  console.log('       SMART ROOM HUMAN COUNTER - SERVER ACTIVE');
  console.log('============================================================');
  console.log(` Mode:        ${USE_HTTPS ? 'HTTPS (Secure Context)' : 'HTTP'}`);
  console.log(` Listening:   ${HOST}:${PORT}`);
  console.log(` Local URL:   ${protocol}://localhost:${PORT}`);
  console.log(` Desktop Dashboard: ${protocol}://${primaryIp}:${PORT}/`);
  console.log(` Mobile Camera:     ${protocol}://${primaryIp}:${PORT}/mobile`);
  console.log('------------------------------------------------------------');
  console.log(' Detected Network Interfaces:');
  allIps.forEach(ip => {
    console.log(`   - ${ip.name.padEnd(25)}: ${ip.address} ${ip.isPrivate ? '(Private LAN)' : ''}`);
  });
  console.log('------------------------------------------------------------');
  console.log(' [!] Make sure computer and mobile are connected to the same Wi-Fi.');
  console.log(' [!] Allow port ' + PORT + ' through Windows Firewall if prompted.');
  console.log('============================================================\n');
});

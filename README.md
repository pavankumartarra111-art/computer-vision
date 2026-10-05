# Smart Room Human Counter 👥📹

A real-time, browser-native smart room occupancy counter and computer-vision monitoring system.

The laptop/desktop runs an AI monitoring dashboard displaying a dynamically generated QR code pointing to the computer's actual local Wi-Fi IP address. A user scans the QR code with their mobile phone, grants camera permission, and streams low-latency live video via **WebRTC** directly to the laptop. The laptop runs **TensorFlow.js COCO-SSD** to detect and count humans in real time, calculating crowd strength levels and detection statistics.

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
```
By default, the server binds to `0.0.0.0` on port `5173`.

### 3. Open the Desktop Dashboard
Open your browser and navigate to:
```
http://localhost:5173/
```
or using your local Wi-Fi IP (e.g., `http://192.168.126.124:5173/`).

### 4. Connect with Your Mobile Phone
1. Ensure your mobile phone is connected to the **same Wi-Fi / local network** as your laptop.
2. Scan the QR code displayed on the desktop dashboard with your mobile camera.
3. The QR code opens `http://<YOUR_LAN_IP>:5173/mobile`.
4. Tap **Start Camera** and allow camera permission.
5. The rear camera starts automatically and streams live video directly to the desktop dashboard over WebRTC!

---

## 🔒 Mobile Browser Camera Access (HTTPS Mode)

Modern mobile browsers (iOS Safari, Android Chrome) enforce security restrictions that require a **Secure Context (HTTPS or localhost)** for `navigator.mediaDevices.getUserMedia()`.

If you scan the QR code and your mobile browser prevents camera access over plain HTTP:

### Option A: Run Server in HTTPS Mode (Recommended for Mobile)
Start the server with auto-generated self-signed certificates:
```bash
npm run start:https
```
- Open `https://localhost:5173/` on the desktop.
- When opening `https://<YOUR_LAN_IP>:5173/mobile` on your phone:
  - You will see a standard browser security warning ("Your connection is not private / Not secure").
  - Tap **Advanced** &rarr; **Proceed to site (unsafe)**.
  - The mobile browser will now grant full camera access!

### Option B: Android Chrome Insecure Origin Flag (For HTTP)
1. In Chrome on your Android phone, visit:
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
2. Add your server URL (e.g., `http://192.168.126.124:5173`).
3. Set to **Enabled** and relaunch Chrome.

### Option C: Instant Testing with Laptop Webcam
If you want to verify the AI human detection, bounding boxes, crowd strength, and statistics immediately without a phone:
- Click the **"🧪 Test with Laptop Webcam"** button inside the video panel on the desktop dashboard.

---

## 🏗 System Architecture

```
Mobile Phone (Camera Transmitter)
  │
  ├── 1. Opens /mobile via QR Code
  ├── 2. getUserMedia() (Rear camera preferred)
  ├── 3. WebRTC Peer Connection (MediaStream tracks)
  └── 4. WebSocket Signaling (Offer / Answer / ICE)
             │
      Local Wi-Fi Network
             │
Laptop / Desktop (AI Monitoring Dashboard)
  │
  ├── 1. Receives WebRTC live video stream
  ├── 2. Renders video on high-resolution viewfinder
  ├── 3. TensorFlow.js COCO-SSD inference loop
  ├── 4. Filters 'person' class only (confidence >= 0.5)
  ├── 5. Draws Cyberpunk/Industrial Bounding Boxes
  ├── 6. Temporal Smoothing Filter (eliminates frame jitter)
  ├── 7. Crowd Strength Classification (LOW / MEDIUM / HIGH / VERY HIGH)
  └── 8. Real-time Analytics (Average, Peak, Confidence %, FPS, 30s Sparkline)
```

---

## 📊 Crowd Strength Levels

| Crowd Level | Occupancy | Badge Color | Alert Status |
| :--- | :--- | :--- | :--- |
| **LOW** | 0 – 3 people | Emerald Green | Normal |
| **MEDIUM** | 4 – 8 people | Amber / Yellow | Normal |
| **HIGH** | 9 – 15 people | Orange | Warning (Optional Chime) |
| **VERY HIGH** | 16+ people | Crimson Red | Critical Pulse Alert |

*Crowd thresholds and confidence sensitivity can be adjusted directly from the Detection Controls panel.*

---

## 🛠 Project Structure

```
├── package.json              # Project dependencies and startup scripts
├── server/
│   ├── server.js             # Express server, WebSocket signaling, QR generator & LAN IP detector
│   └── download-vendor.js    # Pre-downloads TF.js & COCO-SSD for offline support
├── public/
│   ├── index.html            # Desktop monitoring dashboard view
│   ├── mobile.html           # Mobile camera transmitter view
│   ├── css/
│   │   ├── dashboard.css     # Dark mode engineering dashboard styles
│   │   └── mobile.css        # Touch-optimized mobile UI styles
│   ├── js/
│   │   ├── dashboard.js      # Dashboard controller, WebRTC receiver, TF.js detector
│   │   ├── mobile.js         # Mobile camera controller, WebRTC sender
│   │   └── webrtc-common.js  # Shared signaling client & WebRTC ICE configuration
│   └── vendor/               # Local offline copies of TF.js and COCO-SSD
└── README.md
```

---

## ⚙️ Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `5173` | Application port for HTTP/HTTPS and WebSockets |
| `HOST` | `0.0.0.0` | Bind host (must be 0.0.0.0 for LAN access) |
| `HTTPS` | `false` | Set to `true` to enable self-signed HTTPS |

Example with custom port:
```bash
PORT=8080 npm start
```
The QR code and LAN URLs will automatically update to use port `8080`.

---

## 🛡️ Security and Privacy
- **100% Local Processing:** Video streams directly from the mobile phone to the laptop over the local Wi-Fi network via WebRTC peer-to-peer.
- **No Cloud Upload:** No video data, frames, or metrics are uploaded to external cloud servers.
- **No Face Recognition:** The detection model only identifies generic `person` bounding boxes for counting room occupancy; it does not identify individuals.

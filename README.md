# WhyNotShare

> **High-Performance, Zero-Knowledge, Peer-to-Peer Data & File Sharing Protocol in the Browser.**  
> Built with pure WebRTC data channels, client-side AES-GCM 256-bit encryption, and zero server-side storage.

[![GitHub Pages](https://img.shields.io/badge/Deploy-GitHub%20Pages-6366f1?style=for-the-badge&logo=github)](https://prajansrini.github.io/whynotshare/)
[![License: MIT](https://img.shields.io/badge/License-MIT-8b5cf6?style=for-the-badge)](LICENSE)
[![Protocol](https://img.shields.io/badge/Protocol-WebRTC%20Data%20Channels-00b894?style=for-the-badge)](https://webrtc.org/)
[![Cryptography](https://img.shields.io/badge/Security-AES--GCM%20256--bit-fd79a8?style=for-the-badge)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)

[Try Live Demo](https://prajansrini.github.io/whynotshare/) (GitHub Hosted)

---

## Executive Summary

**WhyNotShare** is a state-of-the-art, browser-based peer-to-peer (P2P) communication platform engineered for secure, instantaneous, and zero-latency data transmission across devices. Unlike traditional cloud-based file transfer services that route data through intermediate third-party servers, impose arbitrary upload restrictions, and retain permanent logs, WhyNotShare establishes direct **WebRTC data tunnels (`SCTP/DTLS`)** directly between client browsers.

All data payloads—including text chat transmissions and high-speed binary file transfers—are encrypted entirely on the client using the browser's hardware-accelerated **Web Crypto API (`AES-GCM 256-bit`)**. Data is encrypted before leaving your device and decrypted strictly on authorized destination peers, guaranteeing a **true zero-knowledge architecture** where signaling servers never see plaintext payloads, files, or encryption keys.

---

## Privacy Guarantee & Network Security (`npm start`)

> [!IMPORTANT]
> **Zero IP Leakage Guarantee & Local Network Operation**
> When running the local fallback signaling server via `npm start` (`node server.js`), the server dynamically inspects `os.networkInterfaces()` at runtime **solely to display your local LAN IPv4 address (e.g., `http://192.168.1.X:7890`) inside your private terminal stdout**. This allows you to easily type the address into mobile devices or laptops on the same Wi-Fi network.

* **No External Tracking or Telemetry:** Your local IP address is **never** logged to disk, transmitted to external analytics endpoints, uploaded to the cloud, or committed to version control.
* **No Public IP Discovery:** The server does not query external stun/turn IP discovery APIs or broadcast your network details outside your immediate local area network (LAN).
* **Signaling Isolation:** The local Node.js relay (`server.js`) only negotiates initial WebRTC session descriptors and encrypted data relays. It has zero capability to inspect intercepted binary buffers due to client-side Galois/Counter Mode (`AES-GCM`) cryptographic authentication tags.

---

## Core System Architecture & Features

```
+-------------------------------------------------------------------------------+
|                              WHYNOTSHARE PROTOCOL                             |
+-------------------------------------------------------------------------------+
|                                                                               |
|   +-------------------+    1. Signaling Handshake      +------------------+   |
|   |  Initiator Peer   | <----------------------------> |  Signaling Relay |   |
|   |  (Room Host)      |                                |  (PeerJS / Local)|   |
|   +-------------------+                                +------------------+   |
|             ^                                                    ^            |
|             | 2. Direct WebRTC Data Channel (SCTP/DTLS)          |            |
|             v                                                    v            |
|   +-------------------+    3. AES-GCM 256-bit Stream   +------------------+   |
|   |  Responder Peer   | <============================> |  Additional Peer |   |
|   |  (Client Device)  |      (64KB Binary Chunks)      |  (Multi-Device)  |   |
|   +-------------------+                                +------------------+   |
|                                                                               |
+-------------------------------------------------------------------------------+
```

### 1. Zero-Knowledge Cryptographic Engine
* **Native Web Crypto API Implementation:** Relies exclusively on hardware-accelerated native browser cryptography (`window.crypto.subtle`), eliminating vulnerable or slow third-party JavaScript encryption libraries.
* **PBKDF2 Key Derivation:** Passphrases are passed through PBKDF2 with SHA-256 using a cryptographic salt and 100,000 iterations to derive robust 256-bit symmetric keys.
* **AES-GCM 256-bit Authenticated Encryption:** Every text message and 64KB file chunk is individually encrypted using Advanced Encryption Standard in Galois/Counter Mode (`AES-GCM`). Each payload receives a unique, cryptographically secure 12-byte Initialization Vector (`IV`) and a 16-byte authentication tag.
* **Tamper Proofing & Packet Rejection:** If any chunk is modified or corrupted in transit, Galois/Counter Mode cryptographic verification fails upon arrival, automatically discarding the packet before memory assembly.

### 2. Privileged Host Governance & Key Rotation
* **Role-Based Room Security:** When a room is created, the initiating peer is granted exclusive **Host Governance** privileges (`isPrivileged: true`).
* **Dynamic Passphrase Rotation:** Room hosts can generate cryptographically secure passphrases or enter custom keys on the fly using the **Encryption Key Modal**. When the host updates the key, all connected peers are dynamically notified without breaking WebRTC data tunnels.
* **E2E / Plaintext Mode Switching:** Hosts can toggle between strict **End-to-End Encrypted Mode** and **Plaintext Mode** in real time, instantly updating the security posture across all participants.

### 3. High-Performance Chunked Streaming Protocol
To prevent browser memory exhaustion, garbage collection spikes, and UI freezes when sharing multi-gigabyte archives or 4K videos, WhyNotShare implements an asynchronous chunked streaming pipeline:
* **Segmented Binary Allocation:** Files are sliced into uniform **64KB (`65536` byte) array buffers** prior to encryption and transmission over WebRTC data channels.
* **Sequence Tracking & Deduplication:** Each binary chunk carries precise metadata (file ID, total size, sequence index, and chunk count). The receiving engine maintains deduplication buffers and sequence maps, ensuring out-of-order UDP datagrams are reassembled accurately into a clean final `Blob`.
* **Real-Time Throughput Metrics:** Continuously tracks and displays live transfer speeds (`MB/s`), estimated completion times (`ETA`), and granular percentage progress across multiple concurrent transfers.

### 4. Professional & Discreet File Handling
* **Silent File Cancellation:** If a sender cancels an ongoing file transfer mid-stream, the cancellation is handled quietly. The sender's UI updates cleanly with a `"Cancelled"` badge, while any incomplete transfer cards on the receiver's screen vanish completely—preventing intrusive error alerts or ghost files.
* **Unified Media Lightbox (`modal-media-preview`):** Images and videos shared in the chat can be previewed in a dedicated, full-screen glassmorphic lightbox modal. Features click-to-zoom container delegation (`cursor: zoom-in`), one-click escape navigation (`Esc`), and clean icon-only controls standardized to match primary UI action heights (`34px`).
* **Non-Intrusive Layout:** File names, sizes, and actions are rendered inside clean, professional cards designed to match modern messenger aesthetics without overflowing on mobile viewports.

### 5. Seamless Device Discovery & Hash Routing
* **Client-Side Hash Routing (`#roomCode:secretPhrase`):** Rooms generate deterministic, shareable URLs with the room code and optional secret phrase stored strictly in the URL hash fragment. Because fragments are never transmitted to HTTP servers, secret keys remain 100% client-side.
* **Vector SVG QR Codes:** Employs crisp, vector-based SVG QR code generation (`QRCodeStyling`) with high-density error correction for instant mobile scanning.
* **Hardware & Platform Detection:** Automatically identifies client operating systems (`Android`, `iOS`, `macOS`, `Windows`, `Linux`) and browser engines (`Chrome`, `Firefox`, `Safari`, `Edge`) with distinct device icons for clear peer management.

---

## Technical Protocol Specifications

### Data Envelope Structure
When transmitting across the WebRTC SCTP data channel, payloads conform to a standardized JSON/Binary structure:

```json
{
  "type": "file-chunk",
  "fileId": "8f9d2a10-4b2c-11ee-be56-0242ac120002",
  "fileName": "project_bundle.tar.gz",
  "fileSize": 148576000,
  "chunkIndex": 42,
  "totalChunks": 2267,
  "encrypted": true,
  "iv": "3a9f8c12b4e6d7a091827364",
  "data": "base64_or_array_buffer_payload"
}
```

### Encryption & Verification Pipeline
$$\text{Ciphertext}, \text{Tag} = \text{AES-GCM}_{\text{Key}}\left(\text{Plaintext Chunk}, \text{IV}\right)$$

1. **Import Key:** Senders and receivers derive the 256-bit symmetric key from the PBKDF2 passphrase buffer via `crypto.subtle.importKey()`.
2. **Encrypt Segment:** Senders generate a random 12-byte initialization vector (`IV`) via `crypto.getRandomValues()`, encrypt the 64KB chunk using `crypto.subtle.encrypt()`, and transmit `[IV + Ciphertext]`.
3. **Decrypt Segment:** Receivers extract the `IV`, execute `crypto.subtle.decrypt()`, verify the authentication tag, and append the decrypted array buffer directly to the reassembly map.

---

## Project Structure & Architecture

The codebase is built with zero external frontend frameworks or heavy dependencies, ensuring maximum execution speed, instantaneous loading, and complete visual control.

```text
whynotshare/
├── index.html               # Root redirect for custom domain routing
├── server.js                # Fallback Express & Socket.IO signaling/relay server
├── server/
│   └── roomManager.js       # Server-side room lifecycle and session cleanup
└── public/
    ├── .nojekyll            # Bypasses Jekyll processing for static GitHub Pages
    ├── index.html           # Main Single Page Application (SPA) DOM structure
    ├── css/
    │   ├── index.css        # Design system variables, typography, and layout tokens
    │   ├── components.css   # Component specifications (buttons, modals, device badges)
    │   └── theme.css        # Visual styling and responsive layout adaptations
    └── js/
        ├── app.js           # Main application controller, global event delegation & state
        ├── connection.js    # PeerJS WebRTC data channel and peer discovery wrapper
        ├── crypto.js        # Web Crypto API wrapper (AES-GCM 256-bit & PBKDF2)
        ├── fileTransfer.js  # File slicing, binary stream transmission, and Blob assembly
        ├── textShare.js     # Real-time encrypted text messaging controller
        ├── ui.js            # DOM manipulation, progress updates, and notifications
        ├── deviceInfo.js    # Client environment and hardware platform detection
        └── qr-code-styling.js # Vector SVG QR code rendering engine
```

---

## Deployment & Setup

WhyNotShare operates as a standalone browser application. Because it connects via public PeerJS signaling brokers by default, the client can be hosted on any static web hosting provider without requiring a backend server.

### 1. Static Hosting Deployment (GitHub Pages, Vercel, Netlify)
Serve the `public/` directory or push the repository to GitHub with Pages enabled on the root directory. The included `.nojekyll` file ensures all assets are served cleanly without Jekyll intervention.

```bash
# Example: Serving locally with any static web server
npx serve public
```

### 2. Local Node.js Signaling Server (`npm start`)
For enterprise environments or offline local area networks (LANs) where external cloud signaling is prohibited, an integrated Node.js signaling fallback server is provided.

```bash
# Clone the repository
git clone https://github.com/prajansrini/whynotshare.git
cd whynotshare

# Install backend dependencies
npm install

# Launch the server (outputs your local LAN URL to your terminal)
npm start
```

Navigate to `http://localhost:7890` (or the local network URL displayed in your terminal such as `http://192.168.1.X:7890`) from any device on your Wi-Fi network to initiate instantaneous local sharing.

---

## Contributing

We welcome code contributions, architectural improvements, and security audits from the open-source community.

1. Fork the Project repository.
2. Create your Feature Branch (`git checkout -b feature/Optimization`).
3. Commit your changes (`git commit -m 'Add stream optimization'`).
4. Push to the Branch (`git push origin feature/Optimization`).
5. Open a Pull Request for review.

---

## License

Distributed under the MIT License. See the `LICENSE` file for full legal details.


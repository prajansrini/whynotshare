# WhyNotShare

> **High-Performance, Zero-Knowledge, Peer-to-Peer Data & File Sharing Protocol in the Browser.**  
> Built with pure WebRTC data channels and client-side AES-GCM 256-bit encryption.

[![GitHub Pages](https://img.shields.io/badge/Deploy-GitHub%20Pages-6366f1?style=for-the-badge&logo=github)](https://prajansrini.github.io/whynotshare/)
[![License: MIT](https://img.shields.io/badge/License-MIT-8b5cf6?style=for-the-badge)](LICENSE)
[![Protocol](https://img.shields.io/badge/Protocol-WebRTC%20Data%20Channels-00b894?style=for-the-badge)](https://webrtc.org/)
[![Cryptography](https://img.shields.io/badge/Security-AES--GCM%20256--bit-fd79a8?style=for-the-badge)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)

### 🚀 [Try Live Demo Hosted on GitHub Pages → https://prajansrini.github.io/whynotshare/](https://prajansrini.github.io/whynotshare/)

---

## Executive Summary

**WhyNotShare** is a browser-based, peer-to-peer (P2P) communication platform engineered for secure, zero-latency data transmission across devices. Unlike conventional file-sharing systems that rely on intermediate cloud servers, restrictive upload limits, and database persistence, WhyNotShare establishes direct WebRTC tunnels between clients.

All data—including text transmissions and binary file streams—is processed using the browser's native **Web Crypto API**. Data is encrypted locally before transmission and decrypted strictly on destination devices, guaranteeing a zero-knowledge architecture where signaling servers only handle connection handshakes and cannot inspect payload contents.

---

## Core System Architecture & Features

```
+-------------------------------------------------------------------------------+
|                              WHYNOTSHARE PROTOCOL                             |
+-------------------------------------------------------------------------------+
|                                                                               |
|   +-------------------+    1. Signaling Handshake      +------------------+   |
|   |  Initiator Peer   | <----------------------------> |  Signaling Relay |   |
|   |  (Room Host)      |                                |  (PeerJS Cloud)  |   |
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

### 1. Peer-to-Peer WebRTC Data Tunnels
* **Direct P2P Connectivity:** Utilizes the Stream Control Transmission Protocol (SCTP) over Datagram Transport Layer Security (DTLS) to establish direct browser-to-browser connections.
* **No File Size or Bandwidth Limits:** Because data flows peer-to-peer without passing through external cloud servers, transmission speed is bound solely by the local network or internet bandwidth of the connected peers.
* **Multi-Device Support:** Rooms support multi-peer discovery and concurrent data broadcast, allowing seamless synchronization across laptops, workstations, and mobile devices.

### 2. Zero-Knowledge Cryptographic Engine
* **Native Web Crypto API Implementation:** Relies exclusively on hardware-accelerated, native browser cryptography (`window.crypto.subtle`), eliminating vulnerable third-party encryption libraries.
* **PBKDF2 Key Derivation:** Passphrases are passed through PBKDF2 with SHA-256 and a random salt (100,000 iterations) to generate cryptographically resilient 256-bit symmetric keys.
* **AES-GCM 256-bit Encryption:** Every text message and file chunk is individually encrypted using Advanced Encryption Standard in Galois/Counter Mode (AES-GCM). Each payload receives a cryptographically secure 12-byte Initialization Vector (IV) and a 16-byte authentication tag.
* **Tamper Proofing & Authentication:** If a data chunk is intercepted or altered in transit, Galois/Counter Mode authentication fails immediately upon receipt, causing the packet to be rejected before assembly.
* **Interactive Security Toggling:** Users can dynamically switch between **E2E Encrypted** and **Plaintext Mode** during an active session without dropping WebRTC connections or losing room state.

### 3. High-Performance Chunked Streaming Protocol
To prevent browser memory exhaustion and UI freezing when transmitting multi-gigabyte files, WhyNotShare implements an asynchronous streaming protocol:
* **Segmented Binary Allocation:** Files are sliced into uniform **64KB (`65536` byte) array buffers** prior to encryption and transmission.
* **Sequence Tracking & Assembly:** Each chunk is prefixed with metadata containing the file identifier, total size, sequence index, and chunk count. The receiver reconstructs the file in memory using sequential Blob assembly.
* **Duplicate Chunk Protection:** The receiving protocol implements deduplication buffers to handle out-of-order delivery or retransmitted UDP packets without corrupting the compiled binary.
* **Real-Time Throughput Monitoring:** Calculates live transfer speeds (MB/s), estimated completion times, and percentage progress across all active peers simultaneously.

### 4. Seamless Device Discovery & Routing
* **Hash-Based URL Routing:** Rooms generate deterministic connection URIs incorporating the room identifier and optional encryption keys in the URL fragment (`#roomCode:secretPhrase`). The hash fragment is never sent in HTTP request headers, ensuring secrets remain strictly client-side.
* **Vector SVG QR Code Generation:** Employs crisp, vector-based SVG QR code generation (`QRCodeStyling`) directly on the client. Features dynamic background contrast matching and high-density error correction for instantaneous scanning via mobile cameras.
* **Automatic Device Identification:** Automatically detects and displays client operating systems, browser engines, and customizable device identifiers to simplify multi-node management.

---

## Technical Protocol Specifications

### Data Packet Structure
When transmitting across the WebRTC data channel, payloads conform to a standardized JSON/Binary envelope:

```json
{
  "type": "file-chunk",
  "fileId": "8f9d2a10-4b2c-11ee-be56-0242ac120002",
  "fileName": "dataset_archive.tar.gz",
  "fileSize": 148576000,
  "chunkIndex": 42,
  "totalChunks": 2267,
  "encrypted": true,
  "iv": "3a9f8c12b4e6d7a091827364",
  "data": "base64_or_array_buffer_payload"
}
```

### Encryption Workflow
1. **Room Initialization:** Host creates a room code and specifies a secret phrase.
2. **Key Derivation:** Both sender and receiver execute `crypto.subtle.importKey()` and `deriveKey()` using the shared passphrase.
3. **Chunk Processing:**
   $$\text{Ciphertext}, \text{Tag} = \text{AES-GCM}_{\text{Key}}\left(\text{Plaintext Chunk}, \text{IV}\right)$$
4. **Transmission:** The IV and Ciphertext are transmitted over the WebRTC channel.
5. **Decryption & Verification:** The recipient decrypts the buffer. If verified, the chunk is appended to the file reassembly buffer.

---

## Project Structure & Architecture

The codebase is built without external frontend frameworks, ensuring maximum execution speed, rapid loading times, and zero bundle overhead.

```text
whynotshare/
├── index.html               # Root redirect for custom domain routing
├── server.js                # Fallback Express & Socket.IO signaling server
├── server/
│   └── roomManager.js       # Server-side room lifecycle and session cleanup
└── public/
    ├── .nojekyll            # Bypasses Jekyll processing for GitHub Pages
    ├── index.html           # Main Single Page Application (SPA) DOM structure
    ├── css/
    │   ├── index.css        # Design system variables, typography, and layout tokens
    │   ├── components.css   # Component specifications (buttons, modals, device badges)
    │   └── theme.css        # Visual styling and responsive layout adaptations
    └── js/
        ├── app.js           # Main application controller and state machine
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

WhyNotShare operates as a standalone client application. Because it leverages public PeerJS cloud servers for initial WebRTC signaling by default, the client can be deployed to any static web hosting provider without requiring a backend server.

### 1. Static Hosting Deployment (GitHub Pages, Vercel, Netlify)
Simply serve the `public/` directory or push the repository to GitHub with Pages enabled on the root directory. The included `.nojekyll` file ensures all assets are routed correctly.

```bash
# Example: Running locally with any static web server
npx serve public
```

### 2. Local Node.js Signaling Server (Optional)
For enterprise environments or offline local area networks (LANs) where external cloud signaling is prohibited, an integrated Node.js signaling fallback server is provided.

```bash
# Clone the repository
git clone https://github.com/prajansrini/whynotshare.git
cd whynotshare

# Install backend dependencies
npm install

# Launch the signaling relay server
npm run dev
```

Navigate to `http://localhost:5000` or your local network IP address to initiate offline LAN sharing.

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

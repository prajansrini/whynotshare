# WhyNotShare 🍑🚀

> **Ultra-fast, End-to-End Encrypted, Peer-to-Peer File & Text Sharing in Your Browser.**  
> Zero installation, zero cloud storage limits, and 100% private.

[![GitHub Pages](https://img.shields.io/badge/Deploy-GitHub%20Pages-6366f1?style=for-the-badge&logo=github)](https://prajansrini.github.io/whynotshare/)
[![License: MIT](https://img.shields.io/badge/License-MIT-8b5cf6?style=for-the-badge)](LICENSE)
[![WebRTC](https://img.shields.io/badge/Protocol-WebRTC%20%2B%20PeerJS-00b894?style=for-the-badge)](https://peerjs.com/)
[![Web Crypto](https://img.shields.io/badge/Security-AES--GCM%20256--bit-fd79a8?style=for-the-badge)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)

---

## ✨ Why WhyNotShare?

Traditional file sharing tools either limit your file size, store your sensitive data on third-party cloud servers, or require tedious sign-ups. **WhyNotShare** revolutionizes browser-based sharing by establishing direct **WebRTC peer-to-peer tunnels** between devices, secured with client-side **AES-GCM 256-bit encryption**.

Whether you are sharing confidential documents across the office or transferring multi-gigabyte files between your phone and laptop, WhyNotShare makes it instant, secure, and effortless.

---

## 🔥 Key Features

### 🔒 True End-to-End Encryption (E2E)
* **Client-Side Cryptography:** Built natively using the browser's **Web Crypto API**. Files and messages are encrypted locally using AES-GCM 256-bit encryption before leaving your device.
* **Zero Knowledge:** Signaling servers only relay connection offers and encrypted blobs—they can never decrypt or read your data.
* **Interactive Security Controls:** Toggle between **Encrypted** and **Plaintext** modes on the fly. View or change your secret passphrase anytime with dedicated security controls.

### ⚡ Pure WebRTC P2P Transfer
* **No File Size Limits:** Since transfers occur directly between devices (browser-to-browser), you are never restricted by cloud storage caps or intermediary server upload limits.
* **Optimized Chunking Architecture:** Files are streamed in efficient **64KB chunks** with real-time transfer speeds, progress percentages, and duplicate chunk protection.

### 🎨 Premium Glassmorphism & "Peach" Aesthetic
* **Modern UI/UX:** Styled from the ground up using custom **Vanilla CSS** design tokens featuring vibrant gradients, sleek glassmorphic cards, and responsive layouts.
* **Curated Themes:** Seamlessly toggle between deep, atmospheric **Dark Mode** and soft, elegant **Light ("Peach") Mode**.
* **Distraction-Free Experience:** Designed with strict, professional visual hierarchy—completely stripping away intrusive toast popups for a quiet, focused workflow.

### 📋 Seamless Collaboration
* **One-Click Invitation Links:** Generate sharable room URLs that embed your room code and encryption passphrase into the URL hash fragment (`#code-passphrase`). Anyone clicking the link connects instantly and securely!
* **Unified Messaging Feed:** Transferred files and chat messages appear seamlessly inside an interactive chat feed, complete with previews, file sizes, and download buttons.
* **Drag-and-Drop Staging:** Drag and drop files directly into the message feed or use the dedicated file staging browser.

---

## 🚀 Live Demo & Deployment

WhyNotShare is architected as a **100% static client application** and can be hosted anywhere—including **GitHub Pages**, Vercel, Netlify, or Cloudflare Pages!

👉 **[Try the Live Demo on GitHub Pages](https://prajansrini.github.io/whynotshare/)**

---

## 🛠️ Quick Start (Local Development)

If you wish to run the app locally or host your own optional local signaling relay server:

### 1. Clone the Repository
```bash
git clone https://github.com/prajansrini/whynotshare.git
cd whynotshare
```

### 2. Install Dependencies (Optional for Node Server)
```bash
npm install
```

### 3. Start the Local Server
```bash
npm run dev
# or directly: node server.js
```

Open your browser and navigate to `http://localhost:5000` (or the network IP printed in the console to connect mobile devices on the same Wi-Fi).

> **Note:** Because the client uses PeerJS public cloud signaling by default, you can also simply serve the `public/` folder using any static HTTP server (like `npx serve public` or VS Code Live Server) without running Node at all!

---

## 🏗️ Architecture & Project Structure

WhyNotShare prioritizes maximum performance and zero bloat by using **Vanilla HTML5, CSS3, and ES6+ JavaScript** without heavy frontend frameworks.

```text
whynotshare/
├── index.html               # Root redirect for GitHub Pages custom domain routing
├── server.js                # Optional Express & Socket.IO fallback signaling server
├── server/
│   └── roomManager.js       # Room lifecycle and peer session management
└── public/
    ├── .nojekyll            # Bypasses Jekyll processing for clean GitHub Pages deployment
    ├── index.html           # Main SPA layout and UI view states
    ├── css/
    │   ├── index.css        # Design tokens, variables, and global themes (Dark / Light Peach)
    │   ├── components.css   # Glassmorphic cards, security switches, and transfer UI
    │   └── theme.css        # Specific theme overrides and animations
    └── js/
        ├── app.js           # Core application controller and DOM event bindings
        ├── connection.js    # PeerJS / WebRTC peer discovery and connection logic
        ├── crypto.js        # Web Crypto API wrapper (AES-GCM encryption/decryption)
        ├── fileTransfer.js  # Chunked file streaming, progress tracking, and blob assembly
        ├── textShare.js     # Real-time encrypted text messaging
        ├── ui.js            # UI rendering helpers and dynamic DOM generators
        └── deviceInfo.js    # Automatic OS and browser detection
```

---

## 🔐 How Security Works

1. **Passphrase Generation:** When a room is created or joined, an encryption passphrase is either auto-generated or supplied by the user.
2. **Key Derivation:** `crypto.js` uses **PBKDF2** with SHA-256 and a unique salt to derive a cryptographic key from your passphrase.
3. **Payload Encryption:** Before any text message or file chunk is sent over the WebRTC data channel, it is encrypted using **AES-GCM 256-bit** with a freshly generated 12-byte Initialization Vector (IV).
4. **Decryption & Verification:** Upon receiving an encrypted payload, the recipient's browser decrypts the buffer using their matching derived key. If authentication fails (e.g., mismatched passphrase), the payload is rejected immediately without corrupting state.

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/prajansrini/whynotshare/issues).

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📝 License

Distributed under the MIT License. See `LICENSE` for more information.

---

<p align="center">
  Built with ❤️ for secure, effortless peer-to-peer sharing.
</p>

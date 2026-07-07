class App {
    constructor() {
        this.conn = new ConnectionManager();
        this.crypto = new CryptoManager();
        this.textShare = null;
        this.fileTransfer = null;
        this.e2eEnabled = true;
        this.stagedFiles = [];
    }

    async init() {
        this.conn.connect();
        this.textShare = new TextShare(this.conn, this.crypto);
        this.fileTransfer = new FileTransfer(this.conn, this.crypto);

        this.conn.onPeerJoined = (p) => this._onPeerJoined(p);
        this.conn.onPeerLeft = (p) => this._onPeerLeft(p);
        this.conn.onTextReceived = (d) => this.textShare.receive(d);
        this.conn.onFileEvent = (type, data) => this.fileTransfer.handleFileEvent(type, data);
        this.conn.onSyncRequest = () => this.textShare ? this.textShare.messages : [];
        this.conn.onHistoryReceived = (history) => { if (this.textShare) this.textShare.syncHistory(history); };

        this.fileTransfer.onProgress = (fid, prog, speed, dir, meta) => {
            let card = document.getElementById('transfer-' + fid);
            if (!card) {
                card = UI.renderTransferCard(fid, meta, dir, (id) => this.fileTransfer.cancelTransfer(id));
                document.getElementById('transfers-list').prepend(card);
            }
            UI.updateTransferProgress(fid, prog, speed);
        };

        this.fileTransfer.onIncomingFile = (fid, meta) => {
            const card = UI.renderTransferCard(fid, meta, 'download', (id) => this.fileTransfer.cancelTransfer(id));
            document.getElementById('transfers-list').prepend(card);
        };

        this.fileTransfer.onFileReceived = (fid, meta, blob, senderId) => {
            const tc = document.getElementById('transfer-' + fid);
            if (tc) tc.remove();
            const card = UI.renderReceivedFile(fid, meta, blob);
            document.getElementById('received-files').prepend(card);
            
            const peer = this.conn.getPeers().find(p => p.id === senderId);
            const senderName = peer ? peer.deviceName : 'Peer';
            const senderColor = this.textShare ? this.textShare._getPeerColor(senderId || 'unknown') : 'var(--text-secondary)';
            const url = URL.createObjectURL(blob);
            if (this.textShare) {
                this.textShare.addFileMessage(fid, meta, url, false, { name: senderName, id: senderId, color: senderColor }, Date.now());
            }
        };

        this._bindEvents();
        this.updateMyNameDisplay();

        try {
            if (localStorage.getItem('whynotshare_theme') === 'light') {
                document.body.classList.add('light-theme');
                const moon = document.querySelector('.icon-moon');
                const sun = document.querySelector('.icon-sun');
                if (moon && sun) { moon.style.display = 'none'; sun.style.display = 'block'; }
            }
        } catch {}

        try {
            const savedSess = sessionStorage.getItem('whynotshare_active_session');
            if (savedSess) {
                const sess = JSON.parse(savedSess);
                if (sess && sess.roomCode) {
                    if (sess.passphrase) this.crypto.setKey(sess.passphrase);
                    if (typeof sess.e2eEnabled === 'boolean') {
                        this.e2eEnabled = sess.e2eEnabled;
                        this.toggleE2E(sess.e2eEnabled);
                    }
                    if (sess.isCreator) {
                        UI.showScreen('screen-room');
                        document.getElementById('display-room-code').textContent = sess.roomCode;
                        document.getElementById('display-secret-phrase').textContent = sess.passphrase || 'None (Plaintext)';
                        const urlEl = document.getElementById('share-url');
                        if (urlEl) urlEl.dataset.url = this._buildShareUrl(sess.roomCode, sess.passphrase);
                        this.conn.createRoom(sess.roomCode).then(() => {
                            if (!sess.inWaitingRoom) {
                                this._enterShareScreen(sess.roomCode, this.conn.getPeers());
                            }
                        }).catch(() => {
                            sessionStorage.removeItem('whynotshare_active_session');
                            this._checkUrlHash();
                        });
                    } else {
                        UI.showScreen('screen-join');
                        document.getElementById('input-room-code').value = sess.roomCode;
                        document.getElementById('input-secret-phrase').value = sess.passphrase || '';
                        this.joinRoom(sess.roomCode, sess.passphrase || '');
                    }
                    return;
                }
            }
        } catch {}

        this._checkUrlHash();
    }

    async createRoom() {
        const btn = document.getElementById('btn-create');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<div class="waiting-dots" style="display:inline-flex;margin:0 8px 0 0"><span></span><span></span><span></span></div><span>Creating Room...</span>';
        }
        try {
            const phrase = await this.crypto.generateKey();
            const code = await this.conn.createRoom();
            document.getElementById('display-room-code').textContent = code;
            document.getElementById('display-secret-phrase').textContent = phrase;
            const targetUrl = this.e2eEnabled ? this._buildShareUrl(code, phrase) : (window.location.origin + window.location.pathname + '#' + code);
            const targetHash = this.e2eEnabled ? ('#' + code + ':' + phrase) : ('#' + code);
            document.getElementById('share-url').dataset.url = targetUrl;
            window.history.replaceState(null, '', targetHash);
            try {
                sessionStorage.setItem('whynotshare_active_session', JSON.stringify({
                    roomCode: code,
                    isCreator: true,
                    passphrase: phrase || '',
                    e2eEnabled: this.e2eEnabled,
                    inWaitingRoom: true
                }));
            } catch {}
            UI.showScreen('screen-room');
            const urlEl = document.getElementById('share-url');
            this.renderInlineQr(urlEl ? urlEl.dataset.url : null);
        } catch (err) {
            UI.toast('Failed: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Create Room';
            }
        }
    }

    async joinRoom(code, phrase) {
        if (!code) { UI.toast('Enter a room code', 'error'); return; }
        code = code.toUpperCase().trim();
        if (code.length === 6 && !code.includes('-')) code = code.slice(0, 3) + '-' + code.slice(3);
        const btn = document.getElementById('btn-join-submit');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<div class="waiting-dots" style="display:inline-flex;margin:0 8px 0 0"><span></span><span></span><span></span></div><span>Connecting...</span>';
        }
        try {
            if (phrase && phrase.trim()) {
                await this.crypto.importKey(phrase.trim());
                this.toggleE2E(true);
            } else {
                this.toggleE2E(false);
            }
            const peers = await this.conn.joinRoom(code);
            this._enterShareScreen(code, peers);
        } catch (err) {
            UI.toast(err.message || 'Failed to join', 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 20 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>Connect';
            }
        }
    }

    leaveRoom() {
        try { sessionStorage.removeItem('whynotshare_active_session'); } catch {}
        this.conn.leaveRoom();
        this.textShare.clear();
        this.crypto = new CryptoManager();
        this.textShare = new TextShare(this.conn, this.crypto);
        this.fileTransfer = new FileTransfer(this.conn, this.crypto);
        this.conn.onTextReceived = (d) => this.textShare.receive(d);
        this.conn.onFileEvent = (t, d) => this.fileTransfer.handleFileEvent(t, d);
        this.fileTransfer.onProgress = this.fileTransfer.onIncomingFile = this.fileTransfer.onFileReceived = null;
        window.history.replaceState(null, '', window.location.pathname);
        const btnC = document.getElementById('btn-create');
        if (btnC) { btnC.disabled = false; btnC.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Create Room'; }
        const btnJ = document.getElementById('btn-join-submit');
        if (btnJ) { btnJ.disabled = false; btnJ.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 20 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>Connect'; }
        UI.showScreen('screen-landing');
        this.init(); // re-init callbacks
    }

    stageFiles(fileList) {
        if (!fileList || !fileList.length) return;
        if (!this.stagedFiles) this.stagedFiles = [];
        for (const file of fileList) {
            if (!this.stagedFiles.some(f => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) {
                this.stagedFiles.push(file);
            }
        }
        this.updateStagedFilesUI();
    }

    removeStagedFile(index) {
        if (this.stagedFiles) {
            this.stagedFiles.splice(index, 1);
            this.updateStagedFilesUI();
        }
    }

    updateStagedFilesUI() {
        const renderContainer = (id, includeSendBtn) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (!this.stagedFiles || this.stagedFiles.length === 0) {
                el.style.display = 'none';
                el.innerHTML = '';
                return;
            }
            el.style.display = 'flex';
            el.innerHTML = '';
            
            const title = document.createElement('div');
            title.style.cssText = 'width:100%;font-size:0.8rem;font-weight:600;color:var(--text-secondary);margin-bottom:4px';
            title.textContent = 'Staged for sending (' + this.stagedFiles.length + '):';
            el.appendChild(title);

            const chipsWrap = document.createElement('div');
            chipsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;width:100%;align-items:center';
            this.stagedFiles.forEach((file, idx) => {
                const chip = document.createElement('div');
                chip.style.cssText = 'display:flex;align-items:center;gap:6px;background:var(--accent-primary);color:white;padding:4px 10px;border-radius:16px;font-size:0.8rem;font-weight:500';
                chip.innerHTML = '<span>📄 ' + UI.escapeHtml(file.name) + ' (' + FileTransfer.formatSize(file.size) + ')</span>' +
                    '<button type="button" style="background:none;border:none;color:white;cursor:pointer;font-weight:bold;padding:0 2px" title="Remove">✕</button>';
                chip.querySelector('button').addEventListener('click', () => this.removeStagedFile(idx));
                chipsWrap.appendChild(chip);
            });
            el.appendChild(chipsWrap);

            if (includeSendBtn) {
                const sendBtn = document.createElement('button');
                sendBtn.className = 'btn btn-primary';
                sendBtn.style.cssText = 'margin-top:8px;padding:8px 16px;font-size:0.9rem;background:var(--accent-gradient);color:white;border:none;border-radius:8px;cursor:pointer;font-weight:600';
                sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Send ' + this.stagedFiles.length + ' File' + (this.stagedFiles.length > 1 ? 's' : '');
                sendBtn.addEventListener('click', () => this.sendText());
                el.appendChild(sendBtn);
            }
        };

        renderContainer('staged-files-chat', false);
        renderContainer('staged-files-tab', true);
    }

    async sendText() {
        const input = document.getElementById('text-input');
        const text = input ? input.value.trim() : '';
        if (text) {
            await this.textShare.send(text);
            if (input) {
                input.value = '';
                UI.autoResize(input);
                input.focus();
            }
        }
        if (this.stagedFiles && this.stagedFiles.length > 0) {
            const filesToSend = [...this.stagedFiles];
            this.stagedFiles = [];
            this.updateStagedFilesUI();
            await this.sendFiles(filesToSend);
        }
    }

    async sendFiles(files) {
        for (const file of files) {
            await this.fileTransfer.sendFile(file);
            const tc = document.querySelector('[id^="transfer-"]');
            setTimeout(() => {
                document.querySelectorAll('.transfer-card').forEach(c => {
                    const fill = c.querySelector('.transfer-bar-fill');
                    if (fill && fill.style.width === '100%') c.remove();
                });
            }, 2000);
            const card = UI.renderSentFile(file);
            const rcv = document.getElementById('received-files');
            if (rcv) rcv.prepend(card);
            
            const url = URL.createObjectURL(file);
            const meta = { fileName: file.name, fileSize: file.size, fileType: file.type };
            if (this.textShare) {
                this.textShare.addFileMessage('sent-' + file.name + '-' + Date.now(), meta, url, true, { name: 'You', id: this.conn.getSocketId() }, Date.now());
            }
        }
    }

    toggleE2E(enabled) {
        this.e2eEnabled = enabled;
        try {
            const savedSess = sessionStorage.getItem('whynotshare_active_session');
            if (savedSess) {
                const sess = JSON.parse(savedSess);
                sess.e2eEnabled = enabled;
                sessionStorage.setItem('whynotshare_active_session', JSON.stringify(sess));
            }
        } catch {}
        if (this.textShare) this.textShare.setEncryption(enabled);
        if (this.fileTransfer) this.fileTransfer.setEncryption(enabled);

        // Update Room screen security pills
        const roomOn = document.getElementById('btn-room-encrypt-on');
        const roomOff = document.getElementById('btn-room-encrypt-off');
        if (roomOn && roomOff) {
            roomOn.classList.toggle('active', enabled);
            roomOff.classList.toggle('active-plaintext', !enabled);
            const roomBar = roomOn.closest('.security-switch-bar');
            if (roomBar) roomBar.classList.toggle('plaintext-mode', !enabled);
        }

        // Update Share screen security pills
        const shareOn = document.getElementById('btn-share-encrypt-on');
        const shareOff = document.getElementById('btn-share-encrypt-off');
        if (shareOn && shareOff) {
            shareOn.classList.toggle('active', enabled);
            shareOff.classList.toggle('active-plaintext', !enabled);
            const shareBar = shareOn.closest('.security-switch-bar');
            if (shareBar) shareBar.classList.toggle('plaintext-mode', !enabled);
        }
        const btnEditPass = document.getElementById('btn-edit-passphrase');
        if (btnEditPass) {
            btnEditPass.classList.toggle('collapsed', !enabled);
        }

        // Toggle visibility of secret phrase container on Room screen with smooth slide animation
        const phraseContainer = document.getElementById('secret-phrase-container');
        if (phraseContainer) {
            phraseContainer.classList.toggle('collapsed', !enabled);
        }
        const qrSection = document.getElementById('inline-qr-section');
        if (qrSection) {
            qrSection.style.display = enabled ? 'flex' : 'none';
        }

        // Update Share URL dataset and location hash
        const roomCodeEl = document.getElementById('display-room-code');
        const phraseEl = document.getElementById('display-secret-phrase');
        const code = this.conn.getRoomCode() || (roomCodeEl ? roomCodeEl.textContent : null);
        const phrase = this.crypto.getPhrase() || (phraseEl ? phraseEl.textContent : null);
        if (code && code !== '---') {
            const urlEl = document.getElementById('share-url');
            if (urlEl) {
                urlEl.dataset.url = enabled && phrase ? this._buildShareUrl(code, phrase) : (window.location.origin + window.location.pathname + '#' + code);
            }
            if (window.location.hash.startsWith('#' + code)) {
                window.history.replaceState(null, '', enabled && phrase ? '#' + code + ':' + phrase : '#' + code);
            }
            const sr = document.getElementById('screen-room');
            if (sr && sr.classList.contains('active')) {
                const urlEl = document.getElementById('share-url');
                this.renderInlineQr(urlEl ? urlEl.dataset.url : null);
            }
        }
    }

    async changePassphrase(phrase) {
        if (!phrase || !phrase.trim()) { UI.toast('Passphrase cannot be empty', 'error'); return; }
        await this.crypto.importKey(phrase.trim());
        UI.toast('Passphrase updated! Share it with other devices.', 'success');
        document.getElementById('modal-passphrase').style.display = 'none';
    }

    async generateNewPassphrase() {
        const phrase = await this.crypto.generateKey();
        document.getElementById('input-new-passphrase').value = phrase;
    }

    _enterShareScreen(code, peers) {
        document.getElementById('share-room-code').textContent = code;
        UI.updateDevicesList(peers, this.conn.getSocketId());
        if (this.textShare) {
            this.textShare.loadHistory();
            if (this.textShare.messages.length === 0) UI.showEmptyMessages();
        } else {
            UI.showEmptyMessages();
        }
        const dList = document.getElementById('devices-list');
        const dChev = document.getElementById('devices-dropdown-chevron');
        if (dList) { dList.classList.remove('expanded'); dList.style.display = ''; }
        if (dChev) dChev.style.transform = 'rotate(0deg)';
        document.getElementById('transfers-list').innerHTML = '';
        document.getElementById('received-files').innerHTML = '';
        this.toggleE2E(this.e2eEnabled);
        try {
            sessionStorage.setItem('whynotshare_active_session', JSON.stringify({
                roomCode: code,
                isCreator: this.conn.isCreator,
                passphrase: this.crypto.getPhrase() || '',
                e2eEnabled: this.e2eEnabled,
                inWaitingRoom: false
            }));
        } catch {}
        UI.showScreen('screen-share');
        setTimeout(() => { const i = document.getElementById('text-input'); if (i) i.focus(); }, 300);
    }

    _onPeerJoined(peer) {
        const rs = document.getElementById('screen-room');
        if (rs && rs.classList.contains('active')) { this._enterShareScreen(this.conn.getRoomCode(), this.conn.getPeers()); return; }
        UI.updateDevicesList(this.conn.getPeers(), this.conn.getSocketId());
    }

    _onPeerLeft() { UI.updateDevicesList(this.conn.getPeers(), this.conn.getSocketId()); }

    _buildShareUrl(code, phrase) {
        return window.location.origin + window.location.pathname + '#' + code + ':' + phrase;
    }

    _checkUrlHash() {
        const hash = window.location.hash.slice(1);
        if (!hash) return;
        let code = hash, phrase = '';
        if (hash.includes(':')) {
            const [c, ...rest] = hash.split(':');
            code = c;
            phrase = rest.join(':');
        }
        if (code) {
            setTimeout(() => {
                document.getElementById('input-room-code').value = code;
                document.getElementById('input-secret-phrase').value = phrase || '';
                this.toggleE2E(Boolean(phrase && phrase.trim()));
                UI.showScreen('screen-join');
            }, 300);
        }
    }

    updateMyNameDisplay() {
        const name = (this.conn && this.conn.myInfo && this.conn.myInfo.deviceName) || DeviceInfo.getFriendlyName(navigator.userAgent);
        const sys = (this.conn && this.conn.myInfo && this.conn.myInfo.systemName) || `${DeviceInfo.getBrowser(navigator.userAgent)} on ${DeviceInfo.getOS(navigator.userAgent)}`;
        const type = (this.conn && this.conn.myInfo && this.conn.myInfo.deviceType) || DeviceInfo.getType(navigator.userAgent);
        const iconSvg = DeviceInfo.getIcon(type);

        document.querySelectorAll('.display-device-name').forEach(el => {
            el.textContent = name;
        });
        document.querySelectorAll('.display-os-name').forEach(el => {
            el.textContent = sys;
        });
        document.querySelectorAll('.device-icon-span').forEach(el => {
            el.innerHTML = iconSvg;
        });
    }

    openRenameModal() {
        this.startInlineRename();
    }

    startInlineRename() {
        const activeScreen = document.querySelector('.screen.active') || document;
        const badge = activeScreen.querySelector('.device-id-badge');
        if (!badge) return;
        if (badge.querySelector('.inline-rename-box')) return;

        const nameSpan = badge.querySelector('.display-device-name');
        const editBtn = badge.querySelector('.btn-rename-pill');
        if (!nameSpan || !editBtn) return;

        const currentName = nameSpan.textContent;
        nameSpan.style.display = 'none';
        editBtn.style.display = 'none';

        const editBox = document.createElement('div');
        editBox.className = 'inline-rename-box';
        editBox.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1;margin-right:6px;';
        editBox.innerHTML = `
            <input type="text" class="input-field inline-input-el" value="${currentName}" style="padding:4px 8px;font-size:0.85rem;height:28px;min-width:110px;flex:1" maxlength="32" autocomplete="off" spellcheck="false">
            <button class="btn-rename-pill btn-random-inline" title="Random Name" style="padding:4px 8px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg></button>
            <button class="btn-rename-pill btn-save-inline" title="Save" style="padding:4px 8px;background:var(--status-online);color:white;border:none">✓</button>
            <button class="btn-rename-pill btn-cancel-inline" title="Cancel" style="padding:4px 8px">✕</button>
        `;

        nameSpan.parentNode.insertBefore(editBox, nameSpan);

        const inputEl = editBox.querySelector('.inline-input-el');
        const saveBtn = editBox.querySelector('.btn-save-inline');
        const cancelBtn = editBox.querySelector('.btn-cancel-inline');
        const randomBtn = editBox.querySelector('.btn-random-inline');

        const closeEdit = () => {
            editBox.remove();
            nameSpan.style.display = '';
            editBtn.style.display = '';
        };

        const saveEdit = () => {
            const val = inputEl.value.trim();
            if (!val) {
                UI.toast('Device name cannot be empty', 'error');
                return;
            }
            this.renameMyDevice(val);
            closeEdit();
        };

        saveBtn.addEventListener('click', saveEdit);
        cancelBtn.addEventListener('click', closeEdit);
        randomBtn.addEventListener('click', () => {
            const newName = DeviceInfo.generateRandomName();
            inputEl.value = newName;
            this.renameMyDevice(newName);
            inputEl.focus();
        });
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveEdit();
            if (e.key === 'Escape') closeEdit();
        });

        setTimeout(() => { inputEl.focus(); inputEl.select(); }, 50);
    }

    renameMyDevice(newName) {
        if (!newName || !newName.trim()) {
            UI.toast('Device name cannot be empty', 'error');
            return;
        }
        const clean = DeviceInfo.setCustomName(newName.trim());
        if (clean) {
            this.conn.renameDevice(clean);
            this.updateMyNameDisplay();
        }
    }

    randomizeMyName() {
        const newName = DeviceInfo.generateRandomName();
        this.renameMyDevice(newName);
    }

    _createQrInstance(url, size = 240) {
        if (!window.QRCodeStyling || !url) return null;
        const isLight = document.body.classList.contains('light-theme');
        const dotColor = isLight ? '#1e1b4b' : '#ffffff';
        const cornerColor = isLight ? '#f97316' : '#818cf8';
        const centerDotColor = isLight ? '#ea580c' : '#a5b4fc';
        const logoColor = isLight ? '#f97316' : '#818cf8';

        const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="12 10 76 80">
            <path d="M50 15 L80 30 V52 C80 72 50 88 50 88 C50 88 20 72 20 52 V30 Z" fill="none" stroke="${logoColor}" stroke-width="6" stroke-linejoin="round"/>
            <g transform="translate(34, 34) scale(1.3)" stroke="${logoColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </g>
        </svg>`;
        const logoUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(svgIcon);

        return new QRCodeStyling({
            type: "svg",
            width: size,
            height: size,
            data: url,
            dotsOptions: { color: dotColor, type: "dots" },
            cornersSquareOptions: { color: cornerColor, type: "extra-rounded" },
            cornersDotOptions: { color: centerDotColor, type: "dot" },
            backgroundOptions: { color: "transparent" },
            imageOptions: { crossOrigin: "anonymous", margin: 8, imageSize: 0.44, hideBackgroundDots: true },
            image: logoUrl
        });
    }

    showQrModal(url) {
        if (!url) {
            const urlEl = document.getElementById('share-url');
            url = (urlEl && urlEl.dataset.url) ? urlEl.dataset.url : window.location.href;
        }
        const modal = document.getElementById('modal-qr');
        const container = document.getElementById('qr-container');
        if (!modal || !container) return;
        container.innerHTML = '';
        this.qrCodeObj = this._createQrInstance(url, 240);
        if (this.qrCodeObj) {
            this.qrCodeObj.append(container);
        } else {
            container.textContent = 'QR Library not loaded';
        }
        modal.style.display = 'flex';
    }

    renderInlineQr(url) {
        const section = document.getElementById('inline-qr-section');
        if (section) {
            section.style.display = this.e2eEnabled ? 'flex' : 'none';
        }
        if (!this.e2eEnabled) return;
        if (!url) {
            const urlEl = document.getElementById('share-url');
            url = (urlEl && urlEl.dataset.url) ? urlEl.dataset.url : window.location.href;
        }
        const container = document.getElementById('inline-qr-container');
        if (!container) return;
        container.innerHTML = '';
        this.inlineQrObj = this._createQrInstance(url, 200);
        if (this.inlineQrObj) {
            this.inlineQrObj.append(container);
        }
    }

    _bindEvents() {
        if (this._eventsBound) return;
        this._eventsBound = true;
        document.getElementById('btn-create').addEventListener('click', () => this.createRoom());
        document.getElementById('btn-join-screen').addEventListener('click', () => UI.showScreen('screen-join'));
        document.getElementById('btn-join-submit').addEventListener('click', () => {
            this.joinRoom(document.getElementById('input-room-code').value, document.getElementById('input-secret-phrase').value);
        });
        document.getElementById('btn-back-landing').addEventListener('click', () => UI.showScreen('screen-landing'));
        document.getElementById('btn-copy-code').addEventListener('click', () => UI.copyToClipboard(document.getElementById('display-room-code').textContent));
        document.getElementById('btn-copy-phrase').addEventListener('click', () => UI.copyToClipboard(document.getElementById('display-secret-phrase').textContent));
        document.getElementById('btn-copy-link').addEventListener('click', () => UI.copyToClipboard(document.getElementById('share-url').dataset.url));
        const btnCopyRoomLink = document.getElementById('btn-copy-room-link');
        if (btnCopyRoomLink) {
            btnCopyRoomLink.addEventListener('click', () => {
                const urlEl = document.getElementById('share-url');
                UI.copyToClipboard(urlEl && urlEl.dataset.url ? urlEl.dataset.url : window.location.href);
            });
        }
        const openQr = () => {
            const urlEl = document.getElementById('share-url');
            const url = (urlEl && urlEl.dataset.url) ? urlEl.dataset.url : window.location.href;
            this.showQrModal(url);
        };
        const btnShowQrRoom = document.getElementById('btn-show-qr-room');
        const btnShowQrShare = document.getElementById('btn-show-qr-share');
        if (btnShowQrRoom) btnShowQrRoom.addEventListener('click', openQr);
        if (btnShowQrShare) btnShowQrShare.addEventListener('click', openQr);

        const btnCloseQr = document.getElementById('btn-close-qr');
        const modalQr = document.getElementById('modal-qr');
        if (btnCloseQr) btnCloseQr.addEventListener('click', () => { if (modalQr) modalQr.style.display = 'none'; });
        if (modalQr) modalQr.addEventListener('click', (e) => { if (e.target.id === 'modal-qr') modalQr.style.display = 'none'; });
        const btnDlQr = document.getElementById('btn-download-qr');
        if (btnDlQr) {
            btnDlQr.addEventListener('click', () => {
                if (this.qrCodeObj) {
                    const isLight = document.body.classList.contains('light-theme');
                    const bgColor = isLight ? '#ffffff' : '#0c1022';
                    this.qrCodeObj.update({ backgroundOptions: { color: bgColor } });
                    this.qrCodeObj.download({ name: 'whynotshare-room-' + (this.conn.getRoomCode() || 'link'), extension: 'png' });
                    setTimeout(() => {
                        if (this.qrCodeObj) this.qrCodeObj.update({ backgroundOptions: { color: 'transparent' } });
                    }, 600);
                }
            });
        }

        const devHeader = document.getElementById('devices-header');
        if (devHeader) {
            devHeader.addEventListener('click', () => {
                const list = document.getElementById('devices-list');
                const chevron = document.getElementById('devices-dropdown-chevron');
                if (list) {
                    const isExp = list.classList.toggle('expanded');
                    if (chevron) chevron.style.transform = isExp ? 'rotate(180deg)' : 'rotate(0deg)';
                }
            });
        }

        document.getElementById('btn-back-from-room').addEventListener('click', () => this.leaveRoom());
        document.getElementById('btn-send-text').addEventListener('click', () => this.sendText());
        document.getElementById('btn-disconnect').addEventListener('click', () => this.leaveRoom());

        const themeBtn = document.getElementById('btn-theme-toggle');
        if (themeBtn) {
            themeBtn.addEventListener('click', () => {
                const isLight = document.body.classList.toggle('light-theme');
                const moon = document.querySelector('.icon-moon');
                const sun = document.querySelector('.icon-sun');
                if (moon && sun) {
                    moon.style.display = isLight ? 'none' : 'block';
                    sun.style.display = isLight ? 'block' : 'none';
                }
                try { localStorage.setItem('whynotshare_theme', isLight ? 'light' : 'dark'); } catch {}
                const urlEl = document.getElementById('share-url');
                const url = (urlEl && urlEl.dataset.url) ? urlEl.dataset.url : window.location.href;
                const mq = document.getElementById('modal-qr');
                if (mq && mq.style.display !== 'none') {
                    this.showQrModal(url);
                }
                const sr = document.getElementById('screen-room');
                if (sr && sr.classList.contains('active')) {
                    this.renderInlineQr(url);
                }
            });
        }

        const ti = document.getElementById('text-input');
        ti.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendText(); } });
        ti.addEventListener('input', () => UI.autoResize(ti));

        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                const nav = btn.closest('.tab-nav');
                if (nav) nav.dataset.active = btn.dataset.tab;
                document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
            });
        });

        document.getElementById('input-room-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('input-secret-phrase').focus(); });
        document.getElementById('input-secret-phrase').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('btn-join-submit').click(); });

        // E2E security mode toggle pills
        const bRoomOn = document.getElementById('btn-room-encrypt-on');
        const bRoomOff = document.getElementById('btn-room-encrypt-off');
        const bShareOn = document.getElementById('btn-share-encrypt-on');
        const bShareOff = document.getElementById('btn-share-encrypt-off');
        if (bRoomOn) bRoomOn.addEventListener('click', () => this.toggleE2E(true));
        if (bRoomOff) bRoomOff.addEventListener('click', () => this.toggleE2E(false));
        if (bShareOn) bShareOn.addEventListener('click', () => this.toggleE2E(true));
        if (bShareOff) bShareOff.addEventListener('click', () => this.toggleE2E(false));
        const oldToggle = document.getElementById('toggle-e2e');
        if (oldToggle) oldToggle.addEventListener('change', (e) => this.toggleE2E(e.target.checked));

        // Passphrase modal
        document.getElementById('btn-edit-passphrase').addEventListener('click', () => {
            document.getElementById('input-new-passphrase').value = this.crypto.getPhrase() || '';
            document.getElementById('modal-passphrase').style.display = 'flex';
        });
        document.getElementById('btn-cancel-passphrase').addEventListener('click', () => document.getElementById('modal-passphrase').style.display = 'none');
        document.getElementById('btn-save-passphrase').addEventListener('click', () => this.changePassphrase(document.getElementById('input-new-passphrase').value));
        document.getElementById('btn-generate-passphrase').addEventListener('click', () => this.generateNewPassphrase());
        document.getElementById('modal-passphrase').addEventListener('click', (e) => { if (e.target.id === 'modal-passphrase') e.target.style.display = 'none'; });



        // File transfer
        const dropZone = document.getElementById('drop-zone');
        const filePicker = document.getElementById('file-picker');
        document.getElementById('btn-pick-file').addEventListener('click', () => filePicker.click());
        const btnAttachChat = document.getElementById('btn-attach-chat');
        if (btnAttachChat) btnAttachChat.addEventListener('click', () => filePicker.click());
        filePicker.addEventListener('change', (e) => { if (e.target.files.length) this.stageFiles(e.target.files); e.target.value = ''; });
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
        dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); if (e.dataTransfer.files.length) this.stageFiles(e.dataTransfer.files); });

        const handleChatDragOver = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const tia = document.querySelector('.text-input-area');
            if (tia && !e.target.closest('#drop-zone')) tia.classList.add('drag-highlight');
        };
        const handleChatDragLeave = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const tia = document.querySelector('.text-input-area');
            if (tia) tia.classList.remove('drag-highlight');
        };
        const handleChatDrop = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const tia = document.querySelector('.text-input-area');
            if (tia) tia.classList.remove('drag-highlight');
            if (e.target.closest('#drop-zone')) return;
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                this.stageFiles(e.dataTransfer.files);
            }
        };

        ['screen-room', 'tab-text', 'messages', 'text-input'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('dragenter', handleChatDragOver);
                el.addEventListener('dragover', handleChatDragOver);
                el.addEventListener('dragleave', handleChatDragLeave);
                el.addEventListener('drop', handleChatDrop);
            }
        });
    }
}

document.addEventListener('DOMContentLoaded', () => { window.app = new App(); window.app.init(); });

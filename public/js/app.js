class App {
    constructor() {
        this.conn = new ConnectionManager();
        this.crypto = new CryptoManager();
        this.textShare = null;
        this.fileTransfer = null;
        this.e2eEnabled = true;
        this.personalE2E = true;
        this.selectedPersonalRecipients = new Set();
        this._knownPeersForPersonalE2E = new Set();
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
        try { window.history.replaceState({ screenId: 'screen-landing' }, '', window.location.href); } catch { }

        try {
            if (localStorage.getItem('whynotshare_theme') === 'light') {
                document.body.classList.add('light-theme');
                const moon = document.querySelector('.icon-moon');
                const sun = document.querySelector('.icon-sun');
                if (moon && sun) { moon.style.display = 'block'; sun.style.display = 'none'; }
            }
        } catch { }

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
                        this.updatePhraseUI(sess.passphrase, !sess.e2eEnabled);
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
        } catch { }

        this._checkUrlHash();
        window.addEventListener('hashchange', () => {
            this._checkUrlHash();
        });
    }

    async createRoom() {
        const btn = document.getElementById('btn-create');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span style="display:inline-flex;align-items:center;justify-content:center;overflow:hidden;position:relative;width:100%"><span style="display:inline-flex;align-items:center;animation:slideInLeftSvg 0.35s cubic-bezier(0.16,1,0.3,1) forwards"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 13 32 6" fill="#ffffff" preserveAspectRatio="none" style="width:34px;height:16px;margin-right:8px;display:inline-block;vertical-align:middle"><path opacity="0.8" transform="translate(0 0)" d="M2 14 V18 H6 V14z"><animateTransform attributeName="transform" type="translate" values="0 0; 24 0; 0 0" dur="2s" begin="0" repeatCount="indefinite" keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8" calcMode="spline"/></path><path opacity="0.5" transform="translate(0 0)" d="M0 14 V18 H8 V14z"><animateTransform attributeName="transform" type="translate" values="0 0; 24 0; 0 0" dur="2s" begin="0.1s" repeatCount="indefinite" keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8" calcMode="spline"/></path><path opacity="0.25" transform="translate(0 0)" d="M0 14 V18 H8 V14z"><animateTransform attributeName="transform" type="translate" values="0 0; 24 0; 0 0" dur="2s" begin="0.2s" repeatCount="indefinite" keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8" calcMode="spline"/></path></svg></span><span style="display:inline-flex;align-items:center"><span style="animation:slideShiftLeftText 0.35s cubic-bezier(0.16,1,0.3,1) forwards">Creat</span><span style="display:inline-flex;position:relative;overflow:hidden"><span style="animation:morphIngIn 0.35s cubic-bezier(0.16,1,0.3,1) forwards">ing</span></span><span>&nbsp;Room</span><span style="animation:slideInRightDots 0.35s cubic-bezier(0.16,1,0.3,1) forwards">...</span></span></span>';
        }
        try {
            let phrase = '';
            if (this.e2eEnabled) {
                phrase = await this.crypto.generateKey();
            } else {
                await this.crypto.importKey('');
            }
            const code = await this.conn.createRoom();
            this.lastCreatedRoomCode = code;
            document.getElementById('display-room-code').textContent = code;
            this.updatePhraseUI(phrase, !this.e2eEnabled);
            const targetUrl = this.e2eEnabled ? this._buildShareUrl(code, phrase) : (window.location.origin + window.location.pathname + '#' + code);
            const targetHash = this.e2eEnabled ? ('#' + code + ':' + phrase) : ('#' + code);
            document.getElementById('share-url').dataset.url = targetUrl;
            window.history.replaceState(null, '', '#create-room');
            try {
                sessionStorage.setItem('whynotshare_active_session', JSON.stringify({
                    roomCode: code,
                    isCreator: true,
                    passphrase: phrase || '',
                    e2eEnabled: this.e2eEnabled,
                    inWaitingRoom: true
                }));
            } catch { }
            UI.showScreen('screen-room');
            const urlEl = document.getElementById('share-url');
            this.renderInlineQr(urlEl ? urlEl.dataset.url : null);
        } catch (err) {
            const msg = err && err.message ? err.message : 'Connection failed';
            const detail = (msg.includes('Connection failed') || msg.includes('Lost connection') || msg.includes('Timed out'))
                ? `${msg} (0.peerjs.com cloud server may be experiencing downtime)`
                : msg;
            UI.toast(detail, 'error');
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
            btn.innerHTML = '<span style="display:inline-flex;align-items:center;justify-content:center;overflow:hidden;position:relative;width:100%"><span style="display:inline-flex;align-items:center;animation:slideInLeftSvg 0.35s cubic-bezier(0.16,1,0.3,1) forwards"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 13 32 6" fill="#ffffff" preserveAspectRatio="none" style="width:34px;height:16px;margin-right:8px;display:inline-block;vertical-align:middle"><path opacity="0.8" transform="translate(0 0)" d="M2 14 V18 H6 V14z"><animateTransform attributeName="transform" type="translate" values="0 0; 24 0; 0 0" dur="2s" begin="0" repeatCount="indefinite" keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8" calcMode="spline"/></path><path opacity="0.5" transform="translate(0 0)" d="M0 14 V18 H8 V14z"><animateTransform attributeName="transform" type="translate" values="0 0; 24 0; 0 0" dur="2s" begin="0.1s" repeatCount="indefinite" keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8" calcMode="spline"/></path><path opacity="0.25" transform="translate(0 0)" d="M0 14 V18 H8 V14z"><animateTransform attributeName="transform" type="translate" values="0 0; 24 0; 0 0" dur="2s" begin="0.2s" repeatCount="indefinite" keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8" calcMode="spline"/></path></svg></span><span style="display:inline-flex;align-items:center"><span style="animation:slideShiftLeftText 0.35s cubic-bezier(0.16,1,0.3,1) forwards">Connect</span><span style="display:inline-flex;position:relative;overflow:hidden"><span style="animation:morphIngIn 0.35s cubic-bezier(0.16,1,0.3,1) forwards">ing</span></span><span style="animation:slideInRightDots 0.35s cubic-bezier(0.16,1,0.3,1) forwards">...</span></span></span>';
        }
        try {
            if (phrase && phrase.trim()) {
                await this.crypto.importKey(phrase.trim());
                this.toggleE2E(true);
            } else {
                this.toggleE2E(false);
            }
            let peers;
            try {
                peers = await this.conn.joinRoom(code);
            } catch (err) {
                const isMyRoom = (this.lastCreatedRoomCode && code === this.lastCreatedRoomCode) || (this.lastRoomCodeLeft && code === this.lastRoomCodeLeft);
                if (isMyRoom || err.message === 'Room not found.') {
                    await this.conn.createRoom(code);
                    peers = this.conn.getPeers();
                } else {
                    throw err;
                }
            }
            this._enterShareScreen(code, peers);
        } catch (err) {
            const msg = err && err.message ? err.message : 'Failed to join';
            const detail = (msg.includes('Connection failed') || msg.includes('Lost connection') || msg.includes('Timed out'))
                ? `${msg} (0.peerjs.com cloud server may be experiencing downtime)`
                : msg;
            UI.toast(detail, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 20 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>Connect';
            }
        }
    }

    leaveRoom(pushToHistory = true) {
        try { sessionStorage.removeItem('whynotshare_active_session'); } catch { }
        const currentCode = this.conn ? this.conn.getRoomCode() : null;
        if (currentCode) this.lastRoomCodeLeft = currentCode;
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
        UI.showScreen('screen-landing', pushToHistory);
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

    updatePhraseUI(phrase, isOpen) {
        const el = document.getElementById('display-secret-phrase');
        if (!el) return;
        if ('value' in el && el.tagName === 'INPUT') {
            if (isOpen || !this.e2eEnabled) {
                el.value = '';
                el.placeholder = 'Open Room (No Encryption)';
                el.disabled = true;
                el.style.opacity = '0.4';
                el.style.backgroundColor = 'rgba(0, 0, 0, 0.15)';
            } else {
                el.value = phrase || '';
                el.placeholder = 'Room Key';
                el.disabled = false;
                el.style.opacity = '1';
                el.style.backgroundColor = '';
            }
        } else {
            el.textContent = (isOpen || !this.e2eEnabled) ? 'None (Open Room)' : (phrase || '');
        }
        const btnGen = document.getElementById('btn-gen-room-key');
        if (btnGen) btnGen.style.display = (isOpen || !this.e2eEnabled) ? 'none' : 'inline-flex';
    }

    toggleE2E(enabled) {
        this.e2eEnabled = enabled;
        if (!enabled && this.crypto) {
            this.crypto.importKey('');
            this.updatePhraseUI('', true);
        } else if (enabled && this.crypto && !this.crypto.getPhrase() && (!this.conn || this.conn.isCreator || !this.conn.getRoomCode())) {
            this.crypto.generateKey().then(phrase => {
                this.updatePhraseUI(phrase || '', false);
                const code = this.conn ? this.conn.getRoomCode() : null;
                const urlEl = document.getElementById('share-url');
                if (code && urlEl && code !== '---') {
                    urlEl.dataset.url = this._buildShareUrl(code, phrase);
                    if (window.location.hash.startsWith('#' + code)) window.history.replaceState(null, '', '#' + code + ':' + phrase);
                    const sr = document.getElementById('screen-room');
                    if (sr && sr.classList.contains('active')) this.renderInlineQr(urlEl.dataset.url);
                }
            });
        } else if (enabled && this.crypto) {
            this.updatePhraseUI(this.crypto.getPhrase(), false);
        }
        try {
            const savedSess = sessionStorage.getItem('whynotshare_active_session');
            if (savedSess) {
                const sess = JSON.parse(savedSess);
                sess.e2eEnabled = enabled;
                sessionStorage.setItem('whynotshare_active_session', JSON.stringify(sess));
            }
        } catch { }
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
            qrSection.style.display = 'flex';
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

    /* --- Personal E2E & Host Governance Methods --- */
    togglePersonalE2E(enabled = true) {
        this.personalE2E = true;
        const container = document.getElementById('personal-recipients-container');
        if (container) {
            container.style.display = 'flex';
        }
        const pe2ePill = document.getElementById('pe2e-status-pill');
        if (pe2ePill) {
            pe2ePill.textContent = 'ON';
            pe2ePill.style.color = 'var(--accent-primary)';
        }
        if (!this.crypto.myPersonalKey) {
            this.crypto.generatePersonalKey().then(() => {
                const peers = this.conn.getPeers() || [];
                const myId = this.conn.getSocketId();
                peers.forEach(p => {
                    if (p.id !== myId && this.selectedPersonalRecipients && this.selectedPersonalRecipients.has(p.id)) {
                        this.conn.sendDirect(p.id, { type: 'share-personal-key', payload: { keyStr: this.crypto.myPersonalKeyStr, targetId: p.id } });
                    }
                });
            });
        }
        this.renderPersonalRecipients();
    }

    renderPersonalRecipients() {
        const listEl = document.getElementById('personal-recipients-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        const peers = this.conn.getPeers() || [];
        const myId = this.conn.getSocketId();
        if (!this.selectedPersonalRecipients) this.selectedPersonalRecipients = new Set();
        if (!this._knownPeersForPersonalE2E) this._knownPeersForPersonalE2E = new Set();

        let count = 0;
        peers.forEach(p => {
            if (p.id === myId) return;
            count++;
            if (!this._knownPeersForPersonalE2E.has(p.id)) {
                this._knownPeersForPersonalE2E.add(p.id);
                this.selectedPersonalRecipients.add(p.id);
                if (this.crypto.myPersonalKeyStr) {
                    this.conn.sendDirect(p.id, { type: 'share-personal-key', payload: { keyStr: this.crypto.myPersonalKeyStr, targetId: p.id } });
                }
            }
            const isSel = this.selectedPersonalRecipients.has(p.id);
            const chip = document.createElement('div');
            chip.className = 'recipient-chip ' + (isSel ? 'selected' : '');

            const iconSpan = document.createElement('span');
            iconSpan.className = 'chip-icon';
            iconSpan.innerHTML = isSel ?
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' :
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>';
            chip.appendChild(iconSpan);

            const nameSpan = document.createElement('span');
            nameSpan.textContent = p.deviceName || 'Unknown Device';
            chip.appendChild(nameSpan);

            chip.addEventListener('click', async () => {
                const nowSel = !this.selectedPersonalRecipients.has(p.id);
                if (nowSel) {
                    this.selectedPersonalRecipients.add(p.id);
                    if (!this.crypto.myPersonalKey) await this.crypto.generatePersonalKey();
                    this.conn.sendDirect(p.id, { type: 'share-personal-key', payload: { keyStr: this.crypto.myPersonalKeyStr, targetId: p.id } });
                } else {
                    this.selectedPersonalRecipients.delete(p.id);
                    this.conn.sendDirect(p.id, { type: 'share-personal-key', payload: { keyStr: null, targetId: p.id } });
                }
                this.renderPersonalRecipients();
            });

            listEl.appendChild(chip);
        });
        if (count === 0) {
            listEl.innerHTML = '<span style="font-size:0.8rem;color:var(--text-tertiary)">No other devices in the room yet.</span>';
        }
    }

    _triggerAutoSaveHostSettings(closeModal = false) {
        if (!this.conn || !this.conn.isCreator) return;
        const inputId = document.getElementById('input-new-room-id');
        const newId = inputId ? inputId.value.trim() : null;
        if (newId && newId !== this.conn.getRoomCode()) {
            this.conn._broadcast({ type: 'room-id-changed', payload: { newCode: newId } });
            this._onRoomIdChanged(newId);
        }
        const toggle = document.getElementById('toggle-open-room');
        const isOpen = toggle && toggle.checked;
        const inputKeyEl = document.getElementById('input-rotate-room-key');
        const newKey = isOpen ? '' : (inputKeyEl ? inputKeyEl.value.trim() : '');
        const currentKey = this.crypto.getPhrase() || '';
        if (newKey !== currentKey || isOpen === this.e2eEnabled) {
            this.conn._broadcast({ type: 'room-key-rotated', payload: { newKey: newKey } });
            this._onRoomKeyRotated(newKey);
        }

        const saveBtn = document.getElementById('btn-save-host-manage');
        const spinner = saveBtn ? saveBtn.querySelector('.save-spinner') : null;
        const txt = document.getElementById('txt-save-btn');
        if (saveBtn && txt) {
            if (spinner) spinner.style.display = 'inline-block';
            txt.textContent = 'Saving...';
            clearTimeout(this._saveAnimTimeout);
            clearTimeout(this._saveResetTimeout);
            this._saveAnimTimeout = setTimeout(() => {
                if (spinner) spinner.style.display = 'none';
                txt.textContent = 'Saved';
                if (closeModal) {
                    this._initialHostManageState = {
                        roomCode: this.conn.getRoomCode() || '',
                        e2eEnabled: this.e2eEnabled,
                        phrase: this.crypto.getPhrase() || ''
                    };
                    this._saveResetTimeout = setTimeout(() => {
                        const modal = document.getElementById('modal-host-manage');
                        if (modal) modal.style.display = 'none';
                        txt.textContent = 'Save';
                    }, 350);
                } else {
                    this._saveResetTimeout = setTimeout(() => {
                        txt.textContent = 'Save';
                    }, 1400);
                }
            }, 450);
        }
    }

    revertHostManageSettings() {
        if (this._initialHostManageState) {
            const init = this._initialHostManageState;
            if (init.roomCode && init.roomCode !== this.conn.getRoomCode()) {
                this.conn._broadcast({ type: 'room-id-changed', payload: { newCode: init.roomCode } });
                this._onRoomIdChanged(init.roomCode);
            }
            const currentKey = this.crypto.getPhrase() || '';
            if (init.phrase !== currentKey || init.e2eEnabled !== this.e2eEnabled) {
                this.conn._broadcast({ type: 'room-key-rotated', payload: { newKey: init.phrase } });
                this._onRoomKeyRotated(init.phrase);
            }
        }
        document.getElementById('modal-host-manage').style.display = 'none';
    }

    openHostManageModal() {
        this._initialHostManageState = {
            roomCode: this.conn.getRoomCode() || '',
            e2eEnabled: this.e2eEnabled,
            phrase: this.crypto.getPhrase() || ''
        };
        const isPrivileged = this.conn && (this.conn.isCreator || this.conn.isAdmin);
        const roomCode = this.conn.getRoomCode() || '';
        const isOpenRoom = !this.e2eEnabled || !this.crypto.getPhrase() || this.crypto.getPhrase().trim() === '';
        const phrase = isOpenRoom ? '' : (this.crypto.getPhrase() || '');
        const url = this._buildShareUrl(roomCode, phrase);

        document.getElementById('input-new-room-id').value = roomCode;
        const linkInput = document.getElementById('input-modal-room-link');
        if (linkInput) linkInput.value = url;
        document.getElementById('input-rotate-room-key').value = phrase;

        const titleEl = document.getElementById('host-manage-title-text');
        if (titleEl) titleEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="2.5"><path d="M12 2l3 6 6 1-4 4 1 6-6-3-6 3 1-6-4-4 6-1z"/></svg>${isPrivileged ? 'Host Governance Panel' : 'Room Details & Security'}`;

        const inputId = document.getElementById('input-new-room-id');
        if (inputId) inputId.readOnly = !isPrivileged;

        const toggleOpenRoom = document.getElementById('toggle-open-room');
        const boxToggleOpenRoom = document.getElementById('box-toggle-open-room');
        const btnGenKey = document.getElementById('btn-gen-rotate-room-key');
        const inputKey = document.getElementById('input-rotate-room-key');

        const isCreator = Boolean(this.conn && this.conn.isCreator);

        if (boxToggleOpenRoom) {
            boxToggleOpenRoom.style.display = 'block';
            boxToggleOpenRoom.style.opacity = isCreator ? '1' : '0.55';
            boxToggleOpenRoom.style.pointerEvents = isCreator ? 'auto' : 'none';
        }

        if (toggleOpenRoom) {
            toggleOpenRoom.checked = isOpenRoom;
            toggleOpenRoom.disabled = !isCreator;
        }

        const barKeyMode = document.getElementById('bar-room-key-mode');
        if (barKeyMode) barKeyMode.classList.toggle('plaintext-mode', isOpenRoom);
        const btnKeyReq = document.getElementById('btn-room-key-required');
        if (btnKeyReq) {
            btnKeyReq.classList.toggle('active', !isOpenRoom);
            btnKeyReq.style.pointerEvents = isCreator ? 'auto' : 'none';
        }
        const btnKeyOpen = document.getElementById('btn-room-key-open');
        if (btnKeyOpen) {
            btnKeyOpen.classList.toggle('active-plaintext', isOpenRoom);
            btnKeyOpen.style.pointerEvents = isCreator ? 'auto' : 'none';
        }

        if (inputKey) {
            if (isOpenRoom) {
                inputKey.value = '';
                inputKey.placeholder = 'Open Room (No Encryption)';
                inputKey.disabled = true;
                inputKey.style.opacity = '0.4';
                inputKey.style.backgroundColor = 'rgba(0, 0, 0, 0.15)';
            } else {
                inputKey.value = phrase;
                inputKey.placeholder = 'Room Key';
                inputKey.disabled = !isCreator;
                inputKey.readOnly = !isCreator;
                inputKey.style.opacity = '1';
                inputKey.style.backgroundColor = '';
            }
        }
        if (btnGenKey) btnGenKey.style.display = (!isOpenRoom && isCreator) ? 'inline-flex' : 'none';

        const deleteBtn = document.getElementById('btn-host-delete-room');
        if (deleteBtn) {
            deleteBtn.style.display = isCreator ? 'flex' : 'none';
            deleteBtn.dataset.confirming = 'false';
            deleteBtn.style.background = 'rgba(239, 68, 68, 0.12)';
            deleteBtn.style.borderColor = 'rgba(239, 68, 68, 0.35)';
            const mainTxt = document.getElementById('txt-delete-room-main');
            const subTxt = document.getElementById('txt-delete-room-sub');
            if (mainTxt) mainTxt.textContent = 'Delete Room';
            if (subTxt) subTxt.textContent = 'Disconnect all members & destroy room';
        }

        const bottomActions = document.getElementById('host-manage-bottom-actions');
        if (bottomActions) bottomActions.style.display = isCreator ? 'flex' : 'none';
        const btnSaveManage = document.getElementById('btn-save-host-manage');
        if (btnSaveManage) btnSaveManage.style.display = isCreator ? 'inline-flex' : 'none';

        this.renderHostMembersList();
        document.getElementById('modal-host-manage').style.display = 'flex';
    }

    renderHostMembersList() {
        const listEl = document.getElementById('host-members-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        const peers = this.conn.getPeers() || [];
        const myId = this.conn.getSocketId();
        peers.forEach(p => {
            const card = document.createElement('div');
            card.style.cssText = 'display:flex;flex-direction:column;background:rgba(255,255,255,0.03);border-radius:12px;border:1px solid rgba(255,255,255,0.06);overflow:hidden;transition:border-color 0.2s ease, background 0.2s ease';

            const header = document.createElement('div');
            const isMePrivileged = this.conn && (this.conn.isCreator || this.conn.isAdmin);
            const canManage = isMePrivileged && p.id !== myId && !p.isCreator;

            header.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:10px 14px;${canManage ? 'cursor:pointer;' : ''}user-select:none;transition:background 0.2s ease`;

            const left = document.createElement('div');
            left.style.cssText = 'display:flex;align-items:center;gap:10px';
            left.innerHTML = `
                <div style="width:34px;height:34px;border-radius:10px;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                </div>
                <div style="display:flex;flex-direction:column;gap:2px">
                    <span style="font-weight:600;font-size:0.88rem;color:var(--text-primary);display:flex;align-items:center;gap:6px">
                        ${p.deviceName || 'Device'}
                        ${p.id === myId ? '<span style="font-size:0.7rem;color:var(--accent-primary);font-weight:700">(You)</span>' : ''}
                    </span>
                    <span style="font-size:0.74rem;color:var(--text-tertiary)">${p.systemName || 'Web Client'}</span>
                </div>
            `;

            const right = document.createElement('div');
            right.style.cssText = 'display:flex;align-items:center;gap:8px';

            let badgeHtml = '';
            if (p.isCreator) {
                badgeHtml = '<span style="font-size:0.72rem;padding:3px 9px;background:rgba(108,92,231,0.22);color:var(--accent-primary);border-radius:12px;font-weight:700">Host</span>';
            } else if (p.isAdmin) {
                badgeHtml = '<span style="font-size:0.72rem;padding:3px 9px;background:rgba(234,88,12,0.22);color:#fb923c;border-radius:12px;font-weight:700">Admin</span>';
            } else {
                badgeHtml = '<span style="font-size:0.72rem;padding:3px 9px;background:rgba(255,255,255,0.07);color:var(--text-secondary);border-radius:12px;font-weight:600">Member</span>';
            }

            right.innerHTML = badgeHtml + (canManage ? '<svg class="member-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transition:transform 0.25s ease;color:var(--text-tertiary)"><polyline points="6 9 12 15 18 9"/></svg>' : '');

            header.appendChild(left);
            header.appendChild(right);
            card.appendChild(header);

            if (canManage) {
                const drawer = document.createElement('div');
                drawer.style.cssText = 'max-height:0px;opacity:0;overflow:hidden;transition:max-height 0.25s ease, opacity 0.25s ease, padding 0.25s ease;display:flex;align-items:center;justify-content:flex-end;gap:8px;background:rgba(0,0,0,0.24);border-top:0px solid rgba(255,255,255,0.06);padding:0 14px';

                if (!p.isAdmin) {
                    const btnPromote = document.createElement('button');
                    btnPromote.className = 'btn btn-secondary';
                    btnPromote.style.cssText = 'padding:6px 12px;font-size:0.75rem;height:auto;border-radius:8px;font-weight:600';
                    btnPromote.textContent = 'Promote to Admin';
                    btnPromote.onclick = (e) => {
                        e.stopPropagation();
                        p.isAdmin = true;
                        this.conn._broadcast({ type: 'promote-admin', payload: { targetId: p.id } });
                        this.conn._broadcast({ type: 'peer-update', payload: this.conn.getPeers() });
                        UI.toast(`Promoted ${p.deviceName} to Admin`, 'success');
                        this.refreshPeerLists();
                    };
                    drawer.appendChild(btnPromote);
                }

                const btnKick = document.createElement('button');
                btnKick.className = 'btn btn-danger';
                btnKick.style.cssText = 'padding:6px 14px;font-size:0.75rem;height:auto;border-radius:8px;font-weight:600';
                btnKick.textContent = 'Remove';
                btnKick.onclick = (e) => {
                    e.stopPropagation();
                    this.conn._broadcast({ type: 'kick-peer', payload: { targetId: p.id } });
                    this.conn.peers = (this.conn.peers || []).filter(x => x.id !== p.id);
                    if (this.conn.connections && this.conn.connections.has(p.id)) {
                        try { this.conn.connections.get(p.id).close(); } catch (err) { }
                        this.conn.connections.delete(p.id);
                    }
                    this.conn._broadcast({ type: 'peer-update', payload: this.conn.getPeers() });
                    this.refreshPeerLists();
                    UI.toast(`Removed ${p.deviceName}`, 'success');
                };
                drawer.appendChild(btnKick);

                let isOpen = false;
                header.addEventListener('click', () => {
                    isOpen = !isOpen;
                    const chev = header.querySelector('.member-chevron');
                    if (isOpen) {
                        drawer.style.maxHeight = '70px';
                        drawer.style.opacity = '1';
                        drawer.style.padding = '10px 14px';
                        drawer.style.borderTop = '1px solid rgba(255,255,255,0.06)';
                        if (chev) chev.style.transform = 'rotate(180deg)';
                        card.style.borderColor = 'rgba(108,92,231,0.45)';
                        card.style.background = 'rgba(255,255,255,0.05)';
                    } else {
                        drawer.style.maxHeight = '0px';
                        drawer.style.opacity = '0';
                        drawer.style.padding = '0 14px';
                        drawer.style.borderTop = '0px solid rgba(255,255,255,0.06)';
                        if (chev) chev.style.transform = 'rotate(0deg)';
                        card.style.borderColor = 'rgba(255,255,255,0.06)';
                        card.style.background = 'rgba(255,255,255,0.03)';
                    }
                });

                card.appendChild(drawer);
            }

            listEl.appendChild(card);
        });
    }

    refreshPeerLists() {
        if (!this.conn) return;
        const peers = this.conn.getPeers() || [];
        const myId = this.conn.getSocketId();
        UI.updateDevicesList(peers, myId);
        this.renderHostMembersList();
        this.renderPersonalRecipients();
    }

    _onRoomIdChanged(newCode) {
        this.conn.roomCode = newCode;
        document.getElementById('share-room-code').textContent = newCode;
        document.getElementById('display-room-code').textContent = newCode;
        const phrase = this.crypto.getPhrase() || '';
        const targetUrl = this.e2eEnabled ? this._buildShareUrl(newCode, phrase) : (window.location.origin + window.location.pathname + '#' + newCode);
        const targetHash = this.e2eEnabled ? ('#' + newCode + ':' + phrase) : ('#' + newCode);
        const urlEl = document.getElementById('share-url');
        if (urlEl) urlEl.dataset.url = targetUrl;
        window.history.replaceState(null, '', targetHash);
        try {
            const saved = sessionStorage.getItem('whynotshare_active_session');
            if (saved) {
                const s = JSON.parse(saved);
                s.roomCode = newCode;
                sessionStorage.setItem('whynotshare_active_session', JSON.stringify(s));
            }
        } catch { }
        this.renderInlineQr(targetUrl);
        UI.toast('Room ID changed to: ' + newCode, 'success');
    }

    async _onRoomKeyRotated(newKey) {
        const isEnc = Boolean(newKey && newKey.trim());
        this.toggleE2E(isEnc);
        await this.crypto.importKey(newKey || '');
        this.updatePhraseUI(newKey, !isEnc);
        const code = this.conn.getRoomCode();
        if (code) {
            const targetUrl = this.e2eEnabled ? this._buildShareUrl(code, newKey) : (window.location.origin + window.location.pathname + '#' + code);
            const targetHash = this.e2eEnabled ? ('#' + code + ':' + newKey) : ('#' + code);
            const urlEl = document.getElementById('share-url');
            if (urlEl) urlEl.dataset.url = targetUrl;
            window.history.replaceState(null, '', targetHash);
            try {
                const saved = sessionStorage.getItem('whynotshare_active_session');
                if (saved) {
                    const s = JSON.parse(saved);
                    s.passphrase = newKey || '';
                    s.e2eEnabled = this.e2eEnabled;
                    sessionStorage.setItem('whynotshare_active_session', JSON.stringify(s));
                }
            } catch { }
            this.renderInlineQr(targetUrl);
        }
        UI.toast(isEnc ? 'Room Key was rotated / updated!' : 'Room changed to Open Room!', 'success');
    }

    async changePassphrase(phrase) {
        if (!phrase || !phrase.trim()) { UI.toast('Passphrase cannot be empty', 'error'); return; }
        const cleanKey = phrase.trim();
        await this.crypto.importKey(cleanKey);
        if (this.conn.isCreator || this.conn.isAdmin) {
            this.conn._broadcast({ type: 'room-key-rotated', payload: { newKey: cleanKey } });
            this.updatePhraseUI(cleanKey, false);
            const code = this.conn.getRoomCode();
            if (code) {
                const targetUrl = this.e2eEnabled ? this._buildShareUrl(code, cleanKey) : (window.location.origin + window.location.pathname + '#' + code);
                const targetHash = this.e2eEnabled ? ('#' + code + ':' + cleanKey) : ('#' + code);
                const urlEl = document.getElementById('share-url');
                if (urlEl) urlEl.dataset.url = targetUrl;
                window.history.replaceState(null, '', targetHash);
                try {
                    const saved = sessionStorage.getItem('whynotshare_active_session');
                    if (saved) {
                        const s = JSON.parse(saved);
                        s.passphrase = cleanKey;
                        sessionStorage.setItem('whynotshare_active_session', JSON.stringify(s));
                    }
                } catch { }
                this.renderInlineQr(targetUrl);
            }
            UI.toast('Room Key updated & broadcasted to all members!', 'success');
        } else {
            UI.toast('Passphrase updated locally!', 'success');
        }
        document.getElementById('modal-passphrase').style.display = 'none';
    }

    async generateNewPassphrase() {
        const phrase = await this.crypto.generateKey();
        document.getElementById('input-new-passphrase').value = phrase;
    }

    _enterShareScreen(code, peers) {
        document.getElementById('share-room-code').textContent = code;
        this.refreshPeerLists();
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
        this.togglePersonalE2E(true); // Personal E2E ON by default, all members selected by default
        this.updatePrivilegeUI();
        try {
            sessionStorage.setItem('whynotshare_active_session', JSON.stringify({
                roomCode: code,
                isCreator: this.conn.isCreator,
                passphrase: this.crypto.getPhrase() || '',
                e2eEnabled: this.e2eEnabled,
                inWaitingRoom: false
            }));
        } catch { }
        const phrase = this.crypto.getPhrase() || '';
        const targetHash = this.e2eEnabled && phrase ? ('#' + code + ':' + phrase) : ('#' + code);
        try { window.history.replaceState(null, '', targetHash); } catch { }
        UI.showScreen('screen-share');
        setTimeout(() => { const i = document.getElementById('text-input'); if (i) i.focus(); }, 300);
    }

    _onPeerJoined(peer) {
        const rs = document.getElementById('screen-room');
        if (!rs || !rs.classList.contains('active')) {
            this._enterShareScreen(this.conn.getRoomCode(), this.conn.getPeers());
            return;
        }
        this.refreshPeerLists();
    }

    _onPeerLeft() {
        this.refreshPeerLists();
    }

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
                const codeInput = document.getElementById('input-room-code');
                const phraseInput = document.getElementById('input-secret-phrase');
                if (codeInput) codeInput.value = code;
                if (phraseInput) phraseInput.value = phrase || '';
                this.toggleE2E(Boolean(phrase && phrase.trim()));
                UI.showScreen('screen-join');
            }, 20);
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

    openRenameModal(btnEl) {
        this.startInlineRename(btnEl);
    }

    startInlineRename(btnEl) {
        let badge = btnEl && btnEl.closest ? btnEl.closest('.device-id-badge') : null;
        if (!badge) {
            const activeScreen = document.querySelector('.screen.active') || document;
            badge = activeScreen.querySelector('.device-id-badge');
        }
        if (!badge) return;
        if (badge.querySelector('.inline-rename-box')) return;

        const nameSpan = badge.querySelector('.display-device-name');
        const osSpan = badge.querySelector('.display-os-name');
        const editBtn = badge.querySelector('.btn-rename-pill');
        if (!nameSpan || !editBtn) return;

        const currentName = nameSpan.textContent;
        nameSpan.style.display = 'none';
        if (osSpan) osSpan.style.display = 'none';
        editBtn.style.display = 'none';

        const editBox = document.createElement('div');
        editBox.className = 'inline-rename-box';
        editBox.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1;margin-right:6px;animation:fadeInFast 0.18s ease forwards;';
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

        let closed = false;
        let isCancelling = false;
        let isRandomizing = false;

        const closeEdit = () => {
            if (closed) return;
            closed = true;
            editBox.remove();
            nameSpan.style.display = '';
            if (osSpan) osSpan.style.display = '';
            editBtn.style.display = '';
            nameSpan.style.animation = 'fadeInFast 0.15s ease forwards';
            if (osSpan) osSpan.style.animation = 'fadeInFast 0.15s ease forwards';
            editBtn.style.animation = 'fadeInFast 0.15s ease forwards';
        };

        const saveEdit = () => {
            if (closed) return;
            const val = inputEl.value.trim();
            if (!val || val === currentName) {
                closeEdit();
                return;
            }
            this.renameMyDevice(val);
            closeEdit();
        };

        saveBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            saveEdit();
        });
        cancelBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isCancelling = true;
            closeEdit();
        });
        randomBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isRandomizing = true;
            const newName = DeviceInfo.generateRandomName();
            inputEl.value = newName;
            setTimeout(() => { isRandomizing = false; inputEl.focus(); inputEl.select(); }, 10);
        });
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveEdit();
            if (e.key === 'Escape') {
                isCancelling = true;
                closeEdit();
            }
        });
        inputEl.addEventListener('blur', () => {
            setTimeout(() => {
                if (closed || isCancelling || isRandomizing) return;
                saveEdit();
            }, 120);
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

    updatePrivilegeUI() {
        const isPrivileged = this.conn && (this.conn.isCreator || this.conn.isAdmin);
        const hmBtn = document.getElementById('btn-host-manage');
        const hmText = document.getElementById('btn-host-manage-text');
        const passBtn = document.getElementById('btn-edit-passphrase');
        if (hmBtn) {
            hmBtn.style.display = 'inline-flex';
            hmBtn.classList.toggle('btn-host-privileged', isPrivileged);
        }
        if (hmText) hmText.textContent = isPrivileged ? 'Host Manage' : 'Room Info';
        if (passBtn) passBtn.style.display = 'none';
    }

    _createQrInstance(url, size = 240) {
        if (!window.QRCodeStyling || !url) return null;
        const isLight = document.body.classList.contains('light-theme');
        const dotColor = isLight ? '#1e1b4b' : '#f8fafc';
        const cornerColor = isLight ? '#f97316' : '#818cf8';
        const centerDotColor = isLight ? '#ea580c' : '#c084fc';
        const logoColor = isLight ? '#f97316' : '#818cf8';

        const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="12 10 76 80">
            <path d="M50 15 L80 30 V52 C80 72 50 88 50 88 C50 88 20 72 20 52 V30 Z" fill="none" stroke="${logoColor}" stroke-width="6" stroke-linejoin="round"/>
            <g transform="translate(34, 34) scale(1.3)" stroke="${logoColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </g>
        </svg>`;
        const logoUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(svgIcon);

        // 4x High-DPI / Retina super-sampling prevents bitmap blurring when zoomed in and eliminates sub-pixel gap scratches
        const renderSize = size * 4;

        return new QRCodeStyling({
            type: "canvas",
            width: renderSize,
            height: renderSize,
            data: url,
            qrOptions: { errorCorrectionLevel: "H" },
            dotsOptions: { color: dotColor, type: "rounded" },
            cornersSquareOptions: { color: cornerColor, type: "extra-rounded" },
            cornersDotOptions: { color: centerDotColor, type: "dot" },
            backgroundOptions: { color: "rgba(0, 0, 0, 0)" },
            imageOptions: { margin: 10, imageSize: 0.28, hideBackgroundDots: true },
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
        modal.style.display = 'flex';
        container.innerHTML = '';
        this.qrCodeObj = this._createQrInstance(url, 240);
        if (this.qrCodeObj) {
            this.qrCodeObj.append(container);
            const canvasEl = container.querySelector('canvas');
            if (canvasEl) {
                canvasEl.style.width = '240px';
                canvasEl.style.height = '240px';
                canvasEl.style.display = 'block';
            }
        } else {
            container.textContent = 'QR Library not loaded';
        }
    }

    renderInlineQr(url) {
        const section = document.getElementById('inline-qr-section');
        if (section) {
            section.style.display = 'flex';
        }
        const urlEl = document.getElementById('share-url');
        if (!url) {
            url = (urlEl && urlEl.dataset.url) ? urlEl.dataset.url : window.location.href;
        }
        if (urlEl && url) {
            urlEl.dataset.url = url;
            if ('value' in urlEl) urlEl.value = url;
        }
        const container = document.getElementById('inline-qr-container');
        if (!container) return;
        container.innerHTML = '';
        this.inlineQrObj = this._createQrInstance(url, 200);
        if (this.inlineQrObj) {
            this.inlineQrObj.append(container);
            const canvasEl = container.querySelector('canvas');
            if (canvasEl) {
                canvasEl.style.width = '200px';
                canvasEl.style.height = '200px';
                canvasEl.style.display = 'block';
            }
        }
    }

    _bindEvents() {
        if (this._eventsBound) return;
        this._eventsBound = true;
        window.addEventListener('popstate', (e) => {
            const state = e.state;
            const targetScreenId = state && state.screenId ? state.screenId : 'screen-landing';
            const currentActive = document.querySelector('.screen.active');
            const currentScreenId = currentActive ? currentActive.id : 'screen-landing';
            if (currentScreenId === 'screen-share' && (targetScreenId === 'screen-landing' || targetScreenId === 'screen-room' || targetScreenId === 'screen-join')) {
                this.leaveRoom(false);
            } else if (targetScreenId === 'screen-share' && !this.conn.getRoomCode()) {
                const codeToRejoin = this.lastRoomCodeLeft || (window.location.hash ? window.location.hash.slice(1).split(':')[0] : null);
                if (this.lastCreatedRoomCode || codeToRejoin === 'create-room') {
                    UI.showScreen('screen-room', false);
                    return;
                }
                if (codeToRejoin && codeToRejoin !== 'create-room') {
                    const joinInput = document.getElementById('join-room-code');
                    if (joinInput) joinInput.value = codeToRejoin;
                    UI.showScreen('screen-join', false);
                    return;
                }
                UI.showScreen('screen-landing', false);
            } else {
                UI.showScreen(targetScreenId, false);
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                const activeTag = document.activeElement ? document.activeElement.tagName.toUpperCase() : '';
                if (activeTag !== 'TEXTAREA') {
                    const screenRoom = document.getElementById('screen-room');
                    const screenJoin = document.getElementById('screen-join');
                    if (screenRoom && screenRoom.classList.contains('active')) {
                        const btnEnter = document.getElementById('btn-host-enter-room');
                        if (btnEnter && !btnEnter.disabled) {
                            e.preventDefault();
                            btnEnter.click();
                            return;
                        }
                    } else if (screenJoin && screenJoin.classList.contains('active')) {
                        if (activeTag === 'INPUT') {
                            e.preventDefault();
                            document.activeElement.blur();
                            return;
                        }
                        const btnJoin = document.getElementById('btn-join-submit');
                        if (btnJoin && !btnJoin.disabled) {
                            e.preventDefault();
                            btnJoin.click();
                            return;
                        }
                    }
                }
            }
            if (e.key === 'Escape') {
                const activeModals = document.querySelectorAll('.modal-overlay');
                let closedAny = false;
                activeModals.forEach(m => {
                    if (m.style.display !== 'none') {
                        m.style.display = 'none';
                        closedAny = true;
                    }
                });
                const devicesList = document.getElementById('devices-list');
                const chevron = document.getElementById('devices-dropdown-chevron');
                if (devicesList && devicesList.classList.contains('expanded')) {
                    devicesList.classList.remove('expanded');
                    if (chevron) chevron.style.transform = 'rotate(0deg)';
                    closedAny = true;
                }
                if (closedAny) {
                    const ti = document.getElementById('text-input');
                    const shareScreen = document.getElementById('screen-share');
                    if (ti && shareScreen && shareScreen.classList.contains('active')) {
                        ti.focus();
                    }
                }
            }
        });
        const btnHostEnter = document.getElementById('btn-host-enter-room');
        if (btnHostEnter) {
            btnHostEnter.addEventListener('click', async () => {
                let code = this.conn.getRoomCode();
                if (!code) {
                    const codeEl = document.getElementById('display-room-code');
                    const savedCode = codeEl ? codeEl.textContent.trim() : null;
                    if (savedCode && savedCode !== '---') {
                        code = await this.conn.createRoom(savedCode);
                    }
                }
                if (!code) {
                    UI.toast('No active room found. Please create a room.', 'error');
                    return;
                }
                this._enterShareScreen(code, this.conn.getPeers());
            });
        }
        document.getElementById('btn-create').addEventListener('click', () => this.createRoom());
        document.getElementById('btn-join-screen').addEventListener('click', () => UI.showScreen('screen-join'));
        document.getElementById('btn-join-submit').addEventListener('click', () => {
            this.joinRoom(document.getElementById('input-room-code').value, document.getElementById('input-secret-phrase').value);
        });
        document.getElementById('btn-back-landing').addEventListener('click', () => UI.showScreen('screen-landing'));
        document.getElementById('btn-copy-code').addEventListener('click', () => UI.copyToClipboard(document.getElementById('display-room-code').textContent));
        document.getElementById('btn-copy-phrase').addEventListener('click', () => {
            const el = document.getElementById('display-secret-phrase');
            UI.copyToClipboard(el ? (el.value !== undefined && el.tagName === 'INPUT' ? el.value : el.textContent) : '');
        });
        const btnGenRoomKey = document.getElementById('btn-gen-room-key');
        if (btnGenRoomKey) {
            btnGenRoomKey.addEventListener('click', async () => {
                if (!this.e2eEnabled) return;
                const newPhrase = this.crypto.generateRandomPhrase();
                await this.crypto.importKey(newPhrase);
                this.updatePhraseUI(newPhrase, false);
                const code = this.conn ? this.conn.getRoomCode() : null;
                const urlEl = document.getElementById('share-url');
                if (code && urlEl && code !== '---') {
                    const targetUrl = this._buildShareUrl(code, newPhrase);
                    urlEl.dataset.url = targetUrl;
                    window.history.replaceState(null, '', '#' + code + ':' + newPhrase);
                    this.renderInlineQr(targetUrl);
                }
                if (this.conn && (this.conn.isCreator || this.conn.isAdmin)) {
                    this.conn._broadcast({ type: 'room-key-rotated', payload: { newKey: newPhrase } });
                }
                UI.toast('Generated new room key!', 'success');
            });
        }
        const phraseInput = document.getElementById('display-secret-phrase');
        if (phraseInput) {
            phraseInput.addEventListener('input', async (e) => {
                if (!this.e2eEnabled) return;
                const val = e.target.value.trim();
                await this.crypto.importKey(val);
                const code = this.conn ? this.conn.getRoomCode() : null;
                const urlEl = document.getElementById('share-url');
                if (code && urlEl && code !== '---') {
                    const targetUrl = val ? this._buildShareUrl(code, val) : (window.location.origin + window.location.pathname + '#' + code);
                    urlEl.dataset.url = targetUrl;
                    if (val) window.history.replaceState(null, '', '#' + code + ':' + val);
                    this.renderInlineQr(targetUrl);
                }
                if (this.conn && (this.conn.isCreator || this.conn.isAdmin)) {
                    this.conn._broadcast({ type: 'room-key-rotated', payload: { newKey: val } });
                }
            });
        }
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
        const btnCloseQrTop = document.getElementById('btn-close-qr-top');
        const modalQr = document.getElementById('modal-qr');
        if (btnCloseQr) btnCloseQr.addEventListener('click', () => { if (modalQr) modalQr.style.display = 'none'; });
        if (btnCloseQrTop) btnCloseQrTop.addEventListener('click', () => { if (modalQr) modalQr.style.display = 'none'; });
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
                        if (this.qrCodeObj) this.qrCodeObj.update({ backgroundOptions: { color: 'rgba(0, 0, 0, 0)' } });
                    }, 600);
                }
            });
        }

        const btnShowDevices = document.getElementById('btn-show-devices-popup');
        if (btnShowDevices) {
            btnShowDevices.addEventListener('click', () => {
                document.getElementById('modal-connected-devices').style.display = 'flex';
            });
        }
        const btnCloseDevices = document.getElementById('btn-close-devices-modal');
        if (btnCloseDevices) {
            btnCloseDevices.addEventListener('click', () => {
                document.getElementById('modal-connected-devices').style.display = 'none';
            });
        }
        const modalDevices = document.getElementById('modal-connected-devices');
        if (modalDevices) {
            modalDevices.addEventListener('click', (e) => {
                if (e.target.id === 'modal-connected-devices') e.target.style.display = 'none';
            });
        }

        const btnShowPe2e = document.getElementById('btn-show-pe2e-popup');
        if (btnShowPe2e) {
            btnShowPe2e.addEventListener('click', () => {
                document.getElementById('modal-personal-e2e').style.display = 'flex';
                this.renderPersonalRecipients();
            });
        }
        const btnClosePe2e = document.getElementById('btn-close-pe2e-modal');
        if (btnClosePe2e) {
            btnClosePe2e.addEventListener('click', () => {
                document.getElementById('modal-personal-e2e').style.display = 'none';
            });
        }
        const modalPe2e = document.getElementById('modal-personal-e2e');
        if (modalPe2e) {
            modalPe2e.addEventListener('click', (e) => {
                if (e.target.id === 'modal-personal-e2e') e.target.style.display = 'none';
            });
        }

        document.getElementById('btn-back-from-room').addEventListener('click', () => this.leaveRoom());
        document.getElementById('btn-send-text').addEventListener('click', () => this.sendText());
        document.getElementById('btn-disconnect').addEventListener('click', () => this.leaveRoom());

        document.querySelectorAll('.btn-theme-toggle').forEach(themeBtn => {
            themeBtn.addEventListener('click', () => {
                const isLight = document.body.classList.toggle('light-theme');
                document.querySelectorAll('.icon-moon').forEach(moon => moon.style.display = isLight ? 'block' : 'none');
                document.querySelectorAll('.icon-sun').forEach(sun => sun.style.display = isLight ? 'none' : 'block');
                try { localStorage.setItem('whynotshare_theme', isLight ? 'light' : 'dark'); } catch { }
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
        });

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
        if (bShareOn) bShareOn.addEventListener('click', () => this.togglePersonalE2E(true));
        if (bShareOff) bShareOff.addEventListener('click', () => this.togglePersonalE2E(false));
        const oldToggle = document.getElementById('toggle-e2e');
        if (oldToggle) oldToggle.addEventListener('change', (e) => this.toggleE2E(e.target.checked));

        // Host Governance modal events
        const btnHostManage = document.getElementById('btn-host-manage');
        if (btnHostManage) btnHostManage.addEventListener('click', () => this.openHostManageModal());
        const btnCloseHostManage = document.getElementById('btn-close-host-manage');
        if (btnCloseHostManage) btnCloseHostManage.addEventListener('click', () => document.getElementById('modal-host-manage').style.display = 'none');
        document.getElementById('modal-host-manage').addEventListener('click', (e) => { if (e.target.id === 'modal-host-manage') e.target.style.display = 'none'; });
        const setRoomKeyMode = async (isOpen) => {
            const toggle = document.getElementById('toggle-open-room');
            if (toggle) toggle.checked = isOpen;
            const bar = document.getElementById('bar-room-key-mode');
            if (bar) bar.classList.toggle('plaintext-mode', isOpen);
            const btnReq = document.getElementById('btn-room-key-required');
            if (btnReq) btnReq.classList.toggle('active', !isOpen);
            const btnOpen = document.getElementById('btn-room-key-open');
            if (btnOpen) btnOpen.classList.toggle('active-plaintext', isOpen);

            const inputEl = document.getElementById('input-rotate-room-key');
            const btnGenKey = document.getElementById('btn-gen-rotate-room-key');
            if (inputEl) {
                if (isOpen) {
                    inputEl.value = '';
                    inputEl.placeholder = 'Open Room (No Encryption)';
                    inputEl.disabled = true;
                    inputEl.style.opacity = '0.4';
                    inputEl.style.backgroundColor = 'rgba(0, 0, 0, 0.15)';
                } else {
                    let phrase = this.crypto.getPhrase();
                    if (!phrase || !phrase.trim()) {
                        phrase = this.crypto.generateRandomPhrase();
                    }
                    inputEl.value = phrase;
                    inputEl.placeholder = 'Room Key';
                    inputEl.disabled = false;
                    inputEl.readOnly = false;
                    inputEl.style.opacity = '1';
                    inputEl.style.backgroundColor = '';
                }
            }
            if (btnGenKey) btnGenKey.style.display = !isOpen ? 'inline-flex' : 'none';
            this._triggerAutoSaveHostSettings(false);
        };

        const btnKeyReq = document.getElementById('btn-room-key-required');
        const btnKeyOpen = document.getElementById('btn-room-key-open');
        if (btnKeyReq) btnKeyReq.addEventListener('click', () => setRoomKeyMode(false));
        if (btnKeyOpen) btnKeyOpen.addEventListener('click', () => setRoomKeyMode(true));

        const toggleOpenRoom = document.getElementById('toggle-open-room');
        if (toggleOpenRoom) {
            toggleOpenRoom.addEventListener('change', (e) => setRoomKeyMode(e.target.checked));
        }
        const btnGenRotateKey = document.getElementById('btn-gen-rotate-room-key');
        if (btnGenRotateKey) {
            btnGenRotateKey.addEventListener('click', () => {
                const phrase = this.crypto.generateRandomPhrase();
                const inputEl = document.getElementById('input-rotate-room-key');
                if (inputEl) inputEl.value = phrase;
                this._triggerAutoSaveHostSettings(false);
            });
        }

        const inputNewId = document.getElementById('input-new-room-id');
        if (inputNewId) {
            let idDebounce;
            inputNewId.addEventListener('input', () => {
                clearTimeout(idDebounce);
                idDebounce = setTimeout(() => this._triggerAutoSaveHostSettings(false), 650);
            });
            inputNewId.addEventListener('change', () => this._triggerAutoSaveHostSettings(false));
        }

        const inputRotateKey = document.getElementById('input-rotate-room-key');
        if (inputRotateKey) {
            let keyDebounce;
            inputRotateKey.addEventListener('input', () => {
                clearTimeout(keyDebounce);
                keyDebounce = setTimeout(() => this._triggerAutoSaveHostSettings(false), 650);
            });
            inputRotateKey.addEventListener('change', () => this._triggerAutoSaveHostSettings(false));
        }

        const btnCancelHostManage = document.getElementById('btn-cancel-host-manage');
        if (btnCancelHostManage) {
            btnCancelHostManage.addEventListener('click', () => {
                this.revertHostManageSettings();
            });
        }
        const btnSaveHostManage = document.getElementById('btn-save-host-manage');
        if (btnSaveHostManage) {
            btnSaveHostManage.addEventListener('click', () => {
                this._triggerAutoSaveHostSettings(true);
            });
        }
        const btnDeleteRoom = document.getElementById('btn-host-delete-room');
        if (btnDeleteRoom) {
            btnDeleteRoom.addEventListener('click', () => {
                if (btnDeleteRoom.dataset.confirming !== 'true') {
                    btnDeleteRoom.dataset.confirming = 'true';
                    btnDeleteRoom.style.background = 'rgba(239, 68, 68, 0.28)';
                    btnDeleteRoom.style.borderColor = '#ef4444';
                    const mainTxt = document.getElementById('txt-delete-room-main');
                    const subTxt = document.getElementById('txt-delete-room-sub');
                    if (mainTxt) mainTxt.textContent = 'Are you sure? Click again to Delete';
                    if (subTxt) subTxt.textContent = 'This option cannot be undone';
                    clearTimeout(btnDeleteRoom._confirmTimer);
                    btnDeleteRoom._confirmTimer = setTimeout(() => {
                        btnDeleteRoom.dataset.confirming = 'false';
                        btnDeleteRoom.style.background = 'rgba(239, 68, 68, 0.12)';
                        btnDeleteRoom.style.borderColor = 'rgba(239, 68, 68, 0.35)';
                        if (mainTxt) mainTxt.textContent = 'Delete Room';
                        if (subTxt) subTxt.textContent = 'Disconnect all members & destroy room';
                    }, 5000);
                } else {
                    clearTimeout(btnDeleteRoom._confirmTimer);
                    this.conn._broadcast({ type: 'room-deleted' });
                    document.getElementById('modal-host-manage').style.display = 'none';
                    setTimeout(() => {
                        this.leaveRoom();
                    }, 200);
                }
            });
        }
        const btnSelectAllRecipients = document.getElementById('btn-select-all-recipients');
        if (btnSelectAllRecipients) {
            btnSelectAllRecipients.addEventListener('click', async () => {
                if (!this.crypto.myPersonalKey) await this.crypto.generatePersonalKey();
                const peers = this.conn.getPeers() || [];
                const myId = this.conn.getSocketId();
                if (!this.selectedPersonalRecipients) this.selectedPersonalRecipients = new Set();
                peers.forEach(p => {
                    if (p.id !== myId) {
                        this.selectedPersonalRecipients.add(p.id);
                        this.conn.sendDirect(p.id, { type: 'share-personal-key', payload: { keyStr: this.crypto.myPersonalKeyStr, targetId: p.id } });
                    }
                });
                this.renderPersonalRecipients();
                UI.toast('Shared personal encryption key with all recipients', 'success');
            });
        }

        const btnRoomBadgeCopy = document.getElementById('btn-room-badge-copy');
        if (btnRoomBadgeCopy) {
            btnRoomBadgeCopy.addEventListener('click', () => {
                if (this.roomCode) {
                    navigator.clipboard.writeText(this.roomCode);
                    UI.toast('Room ID copied to clipboard!', 'success');
                }
            });
        }
        const btnCopyModalRoomId = document.getElementById('btn-copy-modal-room-id');
        if (btnCopyModalRoomId) {
            btnCopyModalRoomId.addEventListener('click', () => {
                const val = document.getElementById('input-new-room-id').value;
                if (val) {
                    navigator.clipboard.writeText(val);
                    UI.toast('Room ID copied!', 'success');
                }
            });
        }
        const btnCopyModalRoomLink = document.getElementById('btn-copy-modal-room-link');
        if (btnCopyModalRoomLink) {
            btnCopyModalRoomLink.addEventListener('click', () => {
                const val = document.getElementById('input-modal-room-link').value;
                if (val) {
                    navigator.clipboard.writeText(val);
                    UI.toast('Room Link copied!', 'success');
                }
            });
        }
        const btnCopyModalRoomKey = document.getElementById('btn-copy-modal-room-key');
        if (btnCopyModalRoomKey) {
            btnCopyModalRoomKey.addEventListener('click', () => {
                const val = document.getElementById('input-rotate-room-key').value;
                if (val) {
                    navigator.clipboard.writeText(val);
                    UI.toast('Room Key copied!', 'success');
                }
            });
        }

        // Passphrase modal
        const btnEditPass = document.getElementById('btn-edit-passphrase');
        if (btnEditPass) btnEditPass.addEventListener('click', () => {
            const isPrivileged = this.conn.isCreator || this.conn.isAdmin;
            const titleEl = document.getElementById('passphrase-modal-title');
            const labelEl = document.getElementById('passphrase-modal-label');
            const descEl = document.getElementById('passphrase-modal-desc');
            const inputEl = document.getElementById('input-new-passphrase');
            const btnGen = document.getElementById('btn-generate-passphrase');
            const btnSave = document.getElementById('btn-save-passphrase');
            const btnCancel = document.getElementById('btn-cancel-passphrase');

            inputEl.value = this.crypto.getPhrase() || '';

            if (isPrivileged) {
                if (titleEl) titleEl.textContent = 'Change Encryption Passphrase';
                if (labelEl) labelEl.textContent = 'New Passphrase';
                if (descEl) descEl.textContent = 'All devices must use the same passphrase to decrypt messages.';
                inputEl.readOnly = false;
                inputEl.style.opacity = '1';
                inputEl.style.cursor = 'text';
                if (btnGen) btnGen.style.display = 'flex';
                if (btnSave) btnSave.style.display = '';
                if (btnCancel) btnCancel.textContent = 'Cancel';
            } else {
                if (titleEl) titleEl.textContent = 'Room Encryption Key';
                if (labelEl) labelEl.textContent = 'Current Room Key (View Only)';
                if (descEl) descEl.textContent = 'Only room hosts or admins can rotate the encryption key.';
                inputEl.readOnly = true;
                inputEl.style.opacity = '0.85';
                inputEl.style.cursor = 'default';
                if (btnGen) btnGen.style.display = 'none';
                if (btnSave) btnSave.style.display = 'none';
                if (btnCancel) btnCancel.textContent = 'Close';
            }
            document.getElementById('modal-passphrase').style.display = 'flex';
        });
        document.getElementById('btn-cancel-passphrase').addEventListener('click', () => document.getElementById('modal-passphrase').style.display = 'none');
        const btnClosePassTop = document.getElementById('btn-close-passphrase-top');
        if (btnClosePassTop) btnClosePassTop.addEventListener('click', () => document.getElementById('modal-passphrase').style.display = 'none');
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

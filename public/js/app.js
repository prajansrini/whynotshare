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
    togglePersonalE2E(enabled) {
        this.personalE2E = enabled;
        const shareOn = document.getElementById('btn-share-encrypt-on');
        const shareOff = document.getElementById('btn-share-encrypt-off');
        if (shareOn && shareOff) {
            shareOn.classList.toggle('active', enabled);
            shareOff.classList.toggle('active-plaintext', !enabled);
            const shareBar = shareOn.closest('.security-switch-bar');
            if (shareBar) shareBar.classList.toggle('plaintext-mode', !enabled);
        }
        const container = document.getElementById('personal-recipients-container');
        if (container) {
            container.style.display = enabled ? 'flex' : 'none';
        }
        const pe2ePill = document.getElementById('pe2e-status-pill');
        if (pe2ePill) {
            pe2ePill.textContent = enabled ? 'ON' : 'OFF';
            pe2ePill.style.color = enabled ? '#a855f7' : 'var(--text-tertiary)';
        }
        this.renderPersonalRecipients();
        if (enabled && !this.crypto.myPersonalKey) {
            this.crypto.generatePersonalKey();
        }
    }

    renderPersonalRecipients() {
        const listEl = document.getElementById('personal-recipients-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        const peers = this.conn.getPeers() || [];
        const myId = this.conn.getSocketId();
        if (!this.selectedPersonalRecipients) this.selectedPersonalRecipients = new Set();
        
        let count = 0;
        peers.forEach(p => {
            if (p.id === myId) return;
            count++;
            const isSel = this.selectedPersonalRecipients.has(p.id);
            const chip = document.createElement('div');
            chip.className = 'recipient-chip ' + (isSel ? 'selected' : '');
            chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;font-size:0.82rem;font-weight:500;cursor:pointer;user-select:none;transition:all 0.2s ease;' +
                (isSel ? 'background:linear-gradient(135deg, rgba(99,102,241,0.3), rgba(168,85,247,0.3));border:1px solid rgba(168,85,247,0.8);color:var(--text-primary);box-shadow:0 2px 10px rgba(168,85,247,0.3)' :
                         'background:var(--glass-bg);border:1px solid var(--glass-border);color:var(--text-secondary);opacity:0.8');
            
            const iconSpan = document.createElement('span');
            iconSpan.style.cssText = 'display:flex;align-items:center;' + (isSel ? 'color:#c084fc;' : 'color:var(--text-tertiary);');
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

    openHostManageModal() {
        const isPrivileged = this.conn && (this.conn.isCreator || this.conn.isAdmin);
        const roomCode = this.conn.getRoomCode() || '';
        const phrase = this.crypto.getPhrase() || '';
        const url = this._buildShareUrl(roomCode, phrase);

        document.getElementById('input-new-room-id').value = roomCode;
        const linkInput = document.getElementById('input-modal-room-link');
        if (linkInput) linkInput.value = url;
        document.getElementById('input-rotate-room-key').value = phrase;

        const titleEl = document.getElementById('host-manage-title-text');
        if (titleEl) titleEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="2.5"><path d="M12 2l3 6 6 1-4 4 1 6-6-3-6 3 1-6-4-4 6-1z"/></svg>${isPrivileged ? 'Host Governance Panel' : 'Room Details & Security'}`;

        const inputId = document.getElementById('input-new-room-id');
        const btnSaveId = document.getElementById('btn-save-room-id');
        if (inputId) inputId.readOnly = !isPrivileged;
        if (btnSaveId) btnSaveId.style.display = isPrivileged ? 'inline-block' : 'none';

        const btnGenKey = document.getElementById('btn-gen-rotate-room-key');
        const inputKey = document.getElementById('input-rotate-room-key');
        const btnSaveKey = document.getElementById('btn-rotate-room-key');
        if (btnGenKey) btnGenKey.style.display = isPrivileged ? 'inline-flex' : 'none';
        if (inputKey) inputKey.readOnly = !isPrivileged;
        if (btnSaveKey) btnSaveKey.style.display = isPrivileged ? 'inline-block' : 'none';

        const deleteBox = document.getElementById('box-delete-room');
        if (deleteBox) deleteBox.style.display = isPrivileged ? 'flex' : 'none';

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
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.05)';
            const left = document.createElement('div');
            left.style.cssText = 'display:flex;align-items:center;gap:8px';
            left.innerHTML = `<span style="font-weight:600;font-size:0.85rem">${p.deviceName || 'Device'} ${p.id === myId ? '(You)' : ''}</span>${p.isCreator ? '<span style="font-size:0.7rem;padding:2px 6px;background:rgba(108,92,231,0.2);color:var(--accent-primary);border-radius:10px">Host</span>' : (p.isAdmin ? '<span style="font-size:0.7rem;padding:2px 6px;background:rgba(234,88,12,0.2);color:#ea580c;border-radius:10px;font-weight:600">Admin</span>' : '')}`;
            row.appendChild(left);

            if (p.id !== myId && !p.isCreator) {
                const btns = document.createElement('div');
                btns.style.cssText = 'display:flex;gap:6px';
                if (!p.isAdmin) {
                    const btnPromote = document.createElement('button');
                    btnPromote.className = 'btn btn-secondary';
                    btnPromote.style.cssText = 'padding:4px 8px;font-size:0.7rem;height:auto';
                    btnPromote.textContent = 'Promote Admin';
                    btnPromote.onclick = () => {
                        p.isAdmin = true;
                        this.conn._broadcast({ type: 'promote-admin', payload: { targetId: p.id } });
                        this.conn._broadcast({ type: 'peer-update', payload: this.conn.getPeers() });
                        UI.toast(`Promoted ${p.deviceName} to Admin`, 'success');
                        this.refreshPeerLists();
                    };
                    btns.appendChild(btnPromote);
                }
                const btnKick = document.createElement('button');
                btnKick.className = 'btn btn-danger';
                btnKick.style.cssText = 'padding:4px 8px;font-size:0.7rem;height:auto';
                btnKick.textContent = 'Remove';
                btnKick.onclick = () => {
                    this.conn._broadcast({ type: 'kick-peer', payload: { targetId: p.id } });
                    this.conn.peers = (this.conn.peers || []).filter(x => x.id !== p.id);
                    if (this.conn.connections && this.conn.connections.has(p.id)) {
                        try { this.conn.connections.get(p.id).close(); } catch(e){}
                        this.conn.connections.delete(p.id);
                    }
                    this.conn._broadcast({ type: 'peer-update', payload: this.conn.getPeers() });
                    this.refreshPeerLists();
                    UI.toast(`Removed ${p.deviceName}`, 'success');
                };
                btns.appendChild(btnKick);
                row.appendChild(btns);
            }
            listEl.appendChild(row);
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
        } catch {}
        this.renderInlineQr(targetUrl);
        UI.toast('Room ID changed to: ' + newCode, 'success');
    }

    _onRoomKeyRotated(newKey) {
        this.crypto.importKey(newKey);
        document.getElementById('display-secret-phrase').textContent = newKey;
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
                    s.passphrase = newKey;
                    sessionStorage.setItem('whynotshare_active_session', JSON.stringify(s));
                }
            } catch {}
            this.renderInlineQr(targetUrl);
        }
        UI.toast('Room Key was rotated by Host!', 'success');
    }

    async changePassphrase(phrase) {
        if (!phrase || !phrase.trim()) { UI.toast('Passphrase cannot be empty', 'error'); return; }
        const cleanKey = phrase.trim();
        await this.crypto.importKey(cleanKey);
        if (this.conn.isCreator || this.conn.isAdmin) {
            this.conn._broadcast({ type: 'room-key-rotated', payload: { newKey: cleanKey } });
            document.getElementById('display-secret-phrase').textContent = cleanKey;
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
                } catch {}
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
        this.togglePersonalE2E(false); // Personal E2E off by default
        this.updatePrivilegeUI();
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

    updatePrivilegeUI() {
        const isPrivileged = this.conn && (this.conn.isCreator || this.conn.isAdmin);
        const hmBtn = document.getElementById('btn-host-manage');
        const hmText = document.getElementById('btn-host-manage-text');
        const passBtn = document.getElementById('btn-edit-passphrase');
        if (hmBtn) hmBtn.style.display = 'inline-flex';
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

        return new QRCodeStyling({
            type: "canvas",
            width: size,
            height: size,
            data: url,
            qrOptions: { errorCorrectionLevel: "H" },
            dotsOptions: { color: dotColor, type: "dots" },
            cornersSquareOptions: { color: cornerColor, type: "extra-rounded" },
            cornersDotOptions: { color: centerDotColor, type: "dot" },
            backgroundOptions: { color: "rgba(0, 0, 0, 0)" },
            imageOptions: { margin: 8, imageSize: 0.35, hideBackgroundDots: true },
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
        } else {
            container.textContent = 'QR Library not loaded';
        }
    }

    renderInlineQr(url) {
        const section = document.getElementById('inline-qr-section');
        if (section) {
            section.style.display = 'flex';
        }
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
        document.addEventListener('keydown', (e) => {
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
            btnHostEnter.addEventListener('click', () => {
                this._enterShareScreen(this.conn.getRoomCode(), this.conn.getPeers());
            });
        }
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
        const btnSaveRoomId = document.getElementById('btn-save-room-id');
        if (btnSaveRoomId) {
            btnSaveRoomId.addEventListener('click', () => {
                const newId = document.getElementById('input-new-room-id').value.trim();
                if (newId) {
                    this.conn._broadcast({ type: 'room-id-changed', payload: { newCode: newId } });
                    this._onRoomIdChanged(newId);
                    document.getElementById('modal-host-manage').style.display = 'none';
                }
            });
        }
        const btnGenRotateKey = document.getElementById('btn-gen-rotate-room-key');
        if (btnGenRotateKey) {
            btnGenRotateKey.addEventListener('click', async () => {
                const phrase = await this.crypto.generateKey();
                const inputEl = document.getElementById('input-rotate-room-key');
                if (inputEl) inputEl.value = phrase;
            });
        }
        const btnRotateKey = document.getElementById('btn-rotate-room-key');
        if (btnRotateKey) {
            btnRotateKey.addEventListener('click', () => {
                const newKey = document.getElementById('input-rotate-room-key').value.trim();
                if (newKey) {
                    this.conn._broadcast({ type: 'room-key-rotated', payload: { newKey: newKey } });
                    this._onRoomKeyRotated(newKey);
                    document.getElementById('modal-host-manage').style.display = 'none';
                }
            });
        }
        const btnDeleteRoom = document.getElementById('btn-host-delete-room');
        if (btnDeleteRoom) {
            btnDeleteRoom.addEventListener('click', () => {
                if (confirm('Are you sure you want to delete this room and disconnect all members?')) {
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

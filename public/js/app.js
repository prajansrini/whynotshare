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
        this.conn.onAuditLogSync = () => { if (typeof this.renderAuditLogs === 'function') this.renderAuditLogs(); };
        this.conn.onSyncRequest = () => {
            if (!this.textShare || !Array.isArray(this.textShare.messages)) return [];
            return this.textShare.messages.map(m => {
                const copy = { ...m };
                if (copy.type === 'file') copy.url = null;
                if (copy.sender && (copy.sender.name === 'You' || copy.isSent || copy.sender.id === this.conn.myPeerId)) {
                    copy.sender = { ...copy.sender, id: copy.sender.id || this.conn.myPeerId, name: this.conn.deviceName || 'Host' };
                }
                return copy;
            });
        };
        this.conn.onHistoryReceived = (history) => { if (this.textShare) this.textShare.syncHistory(history); };
        this.conn.onFileHistoryRequest = () => {
            const list = Array.from(this.fileTransfer.sharedFilesHistory.values());
            if (this.textShare && Array.isArray(this.textShare.messages)) {
                this.textShare.messages.forEach(m => {
                    if (m.type === 'file' && m.meta && m.meta.fileId && !this.fileTransfer.sharedFilesHistory.has(m.meta.fileId)) {
                        const item = { meta: m.meta, senderId: (m.sender ? m.sender.id : null) || this.conn.myPeerId, timestamp: m.timestamp };
                        this.fileTransfer.sharedFilesHistory.set(m.meta.fileId, item);
                        list.push(item);
                    }
                });
            }
            return list;
        };
        this.conn.onFileHistoryReceived = async (fileHistoryList) => {
            if (!Array.isArray(fileHistoryList)) return;
            const container = document.getElementById('received-files');
            if (!container) return;
            for (const item of fileHistoryList) {
                if (!item || !item.meta || !item.meta.fileId || item.meta.cancelled) continue;
                if (item.meta.recipients && Array.isArray(item.meta.recipients) && item.meta.recipients.length > 0 && !item.meta.recipients.includes(this.conn.myPeerId)) continue;
                this.fileTransfer.sharedFilesHistory.set(item.meta.fileId, item);
                const blob = await this.fileTransfer.loadFromIndexedDB(item.meta.fileId);
                const url = blob ? URL.createObjectURL(blob) : null;
                if (!document.getElementById('history-card-' + item.meta.fileId)) {
                    const card = UI.renderHistoryFileCard(item.meta, url, item.senderId);
                    container.appendChild(card);
                }
                if (this.textShare && Array.isArray(this.textShare.messages)) {
                    const existingMsg = this.textShare.messages.find(m => (m.meta && m.meta.fileId === item.meta.fileId) || m.id === item.meta.fileId);
                    if (!existingMsg) {
                        const peer = this.conn.getPeers().find(p => p.id === item.senderId);
                        const senderName = peer ? peer.deviceName : 'Peer';
                        const senderColor = this.textShare._getPeerColor(item.senderId || 'unknown');
                        this.textShare.addFileMessage(item.meta.fileId, item.meta, url, item.senderId === this.conn.getSocketId(), { name: senderName, id: item.senderId, color: senderColor }, item.timestamp || Date.now());
                        if (!blob && this.conn.connections && this.conn.connections.size > 0) {
                            this.conn.sendFileEvent('request-history-file', { fileId: item.meta.fileId, targetId: this.conn.myPeerId });
                        }
                    } else if (!existingMsg.url) {
                        if (blob) {
                            existingMsg.url = url;
                            if (typeof this.textShare.updateSingleMessageUI === 'function') {
                                if (!this.textShare.updateSingleMessageUI(existingMsg)) {
                                    this.textShare._renderAllMessages();
                                }
                            } else {
                                this.textShare._renderAllMessages();
                            }
                        } else if (this.conn.connections && this.conn.connections.size > 0) {
                            this.conn.sendFileEvent('request-history-file', { fileId: item.meta.fileId, targetId: this.conn.myPeerId });
                        }
                    }
                }
            }
        };

        this.fileTransfer.onProgress = (fid, prog, speed, dir, meta) => {
            if (meta && meta.historyTransfer) return;
            UI.updateTransferProgress(fid, prog, speed);
        };

        this.fileTransfer.onIncomingFile = (fid, meta) => {
            if (meta && meta.historyTransfer) return;
            const peer = this.conn.getPeers().find(p => p.id === meta.senderId);
            const senderName = peer ? peer.deviceName : 'Peer';
            const senderColor = this.textShare ? this.textShare._getPeerColor(meta.senderId || 'unknown') : 'var(--text-secondary)';
            if (this.textShare && Array.isArray(this.textShare.messages)) {
                const existingMsg = this.textShare.messages.find(m => (m.meta && m.meta.fileId === fid) || m.id === fid);
                if (!existingMsg) {
                    this.textShare.addFileMessage(fid, meta, null, false, { name: senderName, id: meta.senderId, color: senderColor }, meta.timestamp || Date.now());
                }
            }
        };

        this.fileTransfer.onFileReceived = (fid, meta, blob, senderId) => {
            if (this._fetchTimeouts && this._fetchTimeouts.has(fid)) {
                clearTimeout(this._fetchTimeouts.get(fid));
                this._fetchTimeouts.delete(fid);
            }
            const tc = document.getElementById('transfer-' + fid);
            if (tc) tc.remove();
            const oldCard = document.getElementById('history-card-' + fid);
            if (oldCard) {
                const newCard = UI.renderReceivedFile(fid, meta, blob);
                oldCard.replaceWith(newCard);
            } else {
                const card = UI.renderReceivedFile(fid, meta, blob);
                document.getElementById('received-files').prepend(card);
            }

            const peer = this.conn.getPeers().find(p => p.id === senderId);
            const senderName = peer ? peer.deviceName : 'Peer';
            const senderColor = this.textShare ? this.textShare._getPeerColor(senderId || 'unknown') : 'var(--text-secondary)';
            const url = URL.createObjectURL(blob);
            if (this.textShare) {
                const existingMsg = (this.textShare.messages || []).find(m => (m.meta && m.meta.fileId === fid) || m.id === fid);
                if (existingMsg) {
                    existingMsg.url = url;
                    if (typeof this.textShare.updateSingleMessageUI === 'function') {
                        if (!this.textShare.updateSingleMessageUI(existingMsg)) {
                            this.textShare._renderAllMessages();
                        }
                    } else {
                        this.textShare._renderAllMessages();
                    }
                } else {
                    this.textShare.addFileMessage(fid, meta, url, false, { name: senderName, id: senderId, color: senderColor }, meta.timestamp || Date.now());
                }
            }
        };

        this.onFileHistoryMissing = (fileId) => {
            this._resetFetchButton(fileId, 'File not available from connected peers');
        };

        this._bindEvents();
        this.lockPortraitIfPossible();
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

        window.addEventListener('beforeunload', () => {
            if (this.conn && this.conn.getRoomCode()) {
                this.conn.leaveRoom(true);
            }
        });
        window.addEventListener('pagehide', () => {
            if (this.conn && this.conn.getRoomCode()) {
                this.conn.leaveRoom(true);
            }
        });
    }

    async createRoom() {
        const btn = document.getElementById('btn-create');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span style="display:inline-flex;align-items:center;justify-content:center;overflow:hidden;position:relative;width:100%"><span style="display:inline-flex;align-items:center;animation:slideInLeftSvg 0.35s cubic-bezier(0.16,1,0.3,1) forwards"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 13 32 6" fill="#ffffff" preserveAspectRatio="none" style="width:34px;height:16px;margin-right:8px;display:inline-block;vertical-align:middle"><path opacity="0.8" transform="translate(0 0)" d="M2 14 V18 H6 V14z"><animateTransform attributeName="transform" type="translate" values="0 0; 24 0; 0 0" dur="2s" begin="0" repeatCount="indefinite" keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8" calcMode="spline"/></path><path opacity="0.5" transform="translate(0 0)" d="M0 14 V18 H8 V14z"><animateTransform attributeName="transform" type="translate" values="0 0; 24 0; 0 0" dur="2s" begin="0.1s" repeatCount="indefinite" keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8" calcMode="spline"/></path><path opacity="0.25" transform="translate(0 0)" d="M0 14 V18 H8 V14z"><animateTransform attributeName="transform" type="translate" values="0 0; 24 0; 0 0" dur="2s" begin="0.2s" repeatCount="indefinite" keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8" calcMode="spline"/></path></svg></span><span style="display:inline-flex;align-items:center"><span style="animation:slideShiftLeftText 0.35s cubic-bezier(0.16,1,0.3,1) forwards">Creat</span><span style="display:inline-flex;position:relative;overflow:hidden"><span style="animation:morphIngIn 0.35s cubic-bezier(0.16,1,0.3,1) forwards">ing</span></span><span>&nbsp;Room</span><span style="animation:slideInRightDots 0.35s cubic-bezier(0.16,1,0.3,1) forwards">...</span></span></span>';
        }
        try {
            this._hasEnteredLiveRoom = false;
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
            const targetUrl = this.e2eEnabled ? this._buildShareUrl(code, phrase) : (window.location.origin + this._getBasePath() + '#' + code);
            const targetHash = this.e2eEnabled ? ('#' + code + ':' + phrase) : ('#' + code);
            document.getElementById('share-url').dataset.url = targetUrl;
            window.history.pushState({ screenId: 'screen-room' }, '', '#create-room');
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
        this.renderAuditLogs();
        this.textShare.clear();
        this.crypto = new CryptoManager();
        this.textShare = new TextShare(this.conn, this.crypto);
        this.fileTransfer = new FileTransfer(this.conn, this.crypto);
        this.conn.onTextReceived = (d) => this.textShare.receive(d);
        this.conn.onFileEvent = (t, d) => this.fileTransfer.handleFileEvent(t, d);
        this.fileTransfer.onProgress = this.fileTransfer.onIncomingFile = this.fileTransfer.onFileReceived = null;
        UI.showScreen('screen-landing', pushToHistory);
        if (pushToHistory) {
            window.history.replaceState({ screenId: 'screen-landing' }, '', this._getBasePath());
        }
        const btnC = document.getElementById('btn-create');
        if (btnC) { btnC.disabled = false; btnC.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Create Room'; }
        const btnJ = document.getElementById('btn-join-submit');
        if (btnJ) { btnJ.disabled = false; btnJ.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 20 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>Connect'; }
        this.init(); // re-init callbacks
    }

    async downloadAllFilesAsZip() {
        if (!window.JSZip) {
            UI.toast('ZIP library is still loading or not available.', 'error');
            return;
        }
        const btn = document.getElementById('btn-download-all');
        if (btn && btn.disabled) return;
        
        const origHtml = btn ? btn.innerHTML : null;
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:rotateSpinner 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>Preparing...</span></span>';
        }

        try {
            const zip = new JSZip();
            const addedNames = new Map();
            let fileCount = 0;

            const candidates = new Map();
            
            if (this.fileTransfer && this.fileTransfer.sharedFilesHistory) {
                for (const [fid, item] of this.fileTransfer.sharedFilesHistory.entries()) {
                    if (item && item.meta && item.meta.fileName && !item.meta.cancelled) {
                        candidates.set(fid, {
                            fileName: item.meta.fileName,
                            getBlob: () => this.fileTransfer.loadFromIndexedDB(fid)
                        });
                    }
                }
            }

            if (this.textShare && Array.isArray(this.textShare.messages)) {
                for (const msg of this.textShare.messages) {
                    if (msg && msg.meta && (msg.meta.fileName || msg.meta.fileId) && !msg.meta.cancelled) {
                        const fid = msg.meta.fileId || msg.id;
                        const fName = msg.meta.fileName || 'file_' + fid;
                        if (!candidates.has(fid)) {
                            candidates.set(fid, {
                                fileName: fName,
                                getBlob: async () => {
                                    let b = await this.fileTransfer.loadFromIndexedDB(fid);
                                    if (!b && msg.url && msg.url.startsWith('blob:')) {
                                        try { b = await fetch(msg.url).then(r => r.blob()); } catch {}
                                    }
                                    return b;
                                }
                            });
                        }
                    }
                }
            }

            for (const [fid, cand] of candidates.entries()) {
                const blob = await cand.getBlob();
                if (blob && blob instanceof Blob) {
                    let name = cand.fileName || `file_${fid}`;
                    if (addedNames.has(name)) {
                        const count = addedNames.get(name) + 1;
                        addedNames.set(name, count);
                        const dotIdx = name.lastIndexOf('.');
                        if (dotIdx !== -1) {
                            name = name.substring(0, dotIdx) + ` (${count})` + name.substring(dotIdx);
                        } else {
                            name = name + ` (${count})`;
                        }
                    } else {
                        addedNames.set(name, 1);
                    }
                    zip.file(name, blob);
                    fileCount++;
                }
            }

            if (fileCount === 0) {
                UI.toast('No downloadable files found in chat history to zip.', 'info');
                if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
                return;
            }

            if (btn) btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px"><span>Packaging (0%)...</span></span>';
            const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 5 } }, (metadata) => {
                if (btn) {
                    btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:rotateSpinner 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>Packaging (${Math.round(metadata.percent)}%)...</span></span>`;
                }
            });

            const roomCode = this.conn ? this.conn.getRoomCode() : 'room';
            const dateStr = new Date().toISOString().slice(0, 10);
            const zipName = `whynotshare_${roomCode || 'files'}_${dateStr}.zip`;
            const a = document.createElement('a');
            const url = URL.createObjectURL(content);
            a.href = url;
            a.download = zipName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 5000);

            UI.toast(`Downloaded ${fileCount} file(s) as ${zipName}`, 'success');
        } catch (err) {
            console.error('ZIP creation failed:', err);
            UI.toast('Failed to generate ZIP archive.', 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origHtml;
            }
        }
    }

    async handleDataTransferItems(dataTransfer) {
        if (!dataTransfer) return;
        const items = dataTransfer.items;
        const fallbackFiles = dataTransfer.files;

        if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
            const files = [];
            for (let i = 0; i < items.length; i++) {
                const entry = items[i].webkitGetAsEntry();
                if (entry && entry.isFile) {
                    const f = await new Promise(res => entry.file(res, () => res(null)));
                    if (f) files.push(f);
                }
            }
            if (files.length > 0) {
                this.stageFiles(files);
            }
            return;
        }

        if (fallbackFiles && fallbackFiles.length > 0) {
            this.stageFiles(fallbackFiles);
        }
    }

    stageFiles(fileList) {
        if (!fileList || !fileList.length) return;
        if (!this.stagedFiles) this.stagedFiles = [];
        for (const file of fileList) {
            if (file && file.size === 0 && (!file.type || file.type === '') && (!file.name || !file.name.includes('.'))) {
                continue;
            }
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
            if (input) {
                input.value = '';
                UI.autoResize(input);
            }
            await this.textShare.send(text);
            if (input) {
                input.focus();
            }
            if (this.resetViewportScroll) {
                this.resetViewportScroll();
            }
        }
        if (this.stagedFiles && this.stagedFiles.length > 0) {
            const filesToSend = [...this.stagedFiles];
            this.stagedFiles = [];
            this.updateStagedFilesUI();
            await this.sendFiles(filesToSend);
            if (this.resetViewportScroll) {
                this.resetViewportScroll();
            }
        }
    }

    async sendFiles(files) {
        for (const file of files) {
            const fileId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
            const res = await this.fileTransfer.sendFile(file, fileId);
            const tc = document.querySelector('[id^="transfer-"]');
            setTimeout(() => {
                document.querySelectorAll('.transfer-card').forEach(c => {
                    const fill = c.querySelector('.transfer-bar-fill');
                    if (fill && fill.style.width === '100%') c.remove();
                });
            }, 2000);
            if (res && res.cancelled) continue;
            const card = UI.renderSentFile(file);
            const rcv = document.getElementById('received-files');
            if (rcv) rcv.prepend(card);

            const url = URL.createObjectURL(file);
            const meta = { fileId, fileName: file.name, fileSize: file.size, fileType: file.type };
            if (this.textShare) {
                this.textShare.addFileMessage(fileId, meta, url, true, { name: 'You', id: this.conn.getSocketId() }, Date.now());
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
        if (this.e2eEnabled !== enabled && this.conn && this.conn.isCreator && this.conn.addAuditLog && this.conn.roomCode && this._hasEnteredLiveRoom) {
            this.conn.addAuditLog(enabled ? 'Room E2E Encryption active' : 'Room is made Open', 'sec');
        }
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
                    if (window.location.hash.startsWith('#' + code)) window.history.replaceState(null, '', this._getBasePath() + '#' + code + ':' + phrase);
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

        // Sync Host Governance Panel UI
        const isOpenRoom = !enabled;
        const toggle = document.getElementById('toggle-open-room');
        if (toggle) toggle.checked = isOpenRoom;
        const barKeyMode = document.getElementById('bar-room-key-mode');
        if (barKeyMode) barKeyMode.classList.toggle('plaintext-mode', isOpenRoom);
        const btnKeyReq = document.getElementById('btn-room-key-required');
        if (btnKeyReq) btnKeyReq.classList.toggle('active', !isOpenRoom);
        const btnKeyOpen = document.getElementById('btn-room-key-open');
        if (btnKeyOpen) btnKeyOpen.classList.toggle('active-plaintext', isOpenRoom);

        const inputKeyEl = document.getElementById('input-rotate-room-key');
        if (inputKeyEl) {
            if (isOpenRoom) {
                inputKeyEl.value = '';
                inputKeyEl.placeholder = 'Open Room (No Encryption)';
                inputKeyEl.disabled = true;
                inputKeyEl.style.opacity = '0.4';
                inputKeyEl.style.backgroundColor = 'rgba(0, 0, 0, 0.15)';
            } else {
                inputKeyEl.value = this.crypto ? (this.crypto.getPhrase() || '') : '';
                inputKeyEl.placeholder = 'Room Key';
                inputKeyEl.disabled = false;
                inputKeyEl.readOnly = false;
                inputKeyEl.style.opacity = '1';
                inputKeyEl.style.backgroundColor = '';
            }
        }
        const passModalInput = document.getElementById('input-new-passphrase');
        if (passModalInput) passModalInput.value = this.crypto ? (this.crypto.getPhrase() || '') : '';
        const btnGenKey = document.getElementById('btn-gen-rotate-room-key');
        if (btnGenKey) btnGenKey.style.display = isOpenRoom ? 'none' : 'flex';

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
                urlEl.dataset.url = enabled && phrase ? this._buildShareUrl(code, phrase) : (window.location.origin + this._getBasePath() + '#' + code);
            }
            if (window.location.hash && window.location.hash.slice(1).startsWith(code)) {
                window.history.replaceState(null, '', this._getBasePath() + (enabled && phrase ? '#' + code + ':' + phrase : '#' + code));
            }
            const sr = document.getElementById('screen-room');
            if (sr && sr.classList.contains('active')) {
                const urlEl = document.getElementById('share-url');
                this.renderInlineQr(urlEl ? urlEl.dataset.url : null);
            }
        }
    }

    /* --- Personal E2E & Host Governance Methods --- */
    updatePersonalE2EPill() {
        const pe2ePill = document.getElementById('pe2e-status-pill');
        if (!pe2ePill) return;
        if (!this.personalE2E) {
            pe2ePill.textContent = 'OFF';
            pe2ePill.style.color = 'var(--text-tertiary)';
            return;
        }
        pe2ePill.textContent = 'ALL';
        pe2ePill.style.color = 'var(--accent-primary)';
    }

    togglePersonalE2E(enabled = true) {
        this.personalE2E = enabled;
        const container = document.getElementById('personal-recipients-container');
        if (container) {
            container.style.display = enabled ? 'flex' : 'none';
        }
        this.updatePersonalE2EPill();
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
                if (this.crypto.myPersonalKeyStr) {
                    this.conn.sendDirect(p.id, { type: 'share-personal-key', payload: { keyStr: this.crypto.myPersonalKeyStr, targetId: p.id } });
                }
            }
            this.selectedPersonalRecipients.add(p.id);
            const chip = document.createElement('div');
            chip.className = 'recipient-chip selected';
            chip.style.cursor = 'default';
            chip.title = 'All room messages and files are End-to-End Encrypted';

            const iconSpan = document.createElement('span');
            iconSpan.className = 'chip-icon';
            iconSpan.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
            chip.appendChild(iconSpan);

            const nameSpan = document.createElement('span');
            nameSpan.textContent = p.deviceName || 'Unknown Device';
            chip.appendChild(nameSpan);

            listEl.appendChild(chip);
        });
        if (count === 0) {
            listEl.innerHTML = '<div style="padding:16px;text-align:center;font-size:0.85rem;color:var(--text-secondary);background:rgba(255,255,255,0.03);border-radius:10px;border:1px dashed var(--glass-border)">No other members connected yet. When members join, they will automatically be included in Always-On E2E encryption.</div>';
        }
        this.updatePersonalE2EPill();
    }

    _triggerAutoSaveHostSettings(closeModal = false) {
        if (!this.conn || !this.conn.isCreator) return;
        // Room ID change feature has been disabled by user request
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
        if (saveBtn) {
            saveBtn.innerHTML = '<span style="display:inline-flex;align-items:center;justify-content:center;overflow:hidden;position:relative;width:100%"><span style="display:inline-flex;align-items:center;animation:slideInLeftSvg 0.35s cubic-bezier(0.16,1,0.3,1) forwards"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 13 32 6" fill="#ffffff" preserveAspectRatio="none" style="width:34px;height:16px;margin-right:8px;display:inline-block;vertical-align:middle"><path opacity="0.8" transform="translate(0 0)" d="M2 14 V18 H6 V14z"><animateTransform attributeName="transform" type="translate" values="0 0; 24 0; 0 0" dur="2s" begin="0" repeatCount="indefinite" keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8" calcMode="spline"/></path><path opacity="0.5" transform="translate(0 0)" d="M0 14 V18 H8 V14z"><animateTransform attributeName="transform" type="translate" values="0 0; 24 0; 0 0" dur="2s" begin="0.1s" repeatCount="indefinite" keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8" calcMode="spline"/></path><path opacity="0.25" transform="translate(0 0)" d="M0 14 V18 H8 V14z"><animateTransform attributeName="transform" type="translate" values="0 0; 24 0; 0 0" dur="2s" begin="0.2s" repeatCount="indefinite" keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8" calcMode="spline"/></path></svg></span><span style="display:inline-flex;align-items:center"><span style="animation:slideShiftLeftText 0.35s cubic-bezier(0.16,1,0.3,1) forwards">Sav</span><span style="display:inline-flex;position:relative;overflow:hidden"><span style="animation:morphIngIn 0.35s cubic-bezier(0.16,1,0.3,1) forwards">ing</span></span><span style="animation:slideInRightDots 0.35s cubic-bezier(0.16,1,0.3,1) forwards">...</span></span></span>';
            clearTimeout(this._saveAnimTimeout);
            clearTimeout(this._saveResetTimeout);
            this._saveAnimTimeout = setTimeout(() => {
                saveBtn.innerHTML = '<span>Saved</span>';
                if (closeModal) {
                    this._initialHostManageState = {
                        roomCode: this.conn.getRoomCode() || '',
                        e2eEnabled: this.e2eEnabled,
                        phrase: this.crypto.getPhrase() || ''
                    };
                    this._saveResetTimeout = setTimeout(() => {
                        const modal = document.getElementById('modal-host-manage');
                        if (modal) modal.style.display = 'none';
                        saveBtn.innerHTML = '<span id="txt-save-btn">Saved</span>';
                    }, 350);
                } else {
                    this._saveResetTimeout = setTimeout(() => {
                        saveBtn.innerHTML = '<span id="txt-save-btn">Saved</span>';
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

        this.updateRoomLockUI(Boolean(this.conn && this.conn.isRoomLocked));
        const barLockMode = document.getElementById('bar-room-lock-mode');
        if (barLockMode) {
            barLockMode.style.opacity = isPrivileged ? '1' : '0.55';
            barLockMode.style.pointerEvents = isPrivileged ? 'auto' : 'none';
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

        const hostDangerZone = document.getElementById('host-danger-zone-container');
        if (hostDangerZone) hostDangerZone.style.display = isCreator ? 'flex' : 'none';

        const removeNonAdminsBtn = document.getElementById('btn-host-remove-non-admins');
        if (removeNonAdminsBtn) {
            removeNonAdminsBtn.style.display = isCreator ? 'flex' : 'none';
            removeNonAdminsBtn.dataset.confirming = 'false';
            removeNonAdminsBtn.style.background = 'rgba(239, 68, 68, 0.12)';
            removeNonAdminsBtn.style.borderColor = 'rgba(239, 68, 68, 0.35)';
            const mainTxt = document.getElementById('txt-remove-non-admins-main');
            const subTxt = document.getElementById('txt-remove-non-admins-sub');
            if (mainTxt) mainTxt.textContent = 'Remove Non-Admin Members';
            if (subTxt) subTxt.textContent = 'Disconnect all regular members from room';
        }

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

        const batchToolbar = document.getElementById('host-batch-actions-toolbar');
        if (batchToolbar) batchToolbar.style.display = isCreator ? 'flex' : 'none';

        this.renderAuditLogs();
        this.renderHostMembersList();
        document.getElementById('modal-host-manage').style.display = 'flex';
    }

    toggleRoomLock(isLocked) {
        if (!this.conn || (!this.conn.isCreator && !this.conn.isAdmin)) {
            UI.toast('Only the Host or Admin can lock/unlock the room entry.', 'warning');
            return;
        }
        this.conn.isRoomLocked = Boolean(isLocked);
        this.updateRoomLockUI(this.conn.isRoomLocked);
        if (this.conn.addAuditLog) {
            this.conn.addAuditLog(this.conn.isRoomLocked ? 'Room entry locked by Host' : 'Room entry unlocked by Host', 'sec');
        }
        this.conn._broadcast({ type: 'room-lock-changed', payload: { isLocked: this.conn.isRoomLocked } });
        UI.toast(this.conn.isRoomLocked ? 'Room entry is now locked. No new members can join.' : 'Room entry unlocked. New members can now join.', 'info');
        if (window.textShare && typeof window.textShare.addSystemMessage === 'function') {
            window.textShare.addSystemMessage(this.conn.isRoomLocked ? 'Room entry is now locked. No new members can join.' : 'Room entry unlocked. New members can now join.', 'info');
        }
    }

    updateRoomLockUI(isLocked) {
        const btnLockOff = document.getElementById('btn-room-lock-off');
        const btnLockOn = document.getElementById('btn-room-lock-on');
        if (btnLockOff) btnLockOff.classList.toggle('active', !isLocked);
        if (btnLockOn) btnLockOn.classList.toggle('active', isLocked);
        const barLockMode = document.getElementById('bar-room-lock-mode');
        if (barLockMode) barLockMode.classList.toggle('locked-mode', isLocked);
    }

    renderHostMembersList() {
        const listEl = document.getElementById('host-members-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        let peers = this.conn.getPeers() || [];
        const countEl = document.getElementById('txt-member-count');
        if (countEl) countEl.textContent = String(peers.length);

        if (this._memberFilterQuery && this._memberFilterQuery.trim()) {
            const q = this._memberFilterQuery.trim().toLowerCase();
            peers = peers.filter(p => {
                const name = (p.deviceName || '').toLowerCase();
                const sys = (p.systemName || '').toLowerCase();
                const id = (p.id || '').toLowerCase();
                return name.includes(q) || sys.includes(q) || id.includes(q);
            });
        }

        if (peers.length === 0) {
            listEl.innerHTML = `<div style="padding:16px;text-align:center;font-size:0.8rem;color:var(--text-tertiary)">${this._memberFilterQuery ? 'No matching members found.' : 'No members found.'}</div>`;
            return;
        }

        const myId = this.conn.getSocketId();
        peers.forEach(p => {
            const card = document.createElement('div');
            card.className = 'member-card-item';

            const header = document.createElement('div');
            const isMePrivileged = this.conn && (this.conn.isCreator || this.conn.isAdmin);
            const isSelfAdmin = p.id === myId && p.isAdmin && !p.isCreator;
            const canManage = (isMePrivileged && p.id !== myId && !p.isCreator) || isSelfAdmin;

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
                        ${p.id === myId ? '<span class="badge-theme-accent">You</span>' : ''}
                    </span>
                    <span style="font-size:0.74rem;color:var(--text-tertiary)">${p.systemName || 'Web Client'}</span>
                </div>
            `;

            const right = document.createElement('div');
            right.style.cssText = 'display:flex;align-items:center;gap:8px';

            let badgeHtml = '';
            if (p.isCreator) {
                badgeHtml = '<span class="badge-theme-accent">Host</span>';
            } else if (p.isAdmin) {
                badgeHtml = '<span style="font-size:0.72rem;padding:3px 9px;background:rgba(234,88,12,0.22);color:#fb923c;border-radius:12px;font-weight:700">Admin</span>';
            } else {
                badgeHtml = '<span class="badge-theme-member">Member</span>';
            }

            right.innerHTML = badgeHtml + (canManage ? '<svg class="member-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transition:transform 0.25s ease;color:var(--text-tertiary)"><polyline points="6 9 12 15 18 9"/></svg>' : '');

            header.appendChild(left);
            header.appendChild(right);
            card.appendChild(header);

            if (canManage) {
                const drawer = document.createElement('div');
                drawer.className = 'member-card-drawer';

                if (isSelfAdmin) {
                    const btnDethrone = document.createElement('button');
                    btnDethrone.className = 'btn btn-secondary';
                    btnDethrone.style.cssText = 'padding:6px 12px;font-size:0.75rem;height:auto;border-radius:8px;font-weight:600;background:rgba(234,88,12,0.18);border:1px solid rgba(234,88,12,0.35);color:#fb923c';
                    btnDethrone.textContent = 'Dethrone Admin';
                    btnDethrone.onclick = (e) => {
                        e.stopPropagation();
                        p.isAdmin = false;
                        this.conn.isAdmin = false;
                        this.conn._broadcast({ type: 'demote-admin', payload: { targetId: myId } });
                        this.conn._broadcast({ type: 'peer-update', payload: this.conn.getPeers() });
                        UI.toast('You stepped down from Admin', 'info');
                        if (this.conn.addAuditLog) this.conn.addAuditLog('Stepped down from Admin', 'sec');
                        if (this.updatePrivilegeUI) this.updatePrivilegeUI();
                        this.refreshPeerLists();
                    };
                    drawer.appendChild(btnDethrone);

                    const btnLeaveSelf = document.createElement('button');
                    btnLeaveSelf.className = 'btn btn-danger';
                    btnLeaveSelf.style.cssText = 'padding:6px 14px;font-size:0.75rem;height:auto;border-radius:8px;font-weight:600';
                    btnLeaveSelf.textContent = 'Leave Room';
                    btnLeaveSelf.onclick = (e) => {
                        e.stopPropagation();
                        document.getElementById('modal-host-manage').style.display = 'none';
                        this.leaveRoom();
                    };
                    drawer.appendChild(btnLeaveSelf);
                } else {
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
                            if (this.conn.addAuditLog) this.conn.addAuditLog(`Promoted ${p.deviceName} to Admin`, 'sec');
                            this.refreshPeerLists();
                        };
                        drawer.appendChild(btnPromote);
                    } else if (this.conn && this.conn.isCreator) {
                        const btnDemote = document.createElement('button');
                        btnDemote.className = 'btn btn-secondary';
                        btnDemote.style.cssText = 'padding:6px 12px;font-size:0.75rem;height:auto;border-radius:8px;font-weight:600;background:rgba(234,88,12,0.18);border:1px solid rgba(234,88,12,0.35);color:#fb923c';
                        btnDemote.textContent = 'Demote to Member';
                        btnDemote.onclick = (e) => {
                            e.stopPropagation();
                            p.isAdmin = false;
                            this.conn._broadcast({ type: 'demote-admin', payload: { targetId: p.id } });
                            this.conn._broadcast({ type: 'peer-update', payload: this.conn.getPeers() });
                            UI.toast(`Demoted ${p.deviceName} to Member`, 'info');
                            if (this.conn.addAuditLog) this.conn.addAuditLog(`Demoted ${p.deviceName} to Member`, 'sec');
                            this.refreshPeerLists();
                        };
                        drawer.appendChild(btnDemote);
                    }

                    const btnKick = document.createElement('button');
                    btnKick.className = 'btn btn-danger';
                    btnKick.style.cssText = 'padding:6px 14px;font-size:0.75rem;height:auto;border-radius:8px;font-weight:600';
                    btnKick.textContent = 'Remove';
                    btnKick.onclick = (e) => {
                        e.stopPropagation();
                        if (this.conn && this.conn.markKicked) this.conn.markKicked(p.id);
                        this.conn._broadcast({ type: 'kick-peer', payload: { targetId: p.id } });
                        this.conn.peers = (this.conn.peers || []).filter(x => x.id !== p.id);
                        if (this.conn.connections && this.conn.connections.has(p.id)) {
                            try { this.conn.connections.get(p.id).close(); } catch (err) { }
                            this.conn.connections.delete(p.id);
                        }
                        this.conn._broadcast({ type: 'peer-update', payload: this.conn.getPeers() });
                        this.refreshPeerLists();
                        if (this.conn.addAuditLog) this.conn.addAuditLog(`Removed ${p.deviceName}`, 'sec');
                        UI.toast(`Removed ${p.deviceName}`, 'success');
                    };
                    drawer.appendChild(btnKick);
                }

                let isOpen = false;
                header.addEventListener('click', () => {
                    isOpen = !isOpen;
                    const chev = header.querySelector('.member-chevron');
                    if (isOpen) {
                        drawer.classList.add('open');
                        card.classList.add('drawer-open');
                        if (chev) chev.style.transform = 'rotate(180deg)';
                    } else {
                        drawer.classList.remove('open');
                        card.classList.remove('drawer-open');
                        if (chev) chev.style.transform = 'rotate(0deg)';
                    }
                });

                card.appendChild(drawer);
            }

            listEl.appendChild(card);
        });
    }

    renderAuditLogs() {
        const auditListEl = document.getElementById('host-manage-audit-list');
        if (!auditListEl || !this.conn) return;
        const logs = this.conn.auditLogs || [];
        if (logs.length === 0) {
            auditListEl.innerHTML = '<div style="padding:16px;text-align:center;font-size:0.8rem;color:var(--text-tertiary)">No recent activity recorded yet.</div>';
            return;
        }
        auditListEl.innerHTML = '';
        logs.forEach(entry => {
            const item = document.createElement('div');
            item.className = 'audit-log-item';
            const timeStr = this._formatTimeSeconds24(entry.time);
            let badgeClass = 'audit-badge-info';
            let iconHtml = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
            
            const txt = (entry.text || '').toLowerCase();
            if (txt.includes('created') || txt.includes('open')) {
                badgeClass = 'audit-badge-success';
                iconHtml = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
            } else if (txt.includes('passphrase') || txt.includes('key')) {
                badgeClass = 'audit-badge-sec';
                iconHtml = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
            } else if (txt.includes('active') || txt.includes('promoted') || txt.includes('demoted')) {
                badgeClass = 'audit-badge-sec';
                iconHtml = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
            } else if (txt.includes('removed') || txt.includes('stepped down') || txt.includes('kicked')) {
                badgeClass = 'audit-badge-warn';
                iconHtml = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/></svg>';
            } else if (txt.includes('left the room')) {
                badgeClass = 'audit-badge-warn';
                iconHtml = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
            } else if (txt.includes('joined')) {
                badgeClass = 'audit-badge-info';
                iconHtml = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>';
            } else if (txt.includes('exported')) {
                badgeClass = 'audit-badge-info';
                iconHtml = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
            } else if (entry.category === 'sec') {
                badgeClass = 'audit-badge-sec';
                iconHtml = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
            } else if (entry.category === 'warn') {
                badgeClass = 'audit-badge-warn';
                iconHtml = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
            } else if (entry.category === 'success') {
                badgeClass = 'audit-badge-success';
                iconHtml = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
            }
            item.innerHTML = `
                <div class="audit-log-left ${badgeClass}">
                    ${iconHtml}
                </div>
                <div class="audit-log-content">
                    <span class="audit-log-text">${entry.text}</span>
                    <span class="audit-log-time">${timeStr}</span>
                </div>
            `;
            auditListEl.appendChild(item);
        });
    }

    _formatTimeSeconds24(ts) {
        const d = new Date(ts || Date.now());
        const hours = String(d.getHours()).padStart(2, '0');
        const mins = String(d.getMinutes()).padStart(2, '0');
        const secs = String(d.getSeconds()).padStart(2, '0');
        return `${hours}:${mins}:${secs}`;
    }

    _formatDate24(ts) {
        const d = new Date(ts || Date.now());
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day} ${this._formatTimeSeconds24(ts)}`;
    }

    exportAuditLogsAsTxt() {
        if (!this.conn || !this.conn.auditLogs || this.conn.auditLogs.length === 0) {
            UI.toast('No audit logs to export.', 'info');
            return;
        }
        let txt = `=======================================================\n`;
        txt += `           WHYNOTSHARE ROOM AUDIT & SECURITY LOG       \n`;
        txt += `=======================================================\n`;
        txt += `Room Code : ${this.conn.getRoomCode() || 'Unknown'}\n`;
        txt += `Exported  : ${this._formatDate24(Date.now())}\n`;
        txt += `Total Logs: ${this.conn.auditLogs.length}\n`;
        txt += `=======================================================\n\n`;

        this.conn.auditLogs.forEach((entry) => {
            const dateStr = this._formatDate24(entry.time || Date.now());
            const catStr = (entry.category || 'INFO').toUpperCase();
            txt += `[${dateStr}] [${catStr}] ${entry.text || ''}\n`;
        });

        txt += `\n=======================================================\n`;
        txt += `                 END OF AUDIT LOG ENTRY                \n`;
        txt += `=======================================================\n`;

        const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `whynotshare-audit-log-${this.conn.getRoomCode() || 'room'}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    exportRosterAsTxt() {
        const peers = this.conn ? (this.conn.getPeers() || []) : [];
        if (peers.length === 0) {
            UI.toast('No members in room to export.', 'info');
            return;
        }
        let txt = `=======================================================\n`;
        txt += `               WHYNOTSHARE ROOM ROSTER                 \n`;
        txt += `=======================================================\n`;
        txt += `Room Code : ${this.conn.getRoomCode() || 'Unknown'}\n`;
        txt += `Exported  : ${this._formatDate24(Date.now())}\n`;
        txt += `Total     : ${peers.length} Member(s)\n`;
        txt += `=======================================================\n\n`;

        peers.forEach((p, idx) => {
            const role = p.isCreator ? 'Host' : (p.isAdmin ? 'Admin' : 'Member');
            txt += `${idx + 1}. ${p.deviceName || 'Member Device'} (${p.systemName || 'Web Client'}) [Role: ${role}] [ID: ${p.id}]\n`;
        });

        txt += `\n=======================================================\n`;
        txt += `                 END OF ROSTER ENTRY                   \n`;
        txt += `=======================================================\n`;

        const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `whynotshare-roster-${this.conn.getRoomCode() || 'room'}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.toast('Room roster downloaded as TXT', 'success');
    }

    refreshPeerLists() {
        if (!this.conn) return;
        const peers = this.conn.getPeers() || [];
        const myId = this.conn.getSocketId();
        UI.updateDevicesList(peers, myId);
        this.renderHostMembersList();
        this.renderPersonalRecipients();
        if (typeof this.updatePersonalE2EPill === 'function') this.updatePersonalE2EPill();
        if (typeof this.renderAuditLogs === 'function') this.renderAuditLogs();
    }

    _onRoomIdChanged(newCode) {
        this.conn.roomCode = newCode;
        document.getElementById('share-room-code').textContent = newCode;
        document.getElementById('display-room-code').textContent = newCode;
        const phrase = this.crypto.getPhrase() || '';
        const targetUrl = this.e2eEnabled ? this._buildShareUrl(newCode, phrase) : (window.location.origin + this._getBasePath() + '#' + newCode);
        const targetHash = this.e2eEnabled ? ('#' + newCode + ':' + phrase) : ('#' + newCode);
        const urlEl = document.getElementById('share-url');
        if (urlEl) {
            urlEl.dataset.url = targetUrl;
            if (urlEl.tagName === 'INPUT') urlEl.value = targetUrl;
        }
        const modalUrlEl = document.getElementById('input-modal-room-link');
        if (modalUrlEl) {
            modalUrlEl.value = targetUrl;
        }
        if (window.location.hash && window.location.hash.slice(1).startsWith(this.conn.getRoomCode() || '')) {
            window.history.replaceState(null, '', this._getBasePath() + targetHash);
        }
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
        if (this.conn && this.conn.isCreator && this.conn.addAuditLog && this._hasEnteredLiveRoom) {
            if (isEnc) this.conn.addAuditLog('Room security passphrase rotated', 'sec');
            else this.conn.addAuditLog('Room is made Open', 'sec');
        }
        await this.crypto.importKey(newKey || '');
        this.toggleE2E(isEnc);
        this.updatePhraseUI(newKey, !isEnc);
        const code = this.conn.getRoomCode();
        if (code) {
            const targetUrl = this.e2eEnabled ? this._buildShareUrl(code, newKey) : (window.location.origin + this._getBasePath() + '#' + code);
            const targetHash = this.e2eEnabled ? ('#' + code + ':' + newKey) : ('#' + code);
            const urlEl = document.getElementById('share-url');
            if (urlEl) urlEl.dataset.url = targetUrl;
            if (this._hasEnteredLiveRoom) {
                window.history.replaceState(null, '', this._getBasePath() + targetHash);
            }
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
                const targetUrl = this.e2eEnabled ? this._buildShareUrl(code, cleanKey) : (window.location.origin + this._getBasePath() + '#' + code);
                const targetHash = this.e2eEnabled ? ('#' + code + ':' + cleanKey) : ('#' + code);
                const urlEl = document.getElementById('share-url');
                if (urlEl) urlEl.dataset.url = targetUrl;
                if (window.location.hash && window.location.hash.slice(1).startsWith(code)) {
                    window.history.replaceState(null, '', this._getBasePath() + targetHash);
                }
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
        if (this.conn && this.conn.isCreator && !this._hasEnteredLiveRoom) {
            this._hasEnteredLiveRoom = true;
            if (this.conn.addAuditLog) {
                this.conn.addAuditLog(this.e2eEnabled ? 'Room E2E Encryption active' : 'Room is made Open', 'sec');
                const hostDevName = (this.conn.myInfo && this.conn.myInfo.deviceName) ? this.conn.myInfo.deviceName : 'Host';
                this.conn.addAuditLog(`${hostDevName} joined the room`, 'info');
            }
        } else {
            this._hasEnteredLiveRoom = true;
        }
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
        try { window.history.replaceState(null, '', this._getBasePath() + targetHash); } catch { }
        UI.showScreen('screen-share');
        setTimeout(() => { const i = document.getElementById('text-input'); if (i) i.focus(); }, 300);
    }

    _getBasePath() {
        let p = window.location.pathname.replace(/\/(create-room|join-room)\/?$/, '');
        if (!p.endsWith('/')) p += '/';
        return p;
    }

    _onPeerJoined(peer) {
        if (this.conn && peer && peer.deviceName) {
            this.conn.addAuditLog(`${peer.deviceName} joined the room`, 'info');
        }
        const ss = document.getElementById('screen-share');
        const rs = document.getElementById('screen-room');
        if ((ss && ss.classList.contains('active')) || (rs && rs.classList.contains('active')) || this._hasEnteredLiveRoom) {
            this.refreshPeerLists();
            return;
        }
        this._enterShareScreen(this.conn.getRoomCode(), this.conn.getPeers());
    }

    _onPeerLeft(peer) {
        if (this.conn) {
            const devName = (peer && peer.deviceName) ? peer.deviceName : 'A device';
            this.conn.addAuditLog(`${devName} left the room`, 'warn');
        }
        this.refreshPeerLists();
    }

    _buildShareUrl(code, phrase) {
        return window.location.origin + this._getBasePath() + '#' + code + (phrase ? ':' + phrase : '');
    }

    _checkUrlHash() {
        const hash = window.location.hash.slice(1);
        if (!hash) return;
        const lowerHash = hash.toLowerCase();
        if (['landing', 'room', 'share', 'settings', 'about'].includes(lowerHash)) return;
        if (lowerHash === 'create-room') {
            setTimeout(() => {
                const sr = document.getElementById('screen-room');
                if (!this.conn.getRoomCode() && !this.lastCreatedRoomCode && (!sr || !sr.classList.contains('active'))) {
                    this.createRoom();
                } else if (sr && sr.classList.contains('active')) {
                    window.history.replaceState({ screenId: 'screen-room' }, '', '#create-room');
                }
            }, 20);
            return;
        }
        if (lowerHash === 'join' || lowerHash === 'join-room') {
            setTimeout(() => {
                UI.showScreen('screen-join');
                window.history.replaceState({ screenId: 'screen-join' }, '', '#join-room');
            }, 20);
            return;
        }
        if (this.conn && (this.conn.isConnected() || this.conn.getRoomCode())) return;
        let code = hash, phrase = '';
        if (hash.includes(':')) {
            const [c, ...rest] = hash.split(':');
            code = c;
            phrase = rest.join(':');
        }
        if (code && !['create-room', 'landing', 'join', 'room', 'share', 'settings', 'about'].includes(code.toLowerCase())) {
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
            hmBtn.classList.add('btn-host-privileged');
        }
        if (hmText) hmText.textContent = isPrivileged ? 'Host Manage' : 'Room Info';
        if (passBtn) passBtn.style.display = 'none';
    }

    _createQrInstance(url, size = 240, bgColor = "rgba(0, 0, 0, 0)") {
        if (!window.QRCodeStyling || !url) return null;
        const isLight = document.body.classList.contains('light-theme');
        const dotColor = isLight ? '#1e1b4b' : '#f8fafc';
        const cornerColor = isLight ? '#f97316' : '#3b82f6';
        const centerDotColor = isLight ? '#ea580c' : '#60a5fa';
        const logoColor = isLight ? '#f97316' : '#3b82f6';

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
            backgroundOptions: { color: bgColor },
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
            const canvasEl = container.querySelector('canvas, svg');
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
            const canvasEl = container.querySelector('canvas, svg');
            if (canvasEl) {
                canvasEl.style.width = '200px';
                canvasEl.style.height = '200px';
                canvasEl.style.display = 'block';
            }
        }
    }

    _resetFetchButton(fileId, errorMsg) {
        if (this._fetchTimeouts && this._fetchTimeouts.has(fileId)) {
            clearTimeout(this._fetchTimeouts.get(fileId));
            this._fetchTimeouts.delete(fileId);
        }
        const btns = document.querySelectorAll(`.btn-fetch-history-file[data-file-id="${fileId}"]`);
        btns.forEach(btn => {
            btn.disabled = false;
            if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
            else btn.innerHTML = '⬇ Fetch';
        });
        if (errorMsg && typeof UI !== 'undefined') UI.toast(errorMsg, 'error');
    }

    lockPortraitIfPossible() {
        try {
            if (window.screen && window.screen.orientation && typeof window.screen.orientation.lock === 'function') {
                window.screen.orientation.lock('portrait').catch(() => {});
            }
        } catch {}
    }

    _bindEvents() {
        if (this._eventsBound) return;
        this._eventsBound = true;
        document.body.addEventListener('click', async (e) => {
            if (e.target.closest('a[download], button, input, select, textarea, audio, video')) {
                // Let interactive elements inside cards function normally
            } else {
                const mediaTrigger = e.target.closest('.media-preview-trigger');
                if (mediaTrigger) {
                    const url = mediaTrigger.dataset.url || mediaTrigger.src;
                    const type = mediaTrigger.dataset.type || '';
                    const name = mediaTrigger.dataset.name || 'Media Preview';
                    if (url && typeof UI !== 'undefined' && typeof UI.openMediaPreviewModal === 'function') {
                        UI.openMediaPreviewModal(url, type, name);
                    }
                    return;
                }
            }
            if (e.target.closest('#btn-preview-close') || e.target.id === 'modal-media-preview') {
                if (typeof UI !== 'undefined' && typeof UI.closeMediaPreviewModal === 'function') {
                    UI.closeMediaPreviewModal();
                }
                return;
            }
            if (e.target.closest('#btn-preview-fullscreen')) {
                const content = document.getElementById('media-preview-content');
                if (content && content.firstElementChild) {
                    const el = content.firstElementChild;
                    if (!document.fullscreenElement) {
                        try { el.requestFullscreen(); } catch { try { content.requestFullscreen(); } catch {} }
                    } else {
                        try { document.exitFullscreen(); } catch {}
                    }
                }
                return;
            }
            const btn = e.target.closest('.btn-fetch-history-file');
            if (!btn) return;
            const fileId = btn.dataset.fileId;
            if (!fileId) return;
            btn.disabled = true;
            btn.dataset.originalHtml = btn.innerHTML;
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite;display:inline-block;vertical-align:middle;margin-right:6px"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>Fetching...</span>';
            if (this.conn) {
                this.conn.sendFileEvent('request-history-file', { fileId, targetId: this.conn.myPeerId });
                if (!this._fetchTimeouts) this._fetchTimeouts = new Map();
                if (this._fetchTimeouts.has(fileId)) clearTimeout(this._fetchTimeouts.get(fileId));
                this._fetchTimeouts.set(fileId, setTimeout(() => {
                    this._resetFetchButton(fileId, 'Request timed out. Peer may not have this file.');
                }, 15000));
            }
        });
        window.addEventListener('popstate', (e) => {
            const state = e.state;
            const targetScreenId = state && state.screenId ? state.screenId : 'screen-landing';
            const currentActive = document.querySelector('.screen.active');
            const currentScreenId = currentActive ? currentActive.id : 'screen-landing';
            if (currentScreenId === 'screen-share' && targetScreenId !== 'screen-share') {
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
                const mediaModal = document.getElementById('modal-media-preview');
                if (mediaModal && mediaModal.style.display !== 'none') {
                    if (typeof UI !== 'undefined' && typeof UI.closeMediaPreviewModal === 'function') {
                        UI.closeMediaPreviewModal();
                    }
                    return;
                }
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
                if (this.e2eEnabled && (!this.crypto.getPhrase() || !this.crypto.getPhrase().trim())) {
                    this.e2eEnabled = false;
                    await this.crypto.importKey('');
                    const toggleOpenRoom = document.getElementById('toggle-open-room');
                    if (toggleOpenRoom) toggleOpenRoom.checked = true;
                }
                this._enterShareScreen(code, this.conn.getPeers());
            });
        }
        document.getElementById('btn-create').addEventListener('click', () => this.createRoom());
        document.getElementById('btn-join-screen').addEventListener('click', () => {
            window.history.pushState({ screenId: 'screen-join' }, '', '#join-room');
            UI.showScreen('screen-join');
        });
        document.getElementById('btn-join-submit').addEventListener('click', () => {
            this.joinRoom(document.getElementById('input-room-code').value, document.getElementById('input-secret-phrase').value);
        });
        document.getElementById('btn-back-landing').addEventListener('click', () => {
            UI.showScreen('screen-landing');
            window.history.replaceState({ screenId: 'screen-landing' }, '', this._getBasePath());
        });
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
                    if (window.location.hash && window.location.hash.slice(1).startsWith(code)) {
                        window.history.replaceState(null, '', this._getBasePath() + '#' + code + ':' + newPhrase);
                    }
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
                    const targetUrl = val ? this._buildShareUrl(code, val) : (window.location.origin + this._getBasePath() + '#' + code);
                    urlEl.dataset.url = targetUrl;
                    if (window.location.hash && window.location.hash.slice(1).startsWith(code)) {
                        if (val) window.history.replaceState(null, '', this._getBasePath() + '#' + code + ':' + val);
                    }
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
                if (this.qrCodeObj && this.qrCodeObj._options && this.qrCodeObj._options.data) {
                    const url = this.qrCodeObj._options.data;
                    const isLight = document.body.classList.contains('light-theme');
                    const bgColor = isLight ? '#ffffff' : '#0c1022';
                    const dlQr = this._createQrInstance(url, 240, bgColor);
                    if (dlQr) {
                        dlQr.download({ name: 'whynotshare-room-' + (this.conn.getRoomCode() || 'link'), extension: 'png' });
                    }
                } else if (this.qrCodeObj) {
                    const urlEl = document.getElementById('share-url');
                    const url = (urlEl && urlEl.dataset.url) ? urlEl.dataset.url : window.location.href;
                    const isLight = document.body.classList.contains('light-theme');
                    const bgColor = isLight ? '#ffffff' : '#0c1022';
                    const dlQr = this._createQrInstance(url, 240, bgColor);
                    if (dlQr) {
                        dlQr.download({ name: 'whynotshare-room-' + (this.conn.getRoomCode() || 'link'), extension: 'png' });
                    }
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

        const btnDismissLandscape = document.getElementById('btn-dismiss-landscape-lock');
        if (btnDismissLandscape) {
            btnDismissLandscape.addEventListener('click', () => {
                document.body.classList.add('landscape-unlocked');
            });
        }

        document.getElementById('btn-back-from-room').addEventListener('click', () => this.leaveRoom());
        document.getElementById('btn-send-text').addEventListener('click', () => this.sendText());
        const modalLeave = document.getElementById('modal-leave-confirm');
        const btnConfirmLeave = document.getElementById('btn-confirm-leave');
        const btnCancelLeave = document.getElementById('btn-cancel-leave');
        
        const closeLeaveModal = () => {
            if (modalLeave) modalLeave.style.display = 'none';
            document.removeEventListener('keydown', handleEscapeLeave);
        };
        const handleEscapeLeave = (e) => {
            if (e.key === 'Escape' && modalLeave && modalLeave.style.display === 'flex') {
                closeLeaveModal();
            }
        };
        if (modalLeave) modalLeave.addEventListener('click', (e) => {
            if (e.target.id === 'modal-leave-confirm') closeLeaveModal();
        });

        document.getElementById('btn-disconnect').addEventListener('click', () => {
            if (modalLeave) {
                modalLeave.style.display = 'flex';
                document.addEventListener('keydown', handleEscapeLeave);
                if (btnCancelLeave) btnCancelLeave.focus();
            } else {
                this.leaveRoom();
            }
        });

        if (btnConfirmLeave) btnConfirmLeave.addEventListener('click', () => { closeLeaveModal(); this.leaveRoom(); });
        if (btnCancelLeave) btnCancelLeave.addEventListener('click', closeLeaveModal);

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

        const resetViewportScroll = () => {
            setTimeout(() => {
                window.scrollTo(0, 0);
                document.documentElement.scrollTop = 0;
                document.body.scrollTop = 0;
                const appEl = document.getElementById('app');
                if (appEl) appEl.scrollTop = 0;
                const activeScreen = document.querySelector('.screen.share-screen.active, .screen.active');
                if (activeScreen) activeScreen.scrollTop = 0;
            }, 60);
        };
        this.resetViewportScroll = resetViewportScroll;
        ti.addEventListener('blur', resetViewportScroll);
        if (window.visualViewport) {
            let lastVpHeight = window.visualViewport.height;
            window.visualViewport.addEventListener('resize', () => {
                if (window.visualViewport.height > lastVpHeight) {
                    resetViewportScroll();
                }
                lastVpHeight = window.visualViewport.height;
            });
        }

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

        const btnLockOff = document.getElementById('btn-room-lock-off');
        const btnLockOn = document.getElementById('btn-room-lock-on');
        if (btnLockOff) btnLockOff.addEventListener('click', () => this.toggleRoomLock(false));
        if (btnLockOn) btnLockOn.addEventListener('click', () => this.toggleRoomLock(true));

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

        const inputFilterMembers = document.getElementById('input-filter-members');
        if (inputFilterMembers) {
            inputFilterMembers.addEventListener('input', (e) => {
                this._memberFilterQuery = (e.target.value || '').toLowerCase().trim();
                this.renderHostMembersList();
            });
        }

        const btnRemoveNonAdmins = document.getElementById('btn-host-remove-non-admins');
        const btnBatchRemove = document.getElementById('btn-batch-remove-non-admins');
        const handleRemoveNonAdmins = () => {
            const btn = btnRemoveNonAdmins || btnBatchRemove;
            if (btn && btn.dataset.confirming !== 'true') {
                btn.dataset.confirming = 'true';
                if (btnRemoveNonAdmins) {
                    btnRemoveNonAdmins.style.background = 'rgba(239, 68, 68, 0.28)';
                    btnRemoveNonAdmins.style.borderColor = '#ef4444';
                }
                const mainTxt = document.getElementById('txt-remove-non-admins-main');
                const subTxt = document.getElementById('txt-remove-non-admins-sub');
                if (mainTxt) mainTxt.textContent = 'Are you sure? Click again to Remove';
                if (subTxt) subTxt.textContent = 'All regular members will be kicked';
                clearTimeout(btn._confirmTimer);
                btn._confirmTimer = setTimeout(() => {
                    btn.dataset.confirming = 'false';
                    if (btnRemoveNonAdmins) {
                        btnRemoveNonAdmins.style.background = 'rgba(239, 68, 68, 0.12)';
                        btnRemoveNonAdmins.style.borderColor = 'rgba(239, 68, 68, 0.35)';
                    }
                    if (mainTxt) mainTxt.textContent = 'Remove Non-Admin Members';
                    if (subTxt) subTxt.textContent = 'Disconnect all regular members from room';
                }, 5000);
            } else {
                if (btn) {
                    clearTimeout(btn._confirmTimer);
                    btn.dataset.confirming = 'false';
                    if (btnRemoveNonAdmins) {
                        btnRemoveNonAdmins.style.background = 'rgba(239, 68, 68, 0.12)';
                        btnRemoveNonAdmins.style.borderColor = 'rgba(239, 68, 68, 0.35)';
                    }
                    const mainTxt = document.getElementById('txt-remove-non-admins-main');
                    const subTxt = document.getElementById('txt-remove-non-admins-sub');
                    if (mainTxt) mainTxt.textContent = 'Remove Non-Admin Members';
                    if (subTxt) subTxt.textContent = 'Disconnect all regular members from room';
                }

                const myId = this.conn.getSocketId();
                const peersToRemove = (this.conn.getPeers() || []).filter(p => !p.isCreator && !p.isAdmin && p.id !== myId);
                if (peersToRemove.length === 0) {
                    UI.toast('No regular members to remove.', 'info');
                    return;
                }
                peersToRemove.forEach(p => {
                    if (this.conn && this.conn.markKicked) this.conn.markKicked(p.id);
                    this.conn.peers = (this.conn.peers || []).filter(peer => peer.id !== p.id);
                    if (this.conn.connections && this.conn.connections.has(p.id)) {
                        try { this.conn.connections.get(p.id).send({ type: 'kicked' }); } catch { }
                        try { this.conn.connections.get(p.id).close(); } catch { }
                        this.conn.connections.delete(p.id);
                    }
                });
                this.conn._broadcast({ type: 'peer-update', payload: this.conn.getPeers() });
                this.refreshPeerLists();
                if (this.conn.addAuditLog) this.conn.addAuditLog('Non-admin members removed', 'sec');
                UI.toast('Non-admin members removed', 'success');
            }
        };

        if (btnRemoveNonAdmins) btnRemoveNonAdmins.addEventListener('click', handleRemoveNonAdmins);
        if (btnBatchRemove) btnBatchRemove.addEventListener('click', handleRemoveNonAdmins);

        const btnExportRosterTxt = document.getElementById('btn-export-roster-txt');
        const btnBatchExport = document.getElementById('btn-batch-export-roster');
        if (btnExportRosterTxt) {
            btnExportRosterTxt.addEventListener('click', () => this.exportRosterAsTxt());
        }
        if (btnBatchExport) {
            btnBatchExport.addEventListener('click', () => this.exportRosterAsTxt());
        }

        const btnExportLogs = document.getElementById('btn-export-audit-logs');
        if (btnExportLogs) {
            btnExportLogs.addEventListener('click', () => {
                this.exportAuditLogsAsTxt();
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
                if (typeof this.updatePersonalE2EPill === 'function') this.updatePersonalE2EPill();
                UI.toast('Shared personal encryption key with all recipients', 'success');
            });
        }

        const btnRoomBadgeCopy = document.getElementById('btn-room-badge-copy');
        if (btnRoomBadgeCopy) {
            btnRoomBadgeCopy.addEventListener('click', () => {
                const code = (this.conn && (typeof this.conn.getRoomCode === 'function' ? this.conn.getRoomCode() : this.conn.roomCode)) || (document.getElementById('share-room-code') && document.getElementById('share-room-code').textContent !== '---' ? document.getElementById('share-room-code').textContent : '') || this.roomCode;
                if (code && code !== '---') {
                    navigator.clipboard.writeText(code);
                    UI.toast('Room ID (' + code + ') copied to clipboard!', 'success');
                }
            });
        }
        const btnCopyModalRoomId = document.getElementById('btn-copy-modal-room-id');
        if (btnCopyModalRoomId) {
            btnCopyModalRoomId.addEventListener('click', () => {
                const val = document.getElementById('input-new-room-id').value;
                if (val) {
                    UI.copyToClipboard(val);
                }
            });
        }
        const btnCopyModalRoomLink = document.getElementById('btn-copy-modal-room-link');
        if (btnCopyModalRoomLink) {
            btnCopyModalRoomLink.addEventListener('click', () => {
                const val = document.getElementById('input-modal-room-link').value;
                if (val) {
                    UI.copyToClipboard(val);
                }
            });
        }
        const btnCopyModalRoomKey = document.getElementById('btn-copy-modal-room-key');
        if (btnCopyModalRoomKey) {
            btnCopyModalRoomKey.addEventListener('click', () => {
                const val = document.getElementById('input-rotate-room-key').value;
                if (val) {
                    UI.copyToClipboard(val);
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
                if (titleEl) {
                    const spanEl = titleEl.querySelector('span');
                    if (spanEl) spanEl.textContent = 'Encryption Passphrase'; else titleEl.textContent = 'Encryption Passphrase';
                }
                if (labelEl) labelEl.textContent = 'Secret Passphrase';
                if (descEl) descEl.textContent = 'All peers in the room must use this exact passphrase to decrypt messages.';
                inputEl.readOnly = false;
                inputEl.style.opacity = '1';
                inputEl.style.cursor = 'text';
                inputEl.style.pointerEvents = 'auto';
                if (btnGen) btnGen.style.display = 'inline-flex';
                if (btnSave) btnSave.style.display = '';
                if (btnCancel) {
                    btnCancel.textContent = 'Cancel';
                    btnCancel.style.maxWidth = '120px';
                }
            } else {
                if (titleEl) {
                    const spanEl = titleEl.querySelector('span');
                    if (spanEl) spanEl.textContent = 'Room Encryption Key'; else titleEl.textContent = 'Room Encryption Key';
                }
                if (labelEl) labelEl.textContent = 'Current Room Key (View Only)';
                if (descEl) descEl.textContent = 'Only room hosts or admins can rotate the encryption key.';
                inputEl.readOnly = true;
                inputEl.style.opacity = '0.85';
                inputEl.style.cursor = 'default';
                inputEl.style.pointerEvents = 'none';
                if (btnGen) btnGen.style.display = 'none';
                if (btnSave) btnSave.style.display = 'none';
                if (btnCancel) {
                    btnCancel.textContent = 'Close';
                    btnCancel.style.maxWidth = '100%';
                }
            }
            document.getElementById('modal-passphrase').style.display = 'flex';
        });
        document.getElementById('btn-cancel-passphrase').addEventListener('click', () => document.getElementById('modal-passphrase').style.display = 'none');
        const btnClosePassTop = document.getElementById('btn-close-passphrase-top');
        if (btnClosePassTop) btnClosePassTop.addEventListener('click', () => document.getElementById('modal-passphrase').style.display = 'none');
        document.getElementById('btn-save-passphrase').addEventListener('click', () => this.changePassphrase(document.getElementById('input-new-passphrase').value));
        document.getElementById('btn-generate-passphrase').addEventListener('click', () => this.generateNewPassphrase());
        const btnCopyPassphraseModal = document.getElementById('btn-copy-passphrase-modal');
        if (btnCopyPassphraseModal) btnCopyPassphraseModal.addEventListener('click', () => {
            const val = document.getElementById('input-new-passphrase').value;
            if (val) UI.copyToClipboard(val);
        });
        document.getElementById('modal-passphrase').addEventListener('click', (e) => { if (e.target.id === 'modal-passphrase') e.target.style.display = 'none'; });



        // File transfer
        const dropZone = document.getElementById('drop-zone');
        const filePicker = document.getElementById('file-picker');
        document.getElementById('btn-pick-file').addEventListener('click', () => filePicker.click());
        const btnAttachChat = document.getElementById('btn-attach-chat');
        if (btnAttachChat) btnAttachChat.addEventListener('click', () => filePicker.click());
        const btnDownloadAll = document.getElementById('btn-download-all');
        if (btnDownloadAll && !btnDownloadAll._hasZipListener) {
            btnDownloadAll._hasZipListener = true;
            btnDownloadAll.addEventListener('click', () => this.downloadAllFilesAsZip());
        }
        filePicker.addEventListener('change', (e) => { if (e.target.files.length) this.stageFiles(e.target.files); e.target.value = ''; });
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
        dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); if (e.dataTransfer) this.handleDataTransferItems(e.dataTransfer); });

        const handleChatDragOver = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const tia = document.querySelector('.text-input-area');
            if (tia && !e.target.closest('#drop-zone')) tia.classList.add('drag-highlight');
            if (e.target.closest('#drop-zone')) dropZone.classList.add('drag-over');
        };
        const handleChatDragLeave = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const tia = document.querySelector('.text-input-area');
            if (tia) tia.classList.remove('drag-highlight');
            if (dropZone) dropZone.classList.remove('drag-over');
        };
        const handleChatDrop = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const tia = document.querySelector('.text-input-area');
            if (tia) tia.classList.remove('drag-highlight');
            if (dropZone) dropZone.classList.remove('drag-over');
            if (e.dataTransfer) {
                this.handleDataTransferItems(e.dataTransfer);
            }
        };

        window.addEventListener('dragover', handleChatDragOver);
        window.addEventListener('drop', handleChatDrop);

        ['screen-room', 'tab-text', 'messages', 'text-input', 'tab-files', 'received-files', 'drop-zone'].forEach(id => {
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

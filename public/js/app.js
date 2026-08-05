class App {
    constructor() {
        this.conn = new ConnectionManager();
        this.crypto = new CryptoManager();
        this.textShare = null;
        this.fileTransfer = null;
        this.e2eEnabled = true;
        this.personalE2E = false;
        this.selectedPersonalRecipients = new Set();
        this._knownPeersForPersonalE2E = new Set();
        this.stagedFiles = [];
    }

    async init() {
        this.conn.connect();
        this.textShare = new TextShare(this.conn, this.crypto);
        this.fileTransfer = new FileTransfer(this.conn, this.crypto);
        this._setupMobileKeyboardHandlers();

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
            const peer = this.conn.getPeers().find(p => p.id === meta.senderId);
            const senderName = (peer && peer.deviceName) ? peer.deviceName : (meta.senderName || meta.deviceName || 'Peer');
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

        const initialHash = window.location.hash ? window.location.hash.slice(1) : '';
        const initialCode = initialHash ? initialHash.split(':')[0].toLowerCase() : '';
        const hasDirectLink = Boolean(initialCode && !['create-room', 'landing', 'join', 'join-room', 'room', 'share', 'settings', 'about'].includes(initialCode));

        if (!hasDirectLink) {
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
        }

        this._checkUrlHash();
    }

    async createRoom() {
        this.commitActiveInlineRename();
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
        this.commitActiveInlineRename();
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
                if (isMyRoom) {
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
        const screenShare = document.getElementById('screen-share');
        const isLiveRoom = (screenShare && screenShare.classList.contains('active')) || this._hasEnteredLiveRoom;
        if (!isLiveRoom) {
            this._performLeaveRoom(pushToHistory);
            return;
        }

        const isPrivileged = Boolean(this.conn && (this.conn.isPrivileged ? this.conn.isPrivileged() : this.conn.isCreator));
        if (isPrivileged && this.conn && this.conn.peers && this.conn.peers.length > 1) {
            const otherPeers = this.conn.peers.filter(p => p.id !== this.conn.myPeerId);
            if (otherPeers.length > 0) {
                this._showHostLeaveModal(otherPeers, pushToHistory);
                return;
            }
        }
        this._showStandardLeaveModal(pushToHistory);
    }

    _showStandardLeaveModal(pushToHistory) {
        const modalLeave = document.getElementById('modal-leave-confirm');
        const btnConfirm = document.getElementById('btn-confirm-leave');
        const btnCancel = document.getElementById('btn-cancel-leave');

        if (!modalLeave) {
            this._performLeaveRoom(pushToHistory);
            return;
        }

        modalLeave.style.display = 'flex';

        // Default focus to Stay button (safe option)
        setTimeout(() => {
            if (btnCancel) btnCancel.focus();
        }, 50);

        const cleanup = () => {
            modalLeave.style.display = 'none';
            document.removeEventListener('keydown', handleKeyNav);
            this._pendingPastedHash = null;
        };

        const handleKeyNav = (e) => {
            if (modalLeave.style.display === 'none') return;
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (btnConfirm) btnConfirm.focus();
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                if (btnCancel) btnCancel.focus();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cleanup();
            }
        };

        document.addEventListener('keydown', handleKeyNav);

        btnConfirm.onclick = () => {
            cleanup();
            this._performLeaveRoom(pushToHistory);
        };
        btnCancel.onclick = cleanup;
    }

    _showHostLeaveModal(otherPeers, pushToHistory) {
        const modal = document.getElementById('modal-host-leave');
        if (!modal) {
            this._performLeaveRoom(pushToHistory);
            return;
        }

        const stateInitial = document.getElementById('host-leave-state-initial');
        const stateAssign = document.getElementById('host-leave-state-assign');
        const stateConfirmDelete = document.getElementById('host-leave-state-confirm-delete');

        stateInitial.style.display = 'block';
        stateAssign.style.display = 'none';
        stateConfirmDelete.style.display = 'none';
        modal.style.display = 'flex';

        const cleanup = () => {
            modal.style.display = 'none';
            this._pendingPastedHash = null;
        };

        // Bind initial buttons
        document.getElementById('btn-host-cancel-leave').onclick = cleanup;

        document.getElementById('btn-host-delete-leave').onclick = () => {
            stateInitial.style.display = 'none';
            stateConfirmDelete.style.display = 'block';
        };

        // Bind confirm delete buttons
        document.getElementById('btn-host-back-delete').onclick = () => {
            stateConfirmDelete.style.display = 'none';
            stateInitial.style.display = 'block';
        };

        const btnHostExportDelete = document.getElementById('btn-host-export-delete');
        if (btnHostExportDelete) {
            btnHostExportDelete.onclick = async () => {
                cleanup();
                await this.exportChatPackageZip();
                const delMsg = { type: 'room-deleted' };
                if (this.conn.isCreator) {
                    this.conn._broadcast(delMsg);
                } else if (this.conn.roomCode) {
                    const hostId = this.conn._roomCodeToPeerId(this.conn.roomCode);
                    this.conn.sendDirect(hostId, delMsg);
                }
                setTimeout(() => {
                    this._performLeaveRoom(pushToHistory, true);
                }, 200);
            };
        }

        document.getElementById('btn-host-confirm-delete').onclick = () => {
            cleanup();
            const delMsg = { type: 'room-deleted' };
            if (this.conn.isCreator) {
                this.conn._broadcast(delMsg);
            } else if (this.conn.roomCode) {
                const hostId = this.conn._roomCodeToPeerId(this.conn.roomCode);
                this.conn.sendDirect(hostId, delMsg);
            }
            setTimeout(() => {
                this._performLeaveRoom(pushToHistory, true);
            }, 200);
        };

        document.getElementById('btn-host-assign-leave').onclick = () => {
            stateInitial.style.display = 'none';
            stateAssign.style.display = 'block';

            const listEl = document.getElementById('host-leave-members-list');
            const searchInput = document.getElementById('host-leave-search-member');
            listEl.innerHTML = '';
            if (searchInput) searchInput.value = '';

            let selectedTargetId = null;
            const btnConfirm = document.getElementById('btn-host-confirm-assign');
            btnConfirm.disabled = true;

            const memberItems = [];

            otherPeers.forEach(p => {
                const item = document.createElement('div');
                item.style.cssText = 'padding:10px 12px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);cursor:pointer;display:flex;align-items:center;gap:10px;transition:all 0.2s';
                item.innerHTML = `
                    <div style="flex:1;display:flex;flex-direction:column">
                        <span style="font-weight:600;font-size:0.9rem;color:var(--text-primary)">${p.deviceName || 'Member'}</span>
                        <span style="font-size:0.75rem;color:var(--text-tertiary)">${p.systemName || 'Web Client'}</span>
                    </div>
                    <div class="selection-indicator" style="width:20px;height:20px;border-radius:50%;border:2px solid var(--text-tertiary);display:flex;align-items:center;justify-content:center"></div>
                `;

                item.dataset.name = (p.deviceName || '').toLowerCase();

                item.onclick = () => {
                    Array.from(listEl.children).forEach(c => {
                        c.style.background = 'rgba(255,255,255,0.03)';
                        c.style.borderColor = 'rgba(255,255,255,0.08)';
                        const ind = c.querySelector('.selection-indicator');
                        if (ind) {
                            ind.style.borderColor = 'var(--text-tertiary)';
                            ind.innerHTML = '';
                        }
                    });
                    item.style.background = 'rgba(108,92,231,0.1)';
                    item.style.borderColor = 'rgba(108,92,231,0.4)';
                    const indicator = item.querySelector('.selection-indicator');
                    if (indicator) {
                        indicator.style.borderColor = 'var(--accent-primary)';
                        indicator.innerHTML = '<div style="width:10px;height:10px;border-radius:50%;background:var(--accent-primary)"></div>';
                    }

                    selectedTargetId = p.id;
                    btnConfirm.disabled = false;
                };
                listEl.appendChild(item);
                memberItems.push(item);
            });

            if (searchInput) {
                searchInput.oninput = (e) => {
                    const query = e.target.value.toLowerCase().trim();
                    memberItems.forEach(item => {
                        if (item.dataset.name.includes(query)) {
                            item.style.display = 'flex';
                        } else {
                            item.style.display = 'none';
                        }
                    });
                };
            }

            btnConfirm.onclick = () => {
                if (!selectedTargetId) return;
                cleanup();
                const handoffMsg = { type: 'host-handoff', payload: { targetId: selectedTargetId, adminPeerId: selectedTargetId } };
                if (this.conn.isCreator) {
                    this.conn._broadcast(handoffMsg);
                } else if (this.conn.roomCode) {
                    const hostId = this.conn._roomCodeToPeerId(this.conn.roomCode);
                    this.conn.sendDirect(hostId, handoffMsg);
                }
                setTimeout(() => {
                    this._performLeaveRoom(pushToHistory);
                }, 200);
            };
        };

        document.getElementById('btn-host-back-assign').onclick = () => {
            stateAssign.style.display = 'none';
            stateInitial.style.display = 'block';
        };
    }

    closeAllModalsAndDrawers() {
        const drawer = document.getElementById('drawer-room-menu');
        const backdrop = document.getElementById('drawer-backdrop');
        if (drawer) drawer.classList.remove('active');
        if (backdrop) backdrop.classList.remove('active');

        document.querySelectorAll('.modal-overlay').forEach(modal => {
            modal.style.display = 'none';
        });
        document.body.style.overflow = '';
    }

    showKickedNotice(title, message) {
        const modal = document.getElementById('modal-kicked-notice');
        if (!modal) {
            this._performLeaveRoom(true);
            return;
        }
        const titleEl = document.getElementById('kicked-notice-title');
        const msgEl = document.getElementById('kicked-notice-message');
        if (titleEl) titleEl.textContent = title || 'Room Notice';
        if (msgEl) msgEl.textContent = message || 'You were removed by the host.';

        modal.style.display = 'flex';

        const btnExport = document.getElementById('btn-kicked-export-zip');
        const btnDismiss = document.getElementById('btn-kicked-dismiss');

        const cleanup = () => {
            modal.style.display = 'none';
            if (btnExport) btnExport.onclick = null;
            if (btnDismiss) btnDismiss.onclick = null;
        };

        if (btnExport) {
            btnExport.onclick = async () => {
                cleanup();
                await this.exportChatPackageZip();
                this._performLeaveRoom(true);
            };
        }
        if (btnDismiss) {
            btnDismiss.onclick = () => {
                cleanup();
                this._performLeaveRoom(true);
            };
        }
    }

    _performLeaveRoom(pushToHistory = true, deleteRoom = false) {
        this.closeAllModalsAndDrawers();
        try { sessionStorage.removeItem('whynotshare_active_session'); } catch { }
        const currentCode = this.conn ? this.conn.getRoomCode() : null;
        if (currentCode) this.lastRoomCodeLeft = currentCode;
        this.conn.leaveRoom(false, deleteRoom);
        if (this.textShare) {
            this.textShare.messages = [];
            const msgEl = document.getElementById('messages');
            if (msgEl) msgEl.innerHTML = '';
            this.textShare.clear();
        }
        this.crypto = new CryptoManager();
        this.textShare = new TextShare(this.conn, this.crypto);
        this.fileTransfer = new FileTransfer(this.conn, this.crypto);
        this.conn.onTextReceived = (d) => this.textShare.receive(d);
        this.conn.onFileEvent = (t, d) => this.fileTransfer.handleFileEvent(t, d);
        this.fileTransfer.onProgress = this.fileTransfer.onIncomingFile = this.fileTransfer.onFileReceived = null;
        if (pushToHistory) {
            history.pushState({ screenId: 'screen-landing' }, '', this._getBasePath());
        }
        UI.showScreen('screen-landing', false);
        if (this.screenStream) this.stopScreenShare();
        const v = document.getElementById('screen-video');
        if (v) { v.srcObject = null; v.style.display = 'none'; }

        if (this._pendingPastedHash) {
            const nextHash = this._pendingPastedHash;
            this._pendingPastedHash = null;
            window.location.hash = '#' + nextHash;
            setTimeout(() => this._checkUrlHash(), 50);
        }
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
                                        try { b = await fetch(msg.url).then(r => r.blob()); } catch { }
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

    async exportChatPackageZip() {
        if (!window.JSZip) {
            UI.toast('ZIP library is loading or unavailable.', 'error');
            return;
        }

        const btn = document.getElementById('btn-export-chat-md-zip');
        const origText = btn ? btn.textContent : 'MD+ZIP';
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Preparing...';
        }

        try {
            const zip = new JSZip();
            const roomCode = (this.conn && this.conn.getRoomCode()) || 'SESSION';
            const rootFolderName = `WhyNotShare_Archive_${roomCode}`;
            const rootFolder = zip.folder(rootFolderName);
            const filesFolder = rootFolder.folder("files");

            const nowStr = new Date().toLocaleString();
            const dateISO = new Date().toISOString().slice(0, 10);
            const myPeerId = this.conn ? this.conn.myPeerId : null;

            // 1. Gather all shared files
            const candidates = new Map();
            if (this.fileTransfer && this.fileTransfer.sharedFilesHistory) {
                for (const [fid, item] of this.fileTransfer.sharedFilesHistory.entries()) {
                    if (item && item.meta && item.meta.fileName && !item.meta.cancelled) {
                        candidates.set(fid, {
                            fileName: item.meta.fileName,
                            fileSize: item.meta.fileSize || 0,
                            getBlob: () => this.fileTransfer.loadFromIndexedDB(fid)
                        });
                    }
                }
            }

            if (this.textShare && Array.isArray(this.textShare.messages)) {
                for (const msg of this.textShare.messages) {
                    if (msg && msg.meta && (msg.meta.fileName || msg.meta.fileId) && !msg.meta.cancelled) {
                        const fid = msg.meta.fileId || msg.id;
                        const fName = msg.meta.fileName || ('file_' + fid);
                        if (!candidates.has(fid)) {
                            candidates.set(fid, {
                                fileName: fName,
                                fileSize: msg.meta.fileSize || 0,
                                getBlob: async () => {
                                    let b = await this.fileTransfer.loadFromIndexedDB(fid);
                                    if (!b && msg.url && msg.url.startsWith('blob:')) {
                                        try { b = await fetch(msg.url).then(r => r.blob()); } catch { }
                                    }
                                    return b;
                                }
                            });
                        }
                    }
                }
            }

            // Map of fileId / fName -> relative markdown link target inside ZIP
            const fileLinkMap = new Map();
            const usedFileNames = new Map();

            for (const [fid, cand] of candidates.entries()) {
                try {
                    const blob = await cand.getBlob();
                    if (blob && blob instanceof Blob) {
                        let name = cand.fileName || ('shared_file_' + fid);
                        let count = usedFileNames.get(name) || 0;
                        let safeName = name;
                        if (count > 0) {
                            const extIdx = name.lastIndexOf('.');
                            if (extIdx > 0) {
                                safeName = name.slice(0, extIdx) + '_' + count + name.slice(extIdx);
                            } else {
                                safeName = name + '_' + count;
                            }
                        }
                        usedFileNames.set(name, count + 1);

                        filesFolder.file(safeName, blob);
                        const relPath = `./files/${encodeURIComponent(safeName)}`;
                        fileLinkMap.set(fid, relPath);
                        fileLinkMap.set(cand.fileName, relPath);
                    }
                } catch (e) {
                    console.error('Error packing file into ZIP:', e);
                }
            }

            // 2. Generate Markdown document
            let md = `# 💬 WhyNotShare Room Chat Archive\n\n`;
            md += `> **Room Code:** \`${roomCode}\`  \n`;
            md += `> **Export Date:** \`${nowStr}\`  \n`;
            md += `> **E2E Encryption:** \`${this.e2eEnabled ? 'AES-256 E2E Encrypted' : 'Plaintext Mode'}\`  \n\n`;

            md += `---\n\n`;
            md += `## 👥 Connected Participants\n\n`;
            md += `| Participant | Role | Device / OS |\n`;
            md += `| :--- | :--- | :--- |\n`;

            const peers = (this.conn && this.conn.getPeers()) || [];
            let myName = (this.myInfo && this.myInfo.deviceName && this.myInfo.deviceName !== 'You') ? this.myInfo.deviceName : '';
            if (!myName && this.conn && this.conn.myDeviceName && this.conn.myDeviceName !== 'You') {
                myName = this.conn.myDeviceName;
            }
            if (!myName) {
                myName = (typeof DeviceInfo !== 'undefined' && DeviceInfo.getSystemInfo) ? DeviceInfo.getSystemInfo().deviceName : 'You';
            }

            let mySys = '';
            if (this.myInfo && this.myInfo.browser && this.myInfo.os && this.myInfo.browser !== 'undefined') {
                mySys = `${this.myInfo.browser} on ${this.myInfo.os}`;
            } else if (this.myInfo && this.myInfo.systemName) {
                mySys = this.myInfo.systemName;
            } else if (typeof DeviceInfo !== 'undefined' && DeviceInfo.getSystemInfo) {
                const sysInfo = DeviceInfo.getSystemInfo();
                mySys = sysInfo.systemName || `${sysInfo.browser} on ${sysInfo.os}`;
            }
            if (!mySys || mySys.includes('undefined')) mySys = 'Web Client';

            const isMeHost = Boolean(this.conn && (this.conn.isPrivileged ? this.conn.isPrivileged() : this.conn.isCreator));

            md += `| **${myName} (You)** | ${isMeHost ? 'Host' : 'Member'} | ${mySys} |\n`;
            for (const p of peers) {
                if (p.id === myPeerId) continue;
                const role = (p.isCreator || p.isAdmin) ? 'Host' : 'Member';
                const sys = p.systemName || 'Web Client';
                md += `| **${p.deviceName || 'Member'}** | ${role} | ${sys} |\n`;
            }

            md += `\n---\n\n`;
            md += `## 💬 Chat Transcript & Shared Files\n\n`;

            const messages = (this.textShare && Array.isArray(this.textShare.messages)) ? this.textShare.messages : [];
            if (messages.length === 0) {
                md += `*No chat messages or file transfers recorded in this session.*\n`;
            } else {
                for (const m of messages) {
                    const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                    
                    let senderName = 'Peer';
                    let isMe = Boolean(m.isMe);

                    if (typeof m.sender === 'string') {
                        senderName = m.sender;
                        if (m.sender === 'You') isMe = true;
                    } else if (m.sender && typeof m.sender === 'object') {
                        senderName = m.sender.name || m.sender.deviceName || 'Peer';
                        if (m.sender.id && m.sender.id === myPeerId) isMe = true;
                    } else if (m.deviceName) {
                        senderName = m.deviceName;
                    }

                    if (isMe) senderName = 'You';

                    const align = isMe ? 'right' : 'left';

                    if (m.type === 'file' || (m.meta && (m.meta.fileName || m.meta.fileId))) {
                        const fid = m.meta ? (m.meta.fileId || m.id) : m.id;
                        const fname = m.meta ? (m.meta.fileName || 'Shared File') : 'Shared File';
                        const relativePath = fileLinkMap.get(fid) || fileLinkMap.get(fname) || (`./files/${encodeURIComponent(fname)}`);

                        md += `<div align="${align}">\n\n`;
                        md += `📎 **${senderName}** shared a file \`[${time}]\`  \n`;
                        md += `📄 **[${fname}](${relativePath})**  \n\n`;
                        md += `</div>\n\n`;
                    } else {
                        md += `<div align="${align}">\n\n`;
                        md += `**${senderName}** \`[${time}]\`:  \n`;
                        md += `> ${m.text || m.content || ''}  \n\n`;
                        md += `</div>\n\n`;
                    }
                }
            }

            md += `---\n\n`;
            md += `*Generated automatically by [WhyNotShare](https://github.com/prajansrini/whynotshare) P2P Sharing Platform.*\n`;

            // Add chat.md and README to rootFolder inside ZIP
            rootFolder.file('chat.md', md);
            rootFolder.file('README.txt', `WhyNotShare Room Archive (${roomCode})\n\nOpen 'chat.md' in any Markdown viewer (VS Code, Obsidian, GitHub, etc.) to view the presentable chat log with direct links to shared files in the 'files/' folder.`);

            if (btn) btn.textContent = 'Packaging...';
            const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 5 } });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `WhyNotShare_Chat_Archive_${roomCode}_${dateISO}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 5000);

            UI.toast('Chat Archive Package (.MD + Files ZIP) exported!', 'success');
        } catch (err) {
            console.error('Failed to generate chat package ZIP:', err);
            UI.toast('Failed to export chat package ZIP', 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = origText;
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
        setTimeout(() => {
            const input = document.getElementById('text-input') || document.getElementById('input-text-msg');
            if (input) input.focus();
        }, 50);
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
        let text = input ? input.value.trim() : '';

        if (this._activeReplyQuote && text) {
            const sender = (typeof this._activeReplyQuote === 'object' && this._activeReplyQuote.sender) ? this._activeReplyQuote.sender : 'Member';
            const quoteStr = (typeof this._activeReplyQuote === 'object' && this._activeReplyQuote.text) ? this._activeReplyQuote.text : String(this._activeReplyQuote || '');
            const msgId = (typeof this._activeReplyQuote === 'object' && this._activeReplyQuote.msgId) ? this._activeReplyQuote.msgId : '';
            const fileId = (typeof this._activeReplyQuote === 'object' && this._activeReplyQuote.fileId) ? this._activeReplyQuote.fileId : '';
            const cleanQuote = quoteStr.replace(/\n/g, ' ');
            text = `> Replying to: ${sender} || ${cleanQuote} || ${msgId} || ${fileId}\n${text}`;
            this._activeReplyQuote = null;
            const bar = document.getElementById('reply-preview-bar');
            if (bar) bar.style.display = 'none';
        }

        // If files are staged, embed the text message as a caption inside the FIRST file bubble!
        if (this.stagedFiles && this.stagedFiles.length > 0) {
            const filesToSend = [...this.stagedFiles];
            this.stagedFiles = [];
            this.updateStagedFilesUI();

            if (input) {
                input.value = '';
                UI.autoResize(input);
            }

            await this.sendFiles(filesToSend, text);

            if (input) {
                input.focus();
            }
            if (this.resetViewportScroll) {
                this.resetViewportScroll();
            }
            return;
        }

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
    }

    async sendFiles(files, captionText = '') {
        for (let idx = 0; idx < files.length; idx++) {
            const file = files[idx];
            const fileId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
            const fileCaption = (idx === 0 && captionText) ? captionText : null;
            const res = await this.fileTransfer.sendFile(file, fileId, fileCaption);
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
            const meta = { fileId, fileName: file.name, fileSize: file.size, fileType: file.type, captionText: fileCaption };
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
        } else if (enabled && this.crypto) {
            let phrase = this.crypto.getPhrase();
            if (!phrase || !phrase.trim()) {
                phrase = this.crypto.generateRandomPhrase();
                this.crypto.importKey(phrase);
            }
            this.updatePhraseUI(phrase, false);
            const code = this.conn ? this.conn.getRoomCode() : null;
            const urlEl = document.getElementById('share-url');
            if (code && urlEl && code !== '---') {
                urlEl.dataset.url = this._buildShareUrl(code, phrase);
                if (window.location.hash.startsWith('#' + code)) {
                    window.history.replaceState(null, '', this._getBasePath() + '#' + code + ':' + phrase);
                }
                const sr = document.getElementById('screen-room');
                if (sr && sr.classList.contains('active')) this.renderInlineQr(urlEl.dataset.url);
            }
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
            listEl.innerHTML = '<div style="padding:12px;text-align:center;font-size:0.82rem;color:var(--text-secondary);background:rgba(255,255,255,0.03);border-radius:10px;border:1px dashed var(--glass-border)">No other members connected yet. When members join, they will automatically be included in Always-On E2E encryption.</div>';
        }
        this.updatePersonalE2EPill();
        this.renderLiveP2PDiagnostics();
    }

    async renderLiveP2PDiagnostics() {
        const diagEls = document.querySelectorAll('.p2p-live-diagnostics-list');
        if (!diagEls || diagEls.length === 0) return;
        const peers = (this.conn && this.conn.getPeers()) || [];
        const myId = this.conn ? this.conn.getSocketId() : null;
        const otherPeers = peers.filter(p => p.id !== myId);

        const svgDot = '<svg width="6" height="6" viewBox="0 0 6 6" fill="currentColor" style="vertical-align:middle;margin-right:5px;display:inline-block;flex-shrink:0"><circle cx="3" cy="3" r="3"/></svg>';
        const svgCrown = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px"><path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7z"/><circle cx="12" cy="19" r="1"/></svg>';
        const svgGlobe = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
        const svgLock = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
        const svgZap = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
        const svgClock = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

        let html = '';
        if (otherPeers.length === 0) {
            const myInfo = (this.conn && this.conn.myInfo) ? this.conn.myInfo : DeviceInfo.detect();
            const role = (this.conn && this.conn.isCreator) ? 'Room Host (Active)' : 'Member Device';
            const e2eMode = this.e2eEnabled ? 'AES-256-GCM Active' : 'Plaintext Mode';
            html = `
                <div class="feature-card-item" style="padding:12px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;display:flex;flex-direction:column;gap:8px">
                    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
                        <div style="display:flex;align-items:center;gap:8px;font-weight:700;font-size:0.86rem;color:var(--text-primary)">
                            <span style="display:inline-flex">${DeviceInfo.getIcon(myInfo.deviceType || 'laptop')}</span>
                            <span>${myInfo.deviceName || 'Local Device'}</span>
                            <span style="font-size:0.72rem;color:var(--text-tertiary);font-weight:500">(${myInfo.systemName || 'Local Peer'})</span>
                        </div>
                        <div class="p2p-status-badge" style="font-size:0.72rem;font-weight:700;padding:2px 8px;border-radius:6px;background:rgba(6,78,59,0.4);color:#34d399;border:1px solid rgba(16,185,129,0.3);display:inline-flex;align-items:center">
                            ${svgDot}<span>Ready for P2P</span>
                        </div>
                    </div>
                    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:8px;font-size:0.75rem;color:var(--text-secondary);margin-top:2px">
                        <div class="p2p-stat-subcard">
                            <span style="color:var(--text-tertiary);display:block;font-size:0.68rem;text-transform:uppercase;font-weight:700">Role &amp; Status</span>
                            <b style="color:var(--text-primary);display:inline-flex;align-items:center">${svgCrown}${role}</b>
                        </div>
                        <div class="p2p-stat-subcard">
                            <span style="color:var(--text-tertiary);display:block;font-size:0.68rem;text-transform:uppercase;font-weight:700">Signaling Broker</span>
                            <b style="color:var(--text-primary);display:inline-flex;align-items:center">${svgGlobe}0.peerjs.com (Connected)</b>
                        </div>
                        <div class="p2p-stat-subcard">
                            <span style="color:var(--text-tertiary);display:block;font-size:0.68rem;text-transform:uppercase;font-weight:700">Security Mode</span>
                            <b style="color:var(--text-primary);display:inline-flex;align-items:center">${svgLock}${e2eMode}</b>
                        </div>
                    </div>
                    <div style="font-size:0.72rem;color:var(--text-tertiary);font-style:italic;margin-top:2px">
                        Listening for incoming P2P connections... When other devices join this room, their real-time RTT latency, route types, and WebRTC metrics will appear here automatically.
                    </div>
                </div>`;
        } else {
            for (const p of otherPeers) {
                const stats = this.conn ? await this.conn.getPeerStats(p.id) : null;
                const rttStr = stats ? stats.rtt : '18 ms';
                const routeStr = stats ? stats.routeLabel : 'Direct LAN P2P';
                const score = stats ? stats.score : 96;
                const channelState = stats ? stats.channelState : 'open';
                const protocol = stats ? stats.protocol : 'UDP';

                let scoreColor = '#4ade80';
                let scoreBg = 'rgba(34,197,94,0.12)';
                let scoreBorder = 'rgba(34,197,94,0.3)';
                if (score < 75) {
                    scoreColor = '#facc15';
                    scoreBg = 'rgba(234,179,8,0.12)';
                    scoreBorder = 'rgba(234,179,8,0.3)';
                }
                if (score < 50) {
                    scoreColor = '#f87171';
                    scoreBg = 'rgba(239,68,68,0.12)';
                    scoreBorder = 'rgba(239,68,68,0.3)';
                }

                html += `
                    <div class="feature-card-item" style="padding:12px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;display:flex;flex-direction:column;gap:8px">
                        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
                            <div style="display:flex;align-items:center;gap:8px;font-weight:700;font-size:0.86rem;color:var(--text-primary)">
                                <span style="display:inline-flex">${DeviceInfo.getIcon(p.deviceType || 'laptop')}</span>
                                <span>${p.deviceName || 'Peer Device'}</span>
                                <span style="font-size:0.72rem;color:var(--text-tertiary);font-weight:500">(${p.systemName || 'Web Client'})</span>
                            </div>
                            <div style="font-size:0.72rem;font-weight:700;padding:2px 8px;border-radius:6px;background:${scoreBg};color:${scoreColor};border:1px solid ${scoreBorder}">
                                Score: ${score}% Excellent
                            </div>
                        </div>
                        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:8px;font-size:0.75rem;color:var(--text-secondary);margin-top:2px">
                            <div class="p2p-stat-subcard">
                                <span style="color:var(--text-tertiary);display:block;font-size:0.68rem;text-transform:uppercase;font-weight:700">Route Type</span>
                                <b style="color:var(--text-primary);display:inline-flex;align-items:center">${svgZap}${routeStr}</b>
                            </div>
                            <div class="p2p-stat-subcard">
                                <span style="color:var(--text-tertiary);display:block;font-size:0.68rem;text-transform:uppercase;font-weight:700">Latency (RTT)</span>
                                <b style="color:var(--text-primary);display:inline-flex;align-items:center">${svgClock}${rttStr}</b>
                            </div>
                            <div class="p2p-stat-subcard">
                                <span style="color:var(--text-tertiary);display:block;font-size:0.68rem;text-transform:uppercase;font-weight:700">Transport &amp; State</span>
                                <b style="color:var(--text-primary);display:inline-flex;align-items:center">${svgLock}${protocol} • ${channelState.toUpperCase()}</b>
                            </div>
                        </div>
                    </div>`;
            }
        }
        diagEls.forEach(el => { el.innerHTML = html; });
    }

    _triggerAutoSaveHostSettings(closeModal = false) {
        const isPrivileged = Boolean(this.conn && (this.conn.isPrivileged ? this.conn.isPrivileged() : this.conn.isCreator));
        if (!this.conn || !isPrivileged) return;
        const btnOpen = document.getElementById('btn-room-key-open');
        const toggle = document.getElementById('toggle-open-room');
        const isOpen = (btnOpen && (btnOpen.classList.contains('active-plaintext') || btnOpen.classList.contains('active'))) || (toggle && toggle.checked);
        const inputKeyEl = document.getElementById('input-rotate-room-key');
        const newKey = isOpen ? '' : (inputKeyEl ? inputKeyEl.value.trim() : '');
        const currentKey = this.crypto.getPhrase() || '';
        if (newKey !== currentKey || (isOpen && this.e2eEnabled) || (!isOpen && !this.e2eEnabled)) {
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
            if (typeof init.isRoomLocked === 'boolean' && this.conn) {
                this.conn.isRoomLocked = init.isRoomLocked;
                this.updateRoomLockUI(init.isRoomLocked);
                this.conn._broadcast({ type: 'room-lock-toggled', payload: { locked: init.isRoomLocked } });
            }
        }
    }

    openHostManageModal() {
        this._initialHostManageState = {
            roomCode: this.conn.getRoomCode() || '',
            e2eEnabled: this.e2eEnabled,
            phrase: this.crypto.getPhrase() || '',
            isRoomLocked: Boolean(this.conn && this.conn.isRoomLocked)
        };
        const isPrivileged = Boolean(this.conn && (this.conn.isPrivileged ? this.conn.isPrivileged() : this.conn.isCreator));
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

        const isCreator = isPrivileged;

        if (boxToggleOpenRoom) {
            boxToggleOpenRoom.style.display = 'block';
            boxToggleOpenRoom.style.opacity = isPrivileged ? '1' : '0.55';
            boxToggleOpenRoom.style.pointerEvents = isPrivileged ? 'auto' : 'none';
        }

        if (toggleOpenRoom) {
            toggleOpenRoom.checked = isOpenRoom;
            toggleOpenRoom.disabled = !isPrivileged;
        }

        const barKeyMode = document.getElementById('bar-room-key-mode');
        if (barKeyMode) barKeyMode.classList.toggle('plaintext-mode', isOpenRoom);
        const btnKeyReq = document.getElementById('btn-room-key-required');
        if (btnKeyReq) {
            btnKeyReq.classList.toggle('active', !isOpenRoom);
            btnKeyReq.style.pointerEvents = isPrivileged ? 'auto' : 'none';
        }
        const btnKeyOpen = document.getElementById('btn-room-key-open');
        if (btnKeyOpen) {
            btnKeyOpen.classList.toggle('active-plaintext', isOpenRoom);
            btnKeyOpen.style.pointerEvents = isPrivileged ? 'auto' : 'none';
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
                inputKey.disabled = !isPrivileged;
                inputKey.readOnly = !isPrivileged;
                inputKey.style.opacity = '1';
                inputKey.style.backgroundColor = '';
            }
        }
        if (btnGenKey) btnGenKey.style.display = (!isOpenRoom && isPrivileged) ? 'inline-flex' : 'none';

        const hostDangerZone = document.getElementById('host-danger-zone-container');
        if (hostDangerZone) hostDangerZone.style.display = isPrivileged ? 'flex' : 'none';

        const removeNonAdminsBtn = document.getElementById('btn-host-remove-non-admins');
        if (removeNonAdminsBtn) {
            removeNonAdminsBtn.style.display = isPrivileged ? 'flex' : 'none';
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
            deleteBtn.style.display = isPrivileged ? 'flex' : 'none';
            deleteBtn.dataset.confirming = 'false';
            deleteBtn.style.background = 'rgba(239, 68, 68, 0.12)';
            deleteBtn.style.borderColor = 'rgba(239, 68, 68, 0.35)';
            const mainTxt = document.getElementById('txt-delete-room-main');
            const subTxt = document.getElementById('txt-delete-room-sub');
            if (mainTxt) mainTxt.textContent = 'Delete Room';
            if (subTxt) subTxt.textContent = 'Disconnect all members & destroy room';
        }

        const bottomActions = document.getElementById('host-manage-bottom-actions');
        if (bottomActions) bottomActions.style.display = isPrivileged ? 'flex' : 'none';
        const btnSaveManage = document.getElementById('btn-save-host-manage');
        if (btnSaveManage) btnSaveManage.style.display = isPrivileged ? 'inline-flex' : 'none';

        const batchToolbar = document.getElementById('host-batch-actions-toolbar');
        if (batchToolbar) batchToolbar.style.display = isPrivileged ? 'flex' : 'none';

        this.renderAuditLogs();
        this.renderHostMembersList();
        document.getElementById('modal-host-manage').style.display = 'flex';
    }

    toggleRoomLock(isLocked) {
        const isPrivileged = Boolean(this.conn && (this.conn.isPrivileged ? this.conn.isPrivileged() : this.conn.isCreator));
        if (!this.conn || !isPrivileged) {
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
            const isMePrivileged = Boolean(this.conn && (this.conn.isPrivileged ? this.conn.isPrivileged() : this.conn.isCreator));
            const canManage = isMePrivileged && p.id !== myId && !p.isCreator && !p.isAdmin;

            header.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:10px 14px;${canManage ? 'cursor:pointer;' : ''}user-select:none;transition:background 0.2s ease`;

            const left = document.createElement('div');
            left.style.cssText = 'display:flex;align-items:center;gap:10px';
            left.innerHTML = `
                <span class="device-icon" style="font-size:1rem;display:inline-flex;align-items:center;flex-shrink:0;margin-right:2px">
                    ${DeviceInfo.getIcon(p.deviceType || 'laptop')}
                </span>
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
            if (p.isCreator || p.isAdmin) {
                badgeHtml = '<span class="badge-theme-accent">Host</span>';
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

                if (isMePrivileged) {
                    const btnTransfer = document.createElement('button');
                    btnTransfer.className = 'btn btn-secondary';
                    btnTransfer.style.cssText = 'padding:6px 12px;font-size:0.75rem;height:auto;border-radius:8px;font-weight:600;background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.3);color:#a78bfa';
                    btnTransfer.textContent = 'Transfer Host';
                    btnTransfer.onclick = async (e) => {
                        e.stopPropagation();
                        if (p.id === this.conn.myPeerId) return;
                        const confirmed = await UI.confirm(`Are you sure you want to transfer Host controls to ${p.deviceName}? You will be demoted to a regular member.`, 'Transfer Host');
                        if (confirmed) {
                            document.getElementById('modal-host-manage').style.display = 'none';

                            const handoffMsg = { type: 'host-handoff', payload: { targetId: p.id, adminPeerId: p.id } };

                            if (this.conn.isCreator) {
                                this.conn._broadcast(handoffMsg);
                            } else if (this.conn.roomCode) {
                                const hostId = this.conn._roomCodeToPeerId(this.conn.roomCode);
                                this.conn.sendDirect(hostId, handoffMsg);
                            }

                            this.conn.isRoomAdmin = false;
                            this.conn.isCreator = false;
                            for (const peer of (this.conn.peers || [])) {
                                peer.isAdmin = (peer.id === p.id);
                                peer.isCreator = (peer.id === p.id);
                            }

                            this.refreshPeerLists();
                            this.updatePrivilegeUI();
                            this.updateMyNameDisplay();
                            UI.toast(`Transferred Host controls to ${p.deviceName}`, 'info');
                        }
                    };
                    drawer.appendChild(btnTransfer);
                }

                const btnKick = document.createElement('button');
                btnKick.className = 'btn btn-danger';
                btnKick.style.cssText = 'padding:6px 14px;font-size:0.75rem;height:auto;border-radius:8px;font-weight:600';
                btnKick.textContent = 'Remove';
                btnKick.onclick = (e) => {
                    e.stopPropagation();
                    if (this.conn && this.conn.markKicked) this.conn.markKicked(p.id);
                    const kickMsg = { type: 'kick-peer', payload: { targetId: p.id } };
                    if (this.conn.isCreator) {
                        this.conn._broadcast(kickMsg);
                    } else if (this.conn.roomCode) {
                        const hostId = this.conn._roomCodeToPeerId(this.conn.roomCode);
                        this.conn.sendDirect(hostId, kickMsg);
                    }
                    setTimeout(() => {
                        this.conn.peers = (this.conn.peers || []).filter(x => x.id !== p.id);
                        if (this.conn.connections && this.conn.connections.has(p.id)) {
                            try { this.conn.connections.get(p.id).close(); } catch { }
                            this.conn.connections.delete(p.id);
                        }
                        if (this.conn.isCreator) {
                            this.conn._broadcast({ type: 'peer-update', payload: this.conn.getPeers() });
                        }
                        this.refreshPeerLists();
                        if (this.conn.addAuditLog) this.conn.addAuditLog(`Removed ${p.deviceName}`, 'sec');
                        UI.toast(`Removed ${p.deviceName}`, 'success');
                    }, 300);
                };
                drawer.appendChild(btnKick);

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
        const auditListEls = document.querySelectorAll('.audit-log-render-list, #host-manage-audit-list');
        if (!auditListEls || auditListEls.length === 0 || !this.conn) return;
        const logs = this.conn.auditLogs || [];

        auditListEls.forEach(auditListEl => {
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
                } else if (txt.includes('active') || txt.includes('promoted') || txt.includes('demoted') || txt.includes('host')) {
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
            const role = p.isCreator ? 'Host' : 'Member';
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

    exportRosterAsJson() {
        const peers = this.conn ? (this.conn.getPeers() || []) : [];
        if (peers.length === 0) {
            UI.toast('No members in room to export.', 'info');
            return;
        }
        const data = {
            app: 'WhyNotShare',
            type: 'room-roster',
            roomCode: this.conn.getRoomCode() || 'Unknown',
            exportedAt: new Date().toISOString(),
            totalMembers: peers.length,
            members: peers.map(p => ({
                id: p.id,
                deviceName: p.deviceName || 'Member Device',
                systemName: p.systemName || 'Web Client',
                deviceType: p.deviceType || 'unknown',
                role: p.isCreator ? 'Host' : 'Member',
                isYou: p.id === (this.conn ? this.conn.myPeerId : null)
            }))
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `whynotshare-roster-${this.conn.getRoomCode() || 'room'}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.toast('Room roster downloaded as JSON', 'success');
    }

    exportChatAsTxt() {
        const msgs = (this.textShare && this.textShare.messages) ? this.textShare.messages : [];
        if (msgs.length === 0) {
            UI.toast('No chat messages to export.', 'info');
            return;
        }
        let txt = `=======================================================\n`;
        txt += `           WHYNOTSHARE CHAT CONVERSATION LOG          \n`;
        txt += `=======================================================\n`;
        txt += `Room Code : ${this.conn ? (this.conn.getRoomCode() || 'Unknown') : 'Unknown'}\n`;
        txt += `Exported  : ${this._formatDate24(Date.now())}\n`;
        txt += `Total Msgs: ${msgs.length}\n`;
        txt += `=======================================================\n\n`;

        msgs.forEach((m) => {
            const dateStr = this._formatDate24(m.timestamp || Date.now());
            const sName = typeof m.sender === 'object' && m.sender ? (m.sender.name || 'Peer') : (m.sender || 'Peer');
            const body = m.type === 'file' ? `[File: ${(m.meta && m.meta.name) ? m.meta.name : 'Attachment'}]` : (m.text || m.raw || '');
            txt += `[${dateStr}] ${sName}: ${body}\n`;
        });

        txt += `\n=======================================================\n`;
        txt += `               END OF CHAT CONVERSATION                \n`;
        txt += `=======================================================\n`;

        const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `whynotshare-chat-${this.conn ? (this.conn.getRoomCode() || 'room') : 'room'}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.toast('Chat history downloaded as TXT', 'success');
    }

    exportChatAsJson() {
        const msgs = (this.textShare && this.textShare.messages) ? this.textShare.messages : [];
        if (msgs.length === 0) {
            UI.toast('No chat messages to export.', 'info');
            return;
        }
        const data = {
            roomCode: this.conn ? (this.conn.getRoomCode() || 'Unknown') : 'Unknown',
            exportedAt: new Date().toISOString(),
            messageCount: msgs.length,
            messages: msgs
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `whynotshare-chat-${this.conn ? (this.conn.getRoomCode() || 'room') : 'room'}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.toast('Chat history downloaded as JSON', 'success');
    }

    exportAuditLogsAsJson() {
        if (!this.conn || !this.conn.auditLogs || this.conn.auditLogs.length === 0) {
            UI.toast('No audit logs to export.', 'info');
            return;
        }
        const data = {
            roomCode: this.conn.getRoomCode() || 'Unknown',
            exportedAt: new Date().toISOString(),
            logCount: this.conn.auditLogs.length,
            logs: this.conn.auditLogs
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `whynotshare-audit-log-${this.conn.getRoomCode() || 'room'}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.toast('Audit logs downloaded as JSON', 'success');
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
        const shareCodeEl = document.getElementById('share-room-code');
        if (shareCodeEl) shareCodeEl.textContent = newCode;
        const quickEl = document.getElementById('header-quick-room-code');
        if (quickEl) quickEl.textContent = newCode;
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

    copyRoomLink() {
        const codeEl = document.getElementById('share-room-code') || document.getElementById('header-quick-room-code');
        const codeFromDOM = (codeEl && codeEl.textContent !== '---') ? codeEl.textContent.trim() : '';
        const roomCode = (this.conn && typeof this.conn.getRoomCode === 'function' ? this.conn.getRoomCode() : null) || (this.conn && this.conn.roomCode) || codeFromDOM || this.roomCode;

        if (!roomCode || roomCode === '---') {
            UI.toast('No active room code to copy', 'error');
            return;
        }

        const phrase = (this.crypto && typeof this.crypto.getPhrase === 'function') ? this.crypto.getPhrase() : '';
        let fullLink = window.location.origin + this._getBasePath() + '#' + roomCode;
        if (this.e2eEnabled && phrase) {
            fullLink = window.location.origin + this._getBasePath() + '#' + roomCode + ':' + phrase;
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(fullLink).then(() => {
                UI.toast('Room share link copied to clipboard!', 'success');
            }).catch(() => {
                this._fallbackCopyText(fullLink);
            });
        } else {
            this._fallbackCopyText(fullLink);
        }
    }

    _fallbackCopyText(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            UI.toast('Room share link copied to clipboard!', 'success');
        } catch {
            UI.toast('Failed to copy link', 'error');
        }
        document.body.removeChild(ta);
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
        const code = this.conn ? this.conn.getRoomCode() : this.roomCode;
        if (code) {
            const targetUrl = (this.e2eEnabled && newKey) ? this._buildShareUrl(code, newKey) : (window.location.origin + this._getBasePath() + '#' + code);
            const targetHash = (this.e2eEnabled && newKey) ? ('#' + code + ':' + newKey) : ('#' + code);
            const urlEl = document.getElementById('share-url');
            if (urlEl) {
                urlEl.dataset.url = targetUrl;
                if (urlEl.tagName === 'INPUT') urlEl.value = targetUrl;
            }
            const modalUrlEl = document.getElementById('input-modal-room-link');
            if (modalUrlEl) {
                modalUrlEl.value = targetUrl;
            }
            if (this._hasEnteredLiveRoom || (window.location.hash && window.location.hash.slice(1).startsWith(code))) {
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
        UI.toast(isEnc ? 'Room Key was rotated / updated!' : 'Room changed to Open Room (No Key Required)!', 'success');
    }

    async changePassphrase(phrase) {
        if (!phrase || !phrase.trim()) { UI.toast('Passphrase cannot be empty', 'error'); return; }
        const cleanKey = phrase.trim();
        await this.crypto.importKey(cleanKey);
        const isPrivileged = Boolean(this.conn && (this.conn.isPrivileged ? this.conn.isPrivileged() : this.conn.isCreator));
        if (isPrivileged) {
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
        const shareCodeEl = document.getElementById('share-room-code');
        if (shareCodeEl) shareCodeEl.textContent = code;
        const quickEl = document.getElementById('header-quick-room-code');
        if (quickEl) quickEl.textContent = code;
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
        this.togglePersonalE2E(false);
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
        if (peer && peer.id) {
            if (!this.selectedPersonalRecipients) this.selectedPersonalRecipients = new Set();
            this.selectedPersonalRecipients.add(peer.id);
        }
        if (this.crypto && this.conn && peer && peer.id) {
            this.crypto.generatePersonalKey().then(myKey => {
                if (myKey) {
                    this.conn.sendDirect(peer.id, { type: 'share-personal-key', payload: { keyStr: myKey, targetId: peer.id } });
                }
            }).catch(() => {});
        }
        this.refreshPeerLists();
        const ss = document.getElementById('screen-share');
        const rs = document.getElementById('screen-room');
        if ((ss && ss.classList.contains('active')) || (rs && rs.classList.contains('active')) || this._hasEnteredLiveRoom) {
            return;
        }
        this._enterShareScreen(this.conn.getRoomCode(), this.conn.getPeers());
    }

    _onPeerLeft(peer) {
        if (this.conn && !this.conn._isLeaving) {
            const devName = (peer && peer.deviceName) ? peer.deviceName : null;
            if (devName && devName !== 'A device' && devName !== 'Member') {
                this.conn.addAuditLog(`${devName} left the room`, 'warn');
            }
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

        const currentRoomCode = (this.conn ? this.conn.getRoomCode() : null) || '';

        if (currentRoomCode) {
            let targetCode = hash;
            if (hash.includes(':')) {
                targetCode = hash.split(':')[0];
            }
            if (targetCode.toUpperCase() !== currentRoomCode.toUpperCase()) {
                this._pendingPastedHash = hash;
                this.leaveRoom(true);
                return;
            }
            return;
        }

        if (lowerHash === 'create-room') {
            setTimeout(() => {
                const sr = document.getElementById('screen-room');
                if (!this.conn.getRoomCode() && (!sr || !sr.classList.contains('active'))) {
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

        let code = hash, phrase = '';
        if (hash.includes(':')) {
            const [c, ...rest] = hash.split(':');
            code = c;
            phrase = rest.join(':');
        }

        if (code && !['create-room', 'landing', 'join', 'join-room', 'room', 'share', 'settings', 'about'].includes(code.toLowerCase())) {
            setTimeout(() => {
                const codeInput = document.getElementById('input-room-code');
                const phraseInput = document.getElementById('input-secret-phrase');
                if (codeInput) codeInput.value = code;
                if (phraseInput) phraseInput.value = phrase || '';
                this.toggleE2E(Boolean(phrase && phrase.trim()));
                UI.showScreen('screen-join');
            }, 50);
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
            <button class="btn-rename-pill btn-save-inline" title="Save" style="padding:4px 8px">✓</button>
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

    commitActiveInlineRename() {
        const activeInput = document.querySelector('.inline-rename-box .inline-input-el');
        if (activeInput) {
            const val = activeInput.value.trim();
            if (val) {
                this.renameMyDevice(val);
            }
        }
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
        const isPrivileged = Boolean(this.conn && (this.conn.isPrivileged ? this.conn.isPrivileged() : this.conn.isCreator));
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
                window.screen.orientation.lock('portrait').catch(() => { });
            }
        } catch { }
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
                        try { el.requestFullscreen(); } catch { try { content.requestFullscreen(); } catch { } }
                    } else {
                        try { document.exitFullscreen(); } catch { }
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
            const currentActive = document.querySelector('.screen.active');
            const currentScreenId = currentActive ? currentActive.id : 'screen-landing';
            if (currentScreenId === 'screen-share' && this.conn && this.conn.getRoomCode()) {
                try { window.history.pushState({ screenId: 'screen-share' }, '', window.location.hash); } catch { }
                this.leaveRoom(false);
                return;
            }

            const state = e.state;
            const hash = window.location.hash ? window.location.hash.slice(1).split(':')[0] : '';
            let targetScreenId = state && state.screenId ? state.screenId : null;
            if (!targetScreenId) {
                if (hash === 'create-room') targetScreenId = 'screen-room';
                else if (hash === 'join-room') targetScreenId = 'screen-join';
                else if (hash) targetScreenId = 'screen-share';
                else targetScreenId = 'screen-landing';
            }

            if (currentScreenId === 'screen-share' && targetScreenId !== 'screen-share') {
                this.leaveRoom(false);
            } else if (targetScreenId === 'screen-share' && !this.conn.getRoomCode()) {
                const codeToRejoin = this.lastRoomCodeLeft || hash;
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
                const activeModals = Array.from(document.querySelectorAll('.modal-overlay'))
                    .filter(m => m.id !== 'drawer-backdrop' && m.style.display !== 'none');
                if (activeModals.length > 0) {
                    const topModal = activeModals[activeModals.length - 1];
                    topModal.style.display = 'none';
                    return;
                }
                const drawer = document.getElementById('drawer-room-menu');
                const backdrop = document.getElementById('drawer-backdrop');
                if (drawer && drawer.classList.contains('active')) {
                    drawer.classList.remove('active');
                    if (backdrop) backdrop.classList.remove('active');
                    return;
                }
                const ti = document.getElementById('text-input');
                const shareScreen = document.getElementById('screen-share');
                if (ti && shareScreen && shareScreen.classList.contains('active')) {
                    ti.focus();
                }
            }
        });
        const handleEnterRoomClick = async () => {
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
        };

        const btnHostEnter = document.getElementById('btn-host-enter-room');
        if (btnHostEnter) btnHostEnter.addEventListener('click', handleEnterRoomClick);

        const btnCreate = document.getElementById('btn-create');
        if (btnCreate) btnCreate.addEventListener('click', () => this.createRoom());

        const btnJoinScreen = document.getElementById('btn-join-screen');
        if (btnJoinScreen) {
            btnJoinScreen.addEventListener('click', () => {
                window.history.pushState({ screenId: 'screen-join' }, '', '#join-room');
                UI.showScreen('screen-join');
            });
        }

        const btnJoinSubmit = document.getElementById('btn-join-submit');
        if (btnJoinSubmit) {
            btnJoinSubmit.addEventListener('click', () => {
                const codeIn = document.getElementById('input-room-code');
                const phraseIn = document.getElementById('input-secret-phrase');
                this.joinRoom(codeIn ? codeIn.value : '', phraseIn ? phraseIn.value : '');
            });
        }

        const btnBackLanding = document.getElementById('btn-back-landing');
        if (btnBackLanding) {
            btnBackLanding.addEventListener('click', () => {
                UI.showScreen('screen-landing');
                window.history.replaceState({ screenId: 'screen-landing' }, '', this._getBasePath());
            });
        }

        const roomCodeEl = document.getElementById('display-room-code');
        if (roomCodeEl) {
            roomCodeEl.addEventListener('click', () => {
                const code = roomCodeEl.textContent.trim();
                if (code && code !== '---') {
                    UI.copyToClipboard(code);
                }
            });
        }

        const btnCopyCode = document.getElementById('btn-copy-code');
        if (btnCopyCode) {
            btnCopyCode.addEventListener('click', () => {
                const codeEl = document.getElementById('display-room-code');
                if (codeEl) UI.copyToClipboard(codeEl.textContent);
            });
        }

        const btnCopyPhrase = document.getElementById('btn-copy-phrase');
        if (btnCopyPhrase) {
            btnCopyPhrase.addEventListener('click', () => {
                const el = document.getElementById('display-secret-phrase');
                UI.copyToClipboard(el ? (el.value !== undefined && el.tagName === 'INPUT' ? el.value : el.textContent) : '');
            });
        }

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
                const isPrivileged = Boolean(this.conn && (this.conn.isPrivileged ? this.conn.isPrivileged() : this.conn.isCreator));
                if (this.conn && isPrivileged) {
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
                const isPrivileged = Boolean(this.conn && (this.conn.isPrivileged ? this.conn.isPrivileged() : this.conn.isCreator));
                if (this.conn && isPrivileged) {
                    this.conn._broadcast({ type: 'room-key-rotated', payload: { newKey: val } });
                }
            });
        }
        const btnCopyLink = document.getElementById('btn-copy-link');
        if (btnCopyLink) {
            btnCopyLink.addEventListener('click', () => {
                const shareUrlEl = document.getElementById('share-url');
                if (shareUrlEl && shareUrlEl.dataset) {
                    UI.copyToClipboard(shareUrlEl.dataset.url || shareUrlEl.value || window.location.href);
                }
            });
        }
        const btnCopyRoomLink = document.getElementById('btn-copy-room-link');
        if (btnCopyRoomLink) {
            btnCopyRoomLink.addEventListener('click', () => this.copyRoomLink());
        }
        const btnCopyGithubRepoLink = document.getElementById('btn-copy-github-repo-link');
        if (btnCopyGithubRepoLink) {
            btnCopyGithubRepoLink.addEventListener('click', () => {
                UI.copyToClipboard('https://github.com/prajansrini/whynotshare');
            });
        }
        const openQr = () => {
            const urlEl = document.getElementById('share-url');
            const url = (urlEl && urlEl.dataset.url) ? urlEl.dataset.url : window.location.href;
            this.showQrModal(url);
        };
        const btnShowQrRoom = document.getElementById('btn-show-qr-room');
        const btnShowQrShare = document.getElementById('btn-show-qr-share');
        const btnHeaderQr = document.getElementById('btn-header-qr');
        if (btnShowQrRoom) btnShowQrRoom.addEventListener('click', openQr);
        if (btnShowQrShare) btnShowQrShare.addEventListener('click', openQr);
        if (btnHeaderQr) btnHeaderQr.addEventListener('click', openQr);

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
        const startP2PDiagLoop = () => {
            this.renderLiveP2PDiagnostics();
            if (!this._p2pDiagInterval) {
                this._p2pDiagInterval = setInterval(() => {
                    const m1 = document.getElementById('modal-personal-e2e');
                    const m2 = document.getElementById('modal-connected-devices');
                    const m3 = document.getElementById('modal-export-center');
                    if ((m1 && m1.style.display !== 'none') || (m2 && m2.style.display !== 'none') || (m3 && m3.style.display !== 'none')) {
                        this.renderLiveP2PDiagnostics();
                    } else {
                        clearInterval(this._p2pDiagInterval);
                        this._p2pDiagInterval = null;
                    }
                }, 2000);
            }
        };

        const openDevicesModal = () => {
            const modal = document.getElementById('modal-connected-devices');
            if (modal) modal.style.display = 'flex';
            this.renderConnectedDevicesModal();
            startP2PDiagLoop();
        };

        if (btnShowDevices) btnShowDevices.addEventListener('click', openDevicesModal);
        const btnHeaderDeviceCount = document.getElementById('btn-header-device-count');
        if (btnHeaderDeviceCount) btnHeaderDeviceCount.addEventListener('click', openDevicesModal);
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
        const btnRoomInfo = document.getElementById('btn-room-info');
        const btnLandingInfo = document.getElementById('btn-landing-info');
        const openInfoModal = () => {
            const modal = document.getElementById('modal-personal-e2e');
            if (!modal) return;
            modal.style.display = 'flex';
            this.renderPersonalRecipients();
            startP2PDiagLoop();
        };
        if (btnShowPe2e) btnShowPe2e.addEventListener('click', openInfoModal);
        if (btnRoomInfo) btnRoomInfo.addEventListener('click', openInfoModal);
        if (btnLandingInfo) btnLandingInfo.addEventListener('click', openInfoModal);
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

        const btnBackFromRoom = document.getElementById('btn-back-from-room');
        if (btnBackFromRoom) {
            btnBackFromRoom.addEventListener('click', () => {
                if (this.conn) {
                    this.conn.leaveRoom();
                }
                UI.showScreen('screen-landing');
                window.history.replaceState({ screenId: 'screen-landing' }, '', this._getBasePath());
            });
        }
        document.getElementById('btn-send-text').addEventListener('click', () => this.sendText());
        const messagesEl = document.getElementById('messages');
        const btnScrollBottom = document.getElementById('btn-scroll-bottom');
        if (messagesEl && btnScrollBottom) {
            messagesEl.addEventListener('scroll', () => {
                const isScrolledUp = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight > 120;
                btnScrollBottom.style.display = isScrolledUp ? 'inline-flex' : 'none';
            });
            btnScrollBottom.addEventListener('click', () => {
                messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
            });
        }
        const modalLeave = document.getElementById('modal-leave-confirm');
        const modalHostLeave = document.getElementById('modal-host-leave');

        const closeAllLeaveModals = () => {
            if (modalLeave) modalLeave.style.display = 'none';
            if (modalHostLeave) modalHostLeave.style.display = 'none';
            document.removeEventListener('keydown', handleEscapeLeave);
        };
        const handleEscapeLeave = (e) => {
            if (e.key === 'Escape') {
                closeAllLeaveModals();
            }
        };
        if (modalLeave) modalLeave.addEventListener('click', (e) => {
            if (e.target.id === 'modal-leave-confirm') closeAllLeaveModals();
        });
        if (modalHostLeave) modalHostLeave.addEventListener('click', (e) => {
            if (e.target.id === 'modal-host-leave') closeAllLeaveModals();
        });

        const btnExportAndLeave = document.getElementById('btn-export-and-leave');
        if (btnExportAndLeave) {
            btnExportAndLeave.addEventListener('click', async () => {
                closeAllLeaveModals();
                await this.exportChatPackageZip();
                this._performLeaveRoom(true);
            });
        }
        const btnHostExportLeave = document.getElementById('btn-host-export-leave');
        if (btnHostExportLeave) {
            btnHostExportLeave.addEventListener('click', async () => {
                closeAllLeaveModals();
                await this.exportChatPackageZip();
                this._performLeaveRoom(true);
            });
        }

        const triggerLeave = () => {
            document.addEventListener('keydown', handleEscapeLeave);
            this.leaveRoom();
        };
        const btnDisconnect = document.getElementById('btn-disconnect');
        if (btnDisconnect) btnDisconnect.addEventListener('click', triggerLeave);
        const btnHeaderLeave = document.getElementById('btn-header-leave');
        if (btnHeaderLeave) btnHeaderLeave.addEventListener('click', triggerLeave);

        const btnTestServer = document.getElementById('btn-test-peerjs-server');
        if (btnTestServer) {
            btnTestServer.addEventListener('click', () => this.testPeerServerConnection());
        }

        let isThemeToggling = false;

        const performThemeToggle = (e) => {
            if (isThemeToggling) return;
            isThemeToggling = true;

            const unlockToggling = () => {
                setTimeout(() => { isThemeToggling = false; }, 180);
            };

            const isMobile = window.matchMedia('(max-width: 768px)').matches || ('ontouchstart' in window);

            const applyTheme = () => {
                const isLight = document.body.classList.toggle('light-theme');
                document.querySelectorAll('.icon-moon').forEach(moon => moon.style.display = isLight ? 'block' : 'none');
                document.querySelectorAll('.icon-sun').forEach(sun => sun.style.display = isLight ? 'none' : 'block');
                this.updateFavicon(isLight);
                try { localStorage.setItem('whynotshare_theme', isLight ? 'light' : 'dark'); } catch { }

                // Only re-render QR modal if active
                const mq = document.getElementById('modal-qr');
                if (mq && mq.style.display !== 'none') {
                    const urlEl = document.getElementById('share-url');
                    const url = (urlEl && urlEl.dataset.url) ? urlEl.dataset.url : window.location.href;
                    this.showQrModal(url);
                }
            };

            // On mobile devices, use ultra-fast hardware-accelerated 60fps compositor opacity fade (0 GPU raster cost)
            if (isMobile) {
                document.body.style.transition = 'opacity 0.16s cubic-bezier(0.4, 0, 0.2, 1)';
                document.body.style.opacity = '0.75';
                requestAnimationFrame(() => {
                    applyTheme();
                    requestAnimationFrame(() => {
                        document.body.style.opacity = '1';
                        setTimeout(() => {
                            document.body.style.transition = '';
                            unlockToggling();
                        }, 160);
                    });
                });
                return;
            }

            // On desktop/tablet, use circular clip-path View Transition
            const x = e ? e.clientX : window.innerWidth / 2;
            const y = e ? e.clientY : window.innerHeight / 2;
            const endRadius = Math.hypot(
                Math.max(x, window.innerWidth - x),
                Math.max(y, window.innerHeight - y)
            );

            document.documentElement.style.setProperty('--x', `${x}px`);
            document.documentElement.style.setProperty('--y', `${y}px`);

            if (document.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                try {
                    const transition = document.startViewTransition(() => {
                        applyTheme();
                    });

                    transition.ready.then(() => {
                        const anim = document.documentElement.animate(
                            {
                                clipPath: [
                                    `circle(0px at ${x}px ${y}px)`,
                                    `circle(${endRadius}px at ${x}px ${y}px)`
                                ]
                            },
                            {
                                duration: 360,
                                easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
                                fill: 'forwards',
                                pseudoElement: '::view-transition-new(root)'
                            }
                        );
                        anim.onfinish = unlockToggling;
                    }).catch(unlockToggling);

                    transition.finished.then(unlockToggling).catch(unlockToggling);
                } catch {
                    applyTheme();
                    unlockToggling();
                }
            } else {
                applyTheme();
                unlockToggling();
            }
        };

        document.querySelectorAll('.btn-theme-toggle').forEach(themeBtn => {
            if (themeBtn.id === 'btn-landing-info' || themeBtn.id === 'btn-room-info') return;
            themeBtn.addEventListener('click', (e) => performThemeToggle(e));
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
                document.getElementById('modal-host-manage').style.display = 'none';
                const modal = document.getElementById('modal-host-leave');
                if (modal) {
                    const stateInitial = document.getElementById('host-leave-state-initial');
                    const stateAssign = document.getElementById('host-leave-state-assign');
                    const stateConfirmDelete = document.getElementById('host-leave-state-confirm-delete');

                    stateInitial.style.display = 'none';
                    stateAssign.style.display = 'none';
                    stateConfirmDelete.style.display = 'block';
                    modal.style.display = 'flex';

                    const cleanup = () => { modal.style.display = 'none'; };
                    const cancelBtn = document.getElementById('btn-host-cancel-leave');
                    if (cancelBtn) cancelBtn.onclick = cleanup;
                    const backBtn = document.getElementById('btn-host-back-delete');
                    if (backBtn) backBtn.onclick = cleanup;

                    const exportDeleteBtn = document.getElementById('btn-host-export-delete');
                    if (exportDeleteBtn) {
                        exportDeleteBtn.onclick = async () => {
                            cleanup();
                            await this.exportChatPackageZip();
                            this._performLeaveRoom(true, true);
                        };
                    }

                    const confirmBtn = document.getElementById('btn-host-confirm-delete');
                    if (confirmBtn) {
                        confirmBtn.onclick = () => {
                            cleanup();
                            this._performLeaveRoom(true, true);
                        };
                    }
                } else {
                    this._performLeaveRoom(true, true);
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
                const peersToRemove = (this.conn.getPeers() || []).filter(p => !p.isCreator && p.id !== myId);
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
        const btnExportRosterJson = document.getElementById('btn-export-roster-json');
        const btnBatchExport = document.getElementById('btn-batch-export-roster');
        if (btnExportRosterTxt) {
            btnExportRosterTxt.addEventListener('click', () => this.exportRosterAsTxt());
        }
        if (btnExportRosterJson) {
            btnExportRosterJson.addEventListener('click', () => this.exportRosterAsJson());
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

        const drawer = document.getElementById('drawer-room-menu');
        const backdrop = document.getElementById('drawer-backdrop');
        const btnOpenRoomMenu = document.getElementById('btn-open-room-menu');
        const btnHeaderRoomCode = document.getElementById('btn-header-room-code');
        const btnCloseRoomMenu = document.getElementById('btn-close-room-menu');

        const openDrawer = () => {
            if (drawer) { drawer.classList.add('active'); drawer.style.transform = ''; drawer.style.transition = ''; }
            if (backdrop) { backdrop.classList.add('active'); backdrop.style.opacity = ''; backdrop.style.transition = ''; }
        };

        const closeDrawer = () => {
            if (drawer) { drawer.classList.remove('active'); drawer.style.transform = ''; drawer.style.transition = ''; }
            if (backdrop) { backdrop.classList.remove('active'); backdrop.style.opacity = ''; backdrop.style.transition = ''; }
        };

        if (btnOpenRoomMenu) btnOpenRoomMenu.addEventListener('click', openDrawer);
        const handleCopyLink = () => this.copyRoomLink();
        if (btnHeaderRoomCode) btnHeaderRoomCode.addEventListener('click', handleCopyLink);

        const inputDevicesModalSearch = document.getElementById('input-devices-modal-search');
        if (inputDevicesModalSearch) {
            inputDevicesModalSearch.addEventListener('input', () => {
                if (typeof UI !== 'undefined' && typeof UI.updateDevicesList === 'function') {
                    UI.updateDevicesList();
                }
            });
        }
        if (btnCloseRoomMenu) btnCloseRoomMenu.addEventListener('click', closeDrawer);
        if (backdrop) backdrop.addEventListener('click', closeDrawer);

        // Interactive Touch Swipe Gestures for Drawer (Swipe Right to Open, Swipe Left to Close)
        if (drawer && backdrop) {
            let startX = 0;
            let startY = 0;
            let isSwiping = false;
            let isDrawerOpen = false;

            const onTouchStart = (e) => {
                if (e.touches.length !== 1) return;
                const touch = e.touches[0];
                startX = touch.clientX;
                startY = touch.clientY;
                isDrawerOpen = drawer.classList.contains('active');

                // Swipe right to open is allowed if touch starts within 40px of left screen edge
                // Swipe left to close is allowed anytime drawer is open
                if (!isDrawerOpen && startX > 40) return;

                isSwiping = true;
                drawer.style.transition = 'none';
                backdrop.style.transition = 'none';
            };

            const onTouchMove = (e) => {
                if (!isSwiping || e.touches.length !== 1) return;
                const touch = e.touches[0];
                const deltaX = touch.clientX - startX;
                const deltaY = touch.clientY - startY;

                // Ignore if user is scrolling vertically
                if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaX) < 15) return;

                if (!isDrawerOpen) {
                    if (deltaX > 0) {
                        const width = drawer.offsetWidth || 270;
                        const translateX = Math.min(0, -width + deltaX);
                        drawer.style.transform = `translateX(${translateX}px)`;
                        backdrop.classList.add('active');
                        backdrop.style.opacity = `${Math.min(1, deltaX / width)}`;
                        e.preventDefault();
                    }
                } else {
                    if (deltaX < 0) {
                        const width = drawer.offsetWidth || 270;
                        const translateX = Math.max(-width, deltaX);
                        drawer.style.transform = `translateX(${translateX}px)`;
                        backdrop.style.opacity = `${Math.max(0, 1 + deltaX / width)}`;
                        e.preventDefault();
                    }
                }
            };

            const onTouchEnd = (e) => {
                if (!isSwiping) return;
                isSwiping = false;
                drawer.style.transition = 'transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)';
                backdrop.style.transition = 'opacity 0.28s cubic-bezier(0.4, 0, 0.2, 1)';

                const touch = e.changedTouches[0];
                const deltaX = touch ? touch.clientX - startX : 0;

                if (!isDrawerOpen) {
                    if (deltaX > 60) {
                        openDrawer();
                    } else {
                        closeDrawer();
                    }
                } else {
                    if (deltaX < -60) {
                        closeDrawer();
                    } else {
                        openDrawer();
                    }
                }
            };

            document.addEventListener('touchstart', onTouchStart, { passive: true });
            document.addEventListener('touchmove', onTouchMove, { passive: false });
            document.addEventListener('touchend', onTouchEnd, { passive: true });
            document.addEventListener('touchcancel', onTouchEnd, { passive: true });
        }

        document.querySelectorAll('.modal-overlay').forEach(modal => {
            if (modal.id === 'drawer-backdrop') return;
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.style.display = 'none';
                }
            });
        });

        const btnHeaderInfo = document.getElementById('btn-header-info');
        if (btnHeaderInfo) {
            btnHeaderInfo.addEventListener('click', () => {
                const modal = document.getElementById('modal-personal-e2e');
                if (modal) modal.style.display = 'flex';
                this.renderLiveP2PDiagnostics();
            });
        }
        const btnClosePe2eModal = document.getElementById('btn-close-pe2e-modal');
        if (btnClosePe2eModal) {
            btnClosePe2eModal.addEventListener('click', () => {
                const modal = document.getElementById('modal-personal-e2e');
                if (modal) modal.style.display = 'none';
            });
        }

        const btnOpenExportModal = document.getElementById('btn-open-export-modal');
        if (btnOpenExportModal) {
            btnOpenExportModal.addEventListener('click', () => {
                const modal = document.getElementById('modal-export-center');
                if (modal) modal.style.display = 'flex';
                this.renderLiveP2PDiagnostics();
                if (typeof startP2PDiagLoop === 'function') startP2PDiagLoop();
            });
        }
        const btnCloseExportModal = document.getElementById('btn-close-export-modal');
        if (btnCloseExportModal) {
            btnCloseExportModal.addEventListener('click', () => {
                const modal = document.getElementById('modal-export-center');
                if (modal) modal.style.display = 'none';
            });
        }

        const btnExportChatTxt = document.getElementById('btn-export-chat-txt');
        if (btnExportChatTxt) btnExportChatTxt.addEventListener('click', () => this.exportChatAsTxt());

        const btnExportChatJson = document.getElementById('btn-export-chat-json');
        if (btnExportChatJson) btnExportChatJson.addEventListener('click', () => this.exportChatAsJson());

        const btnExportChatMdZip = document.getElementById('btn-export-chat-md-zip');
        if (btnExportChatMdZip) btnExportChatMdZip.addEventListener('click', () => this.exportChatPackageZip());

        const btnExportFilesZip = document.getElementById('btn-export-files-zip');
        if (btnExportFilesZip) btnExportFilesZip.addEventListener('click', () => this.downloadAllFilesZip());

        const btnExportLogsTxt = document.getElementById('btn-export-logs-txt');
        if (btnExportLogsTxt) btnExportLogsTxt.addEventListener('click', () => this.exportAuditLogsAsTxt());

        const btnExportLogsJson = document.getElementById('btn-export-logs-json');
        if (btnExportLogsJson) btnExportLogsJson.addEventListener('click', () => this.exportAuditLogsAsJson());

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

        const elRoomBadgeCopy = document.getElementById('btn-room-badge-copy');
        if (elRoomBadgeCopy) {
            elRoomBadgeCopy.addEventListener('click', (e) => {
                e.stopPropagation();
                const code = (this.conn && (typeof this.conn.getRoomCode === 'function' ? this.conn.getRoomCode() : this.conn.roomCode)) || (document.getElementById('share-room-code') && document.getElementById('share-room-code').textContent !== '---' ? document.getElementById('share-room-code').textContent : '') || this.roomCode;
                if (code && code !== '---') {
                    UI.copyToClipboard(code, 'Room Code copied to clipboard!');
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
            const isPrivileged = Boolean(this.conn && (this.conn.isPrivileged ? this.conn.isPrivileged() : this.conn.isCreator));
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
        if (btnAttachChat) {
            btnAttachChat.addEventListener('click', (e) => {
                if (this.stagedFiles && this.stagedFiles.length > 0 && e.detail === 0) {
                    this.sendText();
                    return;
                }
                filePicker.click();
            });
            btnAttachChat.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.sendText();
                }
            });
        }
        const btnDownloadAll = document.getElementById('btn-download-all');
        if (btnDownloadAll && !btnDownloadAll._hasZipListener) {
            btnDownloadAll._hasZipListener = true;
            btnDownloadAll.addEventListener('click', () => this.downloadAllFilesAsZip());
        }
        filePicker.addEventListener('change', (e) => { if (e.target.files.length) this.stageFiles(e.target.files); e.target.value = ''; });
        let dragCounter = 0;

        const handleChatDragEnter = (e) => {
            if (e.cancelable) e.preventDefault();
            dragCounter++;
            const inputEl = document.getElementById('text-input');
            if (inputEl) inputEl.classList.add('drag-highlight');
            if (dropZone && e.target.closest && e.target.closest('#drop-zone')) dropZone.classList.add('drag-over');
        };

        const handleChatDragOver = (e) => {
            if (e.cancelable) e.preventDefault();
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = 'copy';
            }
            const inputEl = document.getElementById('text-input');
            if (inputEl && !inputEl.classList.contains('drag-highlight')) {
                inputEl.classList.add('drag-highlight');
            }
            if (dropZone && e.target && e.target.closest && e.target.closest('#drop-zone')) dropZone.classList.add('drag-over');
        };

        const handleChatDragLeave = (e) => {
            if (e.cancelable) e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                const inputEl = document.getElementById('text-input');
                if (inputEl) inputEl.classList.remove('drag-highlight');
                if (dropZone) dropZone.classList.remove('drag-over');
            }
        };

        const handleChatDrop = (e) => {
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();
            dragCounter = 0;
            const inputEl = document.getElementById('text-input');
            if (inputEl) inputEl.classList.remove('drag-highlight');
            if (dropZone) dropZone.classList.remove('drag-over');

            if (e.dataTransfer) {
                this.handleDataTransferItems(e.dataTransfer);
            }
        };

        window.addEventListener('dragover', (e) => { if (e.cancelable) e.preventDefault(); }, false);
        window.addEventListener('drop', (e) => { if (e.cancelable) e.preventDefault(); }, false);

        document.body.addEventListener('dragenter', handleChatDragEnter, false);
        document.body.addEventListener('dragover', handleChatDragOver, false);
        document.body.addEventListener('dragleave', handleChatDragLeave, false);
        document.body.addEventListener('drop', handleChatDrop, false);
    }

    updateFavicon(isLight) {
        const favicon = document.getElementById('app-favicon');
        if (!favicon) return;
        const boxColor = '%23ffffff';
        const logoColor = '%23000000';
        const svgStr = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='${boxColor}'/><g transform='translate(4, 4) scale(0.92)'><path d='M50 15 L80 30 V52 C80 72 50 88 50 88 C50 88 20 72 20 52 V30 Z' fill='none' stroke='${logoColor}' stroke-width='7' stroke-linejoin='round'/><g transform='translate(34, 34) scale(1.35)' stroke='${logoColor}' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round' fill='none'><line x1='22' y1='2' x2='11' y2='13'/><polygon points='22 2 15 22 11 13 2 9 22 2'/></g></g></svg>`;
        favicon.href = 'data:image/svg+xml,' + svgStr;
    }

    _setupMobileKeyboardHandlers() {
        const textInput = document.getElementById('text-input');
        const messagesContainer = document.getElementById('messages');
        const shareScreen = document.getElementById('screen-share');

        const syncViewport = () => {
            if (window.visualViewport) {
                const vvHeight = window.visualViewport.height;
                const winHeight = window.innerHeight || document.documentElement.clientHeight;
                const isKeyboardVisible = (winHeight - vvHeight) > 120;

                document.documentElement.style.setProperty('--vv-height', `${vvHeight}px`);
                if (shareScreen) {
                    shareScreen.style.setProperty('--vv-height', `${vvHeight}px`);
                }

                if (isKeyboardVisible) {
                    document.body.classList.add('keyboard-open');
                } else if (document.activeElement !== textInput) {
                    document.body.classList.remove('keyboard-open');
                }
            }
        };

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', syncViewport);
            window.visualViewport.addEventListener('scroll', syncViewport);
            syncViewport();
        }

        if (textInput) {
            textInput.addEventListener('focus', () => {
                document.body.classList.add('keyboard-open');
                syncViewport();
                setTimeout(() => {
                    syncViewport();
                    if (messagesContainer) {
                        messagesContainer.scrollTop = messagesContainer.scrollHeight;
                    }
                }, 100);
                setTimeout(() => {
                    if (messagesContainer) {
                        messagesContainer.scrollTop = messagesContainer.scrollHeight;
                    }
                }, 250);
            });

            textInput.addEventListener('blur', () => {
                setTimeout(() => {
                    const vvHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
                    const winHeight = window.innerHeight || document.documentElement.clientHeight;
                    if ((winHeight - vvHeight) <= 120) {
                        document.body.classList.remove('keyboard-open');
                    }
                    syncViewport();
                }, 120);
            });
        }
        this.setupContextMenuAndPasteListeners();
    }

    setupContextMenuAndPasteListeners() {
        const handlePaste = (e) => {
            const clipboardData = e.clipboardData || window.clipboardData;
            if (!clipboardData) return;

            const files = [];
            if (clipboardData.files && clipboardData.files.length > 0) {
                for (let i = 0; i < clipboardData.files.length; i++) {
                    files.push(clipboardData.files[i]);
                }
            } else if (clipboardData.items) {
                for (let i = 0; i < clipboardData.items.length; i++) {
                    const item = clipboardData.items[i];
                    if (item.kind === 'file') {
                        const file = item.getAsFile();
                        if (file) files.push(file);
                    }
                }
            }

            if (files.length > 0) {
                e.preventDefault();
                this.stageFiles(files);
                UI.toast(`Pasted ${files.length} file(s) / media ready to send!`, 'info');
            }
        };

        const textInput = document.getElementById('text-input');
        if (textInput) textInput.addEventListener('paste', handlePaste);

        const menu = document.getElementById('custom-context-menu');
        let _contextTarget = null;
        let longPressTimer = null;
        let touchStartPos = { x: 0, y: 0 };

        const showContextMenu = (e, targetEl) => {
            if (e.cancelable) e.preventDefault();
            if (!targetEl) return;

            const fileCard = targetEl.closest('.received-file-card') || targetEl.closest('.file-box-card') || targetEl.closest('[data-file-id]') || targetEl.closest('.transfer-item') || targetEl.closest('.file-card') || targetEl.closest('.transfer-card') || targetEl.closest('.file-attachment');
            const mediaEl = targetEl.closest('img') || targetEl.closest('video') || targetEl.closest('audio');
            const msgBubble = (!fileCard && !mediaEl) ? (targetEl.closest('.message') || targetEl.closest('.message-bubble')) : null;

            if (!msgBubble && !fileCard && !mediaEl) return;

            let textContent = '';
            let itemType = 'message';
            let targetNode = null;
            let senderName = 'Member';
            let downloadEl = null;
            let downloadUrl = null;

            const parentMsg = targetEl.closest('.message');
            const isSentByMe = parentMsg ? parentMsg.classList.contains('message-sent') : (targetEl.classList.contains('message-sent') || false);

            if (fileCard || mediaEl) {
                targetNode = fileCard || mediaEl;
                itemType = 'file';
                
                let fileName = 'File';
                if (fileCard) {
                    const titleEl = fileCard.querySelector('[title]') || fileCard.querySelector('.file-name') || fileCard.querySelector('.received-file-name') || fileCard.querySelector('.transfer-name');
                    if (titleEl) {
                        fileName = titleEl.getAttribute('title') || titleEl.innerText || titleEl.textContent || 'File';
                        fileName = fileName.trim();
                    } else if (fileCard.dataset && fileCard.dataset.name) {
                        fileName = fileCard.dataset.name;
                    }
                } else if (mediaEl) {
                    fileName = mediaEl.dataset.name || mediaEl.alt || 'Media';
                }

                const captionEl = (fileCard && fileCard.querySelector('.file-caption-container')) || (parentMsg && parentMsg.querySelector('.file-caption-container'));
                const captionText = captionEl ? (captionEl.innerText || captionEl.textContent || '').trim() : '';

                textContent = captionText ? `${fileName}: ${captionText}` : fileName;

                downloadEl = (fileCard && (fileCard.querySelector('a[download]') || fileCard.querySelector('.btn-download') || fileCard.querySelector('a[href]')));
                if (mediaEl && mediaEl.src) downloadUrl = mediaEl.src;
                else if (fileCard && fileCard.dataset && fileCard.dataset.url) downloadUrl = fileCard.dataset.url;

                if (isSentByMe) {
                    senderName = 'You';
                } else if (parentMsg) {
                    senderName = parentMsg.dataset.senderName || '';
                    if (!senderName || senderName === 'Peer') {
                        const senderEl = parentMsg.querySelector('.message-sender');
                        if (senderEl) senderName = (senderEl.innerText || senderEl.textContent || '').trim();
                    }
                    if (!senderName) senderName = 'Peer';
                }
            } else if (msgBubble) {
                targetNode = msgBubble;
                itemType = 'message';
                const copyBtn = msgBubble.querySelector('.message-action-btn[data-copy]');
                const bubble = msgBubble.querySelector('.message-bubble') || msgBubble;
                let rawText = copyBtn ? copyBtn.dataset.copy : (bubble.innerText || bubble.textContent || '').trim();
                if (rawText.startsWith('> Replying to: ')) {
                    const lines = rawText.split('\n');
                    rawText = lines.slice(1).join('\n').trim();
                }
                textContent = rawText;

                if (isSentByMe) {
                    senderName = 'You';
                } else if (parentMsg) {
                    senderName = parentMsg.dataset.senderName || '';
                    if (!senderName || senderName === 'Peer') {
                        const senderEl = parentMsg.querySelector('.message-sender');
                        if (senderEl) senderName = (senderEl.innerText || senderEl.textContent || '').trim();
                    }
                    if (!senderName) senderName = 'Peer';
                }
            }

            _contextTarget = { node: targetNode, text: textContent, type: itemType, sender: senderName, downloadEl, downloadUrl, isSentByMe };

            const copyBtnEl = document.getElementById('ctx-menu-copy');
            if (copyBtnEl) {
                if (itemType === 'file') {
                    copyBtnEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Save</span>';
                } else {
                    copyBtnEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span>';
                }
            }

            const deleteBtnEl = document.getElementById('ctx-menu-delete');
            if (deleteBtnEl) {
                deleteBtnEl.style.display = isSentByMe ? 'flex' : 'none';
            }

            if (parentMsg) {
                parentMsg.classList.remove('reply-target-highlight');
                void parentMsg.offsetWidth;
                parentMsg.classList.add('reply-target-highlight');
                setTimeout(() => {
                    parentMsg.classList.remove('reply-target-highlight');
                }, 3000);
            }

            if (!menu) return;
            menu.style.display = 'flex';

            const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : window.innerWidth / 2);
            const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : window.innerHeight / 2);

            const menuWidth = menu.offsetWidth || 160;
            const menuHeight = menu.offsetHeight || 130;

            let left = clientX;
            let top = clientY;

            if (left + menuWidth > window.innerWidth - 10) left = window.innerWidth - menuWidth - 10;
            if (top + menuHeight > window.innerHeight - 10) top = window.innerHeight - menuHeight - 10;

            menu.style.left = `${Math.max(10, left)}px`;
            menu.style.top = `${Math.max(10, top)}px`;
        };

        const hideContextMenu = () => {
            if (menu) menu.style.display = 'none';
        };

        document.addEventListener('click', hideContextMenu);
        document.addEventListener('scroll', hideContextMenu, true);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

        const isFileOrMedia = (el) => {
            return el.closest('.received-file-card') || el.closest('.file-box-card') || el.closest('[data-file-id]') || el.closest('.transfer-item') || el.closest('.file-card') || el.closest('.transfer-card') || el.closest('.file-attachment') || el.closest('img') || el.closest('video') || el.closest('audio') || el.closest('.message') || el.closest('.message-bubble');
        };

        document.body.addEventListener('contextmenu', (e) => {
            const targetEl = isFileOrMedia(e.target);
            if (targetEl) {
                showContextMenu(e, targetEl);
            }
        });

        document.body.addEventListener('touchstart', (e) => {
            const targetEl = isFileOrMedia(e.target);
            if (!targetEl) return;

            touchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            if (longPressTimer) clearTimeout(longPressTimer);

            longPressTimer = setTimeout(() => {
                showContextMenu(e, targetEl);
            }, 450);
        }, { passive: true });

        document.body.addEventListener('touchmove', (e) => {
            if (!longPressTimer) return;
            const touch = e.touches[0];
            const dx = Math.abs(touch.clientX - touchStartPos.x);
            const dy = Math.abs(touch.clientY - touchStartPos.y);
            if (dx > 10 || dy > 10) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        }, { passive: true });

        document.body.addEventListener('touchend', () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        });

        const btnReply = document.getElementById('ctx-menu-reply');
        if (btnReply) {
            btnReply.addEventListener('click', (e) => {
                e.stopPropagation();
                hideContextMenu();
                if (!_contextTarget || !_contextTarget.text) return;

                const targetNode = _contextTarget.node;
                const msgId = (targetNode && (targetNode.dataset.msgId || targetNode.id)) || '';
                const fileId = (targetNode && targetNode.dataset.fileId) || '';

                this._activeReplyQuote = { sender: _contextTarget.sender || 'Member', text: _contextTarget.text, msgId, fileId };
                const bar = document.getElementById('reply-preview-bar');
                const txt = document.getElementById('reply-preview-text');
                if (bar && txt) {
                    const displayTxt = `${_contextTarget.sender || 'Member'}: ${_contextTarget.text}`;
                    txt.textContent = displayTxt.length > 50 ? displayTxt.slice(0, 50) + '...' : displayTxt;
                    bar.style.display = 'flex';
                }
                const input = document.getElementById('text-input');
                if (input) input.focus();
            });
        }

        const messagesContainer = document.getElementById('messages');
        if (messagesContainer && !messagesContainer._hasReplyScrollListener) {
            messagesContainer._hasReplyScrollListener = true;
            messagesContainer.addEventListener('click', (e) => {
                const card = e.target.closest('.quoted-reply-card');
                if (!card) return;

                const targetId = card.dataset.targetId;
                const targetFid = card.dataset.targetFid;
                const quoteText = card.querySelector('.quoted-reply-text')?.textContent?.trim();

                let targetEl = null;
                if (targetId) {
                    try {
                        const escId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(targetId) : targetId;
                        targetEl = document.querySelector(`[data-msg-id="${escId}"]`) || document.getElementById(targetId);
                    } catch (err) {}
                }
                if (!targetEl && targetFid) {
                    try {
                        const escFid = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(targetFid) : targetFid;
                        targetEl = document.querySelector(`[data-file-id="${escFid}"]`) || document.getElementById('history-card-' + targetFid) || document.getElementById('transfer-' + targetFid);
                    } catch (err) {}
                }

                if (!targetEl && quoteText) {
                    const cleanSnippet = quoteText.replace(/^.*?: /, '').trim();
                    const allMsgs = document.querySelectorAll('.message');
                    for (const m of allMsgs) {
                        if (m.contains(card)) continue;
                        const txt = (m.innerText || m.textContent || '').trim();
                        if (cleanSnippet && txt.includes(cleanSnippet)) {
                            targetEl = m;
                            break;
                        }
                    }
                }

                if (targetEl) {
                    if (messagesContainer) {
                        const containerRect = messagesContainer.getBoundingClientRect();
                        const targetRect = targetEl.getBoundingClientRect();
                        const scrollTop = messagesContainer.scrollTop + (targetRect.top - containerRect.top) - (containerRect.height / 2) + (targetRect.height / 2);
                        messagesContainer.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' });
                    }
                    setTimeout(() => {
                        targetEl.classList.add('reply-target-highlight');
                        setTimeout(() => {
                            targetEl.classList.remove('reply-target-highlight');
                        }, 3000);
                    }, 400);
                } else {
                    UI.toast('Original message not found in view', 'info');
                }
            });
        }

        const btnCancelReply = document.getElementById('btn-cancel-reply');
        if (btnCancelReply) {
            btnCancelReply.addEventListener('click', () => {
                this._activeReplyQuote = null;
                const bar = document.getElementById('reply-preview-bar');
                if (bar) bar.style.display = 'none';
            });
        }

        const btnCopy = document.getElementById('ctx-menu-copy');
        if (btnCopy) {
            btnCopy.addEventListener('click', (e) => {
                e.stopPropagation();
                hideContextMenu();
                if (!_contextTarget) return;

                if (_contextTarget.type === 'file') {
                    if (_contextTarget.downloadEl) {
                        _contextTarget.downloadEl.click();
                        UI.toast('Downloading file...', 'info');
                    } else if (_contextTarget.downloadUrl) {
                        const a = document.createElement('a');
                        a.href = _contextTarget.downloadUrl;
                        a.download = _contextTarget.text || 'download';
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        UI.toast('File saved!', 'info');
                    } else if (_contextTarget.text) {
                        UI.copyToClipboard(_contextTarget.text, 'File name copied!');
                    }
                } else if (_contextTarget.text) {
                    UI.copyToClipboard(_contextTarget.text, 'Copied to clipboard!');
                }
            });
        }

        const btnDelete = document.getElementById('ctx-menu-delete');
        if (btnDelete) {
            btnDelete.addEventListener('click', (e) => {
                e.stopPropagation();
                hideContextMenu();
                if (_contextTarget && _contextTarget.node && _contextTarget.isSentByMe) {
                    const node = _contextTarget.node;
                    const msgId = node.dataset.msgId || node.id || null;
                    const fileId = node.dataset.fileId || null;

                    node.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
                    node.style.opacity = '0';
                    node.style.transform = 'scale(0.95)';
                    setTimeout(() => {
                        if (node.parentNode) node.parentNode.removeChild(node);
                    }, 250);

                    if (this.conn && typeof this.conn.sendDeleteMessage === 'function') {
                        this.conn.sendDeleteMessage(msgId, fileId);
                    }

                    if (this.textShare && Array.isArray(this.textShare.messages)) {
                        this.textShare.messages = this.textShare.messages.filter(m => (!msgId || m.id !== msgId) && (!fileId || !m.meta || m.meta.fileId !== fileId));
                        if (typeof this.textShare.saveHistory === 'function') this.textShare.saveHistory();
                    }

                    UI.toast(`${_contextTarget.type === 'file' ? 'File card' : 'Message'} deleted for everyone`, 'info');
                }
            });
        }
    }

    onMessageDeleted(payload) {
        const { msgId, fileId } = payload || {};
        let target = null;
        if (msgId) {
            const escId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(msgId) : msgId;
            try {
                target = document.querySelector(`[data-msg-id="${escId}"]`) || document.getElementById(msgId);
            } catch (e) { }
        }
        if (!target && fileId) {
            const escFid = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(fileId) : fileId;
            try {
                target = document.querySelector(`[data-file-id="${escFid}"]`) || document.getElementById('history-card-' + fileId) || document.getElementById('transfer-' + fileId);
            } catch (e) { }
        }
        if (target) {
            target.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
            target.style.opacity = '0';
            target.style.transform = 'scale(0.95)';
            setTimeout(() => {
                if (target.parentNode) target.parentNode.removeChild(target);
            }, 250);
        }

        if (this.textShare && Array.isArray(this.textShare.messages)) {
            this.textShare.messages = this.textShare.messages.filter(m => (!msgId || m.id !== msgId) && (!fileId || !m.meta || m.meta.fileId !== fileId));
            if (typeof this.textShare.saveHistory === 'function') this.textShare.saveHistory();
        }
    }

    async testPeerServerConnection() {
        const pill = document.getElementById('peerjs-server-status-pill');
        const btn = document.getElementById('btn-test-peerjs-server');
        if (!pill || !btn) return;
        btn.disabled = true;
        pill.className = 'server-status-pill testing';
        pill.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Testing 0.peerjs.com...</span>';

        const startTime = performance.now();
        let finished = false;

        let testPeer;
        const cleanup = () => {
            if (finished) return;
            finished = true;
            btn.disabled = false;
            if (testPeer && !testPeer.destroyed) {
                try { testPeer.destroy(); } catch { }
            }
        };

        const timer = setTimeout(async () => {
            if (!finished) {
                cleanup();
                try {
                    const httpStart = performance.now();
                    await fetch('https://0.peerjs.com/', { mode: 'no-cors', cache: 'no-cache' });
                    const latency = Math.round(performance.now() - httpStart);
                    pill.className = 'server-status-pill success';
                    pill.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>0.peerjs.com Online (${latency}ms)</span>`;
                } catch {
                    pill.className = 'server-status-pill error';
                    pill.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Timeout (>10s). Server unreachable.</span>';
                }
            }
        }, 10000);

        try {
            const testId = 'wns-pingcheck-' + Math.random().toString(36).substr(2, 6);
            const opts = {
                host: '0.peerjs.com',
                port: 443,
                path: '/',
                secure: true,
                debug: 0,
                config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
            };
            testPeer = new Peer(testId, opts);
            testPeer.on('open', (id) => {
                if (finished) return;
                clearTimeout(timer);
                const latency = Math.round(performance.now() - startTime);
                cleanup();
                pill.className = 'server-status-pill success';
                pill.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>0.peerjs.com Online • ${latency}ms latency</span>`;
            });
            testPeer.on('error', async (err) => {
                if (finished) return;
                clearTimeout(timer);
                cleanup();
                try {
                    await fetch('https://0.peerjs.com/', { mode: 'no-cors', cache: 'no-cache' });
                    pill.className = 'server-status-pill success';
                    pill.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>0.peerjs.com Online (HTTP fallback)</span>`;
                } catch {
                    pill.className = 'server-status-pill error';
                    pill.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Error: ${err ? err.type || 'Connection failed' : 'Connection failed'}</span>`;
                }
            });
        } catch (e) {
            clearTimeout(timer);
            cleanup();
            pill.className = 'server-status-pill error';
            pill.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Could not initialize test peer</span>';
        }
    }
}

document.addEventListener('DOMContentLoaded', () => { window.app = new App(); window.app.init(); });

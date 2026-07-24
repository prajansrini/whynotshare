class UI {
    static $(sel) { return document.querySelector(sel); }
    static $$(sel) { return document.querySelectorAll(sel); }

    static showScreen(screenId, pushToHistory = true) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const t = document.getElementById(screenId);
        if (t) t.classList.add('active');
        if (typeof window !== 'undefined') {
            if (pushToHistory && window.history && window.history.pushState) {
                try {
                    const currentState = window.history.state;
                    if (!currentState || currentState.screenId !== screenId) {
                        window.history.pushState({ screenId }, '', window.location.href);
                    }
                } catch {}
            }
            if (window.app && typeof window.app.updateMyNameDisplay === 'function') {
                try { window.app.updateMyNameDisplay(); } catch {}
            }
        }
    }

    static toast(message, type = 'info', duration = 3000) {
        let c = document.querySelector('.toast-container');
        if (!c) { c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c); }
        const t = document.createElement('div');
        t.className = 'toast toast-' + type;
        t.textContent = message;
        c.appendChild(t);
        setTimeout(() => { if (t.parentNode) t.remove(); }, duration);
    }

    static confirm(message, title = 'Confirm') {
        return new Promise((resolve) => {
            const modal = document.getElementById('modal-confirm-action');
            if (!modal) return resolve(window.confirm(message));
            
            const titleEl = document.getElementById('confirm-action-title');
            if (titleEl) titleEl.textContent = title;
            const msgEl = document.getElementById('confirm-action-message');
            if (msgEl) msgEl.textContent = message;
            
            modal.style.display = 'flex';
            
            const btnYes = document.getElementById('btn-confirm-action-yes');
            const btnNo = document.getElementById('btn-confirm-action-no');
            
            const cleanup = () => {
                modal.style.display = 'none';
                if (btnYes) btnYes.onclick = null;
                if (btnNo) btnNo.onclick = null;
            };
            
            if (btnYes) btnYes.onclick = () => { cleanup(); resolve(true); };
            if (btnNo) btnNo.onclick = () => { cleanup(); resolve(false); };
        });
    }

    static formatTime(ts) {
        const d = new Date(ts || Date.now());
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    static async copyToClipboard(text) {
        try { await navigator.clipboard.writeText(text); } catch {
            const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        }
        UI.toast('Copied!', 'success');
    }

    static renderDeviceChip(peer, isYou) {
        const el = document.createElement('div');
        el.className = 'device-chip' + (isYou ? ' is-you' : '');
        el.dataset.peerId = peer.id;
        const leftSide = '<div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">' +
            '<span class="device-dot"></span><span class="device-icon">' + DeviceInfo.getIcon(peer.deviceType) + '</span>' +
            '<span class="device-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + peer.deviceName + '</span>' +
            (peer.isCreator ? '<span class="badge-host">Host</span>' : '') +
            '</div>';
        const rightSide = '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">' +
            (peer.systemName ? '<span style="font-size:0.75rem;color:var(--text-tertiary);white-space:nowrap">' + peer.systemName + '</span>' : '') +
            (isYou ? '<span class="device-tag">You</span>' : '') +
            '</div>';
        el.innerHTML = leftSide + rightSide;
        return el;
    }

    static renderMessage(text, sender, timestamp, isSent, groupInfo = {}) {
        const { isGroupFollowup, hasGroupFollowup } = groupInfo;
        const msg = document.createElement('div');
        let classes = 'message ' + (isSent ? 'message-sent' : 'message-received');
        if (isGroupFollowup) classes += ' message-group-followup';
        if (hasGroupFollowup) classes += ' message-group-lead';
        msg.className = classes;

        const escaped = UI.escapeHtml(text);
        const sName = typeof sender === 'object' && sender ? sender.name : (sender || 'Peer');
        const sColor = typeof sender === 'object' && sender && sender.color ? sender.color : 'var(--text-secondary)';

        const senderHtml = (!isSent && !isGroupFollowup)
            ? '<span class="message-sender" style="color:' + sColor + '">' + sName + '</span>'
            : '';

        const timeClass = 'message-time-wrapper' + (hasGroupFollowup ? ' message-time-grouped' : '');

        msg.innerHTML = senderHtml +
            '<div class="message-bubble">' + escaped + '</div>' +
            '<div class="' + timeClass + '" style="display:flex;align-items:center;gap:6px;' + (isSent ? 'flex-direction:row-reverse' : '') + '">' +
            '<span class="message-time">' + UI.formatTime(timestamp || Date.now()) + '</span>' +
            '<div class="message-actions"><button class="message-action-btn" data-copy="' + UI.escapeAttr(text) + '">Copy</button></div></div>';
        msg.querySelector('.message-action-btn').addEventListener('click', function() { UI.copyToClipboard(this.dataset.copy); });
        return msg;
    }

    static updateDevicesList(peers, myId) {
        const list = document.getElementById('devices-list');
        const count = document.getElementById('devices-count');
        const countModal = document.getElementById('devices-count-modal');
        const countPill = document.getElementById('devices-count-pill');
        if (!list) return;
        list.innerHTML = '';
        peers.forEach(p => list.appendChild(UI.renderDeviceChip(p, p.id === myId)));
        if (count) count.textContent = peers.length + ' user' + (peers.length !== 1 ? 's' : '');
        if (countModal) countModal.textContent = peers.length;
        if (countPill) countPill.textContent = peers.length > 10 ? '10+' : peers.length;
    }

    static showEmptyMessages() {
        const c = document.getElementById('messages');
        if (!c) return;
        c.innerHTML = '<div class="messages-empty"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><span>No messages yet</span><span style="font-size:0.8rem">Messages are end-to-end encrypted when E2E is enabled</span></div>';
    }

    static formatFileName(fileName, maxChars = 24) {
        if (!fileName) return 'file';
        if (fileName.length <= maxChars) return fileName;
        const lastDot = fileName.lastIndexOf('.');
        if (lastDot === -1 || lastDot < fileName.length - 8 || lastDot === 0) {
            return fileName.substring(0, maxChars - 3) + '...';
        }
        const ext = fileName.substring(lastDot);
        const base = fileName.substring(0, lastDot);
        const baseMax = Math.max(4, maxChars - ext.length - 3);
        if (base.length <= baseMax) return fileName;
        return base.substring(0, baseMax) + '...' + ext;
    }

    static renderTransferCard(fileId, meta, direction, onCancel) {
        const card = document.createElement('div');
        card.className = 'transfer-card';
        card.id = 'transfer-' + fileId;
        const icon = direction === 'upload' ? '↑' : '↓';
        const label = direction === 'upload' ? 'Sending' : 'Receiving';
        card.innerHTML = '<div class="transfer-info"><span class="transfer-icon">' + icon + '</span><div class="transfer-details">' +
            '<div class="transfer-name" title="' + UI.escapeAttr(meta.fileName) + '">' + UI.escapeHtml(UI.formatFileName(meta.fileName, 28)) + '</div>' +
            '<div class="transfer-meta">' + label + ' · ' + FileTransfer.formatSize(meta.fileSize) + (meta.encrypted ? ' · Encrypted' : '') + '</div></div>' +
            '<button class="btn-cancel-transfer" title="Cancel Transfer" style="margin-left:auto;background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>' +
            '<div class="transfer-progress"><div class="transfer-bar"><div class="transfer-bar-fill" style="width:0%"></div></div>' +
            '<div class="transfer-stats"><span class="transfer-percent">0%</span><span class="transfer-speed"></span></div></div>';
        const cancelBtn = card.querySelector('.btn-cancel-transfer');
        if (cancelBtn && onCancel) cancelBtn.addEventListener('click', () => onCancel(fileId));
        return card;
    }

    static updateTransferProgress(fileId, progress, speed) {
        const card = document.getElementById('transfer-' + fileId);
        if (card) {
            const fill = card.querySelector('.transfer-bar-fill');
            const pct = card.querySelector('.transfer-percent');
            const spd = card.querySelector('.transfer-speed');
            if (fill) fill.style.width = (progress * 100).toFixed(1) + '%';
            if (pct) pct.textContent = (progress * 100).toFixed(0) + '%';
            if (spd) spd.textContent = FileTransfer.formatSpeed(speed);
            if (progress >= 1) {
                setTimeout(() => { if (card.parentNode) card.remove(); }, 300);
            }
        }
        const chatBar = document.getElementById('chat-progress-bar-' + fileId);
        const chatPct = document.getElementById('chat-progress-pct-' + fileId);
        const chatSpd = document.getElementById('chat-progress-spd-' + fileId);
        if (chatBar) chatBar.style.width = (progress * 100).toFixed(1) + '%';
        if (chatPct) chatPct.textContent = (progress * 100).toFixed(0) + '%';
        if (chatSpd) chatSpd.textContent = FileTransfer.formatSpeed(speed);
        if (progress >= 1) {
            setTimeout(() => {
                const wrapper = document.getElementById('chat-progress-wrapper-' + fileId);
                if (wrapper && wrapper.parentNode) wrapper.remove();
            }, 300);
        }
    }

    static renderAudioCardHtml(meta, url, actionBtn, statusBadge = '', inlineProgress = '') {
        const fileName = meta.fileName || meta.name || 'Audio File';
        const fileSize = typeof FileTransfer !== 'undefined' && FileTransfer.formatSize ? FileTransfer.formatSize(meta.fileSize || meta.size || 0) : '';
        const escName = UI.escapeHtml(typeof UI.formatFileName === 'function' ? UI.formatFileName(fileName, 24) : fileName);
        const fullEscName = UI.escapeAttr(fileName);

        return '<div class="custom-audio-card" style="user-select:none;-webkit-user-select:none">' +
            '<div style="display:flex;align-items:center;gap:12px;width:100%">' +
                '<button type="button" class="audio-play-btn" onclick="UI.toggleAudioPlayback(this, \'' + url + '\')" title="Play/Pause">' +
                    '<svg class="play-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>' +
                    '<svg class="pause-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="display:none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>' +
                '</button>' +
                '<div style="flex:1;min-width:0;text-align:left;overflow:hidden;user-select:none">' +
                    '<div style="font-weight:600;font-size:0.88rem;color:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none" title="' + fullEscName + '">' + escName + statusBadge + '</div>' +
                    '<div style="font-size:0.72rem;opacity:0.75;margin-top:2px;display:flex;align-items:center;gap:6px;user-select:none">' +
                        '<span>' + fileSize + '</span>' +
                        '<span>•</span>' +
                        '<span class="audio-time-display" style="font-variant-numeric:tabular-nums;font-family:\'JetBrains Mono\',monospace;display:inline-block;min-width:86px;text-align:left;user-select:none">0:00 / --:--</span>' +
                    '</div>' +
                '</div>' +
                '<div style="flex-shrink:0">' + actionBtn + '</div>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:8px;width:100%;margin-top:2px;padding-left:48px;box-sizing:border-box">' +
                '<input type="range" class="audio-seek-slider" min="0" max="100" value="0" step="0.1" oninput="UI.seekAudio(this)" onmousedown="this.isDragging=true" onmouseup="this.isDragging=false" ontouchstart="this.isDragging=true" ontouchend="this.isDragging=false">' +
                '<audio src="' + url + '" class="hidden-audio" preload="metadata" onloadedmetadata="UI.updateAudioDuration(this)" ontimeupdate="UI.updateAudioProgress(this)" onended="UI.onAudioEnded(this)" style="display:none"></audio>' +
            '</div>' +
            inlineProgress +
        '</div>';
    }

    static toggleAudioPlayback(btn, url) {
        const card = btn.closest('.custom-audio-card');
        if (!card) return;
        const audio = card.querySelector('audio');
        if (!audio) return;

        const playIcon = btn.querySelector('.play-icon');
        const pauseIcon = btn.querySelector('.pause-icon');

        if (audio.paused) {
            document.querySelectorAll('.custom-audio-card audio').forEach(a => {
                if (a !== audio && !a.paused) {
                    a.pause();
                    const b = a.closest('.custom-audio-card')?.querySelector('.audio-play-btn');
                    if (b) {
                        const pi = b.querySelector('.play-icon');
                        const pai = b.querySelector('.pause-icon');
                        if (pi && pai) { pi.style.display = ''; pai.style.display = 'none'; }
                    }
                }
            });

            audio.play().then(() => {
                if (playIcon && pauseIcon) { playIcon.style.display = 'none'; pauseIcon.style.display = ''; }
            }).catch(err => console.error('Audio play error:', err));
        } else {
            audio.pause();
            if (playIcon && pauseIcon) { playIcon.style.display = ''; pauseIcon.style.display = 'none'; }
        }
    }

    static formatAudioDuration(secs) {
        if (!secs || isNaN(secs) || !isFinite(secs)) return '--:--';
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    static updateAudioDuration(audio) {
        const card = audio.closest('.custom-audio-card');
        if (!card) return;
        const timeDisplay = card.querySelector('.audio-time-display');
        const slider = card.querySelector('.audio-seek-slider');
        if (timeDisplay && audio.duration && isFinite(audio.duration)) {
            const cur = UI.formatAudioDuration(audio.currentTime || 0);
            const dur = UI.formatAudioDuration(audio.duration);
            timeDisplay.textContent = `${cur} / ${dur}`;
        }
        if (slider && audio.duration && isFinite(audio.duration)) {
            slider.max = audio.duration;
        }
    }

    static updateAudioProgress(audio) {
        const card = audio.closest('.custom-audio-card');
        if (!card) return;
        const timeDisplay = card.querySelector('.audio-time-display');
        const slider = card.querySelector('.audio-seek-slider');
        if (slider && !slider.isDragging) {
            slider.value = audio.currentTime || 0;
        }
        if (timeDisplay && audio.duration && isFinite(audio.duration)) {
            const cur = UI.formatAudioDuration(audio.currentTime || 0);
            const dur = UI.formatAudioDuration(audio.duration);
            timeDisplay.textContent = `${cur} / ${dur}`;
        }
    }

    static seekAudio(slider) {
        const card = slider.closest('.custom-audio-card');
        if (!card) return;
        const audio = card.querySelector('audio');
        if (audio && audio.duration && isFinite(audio.duration)) {
            audio.currentTime = parseFloat(slider.value) || 0;
            const timeDisplay = card.querySelector('.audio-time-display');
            if (timeDisplay) {
                const cur = UI.formatAudioDuration(audio.currentTime);
                const dur = UI.formatAudioDuration(audio.duration);
                timeDisplay.textContent = `${cur} / ${dur}`;
            }
        }
    }

    static onAudioEnded(audio) {
        const card = audio.closest('.custom-audio-card');
        if (!card) return;
        const btn = card.querySelector('.audio-play-btn');
        if (btn) {
            const playIcon = btn.querySelector('.play-icon');
            const pauseIcon = btn.querySelector('.pause-icon');
            if (playIcon && pauseIcon) { playIcon.style.display = ''; pauseIcon.style.display = 'none'; }
        }
        const slider = card.querySelector('.audio-seek-slider');
        if (slider) slider.value = 0;
        const timeDisplay = card.querySelector('.audio-time-display');
        if (timeDisplay && audio.duration && isFinite(audio.duration)) {
            timeDisplay.textContent = `0:00 / ${UI.formatAudioDuration(audio.duration)}`;
        }
    }

    static renderReceivedFile(fileId, meta, blob) {
        const card = document.createElement('div');
        card.className = 'received-file-card';
        card.id = 'history-card-' + fileId;
        const url = URL.createObjectURL(blob);
        const isImage = (meta.fileType && meta.fileType.startsWith('image/')) || /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i.test(meta.fileName || '');
        const isVideo = (meta.fileType && meta.fileType.startsWith('video/')) || /\.(mp4|webm|mov|mkv|avi|m4v|3gp)$/i.test(meta.fileName || '');
        const isAudio = (meta.fileType && meta.fileType.startsWith('audio/')) || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(meta.fileName || '');
        
        let iconHtml = '<div class="file-preview-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></div>';
        if (isImage) iconHtml = '<div class="file-preview-icon icon-image"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>';
        else if (isVideo) iconHtml = '<div class="file-preview-icon icon-video"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg></div>';

        if (url && (isImage || isVideo)) {
            card.className += ' media-preview-trigger';
            card.dataset.url = url;
            card.dataset.type = meta.fileType || (isImage ? 'image/png' : 'video/mp4');
            card.dataset.name = meta.fileName || (isImage ? 'Image' : 'Video');
            card.style.cursor = 'pointer';
        }

        const actionBtn = '<a href="' + url + '" download="' + UI.escapeAttr(meta.fileName) + '" class="btn btn-primary" style="padding:8px 16px;font-size:0.85rem;border-radius:8px;font-weight:600;display:inline-flex;align-items:center;gap:6px">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Save</a>';

        if (isAudio && url) {
            card.innerHTML = UI.renderAudioCardHtml(meta, url, actionBtn, ' <span style="font-size:0.75rem;color:var(--accent-primary);margin-left:6px;font-weight:600">Received</span>');
        } else {
            card.innerHTML = iconHtml +
                '<div class="received-file-info"><div class="received-file-name" title="' + UI.escapeAttr(meta.fileName) + '">' + UI.escapeHtml(UI.formatFileName(meta.fileName, 28)) + ' <span style="font-size:0.75rem;color:var(--accent-primary);margin-left:6px;font-weight:600">Received</span></div>' +
                '<div class="received-file-size">' + FileTransfer.formatSize(meta.fileSize) + '</div></div>' +
                actionBtn;
        }
        return card;
    }

    static renderHistoryFileCard(meta, url, senderId) {
        const card = document.createElement('div');
        card.className = 'received-file-card';
        card.id = 'history-card-' + meta.fileId;
        const isImage = (meta.fileType && meta.fileType.startsWith('image/')) || /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i.test(meta.fileName || '');
        const isVideo = (meta.fileType && meta.fileType.startsWith('video/')) || /\.(mp4|webm|mov|mkv|avi|m4v|3gp)$/i.test(meta.fileName || '');
        const isAudio = (meta.fileType && meta.fileType.startsWith('audio/')) || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(meta.fileName || '');
        
        let iconHtml = '<div class="file-preview-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></div>';
        if (isImage) iconHtml = '<div class="file-preview-icon icon-image"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>';
        else if (isVideo) iconHtml = '<div class="file-preview-icon icon-video"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg></div>';

        if (url && (isImage || isVideo)) {
            card.className += ' media-preview-trigger';
            card.dataset.url = url;
            card.dataset.type = meta.fileType || (isImage ? 'image/png' : 'video/mp4');
            card.dataset.name = meta.fileName || (isImage ? 'Image' : 'Video');
            card.style.cursor = 'pointer';
        }

        let actionBtn;
        const myId = window.app && window.app.conn ? window.app.conn.myPeerId : null;
        if (meta.cancelled) {
            actionBtn = '<span style="color:var(--status-offline);font-weight:600;font-size:0.8rem;display:inline-flex;align-items:center;gap:4px">🚫 Transfer Cancelled</span>';
        } else if (meta.personalEncrypted && meta.recipients && Array.isArray(meta.recipients) && myId && !meta.recipients.includes(myId)) {
            actionBtn = '<span style="color:var(--status-offline);font-weight:600;font-size:0.8rem;display:inline-flex;align-items:center;gap:4px" title="You are not an authorized recipient for this encrypted file">🚫 File not sent to you</span>';
        } else if (url) {
            actionBtn = '<a href="' + url + '" download="' + UI.escapeAttr(meta.fileName) + '" class="btn btn-primary" style="padding:8px 16px;font-size:0.85rem;border-radius:8px;font-weight:600;display:inline-flex;align-items:center;gap:6px">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Save</a>';
        } else {
            actionBtn = '<button class="btn btn-secondary btn-fetch-history-file" data-file-id="' + UI.escapeAttr(meta.fileId) + '" id="card-fetch-' + UI.escapeAttr(meta.fileId) + '" style="padding:8px 16px;font-size:0.85rem;border-radius:8px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-weight:600">⬇ Fetch (' + FileTransfer.formatSize(meta.fileSize) + ')</button>';
        }
        const statusBadge = url ? (senderId === myId ? ' <span style="font-size:0.75rem;color:var(--accent-primary);margin-left:6px;font-weight:600">Sent</span>' : ' <span style="font-size:0.75rem;color:var(--accent-primary);margin-left:6px;font-weight:600">Received</span>') : '';
        if (isAudio && url) {
            card.innerHTML = UI.renderAudioCardHtml(meta, url, actionBtn, statusBadge);
        } else {
            card.innerHTML = iconHtml +
                '<div class="received-file-info"><div class="received-file-name" title="' + UI.escapeAttr(meta.fileName) + '">' + UI.escapeHtml(UI.formatFileName(meta.fileName, 28)) + statusBadge + '</div>' +
                '<div class="received-file-size">' + FileTransfer.formatSize(meta.fileSize) + '</div></div>' +
                actionBtn;
        }
        return card;
    }

    static renderSentFile(file) {
        const card = document.createElement('div');
        card.className = 'received-file-card';
        const url = URL.createObjectURL(file);
        const isImage = (file.type && file.type.startsWith('image/')) || /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i.test(file.name || '');
        const isVideo = (file.type && file.type.startsWith('video/')) || /\.(mp4|webm|mov|mkv|avi|m4v|3gp)$/i.test(file.name || '');
        const isAudio = (file.type && file.type.startsWith('audio/')) || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file.name || '');
        
        let iconHtml = '<div class="file-preview-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></div>';
        if (isImage) iconHtml = '<div class="file-preview-icon icon-image"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>';
        else if (isVideo) iconHtml = '<div class="file-preview-icon icon-video"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg></div>';

        if (url && (isImage || isVideo)) {
            card.className += ' media-preview-trigger';
            card.dataset.url = url;
            card.dataset.type = file.type || (isImage ? 'image/png' : 'video/mp4');
            card.dataset.name = file.name || (isImage ? 'Image' : 'Video');
            card.style.cursor = 'pointer';
        }

        const actionBtn = '<a href="' + url + '" download="' + UI.escapeAttr(file.name) + '" class="btn btn-primary" style="padding:8px 16px;font-size:0.85rem;border-radius:8px;font-weight:600;display:inline-flex;align-items:center;gap:6px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Save</a>';

        if (isAudio && url) {
            card.innerHTML = UI.renderAudioCardHtml(file, url, actionBtn, ' <span style="font-size:0.75rem;color:var(--accent-primary);margin-left:6px;font-weight:600">Sent</span>');
        } else {
            card.innerHTML = iconHtml +
                '<div class="received-file-info"><div class="received-file-name" title="' + UI.escapeAttr(file.name) + '">' + UI.escapeHtml(UI.formatFileName(file.name, 28)) + ' <span style="font-size:0.75rem;color:var(--accent-primary);margin-left:6px;font-weight:600">Sent</span></div>' +
                '<div class="received-file-size">' + FileTransfer.formatSize(file.size) + '</div></div>' +
                actionBtn;
        }
        return card;
    }

    static renderFileChatMessage(meta, url, isSent, sender, timestamp, groupInfo = {}) {
        const { isGroupFollowup, hasGroupFollowup } = groupInfo;
        const msg = document.createElement('div');
        if (meta && meta.fileId) msg.dataset.fileId = meta.fileId;
        let classes = 'message ' + (isSent ? 'message-sent' : 'message-received');
        if (isGroupFollowup) classes += ' message-group-followup';
        if (hasGroupFollowup) classes += ' message-group-lead';
        msg.className = classes;

        const isImage = (meta.fileType && meta.fileType.startsWith('image/')) || /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i.test(meta.fileName || '');
        const isVideo = (meta.fileType && meta.fileType.startsWith('video/')) || /\.(mp4|webm|mov|mkv|avi|m4v|3gp)$/i.test(meta.fileName || '');
        const isAudio = (meta.fileType && meta.fileType.startsWith('audio/')) || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(meta.fileName || '');
        
        let actionBtn;
        const myId = window.app && window.app.conn ? window.app.conn.myPeerId : null;
        let badgeNotSentToAll = '';
        if (isSent && meta.recipients && Array.isArray(meta.recipients) && meta.recipients.length > 0) {
            badgeNotSentToAll = '<span style="font-size:0.75rem;color:var(--status-offline);margin-right:6px;font-weight:600;display:inline-flex;align-items:center;gap:4px" title="Sent selectively (some members excluded)">🚫 File not sent to all</span>';
        }

        if (meta.cancelled) {
            actionBtn = '<span style="color:var(--status-offline);font-weight:600;font-size:0.8rem;margin-left:auto;display:inline-flex;align-items:center;gap:4px;flex-shrink:0">🚫 Transfer Cancelled</span>';
        } else if (!isSent && meta.personalEncrypted && meta.recipients && Array.isArray(meta.recipients) && myId && !meta.recipients.includes(myId)) {
            actionBtn = '<span style="color:var(--status-offline);font-weight:600;font-size:0.8rem;margin-left:auto;display:inline-flex;align-items:center;gap:4px;flex-shrink:0" title="You are not an authorized recipient for this encrypted file">🚫 File not sent to you</span>';
        } else if (url) {
            actionBtn = badgeNotSentToAll + '<a href="' + url + '" download="' + UI.escapeAttr(meta.fileName) + '" style="margin-left:auto;background:var(--accent-primary);color:white;padding:6px 12px;border-radius:8px;text-decoration:none;font-size:0.8rem;font-weight:600;display:inline-flex;align-items:center;gap:5px;box-shadow:0 2px 6px rgba(0,0,0,0.15);flex-shrink:0;white-space:nowrap"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Save</a>';
        } else {
            actionBtn = '<button class="btn btn-secondary btn-fetch-history-file" data-file-id="' + UI.escapeAttr(meta.fileId) + '" id="chat-fetch-' + UI.escapeAttr(meta.fileId) + '" style="margin-left:auto;padding:6px 12px;border-radius:8px;font-size:0.8rem;font-weight:600;display:inline-flex;align-items:center;gap:5px;cursor:pointer;flex-shrink:0;white-space:nowrap">⬇ Fetch (' + FileTransfer.formatSize(meta.fileSize) + ')</button>';
        }

        let iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
        let iconClass = 'file-preview-icon';
        if (isImage) {
            iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
            iconClass = 'file-preview-icon icon-image';
        } else if (isVideo) {
            iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';
            iconClass = 'file-preview-icon icon-video';
        }

        const triggerAttrs = (url && (isImage || isVideo)) ? ' class="file-box-card media-preview-trigger" data-url="' + url + '" data-type="' + UI.escapeAttr(meta.fileType || (isImage ? 'image/png' : 'video/mp4')) + '" data-name="' + UI.escapeAttr(meta.fileName || 'Media Preview') + '" style="cursor:pointer;display:flex;align-items:center;gap:10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);padding:8px 12px;border-radius:10px;text-decoration:none;color:inherit;box-shadow:0 2px 8px rgba(0,0,0,0.08);width:100%;box-sizing:border-box;overflow:hidden;user-select:none;-webkit-user-select:none"' : ' class="file-box-card" style="display:flex;align-items:center;gap:10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);padding:8px 12px;border-radius:10px;text-decoration:none;color:inherit;box-shadow:0 2px 8px rgba(0,0,0,0.08);width:100%;box-sizing:border-box;overflow:hidden;user-select:none;-webkit-user-select:none"';

        let inlineProgress = '';
        if (!url && !meta.cancelled && (!meta.personalEncrypted || !meta.recipients || !Array.isArray(meta.recipients) || !myId || meta.recipients.includes(myId))) {
            inlineProgress = '<div id="chat-progress-wrapper-' + UI.escapeAttr(meta.fileId) + '" style="width:100%;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;gap:6px">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;font-size:0.75rem;font-weight:600;color:var(--accent-primary)">' +
                '<span style="display:inline-flex;align-items:center;gap:5px">' +
                '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:rotateSpinner 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>' +
                '<span id="chat-progress-status-' + UI.escapeAttr(meta.fileId) + '">' + (isSent ? 'Sending...' : 'Receiving...') + '</span></span>' +
                '<span id="chat-progress-pct-' + UI.escapeAttr(meta.fileId) + '">0%</span></div>' +
                '<div style="width:100%;height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden">' +
                '<div id="chat-progress-bar-' + UI.escapeAttr(meta.fileId) + '" style="width:0%;height:100%;background:var(--accent-gradient);transition:width 0.15s ease"></div></div>' +
                '<div style="display:flex;justify-content:space-between;align-items:center;font-size:0.7rem;color:var(--text-tertiary)">' +
                '<span id="chat-progress-spd-' + UI.escapeAttr(meta.fileId) + '"></span>' +
                '<button onclick="window.app && window.app.fileTransfer && window.app.fileTransfer.cancelTransfer(\'' + UI.escapeAttr(meta.fileId) + '\')" style="background:none;border:none;color:var(--status-offline);font-size:0.72rem;cursor:pointer;padding:0;font-weight:600">Cancel</button></div></div>';
        }

        const fileBox = '<div' + triggerAttrs + '>' +
            '<div class="' + iconClass + '" style="width:36px;height:36px">' + iconSvg + '</div>' +
            '<div style="overflow:hidden;text-align:left;flex:1;min-width:0;user-select:none"><div style="font-weight:600;font-size:0.85rem;color:inherit;word-break:break-all;line-height:1.3;user-select:none" title="' + UI.escapeAttr(meta.fileName) + '">' + UI.escapeHtml(UI.formatFileName(meta.fileName, 22)) + '</div>' +
            '<div style="font-size:0.72rem;opacity:0.75;margin-top:2px">' + FileTransfer.formatSize(meta.fileSize) + '</div></div>' +
            actionBtn + '</div>' + inlineProgress;

        const contentHtml = (isAudio && url)
            ? UI.renderAudioCardHtml(meta, url, actionBtn, '', inlineProgress)
            : fileBox;

        const sName = typeof sender === 'object' && sender ? sender.name : (sender || 'Peer');
        const sColor = typeof sender === 'object' && sender && sender.color ? sender.color : 'var(--text-secondary)';
        const senderHtml = (!isSent && !isGroupFollowup)
            ? '<span class="message-sender" style="color:' + sColor + '">' + sName + '</span>'
            : '';

        const timeClass = 'message-time-wrapper' + (hasGroupFollowup ? ' message-time-grouped' : '');

        msg.innerHTML = senderHtml +
            '<div class="message-bubble" style="padding:10px">' + contentHtml + '</div>' +
            '<div class="' + timeClass + '" style="display:flex;align-items:center;gap:6px;' + (isSent ? 'flex-direction:row-reverse' : '') + '">' +
            '<span class="message-time">' + UI.formatTime(timestamp || Date.now()) + '</span></div>';
        return msg;
    }

    static openMediaPreviewModal(url, fileType, fileName) {
        const modal = document.getElementById('modal-media-preview');
        const content = document.getElementById('media-preview-content');
        const title = document.getElementById('media-preview-title');
        const downloadBtn = document.getElementById('btn-preview-download');
        if (!modal || !content) return;

        if (title) {
            const spanEl = title.querySelector('span');
            if (spanEl) spanEl.textContent = fileName || 'Media Preview'; else title.textContent = fileName || 'Media Preview';
        }
        if (downloadBtn) {
            downloadBtn.href = url || '#';
            downloadBtn.download = fileName || 'download';
        }

        const isImage = (fileType && fileType.startsWith('image/')) || /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i.test(fileName || '');
        const isVideo = (fileType && fileType.startsWith('video/')) || /\.(mp4|webm|mov|mkv|avi|m4v|3gp)$/i.test(fileName || '');

        content.innerHTML = '';
        if (isImage) {
            const img = document.createElement('img');
            img.src = url;
            img.style.cssText = 'max-width:100%;max-height:80vh;object-fit:contain;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.5)';
            content.appendChild(img);
        } else if (isVideo) {
            const vid = document.createElement('video');
            vid.src = url;
            vid.controls = true;
            vid.autoplay = true;
            vid.style.cssText = 'max-width:100%;max-height:80vh;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.5)';
            content.appendChild(vid);
        } else {
            return;
        }

        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('visible'), 10);
    }

    static closeMediaPreviewModal() {
        const modal = document.getElementById('modal-media-preview');
        const content = document.getElementById('media-preview-content');
        if (!modal) return;
        if (document.fullscreenElement) {
            try { document.exitFullscreen(); } catch {}
        }
        modal.classList.remove('visible');
        modal.style.display = 'none';
        if (content) content.innerHTML = '';
    }

    static escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
    static escapeAttr(t) { return t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;'); }
    static autoResize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 150) + 'px'; }
}
window.UI = UI;

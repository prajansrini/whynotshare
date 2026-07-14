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
            (peer.isCreator ? '<span style="font-size:0.7rem;color:var(--accent-primary);background:rgba(108,92,231,0.15);padding:2px 8px;border-radius:9999px;font-weight:600">Host</span>' : (peer.isAdmin ? '<span style="font-size:0.7rem;color:#ea580c;background:rgba(234,88,12,0.15);padding:2px 8px;border-radius:9999px;font-weight:600">Admin</span>' : '')) +
            '</div>';
        const rightSide = '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">' +
            (peer.systemName ? '<span style="font-size:0.75rem;color:var(--text-tertiary);white-space:nowrap">' + peer.systemName + '</span>' : '') +
            (isYou ? '<span class="device-tag">You</span>' : '') +
            '</div>';
        el.innerHTML = leftSide + rightSide;
        return el;
    }

    static renderMessage(text, sender, timestamp, isSent) {
        const msg = document.createElement('div');
        msg.className = 'message ' + (isSent ? 'message-sent' : 'message-received');
        const escaped = UI.escapeHtml(text);
        msg.innerHTML = (!isSent ? '<span class="message-sender" style="color:' + (sender.color || 'var(--text-secondary)') + '">' + sender.name + '</span>' : '') +
            '<div class="message-bubble">' + escaped + '</div>' +
            '<div style="display:flex;align-items:center;gap:6px;' + (isSent ? 'flex-direction:row-reverse' : '') + '">' +
            '<span class="message-time">' + UI.formatTime(timestamp) + '</span>' +
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
        if (count) count.textContent = peers.length + ' device' + (peers.length !== 1 ? 's' : '');
        if (countModal) countModal.textContent = peers.length;
        if (countPill) countPill.textContent = peers.length;
    }

    static showEmptyMessages() {
        const c = document.getElementById('messages');
        if (!c) return;
        c.innerHTML = '<div class="messages-empty"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><span>No messages yet</span><span style="font-size:0.8rem">Messages are end-to-end encrypted when E2E is enabled</span></div>';
    }

    static renderTransferCard(fileId, meta, direction, onCancel) {
        const card = document.createElement('div');
        card.className = 'transfer-card';
        card.id = 'transfer-' + fileId;
        const icon = direction === 'upload' ? '↑' : '↓';
        const label = direction === 'upload' ? 'Sending' : 'Receiving';
        card.innerHTML = '<div class="transfer-info"><span class="transfer-icon">' + icon + '</span><div class="transfer-details">' +
            '<div class="transfer-name">' + UI.escapeHtml(meta.fileName) + '</div>' +
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
        if (!card) return;
        const fill = card.querySelector('.transfer-bar-fill');
        const pct = card.querySelector('.transfer-percent');
        const spd = card.querySelector('.transfer-speed');
        if (fill) fill.style.width = (progress * 100).toFixed(1) + '%';
        if (pct) pct.textContent = (progress * 100).toFixed(0) + '%';
        if (spd) spd.textContent = FileTransfer.formatSpeed(speed);
    }

    static renderReceivedFile(fileId, meta, blob) {
        const card = document.createElement('div');
        card.className = 'received-file-card';
        card.id = 'history-card-' + fileId;
        const url = URL.createObjectURL(blob);
        const isImage = meta.fileType && meta.fileType.startsWith('image/');
        const isVideo = meta.fileType && meta.fileType.startsWith('video/');
        const isAudio = meta.fileType && meta.fileType.startsWith('audio/');
        let preview = '';
        if (isImage) preview = '<img src="' + url + '" class="file-preview-img" alt="' + UI.escapeAttr(meta.fileName) + '">';
        else if (isVideo) preview = '<video src="' + url + '" class="file-preview-video" controls></video>';
        else if (isAudio) preview = '<audio src="' + url + '" class="file-preview-audio" controls></audio>';
        if (!preview) {
            preview = '<div class="file-preview-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></div>';
        }
        card.innerHTML = preview +
            '<div class="received-file-info"><div class="received-file-name">' + UI.escapeHtml(meta.fileName) + '</div>' +
            '<div class="received-file-size">' + FileTransfer.formatSize(meta.fileSize) + '</div></div>' +
            '<a href="' + url + '" download="' + UI.escapeAttr(meta.fileName) + '" class="btn btn-primary" style="padding:8px 16px;font-size:0.85rem;border-radius:8px;font-weight:600;display:inline-flex;align-items:center;gap:6px">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Save</a>';
        return card;
    }

    static renderHistoryFileCard(meta, url, senderId) {
        const card = document.createElement('div');
        card.className = 'received-file-card';
        card.id = 'history-card-' + meta.fileId;
        const isImage = meta.fileType && meta.fileType.startsWith('image/');
        const isVideo = meta.fileType && meta.fileType.startsWith('video/');
        const isAudio = meta.fileType && meta.fileType.startsWith('audio/');
        let preview = '';
        if (url) {
            if (isImage) preview = '<img src="' + url + '" class="file-preview-img" alt="' + UI.escapeAttr(meta.fileName) + '">';
            else if (isVideo) preview = '<video src="' + url + '" class="file-preview-video" controls></video>';
            else if (isAudio) preview = '<audio src="' + url + '" class="file-preview-audio" controls></audio>';
        }
        if (!preview) {
            preview = '<div class="file-preview-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></div>';
        }
        const actionBtn = url ? '<a href="' + url + '" download="' + UI.escapeAttr(meta.fileName) + '" class="btn btn-primary" style="padding:8px 16px;font-size:0.85rem;border-radius:8px;font-weight:600;display:inline-flex;align-items:center;gap:6px">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Save</a>' :
            '<button class="btn btn-secondary btn-fetch-history-file" data-file-id="' + UI.escapeAttr(meta.fileId) + '" id="card-fetch-' + UI.escapeAttr(meta.fileId) + '" style="padding:8px 16px;font-size:0.85rem;border-radius:8px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-weight:600">⬇ Fetch (' + FileTransfer.formatSize(meta.fileSize) + ')</button>';
        card.innerHTML = preview +
            '<div class="received-file-info"><div class="received-file-name">' + UI.escapeHtml(meta.fileName) + '</div>' +
            '<div class="received-file-size">' + FileTransfer.formatSize(meta.fileSize) + '</div></div>' +
            actionBtn;
        return card;
    }

    static renderSentFile(file) {
        const card = document.createElement('div');
        card.className = 'received-file-card';
        const url = URL.createObjectURL(file);
        const isImage = file.type && file.type.startsWith('image/');
        const isVideo = file.type && file.type.startsWith('video/');
        const isAudio = file.type && file.type.startsWith('audio/');
        let preview = '';
        if (isImage) preview = '<img src="' + url + '" class="file-preview-img" alt="' + UI.escapeAttr(file.name) + '">';
        else if (isVideo) preview = '<video src="' + url + '" class="file-preview-video" controls></video>';
        else if (isAudio) preview = '<audio src="' + url + '" class="file-preview-audio" controls></audio>';
        if (!preview) {
            preview = '<div class="file-preview-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></div>';
        }
        card.innerHTML = preview +
            '<div class="received-file-info"><div class="received-file-name">' + UI.escapeHtml(file.name) + ' <span style="font-size:0.75rem;color:var(--status-online);margin-left:6px;font-weight:600">✓ Sent</span></div>' +
            '<div class="received-file-size">' + FileTransfer.formatSize(file.size) + '</div></div>' +
            '<a href="' + url + '" download="' + UI.escapeAttr(file.name) + '" class="btn btn-secondary" style="padding:8px 16px;font-size:0.85rem;border-radius:8px;font-weight:600">Open</a>';
        return card;
    }

    static renderFileChatMessage(meta, url, isSent, sender, timestamp) {
        const msg = document.createElement('div');
        msg.className = 'message ' + (isSent ? 'message-sent' : 'message-received');
        const isImage = meta.fileType && meta.fileType.startsWith('image/');
        const isVideo = meta.fileType && meta.fileType.startsWith('video/');
        const isAudio = meta.fileType && meta.fileType.startsWith('audio/');
        let preview = '';
        if (url) {
            if (isImage) preview = '<img src="' + url + '" class="file-preview-img" style="max-width:200px;max-height:150px;border-radius:8px;margin-bottom:8px;display:block;box-shadow:0 2px 8px rgba(0,0,0,0.15)" alt="' + UI.escapeAttr(meta.fileName) + '">';
            else if (isVideo) preview = '<video src="' + url + '" class="file-preview-video" style="max-width:200px;max-height:150px;border-radius:8px;margin-bottom:8px;display:block" controls></video>';
            else if (isAudio) preview = '<audio src="' + url + '" class="file-preview-audio" style="width:100%;max-width:220px;margin-bottom:8px;display:block" controls></audio>';
        }
        
        const actionBtn = url ? '<a href="' + url + '" download="' + UI.escapeAttr(meta.fileName) + '" style="margin-left:auto;background:var(--accent-primary);color:white;padding:6px 12px;border-radius:8px;text-decoration:none;font-size:0.8rem;font-weight:600;display:inline-flex;align-items:center;gap:5px;box-shadow:0 2px 6px rgba(0,0,0,0.15)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Save</a>' :
            '<button class="btn btn-secondary btn-fetch-history-file" data-file-id="' + UI.escapeAttr(meta.fileId) + '" id="chat-fetch-' + UI.escapeAttr(meta.fileId) + '" style="margin-left:auto;padding:6px 12px;border-radius:8px;font-size:0.8rem;font-weight:600;display:inline-flex;align-items:center;gap:5px;cursor:pointer">⬇ Fetch (' + FileTransfer.formatSize(meta.fileSize) + ')</button>';

        const fileBox = '<div style="display:flex;align-items:center;gap:12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);padding:10px 14px;border-radius:10px;text-decoration:none;color:inherit;box-shadow:0 2px 8px rgba(0,0,0,0.08)">' +
            '<div style="width:36px;height:36px;border-radius:8px;background:rgba(108,92,231,0.15);border:1px solid rgba(108,92,231,0.25);color:var(--accent-primary);display:flex;align-items:center;justify-content:center;flex-shrink:0"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></div>' +
            '<div style="overflow:hidden;text-align:left;flex:1;min-width:0"><div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:0.88rem;color:inherit">' + UI.escapeHtml(meta.fileName) + '</div>' +
            '<div style="font-size:0.75rem;opacity:0.75;margin-top:2px">' + FileTransfer.formatSize(meta.fileSize) + '</div></div>' +
            actionBtn + '</div>';

        const sName = typeof sender === 'object' && sender ? sender.name : (sender || 'Peer');
        const sColor = typeof sender === 'object' && sender && sender.color ? sender.color : 'var(--text-secondary)';
        msg.innerHTML = (!isSent ? '<span class="message-sender" style="color:' + sColor + '">' + sName + '</span>' : '') +
            '<div class="message-bubble" style="padding:10px">' + preview + fileBox + '</div>' +
            '<div style="display:flex;align-items:center;gap:6px;' + (isSent ? 'flex-direction:row-reverse' : '') + '">' +
            '<span class="message-time">' + UI.formatTime(timestamp || Date.now()) + '</span></div>';
        return msg;
    }

    static escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
    static escapeAttr(t) { return t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;'); }
    static autoResize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 150) + 'px'; }
}
window.UI = UI;

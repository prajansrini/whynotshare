class FileTransfer {
    constructor(conn, crypto) {
        this.conn = conn;
        this.crypto = crypto;
        this.encryptionEnabled = true;
        this.incoming = new Map();
        this.cancelledTransfers = new Set();
        this.chunkSize = 64 * 1024;
        this.onProgress = null;
        this.onFileReceived = null;
        this.onIncomingFile = null;
        this.fileCache = new Map();
        this.sharedFilesHistory = new Map();
        this._initIndexedDB();
    }

    _initIndexedDB() {
        if (!window.indexedDB) return;
        try {
            const req = indexedDB.open('whynotshare_files_v1', 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('files')) {
                    db.createObjectStore('files', { keyPath: 'fileId' });
                }
            };
            req.onsuccess = (e) => { this.db = e.target.result; };
        } catch {}
    }

    async saveToIndexedDB(fileId, meta, blob, senderId, timestamp) {
        if (!fileId || !blob) return;
        this.fileCache.set(fileId, blob);
        const item = { meta, senderId: senderId || (this.conn ? this.conn.myPeerId : 'unknown'), timestamp: timestamp || Date.now() };
        this.sharedFilesHistory.set(fileId, item);
        if (!this.db && window.indexedDB) {
            await new Promise(r => setTimeout(r, 100));
        }
        if (!this.db) return;
        try {
            const tx = this.db.transaction(['files'], 'readwrite');
            tx.objectStore('files').put({ fileId, meta, blob, senderId: item.senderId, timestamp: item.timestamp });
        } catch {}
    }

    async loadFromIndexedDB(fileId) {
        if (!fileId) return null;
        if (this.fileCache.has(fileId)) return this.fileCache.get(fileId);
        if (!this.db && window.indexedDB) {
            await new Promise(r => setTimeout(r, 100));
        }
        if (!this.db) return null;
        return new Promise(resolve => {
            try {
                const tx = this.db.transaction(['files'], 'readonly');
                const req = tx.objectStore('files').get(fileId);
                req.onsuccess = () => {
                    if (req.result && req.result.blob) {
                        this.fileCache.set(fileId, req.result.blob);
                        if (req.result.meta) {
                            this.sharedFilesHistory.set(fileId, { meta: req.result.meta, senderId: req.result.senderId, timestamp: req.result.timestamp });
                        }
                        resolve(req.result.blob);
                    } else resolve(null);
                };
                req.onerror = () => resolve(null);
            } catch { resolve(null); }
        });
    }

    async getFileHistoryItem(fileId) {
        if (!fileId) return null;
        if (this.sharedFilesHistory.has(fileId)) return this.sharedFilesHistory.get(fileId);
        if (!this.db && window.indexedDB) {
            await new Promise(r => setTimeout(r, 100));
        }
        if (!this.db) return null;
        return new Promise(resolve => {
            try {
                const tx = this.db.transaction(['files'], 'readonly');
                const req = tx.objectStore('files').get(fileId);
                req.onsuccess = () => {
                    if (req.result && req.result.meta) {
                        const item = { meta: req.result.meta, senderId: req.result.senderId, timestamp: req.result.timestamp };
                        this.sharedFilesHistory.set(fileId, item);
                        if (req.result.blob) this.fileCache.set(fileId, req.result.blob);
                        resolve(item);
                    } else resolve(null);
                };
                req.onerror = () => resolve(null);
            } catch { resolve(null); }
        });
    }

    async sendFile(file) {
        const isPersonal = Boolean(window.app && window.app.personalE2E);
        const recipients = (isPersonal && window.app && window.app.selectedPersonalRecipients) ? Array.from(window.app.selectedPersonalRecipients) : null;
        if (isPersonal && (!recipients || recipients.length === 0)) {
            if (typeof UI !== 'undefined') UI.toast('Please select at least one Authorized Recipient in Personal E2E settings first!', 'error');
            if (window.app && window.app.textShare) {
                const fileId = 'sent-' + file.name + '-' + Date.now();
                const meta = { fileId, fileName: file.name, fileSize: file.size, fileType: file.type, totalChunks: 1, encrypted: true, personalEncrypted: true };
                window.app.textShare.addFileMessage(fileId, meta, null, true, { name: 'You', id: this.conn.getSocketId() }, Date.now());
            }
            return;
        }
        const fileId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        const totalChunks = Math.ceil(file.size / this.chunkSize);
        const encrypt = (this.encryptionEnabled && this.crypto.hasKey()) || isPersonal;
        const meta = { fileId, fileName: file.name, fileSize: file.size, fileType: file.type, totalChunks, encrypted: encrypt, personalEncrypted: isPersonal, recipients };
        this.saveToIndexedDB(fileId, meta, file, this.conn.myPeerId, Date.now());
        this.conn.sendFileEvent('file-meta', meta);
        const start = Date.now();
        for (let i = 0; i < totalChunks; i++) {
            if (this.cancelledTransfers.has(fileId)) {
                this.cancelledTransfers.delete(fileId);
                return;
            }
            const s = i * this.chunkSize, e = Math.min(s + this.chunkSize, file.size);
            const buf = await file.slice(s, e).arrayBuffer();
            let payload;
            if (isPersonal) {
                const enc = await this.crypto.encryptBufferWithPersonalKey(buf);
                payload = { fileId, index: i, data: enc.ciphertext, iv: enc.iv, personalEncrypted: true, recipients };
            } else if (encrypt) {
                const enc = await this.crypto.encryptBuffer(buf);
                payload = { fileId, index: i, data: this.crypto._bufToBase64(enc.ciphertext), iv: this.crypto._bufToBase64(enc.iv), recipients };
            } else {
                payload = { fileId, index: i, data: this.crypto._bufToBase64(buf), recipients };
            }
            this.conn.sendFileEvent('file-chunk', payload);
            const progress = Math.min(1, (i + 1) / totalChunks);
            const elapsed = (Date.now() - start) / 1000;
            const speed = elapsed > 0 ? e / elapsed : 0;
            if (this.onProgress) this.onProgress(fileId, progress, speed, 'upload', meta);
            if (i % 4 === 3) {
                await new Promise(r => setTimeout(r, 5));
                if (this.conn.waitForBuffer) await this.conn.waitForBuffer();
            }
        }
        if (!this.cancelledTransfers.has(fileId)) {
            this.conn.sendFileEvent('file-complete', { fileId });
        } else {
            this.cancelledTransfers.delete(fileId);
        }
    }

    cancelTransfer(fileId) {
        this.cancelledTransfers.add(fileId);
        this.incoming.delete(fileId);
        this.conn.sendFileEvent('file-cancel', { fileId });
        const tc = document.getElementById('transfer-' + fileId);
        if (tc) tc.remove();
        if (typeof UI !== 'undefined') UI.toast('Transfer cancelled', 'info');
    }

    handleFileEvent(type, data) {
        const senderId = data.senderId;
        if (senderId === this.conn.myPeerId) return;
        if (data.recipients && Array.isArray(data.recipients) && data.recipients.length > 0) {
            if (!data.recipients.includes(this.conn.myPeerId) && senderId !== this.conn.myPeerId) {
                return;
            }
        }
        switch (type) {
            case 'file-meta': this._onMeta(data); break;
            case 'file-chunk': this._onChunk(data); break;
            case 'file-complete': this._onComplete(data); break;
            case 'file-cancel': this._onCancel(data); break;
        }
    }

    _onMeta(data) {
        this.incoming.set(data.fileId, { meta: data, chunks: new Array(data.totalChunks), received: 0, startTime: Date.now(), senderId: data.senderId });
        if (this.onIncomingFile) this.onIncomingFile(data.fileId, data);
    }

    async _onChunk(data) {
        const info = this.incoming.get(data.fileId);
        if (!info) return;
        let buf;
        if (data.iv && data.personalEncrypted) {
            try {
                buf = await this.crypto.decryptBufferWithPersonalKey(data.data, data.iv, info.senderId);
            } catch (err) {
                if (typeof UI !== 'undefined') UI.toast('Personal E2E decryption failed! You are not an authorized recipient.', 'error');
                this.incoming.delete(data.fileId);
                const tc = document.getElementById('transfer-' + data.fileId);
                if (tc) tc.remove();
                return;
            }
        } else if (data.iv && info.meta.encrypted && this.crypto.hasKey()) {
            try {
                buf = await this.crypto.decryptBuffer(this.crypto._base64ToBuf(data.data), this.crypto._base64ToBuf(data.iv));
            } catch (err) {
                if (typeof UI !== 'undefined') UI.toast('File decryption failed! Check passphrase or toggle E2E mode.', 'error');
                this.incoming.delete(data.fileId);
                const tc = document.getElementById('transfer-' + data.fileId);
                if (tc) tc.remove();
                return;
            }
        } else { buf = this.crypto._base64ToBuf(data.data); }
        if (!info.chunks[data.index]) {
            info.chunks[data.index] = new Uint8Array(buf);
            info.received++;
        }
        const progress = Math.min(1, info.received / info.meta.totalChunks);
        const elapsed = (Date.now() - info.startTime) / 1000;
        const speed = elapsed > 0 ? (info.received * this.chunkSize) / elapsed : 0;
        if (this.onProgress) this.onProgress(data.fileId, progress, speed, 'download', info.meta);
    }

    _onComplete(data) {
        const info = this.incoming.get(data.fileId);
        if (!info) return;
        const blob = new Blob(info.chunks, { type: info.meta.fileType || 'application/octet-stream' });
        this.saveToIndexedDB(data.fileId, info.meta, blob, info.senderId, info.startTime);
        if (this.onFileReceived) this.onFileReceived(data.fileId, info.meta, blob, info.senderId);
        this.incoming.delete(data.fileId);
    }

    _onCancel(data) {
        this.incoming.delete(data.fileId);
        const tc = document.getElementById('transfer-' + data.fileId);
        if (tc) tc.remove();
        if (typeof UI !== 'undefined') UI.toast('Peer cancelled file transfer', 'info');
    }

    setEncryption(on) { this.encryptionEnabled = on; }

    async sendCachedFileToPeer(fileId, targetPeerId) {
        if (!fileId || !targetPeerId) return false;
        const blob = await this.loadFromIndexedDB(fileId);
        if (!blob) return false;
        const historyItem = await this.getFileHistoryItem(fileId);
        const meta = historyItem && historyItem.meta ? { ...historyItem.meta } : {
            fileId, fileName: blob.name || 'History_File', fileSize: blob.size, fileType: blob.type, totalChunks: Math.ceil(blob.size / this.chunkSize), encrypted: false
        };
        meta.recipients = [targetPeerId];
        meta.historyTransfer = true;
        this.conn.sendFileEvent('file-meta', meta);
        const totalChunks = Math.ceil(blob.size / this.chunkSize);
        const start = Date.now();
        for (let i = 0; i < totalChunks; i++) {
            if (this.cancelledTransfers.has(fileId)) {
                this.cancelledTransfers.delete(fileId);
                return false;
            }
            const s = i * this.chunkSize, e = Math.min(s + this.chunkSize, blob.size);
            const sliceBuf = await blob.slice(s, e).arrayBuffer();
            let payload;
            if (meta.encrypted && this.crypto.hasKey()) {
                const enc = await this.crypto.encryptBuffer(sliceBuf);
                payload = { fileId, index: i, data: this.crypto._bufToBase64(enc.ciphertext), iv: this.crypto._bufToBase64(enc.iv), recipients: [targetPeerId] };
            } else {
                payload = { fileId, index: i, data: this.crypto._bufToBase64(sliceBuf), recipients: [targetPeerId] };
            }
            this.conn.sendFileEvent('file-chunk', payload);
            const progress = Math.min(1, (i + 1) / totalChunks);
            const elapsed = (Date.now() - start) / 1000;
            const speed = elapsed > 0 ? e / elapsed : 0;
            if (this.onProgress) this.onProgress(fileId, progress, speed, 'upload', meta);
            if (i % 4 === 3) {
                await new Promise(r => setTimeout(r, 5));
                if (this.conn.waitForBuffer) await this.conn.waitForBuffer();
            }
        }
        this.conn.sendFileEvent('file-complete', { fileId, recipients: [targetPeerId] });
        return true;
    }

    static formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
        return (bytes / 1073741824).toFixed(2) + ' GB';
    }

    static formatSpeed(bps) {
        if (bps < 1024) return bps.toFixed(0) + ' B/s';
        if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
        return (bps / 1048576).toFixed(1) + ' MB/s';
    }
}
window.FileTransfer = FileTransfer;

class FileTransfer {
    constructor(conn, crypto) {
        this.conn = conn;
        this.crypto = crypto;
        this.encryptionEnabled = true;
        this.incoming = new Map();
        this.chunkSize = 64 * 1024;
        this.onProgress = null;
        this.onFileReceived = null;
        this.onIncomingFile = null;
    }

    async sendFile(file) {
        const fileId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        const totalChunks = Math.ceil(file.size / this.chunkSize);
        const encrypt = this.encryptionEnabled && this.crypto.hasKey();
        const meta = { fileId, fileName: file.name, fileSize: file.size, fileType: file.type, totalChunks, encrypted: encrypt };
        this.conn.sendFileEvent('file-meta', meta);
        const start = Date.now();
        for (let i = 0; i < totalChunks; i++) {
            const s = i * this.chunkSize, e = Math.min(s + this.chunkSize, file.size);
            const buf = await file.slice(s, e).arrayBuffer();
            let payload;
            if (encrypt) {
                const enc = await this.crypto.encryptBuffer(buf);
                payload = { fileId, index: i, data: this.crypto._bufToBase64(enc.ciphertext), iv: this.crypto._bufToBase64(enc.iv) };
            } else {
                payload = { fileId, index: i, data: this.crypto._bufToBase64(buf) };
            }
            this.conn.sendFileEvent('file-chunk', payload);
            const progress = (i + 1) / totalChunks;
            const elapsed = (Date.now() - start) / 1000;
            const speed = elapsed > 0 ? e / elapsed : 0;
            if (this.onProgress) this.onProgress(fileId, progress, speed, 'upload', meta);
            if (i % 8 === 7) await new Promise(r => setTimeout(r, 5));
        }
        this.conn.sendFileEvent('file-complete', { fileId });
    }

    handleFileEvent(type, data) {
        const senderId = data.senderId;
        if (senderId === this.conn.myPeerId) return;
        switch (type) {
            case 'file-meta': this._onMeta(data); break;
            case 'file-chunk': this._onChunk(data); break;
            case 'file-complete': this._onComplete(data); break;
        }
    }

    _onMeta(data) {
        this.incoming.set(data.fileId, { meta: data, chunks: new Array(data.totalChunks), received: 0, startTime: Date.now() });
        if (this.onIncomingFile) this.onIncomingFile(data.fileId, data);
    }

    async _onChunk(data) {
        const info = this.incoming.get(data.fileId);
        if (!info) return;
        let buf;
        if (data.iv && info.meta.encrypted && this.crypto.hasKey()) {
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
        info.chunks[data.index] = new Uint8Array(buf);
        info.received++;
        const progress = info.received / info.meta.totalChunks;
        const elapsed = (Date.now() - info.startTime) / 1000;
        const speed = elapsed > 0 ? (info.received * this.chunkSize) / elapsed : 0;
        if (this.onProgress) this.onProgress(data.fileId, progress, speed, 'download', info.meta);
    }

    _onComplete(data) {
        const info = this.incoming.get(data.fileId);
        if (!info) return;
        const blob = new Blob(info.chunks, { type: info.meta.fileType || 'application/octet-stream' });
        if (this.onFileReceived) this.onFileReceived(data.fileId, info.meta, blob);
        this.incoming.delete(data.fileId);
    }

    setEncryption(on) { this.encryptionEnabled = on; }

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

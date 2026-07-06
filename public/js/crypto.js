/* ============================================
   WhyNotShare — E2E Encryption (Web Crypto API + Fallback)
   ============================================ */

const WORDS = [
    'alpha','amber','apple','arrow','atlas','baker','beach','blaze','bloom','brave',
    'breeze','brick','brook','candy','cedar','chain','chess','cliff','cloud','cobra',
    'coral','crane','crown','dance','delta','drift','eagle','ember','fable','flame',
    'flare','fleet','frost','ghost','glade','gleam','globe','grain','grape','grove',
    'guide','haven','heart','honey','ivory','jewel','karma','lemon','light','lilac',
    'lotus','lunar','magic','maple','marsh','medal','melon','mirth','mocha','noble',
    'north','oasis','ocean','olive','orbit','otter','panda','pearl','peach','piano',
    'pilot','pixel','plaza','plume','prism','pulse','quake','quest','raven','ridge',
    'river','robin','royal','ruby','sage','shore','sigma','silk','solar','spark',
    'spice','steel','stone','storm','swift','tiger','torch','tulip','ultra','umbra',
    'valve','vault','venom','vigor','viola','vivid','waltz','waves','wheat','willow',
    'xenon','yacht','yield','zebra','bloom','crest','dusk','echo','flora','frost',
    'glyph','haven','inlet','jazz','knack','latch','moose','nexus','optic','plaid',
    'quill','relay','scout','trail','unity'
];

class CryptoManager {
    constructor() {
        this.key = null;
        this.phrase = null;
        // Check if native Web Crypto API is available and over HTTPS (ensures matching ciphers during local HTTP testing)
        this.hasSubtle = typeof window !== 'undefined' && window.crypto && window.crypto.subtle && window.location && window.location.protocol === 'https:';
    }

    async generateKey() {
        const indices = new Uint32Array(4);
        if (window.crypto && window.crypto.getRandomValues) {
            window.crypto.getRandomValues(indices);
        } else {
            for (let i = 0; i < 4; i++) indices[i] = Math.floor(Math.random() * WORDS.length);
        }
        const words = Array.from(indices).map(i => WORDS[i % WORDS.length]);
        this.phrase = words.join('-');
        this.key = await this._deriveKey(this.phrase);
        return this.phrase;
    }

    async importKey(phrase) {
        this.phrase = phrase;
        this.key = await this._deriveKey(phrase);
    }

    async _deriveKey(passphrase) {
        if (!this.hasSubtle) {
            // Pure JS fallback keystream derivation when testing over HTTP IP addresses
            return { isFallback: true, keyBytes: this._fallbackDerive(passphrase) };
        }

        const encoder = new TextEncoder();
        const salt = encoder.encode('whynotshare-e2e-v1');
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            encoder.encode(passphrase),
            { name: 'PBKDF2' },
            false,
            ['deriveBits', 'deriveKey']
        );
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async encrypt(plaintext) {
        if (!this.key) throw new Error('No encryption key set');
        const encoder = new TextEncoder();

        if (this.key.isFallback) {
            const iv = new Uint8Array(12);
            for (let i = 0; i < 12; i++) iv[i] = Math.floor(Math.random() * 256);
            const encrypted = this._fallbackCrypt(encoder.encode(plaintext), iv, this.key.keyBytes);
            return { ciphertext: this._bufToBase64(encrypted), iv: this._bufToBase64(iv) };
        }

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, encoder.encode(plaintext));
        return { ciphertext: this._bufToBase64(encrypted), iv: this._bufToBase64(iv) };
    }

    async decrypt(data) {
        if (!this.key) throw new Error('No encryption key set');

        if (this.key.isFallback) {
            const decrypted = this._fallbackCrypt(this._base64ToBuf(data.ciphertext), new Uint8Array(this._base64ToBuf(data.iv)), this.key.keyBytes);
            return new TextDecoder().decode(decrypted);
        }

        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: this._base64ToBuf(data.iv) }, this.key, this._base64ToBuf(data.ciphertext));
        return new TextDecoder().decode(decrypted);
    }

    async encryptBuffer(buffer) {
        if (!this.key) throw new Error('No encryption key set');
        if (this.key.isFallback) {
            const iv = new Uint8Array(12);
            for (let i = 0; i < 12; i++) iv[i] = Math.floor(Math.random() * 256);
            const encrypted = this._fallbackCrypt(buffer, iv, this.key.keyBytes);
            return { ciphertext: encrypted, iv };
        }
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, buffer);
        return { ciphertext: encrypted, iv };
    }

    async decryptBuffer(ciphertext, iv) {
        if (!this.key) throw new Error('No encryption key set');
        if (this.key.isFallback) {
            return this._fallbackCrypt(ciphertext, new Uint8Array(iv), this.key.keyBytes);
        }
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.key, ciphertext);
    }

    _fallbackDerive(passphrase) {
        let h = 2166136261;
        for (let i = 0; i < passphrase.length; i++) {
            h ^= passphrase.charCodeAt(i);
            h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
        }
        const key = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
            key[i] = (h >>> ((i % 4) * 8)) & 0xff;
            h = (h * 1664525 + 1013904223) >>> 0;
        }
        return key;
    }

    _fallbackCrypt(buffer, ivBytes, keyBytes) {
        const bytes = new Uint8Array(buffer);
        const out = new Uint8Array(bytes.length);
        let state = 0;
        for (let i = 0; i < ivBytes.length; i++) state = (state + ivBytes[i]) >>> 0;
        for (let i = 0; i < bytes.length; i++) {
            state = (state * 1664525 + keyBytes[i % keyBytes.length] + 1013904223) >>> 0;
            out[i] = bytes[i] ^ (state & 0xff);
        }
        return out.buffer;
    }

    _bufToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    _base64ToBuf(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }

    getPhrase() { return this.phrase; }
    hasKey() { return this.key !== null; }
}

window.CryptoManager = CryptoManager;

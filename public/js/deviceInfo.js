/* ============================================
   WhyNotShare — Device Info Detection
   ============================================ */

class DeviceInfo {
    static detect() {
        const ua = navigator.userAgent;
        return {
            deviceName: DeviceInfo.getFriendlyName(ua),
            systemName: `${DeviceInfo.getBrowser(ua)} on ${DeviceInfo.getOS(ua)}`,
            deviceType: DeviceInfo.getType(ua),
            browser: DeviceInfo.getBrowser(ua),
            os: DeviceInfo.getOS(ua)
        };
    }

    static getType(ua) {
        if (/iPad|tablet/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua))) return 'tablet';
        if (/Mobile|Android|iPhone|iPod/i.test(ua)) return 'phone';
        return 'laptop';
    }

    static getBrowser(ua) {
        if (/Edg\//i.test(ua)) return 'Edge';
        if (/OPR\//i.test(ua) || /Opera/i.test(ua)) return 'Opera';
        if (/Firefox\//i.test(ua)) return 'Firefox';
        if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return 'Chrome';
        if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'Safari';
        return 'Browser';
    }

    static getOS(ua) {
        if (/Windows/i.test(ua)) return 'Windows';
        if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
        if (/Mac/i.test(ua)) return 'macOS';
        if (/Android/i.test(ua)) return 'Android';
        if (/Linux/i.test(ua)) return 'Linux';
        if (/CrOS/i.test(ua)) return 'ChromeOS';
        return 'Unknown';
    }

    static DRINK_NAMES = [
        "Mango Lassi", "Salted Chaas", "Sattu Sharbat", "Aam Panna", "Kokum Sharbat",
        "Sol Kadhi", "Ragi Malt", "Badam Milk", "Turmeric Milk", "Kashmiri Kahwa",
        "Tulsi Tea", "Ginger Tea", "Lemongrass Tea", "Jeera Water", "Ajwain Water",
        "Saunf Water", "Coriander Water", "Barley Water", "Amla Juice", "Aloe Juice",
        "Sugarcane Juice", "Coconut Water", "Nimbu Pani", "Bael Sharbat", "Panakam Drink",
        "Jowar Malt", "Bajra Raab", "Ragi Ambli", "Kanji Drink", "Neer Mor",
        "Jigarthanda Drink", "Palm Nectar", "Bel Panna", "Mint Cooler", "Cucumber Juice",
        "Carrot Juice", "Beetroot Juice", "Ash Gourd", "Jamun Juice", "Wood Apple"
    ];

    static getFriendlyName(ua) {
        try {
            const saved = localStorage.getItem('whynotshare_drink_name');
            if (saved && saved.trim()) return saved.trim();
            
            const old = localStorage.getItem('whynotshare_device_name');
            if (old && old.trim()) {
                let cleanOld = old.trim();
                if (/on (Linux|Android|Windows|iOS|macOS|ChromeOS)/i.test(cleanOld) || cleanOld === 'Unknown') {
                    return DeviceInfo.generateRandomName();
                }
                cleanOld = cleanOld.replace(/\s*\((Linux|Android|Windows|iOS|macOS|ChromeOS|Unknown)\)\s*$/i, '');
                if (cleanOld && !/on /i.test(cleanOld)) {
                    localStorage.setItem('whynotshare_drink_name', cleanOld);
                    localStorage.setItem('whynotshare_device_name', cleanOld);
                    return cleanOld;
                }
            }
        } catch {}
        return DeviceInfo.generateRandomName();
    }

    static generateRandomName() {
        const randomDrink = DeviceInfo.DRINK_NAMES[Math.floor(Math.random() * DeviceInfo.DRINK_NAMES.length)];
        try {
            localStorage.setItem('whynotshare_drink_name', randomDrink);
            localStorage.setItem('whynotshare_device_name', randomDrink);
        } catch {}
        return randomDrink;
    }

    static setCustomName(name) {
        if (!name || !name.trim()) return null;
        const clean = name.trim();
        try {
            localStorage.setItem('whynotshare_drink_name', clean);
            localStorage.setItem('whynotshare_device_name', clean);
        } catch {}
        return clean;
    }

    static getIcon(deviceType) {
        switch (deviceType) {
            case 'phone': return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-3px"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/><circle cx="12" cy="6" r="0.5" fill="currentColor"/></svg>';
            case 'tablet': return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-3px"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';
            case 'laptop': return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-3px"><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/></svg>';
            default: return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-3px"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
        }
    }

    // Peer colors for multi-device
    static PEER_COLORS = [
        '#6c5ce7', '#00cec9', '#fd79a8', '#ffd93d',
        '#00b894', '#e17055', '#0984e3', '#a29bfe',
        '#fab1a0', '#55efc4'
    ];

    static getColor(index) {
        return DeviceInfo.PEER_COLORS[index % DeviceInfo.PEER_COLORS.length];
    }
}

window.DeviceInfo = DeviceInfo;

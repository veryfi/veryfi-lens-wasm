async function gatherBrowserData () {
    const getCanvasFingerprint = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#f60';
        ctx.fillRect(125, 1, 62, 20);
        ctx.fillStyle = '#069';
        ctx.fillText('Hello, world!', 2, 15);
        ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
        ctx.fillText('Hello, world!', 4, 17);
        return canvas.toDataURL();
    };

    const hashCanvasFingerprint = async () => {
        const fingerprint = await getCanvasFingerprint();
        const data = new TextEncoder().encode(fingerprint);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    };

    const getWebGLRenderer = () => {
        const gl = document.createElement('canvas').getContext('webgl');
        if (!gl) {
            return 'WebGL not supported';
        }
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        return gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
    };

    return {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tzOffset: new Date().getTimezoneOffset(),
        screenSize: `${window.screen.width}x${window.screen.height}x${window.screen.colorDepth}`,
        isCookiesEnabled: navigator.cookieEnabled,
        domLocalStorage: typeof window.localStorage !== 'undefined',
        domSessionStorage: typeof window.sessionStorage !== 'undefined',
        indexedDB: !!window.indexedDB,
        canvasFingerprint: await hashCanvasFingerprint(),
        webglRenderer: getWebGLRenderer(),
        isDntHeaderEnabled: navigator.doNotTrack || false,
        language: navigator.language,
        platform: navigator.platform,
        maxTouchpoints: navigator.maxTouchPoints || 0,
        hardwareConcurrency: navigator.hardwareConcurrency || 'unknown',
        deviceMemory: navigator.deviceMemory || 'unknown'
    };
}

export default gatherBrowserData;

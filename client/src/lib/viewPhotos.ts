/**
 * Fotos fuer die einfache Ansicht (Launch Block D): vor dem Hochladen im Browser
 * verkleinern und neu als JPEG speichern. Beim Neuzeichnen auf der Leinwand
 * fallen alle Metadaten weg, auch die Ortsdaten (GPS). Der Server prueft das
 * zusaetzlich (server/src/lib/viewPhotos.ts).
 */

/** Laengste Seite in Pixeln: reicht fuer ein Tablet, haelt die Sicherung klein. */
export const VIEW_PHOTO_MAX_EDGE = 1600;
/** Wie im Server (MAX_VIEW_PHOTOS, MAX_VIEW_PHOTO_BYTES). */
export const MAX_VIEW_PHOTOS = 20;
const MAX_BYTES = Math.floor(1.5 * 1024 * 1024);
const QUALITIES = [0.85, 0.75, 0.65];

/** Bytes einer base64-data-URL (ohne Kopf). */
const dataUrlBytes = (dataUrl: string): number => {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
};

const loadImage = (file: File): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
        img.src = url;
    });

/**
 * Verkleinertes JPEG ohne Metadaten als data URL. Die Ausrichtung aus der Kamera
 * wendet der Browser beim Zeichnen an (image-orientation: from-image).
 * Wirft einen Fehler, wenn die Datei kein Bild ist oder zu gross bleibt.
 */
export async function prepareViewPhoto(file: File): Promise<string> {
    if (!file.type.startsWith('image/')) throw new Error('format');
    const img = await loadImage(file);
    const scale = Math.min(1, VIEW_PHOTO_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    // Weisser Grund fuer Bilder mit Transparenz (JPEG kennt keine).
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    for (const quality of QUALITIES) {
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (dataUrl.startsWith('data:image/jpeg') && dataUrlBytes(dataUrl) <= MAX_BYTES) return dataUrl;
    }
    throw new Error('size');
}

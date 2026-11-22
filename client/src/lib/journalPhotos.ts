// Fotos im Pflegetagebuch: Verkleinern vor dem Hochladen (normale App und Teambereich am Tablet).

export const MAX_PHOTOS = 4;
export const MAX_PHOTO_BYTES = Math.floor(1.5 * 1024 * 1024);
export const MAX_PHOTO_DIMENSION = 1280;

/** Taille décodée approximative d'une data URL base64, sans allouer de buffer. */
export const dataUrlBytes = (dataUrl: string): number => {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
};

/**
 * Compression côté client (même approche que l'avatar dans Settings.tsx):
 * redimensionne à 1280px max via canvas puis encode en JPEG, en baissant la
 * qualité tant que la photo dépasse 1,5 Mo. Retourne null si impossible.
 */
export const compressImage = async (file: File): Promise<string | null> => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('read'));
        reader.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('decode'));
        image.src = dataUrl;
    });

    const scale = Math.min(1, MAX_PHOTO_DIMENSION / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    for (const quality of [0.8, 0.6, 0.4]) {
        const out = canvas.toDataURL('image/jpeg', quality);
        if (dataUrlBytes(out) <= MAX_PHOTO_BYTES) return out;
    }
    return null;
};

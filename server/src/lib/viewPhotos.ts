/**
 * Fotos fuer die einfache Ansicht der betreuten Person (Launch Block D).
 *
 * Der Browser verkleinert jedes Foto vor dem Hochladen und speichert es neu als
 * JPEG (client/src/lib/viewPhotos.ts); dabei fallen die Metadaten weg. Der Server
 * verlaesst sich nicht darauf: Er nimmt nur JPEG an und entfernt selbst alle
 * Abschnitte, die Metadaten tragen koennen (EXIF mit Ortsdaten, XMP, IPTC,
 * Kommentare). Gespeichert wird wie bei den uebrigen Fotos als data URL.
 */

/** Hoechstzahl Fotos pro Kreis. */
export const MAX_VIEW_PHOTOS = 20;

/** Hoechstgroesse eines Fotos nach dem Verkleinern (1600 px reichen fuer ein Tablet). */
export const MAX_VIEW_PHOTO_BYTES = Math.floor(1.5 * 1024 * 1024);

const JPEG_DATA_URL_REGEX = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Behaltene Abschnitte vor den Bilddaten: APP0 (JFIF), APP2 (Farbprofil) und
 * APP14 (Adobe, noetig fuer die Farbumrechnung). Alle anderen APPn (darunter
 * APP1 = EXIF/XMP mit GPS und APP13 = IPTC) und Kommentare (COM) fallen weg.
 */
const KEPT_APP_MARKERS = new Set([0xe0, 0xe2, 0xee]);

/** JPEG ohne Metadaten, oder null, wenn die Datei kein gueltiges JPEG ist. */
export function stripJpegMetadata(input: Buffer): Buffer | null {
    if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return null;
    const parts: Buffer[] = [input.subarray(0, 2)];
    let pos = 2;
    while (pos < input.length) {
        if (input[pos] !== 0xff) return null;
        // Fuellbytes 0xFF vor einer Markierung ueberspringen.
        while (pos + 1 < input.length && input[pos + 1] === 0xff) pos++;
        if (pos + 1 >= input.length) return null;
        const marker = input[pos + 1];
        // Beginn der Bilddaten: der Rest bleibt unveraendert.
        if (marker === 0xda) {
            parts.push(input.subarray(pos));
            return Buffer.concat(parts);
        }
        // Markierungen ohne Laengenangabe
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            parts.push(input.subarray(pos, pos + 2));
            pos += 2;
            continue;
        }
        if (marker === 0xd9) return null; // Ende ohne Bilddaten
        if (pos + 4 > input.length) return null;
        const length = input.readUInt16BE(pos + 2);
        if (length < 2 || pos + 2 + length > input.length) return null;
        const isApp = marker >= 0xe0 && marker <= 0xef;
        const drop = marker === 0xfe || (isApp && !KEPT_APP_MARKERS.has(marker));
        if (!drop) parts.push(input.subarray(pos, pos + 2 + length));
        pos += 2 + length;
    }
    return null;
}

export type ViewPhotoCheck =
    | { ok: true; dataUrl: string; sizeBytes: number }
    | { ok: false; error: 'format' | 'size' };

/** Prueft ein hochgeladenes Foto und gibt es ohne Metadaten zurueck. */
export function cleanViewPhoto(value: unknown): ViewPhotoCheck {
    const match = typeof value === 'string' ? value.match(JPEG_DATA_URL_REGEX) : null;
    if (!match) return { ok: false, error: 'format' };
    const raw = Buffer.from(match[1], 'base64');
    if (raw.length > MAX_VIEW_PHOTO_BYTES) return { ok: false, error: 'size' };
    const clean = stripJpegMetadata(raw);
    if (!clean) return { ok: false, error: 'format' };
    return { ok: true, dataUrl: `data:image/jpeg;base64,${clean.toString('base64')}`, sizeBytes: clean.length };
}

import { describe, it, expect } from 'vitest';
import { cleanViewPhoto, stripJpegMetadata, MAX_VIEW_PHOTO_BYTES } from '../../server/src/lib/viewPhotos';

// Block D: Fotos fuer die einfache Ansicht, ohne Metadaten (Ortsdaten).

const segment = (marker: number, payload: number[]) => [0xff, marker, 0x00, payload.length + 2, ...payload];
const SOS_AND_DATA = [0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9];
const APP0 = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00]); // JFIF
const APP1 = segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53]); // "Exif" ... "GPS"
const COM = segment(0xfe, [0x68, 0x69]);
const jpeg = (...parts: number[][]) => Buffer.from([0xff, 0xd8, ...parts.flat(), ...SOS_AND_DATA]);

describe('stripJpegMetadata', () => {
    it('entfernt EXIF und Kommentare, behaelt JFIF und Bilddaten', () => {
        const out = stripJpegMetadata(jpeg(APP0, APP1, COM));
        expect(out).toEqual(jpeg(APP0));
    });

    it('laesst ein JPEG ohne Metadaten unveraendert', () => {
        expect(stripJpegMetadata(jpeg(APP0))).toEqual(jpeg(APP0));
    });

    it('lehnt kaputte oder fremde Dateien ab', () => {
        expect(stripJpegMetadata(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
        expect(stripJpegMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40, 0x01]))).toBeNull();
        expect(stripJpegMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    });
});

describe('cleanViewPhoto', () => {
    const asDataUrl = (buf: Buffer, mime = 'image/jpeg') => `data:${mime};base64,${buf.toString('base64')}`;

    it('nimmt nur JPEG als data URL an und entfernt die Ortsdaten', () => {
        const result = cleanViewPhoto(asDataUrl(jpeg(APP0, APP1)));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.dataUrl).toBe(asDataUrl(jpeg(APP0)));
    });

    it('lehnt PNG, SVG und Text ab', () => {
        expect(cleanViewPhoto(asDataUrl(Buffer.from('x'), 'image/png'))).toEqual({ ok: false, error: 'format' });
        expect(cleanViewPhoto('data:image/svg+xml;base64,PHN2Zz4=')).toEqual({ ok: false, error: 'format' });
        expect(cleanViewPhoto(42)).toEqual({ ok: false, error: 'format' });
    });

    it('lehnt zu grosse Fotos ab', () => {
        const big = Buffer.alloc(MAX_VIEW_PHOTO_BYTES + 1, 0);
        big[0] = 0xff; big[1] = 0xd8;
        expect(cleanViewPhoto(asDataUrl(big))).toEqual({ ok: false, error: 'size' });
    });
});

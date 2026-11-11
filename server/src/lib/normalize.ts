export const toNullIfEmpty = <T>(value: T | null | undefined): T | null => {
    if (value === undefined || value === null) {
        return null;
    }

    if (typeof value === 'string' && value.trim() === '') {
        return null;
    }

    return value;
};

/**
 * Benutzername (E18): Vorname und Nachname, vom Admin beim Einladen gesetzt.
 * Leerraum wird zusammengefasst, damit "Erika  Muster" und "Erika Muster" dasselbe
 * Konto sind. Gross- und Kleinschreibung zaehlt nicht: verglichen wird in SQL
 * immer mit LOWER(username) (eindeutiger Index idx_users_username_lower).
 */
export const normalizeUsername = (value: string): string =>
    value.normalize('NFC').replace(/\s+/g, ' ').trim();

export const MAX_NAME_PART_LENGTH = 100;

/** Benutzername aus Vor- und Nachname, oder null wenn ein Teil fehlt oder zu lang ist. */
export const buildUsername = (firstName: unknown, lastName: unknown): string | null => {
    if (typeof firstName !== 'string' || typeof lastName !== 'string') return null;
    const first = normalizeUsername(firstName);
    const last = normalizeUsername(lastName);
    if (!first || !last || first.length > MAX_NAME_PART_LENGTH || last.length > MAX_NAME_PART_LENGTH) return null;
    return `${first} ${last}`;
};

export const serializeStringArray = (value: unknown): string | null => {
    if (value === undefined || value === null) {
        return null;
    }

    if (Array.isArray(value)) {
        const cleaned = value
            .map((item) => (typeof item === 'string' ? item.trim() : ''))
            .filter(Boolean);

        return cleaned.length > 0 ? JSON.stringify(cleaned) : null;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }

        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return serializeStringArray(parsed);
            }
        } catch {
            // Keep plain strings for backward compatibility.
        }

        return trimmed;
    }

    return null;
};

export const parseStringArray = (value: unknown): string[] => {
    if (value === undefined || value === null) {
        return [];
    }

    if (Array.isArray(value)) {
        return value
            .map((item) => (typeof item === 'string' ? item.trim() : ''))
            .filter(Boolean);
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return [];
        }

        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parseStringArray(parsed);
            }
        } catch {
            // Support legacy comma separated values.
        }

        return trimmed
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }

    return [];
};

export const toOptionalNumber = (value: unknown): number | null => {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

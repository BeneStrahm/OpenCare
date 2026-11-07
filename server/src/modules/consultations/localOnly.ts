// "Nur lokal": Gespraechsaudio, Mitschriften und Fachwoerter duerfen nur an
// Dienste im eigenen Netz gehen (Whisper, Ollama). Geprueft wird die Adresse,
// nicht nur der eingestellte Anbieter: Ein "Ollama" im Internet ist nicht lokal.
//
// Als lokal gilt eine Adresse, wenn ALLE aufgeloesten IPs im eigenen Netz liegen:
// Loopback, RFC 1918 (10/8, 172.16/12, 192.168/16), IPv6 unique-local (fc00::/7)
// und 100.64.0.0/10 (CGNAT, z. B. Tailscale/WireGuard-Netze zum Admin).
//
// Ausnahme fuer bewusst betriebene eigene Server mit oeffentlicher Adresse:
// Hostnamen in LOCAL_AI_ALLOWED_HOSTS (kommagetrennt) gelten als lokal.

import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { canonicalizeIp, canonicalizeIpv6, isBlockedAddress } from '../../utils/urlGuard';

const inCgnat = (ip: string): boolean => {
    const parts = ip.split('.').map(Number);
    return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
};

/** true fuer eine Adresse im eigenen Netz (ohne Metadaten-/Link-local-Adressen). */
export function isLocalAddress(rawIp: string): boolean {
    const ip = canonicalizeIp(rawIp);
    if (isIP(ip) === 4 && inCgnat(ip)) return true;
    if (isIP(ip) === 4 && (ip.startsWith('169.254.') || ip.startsWith('0.'))) return false;
    if (isIP(ip) === 6) {
        const n = canonicalizeIpv6(ip);
        if (n.startsWith('fe8') || n.startsWith('fe9') || n.startsWith('fea') || n.startsWith('feb')) return false;
        if (n === '0000:0000:0000:0000:0000:0000:0000:0000') return false;
    }
    // Privat = mit blockPrivate gesperrt, ohne blockPrivate erlaubt.
    return isBlockedAddress(ip, true) !== null && isBlockedAddress(ip, false) === null;
}

export function allowedHosts(): string[] {
    return (process.env.LOCAL_AI_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
}

type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) =>
    (await dns.lookup(hostname, { all: true, verbatim: true })).map((r) => r.address);

/**
 * Prueft, ob eine Dienst-Adresse im eigenen Netz liegt. Bei Zweifel (ungueltige
 * URL, DNS-Fehler, keine Adresse) gilt sie als NICHT lokal.
 */
export async function isLocalServiceUrl(rawUrl: string | null | undefined, resolve: Resolver = defaultResolver): Promise<boolean> {
    if (!rawUrl) return false;
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (allowedHosts().includes(host)) return true;
    let ips: string[];
    try {
        ips = isIP(host) ? [host] : await resolve(host);
    } catch {
        return false;
    }
    return ips.length > 0 && ips.every(isLocalAddress);
}

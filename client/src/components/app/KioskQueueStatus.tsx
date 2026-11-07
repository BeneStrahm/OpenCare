import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CloudUpload } from 'lucide-react';
import { useLocalRecordings } from '../consultations/useLocalRecordings';

/**
 * Tablet: Stand der Warteschlange fuer Arztgespraeche in einem Satz.
 * Zeigt nichts, wenn keine Aufnahme wartet.
 */
const C = { text: '#1d2433', muted: '#5b6472', red: '#c62828', warnBg: '#fdecea', infoBg: '#eef3ff' };

interface Props {
    fontScale: number;
    /** kleinere Schrift, z. B. in der Kachel */
    compact?: boolean;
}

const KioskQueueStatus: React.FC<Props> = ({ fontScale, compact }) => {
    const { t } = useTranslation(['consultations']);
    const { items, uploader } = useLocalRecordings();
    const mine = items.filter((r) => r.from_kiosk && r.state !== 'recording');
    if (mine.length === 0) return null;

    const size = compact ? 15 : 22;
    const fs: React.CSSProperties = { fontSize: `calc(${size}px * ${fontScale || 1})` };
    const needsHelp = mine.some((r) => uploader.needsHelp[r.client_id] ?? r.needs_help);
    const progress = uploader.progress && mine.some((r) => r.client_id === uploader.progress?.client_id) ? uploader.progress : null;

    let text: string;
    let warn = false;
    if (uploader.authProblem) {
        text = t('consultations:kiosk.queueUnpaired');
        warn = true;
    } else if (needsHelp) {
        text = t('consultations:kiosk.queueNeedsHelp');
        warn = true;
    } else if (progress) {
        text = t('consultations:queue.uploading', { sent: progress.sent, total: progress.total });
    } else if (uploader.offline) {
        text = t('consultations:queue.waitingOffline', { count: mine.length });
    } else {
        text = t('consultations:queue.waiting', { count: mine.length });
    }

    const Icon = warn ? AlertTriangle : CloudUpload;
    return (
        // span statt p: steht auch innerhalb der Kachel-Taste (gueltiges HTML).
        <span
            className={`flex items-start gap-2 rounded-2xl text-left ${compact ? 'mt-1 p-2' : 'p-4'}`}
            style={{ ...fs, color: warn ? C.red : C.text, backgroundColor: warn ? C.warnBg : C.infoBg }}
            role={compact ? undefined : warn ? 'alert' : 'status'}
        >
            <Icon className={compact ? 'mt-0.5 h-5 w-5 shrink-0' : 'mt-1 h-7 w-7 shrink-0'} aria-hidden="true" />
            <span>{text}</span>
        </span>
    );
};

export default KioskQueueStatus;

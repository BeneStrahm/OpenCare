import { useEffect, useState } from 'react';
import { listRecordings, type LocalRecording } from '../../lib/consultationStore';
import { subscribeUploader, type UploaderState, getUploaderState, currentOwner } from '../../lib/consultationUploader';
import { belongsToOwner } from '../../lib/consultationLogic';

/**
 * Lokal wartende Aufnahmen und Zustand der Warteschlange, fuer die Anzeige.
 * Aktualisiert sich bei jeder Aenderung der Warteschlange und alle 5 Sekunden.
 */
export function useLocalRecordings(): { items: LocalRecording[]; uploader: UploaderState } {
    const [items, setItems] = useState<LocalRecording[]>([]);
    const [uploader, setUploader] = useState<UploaderState>(getUploaderState());

    useEffect(() => {
        let cancelled = false;
        const reload = () => {
            listRecordings()
                .then((rows) => {
                    // Nur eigene Aufnahmen zeigen (Person bzw. dieses Tablet).
                    const owner = currentOwner();
                    if (!cancelled) setItems(rows.filter((r) => belongsToOwner(r, owner)));
                })
                .catch(() => { if (!cancelled) setItems([]); });
        };
        const unsubscribe = subscribeUploader((s) => {
            setUploader(s);
            reload();
        });
        const timer = window.setInterval(reload, 5_000);
        reload();
        return () => {
            cancelled = true;
            unsubscribe();
            window.clearInterval(timer);
        };
    }, []);

    return { items, uploader };
}

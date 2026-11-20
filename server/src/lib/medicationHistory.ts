import { PoolClient } from 'pg';

/**
 * Änderungshistorie des Medikamentenplans (PC und Handy).
 * Pro Speichern ein Eintrag mit den geänderten Angaben (alt -> neu). Die Einträge
 * bleiben nach dem Löschen eines Medikaments erhalten (keine Fremdschlüssel auf
 * medications). Vorrat, Rezepte und Einnahmen werden hier nicht erfasst.
 */

export type HistoryAction = 'created' | 'updated' | 'deleted';

export interface HistoryChange {
    /** Spalte von medications, 'photo' oder 'schedule' */
    field: string;
    old: unknown;
    new: unknown;
}

/** Angaben des Medikaments, die verglichen werden (Foto und Einnahmezeiten eigen). */
const MEDICATION_FIELDS = [
    'name', 'active_ingredient', 'dosage', 'form', 'instructions', 'prescriber',
    'start_date', 'end_date', 'prn', 'with_food', 'reason', 'appearance', 'plan_group', 'active',
] as const;

interface ScheduleRow {
    id: string;
    time_of_day: string;
    days_of_week: number[];
    label: string | null;
    time_fixed: boolean;
    quantity: number | string;
    unit: string | null;
    view_color: string | null;
}

type MedicationRow = Record<string, unknown> & { schedules?: ScheduleRow[] };

const normalize = (value: unknown): unknown => (value === undefined || value === '' ? null : value);

/** Einnahmezeit ohne Kennung, Menge als Zahl (pg liefert NUMERIC als Text). */
const scheduleSnapshot = (s: ScheduleRow) => ({
    time_of_day: s.time_of_day,
    time_fixed: s.time_fixed,
    days_of_week: s.days_of_week,
    quantity: Number(s.quantity),
    unit: s.unit ?? null,
    view_color: s.view_color ?? null,
    label: s.label ?? null,
});

/** Unterschiede zwischen zwei Ständen. before = null: neu angelegt (alle gefüllten Angaben). */
export const diffMedication = (before: MedicationRow | null, after: MedicationRow): HistoryChange[] => {
    const changes: HistoryChange[] = [];
    for (const field of MEDICATION_FIELDS) {
        const oldValue = before ? normalize(before[field]) : null;
        const newValue = normalize(after[field]);
        // Neu angelegt: nur gefüllte Angaben, "aktiv" versteht sich von selbst.
        if (!before && (field === 'active' || newValue === null || newValue === false)) continue;
        if (before && oldValue === newValue) continue;
        changes.push({ field, old: oldValue, new: newValue });
    }
    // Foto: nur ob eines da ist, das Bild selbst kommt nicht in die Historie.
    const oldPhoto = before ? Boolean(before.photo_url) : false;
    const newPhoto = Boolean(after.photo_url);
    if (oldPhoto !== newPhoto || (before && oldPhoto && before.photo_url !== after.photo_url)) {
        changes.push({ field: 'photo', old: oldPhoto, new: newPhoto });
    }

    const oldSchedules = new Map((before?.schedules ?? []).map((s): [string, ScheduleRow] => [s.id, s]));
    for (const s of after.schedules ?? []) {
        const previous = oldSchedules.get(s.id);
        oldSchedules.delete(s.id);
        const next = scheduleSnapshot(s);
        if (!previous) {
            changes.push({ field: 'schedule', old: null, new: next });
            continue;
        }
        const prev = scheduleSnapshot(previous);
        if (JSON.stringify(prev) !== JSON.stringify(next)) {
            changes.push({ field: 'schedule', old: prev, new: next });
        }
    }
    for (const s of oldSchedules.values()) {
        changes.push({ field: 'schedule', old: scheduleSnapshot(s), new: null });
    }
    return changes;
};

/** Eintrag schreiben (in der laufenden Transaktion). Ohne Änderungen kein Eintrag. */
export const recordMedicationHistory = async (
    client: PoolClient,
    params: {
        circleId: string;
        medicationId: string;
        medicationName: string;
        medicationDosage: string | null;
        action: HistoryAction;
        changes: HistoryChange[];
        userId: string | undefined;
    }
): Promise<void> => {
    if (params.action === 'updated' && params.changes.length === 0) return;
    await client.query(
        `INSERT INTO medication_history (circle_id, medication_id, medication_name, medication_dosage, action, changes, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            params.circleId,
            params.medicationId,
            params.medicationName,
            params.medicationDosage || null,
            params.action,
            JSON.stringify(params.changes),
            params.userId ?? null,
        ]
    );
};

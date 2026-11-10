import { pick, type Lang } from './i18n';

/**
 * Visites (table visits) : qui est passe voir le proche. Launch Block C : les
 * arrivees se declaraient sur la tablette (mode Kiosk, supprime) ; il reste la
 * liste (routes/visits.ts), la vue simple de la personne accompagnee et le
 * texte de journal d'une visite.
 */

export const VISITOR_TYPES = ['family', 'friend', 'caregiver', 'nurse', 'doctor', 'other'] as const;
export type VisitorType = typeof VISITOR_TYPES[number];

const TYPE_LABELS: Record<Lang, Record<VisitorType, string>> = {
    fr: { family: 'famille', friend: 'ami ou voisin', caregiver: 'aide à domicile', nurse: 'infirmier(ère)', doctor: 'médecin', other: 'visiteur' },
    en: { family: 'family', friend: 'friend or neighbor', caregiver: 'home aide', nurse: 'nurse', doctor: 'doctor', other: 'visitor' },
    es: { family: 'familia', friend: 'amigo o vecino', caregiver: 'auxiliar a domicilio', nurse: 'enfermero/a', doctor: 'médico', other: 'visitante' },
    de: { family: 'Familie', friend: 'Freund oder Nachbar', caregiver: 'Haushaltshilfe', nurse: 'Pflegekraft', doctor: 'Arzt oder Ärztin', other: 'Besuch' },
};

const fmtTime = (d: Date, lang: Lang): string => pick(lang, {
    fr: `${d.getHours()} h${d.getMinutes() > 0 ? ` ${String(d.getMinutes()).padStart(2, '0')}` : ''}`,
    en: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    es: `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
    de: `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')} Uhr`,
});

/** "a las 10:30", ou "a la 1:30" : l'article espagnol suit l'heure. */
const esAt = (d: Date): string => `a ${d.getHours() === 1 ? 'la' : 'las'} ${fmtTime(d, 'es')}`;

export const VISIT_COLUMNS = `id, circle_id, visitor_type, visitor_name, member_id, device_id,
    checked_in_at, checked_out_at, note, journal_entry_id, created_at`;

export interface VisitRow {
    id: string;
    circle_id: string;
    visitor_type: VisitorType;
    visitor_name: string;
    member_id: string | null;
    device_id: string | null;
    checked_in_at: string;
    checked_out_at: string | null;
    note: string | null;
    journal_entry_id: string | null;
}

export function journalContent(visit: { visitor_name: string; visitor_type: VisitorType; checked_in_at: Date; checked_out_at?: Date | null }, lang: Lang, recipientName: string): string {
    const type = TYPE_LABELS[lang][visit.visitor_type];
    const arrived = fmtTime(visit.checked_in_at, lang);
    if (lang === 'de') {
        const base = `${visit.visitor_name} (${type}) ist um ${arrived} gekommen${recipientName ? `, zu Besuch bei ${recipientName}` : ''}`;
        return visit.checked_out_at ? `${base}, gegangen um ${fmtTime(visit.checked_out_at, lang)}` : base;
    }
    if (lang === 'es') {
        const base = `${visit.visitor_name} (${type}) llegó ${esAt(visit.checked_in_at)}${recipientName ? ` a casa de ${recipientName}` : ''}`;
        return visit.checked_out_at ? `${base}, se fue ${esAt(visit.checked_out_at)}` : base;
    }
    if (lang === 'en') {
        const base = `${visit.visitor_name} (${type}) checked in at ${arrived}${recipientName ? ` to see ${recipientName}` : ''}`;
        return visit.checked_out_at ? `${base}, left at ${fmtTime(visit.checked_out_at, lang)}` : base;
    }
    const base = `${visit.visitor_name} (${type}) est arrivé(e) à ${arrived}${recipientName ? ` chez ${recipientName}` : ''}`;
    return visit.checked_out_at ? `${base}, reparti(e) à ${fmtTime(visit.checked_out_at, lang)}` : base;
}

// Texte, die der Server fuer das Arztgespraech-Modul selbst erzeugt
// (Benachrichtigungen). Eigene kleine Tabelle, damit das Modul unabhaengig
// von lib/i18n.ts bleibt. Fehlt eine Sprache, gilt Deutsch.

import { toSummaryLang, type SummaryLang } from './summary';

type TextKey = 'summaryReadyTitle' | 'summaryReadyBody' | 'transcriptReadyBody' | 'failedTitle' | 'failedBody' | 'defaultTitle';

const TEXTS: Record<SummaryLang, Record<TextKey, string>> = {
    de: {
        summaryReadyTitle: 'Arztgespräch ausgewertet',
        summaryReadyBody: 'Die Zusammenfassung zu „{{title}}“ ist fertig. Bitte prüfen und freigeben.',
        transcriptReadyBody: 'Die Mitschrift zu „{{title}}“ ist fertig.',
        failedTitle: 'Arztgespräch nicht verarbeitet',
        failedBody: 'Die Aufnahme zu „{{title}}“ konnte nicht verarbeitet werden. Sie können es in der App erneut versuchen.',
        defaultTitle: 'Arztgespräch',
    },
    en: {
        summaryReadyTitle: 'Doctor visit processed',
        summaryReadyBody: 'The summary for "{{title}}" is ready. Please review and approve it.',
        transcriptReadyBody: 'The transcript for "{{title}}" is ready.',
        failedTitle: 'Doctor visit not processed',
        failedBody: 'The recording for "{{title}}" could not be processed. You can try again in the app.',
        defaultTitle: 'Doctor visit',
    },
    fr: {
        summaryReadyTitle: 'Consultation traitée',
        summaryReadyBody: 'Le résumé de « {{title}} » est prêt. Merci de le relire et de le valider.',
        transcriptReadyBody: 'La transcription de « {{title}} » est prête.',
        failedTitle: 'Consultation non traitée',
        failedBody: "L'enregistrement de « {{title}} » n'a pas pu être traité. Vous pouvez réessayer dans l'application.",
        defaultTitle: 'Consultation',
    },
    es: {
        summaryReadyTitle: 'Consulta procesada',
        summaryReadyBody: 'El resumen de «{{title}}» está listo. Revísalo y apruébalo.',
        transcriptReadyBody: 'La transcripción de «{{title}}» está lista.',
        failedTitle: 'Consulta no procesada',
        failedBody: 'La grabación de «{{title}}» no se pudo procesar. Puedes volver a intentarlo en la aplicación.',
        defaultTitle: 'Consulta',
    },
};

export function consultationText(lang: unknown, key: TextKey, vars: Record<string, string> = {}): string {
    const template = TEXTS[toSummaryLang(lang)][key];
    return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars[name] ?? '');
}

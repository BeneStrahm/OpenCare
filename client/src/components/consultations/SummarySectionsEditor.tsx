// E67: Zusammenfassung in der App bearbeiten wie am Tablet (Figma A14): ein Feld je Abschnitt mit
// fetter Ueberschrift, eine Zeile je Punkt, Medikamente als "Name: Änderung". Umwandlung und
// Pruefung wie am Tablet (lib/consultationReview.ts), dazu Termine und unsichere Stellen.
import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Textarea } from '../ui';
import type { ConsultationSummary } from '../../lib/consultationLogic';
import { draftToSummary, invalidMedicationLines, summaryToDraft, type SummaryDraft } from '../../lib/consultationReview';

type Section = 'overview' | 'important' | 'medications' | 'nextSteps' | 'appointments' | 'unclear';

interface Props {
    /** Stand beim Start des Bearbeitens (mit allen Feldern, siehe withDefaults) */
    original: ConsultationSummary;
    questions: { id: string; text: string }[];
    /** Neue Zusammenfassung; invalid: Medikamente ohne "Name: Änderung" (dann nicht speichern) */
    onChange: (next: ConsultationSummary, invalid: boolean) => void;
}

/** Feld waechst mit dem Text (kein Scrollen im Feld). */
const rowsFor = (text: string) => Math.max(2, text.split('\n').length + 1);

const SummarySectionsEditor: React.FC<Props> = ({ original, questions, onChange }) => {
    const { t } = useTranslation(['simpleView', 'consultations']);
    const uid = useId();
    // Ausgangsstand einmal beim Oeffnen: unveraenderte Abschnitte bleiben genau so (draftToSummary).
    const initial = useMemo(() => summaryToDraft(original, questions), []); // eslint-disable-line react-hooks/exhaustive-deps
    const [draft, setDraft] = useState<SummaryDraft>(initial);
    const badMedications = invalidMedicationLines(draft.medications).length > 0;

    const update = (patch: Partial<SummaryDraft>) => {
        const next = { ...draft, ...patch };
        setDraft(next);
        onChange(draftToSummary(original, initial, next, questions), invalidMedicationLines(next.medications).length > 0);
    };

    const heading = (htmlFor: string, text: string, hint?: string) => (
        <>
            <label htmlFor={htmlFor} className="block text-body font-semibold text-foreground">{text}</label>
            {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
        </>
    );
    const area = (key: Section, text: string, hint?: string, error?: string) => (
        <div className="space-y-1.5">
            {heading(`${uid}-${key}`, text, hint)}
            <Textarea
                id={`${uid}-${key}`}
                rows={rowsFor(draft[key])}
                className="min-h-0 resize-none"
                value={draft[key]}
                onChange={(e) => update({ [key]: e.target.value })}
                error={error}
            />
        </div>
    );

    return (
        <div className="space-y-5">
            {area('overview', t('simpleView:doctor.review.overview'))}
            {area('important', t('simpleView:doctor.summary.important'), t('simpleView:doctor.review.lineHint'))}
            {area('medications', t('simpleView:doctor.summary.medications'), t('simpleView:doctor.review.medicationHint'),
                badMedications ? t('simpleView:doctor.review.error.medications') : undefined)}
            {questions.length > 0 && (
                <fieldset className="space-y-3">
                    <legend className="text-body font-semibold text-foreground">{t('simpleView:doctor.review.answers')}</legend>
                    {questions.map((q, i) => (
                        <div key={q.id} className="space-y-1.5">
                            <label htmlFor={`${uid}-q-${q.id}`} className="block text-body text-foreground">{`${i + 1}. ${q.text}`}</label>
                            <Textarea
                                id={`${uid}-q-${q.id}`}
                                rows={rowsFor(draft.answers[q.id] ?? '')}
                                className="min-h-0 resize-none"
                                value={draft.answers[q.id] ?? ''}
                                onChange={(e) => update({ answers: { ...draft.answers, [q.id]: e.target.value } })}
                            />
                        </div>
                    ))}
                </fieldset>
            )}
            {area('nextSteps', t('simpleView:doctor.summary.nextSteps'), t('simpleView:doctor.review.lineHint'))}
            {area('appointments', t('simpleView:doctor.summary.appointments'), t('simpleView:doctor.review.lineHint'))}
            {area('unclear', t('simpleView:doctor.summary.unclear'), t('simpleView:doctor.review.lineHint'))}
        </div>
    );
};

export default SummarySectionsEditor;

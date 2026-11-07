import React from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import { Button, Input, Textarea } from '../ui';
import type { ConsultationSummary } from '../../lib/consultationLogic';

interface Props {
    value: ConsultationSummary;
    onChange: (next: ConsultationSummary) => void;
    questions: { id: string; text: string }[];
    readOnly: boolean;
}

const SectionLabel: React.FC<{ children: React.ReactNode; id?: string }> = ({ children, id }) => (
    <h3 id={id} className="text-body font-semibold text-foreground">{children}</h3>
);

/** Liste einfacher Texte bearbeiten (Befunde, Empfehlungen, Unklares). */
const TextList: React.FC<{
    label: string;
    items: string[];
    onChange: (items: string[]) => void;
    readOnly: boolean;
    emptyText: string;
    addLabel: string;
    removeLabel: string;
}> = ({ label, items, onChange, readOnly, emptyText, addLabel, removeLabel }) => {
    if (readOnly) {
        return (
            <div className="space-y-2">
                <SectionLabel>{label}</SectionLabel>
                {items.length === 0
                    ? <p className="text-caption text-muted-foreground">{emptyText}</p>
                    : <ul className="list-disc space-y-1 pl-6 text-body">{items.map((item, i) => <li key={i}>{item}</li>)}</ul>}
            </div>
        );
    }
    return (
        <fieldset className="space-y-2">
            <legend className="text-body font-semibold text-foreground">{label}</legend>
            {items.length === 0 && <p className="text-caption text-muted-foreground">{emptyText}</p>}
            {items.map((item, i) => (
                <div key={i} className="flex items-start gap-2">
                    <Textarea
                        aria-label={`${label} ${i + 1}`}
                        value={item}
                        rows={2}
                        onChange={(e) => onChange(items.map((v, j) => (j === i ? e.target.value : v)))}
                    />
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-11 w-11 shrink-0 text-muted-foreground hover:text-danger"
                        onClick={() => onChange(items.filter((_, j) => j !== i))}
                        aria-label={`${removeLabel}: ${label} ${i + 1}`}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => onChange([...items, ''])}>
                <Plus className="mr-1 h-4 w-4" aria-hidden="true" />{addLabel}
            </Button>
        </fieldset>
    );
};

const SummaryEditor: React.FC<Props> = ({ value, onChange, questions, readOnly }) => {
    const { t } = useTranslation(['consultations']);
    const set = <K extends keyof ConsultationSummary>(key: K, v: ConsultationSummary[K]) => onChange({ ...value, [key]: v });
    const common = {
        readOnly,
        addLabel: t('consultations:summary.add'),
        removeLabel: t('consultations:summary.remove'),
        emptyText: t('consultations:summary.none'),
    };

    const answerFor = (index: number) => value.question_answers.find((a) => a.question_index === index)?.answer ?? '';
    const setAnswer = (index: number, answer: string) => {
        const others = value.question_answers.filter((a) => a.question_index !== index);
        set('question_answers', [...others, { question_index: index, answer }].sort((a, b) => a.question_index - b.question_index));
    };

    return (
        <div className="space-y-6">
            {/* Unklares zuerst und hervorgehoben: Das muss ein Mensch pruefen. */}
            {(value.unclear.length > 0 || !readOnly) && (
                <div className="rounded-input border-2 border-warning/50 bg-warning/10 p-4">
                    <p className="mb-2 flex items-center gap-2 text-body font-semibold text-foreground">
                        <AlertTriangle className="h-5 w-5 text-warning" aria-hidden="true" />
                        {t('consultations:summary.unclearTitle')}
                    </p>
                    <p className="mb-3 text-caption text-muted-foreground">{t('consultations:summary.unclearHint')}</p>
                    <TextList label={t('consultations:summary.unclear')} items={value.unclear} onChange={(v) => set('unclear', v)} {...common} />
                </div>
            )}

            <div className="space-y-2">
                {readOnly ? (
                    <>
                        <SectionLabel>{t('consultations:summary.overview')}</SectionLabel>
                        <p className="whitespace-pre-wrap text-body">{value.overview || t('consultations:summary.none')}</p>
                    </>
                ) : (
                    <Textarea
                        label={t('consultations:summary.overview')}
                        value={value.overview}
                        rows={4}
                        onChange={(e) => set('overview', e.target.value)}
                    />
                )}
            </div>

            <TextList label={t('consultations:summary.findings')} items={value.findings} onChange={(v) => set('findings', v)} {...common} />

            {/* Medikamente */}
            <fieldset className="space-y-2">
                <legend className="text-body font-semibold text-foreground">{t('consultations:summary.medicationChanges')}</legend>
                {value.medication_changes.length === 0 && <p className="text-caption text-muted-foreground">{t('consultations:summary.none')}</p>}
                {value.medication_changes.map((m, i) => (
                    readOnly ? (
                        <p key={i} className="text-body"><span className="font-semibold">{m.name}:</span> {m.change}</p>
                    ) : (
                        <div key={i} className="grid grid-cols-1 gap-2 rounded-input border border-border p-3 sm:grid-cols-[1fr_2fr_auto]">
                            <Input
                                label={t('consultations:summary.medName')}
                                id={`med-name-${i}`}
                                value={m.name}
                                onChange={(e) => set('medication_changes', value.medication_changes.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                            />
                            <Input
                                label={t('consultations:summary.medChange')}
                                id={`med-change-${i}`}
                                value={m.change}
                                onChange={(e) => set('medication_changes', value.medication_changes.map((x, j) => (j === i ? { ...x, change: e.target.value } : x)))}
                            />
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-11 w-11 self-end text-muted-foreground hover:text-danger"
                                onClick={() => set('medication_changes', value.medication_changes.filter((_, j) => j !== i))}
                                aria-label={`${t('consultations:summary.remove')}: ${m.name || i + 1}`}
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>
                    )
                ))}
                {!readOnly && (
                    <Button variant="secondary" size="sm" onClick={() => set('medication_changes', [...value.medication_changes, { name: '', change: '' }])}>
                        <Plus className="mr-1 h-4 w-4" aria-hidden="true" />{t('consultations:summary.add')}
                    </Button>
                )}
                {value.medication_changes.length > 0 && (
                    <p className="text-caption text-muted-foreground">{t('consultations:summary.medicationHint')}</p>
                )}
            </fieldset>

            <TextList label={t('consultations:summary.recommendations')} items={value.recommendations} onChange={(v) => set('recommendations', v)} {...common} />

            {/* Naechste Schritte */}
            <fieldset className="space-y-2">
                <legend className="text-body font-semibold text-foreground">{t('consultations:summary.nextSteps')}</legend>
                {value.next_steps.length === 0 && <p className="text-caption text-muted-foreground">{t('consultations:summary.none')}</p>}
                {value.next_steps.map((s, i) => (
                    readOnly ? (
                        <p key={i} className="text-body">{s.text}{s.due ? ` (${t('consultations:summary.dueOn', { date: s.due })})` : ''}</p>
                    ) : (
                        <div key={i} className="grid grid-cols-1 gap-2 rounded-input border border-border p-3 sm:grid-cols-[2fr_1fr_auto]">
                            <Input
                                label={t('consultations:summary.stepText')}
                                id={`step-text-${i}`}
                                value={s.text}
                                onChange={(e) => set('next_steps', value.next_steps.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                            />
                            <Input
                                type="date"
                                label={t('consultations:summary.stepDue')}
                                id={`step-due-${i}`}
                                value={s.due ?? ''}
                                onChange={(e) => set('next_steps', value.next_steps.map((x, j) => (j === i ? { ...x, due: e.target.value || null } : x)))}
                            />
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-11 w-11 self-end text-muted-foreground hover:text-danger"
                                onClick={() => set('next_steps', value.next_steps.filter((_, j) => j !== i))}
                                aria-label={`${t('consultations:summary.remove')}: ${s.text || i + 1}`}
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>
                    )
                ))}
                {!readOnly && (
                    <Button variant="secondary" size="sm" onClick={() => set('next_steps', [...value.next_steps, { text: '', due: null }])}>
                        <Plus className="mr-1 h-4 w-4" aria-hidden="true" />{t('consultations:summary.add')}
                    </Button>
                )}
            </fieldset>

            {/* Antworten auf die vorbereiteten Fragen */}
            {questions.length > 0 && (
                <fieldset className="space-y-3">
                    <legend className="text-body font-semibold text-foreground">{t('consultations:summary.answers')}</legend>
                    {questions.map((q, i) => (
                        <div key={q.id} className="space-y-1">
                            <p className="text-body font-medium text-foreground">{i + 1}. {q.text}</p>
                            {readOnly ? (
                                <p className="text-body text-muted-foreground">{answerFor(i) || t('consultations:summary.notAnswered')}</p>
                            ) : (
                                <Textarea
                                    aria-label={`${t('consultations:summary.answerFor')} ${i + 1}`}
                                    value={answerFor(i)}
                                    rows={2}
                                    placeholder={t('consultations:summary.notAnswered')}
                                    onChange={(e) => setAnswer(i, e.target.value)}
                                />
                            )}
                        </div>
                    ))}
                </fieldset>
            )}
        </div>
    );
};

export default SummaryEditor;

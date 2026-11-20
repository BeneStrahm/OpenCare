import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Printer, RotateCcw } from 'lucide-react';
import { api } from '../lib/api';
import { useCircle } from '../contexts/CircleContext';
import { circleWeekStart } from '../lib/weekStart';
import { formatClock } from '../i18n/format';
import { historyTexts, type HistoryChange, type HistoryEntry } from '../lib/medicationHistoryText';
import {
    PLAN_MOMENTS, doseText, hintsText, shortDate, unitText, type PlanSection,
} from '../lib/medicationPlanText';

/**
 * Medikamentenplan zum Drucken nach Vorbild BMP (E54): eigene Seite ohne Menü, A4 quer,
 * Browser-Druck ("Als PDF speichern"). Drucken dürfen admin, family, professional; der
 * Server prüft das (GET /api/medications/plan), Freunde sehen nur einen Hinweis.
 * Seite 2: Änderungen der letzten 14 Tage.
 */

interface PlanData {
    print_date: string;
    history_from: string;
    recipient: { first_name: string; last_name: string | null; birth_date: string | null } | null;
    created_by: string | null;
    sections: PlanSection[];
    changes: HistoryEntry[];
}

const PRINT_ROLES = ['admin', 'family', 'professional'];

/** CSS-Text in Anführungszeichen (für content: in @page). */
const cssString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const MedicationPlanPrint: React.FC = () => {
    const { t, i18n } = useTranslation(['medications', 'common']);
    const navigate = useNavigate();
    const { activeCircle, myRole } = useCircle();
    const weekStart = circleWeekStart(activeCircle);
    const mayPrint = PRINT_ROLES.includes(myRole ?? '');
    const [data, setData] = useState<PlanData | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);

    const load = async () => {
        setError('');
        setLoading(true);
        try {
            const response = await api.get<{ success: boolean; data: PlanData }>('/api/medications/plan');
            if (response.success) setData(response.data);
        } catch (err) {
            console.error('Failed to load medication plan:', err);
            setError(t('medications:print.loadError'));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (mayPrint) void load();
        else setLoading(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mayPrint]);

    const historyText = historyTexts(t, weekStart);
    const locale = i18n.language || 'de';

    const changeText = (change: HistoryChange, entry: HistoryEntry) => {
        const form = entry.medication_form ?? null;
        if (change.field === 'schedule' && (change.old === null || change.new === null)) {
            const added = change.old === null;
            return `${added ? t('medications:history.scheduleAdded') : t('medications:history.scheduleRemoved')} ${historyText.valueText('schedule', added ? change.new : change.old, form)}`;
        }
        const label = historyText.fieldLabel(change.field);
        if (entry.action === 'created') return `${label}: ${historyText.valueText(change.field, change.new, form)}`;
        return `${label}: ${historyText.valueText(change.field, change.old, form)} → ${historyText.valueText(change.field, change.new, form)}`;
    };

    const toolbar = (
        <div className="mb-6 flex flex-wrap gap-3 print:hidden">
            <button
                type="button"
                onClick={() => navigate('/medications')}
                className="flex min-h-[48px] items-center gap-2 rounded-card border border-border bg-surface px-4 text-body font-medium text-foreground hover:border-border-strong"
            >
                <ArrowLeft className="h-5 w-5" aria-hidden="true" />
                {t('medications:print.back')}
            </button>
            {data && (
                <button
                    type="button"
                    onClick={() => window.print()}
                    className="flex min-h-[48px] items-center gap-2 rounded-card bg-primary px-4 text-body font-medium text-primary-foreground"
                >
                    <Printer className="h-5 w-5" aria-hidden="true" />
                    {t('medications:print.print')}
                </button>
            )}
        </div>
    );

    if (!mayPrint || loading || error || !data) {
        return (
            <main className="mx-auto max-w-5xl p-6">
                {toolbar}
                {!mayPrint ? (
                    <p className="text-body text-foreground">{t('medications:print.noAccess')}</p>
                ) : loading ? (
                    <p className="text-body text-foreground">{t('common:states.loading')}</p>
                ) : (
                    <div className="space-y-3">
                        <div role="alert" className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-body text-danger">
                            {error || t('medications:print.loadError')}
                        </div>
                        <button
                            type="button"
                            onClick={() => void load()}
                            className="flex min-h-[48px] items-center gap-2 rounded-card border border-border bg-surface px-4 text-body font-medium text-foreground"
                        >
                            <RotateCcw className="h-5 w-5" aria-hidden="true" />
                            {t('common:actions.retry')}
                        </button>
                    </div>
                )}
            </main>
        );
    }

    const recipientName = data.recipient
        ? [data.recipient.first_name, data.recipient.last_name].filter(Boolean).join(' ')
        : '';
    const sections = data.sections.filter((s) => s.rows.length > 0);
    const pageLabel = `${cssString(t('medications:print.page'))} " " counter(page) " " ${cssString(t('medications:print.of'))} " " counter(pages)`;

    return (
        <main className="medplan mx-auto max-w-[297mm] bg-white p-6 text-black print:max-w-none print:p-0">
            <style>{`
                @page { size: A4 landscape; margin: 12mm 10mm 14mm 10mm;
                    @bottom-center { content: ${pageLabel}; font-size: 9pt; } }
                .medplan table { border-collapse: collapse; width: 100%; }
                .medplan th, .medplan td { border: 1px solid #555; padding: 4px 6px; vertical-align: top; text-align: left; }
                .medplan .dose { text-align: center; width: 2.6em; }
                .medplan thead { display: table-header-group; }
                .medplan tr { break-inside: avoid; }
                @media print {
                    .medplan { font-size: 11pt; line-height: 1.35; }
                    .medplan table { font-size: 10pt; }
                    .medplan .new-page { break-before: page; }
                }
            `}</style>
            {toolbar}

            <header className="mb-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <h1 className="text-h1 font-bold">{t('medications:print.title')}</h1>
                    {recipientName && (
                        <p className="text-body font-semibold">
                            {data.recipient?.birth_date
                                ? t('medications:print.recipientBorn', { name: recipientName, date: shortDate(data.recipient.birth_date) })
                                : recipientName}
                        </p>
                    )}
                </div>
                <p className="mt-1 text-body">{t('medications:print.notice', { date: shortDate(data.print_date) })}</p>
                <p className="text-body">
                    {t('medications:print.createdBy', { name: data.created_by ?? t('medications:history.unknownUser') })}
                    {' · '}
                    {t('medications:print.printedOn', { date: shortDate(data.print_date) })}
                </p>
            </header>

            {sections.length === 0 ? (
                <p className="text-body">{t('medications:print.empty')}</p>
            ) : (
                <table>
                    <thead>
                        <tr>
                            <th scope="col">{t('medications:print.columns.activeIngredient')}</th>
                            <th scope="col">{t('medications:print.columns.name')}</th>
                            <th scope="col">{t('medications:print.columns.strength')}</th>
                            <th scope="col">{t('medications:print.columns.form')}</th>
                            {PLAN_MOMENTS.map((moment) => (
                                <th key={moment} scope="col" className="dose">
                                    <abbr title={t(`medications:moments.${moment}`)}>{t(`medications:print.columns.${moment}`)}</abbr>
                                </th>
                            ))}
                            <th scope="col">{t('medications:print.columns.unit')}</th>
                            <th scope="col">{t('medications:print.columns.hints')}</th>
                            <th scope="col">{t('medications:print.columns.reason')}</th>
                        </tr>
                    </thead>
                    {sections.map((section) => (
                        <tbody key={section.group}>
                            <tr>
                                <th scope="colgroup" colSpan={11} className="bg-[#eee] font-bold">
                                    {t(`medications:print.groups.${section.group}`)}
                                </th>
                            </tr>
                            {section.rows.map((row) => (
                                <tr key={row.id}>
                                    <td>{row.active_ingredient ?? ''}</td>
                                    <td className="font-semibold">{row.name}</td>
                                    <td>{row.dosage ?? ''}</td>
                                    <td>{row.form ? t(`medications:forms.${row.form}`, { defaultValue: row.form }) : ''}</td>
                                    {PLAN_MOMENTS.map((moment) => (
                                        <td key={moment} className="dose">
                                            {row.doses ? doseText(row.doses[moment], locale) : ''}
                                        </td>
                                    ))}
                                    <td>{unitText(t, row.unit, row.form)}</td>
                                    <td>{hintsText(t, row.hints, weekStart)}</td>
                                    <td>{row.reason ?? ''}</td>
                                </tr>
                            ))}
                        </tbody>
                    ))}
                </table>
            )}

            <section className="new-page mt-8">
                <h2 className="mb-3 text-h2 font-bold">
                    {t('medications:print.changesTitle', { from: shortDate(data.history_from), to: shortDate(data.print_date) })}
                </h2>
                {data.changes.length === 0 ? (
                    <p className="text-body">{t('medications:print.changesEmpty')}</p>
                ) : (
                    <table>
                        <thead>
                            <tr>
                                <th scope="col">{t('medications:print.changeColumns.when')}</th>
                                <th scope="col">{t('medications:print.changeColumns.medication')}</th>
                                <th scope="col">{t('medications:print.changeColumns.change')}</th>
                                <th scope="col">{t('medications:print.changeColumns.by')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.changes.map((entry) => (
                                <tr key={entry.id}>
                                    <td className="whitespace-nowrap">
                                        {shortDate(entry.changed_at)}, {formatClock(entry.changed_at)}
                                    </td>
                                    <td>
                                        <span className="font-semibold">{entry.medication_name}</span>
                                        <br />
                                        {t(`medications:history.actions.${entry.action}`)}
                                    </td>
                                    <td>
                                        {entry.changes.length > 0 && (
                                            <ul className="list-none">
                                                {entry.changes.map((change, index) => (
                                                    <li key={index}>{changeText(change, entry)}</li>
                                                ))}
                                            </ul>
                                        )}
                                    </td>
                                    <td>{entry.changed_by_name ?? t('medications:history.unknownUser')}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
        </main>
    );
};

export default MedicationPlanPrint;

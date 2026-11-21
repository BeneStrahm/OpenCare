// E60: Termin eintragen in der einfachen Ansicht (Rolle recipient), Figma 50 bis 54,
// und dasselbe Formular fuer das Arztgespraech (E59, Figma A4/A5): "Arzttermin eintragen"
// (Art fest Arzt, Arzt per Autovervollstaendigen) und "Angaben aendern".
// Keine Rueckfrage: die Haupttaste speichert sofort (E60).
import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../../lib/api';
import {
    RECIPIENT_EVENT_CATEGORIES, matchSuggestions, parseRecipientEventForm,
    type DoctorSuggestion, type PersonSuggestion, type RecipientEventCategory,
} from '../../lib/recipientView';
import { ViewWindow } from './ViewWindow';
import type { RecipientUi } from './ui';

export type EventFormMode = 'event' | 'doctor' | 'doctorEdit';

export interface EventFormValues {
    /** Titel, beim Arzttermin der Name der Aerztin oder des Arztes */
    title: string;
    category: RecipientEventCategory;
    day: string;
    time: string;
    location: string;
    companionNeeded: boolean;
    companionName: string;
    companionMemberId: string | null;
    travelNeeded: boolean;
    driver: string;
    takeAlong: string;
}

export type EventFormError = 'title' | 'doctor' | 'date' | 'time';

export const emptyEventForm = (day: string, category: RecipientEventCategory = 'other'): EventFormValues => ({
    title: '', category, day, time: '', location: '',
    companionNeeded: false, companionName: '', companionMemberId: null,
    travelNeeded: false, driver: '', takeAlong: '',
});

/** Body fuer POST /api/events (parseRecipientEvent im Server) bzw. PUT /api/consultations/:id. */
export function eventFormBody(values: EventFormValues, startTime: string) {
    return {
        title: values.title.trim(),
        start_time: startTime,
        category: values.category,
        location: values.location.trim() || null,
        companion_needed: values.companionNeeded,
        ...(values.companionMemberId ? { companion_member_id: values.companionMemberId } : { companion_name: values.companionName.trim() || null }),
        travel_needed: values.travelNeeded,
        driver: values.driver.trim() || null,
        take_along: values.takeAlong.trim() || null,
    };
}

interface Props {
    ui: RecipientUi;
    mode: EventFormMode;
    initial: EventFormValues;
    /** "Angaben aendern" bei einem Gespraech ohne Termin: ohne Begleitung, Fahrt und Mitnehmen */
    withExtras?: boolean;
    busy: boolean;
    /** Fehlermeldung vom Speichern (z. B. ohne Internet) */
    saveError: string | null;
    onCancel: () => void;
    /** Gueltige Eingabe; start_time "YYYY-MM-DDTHH:MM" */
    onSubmit: (values: EventFormValues, startTime: string) => void;
}

const RecipientEventForm: React.FC<Props> = ({ ui, mode, initial, withExtras = true, busy, saveError, onCancel, onSubmit }) => {
    const { t } = useTranslation(['simpleView', 'calendar']);
    const { C, fs, tile, secondaryButton, windowProps } = ui;
    const uid = useId();
    const [v, setV] = useState<EventFormValues>(initial);
    const [error, setError] = useState<EventFormError | null>(null);
    const [people, setPeople] = useState<PersonSuggestion[]>([]);
    const [doctors, setDoctors] = useState<DoctorSuggestion[]>([]);
    const [open, setOpen] = useState<'doctor' | 'companion' | 'driver' | null>(null);
    const isDoctor = mode !== 'event';

    useEffect(() => {
        let cancelled = false;
        api.get<{ success: boolean; data: { people: PersonSuggestion[]; doctors: DoctorSuggestion[] } }>('/api/events/people')
            .then((res) => {
                if (cancelled || !res.data) return;
                setPeople(Array.isArray(res.data.people) ? res.data.people : []);
                setDoctors(Array.isArray(res.data.doctors) ? res.data.doctors : []);
            })
            // Ohne Vorschlaege geht das Formular trotzdem (freie Eingabe).
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, []);

    const set = (patch: Partial<EventFormValues>) => { setV((prev) => ({ ...prev, ...patch })); setError(null); };

    const submit = () => {
        const parsed = parseRecipientEventForm(v.title, v.day, v.time, new Date(), mode === 'doctorEdit');
        if (!parsed.ok) {
            setError(parsed.error === 'title' && isDoctor ? 'doctor' : parsed.error);
            return;
        }
        onSubmit({ ...v, title: parsed.title }, parsed.start_time);
    };

    const title = mode === 'event' ? t('simpleView:event.new') : mode === 'doctor' ? t('simpleView:doctor.newTitle') : t('simpleView:doctor.editTitle');
    const fieldStyle = (bad: boolean, disabled = false): React.CSSProperties => ({
        ...fs(24),
        backgroundColor: disabled ? C.bg : C.card,
        color: C.text,
        border: `2px solid ${bad ? C.red : C.control}`,
    });
    const label = (htmlFor: string, text: string) => (
        <label htmlFor={htmlFor} className="block font-bold" style={fs(21)}>{text}</label>
    );
    const errorLine = (field: EventFormError) => error === field && (
        <p id={`${uid}-error`} role="alert" className="mt-2 font-bold" style={{ ...fs(20), color: C.red }}>
            {t(field === 'doctor' ? 'simpleView:doctor.error.doctor' : `simpleView:event.error.${field}`)}
        </p>
    );

    /** Liste der Vorschlaege unter einem Feld (Figma "Vorschlagszeile"). */
    const suggestionList = <T extends { name: string }>(id: string, items: T[], sub: (item: T) => string | null, pick: (item: T) => void) =>
        items.length > 0 && (
            <ul id={id} role="listbox" className="mt-2 overflow-hidden rounded-2xl" style={{ backgroundColor: C.card, border: `2px solid ${C.control}` }}>
                {items.map((item, i) => (
                    <li key={`${item.name}-${i}`} role="option" aria-selected={false}>
                        <button
                            type="button"
                            // Vor dem Verlassen des Feldes waehlen (sonst schliesst sich die Liste zuerst).
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => { pick(item); setOpen(null); }}
                            className="block min-h-[3.5rem] w-full px-4 py-2 text-left"
                            style={{ borderTop: i === 0 ? 'none' : `1px solid ${C.border}` }}
                        >
                            <span className="block font-bold" style={fs(21)}>{item.name}</span>
                            {sub(item) && <span className="block" style={{ ...fs(18), color: C.muted }}>{sub(item)}</span>}
                        </button>
                    </li>
                ))}
            </ul>
        );

    /** Kaestchen links, Feld mit Autovervollstaendigen rechts, ausgegraut bis zum Haken (Figma "Kaestchen mit Eingabe"). */
    const personRow = (
        kind: 'companion' | 'driver',
        checked: boolean,
        onCheck: (on: boolean) => void,
        value: string,
        onText: (text: string) => void,
        onPick: (p: PersonSuggestion) => void,
    ) => {
        const boxId = `${uid}-${kind}-box`;
        const inputId = `${uid}-${kind}`;
        const listId = `${uid}-${kind}-list`;
        const matches = open === kind && checked ? matchSuggestions(people, value) : [];
        return (
            <div className="grid grid-cols-1 items-start gap-3 min-[512px]:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
                <label htmlFor={boxId} className="flex min-h-[4rem] cursor-pointer items-center gap-3 font-bold" style={fs(21)}>
                    <input
                        id={boxId}
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => onCheck(e.target.checked)}
                        className="h-10 w-10 shrink-0 cursor-pointer"
                        style={{ accentColor: C.blue }}
                    />
                    {t(kind === 'companion' ? 'simpleView:event.label.companion' : 'simpleView:event.label.travel')}
                </label>
                <div className="min-w-0">
                    <input
                        id={inputId}
                        type="text"
                        autoComplete="off"
                        disabled={!checked}
                        aria-label={t(kind === 'companion' ? 'simpleView:event.placeholder.companion' : 'simpleView:event.placeholder.driver')}
                        placeholder={t(kind === 'companion' ? 'simpleView:event.placeholder.companion' : 'simpleView:event.placeholder.driver')}
                        maxLength={100}
                        value={value}
                        onFocus={() => setOpen(kind)}
                        onBlur={() => setOpen(null)}
                        onChange={(e) => { onText(e.target.value); setOpen(kind); }}
                        aria-controls={matches.length > 0 ? listId : undefined}
                        aria-expanded={matches.length > 0}
                        role="combobox"
                        aria-autocomplete="list"
                        className="min-h-[4rem] w-full min-w-0 rounded-2xl px-4 font-bold placeholder:font-normal disabled:cursor-not-allowed"
                        style={fieldStyle(false, !checked)}
                    />
                    {suggestionList(listId, matches, () => null, onPick)}
                </div>
            </div>
        );
    };

    const doctorMatches = open === 'doctor' ? matchSuggestions(doctors, v.title) : [];

    return (
        <ViewWindow id={`${uid}-title`} title={title} layer="dialog" {...windowProps} onClose={onCancel}>
            <form className="space-y-5 rounded-3xl p-6 min-[512px]:p-8" style={tile} onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
                {isDoctor ? (
                    <div>
                        {label(`${uid}-doctor`, t('simpleView:doctor.label.doctor'))}
                        <input
                            id={`${uid}-doctor`}
                            type="text"
                            autoComplete="off"
                            autoFocus={mode === 'doctor'}
                            maxLength={120}
                            value={v.title}
                            onFocus={() => setOpen('doctor')}
                            onBlur={() => setOpen(null)}
                            onChange={(e) => { set({ title: e.target.value }); setOpen('doctor'); }}
                            role="combobox"
                            aria-autocomplete="list"
                            aria-expanded={doctorMatches.length > 0}
                            aria-controls={doctorMatches.length > 0 ? `${uid}-doctor-list` : undefined}
                            aria-invalid={error === 'doctor' ? true : undefined}
                            aria-describedby={error === 'doctor' ? `${uid}-error` : undefined}
                            className="mt-2 min-h-[4rem] w-full min-w-0 rounded-2xl px-4 font-bold"
                            style={fieldStyle(error === 'doctor')}
                        />
                        {suggestionList(`${uid}-doctor-list`, doctorMatches, (d) => d.organization, (d) => {
                            // E60: Ort aus dem Kontakt vorausfuellen, ein eigener Ort bleibt.
                            set({ title: d.name, location: v.location.trim() ? v.location : (d.location ?? '') });
                        })}
                        {errorLine('doctor')}
                    </div>
                ) : (
                    <>
                        <div>
                            {label(`${uid}-title-input`, t('simpleView:event.label.title'))}
                            <input
                                id={`${uid}-title-input`}
                                type="text"
                                autoComplete="off"
                                autoFocus
                                maxLength={120}
                                value={v.title}
                                onChange={(e) => set({ title: e.target.value })}
                                aria-invalid={error === 'title' ? true : undefined}
                                aria-describedby={error === 'title' ? `${uid}-error` : undefined}
                                className="mt-2 min-h-[4rem] w-full min-w-0 rounded-2xl px-4 font-bold"
                                style={fieldStyle(error === 'title')}
                            />
                            {errorLine('title')}
                        </div>
                        <div>
                            {label(`${uid}-category`, t('simpleView:event.label.category'))}
                            <div className="relative mt-2">
                                <select
                                    id={`${uid}-category`}
                                    value={v.category}
                                    onChange={(e) => set({ category: e.target.value as RecipientEventCategory })}
                                    className="min-h-[4rem] w-full min-w-0 appearance-none rounded-2xl pl-4 pr-14 font-bold"
                                    style={fieldStyle(false)}
                                >
                                    {RECIPIENT_EVENT_CATEGORIES.map((c) => (
                                        <option key={c} value={c}>{t(`calendar:categories.${c}`)}</option>
                                    ))}
                                </select>
                                <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-8 w-8 -translate-y-1/2" style={{ color: C.text }} aria-hidden="true" />
                            </div>
                        </div>
                    </>
                )}

                {([['date', 'date', v.day], ['time', 'time', v.time]] as const).map(([field, type, value]) => (
                    <div key={field}>
                        {label(`${uid}-${field}`, t(`simpleView:event.label.${field}`))}
                        <input
                            id={`${uid}-${field}`}
                            type={type}
                            autoComplete="off"
                            value={value}
                            onChange={(e) => set(field === 'date' ? { day: e.target.value } : { time: e.target.value })}
                            aria-invalid={error === field ? true : undefined}
                            aria-describedby={error === field ? `${uid}-error` : undefined}
                            className="mt-2 min-h-[4rem] w-full min-w-0 rounded-2xl px-4 font-bold"
                            style={fieldStyle(error === field)}
                        />
                        {errorLine(field)}
                    </div>
                ))}

                <div>
                    {label(`${uid}-location`, t('simpleView:event.label.location'))}
                    <input
                        id={`${uid}-location`}
                        type="text"
                        autoComplete="off"
                        maxLength={255}
                        value={v.location}
                        onChange={(e) => set({ location: e.target.value })}
                        className="mt-2 min-h-[4rem] w-full min-w-0 rounded-2xl px-4 font-bold"
                        style={fieldStyle(false)}
                    />
                </div>

                {withExtras && (
                    <>
                        {personRow(
                            'companion',
                            v.companionNeeded,
                            (on) => set({ companionNeeded: on }),
                            v.companionName,
                            (text) => set({ companionName: text, companionMemberId: null }),
                            (p) => set({ companionName: p.name, companionMemberId: p.member_id }),
                        )}
                        {personRow(
                            'driver',
                            v.travelNeeded,
                            (on) => set({ travelNeeded: on }),
                            v.driver,
                            (text) => set({ driver: text }),
                            (p) => set({ driver: p.name }),
                        )}
                        <div>
                            {label(`${uid}-take`, t('simpleView:event.label.takeAlong'))}
                            <input
                                id={`${uid}-take`}
                                type="text"
                                autoComplete="off"
                                maxLength={500}
                                value={v.takeAlong}
                                onChange={(e) => set({ takeAlong: e.target.value })}
                                className="mt-2 min-h-[4rem] w-full min-w-0 rounded-2xl px-4 font-bold"
                                style={fieldStyle(false)}
                            />
                        </div>
                    </>
                )}

                {saveError && (
                    <p role="alert" className="rounded-2xl p-4 font-bold" style={{ ...fs(21), color: C.red, backgroundColor: C.card, border: `2px solid ${C.red}` }}>
                        {saveError}
                    </p>
                )}

                <div className="grid grid-cols-1 gap-3 pt-1 min-[512px]:grid-cols-2">
                    <button type="button" onClick={onCancel} className="min-h-[4rem] rounded-2xl px-4 font-bold" style={secondaryButton}>
                        {t('simpleView:measure.cancel')}
                    </button>
                    <button
                        type="submit"
                        disabled={busy}
                        className="flex min-h-[4rem] items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white disabled:opacity-70"
                        style={{ ...fs(21), backgroundColor: C.blue }}
                    >
                        {mode === 'event'
                            ? <ChevronRight className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                            : <Check className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />}
                        {mode === 'event' ? t('simpleView:measure.next') : mode === 'doctor' ? t('simpleView:doctor.enter') : t('simpleView:doctor.save')}
                    </button>
                </div>
            </form>
        </ViewWindow>
    );
};

export default RecipientEventForm;

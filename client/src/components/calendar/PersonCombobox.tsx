import React, { useState } from 'react';
import { cn } from '../../lib/utils';

export interface PersonOption {
    key: string;
    name: string;
    hint: string;
}

interface PersonComboboxProps {
    id: string;
    value: string;
    onChange: (value: string) => void;
    /** Ein Vorschlag wurde gewählt (Tippen oder Enter). */
    onPick: (name: string) => void;
    /** Enter ohne gewählten Vorschlag. */
    onEnter?: () => void;
    options: PersonOption[];
    /** Namen, die nicht mehr vorgeschlagen werden (schon hinzugefügt). */
    exclude?: string[];
    placeholder?: string;
    describedBy?: string;
}

const MAX_OPTIONS = 8;
const norm = (value: string) => value.trim().toLocaleLowerCase('de');

/**
 * Eingabefeld mit Vorschlagsliste direkt darunter (im Fluss, nicht als Popup,
 * damit nichts im Dialog abgeschnitten wird). Freie Namen bleiben erlaubt.
 */
export const PersonCombobox: React.FC<PersonComboboxProps> = ({
    id, value, onChange, onPick, onEnter, options, exclude = [], placeholder, describedBy,
}) => {
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(-1);

    const query = norm(value);
    const excluded = new Set(exclude.map(norm));
    const matches = options
        .filter((o) => !excluded.has(norm(o.name)))
        .filter((o) => !query || norm(o.name).includes(query) || norm(o.hint).includes(query))
        .slice(0, MAX_OPTIONS);
    const exactOnly = matches.length === 1 && norm(matches[0].name) === query;
    const show = open && matches.length > 0 && !exactOnly;
    const listId = `${id}-list`;

    const pick = (name: string) => {
        onPick(name);
        setActive(-1);
        setOpen(false);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, matches.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, -1));
        } else if (e.key === 'Enter') {
            // Enter wählt bzw. fügt hinzu, statt das Formular abzuschicken.
            e.preventDefault();
            if (show && active >= 0 && matches[active]) pick(matches[active].name);
            else onEnter?.();
        } else if (e.key === 'Escape' && show) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
        }
    };

    return (
        <div className="min-w-0 flex-1">
            <input
                id={id}
                role="combobox"
                aria-expanded={show}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={show && active >= 0 ? `${id}-opt-${active}` : undefined}
                aria-describedby={describedBy}
                value={value}
                onChange={(e) => {
                    onChange(e.target.value);
                    setOpen(true);
                    setActive(-1);
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                autoComplete="off"
                className="input-nexus h-12"
            />
            {show && (
                <ul
                    id={listId}
                    role="listbox"
                    className="mt-1 max-h-72 overflow-auto rounded-input border border-border-strong bg-surface shadow-surface"
                >
                    {matches.map((option, index) => (
                        <li
                            key={option.key}
                            id={`${id}-opt-${index}`}
                            role="option"
                            aria-selected={index === active}
                            // Fokus bleibt im Feld, sonst schließt die Liste vor dem Klick.
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => pick(option.name)}
                            className={cn(
                                'flex min-h-[48px] cursor-pointer flex-col justify-center border-b border-border px-4 py-2 last:border-b-0',
                                index === active ? 'bg-primary-soft' : 'hover:bg-surface-2'
                            )}
                        >
                            <span className="text-body text-foreground">{option.name}</span>
                            {option.hint && <span className="text-caption text-muted-foreground">{option.hint}</span>}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

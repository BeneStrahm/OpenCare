import React from 'react';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';

interface DatePickerProps {
    value: string;
    onChange: (value: string) => void;
    label?: string;
    type?: 'date' | 'datetime-local' | 'time';
    min?: string;
    max?: string;
    className?: string;
    /** Feld hat einen Fehler (aria-invalid). */
    invalid?: boolean;
    /** ID der Fehlermeldung (aria-describedby). */
    describedBy?: string;
}

const parseDateTimeValue = (value: string): { date: string; time: string } => {
    if (!value) {
        return { date: '', time: '' };
    }

    const normalized = value.trim().replace(' ', 'T');
    const [datePart, timePart = ''] = normalized.split('T');
    const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : '';
    const safeTime = /^(\d{2}:\d{2})/.test(timePart) ? timePart.slice(0, 5) : '';
    return { date: safeDate, time: safeTime };
};

export const DatePicker: React.FC<DatePickerProps> = ({
    value,
    onChange,
    label,
    type = 'date',
    min,
    max,
    className,
    invalid,
    describedBy,
}) => {
    const { t } = useTranslation('common');
    const fieldId = React.useId();
    if (type === 'datetime-local') {
        const { date, time } = parseDateTimeValue(value);
        // Local date : toISOString() would give the UTC day, which is wrong near
        // midnight for users outside UTC.
        const today = format(new Date(), 'yyyy-MM-dd');
        const minDate = min ? min.slice(0, 10) : undefined;
        const maxDate = max ? max.slice(0, 10) : undefined;

        return (
            <div className="w-full">
                {label && (
                    <p id={`${fieldId}-label`} className="mb-1.5 block text-caption font-medium text-foreground">
                        {label}
                    </p>
                )}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-labelledby={label ? `${fieldId}-label` : undefined}>
                    <div>
                    <label htmlFor={`${fieldId}-date`} className="mb-1 block text-caption text-muted-foreground">
                        {t('common:labels.date')}
                    </label>
                    <input
                        id={`${fieldId}-date`}
                        type="date"
                        value={date}
                        onChange={(e) => {
                            const nextDate = e.target.value;
                            if (!nextDate) {
                                onChange('');
                                return;
                            }
                            onChange(`${nextDate}T${time || '09:00'}`);
                        }}
                        min={minDate}
                        max={maxDate}
                        className={cn('input-nexus py-0 text-caption', className)}
                        aria-invalid={invalid || undefined}
                        aria-describedby={describedBy}
                    />
                    </div>
                    <div>
                    <label htmlFor={`${fieldId}-time`} className="mb-1 block text-caption text-muted-foreground">
                        {t('common:labels.time')}
                    </label>
                    <input
                        id={`${fieldId}-time`}
                        type="time"
                        step={60}
                        value={time}
                        onChange={(e) => {
                            const nextTime = e.target.value;
                            if (!nextTime) {
                                if (!date) {
                                    onChange('');
                                    return;
                                }
                                onChange(`${date}T00:00`);
                                return;
                            }
                            onChange(`${date || today}T${nextTime}`);
                        }}
                        className={cn('input-nexus py-0 text-caption', className)}
                        aria-invalid={invalid || undefined}
                        aria-describedby={describedBy}
                    />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full">
            <label htmlFor={fieldId} className="mb-1.5 block text-caption font-medium text-foreground">
                {label || t(type === 'time' ? 'common:labels.time' : 'common:labels.date')}
            </label>
            <input
                id={fieldId}
                type={type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                min={min}
                max={max}
                className={cn('input-nexus py-0 text-caption', className)}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
            />
        </div>
    );
};

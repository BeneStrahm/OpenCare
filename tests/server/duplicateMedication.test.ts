import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import { diffMedication } from '../../server/src/lib/medicationHistory';
import { CIRCLE_ROLES, CONTENT_WRITER_ROLES, requireRole, recipientMayAccess, type CircleRequest, type CircleRole } from '../../server/src/middleware/circle';

/**
 * E56: Duplizieren legt im Client ein neues Medikament mit POST /api/medications an
 * (gleiche Rechte wie Anlegen). Die Kopie bekommt ihren eigenen Eintrag "Angelegt".
 */

const guard = (role: CircleRole) => {
    let passed = false;
    const res = { status() { return this; }, json() { return this; } } as unknown as Response;
    requireRole(...CONTENT_WRITER_ROLES)({ circleRole: role } as CircleRequest, res, () => { passed = true; });
    return passed;
};

describe('Duplizieren: Rechte fuer alle fuenf Rollen', () => {
    it('admin und family ja; professional, neighbor und recipient nein', () => {
        const allowed = CIRCLE_ROLES.filter((role) => guard(role));
        expect(allowed).toEqual(['admin', 'family']);
        expect(recipientMayAccess('POST', '/api/medications')).toBe(false);
    });
});

describe('Duplizieren: Historie', () => {
    it('die Kopie steht als "Angelegt" mit allen gefuellten Angaben und Einnahmezeiten in der Historie', () => {
        const copy = {
            name: 'Ramipril', active_ingredient: 'Ramipril', dosage: '5 mg', form: 'tablet', plan_group: 'regular',
            prescriber: 'Dr. Paula Beispiel', active: true, prn: false, photo_url: null,
            schedules: [{ id: 'neu-1', time_of_day: '08:00', days_of_week: [1, 2, 3, 4, 5, 6, 7], label: null, time_fixed: false, quantity: '1.00', unit: 'tablet', view_color: null }],
        };
        const changes = diffMedication(null, copy);
        expect(changes.map((c) => c.field)).toEqual(['name', 'active_ingredient', 'dosage', 'form', 'prescriber', 'plan_group', 'schedule']);
        expect(changes.every((c) => c.old === null)).toBe(true);
    });
});

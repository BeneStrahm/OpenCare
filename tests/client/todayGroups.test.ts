import { describe, it, expect } from 'vitest';
import { groupIntakes } from '../../client/src/lib/recipientView';
import { clockDate } from '../../client/src/lib/clock';

/** E58: "Heute" am PC und Handy gruppiert wie die einfache Ansicht. */

const intake = (id: string, due_at: string, extra: Record<string, unknown> = {}) => ({ id, due_at, time_fixed: false, prn: false, ...extra });

describe('Heute: Gruppen wie in der einfachen Ansicht', () => {
    it('Tageszeiten und je feste Uhrzeit eine eigene Gruppe, nach Uhrzeit sortiert', () => {
        const groups = groupIntakes([
            intake('abends', '2026-11-20T18:00:00'),
            intake('fest', '2026-11-20T21:30:00', { time_fixed: true }),
            intake('morgens', '2026-11-20T08:00:00'),
            intake('frueh', '2026-11-20T06:30:00', { time_fixed: true }),
        ], clockDate, { prnByMoment: true });
        expect(groups.map((g) => g.group.key)).toEqual(['fixed:06:30', 'moment:morning', 'moment:evening', 'fixed:21:30']);
    });

    it('eingetragene Bedarfs-Einnahmen bleiben unter ihrer Tageszeit, die einfache Ansicht zeigt sie nie', () => {
        const list = [intake('bedarf', '2026-11-20T14:23:00', { prn: true, time_fixed: true })];
        expect(groupIntakes(list, clockDate, { prnByMoment: true }).map((g) => g.group.key)).toEqual(['moment:noon']);
        expect(groupIntakes(list, clockDate)).toEqual([]);
    });
});

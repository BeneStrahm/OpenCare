/**
 * Kennungen der Farben der einfachen Ansicht (Launch Block D). Die Farbwerte und
 * ihre Kontrastpruefung stehen in client/src/lib/viewColors.ts und
 * tests/client/viewColors.test.ts (der Test prueft auch, dass beide Listen gleich sind).
 */
export const VIEW_COLOR_IDS: readonly string[] = ['blue', 'teal', 'green', 'purple', 'berry', 'terracotta', 'brown', 'slate'];

/**
 * Block L2: Farbe pro Medikament in der einfachen Ansicht (medications.view_color).
 * Ohne Gruen: Gruen bedeutet dort nur "Genommen" (E21). Gleiche Liste wie
 * MEDICATION_COLORS in client/src/lib/viewColors.ts.
 */
export const MEDICATION_COLOR_IDS: readonly string[] = VIEW_COLOR_IDS.filter((id) => id !== 'green');

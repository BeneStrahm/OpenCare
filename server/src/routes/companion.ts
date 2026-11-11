import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, CircleRequest } from '../middleware/circle';
import { loadTodaySnapshot } from '../lib/todaySnapshot';
import { loadCompanionExtraFacts } from '../lib/companionExtraFacts';
import { isFeatureEnabled, loadCircleSettings, type FeatureId } from '../lib/features';
import { answerIntent, HEALTH_INTENTS, noAccess, type CompanionIntent } from '../lib/companionAnswers';
import { langFromRequest } from '../lib/i18n';
import logger from '../lib/logger';

// "Fragen Sie mich": nur feste Fragen (medicaments, qui vient, rendez-vous,
// date, qui appeler), beantwortet aus den Daten des Kreises, ohne KI und ohne
// freie Eingabe. Der freie Chat (POST /message) ist mit Launch Block D entfallen.
const router = Router();
router.use(authMiddleware, circleMiddleware);

/**
 * Feste Fragen der einfachen Ansicht (betreute Person), Launch Block C.
 * Schluessel in der Adresse -> Thema in lib/companionAnswers. Die Antwort
 * entsteht nur aus den Daten des Kreises: keine KI, keine freie Eingabe,
 * nichts wird gespeichert, keine Meldung an den Kreis.
 */
export const FIXED_QUESTIONS = {
    medications: 'medications',
    visitors: 'visitors',
    appointments: 'appointments',
    week: 'appointments_week',
    date: 'datetime',
    contacts: 'contacts',
} as const satisfies Record<string, CompanionIntent>;
export type FixedQuestion = keyof typeof FIXED_QUESTIONS;

/** Ausgeschaltete Funktion -> keine Antwort zu diesem Thema (wie die Seiten der App). */
const FIXED_QUESTION_FEATURE: Partial<Record<FixedQuestion, FeatureId>> = {
    medications: 'medications',
    visitors: 'calendar',
    appointments: 'calendar',
    week: 'calendar',
    contacts: 'contacts',
};

export const isFixedQuestion = (value: string): value is FixedQuestion =>
    Object.prototype.hasOwnProperty.call(FIXED_QUESTIONS, value);

// GET /api/companion/answer/:question -> { reply, intent }
router.get('/answer/:question', async (req: CircleRequest, res: Response) => {
    try {
        const question = String(req.params.question);
        if (!isFixedQuestion(question)) {
            return res.status(400).json({ success: false, error: 'Unknown question' });
        }
        const intent = FIXED_QUESTIONS[question];
        const circleId = req.circleId!;
        const now = new Date();
        const language = langFromRequest(req);

        const settings = await loadCircleSettings(circleId);
        const feature = FIXED_QUESTION_FEATURE[question];
        if (feature && !isFeatureEnabled(settings, feature)) {
            return res.status(403).json({ success: false, error: 'FEATURE_DISABLED' });
        }
        // Gesundheitsdaten nicht fuer Nachbarn.
        if (req.circleRole === 'neighbor' && HEALTH_INTENTS.includes(intent)) {
            return res.json({ success: true, data: { reply: noAccess(language), intent } });
        }

        const snapshot = await loadTodaySnapshot(circleId, now);
        // Ausgeschaltete Funktionen fliessen auch nicht in andere Antworten ein.
        const on = (id: FeatureId) => isFeatureEnabled(settings, id);
        if (!on('calendar')) snapshot.events_today = [];
        if (!on('visitors')) { snapshot.visits_today = []; snapshot.active_visit = null; }
        if (!on('contacts')) snapshot.contacts_key = [];
        if (!on('heatwave')) snapshot.heatwave = null;
        // Termine der Woche nur fuer diese Frage; Aufgaben, Vorrat und Messwerte nie.
        const week = intent === 'appointments_week'
            ? (await loadCompanionExtraFacts(circleId, false, language, now)).events_week
            : null;
        const facts = {
            ...snapshot,
            recipientFirstName: snapshot.recipient?.first_name?.trim() || '',
            events_week: week,
        };
        const reply = answerIntent(intent, facts, language, now);
        res.json({ success: true, data: { reply, intent } });
    } catch (error) {
        logger.error('companion.answer_error', {
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

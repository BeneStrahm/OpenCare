import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireJournalWriter, CircleRequest } from '../middleware/circle';
import { aiComplete, AiError, loadAiSettingsRow, decryptStoredApiKey, type AiSettings } from '../services/ai';
import {
    COMPANION_SCHEMA,
    buildCompanionPrompt,
    buildCompanionUser,
    validateCompanionReply,
    sanitizeCompanionMessages,
    companionFallback,
    type CompanionStorySection,
} from '../services/ai/companion';
import { loadTodaySnapshot } from '../lib/todaySnapshot';
import { loadCompanionExtraFacts } from '../lib/companionExtraFacts';
import { isFeatureEnabled, loadCircleSettings, type FeatureId } from '../lib/features';
import {
    detectIntent,
    hasDistressSignal,
    answerIntent,
    buildTodayFacts,
    capabilitiesReply,
    distressHint,
    HEALTH_INTENTS,
    noAccess,
    type CompanionIntent,
} from '../lib/companionAnswers';
import { createNotification } from '../lib/notifications';
import { broadcastToCircle } from '../lib/broadcaster';
import { langFromRequest, pick, pickLang, type Lang } from '../lib/i18n';
import logger from '../lib/logger';

// "Demandez-moi" : le compagnon. Les questions pratiques
// (medicaments a prendre, qui vient, rendez-vous, date, qui appeler) sont
// repondues depuis les donnees du cercle, sans IA et sans invention ; la
// conversation libre passe par l'IA du cercle quand elle est configuree, avec
// les memes faits du jour dans son prompt. Pas de stockage de la conversation :
// l'historique vit cote client et n'est persiste QUE si une detresse est
// detectee (escalade journal + notification).
const router = Router();
router.use(authMiddleware, circleMiddleware);

type ReplySource = 'facts' | 'ai' | 'fallback';

// Notification d'escalade VOLONTAIREMENT generique: le detail (flag_reason)
// vient du modele et pourrait etre manipule par la conversation, on ne le pousse
// donc pas tel quel aux familles; il reste consultable dans l'entree de journal.
function buildAlertTexts(name: string, language: Lang): { title: string; message: string } {
    const who = name || pick(language, { fr: 'Votre proche', en: 'Your loved one', es: 'Su familiar', de: 'Ihr Angehöriger' });
    if (language === 'de') {
        return {
            title: `💬 ${who} braucht vielleicht Aufmerksamkeit`,
            message: 'Bei einem Gespräch mit dem Assistenten ist etwas aufgefallen. Bitte melden Sie sich.',
        };
    }
    if (language === 'es') {
        return {
            title: `💬 ${who} puede necesitar atención`,
            message: 'Ha surgido una señal durante una conversación con el asistente. Pregunte cómo se encuentra.',
        };
    }
    if (language === 'en') {
        return {
            title: `💬 ${who} may need attention`,
            message: 'Something came up during a conversation with the assistant. Please check in.',
        };
    }
    return {
        title: `💬 ${who} a peut-être besoin d'attention`,
        message: 'Un signal est apparu pendant une conversation avec l\'assistant. Pensez à prendre des nouvelles.',
    };
}

async function escalate(circleId: string, recipientFirstName: string, flagReason: string, language: Lang): Promise<void> {
    const { rows: memberRows } = await query(
        `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
         FROM circle_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.circle_id = $1 AND cm.role IN ('admin', 'family')`,
        [circleId]
    );

    const entryResult = await query(
        `INSERT INTO journal_entries (circle_id, author_name, type, content, data)
         VALUES ($1, $2, 'incident', $3, $4)
         RETURNING id`,
        [
            circleId,
            // Auteur = "Compagnon": l'entree est generee par le compagnon, pas
            // ecrite par le proche; ne pas signer de son prenom (provenance honnete).
            'Compagnon',
            // Langue de l'ecran, comme les entrees de visite (lib/visits).
            flagReason
                ? pick(language, {
                    fr: `Signal pendant une conversation : ${flagReason}`,
                    en: `Signal during a conversation: ${flagReason}`,
                    es: `Señal durante una conversación: ${flagReason}`,
                    de: `Hinweis während eines Gesprächs: ${flagReason}`,
                })
                : pick(language, {
                    fr: "Signal pendant une conversation avec l'assistant",
                    en: 'Signal during a conversation with the assistant',
                    es: 'Señal durante una conversación con el asistente',
                    de: 'Hinweis während eines Gesprächs mit dem Assistenten',
                }),
            JSON.stringify({ source: 'companion', flag_reason: flagReason }),
        ]
    );
    const entryId = entryResult.rows[0]?.id as string | undefined;

    await Promise.all(
        (memberRows as Array<{ user_id: string; language: string | null }>).map((member) => {
            const { title, message } = buildAlertTexts(recipientFirstName, pickLang(member.language));
            return createNotification({
                userId: member.user_id,
                circleId,
                title,
                message,
                type: 'companion_alert',
                relatedId: entryId ?? null,
                url: '/journal',
                tag: `companion-${circleId}`,
            });
        })
    );

    await broadcastToCircle(circleId, { type: 'update', entity: 'journal', action: 'created' });
    logger.info('companion.flagged', { circleId, recipients: (memberRows as unknown[]).length });
}

// POST /api/companion/message : { messages: [{role, content}] }
//   -> { reply, flagged, source: 'facts' | 'ai' | 'fallback', intent }
// Journal writers only: l'escalade ecrit une entree de journal (incident),
// donc meme classe d'action que /api/voice/transcribe; les recipient
// (lecture seule) sont exclus, conformement a la matrice de permissions.
router.post('/message', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    try {
        if (Array.isArray(req.body?.messages) && req.body.messages.length > 200) {
            return res.status(400).json({ success: false, error: 'too many messages' });
        }
        const messages = sanitizeCompanionMessages(req.body?.messages);
        if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
            return res.status(400).json({ success: false, error: 'messages must end with a user turn' });
        }
        const circleId = req.circleId!;
        const now = new Date();
        // Langue de l'ecran (Accept-Language envoye par le client), puis celle du
        // compte pour un membre, francais sinon.
        const language = langFromRequest(req);

        // Fork: Gesundheitsdaten nicht fuer Nachbarn (wie Uebersicht und Pflegeplan).
        const includeHealth = req.circleRole !== 'neighbor';

        const [snapshot, storyResult, row, extra] = await Promise.all([
            loadTodaySnapshot(circleId, now),
            query('SELECT sections FROM recipient_stories WHERE circle_id = $1', [circleId]),
            loadAiSettingsRow(circleId),
            loadCompanionExtraFacts(circleId, includeHealth, language, now),
        ]);
        const recipientFirstName = snapshot.recipient?.first_name?.trim() || '';
        const facts = { ...snapshot, ...extra, recipientFirstName };

        const lastUser = messages[messages.length - 1].content;
        const intent: CompanionIntent | null = detectIntent(lastUser);
        const answer = (i: CompanionIntent): string =>
            (!includeHealth && HEALTH_INTENTS.includes(i))
                ? noAccess(language)
                : answerIntent(i, facts, language, now, lastUser);
        const distress = hasDistressSignal(lastUser);
        const aiReady = Boolean(row && row.model && row.enabled && row.companion_enabled);

        let reply = '';
        let flagged = false;
        let flagReason = '';
        let source: ReplySource = 'fallback';

        // 1. Question pratique : reponse depuis les donnees, immediate et exacte.
        //    Si un signal de detresse accompagne la question et que l'IA est la,
        //    on la laisse repondre (elle sait escalader avec discernement).
        if (intent && !(distress && aiReady)) {
            reply = answer(intent);
            source = 'facts';
            if (intent === 'help') {
                flagged = true;
                flagReason = pick(language, { fr: "demande d'aide", en: 'asked for help', es: 'ha pedido ayuda', de: 'hat um Hilfe gebeten' });
            } else if (distress) {
                reply += distressHint(language);
            }
        } else if (aiReady && row) {
            // 2. Conversation libre : l'IA du cercle, avec les faits du jour.
            const rawSections = Array.isArray(storyResult.rows[0]?.sections) ? storyResult.rows[0].sections : [];
            const story: CompanionStorySection[] = (rawSections as Array<Record<string, unknown>>)
                .filter((s) => s && typeof s === 'object')
                .map((s) => ({
                    title: typeof s.title === 'string' ? s.title : '',
                    content: typeof s.content === 'string' ? s.content : '',
                }));
            const settings: AiSettings = {
                provider: row.provider,
                base_url: row.base_url,
                api_key: decryptStoredApiKey(row.encrypted_api_key),
                model: row.model,
            };
            try {
                const raw = await aiComplete(settings, {
                    system: buildCompanionPrompt({ recipientFirstName, story, language, today: buildTodayFacts(facts, language, now) }),
                    user: buildCompanionUser(messages, language),
                    jsonSchema: COMPANION_SCHEMA,
                });
                const result = validateCompanionReply(raw, language);
                reply = result.reply;
                flagged = result.flagged;
                flagReason = result.flag_reason;
                source = 'ai';
            } catch (aiError) {
                if (!(aiError instanceof AiError)) throw aiError;
                // Provider injoignable: une phrase calme (200) plutot qu'une erreur
                // brute, pour ne pas derouter la personne agee.
                logger.warn('companion.ai_failed', { circleId, code: aiError.code });
                reply = intent ? answer(intent) : companionFallback(language);
                source = intent ? 'facts' : 'fallback';
            }
        } else {
            // 3. Pas d'IA : on dit ce qu'on sait faire.
            reply = capabilitiesReply(language);
            if (distress) reply += distressHint(language);
        }

        // Escalade en cas de detresse: notification au cercle + trace au journal.
        if (flagged) await escalate(circleId, recipientFirstName, flagReason, language);

        res.json({ success: true, data: { reply, flagged, source, intent } });
    } catch (error) {
        logger.error('companion.message_error', {
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

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
        // Gesundheitsdaten nicht fuer Nachbarn (wie /message).
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

import { WebSocket } from 'ws';
import { query } from '../db';
import logger from './logger';

export type WsEntity =
    | 'circle'
    | 'journal'
    | 'vitals'
    | 'medications'
    | 'intakes'
    | 'events'
    | 'tasks'
    | 'shopping'
    | 'messages'
    | 'documents'
    | 'contacts'
    | 'expenses'
    | 'notifications'
    | 'integrations'
    | 'notes'
    | 'presence'
    | 'heatwave'
    | 'visits'
    | 'care_plan'
    | 'help_requests'
    | 'consultations';

export type WsAction = 'created' | 'updated' | 'deleted' | 'synced';

export interface WsUpdatePayload {
    type: 'update';
    entity: WsEntity;
    action: WsAction;
    circleId?: string;
}

/** Erinnerung an die Einnahme (Eskalation Stufe 1): die einfache Ansicht der betreuten Person zeigt sie an, die normale App ignoriert sie. */
export interface WsReminderPayload {
    type: 'reminder';
    kind: 'medication';
    count: number;
    circleId?: string;
}

export type WsPayload = WsUpdatePayload | WsReminderPayload;

/** Meme union, sans circleId (pose par broadcastToCircle). Omit ne se distribue pas sur une union. */
export type WsBroadcast = Omit<WsUpdatePayload, 'circleId'> | Omit<WsReminderPayload, 'circleId'>;

/** Registered WebSocket connections keyed by userId */
export const clients = new Map<string, Set<WebSocket>>();

/** Push a real-time update to all connections of a given user */
export const broadcast = (userId: string, data: WsPayload): void => {
    const userClients = clients.get(userId);
    if (!userClients) return;

    const message = JSON.stringify(data);
    userClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
};

/**
 * Push a real-time update to every member of a circle.
 * Fire-and-forget: a broadcast failure never breaks the API call that triggered it.
 */
export const broadcastToCircle = async (circleId: string, data: WsBroadcast): Promise<void> => {
    try {
        const result = await query('SELECT user_id FROM circle_members WHERE circle_id = $1', [circleId]);
        const payload = { ...data, circleId } as WsPayload;
        for (const row of result.rows as Array<{ user_id: string }>) {
            broadcast(row.user_id, payload);
        }
    } catch (error) {
        logger.warn('ws.broadcast_circle_failed', {
            circleId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
};

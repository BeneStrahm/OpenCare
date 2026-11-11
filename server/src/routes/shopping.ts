import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import {
    circleMiddleware, requireJournalWriter, requireRole, CircleRequest, SHOPPING_WRITER_ROLES,
    parseRecipientShoppingName, recipientMayCheckShopping, recipientShoppingUndo, type ShoppingEntryInfo,
} from '../middleware/circle';
import { toNullIfEmpty, toOptionalNumber } from '../lib/normalize';
import { broadcastToCircle } from '../lib/broadcaster';

const router = Router();

// Auth + active circle on every route
router.use(authMiddleware);
router.use(circleMiddleware);

/** Block L4: alle Rollen; recipient nur hinzufuegen, abhaken und eigenes rueckgaengig. */
const requireShoppingWriter = requireRole(...SHOPPING_WRITER_ROLES);

/** Alter von Eintrag und Abhaken in ms, in der Datenbank berechnet (wie bei den Messwerten). */
const AGE_COLUMNS_SQL = `EXTRACT(EPOCH FROM (LOCALTIMESTAMP - created_at)) * 1000 AS created_age_ms,
    EXTRACT(EPOCH FROM (LOCALTIMESTAMP - checked_at)) * 1000 AS checked_age_ms`;

/** Fuer die betreute Person: Restzeiten fuer "Rueckgaengig", ohne die internen Altersfelder. */
const withUndo = (req: CircleRequest, row: ShoppingEntryInfo & Record<string, unknown>) => {
    const item: Record<string, unknown> = { ...row };
    delete item.created_age_ms;
    delete item.checked_age_ms;
    if (req.circleRole !== 'recipient') return item;
    const undo = recipientShoppingUndo(row, req.userId);
    return { ...item, added_undo_ms_left: undo.added, checked_undo_ms_left: undo.checked };
};

// List the circle's shopping items (every member, recipient included)
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT *, ${AGE_COLUMNS_SQL} FROM shopping_items WHERE circle_id = $1 ORDER BY created_at DESC`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows.map((row) => withUndo(req, row)) });
    } catch (error) {
        console.error('Get shopping items error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Add an item (every role: the home aide adds paracetamol too; recipient only a name, Block L4).
// Categories are free-form strings, the server does not enforce a list.
router.post('/', requireShoppingWriter, async (req: CircleRequest, res: Response) => {
    try {
        if (req.circleRole === 'recipient') {
            const recipientName = parseRecipientShoppingName(req.body);
            if (!recipientName) {
                return res.status(400).json({ success: false, error: 'name is required' });
            }
            req.body = { name: recipientName };
        }
        const { name, category, quantity, unit, notes } = req.body;
        const cleanedName = typeof name === 'string' ? name.trim() : '';
        const cleanedCategory = typeof category === 'string' && category.trim() ? category.trim() : 'other';
        const parsedQuantity = quantity !== undefined ? toOptionalNumber(quantity) : null;

        if (!cleanedName) {
            return res.status(400).json({ success: false, error: 'name is required' });
        }

        if (quantity !== undefined && quantity !== '' && quantity !== null && parsedQuantity === null) {
            return res.status(400).json({ success: false, error: 'Invalid quantity format' });
        }

        const result = await query(
            `INSERT INTO shopping_items (circle_id, name, category, quantity, unit, notes, added_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [
                req.circleId,
                cleanedName,
                cleanedCategory,
                parsedQuantity,
                toNullIfEmpty(unit),
                toNullIfEmpty(notes),
                req.userId,
            ]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'shopping', action: 'created' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Create shopping item error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update an item, including checking it off (recipient: only is_checked, Block L4)
router.put('/:id', requireShoppingWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { id } = req.params;
        if (req.circleRole === 'recipient') {
            const existing = await query(
                `SELECT is_checked, added_by, checked_by, ${AGE_COLUMNS_SQL} FROM shopping_items WHERE id = $1 AND circle_id = $2`,
                [id, req.circleId]
            );
            if (existing.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Item not found' });
            }
            if (!recipientMayCheckShopping(req.body?.is_checked, existing.rows[0], req.userId)) {
                return res.status(403).json({ success: false, error: 'UNDO_EXPIRED' });
            }
            req.body = { is_checked: req.body.is_checked };
        }
        const { name, category, quantity, unit, is_checked, notes } = req.body;

        const cleanedName = name !== undefined ? toNullIfEmpty(name) : undefined;
        const cleanedCategory = category !== undefined ? toNullIfEmpty(category) : undefined;
        const parsedQuantity = quantity !== undefined ? toOptionalNumber(quantity) : undefined;

        if (quantity !== undefined && quantity !== '' && quantity !== null && parsedQuantity === null) {
            return res.status(400).json({ success: false, error: 'Invalid quantity format' });
        }

        const result = await query(
            `UPDATE shopping_items
             SET name = COALESCE($1, name),
                 category = COALESCE($2, category),
                 quantity = COALESCE($3, quantity),
                 unit = COALESCE($4, unit),
                 is_checked = COALESCE($5, is_checked),
                 notes = COALESCE($6, notes),
                 -- Block L4: wer wann abgehakt hat; nur wenn sich der Haken aendert.
                 checked_by = CASE WHEN $5::boolean IS NULL OR $5::boolean = is_checked THEN checked_by
                                   WHEN $5::boolean THEN $9::uuid ELSE NULL END,
                 checked_at = CASE WHEN $5::boolean IS NULL OR $5::boolean = is_checked THEN checked_at
                                   WHEN $5::boolean THEN LOCALTIMESTAMP ELSE NULL END
             WHERE id = $7 AND circle_id = $8 RETURNING *`,
            [
                cleanedName,
                cleanedCategory,
                parsedQuantity,
                unit !== undefined ? toNullIfEmpty(unit) : undefined,
                is_checked !== undefined ? Boolean(is_checked) : undefined,
                notes !== undefined ? toNullIfEmpty(notes) : undefined,
                id,
                req.circleId,
                req.userId,
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Item not found' });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'shopping', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update shopping item error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete an item (recipient: only her own new item, 10 minutes, Block L4)
router.delete('/:id', requireShoppingWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { id } = req.params;
        if (req.circleRole === 'recipient') {
            const existing = await query(
                `SELECT is_checked, added_by, checked_by, ${AGE_COLUMNS_SQL} FROM shopping_items WHERE id = $1 AND circle_id = $2`,
                [id, req.circleId]
            );
            if (existing.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Item not found' });
            }
            if (recipientShoppingUndo(existing.rows[0], req.userId).added <= 0) {
                return res.status(403).json({ success: false, error: 'UNDO_EXPIRED' });
            }
        }

        const result = await query(
            'DELETE FROM shopping_items WHERE id = $1 AND circle_id = $2 RETURNING id',
            [id, req.circleId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Item not found' });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'shopping', action: 'deleted' });
        res.json({ success: true, message: 'Item deleted' });
    } catch (error) {
        console.error('Delete shopping item error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Clear checked items (any role except recipient)
router.delete('/checked/clear', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    try {
        await query(
            'DELETE FROM shopping_items WHERE circle_id = $1 AND is_checked = true',
            [req.circleId]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'shopping', action: 'deleted' });
        res.json({ success: true, message: 'Checked items cleared' });
    } catch (error) {
        console.error('Clear checked items error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

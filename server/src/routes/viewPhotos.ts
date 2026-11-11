import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireRole, CONTENT_WRITER_ROLES, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';
import { cleanViewPhoto, MAX_VIEW_PHOTOS } from '../lib/viewPhotos';

// Fotos fuer die einfache Ansicht der betreuten Person (Launch Block D).
// Familie und Admin laden hoch und loeschen, die betreute Person sieht sie im
// Wechsel (Freigabe in middleware/circle.ts). Fachkraefte und Freunde brauchen sie nicht.
// Mounted on /api/view-photos by app.ts.
const router = Router();
router.use(authMiddleware, circleMiddleware);

const requireViewer = requireRole(...CONTENT_WRITER_ROLES, 'recipient');
const requireWriter = requireRole(...CONTENT_WRITER_ROLES);

// GET /api/view-photos -> [{ id, created_at }] (ohne Bilddaten, aelteste zuerst)
router.get('/', requireViewer, async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            'SELECT id, created_at FROM view_photos WHERE circle_id = $1 ORDER BY created_at, id',
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List view photos error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/view-photos/:id -> { id, data_url }
router.get('/:id', requireViewer, async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            'SELECT id, data_url FROM view_photos WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Get view photo error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/view-photos  { data_url: "data:image/jpeg;base64,..." }
router.post('/', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        const photo = cleanViewPhoto((req.body as { data_url?: unknown })?.data_url);
        if (!photo.ok) {
            return res.status(400).json({ success: false, error: photo.error === 'size' ? 'PHOTO_TOO_LARGE' : 'PHOTO_FORMAT' });
        }
        // Zaehlen und Einfuegen in einer Anweisung: auch bei gleichzeitigem Hochladen
        // nie mehr als MAX_VIEW_PHOTOS.
        const result = await query(
            `INSERT INTO view_photos (circle_id, data_url, size_bytes, created_by)
             SELECT $1, $2, $3, $4
             WHERE (SELECT COUNT(*) FROM view_photos WHERE circle_id = $1) < $5
             RETURNING id, created_at`,
            [req.circleId, photo.dataUrl, photo.sizeBytes, req.userId, MAX_VIEW_PHOTOS]
        );
        if (result.rows.length === 0) {
            return res.status(409).json({ success: false, error: 'PHOTO_LIMIT' });
        }
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'view_photos', action: 'created' });
        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Upload view photo error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// DELETE /api/view-photos/:id
router.delete('/:id', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            'DELETE FROM view_photos WHERE id = $1 AND circle_id = $2 RETURNING id',
            [req.params.id, req.circleId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'view_photos', action: 'deleted' });
        res.json({ success: true, data: {} });
    } catch (error) {
        console.error('Delete view photo error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

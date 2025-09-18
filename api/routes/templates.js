// api/routes/templates.js (ESM, usa db de la raíz)
import express from 'express';
import { query } from '../../db.js';

const router = express.Router();

/**
 * GET /api/templates
 * ?all=1 → todas (si no, solo activas)
 * ?q=texto → filtra por label ILIKE
 */
router.get('/', async (req, res) => {
  try {
    const showAll = req.query.all === '1';
    const q = (req.query.q || '').trim();

    const where = [];
    const params = [];
    if (!showAll) { params.push(true); where.push(`active = $${params.length}`); }
    if (q)       { params.push(`%${q}%`); where.push(`label ILIKE $${params.length}`); }

    const sql = `
      SELECT id, key, label, type, value, max_discount, min_subtotal,
             include_category_ids, exclude_category_ids, notes, active,
             created_at, updated_at
        FROM campaign_templates
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC
    `;

    const { rows } = await query(sql, params);
    res.json({ ok: true, count: rows.length, data: rows });
  } catch (e) {
    console.error('GET /api/templates error', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

export default router;

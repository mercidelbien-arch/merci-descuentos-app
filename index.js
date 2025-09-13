import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('tiny'));

// DB (Neon / Postgres)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // ej: postgres://user:pass@host/db
  ssl: { rejectUnauthorized: false }
});

// Salud
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Util: cálculo de descuento
function computeDiscount({ type, value, max_discount }, subtotal) {
  let discount = 0;
  if (type === 'percentage') {
    discount = subtotal * (Number(value) / 100);
    if (max_discount && Number(max_discount) > 0) {
      discount = Math.min(discount, Number(max_discount));
    }
  } else if (type === 'absolute') {
    discount = Number(value);
  }
  return -Math.abs(Number(discount || 0)); // devolver NEGATIVO para la línea de descuento
}

/**
 * POST /api/discounts/apply
 * Body: { code, subtotal, items: [{name,qty,price}] }
 * Respuesta: { ok, code, amount (negativo), label }  // lo consume el widget
 */
app.post('/api/discounts/apply', async (req, res) => {
  try {
    const { code, subtotal } = req.body || {};
    const normCode = String(code || '').trim();

    if (!normCode || typeof subtotal !== 'number') {
      return res.status(400).json({ ok: false, error: 'bad_request' });
    }

    const nowSql = `NOW() AT TIME ZONE 'UTC'`;
    const q = `
      SELECT code, type, value, max_discount, min_subtotal, label
      FROM campaigns
      WHERE LOWER(code) = LOWER($1)
        AND active = TRUE
        AND (starts_at IS NULL OR ${nowSql} >= starts_at)
        AND (ends_at   IS NULL OR ${nowSql} <= ends_at)
      LIMIT 1;
    `;
    const { rows } = await pool.query(q, [normCode]);

    if (!rows.length) {
      return res.json({ ok: false, code: normCode, reason: 'not_found_or_inactive' });
    }

    const camp = rows[0];

    if (camp.min_subtotal && Number(subtotal) < Number(camp.min_subtotal)) {
      return res.json({ ok: false, code: normCode, reason: 'min_subtotal' });
    }

    const amount = computeDiscount(
      { type: camp.type, value: camp.value, max_discount: camp.max_discount },
      Number(subtotal)
    );

    if (!amount || amount === 0) {
      return res.json({ ok: false, code: normCode, reason: 'no_benefit' });
    }

    return res.json({
      ok: true,
      code: camp.code,
      amount, // NEGATIVO
      label: camp.label || `Cupón ${camp.code}`
    });
  } catch (err) {
    console.error('apply error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Servir el widget desde /widget/...
app.use('/widget', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Home
app.get('/', (_req, res) => res.send('Merci Descuentos API'));

// Escuchar
app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});

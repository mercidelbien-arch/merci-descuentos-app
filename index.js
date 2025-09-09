// index.js
import express from "express";
import cors from "cors";
import { q } from "./db.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * GET /cupones/:codigo
 * Devuelve datos del cupón (si existe y está activo)
 */
app.get("/cupones/:codigo", async (req, res) => {
  const { codigo } = req.params;
  try {
    const { rows } = await q(
      `SELECT id, codigo, descuento_porcentaje, tope_maximo, usos_maximos, usos_realizados, activo
       FROM cupones
       WHERE codigo = $1`,
      [codigo.toUpperCase()]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: "Cupón inexistente" });

    const c = rows[0];
    if (!c.activo) return res.status(400).json({ ok: false, error: "Cupón inactivo" });
    if (c.usos_realizados >= c.usos_maximos)
      return res.status(400).json({ ok: false, error: "Cupón agotado" });

    res.json({ ok: true, cupon: c });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error consultando cupón" });
  }
});

/**
 * POST /aplicar-cupon
 * body: { codigo: string, subtotal: number }
 * Calcula el descuento = min(subtotal * % , tope_maximo)
 * y (opcionalmente) incrementa usos_realizados si querés “consumar” el uso.
 */
app.post("/aplicar-cupon", async (req, res) => {
  try {
    let { codigo, subtotal, consumir = false } = req.body || {};
    if (!codigo || typeof subtotal !== "number" || subtotal <= 0) {
      return res.status(400).json({ ok: false, error: "Datos inválidos" });
    }
    codigo = String(codigo).toUpperCase();

    const { rows } = await q(
      `SELECT id, descuento_porcentaje, tope_maximo, usos_maximos, usos_realizados, activo
       FROM cupones WHERE codigo = $1`,
      [codigo]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: "Cupón inexistente" });

    const c = rows[0];
    if (!c.activo) return res.status(400).json({ ok: false, error: "Cupón inactivo" });
    if (c.usos_realizados >= c.usos_maximos)
      return res.status(400).json({ ok: false, error: "Cupón agotado" });

    const descuentoPorcentaje = c.descuento_porcentaje / 100;
    const descuentoCalculado = subtotal * descuentoPorcentaje;
    const descuento = Math.min(Number(descuentoCalculado.toFixed(2)), Number(c.tope_maximo));

    const total = Number((subtotal - descuento).toFixed(2));

    // Si “consumir” es true, marcamos el uso
    if (consumir) {
      await q(
        `UPDATE cupones
         SET usos_realizados = usos_realizados + 1
         WHERE id = $1`,
        [c.id]
      );
    }

    res.json({
      ok: true,
      codigo,
      descuento_porcentaje: c.descuento_porcentaje,
      tope_maximo: Number(c.tope_maximo),
      subtotal,
      descuento,
      total,
      puede_consumirse: c.usos_realizados + 1 <= c.usos_maximos,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error aplicando cupón" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(Merci descuentos API running on :${PORT});
});

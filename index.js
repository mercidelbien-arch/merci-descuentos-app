// index.js
import express from "express";
import cors from "cors";
import { q } from "./db.js";

const app = express();
app.use(cors());
app.use(express.json());

// Ruta de prueba (Render usa esto para verificar que el server está vivo)
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
       WHERE codigo = $1 AND activo = true`,
      [codigo]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Cupón no válido o inactivo" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// 🚀 Esto es lo que faltaba: arrancar el servidor en el puerto que Render asigna
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(Servidor escuchando en puerto ${PORT});
});

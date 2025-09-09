// index.js
import express from "express";
import cors from "cors";
import { q } from "./db.js";

const app = express();
app.use(cors());
app.use(express.json());

// Ruta de prueba para verificar que el servidor está vivo
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
    const rows = await q(
      `SELECT id, codigo, descuento_porcentaje, tope_maximo, usos_maximos, usos_realizados, activo 
       FROM cupones 
       WHERE codigo = $1 
       AND activo = true 
       AND (usos_realizados < usos_maximos OR usos_maximos = 0)`,
      [codigo]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Cupón no válido o inactivo" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error consultando cupón:", err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});
// Endpoint de prueba de la base de datos
app.get("/test-db", async (req, res) => {
  try {
    const result = await q("SELECT NOW()");
    res.json({ ok: true, time: result.rows[0] });
  } catch (err) {
    console.error("Error al conectar con la DB:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
// Configuración del puerto
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor escuchando en puerto " + PORT);
});

// index.js
import express from "express";
import cors from "cors";
import { q } from "./db.js";

const app = express();
app.use(cors());
app.use(express.json());

// Endpoint de salud
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Endpoint de cupones (ejemplo)
app.get("/cupones/:codigo", async (req, res) => {
  const { codigo } = req.params;
  try {
    const rows = await q(
      `SELECT id, codigo, descuento_porcentaje, tope_maximo, usos_maximos, usos_realizados, activo 
       FROM cupones WHERE codigo = $1 AND activo = true`,
      [codigo]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Cupón no encontrado o inactivo" });
    }

    res.json({ ok: true, cupon: rows[0] });
  } catch (err) {
    console.error("Error en /cupones/:codigo:", err);
    res.status(500).json({ ok: false, error: "Error en el servidor" });
  }
});

// 🔹 Nuevo endpoint de prueba de conexión a la base de datos
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
  console.log(Servidor escuchando en puerto ${PORT});
});

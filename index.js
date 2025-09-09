// index.js
import express from "express";
import cors from "cors";
import pkg from "pg";

const { Pool } = pkg;

// Configuración de la app
const app = express();
app.use(cors());
app.use(express.json());

// Config DB (usa la variable de entorno DB_URL)
const pool = new Pool({
  connectionString: process.env.DB_URL,
  ssl: { rejectUnauthorized: false }
});

// Endpoint de prueba (salud del server)
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Endpoint de prueba de DB
app.get("/test-db", async (_req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ ok: true, time: result.rows[0] });
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ ok: false, error: "Error conectando a la DB" });
  }
});

// GET /cupones/:codigo
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
      return res.status(404).json({ ok: false, error: "Cupón no encontrado o inactivo" });
    }

    res.json({ ok: true, cupon: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error consultando la base de datos" });
  }
});

// Configuración del puerto
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor escuchando en puerto " + PORT);
});

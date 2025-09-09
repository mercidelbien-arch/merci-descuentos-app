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

// Configuración del puerto
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor escuchando en puerto " +PORT);
});

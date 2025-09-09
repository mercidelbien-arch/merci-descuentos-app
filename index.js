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


// Configuración del puerto
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor escuchando en puerto " +PORT);
});

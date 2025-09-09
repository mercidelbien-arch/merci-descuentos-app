// db.js
import pg from "pg";
const { Pool } = pg;

// Usamos la cadena de conexión que pusiste en Render (DB_URL)
const pool = new Pool({
  connectionString: process.env.DB_URL,
  // Railway/Render suelen requerir SSL
  ssl: { rejectUnauthorized: false },
});

// Helper para consultas: q(sql, params) -> rows
export async function q(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

// Probar conexión al iniciar
pool
  .connect()
  .then((c) => {
    c.release();
    console.log("DB conectada ✅");
  })
  .catch((err) => {
    console.error("Error conectando a DB ❌", err);
  })

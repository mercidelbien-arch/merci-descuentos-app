// db.js
import pg from "pg";

const { Pool } = pg;

// Render/ Railway: la URL viene de la env DB_URL
const connectionString = process.env.DB_URL;

export const pool = new Pool({
  connectionString,
  // En muchos PaaS hace falta SSL
  ssl: { rejectUnauthorized: false },
});

// Helper simple para consultas
export async function q(strings, ...values) {
  // Permite usar q`SELECT * FROM tabla WHERE id=${id}`
  const text =
    Array.isArray(strings)
      ? strings.map((s, i) => s + (i < values.length ? $${i + 1} : `)).join(`)
      : strings;
  const res = await pool.query(text, values);
  return res.rows;
}

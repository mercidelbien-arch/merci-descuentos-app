// db.js
import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DB_URL,
  ssl: { rejectUnauthorized: false }, // necesario en Render
});

// helper sencillo para consultas
export const q = (text, params) => pool.query(text, params);

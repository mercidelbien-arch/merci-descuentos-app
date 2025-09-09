// db.js
import pkg from "pg";
const { Pool } = pkg;

// Render/Variables -> DB_URL (la que ya pegaste)
const connectionString = process.env.DB_URL;

export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // necesario en Render
});

// Helper para consultas
export const q = (text, params = []) => pool.query(text, params);

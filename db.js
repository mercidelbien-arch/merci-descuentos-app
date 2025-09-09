// db.js
import pkg from "pg";
const { Pool } = pkg;

// Creamos el pool de conexión usando la variable de entorno DB_URL
const pool = new Pool({
  connectionString: process.env.DB_URL,
  ssl: { rejectUnauthorized: false }, // Necesario para conexiones externas seguras
});

// Función rápida para ejecutar queries
export const q = (text, params) => pool.query(text, params);

// Exportamos el pool si lo necesitás en otras partes
export default pool;

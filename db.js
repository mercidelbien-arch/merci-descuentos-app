// db.js — conexión a Neon/Postgres
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render + Neon necesitan SSL
});

export default pool;

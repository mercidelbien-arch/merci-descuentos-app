// index.js — servidor mínimo para sanity check
import express from "express";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;

// Salud simple
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    data: {
      status: "ok",
      node: process.version,
      envPort: process.env.PORT || null,
      time: new Date().toISOString(),
    },
  });
});

// Raíz
app.get("/", (_req, res) => {
  res.type("text/plain").send("Merci Descuentos — minimal server OK");
});

// Arranque con manejo de errores
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
}).on("error", (err) => {
  console.error("Listen error:", err);
});

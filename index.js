import express from "express";
const app = express();
app.use(express.json());

// Endpoint de prueba
app.get("/health", (_req, res) => res.send("ok"));

// Placeholders
app.get("/auth/install", (_req, res) => res.status(200).send("Install OK (placeholder)"));
app.get("/auth/callback", (_req, res) => res.status(200).send("Callback OK (placeholder)"));
app.post("/discounts/callback", (_req, res) => res.sendStatus(204));
app.post("/webhooks/order-paid", (_req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server on", PORT));

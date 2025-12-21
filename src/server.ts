import express from "express";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// HEALTH CHECK — NOTHING CAN BLOCK THIS
app.get("/api/test", (_req, res) => {
  res.status(200).json({ status: "API OK" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Health server running on port ${PORT}`);
});

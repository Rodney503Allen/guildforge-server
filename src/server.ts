import express from "express";

const app = express();

app.get("/api/test", (_req, res) => {
  res.json({ status: "API OK" });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Guildforge engine running on port ${PORT}`);
});

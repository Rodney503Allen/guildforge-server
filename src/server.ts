import express from "express";
import session from "express-session";
import { db } from "./db";

const app = express();

/**
 * =======================
 * HEALTH CHECK (ALWAYS FIRST)
 * =======================
 */
app.get("/api/test", (_req, res) => {
  res.json({ status: "API OK" });
});

app.get("/api/dbcheck", async (_req, res) => {
  try {
    const [[row]]: any = await db.query("SELECT 1 AS ok");
    res.json(row);
  } catch (err) {
    console.error("DB check failed:", err);
    res.status(500).json({ error: "DB failed" });
  }
});

/**
 * =======================
 * BASIC MIDDLEWARE
 * =======================
 */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

/**
 * =======================
 * SESSION SETUP
 * =======================
 */
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev_secret",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
  })
);

app.get("/", (_req, res) => {
  res.send("Guildforge server online");
});

/**
 * =======================
 * START SERVER
 * =======================
 */
const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Guildforge engine running on port ${PORT}`);
});

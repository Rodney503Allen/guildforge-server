import express from "express";
import session from "express-session";

const app = express();

/**
 * =======================
 * HEALTH CHECK (ALWAYS FIRST)
 * =======================
 * This must NEVER be blocked by middleware, DB, or auth.
 */
app.get("/api/test", (_req, res) => {
  res.json({ status: "API OK" });
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
    cookie: {
      secure: false, // Railway terminates HTTPS before Node
    },
  })
);

/**
 * =======================
 * OPTIONAL ROOT (FOR SANITY)
 * =======================
 */
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

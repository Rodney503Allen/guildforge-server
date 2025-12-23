import mysql from "mysql2/promise";

let dbConfig;

if (process.env.MYSQL_URL || process.env.DATABASE_URL) {
  // =======================
  // PRODUCTION (Railway / Render)
  // =======================
  dbConfig = {
    uri: process.env.MYSQL_URL || process.env.DATABASE_URL,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  };
} else {
  // =======================
  // LOCALHOST DEVELOPMENT
  // =======================
  dbConfig = {
    host: "localhost",
    user: "root",          // change if needed
    password: "Caelan#1748",          // change if needed
    database: "guildforge",// change if needed
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  };
}

export const db = mysql.createPool(dbConfig);

// =======================
// CONNECTION TEST
// =======================
db.getConnection()
  .then(conn => {
    console.log("✅ Connected to MySQL");
    conn.release();
  })
  .catch(err => {
    console.error("❌ MySQL connection FAILED:", err);
  });





















/*
import mysql from "mysql2/promise";

const MYSQL_CONNECTION_URL =
  process.env.MYSQL_URL || process.env.DATABASE_URL;

if (!MYSQL_CONNECTION_URL) {
  throw new Error("No MySQL connection URL found");
}

export const db = mysql.createPool({
  uri: MYSQL_CONNECTION_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});


db.getConnection()
  .then(() => console.log("✅ Connected to MySQL"))
  .catch(err => console.error("❌ MySQL connection FAILED:", err));
  */

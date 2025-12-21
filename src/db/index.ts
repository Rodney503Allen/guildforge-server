import mysql from "mysql2/promise";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

export const db = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

/*
export const db = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "Caelan#1748",
  database: "guildforge",
  connectionLimit: 10
});
*/

db.getConnection()
  .then(() => console.log("✅ Connected to MySQL"))
  .catch(err => console.error("❌ MySQL connection FAILED:", err));

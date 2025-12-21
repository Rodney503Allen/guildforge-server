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

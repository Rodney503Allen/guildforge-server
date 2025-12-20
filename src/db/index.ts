import mysql from "mysql2/promise";

export const db = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "Caelan#1748",
  database: "guildforge",
  connectionLimit: 10
});

db.getConnection()
  .then(() => console.log("✅ Connected to MySQL"))
  .catch(err => console.error("❌ MySQL connection FAILED:", err));

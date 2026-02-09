const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(cors());

console.log(process.env.DATABASE_URL);

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL env var");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.query("SELECT 1").then(
  () => console.log("Connected to Postgres."),
  (err) => {
    console.error("Failed to connect to Postgres.", err);
    process.exit(1);
  }
);

app.post("/data", async (req, res) => {
  try {
    const row = {
      pressure: req.body.pressure,
      accel: req.body.accel,
    };

    await pool.query(
      `INSERT INTO telemetry (pressure, accel)
       VALUES ($1, $2)`,
      [row.pressure, row.accel]
    );

    console.log("Successfully stored: ", row);
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /data error:", err);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

app.get("/data", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "200", 10), 2000);

    const { rows } = await pool.query(
      `SELECT id, t, pressure, accel
       FROM telemetry
       ORDER BY t DESC
       LIMIT $1`,
      [limit]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET /data error:", err);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () =>
  console.log("API running on port", PORT)
);


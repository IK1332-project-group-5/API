const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(cors());

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

// BULK + SINGLE COMPAT POST
app.post("/data", async (req, res) => {
  try {
    const payload = req.body;
    const rows = Array.isArray(payload) ? payload : [payload];

    if (rows.length === 0) {
      return res.status(400).json({ ok: false, error: "empty_payload" });
    }

    const values = [];
    const params = [];

    rows.forEach((r, i) => {
      if (
        r.pressure == null ||
        r.accel == null ||
        r.gyro == null ||
        r.mag == null
      ) {
        throw new Error("bad payload");
      }

      const base = i * 4;

      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
      params.push(r.pressure, r.accel, r.gyro, r.mag);
    });

    await pool.query(
      `INSERT INTO telemetry (pressure, accel, gyro, mag)
       VALUES ${values.join(",")}`,
      params
    );

    console.log("Stored batch:", rows.length);

    res.json({
      ok: true,
      inserted: rows.length
    });

  } catch (err) {
    console.error("POST bulk error:", err);
    res.status(500).json({ ok: false, error: err });
  }
});

//
//  READ FROM DATABASE
//
app.get("/data", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "200", 10), 2000);

    const { rows } = await pool.query(
      `SELECT id, t, pressure, accel
       FROM telemetry
       ORDER BY id DESC
       LIMIT $1`,
      [limit]
    );

    res.json(rows);

  } catch (err) {
    console.error("GET /data error:", err);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

// HEALTH CHECK
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

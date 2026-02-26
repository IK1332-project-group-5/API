const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

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

let lastDoorOpen = null;

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

    // const { api_key } = req.body;
    // if (!api_key || api_key !== process.env.API_KEY) {
    //   console.log(rows);
    //   return res.status(403).json({ ok: false, error: "forbidden" });
    // }

    if (rows.length === 0) {
      return res.status(400).json({ ok: false, error: "empty_payload" });
    }

    const values = [];
    const params = [];
    const alarms = [];
    const alarmInserts = [];

    rows.forEach((r, i) => {

      // accel är JSONB {x, y, z} — beräkna magnitude för abrupt stop
      const accelMag = r.accel
        ? Math.sqrt(r.accel.x ** 2 + r.accel.y ** 2 + (r.accel.z - 1000) ** 2)
        : 0;

      // ABRUPT STOP: hissen är stillastående men hög acceleration
      const isMoving = r.moving === 1 || r.moving === true;
      if (!isMoving && accelMag > 150) {
        alarms.push("abrupt_stop");
        alarmInserts.push({
          type: "abrupt_stop",
          severity: "high",
          message: "Abrupt stop detected"
        });
      }

      // DOOR EVENT: Arduino ML skickar door_open baserat på magnetometer
      const doorOpen = r.door_open === 1 || r.door_open === true;
      if (!isMoving && doorOpen !== lastDoorOpen && lastDoorOpen !== null) {
        const eventType = doorOpen ? "door_opened" : "door_closed";
        alarms.push(eventType);
        alarmInserts.push({
          type: eventType,
          severity: "info",
          message: doorOpen ? "Door opened" : "Door closed"
        });
      }
      lastDoorOpen = doorOpen;

      if (
        r.pressure == null ||
        r.accel == null ||
        r.mag == null ||
        r.moving == null ||
        r.door_open == null
      ) {
        throw new Error("bad payload");
      }

      if (r.api_key !== process.env.API_KEY || !r.api_key) {
        return res.status(403);
      }

      const base = i * 6;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
      params.push(
        r.pressure,
        r.accel,
        r.mag,
        isMoving,
        r.floor,
        doorOpen
      );
    });

    const insertResult = await pool.query(
      `INSERT INTO telemetry (pressure, accel, mag, moving, floor, door_open)
      VALUES ${values.join(",")}
      RETURNING id`,
      params
    );
    const lastInsertedId = insertResult.rows[insertResult.rows.length - 1].id;

    for (const a of alarmInserts) {

      // kolla om samma alarm redan finns (senaste)
      const existing = await pool.query(
        `SELECT id
         FROM alarms
         WHERE type = $1
         ORDER BY id DESC
         LIMIT 1`,
        [a.type]
      );

      if (existing.rows.length > 0) {
        // uppdatera last_seen_id istället
        await pool.query(
          `UPDATE alarms
           SET last_seen_id = $1
           WHERE id = $2`,
          [lastInsertedId, existing.rows[0].id]
        );
      } else {
        // skapa nytt alarm
        await pool.query(
          `INSERT INTO alarms
           (type, severity, message, first_seen_id, last_seen_id)
           VALUES ($1, $2, $3, $4, $4)`,
          [a.type, a.severity, a.message, lastInsertedId]
        );
      }
    }



    console.log("Stored batch:", rows.length);

    res.json({
      ok: true,
      inserted: rows.length,
      alarms
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
      `SELECT *
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

app.get("/alarms", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT a.*
      FROM alarms a
      JOIN telemetry t ON t.id = a.last_seen_id
      WHERE t.moving = false
      ORDER BY a.id DESC
      LIMIT 50
      `
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "db_error" });
  }
});

// TRAVEL PATTERN — senaste resorna
app.get("/trips", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH last1000 AS (
        SELECT id, floor, moving
        FROM telemetry
        ORDER BY id DESC
        LIMIT 1000
      ),
      ordered AS (
        SELECT
          id,
          floor,
          moving,
          LAG(moving) OVER (ORDER BY id) AS prev_moving
        FROM last1000
      ),
      starts AS (
        SELECT
          id AS start_id,
          floor AS start_floor,
          ROW_NUMBER() OVER (ORDER BY id) AS trip_no
        FROM ordered
        WHERE moving = true
          AND (prev_moving = false OR prev_moving IS NULL)
      ),
      ends AS (
        SELECT
          id AS end_id,
          floor AS end_floor,
          ROW_NUMBER() OVER (ORDER BY id) AS trip_no
        FROM ordered
        WHERE moving = false
          AND prev_moving = true
      )
      SELECT
        s.trip_no,
        s.start_id,
        e.end_id,
        s.start_floor,
        e.end_floor,
        ABS(e.end_floor - s.start_floor) AS floors
      FROM starts s
      JOIN ends e USING (trip_no)
      WHERE ABS(e.end_floor - s.start_floor) > 0
      ORDER BY e.end_id DESC;
    `);

    res.json(rows);
    console.log(rows);
  } catch (err) {
    console.error("GET /trips error:", err);
    res.status(500).json({ error: "db_error" });
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


// CLOUD ML ENDPOINTS
app.get('/ml/model', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM linear_travel_model;");
    res.json(rows).status(200);
  } catch (error) {
    res.status(500).json({ ok: false, error: error })
  }
});

app.get("/ml/predict/:start/:end", async (req, res) => {
  try {
    const start = Number(req.params.start);
    const end = Number(req.params.end);

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return res.status(400).json({
        error: "Start and end must be valid numbers"
      });
    }

    const floors = Math.abs(end - start);

    const { rows } = await pool.query(
      `SELECT beta0, beta1, sigma, r2, n, created_at
       FROM linear_travel_model
       ORDER BY id DESC
       LIMIT 1`
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: "No trained model available yet"
      });
    }

    const { beta0, beta1, sigma, r2, n, created_at } = rows[0];

    const predicted = beta0 + beta1 * floors;

    const lower = predicted - 2 * sigma;
    const upper = predicted + 2 * sigma;

    return res.json({
      input: {
        start_floor: start,
        end_floor: end,
        floors
      },
      prediction: {
        expected_seconds: predicted,
        range_95: [lower, upper]
      },
      model: {
        beta0,
        beta1,
        sigma,
        r2,
        trained_on_trips: n,
        trained_at: created_at
      }
    });

  } catch (error) {
    console.error("Prediction error:", error);
    return res.status(500).json({
      error: "Prediction failed"
    });
  }
});

app.get("/ml/anomalies/:limit/:threshold", async (req, res) => {
  try {
    // Limit = how many trips to include
    // Threshold = how strictly to look for anomalies:
    //             1 = 1 standard deviation away
    //             2 = 2 standard deviation away etc.
    // Basically, |z| > threshold
    const limit = Number(req.params.limit);
    const threshold = Number(req.params.threshold);

    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 20;
    const safeThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : 2;

    const modelRes = await pool.query(
      `SELECT beta0, beta1, sigma
       FROM linear_travel_model
       ORDER BY id DESC
       LIMIT 1`
    );

    if (modelRes.rows.length === 0) {
      return res.status(404).json({ error: "No trained model available" });
    }

    const beta0 = Number(modelRes.rows[0].beta0);
    const beta1 = Number(modelRes.rows[0].beta1);
    const sigma = Number(modelRes.rows[0].sigma);

    if (!Number.isFinite(beta0) || !Number.isFinite(beta1) || !Number.isFinite(sigma) || sigma === 0) {
      return res.status(400).json({ error: "Model parameters invalid; anomaly detection unavailable" });
    }

    const { rows } = await pool.query(
      `
      SELECT
        t.id,
        t.start_floor,
        t.end_floor,
        t.duration,
        ABS(t.end_floor - t.start_floor) AS floors,
        ( $1::double precision + $2::double precision * ABS(t.end_floor - t.start_floor) ) AS predicted,
        (t.duration::double precision - ( $1::double precision + $2::double precision * ABS(t.end_floor - t.start_floor) )) AS error,
        (t.duration::double precision - ( $1::double precision + $2::double precision * ABS(t.end_floor - t.start_floor) )) / $3::double precision AS z_score
      FROM trips t
      WHERE ABS(
        (t.duration::double precision - ( $1::double precision + $2::double precision * ABS(t.end_floor - t.start_floor) )) / $3::double precision
      ) > $4::double precision
      ORDER BY ABS(
        (t.duration::double precision - ( $1::double precision + $2::double precision * ABS(t.end_floor - t.start_floor) )) / $3::double precision
      ) DESC
      LIMIT $5::int
      `,
      [beta0, beta1, sigma, safeThreshold, safeLimit]
    );

    return res.json({
      threshold: safeThreshold,
      limit: safeLimit,
      count: rows.length,
      anomalies: rows
    });
  } catch (err) {
    console.error("Anomaly detection error:", err);
    return res.status(500).json({ error: "Failed to compute anomalies" });
  }
});


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

    const { api_key } = req.body;
    if (!api_key || api_key !== process.env.API_KEY) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

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
        r.gyro == null ||
        r.mag == null ||
        r.moving == null ||
        r.door_open == null
      ) {
        throw new Error("bad payload");
      }

      const base = i * 7;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
      params.push(
        r.pressure,
        r.accel,
        r.gyro,
        r.mag,
        isMoving,
        r.floor,
        doorOpen
      );
    });

    const insertResult = await pool.query(
      `INSERT INTO telemetry (pressure, accel, gyro, mag, moving, floor, door_open)
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
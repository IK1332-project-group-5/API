const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

let store = [];

app.post("/data", (req,res) => {
  const row = {
    t: Date.now(),
    pressure: req.body.pressure,
    accel: req.body.accel
  };

  store.push(row);
  console.log("Received:", row);

  res.json({ok:true});
});

app.get("/data", (req,res) => {
  res.json(store);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () =>
  console.log("API running on port", PORT)
);


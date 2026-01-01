require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Stripe = require("stripe");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// In-memory store (OK for now)
const db = require("./db");

app.use(cors());

// ❗ DO NOT parse JSON globally for webhook
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// ---------- CREATE CHECKOUT SESSION ----------
app.post("/create-checkout-session", async (req, res) => {
  const { plan, deviceId } = req.body;

  const priceId =
    plan === "yearly"
      ? "price_1Sjtj10V3msArFU1pteEpDbb" //yearly price id
      : "price_1Sk8Y50V3msArFU1a5GYycxV"; //monthly price id

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: "eyebalance://success",
    cancel_url: "eyebalance://cancel",
    metadata: { 
      deviceId,
      plan
    }
  });

  res.json({ url: session.url });
});

//=============================== CREATE CUSTOMER PORTAL SESSION==============================
app.post("/create-portal-session", async (req, res) => {
  const { deviceId } = req.body;

  const row = db
    .prepare("SELECT customerId FROM subscriptions WHERE deviceId = ?")
    .get(deviceId);

  if (!row?.customerId) {
    return res.status(400).json({ error: "No customer found" });
  }

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: row.customerId,
    return_url: "eyebalance://subscription"
  });

  res.json({ url: portalSession.url });
});

// ---------- WEBHOOK ----------
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // PAYMENT SUCCESS (trial or paid)
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const deviceId = session.metadata.deviceId;
      const plan = session.metadata.plan; // "monthly" | "yearly"

      db.prepare(`
        INSERT INTO subscriptions (deviceId, plan, status, trial, expiresAt, customerId)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(deviceId) DO UPDATE SET
          plan=excluded.plan,
          status=excluded.status,
          trial=excluded.trial,
          expiresAt=excluded.expiresAt,
          customerId=excluded.customerId
      `).run(
        deviceId,
        plan,
        "active",
        0,
        null,
        customerId
      );
    }

    // SUBSCRIPTION CANCELED
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const deviceId = subscription.metadata.deviceId;

      db.prepare(`
        UPDATE subscriptions
        SET plan='free', status='inactive', trial=0
        WHERE deviceId=?
      `).run(deviceId);
    }

    res.json({ received: true });
  }
);
// ---------- SUBSCRIPTION STATUS ----------
app.get("/subscription-status/:deviceId", (req, res) => {
  const row = db
    .prepare("SELECT * FROM subscriptions WHERE deviceId = ?")
    .get(req.params.deviceId);

  if (!row) {
    return res.json({ plan: "free", status: "inactive", trial: false });
  }

  res.json({
    plan: row.plan,
    status: row.status,
    trial: Boolean(row.trial),
    expiresAt: row.expiresAt
  });
});

const PORT = process.env.PORT || 4242;

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});





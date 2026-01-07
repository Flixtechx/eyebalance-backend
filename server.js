require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Stripe = require("stripe");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const db = require("./db");

/* =========================
   GLOBAL SAFETY NETS
========================= */
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

/* =========================
   MIDDLEWARE
========================= */
app.use(cors());

// ❗ Do NOT JSON-parse webhook
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") return next();
  express.json()(req, res, next);
});

/* =========================
   CREATE CHECKOUT SESSION
========================= */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { plan, deviceId } = req.body;

    if (!deviceId || !["monthly", "yearly"].includes(plan)) {
      return res.status(400).json({ error: "Invalid checkout request" });
    }

    const priceId =
      plan === "yearly"
        ? "price_1Sjtj10V3msArFU1pteEpDbb"
        : "price_1Sk8Y50V3msArFU1a5GYycxV";

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 7,
        metadata: { deviceId }
      },
      success_url: "eyebalance://success",
      cancel_url: "eyebalance://cancel",
      metadata: { deviceId, plan }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: "Checkout failed" });
  }
});

/* =========================
   CUSTOMER PORTAL
========================= */
app.post("/create-portal-session", async (req, res) => {
  try {
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
  } catch (err) {
    console.error("Portal error:", err);
    res.status(500).json({ error: "Portal unavailable" });
  }
});

/* =========================
   STRIPE WEBHOOK (SAFE)
========================= */
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const sig = req.headers["stripe-signature"];
      let event;

      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error("Webhook signature error:", err.message);
        return res.status(400).send("Invalid signature");
      }

      /* ---------- CHECKOUT COMPLETED ---------- */
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const deviceId = session.metadata?.deviceId;
        const plan = session.metadata?.plan;

        if (!deviceId || !session.subscription) {
          return res.json({ received: true });
        }

        const subscription = await stripe.subscriptions.retrieve(
          session.subscription
        );

        await stripe.subscriptions.update(session.subscription, {
          metadata: { deviceId }
        });

        db.prepare(`
          INSERT INTO subscriptions (deviceId, plan, status, expiresAt, customerId)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(deviceId) DO UPDATE SET
            plan=excluded.plan,
            status=excluded.status,
            expiresAt=excluded.expiresAt,
            customerId=excluded.customerId
        `).run(
          deviceId,
          plan,
          subscription.status,
          subscription.trial_end ? subscription.trial_end * 1000 : null,
          subscription.customer
        );
      }

      /* ---------- SUBSCRIPTION CREATED / UPDATED ---------- */
      if (
        event.type === "customer.subscription.created" ||
        event.type === "customer.subscription.updated"
      ) {
        const sub = event.data.object;
        const deviceId = sub.metadata?.deviceId;

        if (!deviceId) return res.json({ received: true });

        const plan =
          sub.items.data[0].price.recurring.interval === "year"
            ? "yearly"
            : "monthly";

        db.prepare(`
          INSERT INTO subscriptions (deviceId, plan, status, expiresAt, customerId)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(deviceId) DO UPDATE SET
            plan=excluded.plan,
            status=excluded.status,
            expiresAt=excluded.expiresAt,
            customerId=excluded.customerId
        `).run(
          deviceId,
          plan,
          sub.status,
          sub.trial_end ? sub.trial_end * 1000 : null,
          sub.customer
        );
      }

      /* ---------- PAYMENT FAILED ---------- */
      if (event.type === "invoice.payment_failed") {
        const invoice = event.data.object;
        if (!invoice.subscription) return res.json({ received: true });

        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const deviceId = sub.metadata?.deviceId;
        if (!deviceId) return res.json({ received: true });

        db.prepare(`
          UPDATE subscriptions
          SET status='inactive'
          WHERE deviceId=?
        `).run(deviceId);
      }

      /* ---------- SUBSCRIPTION CANCELED ---------- */
      if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const deviceId = sub.metadata?.deviceId;
        if (!deviceId) return res.json({ received: true });

        db.prepare(`
          UPDATE subscriptions
          SET plan='free', status='inactive', expiresAt=NULL
          WHERE deviceId=?
        `).run(deviceId);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("Webhook fatal error:", err);
      res.json({ received: true }); // NEVER crash Stripe
    }
  }
);

/* =========================
   SUBSCRIPTION STATUS
========================= */
app.get("/subscription-status/:deviceId", (req, res) => {
  try {
    const row = db
      .prepare("SELECT * FROM subscriptions WHERE deviceId = ?")
      .get(req.params.deviceId);

    if (!row) {
      return res.json({
        plan: "free",
        status: "inactive",
        expiresAt: null
      });
    }

    res.json({
      plan: row.plan,
      status: row.status,
      expiresAt: row.expiresAt
    });
  } catch (err) {
    console.error("Status error:", err);
    res.json({
      plan: "free",
      status: "inactive",
      expiresAt: null
    });
  }
});

/* =========================
   SERVER START
========================= */
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const webpush = require("web-push");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const cron = require("node-cron");

// Initialize Firebase Admin for both databases
const app1 = admin.initializeApp(
  {
    credential: admin.credential.cert({
      type: process.env.FIREBASE_TYPE,
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: process.env.FIREBASE_AUTH_URI,
      token_uri: process.env.FIREBASE_TOKEN_URI,
      auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
      client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
      universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
    }),
  },
  "db1"
);

const app2 = admin.initializeApp(
  {
    credential: admin.credential.cert({
      type: process.env.FIREBASE_TYPE_2,
      project_id: process.env.FIREBASE_PROJECT_ID_2,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID_2,
      private_key: process.env.FIREBASE_PRIVATE_KEY_2.replace(/\\n/g, "\n"),
      client_email: process.env.FIREBASE_CLIENT_EMAIL_2,
      client_id: process.env.FIREBASE_CLIENT_ID_2,
      auth_uri: process.env.FIREBASE_AUTH_URI_2,
      token_uri: process.env.FIREBASE_TOKEN_URI_2,
      auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL_2,
      client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL_2,
      universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN_2,
    }),
  },
  "db2"
);

const db1 = getFirestore(app1);
const db2 = getFirestore(app2);
const subscriptionsCollection = db1.collection("subscriptions"); // Use db1 or db2

const app = express();
app.use(express.json());
app.use(cors());

// VAPID Keys
webpush.setVapidDetails(
  "mailto:your-email@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Store subscribers in memory
let subscribers = [];

// Load subscriptions from Firestore on server start
const loadSubscriptions = async () => {
  try {
    const snapshot = await subscriptionsCollection.get();
    subscribers = snapshot.docs.map((doc) => doc.data());
    console.log(`Loaded ${subscribers.length} subscriptions from Firestore.`);
  } catch (error) {
    console.error("Error loading subscriptions from Firestore:", error);
  }
};

// Call this function when the server starts
loadSubscriptions();

// API to store push subscription
app.post("/subscribe", async (req, res) => {
  const { subscription } = req.body;

  if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    console.error("Invalid subscription:", subscription);
    return res.status(400).json({ message: "Invalid subscription: Missing required fields" });
  }

  // Check for duplicate subscriptions
  const isDuplicate = subscribers.some((sub) => sub.endpoint === subscription.endpoint);
  if (isDuplicate) {
    console.log("Subscription already exists:", subscription.endpoint);
    return res.status(200).json({ message: "Subscription already exists." });
  }

  // Add the subscription to Firestore
  try {
    await subscriptionsCollection.add(subscription);
    subscribers.push(subscription); // Add to in-memory array
    console.log("New subscription added:", subscription.endpoint);
    res.status(201).json({ message: "Subscribed successfully!" });
  } catch (error) {
    console.error("Error saving subscription to Firestore:", error);
    res.status(500).json({ message: "Failed to save subscription." });
  }
});

// Function to clean up invalid subscriptions
const cleanupSubscriptions = async () => {
  const validSubscriptions = [];
  const invalidSubscriptions = [];

  subscribers.forEach((sub) => {
    try {
      new URL(sub.endpoint); // Check if the endpoint is a valid URL
      validSubscriptions.push(sub); // Keep valid subscriptions
    } catch (error) {
      invalidSubscriptions.push(sub); // Mark invalid subscriptions for removal
    }
  });

  // Remove invalid subscriptions from Firestore
  for (const sub of invalidSubscriptions) {
    try {
      const querySnapshot = await subscriptionsCollection
        .where("endpoint", "==", sub.endpoint)
        .get();
      querySnapshot.forEach(async (doc) => {
        await doc.ref.delete();
      });
      console.log("Removed invalid subscription:", sub.endpoint);
    } catch (error) {
      console.error("Error removing invalid subscription:", error);
    }
  }

  // Update the in-memory array
  subscribers = validSubscriptions;
  console.log("Subscriptions cleaned up. Current subscribers:", subscribers.length);
};

// Clean up subscriptions every hour
setInterval(cleanupSubscriptions, 60 * 60 * 1000);

// Start the server
app.listen(process.env.PORT, () =>
  console.log(`🚀 Server running on port ${process.env.PORT}`)
);
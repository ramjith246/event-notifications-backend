require("dotenv").config();
const express = require("express");
const cors = require("cors");
const webpush = require("web-push");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const cron = require("node-cron"); // For scheduling tasks
const readline = require("readline"); // For reading user input


admin.initializeApp({
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
      
    }),
  });

const app = express();
app.use(express.json());
app.use(cors());

// Initialize Firebase Admin
const serviceAccount = require(process.env.FIREBASE_CREDENTIALS);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = getFirestore();

// VAPID Keys
webpush.setVapidDetails(
  "mailto:your-email@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Store subscribers
let subscribers = [];

// Function to check for duplicate subscriptions
const isDuplicateSubscription = (subscription) => {
  return subscribers.some((sub) => sub.endpoint === subscription.endpoint);
};

// Function to clean up invalid subscriptions
const cleanupSubscriptions = () => {
  subscribers = subscribers.filter((sub) => {
    try {
      new URL(sub.endpoint); // Check if the endpoint is a valid URL
      return true; // Keep valid subscriptions
    } catch (error) {
      return false; // Remove invalid subscriptions
    }
  });
  console.log("Subscriptions cleaned up. Current subscribers:", subscribers.length);
};

// API to store push subscription
app.post("/subscribe", (req, res) => {
  const subscription = req.body;

  // Check for duplicates before adding
  if (!isDuplicateSubscription(subscription)) {
    subscribers.push(subscription);
   // console.log("New subscription added:", subscription.endpoint);
  } else {
    //console.log("Subscription already exists:", subscription.endpoint);
  }

  res.status(201).json({ message: "Subscribed successfully!" });
});

// Function to send a push notification
const sendPushNotification = async (title, message) => {
  const payload = JSON.stringify({ title, message });

  console.log("Sending notification to subscribers:", subscribers.length);

  // Use a Set to track sent notifications
  const sentSubscriptions = new Set();

  subscribers.forEach((subscription) => {
    if (!sentSubscriptions.has(subscription.endpoint)) {
      webpush
        .sendNotification(subscription, payload)
        .then(() => {
          console.log("Notification sent successfully to:", subscription.endpoint);
          sentSubscriptions.add(subscription.endpoint); // Mark as sent
        })
        .catch((error) => {
          console.error("Error sending notification:", error);
          // Remove invalid subscriptions
          subscribers = subscribers.filter((sub) => sub.endpoint !== subscription.endpoint);
        });
    }
  });
};

// Function to check and send notifications for upcoming events
const checkAndSendNotifications = async () => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // Today's date at 00:00:00

  console.log(`📅 Checking events for: ${today.toDateString()}`);

  const eventsSnapshot = await db.collection("events").get();

  eventsSnapshot.forEach((doc) => {
    const event = doc.data();

    // Log the event being checked
    console.log(`🔍 Checking event: "${event.name}"`);

    // Check if event.time exists and is a string
    if (!event.time || typeof event.time !== "string") {
      console.log(`⏩ Skipping event "${event.name}" (time not available or invalid)`);
      return; // Skip this event
    }

    // Log the time of the event
    console.log(`🕒 Event time: ${event.time}`);

    // Extract stored date and time
    const eventDate = new Date(event.date); // Date (YYYY-MM-DD)
    const [hours, minutes] = event.time.split(":").map(Number); // Time (HH:MM)

    // Skip the event if the time is invalid (e.g., NaN after splitting)
    if (isNaN(hours) || isNaN(minutes)) {
      console.log(`⏩ Skipping event "${event.name}" (invalid time format)`);
      return; // Skip this event
    }

    // Set event time on the date
    eventDate.setHours(hours, minutes, 0, 0);

    // Check if the event is happening today
    if (
      eventDate.getFullYear() === today.getFullYear() &&
      eventDate.getMonth() === today.getMonth() &&
      eventDate.getDate() === today.getDate()
    ) {
      console.log(`📅 Event scheduled at: ${eventDate}`);

      // Send notification for events happening today
      console.log(`📢 Sending notification for event: ${event.name}`);
      sendPushNotification(
        "Upcoming Event",
        `Reminder: ${event.name} is today at ${event.time}!`
      );
    }
  });
};

// Schedule the notification checker to run daily at 9:00 AM and 4:30 PM
cron.schedule("0 9 * * *", () => {
  console.log("⏰ Running notification checker at 9:00 AM");
  checkAndSendNotifications();
});

cron.schedule("30 16 * * *", () => {
  console.log("⏰ Running notification checker at 4:30 PM");
  checkAndSendNotifications();
});

// API to send custom notifications manually
app.post("/send-notification", (req, res) => {
  const { title, message } = req.body;

  console.log(`📢 Sending manual notification: ${title} - ${message}`);
  console.log(`Number of subscribers: ${subscribers.length}`);

  sendPushNotification(title, message);

  res.status(200).json({ message: "Notification sent successfully!" });
});

// Start the server
const server = app.listen(process.env.PORT, () =>
  console.log(`🚀 Server running on port ${process.env.PORT}`)
);

// Clean up subscriptions every hour
setInterval(cleanupSubscriptions, 60 * 60 * 1000);

// Listen for user input to send a test notification
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});



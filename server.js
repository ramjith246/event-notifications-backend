require("dotenv").config();
const express = require("express");
const cors = require("cors");
const webpush = require("web-push");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const cron = require("node-cron");
const readline = require("readline");

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert({
    type: process.env.FIREBASE_TYPE,
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"), // Replace escaped newlines
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: process.env.FIREBASE_AUTH_URI,
    token_uri: process.env.FIREBASE_TOKEN_URI,
    auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
    universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
  }),
});

const app = express();
app.use(express.json());
app.use(cors());

const db = getFirestore();

// VAPID Keys
webpush.setVapidDetails(
  "mailto:your-email@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Store subscribers with their blood group
let subscribers = [];

// Function to check for duplicate subscriptions
const isDuplicateSubscription = (subscription) => {
  return subscribers.some((sub) => sub.subscription.endpoint === subscription.endpoint);
};

// Function to clean up invalid subscriptions
const cleanupSubscriptions = () => {
  subscribers = subscribers.filter((sub) => {
    try {
      new URL(sub.subscription.endpoint); // Check if the endpoint is a valid URL
      return true; // Keep valid subscriptions
    } catch (error) {
      return false; // Remove invalid subscriptions
    }
  });
  console.log("Subscriptions cleaned up. Current subscribers:", subscribers.length);
};

// API to store push subscription
app.post("/subscribe", (req, res) => {
  const { subscription, bloodGroup } = req.body;

  // Check for duplicates before adding
  if (!isDuplicateSubscription(subscription)) {
    subscribers.push({ subscription, bloodGroup });
    console.log("New subscription added:", subscription.endpoint);
  } else {
    console.log("Subscription already exists:", subscription.endpoint);
  }

  res.status(201).json({ message: "Subscribed successfully!" });
});

// Function to send a push notification to specific blood group
const sendPushNotification = async (title, message, bloodGroup) => {
  const payload = JSON.stringify({ title, message });

  console.log(`Sending notification to subscribers with blood group: ${bloodGroup}`);

  const sentSubscriptions = new Set();

  subscribers.forEach(({ subscription, bloodGroup: group }) => {
    if (group === bloodGroup && !sentSubscriptions.has(subscription.endpoint)) {
      webpush
        .sendNotification(subscription, payload)
        .then(() => {
          console.log("Notification sent successfully to:", subscription.endpoint);
          sentSubscriptions.add(subscription.endpoint); // Mark as sent
        })
        .catch((error) => {
          console.error("Error sending notification:", error);
          // Remove invalid subscriptions
          subscribers = subscribers.filter(sub => sub.subscription.endpoint !== subscription.endpoint);
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
        `Reminder: ${event.name} is today at ${event.time}!`,
        "*" // Send to all subscribers
      );
    }
  });
};

// Listen for new donors and send notifications
const listenForNewDonors = () => {
  const donorsCollection = db.collection("donors");

  donorsCollection.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        const newDonor = change.doc.data();
        console.log(`New donor added: ${newDonor.name}, Blood Group: ${newDonor.bloodGroup}`);

        // Send notification to subscribers with the same blood group
        sendPushNotification(
          "New patient Added",
          `A new patient with blood group ${newDonor.bloodGroup} was added!`,
          newDonor.bloodGroup
        );
      }
    });
  });
};

// Start listening for new donors
listenForNewDonors();

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
  const { title, message, bloodGroup } = req.body;

  console.log(`📢 Sending manual notification: ${title} - ${message}`);
  console.log(`Number of subscribers: ${subscribers.length}`);

  sendPushNotification(title, message, bloodGroup || "*"); // Send to all if bloodGroup is not provided

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

rl.question("Type 'yes' and press Enter to send a test notification: ", (input) => {
  if (input.trim().toLowerCase() === "yes") {
    console.log("📢 Sending test notification...");
    sendPushNotification("Test Notification", "This is a test notification from the server!", "*"); // Send to all
  } else {
    console.log("❌ No notification sent.");
  }
  rl.close();
});
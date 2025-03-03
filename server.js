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
  const { subscription } = req.body;

  if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    console.error("Invalid subscription:", subscription);
    return res.status(400).json({ message: "Invalid subscription: Missing required fields" });
  }

  // Store the subscription
  if (!isDuplicateSubscription(subscription)) {
    subscribers.push(subscription);
    console.log("New subscription added:", subscription.endpoint);
  } else {
    console.log("Subscription already exists:", subscription.endpoint);
  }

  res.status(201).json({ message: "Subscribed successfully!" });
});

// Function to send a push notification to all subscribers
const sendPushNotification = async (title, message, bloodGroup) => {
  const payload = JSON.stringify({ title, message, bloodGroup }); // Ensure bloodGroup is included

  console.log("Sending notification with payload:", payload);

  const sentSubscriptions = new Set();

  subscribers.forEach((subscription) => {
    if (!sentSubscriptions.has(subscription.endpoint)) {
      webpush
        .sendNotification(subscription, payload)
        .then(() => {
          console.log("Notification sent successfully to:", subscription.endpoint);
          sentSubscriptions.add(subscription.endpoint);
        })
        .catch((error) => {
          console.error("Error sending notification:", error);
          subscribers = subscribers.filter((sub) => sub.endpoint !== subscription.endpoint);
        });
    }
  });
};


// Function to check and send notifications for upcoming events
const checkAndSendNotifications = async () => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  console.log(`📅 Checking events for: ${today.toDateString()}`);

  const eventsSnapshot = await db.collection("events").get();

  eventsSnapshot.forEach((doc) => {
    const event = doc.data();

    if (!event.time || typeof event.time !== "string") {
      console.log(`⏩ Skipping event "${event.name}" (time not available or invalid)`);
      return;
    }

    const eventDate = new Date(event.date);
    const [hours, minutes] = event.time.split(":").map(Number);

    if (isNaN(hours) || isNaN(minutes)) {
      console.log(`⏩ Skipping event "${event.name}" (invalid time format)`);
      return;
    }

    eventDate.setHours(hours, minutes, 0, 0);

    if (
      eventDate.getFullYear() === today.getFullYear() &&
      eventDate.getMonth() === today.getMonth() &&
      eventDate.getDate() === today.getDate()
    ) {
      console.log(`📢 Sending notification for event: ${event.name}`);
      sendPushNotification(
        "Upcoming Event",
        `Reminder: ${event.name} is today at ${event.time}!`
      );
    }
  });
};

// Listen for new donors and send notifications to all subscribers
const listenForNewDonors = () => {
  const donorsCollection = db.collection("donors");

  donorsCollection.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        const newDonor = change.doc.data();
        console.log(`New donor added: ${newDonor.name}, Blood Group: ${newDonor.bloodGroup}`);
  
        // Send notification to ALL subscribers with bloodGroup included
        sendPushNotification(
          "New Donor Added",
          `A new donor with blood group ${newDonor.bloodGroup} is available! Contact: ${newDonor.contactName} - ${newDonor.contactNumber}`,
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
  const { title, message } = req.body;

  if (!title || !message) {
    return res.status(400).json({ message: "Title and message are required" });
  }

  console.log(`📢 Sending manual notification: ${title} - ${message}`);
  sendPushNotification(title, message);

  res.status(200).json({ message: "Notification sent successfully!" });
});

// Blood Bank Endpoints
app.get("/bloodbank/donors", async (req, res) => {
  try {
    const donorsSnapshot = await db.collection("donors").get();
    const donors = donorsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(donors);
  } catch (error) {
    console.error("Error fetching donors:", error);
    res.status(500).json({ message: "Failed to fetch donors" });
  }
});

app.post("/bloodbank/donors", async (req, res) => {
  const { name, bloodGroup, contactNumber, contactName, caseType } = req.body;

  if (!name || !bloodGroup || !contactNumber || !contactName || !caseType) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const donorRef = await db.collection("donors").add({
      name,
      bloodGroup,
      contactNumber,
      contactName,
      case: caseType,
    });
    res.status(201).json({ id: donorRef.id, message: "Donor added successfully" });
  } catch (error) {
    console.error("Error adding donor:", error);
    res.status(500).json({ message: "Failed to add donor" });
  }
});

// Start the server
app.listen(process.env.PORT, () =>
  console.log(`🚀 Server running on port ${process.env.PORT}`)
);

// Clean up subscriptions every hour
setInterval(cleanupSubscriptions, 60 * 60 * 1000);

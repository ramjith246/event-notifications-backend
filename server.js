require("dotenv").config();
const express = require("express");
const cors = require("cors");
const webpush = require("web-push");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const cron = require("node-cron");

// Initialize Firebase Admin
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
  const payload = JSON.stringify({ title, message, bloodGroup });

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

// Add a new donor
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

// Fetch donor by phone number
app.get("/bloodbank/donors/:contactNumber", async (req, res) => {
  const { contactNumber } = req.params;

  try {
    const donorsSnapshot = await db.collection("donors").where("contactNumber", "==", contactNumber).get();
    if (donorsSnapshot.empty) {
      return res.status(404).json({ message: "Donor not found" });
    }

    const donor = donorsSnapshot.docs[0].data();
    res.status(200).json({ id: donorsSnapshot.docs[0].id, ...donor });
  } catch (error) {
    console.error("Error fetching donor:", error);
    res.status(500).json({ message: "Failed to fetch donor" });
  }
});

// Update a donor by ID
app.put("/bloodbank/donors/:id", async (req, res) => {
  const { id } = req.params;
  const { name, bloodGroup, contactNumber, contactName, caseType } = req.body;

  if (!name || !bloodGroup || !contactNumber || !contactName || !caseType) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    await db.collection("donors").doc(id).update({
      name,
      bloodGroup,
      contactNumber,
      contactName,
      case: caseType,
    });
    res.status(200).json({ message: "Donor updated successfully" });
  } catch (error) {
    console.error("Error updating donor:", error);
    res.status(500).json({ message: "Failed to update donor" });
  }
});

// Delete a donor by ID
app.delete("/bloodbank/donors/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await db.collection("donors").doc(id).delete();
    res.status(200).json({ message: "Donor deleted successfully" });
  } catch (error) {
    console.error("Error deleting donor:", error);
    res.status(500).json({ message: "Failed to delete donor" });
  }
});

// Events Endpoints

// Add a new event
app.post("/events", async (req, res) => {
  const { name, imageUrl, description, registerLink, date, time, club, status } = req.body;

  if (!name || !imageUrl || !description || !registerLink || !date || !time || !club) {
    return res.status(400).json({ message: "All fields are required except status" });
  }

  try {
    const eventRef = await db.collection("events").add({
      name,
      imageUrl,
      description,
      registerLink,
      date,
      time,
      club,
      status: status || "active", // Default to "active" if not provided
    });
    res.status(201).json({ id: eventRef.id, message: "Event added successfully" });
  } catch (error) {
    console.error("Error adding event:", error);
    res.status(500).json({ message: "Failed to add event" });
  }
});

// Fetch event by ID
// Fetch event by name
app.get("/events/search/:name", async (req, res) => {
  const { name } = req.params;

  try {
    const eventsSnapshot = await db.collection("events").where("name", "==", name).get();
    if (eventsSnapshot.empty) {
      return res.status(404).json({ message: "Event not found" });
    }

    const events = [];
    eventsSnapshot.forEach((doc) => {
      events.push({ id: doc.id, ...doc.data() });
    });

    res.status(200).json(events);
  } catch (error) {
    console.error("Error fetching event by name:", error);
    res.status(500).json({ message: "Failed to fetch event" });
  }
});

// Update an event by ID
app.put("/events/:id", async (req, res) => {
  const { id } = req.params;
  const { name, imageUrl, description, registerLink, date, time, club, status } = req.body;

  if (!name || !imageUrl || !description || !registerLink || !date || !time || !club) {
    return res.status(400).json({ message: "All fields are required except status" });
  }

  try {
    await db.collection("events").doc(id).update({
      name,
      imageUrl,
      description,
      registerLink,
      date,
      time,
      club,
      status: status || "active", // Default to "active" if not provided
    });
    res.status(200).json({ message: "Event updated successfully" });
  } catch (error) {
    console.error("Error updating event:", error);
    res.status(500).json({ message: "Failed to update event" });
  }
});

// Delete an event by ID
app.delete("/events/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await db.collection("events").doc(id).delete();
    res.status(200).json({ message: "Event deleted successfully" });
  } catch (error) {
    console.error("Error deleting event:", error);
    res.status(500).json({ message: "Failed to delete event" });
  }
});

// Cron job to delete past events every day at 1 AM
cron.schedule("0 1 * * *", async () => {
  console.log("⏰ Running event cleanup at 1 AM");

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  try {
    const eventsSnapshot = await db.collection("events").get();
    eventsSnapshot.forEach(async (doc) => {
      const event = doc.data();
      const eventDate = new Date(event.date);

      if (eventDate < today) {
        console.log(`🗑️ Deleting past event: ${event.name} (${event.date})`);
        await db.collection("events").doc(doc.id).delete();
      }
    });
  } catch (error) {
    console.error("Error deleting past events:", error);
  }
});

// Start the server
app.listen(process.env.PORT, () =>
  console.log(`🚀 Server running on port ${process.env.PORT}`)
);

// Clean up subscriptions every hour
setInterval(cleanupSubscriptions, 60 * 60 * 1000);
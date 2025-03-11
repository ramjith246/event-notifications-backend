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
  "db1" // Name for the first database
);

const app2 = admin.initializeApp(
  {
    credential: admin.credential.cert({
      type: process.env.FIREBASE_TYPE_2, // Use separate environment variables for the second database
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
  "db2" // Name for the second database
);

const db1 = getFirestore(app1);
const db2 = getFirestore(app2);

// Firestore collection for subscriptions
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

// Function to check for duplicate subscriptions
const isDuplicateSubscription = (subscription) => {
  return subscribers.some((sub) => sub.endpoint === subscription.endpoint);
};

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

// Function to send ad notifications
const sendAdNotification = async (title, body, link) => {
  const payload = JSON.stringify({ title, body, link, type: "ad" }); // Include a type to differentiate ad notifications

  console.log("Sending ad notification with payload:", payload);

  const sentSubscriptions = new Set();

  subscribers.forEach((subscription) => {
    if (!sentSubscriptions.has(subscription.endpoint)) {
      webpush
        .sendNotification(subscription, payload)
        .then(() => {
          console.log("Ad notification sent successfully to:", subscription.endpoint);
          sentSubscriptions.add(subscription.endpoint);
        })
        .catch((error) => {
          console.error("Error sending ad notification:", error);
          subscribers = subscribers.filter((sub) => sub.endpoint !== subscription.endpoint);
        });
    }
  });
};

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

  // Check events in both databases
  const [snapshot1, snapshot2] = await Promise.all([
    db1.collection("events").get(),
    db2.collection("events").get(),
  ]);

  // Array to store event names happening today
  const eventsToday = [];

  const processEvents = (eventsSnapshot) => {
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
        // Add event name to the array
        eventsToday.push(event.name);
      }
    });
  };

  processEvents(snapshot1);
  processEvents(snapshot2);

  // If there are events today, send a single notification
  if (eventsToday.length > 0) {
    const eventList = eventsToday.join(", "); // Join event names into a single string
    const notificationMessage = `You have ${eventsToday.length} event(s) today: ${eventList}`;

    console.log(`📢 Sending notification for events: ${eventList}`);
    sendPushNotification(
      "Upcoming Events",
      notificationMessage
    );
  } else {
    console.log("No events today.");
  }
};

// Listen for new donors and send notifications to all subscribers
const listenForNewDonors = () => {
  const donorsCollection1 = db1.collection("donors");
  const donorsCollection2 = db2.collection("donors");

  const processDonorChanges = (donorsCollection) => {
    donorsCollection.onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          const newDonor = change.doc.data();
          console.log(`New donor added: ${newDonor.name}, Blood Group: ${newDonor.bloodGroup}`);

          // Send notification to ALL subscribers with bloodGroup included
          sendPushNotification(
            "Blood required",
            `A donor with blood group ${newDonor.bloodGroup} is required! Contact: ${newDonor.contactName} - ${newDonor.contactNumber}`,
            newDonor.bloodGroup
          );
        }
      });
    });
  };

  processDonorChanges(donorsCollection1);
  processDonorChanges(donorsCollection2);
};

// Start listening for new donors
listenForNewDonors();

// Schedule the notification checker to run daily at 3:30 AM and 10:30 AM
cron.schedule("30 3 * * *", () => {
  console.log("⏰ Running notification checker at 3:30 AM");
  checkAndSendNotifications();
});

cron.schedule("30 10 * * *", () => {
  console.log("⏰ Running notification checker at 10:30 AM");
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

app.post("/send-ad", (req, res) => {
  const { title, body, link } = req.body;

  if (!title || !body || !link) {
    return res.status(400).json({ message: "Title, body, and link are required" });
  }

  console.log(`📢 Sending ad notification: ${title} - ${body} - ${link}`);
  sendAdNotification(title, body, link); // Use the new function for ad notifications

  res.status(200).json({ message: "Ad notification sent successfully!" });
});

// Add a new donor
app.post("/bloodbank/donors", async (req, res) => {
  const { name, bloodGroup, contactNumber, contactName, caseType, db } = req.body;

  if (!name || !bloodGroup || !contactNumber || !contactName || !caseType || !db) {
    return res.status(400).json({ message: "All fields are required" });
  }

  const dbRef = db === "db1" ? db1 : db2;

  try {
    const donorRef = await dbRef.collection("donors").add({
      name,
      bloodGroup,
      contactNumber,
      contactName,
      case: caseType,
    });
    res.status(201).json({ id: donorRef.id, message: "patient" });
  } catch (error) {
    console.error("Error adding donor:", error);
    res.status(500).json({ message: "Failed to add donor" });
  }
});

// Fetch donor by phone number (search both databases)
app.get("/bloodbank/donors/:contactNumber", async (req, res) => {
  const { contactNumber } = req.params;

  try {
    const [snapshot1, snapshot2] = await Promise.all([
      db1.collection("donors").where("contactNumber", "==", contactNumber).get(),
      db2.collection("donors").where("contactNumber", "==", contactNumber).get(),
    ]);

    const donors = [];
    snapshot1.forEach((doc) => donors.push({ id: doc.id, ...doc.data(), db: "db1" }));
    snapshot2.forEach((doc) => donors.push({ id: doc.id, ...doc.data(), db: "db2" }));

    if (donors.length === 0) {
      return res.status(404).json({ message: "Donor not found" });
    }

    res.status(200).json(donors);
  } catch (error) {
    console.error("Error fetching donor:", error);
    res.status(500).json({ message: "Failed to fetch donor" });
  }
});

// Update a donor by ID (specify database)
app.put("/bloodbank/donors/:id", async (req, res) => {
  const { id } = req.params;
  const { name, bloodGroup, contactNumber, contactName, caseType, db } = req.body;

  if (!name || !bloodGroup || !contactNumber || !contactName || !caseType || !db) {
    return res.status(400).json({ message: "All fields are required" });
  }

  const dbRef = db === "db1" ? db1 : db2;

  try {
    await dbRef.collection("donors").doc(id).update({
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

// Delete a donor by ID (specify database)
app.delete("/bloodbank/donors/:id", async (req, res) => {
  const { id } = req.params;
  const { db } = req.body;

  if (!db) {
    return res.status(400).json({ message: "Database identifier is required" });
  }

  const dbRef = db === "db1" ? db1 : db2;

  try {
    await dbRef.collection("donors").doc(id).delete();
    res.status(200).json({ message: "Donor deleted successfully" });
  } catch (error) {
    console.error("Error deleting donor:", error);
    res.status(500).json({ message: "Failed to delete donor" });
  }
});

// Events Endpoints

// Add a new event (specify database)
app.post("/events", async (req, res) => {
  const { name, imageUrl, description, registerLink, date, time, club, status, db } = req.body;

  if (!name || !imageUrl || !description || !registerLink || !date || !time || !club || !db) {
    return res.status(400).json({ message: "All fields are required except status" });
  }

  const dbRef = db === "db1" ? db1 : db2;

  try {
    const eventRef = await dbRef.collection("events").add({
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

// Fetch event by name (search both databases)
app.get("/events/search/:name", async (req, res) => {
  const { name } = req.params;

  try {
    const [snapshot1, snapshot2] = await Promise.all([
      db1.collection("events").where("name", "==", name).get(),
      db2.collection("events").where("name", "==", name).get(),
    ]);

    const events = [];
    snapshot1.forEach((doc) => events.push({ id: doc.id, ...doc.data(), db: "db1" }));
    snapshot2.forEach((doc) => events.push({ id: doc.id, ...doc.data(), db: "db2" }));

    if (events.length === 0) {
      return res.status(404).json({ message: "Event not found" });
    }

    res.status(200).json(events);
  } catch (error) {
    console.error("Error fetching event by name:", error);
    res.status(500).json({ message: "Failed to fetch event" });
  }
});

// Update an event by ID (specify database)
app.put("/events/:id", async (req, res) => {
  const { id } = req.params;
  const { name, imageUrl, description, registerLink, date, time, club, status, db } = req.body;

  if (!name || !imageUrl || !description || !registerLink || !date || !time || !club || !db) {
    return res.status(400).json({ message: "All fields are required except status" });
  }

  const dbRef = db === "db1" ? db1 : db2;

  try {
    await dbRef.collection("events").doc(id).update({
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

// Delete an event by ID (specify database)
app.delete("/events/:id", async (req, res) => {
  const { id } = req.params;
  const { db } = req.body;

  if (!db) {
    return res.status(400).json({ message: "Database identifier is required" });
  }

  const dbRef = db === "db1" ? db1 : db2;

  try {
    await dbRef.collection("events").doc(id).delete();
    res.status(200).json({ message: "Event deleted successfully" });
  } catch (error) {
    console.error("Error deleting event:", error);
    res.status(500).json({ message: "Failed to delete event" });
  }
});

// Cron job to delete past events every day at 7:30 PM (both databases)
cron.schedule("30 19 * * *", async () => {
  console.log("⏰ Running event cleanup at 7:30 PM");

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const deletePastEvents = async (dbRef) => {
    try {
      const eventsSnapshot = await dbRef.collection("events").get();
      eventsSnapshot.forEach(async (doc) => {
        const event = doc.data();
        const eventDate = new Date(event.date);

        if (eventDate < today) {
          console.log(`🗑️ Deleting past event: ${event.name} (${event.date})`);
          await dbRef.collection("events").doc(doc.id).delete();
        }
      });
    } catch (error) {
      console.error("Error deleting past events:", error);
    }
  };

  await deletePastEvents(db1);
  await deletePastEvents(db2);
});

// Start the server
app.listen(process.env.PORT, () =>
  console.log(`🚀 Server running on port ${process.env.PORT}`)
);

// Clean up subscriptions every hour
setInterval(cleanupSubscriptions, 60 * 60 * 1000);
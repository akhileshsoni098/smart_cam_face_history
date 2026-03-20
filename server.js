

// server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const socketIo = require("socket.io");
const moment = require("moment-timezone");

// Models (assumes ./model/User and ./model/Attendance exist)
const User = require("./model/User");
const Attendance = require("./model/Attendance");

// Config / thresholds (tweak via .env if needed)
const PORT = process.env.PORT || 3000;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/face_attendance";
const TZ = process.env.TZ || "Asia/Kolkata";
// distance thresholds (euclidean on 128-d descriptors)
const STRICT_MATCH = parseFloat(process.env.STRICT_MATCH) || 0.44; // confident
const RELAXED_MATCH = parseFloat(process.env.RELAXED_MATCH) || 0.55; // relaxed
const BORDERLINE_MARGIN = parseFloat(process.env.BORDERLINE_MARGIN) || 0.06; // tolerance

// C:\Users\akhil\OneDrive\Desktop\Seceret\smartCamera2\public\models
// App + server
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// Connect to MongoDB
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// -------------------- Helper functions --------------------
function euclidean(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function confidenceFromDistance(dist) {
  // a simple mapping: smaller dist => higher confidence (clamped 0..1)
  if (!isFinite(dist)) return 0;
  const conf = 1 - dist; // basic
  return Math.max(0, Math.min(1, conf));
}

async function findBestMatch(descriptorArray) {
  // descriptorArray is a plain JS array (length 128) coming from client
  // returns { user, distance } or { user: null, distance: Infinity }
  const users = await User.find({}, { descriptors: 1, name: 1 }).lean().exec();
  if (!users || users.length === 0) return { user: null, distance: Infinity };

  let best = { user: null, distance: Infinity };
  for (const user of users) {
    const descriptors = user.descriptors || [];
    for (const d of descriptors) {
      const dist = euclidean(d, descriptorArray);
      if (dist < best.distance) {
        best = { user, distance: dist };
      }
    }
  }
  return best;
}

// -------------------- Socket handlers --------------------
io.on("connection", (socket) => {
  console.log("client connected", socket.id);

  // 1) Verify face descriptor against DB (no attendance write)
  // client should send: { descriptor: [number,...] }
  socket.on("face:verify", async (data = {}, ack) => {
    try {
      const descriptor = Array.isArray(data.descriptor)
        ? data.descriptor
        : null;
      if (!descriptor)
        return ack && ack({ ok: false, error: "descriptor required" });

      const { user, distance } = await findBestMatch(descriptor);
      const confidence = confidenceFromDistance(distance);

      if (user && distance <= STRICT_MATCH) {
        return (
          ack && ack({ ok: true, match: true, user, distance, confidence })
        );
      }

      // borderline: between STRICT_MATCH and RELAXED_MATCH (+ margin)
      if (
        user &&
        distance > STRICT_MATCH &&
        distance <= RELAXED_MATCH + BORDERLINE_MARGIN
      ) {
        return (
          ack &&
          ack({
            ok: true,
            match: false,
            borderline: true,
            distance,
            confidence,
            user: { _id: user._id, name: user.name },
          })
        );
      }

      // no match
      return ack && ack({ ok: true, match: false, distance, confidence });
    } catch (err) {
      console.error("face:verify error", err);
      if (typeof ack === "function")
        ack({ ok: false, error: err.message || "Server error" });
    }
  });

  // 2) Mark attendance: client may send either userId OR descriptors (to match server-side)
  // payload examples:
  // { userId: "...", confidence: 0.9 }
  // { descriptor: [...], name: "Optional name if new user" }

  socket.on("attendance:mark", async (data = {}, ack) => {
    try {
      let { userId, name, descriptors, confidence } = data;

      let user = null;
      let userCreated = false;

      // If a descriptor array is provided and no userId, try to match
      if (!userId && Array.isArray(descriptors) && descriptors.length > 0) {
        const best = await findBestMatch(descriptors[0] || descriptors); // either array or array of arrays
        if (best.user && best.distance <= STRICT_MATCH) {
          userId = best.user._id;
          confidence = confidenceFromDistance(best.distance);
        } else {
          // no confident match -> let flow create a new user (below) if client didn't send userId
        }
      }

      // If userId was given or found by matching, fetch user
      if (userId) {
        user = await User.findById(userId).exec();
      }

      // if user not found but name provided, try lookup by name
      if ((!user || !user._id) && name) {
        user = await User.findOne({ name }).exec();
      }

      // If still no user -> create user (optionally save descriptors if provided)
      if (!user || !user._id) {
        const userDoc = new User({
          name: name || `user_${Date.now()}`,
          descriptors: [],
        });
        // if descriptors present and it's an array-of-arrays, flatten first entry
        if (Array.isArray(descriptors) && descriptors.length > 0) {
          // accept either single descriptor array or array of arrays
          const first = Array.isArray(descriptors[0])
            ? descriptors[0]
            : descriptors;
          if (first && first.length === 128) userDoc.descriptors.push(first);
        }
        user = await userDoc.save();
        userCreated = true;
      }

      // Attendance duplicate protection: don't create new attendance within window
      const uid = user._id;
      const now = new Date();
      const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

      const lastAtt = await Attendance.findOne({ user: uid })
        .sort({ timestamp: -1 })
        .exec();
      if (lastAtt && now - new Date(lastAtt.timestamp) < THREE_HOURS_MS) {
        const msg = "Last attendance within 3 hours — skipping new mark";
        console.log(msg, "user:", uid);
        if (typeof ack === "function") {
          ack({
            ok: true,
            userCreated,
            action: "skipped",
            message: msg,
            attendance: lastAtt,
            user,
          });
        } 
        return;
      } 

      const dateStr = moment().tz(TZ).format("YYYY-MM-DD");

      const newAttendance = new Attendance({
        user: uid,
        timestamp: now,
        date: dateStr,
        confidence: typeof confidence !== "undefined" ? confidence : null,
        source: "webcam",
      });

      const saved = await newAttendance.save();
      const populated = await Attendance.findById(saved._id)
        .populate("user")
        .exec();

      io.emit("attendance:new", {
        attendance: populated,
        action: "created",
        userCreated,
      });

      if (typeof ack === "function") {
        ack({
          ok: true,
          userCreated,
          action: "created",
          attendance: populated,
          user,
        });
      }

      console.log(
        `Attendance created for user ${uid} (userCreated=${userCreated})`
      );
    } catch (err) {
      console.error("Error in attendance:mark handler", err);
      if (typeof ack === "function")
        ack({ ok: false, error: err.message || "Server error" });
      socket.emit("attendance:error", {
        message: "Server error saving attendance",
      });
    }
  });

  // 3) Append descriptor to existing user (adaptation / learning)
  // payload: { userId: '...', descriptor: [...] }
  socket.on("user:appendDescriptor", async (data = {}, ack) => {
    try {
      const { userId, descriptor } = data;
      if (!userId || !Array.isArray(descriptor) || descriptor.length === 0) {
        return ack && ack({ ok: false, error: "userId + descriptor required" });
      }
      const user = await User.findByIdAndUpdate(
        userId,
        { $push: { descriptors: descriptor } },
        { new: true }
      ).exec();
      if (!user) return ack && ack({ ok: false, error: "User not found" });
      return ack && ack({ ok: true, user });
    } catch (err) {
      console.error("user:appendDescriptor error", err);
      if (typeof ack === "function")
        ack({ ok: false, error: err.message || "Server error" });
    }
  });

  // optional: list users (socket request) - useful for admin panels
  // emit: socket.emit('users:list') -> server will reply via ack
  socket.on("users:list", async (data = {}, ack) => {
    try {
      const users = await User.find({}, { name: 1, descriptors: 1 })
        .lean()
        .exec();
      if (typeof ack === "function") ack({ ok: true, users });
    } catch (err) {
      console.error("users:list error", err);
      if (typeof ack === "function")
        ack({ ok: false, error: err.message || "Server error" });
    }
  });

  socket.on("disconnect", () => {
    console.log("client disconnected", socket.id);
  });
});

// start server
server.listen(PORT, () => console.log("Server running on", PORT));

// Export for testing (optional)
module.exports = { app, server, io };

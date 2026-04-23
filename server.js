require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");
const {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
} = require("livekit-server-sdk");

const User = require("./User");
const Message = require("./Message");
const MeetingHistory = require("./MeetingHistory");
const Caption = require("./Caption");
const Summary = require("./Summary");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const roomHosts = {};
const roomHostUserIds = {};
const roomParticipants = {};
const roomLimits = {};
const roomRecordingState = {};
const roomTitles = {};
const roomTypes = {};
const roomPasswords = {};
const blockedUsers = {};
const raisedHands = {};

app.set("trust proxy", true);

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("recordings")) fs.mkdirSync("recordings");

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});

const upload = multer({ storage });

app.use(express.json());
app.use(cors());
app.use("/uploads", express.static("uploads"));
app.use("/recordings", express.static("recordings"));

mongoose.set("bufferCommands", false);

mongoose
  .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 })
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log("MongoDB Error:", err));

const egressClient = new EgressClient(
  process.env.LIVEKIT_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

function cleanUserId(raw = "") {
  return String(raw).split("@")[0].split("__")[0];
}

function uniqueLines(lines) {
  return [...new Set(lines.map((x) => x.trim()).filter(Boolean))];
}

function buildSummaryFromCaptions(captions) {
  const finalCaptions = captions.filter((c) => c.isFinal !== false && c.text?.trim());
  const texts = finalCaptions.map((c) => c.text.trim());
  const uniqueTexts = uniqueLines(texts);

  const summaryText =
    uniqueTexts.length > 0
      ? uniqueTexts.slice(0, 8).join(". ") + "."
      : "No meaningful captions found for summary.";

  const actionKeywords = ["do", "send", "complete", "submit", "finish", "update", "call", "share", "create", "check"];
  const actionItems = uniqueLines(
    uniqueTexts.filter((line) =>
      actionKeywords.some((k) => line.toLowerCase().includes(k))
    )
  ).slice(0, 6);

  const keyPoints = uniqueTexts.slice(0, 6);

  return {
    summaryText,
    keyPoints,
    actionItems,
  };
}

async function ensureMeetingHistory(roomId, title, meetingType, hostUserId) {
  let doc = await MeetingHistory.findOne({ roomId });
  if (!doc) {
    doc = await MeetingHistory.create({
      roomId,
      title: title || "Meeting",
      meetingType: meetingType || "public",
      hostUserId,
      startedAt: new Date(),
      participants: [hostUserId],
      attendance: [
        {
          userId: hostUserId,
          joinedAt: new Date(),
          leftAt: null,
        },
      ],
    });
  }
  return doc;
}

async function addAttendance(roomId, userId) {
  const doc = await MeetingHistory.findOne({ roomId });
  if (!doc) return;

  const existsOpen = doc.attendance.some(
    (a) => cleanUserId(a.userId) === cleanUserId(userId) && !a.leftAt
  );

  if (!existsOpen) {
    doc.attendance.push({
      userId,
      joinedAt: new Date(),
      leftAt: null,
    });
  }

  if (!doc.participants.some((p) => cleanUserId(p) === cleanUserId(userId))) {
    doc.participants.push(userId);
  }

  await doc.save();
}

async function markAttendanceLeft(roomId, userId) {
  const doc = await MeetingHistory.findOne({ roomId });
  if (!doc) return;

  for (let i = doc.attendance.length - 1; i >= 0; i--) {
    const item = doc.attendance[i];
    if (cleanUserId(item.userId) === cleanUserId(userId) && !item.leftAt) {
      item.leftAt = new Date();
      break;
    }
  }

  await doc.save();
}

async function closeMeeting(roomId) {
  const doc = await MeetingHistory.findOne({ roomId });
  if (!doc || doc.endedAt) return;

  const now = new Date();
  doc.endedAt = now;
  doc.durationSeconds = Math.max(
    0,
    Math.floor((now.getTime() - new Date(doc.startedAt).getTime()) / 1000)
  );

  doc.attendance.forEach((a) => {
    if (!a.leftAt) a.leftAt = now;
  });

  await doc.save();
}

app.get("/", (req, res) => {
  res.send("Server Running");
});

/* ---------------- AUTH ROUTES ---------------- */

app.post("/signup", async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const password = (req.body.password || "").trim();

    if (!email || !password) {
      return res.status(400).json({ message: "Email and Password required" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.json({ message: "User already exists" });
    }

    const newUser = new User({ email, password });
    await newUser.save();

    res.json({ message: "User created successfully" });
  } catch (error) {
    console.log("Signup error:", error);
    res.status(500).json({ message: error.message || "Error creating user" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const password = (req.body.password || "").trim();

    if (!email || !password) {
      return res.status(400).json({ message: "Email and Password required" });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.json({ message: "Invalid credentials" });
    }

    if (user.password !== password) {
      return res.json({ message: "Invalid credentials" });
    }

    return res.json({ message: "Login success" });
  } catch (error) {
    console.log("Login error:", error);
    res.status(500).json({ message: error.message || "Error logging in" });
  }
});

/* ---------------- CHAT ROUTES ---------------- */

app.post("/sendMessage", async (req, res) => {
  try {
    const { email, sender, message, audioUrl, type } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const newMessage = new Message({
      email,
      sender,
      message,
      audioUrl,
      type,
      time: new Date(),
    });

    await newMessage.save();
    res.json({ message: "Message sent" });
  } catch (error) {
    console.log("Send message error:", error);
    res.status(500).json({ message: error.message || "Error sending message" });
  }
});

app.get("/messages", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const messages = await Message.find({ email }).sort({ time: 1 });
    res.json(messages);
  } catch (error) {
    console.log("Get messages error:", error);
    res.status(500).json({ message: error.message || "Error fetching messages" });
  }
});

/* ---------------- LIVEKIT ---------------- */

app.get("/livekit-token", async (req, res) => {
  try {
    const { room, identity } = req.query;

    if (!room || !identity) {
      return res.status(400).json({ message: "room and identity are required" });
    }

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity: `${identity}@convo` }
    );

    at.addGrant({
      roomJoin: true,
      room: room.toString(),
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    res.json({
      token,
      url: process.env.LIVEKIT_URL,
    });
  } catch (error) {
    console.log("LiveKit token error:", error);
    res.status(500).json({ message: error.message || "Failed to generate token" });
  }
});

/* ---------------- CAPTIONS ---------------- */

app.post("/captions", async (req, res) => {
  try {
    const { roomId, speaker, text, isFinal, language } = req.body;

    if (!roomId || !speaker || !text) {
      return res.status(400).json({ message: "roomId, speaker and text are required" });
    }

    const caption = await Caption.create({
      roomId,
      speaker,
      text,
      isFinal: isFinal !== false,
      language: language || "en",
    });

    io.to(roomId).emit("caption-added", {
      roomId: caption.roomId,
      speaker: caption.speaker,
      text: caption.text,
      isFinal: caption.isFinal,
      language: caption.language,
      createdAt: caption.createdAt,
    });

    res.json({ message: "Caption saved" });
  } catch (error) {
    console.log("Caption save error:", error);
    res.status(500).json({ message: error.message || "Failed to save caption" });
  }
});

app.get("/captions", async (req, res) => {
  try {
    const { roomId } = req.query;
    if (!roomId) {
      return res.status(400).json({ message: "roomId is required" });
    }

    const captions = await Caption.find({ roomId }).sort({ createdAt: 1 }).lean();
    res.json(captions);
  } catch (error) {
    console.log("Caption fetch error:", error);
    res.status(500).json({ message: error.message || "Failed to fetch captions" });
  }
});

/* ---------------- SUMMARY ---------------- */

app.post("/summary/generate", async (req, res) => {
  try {
    const { roomId, title } = req.body;
    if (!roomId) {
      return res.status(400).json({ message: "roomId is required" });
    }

    const captions = await Caption.find({ roomId }).sort({ createdAt: 1 }).lean();
    const generated = buildSummaryFromCaptions(captions);

    const saved = await Summary.findOneAndUpdate(
      { roomId },
      {
        roomId,
        title: title || "Meeting Summary",
        summaryText: generated.summaryText,
        keyPoints: generated.keyPoints,
        actionItems: generated.actionItems,
        generatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    res.json(saved);
  } catch (error) {
    console.log("Summary generate error:", error);
    res.status(500).json({ message: error.message || "Failed to generate summary" });
  }
});

app.get("/summary", async (req, res) => {
  try {
    const { roomId } = req.query;
    if (!roomId) {
      return res.status(400).json({ message: "roomId is required" });
    }

    const summary = await Summary.findOne({ roomId }).lean();
    if (!summary) {
      return res.status(404).json({ message: "Summary not found" });
    }

    res.json(summary);
  } catch (error) {
    console.log("Summary fetch error:", error);
    res.status(500).json({ message: error.message || "Failed to fetch summary" });
  }
});

/* ---------------- HISTORY ---------------- */

app.get("/meeting-history", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const regex = new RegExp("^" + email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    const docs = await MeetingHistory.find({
      $or: [
        { hostUserId: regex },
        { participants: { $elemMatch: { $regex: regex } } },
      ],
    })
      .sort({ startedAt: -1 })
      .lean();

    res.json(docs);
  } catch (error) {
    console.log("History error:", error);
    res.status(500).json({ message: error.message || "Failed to fetch history" });
  }
});

/* ---------------- SOCKETS ---------------- */

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("create-room", async ({
    roomId,
    userId,
    maxParticipants,
    meetingTitle,
    meetingType,
    meetingPassword,
  }) => {
    if (!roomId || !userId) return;

    roomHosts[roomId] = socket.id;
    roomHostUserIds[roomId] = userId;
    roomLimits[roomId] = maxParticipants || 10;
    roomRecordingState[roomId] = false;
    roomTitles[roomId] = meetingTitle || "Meeting";
    roomTypes[roomId] = meetingType === "private" ? "private" : "public";
    roomPasswords[roomId] = roomTypes[roomId] === "private" ? (meetingPassword || "") : "";

    if (!roomParticipants[roomId]) roomParticipants[roomId] = {};
    if (!blockedUsers[roomId]) blockedUsers[roomId] = [];
    if (!raisedHands[roomId]) raisedHands[roomId] = {};

    roomParticipants[roomId][userId] = socket.id;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userId = userId;
    socket.data.isHost = true;

    await ensureMeetingHistory(roomId, meetingTitle, meetingType, userId);

    socket.emit("room-created", {
      roomId,
      userId,
      maxParticipants: roomLimits[roomId],
      hostUserId: roomHostUserIds[roomId],
    });

    io.to(roomId).emit("room-info", {
      roomId,
      hostUserId: roomHostUserIds[roomId] || "",
      maxParticipants: roomLimits[roomId] || 10,
      isRecording: roomRecordingState[roomId] || false,
      meetingTitle: roomTitles[roomId] || "Meeting",
      meetingType: roomTypes[roomId] || "public",
      participants: Object.keys(roomParticipants[roomId] || {}),
    });

    io.to(roomId).emit("participants-updated", {
      participants: Object.keys(roomParticipants[roomId]),
      hostUserId: roomHostUserIds[roomId],
    });
  });

  socket.on("get-room-info", ({ roomId }) => {
    if (!roomId) return;

    socket.emit("room-info", {
      roomId,
      hostUserId: roomHostUserIds[roomId] || "",
      maxParticipants: roomLimits[roomId] || 10,
      isRecording: roomRecordingState[roomId] || false,
      meetingTitle: roomTitles[roomId] || "Meeting",
      meetingType: roomTypes[roomId] || "public",
      participants: Object.keys(roomParticipants[roomId] || {}),
    });
  });

  socket.on("join-request", ({ roomId, userId, password }) => {
    if (!roomId || !userId) return;

    socket.data.roomId = roomId;
    socket.data.userId = userId;
    socket.data.isHost = false;

    let hostSocketId = roomHosts[roomId];

    if (!hostSocketId) {
      const room = io.sockets.adapter.rooms.get(roomId);
      if (room && room.size > 0) {
        hostSocketId = [...room][0];
        roomHosts[roomId] = hostSocketId;
      }
    }

    if (!hostSocketId) {
      socket.emit("join-rejected", { message: "Host not available" });
      return;
    }

    const cleanJoiner = cleanUserId(userId);
    const isBlocked = (blockedUsers[roomId] || []).some(
      (u) => cleanUserId(u) === cleanJoiner
    );

    if (isBlocked) {
      socket.emit("join-rejected", { message: "Blocked by host" });
      return;
    }

    if ((roomTypes[roomId] || "public") === "private") {
      if ((password || "") !== (roomPasswords[roomId] || "")) {
        socket.emit("join-rejected", { message: "Wrong password" });
        return;
      }
    }

    const room = io.sockets.adapter.rooms.get(roomId);
    const currentParticipants = room ? room.size : 0;
    const maxParticipants = roomLimits[roomId] || 10;

    if (currentParticipants >= maxParticipants) {
      socket.emit("join-rejected", { message: "Meeting is full" });
      return;
    }

    io.to(hostSocketId).emit("join-request", {
      roomId,
      userId,
      guestSocketId: socket.id,
    });
  });

  socket.on("approve-join", async ({ roomId, guestSocketId, userId }) => {
    if (!roomId || !guestSocketId || !userId) return;

    const room = io.sockets.adapter.rooms.get(roomId);
    const currentParticipants = room ? room.size : 0;
    const maxParticipants = roomLimits[roomId] || 10;

    if (currentParticipants >= maxParticipants) {
      io.to(guestSocketId).emit("join-rejected", { message: "Meeting is full" });
      return;
    }

    const guestSocket = io.sockets.sockets.get(guestSocketId);
    if (!guestSocket) return;

    guestSocket.join(roomId);
    guestSocket.data.roomId = roomId;
    guestSocket.data.userId = userId;
    guestSocket.data.isHost = false;

    if (!roomParticipants[roomId]) roomParticipants[roomId] = {};
    roomParticipants[roomId][userId] = guestSocketId;

    await addAttendance(roomId, userId);

    io.to(guestSocketId).emit("join-approved", {
      roomId,
      userId,
      hostUserId: roomHostUserIds[roomId] || "",
      meetingTitle: roomTitles[roomId] || "Meeting",
      meetingType: roomTypes[roomId] || "public",
    });

    io.to(roomId).emit("room-info", {
      roomId,
      hostUserId: roomHostUserIds[roomId] || "",
      maxParticipants: roomLimits[roomId] || 10,
      isRecording: roomRecordingState[roomId] || false,
      meetingTitle: roomTitles[roomId] || "Meeting",
      meetingType: roomTypes[roomId] || "public",
      participants: Object.keys(roomParticipants[roomId] || {}),
    });

    io.to(roomId).emit("participants-updated", {
      participants: Object.keys(roomParticipants[roomId] || {}),
      hostUserId: roomHostUserIds[roomId],
    });
  });

  socket.on("reject-join", ({ guestSocketId, userId }) => {
    if (!guestSocketId || !userId) return;
    io.to(guestSocketId).emit("join-rejected", {
      message: `${userId} was rejected by host`
    });
  });

  socket.on("mute-user", ({ targetUserId, roomId }) => {
    if (!targetUserId || !roomId) return;

    const participants = roomParticipants[roomId] || {};
    const cleanTarget = cleanUserId(targetUserId);

    for (const [joinedUserId, joinedSocketId] of Object.entries(participants)) {
      if (cleanUserId(joinedUserId) === cleanTarget) {
        io.to(joinedSocketId).emit("force-mute");
        break;
      }
    }
  });

  socket.on("mute-all", ({ roomId }) => {
    if (!roomId) return;

    const participants = roomParticipants[roomId] || {};
    Object.entries(participants).forEach(([joinedUserId, joinedSocketId]) => {
      if (cleanUserId(joinedUserId) !== cleanUserId(roomHostUserIds[roomId] || "")) {
        io.to(joinedSocketId).emit("force-mute");
      }
    });
  });

  socket.on("kick-user", ({ roomId, targetUserId }) => {
    if (!roomId || !targetUserId) return;

    const cleanTarget = cleanUserId(targetUserId);
    const participants = roomParticipants[roomId] || {};

    let foundUserId = "";
    let foundSocketId = "";

    for (const [joinedUserId, joinedSocketId] of Object.entries(participants)) {
      if (cleanUserId(joinedUserId) === cleanTarget) {
        foundUserId = joinedUserId;
        foundSocketId = joinedSocketId;
        break;
      }
    }

    if (!foundUserId || !foundSocketId) return;

    if (!blockedUsers[roomId]) blockedUsers[roomId] = [];
    if (!blockedUsers[roomId].includes(foundUserId)) {
      blockedUsers[roomId].push(foundUserId);
    }

    delete roomParticipants[roomId][foundUserId];

    io.to(foundSocketId).emit("kicked", {
      message: "You were removed by host"
    });

    const kickedSocket = io.sockets.sockets.get(foundSocketId);
    if (kickedSocket) {
      kickedSocket.leave(roomId);
    }

    io.to(roomId).emit("participants-updated", {
      participants: Object.keys(roomParticipants[roomId] || {}),
      hostUserId: roomHostUserIds[roomId]
    });
  });

  socket.on("raise-hand", ({ roomId, userId, raised }) => {
    if (!roomId || !userId) return;

    const clean = cleanUserId(userId);
    if (!raisedHands[roomId]) raisedHands[roomId] = {};
    raisedHands[roomId][clean] = !!raised;

    io.to(roomId).emit("hand-state-updated", {
      userId: clean,
      raised: !!raised
    });
  });

  socket.on("recording-toggle", ({ roomId, recording }) => {
    if (!roomId) return;
    roomRecordingState[roomId] = !!recording;
    io.to(roomId).emit("recording-state", { recording: !!recording });
  });

  socket.on("leave-room", async ({ roomId, userId }) => {
    if (!roomId || !userId) return;

    socket.leave(roomId);

    if (roomParticipants[roomId] && roomParticipants[roomId][userId]) {
      delete roomParticipants[roomId][userId];
    }

    await markAttendanceLeft(roomId, userId);

    io.to(roomId).emit("participants-updated", {
      participants: Object.keys(roomParticipants[roomId] || {}),
      hostUserId: roomHostUserIds[roomId] || "",
    });

    if (socket.data.isHost && roomHosts[roomId] === socket.id) {
      await closeMeeting(roomId);

      delete roomHosts[roomId];
      delete roomHostUserIds[roomId];
      delete roomLimits[roomId];
      delete roomParticipants[roomId];
      delete roomRecordingState[roomId];
      delete roomTitles[roomId];
      delete roomTypes[roomId];
      delete roomPasswords[roomId];
      delete blockedUsers[roomId];
      delete raisedHands[roomId];
    }
  });

  socket.on("disconnect", async () => {
    const roomId = socket.data.roomId;
    const userId = socket.data.userId;

    if (roomId && roomParticipants[roomId] && userId && roomParticipants[roomId][userId]) {
      delete roomParticipants[roomId][userId];
    }

    if (roomId && userId) {
      await markAttendanceLeft(roomId, userId);

      io.to(roomId).emit("participants-updated", {
        participants: Object.keys(roomParticipants[roomId] || {}),
        hostUserId: roomHostUserIds[roomId] || "",
      });
    }

    if (roomId && socket.data.isHost && roomHosts[roomId] === socket.id) {
      await closeMeeting(roomId);

      delete roomHosts[roomId];
      delete roomHostUserIds[roomId];
      delete roomLimits[roomId];
      delete roomParticipants[roomId];
      delete roomRecordingState[roomId];
      delete roomTitles[roomId];
      delete roomTypes[roomId];
      delete roomPasswords[roomId];
      delete blockedUsers[roomId];
      delete raisedHands[roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server started on port ${PORT}`);
});
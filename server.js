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

app.post("/recording/start", async (req, res) => {
  try {
    const { roomId } = req.body;
    if (!roomId) {
      return res.status(400).json({ message: "roomId is required" });
    }

    const doc = await MeetingHistory.findOne({ roomId });
    if (!doc) {
      return res.status(404).json({ message: "Meeting history not found" });
    }

    if (doc.isRecording && doc.recordingEgressId) {
      return res.json({ message: "Recording already running" });
    }

    const safeRoom = roomId.replace(/[^a-zA-Z0-9-_]/g, "_");
    const filepath = `recordings/${safeRoom}-${Date.now()}.mp4`;

    const fileOutput = new EncodedFileOutput({
      filepath,
    });

    const info = await egressClient.startRoomCompositeEgress(
      roomId,
      fileOutput,
      {
        layout: "grid",
      }
    );

    doc.isRecording = true;
    doc.recordingStatus = "recording";
    doc.recordingEgressId = info.egressId || "";
    doc.recordingFilepath = filepath;
    await doc.save();

    roomRecordingState[roomId] = true;
    io.to(roomId).emit("recording-state", { recording: true });

    res.json({
      message: "Recording started",
      egressId: doc.recordingEgressId,
      filepath,
    });
  } catch (error) {
    console.log("Start recording error:", error);
    res.status(500).json({
      message:
        error.message ||
        "Failed to start recording. Check LiveKit Egress setup.",
    });
  }
});

app.post("/recording/stop", async (req, res) => {
  try {
    const { roomId } = req.body;
    if (!roomId) {
      return res.status(400).json({ message: "roomId is required" });
    }

    const doc = await MeetingHistory.findOne({ roomId });
    if (!doc || !doc.recordingEgressId) {
      return res.status(404).json({ message: "No active recording found" });
    }

    await egressClient.stopEgress(doc.recordingEgressId);

    doc.isRecording = false;
    doc.recordingStatus = "stopped";
    await doc.save();

    roomRecordingState[roomId] = false;
    io.to(roomId).emit("recording-state", { recording: false });

    res.json({
      message: "Recording stopped",
      filepath: doc.recordingFilepath,
    });
  } catch (error) {
    console.log("Stop recording error:", error);
    res.status(500).json({
      message:
        error.message ||
        "Failed to stop recording. Check LiveKit Egress setup.",
    });
  }
});

app.post("/uploadAudio", upload.single("audio"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
  } catch (err) {
    console.log("Upload error:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});

app.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body;

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
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and Password required" });
    }

    const user = await User.findOne({ email, password });

    if (user) {
      res.json({ message: "Login success" });
    } else {
      res.json({ message: "Invalid credentials" });
    }
  } catch (error) {
    console.log("Login error:", error);
    res.status(500).json({ message: error.message || "Error logging in" });
  }
});

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

    const hostSocketId = roomHosts[roomId];

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

    io.to(roomId).emit("participants-updated", {
      participants: Object.keys(roomParticipants[roomId] || {}),
      hostUserId: roomHostUserIds[roomId],
    });
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
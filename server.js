require("dotenv").config();

const OpenAI = require("openai");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");
const { AccessToken } = require("livekit-server-sdk");

const User = require("./User");
const Message = require("./Message");
const Caption = require("./Caption");
const MeetingHistory = require("./MeetingHistory");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
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

if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/"),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});

const upload = multer({ storage });

app.use(express.json());
app.use(cors());
app.use("/uploads", express.static("uploads"));

mongoose.set("bufferCommands", false);

mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 30000
})
    .then(() => console.log("MongoDB Connected"))
    .catch(err => console.log("MongoDB Error:", err));

// --- ADDED PER INSTRUCTIONS ---
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});
// ------------------------------

function cleanUserId(raw = "") {
    return String(raw).split("@")[0].split("__")[0];
}

app.get("/", (req, res) => {
    res.send("Server Running");
});

app.get("/join", (req, res) => {
    const room = req.query.room || "";
    const title = req.query.title || "Meeting";

    const deepLink =
        `convo://join?room=${encodeURIComponent(room)}&title=${encodeURIComponent(title)}`;

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Join Convo Meeting</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script>
                setTimeout(function () {
                    window.location.href = "${deepLink}";
                }, 500);
            </script>
        </head>
        <body style="font-family: Arial; text-align: center; padding: 30px;">
            <h2>Opening Convo...</h2>
            <p>If the app does not open automatically, tap below:</p>
            <a href="${deepLink}" style="font-size: 22px;">Join Meeting</a>
        </body>
        </html>
    `);
});

/* AUTH */

app.post("/signup", async (req, res) => {
    try {
        const email = (req.body.email || "").trim();
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
        const email = (req.body.email || "").trim();
        const password = (req.body.password || "").trim();

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

/* CHAT */

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
            time: new Date()
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

/* AUDIO UPLOAD */

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

/* LIVEKIT TOKEN */

app.get("/livekit-token", async (req, res) => {
    try {
        const { room, identity } = req.query;

        if (!room || !identity) {
            return res.status(400).json({ message: "room and identity are required" });
        }

        const at = new AccessToken(
            process.env.LIVEKIT_API_KEY,
            process.env.LIVEKIT_API_SECRET,
            {
                identity: `${identity}@convo`
            }
        );

        at.addGrant({
            roomJoin: true,
            room: room.toString(),
            canPublish: true,
            canSubscribe: true,
            canPublishData: true
        });

        const token = await at.toJwt();

        res.json({
            token,
            url: process.env.LIVEKIT_URL
        });
    } catch (error) {
        console.log("LiveKit token error:", error);
        res.status(500).json({ message: error.message || "Failed to generate token" });
    }
});

/* CAPTIONS */

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
            language: language || "en"
        });

        io.to(roomId).emit("caption-added", {
            roomId: caption.roomId,
            speaker: caption.speaker,
            text: caption.text,
            isFinal: caption.isFinal,
            language: caption.language,
            createdAt: caption.createdAt
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

        const captions = await Caption.find({ roomId }).sort({ createdAt: 1 });
        res.json(captions);
    } catch (error) {
        console.log("Caption fetch error:", error);
        res.status(500).json({ message: error.message || "Failed to fetch captions" });
    }
});

/* MEETING HISTORY */

app.get("/meeting-history", async (req, res) => {
    try {
        const { email } = req.query;

        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }

        const history = await MeetingHistory.find({
            participants: email
        }).sort({ startedAt: -1 });

        res.json(history);
    } catch (error) {
        console.log("Meeting history error:", error);
        res.status(500).json({ message: "Failed to fetch history" });
    }
});

/* TRANSCRIBE ROUTE - ADDED PER INSTRUCTIONS */

app.post("/transcribe", upload.single("audio"), async (req, res) => {
    try {
        const { roomId, userId } = req.body;

        if (!roomId || !userId) {
            return res.status(400).json({ message: "roomId and userId are required" });
        }
        if (!req.file) {
            return res.status(400).json({ message: "Audio file is required" });
        }

        const audioPath = req.file.path;
        
        // Note: Corrected model to 'whisper-1' as 'gpt-4o-transcribe' is not a valid transcription model
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: "whisper-1"
        });

        const text = (transcription.text || "").trim();

        if (text) {
            await Caption.create({
                roomId,
                speaker: userId,
                text,
                isFinal: true,
                language: "en"
            });
            
            // Emit to socket so participants see it in real-time
            io.to(roomId).emit("caption-added", {
                roomId,
                speaker: userId,
                text,
                isFinal: true,
                language: "en",
                createdAt: new Date()
            });
        }

        try {
            fs.unlinkSync(audioPath);
        } catch (_) {}

        res.json({ text });
    } catch (error) {
        console.log("Transcription error:", error);
        res.status(500).json({
            message: error.message || "Transcription failed",
            text: ""
        });
    }
});

/* SOCKET */

io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);

    socket.on("create-room", async ({ roomId, userId, maxParticipants, meetingTitle, meetingType, meetingPassword }) => {
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

        await MeetingHistory.findOneAndUpdate(
            { roomId },
            {
                roomId,
                title: meetingTitle || "Meeting",
                hostUserId: userId,
                $addToSet: { participants: userId },
                startedAt: new Date()
            },
            { upsert: true, new: true }
        );

        socket.emit("room-created", {
            roomId,
            userId,
            maxParticipants: roomLimits[roomId],
            hostUserId: roomHostUserIds[roomId]
        });

        io.to(roomId).emit("room-info", {
            roomId,
            hostUserId: roomHostUserIds[roomId] || "",
            maxParticipants: roomLimits[roomId] || 10,
            isRecording: roomRecordingState[roomId] || false,
            meetingTitle: roomTitles[roomId] || "Meeting",
            meetingType: roomTypes[roomId] || "public",
            participants: Object.keys(roomParticipants[roomId] || {})
        });

        io.to(roomId).emit("participants-updated", {
            participants: Object.keys(roomParticipants[roomId]),
            hostUserId: roomHostUserIds[roomId]
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
            participants: Object.keys(roomParticipants[roomId] || {})
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
            guestSocketId: socket.id
        });
    });

    socket.on("approve-join", async ({ roomId, guestSocketId, userId }) => {
        if (!roomId || !guestSocketId || !userId) return;

        const guestSocket = io.sockets.sockets.get(guestSocketId);
        if (!guestSocket) return;

        guestSocket.join(roomId);
        guestSocket.data.roomId = roomId;
        guestSocket.data.userId = userId;
        guestSocket.data.isHost = false;

        if (!roomParticipants[roomId]) roomParticipants[roomId] = {};
        roomParticipants[roomId][userId] = guestSocketId;

        await MeetingHistory.findOneAndUpdate(
            { roomId },
            {
                $addToSet: { participants: userId }
            }
        );

        io.to(guestSocketId).emit("join-approved", {
            roomId,
            userId,
            hostUserId: roomHostUserIds[roomId] || "",
            meetingTitle: roomTitles[roomId] || "Meeting",
            meetingType: roomTypes[roomId] || "public"
        });

        io.to(roomId).emit("room-info", {
            roomId,
            hostUserId: roomHostUserIds[roomId] || "",
            maxParticipants: roomLimits[roomId] || 10,
            isRecording: roomRecordingState[roomId] || false,
            meetingTitle: roomTitles[roomId] || "Meeting",
            meetingType: roomTypes[roomId] || "public",
            participants: Object.keys(roomParticipants[roomId] || {})
        });

        io.to(roomId).emit("participants-updated", {
            participants: Object.keys(roomParticipants[roomId] || {}),
            hostUserId: roomHostUserIds[roomId]
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
        socket.to(roomId).emit("force-mute");
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

        if (!blockedUsers[roomId]) {
            blockedUsers[roomId] = [];
        }

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
            hostUserId: roomHostUserIds[roomId] || ""
        });
    });

    socket.on("raise-hand", ({ roomId, userId, raised }) => {
        if (!roomId || !userId) return;

        const clean = cleanUserId(userId);

        if (!raisedHands[roomId]) {
            raisedHands[roomId] = {};
        }

        raisedHands[roomId][clean] = !!raised;

        io.to(roomId).emit("hand-state-updated", {
            userId: clean,
            raised: !!raised
        });
    });

    socket.on("recording-toggle", ({ roomId, recording }) => {
        if (!roomId) return;

        roomRecordingState[roomId] = !!recording;

        io.to(roomId).emit("recording-state", {
            recording: !!recording
        });
    });

    socket.on("leave-room", ({ roomId, userId }) => {
        if (!roomId || !userId) return;

        socket.leave(roomId);

        if (roomParticipants[roomId] && roomParticipants[roomId][userId]) {
            delete roomParticipants[roomId][userId];
        }

        io.to(roomId).emit("participants-updated", {
            participants: Object.keys(roomParticipants[roomId] || {}),
            hostUserId: roomHostUserIds[roomId] || ""
        });

        if (socket.data.isHost && roomHosts[roomId] === socket.id) {
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

    socket.on("disconnect", () => {
        const roomId = socket.data.roomId;
        const userId = socket.data.userId;

        if (roomId && roomParticipants[roomId] && userId && roomParticipants[roomId][userId]) {
            delete roomParticipants[roomId][userId];
        }

        if (roomId) {
            io.to(roomId).emit("participants-updated", {
                participants: Object.keys(roomParticipants[roomId] || {}),
                hostUserId: roomHostUserIds[roomId] || ""
            });
        }

        if (roomId && socket.data.isHost && roomHosts[roomId] === socket.id) {
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
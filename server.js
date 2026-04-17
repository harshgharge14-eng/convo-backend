require("dotenv").config();

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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const roomHosts = {};

app.set("trust proxy", true);

if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "uploads/");
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
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

app.get("/", (req, res) => {
    res.send("Server Running");
});

app.get("/livekit-token", async (req, res) => {
    try {
        const { room, identity } = req.query;

        if (!room || !identity) {
            return res.status(400).json({ message: "room and identity are required" });
        }

        if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET || !process.env.LIVEKIT_URL) {
            return res.status(500).json({ message: "LiveKit environment variables are missing" });
        }

        const at = new AccessToken(
            process.env.LIVEKIT_API_KEY,
            process.env.LIVEKIT_API_SECRET,
            { identity: identity.toString() }
        );

        at.addGrant({
            roomJoin: true,
            room: room.toString(),
            canPublish: true,
            canSubscribe: true
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

io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);

    socket.on("create-room", ({ roomId, userId }) => {
        if (!roomId || !userId) return;

        roomHosts[roomId] = socket.id;
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.userId = userId;
        socket.data.isHost = true;

        socket.emit("room-created", {
            roomId,
            userId,
            hostSocketId: socket.id
        });
    });

    socket.on("join-room", ({ roomId, userId }) => {
        if (!roomId || !userId) return;

        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.userId = userId;
        socket.data.isHost = false;

        socket.to(roomId).emit("user-joined", {
            userId,
            socketId: socket.id
        });
    });

    socket.on("join-request", ({ roomId, userId }) => {
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
            socket.emit("join-rejected", {
                message: "Host not available"
            });
            return;
        }

        io.to(hostSocketId).emit("join-request", {
            roomId,
            userId,
            guestSocketId: socket.id
        });
    });

    socket.on("approve-join", ({ roomId, guestSocketId, userId }) => {
        if (!roomId || !guestSocketId || !userId) return;

        const guestSocket = io.sockets.sockets.get(guestSocketId);
        if (!guestSocket) return;

        guestSocket.join(roomId);
        guestSocket.data.roomId = roomId;
        guestSocket.data.userId = userId;
        guestSocket.data.isHost = false;

        io.to(guestSocketId).emit("join-approved", {
            roomId,
            userId
        });

        io.to(roomId).emit("user-joined", {
            userId,
            socketId: guestSocketId
        });
    });

    socket.on("reject-join", ({ guestSocketId, userId }) => {
        if (!guestSocketId || !userId) return;

        io.to(guestSocketId).emit("join-rejected", {
            message: `${userId} was rejected by host`
        });
    });

    socket.on("leave-room", ({ roomId, userId }) => {
        if (!roomId || !userId) return;

        socket.leave(roomId);

        socket.to(roomId).emit("user-left", {
            userId,
            socketId: socket.id
        });

        if (socket.data.isHost && roomHosts[roomId] === socket.id) {
            delete roomHosts[roomId];
        }
    });

    socket.on("disconnect", () => {
        const roomId = socket.data.roomId;
        const userId = socket.data.userId;

        if (roomId && userId) {
            socket.to(roomId).emit("user-left", {
                userId,
                socketId: socket.id
            });
        }

        if (roomId && socket.data.isHost && roomHosts[roomId] === socket.id) {
            delete roomHosts[roomId];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server started on port ${PORT}`);
});
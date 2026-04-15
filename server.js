require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");

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

// Needed when behind a proxy/load balancer
app.set("trust proxy", true);

// Create uploads folder if not exists
if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
}

// Multer config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "uploads/");
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ storage });

// Middleware
app.use(express.json());
app.use(cors());

// Serve uploaded files
app.use("/uploads", express.static("uploads"));

// MongoDB connection
mongoose.set("bufferCommands", false);

mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 30000
})
    .then(() => console.log("MongoDB Connected"))
    .catch(err => console.log("MongoDB Error:", err));

// Test route
app.get("/", (req, res) => {
    res.send("Server Running");
});

// Upload audio
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

// Signup
app.post("/signup", async (req, res) => {
    try {
        console.log("Signup request body:", req.body);

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

        console.log("User created successfully:", email);
        res.json({ message: "User created successfully" });

    } catch (error) {
        console.log("Signup error:", error);
        res.status(500).json({ message: error.message || "Error creating user" });
    }
});

// Login
app.post("/login", async (req, res) => {
    try {
        console.log("Login request body:", req.body);

        const { email, password } = req.body;

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

// Send message
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

// Get messages
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

// Socket.IO
io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);

    socket.on("create-room", ({ roomId, userId }) => {
        roomHosts[roomId] = socket.id;
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.userId = userId;
        socket.data.isHost = true;

        console.log(`Host ${userId} created room ${roomId}`);
    });

    socket.on("join-request", ({ roomId, userId }) => {
        socket.data.roomId = roomId;
        socket.data.userId = userId;
        socket.data.isHost = false;

        const hostSocketId = roomHosts[roomId];

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
        const guestSocket = io.sockets.sockets.get(guestSocketId);

        if (guestSocket) {
            guestSocket.join(roomId);
            io.to(guestSocketId).emit("join-approved", {
                roomId,
                userId
            });

            socket.to(roomId).emit("user-joined", {
                userId,
                socketId: guestSocketId
            });

            console.log(`Host approved ${userId} for room ${roomId}`);
        }
    });

    socket.on("reject-join", ({ guestSocketId, userId }) => {
        io.to(guestSocketId).emit("join-rejected", {
            message: `${userId} was rejected by host`
        });

        console.log(`Host rejected ${userId}`);
    });

    socket.on("offer", ({ roomId, offer }) => {
        socket.to(roomId).emit("offer", { offer });
    });

    socket.on("answer", ({ roomId, answer }) => {
        socket.to(roomId).emit("answer", { answer });
    });

    socket.on("ice-candidate", ({ roomId, candidate, sdpMid, sdpMLineIndex }) => {
        socket.to(roomId).emit("ice-candidate", {
            candidate,
            sdpMid,
            sdpMLineIndex
        });
    });

    socket.on("leave-room", ({ roomId, userId }) => {
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

        if (roomId) {
            socket.to(roomId).emit("user-left", {
                userId,
                socketId: socket.id
            });
        }

        if (socket.data.isHost && roomHosts[roomId] === socket.id) {
            delete roomHosts[roomId];
        }

        console.log("Socket disconnected:", socket.id);
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server started on port ${PORT}`);
});
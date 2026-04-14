require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const User = require("./User");
const Message = require("./Message");

const app = express();

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
mongoose.connect(process.env.MONGO_URI)
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
        res.status(500).json({ message: "Upload failed" });
    }
});

// Signup
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
        res.status(500).json({ message: "Error creating user" });
    }
});

// Login
app.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email, password });

        if (user) {
            res.json({ message: "Login success" });
        } else {
            res.json({ message: "Invalid credentials" });
        }

    } catch (error) {
        res.status(500).json({ message: "Error logging in" });
    }
});

// Send message
app.post("/sendMessage", async (req, res) => {
    try {
        const { sender, message, audioUrl, type } = req.body;

        const newMessage = new Message({
            sender,
            message,
            audioUrl,
            type,
            time: new Date()
        });

        await newMessage.save();

        res.json({ message: "Message sent" });

    } catch (error) {
        res.status(500).json({ message: "Error sending message" });
    }
});

// Get messages
app.get("/messages", async (req, res) => {
    try {
        const messages = await Message.find().sort({ time: 1 });
        res.json(messages);
    } catch (error) {
        res.status(500).json({ message: "Error fetching messages" });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server started on port ${PORT}`);
});
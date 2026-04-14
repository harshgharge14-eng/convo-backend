const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema({
    sender: String,
    message: String,
     audioUrl: String, // 🔥 NEW
    type: String, // "text" or "audio"
    time: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model("Message", MessageSchema);
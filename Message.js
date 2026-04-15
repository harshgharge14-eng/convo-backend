const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema({
    email: String,
    sender: String,
    message: String,
    audioUrl: String,
    type: String,
    time: {
        type: Date,
        default: Date.now
    }
});
module.exports = mongoose.model("Message", MessageSchema);
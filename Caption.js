const mongoose = require("mongoose");

const captionSchema = new mongoose.Schema(
    {
        roomId: String,
        speaker: String,
        text: String,
        isFinal: {
            type: Boolean,
            default: true
        },
        language: {
            type: String,
            default: "en"
        }
    },
    { timestamps: true }
);

module.exports = mongoose.model("Caption", captionSchema);
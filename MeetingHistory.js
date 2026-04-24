const mongoose = require("mongoose");

const MeetingHistorySchema = new mongoose.Schema(
    {
        roomId: {
            type: String,
            required: true,
            unique: true
        },
        title: {
            type: String,
            default: "Meeting"
        },
        hostUserId: {
            type: String,
            default: ""
        },
        participants: {
            type: [String],
            default: []
        },
        startedAt: {
            type: Date,
            default: Date.now
        },
        endedAt: {
            type: Date,
            default: null
        }
    },
    { timestamps: true }
);

module.exports = mongoose.model("MeetingHistory", MeetingHistorySchema);
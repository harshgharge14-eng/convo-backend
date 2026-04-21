const mongoose = require("mongoose");

const AttendanceSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    joinedAt: { type: Date, required: true },
    leftAt: { type: Date, default: null },
  },
  { _id: false }
);

const MeetingHistorySchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true },
    title: { type: String, default: "Meeting" },
    meetingType: { type: String, default: "public" },
    hostUserId: { type: String, required: true },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
    durationSeconds: { type: Number, default: 0 },
    participants: { type: [String], default: [] },
    attendance: { type: [AttendanceSchema], default: [] },
    isRecording: { type: Boolean, default: false },
    recordingEgressId: { type: String, default: "" },
    recordingFilepath: { type: String, default: "" },
    recordingStatus: { type: String, default: "idle" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MeetingHistory", MeetingHistorySchema);
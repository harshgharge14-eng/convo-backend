const mongoose = require("mongoose");

const SummarySchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true },
    title: { type: String, default: "Meeting Summary" },
    summaryText: { type: String, default: "" },
    keyPoints: { type: [String], default: [] },
    actionItems: { type: [String], default: [] },
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Summary", SummarySchema);
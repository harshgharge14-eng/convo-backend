const mongoose = require("mongoose");

const CaptionSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    speaker: { type: String, required: true },
    text: { type: String, required: true },
    isFinal: { type: Boolean, default: true },
    language: { type: String, default: "en" },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Caption", CaptionSchema);
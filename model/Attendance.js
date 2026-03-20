// models/Attendance.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const AttendanceSchema = new Schema({
  
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  timestamp: { type: Date, default: Date.now },
  date: { type: String, index: true },
  source: { type: String, default: 'webcam' },
  confidence: Number
  
});
module.exports = mongoose.model('Attendance', AttendanceSchema);
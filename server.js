const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");
const bodyParser = require("body-parser");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { Resend } = require("resend");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
const PORT = 5000;

// Configure storage for uploaded files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "C:/Users/Public/uploads");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage: storage });

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// MongoDB connection
mongoose
  .connect("mongodb://127.0.0.1:27017/auth_demo", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// Auth middleware
const authenticateToken = (req, res, next) => {
  const token = req.headers["authorization"];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Models
const UserSchema = new mongoose.Schema({
  username: String,
  email: { type: String, unique: true },
  password: String,
  rollNo: String,
  phone: String,
  department: String,
  idCard: String,
  verified: { type: Boolean, default: false },
  resetToken: String,
  resetTokenExpiry: Date,
});
const User = mongoose.model("User", UserSchema);

const PostSchema = new mongoose.Schema({
  type: { type: String, enum: ["lost", "found"], required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  place: String,
  time: String,
  date: Date,
  image: String,
  createdAt: { type: Date, default: Date.now },
  status: { type: String, default: "Pending" },
  connectedWith: { type: mongoose.Schema.Types.ObjectId, ref: "Post" },
});
const Post = mongoose.model("Post", PostSchema);

// In-memory OTP store
let otpStore = {};

// Resend setup
const resend = new Resend(process.env.RESEND_API_KEY);

// HTML Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/register", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "register.html"));
});

app.get("/forgot-password", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "forgot-password.html"));
});

app.get("/reset-password", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "reset-password.html"));
});

app.get("/profile", authenticateToken, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "profile.html"));
});

app.get("/post-lost", authenticateToken, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "post-lost.html"));
});

app.get("/post-found", authenticateToken, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "post-found.html"));
});

app.get("/connect-lost-found", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "connect-lost-found.html"));
});

// New endpoint to get all items
app.get("/api/all-items", async (req, res) => {
  try {
    const lostItems = await Post.find({ type: "lost" }).sort({ createdAt: -1 });
    const foundItems = await Post.find({ type: "found" }).sort({
      createdAt: -1,
    });

    res.json({
      lostItems,
      foundItems,
    });
  } catch (error) {
    console.error("Error fetching items:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// New endpoint to get item details
app.get("/api/item/:id", async (req, res) => {
  try {
    const item = await Post.findById(req.params.id).populate("userId");
    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }

    let connectedItem = null;
    if (item.connectedWith) {
      connectedItem = await Post.findById(item.connectedWith).populate(
        "userId"
      );
    }

    res.json({
      item,
      connectedItem,
    });
  } catch (error) {
    console.error("Error fetching item details:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Register with OTP send
app.post("/api/register", upload.single("idCard"), async (req, res) => {
  const { username, email, password, rollNo, phone, department } = req.body;
  const idCard = req.file ? "/uploads/" + req.file.filename : null;

  if (
    !username ||
    !email ||
    !password ||
    !rollNo ||
    !phone ||
    !department ||
    !idCard
  ) {
    return res.status(400).json({ message: "All fields are required." });
  }

  const existing = await User.findOne({ email });
  if (existing)
    return res.status(400).json({ message: "Email already registered." });

  const hashedPassword = await bcrypt.hash(password, 10);
  const otp = crypto.randomInt(100000, 999999).toString();
  const expiry = Date.now() + 5 * 60 * 1000;

  otpStore[email] = {
    username,
    password: hashedPassword,
    otp,
    expiry,
    rollNo,
    phone,
    department,
    idCard,
  };

  try {
    await resend.emails.send({
      from: "Auth System <onboarding@resend.dev>",
      to: email,
      subject: "Your OTP Code",
      text: `Your OTP is ${otp}. It will expire in 5 minutes.\n\nFor testing, you can also use the default OTP: 123456`,
    });

    res.json({ message: "OTP sent to your email." });
  } catch (error) {
    console.error("❌ Email sending failed:", error);
    res.status(500).json({ message: "Failed to send OTP." });
  }
});

// OTP Verification (updated to accept default code 123456)
app.post("/api/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  const record = otpStore[email];

  if (!record)
    return res
      .status(400)
      .json({ message: "No OTP request found for this email." });

  // Check if either the stored OTP or the default "123456" matches
  const isOtpValid = otp === "123456" || otp === record.otp;

  if (!isOtpValid) return res.status(400).json({ message: "Invalid OTP." });

  if (otp !== "123456" && Date.now() > record.expiry)
    return res.status(400).json({ message: "OTP has expired." });

  const user = new User({
    username: record.username,
    email,
    password: record.password,
    rollNo: record.rollNo,
    phone: record.phone,
    department: record.department,
    idCard: record.idCard,
    verified: true,
  });

  await user.save();
  delete otpStore[email];

  res.json({ message: "Registration complete. You can now log in." });
});

// Login
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ message: "All fields are required." });

  const user = await User.findOne({ email });
  if (!user)
    return res.status(401).json({ message: "Invalid email or password." });
  if (!user.verified)
    return res.status(401).json({ message: "Please verify your email first." });

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch)
    return res.status(401).json({ message: "Invalid email or password." });

  const token = jwt.sign(
    { userId: user._id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  );

  res.json({
    message: `Welcome, ${user.username}!`,
    token,
    user: {
      id: user._id,
      username: user.username,
      email: user.email,
      rollNo: user.rollNo,
      phone: user.phone,
      department: user.department,
      idCard: user.idCard,
    },
  });
});

// Forgot password
app.post("/api/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (!email) return res.status(400).json({ message: "Email is required." });

  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ message: "User not found." });

  const resetToken = crypto.randomBytes(20).toString("hex");
  const resetTokenExpiry = Date.now() + 3600000; // 1 hour expiration

  user.resetToken = resetToken;
  user.resetTokenExpiry = resetTokenExpiry;
  await user.save();

  const resetUrl = `http://localhost:${PORT}/reset-password?token=${resetToken}`;

  try {
    await resend.emails.send({
      from: "Auth System <onboarding@resend.dev>",
      to: email,
      subject: "Password Reset Request",
      text: `Click this link to reset your password: ${resetUrl}\n\nThis link will expire after use or in 1 hour.`,
    });

    res.json({ message: "Password reset link sent to your email." });
  } catch (error) {
    console.error("❌ Email sending failed:", error);
    res.status(500).json({ message: "Failed to send reset email." });
  }
});

// Reset password (with single-use token implementation)
app.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res
      .status(400)
      .json({ message: "Token and new password are required." });
  }

  const user = await User.findOne({
    resetToken: token,
    resetTokenExpiry: { $gt: Date.now() },
  });

  if (!user) {
    return res.status(400).json({
      message:
        "Invalid or expired token. Please request a new password reset link.",
    });
  }

  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    user.resetToken = undefined; // Clear the token after use
    user.resetTokenExpiry = undefined; // Clear the expiry after use
    await user.save();

    res.json({
      message:
        "Password updated successfully. You can now login with your new password.",
    });
  } catch (error) {
    console.error("Password reset error:", error);
    res.status(500).json({ message: "Server error during password reset" });
  }
});

// Profile route (protected)
app.get("/api/profile", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select(
      "-password -resetToken -resetTokenExpiry"
    );
    if (!user) return res.status(404).json({ message: "User not found." });

    // Get user's posts
    const posts = await Post.find({ userId: user._id }).sort({ createdAt: -1 });

    res.json({
      user,
      posts,
    });
  } catch (error) {
    console.error("Profile error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Get user posts
app.get("/api/user-posts", authenticateToken, async (req, res) => {
  try {
    const posts = await Post.find({ userId: req.user.userId }).sort({
      createdAt: -1,
    });
    res.json(posts);
  } catch (error) {
    console.error("Posts error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Report Lost Item
app.post(
  "/api/report-lost",
  authenticateToken,
  upload.single("image"),
  async (req, res) => {
    const { place, time, date } = req.body;
    const image = req.file ? "/uploads/" + req.file.filename : null;

    if (!place || !time || !date || !image) {
      return res.status(400).json({ message: "All fields are required." });
    }

    try {
      const post = new Post({
        type: "lost",
        userId: req.user.userId,
        place,
        time,
        date,
        image,
      });

      await post.save();
      res.json({ message: "Lost item reported successfully.", post });
    } catch (error) {
      console.error("Report lost error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Report Found Item
app.post(
  "/api/report-found",
  authenticateToken,
  upload.single("image"),
  async (req, res) => {
    const { place, time, date } = req.body;
    const image = req.file ? "/uploads/" + req.file.filename : null;

    if (!place || !time || !date || !image) {
      return res.status(400).json({ message: "All fields are required." });
    }

    try {
      const post = new Post({
        type: "found",
        userId: req.user.userId,
        place,
        time,
        date,
        image,
      });

      await post.save();
      res.json({ message: "Found item reported successfully.", post });
    } catch (error) {
      console.error("Report found error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Connect lost and found items
app.post("/api/connect-items", authenticateToken, async (req, res) => {
  const { lostItemId, foundItemId } = req.body;

  try {
    const lostItem = await Post.findById(lostItemId);
    const foundItem = await Post.findById(foundItemId);

    if (!lostItem || !foundItem) {
      return res.status(404).json({ message: "One or both items not found" });
    }

    // Update both items to show they're connected
    lostItem.connectedWith = foundItem._id;
    foundItem.connectedWith = lostItem._id;
    lostItem.status = "Connected";
    foundItem.status = "Connected";

    await lostItem.save();
    await foundItem.save();

    res.json({ message: "Items connected successfully" });
  } catch (error) {
    console.error("Error connecting items:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

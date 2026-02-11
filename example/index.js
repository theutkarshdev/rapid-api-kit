const { rapidAPI } = require("../src/index");

rapidAPI({
  mongoURI: "mongodb://localhost:27017/my_school_db",
  port: 3000,
  resources: [
    {
      name: "students",
      schema: {
        name: { type: String, required: true },
        email: { type: String, required: true, unique: true },
        age: { type: Number, min: 10, max: 100 },
        grade: { type: String, enum: ["A", "B", "C", "D", "F"] },
        isActive: { type: Boolean, default: true },
      },
      searchBy: ["name", "email"],
      filterBy: ["grade", "age", "isActive"],
    },
    {
      name: "courses",
      schema: {
        title: { type: String, required: true },
        description: { type: String },
        instructor: { type: String, required: true },
        duration: { type: Number }, // in hours
        price: { type: Number, default: 0 },
        tags: [String],
      },
      searchBy: ["title", "description", "instructor"], 
      filterBy: ["instructor", "price", "duration"],
    },
    {
      name: "assignments",
      schema: {
        title: { type: String, required: true },
        subject: { type: String, required: true },
        dueDate: { type: Date },
        maxScore: { type: Number, default: 100 },
        isPublished: { type: Boolean, default: false },
      },
      searchBy: ["title", "subject"],
      filterBy: ["subject", "isPublished", "maxScore"],
    },
  ],

  // ── Optional settings ────────────────────────────────────────
  apiPrefix: "/api",
  logging: true,
  cors: {},

  swaggerInfo: {
    title: "My School API",
    description: "API for managing students, courses, and assignments",
    version: "1.0.0",
  },
});

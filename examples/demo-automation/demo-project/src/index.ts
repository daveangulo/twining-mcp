import express from "express";
import { corsMiddleware } from "./middleware/cors";
import { apiRouter } from "./routes/api";
import { healthRouter } from "./routes/health";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(corsMiddleware);
app.use(healthRouter);
app.use(apiRouter);

// No rate limiting — all endpoints are wide open
// No authentication — every route is publicly accessible

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

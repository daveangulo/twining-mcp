import { Router, Request, Response } from "express";

const router = Router();

// GET /api/users — list all users
router.get("/api/users", (_req: Request, res: Response) => {
  // TODO: no authentication — anyone can list users
  res.json([
    { id: 1, name: "Alice", email: "alice@example.com" },
    { id: 2, name: "Bob", email: "bob@example.com" },
  ]);
});

// GET /api/users/:id — get single user
router.get("/api/users/:id", (req: Request, res: Response) => {
  res.json({ id: Number(req.params.id), name: "Alice", email: "alice@example.com" });
});

// POST /api/posts — create a post
router.post("/api/posts", (req: Request, res: Response) => {
  const { title, content } = req.body;
  // TODO: no auth check — anyone can create posts
  res.status(201).json({ id: Date.now(), title, content, created_at: new Date().toISOString() });
});

// DELETE /api/posts/:id — delete a post
router.delete("/api/posts/:id", (req: Request, res: Response) => {
  // TODO: no authorization — any user can delete any post
  res.json({ deleted: true, id: Number(req.params.id) });
});

export { router as apiRouter };

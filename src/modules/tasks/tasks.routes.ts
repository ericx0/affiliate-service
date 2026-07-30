import { Router } from "express";
import { kolAuthMiddleware } from "../../middleware/kol-auth.js";
import { completeMyTask } from "./tasks.controller.js";

export const tasksRouter = Router();

tasksRouter.use(kolAuthMiddleware);

tasksRouter.post("/:id/complete", completeMyTask);
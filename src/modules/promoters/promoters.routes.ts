import { Router } from "express";
import { createPromoter } from "./promoters.controller.js";

export const promotersRouter = Router();

promotersRouter.post("/", createPromoter);

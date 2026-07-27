import { Router } from "express";
import { track } from "./clicks.controller.js";

export const clicksRouter = Router();

clicksRouter.post("/track", track);

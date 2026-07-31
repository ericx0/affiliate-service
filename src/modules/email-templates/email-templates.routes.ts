import { Router } from "express";
import { kolAuthMiddleware } from "../../middleware/kol-auth.js";
import {
  getTemplate,
  listTemplates,
  renderTemplate,
  sendTemplate,
} from "./email-templates.controller.js";

export const emailTemplatesRouter = Router();

emailTemplatesRouter.use(kolAuthMiddleware);

emailTemplatesRouter.get("/", listTemplates);
emailTemplatesRouter.get("/:id", getTemplate);
emailTemplatesRouter.post("/:id/render", renderTemplate);
emailTemplatesRouter.post("/:id/send", sendTemplate);

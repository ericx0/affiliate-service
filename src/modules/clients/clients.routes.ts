import { Router } from "express";
import { kolAuthMiddleware } from "../../middleware/kol-auth.js";
import {
  listMyClients,
  createMyClient,
  getMyClient,
  patchMyClient,
  logMyContact,
} from "./clients.controller.js";

export const clientsRouter = Router();

// Every endpoint here requires an authenticated KOL session.
// (Self-service KOL portal routes; the portal already mounts the same
// kolAuthMiddleware on /me — using it here keeps the contract identical.)
clientsRouter.use(kolAuthMiddleware);

clientsRouter.get("/", listMyClients);
clientsRouter.post("/", createMyClient);
clientsRouter.get("/:id", getMyClient);
clientsRouter.patch("/:id", patchMyClient);
clientsRouter.post("/:id/contacts", logMyContact);
import express from "express";
import { authErrorHandler, postCreateGym, postLogin, postLogout, postRefresh } from "../controllers/authController.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { validateCredentials, validateGymName, validateRefreshToken } from "../middleware/validateAuth.js";

const router = express.Router();

router.post("/login", validateCredentials, postLogin);
router.post("/refresh", validateRefreshToken, postRefresh);
router.post("/logout", requireAuth({ allowNoGym: true }), postLogout);
router.post("/gym", requireAuth({ allowNoGym: true }), validateGymName, postCreateGym);
router.use(authErrorHandler);

export default router;

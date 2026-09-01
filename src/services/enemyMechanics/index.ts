import { genericEnemyMechanicHandlers } from "./handlers/genericEnemyMechanics";
import { registerEnemyMechanicHandlers } from "./registry";

registerEnemyMechanicHandlers(genericEnemyMechanicHandlers);

export * from "./engine";
export * from "./loader";
export * from "./registry";
export * from "./targeting";
export * from "./types";
export * from "./handlers/genericEnemyMechanics";

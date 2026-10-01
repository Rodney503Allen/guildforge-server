// services/tutorialService.ts
import { db } from "../db";

export enum TutorialStep {
  VISIT_CHARACTER = 0,
  EQUIP_STARTER_WEAPON = 1,
  ASSIGN_HEALTH_POTION = 2,
  VISIT_TRAINER = 3,
  LEARN_FIRST_SPELL = 4,
  EQUIP_FIRST_SPELL = 5,
  ACCEPT_FIRST_QUEST = 6,
  LEAVE_PORT_HAVEN = 7,
  ENTER_FIRST_COMBAT = 8,
  CAST_FIRST_SPELL = 9,
  USE_FIRST_POTION = 10,
  WIN_FIRST_BATTLE = 11,
  COMPLETE = 12
}

export async function getTutorialState(playerId: number) {
  const [[row]]: any = await db.query(`SELECT tutorial_step, tutorial_completed FROM players WHERE id = ? LIMIT 1`, [playerId]);
  if (!row) return null;
  return { step: Number(row.tutorial_step || 0), completed: Number(row.tutorial_completed || 0) === 1 };
}

export async function advanceTutorial(playerId: number, expectedStep: TutorialStep, nextStep: TutorialStep) {
  const [result]: any = await db.query(`UPDATE players SET tutorial_step = ? WHERE id = ? AND tutorial_completed = 0 AND tutorial_step = ?`, [nextStep, playerId, expectedStep]);
  return Number(result?.affectedRows || 0) > 0;
}

export async function completeTutorial(playerId: number) {
  await db.query(`UPDATE players SET tutorial_step = ?, tutorial_completed = 1 WHERE id = ?`, [TutorialStep.COMPLETE, playerId]);
}

export async function skipTutorial(playerId: number) { await completeTutorial(playerId); }

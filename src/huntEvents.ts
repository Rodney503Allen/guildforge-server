// src/huntEvents.ts
import { EventEmitter } from "events";

const huntEvents =
  new EventEmitter();

export type HuntProgressPayload =
  Record<string, any>;

type HuntProgressEvent = {
  partyId: number;
  progress: HuntProgressPayload;
};

export function publishHuntProgressEvent(
  partyId: number,
  progress: HuntProgressPayload,
) {
  const id =
    Number(partyId);

  if (
    !Number.isInteger(id) ||
    id <= 0 ||
    !progress ||
    typeof progress !== "object"
  ) {
    return;
  }

  huntEvents.emit(
    "hunt-progress",
    {
      partyId: id,
      progress,
    } satisfies HuntProgressEvent,
  );
}

export function onHuntProgressEvent(
  listener: (
    partyId: number,
    progress: HuntProgressPayload,
  ) => void,
) {
  const handler = (
    event: HuntProgressEvent,
  ) => {
    listener(
      event.partyId,
      event.progress,
    );
  };

  huntEvents.on(
    "hunt-progress",
    handler,
  );

  return () => {
    huntEvents.off(
      "hunt-progress",
      handler,
    );
  };
}
// =========================================================
// GUILDFORGE SPELL CAST EVENTS
// Shared frontend bridge for spell audio and future cast reactions.
//
// Usage after the server confirms a successful cast:
//
//   window.GFSpellEvents.emitCast(spell);
//
// Where spell may contain:
//   {
//     id: 12,
//     name: "Sacred Strike",
//     audio: "sacredstrike"
//   }
//
// Or, if only the audio key is available:
//
//   window.GFSpellEvents.emitCast("sacredstrike");
//
// This file does NOT play audio itself.
// audioManager.js listens for "guildforge:spell-cast" globally.
// =========================================================

(function initializeGuildforgeSpellEvents() {
  if (
    window.GFSpellEvents &&
    typeof window.GFSpellEvents.emitCast === "function"
  ) {
    return;
  }

  function normalizeSpellPayload(spellOrAudio, options = {}) {
    if (
      typeof spellOrAudio === "string"
    ) {
      return {
        audio: spellOrAudio,
        options
      };
    }

    if (
      spellOrAudio &&
      typeof spellOrAudio === "object"
    ) {
      return {
        spell: spellOrAudio,
        audio:
          spellOrAudio.audio ??
          spellOrAudio.audio_key ??
          spellOrAudio.sfx_key ??
          null,
        options
      };
    }

    return {
      audio: null,
      options
    };
  }

  function emitCast(spellOrAudio, options = {}) {
    const detail =
      normalizeSpellPayload(
        spellOrAudio,
        options
      );

    if (!detail.audio) {
      return false;
    }

    window.dispatchEvent(
      new CustomEvent(
        "guildforge:spell-cast",
        {
          detail
        }
      )
    );

    return true;
  }

  window.GFSpellEvents = {
    emitCast
  };
})();
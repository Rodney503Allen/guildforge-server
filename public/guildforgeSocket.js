// public/guildforgeSocket.js

(() => {
  "use strict";

  /*
   * Guildforge-wide Socket.IO singleton.
   *
   * Every authenticated page should load:
   *
   *   <script src="/socket.io/socket.io.js"></script>
   *   <script src="/guildforgeSocket.js"></script>
   *
   * Feature scripts should then reuse:
   *
   *   window.GFSocket
   *
   * instead of calling io() themselves.
   */

  if (
    window.GFSocket &&
    typeof window.GFSocket.on === "function"
  ) {
    return;
  }

  if (
    typeof window.io !== "function"
  ) {
    console.error(
      "Guildforge socket bootstrap failed: Socket.IO client is not loaded."
    );

    return;
  }

  const socket =
    window.io({
      autoConnect: true
    });

  window.GFSocket =
    socket;

  socket.on(
    "connect",
    () => {
      window.dispatchEvent(
        new CustomEvent(
          "guildforge:socket-connected",
          {
            detail: {
              socketId:
                socket.id
            }
          }
        )
      );
    }
  );

  socket.on(
    "disconnect",
    reason => {
      window.dispatchEvent(
        new CustomEvent(
          "guildforge:socket-disconnected",
          {
            detail: {
              reason
            }
          }
        )
      );
    }
  );

  socket.on(
    "connect_error",
    error => {
      /*
       * A logged-out page may briefly load a script
       * before redirecting. Keep this informational
       * rather than throwing.
       */
      console.warn(
        "Guildforge socket connection failed:",
        error?.message ||
        error
      );
    }
  );
})();
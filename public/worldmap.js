// worldmap.js

// =======================
// BASIC SETUP
// =======================
const canvas = document.getElementById("world-canvas");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// =======================
// LOAD WORLD MAP
// =======================
const worldImage = new Image();
worldImage.src = "/images/world/overworld.png";

let worldLoaded = false;

worldImage.onload = () => {
  worldLoaded = true;

  // Start player roughly in the center of the map
  player.x = worldImage.width / 2;
  player.y = worldImage.height / 2;
};

// =======================
// PLAYER STATE
// =======================
const player = {
  x: 0,
  y: 0,
  speed: 3,
  size: 18 // radius of icon
};

// Simple key state
const keys = {
  up: false,
  down: false,
  left: false,
  right: false
};

window.addEventListener("keydown", (e) => {
  switch (e.key) {
    case "w":
    case "ArrowUp":
      keys.up = true;
      break;
    case "s":
    case "ArrowDown":
      keys.down = true;
      break;
    case "a":
    case "ArrowLeft":
      keys.left = true;
      break;
    case "d":
    case "ArrowRight":
      keys.right = true;
      break;
  }
});

window.addEventListener("keyup", (e) => {
  switch (e.key) {
    case "w":
    case "ArrowUp":
      keys.up = false;
      break;
    case "s":
    case "ArrowDown":
      keys.down = false;
      break;
    case "a":
    case "ArrowLeft":
      keys.left = false;
      break;
    case "d":
    case "ArrowRight":
      keys.right = false;
      break;
  }
});

// =======================
// GAME LOOP
// =======================
function update() {
  if (!worldLoaded) return;

  let dx = 0;
  let dy = 0;

  if (keys.up) dy -= 1;
  if (keys.down) dy += 1;
  if (keys.left) dx -= 1;
  if (keys.right) dx += 1;

  // Normalize diagonal movement
  if (dx !== 0 && dy !== 0) {
    const inv = 1 / Math.sqrt(2);
    dx *= inv;
    dy *= inv;
  }

  player.x += dx * player.speed;
  player.y += dy * player.speed;

  // Clamp player to world boundaries
  player.x = Math.max(player.size, Math.min(worldImage.width - player.size, player.x));
  player.y = Math.max(player.size, Math.min(worldImage.height - player.size, player.y));
}

// Camera centers on player
function draw() {
  if (!worldLoaded) return;

  const { width: cw, height: ch } = canvas;

  const camX = player.x - cw / 2;
  const camY = player.y - ch / 2;

  ctx.clearRect(0, 0, cw, ch);

  // Draw world section
  ctx.drawImage(
    worldImage,
    camX, camY,              // source x,y
    cw, ch,                  // source w,h
    0, 0,                    // dest x,y
    cw, ch                   // dest w,h
  );

  // Draw player as a glowing pixel circle for now
  const px = cw / 2;
  const py = ch / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(px, py, player.size, 0, Math.PI * 2);
  ctx.fillStyle = "#ffd36a";
  ctx.shadowColor = "#ffea9a";
  ctx.shadowBlur = 18;
  ctx.fill();
  ctx.restore();
}

function loop() {
  update();
  draw();
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);

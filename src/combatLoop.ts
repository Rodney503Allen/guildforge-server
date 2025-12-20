setInterval(async ()=>{
  const [fights] = await db.query(`
    SELECT e.id, c.attack, c.attack_speed, pc.player_id
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    JOIN player_encounters e ON e.player_id = pc.player_id
  `);

  for (const fight of fights) {
    // Check last attack timing, apply damage
  }
}, 1000);
